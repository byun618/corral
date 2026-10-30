// LIFE-745 부모·자식 표현의 순수 로직 — C9(설정 읽기: 옛 모양·모르는 값·정상) · C8(부모 필터, (연결, 부모 id)) · C1(경로) · C4(보충 대상)
// · C5(레인 순서·「전체」 정체·칸 구성·진행) · C7(리스트 그룹 「부모」).
import { describe, expect, it } from 'vitest'
import type { WorkItem, WorkStatus } from '../../shared/work.js'
import {
  DEFAULT_TASKS_PREFS,
  NO_FILTERS,
  activePreset,
  boardBands,
  columnZone,
  filtersActive,
  groupRows,
  laneBands,
  laneProgress,
  missingParents,
  parentInfo,
  parentLanes,
  parentOptions,
  passesFilters,
  readTasksPrefs,
  rowsOf,
  type ParentLookup,
  type SpaceData,
  type TasksRow,
} from './tasks-model.js'

const status = (key: string, category: WorkStatus['category'], order: number): WorkStatus => ({ key, label: key.toUpperCase(), category, order, color: null })
const STATUSES = [status('todo', 'todo', 0), status('doing', 'in_progress', 1), status('done', 'done', 2)]
const item = (over: Partial<WorkItem> & { id: string }): WorkItem => ({ bodyLock: null, doneAt: null,
  key: over.id.toUpperCase(), spaceKey: 'S', title: `title ${over.id}`, body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'todo', category: 'todo',
  priority: 'medium', dueAt: null, parentId: null, placement: 'board', rank: null, resolution: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [],
  ...over,
})
const space = ({ connectionId = 'c1', items, nextCursor = null }: { connectionId?: string; items: WorkItem[]; nextCursor?: string | null }): SpaceData => ({
  connectionId, spaceKey: 'S', spaceName: 'Space', colorIndex: 1, color: null, statuses: STATUSES, kinds: [], items, nextCursor, truncated: false,
})
const NONE: ReadonlyMap<string, ParentLookup> = new Map()

describe('C9 설정 읽기 — 묶기·부모 필터', () => {
  it('옛 모양(새 칸 없음) — 묶기 없음 · 부모 필터 없음, 다른 칸은 그대로', () => {
    const old = { view: 'list', group: 'priority', density: 'compact', filters: { kinds: ['bug'], priorities: [], blocked: true, working: false, dueWeek: false } }
    const read = readTasksPrefs(old)
    expect(read.swimlane).toBe('none')
    expect(read.filters).toEqual({ kinds: ['bug'], priorities: [], blocked: true, working: false, dueWeek: false, parent: null })
    expect(read).toMatchObject({ view: 'list', group: 'priority', density: 'compact' })
  })

  it('모르는 값 — 기본값(묶기 없음 · 부모 필터 없음 · 그룹 상태)', () => {
    const read = readTasksPrefs({ swimlane: 'epic', group: 'tree', filters: { parent: 'no-separator' } })
    expect(read.swimlane).toBe('none')
    expect(read.group).toBe('status')
    expect(read.filters.parent).toBeNull()
    expect(readTasksPrefs({ swimlane: 3, filters: { parent: 7 } })).toMatchObject({ swimlane: 'none', filters: { parent: null } })
  })

  it('정상 — 쓰고 읽으면 같다(재시작 왕복)', () => {
    const prefs = { ...DEFAULT_TASKS_PREFS, swimlane: 'parent' as const, group: 'parent' as const, filters: { ...NO_FILTERS, parent: 'c1::p1' } }
    expect(readTasksPrefs(JSON.parse(JSON.stringify(prefs)))).toEqual(prefs)
    expect(DEFAULT_TASKS_PREFS.swimlane).toBe('none')
  })
})

describe('C8 부모 필터', () => {
  const rows = rowsOf([space({ items: [item({ id: 'p' }), item({ id: 'a', parentId: 'p' }), item({ id: 'g', parentId: 'a' }), item({ id: 'x' })] })])
  const pass = (row: TasksRow, parent: string | null, connectionId = row.space.connectionId): boolean =>
    passesFilters({ item: row.item, connectionId, filters: { ...NO_FILTERS, parent }, workingKeys: new Set(), now: 0 })

  it('직계 자식만 — 손자·부모 자신·부모 없는 작업은 빠진다', () => {
    expect(rows.filter((row) => pass(row, 'c1::p')).map((row) => row.item.id)).toEqual(['a'])
  })
  it('(연결, 부모 id) 로 본다 — 다른 연결의 같은 id 부모는 아니다', () => {
    const [, child] = rows
    if (child === undefined) throw new Error('row')
    expect(pass(child, 'c1::p')).toBe(true)
    expect(pass(child, 'c1::p', 'c2')).toBe(false)
  })
  it('필터 켜짐 표시 · 프리셋과 섞이지 않음', () => {
    expect(filtersActive({ ...NO_FILTERS, parent: 'c1::p' })).toBe(true)
    expect(activePreset({ ...NO_FILTERS, parent: 'c1::p' })).toBeNull()
    expect(activePreset(NO_FILTERS)).toBe('all')
  })
  it('선택지 = 받은 행 중 자식이 있는 작업 + 보충한 부모, 순서 값 순', () => {
    const data = rowsOf([space({ items: [item({ id: 'p', rank: '2' }), item({ id: 'a', parentId: 'p' }), item({ id: 'b', parentId: 'ext' }), item({ id: 'c', parentId: 'gone' })] })])
    const fetched = new Map<string, ParentLookup>([['c1::ext', { state: 'found', item: item({ id: 'ext', rank: '1' }) }], ['c1::gone', { state: 'error', message: 'x' }]])
    expect(parentOptions({ rows: data, fetched }).map((option) => option.uid)).toEqual(['c1::ext', 'c1::p'])
  })
})

describe('C1·C4 부모 찾기 · 보충 대상', () => {
  it('받은 행 → 보충 → 받는 중 순, 경로는 가장 가까운 조상부터 아는 데까지, 고리는 끊는다', () => {
    const rows = rowsOf([space({ items: [item({ id: 'p', key: 'K-1', title: '체크포인트', parentId: 'top' }), item({ id: 'a', parentId: 'p' }), item({ id: 'b', parentId: 'ext' })] })])
    const fetched = new Map<string, ParentLookup>([['c1::top', { state: 'found', item: item({ id: 'top', key: 'K-0', title: '프로젝트', parentId: 'p' }) }]])
    const [, a, b] = rows
    if (a === undefined || b === undefined) throw new Error('row')
    const info = parentInfo({ connectionId: 'c1', item: a.item, rows, fetched })
    expect(info).toMatchObject({ uid: 'c1::p', lookup: { state: 'found' }, path: '상위: K-1 체크포인트 › K-0 프로젝트' })
    expect(parentInfo({ connectionId: 'c1', item: b.item, rows, fetched })).toMatchObject({ uid: 'c1::ext', lookup: { state: 'loading' }, path: '' })
    expect(parentInfo({ connectionId: 'c1', item: item({ id: 'z' }), rows, fetched })).toBeNull()
  })

  it('보충 대상 = 받은 행에 없는 부모만, 같은 부모는 한 번, 연결마다 따로', () => {
    const rows = rowsOf([space({ items: [item({ id: 'p' }), item({ id: 'a', parentId: 'p' }), item({ id: 'b', parentId: 'ext' }), item({ id: 'c', parentId: 'ext' })] })])
    const entries = [...rows.map((row) => ({ connectionId: 'c1', item: row.item })), { connectionId: 'c2', item: item({ id: 'h', parentId: 'ext' }) }]
    expect(missingParents({ entries, rows })).toEqual([{ connectionId: 'c1', itemId: 'ext' }, { connectionId: 'c2', itemId: 'ext' }])
  })
})

describe('C5 레인 · C7 그룹', () => {
  it('레인 순서 = 부모 순서 값, 받는 중·실패 부모는 그 뒤, 부모 없음 맨 끝', () => {
    const rows = rowsOf([space({ items: [
      item({ id: 'late', parentId: 'q' }), item({ id: 'p1', rank: '5' }), item({ id: 'p2', rank: '1' }),
      item({ id: 'a', parentId: 'p1' }), item({ id: 'b', parentId: 'p2' }), item({ id: 'solo' }),
    ] })])
    const lanes = parentLanes({ rows, parentOf: (row) => parentInfo({ connectionId: row.space.connectionId, item: row.item, rows, fetched: NONE }) })
    expect(lanes.map((lane) => [lane.id, lane.rows.map((row) => row.item.id)])).toEqual([
      ['c1::p2', ['b']], ['c1::p1', ['a']], ['c1::q', ['late']], ['none', ['p1', 'p2', 'solo']],
    ])
  })

  it('「전체」 — 두 연결의 같은 부모 id 는 다른 레인', () => {
    const rows = rowsOf([space({ items: [item({ id: 'p' }), item({ id: 'a', parentId: 'p' })] }), space({ connectionId: 'c2', items: [item({ id: 'p' }), item({ id: 'a', parentId: 'p' })] })])
    const lanes = parentLanes({ rows, parentOf: (row) => parentInfo({ connectionId: row.space.connectionId, item: row.item, rows, fetched: NONE }) })
    expect(lanes.map((lane) => lane.id)).toEqual(expect.arrayContaining(['c1::p', 'c2::p', 'none']))
    expect(lanes.find((lane) => lane.id === 'c2::p')?.rows.map((row) => row.space.connectionId)).toEqual(['c2'])
  })

  it('레인 밴드 — 묶기 없음과 같은 칸 구성, 칸마다 그 레인의 카드만, 놓기 영역은 레인마다 갈린다', () => {
    const rows = rowsOf([space({ items: [item({ id: 'p' }), item({ id: 'a', parentId: 'p' }), item({ id: 'b', parentId: 'p', statusKey: 'doing', category: 'in_progress' }), item({ id: 'z', statusKey: 'weird' })] })])
    const bands = boardBands({ rows, statuses: STATUSES, all: false })
    const lanes = parentLanes({ rows, parentOf: (row) => parentInfo({ connectionId: row.space.connectionId, item: row.item, rows, fetched: NONE }) })
    const plainColumns = bands.flatMap((band) => band.columns.map((column) => column.id))
    for (const lane of lanes) {
      const laned = laneBands({ bands, lane })
      expect(laned.flatMap((band) => band.columns.map((column) => column.id))).toEqual(plainColumns)
      expect(laned.flatMap((band) => band.columns.flatMap((column) => column.rows)).length).toBe(lane.rows.length)
    }
    const first = lanes[0]
    if (first === undefined) throw new Error('lane')
    const column = laneBands({ bands, lane: first })[0]?.columns[0]
    if (column === undefined) throw new Error('column')
    expect(columnZone(column)).toBe('col:st:todo@c1::p')
    expect(columnZone({ ...column, lane: null })).toBe('col:st:todo')
  })

  it('레인 진행 — 받은 자식 전부(보드 밖 포함), 덜 받았으면 partial', () => {
    const rows = rowsOf([space({ nextCursor: 'more', items: [item({ id: 'a', parentId: 'p', category: 'done', statusKey: 'done' }), item({ id: 'b', parentId: 'p', placement: 'backlog' })] })])
    const parent = parentInfo({ connectionId: 'c1', item: item({ id: 'x', parentId: 'p' }), rows, fetched: NONE })
    if (parent === null) throw new Error('parent')
    expect(laneProgress({ parent, rows })).toEqual({ done: 1, total: 2, partial: true })
  })

  it('리스트 그룹 「부모」 — 부모마다 그룹, 부모 없음 끝, 그룹에 레인(머리용)', () => {
    const rows = rowsOf([space({ items: [item({ id: 'p', rank: '1' }), item({ id: 'a', parentId: 'p' }), item({ id: 'b', parentId: 'ext' })] })])
    const fetched = new Map<string, ParentLookup>([['c1::ext', { state: 'error', message: '끊김' }]])
    const groups = groupRows({ rows, group: 'parent', statuses: STATUSES, all: false, parentOf: (row) => parentInfo({ connectionId: 'c1', item: row.item, rows, fetched }) })
    expect(groups.map((group) => [group.id, group.label])).toEqual([['parent:c1::p', 'P title p'], ['parent:c1::ext', '부모를 불러오지 못함'], ['parent:none', '부모 없음']])
    expect(groups[0]?.lane?.parent?.uid).toBe('c1::p')
  })
})
