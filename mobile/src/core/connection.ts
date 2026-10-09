// 연결 관리자 — 페어링·인증·생존 확인·자동 재연결 (LIFE-578 P3·P5·P6·P9). RN 을 모른다: 소켓·시계·금고를 주입받는다.
//
// Orca issue-5049 의 세 원인에 대한 답:
//  ① 복귀 훅 없음 → `setForeground(true)` 가 곧장 짧은 마감의 프로브를 보낸다. 그동안 상태는 `checking`(연결됨 아님).
//  ② half-open(소켓은 OPEN 인데 망이 죽음) → 포그라운드 동안 ping 을 돌리고, 마감 안에 서버에서 아무 프레임도 오지 않으면 끊고 새로 붙는다.
//     「연결됨」 은 `hello` 응답·pong 같은 **서버 수신 위에서만** 된다 — 소켓 `OPEN` 은 연결됨의 근거가 아니다.
//  ③ 재연결 뒤 낡은 클라이언트 참조 → 시도마다 `Attempt` 를 새로 만들고, 모든 핸들러·타이머는 「내가 지금 시도인가」 를 먼저 본다.
//     낡은 소켓은 핸들러를 떼고 닫는다. 송신은 늘 `this.current` 로만 간다.
//
// 토큰은 금고(SecureStore)와 이 객체의 메모리에만 있다 — 기록·상태·오류 문구로 나가지 않는다.
// 토큰을 지우는 것은 서버가 명시적으로 거절할 때(`revoked`·`unauthorized`)와 사용자 해제뿐이다. 망 오류·마감·`unavailable`·1001 은 지우지 않는다(E4).
import type { ConnectionLog, LogValue } from './log'
import { hostOf, type PairingTarget } from './payload'
import { CLOSE, PROTOCOL_VERSION, parseServerMessage, serverPairFailure, type PairFailure, type ServerInfo } from './protocol'

// --- 주입 ---------------------------------------------------------------------------------------------

/** 브라우저식 WebSocket 의 쓰는 부분 — RN `WebSocket` 과 node `ws` 둘 다 맞는다. */
export type SocketLike = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type TimerHandle = { readonly id: unknown }

export type Clock = {
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/** 금고에 두는 것 — 전부 SecureStore 한 칸. 토큰 말고는 비밀이 아니지만 한곳에 둔다. */
export type PairingRecord = {
  token: string
  url: string
  macName: string
  serverVersion: string
  deviceId: string
  deviceName: string
  pairedAt: number
}

export type Vault = {
  load(): Promise<PairingRecord | null>
  save(record: PairingRecord): Promise<void>
  clear(): Promise<void>
}

export type Timing = {
  /** 연결됨 동안 ping 주기. */
  pingIntervalMs: number
  /** ping 을 보낸 뒤 이 안에 서버 프레임이 하나도 없으면 죽은 연결로 본다. */
  pongDeadlineMs: number
  /** 복귀·망 바뀜·「다시 연결」 프로브의 마감. */
  probeDeadlineMs: number
  /** 소켓 열기 + hello 응답(또는 paired)까지의 마감. */
  connectDeadlineMs: number
  /** 재시도 간격 — 끝 값이 상한(E7 ≤ 15초). */
  backoffMs: readonly number[]
  /** 재연결 중이 이만큼 이어지면 「끊김」 으로 보인다(재시도는 계속). */
  offlineAfterMs: number
}

export const DEFAULT_TIMING: Timing = {
  pingIntervalMs: 8_000,
  pongDeadlineMs: 8_000,
  probeDeadlineMs: 3_000,
  connectDeadlineMs: 8_000,
  backoffMs: [500, 1_000, 2_000, 4_000, 8_000, 15_000],
  offlineAfterMs: 20_000,
}

export type ConnectionDeps = {
  openSocket(url: string): SocketLike
  vault: Vault
  clock: Clock
  log: ConnectionLog
  appVersion: string
  deviceName: string
  timing?: Partial<Timing>
}

// --- 상태 ---------------------------------------------------------------------------------------------

export type UnpairReason = 'revoked' | 'unauthorized' | 'user'

export type ReconnectReason = 'launch' | 'network' | 'ping_timeout' | 'probe_timeout' | 'connect_timeout' | 'shutdown' | 'unavailable' | 'closed' | 'save_failed' | 'manual'

export type ConnState =
  | { kind: 'loading' }
  /** 토큰 없음 — 페어링 화면. reason 은 A1 에 한 줄로 보인다(첫 실행이면 null). */
  | { kind: 'unpaired'; reason: UnpairReason | null }
  /** 최근 프로브 성공 위에서만. */
  | { kind: 'connected'; since: number; lastAliveAt: number }
  /** 복귀 직후 등 — 소켓은 있으나 살아 있는지 프로브 중. 연결됨으로 보이지 않는다. */
  | { kind: 'checking'; since: number; lastConnectedAt: number }
  /** 재시도 중. `offline` = 끊김 표시(서버가 내려감·오래 실패), 재시도는 계속한다. */
  | { kind: 'reconnecting'; since: number; lastConnectedAt: number | null; attempt: number; reason: ReconnectReason; offline: boolean }
  /** 프로토콜 불일치 — 본문을 막는다. 토큰 유지, 자동 재시도 안 함(「다시 연결」 은 받는다). */
  | { kind: 'mismatch'; at: number; supported: number[] }

export type PairState =
  | { kind: 'idle' }
  | { kind: 'pairing'; host: string; startedAt: number }
  | { kind: 'paired'; macName: string; serverVersion: string }
  | { kind: 'failed'; reason: PairFailure; host: string; supported: number[] }

/** 화면에 내보내는 페어링 정보 — 토큰은 없다. */
export type PairingInfo = { url: string; host: string; macName: string; serverVersion: string; deviceName: string; pairedAt: number }

export type Snapshot = { conn: ConnState; pair: PairState; info: PairingInfo | null; appVersion: string }

// --- 시도 ---------------------------------------------------------------------------------------------

type Attempt = {
  seq: number
  purpose: 'pair' | 'connect'
  socket: SocketLike
  phase: 'opening' | 'authing' | 'live'
  ended: boolean
  /** 서버가 close 앞에 보낸 마지막 오류 코드. */
  lastError: string | null
  supported: number[]
  connectTimer: TimerHandle | null
  pingTimer: TimerHandle | null
  deadlineTimer: TimerHandle | null
  /** 프로브를 보냈고 아직 서버 프레임이 오지 않았다. */
  awaiting: boolean
  pairTarget: PairingTarget | null
}

// --- 관리자 -------------------------------------------------------------------------------------------

export class ConnectionManager {
  private readonly deps: ConnectionDeps
  private readonly timing: Timing
  private snapshot: Snapshot
  private readonly listeners = new Set<() => void>()
  private record: PairingRecord | null = null
  private current: Attempt | null = null
  private attemptSeq = 0
  private pingSeq = 0
  private failures = 0
  private retryTimer: TimerHandle | null = null
  private offlineTimer: TimerHandle | null = null
  private foreground = true
  private backgroundAt: number | null = null
  private started = false

  constructor(deps: ConnectionDeps) {
    this.deps = deps
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.snapshot = { conn: { kind: 'loading' }, pair: { kind: 'idle' }, info: null, appVersion: deps.appVersion }
  }

  // --- 구독 ---

  getSnapshot = (): Snapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(next: { conn?: ConnState; pair?: PairState }): void {
    this.snapshot = {
      conn: next.conn ?? this.snapshot.conn,
      pair: next.pair ?? this.snapshot.pair,
      info: this.record === null ? null : infoOf(this.record),
      appVersion: this.deps.appVersion,
    }
    for (const listener of this.listeners) listener()
  }

  // --- 시작 ---

  /** 금고를 읽고 토큰이 있으면 곧장 hello. 한 번만. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    let record: PairingRecord | null = null
    try {
      record = await this.deps.vault.load()
    } catch (error) {
      this.log('vault_load_failed', { error: errorName(error) })
    }
    if (record === null) {
      this.log('start', { paired: false })
      this.set({ conn: { kind: 'unpaired', reason: null } })
      return
    }
    this.record = record
    this.deps.log.rememberSecret(record.token)
    this.log('start', { paired: true, host: hostOf(record.url) })
    this.enterReconnecting('launch', null)
    this.connect()
  }

  // --- 페어링 (A2 → A3 → A4 / A6–A9) ---

  pair(target: PairingTarget): void {
    if (this.record !== null || this.snapshot.pair.kind === 'pairing') return
    this.deps.log.rememberSecret(target.code)
    this.log('pair_start', { host: target.host })
    this.set({ pair: { kind: 'pairing', host: target.host, startedAt: this.deps.clock.now() } })
    const attempt = this.open('pair', target.url, target)
    attempt.connectTimer = this.deps.clock.setTimeout(() => {
      if (this.current !== attempt || attempt.ended) return
      this.log('pair_timeout', { attempt: attempt.seq })
      this.endAttempt(attempt)
      this.set({ pair: { kind: 'failed', reason: 'unreachable', host: target.host, supported: [] } })
    }, this.timing.connectDeadlineMs)
  }

  /** A3 「취소」 · 실패 화면에서 돌아가기. */
  resetPair(): void {
    const attempt = this.current
    if (attempt !== null && attempt.purpose === 'pair') {
      this.log('pair_cancel', { attempt: attempt.seq })
      this.endAttempt(attempt)
    }
    this.set({ pair: { kind: 'idle' } })
  }

  // --- 사용자 동작 ---

  /** 「다시 연결」·당겨서 새로고침 — 연결됨이면 프로브, 아니면 기다리지 않고 지금 시도. */
  reconnectNow(): void {
    const conn = this.snapshot.conn
    if (this.record === null) return
    this.log('manual_reconnect', { state: conn.kind })
    if (conn.kind === 'connected') return this.probe(this.timing.probeDeadlineMs, 'manual')
    if (conn.kind === 'checking') return
    if (conn.kind === 'mismatch') this.enterReconnecting('manual', null)
    this.clearRetry()
    this.connect()
  }

  /** 페어링 해제(D2) — 폰 토큰만 지운다. 맥 기기 목록에는 남는다. */
  async unpair(): Promise<void> {
    this.log('unpair_user', {})
    await this.dropPairing('user')
  }

  /** M3~ 가 쓸 송신 — 연결됨에서만, 늘 지금 시도의 소켓으로. */
  send(message: Record<string, unknown>): boolean {
    const attempt = this.current
    if (this.snapshot.conn.kind !== 'connected' || attempt === null || attempt.phase !== 'live') return false
    return this.write(attempt, message)
  }

  // --- 수명 신호 (런타임이 부른다) ---

  setForeground(active: boolean): void {
    if (active === this.foreground) return
    this.foreground = active
    const now = this.deps.clock.now()
    if (!active) {
      // 백그라운드에서 JS 타이머는 멈춘다 — 복귀 순간 몰려 터지는 낡은 마감이 오판을 만들지 않게 지금 다 거둔다.
      this.backgroundAt = now
      this.log('background', { state: this.snapshot.conn.kind })
      const attempt = this.current
      // 붙는 중이던 연결 시도는 버린다 — 복귀하면 새로 시도한다(멈춘 마감이 복귀 직후 터지지 않게).
      if (attempt !== null && attempt.purpose === 'connect' && attempt.phase !== 'live') this.endAttempt(attempt)
      else if (attempt !== null) {
        this.clearTimer(attempt, 'pingTimer')
        this.clearTimer(attempt, 'deadlineTimer')
        attempt.awaiting = false
      }
      this.clearRetry()
      this.clearOfflineTimer()
      return
    }
    const awayMs = this.backgroundAt === null ? null : now - this.backgroundAt
    this.backgroundAt = null
    const conn = this.snapshot.conn
    this.log('resume', { state: conn.kind, awayMs })
    if (this.record === null) return
    if (conn.kind === 'connected' || conn.kind === 'checking') {
      const attempt = this.current
      if (attempt === null || attempt.phase !== 'live' || attempt.socket.readyState !== OPEN) {
        this.fail(attempt, 'closed')
        return
      }
      this.set({ conn: { kind: 'checking', since: now, lastConnectedAt: conn.kind === 'connected' ? conn.lastAliveAt : conn.lastConnectedAt } })
      this.probe(this.timing.probeDeadlineMs, 'resume')
      return
    }
    if (conn.kind === 'reconnecting') {
      this.armOfflineTimer()
      this.clearRetry()
      if (this.current === null || this.current.ended) this.connect()
    }
  }

  /** 망이 바뀌었다(Wi-Fi↔LTE 등) — 연결됨이면 곧장 프로브, 재시도 중이면 기다리지 않고 시도. */
  networkChanged(detail: { type: string; reachable: boolean | null }): void {
    this.log('network', { type: detail.type, reachable: detail.reachable })
    if (!this.foreground || this.record === null || detail.reachable === false) return
    const conn = this.snapshot.conn
    if (conn.kind === 'connected') return this.probe(this.timing.probeDeadlineMs, 'network')
    if (conn.kind === 'reconnecting') {
      this.clearRetry()
      if (this.current === null || this.current.ended) this.connect()
    }
  }

  // --- 시도 열기 ---

  private open(purpose: Attempt['purpose'], url: string, pairTarget: PairingTarget | null): Attempt {
    if (this.current !== null) this.endAttempt(this.current)
    this.attemptSeq += 1
    const socket = this.deps.openSocket(url)
    const attempt: Attempt = {
      seq: this.attemptSeq,
      purpose,
      socket,
      phase: 'opening',
      ended: false,
      lastError: null,
      supported: [],
      connectTimer: null,
      pingTimer: null,
      deadlineTimer: null,
      awaiting: false,
      pairTarget,
    }
    this.current = attempt
    socket.onopen = () => this.onOpen(attempt)
    socket.onmessage = (event) => this.onMessage(attempt, event.data)
    socket.onclose = (event) => this.onClose(attempt, event.code)
    socket.onerror = () => this.onError(attempt)
    return attempt
  }

  private connect(): void {
    const record = this.record
    if (record === null || !this.foreground) return
    const attempt = this.open('connect', record.url, null)
    const conn = this.snapshot.conn
    this.log('connect', { attempt: attempt.seq, host: hostOf(record.url), retry: conn.kind === 'reconnecting' ? conn.attempt : 0 })
    attempt.connectTimer = this.deps.clock.setTimeout(() => {
      if (this.current !== attempt || attempt.ended) return
      this.fail(attempt, 'connect_timeout')
    }, this.timing.connectDeadlineMs)
  }

  /** 시도를 끝낸다 — 핸들러를 먼저 떼서 이 소켓의 늦은 이벤트가 아무것도 바꾸지 못하게 한다. */
  private endAttempt(attempt: Attempt): void {
    if (attempt.ended) return
    attempt.ended = true
    this.clearTimer(attempt, 'connectTimer')
    this.clearTimer(attempt, 'pingTimer')
    this.clearTimer(attempt, 'deadlineTimer')
    const socket = attempt.socket
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close(CLOSE.normal, 'client')
    } catch {
      // 이미 닫힘
    }
    if (this.current === attempt) this.current = null
  }

  // --- 소켓 이벤트 ---

  private onOpen(attempt: Attempt): void {
    if (this.current !== attempt || attempt.ended) return
    attempt.phase = 'authing'
    if (attempt.purpose === 'pair' && attempt.pairTarget !== null) {
      this.log('pair_send', { attempt: attempt.seq })
      this.write(attempt, { type: 'pair', protocol: PROTOCOL_VERSION, code: attempt.pairTarget.code, name: this.deps.deviceName.slice(0, 64) })
      return
    }
    const record = this.record
    if (record === null) return this.endAttempt(attempt)
    this.log('hello_send', { attempt: attempt.seq })
    this.write(attempt, { type: 'hello', protocol: PROTOCOL_VERSION, token: record.token, client: { name: 'corral-mobile', version: this.deps.appVersion } })
  }

  private onMessage(attempt: Attempt, data: unknown): void {
    if (this.current !== attempt || attempt.ended) return
    if (typeof data !== 'string') return
    const message = parseServerMessage(data)
    const now = this.deps.clock.now()
    // 서버에서 프레임이 왔다 = 이 연결은 살아 있다.
    if (attempt.awaiting) {
      attempt.awaiting = false
      this.clearTimer(attempt, 'deadlineTimer')
    }
    switch (message.type) {
      case 'hello': {
        if (attempt.purpose !== 'connect' || attempt.phase !== 'authing' || this.record === null) return
        this.clearTimer(attempt, 'connectTimer')
        attempt.phase = 'live'
        const record = this.record
        if (record.macName !== message.server.macName || record.serverVersion !== message.server.version) {
          this.record = { ...record, macName: message.server.macName, serverVersion: message.server.version }
          void this.deps.vault.save(this.record).catch((error: unknown) => this.log('vault_save_failed', { error: errorName(error) }))
        }
        this.log('hello_ok', { attempt: attempt.seq, serverVersion: message.server.version })
        this.markConnected(attempt, now)
        return
      }
      case 'paired': {
        if (attempt.purpose !== 'pair' || attempt.phase !== 'authing' || attempt.pairTarget === null) return
        this.clearTimer(attempt, 'connectTimer')
        void this.adoptPairing(attempt, attempt.pairTarget, message.server, message.token, { id: message.deviceId, name: message.deviceName })
        return
      }
      case 'pong': {
        const conn = this.snapshot.conn
        if (conn.kind === 'checking') {
          this.log('probe_ok', { attempt: attempt.seq, after: 'resume' })
          this.markConnected(attempt, now)
        } else if (conn.kind === 'connected') {
          this.set({ conn: { ...conn, lastAliveAt: now } })
        }
        return
      }
      case 'error':
        attempt.lastError = message.code
        attempt.supported = message.supported
        this.log('server_error', { attempt: attempt.seq, code: message.code })
        return
      case 'other':
        return
    }
  }

  private onError(attempt: Attempt): void {
    if (this.current !== attempt || attempt.ended) return
    this.log('socket_error', { attempt: attempt.seq, phase: attempt.phase })
    // RN 은 error 뒤 close 를 보내지만, 오지 않는 경우에도 같은 길로 끝낸다.
    this.onClose(attempt, CLOSE.abnormal)
  }

  private onClose(attempt: Attempt, code: number): void {
    if (this.current !== attempt || attempt.ended) return
    const error = attempt.lastError
    this.log('closed', { attempt: attempt.seq, code, error, phase: attempt.phase })
    if (attempt.purpose === 'pair') return this.pairFailed(attempt, code)
    // E4 — 서버가 명시적으로 거절한 경우만 토큰을 지운다.
    if (error === 'revoked' || code === CLOSE.revoked) {
      this.endAttempt(attempt)
      void this.dropPairing('revoked')
      return
    }
    if (error === 'unauthorized' || (code === CLOSE.unauthorized && error !== 'not_authenticated')) {
      this.endAttempt(attempt)
      void this.dropPairing('unauthorized')
      return
    }
    if (error === 'protocol_mismatch' || code === CLOSE.protocolMismatch) {
      const supported = attempt.supported
      this.endAttempt(attempt)
      this.clearRetry()
      this.clearOfflineTimer()
      this.log('mismatch', { supported: supported.join(',') })
      this.set({ conn: { kind: 'mismatch', at: this.deps.clock.now(), supported } })
      return
    }
    const reason: ReconnectReason = code === CLOSE.shutdown ? 'shutdown' : code === CLOSE.unavailable || error === 'unavailable' ? 'unavailable' : 'closed'
    this.fail(attempt, reason)
  }

  // --- 상태 전이 ---

  private markConnected(attempt: Attempt, now: number): void {
    this.failures = 0
    this.clearRetry()
    this.clearOfflineTimer()
    const conn = this.snapshot.conn
    const since = conn.kind === 'connected' ? conn.since : now
    this.set({ conn: { kind: 'connected', since, lastAliveAt: now } })
    this.schedulePing(attempt)
  }

  /** 이 시도를 버리고 재연결 중으로. 백오프 뒤 새 시도. */
  private fail(attempt: Attempt | null, reason: ReconnectReason): void {
    if (attempt !== null) {
      if (this.current !== attempt) return
      this.endAttempt(attempt)
    }
    this.log('reconnect_wait', { reason, failures: this.failures })
    const conn = this.snapshot.conn
    const lastConnectedAt = conn.kind === 'connected' ? conn.lastAliveAt : conn.kind === 'checking' || conn.kind === 'reconnecting' ? conn.lastConnectedAt : null
    this.enterReconnecting(reason, lastConnectedAt)
    this.scheduleRetry()
  }

  private enterReconnecting(reason: ReconnectReason, lastConnectedAt: number | null): void {
    const now = this.deps.clock.now()
    const conn = this.snapshot.conn
    // 서버가 스스로 내려갔다(1001·4009) — 기다리지 않고 끊김으로 보인다. 그 밖은 offlineAfterMs 뒤.
    const serverGone = reason === 'shutdown' || reason === 'unavailable'
    if (conn.kind === 'reconnecting') {
      this.set({ conn: { ...conn, reason, attempt: conn.attempt + 1, offline: conn.offline || serverGone } })
      return
    }
    // 복귀 프로브 실패면 그 프로브 시작 시각부터 센다 — 3초 유예가 이어진다.
    const since = conn.kind === 'checking' ? conn.since : now
    this.set({ conn: { kind: 'reconnecting', since, lastConnectedAt, attempt: 0, reason, offline: serverGone } })
    this.armOfflineTimer()
  }

  private armOfflineTimer(): void {
    const conn = this.snapshot.conn
    if (conn.kind !== 'reconnecting' || conn.offline || this.offlineTimer !== null || !this.foreground) return
    const remaining = Math.max(0, this.timing.offlineAfterMs - (this.deps.clock.now() - conn.since))
    this.offlineTimer = this.deps.clock.setTimeout(() => {
      this.offlineTimer = null
      const latest = this.snapshot.conn
      if (latest.kind !== 'reconnecting' || latest.offline) return
      this.log('offline', { failures: this.failures })
      this.set({ conn: { ...latest, offline: true } })
    }, remaining)
  }

  private clearOfflineTimer(): void {
    if (this.offlineTimer !== null) this.deps.clock.clearTimeout(this.offlineTimer)
    this.offlineTimer = null
  }

  private scheduleRetry(): void {
    this.clearRetry()
    if (!this.foreground || this.record === null) return
    const delays = this.timing.backoffMs
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 15_000
    this.failures += 1
    this.retryTimer = this.deps.clock.setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.deps.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  // --- 생존 확인 ---

  private schedulePing(attempt: Attempt): void {
    this.clearTimer(attempt, 'pingTimer')
    if (!this.foreground) return
    attempt.pingTimer = this.deps.clock.setTimeout(() => {
      attempt.pingTimer = null
      if (this.current !== attempt || attempt.ended) return
      this.probe(this.timing.pongDeadlineMs, 'interval')
    }, this.timing.pingIntervalMs)
  }

  /** ping 을 보내고 마감을 건다. 마감 안에 서버 프레임이 없으면 이 연결을 버린다. */
  private probe(deadlineMs: number, why: 'interval' | 'resume' | 'network' | 'manual'): void {
    const attempt = this.current
    if (attempt === null || attempt.ended || attempt.phase !== 'live') return
    this.pingSeq += 1
    if (why !== 'interval') this.log('probe', { attempt: attempt.seq, why, id: this.pingSeq })
    if (!this.write(attempt, { type: 'ping', id: this.pingSeq })) {
      this.fail(attempt, why === 'resume' ? 'probe_timeout' : 'ping_timeout')
      return
    }
    attempt.awaiting = true
    this.clearTimer(attempt, 'deadlineTimer')
    attempt.deadlineTimer = this.deps.clock.setTimeout(() => {
      attempt.deadlineTimer = null
      if (this.current !== attempt || attempt.ended || !attempt.awaiting) return
      this.log(why === 'interval' ? 'ping_timeout' : 'probe_timeout', { attempt: attempt.seq, why, deadlineMs })
      this.fail(attempt, why === 'interval' ? 'ping_timeout' : 'probe_timeout')
    }, deadlineMs)
    this.schedulePing(attempt)
  }

  // --- 페어링 마무리 ---

  private async adoptPairing(attempt: Attempt, target: PairingTarget, server: ServerInfo, token: string, device: { id: string; name: string }): Promise<void> {
    this.deps.log.rememberSecret(token)
    const record: PairingRecord = {
      token,
      url: target.url,
      macName: server.macName,
      serverVersion: server.version,
      deviceId: device.id,
      deviceName: device.name,
      pairedAt: this.deps.clock.now(),
    }
    try {
      await this.deps.vault.save(record)
    } catch (error) {
      this.log('vault_save_failed', { error: errorName(error) })
      if (this.current === attempt) this.endAttempt(attempt)
      this.set({ pair: { kind: 'failed', reason: 'save_failed', host: target.host, supported: [] } })
      return
    }
    this.record = record
    this.log('paired', { attempt: attempt.seq, host: target.host, serverVersion: server.version })
    // 서버는 pair 성공한 연결을 그대로 인증된 연결로 둔다 — 같은 소켓을 연결 시도로 넘겨받는다.
    if (this.current === attempt && !attempt.ended) {
      attempt.purpose = 'connect'
      attempt.phase = 'live'
      attempt.pairTarget = null
      this.set({ pair: { kind: 'paired', macName: server.macName, serverVersion: server.version } })
      this.markConnected(attempt, this.deps.clock.now())
      return
    }
    this.set({ pair: { kind: 'paired', macName: server.macName, serverVersion: server.version } })
    this.enterReconnecting('closed', null)
    this.connect()
  }

  private pairFailed(attempt: Attempt, code: number): void {
    const target = attempt.pairTarget
    const supported = attempt.supported
    this.endAttempt(attempt)
    if (target === null) return
    const reason = serverPairFailure(attempt.lastError) ?? (code === CLOSE.unavailable ? 'unavailable' : code === CLOSE.protocolMismatch ? 'protocol_mismatch' : 'unreachable')
    this.log('pair_failed', { reason, code })
    this.set({ pair: { kind: 'failed', reason, host: target.host, supported } })
  }

  private async dropPairing(reason: UnpairReason): Promise<void> {
    if (this.current !== null) this.endAttempt(this.current)
    this.clearRetry()
    this.clearOfflineTimer()
    this.failures = 0
    this.record = null
    try {
      await this.deps.vault.clear()
    } catch (error) {
      this.log('vault_clear_failed', { error: errorName(error) })
    }
    this.log('unpaired', { reason })
    this.deps.log.forgetSecrets()
    this.set({ conn: { kind: 'unpaired', reason }, pair: { kind: 'idle' } })
  }

  // --- 잔일 ---

  private write(attempt: Attempt, message: Record<string, unknown>): boolean {
    if (attempt.ended || attempt.socket.readyState !== OPEN) return false
    try {
      attempt.socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private clearTimer(attempt: Attempt, key: 'connectTimer' | 'pingTimer' | 'deadlineTimer'): void {
    const handle = attempt[key]
    if (handle !== null) this.deps.clock.clearTimeout(handle)
    attempt[key] = null
  }

  private log(event: string, detail: Record<string, LogValue>): void {
    this.deps.log.add(event, detail)
  }
}

const OPEN = 1

function infoOf(record: PairingRecord): PairingInfo {
  return {
    url: record.url,
    host: hostOf(record.url) ?? record.url,
    macName: record.macName,
    serverVersion: record.serverVersion,
    deviceName: record.deviceName,
    pairedAt: record.pairedAt,
  }
}

/** 오류는 이름만 남긴다 — 메시지에 값이 섞일 수 있다. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
