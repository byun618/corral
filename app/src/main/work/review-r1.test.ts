// LIFE-600 수정 r1 — 리뷰 r1(Codex) 지적의 재현을 회귀 테스트로 옮긴 것. 테스트 이름 앞 [R1-x] 가 지적 ID 다(notes.md 대응표).
// 모의 LA MCP 서버(HTTP) + 가짜 cipher. 토큰은 가짜 `life_pat_` 뿐이다.
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkSettingsState } from '../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS, type FixtureCorrupt, type FixtureEcho } from './la-mcp-fixture.js'
import { readIssueDetail, readIssueSummary, readIssueUpdated } from './la-shape.js'
import { LA_CATCH_ALL_KEY, laSourceEntry, laToolError } from './la-source.js'
import { McpHttpClient, parseSseMessages, readEnvelope, readToolResult, SseParser } from './mcp-http.js'
import { FAKE_LA_TOKEN, laFixtureHarness, workHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

async function connected(options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
  const harness = await laFixtureHarness({ timeoutMs: options.timeoutMs })
  stops.push(() => harness.fixture.stop())
  const service = options.fetchImpl === undefined
    ? harness
    : workHarness({ entries: [laSourceEntry({ url: harness.url, clientVersion: 'test', fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })] })
  const added = await service.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  return { ...service, fixture: harness.fixture, url: harness.url, connectionId: added.connection.id }
}

/** 재시작한 앱 — 같은 저장 내용, 새 금고(메모리 비움)·새 서비스. 풀기를 붙잡을 수 있다. */
function restarted(first: Awaited<ReturnType<typeof connected>>) {
  const next = workHarness({ entries: [laSourceEntry({ url: first.url, clientVersion: 'test' })] })
  next.store.data = structuredClone(first.store.data)
  let release = (): void => {}
  next.cipher.hold = new Promise<void>((resolve) => { release = resolve })
  return { next, release }
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function last(emitted: WorkSettingsState[]) {
  return emitted.at(-1)?.connections[0] ?? null
}

function runtimeHas({ service, id }: { service: object; id: string }): boolean {
  const runtime: unknown = Reflect.get(service, 'runtime')
  return runtime instanceof Map && runtime.has(id)
}

describe('[R1-A] bug 아래 task 가 목록에 있다', () => {
  it('프로젝트 목록·단건 스페이스 — 열린 bug·완료된 bug 아래 task 둘 다', async () => {
    const h = await connected()
    const list = await h.service.request({ requestId: 'l', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    if (!list.ok || list.result.op !== 'listItems') throw new Error('list')
    const ids = list.result.items.map((item) => item.id)
    expect(ids).toContain(FIXTURE_IDS.taskUnderBug)
    expect(ids).toContain(FIXTURE_IDS.taskUnderDoneBug)
    expect(list.result.items.find((item) => item.id === FIXTURE_IDS.taskUnderBug)?.parentId).toBe(FIXTURE_IDS.bug)
    const one = await h.service.request({ requestId: 'g', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.taskUnderBug } })
    expect(one).toMatchObject({ ok: true, result: { item: { spaceKey: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.bug } } })
  })

  it('미분류 — 부모 없는 bug 아래 task 도 내려간다', async () => {
    const h = await connected()
    const child = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task601)
    if (child === undefined) throw new Error('fixture')
    child.parentId = FIXTURE_IDS.orphanBug
    const list = await h.service.request({ requestId: 'u', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: LA_CATCH_ALL_KEY, cursor: null } })
    if (!list.ok || list.result.op !== 'listItems') throw new Error('list')
    expect(list.result.items.map((item) => item.id)).toContain(FIXTURE_IDS.task601)
  })
})

describe('[R1-B] LA SDK scope 부족 → forbidden', () => {
  it('정확한 꼴만 권한 부족 — 그 밖 isError 는 공통 분류(거절)', () => {
    expect(laToolError('missing scope: issue:write')).toMatchObject({ kind: 'forbidden' })
    expect(laToolError('  missing scope: issue:read\n')).toMatchObject({ kind: 'forbidden' })
    expect(laToolError('missing scope: issue:write; also token life_pat_x')).toBeNull()
    expect(laToolError('missing scope')).toBeNull()
    const wire = { content: [{ type: 'text', text: 'missing scope: issue:write' }], isError: true }
    expect(readToolResult({ value: wire, tool: 'issue_update', toolError: laToolError })).toMatchObject({ ok: false, error: { kind: 'forbidden' } })
    expect(readToolResult({ value: wire, tool: 'issue_update' })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
  })
})

describe('[R1-C] 해제·교체 뒤 늦은 요청', () => {
  it('late-write-after-remove — 풀기 대기 중 해제하면 해제 뒤 요청 0건, 클라이언트·상태가 남지 않는다', async () => {
    const h = await connected()
    const { next, release } = restarted(h)
    const pending = next.service.request({ requestId: 'w', connectionId: h.connectionId, call: { op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion: null } })
    await tick()
    expect(next.service.removeConnection({ connectionId: h.connectionId })).toEqual({ ok: true })
    const before = h.fixture.requests.length
    release()
    const out = await pending
    expect(out).toMatchObject({ ok: false, error: { kind: 'not_connected' } })
    expect(h.fixture.requests.length - before).toBe(0)
    expect(h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)?.onBoard).toBe(true)
    expect(next.store.data.connections).toHaveLength(0)
    expect(runtimeHas({ service: next.service, id: h.connectionId })).toBe(false)
  })

  it('late-decrypt-after-replace — 옛 토큰 풀기 결과가 새 토큰 상태를 auth 로 덮지 않는다', async () => {
    const h = await connected()
    const { next, release } = restarted(h)
    const old = next.service.testConnection({ connectionId: h.connectionId })
    await tick()
    const fresh = `life_pat_${randomBytes(20).toString('hex')}`
    h.fixture.tokens.set(fresh, 'write')
    next.cipher.hold = null
    // 교체의 seal 은 붙잡지 않는다 — 붙잡힌 것은 옛 풀기뿐.
    const replaced = await next.service.addConnection({ sourceId: 'la', token: fresh, replaceId: h.connectionId })
    expect(replaced.ok).toBe(true)
    h.fixture.tokens.delete(FAKE_LA_TOKEN)
    const before = h.fixture.requests.length
    release()
    expect(await old).toMatchObject({ ok: false, error: { kind: 'not_connected' } })
    expect(h.fixture.requests.length - before).toBe(0)
    expect(last(next.emitted)).toMatchObject({ status: 'ok', tokenTail: fresh.slice(-4) })
    expect(await next.service.testConnection({ connectionId: h.connectionId })).toEqual({ ok: true })
  })

  it('보내는 중 해제 — 이미 보낸 요청은 되돌리지 못하지만, 해제 뒤 새 쓰기는 나가지 않는다', async () => {
    const h = await connected()
    const todo = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task601)
    if (todo === undefined) throw new Error('fixture')
    h.fixture.fault = { kind: 'delay', ms: 80 }
    // 앞으로 = status_list·issue_get(동시) → issue_transition. 앞의 둘이 날아가는 동안 해제한다.
    const pending = h.service.request({ requestId: 'c', connectionId: h.connectionId, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: null } })
    await tick(30)
    h.service.removeConnection({ connectionId: h.connectionId })
    h.fixture.fault = null
    const out = await pending
    expect(out.ok).toBe(false)
    expect(h.fixture.requests.map((request) => request.tool)).not.toContain('issue_transition')
    expect(todo.statusId).toBe(FIXTURE_STATUS.todo)
    expect(runtimeHas({ service: h.service, id: h.connectionId })).toBe(false)
  })
})

describe('[R1-D] 교체 실패는 카드 상태를 교체 전 그대로', () => {
  it('키체인 거부(seal) — ok 는 ok 로, testing 에 멈추지 않는다 · 암호문 보존 · 다시 시도 가능', async () => {
    const h = await connected()
    const sealed = h.store.data.connections[0]?.sealed
    h.cipher.mode = 'deny-encrypt'
    const out = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: h.connectionId })
    expect(out).toMatchObject({ ok: false, error: { kind: 'keychain' } })
    expect(last(h.emitted)).toMatchObject({ status: 'ok', pending: null })
    expect(h.store.data.connections[0]?.sealed).toBe(sealed)
    h.cipher.mode = 'ok'
    expect((await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: h.connectionId })).ok).toBe(true)
  })

  it('인증 실패 상태에서 교체 테스트가 네트워크로 실패 — auth 가 ok 로 바뀌지 않는다', async () => {
    const h = await connected()
    h.fixture.tokens.delete(FAKE_LA_TOKEN)
    await h.service.testConnection({ connectionId: h.connectionId })
    expect(last(h.emitted)?.status).toBe('auth')
    h.fixture.fault = { kind: 'drop' }
    const out = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: h.connectionId })
    expect(out).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(last(h.emitted)).toMatchObject({ status: 'auth', pending: null, error: { action: 'replace_token' } })
  })

  it('파일 쓰기 실패 — 상태 복원, 암호문 보존', async () => {
    const h = await connected()
    const sealed = h.store.data.connections[0]?.sealed
    h.store.failWrites = true
    const out = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: h.connectionId })
    expect(out).toMatchObject({ ok: false, error: { kind: 'local_write' } })
    expect(last(h.emitted)).toMatchObject({ status: 'ok', pending: null })
    expect(h.store.data.connections[0]?.sealed).toBe(sealed)
  })
})

describe('[R1-E] 원격 오류 글의 토큰이 응답·상태·push 로 넘어가지 않는다', () => {
  const echoes: FixtureEcho[] = ['http-body', 'rpc-error', 'tool-error']
  for (const echo of echoes) {
    it(`${echo} — 양성 대조: 서버는 실제로 토큰을 되울렸다`, async () => {
      let echoed = 0
      const fetchImpl: typeof fetch = async (url, init) => {
        const response = await fetch(url, init)
        if ((await response.clone().text()).includes(FAKE_LA_TOKEN)) echoed += 1
        return response
      }
      const h = await connected({ fetchImpl })
      h.fixture.echo = echo
      const tested = await h.service.testConnection({ connectionId: h.connectionId })
      const asked = await h.service.request({ requestId: 'e', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
      expect(echoed).toBeGreaterThan(0)
      expect(tested.ok).toBe(false)
      for (const value of [tested, asked, h.service.settings(), h.emitted]) expect(JSON.stringify(value).includes(FAKE_LA_TOKEN)).toBe(false)
    })
  }
})

describe('[R1-F] 봉투·단건 모양을 엄격히', () => {
  const corruptions: FixtureCorrupt[] = ['isError-string', 'drop-links', 'drop-description', 'drop-onBoard', 'drop-priority', 'rpc-wrong-version', 'rpc-error-string']
  for (const corrupt of corruptions) {
    it(`${corrupt} → invalid_response`, async () => {
      const h = await connected()
      h.fixture.corrupt = corrupt
      const response = await h.service.request({ requestId: corrupt, connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
      expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    })
  }

  it('null 허용과 칸 없음을 가른다 — 목록은 openBlockers, 수정은 description, 단건은 description·links', () => {
    const row = {
      id: 'i', sequentialId: 1, displayId: 'LIFE-1', kind: 'task', title: 't', statusId: 's', statusCategoryKey: 'todo', statusLabel: '할 일',
      parentId: null, priority: null, onBoard: null, position: '1', dueAt: null, color: null, archivedAt: null, updatedAt: '2026-10-13T00:00:00.000Z',
      // LIFE-622 — LA 응답은 판(version)을 늘 싣는다. 이 시험이 보는 칸 갈래와 무관하므로 행에 더한다.
      version: '1',
    }
    expect(readIssueSummary({ ...row, openBlockers: [] }, 'x').links).toBeNull()
    expect(() => readIssueSummary(row, 'x')).toThrow()
    expect(readIssueUpdated({ ...row, description: null }, 'x').id).toBe('i')
    expect(() => readIssueUpdated(row, 'x')).toThrow()
    expect(() => readIssueDetail(row, 'x')).toThrow()
    expect(readIssueDetail({ ...row, description: null, links: [] }, 'x').description).toBeNull()
    const { priority: _priority, ...withoutPriority } = row
    void _priority
    expect(() => readIssueSummary({ ...withoutPriority, openBlockers: [] }, 'x')).toThrow()
  })

  it('JSON-RPC 봉투 — 판·result/error 배타·error 모양', () => {
    const at = { host: 'h', status: 200 }
    expect(readEnvelope({ ...at, reply: { jsonrpc: '2.0', id: 1, result: {} } }).ok).toBe(true)
    expect(readEnvelope({ ...at, reply: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } } })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    for (const reply of [
      { jsonrpc: 'broken', id: 1, result: {} },
      { id: 1, result: {} },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 1, result: {}, error: 'failed' },
      { jsonrpc: '2.0', id: 1, error: 'failed' },
      { jsonrpc: '2.0', id: 1, error: { code: '1', message: 'x' } },
    ]) expect(readEnvelope({ ...at, reply })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
  })
})

describe('[R1-H] SSE 를 받는 대로 읽는다', () => {
  it('CR 만 쓰는 줄 끝 · 조각 경계의 CR LF', () => {
    expect(parseSseMessages('data: {"id":1,\rdata: "result":1}\r\r')).toEqual([{ id: 1, result: 1 }])
    const parser = new SseParser()
    expect(parser.push('data: {"a":1}\r')).toEqual([])
    expect(parser.push('\n\r\n')).toEqual([{ a: 1 }])
    expect(parser.push('data: {"b":2}')).toEqual([])
    expect(parser.end()).toEqual([])
  })

  it('held — 결과를 쓰고 스트림을 닫지 않아도 바로 끝난다', async () => {
    const h = await connected({ timeoutMs: 2000 })
    h.fixture.holdStream = true
    const started = Date.now()
    const response = await h.service.request({ requestId: 'h', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
    expect(response.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('끝없는 스트림 — 읽는 동안 바이트 상한에서 멈춘다', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    const server = http.createServer(async (request, response) => {
      let raw = ''
      for await (const part of request) raw += String(part)
      const body: unknown = JSON.parse(raw)
      const method = typeof body === 'object' && body !== null ? Reflect.get(body, 'method') : null
      const id = typeof body === 'object' && body !== null ? Reflect.get(body, 'id') : null
      if (method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18' } }))
        return
      }
      if (method === 'notifications/initialized') { response.writeHead(202).end(); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const pump = (): void => {
        while (!response.destroyed && response.write(chunk));
        if (!response.destroyed) response.once('drain', pump)
      }
      pump()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    stops.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') throw new Error('address')
    const client = new McpHttpClient({ url: `http://127.0.0.1:${address.port}/mcp`, token: FAKE_LA_TOKEN, clientVersion: 'test', timeoutMs: 20_000 })
    const outcome = await client.callTool({ name: 'issue_list', args: {} })
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'invalid_response', message: expect.stringContaining('너무 큽니다') } })
  })
})

describe('[R1-I] 열린 수 — 부모 사슬·상한', () => {
  it('완료된 bug 아래 열린 task 도 센다', async () => {
    const h = await connected()
    const spaces = await h.service.request({ requestId: 's', connectionId: h.connectionId, call: { op: 'listSpaces' } })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    // checkpoint · task600 · task601 · 직속 · 열린 bug · bug 아래 task · 완료 bug 아래 task · 보관 checkpoint 아래 task(R2-C) = 8
    expect(spaces.result.spaces.find((space) => space.key === FIXTURE_IDS.corral)?.openCount).toBe(8)
  })

  it('목록 상한에 닿으면 수를 모른다(null) — 틀린 수를 보이지 않는다', async () => {
    const h = await connected()
    const template = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.direct)
    if (template === undefined) throw new Error('fixture')
    for (let index = 0; index < 205; index += 1) h.fixture.issues.push({ ...template, id: `extra-${index}`, sequentialId: 10_000 + index, title: `extra ${index}` })
    const spaces = await h.service.request({ requestId: 's', connectionId: h.connectionId, call: { op: 'listSpaces' } })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    for (const space of spaces.result.spaces) expect(space.openCount).toBeNull()
  })

  it('부모 사슬을 못 풀면(어느 목록에도 없는 부모) 수를 모른다(null) — 보관된 부모는 이제 풀린다(R2-C)', async () => {
    const h = await connected()
    h.fixture.issues = h.fixture.issues.filter((issue) => issue.id !== FIXTURE_IDS.checkpoint)
    const spaces = await h.service.request({ requestId: 's', connectionId: h.connectionId, call: { op: 'listSpaces' } })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    expect(spaces.result.spaces.find((space) => space.key === FIXTURE_IDS.corral)?.openCount).toBeNull()
  })
})
