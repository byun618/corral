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
//
// 금고 쓰기(저장·삭제)는 한 줄로 선다(`vaultOp`) — 같은 키의 save·clear 가 부른 순서대로 끝난다(리뷰 r1 R1-A3).
// 페어링 1건은 하나의 순서 있는 작업이다 — pair 송신 → paired 수신 → 저장 → 채택. 저장이 떠난 뒤에는 취소·새 페어링을 받지 않고
// 소켓이 닫혀도 실패로 바꾸지 않는다(서버는 이미 기기를 등록했다 — 저장이 끝나면 hello 로 다시 붙는다). 저장 수명은 화면 상태가 아니라 `saving` 이 쥔다(R2-A1).
// 해제·해지·삭제 재시도는 한 경로(`dropPairing`)만 지난다 — 시도 종료·세대 무효화·메모리 record 제거·금고 삭제·상태 반영(R2-A2).
// 세대(`gen`)는 pair·해제마다 오른다 — 그 뒤에 끝난 이전 저장·삭제는 상태를 바꾸지 않는다.
// 삭제가 끝나기 전에는 「해제됨」 을 보이지 않는다 — `unpairing` → 성공이면 `unpaired`, 실패면 `unpair_failed`(R1-A4).
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
  /** 해제·해지 — 연결은 이미 닫았고 금고 삭제를 기다린다. 아직 「해제됨」 이 아니다. */
  | { kind: 'unpairing'; reason: UnpairReason }
  /** 금고 삭제가 실패했다 — 토큰이 폰에 남아 있을 수 있다. `retryUnpair` 로 다시. 연결은 하지 않는다. */
  | { kind: 'unpair_failed'; reason: UnpairReason }

export type PairState =
  | { kind: 'idle' }
  /** saving = 서버가 토큰을 줬고 폰에 저장하는 중 — 이때는 취소를 받지 않는다. */
  | { kind: 'pairing'; host: string; startedAt: number; saving: boolean }
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
  /** saving = paired 를 받고 저장을 기다린다(페어링 시도만). */
  phase: 'opening' | 'authing' | 'saving' | 'live'
  ended: boolean
  /** 서버가 close 앞에 보낸 마지막 오류 코드. */
  lastError: string | null
  supported: number[]
  connectTimer: TimerHandle | null
  pingTimer: TimerHandle | null
  deadlineTimer: TimerHandle | null
  /** 프로브를 보냈고 아직 서버 프레임이 오지 않았다. */
  awaiting: boolean
  /** 미응답 프로브의 마감 시각 — 새 프로브는 앞당기기만 한다(R1-A1). */
  deadlineAt: number | null
  /** 이 페어링 시도의 세대(연결 시도는 0). */
  gen: number
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
  /** 금고 쓰기 줄 — 앞 작업이 끝나야(성공·실패 무관) 다음이 시작한다. */
  private vaultChain: Promise<void> = Promise.resolve()
  /** 세대 — pair·해제마다 오른다. 페어링 저장·hello 메타 저장·해제 삭제는 세대가 같을 때만 상태를 바꾼다. */
  private gen = 0
  /** 페어링 토큰 저장이 진행 중 — 끝날 때까지 취소·새 페어링을 받지 않는다(R2-A1). */
  private saving = false
  /** 마지막으로 검증된 페어링 대상 — A8 「다시 시도」 용. 메모리에만(코드는 기록에서 가린다). */
  private lastTarget: PairingTarget | null = null

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
    // 토큰이 없다고 확인된 상태(unpaired)에서만 — 삭제 중·삭제 실패면 받지 않는다.
    if (this.record !== null || this.saving || this.snapshot.conn.kind !== 'unpaired' || this.snapshot.pair.kind === 'pairing') return
    this.gen += 1
    this.deps.log.rememberSecret(target.code)
    this.log('pair_start', { host: target.host })
    // 새 페어링을 시작하면 지난 해지·해제 이유는 지운다 — A1 으로 되돌리는 이유가 아니다(R1-A5).
    this.set({ conn: { kind: 'unpaired', reason: null }, pair: { kind: 'pairing', host: target.host, startedAt: this.deps.clock.now(), saving: false } })
    this.lastTarget = target
    const attempt = this.open('pair', target.url, target)
    attempt.gen = this.gen
    attempt.connectTimer = this.deps.clock.setTimeout(() => {
      if (this.current !== attempt || attempt.ended) return
      this.log('pair_timeout', { attempt: attempt.seq })
      this.endAttempt(attempt)
      this.set({ pair: { kind: 'failed', reason: 'unreachable', host: target.host, supported: [] } })
    }, this.timing.connectDeadlineMs)
  }

  /** A8 등 「다시 시도」 — 실패한 페어링을 같은 대상(QR 을 다시 찍지 않고)으로. 코드가 소모되지 않은 실패에서만 화면이 부른다. */
  retryPair(): void {
    const target = this.lastTarget
    if (this.snapshot.pair.kind !== 'failed' || target === null) return
    this.log('pair_retry', { host: target.host })
    this.set({ pair: { kind: 'idle' } })
    this.pair(target)
  }

  /** A1 에서 「QR 찍기」 를 누르면 지난 해지·해제 이유를 내려놓는다 — 그 뒤 페어링 화면에서 A1 으로 되돌리지 않게. */
  acknowledgeUnpair(): void {
    const conn = this.snapshot.conn
    if (conn.kind === 'unpaired' && conn.reason !== null) this.set({ conn: { kind: 'unpaired', reason: null } })
  }

  /** A3 「취소」 · 실패 화면에서 돌아가기 · A4 「대화방 보기」. 토큰 저장이 떠난 뒤에는 받지 않는다 — 저장은 짧고, 끝나면 페어링됨으로 이어진다(R2-A1). */
  resetPair(): void {
    if (this.saving) {
      this.log('pair_cancel_ignored', { why: 'saving' })
      return
    }
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
    if (this.snapshot.conn.kind === 'unpairing') return
    this.log('unpair_user', {})
    await this.dropPairing('user')
  }

  /** 금고 삭제 실패(`unpair_failed`) 뒤 다시 지운다 — 해제와 같은 경로(R2-A2). */
  async retryUnpair(): Promise<void> {
    const conn = this.snapshot.conn
    if (conn.kind !== 'unpair_failed') return
    this.log('unpair_retry', { reason: conn.reason })
    await this.dropPairing(conn.reason)
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
        attempt.deadlineAt = null
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
      deadlineAt: null,
      gen: 0,
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
      attempt.deadlineAt = null
      this.clearTimer(attempt, 'deadlineTimer')
    }
    switch (message.type) {
      case 'hello': {
        if (attempt.purpose !== 'connect' || attempt.phase !== 'authing' || this.record === null) return
        this.clearTimer(attempt, 'connectTimer')
        attempt.phase = 'live'
        const record = this.record
        if (record.macName !== message.server.macName || record.serverVersion !== message.server.version) {
          const next: PairingRecord = { ...record, macName: message.server.macName, serverVersion: message.server.version }
          this.record = next
          // 줄을 서서 쓰고, 그사이 해제됐으면(세대가 바뀜) 쓰지 않는다 — 지운 토큰이 되살아나지 않게(R1-A3).
          const gen = this.gen
          void this.vaultOp(async () => {
            if (gen !== this.gen) return
            await this.deps.vault.save(next)
          }).catch((error: unknown) => this.log('vault_save_failed', { error: errorName(error) }))
        }
        this.log('hello_ok', { attempt: attempt.seq, serverVersion: message.server.version })
        this.markConnected(attempt, now)
        return
      }
      case 'paired': {
        if (attempt.purpose !== 'pair' || attempt.phase !== 'authing' || attempt.pairTarget === null) return
        this.clearTimer(attempt, 'connectTimer')
        attempt.phase = 'saving'
        this.saving = true
        this.set({ pair: { kind: 'pairing', host: attempt.pairTarget.host, startedAt: now, saving: true } })
        void this.adoptPairing({ attempt, gen: attempt.gen, target: attempt.pairTarget, server: message.server, token: message.token, device: { id: message.deviceId, name: message.deviceName }, receivedAt: now })
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
    if (attempt.purpose === 'pair' && attempt.phase !== 'saving') return this.pairFailed(attempt, code)
    // E4 — 서버가 명시적으로 거절한 경우만 토큰을 지운다. 토큰 저장 중(pair·saving)에 받은 거절도 같다 —
    // dropPairing 이 세대를 올려 늦은 저장을 무효로 하고, 삭제는 이미 떠난 저장 뒤에 줄을 선다(R3-A1).
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
    if (attempt.purpose === 'pair') {
      // 저장 중 그 밖의 종료(망 오류·1001·1006·4006·4008·4009…) — 토큰은 이미 받았다, 실패가 아니다. 저장이 끝나면 hello 로 다시 붙는다(R2-A1).
      this.endAttempt(attempt)
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
  private probe(deadlineMs: number, why: 'interval' | 'resume' | 'network' | 'manual' | 'saved'): void {
    const attempt = this.current
    if (attempt === null || attempt.ended || attempt.phase !== 'live') return
    this.pingSeq += 1
    if (why !== 'interval') this.log('probe', { attempt: attempt.seq, why, id: this.pingSeq })
    if (!this.write(attempt, { type: 'ping', id: this.pingSeq })) {
      this.fail(attempt, why === 'interval' ? 'ping_timeout' : 'probe_timeout')
      return
    }
    // 응답을 기다리는 동안 마감은 늦추지 않는다 — 첫 미응답 프로브의 마감이 기준, 새 프로브는 앞당기기만(R1-A1).
    const deadlineAt = this.deps.clock.now() + deadlineMs
    if (!attempt.awaiting || attempt.deadlineAt === null || deadlineAt < attempt.deadlineAt) {
      attempt.awaiting = true
      attempt.deadlineAt = deadlineAt
      this.clearTimer(attempt, 'deadlineTimer')
      attempt.deadlineTimer = this.deps.clock.setTimeout(() => {
        attempt.deadlineTimer = null
        if (this.current !== attempt || attempt.ended || !attempt.awaiting) return
        this.log(why === 'interval' ? 'ping_timeout' : 'probe_timeout', { attempt: attempt.seq, why, deadlineMs })
        this.fail(attempt, why === 'interval' ? 'ping_timeout' : 'probe_timeout')
      }, deadlineMs)
    }
    // 정기 ping 은 미루지 않는다 — 멈춰 있을 때(복귀 직후)만 다시 건다.
    if (attempt.pingTimer === null) this.schedulePing(attempt)
  }

  // --- 페어링 마무리 ---

  private async adoptPairing(job: {
    attempt: Attempt
    gen: number
    target: PairingTarget
    server: ServerInfo
    token: string
    device: { id: string; name: string }
    /** paired 를 받은 시각 — 연결됨의 근거는 이 수신이다(저장 완료 시각이 아니다, R2-A4). */
    receivedAt: number
  }): Promise<void> {
    const { attempt, gen, target, server, receivedAt } = job
    this.deps.log.rememberSecret(job.token)
    const record: PairingRecord = {
      token: job.token,
      url: target.url,
      macName: server.macName,
      serverVersion: server.version,
      deviceId: job.device.id,
      deviceName: job.device.name,
      pairedAt: receivedAt,
    }
    let saveError: unknown = null
    try {
      await this.vaultOp(() => this.deps.vault.save(record))
    } catch (error) {
      saveError = error ?? new Error('save failed')
    }
    this.saving = false
    // 저장 중 해제됐다(세대가 바뀜) — 상태·소켓을 건드리지 않는다. 해제의 삭제는 이 저장 뒤에 줄을 섰다.
    if (gen !== this.gen) {
      this.log('pair_stale', { attempt: attempt.seq, failed: saveError !== null })
      return
    }
    if (saveError !== null) {
      this.log('vault_save_failed', { error: errorName(saveError) })
      if (this.current === attempt) this.endAttempt(attempt)
      this.set({ pair: { kind: 'failed', reason: 'save_failed', host: target.host, supported: [] } })
      return
    }
    this.record = record
    this.lastTarget = null
    this.log('paired', { attempt: attempt.seq, host: target.host, serverVersion: server.version })
    this.set({ pair: { kind: 'paired', macName: server.macName, serverVersion: server.version } })
    // 서버는 pair 성공한 연결을 그대로 인증된 연결로 둔다 — 같은 소켓을 연결 시도로 넘겨받는다.
    if (this.current === attempt && !attempt.ended) {
      attempt.purpose = 'connect'
      attempt.phase = 'live'
      attempt.pairTarget = null
      const now = this.deps.clock.now()
      if (now - receivedAt <= this.timing.probeDeadlineMs) {
        this.markConnected(attempt, receivedAt)
        return
      }
      // 저장이 오래 걸렸다 — paired 수신은 낡았다. 연결됨 대신 확인 중으로 두고 새 프로브 응답을 받은 뒤에만 연결됨(R2-A4).
      this.log('pair_saved_late', { attempt: attempt.seq, savedAfterMs: now - receivedAt })
      this.set({ conn: { kind: 'checking', since: now, lastConnectedAt: receivedAt } })
      this.probe(this.timing.probeDeadlineMs, 'saved')
      return
    }
    // 저장 중 소켓이 닫혔다 — 저장한 토큰으로 다시 붙는다.
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

  /**
   * 해제의 한 경로 — 사용자 해제·해지·인증 실패·삭제 재시도가 모두 지난다(R2-A2).
   * 연결은 지금 닫고(살아 있는 시도·재시도 타이머), 세대를 올려 진행 중 저장·메타 저장을 무효로 하고, 메모리 record 를 지운 뒤
   * 금고 삭제가 확인된 뒤에만 `unpaired` 로(R1-A4). 그사이 다시 해제가 시작됐으면(세대가 바뀜) 이 결과는 반영하지 않는다 — 뒤의 삭제가 줄 끝에서 결과를 낸다.
   */
  private async dropPairing(reason: UnpairReason): Promise<void> {
    if (this.current !== null) this.endAttempt(this.current)
    this.clearRetry()
    this.clearOfflineTimer()
    this.failures = 0
    this.record = null
    this.gen += 1
    const gen = this.gen
    this.lastTarget = null
    this.set({ conn: { kind: 'unpairing', reason }, pair: { kind: 'idle' } })
    try {
      await this.vaultOp(() => this.deps.vault.clear())
    } catch (error) {
      if (gen !== this.gen) return
      this.log('vault_clear_failed', { error: errorName(error), reason })
      this.set({ conn: { kind: 'unpair_failed', reason } })
      return
    }
    if (gen !== this.gen) return
    this.log('unpaired', { reason })
    this.deps.log.forgetSecrets()
    this.set({ conn: { kind: 'unpaired', reason } })
  }

  /** 금고 쓰기를 한 줄로 — 앞 작업이 끝난 뒤(성공·실패 무관) 시작한다. 결과·오류는 부른 쪽에 그대로. */
  private vaultOp(op: () => Promise<void>): Promise<void> {
    const run = this.vaultChain.then(op, op)
    this.vaultChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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
