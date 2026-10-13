// MCP Streamable HTTP 클라이언트 (LIFE-600 킥오프 3) — **직접 JSON-RPC POST + SSE 파싱**. SDK(`@modelcontextprotocol/sdk`)를 쓰지 않는다:
// main 은 의존성을 외부화하므로 SDK 를 넣으면 express·hono 등 서버 쪽 패키지까지 설치본 `node_modules` 에 들어간다(00-analysis §5).
// 쓰는 와이어는 셋뿐이다 — `initialize` → `notifications/initialized` → `tools/call`. 무상태 서버(LA)는 세션 헤더 없이 동작하지만,
// 서버가 `Mcp-Session-Id` 를 주면 그대로 돌려보낸다(스펙).
//
// 응답은 `application/json` 또는 `text/event-stream`(SSE). SSE 는 **받는 대로** 이벤트를 읽어, 요청 id 의 응답이 오면 스트림이
// 열려 있어도 바로 끝낸다(R1-H — 결과 뒤 스트림을 닫지 않는 서버를 시간 초과로 읽지 않는다). 읽는 동안 바이트 상한을 센다.
// 응답 봉투는 JSON-RPC 2.0 모양(`jsonrpc: "2.0"` · result/error 중 하나 · error 는 code·message)을 확인한 뒤에만 쓴다(R1-F).
// 협상한 프로토콜 판이 아는 목록 밖이면 분류된 오류로 멈춘다(위험 ⑦ — 2026-07-28 개정은 `initialize`·세션을 뺀다).
//
// 토큰은 이 객체 안에만 있다 — 로그·오류 문구에 싣지 않는다. **원격이 준 글(HTTP 본문·JSON-RPC message·도구 오류 글)은 오류 문구로
// 옮기지 않는다**(R1-E) — 정해진 모양의 코드만 옮기고, 그래도 나가는 문구에서 이 객체의 토큰을 한 번 더 지운다.
// `close()` 뒤에는 아무 요청도 보내지 않는다(R1-C — 해제·교체 뒤 늦게 도는 요청이 쓰기를 보내지 않게).

import { isRecord, safeParse } from '../../shared/json.js'
import type { WorkError } from '../../shared/work.js'
import { log } from '../log.js'
import { classifyHttpStatus, classifyThrown, classifyToolError, redactSecret, workError } from './errors.js'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26'])
const MAX_BODY_BYTES = 16 * 1024 * 1024
/** HTTP 오류 본문에서 코드 힌트를 찾을 때 읽는 상한. */
const HINT_BYTES = 64 * 1024

export type McpOutcome = { ok: true; value: unknown } | { ok: false; error: WorkError }

export type McpHttpOptions = {
  url: string
  token: string
  clientVersion: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 출처별 도구 오류 해석 — 아는 모양이면 그 분류, 아니면 null(공통 분류로). 원격 글을 문구로 옮기지 않는다. */
  toolError?: (text: string) => WorkError | null
}

/**
 * SSE 파서 — 조각을 받는 대로 이벤트를 낸다(R1-H). 줄 끝은 CRLF·LF·CR 셋 다(SSE 규칙). 빈 줄이 이벤트를 끝내고,
 * 여러 줄 `data:` 는 줄바꿈으로 잇는다. 끝나지 않은 이벤트는 스트림이 끝나면 버린다(규칙).
 */
export class SseParser {
  private buffer = ''
  private data: string[] = []

  push(chunk: string): unknown[] {
    this.buffer += chunk
    return this.drain(false)
  }

  end(): unknown[] {
    return this.drain(true)
  }

  private drain(final: boolean): unknown[] {
    const out: unknown[] = []
    for (;;) {
      const at = this.buffer.search(/[\r\n]/)
      if (at < 0) break
      // CR 이 조각 끝이면 다음 조각의 LF 와 한 줄 끝일 수 있다 — 더 받는다.
      if (this.buffer[at] === '\r' && at === this.buffer.length - 1 && !final) break
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + (this.buffer[at] === '\r' && this.buffer[at + 1] === '\n' ? 2 : 1))
      if (line === '') {
        if (this.data.length > 0) {
          const parsed = safeParse(this.data.join('\n'))
          if (parsed !== null) out.push(parsed)
        }
        this.data = []
      } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''))
    }
    return out
  }
}

/** SSE 본문 통째에서 이벤트들을 JSON 으로(짧은 본문·테스트용). */
export function parseSseMessages(body: string): unknown[] {
  const parser = new SseParser()
  return [...parser.push(body), ...parser.end()]
}

class BodyTooLarge extends Error {}

export class McpHttpClient {
  private readonly url: string
  private readonly host: string
  private readonly token: string
  private readonly clientVersion: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly toolError: (text: string) => WorkError | null
  private nextId = 1
  private sessionId: string | null = null
  private negotiated: string | null = null
  private initializing: Promise<McpOutcome> | null = null
  private closed = false

  constructor(options: McpHttpOptions) {
    this.url = options.url
    this.host = safeHost(options.url)
    this.token = options.token
    this.clientVersion = options.clientVersion
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.toolError = options.toolError ?? (() => null)
  }

  /** 협상된 프로토콜 판 — 아직 안 했으면 null. 원자료·로그용. */
  protocolVersion(): string | null {
    return this.negotiated
  }

  /** 이 클라이언트를 닫는다 — 이후 요청은 보내지 않고 `not_connected`. 이미 보낸 요청은 되돌리지 못한다. */
  close(): void {
    this.closed = true
  }

  /** 도구 하나를 부르고 결과 JSON 을 돌려준다. `isError` 는 분류된 오류가 된다(C3). */
  async callTool({ name, args }: { name: string; args: Record<string, unknown> }): Promise<McpOutcome> {
    const ready = await this.ensureInitialized()
    if (!ready.ok) return ready
    const response = await this.rpc({ method: 'tools/call', params: { name, arguments: args } })
    if (!response.ok) return response
    return this.clean(readToolResult({ value: response.value, tool: name, toolError: this.toolError }))
  }

  private ensureInitialized(): Promise<McpOutcome> {
    if (this.negotiated !== null) return Promise.resolve({ ok: true, value: null })
    if (this.initializing === null) {
      this.initializing = this.initialize().then((outcome) => {
        if (!outcome.ok) this.initializing = null
        return outcome
      })
    }
    return this.initializing
  }

  private async initialize(): Promise<McpOutcome> {
    const response = await this.rpc({
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'corral', version: this.clientVersion } },
    })
    if (!response.ok) return response
    const version = isRecord(response.value) ? response.value.protocolVersion : null
    if (typeof version !== 'string' || !SUPPORTED_VERSIONS.has(version)) {
      // 판 글자는 날짜 꼴일 때만 옮긴다 — 원격 글을 문구로 옮기지 않는다.
      const shown = typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version) ? ` (${version})` : ''
      return { ok: false, error: workError({ kind: 'invalid_response', message: `${this.host} 가 모르는 MCP 프로토콜 판을 돌려줬습니다${shown}.` }) }
    }
    this.negotiated = version
    const notified = await this.post({ body: { jsonrpc: '2.0', method: 'notifications/initialized' }, id: null })
    if (!notified.ok) {
      this.negotiated = null
      return notified
    }
    // C14 — 협상된 판을 남긴다(호스트·판만, 토큰·본문 없음).
    log('work.mcp_initialized', { host: this.host, protocolVersion: version })
    return { ok: true, value: null }
  }

  private async rpc({ method, params }: { method: string; params: Record<string, unknown> }): Promise<McpOutcome> {
    const id = this.nextId
    this.nextId += 1
    return this.post({ body: { jsonrpc: '2.0', id, method, params }, id })
  }

  /** `id === null` 이면 알림 — 답을 기다리지 않는다. */
  private async post({ body, id }: { body: Record<string, unknown>; id: number | null }): Promise<McpOutcome> {
    return this.clean(await this.send({ body, id }))
  }

  private async send({ body, id }: { body: Record<string, unknown>; id: number | null }): Promise<McpOutcome> {
    if (this.closed) return { ok: false, error: closedError() }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    }
    if (this.negotiated !== null) headers['mcp-protocol-version'] = this.negotiated
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId
    try {
      const response = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) })
      const session = response.headers.get('mcp-session-id')
      if (session !== null && session.length > 0) this.sessionId = session
      // 분류는 상태 코드로 먼저 정한다(R2-G). 본문은 코드 힌트만 — 읽기가 끊기거나 크거나 늦어도 분류를 잃지 않는다.
      if (!response.ok) return { ok: false, error: classifyHttpStatus({ status: response.status, body: await readHint(response), host: this.host }) }
      if (id === null) {
        await response.body?.cancel()
        return { ok: true, value: null }
      }
      const contentType = response.headers.get('content-type') ?? ''
      const reply = contentType.includes('text/event-stream') ? await findInStream({ response, id }) : findInJson({ text: await readCapped({ response }), id })
      if (reply === null) {
        return { ok: false, error: workError({ kind: 'invalid_response', status: response.status, message: `${this.host} 응답에 요청 ${id} 의 JSON-RPC 결과가 없습니다.` }) }
      }
      return readEnvelope({ reply, host: this.host, status: response.status })
    } catch (error) {
      if (error instanceof BodyTooLarge) return { ok: false, error: workError({ kind: 'invalid_response', message: `${this.host} 응답이 너무 큽니다 (${MAX_BODY_BYTES} bytes 초과).` }) }
      return { ok: false, error: classifyThrown({ error, host: this.host, timeoutMs: this.timeoutMs }) }
    }
  }

  /** 나가는 문구에서 이 클라이언트의 토큰을 지운다 — 코드만 옮기는 분류 위의 두 번째 칸막이. */
  private clean(outcome: McpOutcome): McpOutcome {
    return outcome.ok ? outcome : { ok: false, error: { ...outcome.error, message: redactSecret({ text: outcome.error.message, secret: this.token }) } }
  }
}

function closedError(): WorkError {
  return workError({ kind: 'not_connected', message: '연결이 해제됐거나 토큰이 바뀌어 요청을 보내지 않았습니다.' })
}

/** HTTP 오류 본문 — 코드 힌트용 보조 단계. 상한(64 KiB)·끊김·시간 초과는 모두 「힌트 없음」(빈 글)이다. 던지지 않는다. */
async function readHint(response: Response): Promise<string> {
  try {
    return await readCapped({ response, limit: HINT_BYTES })
  } catch {
    return ''
  }
}

/** 본문을 상한 안에서 읽는다 — 상한을 넘으면 그 자리에서 멈춘다. */
async function readCapped({ response, limit = MAX_BODY_BYTES }: { response: Response; limit?: number }): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > limit) throw new BodyTooLarge()
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > limit) throw new BodyTooLarge()
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/** SSE 를 받는 대로 읽어 요청 id 의 응답이 오면 바로 돌려준다(스트림은 거기서 끊는다). 끝까지 없으면 null. */
async function findInStream({ response, id }: { response: Response; id: number }): Promise<Record<string, unknown> | null> {
  const body = response.body
  if (body === null) return null
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      let messages: unknown[]
      if (done) messages = [...parser.push(decoder.decode()), ...parser.end()]
      else {
        bytes += value.byteLength
        if (bytes > MAX_BODY_BYTES) throw new BodyTooLarge()
        messages = parser.push(decoder.decode(value, { stream: true }))
      }
      const reply = messages.find((message) => isRecord(message) && message.id === id)
      if (isRecord(reply)) return reply
      if (done) return null
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

function findInJson({ text, id }: { text: string; id: number }): Record<string, unknown> | null {
  const parsed = safeParse(text)
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  const reply = messages.find((message) => isRecord(message) && message.id === id)
  return isRecord(reply) ? reply : null
}

/** JSON-RPC 2.0 봉투 — `jsonrpc: "2.0"`, result·error 중 정확히 하나, error 는 숫자 code·글 message. 원격 message 는 옮기지 않는다. */
export function readEnvelope({ reply, host, status }: { reply: Record<string, unknown>; host: string; status: number | null }): McpOutcome {
  const broken = (what: string): McpOutcome => ({ ok: false, error: workError({ kind: 'invalid_response', status, message: `${host} 응답이 JSON-RPC 모양이 아닙니다 (${what}).` }) })
  if (reply.jsonrpc !== '2.0') return broken('jsonrpc')
  const hasResult = Object.hasOwn(reply, 'result')
  const hasError = Object.hasOwn(reply, 'error')
  if (hasResult === hasError) return broken('result·error')
  if (hasError) {
    const error = reply.error
    if (!isRecord(error) || typeof error.code !== 'number' || !Number.isInteger(error.code) || typeof error.message !== 'string') return broken('error')
    return { ok: false, error: workError({ kind: 'rejected', status, message: `${host} 가 요청을 거절했습니다 (JSON-RPC ${error.code}).` }) }
  }
  return { ok: true, value: reply.result }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '작업 출처'
  }
}

/** `tools/call` 결과 → 도구가 준 JSON. `structuredContent` 가 있으면 그것, 없으면 첫 text 조각을 JSON 으로. `isError` 는 불리언만 받는다. */
export function readToolResult({ value, tool, toolError = () => null }: { value: unknown; tool: string; toolError?: (text: string) => WorkError | null }): McpOutcome {
  if (!isRecord(value)) return { ok: false, error: workError({ kind: 'invalid_response', message: `${tool}: 도구 결과가 객체가 아닙니다.` }) }
  if (value.isError !== undefined && typeof value.isError !== 'boolean') return { ok: false, error: workError({ kind: 'invalid_response', message: `${tool}: 도구 결과의 isError 가 불리언이 아닙니다.` }) }
  const content = Array.isArray(value.content) ? value.content : []
  const text = content.flatMap((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n')
  if (value.isError === true) return { ok: false, error: toolError(text) ?? classifyToolError({ text }) }
  if (value.structuredContent !== undefined) return { ok: true, value: value.structuredContent }
  if (text === '') return { ok: false, error: workError({ kind: 'invalid_response', message: `${tool}: 도구 결과에 내용이 없습니다.` }) }
  const parsed = safeParse(text)
  if (parsed === null) return { ok: false, error: workError({ kind: 'invalid_response', message: `${tool}: 도구 결과가 JSON 이 아닙니다.` }) }
  return { ok: true, value: parsed }
}
