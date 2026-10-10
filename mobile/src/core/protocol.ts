// 앱이 쓰는 모바일 프로토콜 — 정본은 `app/src/main/mobile/SURFACE.md`(서버). 여기는 그 표의 앱 쪽 사본이다.
// RN·Expo 를 모른다(단위 시험이 node 에서 돈다).

import { parseChatMessage, type ChatMessage } from './chat'
import { parseListMessage, type ListMessage } from './list'

export const PROTOCOL_VERSION = 1

/** 서버 close 코드(SURFACE §4). */
export const CLOSE = {
  normal: 1000,
  shutdown: 1001,
  abnormal: 1006,
  unauthorized: 4001,
  protocolMismatch: 4002,
  revoked: 4003,
  badMessage: 4004,
  pairRejected: 4005,
  replaced: 4006,
  authTimeout: 4008,
  unavailable: 4009,
} as const

/** 페어링이 실패한 이유 — 서버 오류 코드 + 앱이 아는 것(닿지 않음·저장 실패). */
export type PairFailure =
  | 'code_expired'
  | 'code_used'
  | 'code_invalid'
  | 'pair_rejected'
  | 'device_limit'
  | 'protocol_mismatch'
  | 'unavailable'
  | 'unreachable'
  | 'save_failed'

const SERVER_PAIR_FAILURES = ['code_expired', 'code_used', 'code_invalid', 'pair_rejected', 'device_limit', 'protocol_mismatch', 'unavailable'] as const

export function serverPairFailure(code: string | null): PairFailure | null {
  for (const known of SERVER_PAIR_FAILURES) if (known === code) return known
  return null
}

export type ServerInfo = { version: string; macName: string }

/** 서버 → 앱 메시지 중 앱이 읽는 것. 모르는 모양은 `other`. */
export type ServerMessage =
  | { type: 'hello'; server: ServerInfo; deviceId: string; deviceName: string }
  | { type: 'paired'; server: ServerInfo; token: string; deviceId: string; deviceName: string }
  /** `at` = 서버가 pong 을 보낸 시각(시계차 보정 원자료, R1 C1). 없거나 모양이 틀리면 null. */
  | { type: 'pong'; id: string | number | null; at: number | null }
  /** 대화방 목록(LIFE-580). */
  | { type: 'list'; message: ListMessage }
  /** `list` 타입인데 모양을 읽지 못했다(R1-A4) — 버리지 않고 목록 실패로 올린다. 아는 번호만 같이. */
  | { type: 'list_invalid'; seq: number | null }
  /** 대화(LIFE-581) — `chat.page`·`chat.items`·`chat.unavailable`. 봉투를 읽지 못하면 `chat_invalid`. */
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat_invalid' }
  | { type: 'error'; code: string; supported: number[] }
  | { type: 'other' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readServer(value: unknown): ServerInfo | null {
  if (!isRecord(value) || typeof value.version !== 'string' || typeof value.macName !== 'string') return null
  return { version: value.version, macName: value.macName }
}

function readDevice(value: unknown): { id: string; name: string } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null
  return { id: value.id, name: value.name }
}

export function parseServerMessage(text: string): ServerMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { type: 'other' }
  }
  if (!isRecord(parsed)) return { type: 'other' }
  switch (parsed.type) {
    case 'hello': {
      const server = readServer(parsed.server)
      const device = readDevice(parsed.device)
      if (parsed.ok !== true || server === null || device === null) return { type: 'other' }
      return { type: 'hello', server, deviceId: device.id, deviceName: device.name }
    }
    case 'paired': {
      const server = readServer(parsed.server)
      const device = readDevice(parsed.device)
      if (server === null || device === null || typeof parsed.token !== 'string' || parsed.token.length === 0) return { type: 'other' }
      return { type: 'paired', server, token: parsed.token, deviceId: device.id, deviceName: device.name }
    }
    case 'pong':
      return {
        type: 'pong',
        id: typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null,
        at: typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null,
      }
    case 'list': {
      const message = parseListMessage(parsed)
      if (message !== null) return { type: 'list', message }
      return { type: 'list_invalid', seq: typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : null }
    }
    case 'chat.page':
    case 'chat.items':
    case 'chat.unavailable': {
      const message = parseChatMessage(parsed)
      return message === null ? { type: 'chat_invalid' } : { type: 'chat', message }
    }
    case 'error': {
      const supported = Array.isArray(parsed.supported) ? parsed.supported.filter((v): v is number => typeof v === 'number') : []
      return { type: 'error', code: typeof parsed.code === 'string' ? parsed.code : 'unknown', supported }
    }
    default:
      return { type: 'other' }
  }
}
