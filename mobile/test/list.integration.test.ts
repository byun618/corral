// 목록 실제 서버 통합 시험 (LIFE-580 L1ⓐ · L4ⓐⓑ · L9ⓒ) — app/ 의 MobileServer + ListFeed(데스크톱 파생 함수) 에 앱 연결 관리자·목록 상태를 node `ws` 로 붙인다.
// 페어링 → 구독 → 스냅샷 → push(3초 안) · 끊긴 동안의 변화가 재연결 뒤 사용자 조작 없이 반영 · 서버 재기동(epoch 바뀜) · 앱 재시작 뒤 안 읽음 유지.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { ListFeed } from '../../app/src/main/mobile/feed'
import { FIXTURE_NOW, listFixture } from '../../app/src/main/mobile/list-fixture'
import { PairingStore } from '../../app/src/main/mobile/pairing'
import { MobileServer } from '../../app/src/main/mobile/server'
import { createTimerClock } from '../src/core/clock'
import { ConnectionManager, type ConnState, type SocketLike, type Timing } from '../src/core/connection'
import { allChannels } from '../src/core/list'
import { ListStore, type ListSnapshot } from '../src/core/list-store'
import { ConnectionLog } from '../src/core/log'
import { UnreadLedger, type UnreadData } from '../src/core/unread'
import { MemoryVault } from './fakes'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const realClock = createTimerClock()

function nodeSocket(url: string): SocketLike {
  const ws = new WebSocket(url)
  const adapter: SocketLike = {
    get readyState() {
      return ws.readyState
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  ws.on('open', () => adapter.onopen?.({}))
  ws.on('message', (data) => adapter.onmessage?.({ data: data.toString() }))
  ws.on('close', (code) => adapter.onclose?.({ code }))
  ws.on('error', () => adapter.onerror?.({}))
  cleanups.push(() => ws.terminate())
  return adapter
}

const FAST: Partial<Timing> = { pingIntervalMs: 300, pongDeadlineMs: 300, probeDeadlineMs: 300, connectDeadlineMs: 1_000, backoffMs: [100, 200, 400], offlineAfterMs: 2_000 }

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l580i-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new PairingStore({ dir: path.join(dir, 'mobile') })
  store.load()
  let state = listFixture()
  const logs: string[] = []
  let feed = new ListFeed({ read: () => ({ state, prefs: null, now: FIXTURE_NOW }), log: (tag, fields = {}) => logs.push(`${tag} ${JSON.stringify(fields)}`) })
  const make = () =>
    new MobileServer({ pairing: store, appVersion: '0.2.0-it', macName: () => '시험 맥', log: (tag, fields = {}) => logs.push(`${tag} ${JSON.stringify(fields)}`), onChange: () => {}, list: feed })
  let server = make()
  let port = await server.start()
  cleanups.push(() => server.stop())
  cleanups.push(() => feed.stop())
  return {
    store,
    logs,
    url: () => `ws://127.0.0.1:${port}/ws`,
    change: (overrides: Parameters<typeof listFixture>[0]) => {
      state = listFixture(overrides)
      feed.changed()
    },
    /** 서버 재기동(맥 corral 재시작) — 같은 포트는 못 받으니 새 포트, 새 epoch. */
    restart: async () => {
      await server.stop()
      feed.stop()
      feed = new ListFeed({ read: () => ({ state, prefs: null, now: FIXTURE_NOW }), log: () => {} })
      server = make()
      port = await server.start()
    },
    disconnectAll: () => server.disconnectAll(),
  }
}

class MemoryStore<T> {
  data: T | null = null
  load(): T | null {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data))
  }
  save(data: T): void {
    this.data = JSON.parse(JSON.stringify(data))
  }
}

function app(vault: MemoryVault, unreadStore = new MemoryStore<UnreadData>()) {
  const log = new ConnectionLog(() => Date.now())
  const m = new ConnectionManager({ openSocket: nodeSocket, vault, clock: realClock, log, appVersion: '0.1.0', deviceName: 'it-phone', timing: FAST })
  const ledger = new UnreadLedger({ store: unreadStore, now: () => Date.now() })
  const list = new ListStore({ connection: m, ledger, now: () => Date.now(), log })
  cleanups.push(() => m.setForeground(false))
  return { m, list, ledger, log, unreadStore }
}

async function until<T>(read: () => T, pred: (value: T) => boolean, timeoutMs = 5_000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred(read())) return Date.now() - start
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error(`시간 초과 — ${JSON.stringify(read()).slice(0, 300)}`)
}

const seq = (snapshot: ListSnapshot): number => (snapshot.phase.kind === 'ready' ? snapshot.phase.message.seq : 0)
const epoch = (snapshot: ListSnapshot): string => (snapshot.phase.kind === 'ready' ? snapshot.phase.message.epoch : '')
const dotOf = (snapshot: ListSnapshot, id: string): string | null =>
  snapshot.phase.kind === 'ready' ? (allChannels(snapshot.phase.message.list).find((channel) => channel.id === id)?.dot ?? null) : null
const ids = (snapshot: ListSnapshot): string[] => (snapshot.phase.kind === 'ready' ? allChannels(snapshot.phase.message.list).map((channel) => channel.id) : [])

async function paired(srv: Awaited<ReturnType<typeof startServer>>) {
  const vault = new MemoryVault()
  const a = app(vault)
  await a.m.start()
  a.m.pair({ url: srv.url(), host: '127.0.0.1', code: srv.store.createCode().code })
  await until(() => a.m.getSnapshot().conn, (conn: ConnState) => conn.kind === 'connected')
  return { ...a, vault }
}

describe('목록 — 실제 서버', () => {
  it('L1ⓐ 페어링 직후 구독 → 전체 스냅샷(셸 0) → 상태 변화 push 가 3초 안에 반영', async () => {
    const srv = await startServer()
    const a = await paired(srv)
    await until(() => a.list.getSnapshot(), (snapshot) => seq(snapshot) === 1)
    expect(ids(a.list.getSnapshot())).not.toContain('s1')
    expect(ids(a.list.getSnapshot())).toContain('p1')
    expect(dotOf(a.list.getSnapshot(), 'p6')).toBe('idle')
    const started = Date.now()
    srv.change({ p6: { agentStatus: 'working' } })
    await until(() => a.list.getSnapshot(), (snapshot) => dotOf(snapshot, 'p6') === 'working', 3_000)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(a.log.text()).toContain('list_recv')
  })

  it('L4ⓐ 끊긴 동안의 변화(상태·세션 추가·닫기)가 재연결 뒤 사용자 조작 없이 반영된다', async () => {
    const srv = await startServer()
    const a = await paired(srv)
    await until(() => a.list.getSnapshot(), (snapshot) => seq(snapshot) === 1)
    const before = seq(a.list.getSnapshot())
    // 서버가 연결을 닫는다(노출 막힘 흉내) — 그 사이 데스크톱에서 세 가지가 바뀐다.
    srv.disconnectAll()
    await until(() => a.m.getSnapshot().conn, (conn) => conn.kind !== 'connected')
    srv.change({ p6: { agentStatus: 'working' }, p9: { agent: null }, p7: { agentStatus: 'blocked', agentState: { blockedReason: 'question' } } })
    // 재연결은 앱이 알아서 한다(백오프 100ms~).
    await until(() => a.list.getSnapshot(), (snapshot) => dotOf(snapshot, 'p6') === 'working', 6_000)
    const after = a.list.getSnapshot()
    expect(seq(after)).toBeGreaterThan(before)
    expect(ids(after)).not.toContain('p9')
    expect(dotOf(after, 'p7')).toBe('waiting')
  })

  it('서버 재기동(epoch 바뀜) — 새 연결의 낮은 번호 목록도 받는다', async () => {
    const srv = await startServer()
    const a = await paired(srv)
    await until(() => a.list.getSnapshot(), (snapshot) => seq(snapshot) === 1)
    srv.change({ p6: { agentStatus: 'working' } })
    await until(() => a.list.getSnapshot(), (snapshot) => seq(snapshot) === 2)
    const oldEpoch = epoch(a.list.getSnapshot())
    srv.change({ p6: { agentStatus: 'blocked', agentState: { blockedReason: 'question' } } })
    await until(() => a.list.getSnapshot(), (snapshot) => seq(snapshot) === 3)
    await srv.restart()
    // 새 포트 — 저장된 URL 을 바꿔 다시 붙인다(앱 재시작 흉내).
    const again = app(new MemoryVault(a.vault.record === null ? null : { ...a.vault.record, url: srv.url() }))
    await again.m.start()
    await until(() => again.list.getSnapshot(), (snapshot) => seq(snapshot) === 1)
    expect(epoch(again.list.getSnapshot())).not.toBe(oldEpoch)
    expect(dotOf(again.list.getSnapshot(), 'p6')).toBe('waiting')
  })

  it('L7ⓒ 앱 재시작 뒤 안 읽음 유지 — 장부 저장을 이어 읽는다', async () => {
    const srv = await startServer()
    const a = await paired(srv)
    await until(() => a.list.getSnapshot(), (snapshot) => seq(snapshot) === 1)
    srv.change({ p6: { digest: { lastActivityAt: FIXTURE_NOW + 5_000 } } })
    await until(() => a.list.getSnapshot(), (snapshot) => seq(snapshot) === 2)
    const p6 = () => {
      const snapshot = a.list.getSnapshot()
      return snapshot.phase.kind === 'ready' ? allChannels(snapshot.phase.message.list).find((channel) => channel.id === 'p6') : undefined
    }
    const channel = p6()
    if (channel === undefined) throw new Error('p6')
    expect(a.list.isUnread(channel)).toBe(true)
    a.m.setForeground(false)
    const again = app(new MemoryVault(a.vault.record), a.unreadStore)
    await again.m.start()
    await until(() => again.list.getSnapshot(), (snapshot) => seq(snapshot) >= 1)
    expect(again.list.isUnread(channel)).toBe(true)
    again.list.markRead(channel)
    expect(again.list.isUnread(channel)).toBe(false)
  })
})
