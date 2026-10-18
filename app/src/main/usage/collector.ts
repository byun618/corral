// 사용량 수집기 계약 (LIFE-636 E2) — provider 하나 = 이 계약을 따르는 모듈 하나 + `registry.ts` 등록 한 줄.
//
// 수집기는 바깥 세계를 **이 파일의 deps 로만** 만진다. deps 에는 읽기 연산만 있다 — 파일 읽기·키체인 읽기·HTTP GET.
// 쓰기 연산이 계약에 없으니 수집기가 자격 증명에 쓰거나 토큰을 갱신할 길이 구조적으로 없다(E6ⓐ, 00-analysis D3).
// 시험은 deps 를 대역으로 갈아 호출을 기록하고, 실제 회차(E11)는 실제 deps 에 계측을 씌운다.
//
// 토큰은 수집기 안에서만 산다 — 결과(`FetchOutcome`)·오류 문구에 싣지 않는다(E6ⓑ). 오류 문구는 여기 고정 문구로만 만든다
// (응답 본문·예외 메시지를 옮기지 않는다 — 어떤 서버가 본문에 요청 헤더를 되비춰도 새지 않게).
import { isRecord, safeParse } from '../../shared/json.js'
import type { UsageError, UsageWindow } from '../../shared/usage.js'

export type HttpResponse = { status: number; header: (name: string) => string | null; text: () => Promise<string> }
export type HttpGet = (request: { url: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<HttpResponse>
export type FileReadResult = { kind: 'found'; text: string } | { kind: 'missing' } | { kind: 'error' }
export type KeychainReadResult = { kind: 'found'; secret: string } | { kind: 'missing' } | { kind: 'error' }

export type CollectorDeps = {
  httpGet: HttpGet
  readFile: (file: string) => Promise<FileReadResult>
  /** macOS 키체인 generic password 읽기(`security find-generic-password … -w`). macOS 가 아니면 부르지 않는다. */
  readKeychain: (query: { service: string; account: string }) => Promise<KeychainReadResult>
  env: Readonly<Record<string, string | undefined>>
  homedir: string
  platform: string
  now: () => number
  /** corral 자기 이름 — provider CLI 로 위장하지 않는다(D10). */
  userAgent: string
  /** 서비스의 10초 타임아웃·끄기 취소. */
  signal: AbortSignal
}

/** 수집 한 번의 결과 — 서비스가 이것을 `ProviderUsage` 로 바꾼다(직전 값 유지·stale 정책은 서비스 몫). */
export type FetchOutcome =
  | { kind: 'ok'; windows: UsageWindow[] }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; error: UsageError; retryAfterMs: number | null }

export type UsageCollector = {
  id: string
  name: string
  fetch: (deps: CollectorDeps) => Promise<FetchOutcome>
}

export function failure(input: { error: UsageError; retryAfterMs?: number | null }): FetchOutcome {
  return { kind: 'error', error: input.error, retryAfterMs: input.retryAfterMs ?? null }
}

export const PARSE_ERROR: UsageError = { kind: 'parse', message: '응답 형태를 읽지 못함 — 사용량 API 가 바뀌었을 수 있습니다' }

/** `Retry-After` — 초 또는 HTTP 날짜. 24시간 상한(Orca `claude-oauth-usage-error.ts`). 못 읽으면 null. */
const RETRY_AFTER_CAP_MS = 24 * 60 * 60 * 1000
export function parseRetryAfter({ value, now }: { value: string | null; now: number }): number | null {
  if (value === null || value.trim() === '') return null
  const seconds = Number(value.trim())
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.min(ms, RETRY_AFTER_CAP_MS)
}

function minutesLabel(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return minutes >= 60 ? `${Math.ceil(minutes / 60)}시간` : `${minutes}분`
}

/**
 * GET 하나 → JSON 값 또는 분류된 오류(E3ⓓ). 상태 코드별 문구는 고정이다.
 * 401 = 만료(「<cli> 실행 시 갱신」) · 403 = 권한(본문이 scope 를 말하면 다시 로그인) · 429 = 요청 제한(Retry-After) · 5xx = 서버 · 예외 = 네트워크/타임아웃 · JSON 아님 = parse.
 */
export async function getJson(input: { deps: CollectorDeps; url: string; headers: Record<string, string>; cli: string }): Promise<{ kind: 'json'; value: unknown } | Extract<FetchOutcome, { kind: 'error' }>> {
  const { deps, cli } = input
  let response: HttpResponse
  try {
    response = await deps.httpGet({ url: input.url, headers: { Accept: 'application/json', 'User-Agent': deps.userAgent, ...input.headers }, signal: deps.signal })
  } catch {
    return deps.signal.aborted
      ? { kind: 'error', error: { kind: 'timeout', message: '응답이 늦음 — 시간 초과' }, retryAfterMs: null }
      : { kind: 'error', error: { kind: 'network', message: '네트워크 오류 — 연결하지 못함' }, retryAfterMs: null }
  }
  const status = response.status
  if (status === 401) return { kind: 'error', error: { kind: 'expired', message: `로그인 만료 — ${cli} 실행 시 갱신` }, retryAfterMs: null }
  if (status === 403) {
    const body = await response.text().catch(() => '')
    const scope = /scope|user:profile/i.test(body)
    return { kind: 'error', error: { kind: 'forbidden', message: scope ? `권한 범위 부족 — ${cli} 에 다시 로그인` : `권한 없음 (HTTP 403) — ${cli} 실행 시 갱신` }, retryAfterMs: null }
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter({ value: response.header('retry-after'), now: deps.now() })
    const wait = retryAfterMs === null ? '' : ` — ${minutesLabel(retryAfterMs)} 뒤 다시`
    return { kind: 'error', error: { kind: 'rate_limited', message: `요청 제한 (HTTP 429)${wait}` }, retryAfterMs }
  }
  if (status >= 500) return { kind: 'error', error: { kind: 'server', message: `서버 오류 (HTTP ${status})` }, retryAfterMs: null }
  if (status < 200 || status >= 300) return { kind: 'error', error: { kind: 'http', message: `요청 실패 (HTTP ${status})` }, retryAfterMs: null }
  let text: string
  try {
    text = await response.text()
  } catch {
    return deps.signal.aborted
      ? { kind: 'error', error: { kind: 'timeout', message: '응답이 늦음 — 시간 초과' }, retryAfterMs: null }
      : { kind: 'error', error: { kind: 'network', message: '네트워크 오류 — 응답을 끝까지 받지 못함' }, retryAfterMs: null }
  }
  const value = safeParse(text)
  if (value === null) return { kind: 'error', error: PARSE_ERROR, retryAfterMs: null }
  return { kind: 'json', value }
}

/** JSON 파일 읽기 — 없음·손상·읽기 오류를 가른다. */
export async function readJsonFile({ deps, file }: { deps: CollectorDeps; file: string }): Promise<{ kind: 'found'; value: unknown } | { kind: 'missing' } | { kind: 'error' }> {
  const read = await deps.readFile(file)
  switch (read.kind) {
    case 'missing':
    case 'error':
      return read
    case 'found': {
      const value = safeParse(read.text)
      return value === null ? { kind: 'error' } : { kind: 'found', value }
    }
  }
}

/** 사용률 0–100 클램프. 숫자가 아니면 null. */
export function percentOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

/** 초기화 시각 — ISO 문자열 · epoch 초 · epoch ms(1e10 초과) 모두(Orca `claude-usage-window.ts`). 못 읽으면 null. */
export function timeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e10 ? value : value * 1000
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function stringField({ record, key }: { record: unknown; key: string }): string | null {
  if (!isRecord(record)) return null
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
