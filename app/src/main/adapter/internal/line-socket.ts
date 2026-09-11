// NDJSON 줄 프레이밍 + 소켓 수명. 요청 커넥션과 구독 커넥션이 공통으로 쓴다.
//
// 끊김은 EOF('close')로 감지한다. 서버가 없는 동안 connect 는 ENOENT(정상 종료 — 소켓 파일이
// 사라짐) 또는 ECONNREFUSED(크래시 — 파일만 남음)로 실패한다. 시도마다 **새 net.Socket** 을
// 만들고 'error' 리스너를 새로 건다 — 안 걸면 unhandled error 로 프로세스가 죽는다.

import net from 'node:net'

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
   */
  connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.setEncoding('utf8')
      this.socket.on('error', (error) => {
        if (!this.settled) {
          this.settled = true
          reject(error)
          return
        }
        this.hooks.onError(error)
      })
      this.socket.on('data', (chunk) => this.consume(String(chunk)))
      this.socket.on('close', () => {
        if (!this.settled) {
          this.settled = true
          reject(new Error(`connect closed without error: ${socketPath}`))
          return
        }
        this.hooks.onClose(this.endedByUs ? 'local' : 'eof')
      })
      this.socket.once('connect', () => {
        this.settled = true
        resolve()
      })
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
