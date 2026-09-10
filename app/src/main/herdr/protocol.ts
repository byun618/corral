// herdr 소켓 프로토콜 — 봉투 모양과 구독 타입 목록.
//
// 스파이크(LIFE-342 §1-③)에서 실측한 것: 구독 타입은 점(`pane.created`), 푸시 이벤트는
// 밑줄(`pane_created`). 봉투는 {"event":"pane_created","data":{"type":"pane_created",…}}.
// 파라미터를 받는 3종(`pane.output_matched`·`pane.agent_status_changed`·`pane.scroll_changed`)만
// SubscriptionEventKind 로 되돌아온다 — 그쪽 봉투는 아직 실측한 적이 없으므로 구독하지 않는다.

import type { AgentStatus } from '../../shared/types.js'

/**
 * corral 이 구독하는 타입. herdr 0.9.0 이 아는 27종의 부분집합이며,
 * **푸시 봉투 모양을 실제로 확인한 것만** 넣는다.
 * 하나라도 모르는 타입을 섞으면 요청 전체가 거부된다 (스파이크 제약 4).
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
  'tab.created',
  'tab.closed',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.exited',
  'layout.updated',
]

export type RequestFrame = { id: string; method: string; params: Record<string, unknown> }

/** 응답 봉투. 서버가 준 result/error 를 가공하지 않고 그대로 들고 다닌다. */
export type ResponseFrame = {
  id?: string
  result?: unknown
  error?: { code?: string; message?: string }
}

/** 구독 push 봉투. */
export type PushFrame = { event: string; data: Record<string, unknown> }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' ? value : null
}

export function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key]
  return isRecord(value) ? value : null
}

const AGENT_STATUSES: readonly string[] = ['idle', 'working', 'blocked', 'done', 'unknown']

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

/** 줄 하나를 push 봉투로 읽는다. 모양이 다르면 null — 던지지 않는다. */
export function asPushFrame(message: unknown): PushFrame | null {
  if (!isRecord(message)) return null
  const event = readString(message, 'event')
  const data = readRecord(message, 'data')
  if (event === null || data === null) return null
  return { event, data }
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
