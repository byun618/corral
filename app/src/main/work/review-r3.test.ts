// LIFE-600 수정 r3 — 리뷰 r3(Codex) 지적의 재현(raw/review/codex-r3-raw 의 드라이버)을 회귀 테스트로 옮긴 것. 테스트 이름 앞 [R3-x] 가 지적 ID,
// [Tn] 은 notes.md §11 연결 상태 전이 표의 칸이다(표의 칸마다 시험이 있게 — r1·r2 시험이 맡는 칸은 표에 그 이름을 적었다).
// 토큰은 가짜 `life_pat_` 뿐이다.
import { afterEach, describe, expect, it } from 'vitest'
import { isRecord, safeParse } from '../../shared/json.js'
import type { WorkCall } from '../../shared/work.js'
import { workError } from './errors.js'
import { FIXTURE_IDS } from './la-mcp-fixture.js'
import { LA_CAPABILITIES, LA_CATCH_ALL_KEY, LA_DESCRIPTOR, laSourceEntry } from './la-source.js'
import type { WorkOutcome, WorkSourceClient, WorkSourceEntry } from './source.js'
import { FAKE_LA_TOKEN, laFixtureHarness, workHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('until: 시간 초과')
}

function toolName(init: RequestInit | undefined): string | null {
  const body = typeof init?.body === 'string' ? safeParse(init.body) : null
  const params = isRecord(body) && isRecord(body.params) ? body.params : {}
  return typeof params.name === 'string' ? params.name : null
}

const SUCCESS: WorkOutcome = { ok: true, result: { op: 'listSpaces', spaces: [], capabilities: LA_CAPABILITIES } }
const AUTH: WorkOutcome = { ok: false, error: workError({ kind: 'auth', status: 401, message: 'expired' }) }
const NETWORK: WorkOutcome = { ok: false, error: workError({ kind: 'network', status: 500, message: 'offline' }) }
const INVALID: WorkOutcome = { ok: false, error: workError({ kind: 'invalid_response', status: 200, message: 'broken' }) }

/** 응답 시점을 시험이 정하는 출처 — n 번째로 만든 클라이언트의 호출마다 `answer` 가 결과를 고른다. */
function scripted(answer: (input: { client: number; call: number; op: WorkCall['op'] }) => Promise<WorkOutcome> | WorkOutcome) {
  let clients = 0
  let calls = 0
  const entry: WorkSourceEntry = {
    descriptor: LA_DESCRIPTOR,
    create: (): WorkSourceClient => {
      clients += 1
      const client = clients
      return {
        capabilities: () => LA_CAPABILITIES,
        close: () => {},
        call: async (call: WorkCall) => {
          calls += 1
          return answer({ client, call: calls, op: call.op })
        },
      }
    },
  }
  return { entry, calls: () => calls }
}

function summary(h: { service: { settings(): { connections: { status: string; pending: string | null }[] } } }) {
  const connection = h.service.settings().connections[0]
  return { status: connection?.status, pending: connection?.pending }
}

describe('[R3-A] auth 는 그때까지 발급된 모든 요청의 복구 권한을 없앤다 (경계 동등값 포함)', () => {
  it('[T5] newest-inflight-success-revives-auth — auth 이전에 시작한 마지막 순번 요청의 늦은 성공도 auth 를 풀지 못하고, 그 뒤 일반 요청은 보내지 않는다', async () => {
    const harness = await laFixtureHarness()
    stops.push(() => harness.fixture.stop())
    const outbound = deferred()
    const inbound = deferred()
    let active = false
    let olderHeld = false
    let newerHeld = false
    const fetchImpl: typeof fetch = async (input, init) => {
      const name = toolName(init)
      if (active && name === 'issue_get') { olderHeld = true; await outbound.promise }
      const response = await fetch(input, init)
      if (active && name === 'status_list') { newerHeld = true; await inbound.promise }
      return response
    }
    const h = workHarness({ entries: [laSourceEntry({ url: harness.url, clientVersion: 'test', fetchImpl })] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    const id = added.connection.id
    active = true
    const older = h.service.request({ requestId: 'older', connectionId: id, call: { op: 'getItem', itemId: FIXTURE_IDS.task601 } })
    await until(() => olderHeld)
    const newer = h.service.request({ requestId: 'newer', connectionId: id, call: { op: 'listStatuses', spaceKey: FIXTURE_IDS.corral } })
    await until(() => newerHeld)
    harness.fixture.tokens.delete(FAKE_LA_TOKEN)
    outbound.resolve()
    expect(await older).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(summary(h).status).toBe('auth')
    inbound.resolve()
    expect((await newer).ok).toBe(true)
    expect(summary(h).status).toBe('auth')
    active = false
    const sent = harness.fixture.requests.length
    expect(await h.service.request({ requestId: 'automatic', connectionId: id, call: { op: 'getItem', itemId: FIXTURE_IDS.task601 } })).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(harness.fixture.requests.length).toBe(sent)
  })
})

describe('[R3-B] 진행 표시와 확정 상태 — 실패는 자기 진행 표시만 거둔다', () => {
  it('[T11] failed-replacement-rolls-back-auth — 교체 대기 중 옛 자격 요청이 auth 를 만들면, 교체 실패 뒤에도 auth 이고 일반 요청은 나가지 않는다', async () => {
    const replacement = deferred()
    const source = scripted(async ({ client, call }) => {
      if (client === 2) { await replacement.promise; return NETWORK }
      return call === 1 ? SUCCESS : AUTH
    })
    const h = workHarness({ entries: [source.entry] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    const id = added.connection.id
    const replacing = h.service.addConnection({ sourceId: 'la', token: `${FAKE_LA_TOKEN}new`, replaceId: id })
    await h.service.request({ requestId: 'old', connectionId: id, call: { op: 'listSpaces' } })
    expect(summary(h)).toEqual({ status: 'testing', pending: 'network' })
    replacement.resolve()
    expect(await replacing).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(summary(h)).toEqual({ status: 'auth', pending: null })
    const calls = source.calls()
    await h.service.request({ requestId: 'automatic', connectionId: id, call: { op: 'listSpaces' } })
    expect(source.calls()).toBe(calls)
  })

  it('[T10·T11] failed-replacement-restores-completed-testing — 교체 중에 끝난 테스트의 ok 를 교체 실패가 testing 으로 되돌리지 않는다(버튼이 잠기지 않는다)', async () => {
    const oldTest = deferred()
    const replacement = deferred()
    let oldCalls = 0
    const source = scripted(async ({ client }) => {
      if (client === 1) {
        oldCalls += 1
        if (oldCalls > 1) await oldTest.promise
        return SUCCESS
      }
      await replacement.promise
      return NETWORK
    })
    const h = workHarness({ entries: [source.entry] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    const id = added.connection.id
    const testing = h.service.testConnection({ connectionId: id })
    await until(() => oldCalls === 2)
    const replacing = h.service.addConnection({ sourceId: 'la', token: `${FAKE_LA_TOKEN}new`, replaceId: id })
    oldTest.resolve()
    expect(await testing).toEqual({ ok: true })
    expect(summary(h)).toEqual({ status: 'testing', pending: 'network' })
    replacement.resolve()
    await replacing
    expect(summary(h)).toEqual({ status: 'ok', pending: null })
  })

  it('[T8] failed-explicit-test-restores-auth-to-ok — auth 뒤 누른 테스트가 invalid_response 면 auth 그대로(checkedAt 으로 추정하지 않는다), 일반 요청은 나가지 않는다', async () => {
    const source = scripted(({ call }) => (call === 1 ? SUCCESS : call === 3 ? INVALID : AUTH))
    const h = workHarness({ entries: [source.entry] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    const id = added.connection.id
    await h.service.request({ requestId: 'revoke', connectionId: id, call: { op: 'listSpaces' } })
    expect(summary(h).status).toBe('auth')
    expect(await h.service.testConnection({ connectionId: id })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    expect(summary(h)).toEqual({ status: 'auth', pending: null })
    const calls = source.calls()
    await h.service.request({ requestId: 'automatic', connectionId: id, call: { op: 'listSpaces' } })
    expect(source.calls()).toBe(calls)
  })

  it('[T8] ok 에서 누른 테스트가 invalid_response 면 ok 그대로 — 진행 표시만 거둔다', async () => {
    const source = scripted(({ call }) => (call === 1 ? SUCCESS : INVALID))
    const h = workHarness({ entries: [source.entry] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    expect(await h.service.testConnection({ connectionId: added.connection.id })).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    expect(summary(h)).toEqual({ status: 'ok', pending: null })
  })

  it('[T4·T5] 확정 상태는 더 늦게 시작한 요청이 정한다 — 먼저 시작한 요청의 늦은 실패는 그 뒤 성공을 덮지 않는다', async () => {
    const slow = deferred()
    let olderStarted = false
    const source = scripted(async ({ call }) => {
      if (call === 1) return SUCCESS
      if (call === 2) { olderStarted = true; await slow.promise; return NETWORK }
      return SUCCESS
    })
    const h = workHarness({ entries: [source.entry] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    const id = added.connection.id
    const older = h.service.request({ requestId: 'older', connectionId: id, call: { op: 'listSpaces' } })
    await until(() => olderStarted)
    expect((await h.service.request({ requestId: 'newer', connectionId: id, call: { op: 'listSpaces' } })).ok).toBe(true)
    slow.resolve()
    expect((await older).ok).toBe(false)
    expect(summary(h).status).toBe('ok')
  })

  it('[T7·T3] 연결 계열 오류(network)는 확정 상태 — 그 뒤 누른 테스트의 성공이 푼다', async () => {
    const source = scripted(({ call }) => (call === 2 ? NETWORK : SUCCESS))
    const h = workHarness({ entries: [source.entry] })
    const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    const id = added.connection.id
    await h.service.request({ requestId: 'r', connectionId: id, call: { op: 'listSpaces' } })
    expect(summary(h).status).toBe('offline')
    expect(await h.service.testConnection({ connectionId: id })).toEqual({ ok: true })
    expect(summary(h).status).toBe('ok')
  })
})

describe('[R3-D] 스페이스가 아닌 프로젝트(완료·보관) — 미분류로 보이고, 옛 키 목록은 「스페이스 아님」', () => {
  it('완료 프로젝트 아래 열린 작업은 미분류 목록·단건 모두 미분류 키, 옛 프로젝트 키로 목록을 부르면 rejected', async () => {
    const harness = await laFixtureHarness()
    stops.push(() => harness.fixture.stop())
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error('add')
    const send = (call: WorkCall) => harness.service.request({ requestId: call.op, connectionId: added.connection.id, call })
    const spaces = await send({ op: 'listSpaces' })
    if (!spaces.ok || spaces.result.op !== 'listSpaces') throw new Error('spaces')
    expect(spaces.result.spaces.map((space) => space.key)).not.toContain(FIXTURE_IDS.doneProject)
    const unsorted = await send({ op: 'listItems', spaceKey: LA_CATCH_ALL_KEY, cursor: null })
    if (!unsorted.ok || unsorted.result.op !== 'listItems') throw new Error('unsorted')
    expect(unsorted.result.items.find((item) => item.id === FIXTURE_IDS.taskUnderDoneProject)).toMatchObject({ spaceKey: LA_CATCH_ALL_KEY, parentId: null })
    expect(await send({ op: 'getItem', itemId: FIXTURE_IDS.taskUnderDoneProject })).toMatchObject({ ok: true, result: { item: { spaceKey: LA_CATCH_ALL_KEY } } })
    expect(await send({ op: 'listItems', spaceKey: FIXTURE_IDS.doneProject, cursor: null })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    // 보관된 프로젝트도 같은 규칙.
    const project = harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.lifeAssistant)
    if (project === undefined) throw new Error('fixture')
    project.archivedAt = '2026-10-13T00:00:00.000Z'
    expect(await send({ op: 'listItems', spaceKey: FIXTURE_IDS.lifeAssistant, cursor: null })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
  })
})
