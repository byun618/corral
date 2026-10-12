// 탐색기 감시·git 상태 허브 (LIFE-589 E4·E5) — main 쪽. 감시 프로세스(utility process) 하나를 띄우고, 렌더러가 구독한 worktree 루트만 감시한다.
//
// · 구독은 렌더러가 「패널이 열려 있고 이 worktree 가 활성」 일 때만 건다 — 감시 구독 수 ≤ 열린 worktree 수(E1ⓓ). 루트가 더 이상 열린 worktree 가 아니면
//   (`prune`) 구독을 푼다(worktree 닫기 → 감시 자원 0, E4ⓕ). 앱 종료 때 `dispose` 가 프로세스를 끝낸다.
// · 변경 배치 → 렌더러에 `{ kind: 'changed', dirs }` 또는 `{ kind: 'overflow' }` 를 밀고, git 상태 재조회를 예약한다(300 ms 뭉침, 최소 간격 1 s).
// · 인덱스만 바뀌는 변경(`git add`·commit — linked worktree 의 gitdir 은 루트 밖이라 감시에 안 잡힌다)은 gitdir 의 `index`·`HEAD` mtime 을 1초마다 stat 해 잡는다(E5ⓓ).
// · 감시 프로세스가 죽으면(E4ⓖ) 로그를 남기고 1초 뒤 다시 띄워 구독을 되살린다 — 60초 안 3번까지. 넘으면 멈추고 렌더러 안전망만 남는다.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { parsePorcelainV2, toWire, type GitSnapshotWire } from '../shared/explorer-git.js'
import type { ExplorerPush } from '../shared/explorer.js'
import { confine } from './explorer-fs.js'
import { RESTART_DELAY_MS, RESTART_MAX, RESTART_WINDOW_MS } from './explorer-watch-batch.js'

/** utility process 의 최소 모양 — 시험에서 가짜를 꽂는다. */
export type WatcherChild = {
  pid: number | undefined
  postMessage: (message: unknown) => void
  on: (event: 'message' | 'exit', listener: (value: unknown) => void) => void
  kill: () => boolean
}

export type ExplorerHubDeps = {
  fork: () => WatcherChild
  push: (event: ExplorerPush) => void
  roots: () => readonly string[]
  log: (event: string, data?: Record<string, unknown>) => void
  now?: () => number
}

const GIT_DEBOUNCE_MS = 300
const GIT_MIN_INTERVAL_MS = 1_000
const INDEX_POLL_MS = 1_000
export const GIT_STATUS_ARGS = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching']

type Subscription = { root: string; realRoot: string; gitDir: string | null; indexStamp: string; gitTimer: NodeJS.Timeout | null; gitLastAt: number; gitRunning: boolean; gitAgain: boolean }

export class ExplorerHub {
  private child: WatcherChild | null = null
  private childPid: number | null = null
  private readonly subs = new Map<string, Subscription>()
  private restarts: number[] = []
  private stopped = false
  private indexTimer: NodeJS.Timeout | null = null
  /** 계측(E4ⓓ·E4ⓕ) — 렌더러로 민 변경 이벤트 수·감시 프로세스가 버린 제외 경로 이벤트 수(마지막 배치 기준 누계). */
  readonly counters = { pushedChanged: 0, pushedOverflow: 0, pushedGit: 0, excludedSeen: 0, childStarts: 0, childExits: 0 }

  constructor(private readonly deps: ExplorerHubDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  status(): { childPid: number | null; subscriptions: string[]; restartsInWindow: number; stopped: boolean; counters: ExplorerHub['counters'] } {
    return { childPid: this.childPid, subscriptions: [...this.subs.keys()], restartsInWindow: this.restarts.length, stopped: this.stopped, counters: { ...this.counters } }
  }

  private ensureChild(): WatcherChild | null {
    if (this.child !== null) return this.child
    if (this.stopped) return null
    const child = this.deps.fork()
    this.child = child
    this.childPid = child.pid ?? null
    this.counters.childStarts += 1
    this.deps.log('explorer.watch.start', { pid: this.childPid })
    child.on('message', (message) => this.onChildMessage(message))
    child.on('exit', (code) => this.onChildExit(code))
    return child
  }

  private onChildMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'batch' && 'id' in message && typeof message.id === 'string') {
      const sub = this.subs.get(message.id)
      if (sub === undefined) return
      if ('excluded' in message && typeof message.excluded === 'number') this.counters.excludedSeen = message.excluded
      if ('kind' in message && message.kind === 'overflow') {
        this.counters.pushedOverflow += 1
        this.deps.push({ kind: 'overflow', root: sub.root })
      } else if ('dirs' in message && Array.isArray(message.dirs)) {
        const dirs = message.dirs.filter((dir): dir is string => typeof dir === 'string')
        this.counters.pushedChanged += 1
        this.deps.push({ kind: 'changed', root: sub.root, dirs })
      }
      this.scheduleGit(sub)
      return
    }
    if (message.type === 'ready' && 'pid' in message && typeof message.pid === 'number') {
      this.childPid = message.pid
      this.deps.log('explorer.watch.ready', { pid: message.pid })
      return
    }
    if (message.type === 'error') this.deps.log('explorer.watch.error', { message: JSON.stringify(message).slice(0, 300) })
  }

  private onChildExit(code: unknown): void {
    const pid = this.childPid
    this.child = null
    this.childPid = null
    this.counters.childExits += 1
    this.deps.log('explorer.watch.exit', { pid, code: typeof code === 'number' ? code : String(code), subscriptions: this.subs.size, disposing: this.stopped })
    if (this.stopped || this.subs.size === 0) return
    const now = this.now()
    this.restarts = this.restarts.filter((at) => now - at < RESTART_WINDOW_MS)
    if (this.restarts.length >= RESTART_MAX) {
      this.deps.log('explorer.watch.gave_up', { restarts: this.restarts.length, windowMs: RESTART_WINDOW_MS })
      return
    }
    this.restarts.push(now)
    setTimeout(() => {
      const child = this.ensureChild()
      if (child === null) return
      for (const sub of this.subs.values()) child.postMessage({ type: 'watch', id: sub.root, path: sub.realRoot })
      this.deps.log('explorer.watch.restarted', { pid: this.childPid, subscriptions: this.subs.size })
    }, RESTART_DELAY_MS)
  }

  /** 구독 — 루트는 열린 worktree 여야 한다(같은 가둠). 결과는 git 첫 상태 push 로 이어진다. */
  async subscribe(root: unknown): Promise<{ ok: true } | { ok: false; code: string }> {
    const confined = await confine({ roots: this.deps.roots(), root, rel: '' })
    if (!confined.ok || typeof root !== 'string') return { ok: false, code: confined.ok ? 'invalid_argument' : confined.code }
    const existing = this.subs.get(root)
    if (existing !== undefined) {
      this.scheduleGit(existing, 0)
      return { ok: true }
    }
    const gitDir = await gitDirOf(confined.realRoot)
    const sub: Subscription = { root, realRoot: confined.realRoot, gitDir, indexStamp: indexStamp(gitDir), gitTimer: null, gitLastAt: 0, gitRunning: false, gitAgain: false }
    this.subs.set(root, sub)
    this.ensureChild()?.postMessage({ type: 'watch', id: root, path: confined.realRoot })
    this.deps.log('explorer.watch.subscribe', { root, subscriptions: this.subs.size, gitDir })
    this.ensureIndexPoll()
    this.scheduleGit(sub, 0)
    return { ok: true }
  }

  unsubscribe(root: unknown): void {
    if (typeof root !== 'string') return
    const sub = this.subs.get(root)
    if (sub === undefined) return
    if (sub.gitTimer !== null) clearTimeout(sub.gitTimer)
    this.subs.delete(root)
    this.child?.postMessage({ type: 'unwatch', id: root })
    this.deps.log('explorer.watch.unsubscribe', { root, subscriptions: this.subs.size })
    if (this.subs.size === 0) this.stopChild('idle')
  }

  /** 열린 worktree 가 아닌 구독을 푼다 — 트리가 바뀔 때마다 부른다. */
  prune(): void {
    const roots = this.deps.roots()
    for (const root of [...this.subs.keys()]) if (!roots.includes(root)) this.unsubscribe(root)
  }

  /** 렌더러 안전망·새로고침 — git 상태를 바로 다시 읽는다. */
  refreshGit(root: unknown): void {
    if (typeof root !== 'string') return
    const sub = this.subs.get(root)
    if (sub !== undefined) this.scheduleGit(sub, 0)
  }

  /** E4ⓖ 장애 주입(계측 소켓 전용). */
  injectCrash(): boolean {
    if (this.child === null) return false
    this.child.postMessage({ type: 'crash' })
    return true
  }

  dispose(): void {
    this.stopped = true
    for (const sub of this.subs.values()) if (sub.gitTimer !== null) clearTimeout(sub.gitTimer)
    this.subs.clear()
    if (this.indexTimer !== null) clearInterval(this.indexTimer)
    this.indexTimer = null
    this.stopChild('dispose')
  }

  private stopChild(reason: string): void {
    if (this.indexTimer !== null && this.subs.size === 0) {
      clearInterval(this.indexTimer)
      this.indexTimer = null
    }
    const child = this.child
    if (child === null) return
    // 구독 0 이면 프로세스도 끝낸다(감시 자원 0 — E4ⓕ). exit 콜백은 subs 가 비어 재기동하지 않는다.
    this.deps.log('explorer.watch.stop', { pid: this.childPid, reason })
    child.kill()
  }

  private ensureIndexPoll(): void {
    if (this.indexTimer !== null) return
    this.indexTimer = setInterval(() => {
      for (const sub of this.subs.values()) {
        const stamp = indexStamp(sub.gitDir)
        if (stamp !== sub.indexStamp) {
          sub.indexStamp = stamp
          this.scheduleGit(sub, 0)
        }
      }
    }, INDEX_POLL_MS)
    this.indexTimer.unref?.()
  }

  private scheduleGit(sub: Subscription, delay = GIT_DEBOUNCE_MS): void {
    if (sub.gitRunning) {
      sub.gitAgain = true
      return
    }
    if (sub.gitTimer !== null) clearTimeout(sub.gitTimer)
    const wait = Math.max(delay, sub.gitLastAt + GIT_MIN_INTERVAL_MS - this.now())
    sub.gitTimer = setTimeout(() => void this.runGit(sub), Math.max(0, wait))
  }

  private async runGit(sub: Subscription): Promise<void> {
    sub.gitTimer = null
    if (this.subs.get(sub.root) !== sub) return
    sub.gitRunning = true
    sub.gitLastAt = this.now()
    const startedAt = this.now()
    const outcome = await runGitStatus(sub.realRoot)
    sub.gitRunning = false
    if (this.subs.get(sub.root) !== sub) return
    this.counters.pushedGit += 1
    this.deps.log('explorer.git', { root: sub.root, ms: this.now() - startedAt, ok: outcome.error === null, marks: outcome.git?.marks.length ?? 0, ignored: outcome.git?.ignored.length ?? 0 })
    this.deps.push({ kind: 'git', root: sub.root, git: outcome.git, error: outcome.error })
    if (sub.gitAgain) {
      sub.gitAgain = false
      this.scheduleGit(sub)
    }
  }
}

function runGitStatus(cwd: string): Promise<{ git: GitSnapshotWire | null; error: string | null }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...GIT_STATUS_ARGS], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) resolve({ git: null, error: String(error).slice(0, 300) })
      else resolve({ git: toWire(parsePorcelainV2(stdout)), error: null })
    })
  })
}

function gitDirOf(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], { timeout: 5_000 }, (error, stdout) => resolve(error === null ? stdout.trim() : null))
  })
}

/** gitdir 의 index·HEAD mtime·크기 — 바뀌면 인덱스 쪽 변경(`git add`·commit·checkout). */
function indexStamp(gitDir: string | null): string {
  if (gitDir === null) return ''
  const one = (name: string): string => {
    try {
      const stat = fs.statSync(path.join(gitDir, name))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return '-'
    }
  }
  return `${one('index')}|${one('HEAD')}`
}
