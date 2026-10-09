// 모바일 프로토콜 (LIFE-577 A5) — WS 하나 + JSON 텍스트 프레임. 정본 설명은 `SURFACE.md`(같은 폴더).
// M1 메시지는 `hello`·`pair`·`ping` 셋뿐이다. M3~ 는 `CLIENT_TYPES` 에 타입을 더하고 `server.ts` 의 인증 뒤 분기에 한 줄을 더한다.
import { isRecord } from '../../shared/json.js'

/** 프로토콜 버전 — 메시지 모양이 호환되지 않게 바뀔 때만 올린다. 앱 버전과 별개다. */
export const PROTOCOL_VERSION = 1
/** WS 업그레이드를 받는 유일한 경로. */
export const WS_PATH = '/ws'
/** 프레임 하나 상한(바이트) — 넘으면 ws 가 1009 로 닫는다. */
export const MAX_MESSAGE_BYTES = 16 * 1024
/** 인증(hello·pair 성공) 전 연결 수명. */
export const AUTH_TIMEOUT_MS = 10_000
/** 동시 연결 상한 — 인증 전 연결까지 센다. */
export const MAX_CONNECTIONS = 16

export const CLIENT_TYPES = ['hello', 'pair', 'ping'] as const
export type ClientType = (typeof CLIENT_TYPES)[number]

/** 오류 코드 — 문서 표와 같은 목록이다(`SURFACE.md` §4). */
export type ErrorCode =
  | 'bad_json'
  | 'bad_message'
  | 'protocol_mismatch'
  | 'unauthorized'
  | 'not_authenticated'
  | 'pair_rejected'
  | 'device_limit'
  | 'unknown_type'
  | 'auth_timeout'
  | 'revoked'

/** WS close 코드 — 4000 번대는 응용 몫. */
export const CLOSE = {
  unauthorized: 4001,
  protocolMismatch: 4002,
  revoked: 4003,
  badMessage: 4004,
  pairRejected: 4005,
  authTimeout: 4008,
  shutdown: 1001,
} as const

export type ClientMessage =
  | { type: 'hello'; protocol: number; token: unknown; client: unknown }
  | { type: 'pair'; protocol: number; code: unknown; name: unknown }
  | { type: 'ping'; id: string | number | null }
  | { type: 'unknown'; name: string }

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; code: 'bad_json' | 'bad_message' }

export function parseClientMessage(text: string): ParseResult {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, code: 'bad_json' } }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return { ok: false, code: 'bad_message' }
  switch (parsed.type) {
    case 'hello':
      return typeof parsed.protocol === 'number'
        ? { ok: true, message: { type: 'hello', protocol: parsed.protocol, token: parsed.token, client: parsed.client } }
        : { ok: false, code: 'bad_message' }
    case 'pair':
      return typeof parsed.protocol === 'number'
        ? { ok: true, message: { type: 'pair', protocol: parsed.protocol, code: parsed.code, name: parsed.name } }
        : { ok: false, code: 'bad_message' }
    case 'ping': {
      const id = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null
      return { ok: true, message: { type: 'ping', id } }
    }
    default:
      return { ok: true, message: { type: 'unknown', name: parsed.type.slice(0, 64) } }
  }
}

/** QR 페이로드 — 앱(M2)이 읽는 모양. `url` 은 tailnet 주소(`wss://<mac>.ts.net:<port>/ws`). */
export type PairingPayload = { kind: 'corral-pair'; v: 1; url: string; code: string }

export function pairingPayload(input: { url: string; code: string }): string {
  const payload: PairingPayload = { kind: 'corral-pair', v: 1, url: input.url, code: input.code }
  return JSON.stringify(payload)
}
