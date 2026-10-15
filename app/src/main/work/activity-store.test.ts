// LIFE-602 C9 — corral 활동 저장소: 재시작 유지 · 손상 파일(양성 대조) · 보존 상한 · 연결 해제 · 성공한 쓰기만(보드 끌기 포함).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkActivityChange, WorkActivityRecord } from '../../shared/work.js'
import { WorkActivityStore, capRecords, readActivityRecord } from './activity-store.js'
import { mockSourceEntry, seedMockState } from './mock-source.js'
import { FAKE_MOCK_TOKEN, workHarness } from './test-kit.js'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l602-act-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const record = (over: Partial<WorkActivityRecord> = {}): WorkActivityRecord => ({
  id: `a-${Math.random()}`, connectionId: 'c1', itemId: 'i1', at: 1, writeId: 'w1', change: { field: 'title', to: '새 제목' }, ...over,
})

describe('활동 저장소 파일', () => {
  it('재시작(새 인스턴스 load) 뒤에도 남는다 · 파일은 0600 · 본문 전문은 담지 않는다', () => {
    const first = new WorkActivityStore(dir)
    first.load()
    expect(fs.existsSync(first.file)).toBe(false)
    first.append(record({ change: { field: 'body', lines: 3 } }))
    first.append(record({ itemId: 'i2' }))
    const second = new WorkActivityStore(dir)
    second.load()
    expect(second.list({ connectionId: 'c1', itemId: 'i1' })).toHaveLength(1)
    expect(second.list({ connectionId: 'c1', itemId: 'i1' })[0]?.change).toEqual({ field: 'body', lines: 3 })
    expect(fs.statSync(first.file).mode & 0o777).toBe(0o600)
  })

  it('손상된 파일 — 죽지 않고 빈 기록으로 시작, 원본은 .corrupt 로 보존(양성 대조: 같은 내용이 정상이면 읽힌다)', () => {
    const file = path.join(dir, 'work-activity.json')
    const good = JSON.stringify({ version: 1, records: [record()] })
    fs.writeFileSync(file, good)
    const control = new WorkActivityStore(dir)
    control.load()
    expect(control.list({ connectionId: 'c1', itemId: 'i1' })).toHaveLength(1)

    fs.writeFileSync(file, good.slice(0, good.length - 7))
    const broken = new WorkActivityStore(dir)
    expect(() => broken.load()).not.toThrow()
    expect(broken.list({ connectionId: 'c1', itemId: 'i1' })).toEqual([])
    expect(fs.readFileSync(`${file}.corrupt`, 'utf8')).toBe(good.slice(0, good.length - 7))
    broken.append(record({ id: 'after' }))
    expect(fs.readFileSync(`${file}.corrupt`, 'utf8')).toBe(good.slice(0, good.length - 7))
  })

  it('모르는 버전 — 손상과 같이 빈 기록 + .corrupt 보존(새 앱이 쓴 파일을 옛 앱이 덮어 지우지 않게)', () => {
    const file = path.join(dir, 'work-activity.json')
    const future = JSON.stringify({ version: 2, records: [record()] })
    fs.writeFileSync(file, future)
    const store = new WorkActivityStore(dir)
    store.load()
    expect(store.list({ connectionId: 'c1', itemId: 'i1' })).toEqual([])
    expect(fs.readFileSync(`${file}.corrupt`, 'utf8')).toBe(future)
  })

  it('망가진 줄만 버린다 — 모르는 칸·모양', () => {
    fs.writeFileSync(path.join(dir, 'work-activity.json'), JSON.stringify({ version: 1, records: [record(), { id: 'x' }, { ...record(), change: { field: 'nope', to: 1 } }, record({ id: 'ok2' })] }))
    const store = new WorkActivityStore(dir)
    store.load()
    expect(store.list({ connectionId: 'c1', itemId: 'i1' }).map((row) => row.id)).toHaveLength(2)
    expect(readActivityRecord({ ...record(), change: { field: 'priority', to: 'urgent' } })).toBeNull()
    expect(readActivityRecord({ ...record(), change: { field: 'relation', action: 'add', kind: 'blocks', otherKey: 'X-1' } })).not.toBeNull()
  })

  it('보존 상한 — 작업당 최근 N · 전체 최근 M, 순서 유지', () => {
    const rows = Array.from({ length: 10 }, (_, index) => record({ id: `r${index}`, itemId: index < 7 ? 'a' : 'b', at: index }))
    const capped = capRecords({ records: rows, perItem: 3, total: 5 })
    expect(capped.map((row) => row.id)).toEqual(['r4', 'r5', 'r6', 'r7', 'r8', 'r9'].slice(-5))
    const store = new WorkActivityStore(dir)
    for (let index = 0; index < 205; index += 1) store.append(record({ id: `n${index}` }))
    expect(store.list({ connectionId: 'c1', itemId: 'i1' })).toHaveLength(200)
    expect(store.list({ connectionId: 'c1', itemId: 'i1' })[0]?.id).toBe('n5')
  })

  it('경로 오버라이드 CORRAL_WORK_ACTIVITY · 쓰기 실패는 던지지 않는다', () => {
    const previous = process.env.CORRAL_WORK_ACTIVITY
    process.env.CORRAL_WORK_ACTIVITY = path.join(dir, 'blocked', 'act.json')
    try {
      fs.writeFileSync(path.join(dir, 'blocked'), 'file, not dir')
      const store = new WorkActivityStore('/nowhere')
      expect(store.file).toBe(path.join(dir, 'blocked', 'act.json'))
      expect(() => store.append(record())).not.toThrow()
      expect(store.list({ connectionId: 'c1', itemId: 'i1' })).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.CORRAL_WORK_ACTIVITY
      else process.env.CORRAL_WORK_ACTIVITY = previous
    }
  })
})

describe('WorkService 기록 지점', () => {
  const setup = async (token = FAKE_MOCK_TOKEN) => {
    const state = seedMockState()
    const harness = workHarness({ entries: [mockSourceEntry({ state })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const id = added.connection.id
    let n = 0
    const send = (call: unknown) => harness.service.request({ requestId: `r${++n}`, connectionId: id, call })
    return { harness, id, send, state }
  }

  it('보드 끌기와 같은 연산(changeStatus·setPlacement)도 남고, 순서 바꾸기·읽기는 남지 않는다', async () => {
    const { harness, id, send } = await setup()
    await send({ op: 'listStatuses', spaceKey: 'CORE' })
    await send({ op: 'changeStatus', itemId: 'm-2', statusKey: 'core-doing', ifVersion: null })
    await send({ op: 'setPlacement', itemId: 'm-2', placement: 'backlog', ifVersion: null })
    await send({ op: 'reorder', itemId: 'm-2', afterId: null })
    await send({ op: 'getItem', itemId: 'm-2' })
    const records = harness.service.activity({ connectionId: id, itemId: 'm-2' })
    if (!records.ok) throw new Error('activity')
    expect(records.records.map((row) => row.change)).toEqual([
      { field: 'status', statusKey: 'core-doing', statusLabel: 'In Progress', resolution: null },
      { field: 'placement', to: 'backlog' },
    ])
    expect(records.records.every((row) => row.at === 1_791_800_000_000)).toBe(true)
  })

  it('실패한 쓰기(출처 거절 · 충돌 · 능력 꺼짐)는 남지 않는다', async () => {
    const { harness, id, send } = await setup('mock_reject-writes')
    await send({ op: 'changeStatus', itemId: 'm-2', statusKey: 'core-doing', ifVersion: null })
    await send({ op: 'updateItem', itemId: 'm-2', fields: { title: 'x' }, ifVersion: null })
    await send({ op: 'setPlacement', itemId: 'm-2', placement: 'backlog', ifVersion: 'stale' })
    const records = harness.service.activity({ connectionId: id, itemId: 'm-2' })
    expect(records).toEqual({ ok: true, records: [] })
  })

  it('연결을 해제하면 그 연결의 기록이 지워진다 · 모양이 틀린 질의·없는 연결은 거절', async () => {
    const { harness, id, send } = await setup()
    await send({ op: 'updateItem', itemId: 'm-2', fields: { priority: 'high' }, ifVersion: null })
    expect(harness.activity.records).toHaveLength(1)
    expect(harness.service.activity({ connectionId: id })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    harness.service.removeConnection({ connectionId: id })
    expect(harness.activity.records).toHaveLength(0)
    expect(harness.service.activity({ connectionId: id, itemId: 'm-2' })).toMatchObject({ ok: false, error: { kind: 'not_connected' } })
  })

  it('뗀 연결의 상대는 앞서 본 단건에서 — 못 봤으면 null', async () => {
    const { harness, id, send } = await setup()
    const added = await send({ op: 'addRelation', itemId: 'm-1', kind: 'blocks', otherKey: 'CORE-3' })
    const relationId = added.ok && added.result.op === 'addRelation' ? added.result.relation.id : ''
    await send({ op: 'getItem', itemId: 'm-1' })
    await send({ op: 'removeRelation', itemId: 'm-1', relationId })
    const records = harness.service.activity({ connectionId: id, itemId: 'm-1' })
    if (!records.ok) throw new Error('activity')
    expect(records.records.map((row) => row.change)).toEqual([
      { field: 'relation', action: 'add', kind: 'blocks', otherKey: 'CORE-3' },
      { field: 'relation', action: 'remove', kind: 'blocks', otherKey: 'CORE-3' },
    ])
  })
})

describe('LIFE-603 R1-K·M — 사건 열쇠 기억 · 내용 고치기', () => {
  it('보존 상한으로 줄이 밀려나도 같은 열쇠는 다시 남지 않는다 — 재시작 뒤에도(양성 대조: 새 열쇠는 남는다)', () => {
    const first = new WorkActivityStore(dir)
    first.load()
    expect(first.append(record({ eventKey: 'agent:q:old', itemKey: 'K-1' }))).toBe(true)
    for (let index = 0; index < 205; index += 1) first.append(record({ eventKey: `agent:t:${index}`, itemKey: 'K-1' }))
    expect(first.list({ connectionId: 'c1', itemId: 'i1' }).some((row) => row.eventKey === 'agent:q:old')).toBe(false)
    expect(first.append(record({ eventKey: 'agent:q:old', itemKey: 'K-1' }))).toBe(false)
    const second = new WorkActivityStore(dir)
    second.load()
    expect(second.append(record({ eventKey: 'agent:q:old', itemKey: 'K-1' }))).toBe(false)
    expect(second.append(record({ eventKey: 'agent:q:new', itemKey: 'K-1' }))).toBe(true)
  })
  it('옛 파일(seen 없음)은 남은 줄의 열쇠로 시작한다', () => {
    fs.writeFileSync(path.join(dir, 'work-activity.json'), JSON.stringify({ version: 1, records: [record({ eventKey: 'run:start:a' })] }))
    const store = new WorkActivityStore(dir)
    store.load()
    expect(store.append(record({ eventKey: 'run:start:a' }))).toBe(false)
  })
  it('연결 해제는 그 연결의 열쇠도 잊는다', () => {
    const store = new WorkActivityStore(dir)
    store.load()
    store.append(record({ eventKey: 'run:start:c1' }))
    store.purgeConnection('c1')
    expect(store.append(record({ eventKey: 'run:start:c1' }))).toBe(true)
  })
  it('refresh — 같은 열쇠의 줄 내용을 바꾸고 재시작 뒤에도 남는다, 같은 내용·없는 열쇠는 false', () => {
    const store = new WorkActivityStore(dir)
    store.load()
    const result = (filesChanged: number): WorkActivityChange => ({ field: 'agent', event: 'result', agent: 'claude', worktree: '/w', outcome: 'completed', detail: null, filesChanged })
    store.append(record({ eventKey: 'agent:t:1', change: result(0) }))
    expect(store.refresh({ eventKey: 'agent:t:1', change: result(3) })).toBe(true)
    expect(store.refresh({ eventKey: 'agent:t:1', change: result(3) })).toBe(false)
    expect(store.refresh({ eventKey: 'agent:t:none', change: result(0) })).toBe(false)
    const again = new WorkActivityStore(dir)
    again.load()
    expect(again.list({ connectionId: 'c1', itemId: 'i1' })[0]?.change).toEqual(result(3))
  })
})

describe('R2-J ⓒ 연결 해제는 줄이 밀려난 열쇠까지 지운다', () => {
  it('상한으로 밀려난 c1 의 열쇠도 해제 뒤 파일에 없다 · 다른 연결의 열쇠는 남는다(양성 대조) · fix1 판 문자열 seen 도 읽는다', () => {
    const store = new WorkActivityStore(dir)
    store.load()
    store.append(record({ eventKey: 'run:start:attempt-old', connectionId: 'c1', itemKey: 'K-1' }))
    for (let index = 0; index < 205; index += 1) store.append(record({ eventKey: `agent:t:c1:K-1:${index}`, connectionId: 'c1', itemKey: 'K-1' }))
    store.append(record({ eventKey: 'run:start:other', connectionId: 'c2', itemId: 'i9' }))
    expect(store.list({ connectionId: 'c1', itemId: 'i1' }).some((row) => row.eventKey === 'run:start:attempt-old')).toBe(false)
    store.purgeConnection('c1')
    const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'))
    expect(JSON.stringify(saved.seen)).not.toContain('c1')
    expect(JSON.stringify(saved.seen)).not.toContain('attempt-old')
    expect(saved.seen).toEqual([['run:start:other', 'c2']])
    fs.writeFileSync(store.file, JSON.stringify({ version: 1, records: [], seen: ['agent:q:c3:K:s:b:x', 'run:start:keep'] }))
    const legacy = new WorkActivityStore(dir)
    legacy.load()
    expect(legacy.append(record({ eventKey: 'agent:q:c3:K:s:b:x', connectionId: 'c3' }))).toBe(false)
    legacy.purgeConnection('c3')
    expect(legacy.append(record({ eventKey: 'agent:q:c3:K:s:b:x', connectionId: 'c3' }))).toBe(true)
    expect(legacy.append(record({ eventKey: 'run:start:keep', connectionId: 'c3' }))).toBe(false)
  })
})
