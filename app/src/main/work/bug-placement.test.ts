// LIFE-665 — LA Bug 배치: 만들기를 LA 실제에 맞춘다(안 A). LA 는 LIFE-293 이후 bug 의 onBoard 를 생성·갱신 모두 task 와 같게 받는다
// (`specs/LIFE-665-bug-placement/raw/coord/c11-la-source-contrast.txt` — `issue.service.ts:447-452`).
// C1: 생성 메타 — bug·task·checkpoint 모두 `placement: 'applies'`(프로젝트 스페이스 · 「미분류」), 미분류 Checkpoint `unavailable` 그대로.
// C2: 만들기 인자 — bug 에도 onBoard 를 늘 싣는다(backlog → false, board·없음 → true). 모의 MCP 가 받은 인자 + 다시 읽은 placement 로 본다. 자식 Bug(부모 체크포인트)도 같은 경로.
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkResponse } from '../../shared/work.js'
import { FIXTURE_IDS } from './la-mcp-fixture.js'
import { LA_CATCH_ALL_KEY } from './la-source.js'
import { FAKE_LA_TOKEN, laFixtureHarness } from './test-kit.js'

let seq = 0
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.()
})

async function laSetup() {
  const harness = await laFixtureHarness()
  stops.push(() => harness.fixture.stop())
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  const connectionId = added.connection.id
  const send = (call: WorkCall): Promise<WorkResponse> => harness.service.request({ requestId: `r-${++seq}`, connectionId, call })
  return { fixture: harness.fixture, send }
}

describe('C1 생성 메타 — bug 도 배치 적용', () => {
  it.each([
    ['프로젝트 스페이스', FIXTURE_IDS.corral],
    ['「미분류」', LA_CATCH_ALL_KEY],
  ])('%s: bug·task·checkpoint 모두 applies · 미분류 Checkpoint 만 unavailable', async (_name, spaceKey) => {
    const { send } = await laSetup()
    for (const kindKey of ['bug', 'task', 'checkpoint']) {
      const response = await send({ op: 'getCreateMeta', spaceKey, kindKey })
      expect(response).toMatchObject({ ok: true, result: { op: 'getCreateMeta', meta: { kindKey, placement: 'applies', accepts: { body: true, priority: true } } } })
      if (!response.ok || response.result.op !== 'getCreateMeta') throw new Error('메타 없음')
      expect(response.result.meta.unavailable !== undefined).toBe(kindKey === 'checkpoint' && spaceKey === LA_CATCH_ALL_KEY)
    }
  })
})

describe('C2 만들기 인자 — bug 에도 onBoard 를 늘 싣는다', () => {
  it.each([
    ['백로그 → onBoard false', 'backlog', false, 'backlog'],
    ['보드 → onBoard true', 'board', true, 'board'],
    ['배치 없음(서비스 직접 호출 · 기본 = 보드) → onBoard true', undefined, true, 'board'],
  ] as const)('%s · 다시 읽은 placement 같음', async (_name, placement, onBoard, reread) => {
    const { fixture, send } = await laSetup()
    const made = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'bug', title: `버그 ${String(placement)}`, ...(placement === undefined ? {} : { placement }) })
    if (!made.ok || made.result.op !== 'createItem') throw new Error(`만들기 실패: ${JSON.stringify(made)}`)
    const item = made.result.item
    expect(fixture.createArgs.at(-1)).toMatchObject({ kind: 'bug', onBoard })
    expect(fixture.issues.find((issue) => issue.id === item.id)?.onBoard).toBe(onBoard)
    expect(item.placement).toBe(reread)
    const again = await send({ op: 'getItem', itemId: item.id })
    expect(again).toMatchObject({ ok: true, result: { item: { placement: reread, kind: { key: 'bug' } } } })
  })

  it('자식 Bug(부모 체크포인트) — 고른 배치가 그대로 onBoard 로 · 배치 없음 = 보드', async () => {
    const { fixture, send } = await laSetup()
    const backlog = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.checkpoint, kindKey: 'bug', title: '자식 버그', placement: 'backlog' })
    expect(backlog).toMatchObject({ ok: true, result: { item: { placement: 'backlog', parentId: FIXTURE_IDS.checkpoint } } })
    expect(fixture.createArgs.at(-1)).toMatchObject({ kind: 'bug', parentId: FIXTURE_IDS.checkpoint, onBoard: false })
    const plain = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.checkpoint, kindKey: 'bug', title: '자식 버그 기본' })
    expect(plain).toMatchObject({ ok: true, result: { item: { placement: 'board' } } })
    expect(fixture.createArgs.at(-1)).toMatchObject({ kind: 'bug', parentId: FIXTURE_IDS.checkpoint, onBoard: true })
  })
})
