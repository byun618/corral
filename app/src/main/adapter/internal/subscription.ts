// 구독 경로 — **push 전용 커넥션** (스파이크 제약 1).
//
// ack 이후 이 커넥션에 요청을 보내면 서버가 13ms 만에 끊는다. 그래서 이 클래스에는 요청을
// 보내는 공개 메서드가 아예 없다. 쓰기는 connect() 안의 events.subscribe 한 줄뿐이다.

import { safeParse } from '../../../shared/json.js'
import { log } from '../../log.js'
import { LineSocket } from './line-socket.js'
import { asPushFrame, asResponseFrame, type PushFrame } from './protocol.js'

export type SubscriptionHooks = {
  /** 어느 커넥션인지 — 로그에 실린다. 상태 전용 커넥션은 **일부러** 자주 닫혔다 열린다. */
  label?: string
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
  private readonly label: string
  private socket: LineSocket | null = null
  private acked = false
  private dropped = false
  private onAck: ((ack: unknown) => void) | null = null
  private onAckFail: ((error: Error) => void) | null = null

  constructor(hooks: SubscriptionHooks) {
    this.hooks = hooks
    this.label = hooks.label ?? 'main'
  }

  /**
   * 연결 → subscribe 전송 → ack 수신까지. 거부되면 SubscriptionRejected 로 던진다.
   * `types` 는 문자열이거나 파라미터를 담은 레코드다 — `pane.agent_status_changed` 처럼
   * `pane_id` 를 요구하는 타입이 있다.
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
    log('sub.conn.open', { label: this.label, conn: socket.id, socketPath, types: types.length })
    await socket.connect(socketPath)

    // ack 타임아웃 타이머는 **받으면 끈다** (수정 1회차 L1). agent 구독은 pane 집합이 바뀔 때마다
    // 커넥션째 다시 열리므로, 안 끄면 5초짜리 죽은 타이머가 계속 쌓인다.
    const ack = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SubscriptionRejected('timeout', `구독 ack 타임아웃 (${timeoutMs}ms)`)),
        timeoutMs,
      )
      this.onAck = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
      this.onAckFail = (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
    const frame = JSON.stringify({
      id: 'sub',
      method: 'events.subscribe',
      params: { subscriptions: types.map((type) => (typeof type === 'string' ? { type } : type)) },
    })
    log('sub.tx', { label: this.label, conn: socket.id, count: types.length })
    // 이 커넥션에 쓰는 것은 이 한 줄뿐이다. 이후로는 오로지 push 를 받는다.
    socket.write(frame)
    return ack
  }

  close(): void {
    this.socket?.end()
    this.socket = null
  }

  private handleLine(line: string, at: number): void {
    const parsed = safeParse(line)
    if (parsed === null) {
      log('sub.line.parse_error', { label: this.label, line: line.slice(0, 400) })
      return
    }

    const push = asPushFrame(parsed)
    if (push !== null) {
      if (!this.acked) log('sub.push.before_ack', { label: this.label, event: push.event })
      this.hooks.onPush(push, at)
      return
    }

    const response = asResponseFrame(parsed)
    if (response !== null) {
      // ack 이거나 거부. 서버가 요청 전체를 거부하면 id 를 잃는다("id":"") — 그래서 id 로 안 가른다.
      if (response.error) {
        const code = response.error.code ?? 'unknown'
        const message = response.error.message ?? ''
        log('sub.ack.rejected', { label: this.label, code, message })
        this.onAckFail?.(new SubscriptionRejected(code, message))
        return
      }
      this.acked = true
      log('sub.ack', { label: this.label })
      this.onAck?.(response.result)
      return
    }

    log('sub.line.unknown_envelope', { label: this.label, line: line.slice(0, 400) })
  }

  private drop(reason: 'eof' | 'local' | 'error', detail: string): void {
    if (this.dropped) return
    this.dropped = true
    log('sub.drop', { label: this.label, reason, detail })
    if (!this.acked) this.onAckFail?.(new SubscriptionRejected(reason, detail))
    this.hooks.onDrop(reason, detail)
  }
}
