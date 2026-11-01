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
 * 앱이 보내도 되는 메서드 — **읽기 4종 + 쓰기 13종** (R3 + LIFE-357 `tab.rename` + LIFE-366 `integration.list`
 *  + LIFE-373 `pane.*` 5종, 그 뒤 읽기 `agent.list` — LIFE-710).
 *
 * R1(LIFE-351)에서는 herdr 접촉이 읽기 전용이었다 — 쓰기 메서드가 나가면 범위 위반이라
 * 화이트리스트에 쓰기가 한 줄도 없었다. R3 에서 행 생성·종료·worktree 조작이 들어오며 쓰기
 * 7종이 늘었고, LIFE-357 I-7 의 `tab.rename` 으로 8종이 됐다 (R1 L3 판정 "R3 에서 다시 늘리면 된다"과 정합). 코드가 목록 밖 메서드를
 * 실수로 불러도 여기서 막힌다.
 *
 * **실제 호출부가 있는 것만 둔다** (수정 1회차 L3 — 판정 "줄인다"). 안 쓰는 줄이 섞이면
 * 목록이 실제 접촉면을 말하지 않는다.
 *   읽기:
 *   · `session.snapshot`   — 부트스트랩·주기 재동기 (link.ts)
 *   · `worktree.list`      — worktree 열림상태 (worktrees.ts)
 *   · `pane.process_info`  — 종료 게이트 판별자 (lifecycle.ts probeForeground)
 *   · `integration.list`   — herdr 통합 훅 설치 상태 (LIFE-366 A1, integrations.ts).
 *     **읽기만 한다** — `integration.install`·`uninstall` 은 목록에 없다. 사용자 에이전트 설정을
 *     고치는 조작이라 corral 이 말없이 부를 일이 아니다 (기준 B8 "사용자 확인 없이 실행하지 않는다")
 *   · `agent.list`         — 에이전트 pane 의 세션 참조 따라잡기 (LIFE-710, link.ts pollAgentSessions)
 *   쓰기 (R3 — lifecycle.ts):
 *   · `tab.create`·`agent.start` — 행 생성 (L1·L2)
 *   · `tab.close`               — 행 종료 (L3·L4·L9a)
 *   · `workspace.close`         — worktree(=workspace) 닫기 (L9b — close_group 없이)
 *   · `worktree.open`·`worktree.create`·`workspace.create` — worktree 열기·만들기·빈 상태 복구 (L6·L7·L8)
 *   · `tab.rename`               — 탭 이름을 사용자가 직접 준다 (LIFE-357 I-7, lifecycle.ts renameTab).
 *     수신부(`tab_renamed`)는 이미 있었고 발신 경로가 없었다 — 이 줄이 그 구멍이다.
 *   쓰기 (LIFE-373 ② — panes.ts):
 *   · `pane.split`·`pane.resize`·`pane.close` — 분할·경계 밀기·닫기 (F2-1·F2-2·F2-5).
 *     **분할 트리는 herdr 것이다** — corral 이 클라이언트 트리를 발명하지 않는다 (§0-1)
 *   · `pane.zoom`     — 줌 **플래그만** 서버에 남긴다. 그리는 건 클라이언트다 (F2-3, A5)
 *   · `pane.neighbor` — 인접 pane 을 **묻는다**. `pane.focus_direction` 은 여기 없다:
 *     그건 herdr 세션 전역 포커스를 움직여 사용자의 TUI 클라이언트까지 끌고 간다 (3차 T3b).
 *     corral 은 이웃 id 만 받아 자기 연결의 `pane.focus`(endpoint 소켓)로 옮긴다
 */
const ALLOWED_METHODS: readonly string[] = [
  'corral.terminal',
  'session.snapshot',
  'worktree.list',
  'pane.process_info',
  'integration.list',
  'agent.explain',
  // LIFE-710 — 세션 참조 따라잡기 (link.ts `pollAgentSessions`). 읽기 전용.
  'agent.list',
  'tab.create',
  'agent.start',
  'tab.close',
  'workspace.close',
  'worktree.open',
  'worktree.create',
  'workspace.create',
  'tab.rename',
  // LIFE-373 ② — pane 분할. 분할 트리는 herdr 것이고 corral 은 이 다섯으로만 건드린다 (panes.ts).
  'pane.split',
  'pane.resize',
  'pane.zoom',
  'pane.close',
  'pane.neighbor',
]

export class HerdrRequestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HerdrRequestError'
    this.code = code
  }
}

/**
 * `quiet` — 성공한 요청의 `req.*` 줄(open·tx·rx·close)을 남기지 않는다. 오류 답(`req.rx.error`)·모르는 줄은 그대로 남기고,
 * 연결 실패·타임아웃은 호출부가 남긴다. 짧은 주기로 도는 읽기(세션 조회, LIFE-710)가 로그를 쌓지 않게 하려는 것이다.
 */
export type RequestOptions = { timeoutMs?: number; reason?: string; signal?: AbortSignal; onSent?: () => void; quiet?: boolean }

export async function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<ResponseFrame> {
  if (!ALLOWED_METHODS.includes(method)) {
    throw new HerdrRequestError('method_not_allowed', `corral 이 보내지 않는 메서드: ${method}`)
  }
  options.signal?.throwIfAborted()
  const timeoutMs = options.timeoutMs ?? 5000
  const reason = options.reason ?? 'app'
  const trace: typeof log = options.quiet === true ? () => {} : log

  return new Promise<ResponseFrame>((resolve, reject) => {
    let done = false
    let timer: NodeJS.Timeout | null = null
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      trace('req.conn.close', { conn: socket.id, method, reason })
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
        // 에러 응답은 **원문 줄 그대로** 남긴다 (L9 채널 원자료 — advisor). 성공은 바이트 수만.
        if (frame.error) log('req.rx.error', { conn: socket.id, method, at, line: line.slice(0, 2000) })
        else trace('req.rx', { conn: socket.id, method, at, bytes: line.length })
        finish(() => resolve(frame))
      },
      // 서버는 응답 뒤 스스로 닫는다 — 응답을 이미 받았으면 finish 가 먼저라 이 경로로 안 온다.
      onClose: () => finish(() => reject(new HerdrRequestError('closed', `응답 전에 닫힘: ${method}`))),
      onError: (error) => finish(() => reject(toRequestError(error))),
    })

    const abort = () => finish(() => reject(new HerdrRequestError('request_cancelled', 'Request cancelled')))
    options.signal?.addEventListener('abort', abort, { once: true })
    trace('req.conn.open', { conn: socket.id, method, reason, socketPath })
    socket.connect(socketPath).then(
      () => {
        if (done || options.signal?.aborted) { abort(); return }
        timer = setTimeout(
          () => finish(() => reject(new HerdrRequestError('timeout', `타임아웃 ${method} (${timeoutMs}ms)`))),
          timeoutMs,
        )
        const frame = JSON.stringify({ id: `${socket.id}:1`, method, params })
        trace('req.tx', { conn: socket.id, method, ...(method === 'corral.terminal' ? { bytes: frame.length } : { line: frame.slice(0, 500) }) })
        options.onSent?.()
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
