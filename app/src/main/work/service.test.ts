// LIFE-600 — 연결 흐름(C8 빠른 층) · 오류 분류 5종(C5) · 자격(C6) · 응답 검증(C3) 단위. 모의 LA MCP 서버 + 가짜 cipher.
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkSettingsState } from '../../shared/work.js'
import { classifyHttpStatus, classifyThrown, classifyToolError } from './errors.js'
import { FIXTURE_IDS, type FixtureCorrupt } from './la-mcp-fixture.js'
import { LA_CATCH_ALL_KEY, laSourceEntry } from './la-source.js'
import { parseSseMessages } from './mcp-http.js'
import { FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN, laFixtureHarness, workHarness, type FakeCipherMode } from './test-kit.js'

const harnesses: { fixture: { stop: () => Promise<void> } }[] = []
async function open(options: { timeoutMs?: number } = {}) {
  const harness = await laFixtureHarness(options)
  harnesses.push(harness)
  return harness
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.fixture.stop()
})

async function connected(options: { timeoutMs?: number } = {}) {
  const harness = await open(options)
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  return { ...harness, connectionId: added.connection.id }
}

/** 상태 push·응답 어디에도 토큰 원문이 없어야 한다. */
function expectNoToken(value: unknown): void {
  const text = JSON.stringify(value)
  expect(text.includes(FAKE_LA_TOKEN)).toBe(false)
  expect(text.includes(FAKE_LA_READ_TOKEN)).toBe(false)
}

function lastConnection(emitted: WorkSettingsState[]) {
  const state = emitted.at(-1)
  return state?.connections[0] ?? null
}

describe('오류 분류 (C5) — 추측하지 않는다', () => {
  it('401 인증 · 403 권한 · 5xx 네트워크 · 그 밖 4xx 거절', () => {
    expect(classifyHttpStatus({ status: 401, body: '{"code":"UNAUTHORIZED"}', host: 'h' }).kind).toBe('auth')
    expect(classifyHttpStatus({ status: 403, body: '{"code":"FORBIDDEN"}', host: 'h' }).kind).toBe('forbidden')
    // 500 INTERNAL_ERROR 를 인증 실패로 읽지 않는다.
    expect(classifyHttpStatus({ status: 500, body: '{"code":"INTERNAL_ERROR","message":"잠시 후 다시 시도해주세요"}', host: 'h' }).kind).toBe('network')
    expect(classifyHttpStatus({ status: 503, body: '', host: 'h' }).kind).toBe('network')
    expect(classifyHttpStatus({ status: 404, body: '', host: 'h' }).kind).toBe('rejected')
  })

  it('던져진 예외 — 시간 초과·DNS·연결 거부는 네트워크', () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    expect(classifyThrown({ error: timeout, host: 'h', timeoutMs: 15_000 })).toMatchObject({ kind: 'network', message: expect.stringContaining('15초') })
    const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
    expect(classifyThrown({ error: dns, host: 'h', timeoutMs: 1 })).toMatchObject({ kind: 'network', message: expect.stringContaining('DNS') })
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    expect(classifyThrown({ error: refused, host: 'h', timeoutMs: 1 })).toMatchObject({ kind: 'network', message: expect.stringContaining('ECONNREFUSED') })
  })

  it('도구 isError — 코드가 인증·권한일 때만 그 갈래', () => {
    expect(classifyToolError({ text: '{"code":"UNAUTHORIZED","message":"x"}' }).kind).toBe('auth')
    expect(classifyToolError({ text: '{"code":"FORBIDDEN","message":"x"}' }).kind).toBe('forbidden')
    expect(classifyToolError({ text: '{"code":"CONFLICT","message":"이미 연결됨"}' }).kind).toBe('rejected')
    expect(classifyToolError({ text: 'plain words 403' }).kind).toBe('rejected')
  })

  it('SSE 본문 파싱 — data 줄을 모은다', () => {
    expect(parseSseMessages('event: message\ndata: {"a":1}\n\nevent: message\ndata: {"b":\ndata: 2}\n\n')).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('연결 추가 (C8) — 테스트 통과 뒤에만 저장', () => {
  it('life_pat_ 가 아닌 토큰은 보내기 전에 거절 — 요청 0건, 저장 0', async () => {
    const harness = await open()
    for (const token of ['garbage', '', '  ', 'life_pat_ has space']) {
      const result = await harness.service.addConnection({ sourceId: 'la', token, replaceId: null })
      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    }
    expect(harness.fixture.requests).toHaveLength(0)
    expect(harness.store.writes).toBe(0)
    expect(harness.cipher.encrypts).toBe(0)
  })

  it('인증 실패면 저장 0 — 키체인에도 안 넣는다', async () => {
    const harness = await open()
    const result = await harness.service.addConnection({ sourceId: 'la', token: 'life_pat_unknown00000000000000000000000000000000000', replaceId: null })
    expect(result).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } })
    expect(harness.store.writes).toBe(0)
    expect(harness.cipher.encrypts).toBe(0)
    expect(harness.service.settings().connections).toHaveLength(0)
  })

  it('키체인에 못 넣으면(가용 아님·거부) 저장 0, 평문 폴백 없음', async () => {
    const modes: FakeCipherMode[] = ['unavailable', 'deny-encrypt']
    for (const mode of modes) {
      const harness = await open()
      harness.cipher.mode = mode
      const result = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
      expect(result).toMatchObject({ ok: false, error: { kind: 'keychain' } })
      expect(harness.store.writes).toBe(0)
      expectNoToken(harness.store.data)
    }
  })

  it('파일 쓰기 실패면 저장 0 — 연결로 보이지 않는다', async () => {
    const harness = await open()
    harness.store.failWrites = true
    const result = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    expect(result).toMatchObject({ ok: false, error: { kind: 'local_write' } })
    expect(harness.service.settings().connections).toHaveLength(0)
  })

  it('성공 — 암호문만 저장, 화면에는 끝 4자, 스페이스 = 열린 프로젝트 + 미분류', async () => {
    const harness = await connected()
    const stored = harness.store.data.connections[0]
    expect(stored?.sealed.length).toBeGreaterThan(0)
    expect(stored?.tokenTail).toBe(FAKE_LA_TOKEN.slice(-4))
    expectNoToken(harness.store.data)
    expectNoToken(harness.emitted)
    expectNoToken(harness.service.settings())
    const summary = harness.service.settings().connections[0]
    expect(summary).toMatchObject({ status: 'ok', tokenTail: FAKE_LA_TOKEN.slice(-4), name: 'LA', mono: 'LA' })
    expect(summary?.spaces?.map((space) => space.key)).toEqual([FIXTURE_IDS.corral, FIXTURE_IDS.lifeAssistant, LA_CATCH_ALL_KEY])
    expect(summary?.spaces?.find((space) => space.key === FIXTURE_IDS.corral)?.openCount).toBe(7)
  })

  it('프로젝트 직속 작업은 parentId null, 보관·프로젝트 자신은 목록에 없다', async () => {
    const harness = await connected()
    const response = await harness.service.request({ requestId: 'r', connectionId: harness.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    if (!response.ok || response.result.op !== 'listItems') throw new Error('list')
    const byId = new Map(response.result.items.map((item) => [item.id, item]))
    expect(byId.get(FIXTURE_IDS.direct)?.parentId).toBeNull()
    expect(byId.get(FIXTURE_IDS.checkpoint)?.parentId).toBeNull()
    expect(byId.get(FIXTURE_IDS.task600)?.parentId).toBe(FIXTURE_IDS.checkpoint)
    expect(byId.has(FIXTURE_IDS.archived)).toBe(false)
    expect(byId.has(FIXTURE_IDS.corral)).toBe(false)
    const orphan = await harness.service.request({ requestId: 'r2', connectionId: harness.connectionId, call: { op: 'listItems', spaceKey: LA_CATCH_ALL_KEY, cursor: null } })
    if (!orphan.ok || orphan.result.op !== 'listItems') throw new Error('orphan')
    expect(orphan.result.items.map((item) => item.key)).toEqual(['LIFE-385'])
    const single = await harness.service.request({ requestId: 'r3', connectionId: harness.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
    expect(single).toMatchObject({ ok: true, result: { item: { spaceKey: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.checkpoint, body: '본문 600' } } })
  })

  it('상태 앞 = issue_transition · 뒤 = issue_update (D6)', async () => {
    const harness = await connected()
    const statuses = await harness.service.request({ requestId: 's', connectionId: harness.connectionId, call: { op: 'listStatuses', spaceKey: FIXTURE_IDS.corral } })
    if (!statuses.ok || statuses.result.op !== 'listStatuses') throw new Error('statuses')
    const done = statuses.result.statuses.find((status) => status.category === 'done')
    const todo = statuses.result.statuses.find((status) => status.category === 'todo')
    if (done === undefined || todo === undefined) throw new Error('status')
    harness.fixture.requests.length = 0
    await harness.service.request({ requestId: 'f', connectionId: harness.connectionId, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: done.key, ifVersion: null } })
    expect(harness.fixture.requests.map((request) => request.tool)).toContain('issue_transition')
    expect(harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)?.resolution).toBe('completed')
    harness.fixture.requests.length = 0
    await harness.service.request({ requestId: 'b', connectionId: harness.connectionId, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: todo.key, ifVersion: null } })
    const tools = harness.fixture.requests.map((request) => request.tool)
    expect(tools).toContain('issue_update')
    expect(tools).not.toContain('issue_transition')
    expect(harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)).toMatchObject({ statusId: todo.key, resolution: null })
  })
})

describe('연결 상태 — 오류 5종 실측 (C5 빠른 층)', () => {
  it('401 → 인증 실패, 토큰 다시 붙여넣기 · 그 뒤 일반 요청은 보내지 않는다(연결 테스트만 다시 보낸다)', async () => {
    const harness = await connected()
    harness.fixture.tokens.delete(FAKE_LA_TOKEN)
    const response = await harness.service.request({ requestId: 'a', connectionId: harness.connectionId, call: { op: 'listSpaces' } })
    expect(response).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(lastConnection(harness.emitted)).toMatchObject({ status: 'auth', error: { action: 'replace_token' } })
    expect(harness.store.data.connections).toHaveLength(1)
    // R1-K — 인증 실패 상태의 일반 요청은 출처에 닿지 않는다.
    const before = harness.fixture.requests.length
    const again = await harness.service.request({ requestId: 'b', connectionId: harness.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
    expect(again).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(harness.fixture.requests.length - before).toBe(0)
    // 사용자가 누른 연결 테스트는 다시 보낸다.
    await harness.service.testConnection({ connectionId: harness.connectionId })
    expect(harness.fixture.requests.length - before).toBeGreaterThan(0)
    expect(lastConnection(harness.emitted)?.status).toBe('auth')
  })

  it('scope 부족(LA SDK 꼴: 200 · isError · missing scope) → 권한 부족, 연결 유지(읽기는 계속 된다)', async () => {
    const harness = await open()
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_READ_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const write = await harness.service.request({ requestId: 'w', connectionId: added.connection.id, call: { op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion: null } })
    expect(write).toMatchObject({ ok: false, error: { kind: 'forbidden', status: null, message: expect.stringContaining('issue:write') } })
    expect(lastConnection(harness.emitted)).toMatchObject({ status: 'forbidden', error: { action: null } })
    const read = await harness.service.request({ requestId: 'r', connectionId: added.connection.id, call: { op: 'listSpaces' } })
    expect(read.ok).toBe(true)
    expect(lastConnection(harness.emitted)?.status).toBe('ok')
  })

  it('403(HTTP 꼴) → 권한 부족, 연결 유지(읽기는 계속 된다)', async () => {
    const harness = await open()
    harness.fixture.scopeStyle = 'http'
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_READ_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const write = await harness.service.request({ requestId: 'w', connectionId: added.connection.id, call: { op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion: null } })
    expect(write).toMatchObject({ ok: false, error: { kind: 'forbidden', status: 403 } })
    expect(lastConnection(harness.emitted)).toMatchObject({ status: 'forbidden', error: { action: null } })
    const read = await harness.service.request({ requestId: 'r', connectionId: added.connection.id, call: { op: 'listSpaces' } })
    expect(read.ok).toBe(true)
    expect(lastConnection(harness.emitted)?.status).toBe('ok')
  })

  it('500 INTERNAL_ERROR → 네트워크(서버 오류), 인증 실패가 아니다', async () => {
    const harness = await connected()
    harness.fixture.fault = { kind: 'http', status: 500, body: '{"code":"INTERNAL_ERROR","message":"잠시 후 다시 시도해주세요"}' }
    const response = await harness.service.request({ requestId: 'n', connectionId: harness.connectionId, call: { op: 'listSpaces' } })
    expect(response).toMatchObject({ ok: false, error: { kind: 'network', status: 500 } })
    expect(lastConnection(harness.emitted)).toMatchObject({ status: 'offline', error: { action: 'retry' } })
  })

  it('소켓 끊김·시간 초과 → 네트워크', async () => {
    const dropped = await connected()
    dropped.fixture.fault = { kind: 'drop' }
    expect(await dropped.service.request({ requestId: 'd', connectionId: dropped.connectionId, call: { op: 'listSpaces' } })).toMatchObject({ ok: false, error: { kind: 'network' } })
    const slow = await connected({ timeoutMs: 100 })
    slow.fixture.fault = { kind: 'delay', ms: 400 }
    expect(await slow.service.request({ requestId: 't', connectionId: slow.connectionId, call: { op: 'listSpaces' } })).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(lastConnection(slow.emitted)?.status).toBe('offline')
  })

  it('닿지 않는 주소(연결 거부) → 네트워크', async () => {
    const harness = await open()
    await harness.fixture.stop()
    const result = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    expect(result).toMatchObject({ ok: false, error: { kind: 'network' } })
  })
})

describe('응답 검증 (C3) — 어긋나면 분류된 오류', () => {
  it('필드 누락 · 타입 어긋남 · 도구 isError', async () => {
    const harness = await connected()
    const corruptions: FixtureCorrupt[] = ['drop-statusLabel', 'issue-statusId', 'tool-error']
    for (const corrupt of corruptions) {
      harness.fixture.corrupt = corrupt
      const response = await harness.service.request({ requestId: corrupt, connectionId: harness.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
      expect(response.ok, corrupt).toBe(false)
      if (!response.ok) expect(response.error.kind).toBe(corrupt === 'tool-error' ? 'rejected' : 'invalid_response')
    }
  })

  it('모르는 MCP 프로토콜 판 → invalid_response', async () => {
    const harness = await open()
    harness.fixture.protocolVersion = '2026-07-28'
    const result = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
  })
})

describe('자격 지연 풀기 (C6) — 기동이 금고를 건드리지 않는다', () => {
  async function restarted() {
    const first = await connected()
    // 재시작: 같은 저장 내용, 새 금고·새 서비스(메모리 비움).
    const next = workHarness({ entries: [laSourceEntry({ url: first.url, clientVersion: 'test' })] })
    next.store.data = structuredClone(first.store.data)
    return { next }
  }

  it('재시작 뒤 settings() 는 풀지 않는다 — 처음 쓰일 때 한 번만 푼다', async () => {
    const { next } = await restarted()
    const summary = next.service.settings().connections[0]
    expect(summary).toMatchObject({ status: 'unchecked', spaces: null, tokenTail: FAKE_LA_TOKEN.slice(-4) })
    expect(next.cipher.decrypts).toBe(0)
    const [a, b] = await Promise.all([
      next.service.request({ requestId: '1', connectionId: summary?.id ?? '', call: { op: 'listSpaces' } }),
      next.service.request({ requestId: '2', connectionId: summary?.id ?? '', call: { op: 'listSpaces' } }),
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(next.cipher.decrypts).toBe(1)
  })

  it('푸는 동안 화면은 「키체인 대기」 를 본다', async () => {
    const { next } = await restarted()
    let release = (): void => {}
    next.cipher.hold = new Promise<void>((resolve) => { release = resolve })
    const id = next.service.settings().connections[0]?.id ?? ''
    const pending = next.service.testConnection({ connectionId: id })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(lastConnection(next.emitted)).toMatchObject({ status: 'testing', pending: 'keychain' })
    release()
    expect(await pending).toEqual({ ok: true })
    expect(lastConnection(next.emitted)).toMatchObject({ status: 'ok', pending: null })
  })

  it('키체인 거부 → keychain 오류, 암호문은 그대로 — 허용하면 같은 암호문이 다시 풀린다', async () => {
    const { next } = await restarted()
    const before = structuredClone(next.store.data)
    next.cipher.mode = 'deny-decrypt'
    const id = next.service.settings().connections[0]?.id ?? ''
    const denied = await next.service.request({ requestId: 'k', connectionId: id, call: { op: 'listSpaces' } })
    expect(denied).toMatchObject({ ok: false, error: { kind: 'keychain' } })
    expect(lastConnection(next.emitted)).toMatchObject({ status: 'keychain', error: { action: 'replace_token' } })
    expect(next.store.data).toEqual(before)
    expect(next.store.writes).toBe(0)
    next.cipher.mode = 'ok'
    const again = await next.service.request({ requestId: 'k2', connectionId: id, call: { op: 'listSpaces' } })
    expect(again.ok).toBe(true)
  })
})

describe('스페이스 켜고 끄기 · 레포 기본 · 해제 (C8)', () => {
  it('마지막 켜진 스페이스는 끌 수 없다', async () => {
    const harness = await connected()
    const id = harness.connectionId
    expect(harness.service.setSpaceHidden({ connectionId: id, spaceKey: FIXTURE_IDS.corral, hidden: true })).toEqual({ ok: true })
    expect(harness.service.setSpaceHidden({ connectionId: id, spaceKey: FIXTURE_IDS.lifeAssistant, hidden: true })).toEqual({ ok: true })
    expect(harness.service.setSpaceHidden({ connectionId: id, spaceKey: LA_CATCH_ALL_KEY, hidden: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining('마지막') } })
    expect(harness.store.data.connections[0]?.hiddenSpaceKeys).toEqual([FIXTURE_IDS.corral, FIXTURE_IDS.lifeAssistant])
    expect(harness.service.setSpaceHidden({ connectionId: id, spaceKey: FIXTURE_IDS.corral, hidden: false })).toEqual({ ok: true })
    expect(harness.service.settings().connections[0]?.spaces?.find((space) => space.key === FIXTURE_IDS.corral)?.hidden).toBe(false)
  })

  it('레포 기본 스페이스 — RepoRecord.id 로 저장, 화면에는 root 로', async () => {
    const harness = await connected()
    harness.repos.push({ id: 'repo-1', root: '/r/corral' })
    expect(harness.service.setRepoDefault({ repoRoot: '/r/corral', target: { connectionId: harness.connectionId, spaceKey: FIXTURE_IDS.corral } })).toEqual({ ok: true })
    expect(harness.store.data.repoDefaults).toEqual({ 'repo-1': { connectionId: harness.connectionId, spaceKey: FIXTURE_IDS.corral } })
    expect(harness.service.settings().repoDefaults).toEqual([{ repoRoot: '/r/corral', connectionId: harness.connectionId, spaceKey: FIXTURE_IDS.corral }])
    // 레포 경로가 바뀌어도(같은 id) 유지된다.
    harness.repos[0] = { id: 'repo-1', root: '/moved/corral' }
    expect(harness.service.settings().repoDefaults[0]?.repoRoot).toBe('/moved/corral')
    expect(harness.service.setRepoDefault({ repoRoot: '/nope', target: null })).toMatchObject({ ok: false })
    expect(harness.service.setRepoDefault({ repoRoot: '/moved/corral', target: null })).toEqual({ ok: true })
    expect(harness.store.data.repoDefaults).toEqual({})
  })

  it('해제 — 암호문·레포 기본이 지워지고 메모리 토큰도 버린다', async () => {
    const harness = await connected()
    harness.repos.push({ id: 'repo-1', root: '/r/corral' })
    harness.service.setRepoDefault({ repoRoot: '/r/corral', target: { connectionId: harness.connectionId, spaceKey: FIXTURE_IDS.corral } })
    expect(harness.service.removeConnection({ connectionId: harness.connectionId })).toEqual({ ok: true })
    expect(harness.store.data).toEqual({ connections: [], repoDefaults: {} })
    expect(harness.vault.isOpen(harness.connectionId)).toBe(false)
    expect(await harness.service.request({ requestId: 'x', connectionId: harness.connectionId, call: { op: 'listSpaces' } })).toMatchObject({ ok: false, error: { kind: 'not_connected' } })
  })

  it('토큰 교체 — 같은 연결 id, 새 끝 4자, 숨김 유지', async () => {
    const harness = await connected()
    harness.service.setSpaceHidden({ connectionId: harness.connectionId, spaceKey: FIXTURE_IDS.lifeAssistant, hidden: true })
    const replacement = 'life_pat_replace00000000000000000000000000000000wxyz'
    harness.fixture.tokens.set(replacement, 'write')
    const result = await harness.service.addConnection({ sourceId: 'la', token: replacement, replaceId: harness.connectionId })
    expect(result).toMatchObject({ ok: true, connection: { id: harness.connectionId, tokenTail: 'wxyz', hiddenSpaceKeys: [FIXTURE_IDS.lifeAssistant] } })
    expect(harness.store.data.connections).toHaveLength(1)
    expect(JSON.stringify(harness.store.data).includes(replacement)).toBe(false)
  })
})
