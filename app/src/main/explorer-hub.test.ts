// LIFE-589 E4ⓕⓖ — 허브 수명: 구독 0 이면 감시 프로세스 0, 죽으면 1초 뒤 재기동·구독 복원, 60초 안 3번 넘으면 멈춤. 가짜 child 로 본다.
// 가짜 kill 은 실제 utilityProcess 처럼 exit 를 **나중에**(비동기) 부른다(R1-C). R1-B·E·F 회귀 시험은 아래.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExplorerHub, GIT_MAX_WAIT_MS, IDLE_STOP_MS, indexStamp, WATCH_READY_TIMEOUT_MS, type WatcherChild } from './explorer-hub.js'
import { RESTART_DELAY_MS, RESTART_MAX } from './explorer-watch-batch.js'
import type { ExplorerPush } from '../shared/explorer.js'

/** 가짜 감시 프로세스가 `watch` 를 받으면 실제처럼 `watching` 을 비동기로 알리는가(R2-A 시험에서 끈다). */
let autoAck = true

type FakeChild = WatcherChild & { posted: unknown[]; killed: boolean; emit: (event: 'message' | 'exit', value: unknown) => void }

function fakeChild(pid: number): FakeChild {
  const listeners: { message: ((value: unknown) => void)[]; exit: ((value: unknown) => void)[] } = { message: [], exit: [] }
  const child: FakeChild = {
    pid,
    posted: [],
    killed: false,
    postMessage: (message) => {
      child.posted.push(message)
      if (autoAck && typeof message === 'object' && message !== null && 'type' in message && message.type === 'watch' && 'id' in message) {
        const id = message.id
        setTimeout(() => {
          for (const listener of listeners.message) listener({ type: 'watching', id, count: 1 })
        }, 1)
      }
    },
    on: (event, listener) => void listeners[event].push(listener),
    kill: () => {
      child.killed = true
      setTimeout(() => {
        for (const listener of listeners.exit) listener(null)
      }, 5)
      return true
    },
    emit: (event, value) => {
      for (const listener of listeners[event]) listener(value)
    },
  }
  return child
}

let base = ''
let rootA = ''
let rootB = ''

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l589-hub-')))
  rootA = path.join(base, 'a')
  rootB = path.join(base, 'b')
  fs.mkdirSync(rootA)
  fs.mkdirSync(rootB)
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

let children: FakeChild[] = []
let pushed: ExplorerPush[] = []
let roots: string[] = []
let hub: ExplorerHub

beforeEach(() => {
  autoAck = true
  children = []
  pushed = []
  roots = [rootA, rootB]
  hub = new ExplorerHub({
    fork: () => {
      const child = fakeChild(1000 + children.length)
      children.push(child)
      return child
    },
    push: (event) => void pushed.push(event),
    roots: () => roots,
    log: () => {},
  })
})

afterEach(() => {
  hub.dispose()
  vi.useRealTimers()
})

describe('E4ⓕ 구독 수명', () => {
  it('열린 worktree 만 구독 — 밖 루트는 거절, 프로세스도 안 띄운다', async () => {
    expect(await hub.subscribe(base)).toEqual({ ok: false, code: 'not_worktree' })
    expect(children).toHaveLength(0)
  })
  it('구독 둘 → 프로세스 하나, 마지막 구독을 풀면 프로세스를 끝낸다(재기동 안 함)', async () => {
    await hub.subscribe(rootA)
    await hub.subscribe(rootB)
    expect(children).toHaveLength(1)
    expect(children[0]?.posted).toEqual([
      { type: 'watch', id: rootA, path: rootA },
      { type: 'watch', id: rootB, path: rootB },
    ])
    hub.unsubscribe(rootA)
    expect(children[0]?.killed).toBe(false)
    hub.unsubscribe(rootB)
    // 구독 0 → 유예(IDLE_STOP_MS) 뒤에 끈다.
    expect(children[0]?.killed).toBe(false)
    await sleep(IDLE_STOP_MS + 50)
    expect(children[0]?.killed).toBe(true)
    expect(hub.status()).toMatchObject({ childPid: null, subscriptions: [] })
  })
  it('worktree 를 닫으면(prune) 그 구독이 풀린다', async () => {
    await hub.subscribe(rootA)
    roots = [rootB]
    hub.prune()
    expect(hub.status().subscriptions).toEqual([])
    await sleep(IDLE_STOP_MS + 50)
    expect(children[0]?.killed).toBe(true)
  })
  it('배치 → 렌더러 push(changed·overflow), 모르는 구독 id 는 버린다', async () => {
    await hub.subscribe(rootA)
    children[0]?.emit('message', { type: 'batch', id: rootA, excluded: 5, kind: 'changed', dirs: ['', 'src'] })
    children[0]?.emit('message', { type: 'batch', id: rootA, excluded: 5, kind: 'overflow' })
    children[0]?.emit('message', { type: 'batch', id: '/nope', kind: 'changed', dirs: [''] })
    expect(pushed.filter((event) => event.kind !== 'git')).toEqual([
      { kind: 'changed', root: rootA, dirs: ['', 'src'] },
      { kind: 'overflow', root: rootA },
    ])
    expect(hub.status().counters.excludedSeen).toBe(5)
  })
})

describe('E4ⓖ 장애 재기동', () => {
  it('죽으면 1초 뒤 새 프로세스로 구독을 되살린다 — 60초 안 3번 넘으면 멈춘다', async () => {
    await hub.subscribe(rootA)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    for (let round = 0; round < RESTART_MAX; round += 1) {
      children.at(-1)?.emit('exit', 1)
      expect(hub.status().childPid).toBeNull()
      vi.advanceTimersByTime(RESTART_DELAY_MS)
      expect(children).toHaveLength(round + 2)
      expect(children.at(-1)?.posted).toEqual([{ type: 'watch', id: rootA, path: rootA }])
    }
    children.at(-1)?.emit('exit', 1)
    vi.advanceTimersByTime(RESTART_DELAY_MS * 5)
    expect(children).toHaveLength(RESTART_MAX + 1)
    expect(hub.status()).toMatchObject({ childPid: null, restartsInWindow: RESTART_MAX })
  })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('R1-B 진행 중 구독 vs 해제', () => {
  it('구독 직후 해제 — await 가 끝나도 구독 0·프로세스 0', async () => {
    const pending = hub.subscribe(rootA)
    hub.unsubscribe(rootA)
    expect(await pending).toEqual({ ok: false, code: 'cancelled' })
    expect(hub.status().subscriptions).toEqual([])
    expect(children).toHaveLength(0)
  })
  it('구독 중 worktree 닫힘(prune) — 구독 0', async () => {
    const pending = hub.subscribe(rootA)
    roots = [rootB]
    hub.prune()
    expect(await pending).toMatchObject({ ok: false })
    expect(hub.status().subscriptions).toEqual([])
    expect(children).toHaveLength(0)
  })
  it('같은 루트 동시 구독은 하나로 합친다', async () => {
    const first = hub.subscribe(rootA)
    const second = hub.subscribe(rootA)
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(hub.status().subscriptions).toEqual([rootA])
    expect(children[0]?.posted).toEqual([{ type: 'watch', id: rootA, path: rootA }])
  })
  it('구독 → 해제 → 다시 구독(모두 진행 중) — 마지막 뜻대로 구독된다', async () => {
    const first = hub.subscribe(rootA)
    hub.unsubscribe(rootA)
    const again = hub.subscribe(rootA)
    await Promise.all([first, again])
    expect(hub.status().subscriptions).toEqual([rootA])
  })
  it('dispose 뒤 끝난 구독은 남지 않는다', async () => {
    const pending = hub.subscribe(rootA)
    hub.dispose()
    await pending
    expect(hub.status().subscriptions).toEqual([])
    expect(children).toHaveLength(0)
  })
})

describe('감시 시작 알림 → 한 번 다시 읽기 (수정 r1 격리 실행에서 발견)', () => {
  it('watching 을 받으면 그 루트에 overflow 를 민다 — 모르는 id 는 버린다', async () => {
    await hub.subscribe(rootA)
    children[0]?.emit('message', { type: 'watching', id: rootA, count: 1 })
    children[0]?.emit('message', { type: 'watching', id: '/nope', count: 1 })
    expect(pushed.filter((event) => event.kind === 'overflow')).toEqual([{ kind: 'overflow', root: rootA }])
  })
})

describe('R2-A 구독은 감시 시작 확인 뒤 끝난다 · 전환은 프로세스를 다시 안 띄운다', () => {
  it('watching 알림 전에는 구독이 안 끝나고, 알림이 오면 끝난다 — 이때 overflow 는 안 민다(렌더러가 그 뒤 한 번 읽는다)', async () => {
    autoAck = false
    let done = false
    const pending = hub.subscribe(rootA).then((result) => {
      done = true
      return result
    })
    await sleep(50)
    expect(done).toBe(false)
    children[0]?.emit('message', { type: 'watching', id: rootA, count: 1 })
    expect(await pending).toEqual({ ok: true })
    expect(pushed.filter((event) => event.kind === 'overflow')).toEqual([])
  })
  it('알림이 안 오면 시간 초과로 끝난다(렌더러는 읽고 안전망이 남는다)', async () => {
    autoAck = false
    const started = Date.now()
    expect(await hub.subscribe(rootA)).toEqual({ ok: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(WATCH_READY_TIMEOUT_MS - 20)
  })
  it('해제 → 바로 다른 루트 구독(전환)은 같은 프로세스를 쓴다', async () => {
    await hub.subscribe(rootA)
    hub.unsubscribe(rootA)
    await hub.subscribe(rootB)
    await sleep(IDLE_STOP_MS + 50)
    expect(children).toHaveLength(1)
    expect(children[0]?.killed).toBe(false)
    expect(hub.status()).toMatchObject({ subscriptions: [rootB], counters: { childStarts: 1 } })
  })
  it('장애 재기동으로 되살린 감시의 watching 은 overflow 를 민다(끊긴 동안 변경)', async () => {
    await hub.subscribe(rootA)
    children[0]?.emit('exit', 1)
    await sleep(RESTART_DELAY_MS + 100)
    expect(children).toHaveLength(2)
    expect(pushed.filter((event) => event.kind === 'overflow')).toEqual([{ kind: 'overflow', root: rootA }])
  })
})

describe('R1-C 재기동 타이머 소유·비동기 exit', () => {
  it('죽은 뒤 재기동 대기 중 마지막 구독 해제 → 재기동하지 않는다', async () => {
    await hub.subscribe(rootA)
    children[0]?.emit('exit', 1)
    hub.unsubscribe(rootA)
    await sleep(RESTART_DELAY_MS + 200)
    expect(children).toHaveLength(1)
    expect(hub.status()).toMatchObject({ childPid: null, subscriptions: [] })
  })
  it('일부러 끈 프로세스의 늦은 exit 는 장애로 안 센다 — 그 사이 새 구독이 띄운 프로세스도 그대로', async () => {
    await hub.subscribe(rootA)
    hub.unsubscribe(rootA)
    while (children[0]?.killed !== true) await sleep(5)
    await hub.subscribe(rootB)
    expect(children).toHaveLength(2)
    await sleep(50)
    expect(hub.status()).toMatchObject({ childPid: 1001, subscriptions: [rootB], restartsInWindow: 0 })
    await sleep(RESTART_DELAY_MS + 200)
    expect(children).toHaveLength(2)
  })
  it('재기동 대기 중 새 구독이 먼저 띄우면 기존 구독도 함께 감시하고, 예약 재기동은 취소된다', async () => {
    await hub.subscribe(rootA)
    children[0]?.emit('exit', 1)
    await hub.subscribe(rootB)
    expect(children).toHaveLength(2)
    expect(children[1]?.posted).toEqual(expect.arrayContaining([{ type: 'watch', id: rootA, path: rootA }, { type: 'watch', id: rootB, path: rootB }]))
    await sleep(RESTART_DELAY_MS + 200)
    expect(children).toHaveLength(2)
  })
})

describe('R1-E·F git 재조회 (실제 git)', () => {
  let repo = ''
  beforeEach(() => {
    repo = path.join(base, `repo-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(repo)
    const git = (...args: string[]): void => void execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args])
    git('init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'f.txt'), 'one')
    git('add', '.')
    git('commit', '-qm', 'one')
    fs.writeFileSync(path.join(repo, 'f.txt'), 'two')
    git('commit', '-qam', 'two')
    roots = [repo]
  })
  const gitPushes = (): number => pushed.filter((event) => event.kind === 'git').length

  it(`R1-E 연속 변경(200 ms 간격) 중에도 git 이 ${GIT_MAX_WAIT_MS} ms 최대 대기 안에 돈다`, async () => {
    await hub.subscribe(repo)
    await sleep(400)
    const initial = gitPushes()
    const timer = setInterval(() => children[0]?.emit('message', { type: 'batch', id: repo, kind: 'changed', dirs: [''] }), 200)
    await sleep(2_600)
    clearInterval(timer)
    expect(gitPushes() - initial).toBeGreaterThanOrEqual(2)
  }, 10_000)

  it('R1-F `reset --soft` (index·HEAD 파일 그대로, ref 만 이동) 를 도장이 잡고 5 s 안에 git push', async () => {
    const gitDir = path.join(repo, '.git')
    const before = indexStamp(gitDir)
    await hub.subscribe(repo)
    await sleep(2_500)
    const initial = gitPushes()
    execFileSync('git', ['-C', repo, 'reset', '--soft', 'HEAD^'])
    expect(indexStamp(gitDir)).not.toBe(before)
    const started = Date.now()
    while (gitPushes() === initial && Date.now() - started < 5_000) await sleep(50)
    expect(gitPushes()).toBeGreaterThan(initial)
    const last = pushed.filter((event) => event.kind === 'git').at(-1)
    expect(last?.kind === 'git' ? last.git?.marks : null).toEqual([['f.txt', 'M']])
  }, 15_000)

  it('R1-F linked worktree — ref 는 공용 gitdir 에 있다(commondir), packed-refs 변화도 잡는다', () => {
    const linked = path.join(base, `linked-${Math.random().toString(36).slice(2)}`)
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'side', linked])
    const linkedGitDir = execFileSync('git', ['-C', linked, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
    const before = indexStamp(linkedGitDir)
    execFileSync('git', ['-C', repo, 'update-ref', 'refs/heads/side', 'HEAD^'])
    const moved = indexStamp(linkedGitDir)
    expect(moved).not.toBe(before)
    execFileSync('git', ['-C', repo, 'pack-refs', '--all'])
    expect(indexStamp(linkedGitDir)).not.toBe(moved)
  })
})
