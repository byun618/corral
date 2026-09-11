// herdr 소켓 프로토콜 — 봉투 모양과 구독 타입. **이 파일 바깥으로 나가는 모양은 없다.**
//
// 실측(LIFE-342 §1-③): 구독 타입은 점(`pane.created`), 푸시 이벤트는 밑줄(`pane_created`).
// 봉투는 {"event":"pane_created","data":{…}}.

import { isRecord, readRecord, readString } from '../../../shared/json.js'
import type { AgentStatus } from '../../../shared/types.js'

/**
 * corral 이 구독하는 타입. herdr 0.9.0 이 아는 27종의 부분집합이며 **푸시 봉투 모양을 실제로
 * 확인한 것만** 넣는다. 하나라도 모르는 타입을 섞으면 요청 전체가 거부된다 (스파이크 제약 4).
 *
 * R1 은 worktree 열림/닫힘도 그린다 — `worktree.*` 3종이 그래서 들어 있다.
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
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated',
]

/**
 * 상태 전이는 **이 타입으로만** 온다 (LIFE-342 실측: 파라미터 없는 구독에는 0건,
 * `pane_id` 를 건 구독에만 왔다). 그래서 **pane 마다** 걸어야 하는데, 구독 커넥션에는
 * `events.subscribe` 를 한 줄만 쓴다는 것이 스파이크 제약이다 — 그래서 pane 목록이 바뀌면
 * 이 구독만 **커넥션째 새로 연다**. 본 구독은 흔들리지 않는다.
 */
export function agentStatusSubscriptions(paneIds: readonly string[]): Array<Record<string, string>> {
  return paneIds.map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId }))
}

/** 응답 봉투. 서버가 준 result/error 를 가공하지 않고 그대로 들고 다닌다. */
export type ResponseFrame = {
  id?: string
  result?: unknown
  error?: { code?: string; message?: string }
}

/** 구독 push 봉투. */
export type PushFrame = { event: string; data: Record<string, unknown> }

const AGENT_STATUSES: readonly string[] = ['idle', 'working', 'blocked', 'done', 'unknown']

/** herdr 의 상태 문자열을 **corral 의** AgentStatus 로 옮긴다 (경계를 건너는 건 이쪽이다). */
export function readAgentStatus(source: Record<string, unknown>, key: string): AgentStatus {
  const value = source[key]
  if (typeof value !== 'string' || !AGENT_STATUSES.includes(value)) return 'unknown'
  switch (value) {
    case 'idle':
      return 'idle'
    case 'working':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'done'
    default:
      return 'unknown'
  }
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
        : { code: readString(error, 'code') ?? undefined, message: readString(error, 'message') ?? undefined },
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
