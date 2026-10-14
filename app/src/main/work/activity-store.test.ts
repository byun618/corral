// LIFE-602 C9 — corral 활동 저장소: 재시작 유지 · 손상 파일(양성 대조) · 보존 상한 · 연결 해제 · 성공한 쓰기만(보드 끌기 포함).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkActivityRecord } from '../../shared/work.js'
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
