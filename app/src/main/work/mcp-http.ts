// MCP Streamable HTTP 클라이언트 (LIFE-600 킥오프 3) — **직접 JSON-RPC POST + SSE 파싱**. SDK(`@modelcontextprotocol/sdk`)를 쓰지 않는다:
// main 은 의존성을 외부화하므로 SDK 를 넣으면 express·hono 등 서버 쪽 패키지까지 설치본 `node_modules` 에 들어간다(00-analysis §5).
// 쓰는 와이어는 셋뿐이다 — `initialize` → `notifications/initialized` → `tools/call`. 무상태 서버(LA)는 세션 헤더 없이 동작하지만,
// 서버가 `Mcp-Session-Id` 를 주면 그대로 돌려보낸다(스펙).
//
// 응답은 `application/json` 또는 `text/event-stream`(SSE). SSE 는 본문을 다 읽고 `data:` 줄을 모아 요청 id 의 응답을 찾는다.
// 협상한 프로토콜 판이 아는 목록 밖이면 분류된 오류로 멈춘다(위험 ⑦ — 2026-07-28 개정은 `initialize`·세션을 뺀다).
//
// 토큰은 이 객체 안에만 있다 — 로그·오류 문구에 싣지 않는다.

import { isRecord, safeParse } from '../../shared/json.js'
import type { WorkError } from '../../shared/work.js'
import { classifyHttpStatus, classifyThrown, classifyToolError, workError } from './errors.js'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26'])
const MAX_BODY_BYTES = 16 * 1024 * 1024

export type McpOutcome = { ok: true; value: unknown } | { ok: false; error: WorkError }

export type McpHttpOptions = {
  url: string
  token: string
  clientVersion: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** SSE 본문에서 `data:` 이벤트들을 JSON 으로. 여러 줄 data 는 줄바꿈으로 잇는다(SSE 규칙). */
export function parseSseMessages(body: string): unknown[] {
  const messages: unknown[] = []
  for (const block of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
    if (data.length === 0) continue
    const parsed = safeParse(data.join('\n'))
    if (parsed !== null) messages.push(parsed)
  }
  return messages
}

export class McpHttpClient {
  private readonly url: string
  private readonly host: string
  private readonly token: string
  private readonly clientVersion: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private nextId = 1
  private sessionId: string | null = null
  private negotiated: string | null = null
  private initializing: Promise<McpOutcome> | null = null

  constructor(options: McpHttpOptions) {
    this.url = options.url
    this.host = safeHost(options.url)
    this.token = options.token
    this.clientVersion = options.clientVersion
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** 협상된 프로토콜 판 — 아직 안 했으면 null. 원자료·로그용. */
  protocolVersion(): string | null {
    return this.negotiated
  }

  /** 도구 하나를 부르고 결과 JSON 을 돌려준다. `isError` 는 분류된 오류가 된다(C3). */
  async callTool({ name, args }: { name: string; args: Record<string, unknown> }): Promise<McpOutcome> {
    const ready = await this.ensureInitialized()
    if (!ready.ok) return ready
    const response = await this.rpc({ method: 'tools/call', params: { name, arguments: args } })
    if (!response.ok) return response
    return readToolResult({ value: response.value, tool: name })
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
      return { ok: false, error: workError({ kind: 'invalid_response', message: `${this.host} 가 모르는 MCP 프로토콜 판을 돌려줬습니다 (${String(version).slice(0, 40)}).` }) }
    }
    this.negotiated = version
    const notified = await this.post({ body: { jsonrpc: '2.0', method: 'notifications/initialized' }, expectReply: false, id: null })
    if (!notified.ok) {
      this.negotiated = null
      return notified
    }
    return { ok: true, value: null }
  }

  private async rpc({ method, params }: { method: string; params: Record<string, unknown> }): Promise<McpOutcome> {
    const id = this.nextId
    this.nextId += 1
    return this.post({ body: { jsonrpc: '2.0', id, method, params }, expectReply: true, id })
  }

  private async post({ body, expectReply, id }: { body: Record<string, unknown>; expectReply: boolean; id: number | null }): Promise<McpOutcome> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    }
    if (this.negotiated !== null) headers['mcp-protocol-version'] = this.negotiated
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId
    let response: Response
    let text: string
    try {
      response = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) })
      text = await readBody(response)
    } catch (error) {
      return { ok: false, error: classifyThrown({ error, host: this.host, timeoutMs: this.timeoutMs }) }
    }
    const session = response.headers.get('mcp-session-id')
    if (session !== null && session.length > 0) this.sessionId = session
    if (!response.ok) return { ok: false, error: classifyHttpStatus({ status: response.status, body: text, host: this.host }) }
    if (!expectReply) return { ok: true, value: null }
    const contentType = response.headers.get('content-type') ?? ''
    const messages = contentType.includes('text/event-stream') ? parseSseMessages(text) : [safeParse(text)]
    const reply = messages.find((message) => isRecord(message) && message.id === id)
    if (!isRecord(reply)) {
      return { ok: false, error: workError({ kind: 'invalid_response', status: response.status, message: `${this.host} 응답에 요청 ${id} 의 JSON-RPC 결과가 없습니다.` }) }
    }
    if (isRecord(reply.error)) {
      const message = typeof reply.error.message === 'string' ? reply.error.message.slice(0, 200) : 'JSON-RPC 오류'
      return { ok: false, error: workError({ kind: 'rejected', status: response.status, message: `${this.host}: ${message}` }) }
    }
    return { ok: true, value: reply.result }
  }
}

async function readBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) throw new Error(`응답이 너무 큽니다 (${declared} bytes)`)
  const text = await response.text()
  if (text.length > MAX_BODY_BYTES) throw new Error(`응답이 너무 큽니다 (${text.length} chars)`)
  return text
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}

/** `tools/call` 결과 → 도구가 준 JSON. `structuredContent` 가 있으면 그것, 없으면 첫 text 조각을 JSON 으로. */
export function readToolResult({ value, tool }: { value: unknown; tool: string }): McpOutcome {
  if (!isRecord(value)) return { ok: false, error: workError({ kind: 'invalid_response', message: `${tool}: 도구 결과가 객체가 아닙니다.` }) }
  const content = Array.isArray(value.content) ? value.content : []
  const text = content.flatMap((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n')
  if (value.isError === true) return { ok: false, error: classifyToolError({ text }) }
  if (value.structuredContent !== undefined) return { ok: true, value: value.structuredContent }
  if (text === '') return { ok: false, error: workError({ kind: 'invalid_response', message: `${tool}: 도구 결과에 내용이 없습니다.` }) }
  const parsed = safeParse(text)
  if (parsed === null) return { ok: false, error: workError({ kind: 'invalid_response', message: `${tool}: 도구 결과가 JSON 이 아닙니다.` }) }
  return { ok: true, value: parsed }
}
