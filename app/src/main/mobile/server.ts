// 모바일 서버 (LIFE-577 A2·A3·A5) — loopback 전용 HTTP+WS. 노출 표면 정본은 `SURFACE.md`(같은 폴더).
//
// - 바인딩은 `127.0.0.1` **상수** — 인자·환경변수로 넓힐 길이 없다. 포트는 0(OS 가 고름), 켤 때마다 바뀔 수 있다.
// - HTTP 표면은 `GET /ws` 의 WS 업그레이드 **하나**. 그 밖의 요청·경로·메서드·모양이 틀린 업그레이드는 본문 없이 404 로 닫는다
//   (fix1 R1-A10 — 키·버전 검사를 ws 에 맡기기 전에 직접 해 거절 형식을 하나로). `Origin` 이 있으면 노출 주소 origin 만(R1-N2).
// - 노출이 막히면(`accepting` 거짓) 새 hello·pair 를 `unavailable` 로 거절하고 기존 연결은 `disconnectAll` 로 닫는다(R1-A2).
// - 거절·close 를 시작한 연결은 그 뒤 메시지를 처리하지 않는다(R1-A7 — 같은 write 에 이어 온 pair 가 통과하지 않게).
// - 인증은 WS 첫 메시지(`hello`+토큰 또는 `pair`+코드). 그 전에는 어떤 데이터도 돌려주지 않는다 — 버전도 인증 뒤에만.
//   loopback 의 다른 로컬 프로세스도 붙을 수 있다는 전제다(serve 헤더는 위조 가능 — W6). 경계는 토큰이다.
// - 미인증 연결은 `AUTH_TIMEOUT_MS` 뒤 닫고, 프레임은 `MAX_MESSAGE_BYTES` 를 넘으면 1009 로 닫는다. 인증된 연결의 `input.send`·`question.answer` 만
//   `MAX_INPUT_FRAME_BYTES` 까지 받는다(LIFE-582 P7) — ws 의 `maxPayload` 는 큰 쪽이다. 인증 전에는 소켓에 들어온 바이트를 직접 세어
//   `PRE_AUTH_MAX_BYTES` 를 넘으면 닫고(끝나지 않은 조각도 — R1-A10), 인증 뒤 그 밖의 프레임(파싱 실패·바이너리 포함)은 16 KiB 를 여기서 다시 건다.
// - 인증된 연결은 생존 확인(LIFE-578 E3): `LIVENESS_INTERVAL_MS` 마다 WS ping 프레임, `IDLE_TIMEOUT_MS` 동안 아무 프레임도 없으면 끊는다.
//   같은 기기가 새로 hello 하면 그 기기의 이전 연결을 `replaced` 로 닫는다 — 망을 바꾼 폰의 죽은 연결이 상한 16 을 채우지 않게.
// - **electron 을 모른다** — 버전·로그를 주입받아 vitest 가 실제 서버를 띄운다.
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import { isRecord } from '../../shared/json.js'
import type { ChatResume, ChatSubscription } from './chat.js'
import type { Device, PairingStore } from './pairing.js'
import {
  AUTH_TIMEOUT_MS,
  CLOSE,
  IDLE_TIMEOUT_MS,
  LIVENESS_INTERVAL_MS,
  MAX_CONNECTIONS,
  MAX_INPUT_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  PRE_AUTH_MAX_BYTES,
  PROTOCOL_VERSION,
  WS_PATH,
  parseClientMessage,
  type ErrorCode,
} from './protocol.js'

export const MOBILE_BIND_HOST = '127.0.0.1'

type Log = (tag: string, fields?: Record<string, unknown>) => void

type Connection = {
  ws: WebSocket
  deviceId: string | null
  timer: NodeJS.Timeout | null
  closing: boolean
  lastSeenAt: number
  /** 목록 구독 해제(LIFE-580) — 닫힘·거절·해지·교체 때 부른다. 그 뒤 이 연결로 목록이 가지 않는다. */
  unsubscribe: (() => void) | null
  /** 대화 구독(LIFE-581) — 한 연결에 하나. 닫힘·거절·해지·교체 때 목록 구독과 같이 끊는다. */
  chat: ChatSubscription | null
  /** 쓰기 결과 받기(LIFE-582) — 인증 때 붙이고 연결이 끝날 때 뗀다. */
  input: (() => void) | null
}

/** 목록 공급(LIFE-580 `feed.ts`) — 서버는 구독·해제만 안다. */
export type ListSource = { subscribe(sink: (text: string) => void): () => void }

/** 대화 공급(LIFE-581 `chat.ts`) — 서버는 구독·과거 요청·해제만 안다. 채널 id → 세션은 공급 쪽이 서버 상태로만 고른다. */
export type ChatSource = { subscribe(input: { channelId: string; resume: ChatResume; sink: (text: string) => void }): ChatSubscription }

/** 폰 쓰기(LIFE-582 `input.ts`) — 서버는 기기 id 를 붙여 넘기고 결과 받기를 붙였다 뗀다. 키 시퀀스는 공급 쪽이 만든다. */
export type InputSource = {
  attach(input: { device: string; sink: (text: string) => void }): () => void
  send(input: { device: string; id: string; channel: string; text: string }): void
  cancel(input: { device: string; id: string }): void
  status(input: { device: string; ids: string[] }): void
  answer(input: { device: string; id: string; channel: string; question: number; call: string | null; answers: { choices: number[]; other: string | null }[] }): void
  stopTurn(input: { device: string; id: string; channel: string }): void
  pending(input: { device: string }): void
}

/** 인증된 연결이 16 KiB 를 넘겨 보낼 수 있는 메시지(P7). */
const LARGE_TYPES: ReadonlySet<string> = new Set(['input.send', 'question.answer'])

/** RFC 6455 §4.1 — 16바이트 nonce 의 base64(24자, `==` 로 끝남). */
const WS_KEY = /^[A-Za-z0-9+/]{22}==$/

export type MobileServerDeps = {
  pairing: PairingStore
  appVersion: string
  /** 표시용 맥 이름(R5 A5ⓓ) — 인증 뒤 `hello`·`paired` 응답에만 싣는다. 출처는 `mac-name.ts`. */
  macName: () => string
  log: Log
  /** 기기 목록·연결 수가 바뀌었다(페어링·접속·끊김) — 설정 화면 push 용. 내용(토큰·코드)은 싣지 않는다. */
  onChange: () => void
  /** 새 인증을 받나 — 노출이 막히면 거짓(R1-A2). 없으면 늘 받는다(서버 단위 시험). */
  accepting?: () => boolean
  /** 허용 Origin — `https://<mac>.ts.net:8577`. 업그레이드에 Origin 이 있으면 이것과 같아야 한다. 없으면(null) Origin 있는 요청은 전부 거절(R1-N2). */
  allowedOrigin?: () => string | null
  /** 대화방 목록 공급(LIFE-580). 없으면 `list.subscribe` 는 `unknown_type`. */
  list?: ListSource
  /** 대화 공급(LIFE-581). 없으면 `chat.*` 는 `unknown_type`. */
  chat?: ChatSource
  /** 폰 쓰기(LIFE-582). 없으면 `input.*`·`question.answer`·`turn.stop` 은 `unknown_type`. */
  input?: InputSource
  /** 시험만 줄인다. */
  authTimeoutMs?: number
  /** 시험만 줄인다 — 생존 확인 주기·무수신 마감(E3). */
  livenessIntervalMs?: number
  idleTimeoutMs?: number
}

export class MobileServer {
  private readonly deps: MobileServerDeps
  private http: http.Server | null = null
  private wss: WebSocketServer | null = null
  private readonly connections = new Set<Connection>()
  private port: number | null = null
  private starting: Promise<number> | null = null
  private sweeper: NodeJS.Timeout | null = null

  constructor(deps: MobileServerDeps) {
    this.deps = deps
  }

  listeningPort(): number | null {
    return this.port
  }

  connectedDeviceIds(): Set<string> {
    const out = new Set<string>()
    for (const connection of this.connections) if (connection.deviceId !== null) out.add(connection.deviceId)
    return out
  }

  /** 기동은 한 번에 하나 — 겹친 start 는 같은 약속을, stop 은 진행 중인 기동이 끝난 뒤 닫는다(R1-A1). */
  start(): Promise<number> {
    if (this.http !== null && this.port !== null) return Promise.resolve(this.port)
    if (this.starting === null) this.starting = this.listen().finally(() => { this.starting = null })
    return this.starting
  }

  private async listen(): Promise<number> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_FRAME_BYTES, clientTracking: false, perMessageDeflate: false })
    const server = http.createServer((request, response) => {
      // WS 가 아닌 HTTP 는 전부 같은 모양으로 거절 — 본문·헤더로 아무것도 알려 주지 않는다.
      request.resume()
      response.writeHead(404, { Connection: 'close', 'Content-Length': '0' })
      response.end()
    })
    server.headersTimeout = 10_000
    server.requestTimeout = 10_000
    server.maxHeadersCount = 64
    server.on('upgrade', (request, socket: Socket, head) => {
      if (!this.upgradeAllowed(request)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.accept({ ws, socket, head: head.length }))
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: MOBILE_BIND_HOST, port: 0, exclusive: true }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('서버 주소를 읽지 못했다')
    this.http = server
    this.wss = wss
    this.port = (address satisfies AddressInfo).port
    this.sweeper = setInterval(() => this.sweep(), this.deps.livenessIntervalMs ?? LIVENESS_INTERVAL_MS)
    this.sweeper.unref()
    this.deps.log('mobile.server_listen', { host: MOBILE_BIND_HOST, port: this.port })
    return this.port
  }

  async stop(): Promise<void> {
    if (this.starting !== null) await this.starting.catch(() => {})
    const server = this.http
    this.http = null
    this.port = null
    if (this.sweeper !== null) clearInterval(this.sweeper)
    this.sweeper = null
    for (const connection of this.connections) this.drop(connection, CLOSE.shutdown, 'shutdown')
    this.connections.clear()
    this.wss?.close()
    this.wss = null
    if (server === null) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.deps.log('mobile.server_stop', {})
  }

  /** 노출이 막혔다 — 열린 연결을 전부 닫는다(R1-A2). 닫은 수를 돌려준다. */
  disconnectAll(): number {
    let closed = 0
    for (const connection of [...this.connections]) {
      if (connection.closing) continue
      this.reject(connection, 'unavailable', CLOSE.unavailable)
      closed += 1
    }
    if (closed > 0) this.deps.onChange()
    return closed
  }

  private upgradeAllowed(request: http.IncomingMessage): boolean {
    const pathOnly = (request.url ?? '').split('?')[0]
    if (request.method !== 'GET' || pathOnly !== WS_PATH || this.connections.size >= MAX_CONNECTIONS) return false
    if ((request.headers.upgrade ?? '').toLowerCase() !== 'websocket') return false
    if (!WS_KEY.test(request.headers['sec-websocket-key'] ?? '')) return false
    if (request.headers['sec-websocket-version'] !== '13') return false
    // 하위 프로토콜은 쓰지 않는다 — 있으면 ws 가 모양 오류에 400 본문을 내므로 여기서 같은 404 로 닫는다.
    if (request.headers['sec-websocket-protocol'] !== undefined) return false
    const origin = request.headers.origin
    if (origin !== undefined) {
      const allowed = this.deps.allowedOrigin?.() ?? null
      if (allowed === null || origin !== allowed) {
        this.deps.log('mobile.origin_rejected', {})
        return false
      }
    }
    return true
  }

  /** 해지한 기기의 열린 연결을 지금 닫는다(A4ⓔ). 다른 기기 연결은 그대로. */
  disconnectDevice(deviceId: string): number {
    let closed = 0
    for (const connection of [...this.connections]) {
      if (connection.deviceId !== deviceId) continue
      this.send(connection.ws, { type: 'error', code: 'revoked', message: '기기가 해지되었다' })
      this.drop(connection, CLOSE.revoked, 'revoked')
      closed += 1
    }
    if (closed > 0) this.deps.onChange()
    return closed
  }

  /**
   * 생존 확인(E3) — 인증된 연결 중 마감 동안 아무 프레임도 보내지 않은 것은 끊고(close 핸드셰이크 없이 — 상대가 없다), 나머지에는 ping 을 보낸다.
   * 인증 전 연결은 `auth_timeout` 이 맡는다.
   */
  private sweep(): void {
    const now = Date.now()
    const idleMs = this.deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    for (const connection of [...this.connections]) {
      if (connection.deviceId === null || connection.closing) continue
      if (now - connection.lastSeenAt > idleMs) {
        this.deps.log('mobile.idle_drop', { device: connection.deviceId, idleMs: now - connection.lastSeenAt })
        connection.closing = true
        this.unsubscribe(connection)
        connection.ws.terminate()
        continue
      }
      try {
        connection.ws.ping()
      } catch {
        connection.ws.terminate()
      }
    }
  }

  private accept(input: { ws: WebSocket; socket: Socket; head: number }): void {
    const { ws, socket } = input
    const connection: Connection = { ws, deviceId: null, timer: null, closing: false, lastSeenAt: Date.now(), unsubscribe: null, chat: null, input: null }
    connection.timer = setTimeout(() => this.reject(connection, 'auth_timeout', CLOSE.authTimeout), this.deps.authTimeoutMs ?? AUTH_TIMEOUT_MS)
    this.connections.add(connection)
    // 인증 전 수신 관문(R1-A10) — ws 는 큰 `maxPayload` 로 끝나지 않은 조각을 모은다. 인증 전에는 소켓 바이트 합계로 16 KiB(+머리)를 넘기지 않는다.
    let preAuth = input.head
    const countPreAuth = (chunk: Buffer): void => {
      if (connection.deviceId !== null || connection.closing) return void socket.off('data', countPreAuth)
      preAuth += chunk.length
      if (preAuth <= PRE_AUTH_MAX_BYTES) return
      socket.off('data', countPreAuth)
      this.drop(connection, CLOSE.tooBig, 'too_big')
    }
    socket.on('data', countPreAuth)
    ws.on('message', (data, isBinary) => {
      connection.lastSeenAt = Date.now()
      this.onMessage(connection, data, isBinary)
    })
    ws.on('pong', () => { connection.lastSeenAt = Date.now() })
    ws.on('close', () => {
      this.unsubscribe(connection)
      if (connection.timer !== null) clearTimeout(connection.timer)
      const wasDevice = connection.deviceId !== null
      this.connections.delete(connection)
      if (wasDevice) this.deps.onChange()
    })
    ws.on('error', () => ws.terminate())
  }

  private onMessage(connection: Connection, data: RawData, isBinary: boolean): void {
    // 거절·close 를 시작한 연결 — 같은 write 로 뒤따라 온 메시지도 버린다(R1-A7).
    if (connection.closing || connection.ws.readyState !== connection.ws.OPEN) return
    const text = rawText(data)
    const bytes = Buffer.byteLength(text)
    // 16 KiB 를 넘는 프레임은 인증된 `input.send`·`question.answer` 만 — 인증 전·바이너리·JSON 아님·다른 타입은 1009(R1-A10).
    // 그 두 타입의 모양 오류(본문 초과 등)는 아래 파싱이 `bad_message` 로 답한다.
    if (bytes > MAX_MESSAGE_BYTES && (connection.deviceId === null || isBinary || !largeType(text))) return this.drop(connection, CLOSE.tooBig, 'too_big')
    if (isBinary) {
      if (connection.deviceId === null) return this.reject(connection, 'bad_message', CLOSE.badMessage)
      return this.send(connection.ws, { type: 'error', code: 'bad_message', message: errorText('bad_message') })
    }
    const parsed = parseClientMessage(text)
    if (!parsed.ok) {
      if (connection.deviceId === null) return this.reject(connection, parsed.code, CLOSE.badMessage)
      return this.send(connection.ws, { type: 'error', code: parsed.code, message: errorText(parsed.code) })
    }
    const message = parsed.message
    // 인증 뒤 — ping · list.subscribe(LIFE-580) · chat.*(LIFE-581) · 쓰기(LIFE-582).
    if (connection.deviceId !== null) {
      // 해지가 연결 닫기보다 먼저 보일 수 있는 틈을 막는다 — 매 메시지 기기 존재 확인.
      if (!this.deps.pairing.has(connection.deviceId)) return this.reject(connection, 'revoked', CLOSE.revoked)
      const device = connection.deviceId
      const input = this.deps.input
      switch (message.type) {
        case 'input.send':
          if (input === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
          return input.send({ device, id: message.id, channel: message.channel, text: message.text })
        case 'input.cancel':
          if (input === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
          return input.cancel({ device, id: message.id })
        case 'input.status':
          if (input === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
          return input.status({ device, ids: message.ids })
        case 'question.answer':
          if (input === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
          return input.answer({ device, id: message.id, channel: message.channel, question: message.question, call: message.call, answers: message.answers })
        case 'turn.stop':
          if (input === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
          return input.stopTurn({ device, id: message.id, channel: message.channel })
        case 'input.pending':
          if (input === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
          return input.pending({ device })
        case 'ping':
          return this.send(connection.ws, { type: 'pong', id: message.id, at: Date.now() })
        case 'list.subscribe':
          return this.subscribeList(connection)
        case 'chat.subscribe':
          return this.subscribeChat({ connection, channelId: message.channel, resume: message.resume })
        case 'chat.older':
          if (this.deps.chat === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
          return connection.chat?.older({ gen: message.gen, before: message.before })
        case 'chat.unsubscribe':
          if (this.deps.chat === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
          return this.unsubscribeChat(connection)
        case 'hello':
        case 'pair':
          return this.send(connection.ws, { type: 'error', code: 'bad_message', message: '이미 인증된 연결이다' })
        case 'unknown':
          return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
      }
    }
    // 인증 전 — hello·pair 만. 그 밖은 거절하고 닫는다. 노출이 막혔으면 hello·pair 도 받지 않는다(R1-A2).
    if ((message.type === 'hello' || message.type === 'pair') && this.deps.accepting?.() === false) {
      return this.reject(connection, 'unavailable', CLOSE.unavailable)
    }
    switch (message.type) {
      case 'hello': {
        if (message.protocol !== PROTOCOL_VERSION) return this.rejectProtocol(connection)
        const device = this.deps.pairing.authenticate(message.token)
        if (device === null) return this.reject(connection, 'unauthorized', CLOSE.unauthorized)
        this.deps.pairing.touch(device.id)
        this.replacePrevious(connection, device.id)
        this.admit(connection, device)
        this.deps.log('mobile.hello', { device: device.id })
        return this.send(connection.ws, { type: 'hello', ok: true, ...this.versions(), device: { id: device.id, name: device.name } })
      }
      case 'pair': {
        if (message.protocol !== PROTOCOL_VERSION) return this.rejectProtocol(connection)
        let result
        try {
          result = this.deps.pairing.pair({ code: message.code, name: message.name })
        } catch (error) {
          this.deps.log('mobile.pair_failed', { error: String(error) })
          return this.reject(connection, 'pair_rejected', CLOSE.pairRejected)
        }
        if (!result.ok) {
          this.deps.log('mobile.pair_rejected', { reason: result.reason })
          this.deps.onChange()
          // 실패 이유를 그대로 오류 코드로(R5 A4ⓖ) — 만료·이미 씀·무효·상한.
          return this.reject(connection, result.reason, CLOSE.pairRejected)
        }
        this.admit(connection, result.device)
        this.deps.log('mobile.paired', { device: result.device.id })
        return this.send(connection.ws, {
          type: 'paired',
          ...this.versions(),
          token: result.token,
          device: { id: result.device.id, name: result.device.name },
        })
      }
      case 'ping':
      case 'list.subscribe':
      case 'chat.subscribe':
      case 'chat.older':
      case 'chat.unsubscribe':
      case 'input.send':
      case 'input.cancel':
      case 'input.status':
      case 'question.answer':
      case 'turn.stop':
      case 'input.pending':
      case 'unknown':
        return this.reject(connection, 'not_authenticated', CLOSE.unauthorized)
    }
  }

  /**
   * 목록 구독(LIFE-580 J8) — 다시 보내면 이전 구독을 끊고 새로 붙어 전체를 다시 받는다(포그라운드 복귀). 보내기 직전마다
   * 이 연결이 아직 살아 있고(닫는 중 아님) 기기가 해지되지 않았는지 본다 — 해지·교체·닫힘 뒤에는 한 건도 가지 않는다.
   */
  private subscribeList(connection: Connection): void {
    const list = this.deps.list
    if (list === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
    // 목록 구독만 바꾼다 — 열린 대화 구독은 그대로(포그라운드 복귀의 목록 재구독이 대화를 끊지 않게).
    const previous = connection.unsubscribe
    connection.unsubscribe = null
    previous?.()
    const deviceId = connection.deviceId
    connection.unsubscribe = list.subscribe((text) => {
      if (connection.closing || deviceId === null || connection.ws.readyState !== connection.ws.OPEN) return
      if (!this.deps.pairing.has(deviceId)) return this.reject(connection, 'revoked', CLOSE.revoked)
      connection.ws.send(text)
    })
    this.deps.log('mobile.list_subscribe', { device: deviceId })
  }

  /**
   * 대화 구독(LIFE-581 X3) — 목록과 같은 보내기 직전 확인(닫는 중·기기 해지). 다시 보내면 이전 대화 구독을 끊는다.
   * 채널 id 는 공급 쪽이 지금 목록 안에서만 찾는다 — 폰이 준 값으로 파일을 고르지 않는다.
   */
  private subscribeChat(input: { connection: Connection; channelId: string; resume: ChatResume }): void {
    const { connection } = input
    const chat = this.deps.chat
    if (chat === undefined) return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
    this.unsubscribeChat(connection)
    const deviceId = connection.deviceId
    connection.chat = chat.subscribe({
      channelId: input.channelId,
      resume: input.resume,
      sink: (text) => {
        if (connection.closing || deviceId === null || connection.ws.readyState !== connection.ws.OPEN) return
        if (!this.deps.pairing.has(deviceId)) return this.reject(connection, 'revoked', CLOSE.revoked)
        connection.ws.send(text)
      },
    })
    this.deps.log('mobile.chat_open', { device: deviceId })
  }

  private unsubscribeChat(connection: Connection): void {
    const chat = connection.chat
    connection.chat = null
    chat?.close()
  }

  /** 연결이 끝난다(닫힘·거절·해지·교체·생존 확인 끊김) — 목록·대화 구독을 모두 끊는다. 그 뒤 이 연결로 아무것도 가지 않는다. */
  private unsubscribe(connection: Connection): void {
    const stop = connection.unsubscribe
    connection.unsubscribe = null
    stop?.()
    this.unsubscribeChat(connection)
    const detach = connection.input
    connection.input = null
    detach?.()
  }

  /** 같은 기기의 이전 연결을 닫는다(E3) — 다른 기기 연결은 건드리지 않는다. */
  private replacePrevious(connection: Connection, deviceId: string): void {
    for (const other of [...this.connections]) {
      if (other === connection || other.deviceId !== deviceId || other.closing) continue
      this.deps.log('mobile.replaced', { device: deviceId })
      this.reject(other, 'replaced', CLOSE.replaced)
    }
  }

  private admit(connection: Connection, device: Device): void {
    if (connection.timer !== null) clearTimeout(connection.timer)
    connection.timer = null
    connection.deviceId = device.id
    // 쓰기 결과는 이 연결로 — 보내기 직전마다 살아 있음·해지를 본다(목록·대화와 같은 확인).
    const input = this.deps.input
    if (input !== undefined) {
      const deviceId = device.id
      connection.input = input.attach({
        device: deviceId,
        sink: (text) => {
          if (connection.closing || connection.ws.readyState !== connection.ws.OPEN) return
          if (!this.deps.pairing.has(deviceId)) return this.reject(connection, 'revoked', CLOSE.revoked)
          connection.ws.send(text)
        },
      })
    }
    this.deps.onChange()
  }

  /** 인증 뒤 응답 전용 — 맥 이름이 여기 실린다(인증 전 응답·오류에는 없다). */
  private versions(): { protocol: number; server: { app: 'corral'; version: string; macName: string } } {
    return { protocol: PROTOCOL_VERSION, server: { app: 'corral', version: this.deps.appVersion, macName: this.deps.macName() } }
  }

  private rejectProtocol(connection: Connection): void {
    this.send(connection.ws, { type: 'error', code: 'protocol_mismatch', message: errorText('protocol_mismatch'), supported: [PROTOCOL_VERSION] })
    this.drop(connection, CLOSE.protocolMismatch, 'protocol_mismatch')
  }

  private reject(connection: Connection, code: ErrorCode, closeCode: number): void {
    this.send(connection.ws, { type: 'error', code, message: errorText(code) })
    this.drop(connection, closeCode, code)
  }

  private drop(connection: Connection, closeCode: number, reason: string): void {
    connection.closing = true
    this.unsubscribe(connection)
    if (connection.timer !== null) clearTimeout(connection.timer)
    connection.timer = null
    const ws = connection.ws
    ws.close(closeCode, reason)
    // 상대가 close 에 답하지 않아도 1초 안에 끊는다(A4ⓔ 「1초 안에」).
    setTimeout(() => ws.terminate(), 500).unref()
  }

  private send(ws: WebSocket, value: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value))
  }
}

/** 큰 프레임이 받을 수 있는 타입인가 — JSON 이고 `type` 이 `LARGE_TYPES` 다. */
function largeType(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) && typeof value.type === 'string' && LARGE_TYPES.has(value.type)
  } catch {
    return false
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

/** 오류 문구 — 받은 값(토큰·코드)을 되풀이하지 않는다. */
function errorText(code: ErrorCode): string {
  switch (code) {
    case 'bad_json': return 'JSON 이 아니다'
    case 'bad_message': return '메시지 모양이 맞지 않다'
    case 'protocol_mismatch': return '프로토콜 버전이 맞지 않다'
    case 'unauthorized': return '인증 실패'
    case 'not_authenticated': return '인증 전에는 hello 또는 pair 만 보낼 수 있다'
    case 'pair_rejected': return '페어링을 저장하지 못했다 — 다시 시도한다'
    case 'code_expired': return '페어링 코드가 만료되었다 — 데스크톱에서 새 QR 을 만든다'
    case 'code_used': return '이미 쓴 페어링 코드다 — 데스크톱에서 새 QR 을 만든다'
    case 'code_invalid': return '페어링 코드가 맞지 않다'
    case 'device_limit': return '기기 상한에 닿았다 — 데스크톱에서 기기를 해지한 뒤 다시 페어링한다'
    case 'unknown_type': return '모르는 메시지 타입'
    case 'auth_timeout': return '인증 시간 초과'
    case 'revoked': return '기기가 해지되었다'
    case 'unavailable': return '지금은 모바일 연결을 받지 않는다 — 데스크톱 설정의 노출 상태를 확인한다'
    case 'replaced': return '같은 기기의 새 연결로 바뀌었다'
  }
}
