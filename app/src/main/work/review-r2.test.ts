// LIFE-600 수정 r2 — 리뷰 r2(Codex) 지적의 재현(raw/review/codex-r2-raw 의 드라이버)을 회귀 테스트로 옮긴 것. 테스트 이름 앞 [R2-x] 가 지적 ID 다
// (notes.md §10 대응표). 연결 동시성(R2-A·B·H)은 한 모델(service.ts 머리 주석 · notes §10)로 막고, 그 모델이 r1 시나리오
// (late-write-after-remove · late-decrypt-after-replace — review-r1.test.ts)까지 같이 막는지 이 파일과 r1 파일이 함께 본다.
// 모의 LA MCP 서버(HTTP) + 가짜 cipher. 토큰은 가짜 `life_pat_` 뿐이다.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isRecord, safeParse } from '../../shared/json.js'
import type { WorkCall } from '../../shared/work.js'
import { workError } from './errors.js'
import { FIXTURE_IDS, FIXTURE_STATUS, type FixtureCorrupt } from './la-mcp-fixture.js'
import { LA_CAPABILITIES, LA_CATCH_ALL_KEY, LA_DESCRIPTOR, laSourceEntry } from './la-source.js'
import { McpHttpClient } from './mcp-http.js'
import type { WorkSourceClient, WorkSourceEntry } from './source.js'
import { FAKE_LA_TOKEN, laFixtureHarness, workHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

async function connected(options: { fetchImpl?: typeof fetch } = {}) {
  const harness = await laFixtureHarness()
  stops.push(() => harness.fixture.stop())
  const service = options.fetchImpl === undefined
    ? harness
    : workHarness({ entries: [laSourceEntry({ url: harness.url, clientVersion: 'test', fetchImpl: options.fetchImpl })] })
  const added = await service.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  return { ...service, fixture: harness.fixture, url: harness.url, connectionId: added.connection.id }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('until: 시간 초과')
}

/** fetch 에 실린 도구 호출 — 이름·인자. */
function toolOf(init: RequestInit | undefined): { name: string | null; args: Record<string, unknown> } {
  const body = typeof init?.body === 'string' ? safeParse(init.body) : null
  const params = isRecord(body) && isRecord(body.params) ? body.params : {}
  return { name: typeof params.name === 'string' ? params.name : null, args: isRecord(params.arguments) ? params.arguments : {} }
}

function statusOf(h: { service: { settings(): { connections: { status: string }[] } } }): string | undefined {
  return h.service.settings().connections[0]?.status
}

describe('[R2-A] 동시 첫 요청 — 세대마다 클라이언트 하나', () => {
  it('concurrent-first-use-remove — 재시작 뒤 동시 첫 요청 둘이 클라이언트 하나를 나눠 쓰고, 해제하면 여러 단계 연산의 다음 단계(issue_transition)가 나가지 않는다', async () => {
    const first = await connected()
    const gate = deferred()
    let blocked = false
    let creates = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const tool = toolOf(init)
      const response = await fetch(input, init)
      if (tool.name === 'issue_get' && tool.args.id === FIXTURE_IDS.task601 && !blocked) {
        blocked = true
        await gate.promise
      }
      return response
    }
    const entry = laSourceEntry({ url: first.url, clientVersion: 'test', fetchImpl })
    const counted: WorkSourceEntry = { descriptor: entry.descriptor, create: (token) => { creates += 1; return entry.create(token) } }
    const h = workHarness({ entries: [counted] })
    h.store.data = structuredClone(first.store.data)
    const id = first.connectionId
    const moving = h.service.request({ requestId: 'move', connectionId: id, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: null } })
    const testing = h.service.testConnection({ connectionId: id })
    await until(() => blocked)
    await testing
    expect(h.service.removeConnection({ connectionId: id })).toEqual({ ok: true })
    const before = first.fixture.requests.length
    gate.resolve()
    const result = await moving
    const sent = first.fixture.requests.slice(before).map((request) => request.tool)
    expect(creates).toBe(1)
    expect(sent).not.toContain('issue_transition')
    expect(sent).toEqual([])
    expect(first.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task601)?.statusId).toBe(FIXTURE_STATUS.todo)
    expect(result).toMatchObject({ ok: false, error: { kind: 'not_connected' } })
    expect(h.store.data.connections).toHaveLength(0)
  })
})

describe('[R2-B] 늦은 성공이 인증 실패를 되살리지 않는다', () => {
  it('late-success-revives-auth — auth 이전에 시작한 요청의 늦은 성공은 상태를 ok 로 바꾸지 않고, 그 뒤 일반 요청은 보내지 않는다', async () => {
    const gate = deferred()
    let hold = false
    let held = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      const tool = toolOf(init)
      const response = await fetch(input, init)
      if (hold && tool.name === 'issue_list') {
        held += 1
        await gate.promise
      }
      return response
    }
    const h = await connected({ fetchImpl })
    hold = true
    const listing = h.service.request({ requestId: 'list', connectionId: h.connectionId, call: { op: 'listSpaces' } })
    await until(() => held === 5)
    h.fixture.tokens.delete(FAKE_LA_TOKEN)
    const rejected = await h.service.request({ requestId: 'get', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task601 } })
    expect(rejected).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(statusOf(h)).toBe('auth')
    hold = false
    gate.resolve()
    await listing
    expect(statusOf(h)).toBe('auth')
    const sentBefore = h.fixture.requests.length
    const retried = await h.service.request({ requestId: 'again', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task601 } })
    expect(retried).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(h.fixture.requests.length).toBe(sentBefore)
    // 다시 보내는 길 — 사용자가 누른 연결 테스트(새 토큰이 없으니 여전히 auth).
    const tested = await h.service.testConnection({ connectionId: h.connectionId })
    expect(tested).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(h.fixture.requests.length).toBeGreaterThan(sentBefore)
  })

  it('auth 뒤에 시작한 연결 테스트의 성공은 auth 를 푼다(토큰이 되살아난 경우)', async () => {
    const h = await connected()
    h.fixture.tokens.delete(FAKE_LA_TOKEN)
    await h.service.request({ requestId: 'get', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task601 } })
    expect(statusOf(h)).toBe('auth')
    h.fixture.tokens.set(FAKE_LA_TOKEN, 'write')
    expect(await h.service.testConnection({ connectionId: h.connectionId })).toEqual({ ok: true })
    expect(statusOf(h)).toBe('ok')
  })
})

describe('[R2-H] 토큰 교체는 자격 칸만 바꾼다', () => {
  it('replace-overwrites-space-toggle — 교체를 기다리는 동안 숨긴 스페이스가 교체 뒤에도 숨겨져 있다', async () => {
    const h = await connected()
    h.fixture.fault = { kind: 'delay', ms: 80 }
    const replacing = h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: h.connectionId })
    expect(h.service.setSpaceHidden({ connectionId: h.connectionId, spaceKey: FIXTURE_IDS.lifeAssistant, hidden: true })).toEqual({ ok: true })
    expect(h.store.data.connections[0]?.hiddenSpaceKeys).toContain(FIXTURE_IDS.lifeAssistant)
    const replaced = await replacing
    h.fixture.fault = null
    expect(replaced.ok).toBe(true)
    expect(h.store.data.connections[0]?.hiddenSpaceKeys).toContain(FIXTURE_IDS.lifeAssistant)
  })

  it('교체 중 레포 기본을 바꿔도 교체가 되돌리지 않는다', async () => {
    const harness = await laFixtureHarness()
    stops.push(() => harness.fixture.stop())
    const h = workHarness({ entries: [laSourceEntry({ url: harness.url, clientVersion: 'test' })], repos: [{ id: 'repo1', root: '/r/repo' }] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    harness.fixture.fault = { kind: 'delay', ms: 80 }
    const replacing = h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: added.connection.id })
    expect(h.service.setRepoDefault({ repoRoot: '/r/repo', target: { connectionId: added.connection.id, spaceKey: FIXTURE_IDS.corral } })).toEqual({ ok: true })
    expect((await replacing).ok).toBe(true)
    harness.fixture.fault = null
    expect(h.store.data.repoDefaults.repo1).toEqual({ connectionId: added.connection.id, spaceKey: FIXTURE_IDS.corral })
  })
})

describe('[R2-C] 보관된 부모 아래 미보관 작업', () => {
  it('씨앗 — 보관된 checkpoint 아래 task 는 프로젝트 목록에, 보관된 부모 없는 bug 아래 task 는 미분류에. 부모는 가장 가까운 미보관 조상(없으면 null)', async () => {
    const h = await connected()
    const list = await h.service.request({ requestId: 'l', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    if (!list.ok || list.result.op !== 'listItems') throw new Error('list')
    const byId = new Map(list.result.items.map((item) => [item.id, item]))
    expect(byId.get(FIXTURE_IDS.taskUnderArchived)?.parentId).toBeNull()
    expect(byId.has(FIXTURE_IDS.archivedCheckpoint)).toBe(false)
    expect(list.result.truncated).toBe(false)
    const one = await h.service.request({ requestId: 'g', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.taskUnderArchived } })
    expect(one).toMatchObject({ ok: true, result: { item: { spaceKey: FIXTURE_IDS.corral, parentId: null } } })
    const unsorted = await h.service.request({ requestId: 'u', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: LA_CATCH_ALL_KEY, cursor: null } })
    if (!unsorted.ok || unsorted.result.op !== 'listItems') throw new Error('unsorted')
    expect(unsorted.result.items.find((item) => item.id === FIXTURE_IDS.taskUnderArchivedBug)?.parentId).toBeNull()
    expect(unsorted.result.items.some((item) => item.id === FIXTURE_IDS.archivedOrphanBug)).toBe(false)
  })

  it('archived-parent-child-omitted — 실행 중에 checkpoint 를 보관해도 그 아래 task 는 남고, 열린 수도 같은 규칙으로 센다', async () => {
    const h = await connected()
    const checkpoint = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.checkpoint)
    if (checkpoint === undefined) throw new Error('fixture')
    checkpoint.archivedAt = '2026-10-13T00:00:00.000Z'
    const list = await h.service.request({ requestId: 'l', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    if (!list.ok || list.result.op !== 'listItems') throw new Error('list')
    const byId = new Map(list.result.items.map((item) => [item.id, item]))
    expect(byId.get(FIXTURE_IDS.task600)?.parentId).toBeNull()
    expect(byId.has(FIXTURE_IDS.checkpoint)).toBe(false)
    // 보관된 checkpoint 아래 완료 bug 는 미보관이라 남고, 그 아래 task 의 부모는 그 bug 다.
    expect(byId.get(FIXTURE_IDS.taskUnderDoneBug)?.parentId).toBe(FIXTURE_IDS.doneBug)
    const one = await h.service.request({ requestId: 'g', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
    expect(one).toMatchObject({ ok: true, result: { item: { spaceKey: FIXTURE_IDS.corral, parentId: null } } })
    const spaces = await h.service.request({ requestId: 's', connectionId: h.connectionId, call: { op: 'listSpaces' } })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    const open = list.result.items.filter((item) => item.category !== 'done').length
    expect(spaces.result.spaces.find((space) => space.key === FIXTURE_IDS.corral)?.openCount).toBe(open)
  })

  it('스페이스가 아닌 프로젝트(보관) 아래 미보관 작업은 미분류로 — 목록과 단건이 같은 스페이스를 말한다', async () => {
    const h = await connected()
    const project = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.lifeAssistant)
    const task = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.laTask)
    if (project === undefined || task === undefined) throw new Error('fixture')
    project.archivedAt = '2026-10-13T00:00:00.000Z'
    task.statusId = FIXTURE_STATUS.todo
    const one = await h.service.request({ requestId: 'g', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.laTask } })
    expect(one).toMatchObject({ ok: true, result: { item: { spaceKey: LA_CATCH_ALL_KEY, parentId: null } } })
    const unsorted = await h.service.request({ requestId: 'u', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: LA_CATCH_ALL_KEY, cursor: null } })
    if (!unsorted.ok || unsorted.result.op !== 'listItems') throw new Error('unsorted')
    expect(unsorted.result.items.some((item) => item.id === FIXTURE_IDS.laTask)).toBe(true)
    const spaces = await h.service.request({ requestId: 's', connectionId: h.connectionId, call: { op: 'listSpaces' } })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    expect(spaces.result.spaces.map((space) => space.key)).not.toContain(FIXTURE_IDS.lifeAssistant)
    const open = unsorted.result.items.filter((item) => item.category !== 'done').length
    expect(spaces.result.spaces.find((space) => space.key === LA_CATCH_ALL_KEY)?.openCount).toBe(open)
  })
})

describe('[R2-D] 목록 응답 계약 — 칸 없음·막힘 원소', () => {
  const corruptions: FixtureCorrupt[] = ['list-drop-position', 'list-drop-dueAt', 'list-drop-color', 'list-drop-archivedAt', 'list-drop-openBlockers', 'list-bad-blocker']
  for (const corrupt of corruptions) {
    it(`shape-gap ${corrupt} → invalid_response`, async () => {
      const h = await connected()
      h.fixture.corrupt = corrupt
      const response = await h.service.request({ requestId: corrupt, connectionId: h.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
      expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    })
  }

  it('정상 막힘 원소는 센다 — 수정 응답(links 없음)도 받는다', async () => {
    const h = await connected()
    const link = await h.service.request({ requestId: 'r', connectionId: h.connectionId, call: { op: 'addRelation', itemId: FIXTURE_IDS.task601, kind: 'is_blocked_by', otherKey: 'LIFE-600' } })
    expect(link.ok).toBe(true)
    const list = await h.service.request({ requestId: 'l', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    if (!list.ok || list.result.op !== 'listItems') throw new Error('list')
    expect(list.result.items.find((item) => item.id === FIXTURE_IDS.task601)?.openBlockerCount).toBe(1)
    const placed = await h.service.request({ requestId: 'p', connectionId: h.connectionId, call: { op: 'setPlacement', itemId: FIXTURE_IDS.task601, placement: 'backlog', ifVersion: null } })
    expect(placed).toMatchObject({ ok: true, result: { item: { placement: 'backlog' } } })
  })
})

describe('[R2-F] 오류 문구 — 원격 글을 넣지 않고, 마지막 경계에서 자격을 지운다', () => {
  it('source-error-secret-echo — 성공 응답의 displayId 에 토큰을 되울려도 source 가 만든 오류에 토큰이 없다', async () => {
    let reflect = false
    const fetchImpl: typeof fetch = async (input, init) => {
      const tool = toolOf(init)
      const response = await fetch(input, init)
      if (!reflect || tool.name !== 'issue_get') return response
      const text = await response.text()
      const message = safeParse(text.slice(text.indexOf('data: ') + 6).trim())
      if (!isRecord(message) || !isRecord(message.result) || !Array.isArray(message.result.content)) throw new Error('wire')
      const part: unknown = message.result.content[0]
      const row = isRecord(part) && typeof part.text === 'string' ? safeParse(part.text) : null
      if (!isRecord(row) || !isRecord(part)) throw new Error('wire')
      row.displayId = FAKE_LA_TOKEN
      part.text = JSON.stringify(row)
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const h = await connected({ fetchImpl })
    reflect = true
    const asItem = await h.service.request({ requestId: 'echo', connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.corral } })
    expect(asItem).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(JSON.stringify(asItem)).not.toContain(FAKE_LA_TOKEN)
    const asSpace = await h.service.request({ requestId: 'echo2', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.task600, cursor: null } })
    expect(asSpace).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(JSON.stringify(asSpace)).not.toContain(FAKE_LA_TOKEN)
    expect(JSON.stringify(h.emitted)).not.toContain(FAKE_LA_TOKEN)
  })

  it('양성 대조 — 출처가 문구에 토큰을 넣어도 IPC 응답·push·추가 실패에서 지워진다(마지막 경계 한 곳)', async () => {
    // 첫 연결 테스트만 통과하고(가짜 토큰일 때), 그 뒤 모든 오류 문구에 받은 토큰을 원문·URL 인코딩 꼴로 싣는 출처.
    const echoing = (token: string): WorkSourceClient => {
      let listed = false
      return {
      capabilities: () => LA_CAPABILITIES,
      close: () => {},
      call: async (call: WorkCall) => {
        if (call.op === 'listSpaces' && !listed && token === FAKE_LA_TOKEN) {
          listed = true
          return { ok: true, result: { op: 'listSpaces', spaces: [], capabilities: LA_CAPABILITIES } }
        }
        return { ok: false, error: workError({ kind: call.op === 'getItem' ? 'rejected' : 'network', message: `echo ${token} ${encodeURIComponent(token)}` }) }
      },
      }
    }
    const h = workHarness({ entries: [{ descriptor: LA_DESCRIPTOR, create: echoing }] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    const rejected = await h.service.request({ requestId: 'r', connectionId: added.connection.id, call: { op: 'getItem', itemId: 'x' } })
    expect(rejected).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('••••') } })
    const offline = await h.service.testConnection({ connectionId: added.connection.id })
    expect(offline).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(h.service.settings().connections[0]?.error?.message).toContain('••••')
    const failedAdd = await h.service.addConnection({ sourceId: 'la', token: 'life_pat_other1', replaceId: null })
    expect(failedAdd).toMatchObject({ ok: false, error: { message: expect.stringContaining('••••') } })
    for (const value of [rejected, offline, failedAdd, h.emitted, h.service.settings()]) {
      expect(JSON.stringify(value)).not.toContain(FAKE_LA_TOKEN)
      expect(JSON.stringify(value)).not.toContain('life_pat_other1')
    }
  })
})

describe('[R2-G] HTTP 401·403 은 상태 코드로 먼저 분류한다', () => {
  type Mode = 'held' | 'large'
  async function serve({ status, mode }: { status: number; mode: Mode }): Promise<string> {
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      const body = safeParse(Buffer.concat(chunks).toString('utf8'))
      const method = isRecord(body) ? body.method : null
      if (method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: isRecord(body) ? body.id : null, result: { protocolVersion: '2025-06-18', capabilities: {} } }))
        return
      }
      if (method === 'notifications/initialized') { response.writeHead(202).end(); return }
      if (mode === 'large') response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(16 * 1024 * 1024 + 1) })
      else response.writeHead(status, { 'content-type': 'application/json' })
      response.write('{')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    stops.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) })
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') throw new Error('address')
    return `http://127.0.0.1:${address.port}/mcp`
  }

  const cases: { status: number; mode: Mode; kind: 'auth' | 'forbidden' }[] = [
    { status: 401, mode: 'held', kind: 'auth' },
    { status: 401, mode: 'large', kind: 'auth' },
    { status: 403, mode: 'held', kind: 'forbidden' },
    { status: 403, mode: 'large', kind: 'forbidden' },
  ]
  for (const { status, mode, kind } of cases) {
    it(`${status}-${mode} — 본문 읽기가 끊기거나 커도 ${kind}`, async () => {
      const url = await serve({ status, mode })
      const client = new McpHttpClient({ url, token: FAKE_LA_TOKEN, clientVersion: 'test', timeoutMs: 180 })
      const outcome = await client.callTool({ name: 'issue_list', args: {} })
      client.close()
      expect(outcome).toMatchObject({ ok: false, error: { kind, status } })
    })
  }
})
