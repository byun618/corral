// Jira Cloud REST 전송 (LIFE-605 C1·C2·C11) — Basic `base64(이메일:API 토큰)` 로 검증한 사이트에만 보낸다.
//
// - 보내는 곳 = 출처가 정규화한 `https://<이름>.atlassian.net` 하나(F3). 측정 실행만 `baseUrl` 을 fixture 로 바꾼다(`jira-source.ts` `jiraFixtureBaseFromEnv`).
// - **리다이렉트를 따라가지 않는다**(`redirect: 'manual'`) — 자격을 실은 요청이 다른 호스트로 가지 않게. 3xx 는 응답 모양 어긋남.
// - 시간 제한(기본 15 s) · 본문 상한(16 MiB, `mcp-http.ts` 와 같은 읽기) · 동시 요청 상한(기본 4 — 넘치면 차례를 기다린다).
// - 오류 분류(`errors.ts` 재사용): 401 = 인증(CAPTCHA 표지 `X-Seraph-LoginReason: AUTHENTICATION_DENIED` 면 「웹에서 한 번 로그인」) · 403 · 404(부르는 쪽이 정한다) ·
//   429/503 = 네트워크 + `Retry-After` · 5xx · DNS/연결 거부(보내기 전 — `unsent`). **원격 글은 문구에 넣지 않는다** — 질의 거부 사유만 부르는 쪽이 따로 꺼낸다(`errorText`).
// - **읽기만 다시 보낸다**: 429·503 이고 `Retry-After` 가 상한(5 s) 안이면 최대 2번. 쓰기는 한 번만(C11 — 시간 초과·429·5xx 모두).
// - 나가는 문구에서 이 자격(토큰·이메일·Basic 값)을 지운다. `close()` 뒤에는 보내지 않는다(`not_connected` + `unsent`).

import { isRecord, safeParse } from '../../shared/json.js'
import type { WorkError } from '../../shared/work.js'
import { classifyHttpStatus, classifyThrown, failedBeforeConnect, redactSecret, workError } from './errors.js'
import { BodyTooLarge, readCapped, readHint } from './mcp-http.js'

export type JiraHttpOptions = {
  baseUrl: string
  email: string
  token: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  maxConcurrent?: number
  /** `Retry-After` 기다리기 — 시험이 바꾼다. */
  sleep?: (ms: number) => Promise<void>
}

export type JiraMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** `unsent` = 요청이 Jira 에 닿지 않았음이 확실하다(닫힘·연결 전 실패). `status`·`body` 는 받은 응답(2xx 가 아니어도 404·400·207 은 부르는 쪽이 본다). */
export type JiraReply = { ok: true; status: number; json: unknown; headers: Headers } | { ok: false; error: WorkError; unsent: boolean; status: number | null; body: unknown; retryAfterMs: number | null }

const RETRY_AFTER_CAP_MS = 5_000
const READ_RETRIES = 2
/** 받은 응답을 그대로 부르는 쪽에 넘기는 상태 — 400(검증·JQL 거부) · 404(없음 = 인증 실패 아님) · 207(부분 실패). */
const PASS_THROUGH = new Set([400, 404, 207])

export function basicHeader({ email, token }: { email: string; token: string }): string {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`
}

export class JiraHttp {
  private readonly baseUrl: string
  private readonly host: string
  private readonly authorization: string
  private readonly secrets: string[]
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly maxConcurrent: number
  private readonly sleep: (ms: number) => Promise<void>
  private active = 0
  private readonly waiting: (() => void)[] = []
  private closed = false

  constructor(options: JiraHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.host = safeHost(this.baseUrl)
    this.authorization = basicHeader({ email: options.email, token: options.token })
    this.secrets = [this.authorization, this.authorization.slice('Basic '.length), options.token, options.email, `${options.email}:${options.token}`].filter((secret) => secret.length >= 4)
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4)
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  close(): void {
    this.closed = true
  }

  /** 이 자격의 비밀 글을 지운다 — 원격 글을 화면에 옮기는 유일한 경로(질의 거부 사유)가 쓴다. */
  redact(text: string): string {
    let out = text
    for (const secret of this.secrets) out = redactSecret({ text: out, secret })
    return out
  }

  /** `write` = 비멱등일 수 있는 쓰기 — 다시 보내지 않는다. */
  async request({ method, path, query, body, write }: { method: JiraMethod; path: string; query?: Record<string, string>; body?: unknown; write: boolean }): Promise<JiraReply> {
    for (let attempt = 0; ; attempt += 1) {
      const reply = await this.once({ method, path, query, body })
      if (reply.ok || write || attempt >= READ_RETRIES || reply.status === null || (reply.status !== 429 && reply.status !== 503)) return reply
      const wait = reply.retryAfterMs
      if (wait === null || wait > RETRY_AFTER_CAP_MS) return reply
      await this.sleep(wait)
    }
  }

  private async once({ method, path, query, body }: { method: JiraMethod; path: string; query?: Record<string, string>; body?: unknown }): Promise<JiraReply> {
    if (this.closed) return { ok: false, error: closedError(), unsent: true, status: null, body: null, retryAfterMs: null }
    await this.acquire()
    try {
      if (this.closed) return { ok: false, error: closedError(), unsent: true, status: null, body: null, retryAfterMs: null }
      const url = `${this.baseUrl}${path}${query === undefined || Object.keys(query).length === 0 ? '' : `?${new URLSearchParams(query).toString()}`}`
      const headers: Record<string, string> = { authorization: this.authorization, accept: 'application/json' }
      if (body !== undefined) headers['content-type'] = 'application/json'
      const response = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) })
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => undefined)
        return { ok: false, error: workError({ kind: 'invalid_response', status: response.status || null, message: `${this.host} 가 다른 주소로 보내려 했습니다 — 자격을 실은 요청은 따라가지 않습니다.` }), unsent: false, status: response.status || null, body: null, retryAfterMs: null }
      }
      if (response.ok && !PASS_THROUGH.has(response.status)) {
        const text = response.status === 204 ? '' : await readCapped({ response })
        if (text.trim() === '') return { ok: true, status: response.status, json: null, headers: response.headers }
        const json = safeParse(text)
        if (json === null) return { ok: false, error: workError({ kind: 'invalid_response', status: response.status, message: `${this.host} 응답이 JSON 이 아닙니다.` }), unsent: false, status: response.status, body: null, retryAfterMs: null }
        return { ok: true, status: response.status, json, headers: response.headers }
      }
      const hint = await readHint(response)
      const parsed = safeParse(hint)
      const retryAfterMs = response.status === 429 || response.status === 503 ? parseRetryAfter(response.headers.get('retry-after')) : null
      return { ok: false, error: this.clean(this.classify({ status: response.status, headers: response.headers, retryAfterMs })), unsent: false, status: response.status, body: parsed, retryAfterMs }
    } catch (error) {
      if (error instanceof BodyTooLarge) return { ok: false, error: workError({ kind: 'invalid_response', message: `${this.host} 응답이 너무 큽니다.` }), unsent: false, status: null, body: null, retryAfterMs: null }
      return { ok: false, error: this.clean(classifyThrown({ error, host: this.host, timeoutMs: this.timeoutMs })), unsent: failedBeforeConnect(error), status: null, body: null, retryAfterMs: null }
    } finally {
      this.release()
    }
  }

  private classify({ status, headers, retryAfterMs }: { status: number; headers: Headers; retryAfterMs: number | null }): WorkError {
    if (status === 401 && (headers.get('x-seraph-loginreason') ?? '').toUpperCase().includes('AUTHENTICATION_DENIED')) {
      return workError({ kind: 'auth', status, message: `${this.host} 가 로그인 확인(CAPTCHA)을 요구해 API 요청을 거부했습니다 — 브라우저로 Jira 에 한 번 로그인한 뒤 「연결 테스트」 를 누르세요.` })
    }
    if (status === 401) return workError({ kind: 'auth', status, message: `${this.host} 가 이메일·API 토큰을 거부했습니다 (401). 토큰이 만료·폐기됐거나 스코프가 있는 토큰입니다 — 스코프 없는 API 토큰을 다시 붙여넣으세요.` })
    if (status === 429 || status === 503) {
      return workError({ kind: 'network', status, message: `${this.host} 가 지금 요청을 받지 않습니다 (${status})${retryAfterMs === null ? '' : ` — ${Math.ceil(retryAfterMs / 1000)}초 뒤 다시 시도하세요`}.` })
    }
    // 원격 본문은 넘기지 않는다 — 분류는 상태 코드로만(`errors.ts`).
    return classifyHttpStatus({ status, body: '', host: this.host })
  }

  private clean(error: WorkError): WorkError {
    return { ...error, message: this.redact(error.message) }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(() => {
      this.active += 1
      resolve()
    }))
  }

  private release(): void {
    this.active -= 1
    this.waiting.shift()?.()
  }
}

/** `Retry-After` — 초(정수) 또는 HTTP 날짜. 못 읽으면 null. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  if (/^\d{1,6}$/.test(value.trim())) return Number(value.trim()) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

/**
 * Jira 오류 본문의 사람 글(질의 거부 사유) — `errorMessages[0]` 또는 `errors` 의 첫 값. 제어 글자를 빼고 한 줄로, 상한 200자.
 * 이 글은 **질의 검색의 거부 사유 하나**에만 화면으로 나간다(C2 · C5) — 부르는 쪽이 자격을 지운다.
 */
/** `redact` 를 **자르기 전에** 적용한다 — 200자 경계에 걸린 토큰 조각이 남지 않게(R1-S). */
export function errorText({ body, redact = (text) => text }: { body: unknown; redact?: (text: string) => string }): string | null {
  if (!isRecord(body)) return null
  const messages = Array.isArray(body.errorMessages) ? body.errorMessages.filter((entry): entry is string => typeof entry === 'string') : []
  const fields = isRecord(body.errors) ? Object.values(body.errors).filter((entry): entry is string => typeof entry === 'string') : []
  const first = messages[0] ?? fields[0] ?? null
  if (first === null) return null
  // eslint-disable-next-line no-control-regex
  const flat = redact(first).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length === 0 ? null : flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

function closedError(): WorkError {
  return workError({ kind: 'not_connected', message: '연결이 해제됐거나 토큰이 바뀌어 요청을 보내지 않았습니다.' })
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'Jira'
  }
}
