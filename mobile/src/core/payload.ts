// 페어링 QR 페이로드 검사 — 네트워크에 닿기 **전에** 모양을 본다(P3ⓔ). 정본 모양은 SURFACE §5:
//   {"kind":"corral-pair","v":1,"url":"wss://<mac>.<tailnet>.ts.net:8577/ws","code":"ABCD2345"}
// QR 과 붙여넣기(설정 › Mobile 의 같은 텍스트)가 이 함수 하나를 지난다.

export type PairingTarget = { url: string; host: string; code: string }

export type PayloadProblem =
  /** JSON 이 아니거나 corral QR 이 아니다(kind 다름·모양 다름). */
  | 'not_corral'
  /** corral QR 이지만 페이로드 버전이 이 앱이 모르는 것. */
  | 'unknown_version'
  /** 주소가 `wss://<host>[:port]/ws` 가 아니다. */
  | 'bad_url'
  /** 코드가 8자 알파벳이 아니다. */
  | 'bad_code'

export type PayloadResult = { ok: true; target: PairingTarget } | { ok: false; problem: PayloadProblem }

/** SURFACE §5 — 혼동 문자 I·L·O·S·Z·0·1 을 뺀 29자. */
const CODE = /^[ABCDEFGHJKMNPQRTUVWXY23456789]{8}$/
/** 호스트는 DNS 이름(라벨 영숫자·하이픈)만 — 사용자 정보·경로 변형·쿼리 없이 `/ws` 로 끝난다. */
const URL_SHAPE = /^wss:\/\/((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?::(\d{1,5}))?\/ws$/

const MAX_TEXT = 1024

export function parsePairingPayload(text: string): PayloadResult {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT) return { ok: false, problem: 'not_corral' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, problem: 'not_corral' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, problem: 'not_corral' }
  const record: Record<string, unknown> = { ...parsed }
  if (record.kind !== 'corral-pair') return { ok: false, problem: 'not_corral' }
  if (record.v !== 1) return { ok: false, problem: 'unknown_version' }
  if (typeof record.url !== 'string') return { ok: false, problem: 'bad_url' }
  const match = URL_SHAPE.exec(record.url)
  if (match === null) return { ok: false, problem: 'bad_url' }
  const port = match[2] === undefined ? null : Number(match[2])
  if (port !== null && (port < 1 || port > 65535)) return { ok: false, problem: 'bad_url' }
  if (typeof record.code !== 'string') return { ok: false, problem: 'bad_code' }
  const code = record.code.trim().toUpperCase()
  if (!CODE.test(code)) return { ok: false, problem: 'bad_code' }
  return { ok: true, target: { url: record.url, host: match[1], code } }
}

/** 표시·기록용 호스트 — `wss://host:port/ws` 에서 `host:port`. 모양이 틀리면 null. */
export function hostOf(url: string): string | null {
  const match = URL_SHAPE.exec(url)
  if (match === null) return null
  return match[2] === undefined ? match[1] : `${match[1]}:${match[2]}`
}

/** RN Android 가 Origin 을 주지 않을 때 만드는 값과 같은 모양 — `wss://h:p/ws` → `https://h:p` (SURFACE §2 Origin). */
export function originOf(url: string): string | null {
  const host = hostOf(url)
  return host === null ? null : `https://${host}`
}
