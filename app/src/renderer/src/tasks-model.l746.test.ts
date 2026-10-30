// LIFE-746 보드 「묶기: 부모」 레인 밀도의 순수 로직 — C1(완료 레인 판정 · 보드 레인 순서, 리스트 그룹 순서 불변).
import { describe, expect, it } from 'vitest'
import type { WorkItem, WorkStatus } from '../../shared/work.js'
import { boardLaneOrder, groupRows, laneComplete, laneProgress, parentInfo, parentLanes, rowsOf, type ParentLane, type ParentLookup, type SpaceData, type TasksRow } from './tasks-model.js'

const status = (key: string, category: WorkStatus['category'], order: number): WorkStatus => ({ key, label: key.toUpperCase(), category, order, color: null })
const STATUSES = [status('todo', 'todo', 0), status('doing', 'in_progress', 1), status('done', 'done', 2)]
const item = (over: Partial<WorkItem> & { id: string }): WorkItem => ({ bodyLock: null, doneAt: null,
  key: over.id.toUpperCase(), spaceKey: 'S', title: `title ${over.id}`, body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'todo', category: 'todo',
  priority: 'medium', dueAt: null, parentId: null, placement: 'board', rank: null, resolution: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [],
  ...over,
})
const done = (over: Partial<WorkItem> & { id: string }): WorkItem => item({ statusKey: 'done', category: 'done', ...over })
const space = ({ items, nextCursor = null, truncated = false }: { items: WorkItem[]; nextCursor?: string | null; truncated?: boolean }): SpaceData => ({
  connectionId: 'c1', spaceKey: 'S', spaceName: 'Space', colorIndex: 1, color: null, statuses: STATUSES, kinds: [], items, nextCursor, truncated,
})
const NONE: ReadonlyMap<string, ParentLookup> = new Map()
const lanesOf = (rows: TasksRow[]): ParentLane[] => parentLanes({ rows, parentOf: (row) => parentInfo({ connectionId: row.space.connectionId, item: row.item, rows, fetched: NONE }) })

describe('C1 완료 레인 판정', () => {
  it('머리 진행 n/n(받은 자식 전부 완료) = 완료, 하나라도 미완 · 덜 받음(partial) · 부모 없음 = 아님', () => {
    const rows = rowsOf([space({ items: [
      item({ id: 'pa', rank: '1' }), done({ id: 'a1', parentId: 'pa' }), done({ id: 'a2', parentId: 'pa' }),
      item({ id: 'pb', rank: '2' }), done({ id: 'b1', parentId: 'pb' }), item({ id: 'b2', parentId: 'pb' }),
    ] })])
    const lanes = lanesOf(rows)
    const of = (id: string): boolean => {
      const lane = lanes.find((entry) => entry.id === id)
      if (lane === undefined) throw new Error(id)
      return laneComplete({ lane, rows })
    }
    expect(of('c1::pa')).toBe(true)
    expect(of('c1::pb')).toBe(false)
    expect(of('none')).toBe(false)
    // 판정은 머리 진행과 같은 값이다.
    const pa = lanes.find((entry) => entry.id === 'c1::pa')?.parent
    if (pa === undefined || pa === null) throw new Error('pa')
    expect(laneProgress({ parent: pa, rows })).toEqual({ done: 2, total: 2, partial: false })

    const partial = rowsOf([space({ nextCursor: 'more', items: [item({ id: 'pa' }), done({ id: 'a1', parentId: 'pa' })] })])
    const truncated = rowsOf([space({ truncated: true, items: [item({ id: 'pa' }), done({ id: 'a1', parentId: 'pa' })] })])
    for (const data of [partial, truncated]) {
      const lane = lanesOf(data).find((entry) => entry.id === 'c1::pa')
      if (lane === undefined) throw new Error('lane')
      expect(laneComplete({ lane, rows: data })).toBe(false)
    }
  })

  it('보드 밖 자식(백로그)도 센다 — 보드에 보이는 자식이 다 완료여도 백로그 자식이 미완이면 아님', () => {
    const rows = rowsOf([space({ items: [item({ id: 'pa' }), done({ id: 'a1', parentId: 'pa' }), item({ id: 'a2', parentId: 'pa', placement: 'backlog' })] })])
    const boardRows = rows.filter((row) => row.item.placement !== 'backlog')
    const lane = lanesOf(boardRows).find((entry) => entry.id === 'c1::pa')
    if (lane === undefined) throw new Error('lane')
    expect(laneComplete({ lane, rows })).toBe(false)
  })
})

describe('C1 보드 레인 순서', () => {
  const rows = rowsOf([space({ items: [
    // 순서 값: done1(0) < prog1(1) < done2(2) < prog2(3). 받는 중 부모 ghost 는 그 뒤.
    item({ id: 'done1', rank: '0' }), done({ id: 'x1', parentId: 'done1' }),
    item({ id: 'prog1', rank: '1' }), item({ id: 'y1', parentId: 'prog1' }), done({ id: 'y2', parentId: 'prog1' }),
    item({ id: 'done2', rank: '2' }), done({ id: 'z1', parentId: 'done2' }), done({ id: 'z2', parentId: 'done2' }),
    item({ id: 'prog2', rank: '3' }), item({ id: 'w1', parentId: 'prog2', statusKey: 'doing', category: 'in_progress' }),
    item({ id: 'g1', parentId: 'ghost' }),
  ] })])

  it('진행 레인(기존 순서) → 완료 레인(기존 순서) → 「부모 없음」, 완료 표시 동반', () => {
    const lanes = lanesOf(rows)
    expect(lanes.map((lane) => lane.id)).toEqual(['c1::done1', 'c1::prog1', 'c1::done2', 'c1::prog2', 'c1::ghost', 'none'])
    expect(boardLaneOrder({ lanes, rows }).map(({ lane, complete }) => [lane.id, complete])).toEqual([
      ['c1::prog1', false], ['c1::prog2', false], ['c1::ghost', false], ['c1::done1', true], ['c1::done2', true], ['none', false],
    ])
  })

  it('레인 수·행은 그대로(재배열만), 「부모 없음」 이 없으면 완료 레인이 끝', () => {
    const lanes = lanesOf(rows)
    const ordered = boardLaneOrder({ lanes, rows })
    expect(ordered.map(({ lane }) => lane).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...lanes].sort((a, b) => a.id.localeCompare(b.id)))
    const withParents = rows.filter((row) => row.item.parentId !== null)
    expect(boardLaneOrder({ lanes: lanesOf(withParents), rows }).map(({ lane }) => lane.id).at(-1)).toBe('c1::done2')
  })

  it('리스트 그룹 「부모」 순서는 그대로 — parentLanes 순서(완료 레인을 뒤로 보내지 않는다)', () => {
    const groups = groupRows({ rows, group: 'parent', statuses: STATUSES, all: false, parentOf: (row) => parentInfo({ connectionId: row.space.connectionId, item: row.item, rows, fetched: NONE }) })
    expect(groups.map((group) => group.id)).toEqual(lanesOf(rows).map((lane) => `parent:${lane.id}`))
    expect(groups[0]?.id).toBe('parent:c1::done1')
  })
})
