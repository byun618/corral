// Jira `doneAt` 매핑 — done 분류일 때만 `statuscategorychangedate`(비공식 칸)를 ISO 로 싣는다. 칸이 없거나 null·이상값이면 null, 목록은 깨지지 않는다.
// fixture 전이는 분류가 바뀔 때만 그 시각을 새로 쓴다(같은 분류 안 이동은 그대로 — 실제 Jira 칸 의미). 실제 경로: WorkService → Jira 출처 → REST fixture(127.0.0.1).
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkItem, WorkResult } from '../../shared/work.js'
import { JIRA_FIXTURE_IDS, type JiraRestFixture } from './jira-rest-fixture.js'
import { FAKE_JIRA_TOKEN, JIRA_ACCOUNT, jiraFixtureHarness, type WorkHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

type Rig = WorkHarness & { fixture: JiraRestFixture; connectionId: string }

async function connected(): Promise<Rig> {
  const harness = await jiraFixtureHarness()
  stops.push(() => harness.fixture.stop())
  const added = await harness.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  return { ...harness, connectionId: added.connection.id }
}

let seq = 0
async function send({ rig, call }: { rig: Rig; call: WorkCall }): Promise<WorkResult> {
  const response = await rig.service.request({ requestId: `j-${++seq}`, connectionId: rig.connectionId, call })
  if (!response.ok) throw new Error(`${call.op}: ${response.error.kind} ${response.error.message}`)
  return response.result
}
function itemOf(result: WorkResult): WorkItem {
  if (!('item' in result) || result.item === null || result.item === undefined) throw new Error(`item 없음: ${result.op}`)
  return result.item
}
/** 스페이스 목록 전 쪽(하네스 쪽 크기 2). */
async function listAll({ rig, spaceKey }: { rig: Rig; spaceKey: string }): Promise<WorkItem[]> {
  const all: WorkItem[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const result = await send({ rig, call: { op: 'listItems', spaceKey, cursor } })
    if (result.op !== 'listItems') throw new Error(result.op)
    all.push(...result.items)
    cursor = result.nextCursor
    if (cursor === null) return all
  }
  throw new Error('쪽이 끝나지 않음')
}
async function three({ rig, itemId, key }: { rig: Rig; itemId: string; key: string }): Promise<{ list: WorkItem | undefined; get: WorkItem; find: WorkItem }> {
  const list = (await listAll({ rig, spaceKey: 'CORE' })).find((item) => item.id === itemId)
  const get = itemOf(await send({ rig, call: { op: 'getItem', itemId } }))
  const find = itemOf(await send({ rig, call: { op: 'findByKey', key } }))
  return { list, get, find }
}
function issueOf({ rig, id }: { rig: Rig; id: string }) {
  const issue = rig.fixture.issue(id)
  if (issue === null) throw new Error(`fixture 에 없음: ${id}`)
  return issue
}
const CATEGORY_FIELD = 'statuscategorychangedate'

describe('D1 Jira doneAt — 값', () => {
  it('ⓐ done 이슈 — `+0000` 꼴 칸 값을 ISO(UTC) 로 · 목록·단건·키 찾기 같은 값', async () => {
    const rig = await connected()
    const { list, get, find } = await three({ rig, itemId: JIRA_FIXTURE_IDS.done, key: 'CORE-6' })
    expect(get.category).toBe('done')
    expect(get.doneAt).toBe('2026-10-09T00:00:00.000Z')
    expect(list?.doneAt).toBe(get.doneAt)
    expect(find.doneAt).toBe(get.doneAt)
  })

  it('ⓐ done 이슈 — `+0900` 꼴도 같은 순간의 UTC 로', async () => {
    const rig = await connected()
    issueOf({ rig, id: JIRA_FIXTURE_IDS.done }).fieldValues[CATEGORY_FIELD] = '2026-10-26T15:03:28.123+0900'
    const { list, get, find } = await three({ rig, itemId: JIRA_FIXTURE_IDS.done, key: 'CORE-6' })
    expect(get.doneAt).toBe('2026-10-26T06:03:28.123Z')
    expect(list?.doneAt).toBe(get.doneAt)
    expect(find.doneAt).toBe(get.doneAt)
  })

  it('ⓑ todo·in_progress 이슈는 칸 값이 와도 null', async () => {
    const rig = await connected()
    const items = await listAll({ rig, spaceKey: 'CORE' })
    const open = items.filter((item) => item.category !== 'done')
    expect(open.map((item) => item.category)).toEqual(expect.arrayContaining(['todo', 'in_progress']))
    for (const item of open) expect(item.doneAt, item.key).toBeNull()
    // 칸이 실제로 응답에 실렸다(비어서 null 인 것이 아니다) — fixture 가 그 이슈에 값을 갖고, 목록 요청이 칸을 달라고 했다.
    for (const item of open) expect(issueOf({ rig, id: item.id }).categoryChanged, item.key).toBeGreaterThan(0)
    const search = rig.fixture.requests.find((request) => request.path === '/rest/api/3/search/jql')
    expect(search?.query.fields?.split(',')).toContain(CATEGORY_FIELD)
    expect(itemOf(await send({ rig, call: { op: 'getItem', itemId: JIRA_FIXTURE_IDS.epic } })).doneAt).toBeNull()
    expect(itemOf(await send({ rig, call: { op: 'findByKey', key: 'CORE-2' } })).doneAt).toBeNull()
  })

  it('ⓒ 세 경로 모두 요청 fields 에 칸이 있다(fixture 가 받은 요청)', async () => {
    const rig = await connected()
    await three({ rig, itemId: JIRA_FIXTURE_IDS.done, key: 'CORE-6' })
    const fieldsOf = (match: (path: string) => boolean): string[][] => rig.fixture.requests.filter((request) => request.method === 'GET' && match(request.path)).map((request) => (request.query.fields ?? '').split(','))
    const searched = fieldsOf((path) => path === '/rest/api/3/search/jql')
    const byId = fieldsOf((path) => path === `/rest/api/3/issue/${JIRA_FIXTURE_IDS.done}`)
    const byKey = fieldsOf((path) => path === '/rest/api/3/issue/CORE-6')
    expect(searched.length).toBeGreaterThan(0)
    expect(byId.length).toBeGreaterThan(0)
    expect(byKey.length).toBeGreaterThan(0)
    for (const fields of [...searched, ...byId, ...byKey]) expect(fields).toContain(CATEGORY_FIELD)
  })
})

describe('D2 Jira doneAt — 결측·이상값', () => {
  const cases: { name: string; value: unknown }[] = [
    { name: 'ⓐ 응답에 칸 없음', value: undefined },
    { name: 'ⓑ null', value: null },
    { name: 'ⓒ 해석 안 되는 문자열', value: '어제쯤' },
    { name: 'ⓒ 시각 꼴이 아닌 문자열(Date.parse 는 받는다)', value: '2026' },
    { name: 'ⓒ 문자열이 아닌 값', value: 1761000000000 },
  ]
  for (const { name, value } of cases) {
    it(`${name} — doneAt null · 목록·단건 ok · 다른 칸은 그대로`, async () => {
      const rig = await connected()
      const before = await three({ rig, itemId: JIRA_FIXTURE_IDS.done, key: 'CORE-6' })
      expect(before.get.doneAt).not.toBeNull()
      issueOf({ rig, id: JIRA_FIXTURE_IDS.done }).fieldValues[CATEGORY_FIELD] = value
      const after = await three({ rig, itemId: JIRA_FIXTURE_IDS.done, key: 'CORE-6' })
      expect(after.list).toBeDefined()
      const pairs: { was: WorkItem | undefined; now: WorkItem | undefined }[] = [{ was: before.list, now: after.list }, { was: before.get, now: after.get }, { was: before.find, now: after.find }]
      for (const { was, now } of pairs) {
        expect(now?.doneAt).toBeNull()
        expect({ ...now, doneAt: 'x' }).toEqual({ ...was, doneAt: 'x' })
      }
    })
  }

  it('단건 부분 응답에서 칸만 빠져도(omitOnce) 실패하지 않는다', async () => {
    const rig = await connected()
    rig.fixture.omitOnce.set(JIRA_FIXTURE_IDS.done, [CATEGORY_FIELD])
    const got = itemOf(await send({ rig, call: { op: 'getItem', itemId: JIRA_FIXTURE_IDS.done } }))
    expect(got.category).toBe('done')
    expect(got.doneAt).toBeNull()
  })
})

describe('D5 fixture 전이 — 분류가 바뀔 때만 칸을 새로 쓴다', () => {
  it('진행 중 → 검토(같은 분류) 그대로 · 검토 → 완료 새로 · 완료 → 다른 완료 그대로 · 완료 → 검토 새로', async () => {
    const rig = await connected()
    const core = rig.fixture.projects.find((project) => project.key === 'CORE')
    if (core === undefined) throw new Error('CORE')
    // 실제 Jira 워크플로처럼 완료 → 다른 완료(Closed) 전이를 둔다.
    for (const statuses of Object.values(core.statusesByType)) statuses.push('10011')
    core.workflow['10003']?.push({ id: '42', name: 'Close', to: '10011' })
    core.workflow['10011'] = [{ id: '43', name: 'Reopen', to: '10002' }]
    // CORE-4 Story: In Review(10002) → Rework → In Progress(10001) → Review → In Review — 둘 다 진행 중 분류.
    const issue = issueOf({ rig, id: JIRA_FIXTURE_IDS.review })
    const changeTo = async (statusKey: string): Promise<WorkItem> => itemOf(await send({ rig, call: { op: 'changeStatus', itemId: issue.id, statusKey, ifVersion: null } }))
    const start = issue.categoryChanged
    const progress = await changeTo('10001')
    expect(progress.category).toBe('in_progress')
    expect(progress.doneAt).toBeNull()
    expect(issue.categoryChanged).toBe(start)
    await changeTo('10002')
    expect(issue.categoryChanged).toBe(start)
    const done = await changeTo('10003')
    expect(done.category).toBe('done')
    expect(issue.categoryChanged).toBeGreaterThan(start)
    expect(done.doneAt).toBe(new Date(issue.categoryChanged).toISOString())
    const closed = await changeTo('10011')
    expect(closed.category).toBe('done')
    expect(closed.doneAt).toBe(done.doneAt)
    const reopened = await changeTo('10002')
    expect(reopened.doneAt).toBeNull()
    expect(issue.categoryChanged).toBeGreaterThan(Date.parse(done.doneAt ?? ''))
  })
})
