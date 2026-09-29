// herdr 소켓 프로토콜 — 봉투 모양과 구독 타입. **이 파일 바깥으로 나가는 모양은 없다.**
//
// 실측(LIFE-342 §1-③): 구독 타입은 점(`pane.created`), 푸시 이벤트는 밑줄(`pane_created`).
// 봉투는 {"event":"pane_created","data":{…}}.

import { isRecord, readRecord, readString } from '../../../shared/json.js'
import { parseAgentStatus } from '../../../shared/agent-state.js'
import type { AgentStatus } from '../../../shared/types.js'
import { log } from '../../log.js'

/**
 * corral 이 구독하는 타입. herdr 0.9.0 이 아는 27종의 부분집합이며 **푸시 봉투 모양을 실제로
 * 확인한 것만** 넣는다. 하나라도 모르는 타입을 섞으면 요청 전체가 거부된다 (스파이크 제약 4).
 *
 * R1 은 worktree 열림/닫힘도 그린다 — `worktree.*` 3종이 그래서 들어 있다.
 *
 * **이 배열의 순서가 푸시 도착 순서다** (F17 실측). herdr 서버는 구독 항목마다 커서를 따로
 * 두고 **여기 적힌 순서대로** 한 바퀴에 한 건씩 흘린다(`src/api/server.rs:749-753`). 그래서
 * 마지막 탭을 닫으면 서버가 `TabClosed` → `WorkspaceClosed` 로 내는데도
 * (`src/app/api/tabs.rs:248-261`) corral 에는 `workspace.closed` 가 먼저 도착한다 —
 * 이 목록에서 앞에 있기 때문이다. 목록 순서만 뒤집은 두 구독으로 같은 닫기를 동시에 받아
 * 도착 순서가 그대로 뒤집히는 것을 실측했다(`raw/claude/s9-r1/08-f17-retained-and-order.md`).
 * **재정렬하면 도착 순서가 조용히 바뀐다** — 순서에 기대는 판정을 새로 만들지 말 것.
 */
export const SUBSCRIPTION_TYPES: readonly string[] = [
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.closed',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  // 목록이 탭 **번호·순서**를 그린다 — 순서가 바뀌면 화면도 따라가야 한다 (수정 1회차 M5).
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated',
]

/**
 * **일부러 뺀 것** (수정 1회차 L13 — 다음 라운드가 이걸 "빠졌다" 로 재발견하지 않게 적는다).
 * herdr 0.9.0 이 아는 27종 중 위 목록에 없는 것과 그 이유:
 *   · `pane.focused` — endpoint 세션은 자기 연결의 focus 를 자기가 정한다(`pane.focus` per-client,
 *     0.9.0 실측). 그래서 control 구독의 `pane.focused` 는 R2 에서도 불필요하다 — corral 의
 *     터미널 포커스는 endpoint 연결이 쥐지 control push 가 아니다 (LIFE-353 재평가, 00-analysis §3-2)
 *   · `pane.moved` — pane 이 다른 탭으로 옮겨가는 이벤트. R2 스트림은 paneId 로 붙으므로 이동해도
 *     같은 pane 을 따라간다(surface 에 그 pane 이 남는 한). pane 이 목록에서 **사라지는** 경우만
 *     스트림을 내리면 되는데(main 의 `dropStreamIfPaneGone`), 그건 `pane_closed`/스냅샷 재동기가
 *     이미 store 에서 지운다 — `pane.moved` 를 따로 구독할 필요가 여기서도 없다 (LIFE-353 확인)
 *   · `pane.output_matched` · `pane.scroll_changed` — 터미널 내용 층이다. 목록과 무관하고
 *     둘 다 파라미터를 요구하는 구독이라 pane 마다 커넥션이 든다
 *   · `pane.agent_status_changed` — 목록에 없는 게 아니라 **별도 커넥션**으로 건다 (바로 아래)
 *
 * 상태 전이는 **이 타입으로만** 온다 (LIFE-342 실측: 파라미터 없는 구독에는 0건,
 * `pane_id` 를 건 구독에만 왔다). 그래서 **pane 마다** 걸어야 하는데, 구독 커넥션에는
 * `events.subscribe` 를 한 줄만 쓴다는 것이 스파이크 제약이다 — 그래서 pane 목록이 바뀌면
 * 이 구독만 **커넥션째 새로 연다**. 본 구독은 흔들리지 않는다.
 */
export function agentStatusSubscriptions(paneIds: readonly string[]): Array<Record<string, string>> {
  return paneIds.map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId }))
}

/**
 * 응답 봉투. 서버가 준 result/error 를 가공하지 않고 그대로 들고 다닌다.
 *
 * `observed` 는 가드가 거절하면서 **자기가 본 AgentInfo** 를 실어 보내는 자리다 (LIFE-394 §1.4).
 * 거절의 근거는 그 관측값 하나뿐인데 봉투가 code·message 만 남기면 호출자는 거절 시점의 상태를
 * 다시 볼 방법이 없다 — 되읽기는 이미 달라진 상태를 본다. 그래서 **모양을 보지 않고 그대로** 통과시킨다.
 */
export type ResponseFrame = {
  id?: string
  result?: unknown
  error?: { code?: string; message?: string; observed?: unknown }
}

/** 구독 push 봉투. */
export type PushFrame = { event: string; data: Record<string, unknown> }

/**
 * herdr 의 상태 문자열을 **corral 의** AgentStatus 로 옮긴다 (경계를 건너는 건 이쪽이다).
 *
 * **다섯 값을 전부 산다** (LIFE-456). 전에는 `done` 을 미상으로 접고 로그만 남겼는데,
 * 그 근거였던 "0.9.0 은 done 을 만들지 않는다" 가 거짓이었다 — 그건 `pane.report_agent` 의
 * **입력** 스키마였고 herdr 가 파생해 내보내는 출력은 done 을 낸다(`shared/types.ts` 참조).
 * 사용자 로그의 `agent_status.unmapped` 11,463 건이 전부 `wire:"done"` 이었던 것이 그 증거다.
 *
 * 이제 이 로그에는 **정말 모르는 값만** 남는다 — 그래서 로그가 다시 신호가 된다.
 */
export function readAgentStatus(source: Record<string, unknown>, key: string): AgentStatus {
  const value = source[key]
  const parsed = parseAgentStatus(value)
  if (parsed !== null) return parsed
  if (typeof value === 'string') log('agent_status.unmapped', { wire: value, key })
  return 'unknown'
}

/**
 * herdr `state_labels` 를 읽는다 — blocked 사유의 입력 (S3).
 *
 * 키가 없으면 `null`(= herdr 가 말하지 않았다)이고 빈 객체와 구분하지 않는다: 둘 다
 * 「사유 없음」이다. **실측상 claude·codex·grok 에서는 항상 이 자리가 비어 온다.**
 */
export function readStateLabels(source: Record<string, unknown>): Record<string, string> | null {
  const raw = source['state_labels']
  if (!isRecord(raw)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value
  return Object.keys(out).length === 0 ? null : out
}

/**
 * 줄 하나를 push 봉투로 읽는다. 모양이 다르면 null — 던지지 않는다.
 *
 * **실측 주의**: push 의 `event` 이름은 구독 타입의 점을 밑줄로 바꾼 것인데
 * (`pane.created` → `pane_created`), **`pane.agent_status_changed` 만 점을 그대로 유지한 채**
 * 온다. 예외 하나 때문에 저장소가 두 이름을 알 필요는 없으므로 여기서 표기를 하나로 맞춘다.
 */
export function asPushFrame(message: unknown): PushFrame | null {
  if (!isRecord(message)) return null
  const event = readString(message, 'event')
  const data = readRecord(message, 'data')
  if (event === null || data === null) return null
  return { event: event.replace(/\./g, '_'), data }
}

/** 줄 하나를 응답 봉투로 읽는다. */
export function asResponseFrame(message: unknown): ResponseFrame | null {
  if (!isRecord(message)) return null
  if (!('result' in message) && !('error' in message)) return null
  const id = readString(message, 'id')
  const error = readRecord(message, 'error')
  return {
    id: id ?? undefined,
    result: message['result'],
    error:
      error === null
        ? undefined
        : {
            code: readString(error, 'code') ?? undefined,
            message: readString(error, 'message') ?? undefined,
            ...('observed' in error ? { observed: error['observed'] } : {}),
          },
  }
}

/** 로그에서 유발↔반영을 짝짓기 위한 주체 id. */
export function subjectOf(frame: PushFrame): string | null {
  const direct = frame.data['workspace_id']
  if (typeof direct === 'string') return direct
  for (const key of ['workspace', 'pane', 'tab']) {
    const nested = readRecord(frame.data, key)
    if (nested === null) continue
    const id = nested['workspace_id']
    if (typeof id === 'string') return id
  }
  return null
}
