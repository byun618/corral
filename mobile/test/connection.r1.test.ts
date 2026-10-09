// 리뷰 r1 지적 시험 — R1-A1(반복 프로브가 마감을 늦추지 않음) · R1-A2(→ r2 로 옮김) · R1-A3(저장·삭제 순서) ·
// R1-A4(삭제 실패는 실패로) · R1-A5(A4 에서 해지 → A1) · R1-A7(같은 대상 다시 시도) · 판별력(캡처된 이전 콜백이 새 연결을 못 바꾼다).
import { describe, expect, it } from 'vitest'
import { ConnectionManager, DEFAULT_TIMING, type Vault } from '../src/core/connection'
import { ConnectionLog } from '../src/core/log'
import { shouldGoToIntro } from '../src/core/route'
import { DeferredVault, FakeClock, FakeSocket, MemoryVault, SERVER, TOKEN, flush, record } from './fakes'

function make(vault: Vault) {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const log = new ConnectionLog(() => clock.now())
  const lines: string[] = []
  log.addSink((_entry, line) => lines.push(line))
  const manager = new ConnectionManager({
    vault,
    clock,
    log,
    appVersion: '0.1.0',
    deviceName: 'r1',
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
  return { manager, clock, sockets, last, lines }
}

const A = { url: 'wss://mac-a.tailnet.ts.net:8577/ws', host: 'mac-a.tailnet.ts.net:8577', code: 'ABCDEFGH' }

function paired(socket: FakeSocket, macName: string, token = `${TOKEN}-${macName}`) {
  socket.serverOpen()
  socket.serverSend({ type: 'paired', protocol: 1, server: { ...SERVER, macName }, token, device: { id: macName, name: 'r1' } })
}

function hello(socket: FakeSocket, server = SERVER) {
  socket.serverOpen()
  socket.serverSend({ type: 'hello', ok: true, protocol: 1, server, device: { id: 'dev1', name: 'r1' } })
}

describe('R1-A1 — 반복 프로브는 마감을 늦추지 않는다 (E7 ≤ 20초)', () => {
  it('당겨서 새로고침을 2초마다 해도 half-open 이면 20초 안에 재연결 중', async () => {
    const t = make(new MemoryVault(record()))
    await t.manager.start()
    hello(t.last())
    const stalledAt = t.clock.now()
    let detectedAt: number | null = null
    for (let i = 0; i < 20 && detectedAt === null; i += 1) {
      for (let k = 0; k < 20 && detectedAt === null; k += 1) {
        t.clock.advance(100)
        if (t.manager.getSnapshot().conn.kind !== 'connected') detectedAt = t.clock.now()
      }
      if (detectedAt === null) t.manager.reconnectNow()
    }
    expect(detectedAt).not.toBeNull()
    expect((detectedAt ?? Infinity) - stalledAt).toBeLessThanOrEqual(20_000)
    // 첫 수동 프로브(2초)의 마감 3초 — 5초 안
    expect((detectedAt ?? Infinity) - stalledAt).toBeLessThanOrEqual(2_000 + DEFAULT_TIMING.probeDeadlineMs)
  })

  it('망 바뀜 통지를 1초마다 받아도 20초 안에 재연결 중', async () => {
    const t = make(new MemoryVault(record()))
    await t.manager.start()
    hello(t.last())
    const stalledAt = t.clock.now()
    let detectedAt: number | null = null
    for (let i = 0; i < 40 && detectedAt === null; i += 1) {
      t.clock.advance(1_000)
      if (t.manager.getSnapshot().conn.kind !== 'connected') detectedAt = t.clock.now()
      else t.manager.networkChanged({ type: i % 2 === 0 ? 'wifi' : 'cellular', reachable: true })
    }
    expect((detectedAt ?? Infinity) - stalledAt).toBeLessThanOrEqual(20_000)
  })

  it('정기 ping 은 수동 프로브로 미뤄지지 않는다 — 서버가 답하면 8초마다 그대로 나간다', async () => {
    const t = make(new MemoryVault(record()))
    await t.manager.start()
    const socket = t.last()
    hello(socket)
    const pingTimes: number[] = []
    let seen = 0
    for (let i = 0; i < 300; i += 1) {
      t.clock.advance(100)
      if (i % 15 === 0) t.manager.reconnectNow()
      const pings = socket.sent.filter((m) => m.type === 'ping')
      while (seen < pings.length) {
        pingTimes.push(t.clock.now())
        seen += 1
        socket.serverSend({ type: 'pong', id: 0, at: 0 })
      }
    }
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    // 30초 동안 수동 프로브 20회 + 정기 ping ≥ 3회(미뤄졌다면 0회)
    expect(pingTimes.length).toBeGreaterThanOrEqual(20 + 3)
  })

  it('짧은 마감 프로브는 진행 중 마감을 앞당긴다 — 정기 ping 대기 중 복귀하면 3초', async () => {
    const t = make(new MemoryVault(record()))
    await t.manager.start()
    hello(t.last())
    t.clock.advance(DEFAULT_TIMING.pingIntervalMs) // 정기 ping 대기(마감 8초)
    const at = t.clock.now()
    t.manager.networkChanged({ type: 'cellular', reachable: true }) // 마감 3초로 앞당김
    t.clock.advance(DEFAULT_TIMING.probeDeadlineMs)
    expect(t.manager.getSnapshot().conn.kind).toBe('reconnecting')
    expect(t.clock.now() - at).toBe(DEFAULT_TIMING.probeDeadlineMs)
  })
})

// R1-A2(저장 대기 중 취소·새 페어링) 시험 3건은 r2 에서 의미가 바뀌었다 — 저장이 떠난 뒤에는 취소·새 페어링을 받지 않는다(R2-A1).
// 바뀐 모양은 connection.r2.test.ts 「R2-A1」 에 있다.

describe('R1-A3 — 같은 키의 저장·삭제는 순서대로', () => {
  it('metadata-save-after-delete: hello 메타 저장 대기 중 해제 → 삭제가 저장 뒤에 돌아 토큰이 남지 않는다, 재시작 소켓 0', async () => {
    const vault = new DeferredVault(record())
    const t = make(vault)
    await t.manager.start()
    hello(t.last(), { ...SERVER, version: 'new-version' })
    await flush()
    expect(vault.ops.map((op) => op.kind)).toEqual(['save'])
    const unpairing = t.manager.unpair()
    await flush()
    // 삭제는 저장이 끝나야 시작한다 — 아직 「해제됨」 아님
    expect(vault.ops.map((op) => op.kind)).toEqual(['save'])
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpairing', reason: 'user' })
    vault.op(0).finish()
    await flush()
    vault.op(1).finish()
    await unpairing
    expect(vault.record).toBeNull()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'user' })
    const restart = make(vault)
    await restart.manager.start()
    expect(restart.sockets).toHaveLength(0)
  })

  it('해제가 메타 저장보다 먼저 줄에 서면 그 저장은 건너뛴다(세대)', async () => {
    const vault = new DeferredVault(record())
    const t = make(vault)
    await t.manager.start()
    // 앞선 작업이 줄을 잡고 있게: 첫 hello 메타 저장
    hello(t.last(), { ...SERVER, version: 'v2' })
    await flush()
    const unpairing = t.manager.unpair()
    vault.op(0).finish()
    await flush()
    vault.op(1).finish()
    await unpairing
    expect(vault.ops.map((op) => op.kind)).toEqual(['save', 'clear'])
    expect(vault.record).toBeNull()
  })
})

describe('R1-A4 — 삭제 실패는 해제 성공이 아니다', () => {
  it('clear 실패 → unpair_failed(연결은 닫힘, 「해제됨」 아님) → 다시 지우기 성공 → unpaired', async () => {
    const vault = new DeferredVault(record())
    const t = make(vault)
    await t.manager.start()
    const socket = t.last()
    hello(socket)
    const unpairing = t.manager.unpair()
    // 연결은 즉시 닫는다
    expect(socket.closedByClient).toBe(1000)
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpairing', reason: 'user' })
    await flush()
    vault.op(0).fail()
    await unpairing
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpair_failed', reason: 'user' })
    expect(vault.record).not.toBeNull()
    // 실패 상태에서는 재연결도 페어링도 하지 않는다
    t.manager.reconnectNow()
    t.manager.pair(A)
    t.clock.advance(60_000)
    expect(t.sockets).toHaveLength(1)
    const retry = t.manager.retryUnpair()
    expect(t.manager.getSnapshot().conn.kind).toBe('unpairing')
    await flush()
    vault.op(1).finish()
    await retry
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'user' })
    expect(vault.record).toBeNull()
  })

  it('해지(revoked) 뒤 clear 실패도 unpair_failed(revoked)', async () => {
    const vault = new DeferredVault(record())
    const t = make(vault)
    await t.manager.start()
    hello(t.last())
    t.last().serverSend({ type: 'error', code: 'revoked', message: '' })
    t.last().serverClose(4003)
    await flush()
    vault.op(0).fail()
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpair_failed', reason: 'revoked' })
  })

  it('저장 실패(페어링) → save_failed, 금고 비어 있음', async () => {
    const vault = new DeferredVault()
    const t = make(vault)
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'mac-A')
    await flush()
    vault.op(0).fail()
    await flush()
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'failed', reason: 'save_failed' })
    expect(vault.record).toBeNull()
  })
})

describe('R1-A5 — A4 에서 해지되면 A1 로', () => {
  it('paired(A4) 뒤 revoked → unpaired(revoked) — /pair/progress 에서도 A1 으로 가야 한다', async () => {
    const t = make(new MemoryVault())
    await t.manager.start()
    t.manager.pair(A)
    paired(t.last(), 'mac-A')
    await flush()
    expect(t.manager.getSnapshot().pair.kind).toBe('paired')
    t.last().serverSend({ type: 'error', code: 'revoked', message: '' })
    t.last().serverClose(4003)
    await flush()
    const conn = t.manager.getSnapshot().conn
    expect(conn).toEqual({ kind: 'unpaired', reason: 'revoked' })
    expect(shouldGoToIntro(conn, ['pair', 'progress'])).toBe(true)
  })

  it('A1 에서 「QR 찍기」(acknowledge) → 이유가 지워져 페어링 화면에 머문다', async () => {
    const t = make(new MemoryVault(record()))
    await t.manager.start()
    hello(t.last())
    await t.manager.unpair()
    expect(shouldGoToIntro(t.manager.getSnapshot().conn, ['pair', 'scan'])).toBe(true)
    t.manager.acknowledgeUnpair()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: null })
    expect(shouldGoToIntro(t.manager.getSnapshot().conn, ['pair', 'scan'])).toBe(false)
  })
})

describe('R1-A7 — 실패한 페어링을 같은 대상으로 다시', () => {
  it('unreachable → retryPair → 같은 주소·같은 코드로 새 시도(QR 재스캔 없음), 기록에 코드 없음', async () => {
    const t = make(new MemoryVault())
    await t.manager.start()
    t.manager.pair(A)
    t.last().serverError()
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'failed', reason: 'unreachable' })
    t.manager.retryPair()
    expect(t.sockets).toHaveLength(2)
    expect(t.last().url).toBe(A.url)
    t.last().serverOpen()
    expect(t.last().lastSent()).toMatchObject({ type: 'pair', code: A.code })
    expect(t.lines.join('\n')).not.toContain(A.code)
    expect(t.lines.some((line) => line.includes('"event":"pair_retry"'))).toBe(true)
  })

  it('실패가 아니면 retryPair 는 아무것도 하지 않는다', async () => {
    const t = make(new MemoryVault())
    await t.manager.start()
    t.manager.retryPair()
    expect(t.sockets).toHaveLength(0)
  })
})

describe('판별력 — 캡처된 이전 소켓 콜백은 새 연결을 바꾸지 못한다(시도 가드)', () => {
  async function swapped() {
    const vault = new MemoryVault(record())
    const t = make(vault)
    await t.manager.start()
    const old = t.last()
    hello(old)
    // 핸들러를 떼기 전에 잡아 둔다 — RN 이벤트 큐에 이미 들어간 콜백 흉내
    const captured = { onclose: old.onclose, onmessage: old.onmessage, onerror: old.onerror, onopen: old.onopen }
    t.clock.advance(DEFAULT_TIMING.pingIntervalMs + DEFAULT_TIMING.pongDeadlineMs + DEFAULT_TIMING.backoffMs[0])
    const fresh = t.last()
    expect(fresh).not.toBe(old)
    hello(fresh)
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    return { t, vault, captured, fresh }
  }

  it('늦은 onclose(4003) 는 토큰을 지우지 않는다', async () => {
    const { t, vault, captured } = await swapped()
    captured.onclose?.({ code: 4003 })
    await flush()
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(vault.record).not.toBeNull()
  })

  it('늦은 onmessage(revoked 오류)·onerror 는 상태를 바꾸지 않는다', async () => {
    const { t, vault, captured } = await swapped()
    captured.onmessage?.({ data: JSON.stringify({ type: 'error', code: 'revoked', message: '' }) })
    captured.onerror?.({})
    await flush()
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(vault.record).not.toBeNull()
  })

  it('늦은 onopen 은 이전 소켓으로 hello 를 다시 보내지 않는다', async () => {
    const { t, captured, fresh } = await swapped()
    const before = fresh.sent.length
    captured.onopen?.({})
    expect(fresh.sent.length).toBe(before)
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
  })
})
