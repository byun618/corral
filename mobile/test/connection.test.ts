// 연결 관리자 단위 시험 — 상태기계(P5ⓐ)·자동 재연결(P6)·토큰 삭제 조건(E4)·새 연결로 교체(P6ⓒ)·비밀(P10).
import { describe, expect, it } from 'vitest'
import { ConnectionManager, DEFAULT_TIMING } from '../src/core/connection'
import { ConnectionLog } from '../src/core/log'
import { parsePairingPayload } from '../src/core/payload'
import { CODE, FakeClock, FakeSocket, MemoryVault, SERVER, TOKEN, URL, flush, record } from './fakes'

function setup(input: { paired?: boolean } = {}) {
  const clock = new FakeClock()
  const vault = new MemoryVault(input.paired === false ? null : record())
  const log = new ConnectionLog(() => clock.now())
  const lines: string[] = []
  log.addSink((_entry, line) => lines.push(line))
  const sockets: FakeSocket[] = []
  const manager = new ConnectionManager({
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    vault,
    clock,
    log,
    appVersion: '0.1.0',
    deviceName: 'Z Flip7',
  })
  const last = (): FakeSocket => {
    const socket = sockets[sockets.length - 1]
    if (socket === undefined) throw new Error('소켓 없음')
    return socket
  }
  /** 지금 소켓을 열고 hello 에 답한다. */
  const accept = (): FakeSocket => {
    const socket = last()
    socket.serverOpen()
    socket.serverSend({ type: 'hello', ok: true, protocol: 1, server: SERVER, device: { id: 'dev1', name: 'Z Flip7' } })
    return socket
  }
  return { clock, vault, log, lines, sockets, manager, last, accept }
}

async function connected() {
  const t = setup()
  await t.manager.start()
  t.accept()
  expect(t.manager.getSnapshot().conn.kind).toBe('connected')
  return t
}

describe('시작·인증', () => {
  it('토큰 없으면 unpaired(reason null), 소켓 0', async () => {
    const t = setup({ paired: false })
    await t.manager.start()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: null })
    expect(t.sockets).toHaveLength(0)
  })

  it('토큰 있으면 곧장 hello — 소켓 OPEN 만으로는 연결됨이 아니다, hello 응답 뒤에 연결됨', async () => {
    const t = setup()
    await t.manager.start()
    expect(t.manager.getSnapshot().conn.kind).toBe('reconnecting')
    const socket = t.last()
    socket.serverOpen()
    expect(socket.lastSent()).toMatchObject({ type: 'hello', protocol: 1, token: TOKEN })
    // OPEN 이고 hello 를 보냈어도 아직 연결됨 아님(P5ⓒ)
    expect(t.manager.getSnapshot().conn.kind).toBe('reconnecting')
    socket.serverSend({ type: 'hello', ok: true, protocol: 1, server: { ...SERVER, macName: '새 이름' }, device: { id: 'dev1', name: 'Z Flip7' } })
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(t.manager.getSnapshot().info?.macName).toBe('새 이름')
    await flush()
    expect(t.vault.record?.macName).toBe('새 이름')
  })
})

describe('half-open (P6ⓐ, E7 ≤ 20초)', () => {
  it('서버가 응답을 멈추면 ping 마감으로 재연결 중 — 20초 안', async () => {
    const t = await connected()
    const first = t.last()
    const stalledAt = t.clock.now()
    // 서버는 아무것도 보내지 않는다(close 없음)
    let detectedAt: number | null = null
    for (let i = 0; i < 400 && detectedAt === null; i += 1) {
      t.clock.advance(100)
      if (t.manager.getSnapshot().conn.kind === 'reconnecting') detectedAt = t.clock.now()
    }
    expect(detectedAt).not.toBeNull()
    expect((detectedAt ?? 0) - stalledAt).toBeLessThanOrEqual(20_000)
    expect((detectedAt ?? 0) - stalledAt).toBeLessThanOrEqual(DEFAULT_TIMING.pingIntervalMs + DEFAULT_TIMING.pongDeadlineMs)
    expect(first.closedByClient).toBe(1000)
    // 풀리면 사용자 조작 없이 연결됨
    t.clock.advance(1_000)
    expect(t.sockets.length).toBe(2)
    t.accept()
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
  })

  it('pong 이 오면 연결됨 유지, lastAliveAt 갱신', async () => {
    const t = await connected()
    const socket = t.last()
    for (let i = 0; i < 5; i += 1) {
      t.clock.advance(DEFAULT_TIMING.pingIntervalMs)
      expect(socket.lastSent()).toMatchObject({ type: 'ping' })
      socket.serverSend({ type: 'pong', id: 1, at: 0 })
    }
    const conn = t.manager.getSnapshot().conn
    expect(conn.kind).toBe('connected')
    if (conn.kind === 'connected') expect(conn.lastAliveAt).toBe(t.clock.now())
    expect(t.sockets).toHaveLength(1)
  })
})

describe('복귀 프로브 (P6ⓑ)', () => {
  it('복귀 즉시 프로브 — 그동안 checking(연결됨 아님), pong 이면 연결됨', async () => {
    const t = await connected()
    const socket = t.last()
    t.manager.setForeground(false)
    expect(t.clock.pending()).toBe(0)
    t.clock.jump(120_000)
    const before = socket.sent.length
    t.manager.setForeground(true)
    expect(t.manager.getSnapshot().conn.kind).toBe('checking')
    expect(socket.sent.length).toBe(before + 1)
    expect(socket.lastSent()).toMatchObject({ type: 'ping' })
    expect(t.lines.some((line) => line.includes('"event":"probe"') && line.includes('"why":"resume"'))).toBe(true)
    socket.serverSend({ type: 'pong', id: 1, at: 0 })
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
  })

  it('복귀 프로브가 마감(3초) 안에 답이 없으면 새 연결 — 5초 안에 연결됨', async () => {
    const t = await connected()
    t.manager.setForeground(false)
    t.clock.jump(300_000)
    const resumedAt = t.clock.now()
    t.manager.setForeground(true)
    t.clock.advance(DEFAULT_TIMING.probeDeadlineMs)
    expect(t.manager.getSnapshot().conn.kind).toBe('reconnecting')
    t.clock.advance(DEFAULT_TIMING.backoffMs[0] ?? 0)
    expect(t.sockets).toHaveLength(2)
    t.accept()
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(t.clock.now() - resumedAt).toBeLessThanOrEqual(5_000)
  })

  it('복귀 시 소켓이 이미 닫혀 있으면 프로브 없이 곧 재연결', async () => {
    const t = await connected()
    t.manager.setForeground(false)
    t.last().readyState = 3
    t.manager.setForeground(true)
    expect(t.manager.getSnapshot().conn.kind).toBe('reconnecting')
  })

  it('백그라운드 동안 멈춘 타이머가 복귀 직후 오판을 만들지 않는다', async () => {
    const t = await connected()
    const socket = t.last()
    t.clock.advance(DEFAULT_TIMING.pingIntervalMs) // ping 하나 보낸 상태(답 대기)
    t.manager.setForeground(false)
    t.clock.jump(60_000)
    t.manager.setForeground(true)
    socket.serverSend({ type: 'pong', id: 2, at: 0 })
    t.clock.advance(100)
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(t.sockets).toHaveLength(1)
  })
})

describe('새 연결로 교체 (P6ⓒ)', () => {
  it('이전 소켓의 늦은 close·message·error 는 상태를 바꾸지 않고, 송신은 새 소켓으로만', async () => {
    const t = await connected()
    const old = t.last()
    // half-open → 재연결
    t.clock.advance(DEFAULT_TIMING.pingIntervalMs + DEFAULT_TIMING.pongDeadlineMs)
    t.clock.advance(DEFAULT_TIMING.backoffMs[0] ?? 0)
    const fresh = t.accept()
    expect(fresh).not.toBe(old)
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    // 이전 소켓 핸들러는 떼어졌다
    expect(old.onmessage).toBeNull()
    expect(old.onclose).toBeNull()
    // 그래도 누가 이전 참조로 이벤트를 쏘면(늦은 이벤트) — 아무 일도 없다
    old.serverSend({ type: 'error', code: 'revoked', message: 'x' })
    old.serverClose(4003)
    old.serverError()
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(t.vault.record).not.toBeNull()
    const oldCount = old.sent.length
    expect(t.manager.send({ type: 'ping', id: 'x' })).toBe(true)
    t.clock.advance(DEFAULT_TIMING.pingIntervalMs)
    expect(old.sent.length).toBe(oldCount)
    expect(fresh.sent.some((m) => m.id === 'x')).toBe(true)
  })

  it('끊긴 동안 send 는 거절(false) — 연결됨에서만 보낸다', async () => {
    const t = await connected()
    t.last().serverClose(1006)
    expect(t.manager.send({ type: 'ping' })).toBe(false)
  })
})

describe('신호 → 반응 (E4)', () => {
  it('revoked(4003) → 토큰 삭제 → unpaired(revoked)', async () => {
    const t = await connected()
    t.last().serverSend({ type: 'error', code: 'revoked', message: '기기가 해지되었다' })
    t.last().serverClose(4003)
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'revoked' })
    expect(t.vault.record).toBeNull()
    expect(t.vault.clears).toBe(1)
    t.clock.advance(60_000)
    expect(t.sockets).toHaveLength(1)
  })

  it('hello 에 unauthorized(4001) → 토큰 삭제 → unpaired(unauthorized)', async () => {
    const t = setup()
    await t.manager.start()
    const socket = t.last()
    socket.serverOpen()
    socket.serverSend({ type: 'error', code: 'unauthorized', message: '인증 실패' })
    socket.serverClose(4001)
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'unauthorized' })
    expect(t.vault.record).toBeNull()
  })

  it.each([
    ['unavailable 4009', 4009, 'unavailable', true],
    ['shutdown 1001', 1001, null, true],
    ['abnormal 1006', 1006, null, false],
    ['auth_timeout 4008', 4008, 'auth_timeout', false],
    ['replaced 4006', 4006, 'replaced', false],
    ['not_authenticated 4001', 4001, 'not_authenticated', false],
  ])('%s → 토큰 유지 + 자동 재연결', async (_name, code, error, offlineNow) => {
    const t = await connected()
    if (error !== null) t.last().serverSend({ type: 'error', code: error, message: '' })
    t.last().serverClose(code)
    await flush()
    const conn = t.manager.getSnapshot().conn
    expect(conn.kind).toBe('reconnecting')
    if (conn.kind === 'reconnecting') expect(conn.offline).toBe(offlineNow)
    expect(t.vault.record?.token).toBe(TOKEN)
    expect(t.vault.clears).toBe(0)
    t.clock.advance(DEFAULT_TIMING.backoffMs[0] ?? 0)
    expect(t.sockets).toHaveLength(2)
    t.accept()
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
  })

  it('망 오류(error 이벤트만) → 토큰 유지 + 재연결', async () => {
    const t = await connected()
    t.last().serverError()
    expect(t.manager.getSnapshot().conn.kind).toBe('reconnecting')
    expect(t.vault.record).not.toBeNull()
  })

  it('protocol_mismatch(4002) → mismatch, 토큰 유지, 자동 재시도 없음, 「다시 연결」 은 받는다', async () => {
    const t = setup()
    await t.manager.start()
    const socket = t.last()
    socket.serverOpen()
    socket.serverSend({ type: 'error', code: 'protocol_mismatch', message: '', supported: [2] })
    socket.serverClose(4002)
    expect(t.manager.getSnapshot().conn).toMatchObject({ kind: 'mismatch', supported: [2] })
    expect(t.vault.record).not.toBeNull()
    t.clock.advance(120_000)
    expect(t.sockets).toHaveLength(1)
    t.manager.reconnectNow()
    expect(t.sockets).toHaveLength(2)
  })
})

describe('재시도·끊김 표시 (P5ⓐ·E7)', () => {
  it('백오프 상한 15초, 포그라운드 동안 멈추지 않는다, 20초 뒤 끊김(offline) 표시', async () => {
    const t = await connected()
    t.last().serverClose(1006)
    const gaps: number[] = []
    let lastCount = t.sockets.length
    let lastAt = t.clock.now()
    for (let i = 0; i < 1200; i += 1) {
      t.clock.advance(100)
      if (t.sockets.length !== lastCount) {
        gaps.push(t.clock.now() - lastAt)
        lastAt = t.clock.now()
        lastCount = t.sockets.length
        t.last().serverClose(1006) // 매번 실패
      }
    }
    expect(gaps.length).toBeGreaterThan(5)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15_000)
    const conn = t.manager.getSnapshot().conn
    expect(conn.kind).toBe('reconnecting')
    if (conn.kind === 'reconnecting') expect(conn.offline).toBe(true)
  })

  it('「다시 연결」 은 백오프를 기다리지 않는다', async () => {
    const t = await connected()
    t.last().serverClose(1006)
    for (let i = 0; i < 4; i += 1) {
      t.clock.advance(15_000)
      t.last().serverClose(1006)
    }
    const count = t.sockets.length
    t.manager.reconnectNow()
    expect(t.sockets.length).toBe(count + 1)
  })

  it('연결됨에서 「다시 연결」 은 프로브', async () => {
    const t = await connected()
    t.manager.reconnectNow()
    expect(t.last().lastSent()).toMatchObject({ type: 'ping' })
    expect(t.sockets).toHaveLength(1)
  })

  it('망 바뀜 → 연결됨이면 즉시 프로브, 답 없으면 3초 뒤 재연결', async () => {
    const t = await connected()
    t.manager.networkChanged({ type: 'cellular', reachable: true })
    expect(t.last().lastSent()).toMatchObject({ type: 'ping' })
    t.clock.advance(DEFAULT_TIMING.probeDeadlineMs)
    expect(t.manager.getSnapshot().conn.kind).toBe('reconnecting')
  })

  it('connect 마감 — 열리지도 닫히지도 않는 소켓은 8초 뒤 버린다', async () => {
    const t = setup()
    await t.manager.start()
    t.clock.advance(DEFAULT_TIMING.connectDeadlineMs)
    expect(t.last().closedByClient).toBe(1000)
    t.clock.advance(DEFAULT_TIMING.backoffMs[0] ?? 0)
    expect(t.sockets).toHaveLength(2)
  })
})

describe('페어링 (P3·P4)', () => {
  function target() {
    const parsed = parsePairingPayload(JSON.stringify({ kind: 'corral-pair', v: 1, url: URL, code: CODE }))
    if (!parsed.ok) throw new Error('payload')
    return parsed.target
  }

  it('pair → paired → 금고에 저장, 같은 소켓으로 연결됨', async () => {
    const t = setup({ paired: false })
    await t.manager.start()
    t.manager.pair(target())
    expect(t.manager.getSnapshot().pair.kind).toBe('pairing')
    const socket = t.last()
    socket.serverOpen()
    expect(socket.lastSent()).toEqual({ type: 'pair', protocol: 1, code: CODE, name: 'Z Flip7' })
    socket.serverSend({ type: 'paired', protocol: 1, server: SERVER, token: TOKEN, device: { id: 'd9', name: 'Z Flip7' } })
    await flush()
    expect(t.vault.record).toMatchObject({ token: TOKEN, url: URL, macName: '시험 맥', deviceId: 'd9' })
    expect(t.manager.getSnapshot().pair).toEqual({ kind: 'paired', macName: '시험 맥', serverVersion: '0.2.0' })
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(t.sockets).toHaveLength(1)
    // 화면을 넘긴 뒤 resetPair 는 넘겨받은 연결을 끊지 않는다
    t.manager.resetPair()
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(socket.closedByClient).toBeNull()
  })

  it.each(['code_expired', 'code_used', 'code_invalid', 'pair_rejected', 'device_limit', 'unavailable'] as const)('%s → failed(%s), 토큰 저장 0', async (code) => {
    const t = setup({ paired: false })
    await t.manager.start()
    t.manager.pair(target())
    const socket = t.last()
    socket.serverOpen()
    socket.serverSend({ type: 'error', code, message: '' })
    socket.serverClose(code === 'unavailable' ? 4009 : 4005)
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'failed', reason: code })
    expect(t.vault.saves).toBe(0)
  })

  it('protocol_mismatch → failed(protocol_mismatch) + supported', async () => {
    const t = setup({ paired: false })
    await t.manager.start()
    t.manager.pair(target())
    const socket = t.last()
    socket.serverOpen()
    socket.serverSend({ type: 'error', code: 'protocol_mismatch', message: '', supported: [1] })
    socket.serverClose(4002)
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'failed', reason: 'protocol_mismatch', supported: [1] })
  })

  it('닿지 않음(열기 전 error/close) → unreachable · 마감도 unreachable', async () => {
    const t = setup({ paired: false })
    await t.manager.start()
    t.manager.pair(target())
    t.last().serverError()
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'failed', reason: 'unreachable' })
    t.manager.resetPair()
    t.manager.pair(target())
    t.clock.advance(DEFAULT_TIMING.connectDeadlineMs)
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'failed', reason: 'unreachable' })
  })

  it('금고 저장 실패 → save_failed, 연결 닫음', async () => {
    const t = setup({ paired: false })
    t.vault.failSave = true
    await t.manager.start()
    t.manager.pair(target())
    const socket = t.last()
    socket.serverOpen()
    socket.serverSend({ type: 'paired', protocol: 1, server: SERVER, token: TOKEN, device: { id: 'd9', name: 'x' } })
    await flush()
    expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'failed', reason: 'save_failed' })
    expect(socket.closedByClient).toBe(1000)
  })

  it('A3 취소 → 소켓 닫고 idle', async () => {
    const t = setup({ paired: false })
    await t.manager.start()
    t.manager.pair(target())
    t.manager.resetPair()
    expect(t.manager.getSnapshot().pair.kind).toBe('idle')
    expect(t.last().closedByClient).toBe(1000)
  })
})

describe('해제 (P9ⓒ)', () => {
  it('사용자 해제 → 토큰 삭제, 소켓 닫음, unpaired(user)', async () => {
    const t = await connected()
    await t.manager.unpair()
    expect(t.vault.record).toBeNull()
    expect(t.last().closedByClient).toBe(1000)
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'user' })
    expect(t.manager.getSnapshot().info).toBeNull()
  })
})

describe('비밀 (P10)', () => {
  it('기록·상태 스냅샷에 토큰·코드가 없다', async () => {
    const t = setup({ paired: false })
    await t.manager.start()
    const parsed = parsePairingPayload(JSON.stringify({ kind: 'corral-pair', v: 1, url: URL, code: CODE }))
    if (!parsed.ok) throw new Error('payload')
    t.manager.pair(parsed.target)
    const socket = t.last()
    socket.serverOpen()
    socket.serverSend({ type: 'paired', protocol: 1, server: SERVER, token: TOKEN, device: { id: 'd9', name: 'x' } })
    await flush()
    t.clock.advance(30_000)
    t.manager.setForeground(false)
    t.manager.setForeground(true)
    t.last().serverClose(1006)
    t.clock.advance(5_000)
    // 일부러 비밀을 칸에 넣어도 가린다
    t.log.add('probe', { note: `x${TOKEN}y` })
    const all = t.lines.join('\n') + t.log.text() + JSON.stringify(t.manager.getSnapshot())
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(CODE)
    expect(all).toContain('<redacted>')
  })
})
