// LIFE-632 C2 ①②③ — LA 쓰기 결과 구별(R5-B · F11). 출처가 「쓰기가 닿은 뒤 정본을 못 받음」 과 「쓰기 전 실패·쓰기 없는 갈래·충돌·거절」 을 갈라 준다.
// 쓰기 뒤 정본 미확보 · 쓰기 호출 자체의 결과 모름 = `maybeApplied`(분류 `kind` 는 그대로 — K2). 나머지는 그대로(붙이면 화면이 「다시 보내지 말라」 고 잘못 막는다).
// 모의 LA MCP(`la-mcp-fixture.ts`, 충돌 검사 켜짐) · 가짜 토큰만. Jira 의 같은 규칙은 `jira-source.test.ts` 「R1-X 쓰기 뒤 다시 읽기 실패」 가 본다(C3).
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkResponse } from '../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS, LaMcpFixture } from './la-mcp-fixture.js'
import { laSourceEntry } from './la-source.js'
import { FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN, laFixtureHarness, workHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

async function connected({ token = FAKE_LA_TOKEN }: { token?: string } = {}) {
  const h = await laFixtureHarness()
  stops.push(() => h.fixture.stop())
  const added = await h.service.addConnection({ sourceId: 'la', token, replaceId: null })
  if (!added.ok) throw new Error(`연결 실패: ${added.error.kind}`)
  let seq = 0
  const send = (call: WorkCall): Promise<WorkResponse> => h.service.request({ requestId: `r${(seq += 1)}`, connectionId: added.connection.id, call })
  const issue = (itemId: string) => {
    const found = h.fixture.issues.find((entry) => entry.id === itemId)
    if (found === undefined) throw new Error(`fixture ${itemId}`)
    return found
  }
  return { ...h, send, issue }
}

/** 실패 응답의 오류 — 성공이면 시험 실패. */
function failure(response: WorkResponse) {
  if (response.ok) throw new Error(`성공이 왔다: ${response.result.op}`)
  return response.error
}

/** 쓰기 갈래 전부 — 판은 지금 판(충돌 없음). `prepare` 는 그 갈래가 되도록 서버를 맞춘다. */
const writes: { name: string; call: (version: string) => WorkCall; itemId: string; prepare?: (fixture: LaMcpFixture) => void }[] = [
  { name: 'updateItem', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { priority: 'high' }, ifVersion }) },
  { name: 'setPlacement', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion }) },
  { name: 'setParent', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'setParent', itemId: FIXTURE_IDS.task600, spaceKey: FIXTURE_IDS.corral, parentId: null, ifVersion }) },
  { name: 'changeStatus 전진(issue_transition)', itemId: FIXTURE_IDS.task601, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion }) },
  { name: 'changeStatus no-op 전이 뒤 issue_update(statusId)', itemId: FIXTURE_IDS.task601, prepare: (fixture) => { fixture.transitionNoop = true }, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion }) },
  { name: 'changeStatus 뒤로 issue_update(statusId)', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: FIXTURE_STATUS.todo, ifVersion }) },
  { name: 'changeStatus 갈래만 issue_update(resolution)', itemId: FIXTURE_IDS.laTask, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.laTask, statusKey: FIXTURE_STATUS.done, resolution: 'cancelled', ifVersion }) },
]

describe('C2 ① 쓰기가 성공한 뒤 정본 읽기(issue_get) 실패 = maybeApplied · 분류 그대로 · 「적용됐지만」', () => {
  const modes = [
    { mode: 'partial', kind: 'invalid_response' },
    { mode: 'malformed', kind: 'invalid_response' },
    { mode: 'drop', kind: 'network' },
    { mode: 'refused', kind: 'rejected' },
  ] as const
  for (const write of writes) {
    for (const { mode, kind } of modes) {
      it(`${write.name} — ${mode}`, async () => {
        const h = await connected()
        write.prepare?.(h.fixture)
        const before = h.issue(write.itemId).version
        h.fixture.afterWrite = { mode, times: 10 }
        const error = failure(await h.send(write.call(String(before))))
        // 쓰기는 저장됐다 — 판이 올랐다.
        expect(h.issue(write.itemId).version).toBeGreaterThan(before)
        expect(error.kind).toBe(kind)
        expect(error.maybeApplied).toBe(true)
        expect(error.message.startsWith('LA 에는 적용됐지만')).toBe(true)
      })
    }
  }
})

describe('C2 ② 붙이지 않는 갈래 — 쓰기 전 읽기 실패 · 쓰기 없는 갈래 · 충돌 뒤 재조회 실패 · 서버 거절', () => {
  it('changeStatus 앞 issue_get 실패 — 쓰기 0, maybeApplied 없음', async () => {
    const h = await connected()
    h.fixture.toolFaults.set('issue_get', { kind: 'drop' })
    const error = failure(await h.send({ op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: '1' }))
    expect(h.fixture.writeArgs).toHaveLength(0)
    expect(error.maybeApplied).toBeUndefined()
  })

  it('changeStatus 앞 status_list 실패 — 쓰기 0, maybeApplied 없음', async () => {
    const h = await connected()
    h.fixture.toolFaults.set('status_list', { kind: 'drop' })
    const error = failure(await h.send({ op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: '1' }))
    expect(h.fixture.writeArgs).toHaveLength(0)
    expect(error.maybeApplied).toBeUndefined()
  })

  it.each(['partial', 'refused'] as const)('같은 상태 무동작 갈래의 읽기 실패(%s) — 쓰기 0, maybeApplied 없음', async (mode) => {
    const h = await connected()
    // 앞선 다른 작업의 쓰기 — 이 연산의 두 번째 읽기(결과 읽기)만 깨뜨리려고 고장을 켠다.
    const primed = await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.laTask, fields: { priority: 'low' }, ifVersion: null })
    expect(primed.ok).toBe(true)
    const writesBefore = h.fixture.writeArgs.length
    const current = h.issue(FIXTURE_IDS.task600)
    h.fixture.afterWrite = { mode, times: 10, skip: 1 }
    const error = failure(await h.send({ op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: current.statusId, ifVersion: String(current.version) }))
    expect(h.fixture.writeArgs).toHaveLength(writesBefore)
    expect(error.maybeApplied).toBeUndefined()
    expect(error.message).not.toContain('적용됐')
  })

  it('충돌(저장 0) 뒤 current 재조회 실패 — conflict 그대로, maybeApplied 없음', async () => {
    const h = await connected()
    const before = h.issue(FIXTURE_IDS.task600).version
    h.fixture.toolFaults.set('issue_get', { kind: 'drop' })
    const error = failure(await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { priority: 'high' }, ifVersion: String(before - 1) }))
    expect(error.kind).toBe('conflict')
    expect(error.maybeApplied).toBeUndefined()
    expect(h.issue(FIXTURE_IDS.task600).version).toBe(before)
  })

  it('서버 거절 — 권한(읽기 토큰) · 도구 오류는 maybeApplied 없음', async () => {
    const reader = await connected({ token: FAKE_LA_READ_TOKEN })
    const forbidden = failure(await reader.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { priority: 'high' }, ifVersion: null }))
    expect(forbidden.kind).toBe('forbidden')
    expect(forbidden.maybeApplied).toBeUndefined()
    const h = await connected()
    h.fixture.corrupt = 'tool-error'
    const rejected = failure(await h.send({ op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion: null }))
    expect(rejected.kind).toBe('rejected')
    expect(rejected.maybeApplied).toBeUndefined()
  })
})

/** 쓰기 도구 요청만 `code` 로 실패시키는 fetch — 연결 뒤 끊김(ECONNRESET)과 연결 전 실패(ECONNREFUSED = 보내지 않음)를 가른다. */
function failingWriteFetch({ tool, code }: { tool: string; code: string }): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string' && init.body.includes(`"name":"${tool}"`)) throw new TypeError('fetch failed', { cause: { code } })
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
  let seq = 0
  return { fixture, send: (call: WorkCall): Promise<WorkResponse> => harness.service.request({ requestId: `w${(seq += 1)}`, connectionId: added.connection.id, call }) }
}

describe('C2 ③ 쓰기 호출 자체의 결과 모름 = maybeApplied(만들기와 같은 규칙) · 보내지 않음·거절은 그대로', () => {
  it.each(['issue_update', 'issue_transition'] as const)('%s 가 처리된 뒤 답이 끊김 — network + maybeApplied + 「적용됐는지 모릅니다」', async (tool) => {
    const h = await connected()
    h.fixture.toolFaults.set(tool, { kind: 'drop-after' })
    const call: WorkCall = tool === 'issue_update'
      ? { op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { priority: 'high' }, ifVersion: null }
      : { op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: null }
    const error = failure(await h.send(call))
    expect(error.kind).toBe('network')
    expect(error.maybeApplied).toBe(true)
    expect(error.message.startsWith('적용됐는지 모릅니다')).toBe(true)
    expect(h.fixture.requests.filter((request) => request.tool === tool)).toHaveLength(1)
  })

  it('쓰기 응답 모양 어긋남(update-bad-title) — invalid_response + maybeApplied', async () => {
    const h = await connected()
    h.fixture.corrupt = 'update-bad-title'
    const error = failure(await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: '바뀐 제목' }, ifVersion: null }))
    expect(error.kind).toBe('invalid_response')
    expect(error.maybeApplied).toBe(true)
  })

  it('연결 뒤 끊김(ECONNRESET)은 닿았을 수 있음 · 대조 — 연결 전 실패(ECONNREFUSED)는 보내지 않음(maybeApplied 없음)', async () => {
    const call: WorkCall = { op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion: null }
    const reset = await laWithFetch(failingWriteFetch({ tool: 'issue_update', code: 'ECONNRESET' }))
    expect(failure(await reset.send(call))).toMatchObject({ kind: 'network', maybeApplied: true })
    const refused = await laWithFetch(failingWriteFetch({ tool: 'issue_update', code: 'ECONNREFUSED' }))
    const error = failure(await refused.send(call))
    expect(error.kind).toBe('network')
    expect(error.maybeApplied).toBeUndefined()
    expect(error.message).not.toContain('모릅니다')
  })

  it('명시 거절(HTTP 403 · 도구 오류)은 maybeApplied 없음', async () => {
    const h = await connected()
    h.fixture.toolFaults.set('issue_update', { kind: 'http', status: 403, body: '{"code":"FORBIDDEN"}' })
    const forbidden = failure(await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { priority: 'high' }, ifVersion: null }))
    expect(forbidden.kind).toBe('forbidden')
    expect(forbidden.maybeApplied).toBeUndefined()
  })
})
