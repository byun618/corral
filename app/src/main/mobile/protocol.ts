// 모바일 프로토콜 (LIFE-577 A5) — WS 하나 + JSON 텍스트 프레임. 정본 설명은 `SURFACE.md`(같은 폴더).
// M1 메시지는 `hello`·`pair`·`ping`, M3(LIFE-580)이 `list.subscribe`, M4(LIFE-581)가 `chat.subscribe`·`chat.older`·`chat.unsubscribe` 를 더했다. M3~ 는 `CLIENT_TYPES` 에 타입을 더하고 `server.ts` 의 인증 뒤 분기에 한 줄을 더한다.
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
/** 인증된 연결의 생존 확인 주기 — 이 주기로 WS ping 프레임을 보내고 무수신을 잰다(LIFE-578 E3). */
export const LIVENESS_INTERVAL_MS = 10_000
/** 인증된 연결이 이만큼 아무 프레임(메시지·pong)도 보내지 않으면 죽은 연결로 보고 끊는다. 정리까지 최대 = 이 값 + 주기. */
export const IDLE_TIMEOUT_MS = 30_000

/** 채널 id 길이 상한 — 목록의 id 는 pane id(`w1:p3`)·`retained:<pane id>` 라 짧다. */
export const CHANNEL_ID_MAX = 200

export const CLIENT_TYPES = ['hello', 'pair', 'ping', 'list.subscribe', 'chat.subscribe', 'chat.older', 'chat.unsubscribe'] as const
export type ClientType = (typeof CLIENT_TYPES)[number]

/** 오류 코드 — 문서 표와 같은 목록이다(`SURFACE.md` §4). */
export type ErrorCode =
  | 'bad_json'
  | 'bad_message'
  | 'protocol_mismatch'
  | 'unauthorized'
  | 'not_authenticated'
  | 'pair_rejected'
  | 'code_expired'
  | 'code_used'
  | 'code_invalid'
  | 'device_limit'
  | 'unknown_type'
  | 'auth_timeout'
  | 'revoked'
  | 'unavailable'
  | 'replaced'

/** WS close 코드 — 4000 번대는 응용 몫. */
export const CLOSE = {
  unauthorized: 4001,
  protocolMismatch: 4002,
  revoked: 4003,
  badMessage: 4004,
  pairRejected: 4005,
  /** 같은 기기가 새 연결로 다시 인증했다 — 이전 연결을 닫는다(LIFE-578 E3). */
  replaced: 4006,
  authTimeout: 4008,
  /** 노출이 막혔다(Funnel·HTTPS 꺼짐 등) — 새 인증을 받지 않고 기존 연결도 닫는다(fix1 R1-A2). */
  unavailable: 4009,
  shutdown: 1001,
} as const

export type ClientMessage =
  | { type: 'hello'; protocol: number; token: unknown; client: unknown }
  | { type: 'pair'; protocol: number; code: unknown; name: unknown }
  | { type: 'ping'; id: string | number | null }
  /** 대화방 목록 구독(LIFE-580) — 인증 뒤. 다시 보내면 전체 스냅샷을 다시 받는다(재연결·포그라운드 복귀). */
  | { type: 'list.subscribe' }
  /**
   * 대화 구독(LIFE-581) — 인증 뒤. `channel` = 목록이 준 채널 id. `resume` = 받은 세대 · 들고 있는 첫 말풍선 id(`from`) · 받은 가장 큰 변경 순번(`cursor`)
   * — 셋이 다 있을 때만(R1-A2, 재연결 이어 받기 — 없으면 최근 페이지). 다시 보내면 이전 대화 구독을 끊는다(한 연결에 대화 하나).
   */
  | { type: 'chat.subscribe'; channel: string; resume: { gen: string; from: number; cursor: number } | null }
  /** 과거 페이지 — `before` 보다 앞 말풍선. */
  | { type: 'chat.older'; gen: string; before: number }
  | { type: 'chat.unsubscribe' }
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
    case 'list.subscribe':
      return { ok: true, message: { type: 'list.subscribe' } }
    case 'chat.subscribe': {
      if (typeof parsed.channel !== 'string' || parsed.channel.length === 0 || parsed.channel.length > CHANNEL_ID_MAX) return { ok: false, code: 'bad_message' }
      const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
      const resume = typeof parsed.gen === 'string' && parsed.gen.length <= 64 && finite(parsed.from) && finite(parsed.cursor) ? { gen: parsed.gen, from: parsed.from, cursor: parsed.cursor } : null
      return { ok: true, message: { type: 'chat.subscribe', channel: parsed.channel, resume } }
    }
    case 'chat.older':
      if (typeof parsed.gen !== 'string' || parsed.gen.length > 64 || typeof parsed.before !== 'number' || !Number.isFinite(parsed.before)) return { ok: false, code: 'bad_message' }
      return { ok: true, message: { type: 'chat.older', gen: parsed.gen, before: parsed.before } }
    case 'chat.unsubscribe':
      return { ok: true, message: { type: 'chat.unsubscribe' } }
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
