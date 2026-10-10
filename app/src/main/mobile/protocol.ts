// 모바일 프로토콜 (LIFE-577 A5) — WS 하나 + JSON 텍스트 프레임. 정본 설명은 `SURFACE.md`(같은 폴더).
// M1 메시지는 `hello`·`pair`·`ping`, M3(LIFE-580)이 `list.subscribe`, M4(LIFE-581)가 `chat.subscribe`·`chat.older`·`chat.unsubscribe` 를 더했다. M3~ 는 `CLIENT_TYPES` 에 타입을 더하고 `server.ts` 의 인증 뒤 분기에 한 줄을 더한다.
// M5(LIFE-582)가 폰이 맥에 **쓰는** 메시지 다섯을 더했다 — `input.send`·`input.cancel`·`input.status`·`question.answer`·`turn.stop`(+ r1 복구 조회 `input.pending`). 키·바이트를 싣는 메시지는 없다(P8).
import { isRecord } from '../../shared/json.js'
import { MAX_INPUT_BYTES } from './keys.js'

/** 프로토콜 버전 — 메시지 모양이 호환되지 않게 바뀔 때만 올린다. 앱 버전과 별개다. */
export const PROTOCOL_VERSION = 1
/** WS 업그레이드를 받는 유일한 경로. */
export const WS_PATH = '/ws'
/** 프레임 하나 상한(바이트) — 넘으면 1009 로 닫는다. 인증된 `input.send`·`question.answer` 만 예외(`MAX_INPUT_FRAME_BYTES`, LIFE-582 P7). */
export const MAX_MESSAGE_BYTES = 16 * 1024
/**
 * `input.send`·`question.answer` 프레임 상한 — 본문(직접 입력 글 합계) 65536 바이트(`MAX_INPUT_BYTES`)가 JSON 이스케이프(줄바꿈·따옴표 2바이트)로
 * 불어도 들어가게 두 배 + 여유. ws 의 `maxPayload` 는 이 값이다 — 인증 전 수신은 소켓 바이트로 16 KiB 를 따로 세고(`PRE_AUTH_MAX_BYTES`),
 * 인증 뒤 다른 메시지(파싱 실패·바이너리 포함)는 서버가 16 KiB 를 직접 다시 건다(`server.ts`, R1-A10).
 */
export const MAX_INPUT_FRAME_BYTES = MAX_INPUT_BYTES * 2 + 4096
/** 폰이 만든 메시지 id — 영숫자·`_`·`-` 8~64자. */
export const INPUT_ID = /^[A-Za-z0-9_-]{8,64}$/
/** 인증 전 연결이 보낼 수 있는 소켓 바이트 합계 — 16 KiB 프레임 하나 + 프레임 머리·close 여유(R1-A10). 넘으면 1009. */
export const PRE_AUTH_MAX_BYTES = MAX_MESSAGE_BYTES + 512
/** 질문 말풍선의 도구 호출 id 상한(글자). */
export const QUESTION_CALL_MAX = 256
/** `input.status` 한 번에 묻는 id 수 상한. */
export const INPUT_STATUS_MAX = 100
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

export const CLIENT_TYPES = ['hello', 'pair', 'ping', 'list.subscribe', 'chat.subscribe', 'chat.older', 'chat.unsubscribe', 'input.send', 'input.cancel', 'input.status', 'question.answer', 'turn.stop', 'input.pending'] as const
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
  /** 프레임이 상한을 넘었다 — 인증 전 16 KiB, 인증 뒤 `input.send` 만 `MAX_INPUT_FRAME_BYTES`(LIFE-582 P7). */
  tooBig: 1009,
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
  /** 지시 보내기(LIFE-582 P2) — `id` 는 폰이 만든 고유값. 같은 id 를 다시 보내면 다시 넣지 않고 상태만 받는다. `text` 는 65536 UTF-8 바이트까지. */
  | { type: 'input.send'; id: string; channel: string; text: string }
  /** 큐 취소 — 아직 넣기 시작하지 않은 것만. */
  | { type: 'input.cancel'; id: string }
  /** 상태 조회 — 재연결 뒤 결과를 못 받은 id 들. */
  | { type: 'input.status'; ids: string[] }
  /**
   * 질문 답 — `question` = 대화의 질문 말풍선 id, `call` = 그 말풍선의 도구 호출 id(R1-A2 — 말풍선 id 는 파일 위치라 다른 질문에 재사용될 수 있다),
   * `answers` = 문항 순서대로 고른 선택지 번호(0부터)·직접 입력 글(합계 65536 UTF-8 바이트까지, P7).
   */
  | { type: 'question.answer'; id: string; channel: string; question: number; call: string | null; answers: { choices: number[]; other: string | null }[] }
  /** 중단 — 서버가 그 순간 상태를 보고 provider 키 1회. */
  | { type: 'turn.stop'; id: string; channel: string }
  /** 복구 조회(R1-A8) — 이 기기의 끝나지 않은 요청 전부를 `input.state` 로 받는다(폰 앱이 다시 시작해 id 를 잊었을 때). */
  | { type: 'input.pending' }
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
    case 'input.send': {
      if (!inputId(parsed.id) || !channelId(parsed.channel) || typeof parsed.text !== 'string') return { ok: false, code: 'bad_message' }
      if (parsed.text.length === 0 || Buffer.byteLength(parsed.text) > MAX_INPUT_BYTES) return { ok: false, code: 'bad_message' }
      return { ok: true, message: { type: 'input.send', id: parsed.id, channel: parsed.channel, text: parsed.text } }
    }
    case 'input.cancel':
      return inputId(parsed.id) ? { ok: true, message: { type: 'input.cancel', id: parsed.id } } : { ok: false, code: 'bad_message' }
    case 'input.status': {
      const ids = parsed.ids
      if (!Array.isArray(ids) || ids.length > INPUT_STATUS_MAX) return { ok: false, code: 'bad_message' }
      const valid = ids.filter(inputId)
      return valid.length === ids.length ? { ok: true, message: { type: 'input.status', ids: valid } } : { ok: false, code: 'bad_message' }
    }
    case 'question.answer': {
      if (!inputId(parsed.id) || !channelId(parsed.channel) || typeof parsed.question !== 'number' || !Number.isFinite(parsed.question)) return { ok: false, code: 'bad_message' }
      const call = parsed.call ?? null
      if (call !== null && (typeof call !== 'string' || call.length === 0 || call.length > QUESTION_CALL_MAX)) return { ok: false, code: 'bad_message' }
      const answers = readAnswers(parsed.answers)
      if (answers === null) return { ok: false, code: 'bad_message' }
      return { ok: true, message: { type: 'question.answer', id: parsed.id, channel: parsed.channel, question: parsed.question, call, answers } }
    }
    case 'input.pending':
      return { ok: true, message: { type: 'input.pending' } }
    case 'turn.stop':
      if (!inputId(parsed.id) || !channelId(parsed.channel)) return { ok: false, code: 'bad_message' }
      return { ok: true, message: { type: 'turn.stop', id: parsed.id, channel: parsed.channel } }
    default:
      return { ok: true, message: { type: 'unknown', name: parsed.type.slice(0, 64) } }
  }
}

const inputId = (value: unknown): value is string => typeof value === 'string' && INPUT_ID.test(value)
const channelId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= CHANNEL_ID_MAX

/** 질문 답 모양 — 문항 10개까지, 문항마다 선택지 번호 20개까지(0~19 정수) · 직접 입력 글 합계 `MAX_INPUT_BYTES` 까지(P7 — 서버가 한 줄로 다시 정리한다). */
function readAnswers(value: unknown): { choices: number[]; other: string | null }[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) return null
  const out: { choices: number[]; other: string | null }[] = []
  let bytes = 0
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item.choices) || item.choices.length > 20) return null
    const choices: number[] = []
    for (const choice of item.choices) {
      if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 19) return null
      choices.push(choice)
    }
    const other = item.other
    if (other !== null && other !== undefined && typeof other !== 'string') return null
    if (typeof other === 'string') bytes += Buffer.byteLength(other)
    if (bytes > MAX_INPUT_BYTES) return null
    out.push({ choices, other: typeof other === 'string' ? other : null })
  }
  return out
}

/** QR 페이로드 — 앱(M2)이 읽는 모양. `url` 은 tailnet 주소(`wss://<mac>.ts.net:<port>/ws`). */
export type PairingPayload = { kind: 'corral-pair'; v: 1; url: string; code: string }

export function pairingPayload(input: { url: string; code: string }): string {
  const payload: PairingPayload = { kind: 'corral-pair', v: 1, url: input.url, code: input.code }
  return JSON.stringify(payload)
}
