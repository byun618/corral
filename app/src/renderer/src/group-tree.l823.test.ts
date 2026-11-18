// LIFE-823 C1·C3 — 배치에 없던 탭을 들이는 이름 있는 배치 함수(삽입·가운데·분할)와 옆으로 열기의 오른쪽 이웃.
// 이미 배치에 있는 탭은 건드리지 않는다(같은 탭이 두 곳에 실리지 않는다 — C2 탭 id 중복 0 의 모델 쪽).

import { describe, expect, it } from 'vitest'
import {
  groupRects,
  insertNewTabAt,
  listGroups,
  openNewTabInGroup,
  reconcileLayout,
  rightNeighborGroupId,
  rightNeighborGroups,
  singleLayout,
  splitGroupWithNewTab,
  type GroupLayout,
  type GroupNode,
} from './group-tree.js'

const leafNode = (groupId: string, tabOrder: string[], activeTabId: string | null = tabOrder[0] ?? null): GroupNode => ({ kind: 'leaf', group: { groupId, tabOrder, activeTabId } })
const two = (): GroupLayout => ({
  root: { kind: 'split', direction: 'row', ratio: 0.5, first: leafNode('g1', ['t1', 't2', 't3'], 't2'), second: leafNode('g2', ['t4'], 't4') },
  activeGroupId: 'g1',
})
const allTabs = (layout: GroupLayout): string[] => listGroups(layout.root).flatMap((group) => group.tabOrder)

describe('insertNewTabAt — 탭바 삽입', () => {
  it('그 영역의 index 자리에 끼우고 그 영역·그 탭이 활성', () => {
    const next = insertNewTabAt({ layout: two(), tabId: 'file:a.ts', groupId: 'g1', index: 1 })
    expect(listGroups(next.root)[0]).toMatchObject({ tabOrder: ['t1', 'file:a.ts', 't2', 't3'], activeTabId: 'file:a.ts' })
    expect(next.activeGroupId).toBe('g1')
  })
  it('다른(비활성) 영역에도 — 맨 앞·맨 끝, 벗어난 index 는 clamp', () => {
    expect(listGroups(insertNewTabAt({ layout: two(), tabId: 'x', groupId: 'g2', index: 0 }).root)[1]?.tabOrder).toEqual(['x', 't4'])
    const end = insertNewTabAt({ layout: two(), tabId: 'x', groupId: 'g2', index: 99 })
    expect(listGroups(end.root)[1]?.tabOrder).toEqual(['t4', 'x'])
    expect(end.activeGroupId).toBe('g2')
    expect(listGroups(insertNewTabAt({ layout: two(), tabId: 'x', groupId: 'g2', index: -3 }).root)[1]?.tabOrder).toEqual(['x', 't4'])
  })
  it('이미 배치에 있는 탭이면(다른 영역이어도) 그대로 — 끼워 넣지 않는다', () => {
    const layout = two()
    expect(insertNewTabAt({ layout, tabId: 't4', groupId: 'g1', index: 0 })).toBe(layout)
    expect(insertNewTabAt({ layout, tabId: 't1', groupId: 'g1', index: 3 })).toBe(layout)
  })
  it('없는 영역이면 그대로', () => {
    const layout = two()
    expect(insertNewTabAt({ layout, tabId: 'x', groupId: 'g9', index: 0 })).toBe(layout)
  })
  it('미리보기 표시는 건드리지 않는다', () => {
    const withPreview: GroupLayout = { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['file:p.ts'], activeTabId: 'file:p.ts', previewTabId: 'file:p.ts' } }, activeGroupId: 'g1' }
    const next = insertNewTabAt({ layout: withPreview, tabId: 'file:q.ts', groupId: 'g1', index: 1 })
    expect(listGroups(next.root)[0]?.previewTabId).toBe('file:p.ts')
  })
})

describe('openNewTabInGroup — 가운데 열기', () => {
  it('그 영역의 활성 탭 바로 오른쪽', () => {
    const next = openNewTabInGroup({ layout: two(), tabId: 'x', groupId: 'g1' })
    expect(listGroups(next.root)[0]).toMatchObject({ tabOrder: ['t1', 't2', 'x', 't3'], activeTabId: 'x' })
    expect(next.activeGroupId).toBe('g1')
  })
  it('비활성 영역이면 그 영역을 활성으로', () => {
    const next = openNewTabInGroup({ layout: two(), tabId: 'x', groupId: 'g2' })
    expect(listGroups(next.root)[1]).toMatchObject({ tabOrder: ['t4', 'x'], activeTabId: 'x' })
    expect(next.activeGroupId).toBe('g2')
  })
  it('빈 영역(활성 탭 없음)이면 끝에', () => {
    const layout: GroupLayout = { root: leafNode('g1', [], null), activeGroupId: 'g1' }
    expect(listGroups(openNewTabInGroup({ layout, tabId: 'x', groupId: 'g1' }).root)[0]).toMatchObject({ tabOrder: ['x'], activeTabId: 'x' })
  })
  it('이미 있는 탭·없는 영역이면 그대로', () => {
    const layout = two()
    expect(openNewTabInGroup({ layout, tabId: 't3', groupId: 'g2' })).toBe(layout)
    expect(openNewTabInGroup({ layout, tabId: 'x', groupId: 'g9' })).toBe(layout)
  })
})

describe('splitGroupWithNewTab — 가장자리 분할', () => {
  it('네 방향 — right/down 은 뒤, left/up 은 앞에 새 영역, 새 영역 활성', () => {
    const right = splitGroupWithNewTab({ layout: two(), tabId: 'x', targetGroupId: 'g2', direction: 'row', edge: 'after', newGroupId: 'g3' })
    expect(listGroups(right.root).map((group) => group.groupId)).toEqual(['g1', 'g2', 'g3'])
    expect(right.activeGroupId).toBe('g3')
    expect(listGroups(right.root)[2]).toMatchObject({ tabOrder: ['x'], activeTabId: 'x' })
    const up = splitGroupWithNewTab({ layout: two(), tabId: 'x', targetGroupId: 'g1', direction: 'column', edge: 'before', newGroupId: 'g3' })
    expect(up.root.kind === 'split' && up.root.first.kind === 'split' ? up.root.first : null).toMatchObject({ direction: 'column', first: { group: { groupId: 'g3' } }, second: { group: { groupId: 'g1' } } })
    const left = splitGroupWithNewTab({ layout: two(), tabId: 'x', targetGroupId: 'g2', direction: 'row', edge: 'before', newGroupId: 'g3' })
    expect(listGroups(left.root).map((group) => group.groupId)).toEqual(['g1', 'g3', 'g2'])
    const down = splitGroupWithNewTab({ layout: two(), tabId: 'x', targetGroupId: 'g2', direction: 'column', edge: 'after', newGroupId: 'g3' })
    expect(down.root.kind === 'split' ? down.root.second : null).toMatchObject({ kind: 'split', direction: 'column', first: { group: { groupId: 'g2' } }, second: { group: { groupId: 'g3' } } })
  })
  it('탭 1개 영역 가장자리도 된다 — 화면 배치(reconcileLayout)를 거쳐도 두 영역', () => {
    const one = singleLayout({ groupId: 'g1', tabOrder: ['t1'], activeTabId: 't1' })
    const next = splitGroupWithNewTab({ layout: one, tabId: 'file:x.ts', targetGroupId: 'g1', direction: 'row', edge: 'after', newGroupId: 'g2' })
    const shown = reconcileLayout({ layout: next, liveTabIds: ['t1'] })
    expect(listGroups(shown.root).map((group) => group.tabOrder)).toEqual([['t1'], ['file:x.ts']])
  })
  it('F1 빈 영역 가장자리 분할은 화면 배치에서 한 영역으로 접힌다 — 그래서 끌기 판정이 빈 영역을 열기로 본다(tab-drag)', () => {
    const empty: GroupLayout = { root: leafNode('g1', [], null), activeGroupId: 'g1' }
    const split = splitGroupWithNewTab({ layout: empty, tabId: 'file:x.ts', targetGroupId: 'g1', direction: 'row', edge: 'before', newGroupId: 'g2' })
    expect(listGroups(reconcileLayout({ layout: split, liveTabIds: [] }).root).map((group) => group.tabOrder)).toEqual([['file:x.ts']])
    const opened = openNewTabInGroup({ layout: empty, tabId: 'file:x.ts', groupId: 'g1' })
    expect(listGroups(reconcileLayout({ layout: opened, liveTabIds: [] }).root).map((group) => ({ groupId: group.groupId, tabs: group.tabOrder }))).toEqual([{ groupId: 'g1', tabs: ['file:x.ts'] }])
  })
  it('이미 있는 탭·없는 대상·이미 쓰는 새 영역 id 면 그대로', () => {
    const layout = two()
    expect(splitGroupWithNewTab({ layout, tabId: 't1', targetGroupId: 'g2', direction: 'row', edge: 'after', newGroupId: 'g3' })).toBe(layout)
    expect(splitGroupWithNewTab({ layout, tabId: 'x', targetGroupId: 'g9', direction: 'row', edge: 'after', newGroupId: 'g3' })).toBe(layout)
    expect(splitGroupWithNewTab({ layout, tabId: 'x', targetGroupId: 'g1', direction: 'row', edge: 'after', newGroupId: 'g2' })).toBe(layout)
  })
  it('탭 수 보존 — 새 탭 하나만 늘고 중복 없음', () => {
    const next = splitGroupWithNewTab({ layout: two(), tabId: 'x', targetGroupId: 'g1', direction: 'row', edge: 'after', newGroupId: 'g3' })
    expect(allTabs(next).sort()).toEqual(['t1', 't2', 't3', 't4', 'x'])
  })
})

const split = (direction: 'row' | 'column', first: GroupNode, second: GroupNode, ratio = 0.5): GroupNode => ({ kind: 'split', direction, ratio, first, second })
const right = (root: GroupNode, groupId: string): string | null => rightNeighborGroupId({ root, groupId })

describe('groupRects — 분할 비율로 영역 사각형', () => {
  it('row 는 좌우·column 은 위아래, ratio 는 앞쪽 몫', () => {
    const rects = groupRects(split('row', leafNode('A', ['a']), split('column', leafNode('B', ['b']), leafNode('C', ['c']), 0.25), 0.4))
    expect(rects.get('A')).toEqual({ left: 0, top: 0, width: 0.4, height: 1 })
    expect(rects.get('B')?.top).toBe(0)
    expect(rects.get('B')?.height).toBeCloseTo(0.25)
    expect(rects.get('C')?.left).toBeCloseTo(0.4)
    expect(rects.get('C')?.top).toBeCloseTo(0.25)
  })
})

describe('rightNeighborGroupId — 옆으로 열기 대상(P3·F2): 오른쪽 변과 세로 구간이 겹치는 영역', () => {
  it('좌우 둘 — 왼쪽의 오른쪽 이웃은 오른쪽, 가장 오른쪽은 null', () => {
    expect(right(two().root, 'g1')).toBe('g2')
    expect(right(two().root, 'g2')).toBeNull()
  })
  it('한 영역·위아래만이면 null', () => {
    expect(right(leafNode('g1', ['t1']), 'g1')).toBeNull()
    expect(right(split('column', leafNode('g1', ['t1']), leafNode('g2', ['t2'])), 'g1')).toBeNull()
  })
  it('F2 2×2 (row(column(A,C), column(B,D))) — 아래-왼쪽 C 의 이웃은 아래-오른쪽 D, 위-왼쪽 A 는 B', () => {
    const grid = split('row', split('column', leafNode('A', ['a']), leafNode('C', ['c'])), split('column', leafNode('B', ['b']), leafNode('D', ['d'])))
    expect(right(grid, 'C')).toBe('D')
    expect(right(grid, 'A')).toBe('B')
    expect(right(grid, 'B')).toBeNull()
  })
  it('2×2 (column(row(A,B), row(C,D))) — C → D', () => {
    const grid = split('column', split('row', leafNode('A', ['a']), leafNode('B', ['b'])), split('row', leafNode('C', ['c']), leafNode('D', ['d'])))
    expect(right(grid, 'C')).toBe('D')
    expect(right(grid, 'A')).toBe('B')
  })
  it('꽉 찬 왼쪽 → 오른쪽 열 둘 다 이웃, 겹침이 같으면 위', () => {
    const tree = split('row', leafNode('g1', ['t1']), split('column', leafNode('g2', ['t2']), leafNode('g3', ['t3'])))
    expect(rightNeighborGroups({ root: tree, groupId: 'g1' }).map((neighbor) => neighbor.groupId).sort()).toEqual(['g2', 'g3'])
    expect(right(tree, 'g1')).toBe('g2')
  })
  it('겹침이 큰 쪽 — 오른쪽 열이 30:70 이면 아래', () => {
    const tree = split('row', leafNode('g1', ['t1']), split('column', leafNode('g2', ['t2']), leafNode('g3', ['t3']), 0.3))
    expect(right(tree, 'g1')).toBe('g3')
  })
  it('끝점만 닿는 것은 이웃이 아니다 — 위 칸끼리 다른 비율이어도 겹침으로', () => {
    // 왼쪽 열 위 50% · 오른쪽 열 위 50% 경계가 같으면 아래-왼쪽과 위-오른쪽은 끝점만 닿는다
    const grid = split('row', split('column', leafNode('A', ['a']), leafNode('C', ['c'])), split('column', leafNode('B', ['b']), leafNode('D', ['d'])))
    expect(rightNeighborGroups({ root: grid, groupId: 'C' }).map((neighbor) => neighbor.groupId)).toEqual(['D'])
    // 오른쪽 열을 60:40 으로 — 아래-왼쪽(0.5~1)은 B(0~0.6)와 0.1, D(0.6~1)와 0.4 겹친다 → D
    const skew = split('row', split('column', leafNode('A', ['a']), leafNode('C', ['c'])), split('column', leafNode('B', ['b']), leafNode('D', ['d']), 0.6))
    expect(rightNeighborGroups({ root: skew, groupId: 'C' }).map((neighbor) => neighbor.groupId).sort()).toEqual(['B', 'D'])
    expect(right(skew, 'C')).toBe('D')
  })
  it('세로 분할 안쪽 영역은 바깥 가로 분할의 오른쪽으로, 없는 영역은 null', () => {
    const tree = split('row', split('column', leafNode('g1', ['t1']), leafNode('g2', ['t2'])), leafNode('g3', ['t3']))
    expect(right(tree, 'g2')).toBe('g3')
    expect(right(tree, 'g3')).toBeNull()
    expect(right(tree, 'g9')).toBeNull()
  })
})
