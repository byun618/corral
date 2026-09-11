// 요청 경로 — **요청 1건 = 커넥션 1개** (스파이크 제약 2).
// 서버가 응답 1건마다 커넥션을 닫으므로 재사용도 파이프라인도 불가능하다. 비용은 0.3ms 로 싸다.
//
// 이 파일이 앱에서 요청을 보내는 **유일한** 경로다. 구독 커넥션(subscription.ts)에는
// 요청을 보내는 메서드가 존재하지 않는다 (제약 1).

import { LineSocket } from './line-socket.js'
import { asResponseFrame, type ResponseFrame } from './protocol.js'
import { log } from '../log.js'

/**
 * 앱이 보내도 되는 메서드.
 *
 * LIFE-344 까지 corral 은 herdr 를 **읽기만** 했다. LIFE-345 에서 터미널 입력이 붙으면서
 * `pane.send_text`·`pane.send_keys` 두 개의 **쓰기** 경로가 생긴다 — 목록은 그래서 여전히
 * 화이트리스트다. 여기 없는 메서드는 코드가 실수로 불러도 나가지 않는다.
 *
 * 세션 단위의 안전장치는 따로 있다: `default-session-guard.ts` 가 `default` 세션에는
 * `CORRAL_ALLOW_DEFAULT_INPUT=1` 없이 쓰기를 보내지 않는다 (01-criteria.md §0.1 격리 규칙).
 * 터미널 입력(LIFE-345)과 행 생성·종료(LIFE-346)가 같은 가드를 쓴다.
 */
const ALLOWED_METHODS: readonly string[] = [
  'ping',
  'session.snapshot',
  'worktree.list',
  // --- 터미널 읽기 (LIFE-345) ---
  'pane.read',
  'pane.get',
  'pane.layout',
  // --- 터미널 쓰기 (LIFE-345) ---
  'pane.send_text',
  'pane.send_keys',
  // --- 행 생성·종료 (LIFE-346) ---
  // 생성은 두 걸음이다: `tab.create` 로 탭(+root pane)을 만들고 그 pane 에 `agent.start` 를 건다.
  // `tab.create` 에는 시작 커맨드 파라미터가 없다 (00-analysis.md ⓐ·ⓑ).
  'tab.create',
  'agent.start',
  'tab.close',
  // 기동 여부는 **관측**으로 판정한다 — 이 읽기가 그 관측이다 (01-criteria.md 관문 ④).
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
        const parsed = safeParse(line)
        const frame = asResponseFrame(parsed)
        if (frame === null) {
          log('req.line.unknown', { conn: socket.id, method, line: line.slice(0, 400) })
          return
        }
        log('req.rx', { conn: socket.id, method, at, line: line.slice(0, 2000) })
        finish(() => resolve(frame))
      },
      // 서버는 응답 뒤 스스로 닫는다 — 응답을 이미 받았으면 정상이다.
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
        const id = `${socket.id}:1`
        const frame = JSON.stringify({ id, method, params })
        log('req.tx', { conn: socket.id, method, line: frame })
        socket.write(frame)
      },
      (error) => finish(() => reject(toRequestError(error))),
    )
  })
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
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

export const RETRYABLE_CONNECT_CODES: readonly string[] = ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE']

export function isRetryable(error: HerdrRequestError): boolean {
  return RETRYABLE_CONNECT_CODES.includes(error.code) || error.code === 'closed' || error.code === 'timeout'
}
