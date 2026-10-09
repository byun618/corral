// 실제 서버 통합 시험 — app/ 의 MobileServer(LIFE-577 + E3)를 띄우고 앱 연결 관리자를 node `ws` 로 붙인다.
// 페어링 실패 신호(P4)·재시작 hello(P3ⓓ)·해지(P9)·half-open(P6ⓐ)·서버 종료/재기동(P6ⓓ)·unavailable(P6ⓔ)를 진짜 서버 신호로 본다.
// 서버 쪽 Origin·바인딩은 건드리지 않는다 — node 클라이언트는 Origin 을 보내지 않는다(SURFACE §2).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PairingStore } from '../../app/src/main/mobile/pairing'
import { MobileServer } from '../../app/src/main/mobile/server'
import { createTimerClock } from '../src/core/clock'
import { ConnectionManager, type ConnState, type SocketLike, type Timing } from '../src/core/connection'
import { ConnectionLog } from '../src/core/log'
import { MemoryVault } from './fakes'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const realClock = createTimerClock()

/** node `ws` 를 브라우저식 소켓 모양으로. RN WebSocket 과 같은 칸만 쓴다. */
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

/** 서버 앞의 TCP 중계 — `freeze` 는 열린 연결의 바이트를 버린다(close 없음 = half-open). 대상 포트를 바꿀 수 있다(서버 재기동). */
async function relay(target: () => number) {
  const live = new Set<{ client: net.Socket; upstream: net.Socket; frozen: boolean }>()
  const server = net.createServer((client) => {
    const upstream = net.connect(target(), '127.0.0.1')
    const pair = { client, upstream, frozen: false }
    live.add(pair)
    client.on('data', (chunk) => { if (!pair.frozen) upstream.write(chunk) })
    upstream.on('data', (chunk) => { if (!pair.frozen) client.write(chunk) })
    const end = () => {
      live.delete(pair)
      client.destroy()
      upstream.destroy()
    }
    client.on('close', () => { if (!pair.frozen) end() })
    upstream.on('close', () => { if (!pair.frozen) end() })
    client.on('error', () => {})
    upstream.on('error', () => {})
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('relay 주소')
  cleanups.push(() => new Promise<void>((done) => {
    for (const pair of live) { pair.client.destroy(); pair.upstream.destroy() }
    server.close(() => done())
  }))
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    freezeAll: () => { for (const pair of live) pair.frozen = true },
  }
}

const FAST: Partial<Timing> = { pingIntervalMs: 300, pongDeadlineMs: 300, probeDeadlineMs: 300, connectDeadlineMs: 1_000, backoffMs: [100, 200, 400], offlineAfterMs: 2_000 }

async function startServer(input: { now?: () => number; accepting?: () => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l578i-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new PairingStore({ dir: path.join(dir, 'mobile'), now: input.now })
  store.load()
  const logs: string[] = []
  const server = new MobileServer({
    pairing: store,
    appVersion: '0.2.0-it',
    macName: () => '시험 맥',
    log: (tag, fields = {}) => logs.push(`${tag} ${JSON.stringify(fields)}`),
    onChange: () => {},
    accepting: input.accepting,
    livenessIntervalMs: 200,
    idleTimeoutMs: 800,
  })
  let port = await server.start()
  cleanups.push(() => server.stop())
  return {
    store,
    server,
    logs,
    port: () => port,
    url: () => `ws://127.0.0.1:${port}/ws`,
    restart: async () => {
      await server.stop()
      port = await server.start()
    },
  }
}

function manager(vault: MemoryVault, timing: Partial<Timing> = FAST) {
  const log = new ConnectionLog(() => Date.now())
  const m = new ConnectionManager({ openSocket: nodeSocket, vault, clock: realClock, log, appVersion: '0.1.0', deviceName: 'it-phone', timing })
  cleanups.push(() => m.setForeground(false))
  cleanups.push(() => { void m.unpair().catch(() => {}) })
  return { m, log }
}

async function until(m: ConnectionManager, pred: (conn: ConnState) => boolean, timeoutMs = 5_000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred(m.getSnapshot().conn)) return Date.now() - start
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`시간 초과 — 상태 ${JSON.stringify(m.getSnapshot().conn)} / pair ${JSON.stringify(m.getSnapshot().pair)}`)
}

async function untilPair(m: ConnectionManager, kind: string, timeoutMs = 5_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (m.getSnapshot().pair.kind === kind) return m.getSnapshot().pair
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`시간 초과 — pair ${JSON.stringify(m.getSnapshot().pair)}`)
}

function target(url: string, code: string) {
  return { url, host: '127.0.0.1', code }
}

async function pairWith(srv: Awaited<ReturnType<typeof startServer>>, url: string) {
  const vault = new MemoryVault()
  const { m, log } = manager(vault)
  await m.start()
  m.pair(target(url, srv.store.createCode().code))
  await untilPair(m, 'paired')
  await until(m, (c) => c.kind === 'connected')
  return { m, vault, log }
}

describe('페어링 → 재시작 hello (P3ⓐⓓ)', () => {
  it('pair → paired(맥 이름·서버 버전) → 연결됨, 새 관리자(앱 재시작)는 저장 토큰으로 hello → 연결됨', async () => {
    const srv = await startServer()
    const { m, vault, log } = await pairWith(srv, srv.url())
    expect(m.getSnapshot().pair).toEqual({ kind: 'paired', macName: '시험 맥', serverVersion: '0.2.0-it' })
    expect(m.getSnapshot().info?.macName).toBe('시험 맥')
    const token = vault.record?.token ?? ''
    expect(token.length).toBeGreaterThan(20)
    m.setForeground(false)
    // 앱 재시작
    const again = manager(new MemoryVault(vault.record))
    await again.m.start()
    await until(again.m, (c) => c.kind === 'connected')
    expect(again.m.getSnapshot().info?.macName).toBe('시험 맥')
    expect(srv.store.list().length).toBe(1)
    // 기록·서버 로그에 토큰 없음(P10)
    expect(log.text() + again.log.text() + srv.logs.join('\n')).not.toContain(token)
  })
})

describe('페어링 실패 신호 (P4)', () => {
  it('code_used — 같은 코드 두 번째', async () => {
    const srv = await startServer()
    const code = srv.store.createCode().code
    const first = manager(new MemoryVault())
    await first.m.start()
    first.m.pair(target(srv.url(), code))
    await untilPair(first.m, 'paired')
    const second = manager(new MemoryVault())
    await second.m.start()
    second.m.pair(target(srv.url(), code))
    expect(await untilPair(second.m, 'failed')).toMatchObject({ reason: 'code_used' })
  })

  it('code_expired — 10분 지난 코드', async () => {
    let now = Date.now()
    const srv = await startServer({ now: () => now })
    const code = srv.store.createCode().code
    now += 11 * 60_000
    const { m } = manager(new MemoryVault())
    await m.start()
    m.pair(target(srv.url(), code))
    expect(await untilPair(m, 'failed')).toMatchObject({ reason: 'code_expired' })
  })

  it('code_invalid — 모르는 코드', async () => {
    const srv = await startServer()
    srv.store.createCode()
    const { m } = manager(new MemoryVault())
    await m.start()
    m.pair(target(srv.url(), 'ABCDEFGH'))
    expect(await untilPair(m, 'failed')).toMatchObject({ reason: 'code_invalid' })
  })

  it('device_limit — 5대가 차 있으면', async () => {
    const srv = await startServer()
    for (let i = 0; i < 5; i += 1) {
      const { m } = manager(new MemoryVault())
      await m.start()
      m.pair(target(srv.url(), srv.store.createCode().code))
      await untilPair(m, 'paired')
      m.setForeground(false)
    }
    const { m } = manager(new MemoryVault())
    await m.start()
    m.pair(target(srv.url(), srv.store.createCode().code))
    expect(await untilPair(m, 'failed')).toMatchObject({ reason: 'device_limit' })
  })

  it('unavailable — 노출이 막힌 서버', async () => {
    const srv = await startServer({ accepting: () => false })
    const { m } = manager(new MemoryVault())
    await m.start()
    m.pair(target(srv.url(), srv.store.createCode().code))
    expect(await untilPair(m, 'failed')).toMatchObject({ reason: 'unavailable' })
  })

  it('unreachable — 닫힌 포트', async () => {
    const probe = net.createServer()
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
    const address = probe.address()
    if (address === null || typeof address === 'string') throw new Error('port')
    await new Promise<void>((done) => probe.close(() => done()))
    const { m } = manager(new MemoryVault())
    await m.start()
    m.pair(target(`ws://127.0.0.1:${address.port}/ws`, 'ABCD2345'))
    expect(await untilPair(m, 'failed')).toMatchObject({ reason: 'unreachable' })
  })
})

describe('해지 (P9ⓐⓑ)', () => {
  it('열린 연결에서 맥이 해지 → revoked → 토큰 삭제 → unpaired ≤ 3초', async () => {
    const srv = await startServer()
    const { m, vault } = await pairWith(srv, srv.url())
    const device = srv.store.list()[0]
    if (device === undefined) throw new Error('device')
    const at = Date.now()
    srv.store.revoke(device.id)
    srv.server.disconnectDevice(device.id)
    await until(m, (c) => c.kind === 'unpaired')
    expect(Date.now() - at).toBeLessThanOrEqual(3_000)
    expect(m.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'revoked' })
    expect(vault.record).toBeNull()
  })

  it('꺼진 동안 해지 → 다음 실행 unauthorized → 토큰 삭제', async () => {
    const srv = await startServer()
    const { m, vault } = await pairWith(srv, srv.url())
    const saved = vault.record
    m.setForeground(false)
    const device = srv.store.list()[0]
    if (device === undefined) throw new Error('device')
    srv.store.revoke(device.id)
    const next = new MemoryVault(saved)
    const again = manager(next)
    await again.m.start()
    await until(again.m, (c) => c.kind === 'unpaired')
    expect(again.m.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'unauthorized' })
    expect(next.record).toBeNull()
  })
})

describe('자동 재연결 (P6)', () => {
  it('half-open — 중계가 바이트를 버리면(close 없음) ping 마감으로 재연결 중, 새 연결로 자동 연결됨 · 서버 쪽 이전 연결은 replaced', async () => {
    const srv = await startServer()
    const hop = await relay(srv.port)
    const { m } = await pairWith(srv, hop.url)
    hop.freezeAll()
    const detectMs = await until(m, (c) => c.kind === 'reconnecting', 3_000)
    expect(detectMs).toBeLessThanOrEqual((FAST.pingIntervalMs ?? 0) + (FAST.pongDeadlineMs ?? 0) + 200)
    await until(m, (c) => c.kind === 'connected', 3_000)
    // 서버: 같은 기기 연결은 새 것 하나 — 이전(얼어붙은) 연결은 replaced 로 정리
    await new Promise((done) => setTimeout(done, 300))
    expect(srv.logs.some((line) => line.startsWith('mobile.replaced'))).toBe(true)
    expect(srv.server.connectedDeviceIds().size).toBe(1)
  })

  it('corral 종료(1001) → 끊김(offline) 즉시, 재기동 → 자동 재접속', async () => {
    const srv = await startServer()
    const hop = await relay(srv.port)
    const { m, vault } = await pairWith(srv, hop.url)
    await srv.server.stop()
    await until(m, (c) => c.kind === 'reconnecting' && c.offline && c.reason === 'shutdown')
    expect(vault.record).not.toBeNull()
    await srv.restart()
    await until(m, (c) => c.kind === 'connected', 5_000)
  })

  it('unavailable(4009) → 토큰 유지·재시도, 다시 받으면 자동 재접속', async () => {
    let accepting = true
    const srv = await startServer({ accepting: () => accepting })
    const { m, vault } = await pairWith(srv, srv.url())
    accepting = false
    srv.server.disconnectAll()
    await until(m, (c) => c.kind === 'reconnecting' && c.offline)
    await new Promise((done) => setTimeout(done, 600))
    expect(vault.record).not.toBeNull()
    expect(m.getSnapshot().conn.kind).toBe('reconnecting')
    accepting = true
    await until(m, (c) => c.kind === 'connected', 5_000)
  })

  it('복귀 프로브 — 백그라운드 뒤 복귀하면 프로브를 보내고 서버 pong 으로 연결됨', async () => {
    const srv = await startServer()
    const { m, log } = await pairWith(srv, srv.url())
    m.setForeground(false)
    await new Promise((done) => setTimeout(done, 300))
    m.setForeground(true)
    expect(m.getSnapshot().conn.kind).toBe('checking')
    const ms = await until(m, (c) => c.kind === 'connected', 2_000)
    expect(ms).toBeLessThan(1_000)
    expect(log.text()).toContain('"why":"resume"')
    expect(log.text()).toContain('"event":"probe_ok"')
  })
})
