// LIFE-589 E4ⓕⓖ — 허브 수명: 구독 0 이면 감시 프로세스 0, 죽으면 1초 뒤 재기동·구독 복원, 60초 안 3번 넘으면 멈춤. 가짜 child 로 본다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExplorerHub, type WatcherChild } from './explorer-hub.js'
import { RESTART_DELAY_MS, RESTART_MAX } from './explorer-watch-batch.js'
import type { ExplorerPush } from '../shared/explorer.js'

type FakeChild = WatcherChild & { posted: unknown[]; killed: boolean; emit: (event: 'message' | 'exit', value: unknown) => void }

function fakeChild(pid: number): FakeChild {
  const listeners: { message: ((value: unknown) => void)[]; exit: ((value: unknown) => void)[] } = { message: [], exit: [] }
  const child: FakeChild = {
    pid,
    posted: [],
    killed: false,
    postMessage: (message) => void child.posted.push(message),
    on: (event, listener) => void listeners[event].push(listener),
    kill: () => {
      child.killed = true
      for (const listener of listeners.exit) listener(null)
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
    expect(children[0]?.killed).toBe(true)
    expect(hub.status()).toMatchObject({ childPid: null, subscriptions: [] })
  })
  it('worktree 를 닫으면(prune) 그 구독이 풀린다', async () => {
    await hub.subscribe(rootA)
    roots = [rootB]
    hub.prune()
    expect(hub.status().subscriptions).toEqual([])
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
