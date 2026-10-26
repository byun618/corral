// LIFE-702 D1 — `WorkItem.doneAt` 계약. LA 는 응답 값 그대로(목록·단건·키 조회·쓰기 결과), 칸이 없으면 null(옛 서버 — 목록 실패 금지).
// Jira 는 null(숨기지 않음), 모의 출처는 상태 쓰기에서 LA 규칙(진입 기록·이탈 null)을 따른다. LA 모의 서버는 씨앗별 doneAt 을 싣는다.
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkItem } from '../../shared/work.js'
import { JIRA_FIXTURE_IDS } from './jira-rest-fixture.js'
import { FIXTURE_IDS, FIXTURE_STATUS } from './la-mcp-fixture.js'
import { FAKE_JIRA_TOKEN, FAKE_LA_TOKEN, FAKE_MOCK_TOKEN, JIRA_ACCOUNT, jiraFixtureHarness, laFixtureHarness, mockHarness, type WorkHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

const OLD = '2026-10-01T03:04:05.000Z'

async function laConnected() {
  const harness = await laFixtureHarness()
  stops.push(() => harness.fixture.stop())
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  const doneBug = harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.doneBug)
  if (doneBug === undefined) throw new Error('doneBug')
  doneBug.doneAt = OLD
  return { ...harness, connectionId: added.connection.id }
}

let seq = 0
async function ok({ harness, connectionId, call }: { harness: WorkHarness; connectionId: string; call: WorkCall }) {
  const response = await harness.service.request({ requestId: `r-${++seq}`, connectionId, call })
  if (!response.ok) throw new Error(`${call.op}: ${response.error.kind} ${response.error.message}`)
  return response.result
}
async function listed({ harness, connectionId, spaceKey }: { harness: WorkHarness; connectionId: string; spaceKey: string }): Promise<WorkItem[]> {
  const result = await ok({ harness, connectionId, call: { op: 'listItems', spaceKey, cursor: null } })
  if (result.op !== 'listItems') throw new Error(result.op)
  return result.items
}
function itemOf(result: Awaited<ReturnType<typeof ok>>): WorkItem {
  if (!('item' in result) || result.item === null || result.item === undefined) throw new Error(`item 없음: ${result.op}`)
  return result.item
}

describe('D1ⓐ LA — 응답의 doneAt 을 그대로 싣는다', () => {
  it('목록 · 단건 · 키 조회', async () => {
    const h = await laConnected()
    const items = await listed({ harness: h, connectionId: h.connectionId, spaceKey: FIXTURE_IDS.corral })
    expect(items.find((item) => item.id === FIXTURE_IDS.doneBug)?.doneAt).toBe(OLD)
    expect(items.find((item) => item.id === FIXTURE_IDS.task600)?.doneAt).toBeNull()
    expect(itemOf(await ok({ harness: h, connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.doneBug } })).doneAt).toBe(OLD)
    expect(itemOf(await ok({ harness: h, connectionId: h.connectionId, call: { op: 'findByKey', key: 'LIFE-387' } })).doneAt).toBe(OLD)
  })

  it('쓰기 결과 — done 진입이면 서버가 기록한 값, 이탈이면 null', async () => {
    const h = await laConnected()
    const entered = itemOf(await ok({ harness: h, connectionId: h.connectionId, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: FIXTURE_STATUS.done, ifVersion: null, resolution: 'completed' } }))
    const stored = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)?.doneAt ?? null
    expect(stored).not.toBeNull()
    expect(entered.category).toBe('done')
    expect(entered.doneAt).toBe(stored)
    const left = itemOf(await ok({ harness: h, connectionId: h.connectionId, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: FIXTURE_STATUS.todo, ifVersion: null } }))
    expect(left.category).toBe('todo')
    expect(left.doneAt).toBeNull()
  })
})

describe('D1ⓑ LA — doneAt 칸이 없는 응답(옛 서버)은 null, 실패가 아니다', () => {
  it('목록 행에 칸 없음 → 목록 성공 · 전부 null', async () => {
    const h = await laConnected()
    h.fixture.corrupt = 'list-drop-doneAt'
    const items = await listed({ harness: h, connectionId: h.connectionId, spaceKey: FIXTURE_IDS.corral })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.doneAt === null)).toBe(true)
  })

  it('단건 응답에 칸 없음 → 단건 성공 · null', async () => {
    const h = await laConnected()
    h.fixture.corrupt = 'drop-doneAt'
    expect(itemOf(await ok({ harness: h, connectionId: h.connectionId, call: { op: 'getItem', itemId: FIXTURE_IDS.doneBug } })).doneAt).toBeNull()
  })

  it('대조 — 칸이 있는데 글자가 아니면 형태 어긋남(invalid_response)', async () => {
    const h = await laConnected()
    const doneBug = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.doneBug)
    if (doneBug === undefined) throw new Error('doneBug')
    Reflect.set(doneBug, 'doneAt', 12345)
    const response = await h.service.request({ requestId: 'bad', connectionId: h.connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
  })
})

describe('D1ⓒ Jira · 모의 출처', () => {
  it('Jira — 완료 작업도 doneAt null(숨기지 않음)', async () => {
    const harness = await jiraFixtureHarness()
    stops.push(() => harness.fixture.stop())
    const added = await harness.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const spaces = await ok({ harness, connectionId: added.connection.id, call: { op: 'listSpaces' } })
    if (spaces.op !== 'listSpaces') throw new Error(spaces.op)
    const items = (await Promise.all(spaces.spaces.map((space) => listed({ harness, connectionId: added.connection.id, spaceKey: space.key })))).flat()
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.doneAt === null)).toBe(true)
    // 목록 씨앗에 완료가 없어 완료 이슈는 단건으로 본다.
    const done = itemOf(await ok({ harness, connectionId: added.connection.id, call: { op: 'getItem', itemId: JIRA_FIXTURE_IDS.done } }))
    expect(done.category).toBe('done')
    expect(done.doneAt).toBeNull()
  })

  it('모의 — done 으로 가면 기록, 나가면 null', async () => {
    const harness = mockHarness()
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const connectionId = added.connection.id
    const before = await listed({ harness, connectionId, spaceKey: 'WEB' })
    const open = before.find((item) => item.statusKey === 'web-open')
    if (open === undefined) throw new Error('WEB open 없음')
    expect(open.doneAt).toBeNull()
    const closed = itemOf(await ok({ harness, connectionId, call: { op: 'changeStatus', itemId: open.id, statusKey: 'web-closed', ifVersion: null } }))
    expect(closed.category).toBe('done')
    expect(closed.doneAt).not.toBeNull()
    expect(Number.isNaN(Date.parse(closed.doneAt ?? ''))).toBe(false)
    const reopened = itemOf(await ok({ harness, connectionId, call: { op: 'changeStatus', itemId: open.id, statusKey: 'web-open', ifVersion: null } }))
    expect(reopened.doneAt).toBeNull()
  })
})
