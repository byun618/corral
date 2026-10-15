// LIFE-604 — 만들기 계약 E10·E11 의 출처별 사정. 공통 규칙은 계약 묶음(`contract-suite.ts`)이 두 출처에 같이 돌린다.
// 여기서는: LA 칸 전달(모의 MCP 가 받은 인자 기록 — C4) · 모의 출처(Jira 형) 첫 상태·필수 필드(C3·C8) · main 의 생성 메타 검증(양성 대조) ·
// 「만들었음」 활동(C10)의 재시작 유지.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkCreateMeta, WorkErrorKind, WorkResponse } from '../../shared/work.js'
import { WorkActivityStore, readActivityRecord } from './activity-store.js'
import { FIXTURE_IDS, FIXTURE_STATUS, LaMcpFixture } from './la-mcp-fixture.js'
import { LA_CATCH_ALL_KEY, laSourceEntry } from './la-source.js'
import { MOCK_CAPABILITIES, MOCK_DESCRIPTOR, mockSourceEntry, seedMockState, type MockState } from './mock-source.js'
import type { WorkOutcome, WorkSourceEntry } from './source.js'
import { FAKE_LA_TOKEN, FAKE_MOCK_TOKEN, laFixtureHarness, workHarness, type WorkHarness } from './test-kit.js'
import { unknownWriteOutcome, workError } from './errors.js'

let seq = 0
const sender = ({ harness, connectionId }: { harness: WorkHarness; connectionId: string }) => (call: WorkCall | Record<string, unknown>): Promise<WorkResponse> =>
  harness.service.request({ requestId: `r-${++seq}`, connectionId, call })

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.()
})

async function laSetup({ timeoutMs }: { timeoutMs?: number } = {}) {
  const harness = await laFixtureHarness({ timeoutMs })
  stops.push(() => harness.fixture.stop())
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  return { harness, fixture: harness.fixture, send: sender({ harness, connectionId: added.connection.id }), connectionId: added.connection.id }
}

async function mockSetup({ token = FAKE_MOCK_TOKEN, state = seedMockState() }: { token?: string; state?: MockState } = {}) {
  const harness = workHarness({ entries: [mockSourceEntry({ state })] })
  const added = await harness.service.addConnection({ sourceId: 'mock-jira', token, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  return { harness, state, send: sender({ harness, connectionId: added.connection.id }), connectionId: added.connection.id }
}

describe('LA 칸 전달 (C4 — 모의 MCP 가 받은 인자)', () => {
  it('본문 → description · 상태 → statusId · 우선순위 → priority · 백로그 → onBoard false 명시, 재조회 값이 같다', async () => {
    const { fixture, send } = await laSetup()
    const response = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '칸 전달', body: '본문 **굵게**', statusKey: FIXTURE_STATUS.dev, priority: 'highest', placement: 'backlog' })
    expect(response.ok).toBe(true)
    expect(fixture.createArgs.at(-1)).toEqual({ kind: 'task', title: '칸 전달', parentId: FIXTURE_IDS.corral, onBoard: false, description: '본문 **굵게**', statusId: FIXTURE_STATUS.dev, priority: 'highest' })
    if (!response.ok || response.result.op !== 'createItem') throw new Error('createItem')
    const again = await send({ op: 'getItem', itemId: response.result.item.id })
    if (!again.ok || again.result.op !== 'getItem') throw new Error('getItem')
    expect(again.result.item).toMatchObject({ title: '칸 전달', body: '본문 **굵게**', statusKey: FIXTURE_STATUS.dev, priority: 'highest', placement: 'backlog', parentId: null, spaceKey: FIXTURE_IDS.corral })
  })

  it('보드 → onBoard true 명시 · 배치를 안 보낸 만들기(T3 자식 추가)도 onBoard true, 안 보낸 칸은 싣지 않는다', async () => {
    const { fixture, send } = await laSetup()
    await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '보드로', placement: 'board' })
    expect(fixture.createArgs.at(-1)).toMatchObject({ onBoard: true })
    const child = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.checkpoint, kindKey: 'task', title: '자식' })
    expect(child.ok).toBe(true)
    expect(fixture.createArgs.at(-1)).toEqual({ kind: 'task', title: '자식', parentId: FIXTURE_IDS.checkpoint, onBoard: true })
  })

  it('LA 가 받지 않는 칸(필수 필드)·완료 상태는 보내기 전에 거절 — issue_create 0건', async () => {
    const { fixture, send } = await laSetup()
    const withField = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '필드', fields: [{ key: 'customfield_impact', value: 'x' }] })
    expect(withField).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    const done = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '완료로', statusKey: FIXTURE_STATUS.done })
    expect(done).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(fixture.createArgs).toHaveLength(0)
    expect(fixture.requests.filter((request) => request.tool === 'issue_create')).toHaveLength(0)
  })

  it('생성 메타 — 열린 상태 전부(완료 제외) · 기본 = 할 일 · 필수 필드 없음', async () => {
    const { send } = await laSetup()
    const response = await send({ op: 'getCreateMeta', spaceKey: FIXTURE_IDS.corral, kindKey: 'bug' })
    expect(response).toMatchObject({ ok: true, result: { op: 'getCreateMeta', meta: { spaceKey: FIXTURE_IDS.corral, kindKey: 'bug', statusKeys: [FIXTURE_STATUS.todo, FIXTURE_STATUS.analysis, FIXTURE_STATUS.dev], defaultStatusKey: FIXTURE_STATUS.todo, fields: [] } } })
  })

  it('R4-F 「미분류」 의 Checkpoint — 메타가 만들 수 없다고 말하고(unavailable) 만들기는 보내기 전에 거절 · Task 와 프로젝트 스페이스의 Checkpoint 는 그대로(대조)', async () => {
    const { fixture, send } = await laSetup()
    const meta = await send({ op: 'getCreateMeta', spaceKey: LA_CATCH_ALL_KEY, kindKey: 'checkpoint' })
    expect(meta).toMatchObject({ ok: true, result: { op: 'getCreateMeta', meta: { kindKey: 'checkpoint', unavailable: expect.stringContaining('부모 프로젝트가 필요합니다') } } })
    const made = await send({ op: 'createItem', spaceKey: LA_CATCH_ALL_KEY, parentId: null, kindKey: 'checkpoint', title: '미분류 체크포인트' })
    expect(made).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('「미분류」 에는 Checkpoint') } })
    expect(fixture.requests.filter((request) => request.tool === 'issue_create')).toHaveLength(0)
    const task = await send({ op: 'getCreateMeta', spaceKey: LA_CATCH_ALL_KEY, kindKey: 'task' })
    expect(task.ok && task.result.op === 'getCreateMeta' ? task.result.meta.unavailable : 'x').toBeUndefined()
    const inProject = await send({ op: 'getCreateMeta', spaceKey: FIXTURE_IDS.corral, kindKey: 'checkpoint' })
    expect(inProject.ok && inProject.result.op === 'getCreateMeta' ? inProject.result.meta.unavailable : 'x').toBeUndefined()
  })

  it('양성 대조 — 모의 MCP 가 모르는 칸을 받으면 BAD_REQUEST(이름이 틀린 칸이 조용히 사라지지 않는다)', async () => {
    // 계약 밖이라 corral 이 보낼 수 없는 칸 — 출처를 거치지 않고 모의 MCP 를 직접 부른다.
    const harness = await laFixtureHarness()
    stops.push(() => harness.fixture.stop())
    const response = await fetch(harness.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${FAKE_LA_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'issue_create', arguments: { kind: 'task', title: 't', body: 'x' } } }),
    })
    const text = await response.text()
    expect(text).toContain('isError')
    expect(text).toContain('모르는 칸 body')
    expect(harness.fixture.issues.some((issue) => issue.title === 't')).toBe(false)
  })
})

/** `issue_create` 요청만 던지게 하는 fetch — 던질 오류의 코드를 고른다(연결 전 실패 대 연결 뒤 끊김). */
function failingCreateFetch(code: string): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string' && init.body.includes('"name":"issue_create"')) throw new TypeError('fetch failed', { cause: { code } })
    return fetch(input, init)
  }
}

async function laWithFetch(fetchImpl: typeof fetch) {
  const fixture = new LaMcpFixture()
  fixture.tokens.set(FAKE_LA_TOKEN, 'write')
  const url = await fixture.start()
  stops.push(() => fixture.stop())
  const harness = workHarness({ entries: [laSourceEntry({ url, clientVersion: 'test', fetchImpl })] })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  return { fixture, send: sender({ harness, connectionId: added.connection.id }) }
}

describe('LA 만들기 결과를 모를 때 (R1-A)', () => {
  const call = { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '재조회 끊김' }

  it('ⓐ issue_create 성공 뒤 재조회(issue_get)가 끊기면 실패가 아니라 만든 작업(최소 값)을 돌려준다', async () => {
    const { fixture, send } = await laSetup()
    fixture.toolFaults.set('issue_get', { kind: 'drop' })
    const response = await send({ ...call, body: '본문', priority: 'high', placement: 'backlog' })
    expect(fixture.createArgs).toHaveLength(1)
    const made = fixture.issues.find((issue) => issue.title === '재조회 끊김')
    expect(response).toMatchObject({ ok: true, result: { op: 'createItem', item: { id: made?.id, key: `LIFE-${made?.sequentialId}`, title: '재조회 끊김', body: '본문', priority: 'high', placement: 'backlog', spaceKey: FIXTURE_IDS.corral, parentId: null, openBlockerCount: 0, relations: [] } } })
  })

  it('ⓑ issue_create 가 처리된 뒤 답이 끊기면 「만들어졌을 수 있음」(maybeApplied) — 분류는 network 그대로, 다시 보내지 않는다', async () => {
    const { fixture, send } = await laSetup()
    fixture.toolFaults.set('issue_create', { kind: 'drop-after' })
    const response = await send(call)
    expect(response).toMatchObject({ ok: false, error: { kind: 'network', maybeApplied: true, message: expect.stringContaining('만들어졌는지 모릅니다') } })
    expect(fixture.createArgs).toHaveLength(1)
    expect(fixture.requests.filter((request) => request.tool === 'issue_create')).toHaveLength(1)
  })

  it('ⓑ 시간 초과(요청은 닿았다)도 「만들어졌을 수 있음」', async () => {
    const { fixture, send } = await laSetup({ timeoutMs: 200 })
    fixture.toolFaults.set('issue_create', { kind: 'delay', ms: 600 })
    const response = await send(call)
    expect(response).toMatchObject({ ok: false, error: { kind: 'network', maybeApplied: true } })
    expect(fixture.requests.filter((request) => request.tool === 'issue_create')).toHaveLength(1)
  })

  it('ⓑ 연결 뒤 끊김(ECONNRESET)은 닿았을 수 있음 · 대조 — 연결 전 실패(ECONNREFUSED·DNS)는 보통 실패(maybeApplied 없음)', async () => {
    const reset = await laWithFetch(failingCreateFetch('ECONNRESET'))
    expect(await reset.send(call)).toMatchObject({ ok: false, error: { kind: 'network', maybeApplied: true } })
    for (const code of ['ECONNREFUSED', 'ENOTFOUND']) {
      const refused = await laWithFetch(failingCreateFetch(code))
      const response = await refused.send(call)
      expect(response).toMatchObject({ ok: false, error: { kind: 'network' } })
      if (response.ok) throw new Error('ok')
      expect(response.error.maybeApplied).toBeUndefined()
      expect(response.error.message).not.toContain('만들어졌는지 모릅니다')
      expect(refused.fixture.createArgs).toHaveLength(0)
    }
  })

  it('대조 — 출처가 거절한 만들기(HTTP 403 · 도구 오류)는 maybeApplied 가 없다', async () => {
    const { fixture, send } = await laSetup()
    fixture.toolFaults.set('issue_create', { kind: 'http', status: 403, body: '{"code":"FORBIDDEN"}' })
    const forbidden = await send(call)
    expect(forbidden).toMatchObject({ ok: false, error: { kind: 'forbidden' } })
    if (forbidden.ok) throw new Error('ok')
    expect(forbidden.error.maybeApplied).toBeUndefined()
    fixture.toolFaults.clear()
    const rejected = await send({ ...call, parentId: FIXTURE_IDS.checkpoint, kindKey: 'checkpoint' })
    expect(rejected).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    if (rejected.ok) throw new Error('ok')
    expect(rejected.error.maybeApplied).toBeUndefined()
  })

  it('unknownWriteOutcome — network·invalid_response 만, unsent 면 그대로', () => {
    expect(unknownWriteOutcome({ error: workError({ kind: 'network', message: 'm' }), unsent: false })).toMatchObject({ kind: 'network', maybeApplied: true })
    expect(unknownWriteOutcome({ error: workError({ kind: 'invalid_response', message: 'm' }), unsent: false })).toMatchObject({ maybeApplied: true })
    expect(unknownWriteOutcome({ error: workError({ kind: 'network', message: 'm' }), unsent: true })).toEqual(workError({ kind: 'network', message: 'm' }))
    const refused: WorkErrorKind[] = ['auth', 'forbidden', 'rejected']
    for (const kind of refused) expect(unknownWriteOutcome({ error: workError({ kind, message: 'm' }), unsent: false })).toEqual(workError({ kind, message: 'm' }))
  })

  it('모의 출처 create-lost — 적용하고 답을 잃는다(화면 시험용)', async () => {
    const { send, state } = await mockSetup({ token: `${FAKE_MOCK_TOKEN}_create-lost` })
    const before = state.items.length
    const response = await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: '잃은 답' })
    expect(response).toMatchObject({ ok: false, error: { kind: 'network', maybeApplied: true } })
    expect(state.items.length).toBe(before + 1)
  })
})

describe('LA 기본 상태·배치 적용 (R2-G·R2-H)', () => {
  const second = '00000000-0000-4000-8000-000000009099'

  it('R2-G 기본 상태 = 할 일 분류의 isDefault 단계(위치 첫째가 아니어도) · 칸이 없는 옛 서버면 위치 첫 할 일', async () => {
    const { fixture, send } = await laSetup()
    fixture.statuses = [
      ...fixture.statuses.map((status) => (status.categoryKey === 'todo' ? { ...status, isDefault: false } : status)),
      { id: second, categoryKey: 'todo', label: '대기', color: null, position: 1, isDefault: true },
    ]
    expect(await send({ op: 'getCreateMeta', spaceKey: FIXTURE_IDS.corral, kindKey: 'task' })).toMatchObject({ ok: true, result: { meta: { defaultStatusKey: second } } })
    fixture.corrupt = 'status-no-default'
    expect(await send({ op: 'getCreateMeta', spaceKey: FIXTURE_IDS.corral, kindKey: 'task' })).toMatchObject({ ok: true, result: { meta: { defaultStatusKey: FIXTURE_STATUS.todo } } })
  })

  it('R2-H task·checkpoint = 배치 적용(onBoard 명시) · bug = 적용 안 됨: onBoard 를 싣지 않고, 배치를 실어 보내면 보내기 전에 거절', async () => {
    const { fixture, send } = await laSetup()
    expect(await send({ op: 'getCreateMeta', spaceKey: FIXTURE_IDS.corral, kindKey: 'task' })).toMatchObject({ ok: true, result: { meta: { placement: 'applies' } } })
    expect(await send({ op: 'getCreateMeta', spaceKey: FIXTURE_IDS.corral, kindKey: 'checkpoint' })).toMatchObject({ ok: true, result: { meta: { placement: 'applies' } } })
    expect(await send({ op: 'getCreateMeta', spaceKey: FIXTURE_IDS.corral, kindKey: 'bug' })).toMatchObject({ ok: true, result: { meta: { placement: 'ignored' } } })
    const bug = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'bug', title: '버그' })
    expect(bug.ok).toBe(true)
    expect(fixture.createArgs.at(-1)).toEqual({ kind: 'bug', title: '버그', parentId: FIXTURE_IDS.corral })
    const withPlacement = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'bug', title: '배치 실음', placement: 'backlog' })
    expect(withPlacement).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('배치') } })
    expect(fixture.createArgs).toHaveLength(1)
  })
})

describe('모의 출처(Jira 형) — 첫 상태만 · 필수 필드 (C3·C8)', () => {
  it('생성 메타 — 상태는 워크플로 첫 상태 하나 · Bug 만 Customer impact(고르기) 필수', async () => {
    const { send } = await mockSetup()
    expect(await send({ op: 'getCreateMeta', spaceKey: 'CORE', kindKey: 'story' })).toMatchObject({ ok: true, result: { meta: { statusKeys: ['core-todo'], defaultStatusKey: 'core-todo', fields: [] } } })
    const bug = await send({ op: 'getCreateMeta', spaceKey: 'CORE', kindKey: 'bug' })
    expect(bug).toMatchObject({ ok: true, result: { meta: { fields: [{ key: 'customfield_impact', label: 'Customer impact', shape: 'option' }] } } })
  })

  it('첫 상태가 아닌 상태로는 거절 · Bug 는 impact 없이 거절, 고르면 만든다 · 요청 기록에 남는다', async () => {
    const { send, state } = await mockSetup()
    expect(await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: 's', statusKey: 'core-doing' })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'bug', title: 'b' })).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('Customer impact') } })
    expect(await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'bug', title: 'b', fields: [{ key: 'customfield_impact', value: 'nope' }] })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    const made = await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'bug', title: 'b', fields: [{ key: 'customfield_impact', value: 'impact-high' }], priority: 'low', placement: 'backlog', body: '재현 순서' })
    expect(made).toMatchObject({ ok: true, result: { item: { statusKey: 'core-todo', priority: 'low', placement: 'backlog', body: '재현 순서' } } })
    expect(state.createCalls).toHaveLength(4)
  })

  it('지원 밖 모양의 필수 필드(createmeta-unsupported) — 메타에 unsupported 로 실리고, 만들기는 거절', async () => {
    const { send } = await mockSetup({ token: 'mock_createmeta-unsupported' })
    const meta = await send({ op: 'getCreateMeta', spaceKey: 'CORE', kindKey: 'epic' })
    expect(meta).toMatchObject({ ok: true, result: { meta: { fields: [{ key: 'customfield_team', shape: 'unsupported', sourceType: 'user' }] } } })
    expect(await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'epic', title: 'e', fields: [{ key: 'customfield_team', value: 'me' }] })).toMatchObject({ ok: false, error: { kind: 'rejected', message: expect.stringContaining('corral 에서 채울 수 없습니다') } })
  })

  it('글 모양 필수 필드 — 공백만이면 거절, 값이 있으면 만든다', async () => {
    const state = seedMockState()
    state.createFields = { story: [{ key: 'customfield_env', label: 'Environment', shape: 'text' }] }
    const { send } = await mockSetup({ state })
    expect(await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: 's', fields: [{ key: 'customfield_env', value: '  ' }] })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: 's', fields: [{ key: 'customfield_env', value: 'prod' }] })).toMatchObject({ ok: true })
  })

  it('createmeta-fail — 생성 메타 요청이 거절된다(화면은 이유 + 다시 시도)', async () => {
    const { send } = await mockSetup({ token: 'mock_createmeta-fail' })
    expect(await send({ op: 'getCreateMeta', spaceKey: 'CORE', kindKey: 'story' })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
  })

  it('배치 능력 hidden 이면 배치를 실은 만들기는 출처에 닿지 않고 unsupported', async () => {
    const { send, state } = await mockSetup({ token: 'mock_cap-placement-hide' })
    await send({ op: 'listSpaces' })
    expect(await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: 's', placement: 'board' })).toMatchObject({ ok: false, error: { kind: 'unsupported' } })
    expect(state.createCalls ?? []).toHaveLength(0)
    expect(await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: 's' })).toMatchObject({ ok: true })
  })
})

describe('main 의 생성 메타 검증 (E11 — 양성 대조)', () => {
  const fakeEntry = (meta: unknown): WorkSourceEntry => ({
    descriptor: { ...MOCK_DESCRIPTOR, id: 'fake-meta' },
    create: () => ({
      capabilities: () => MOCK_CAPABILITIES,
      close: () => {},
      call: async (call: WorkCall): Promise<WorkOutcome> => {
        if (call.op === 'listSpaces') return { ok: true, result: { op: 'listSpaces', spaces: [], capabilities: MOCK_CAPABILITIES } }
        if (call.op !== 'getCreateMeta') return { ok: false, error: { kind: 'rejected', message: 'x', status: null } }
        // 일부러 계약 밖 모양을 돌려준다 — 타입 밖 값이라 unknown 을 그대로 실을 수 있게 JSON 을 거친다.
        const result: unknown = JSON.parse(JSON.stringify({ op: 'getCreateMeta', meta }))
        return { ok: true, result: readResultLoosely(result) }
      },
    }),
  })
  const good: WorkCreateMeta = { spaceKey: 'S', kindKey: 'k', statusKeys: ['a', 'b'], defaultStatusKey: 'a', placement: 'applies', fields: [{ key: 'f', label: 'F', shape: 'option', options: [{ id: 'o', label: 'O' }] }] }
  const cases: { name: string; meta: unknown }[] = [
    { name: '상태 없음', meta: { ...good, statusKeys: [] } },
    { name: '기본 상태가 목록 밖', meta: { ...good, defaultStatusKey: 'z' } },
    { name: '모르는 값 모양', meta: { ...good, fields: [{ key: 'f', label: 'F', shape: 'cascading' }] } },
    { name: '선택지 없는 고르기', meta: { ...good, fields: [{ key: 'f', label: 'F', shape: 'option', options: [] }] } },
    { name: '필드 키 겹침', meta: { ...good, fields: [{ key: 'f', label: 'F', shape: 'text' }, { key: 'f', label: 'G', shape: 'text' }] } },
    { name: '다른 종류의 메타', meta: { ...good, kindKey: 'other' } },
    { name: '배치 적용 값 모름(R2-H)', meta: { ...good, placement: 'maybe' } },
    { name: '만들 수 없음 이유가 빈 글(R4-F)', meta: { ...good, unavailable: '' } },
    { name: '만들 수 없음 이유가 글이 아님(R4-F)', meta: { ...good, unavailable: true } },
    { name: '다른 스페이스의 메타(R5-C)', meta: { ...good, spaceKey: 'OTHER' } },
    { name: '만들 수 없음 이유가 500자 넘음(R5-C)', meta: { ...good, unavailable: 'x'.repeat(501) } },
  ]
  for (const { name, meta } of cases) {
    it(`${name} → invalid_response`, async () => {
      const harness = workHarness({ entries: [fakeEntry(meta)] })
      const added = await harness.service.addConnection({ sourceId: 'fake-meta', token: 'mock_x', replaceId: null })
      if (!added.ok) throw new Error(added.error.message)
      const response = await harness.service.request({ requestId: 'm', connectionId: added.connection.id, call: { op: 'getCreateMeta', spaceKey: 'S', kindKey: 'k' } })
      expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    })
  }
  it('맞는 메타는 그대로 통과(대조)', async () => {
    const harness = workHarness({ entries: [fakeEntry(good)] })
    const added = await harness.service.addConnection({ sourceId: 'fake-meta', token: 'mock_x', replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const response = await harness.service.request({ requestId: 'm', connectionId: added.connection.id, call: { op: 'getCreateMeta', spaceKey: 'S', kindKey: 'k' } })
    expect(response).toMatchObject({ ok: true, result: { op: 'getCreateMeta', meta: good } })
  })
  it('만들 수 없음 이유가 있는 메타도 통과(대조, R4-F) · 이유 500자까지(대조, R5-C)', async () => {
    const meta: WorkCreateMeta = { ...good, unavailable: 'y'.repeat(500) }
    const harness = workHarness({ entries: [fakeEntry(meta)] })
    const added = await harness.service.addConnection({ sourceId: 'fake-meta', token: 'mock_x', replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const response = await harness.service.request({ requestId: 'm', connectionId: added.connection.id, call: { op: 'getCreateMeta', spaceKey: 'S', kindKey: 'k' } })
    expect(response).toMatchObject({ ok: true, result: { op: 'getCreateMeta', meta } })
  })
})

describe('「만들었음」 활동 (C10)', () => {
  it('부모 없는 만들기 = 새 작업에 created 1건 · 부모 있는 만들기 = 새 작업 created + 부모 child, 같은 쓰기 id', async () => {
    const { harness, send, connectionId } = await mockSetup()
    const top = await send({ op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'epic', title: '맨 위' })
    if (!top.ok || top.result.op !== 'createItem') throw new Error('top')
    expect(harness.activity.list({ connectionId, itemId: top.result.item.id }).map((record) => record.change)).toEqual([{ field: 'created', kindLabel: 'Epic' }])
    const child = await send({ op: 'createItem', spaceKey: 'CORE', parentId: top.result.item.id, kindKey: 'story', title: '아래' })
    if (!child.ok || child.result.op !== 'createItem') throw new Error('child')
    const mine = harness.activity.list({ connectionId, itemId: child.result.item.id })
    const parent = harness.activity.list({ connectionId, itemId: top.result.item.id }).filter((record) => record.change.field === 'child')
    expect(mine.map((record) => record.change)).toEqual([{ field: 'created', kindLabel: 'Story' }])
    expect(parent).toHaveLength(1)
    expect(parent[0]?.writeId).toBe(mine[0]?.writeId)
    // 재조회(읽기)는 활동을 늘리지 않는다.
    await send({ op: 'getItem', itemId: child.result.item.id })
    await send({ op: 'listItems', spaceKey: 'CORE', cursor: null })
    expect(harness.activity.list({ connectionId, itemId: child.result.item.id })).toHaveLength(1)
  })

  it('파일 저장소 — created 기록이 재시작 뒤에도 그대로 읽힌다(모르는 칸 아님)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l604-act-'))
    try {
      const first = new WorkActivityStore(dir)
      first.load()
      first.append({ id: 'a1', connectionId: 'c1', itemId: 'i1', at: 1, writeId: 'w1', change: { field: 'created', kindLabel: 'Task' } })
      const second = new WorkActivityStore(dir)
      second.load()
      expect(second.list({ connectionId: 'c1', itemId: 'i1' }).map((record) => record.change)).toEqual([{ field: 'created', kindLabel: 'Task' }])
      expect(readActivityRecord({ id: 'a', connectionId: 'c', itemId: 'i', at: 1, writeId: 'w', change: { field: 'created' } })).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** 시험 전용 — 계약 밖 값을 결과 자리에 싣는다(main 검증이 막는지 본다). 런타임 모양만 맞추고 타입은 결과 합집합의 한 갈래로 읽는다. */
function readResultLoosely(value: unknown): Extract<WorkOutcome, { ok: true }>['result'] {
  return JSON.parse(JSON.stringify(value), (_key, entry: unknown) => entry)
}
