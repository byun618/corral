// LIFE-702 수정 r3 H3 — 모의 출처·LA 모의 서버의 doneAt 을 LA `issue.service.ts` `resolveDoneAt` 과 같게:
// done→done 이고 기존 null 이면 지금(백필 누락 구멍 메움) · done 상태로 만들기 = 지금(진입 취급).
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkItem } from '../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS } from './la-mcp-fixture.js'
import { McpHttpClient } from './mcp-http.js'
import { mockSourceEntry, seedMockState } from './mock-source.js'
import { FAKE_LA_TOKEN, FAKE_MOCK_TOKEN, laFixtureHarness, workHarness, type WorkHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

const NOW = Date.parse('2030-01-02T03:04:05.000Z')
const CANCEL_STATUS = '00000000-0000-4000-8000-000000009005'

let seq = 0
async function changed({ harness, connectionId, call }: { harness: WorkHarness; connectionId: string; call: WorkCall }): Promise<WorkItem> {
  const response = await harness.service.request({ requestId: `f3-${++seq}`, connectionId, call })
  if (!response.ok) throw new Error(`${call.op}: ${response.error.kind} ${response.error.message}`)
  if (response.result.op !== 'changeStatus') throw new Error(response.result.op)
  return response.result.item
}

describe('H3 LA 모의 서버 — resolveDoneAt', () => {
  it('done→done 인데 doneAt 이 null(옛 행)이면 지금으로 채운다', async () => {
    const harness = await laFixtureHarness()
    stops.push(() => harness.fixture.stop())
    harness.fixture.doneClock = () => NOW
    harness.fixture.statuses.push({ id: CANCEL_STATUS, categoryKey: 'done', label: '취소', color: null, position: 1, isDefault: false })
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    // 씨앗 doneBug 는 done 인데 doneAt null — LA 백필 누락 행과 같은 모양.
    const item = await changed({ harness, connectionId: added.connection.id, call: { op: 'changeStatus', itemId: FIXTURE_IDS.doneBug, statusKey: CANCEL_STATUS, ifVersion: null, resolution: 'cancelled' } })
    expect(item.category).toBe('done')
    expect(item.doneAt).toBe(new Date(NOW).toISOString())
  })

  it('done 상태로 만들기(issue_create statusId=완료) = 지금', async () => {
    const harness = await laFixtureHarness()
    stops.push(() => harness.fixture.stop())
    harness.fixture.doneClock = () => NOW
    const mcp = new McpHttpClient({ url: harness.url, token: FAKE_LA_TOKEN, clientVersion: 'test' })
    const sent = await mcp.callTool({ name: 'issue_create', args: { kind: 'task', parentId: FIXTURE_IDS.corral, title: '완료로 만들기', statusId: FIXTURE_STATUS.done } })
    mcp.close()
    expect(sent.ok).toBe(true)
    const created = harness.fixture.issues.find((issue) => issue.title === '완료로 만들기')
    expect(created?.statusId).toBe(FIXTURE_STATUS.done)
    expect(created?.doneAt).toBe(new Date(NOW).toISOString())
    const open = harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)
    expect(open?.doneAt).toBeNull()
  })
})

describe('H3 모의 출처 — resolveDoneAt', () => {
  it('done→done 인데 doneAt 이 null 이면 지금으로 채운다(다른 done 상태로 이동)', async () => {
    const state = seedMockState()
    state.clock = () => NOW
    const core = state.spaces.find((space) => space.space.key === 'CORE')
    if (core === undefined) throw new Error('CORE')
    core.statuses.push({ key: 'core-cancelled', label: 'Cancelled', category: 'done', order: 4, color: null })
    core.transitions['core-done'] = [...(core.transitions['core-done'] ?? []), 'core-cancelled']
    const target = state.items.find((entry) => entry.spaceKey === 'CORE')
    if (target === undefined) throw new Error('CORE 작업 없음')
    Object.assign(target, { statusKey: 'core-done', resolution: 'completed', doneAt: null })
    const harness = workHarness({ entries: [mockSourceEntry({ state })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const moved = await changed({ harness, connectionId: added.connection.id, call: { op: 'changeStatus', itemId: target.id, statusKey: 'core-cancelled', ifVersion: null } })
    expect(moved.category).toBe('done')
    expect(moved.doneAt).toBe(new Date(NOW).toISOString())
  })

  it('done 상태로 만들기 = 지금 · 열린 상태로 만들기 = null', async () => {
    const state = seedMockState()
    state.clock = () => NOW
    // 모의 생성은 첫 할 일 상태(없으면 첫 상태)로만 만든다(Jira 흉내) — WEB 을 done(Closed) 상태만 남겨 done 으로 만드는 무대로.
    const web = state.spaces.find((space) => space.space.key === 'WEB')
    if (web === undefined) throw new Error('WEB')
    web.statuses = web.statuses.filter((status) => status.category === 'done')
    const harness = workHarness({ entries: [mockSourceEntry({ state })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const response = await harness.service.request({ requestId: 'f3-create', connectionId: added.connection.id, call: { op: 'createItem', spaceKey: 'WEB', parentId: null, kindKey: 'story', title: '완료로 만들기', statusKey: 'web-closed' } })
    if (!response.ok || response.result.op !== 'createItem') throw new Error(response.ok ? response.result.op : `${response.error.kind} ${response.error.message}`)
    expect(response.result.item.category).toBe('done')
    expect(response.result.item.doneAt).toBe(new Date(NOW).toISOString())
    const open = await harness.service.request({ requestId: 'f3-create-open', connectionId: added.connection.id, call: { op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: '열린 만들기' } })
    if (!open.ok || open.result.op !== 'createItem') throw new Error('open create')
    expect(open.result.item.doneAt).toBeNull()
  })
})
