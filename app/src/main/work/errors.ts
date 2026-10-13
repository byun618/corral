// 오류 분류 (LIFE-600 C5 · K2) — HTTP 상태·던져진 예외를 `WorkError` 로. **추측하지 않는다**:
//   401 = 인증 실패 · 403 = 권한 부족 · 5xx = 서버 오류(네트워크 갈래) — 500 을 인증 실패로 읽지 않는다(00-analysis §3).
//   LA `/mcp` 는 무인증·형식 다른 토큰에 500 을 주지만, corral 은 `life_pat_` 접두사가 아닌 토큰을 보내기 전에 거절하므로
//   서버가 주는 인증 실패는 401 하나다.
// 오류 문구에 토큰을 넣지 않는다 — 응답 본문은 앞 200자만, 그것도 출처가 준 `code`·`message` 칸만 옮긴다.

import { isRecord, safeParse } from '../../shared/json.js'
import type { WorkError, WorkErrorKind } from '../../shared/work.js'

export function workError({ kind, message, status = null }: { kind: WorkErrorKind; message: string; status?: number | null }): WorkError {
  return { kind, message, status }
}

/** 본문에서 출처가 준 `code`·`message` 만 꺼낸다(본문 통째를 옮기지 않는다). */
function bodyHint(body: string): string {
  const parsed = safeParse(body)
  if (!isRecord(parsed)) return ''
  const code = typeof parsed.code === 'string' ? parsed.code.slice(0, 60) : null
  const message = typeof parsed.message === 'string' ? parsed.message.slice(0, 140) : null
  return [code, message].filter((part) => part !== null).join(' · ')
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

/** MCP 도구 결과 `isError` — 출처가 준 `code` 가 인증·권한 낱말일 때만 그 갈래, 나머지는 거절. */
export function classifyToolError({ text }: { text: string }): WorkError {
  const parsed = safeParse(text)
  const code = isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code : null
  const statusCode = isRecord(parsed) && typeof parsed.statusCode === 'number' ? parsed.statusCode : null
  const message = isRecord(parsed) && typeof parsed.message === 'string' ? parsed.message : text
  const short = message.slice(0, 200)
  if (code === 'UNAUTHORIZED' || statusCode === 401) return workError({ kind: 'auth', status: 401, message: `토큰이 거부됐습니다 — ${short}` })
  if (code === 'FORBIDDEN' || statusCode === 403) return workError({ kind: 'forbidden', status: 403, message: `이 작업을 할 권한이 없습니다 — ${short}` })
  return workError({ kind: 'rejected', status: statusCode, message: short })
}
