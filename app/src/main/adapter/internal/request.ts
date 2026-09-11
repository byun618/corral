// 요청 경로 — **요청 1건 = 커넥션 1개** (스파이크 제약 2).
// 서버가 응답 1건마다 커넥션을 닫으므로 재사용도 파이프라인도 불가능하다. 비용은 0.3ms 로 싸다.
//
// 이 파일이 앱에서 요청을 보내는 **유일한** 경로다. 구독 커넥션(subscription.ts)에는 요청을
// 보내는 메서드가 존재하지 않는다 (제약 1).

import { safeParse } from '../../../shared/json.js'
import { log } from '../../log.js'
import { LineSocket } from './line-socket.js'
import { asResponseFrame, type ResponseFrame } from './protocol.js'

/**
 * 앱이 보내도 되는 메서드 — **R1 은 전부 읽기다.**
 *
 * 킥오프가 못 박은 것: "R1 의 herdr 접촉은 읽기 전용이다 — 쓰기 메서드가 나가면 그 자체가
 * 범위 위반". 그래서 화이트리스트에 쓰기가 한 줄도 없다. 코드가 실수로 불러도 여기서 막힌다.
 * (행 생성·종료는 R3. 그때 이 목록에 줄이 늘어난다.)
 */
const ALLOWED_METHODS: readonly string[] = [
  'ping',
  'session.snapshot',
  'workspace.list',
  'tab.list',
  'pane.list',
  'worktree.list',
  'pane.process_info',
]

export class HerdrRequestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HerdrRequestError'
    this.code = code
  }
}

export type RequestOptions = { timeoutMs?: number; reason?: string }

export async function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<ResponseFrame> {
  if (!ALLOWED_METHODS.includes(method)) {
    throw new HerdrRequestError('method_not_allowed', `corral 이 보내지 않는 메서드: ${method}`)
  }
  const timeoutMs = options.timeoutMs ?? 5000
  const reason = options.reason ?? 'app'

  return new Promise<ResponseFrame>((resolve, reject) => {
    let done = false
    let timer: NodeJS.Timeout | null = null
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      log('req.conn.close', { conn: socket.id, method, reason })
      socket.end()
      fn()
    }

    const socket = new LineSocket({
      onLine: (line, at) => {
        const frame = asResponseFrame(safeParse(line))
        if (frame === null) {
          log('req.line.unknown', { conn: socket.id, method, line: line.slice(0, 400) })
          return
        }
        log('req.rx', { conn: socket.id, method, at, bytes: line.length })
        finish(() => resolve(frame))
      },
      // 서버는 응답 뒤 스스로 닫는다 — 응답을 이미 받았으면 finish 가 먼저라 이 경로로 안 온다.
      onClose: () => finish(() => reject(new HerdrRequestError('closed', `응답 전에 닫힘: ${method}`))),
      onError: (error) => finish(() => reject(toRequestError(error))),
    })

    log('req.conn.open', { conn: socket.id, method, reason, socketPath })
    socket.connect(socketPath).then(
      () => {
        timer = setTimeout(
          () => finish(() => reject(new HerdrRequestError('timeout', `타임아웃 ${method} (${timeoutMs}ms)`))),
          timeoutMs,
        )
        const frame = JSON.stringify({ id: `${socket.id}:1`, method, params })
        log('req.tx', { conn: socket.id, method, line: frame.slice(0, 500) })
        socket.write(frame)
      },
      (error) => finish(() => reject(toRequestError(error))),
    )
  })
}

/**
 * ENOENT = 소켓 파일 자체가 없다 (서버가 정상 종료하며 unlink 했다).
 * ECONNREFUSED = 파일은 남았는데 듣는 프로세스가 없다 (크래시). **둘 다 재시도 대상**이고
 * 구분은 진단용이다.
 */
export function toRequestError(error: unknown): HerdrRequestError {
  if (error instanceof HerdrRequestError) return error
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'
    return new HerdrRequestError(code, error.message)
  }
  return new HerdrRequestError('unknown', String(error))
}
