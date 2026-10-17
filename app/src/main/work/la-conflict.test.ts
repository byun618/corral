// LIFE-622 C1·C2 — LA 조건부 수정(저장 충돌 검사) 켜기. 모의 LA MCP(`la-mcp-fixture.ts`)는 코디 실측(`specs/LIFE-622-reconcile-conflict/raw/coordinator/c12-la-conflict-probe.md`)
// 과 LA 코드 대조의 모양이다: 응답 `version`(불투명 글자) · `ifVersion` 다르면 저장 0 + isError text JSON CONFLICT(current 에 links 없음) · transition 은 버전 비교 먼저 ·
// no-op 전이는 판 소비 없음 · 조건부 저장은 무변경이어도 판 소비. 토큰은 가짜 `life_pat_` 뿐이다.
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkItem } from '../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS, type FixtureCorrupt } from './la-mcp-fixture.js'
import { LA_CAPABILITIES } from './la-source.js'
import { FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN, laFixtureHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

async function connected({ token = FAKE_LA_TOKEN }: { token?: string } = {}) {
  const h = await laFixtureHarness()
  stops.push(() => h.fixture.stop())
  const added = await h.service.addConnection({ sourceId: 'la', token, replaceId: null })
  if (!added.ok) throw new Error(`연결 실패: ${added.error.kind}`)
  const id = added.connection.id
  let seq = 0
  const send = (call: WorkCall) => h.service.request({ requestId: `r${(seq += 1)}`, connectionId: id, call })
  const getItem = async (itemId: string): Promise<WorkItem> => {
    const got = await send({ op: 'getItem', itemId })
    if (!got.ok || got.result.op !== 'getItem') throw new Error(`getItem ${itemId}`)
    return got.result.item
  }
  const issue = (itemId: string) => {
    const found = h.fixture.issues.find((entry) => entry.id === itemId)
    if (found === undefined) throw new Error(`fixture ${itemId}`)
    return found
  }
  return { ...h, id, send, getItem, issue }
}

describe('C1 판 매핑 · 능력 켜짐', () => {
  it('목록·단건·쓰기 결과·만들기 결과의 version = LA version 글자 그대로', async () => {
    const h = await connected()
    expect(LA_CAPABILITIES.conflictCheck).toEqual({ state: 'on' })
    h.issue(FIXTURE_IDS.task600).version = 41
    const listed = await h.send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null })
    if (!listed.ok || listed.result.op !== 'listItems') throw new Error('list')
    expect(listed.result.items.find((entry) => entry.id === FIXTURE_IDS.task600)?.version).toBe('41')
    expect((await h.getItem(FIXTURE_IDS.task600)).version).toBe('41')
    const edited = await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: '바뀐 제목' }, ifVersion: '41' })
    expect(edited).toMatchObject({ ok: true, result: { op: 'updateItem', item: { version: '42' } } })
    const created = await h.send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, kindKey: 'task', parentId: null, title: '새 작업' })
    expect(created).toMatchObject({ ok: true, result: { op: 'createItem', item: { version: '1' } } })
  })

  const breaks: { corrupt: FixtureCorrupt; call: WorkCall }[] = [
    { corrupt: 'drop-version', call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } },
    { corrupt: 'list-drop-version', call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } },
    { corrupt: 'version-number', call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } },
    { corrupt: 'version-number', call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } },
  ]
  for (const { corrupt, call } of breaks) {
    it(`양성 대조 — ${corrupt} 면 ${call.op} 는 invalid_response(조용히 null 로 접지 않는다)`, async () => {
      const h = await connected()
      h.fixture.corrupt = corrupt
      expect(await h.send(call)).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
    })
  }
})

describe('C2 ① 네 연산 — 낡은 판은 conflict · 저장 0 · current = 단건 모양 · by null', () => {
  const ops: { name: string; call: (stale: string) => WorkCall; itemId: string }[] = [
    { name: 'updateItem', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: '충돌 제목' }, ifVersion }) },
    { name: 'setPlacement', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion }) },
    { name: 'setParent', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'setParent', itemId: FIXTURE_IDS.task600, spaceKey: FIXTURE_IDS.corral, parentId: null, ifVersion }) },
    { name: 'changeStatus 전진', itemId: FIXTURE_IDS.task601, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion }) },
    { name: 'changeStatus 뒤로', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: FIXTURE_STATUS.todo, ifVersion }) },
    { name: 'changeStatus 갈래만', itemId: FIXTURE_IDS.laTask, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.laTask, statusKey: FIXTURE_STATUS.done, resolution: 'cancelled', ifVersion }) },
    // F7 — 같은 상태·같은 갈래(쓰기 없음)도 낡은 판이면 성공으로 지나가지 않는다.
    { name: 'changeStatus 같은 상태(F7)', itemId: FIXTURE_IDS.task600, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: FIXTURE_STATUS.dev, ifVersion }) },
    { name: 'changeStatus 같은 완료·같은 갈래(F7)', itemId: FIXTURE_IDS.laTask, call: (ifVersion) => ({ op: 'changeStatus', itemId: FIXTURE_IDS.laTask, statusKey: FIXTURE_STATUS.done, resolution: 'completed', ifVersion }) },
  ]
  for (const { name, call, itemId } of ops) {
    it(name, async () => {
      const h = await connected()
      const before = await h.getItem(itemId)
      const saved = JSON.stringify(h.issue(itemId))
      const writes = h.fixture.writeArgs.length
      h.issue(itemId).version += 1
      const now = await h.getItem(itemId)
      const outcome = await h.send(call(before.version ?? ''))
      expect(outcome).toMatchObject({ ok: false, error: { kind: 'conflict', status: 409 } })
      if (outcome.ok) return
      // 저장 0 — 판 말고는 그대로.
      expect({ ...h.issue(itemId), version: 0 }).toEqual({ ...JSON.parse(saved), version: 0 })
      expect(h.issue(itemId).version).toBe(Number(before.version) + 1)
      expect(outcome.error.conflict).toEqual({ current: now, by: null })
      // 원격 message 를 옮기지 않는다(⑥).
      expect(outcome.error.message).not.toContain('ifVersion=')
      expect(outcome.error.message).toBe(`${before.key} 이(가) 연 뒤에 바뀌었습니다 — 새로 불러오거나 덮어쓰세요.`)
      // 같은 상태 갈래는 쓰기를 보내지 않고 판으로 가린다.
      if (name.includes('F7')) expect(h.fixture.writeArgs).toHaveLength(writes)
    })
  }

  it('conflict.current 는 단건과 같은 모양 — 스페이스·표시 부모·연결·막힘(F4)', async () => {
    const h = await connected()
    await h.send({ op: 'addRelation', itemId: FIXTURE_IDS.task600, kind: 'is_blocked_by', otherKey: 'LIFE-601' })
    const item = await h.getItem(FIXTURE_IDS.task600)
    h.issue(FIXTURE_IDS.task600).version += 1
    const outcome = await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: 'x' }, ifVersion: item.version })
    if (outcome.ok || outcome.error.conflict === undefined) throw new Error('conflict 아님')
    expect(outcome.error.conflict.current).toMatchObject({ spaceKey: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.checkpoint, openBlockerCount: 1 })
    expect(outcome.error.conflict.current.relations?.[0]).toMatchObject({ kind: 'is_blocked_by', other: { key: 'LIFE-601', spaceKey: FIXTURE_IDS.corral } })
  })
})

describe('C2 ② 상태 바꾸기의 모든 갈래에 ifVersion 이 실린다', () => {
  const sentVersions = (h: Awaited<ReturnType<typeof connected>>, from: number) => h.fixture.writeArgs.slice(from).map(({ tool, args }) => ({ tool, ifVersion: args.ifVersion }))

  it('전진 = issue_transition(ifVersion)', async () => {
    const h = await connected()
    const item = await h.getItem(FIXTURE_IDS.task601)
    const from = h.fixture.writeArgs.length
    expect(await h.send({ op: 'changeStatus', itemId: item.id, statusKey: FIXTURE_STATUS.dev, ifVersion: item.version })).toMatchObject({ ok: true, result: { item: { statusKey: FIXTURE_STATUS.dev, version: '2' } } })
    expect(sentVersions(h, from)).toEqual([{ tool: 'issue_transition', ifVersion: '1' }])
  })

  it('전진인데 서버 no-op → issue_update(statusId) 로 이어 감 — 두 단계 모두 같은 판(no-op 은 판을 소비하지 않는다, F5)', async () => {
    const h = await connected()
    h.fixture.transitionNoop = true
    const item = await h.getItem(FIXTURE_IDS.task601)
    const from = h.fixture.writeArgs.length
    expect(await h.send({ op: 'changeStatus', itemId: item.id, statusKey: FIXTURE_STATUS.dev, ifVersion: item.version })).toMatchObject({ ok: true, result: { item: { statusKey: FIXTURE_STATUS.dev, version: '2' } } })
    expect(sentVersions(h, from)).toEqual([{ tool: 'issue_transition', ifVersion: '1' }, { tool: 'issue_update', ifVersion: '1' }])
  })

  it('전진 갈래의 낡은 판 — transition 이 CONFLICT 이면 이어 가지 않는다', async () => {
    const h = await connected()
    h.fixture.transitionNoop = true
    h.issue(FIXTURE_IDS.task601).version = 5
    const from = h.fixture.writeArgs.length
    expect(await h.send({ op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: '4' })).toMatchObject({ ok: false, error: { kind: 'conflict' } })
    expect(sentVersions(h, from)).toEqual([{ tool: 'issue_transition', ifVersion: '4' }])
  })

  it('뒤로 = issue_update(statusId, ifVersion) (D6)', async () => {
    const h = await connected()
    const item = await h.getItem(FIXTURE_IDS.task600)
    const from = h.fixture.writeArgs.length
    expect(await h.send({ op: 'changeStatus', itemId: item.id, statusKey: FIXTURE_STATUS.todo, ifVersion: item.version })).toMatchObject({ ok: true, result: { item: { statusKey: FIXTURE_STATUS.todo } } })
    expect(sentVersions(h, from)).toEqual([{ tool: 'issue_update', ifVersion: '1' }])
  })

  it('갈래만 = issue_update(resolution, ifVersion)', async () => {
    const h = await connected()
    const item = await h.getItem(FIXTURE_IDS.laTask)
    const from = h.fixture.writeArgs.length
    expect(await h.send({ op: 'changeStatus', itemId: item.id, statusKey: FIXTURE_STATUS.done, resolution: 'cancelled', ifVersion: item.version })).toMatchObject({ ok: true, result: { item: { resolution: 'cancelled' } } })
    expect(sentVersions(h, from)).toEqual([{ tool: 'issue_update', ifVersion: '1' }])
  })

  it('같은 상태·맞는 판 — 쓰기 없이 지금 작업(F7 대조)', async () => {
    const h = await connected()
    const item = await h.getItem(FIXTURE_IDS.task600)
    const from = h.fixture.writeArgs.length
    expect(await h.send({ op: 'changeStatus', itemId: item.id, statusKey: FIXTURE_STATUS.dev, ifVersion: item.version })).toMatchObject({ ok: true, result: { item: { version: item.version } } })
    expect(h.fixture.writeArgs).toHaveLength(from)
  })

  it('updateItem·setPlacement·setParent 도 ifVersion 을 싣는다', async () => {
    const h = await connected()
    const from = h.fixture.writeArgs.length
    await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: 'a' }, ifVersion: '1' })
    await h.send({ op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion: '2' })
    await h.send({ op: 'setParent', itemId: FIXTURE_IDS.task600, spaceKey: FIXTURE_IDS.corral, parentId: null, ifVersion: '3' })
    expect(sentVersions(h, from)).toEqual([{ tool: 'issue_update', ifVersion: '1' }, { tool: 'issue_update', ifVersion: '2' }, { tool: 'issue_update', ifVersion: '3' }])
    expect((await h.getItem(FIXTURE_IDS.task600)).version).toBe('4')
  })
})

describe('C2 ④ 판 없음 = 무조건 저장 · F8 연속 조건부 쓰기', () => {
  it('ifVersion null 이면 판을 싣지 않고 낡은 판 위에도 저장된다(「내 값으로 덮기」)', async () => {
    const h = await connected()
    h.issue(FIXTURE_IDS.task600).version = 9
    const from = h.fixture.writeArgs.length
    expect(await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: '덮은 제목' }, ifVersion: null })).toMatchObject({ ok: true, result: { item: { title: '덮은 제목', version: '10' } } })
    expect(h.fixture.writeArgs.slice(from).map(({ args }) => Object.hasOwn(args, 'ifVersion'))).toEqual([false])
  })

  it('무변경 조건부 저장도 판을 소비한다 — 다음 쓰기는 앞 결과의 판을 써야 한다', async () => {
    const h = await connected()
    const item = await h.getItem(FIXTURE_IDS.task600)
    const first = await h.send({ op: 'updateItem', itemId: item.id, fields: { title: item.title }, ifVersion: item.version })
    if (!first.ok || first.result.op !== 'updateItem') throw new Error('first')
    expect(first.result.item.version).not.toBe(item.version)
    expect(await h.send({ op: 'updateItem', itemId: item.id, fields: { title: 'b' }, ifVersion: item.version })).toMatchObject({ ok: false, error: { kind: 'conflict' } })
    expect(await h.send({ op: 'updateItem', itemId: item.id, fields: { title: 'b' }, ifVersion: first.result.item.version })).toMatchObject({ ok: true })
  })
})

describe('C2 ⑤ CONFLICT 판독이 다른 오류를 삼키지 않는다', () => {
  it('missing scope 평문은 그대로 forbidden', async () => {
    const h = await connected({ token: FAKE_LA_READ_TOKEN })
    expect(await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: 'x' }, ifVersion: '0' })).toMatchObject({ ok: false, error: { kind: 'forbidden' } })
  })
  for (const corrupt of ['conflict-no-status', 'conflict-other-code'] as const) {
    it(`${corrupt} — CONFLICT 와 닮은 다른 isError 는 conflict 가 아니다(지금 분류 그대로)`, async () => {
      const h = await connected()
      h.fixture.corrupt = corrupt
      const outcome = await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: 'x' }, ifVersion: '0' })
      expect(outcome).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      if (!outcome.ok) expect(outcome.error.conflict).toBeUndefined()
    })
  }
  it('도구가 준 다른 CONFLICT 코드(연결 중복 — statusCode 없음)는 그대로 rejected', async () => {
    const h = await connected()
    await h.send({ op: 'addRelation', itemId: FIXTURE_IDS.task600, kind: 'relates_to', otherKey: 'LIFE-601' })
    expect(await h.send({ op: 'addRelation', itemId: FIXTURE_IDS.task600, kind: 'relates_to', otherKey: 'LIFE-601' })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
  })
  it('충돌 뒤 단건 재조회가 실패해도 conflict 는 conflict(current 없음) — 성공으로 넘기지 않는다', async () => {
    const h = await connected()
    h.issue(FIXTURE_IDS.task600).version = 3
    h.fixture.toolFaults.set('issue_get', { kind: 'http', status: 500, body: '{}' })
    const outcome = await h.send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: 'x' }, ifVersion: '2' })
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'conflict' } })
    if (!outcome.ok) expect(outcome.error.conflict).toBeUndefined()
    expect(h.issue(FIXTURE_IDS.task600).title).not.toBe('x')
  })
})
