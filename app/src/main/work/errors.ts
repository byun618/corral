// 오류 분류 (LIFE-600 C5 · K2) — HTTP 상태·던져진 예외를 `WorkError` 로. **추측하지 않는다**:
//   401 = 인증 실패 · 403 = 권한 부족 · 5xx = 서버 오류(네트워크 갈래) — 500 을 인증 실패로 읽지 않는다(00-analysis §3).
//   LA `/mcp` 는 자격 없음·무효·폐기 토큰에 401(`WWW-Authenticate: Bearer …`, 무효면 `error="invalid_token"`)을 준다(LA LIFE-608 · LIFE-635 실측 c10 —
//   옛 「무인증·형식 다른 토큰 = 500」 은 사라졌다). 남은 500 은 서버 오류뿐이다. corral 은 `life_pat_` 접두사가 아닌 토큰을 여전히 보내기 전에 거절한다(K2).
//   분류는 HTTP 상태로만 — `WWW-Authenticate` 의 글은 읽지도 옮기지도 않는다.
// **원격이 준 글은 오류 문구로 옮기지 않는다**(R1-E) — HTTP 본문·도구 오류에서 `code` 칸이 정해진 모양(대문자·숫자·밑줄)일 때 그 코드만 옮기고,
// 문구는 이쪽 말로 쓴다. 원격 `message` 는 토큰을 되울릴 수 있다(리뷰 r1 secret-echo). 나가는 문구는 클라이언트가 한 번 더 토큰을 지운다.

import { isRecord, safeParse } from '../../shared/json.js'
import type { WorkError, WorkErrorKind } from '../../shared/work.js'

export function workError({ kind, message, status = null }: { kind: WorkErrorKind; message: string; status?: number | null }): WorkError {
  return { kind, message, status }
}

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,39}$/

/** 원격 JSON 의 `code` 칸 — 정해진 모양일 때만. 그 밖(문장·토큰 같은 글)은 버린다. */
export function remoteCode(value: unknown): string | null {
  return isRecord(value) && typeof value.code === 'string' && CODE_SHAPE.test(value.code) ? value.code : null
}

/** 본문에서 출처가 준 코드만 꺼낸다(본문·message 를 옮기지 않는다). */
function bodyHint(body: string): string {
  return remoteCode(safeParse(body)) ?? ''
}

/** 문구에서 비밀값을 지운다 — 원문·URL 인코딩 꼴 둘 다. */
export function redactSecret({ text, secret }: { text: string; secret: string }): string {
  if (secret.length === 0) return text
  return text.replaceAll(secret, '••••').replaceAll(encodeURIComponent(secret), '••••')
}

export function classifyHttpStatus({ status, body, host }: { status: number; body: string; host: string }): WorkError {
  const hint = bodyHint(body)
  const suffix = hint === '' ? `(${status})` : `(${status} ${hint})`
  if (status === 401) return workError({ kind: 'auth', status, message: `${host} 가 토큰을 거부했습니다 ${suffix}. 토큰이 만료됐거나 폐기됐습니다.` })
  if (status === 403) return workError({ kind: 'forbidden', status, message: `연결은 됐지만 이 작업을 할 권한이 없습니다 ${suffix}. 토큰 범위(scope)를 확인하세요.` })
  if (status >= 500) return workError({ kind: 'network', status, message: `${host} 서버 오류 ${suffix}. 잠시 후 다시 시도하세요.` })
  if (status === 408 || status === 429) return workError({ kind: 'network', status, message: `${host} 가 지금 요청을 받지 않습니다 ${suffix}.` })
  return workError({ kind: 'rejected', status, message: `${host} 가 요청을 거절했습니다 ${suffix}.` })
}

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

function errorCode(error: unknown): string | null {
  if (!isRecord(error) && !(error instanceof Error)) return null
  const own = Reflect.get(error, 'code')
  if (typeof own === 'string') return own
  const cause = Reflect.get(error, 'cause')
  return cause === undefined || cause === error ? null : errorCode(cause)
}

function errorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null
}

/** 연결을 맺기 전에 실패했나 — 요청이 출처에 닿지 않았다(DNS·연결 거부·연결 시간 초과). 그 밖의 끊김·시간 초과는 닿았을 수 있다(LIFE-604 R1-A). */
const PRE_CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

export function failedBeforeConnect(error: unknown): boolean {
  const code = errorCode(error)
  return code !== null && PRE_CONNECT_CODES.has(code)
}

/** `fetch` 가 던진 것 — 시간 초과·DNS·연결 거부·끊김은 네트워크. 모르는 것도 네트워크 갈래지만 코드를 그대로 적는다. */
export function classifyThrown({ error, host, timeoutMs }: { error: unknown; host: string; timeoutMs: number }): WorkError {
  const name = errorName(error)
  if (name === 'TimeoutError' || name === 'AbortError') {
    return workError({ kind: 'network', message: `${host} 에 닿지 않습니다 (${Math.round(timeoutMs / 1000)}초 초과).` })
  }
  const code = errorCode(error)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return workError({ kind: 'network', message: `${host} 주소를 찾지 못했습니다 (DNS ${code}). 네트워크 연결을 확인하세요.` })
  if (code !== null && NETWORK_CODES.has(code)) return workError({ kind: 'network', message: `${host} 에 닿지 않습니다 (${code}).` })
  return workError({ kind: 'network', message: `${host} 에 닿지 않습니다 (${code ?? name ?? '알 수 없는 오류'}).` })
}

/** MCP 도구 결과 `isError` — 출처가 준 `code` 가 인증·권한 낱말일 때만 그 갈래, 나머지는 거절. 원격 글은 옮기지 않는다. */
export function classifyToolError({ text }: { text: string }): WorkError {
  const parsed = safeParse(text)
  const code = remoteCode(parsed)
  const statusCode = isRecord(parsed) && typeof parsed.statusCode === 'number' && Number.isInteger(parsed.statusCode) ? parsed.statusCode : null
  if (code === 'UNAUTHORIZED' || statusCode === 401) return workError({ kind: 'auth', status: 401, message: '토큰이 거부됐습니다. 토큰이 만료됐거나 폐기됐습니다.' })
  if (code === 'FORBIDDEN' || statusCode === 403) return workError({ kind: 'forbidden', status: 403, message: '연결은 됐지만 이 작업을 할 권한이 없습니다. 토큰 범위(scope)를 확인하세요.' })
  return workError({ kind: 'rejected', status: statusCode, message: code === null ? '작업 출처가 요청을 거절했습니다.' : `작업 출처가 요청을 거절했습니다 (${code}).` })
}

/**
 * 쓰기 실패를 「닿았을 수 있음」 으로(LIFE-604 R1-A) — 출처가 답하지 않았거나(시간 초과·끊김·5xx) 답이 깨졌을 때만. 출처가 분명히 거절했거나
 * (인증·권한·거절) 보내지 않은 실패(`unsent`)는 그대로. 분류(`kind`)는 바꾸지 않는다(K2) — 문구 앞에 결과를 모른다는 말을 붙인다.
 */
export function unknownWriteOutcome({ error, unsent, prefix = '만들어졌는지 모릅니다' }: { error: WorkError; unsent: boolean; prefix?: string }): WorkError {
  if (unsent || (error.kind !== 'network' && error.kind !== 'invalid_response')) return error
  return { ...error, message: `${prefix} — ${error.message}`, maybeApplied: true }
}

/**
 * 쓰기가 출처에 **닿은 뒤** 정본을 받지 못함(LIFE-632 R5-B) — 다시 읽기 실패·응답 모양 어긋남. 쓰기는 적용됐다: 일반 실패로 돌려주면 화면이 같은 쓰기를 다시 보낸다.
 * `maybeApplied`(「다시 보내지 말고 새로 읽어라」)를 붙이고 분류는 그대로(K2). 이미 붙어 있으면 그대로. Jira `afterWrite` 와 같은 뜻.
 */
export function appliedUnread({ error, prefix }: { error: WorkError; prefix: string }): WorkError {
  if (error.maybeApplied === true) return error
  return { ...error, message: `${prefix}${error.message}`, maybeApplied: true }
}
