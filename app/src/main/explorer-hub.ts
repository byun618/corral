// 탐색기 감시·git 상태 허브 (LIFE-589 E4·E5) — main 쪽. 감시 프로세스(utility process) 하나를 띄우고, 렌더러가 구독한 worktree 루트만 감시한다.
//
// · 구독은 렌더러가 「패널이 열려 있고 이 worktree 가 활성」 일 때만 건다 — 감시 구독 수 ≤ 열린 worktree 수(E1ⓓ). 루트가 더 이상 열린 worktree 가 아니면
//   (`prune`) 구독을 푼다(worktree 닫기 → 감시 자원 0, E4ⓕ). 앱 종료 때 `dispose` 가 프로세스를 끝낸다.
// · 구독 요청은 비동기(realpath·`git rev-parse`)다. 루트마다 「원하는 상태」 를 세대 번호로 들고, await 뒤에 아직 원하는지·열린 worktree 인지·dispose 전인지
//   다시 본다 — 그 사이 온 해제·prune 이 이긴다(R1-B). 같은 루트 동시 구독은 진행 중 요청 하나로 합친다.
// · 변경 배치 → 렌더러에 `{ kind: 'changed', dirs }` 또는 `{ kind: 'overflow' }` 를 밀고, git 상태 재조회를 예약한다(300 ms 뭉침, 최소 간격 1 s,
//   **첫 요청부터 최대 1 s** — 연속 변경이 뭉침을 끝없이 미루지 못한다(R1-E). 배치 창 ≤ 500 ms + 1 s + git 한 번 ≈ 작업 트리 변경 뒤 2 s 안).
// · 인덱스·ref 만 바뀌는 변경(`git add`·commit·`reset --soft`·브랜치 전환 — gitdir 은 감시 제외이거나 루트 밖)은 1초마다 stat 해 잡는다(E5ⓓ·R1-F):
//   gitdir 의 `index`·`HEAD`(내용 포함), HEAD 가 가리키는 ref 의 loose 파일(linked worktree 면 `commondir` 이 가리키는 공용 gitdir 쪽)·`packed-refs`.
// · 감시 프로세스가 죽으면(E4ⓖ) 로그를 남기고 1초 뒤 다시 띄워 구독을 되살린다 — 60초 안 3번까지. 넘으면 멈추고 렌더러 안전망만 남는다.
//   재기동 타이머는 허브가 들고 있다가 구독이 0 이 되거나 dispose 면 취소하고, 실행 시점에도 구독 수를 다시 본다(R1-C). 일부러 끈 프로세스의
//   exit 는 그 child 를 보고 가려 장애로 세지 않는다(실제 utilityProcess 의 exit 는 kill 뒤 비동기로 온다).
// · 감시 준비와 목록 읽기는 서로 기다리지 않는다(상태 모델 `specs/LIFE-589-explorer-tree/raw/claude/fix-r3/state-model.md`). 렌더러는 활성화되자마자
//   목록을 한 번 읽고(전환당 펼친 폴더 수 + 1 — E1ⓓ, 첫 표시가 감시 준비에 묶이지 않음 — E3ⓐ), 허브는 목록을 줄 때마다 그 폴더의 도장(정체 + mtime)을
//   적어 둔다(`list`). 감시 프로세스가 `watching`(감시 시작)을 알리면 — 처음이든 늦게든 장애 재기동 뒤든 같게 — 적어 둔 폴더를 stat 만 해서 도장이
//   달라진 폴더만 `changed` 로 민다(감시 시작 전 틈 — r1 보완). 그 사이 바뀐 게 없으면 다시 읽기 0 이다. 감시 시작 오류는 기다리는 것이 없으니 로그만 남고
//   안전망이 맡는다(R3-C).
// · 구독이 0 이 되면 감시 프로세스를 300 ms 뒤에 끈다 — worktree 전환(해제 → 바로 구독)이 프로세스를 매번 새로 띄우지 않게. 그 사이 새 구독이 오면 그대로 쓴다.
//   ref 폴링·재기동 예약은 0 이 되는 즉시 멈춘다. dispose 는 바로 끈다.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { parsePorcelainV2, toWire, type GitSnapshotWire } from '../shared/explorer-git.js'
import type { ExplorerPush } from '../shared/explorer.js'
import { confine, dirStamp, listDir } from './explorer-fs.js'
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
/** 구독 0 뒤 감시 프로세스를 끄기까지의 유예. */
export const IDLE_STOP_MS = 300
/** git 재조회 최대 대기 — 첫 요청부터 이 안에는 돈다(뭉침이 계속 밀려도). */
export const GIT_MAX_WAIT_MS = 1_000
const INDEX_POLL_MS = 1_000
export const GIT_STATUS_ARGS = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching']

type Subscription = {
  root: string
  realRoot: string
  gitDir: string | null
  indexStamp: string
  gitTimer: NodeJS.Timeout | null
  gitLastAt: number
  /** 아직 처리 안 된 첫 git 요청 시각(최대 대기 기준) — 실행이 시작되면 비운다. */
  gitFirstAt: number | null
  gitRunning: boolean
  gitAgain: boolean
}

type SubscribeResult = { ok: true } | { ok: false; code: string }

export class ExplorerHub {
  private child: WatcherChild | null = null
  private childPid: number | null = null
  private readonly subs = new Map<string, Subscription>()
  /** 루트 → 원하는 구독의 세대. 해제·prune 이 지운다 — 진행 중 구독은 await 뒤 이 값을 보고 물러난다(R1-B). */
  private readonly wanted = new Map<string, number>()
  private readonly pending = new Map<string, { generation: number; promise: Promise<SubscribeResult> }>()
  private generation = 0
  private restartTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  /** 루트 → (실경로 상대 → 렌더러에 준 목록의 도장). 감시 시작 때 그 사이 바뀐 폴더를 가리는 데 쓴다. 열린 worktree 가 아니게 되면 버린다. */
  private readonly listed = new Map<string, Map<string, string>>()
  private restarts: number[] = []
  private stopped = false
  private indexTimer: NodeJS.Timeout | null = null
  /** 계측(E4ⓓ·E4ⓕ) — 렌더러로 민 변경 이벤트 수·감시 프로세스가 버린 제외 경로 이벤트 수(마지막 배치 기준 누계). */
  readonly counters = { pushedChanged: 0, pushedOverflow: 0, pushedGit: 0, excludedSeen: 0, childStarts: 0, childExits: 0, gapChecks: 0, gapChangedDirs: 0, watchErrors: 0 }

  constructor(private readonly deps: ExplorerHubDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  status(): { childPid: number | null; subscriptions: string[]; restartsInWindow: number; stopped: boolean; counters: ExplorerHub['counters'] } {
    return { childPid: this.childPid, subscriptions: [...this.subs.keys()], restartsInWindow: this.restarts.length, stopped: this.stopped, counters: { ...this.counters } }
  }

  private ensureChild(): WatcherChild | null {
    this.clearIdle()
    if (this.child !== null) return this.child
    if (this.stopped) return null
    const child = this.deps.fork()
    this.child = child
    this.childPid = child.pid ?? null
    this.counters.childStarts += 1
    this.deps.log('explorer.watch.start', { pid: this.childPid })
    child.on('message', (message) => {
      if (this.child === child) this.onChildMessage(message)
    })
    child.on('exit', (code) => this.onChildExit(child, code))
    // 새 프로세스는 지금 구독 전부를 감시한다(장애 뒤 재기동 대기 중에 새 구독이 와서 먼저 띄워도 기존 구독을 잃지 않는다).
    this.clearRestart()
    for (const sub of this.subs.values()) child.postMessage({ type: 'watch', id: sub.root, path: sub.realRoot })
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
    if (message.type === 'watching' && 'id' in message && typeof message.id === 'string') {
      // 감시가 실제로 붙었다(처음·늦게·재기동 뒤 모두 같은 길). 감시가 없던 동안 바뀐 폴더만 stat 으로 가려 민다.
      const sub = this.subs.get(message.id)
      if (sub === undefined) return
      void this.gapCheck(sub)
      this.scheduleGit(sub)
      return
    }
    if (message.type === 'ready' && 'pid' in message && typeof message.pid === 'number') {
      this.childPid = message.pid
      this.deps.log('explorer.watch.ready', { pid: message.pid })
      return
    }
    if (message.type === 'error') {
      // 감시 시작·유지 오류 — 기다리는 것이 없으므로 목록·git 은 그대로 가고, 변경 반영은 렌더러 안전망(10 s)이 맡는다.
      this.counters.watchErrors += 1
      this.deps.log('explorer.watch.error', { message: JSON.stringify(message).slice(0, 300) })
    }
  }

  private onChildExit(child: WatcherChild, code: unknown): void {
    if (this.child !== child) {
      // 일부러 끈(stopChild) 프로세스의 늦은 exit — 장애가 아니다.
      this.deps.log('explorer.watch.exit', { pid: child.pid ?? null, code: typeof code === 'number' ? code : String(code), stopped: true })
      return
    }
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
    this.clearRestart()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopped || this.subs.size === 0) return
      if (this.ensureChild() === null) return
      this.deps.log('explorer.watch.restarted', { pid: this.childPid, subscriptions: this.subs.size })
    }, RESTART_DELAY_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /** 목록 읽기(렌더러 `explorerList` 의 main 입구) — 결과의 도장을 적어 둔다. */
  async list(input: { roots: readonly string[]; root: unknown; rel: unknown }): ReturnType<typeof listDir> {
    const result = await listDir(input)
    if (result.ok && typeof input.root === 'string' && result.stamp !== '') {
      const records = this.listed.get(input.root) ?? new Map<string, string>()
      records.set(result.real, result.stamp)
      this.listed.set(input.root, records)
    }
    return result
  }

  /** 감시 시작 틈 맞추기 — 적어 둔 폴더를 stat 만 해서 도장이 달라진(없어진 것 포함) 폴더를 `changed` 로 민다. 목록은 읽지 않는다. */
  private async gapCheck(sub: Subscription): Promise<void> {
    const records = this.listed.get(sub.root)
    this.counters.gapChecks += 1
    if (records === undefined || records.size === 0) return
    const dirs: string[] = []
    for (const [real, stamp] of records) {
      const now = await dirStamp(real === '' ? sub.realRoot : path.join(sub.realRoot, ...real.split('/')))
      if (now?.stamp !== stamp) dirs.push(real)
    }
    if (this.subs.get(sub.root) !== sub || dirs.length === 0) return
    this.counters.gapChangedDirs += dirs.length
    this.counters.pushedChanged += 1
    this.deps.log('explorer.watch.gap', { root: sub.root, checked: records.size, changed: dirs.length })
    this.deps.push({ kind: 'changed', root: sub.root, dirs })
  }

  private clearRestart(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  /** 지금도 이 세대의 구독을 원하는가 — await 뒤마다 본다. */
  private stillWanted(root: string, generation: number): boolean {
    return !this.stopped && this.wanted.get(root) === generation && this.deps.roots().includes(root)
  }

  /** 구독 — 루트는 열린 worktree 여야 한다(같은 가둠). 결과는 git 첫 상태 push 로 이어진다. */
  subscribe(root: unknown): Promise<SubscribeResult> {
    if (typeof root !== 'string') return Promise.resolve({ ok: false, code: 'not_worktree' })
    if (this.stopped) return Promise.resolve({ ok: false, code: 'stopped' })
    const existing = this.subs.get(root)
    if (existing !== undefined) {
      this.scheduleGit(existing, 0)
      return Promise.resolve({ ok: true })
    }
    const inFlight = this.pending.get(root)
    if (inFlight !== undefined) {
      // 같은 루트 동시 구독 — 하나로 합친다. 그 사이 해제가 있었으면 다시 원한다고 적는다.
      this.wanted.set(root, inFlight.generation)
      return inFlight.promise
    }
    this.generation += 1
    const generation = this.generation
    this.wanted.set(root, generation)
    const promise = this.establish(root, generation).finally(() => {
      if (this.pending.get(root)?.generation === generation) this.pending.delete(root)
    })
    this.pending.set(root, { generation, promise })
    return promise
  }

  private async establish(root: string, generation: number): Promise<SubscribeResult> {
    const confined = await confine({ roots: this.deps.roots(), root, rel: '' })
    if (!confined.ok) {
      if (this.wanted.get(root) === generation) this.wanted.delete(root)
      return { ok: false, code: confined.code }
    }
    if (!this.stillWanted(root, generation)) return { ok: false, code: 'cancelled' }
    const gitDir = await gitDirOf(confined.realRoot)
    if (!this.stillWanted(root, generation)) {
      this.deps.log('explorer.watch.subscribe_cancelled', { root })
      return { ok: false, code: 'cancelled' }
    }
    const sub: Subscription = { root, realRoot: confined.realRoot, gitDir, indexStamp: indexStamp(gitDir), gitTimer: null, gitLastAt: 0, gitFirstAt: null, gitRunning: false, gitAgain: false }
    this.subs.set(root, sub)
    if (this.child === null) this.ensureChild()
    else {
      this.clearIdle()
      this.child.postMessage({ type: 'watch', id: root, path: confined.realRoot })
    }
    this.deps.log('explorer.watch.subscribe', { root, subscriptions: this.subs.size, gitDir })
    this.ensureIndexPoll()
    this.scheduleGit(sub, 0)
    return { ok: true }
  }

  unsubscribe(root: unknown): void {
    if (typeof root !== 'string') return
    this.wanted.delete(root)
    const sub = this.subs.get(root)
    if (sub === undefined) return
    if (sub.gitTimer !== null) clearTimeout(sub.gitTimer)
    this.subs.delete(root)
    this.child?.postMessage({ type: 'unwatch', id: root })
    this.deps.log('explorer.watch.unsubscribe', { root, subscriptions: this.subs.size })
    if (this.subs.size === 0) {
      if (this.indexTimer !== null) clearInterval(this.indexTimer)
      this.indexTimer = null
      this.clearRestart()
      this.clearIdle()
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null
        if (this.subs.size === 0) this.stopChild('idle')
      }, IDLE_STOP_MS)
    }
  }

  /** 열린 worktree 가 아닌 구독을 푼다 — 트리가 바뀔 때마다 부른다. */
  prune(): void {
    const roots = this.deps.roots()
    for (const root of new Set([...this.subs.keys(), ...this.wanted.keys()])) if (!roots.includes(root)) this.unsubscribe(root)
    for (const root of [...this.listed.keys()]) if (!roots.includes(root)) this.listed.delete(root)
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
    this.wanted.clear()
    this.clearRestart()
    this.clearIdle()
    this.listed.clear()
    for (const sub of this.subs.values()) if (sub.gitTimer !== null) clearTimeout(sub.gitTimer)
    this.subs.clear()
    if (this.indexTimer !== null) clearInterval(this.indexTimer)
    this.indexTimer = null
    this.stopChild('dispose')
  }

  private stopChild(reason: string): void {
    if (this.subs.size === 0) {
      if (this.indexTimer !== null) clearInterval(this.indexTimer)
      this.indexTimer = null
      this.clearRestart()
    }
    const child = this.child
    if (child === null) return
    // 구독 0 이면 프로세스도 끝낸다(감시 자원 0 — E4ⓕ). 먼저 놓아 두므로 늦게 오는 exit 는 장애로 안 센다.
    this.deps.log('explorer.watch.stop', { pid: this.childPid, reason })
    this.child = null
    this.childPid = null
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
    const now = this.now()
    if (sub.gitFirstAt === null) sub.gitFirstAt = now
    if (sub.gitRunning) {
      sub.gitAgain = true
      return
    }
    if (sub.gitTimer !== null) clearTimeout(sub.gitTimer)
    const earliest = Math.max(now + delay, sub.gitLastAt + GIT_MIN_INTERVAL_MS)
    const at = Math.min(earliest, sub.gitFirstAt + GIT_MAX_WAIT_MS)
    sub.gitTimer = setTimeout(() => void this.runGit(sub), Math.max(0, at - now))
  }

  private async runGit(sub: Subscription): Promise<void> {
    sub.gitTimer = null
    if (this.subs.get(sub.root) !== sub) return
    sub.gitRunning = true
    sub.gitFirstAt = null
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

/**
 * 인덱스·ref 쪽 도장 — 바뀌면 git 을 다시 본다(`git add`·commit·checkout·`reset --soft`). gitdir 의 index·HEAD(내용 포함) +
 * HEAD 가 가리키는 ref 의 loose 파일(gitdir 쪽과 공용 gitdir 쪽 둘 다 — linked worktree 는 `commondir` 로 공용 gitdir 을 찾는다) + `packed-refs`.
 */
export function indexStamp(gitDir: string | null): string {
  if (gitDir === null) return ''
  const one = (file: string): string => {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
    } catch {
      return '-'
    }
  }
  const read = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }
  const commondirText = read(path.join(gitDir, 'commondir'))
  const commonDir = commondirText === '' ? gitDir : path.resolve(gitDir, commondirText)
  const head = read(path.join(gitDir, 'HEAD'))
  const ref = head.startsWith('ref: ') ? head.slice(5).trim() : null
  const refStamp = ref === null || ref.includes('..') ? '' : `${one(path.join(gitDir, ref))}|${one(path.join(commonDir, ref))}`
  return [one(path.join(gitDir, 'index')), one(path.join(gitDir, 'HEAD')), head, refStamp, one(path.join(commonDir, 'packed-refs'))].join('|')
}
