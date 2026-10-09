// 리뷰 r2 지적 시험 — R2-A1(저장 중 연결 종료·취소·다른 QR) · R2-A2(해제 한 경로 · 삭제 재시도) · R2-A4(지연 저장은 연결됨의 근거가 아니다).
// 모양은 리뷰어 프로브(raw/review/codex-r2-raw/review-probes-rerun.test.ts)를 따르되, 결함 상태가 아니라 고친 동작을 단언한다.
import { describe, expect, it } from 'vitest'
import { ConnectionManager, DEFAULT_TIMING } from '../src/core/connection'
import { ConnectionLog } from '../src/core/log'
import { DeferredVault, FakeClock, FakeSocket, SERVER, flush } from './fakes'

const A = { url: 'wss://a.example.ts.net:8577/ws', host: 'a.example.ts.net', code: 'ABCDEFGH' }
const B = { url: 'wss://b.example.ts.net:8577/ws', host: 'b.example.ts.net', code: 'HGFEDCBA' }

function setup(vault: DeferredVault = new DeferredVault(), clock: FakeClock = new FakeClock(), sockets: FakeSocket[] = []) {
  const manager = new ConnectionManager({
    vault,
    clock,
    log: new ConnectionLog(() => clock.now()),
    appVersion: 'test',
    deviceName: 'test',
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  const last = (): FakeSocket => {
    const socket = sockets[sockets.length - 1]
    if (socket === undefined) throw new Error('소켓 없음')
    return socket
  }
  return { manager, vault, clock, sockets, last }
}

function paired(socket: FakeSocket, name: string) {
  socket.serverOpen()
  socket.serverSend({ type: 'paired', protocol: 1, server: { ...SERVER, macName: name }, token: `synthetic-${name}`, device: { id: name, name } })
}

function hello(socket: FakeSocket, name: string) {
  socket.serverOpen()
  socket.serverSend({ type: 'hello', ok: true, protocol: 1, server: { ...SERVER, macName: name }, device: { id: name, name: 'test' } })
}

type T = ReturnType<typeof setup>

/** 화면·메모리·금고가 같은 맥을 가리키는가. */
function view(t: T) {
  const snap = t.manager.getSnapshot()
  return { conn: snap.conn.kind, pair: snap.pair.kind, mac: snap.info?.macName ?? null, vaultMac: t.vault.record?.macName ?? null, sockets: t.sockets.length, ops: t.vault.ops.map((op) => op.kind) }
}

describe('R2-A1 — 저장이 떠난 뒤의 페어링은 하나의 작업으로 끝난다', () => {
  it('closed-save-cancel: 저장 대기 중 소켓이 닫혀도 실패가 아니고 취소는 받지 않는다 → 저장 뒤 A 로 다시 붙는다(화면·금고 일치)', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'A')
    await flush()
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'pairing', saving: true })
    t.last().serverClose(1006)
    // 실패 화면으로 가지 않는다 — 돌아갈 「취소」 도 없다
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'pairing', saving: true })
    t.manager.resetPair()
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'pairing', saving: true })
    t.vault.op(0).finish()
    await flush()
    expect(view(t)).toEqual({ conn: 'reconnecting', pair: 'paired', mac: 'A', vaultMac: 'A', sockets: 2, ops: ['save'] })
    // 저장한 토큰으로 hello
    t.last().serverOpen()
    expect(t.last().url).toBe(A.url)
    expect(t.last().lastSent()?.type).toBe('hello')
    expect(t.last().lastSent()?.token).toBe('synthetic-A')
  })

  it('closed-save-new-fails: 저장 대기 중 다른 QR(B) 은 시작하지 않는다 → 저장 뒤 화면·금고·재시작이 모두 A', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'A')
    await flush()
    t.last().serverClose(1006)
    t.manager.resetPair()
    t.manager.pair(B)
    expect(t.sockets).toHaveLength(1)
    t.vault.op(0).finish()
    await flush()
    expect(view(t)).toMatchObject({ pair: 'paired', mac: 'A', vaultMac: 'A' })
    // restart — 금고가 가리키는 맥과 화면이 가리켰던 맥이 같다
    const restart = setup(t.vault, t.clock)
    await restart.manager.start()
    expect(restart.last().url).toBe(A.url)
  })

  it('저장 실패 뒤에는 새 페어링을 받는다(작업이 끝났다)', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'A')
    await flush()
    t.vault.op(0).fail()
    await flush()
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'failed', reason: 'save_failed' })
    t.manager.resetPair()
    t.manager.pair(B)
    expect(t.sockets).toHaveLength(2)
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'pairing', host: B.host, saving: false })
  })

  it('양성 대조 — 저장 전(paired 수신 전) A3 취소는 받는다: 소켓 닫힘, 저장 없음, 새 페어링 가능', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    t.last().serverOpen()
    t.manager.resetPair()
    expect(t.sockets[0]?.closedByClient).toBe(1000)
    expect(t.manager.getSnapshot().pair.kind).toBe('idle')
    t.manager.pair(B)
    expect(t.sockets).toHaveLength(2)
    expect(t.vault.ops).toHaveLength(0)
  })

  it('저장 중 해제(unpair)는 해제 경로가 이긴다 — 늦은 저장은 반영되지 않고 삭제가 그 뒤에 돈다', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'A')
    await flush()
    const unpairing = t.manager.unpair()
    expect(t.sockets[0]?.closedByClient).toBe(1000)
    t.vault.op(0).finish()
    await flush()
    expect(view(t)).toMatchObject({ conn: 'unpairing', pair: 'idle', mac: null, ops: ['save', 'clear'] })
    t.vault.op(1).finish()
    await unpairing
    expect(view(t)).toEqual({ conn: 'unpaired', pair: 'idle', mac: null, vaultMac: null, sockets: 1, ops: ['save', 'clear'] })
    t.clock.advance(60_000)
    expect(t.sockets).toHaveLength(1)
  })
})

describe('R2-A2 — 해제·삭제 재시도는 한 경로를 지난다', () => {
  it('old-clear-failure-while-new-save ~ after-ping-timeout 모양: 저장 중 B 는 시작되지 않고, 해제 삭제 실패 → 다시 지우기 → 소켓·메모리 토큰 없음, 재연결 없음', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'A')
    await flush()
    t.manager.resetPair()
    t.manager.pair(B)
    expect(view(t).ops).toEqual(['save'])
    t.vault.op(0).finish()
    await flush()
    expect(view(t)).toEqual({ conn: 'connected', pair: 'paired', mac: 'A', vaultMac: 'A', sockets: 1, ops: ['save'] })
    const unpairing = t.manager.unpair()
    await flush()
    t.vault.op(1).fail()
    await unpairing
    expect(view(t)).toMatchObject({ conn: 'unpair_failed', pair: 'idle', mac: null, vaultMac: 'A' })
    const retry = t.manager.retryUnpair()
    expect(t.manager.getSnapshot().conn.kind).toBe('unpairing')
    await flush()
    t.vault.op(2).finish()
    await retry
    expect(view(t)).toEqual({ conn: 'unpaired', pair: 'idle', mac: null, vaultMac: null, sockets: 1, ops: ['save', 'clear', 'clear'] })
    expect(t.sockets.every((socket) => socket.closedByClient !== null)).toBe(true)
    // after-ping-timeout — 마감이 지나도 새 소켓·hello 없음
    const sent = t.sockets[0]?.sent.length
    t.clock.advance(8_000)
    t.clock.advance(8_000)
    t.clock.advance(500)
    expect(t.sockets).toHaveLength(1)
    expect(t.sockets[0]?.sent.length).toBe(sent)
  })

  it('다시 지우기도 실패하면 unpair_failed 그대로(숨기지 않는다) → 세 번째에 성공', async () => {
    const t = setup(new DeferredVault({ token: 'synthetic-A', url: A.url, macName: 'A', serverVersion: '0.2.0', deviceId: 'A', deviceName: 'test', pairedAt: 1 }))
    await t.manager.start()
    hello(t.last(), 'A')
    const unpairing = t.manager.unpair()
    await flush()
    t.vault.op(0).fail()
    await unpairing
    const retry1 = t.manager.retryUnpair()
    await flush()
    t.vault.op(1).fail()
    await retry1
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpair_failed', reason: 'user' })
    expect(t.vault.record).not.toBeNull()
    const retry2 = t.manager.retryUnpair()
    await flush()
    t.vault.op(2).finish()
    await retry2
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'user' })
    expect(t.vault.record).toBeNull()
  })

  it('앞 해제의 늦은 결과는 뒤 해제 상태를 덮지 않는다(세대) — 해지 삭제 실패 대기 중 다시 지우기', async () => {
    const t = setup(new DeferredVault({ token: 'synthetic-A', url: A.url, macName: 'A', serverVersion: '0.2.0', deviceId: 'A', deviceName: 'test', pairedAt: 1 }))
    await t.manager.start()
    hello(t.last(), 'A')
    t.last().serverSend({ type: 'error', code: 'revoked', message: '' })
    t.last().serverClose(4003)
    await flush()
    t.vault.op(0).fail()
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpair_failed', reason: 'revoked' })
    const retry = t.manager.retryUnpair()
    // 다시 지우기의 삭제가 끝나기 전에는 「해제됨」 이 아니다
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpairing', reason: 'revoked' })
    t.vault.op(1).finish()
    await retry
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'revoked' })
  })
})

describe('R2-A4 — 지연된 토큰 저장 완료는 서버 수신이 아니다', () => {
  it('stale-paired-after-60s-save + OPEN 블랙홀: 연결됨이 아니라 확인 중 → 프로브 마감 3초 뒤 재연결', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'A')
    const receivedAt = t.clock.now()
    await flush()
    t.clock.advance(60_000)
    t.vault.op(0).finish()
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'checking', since: receivedAt + 60_000, lastConnectedAt: receivedAt })
    expect(t.manager.getSnapshot().pair.kind).toBe('paired')
    expect(t.manager.send({ type: 'x' })).toBe(false)
    expect(t.last().lastSent()?.type).toBe('ping')
    t.clock.advance(DEFAULT_TIMING.probeDeadlineMs)
    expect(t.manager.getSnapshot().conn).toMatchObject({ kind: 'reconnecting', reason: 'probe_timeout' })
    t.clock.advance(500)
    expect(t.sockets).toHaveLength(2)
    t.last().serverOpen()
    expect(t.last().lastSent()?.type).toBe('hello')
  })

  it('지연 저장 뒤 서버가 pong 으로 답하면 그 수신 시각으로 연결됨', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'A')
    await flush()
    t.clock.advance(60_000)
    t.vault.op(0).finish()
    await flush()
    t.clock.advance(200)
    const ping = t.last().lastSent()
    t.last().serverSend({ type: 'pong', id: ping?.id })
    expect(t.manager.getSnapshot().conn).toMatchObject({ kind: 'connected', lastAliveAt: t.clock.now() })
    expect(t.manager.send({ type: 'x' })).toBe(true)
  })

  it('양성 대조 — 저장이 짧으면(마감 안) paired 수신 시각으로 곧장 연결됨', async () => {
    const t = setup()
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'A')
    const receivedAt = t.clock.now()
    await flush()
    t.clock.advance(50)
    t.vault.op(0).finish()
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'connected', since: receivedAt, lastAliveAt: receivedAt })
  })
})

