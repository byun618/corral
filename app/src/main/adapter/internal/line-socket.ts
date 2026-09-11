// NDJSON 줄 프레이밍 + 소켓 수명. 요청 커넥션과 구독 커넥션이 공통으로 쓴다.
//
// 끊김은 EOF('close')로 감지한다. 서버가 없는 동안 connect 는 ENOENT(정상 종료 — 소켓 파일이
// 사라짐) 또는 ECONNREFUSED(크래시 — 파일만 남음)로 실패한다. 시도마다 **새 net.Socket** 을
// 만들고 'error' 리스너를 새로 건다 — 안 걸면 unhandled error 로 프로세스가 죽는다.

import net from 'node:net'

/**
 * connect 단계 시한. 유닉스 소켓 연결은 보통 즉시 성공하거나 ENOENT/ECONNREFUSED 로 떨어지므로
 * 이 시한에 걸리는 것은 백로그가 찼거나 서버 프로세스가 멈춘 경우다 — 둘 다 재시도 대상이다.
 */
const CONNECT_TIMEOUT_MS = 5000

export type LineSocketHooks = {
  onLine: (line: string, at: number) => void
  /** 소켓이 닫혔다. reason 은 'eof'(서버가 끊음) 또는 'local'(우리가 끊음). */
  onClose: (reason: 'eof' | 'local') => void
  onError: (error: NodeJS.ErrnoException) => void
}

let nextConnectionId = 0

export class LineSocket {
  readonly id: string
  private readonly socket: net.Socket
  private readonly hooks: LineSocketHooks
  private buffer = ''
  private settled = false
  private endedByUs = false

  constructor(hooks: LineSocketHooks) {
    this.id = `c${++nextConnectionId}`
    this.hooks = hooks
    this.socket = new net.Socket()
  }

  /**
   * connect 단계 실패와 연결 후 실패를 **명시적 플래그로** 가른다.
   * readyState 로 가르면 ENOENT 가 이미 'closed' 로 보여 프라미스가 영영 안 풀린다 (LIFE-342 실측).
   *
   * **시한은 여기 있다** (수정 1회차 M4). 1회차에는 두 호출부가 타임아웃을 connect **뒤에**
   * 걸어서, connect 자체가 얼면 프라미스가 영영 안 풀렸다. 그 결과가 둘이었다 —
   * 부트스트랩이 `subscribing` 라벨을 들고 멈추고(catch 도 재시도도 없다), `resync()` 의
   * `resyncing` 플래그가 `finally` 를 못 만나 **주기 재동기가 영구 정지**한다(N7 이 사는 기능).
   * 한 자리에 두면 요청·구독 두 경로가 같이 낫는다.
   */
  connect(socketPath: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.settled) return
        this.settled = true
        this.socket.destroy()
        const error: NodeJS.ErrnoException = new Error(`connect 타임아웃 ${timeoutMs}ms: ${socketPath}`)
        error.code = 'connect_timeout'
        reject(error)
      }, timeoutMs)
      const settle = (fn: () => void): void => {
        clearTimeout(timer)
        this.settled = true
        fn()
      }
      this.socket.setEncoding('utf8')
      this.socket.on('error', (error) => {
        if (!this.settled) {
          settle(() => reject(error))
          return
        }
        this.hooks.onError(error)
      })
      this.socket.on('data', (chunk) => this.consume(String(chunk)))
      this.socket.on('close', () => {
        if (!this.settled) {
          settle(() => reject(new Error(`connect closed without error: ${socketPath}`)))
          return
        }
        this.hooks.onClose(this.endedByUs ? 'local' : 'eof')
      })
      this.socket.once('connect', () => settle(resolve))
      this.socket.connect(socketPath)
    })
  }

  write(line: string): void {
    this.socket.write(line + '\n')
  }

  end(): void {
    this.endedByUs = true
    this.socket.end()
    this.socket.destroy()
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) break
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      this.hooks.onLine(line, Date.now())
    }
  }
}
