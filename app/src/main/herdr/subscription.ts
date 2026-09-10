// 구독 경로 — **push 전용 커넥션** (스파이크 제약 1).
//
// ack 이후 이 커넥션에 요청을 보내면 서버가 13ms 만에 끊는다. 그래서 이 클래스에는
// 요청을 보내는 공개 메서드가 아예 없다. 쓰기는 connect() 안의 events.subscribe 한 줄뿐이다.
//
// 모르는 봉투는 던지지 않고 로그로 남긴다 (K5 의 정신을 push 쪽에도 적용).

import { LineSocket } from './line-socket.js'
import { asPushFrame, asResponseFrame, type PushFrame } from './protocol.js'
import { log } from '../log.js'

export type SubscriptionHooks = {
  onPush: (frame: PushFrame, at: number) => void
  onDrop: (reason: 'eof' | 'local' | 'error', detail: string) => void
}

export class SubscriptionRejected extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SubscriptionRejected'
    this.code = code
  }
}

export class Subscription {
  private readonly hooks: SubscriptionHooks
  private socket: LineSocket | null = null
  private acked = false
  private dropped = false
  private onAck: ((ack: unknown) => void) | null = null
  private onAckFail: ((error: Error) => void) | null = null

  constructor(hooks: SubscriptionHooks) {
    this.hooks = hooks
  }

  /** 연결 → subscribe 전송 → ack 수신까지. 거부되면 SubscriptionRejected 로 던진다. */
  /**
   * `types` 는 문자열이거나 파라미터를 담은 레코드다 — `pane.agent_status_changed` 처럼
   * `pane_id` 를 요구하는 타입이 있다 (raw/claude/36-agent-status-and-revision.json).
   */
  async connect(
    socketPath: string,
    types: readonly (string | Record<string, string>)[],
    timeoutMs = 5000,
  ): Promise<unknown> {
    const socket = new LineSocket({
      onLine: (line, at) => this.handleLine(line, at),
      onClose: (reason) => this.drop(reason, 'socket closed'),
      onError: (error) => this.drop('error', `${error.code ?? 'unknown'}: ${error.message}`),
    })
    this.socket = socket
    log('sub.conn.open', { conn: socket.id, socketPath, types: types.length })
    await socket.connect(socketPath)

    const ack = new Promise<unknown>((resolve, reject) => {
      this.onAck = resolve
      this.onAckFail = reject
      setTimeout(() => reject(new SubscriptionRejected('timeout', `구독 ack 타임아웃 (${timeoutMs}ms)`)), timeoutMs)
    })
    const frame = JSON.stringify({
      id: 'sub',
      method: 'events.subscribe',
      params: { subscriptions: types.map((type) => (typeof type === 'string' ? { type } : type)) },
    })
    log('sub.tx', { conn: socket.id, line: frame })
    // 이 커넥션에 쓰는 것은 이 한 줄뿐이다. 이후로는 오로지 push 를 받는다.
    socket.write(frame)
    return ack
  }

  close(): void {
    this.socket?.end()
    this.socket = null
  }

  private handleLine(line: string, at: number): void {
    log('sub.rx', { conn: this.socket?.id ?? '?', at, line: line.slice(0, 4000) })
    let parsed: unknown = null
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      log('sub.line.parse_error', { error: String(error), line: line.slice(0, 400) })
      return
    }

    const push = asPushFrame(parsed)
    if (push !== null) {
      if (!this.acked) log('sub.push.before_ack', { event: push.event })
      this.hooks.onPush(push, at)
      return
    }

    const response = asResponseFrame(parsed)
    if (response !== null) {
      // ack 이거나 거부. 서버가 요청 전체를 거부하면 id 를 잃는다("id":"") — 그래서 id 로 안 가른다.
      if (response.error) {
        const code = response.error.code ?? 'unknown'
        const message = response.error.message ?? ''
        log('sub.ack.rejected', { code, message })
        this.onAckFail?.(new SubscriptionRejected(code, message))
        return
      }
      this.acked = true
      log('sub.ack', { result: JSON.stringify(response.result) })
      this.onAck?.(response.result)
      return
    }

    log('sub.line.unknown_envelope', { line: line.slice(0, 400) })
  }

  private drop(reason: 'eof' | 'local' | 'error', detail: string): void {
    if (this.dropped) return
    this.dropped = true
    log('sub.drop', { reason, detail })
    if (!this.acked) this.onAckFail?.(new SubscriptionRejected(reason, detail))
    this.hooks.onDrop(reason, detail)
  }
}
