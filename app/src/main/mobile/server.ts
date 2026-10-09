// 모바일 서버 (LIFE-577 A2·A3·A5) — loopback 전용 HTTP+WS. 노출 표면 정본은 `SURFACE.md`(같은 폴더).
//
// - 바인딩은 `127.0.0.1` **상수** — 인자·환경변수로 넓힐 길이 없다. 포트는 0(OS 가 고름), 켤 때마다 바뀔 수 있다.
// - HTTP 표면은 `GET /ws` 의 WS 업그레이드 **하나**. 그 밖의 요청·경로·메서드는 본문 없이 404 로 닫는다.
// - 인증은 WS 첫 메시지(`hello`+토큰 또는 `pair`+코드). 그 전에는 어떤 데이터도 돌려주지 않는다 — 버전도 인증 뒤에만.
//   loopback 의 다른 로컬 프로세스도 붙을 수 있다는 전제다(serve 헤더는 위조 가능 — W6). 경계는 토큰이다.
// - 미인증 연결은 `AUTH_TIMEOUT_MS` 뒤 닫고, 프레임은 `MAX_MESSAGE_BYTES` 를 넘으면 ws 가 닫는다.
// - **electron 을 모른다** — 버전·로그를 주입받아 vitest 가 실제 서버를 띄운다.
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import type { Device, PairingStore } from './pairing.js'
import {
  AUTH_TIMEOUT_MS,
  CLOSE,
  MAX_CONNECTIONS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  WS_PATH,
  parseClientMessage,
  type ErrorCode,
} from './protocol.js'

export const MOBILE_BIND_HOST = '127.0.0.1'

type Log = (tag: string, fields?: Record<string, unknown>) => void

type Connection = { ws: WebSocket; deviceId: string | null; timer: NodeJS.Timeout | null }

export type MobileServerDeps = {
  pairing: PairingStore
  appVersion: string
  log: Log
  /** 기기 목록·연결 수가 바뀌었다(페어링·접속·끊김) — 설정 화면 push 용. 내용(토큰·코드)은 싣지 않는다. */
  onChange: () => void
  /** 시험만 줄인다. */
  authTimeoutMs?: number
}

export class MobileServer {
  private readonly deps: MobileServerDeps
  private http: http.Server | null = null
  private wss: WebSocketServer | null = null
  private readonly connections = new Set<Connection>()
  private port: number | null = null

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

  async start(): Promise<number> {
    if (this.http !== null && this.port !== null) return this.port
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, clientTracking: false, perMessageDeflate: false })
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
      const url = request.url ?? ''
      const pathOnly = url.split('?')[0]
      if (request.method !== 'GET' || pathOnly !== WS_PATH || this.connections.size >= MAX_CONNECTIONS) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws))
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
    this.deps.log('mobile.server_listen', { host: MOBILE_BIND_HOST, port: this.port })
    return this.port
  }

  async stop(): Promise<void> {
    const server = this.http
    this.http = null
    this.port = null
    for (const connection of this.connections) this.drop(connection, CLOSE.shutdown, 'shutdown')
    this.connections.clear()
    this.wss?.close()
    this.wss = null
    if (server === null) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.deps.log('mobile.server_stop', {})
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

  private accept(ws: WebSocket): void {
    const connection: Connection = { ws, deviceId: null, timer: null }
    connection.timer = setTimeout(() => this.reject(connection, 'auth_timeout', CLOSE.authTimeout), this.deps.authTimeoutMs ?? AUTH_TIMEOUT_MS)
    this.connections.add(connection)
    ws.on('message', (data, isBinary) => this.onMessage(connection, data, isBinary))
    ws.on('close', () => {
      if (connection.timer !== null) clearTimeout(connection.timer)
      const wasDevice = connection.deviceId !== null
      this.connections.delete(connection)
      if (wasDevice) this.deps.onChange()
    })
    ws.on('error', () => ws.terminate())
  }

  private onMessage(connection: Connection, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      if (connection.deviceId === null) return this.reject(connection, 'bad_message', CLOSE.badMessage)
      return this.send(connection.ws, { type: 'error', code: 'bad_message', message: errorText('bad_message') })
    }
    const parsed = parseClientMessage(rawText(data))
    if (!parsed.ok) {
      if (connection.deviceId === null) return this.reject(connection, parsed.code, CLOSE.badMessage)
      return this.send(connection.ws, { type: 'error', code: parsed.code, message: errorText(parsed.code) })
    }
    const message = parsed.message
    // 인증 뒤 — M1 은 ping 하나. M3~ 메시지는 여기 분기에 더한다.
    if (connection.deviceId !== null) {
      // 해지가 연결 닫기보다 먼저 보일 수 있는 틈을 막는다 — 매 메시지 기기 존재 확인.
      if (!this.deps.pairing.has(connection.deviceId)) return this.reject(connection, 'revoked', CLOSE.revoked)
      switch (message.type) {
        case 'ping':
          return this.send(connection.ws, { type: 'pong', id: message.id, at: Date.now() })
        case 'hello':
        case 'pair':
          return this.send(connection.ws, { type: 'error', code: 'bad_message', message: '이미 인증된 연결이다' })
        case 'unknown':
          return this.send(connection.ws, { type: 'error', code: 'unknown_type', message: errorText('unknown_type') })
      }
    }
    // 인증 전 — hello·pair 만. 그 밖은 거절하고 닫는다.
    switch (message.type) {
      case 'hello': {
        if (message.protocol !== PROTOCOL_VERSION) return this.rejectProtocol(connection)
        const device = this.deps.pairing.authenticate(message.token)
        if (device === null) return this.reject(connection, 'unauthorized', CLOSE.unauthorized)
        this.deps.pairing.touch(device.id)
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
          return result.reason === 'device_limit'
            ? this.reject(connection, 'device_limit', CLOSE.pairRejected)
            : this.reject(connection, 'pair_rejected', CLOSE.pairRejected)
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
      case 'unknown':
        return this.reject(connection, 'not_authenticated', CLOSE.unauthorized)
    }
  }

  private admit(connection: Connection, device: Device): void {
    if (connection.timer !== null) clearTimeout(connection.timer)
    connection.timer = null
    connection.deviceId = device.id
    this.deps.onChange()
  }

  private versions(): { protocol: number; server: { app: 'corral'; version: string } } {
    return { protocol: PROTOCOL_VERSION, server: { app: 'corral', version: this.deps.appVersion } }
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
    case 'pair_rejected': return '페어링 코드가 맞지 않거나 만료되었다'
    case 'device_limit': return '기기 상한에 닿았다 — 데스크톱에서 기기를 해지한 뒤 다시 페어링한다'
    case 'unknown_type': return '모르는 메시지 타입'
    case 'auth_timeout': return '인증 시간 초과'
    case 'revoked': return '기기가 해지되었다'
  }
}
