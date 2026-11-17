// LIFE-825 — 영역 레이아웃 조작의 순수 판정: 닫기 목적지(C1)·같은 방향 줄 균등(C2·C3)·최대화 유효(C4)·새 탭 자리(C5).
import { describe, expect, it } from 'vitest'
import {
  closeGroup,
  closeGroupHeir,
  evenAllGroups,
  evenGroupRunAt,
  findGroup,
  layoutShapeKey,
  listGroups,
  maximizedGroupOf,
  newTabPlacement,
  newTabSlotKey,
  newTabSlotOf,
  partitionPinnedLayout,
  RATIO_MIN,
  reconcileLayout,
  removeTabFromGroup,
  splitIdOf,
  unrememberedArrivalBranch,
  type GroupLayout,
  type GroupNode,
} from './group-tree.js'

const leaf = (groupId: string, tabOrder: string[], activeTabId: string | null = tabOrder[0] ?? null): GroupNode => ({ kind: 'leaf', group: { groupId, tabOrder, activeTabId } })
const split = (direction: 'row' | 'column', first: GroupNode, second: GroupNode, ratio = 0.5): GroupNode => ({ kind: 'split', direction, ratio, first, second })

/** 가로: g1 | g2 | g3 (row(g1, row(g2, g3))) */
const ROW = (activeGroupId = 'g2'): GroupLayout => ({ root: split('row', leaf('g1', ['a']), split('row', leaf('g2', ['b', 'c'], 'c'), leaf('g3', ['d']))), activeGroupId })
/** 세로: g1 / g2 / g3 */
const COLUMN = (activeGroupId = 'g2'): GroupLayout => ({ root: split('column', leaf('g1', ['a']), split('column', leaf('g2', ['b', 'c'], 'c'), leaf('g3', ['d']))), activeGroupId })
/** 중첩: g1 | (g2 / g3), g2 는 위·g3 는 아래, 왼쪽 g1 은 둘에 맞닿는다. */
const NESTED = (activeGroupId = 'g1'): GroupLayout => ({ root: split('row', leaf('g1', ['a', 'b'], 'b'), split('column', leaf('g2', ['c']), leaf('g3', ['d']))), activeGroupId })

const ratios = (node: GroupNode): number[] => (node.kind === 'leaf' ? [] : [node.ratio, ...ratios(node.first), ...ratios(node.second)])

describe('C1 closeGroupHeir — 영역 MRU → 공간 이웃', () => {
  it('ⓐ MRU 가 있으면 닫는 영역 다음으로 최근 — 가로·세로·중첩', () => {
    expect(closeGroupHeir({ root: ROW().root, groupId: 'g2', recent: ['g2', 'g3', 'g1'] })).toBe('g3')
    expect(closeGroupHeir({ root: COLUMN().root, groupId: 'g2', recent: ['g2', 'g1', 'g3'] })).toBe('g1')
    expect(closeGroupHeir({ root: NESTED().root, groupId: 'g1', recent: ['g1', 'g3', 'g2'] })).toBe('g3')
  })
  it('ⓐ 닫는 영역이 활성이 아니면 MRU 첫째(= 활성 영역)', () => {
    expect(closeGroupHeir({ root: ROW().root, groupId: 'g1', recent: ['g3', 'g1', 'g2'] })).toBe('g3')
  })
  it('ⓐ MRU 의 죽은 id 는 건너뛴다', () => {
    expect(closeGroupHeir({ root: ROW().root, groupId: 'g2', recent: ['g9', 'g2', 'g1'] })).toBe('g1')
  })
  it('ⓑ MRU 가 비면 공간 이웃 — 닫는 영역 자리를 차지하는 형제 쪽에서 맞닿은 영역(가로·세로)', () => {
    // g2 는 row(g2, g3) 의 앞 → 형제는 오른쪽 g3
    expect(closeGroupHeir({ root: ROW().root, groupId: 'g2', recent: [] })).toBe('g3')
    // g3 는 뒤 → 형제는 왼쪽 g2(맞닿음). 트리 첫 영역 g1 이 아니다 — base 와 다른 갈래.
    expect(closeGroupHeir({ root: ROW().root, groupId: 'g3', recent: [] })).toBe('g2')
    expect(closeGroupHeir({ root: COLUMN().root, groupId: 'g3', recent: [] })).toBe('g2')
    expect(closeGroupHeir({ root: COLUMN().root, groupId: 'g1', recent: [] })).toBe('g2')
  })
  it('ⓑ 중첩 — 형제 쪽 이웃이 여럿이면 겹침 최대, 동점이면 위', () => {
    expect(closeGroupHeir({ root: NESTED().root, groupId: 'g1', recent: [] })).toBe('g2')
    const tall: GroupLayout = { root: split('row', leaf('g1', ['a']), split('column', leaf('g2', ['c']), leaf('g3', ['d']), 0.3)), activeGroupId: 'g1' }
    expect(closeGroupHeir({ root: tall.root, groupId: 'g1', recent: [] })).toBe('g3')
    // g3(아래)를 닫으면 형제는 위 g2
    expect(closeGroupHeir({ root: NESTED().root, groupId: 'g3', recent: [] })).toBe('g2')
  })
  it('ⓔ 영역 1개·모르는 영역은 null', () => {
    expect(closeGroupHeir({ root: leaf('g1', ['a']), groupId: 'g1', recent: [] })).toBeNull()
    expect(closeGroupHeir({ root: ROW().root, groupId: 'gX', recent: [] })).toBeNull()
  })
})

describe('C1 closeGroup — 탭·활성', () => {
  it('ⓐⓒ 활성 영역을 닫으면 남은 탭이 받는 영역 끝에 base 상대 순서대로, 받는 영역이 활성, 닫는 영역의 활성 탭이 받는 영역의 활성 탭', () => {
    const closed = closeGroup(ROW('g2'), 'g2', { recent: ['g2', 'g3', 'g1'] })
    expect(findGroup(closed.root, 'g3')).toEqual({ groupId: 'g3', tabOrder: ['d', 'b', 'c'], activeTabId: 'c' })
    expect(closed.activeGroupId).toBe('g3')
    expect(findGroup(closed.root, 'g1')?.tabOrder).toEqual(['a'])
  })
  it('ⓒ 활성이 아닌 영역을 닫으면 활성·받는 영역의 활성 탭 그대로', () => {
    const closed = closeGroup(ROW('g1'), 'g2', { recent: ['g1', 'g2'] })
    expect(closed.activeGroupId).toBe('g1')
    expect(findGroup(closed.root, 'g1')).toEqual({ groupId: 'g1', tabOrder: ['a', 'b', 'c'], activeTabId: 'a' })
  })
  it('ⓑ MRU 없이 — 공간 이웃으로(가로·세로·중첩)', () => {
    expect(findGroup(closeGroup(ROW('g3'), 'g3').root, 'g2')?.tabOrder).toEqual(['b', 'c', 'd'])
    expect(closeGroup(ROW('g3'), 'g3').activeGroupId).toBe('g2')
    expect(findGroup(closeGroup(COLUMN('g1'), 'g1').root, 'g2')?.tabOrder).toEqual(['b', 'c', 'a'])
    const nested = closeGroup(NESTED('g1'), 'g1')
    expect(findGroup(nested.root, 'g2')).toEqual({ groupId: 'g2', tabOrder: ['c', 'a', 'b'], activeTabId: 'b' })
    expect(nested.activeGroupId).toBe('g2')
  })
  it('ⓓ 빈 영역 닫기 — 넘길 탭 없이 활성 규칙만', () => {
    const withEmpty: GroupLayout = { root: split('row', leaf('g1', ['a']), leaf('g2', [])), activeGroupId: 'g2' }
    const closed = closeGroup(withEmpty, 'g2', { recent: ['g2', 'g1'] })
    expect(closed.activeGroupId).toBe('g1')
    expect(listGroups(closed.root)).toEqual([{ groupId: 'g1', tabOrder: ['a'], activeTabId: 'a' }])
    const inactive = closeGroup({ ...withEmpty, activeGroupId: 'g1' }, 'g2')
    expect(inactive.activeGroupId).toBe('g1')
  })
  it('ⓔ 영역 1개면 같은 객체', () => {
    const one: GroupLayout = { root: leaf('g1', ['a']), activeGroupId: 'g1' }
    expect(closeGroup(one, 'g1', { recent: ['g1'] })).toBe(one)
  })
  it('ⓕ 끌어내 영역이 빌 때(collapseEmptyGroup) 결과는 base 그대로 — 활성 영역이 사라지면 트리 첫 영역', () => {
    const collapsed = removeTabFromGroup(ROW('g3'), 'g3', 'd')
    expect(listGroups(collapsed.root).map((group) => group.groupId)).toEqual(['g1', 'g2'])
    expect(collapsed.activeGroupId).toBe('g1')
  })
  it('ⓖ 핀 탭은 받는 영역의 핀 구간으로', () => {
    const pinned = new Set(['p'])
    const layout: GroupLayout = { root: split('row', leaf('g1', ['p', 'x'], 'p'), leaf('g2', ['a', 'b'])), activeGroupId: 'g1' }
    const closed = partitionPinnedLayout({ layout: closeGroup(layout, 'g1', { recent: ['g1', 'g2'] }), pinned })
    expect(findGroup(closed.root, 'g2')?.tabOrder).toEqual(['p', 'a', 'b', 'x'])
    expect(findGroup(closed.root, 'g2')?.activeTabId).toBe('p')
  })
})

describe('C2 evenGroupRunAt — 경계를 가진 같은 방향 줄만 고르게', () => {
  it('row(A, row(B, C)) — 어느 경계든 A·B·C 각 1/3', () => {
    const layout: GroupLayout = { root: split('row', leaf('A', ['a']), split('row', leaf('B', ['b']), leaf('C', ['c']), 0.7), 0.2), activeGroupId: 'A' }
    const inner = layout.root.kind === 'split' && layout.root.second.kind === 'split' ? splitIdOf(layout.root.second) : ''
    for (const splitId of [splitIdOf({ first: leaf('A', []), second: leaf('B', []) }), inner]) {
      const even = evenGroupRunAt(layout, splitId)
      const [outer, nested] = ratios(even.root)
      expect(outer).toBeCloseTo(1 / 3)
      expect(nested).toBeCloseTo(1 / 2)
    }
  })
  it('row(A, column(B, C)) — row 경계는 A·(B,C) 반반, 안쪽 column 비율은 그대로(재귀 아님)', () => {
    const layout: GroupLayout = { root: split('row', leaf('A', ['a']), split('column', leaf('B', ['b']), leaf('C', ['c']), 0.8), 0.3), activeGroupId: 'A' }
    const even = evenGroupRunAt(layout, 'A|B')
    expect(ratios(even.root)).toEqual([0.5, 0.8])
    // 안쪽 경계는 그 줄(B·C)만
    expect(ratios(evenGroupRunAt(layout, 'B|C').root)).toEqual([0.3, 0.5])
  })
  it('다른 줄의 비율은 그대로 — column(row(A,B), row(C,D)) 에서 위 줄만', () => {
    const layout: GroupLayout = { root: split('column', split('row', leaf('A', []), leaf('B', []), 0.2), split('row', leaf('C', []), leaf('D', []), 0.7), 0.4), activeGroupId: 'A' }
    expect(ratios(evenGroupRunAt(layout, 'A|B').root)).toEqual([0.4, 0.5, 0.7])
  })
  it('클램프에 걸리는 줄 — 8칸 줄의 첫 마디는 1/8 대신 RATIO_MIN', () => {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    const chain = (rest: string[]): GroupNode => (rest.length === 1 ? leaf(rest[0] ?? '', []) : split('row', leaf(rest[0] ?? '', []), chain(rest.slice(1)), 0.5))
    const even = evenGroupRunAt({ root: chain(ids), activeGroupId: 'A' }, 'A|B')
    expect(ratios(even.root)[0]).toBe(RATIO_MIN)
    expect(ratios(even.root).at(-1)).toBeCloseTo(0.5)
  })
  it('바뀔 것이 없거나 모르는 경계면 같은 객체', () => {
    const layout: GroupLayout = { root: split('row', leaf('A', []), leaf('B', [])), activeGroupId: 'A' }
    expect(evenGroupRunAt(layout, 'A|B')).toBe(layout)
    expect(evenGroupRunAt(layout, 'X|Y')).toBe(layout)
  })
})

describe('C3 evenAllGroups — 모든 줄 재귀 균등', () => {
  it('중첩 배치의 모든 줄을 고르게', () => {
    const layout: GroupLayout = { root: split('row', leaf('A', []), split('row', leaf('B', []), split('column', leaf('C', []), leaf('D', []), 0.8), 0.2), 0.7), activeGroupId: 'A' }
    const [outer, middle, inner] = ratios(evenAllGroups(layout).root)
    expect(outer).toBeCloseTo(1 / 3)
    expect(middle).toBeCloseTo(1 / 2)
    expect(inner).toBeCloseTo(1 / 2)
  })
  it('영역 1개면 같은 객체', () => {
    const one: GroupLayout = { root: leaf('A', []), activeGroupId: 'A' }
    expect(evenAllGroups(one)).toBe(one)
  })
})

describe('C4 maximizedGroupOf — 해제 조건을 한 자리에서', () => {
  const layout = NESTED('g2')
  const maximize = { groupId: 'g2', shape: layoutShapeKey(layout.root) }
  it('모양 키는 방향·영역 id 만(비율·탭 무관)', () => {
    expect(layoutShapeKey(layout.root)).toBe('row(g1,column(g2,g3))')
    expect(layoutShapeKey(evenAllGroups(layout).root)).toBe(layoutShapeKey(layout.root))
  })
  it('기록 · 모양 그대로 · 그 영역 활성이면 최대화', () => {
    expect(maximizedGroupOf({ layout, maximize })).toBe('g2')
  })
  it('숨은 영역 활성이면 풀림', () => {
    expect(maximizedGroupOf({ layout: { ...layout, activeGroupId: 'g3' }, maximize })).toBeNull()
  })
  it('모양이 바뀌면(닫기·분할) 풀림 · 영역 1개면 풀림 · 기록 없으면 null', () => {
    expect(maximizedGroupOf({ layout: closeGroup(layout, 'g3'), maximize })).toBeNull()
    expect(maximizedGroupOf({ layout: { root: leaf('g2', ['c']), activeGroupId: 'g2' }, maximize: { groupId: 'g2', shape: 'g2' } })).toBeNull()
    expect(maximizedGroupOf({ layout, maximize: undefined })).toBeNull()
  })
})

describe('C5 새 터미널 탭 자리', () => {
  it('newTabSlotOf — 요청 순간의 활성 영역·활성 탭', () => {
    expect(newTabSlotOf(ROW('g2'))).toEqual({ groupId: 'g2', afterTabId: 'c' })
    expect(newTabSlotOf({ root: split('row', leaf('g1', []), leaf('g2', ['a'])), activeGroupId: 'g1' })).toEqual({ groupId: 'g1', afterTabId: null })
  })
  it('ⓐ newTabPlacement — 기억한 탭 바로 오른쪽(새 탭을 뺀 순서 기준)', () => {
    // 새 탭 n 이 도착 때 자리(다른 영역 g1 의 a 오른쪽)에 있어도 기억한 g2·b 오른쪽으로
    const arrived: GroupLayout = { root: split('row', leaf('g1', ['a', 'n']), leaf('g2', ['b', 'c'], 'c')), activeGroupId: 'g1' }
    expect(newTabPlacement({ layout: arrived, slot: { groupId: 'g2', afterTabId: 'b' }, tabId: 'n' })).toEqual({ groupId: 'g2', index: 1 })
    // 같은 영역 안 — 새 탭이 이미 끝에 있어도 기억한 b 바로 오른쪽
    const same: GroupLayout = { root: leaf('g2', ['b', 'c', 'n'], 'c'), activeGroupId: 'g2' }
    expect(newTabPlacement({ layout: same, slot: { groupId: 'g2', afterTabId: 'b' }, tabId: 'n' })).toEqual({ groupId: 'g2', index: 1 })
  })
  it('ⓐ 기억한 탭이 사라졌으면 그 영역의 지금 활성 탭 오른쪽, 그것도 없으면 끝', () => {
    const layout: GroupLayout = { root: leaf('g2', ['x', 'c', 'y'], 'c'), activeGroupId: 'g2' }
    expect(newTabPlacement({ layout, slot: { groupId: 'g2', afterTabId: 'gone' }, tabId: 'n' })).toEqual({ groupId: 'g2', index: 2 })
    expect(newTabPlacement({ layout: { root: leaf('g2', ['x', 'n'], 'n'), activeGroupId: 'g2' }, slot: { groupId: 'g2', afterTabId: null }, tabId: 'n' })).toEqual({ groupId: 'g2', index: 1 })
  })
  it('ⓑ 기억한 영역이 사라졌으면 null — 도착 때 자리 그대로', () => {
    expect(newTabPlacement({ layout: ROW(), slot: { groupId: 'g9', afterTabId: 'b' }, tabId: 'n' })).toBeNull()
  })
  it('ⓒ 요청 없이 도착한 탭 — reconcileLayout 이 도착 때 활성 영역·활성 탭 오른쪽에 둔다(여럿이면 순서대로)', () => {
    const shown = reconcileLayout({ layout: ROW('g2'), liveTabIds: ['a', 'b', 'c', 'd', 'n1', 'n2'] })
    // 활성 g2 의 활성 탭 c 오른쪽 — c 가 끝이라 끝과 같아 보이지 않게 활성을 b 로 둔 경우도 본다
    expect(findGroup(shown.root, 'g2')?.tabOrder).toEqual(['b', 'c', 'n1', 'n2'])
    const mid: GroupLayout = { ...ROW('g2'), root: split('row', leaf('g1', ['a']), split('row', leaf('g2', ['b', 'c'], 'b'), leaf('g3', ['d']))) }
    expect(findGroup(reconcileLayout({ layout: mid, liveTabIds: ['a', 'b', 'c', 'd', 'n'] }).root, 'g2')?.tabOrder).toEqual(['b', 'n', 'c'])
    expect(findGroup(reconcileLayout({ layout: mid, liveTabIds: ['a', 'b', 'c', 'd', 'n'] }).root, 'g2')?.activeTabId).toBe('b')
  })
  it('ⓓ 복원 실패 회차(맞은 터미널 0)는 base 그대로 — 첫 영역 끝', () => {
    const restored = reconcileLayout({ layout: ROW('g2'), liveTabIds: ['x1', 'x2'] })
    expect(listGroups(restored.root).map((group) => [group.groupId, group.tabOrder])).toEqual([['g1', ['x1', 'x2']]])
  })
  it('ⓕ 활성 탭이 핀이면 핀 경계로', () => {
    const pinned = new Set(['p1', 'p2'])
    const layout: GroupLayout = { root: leaf('g1', ['p1', 'p2', 'a'], 'p1'), activeGroupId: 'g1' }
    const shown = partitionPinnedLayout({ layout: reconcileLayout({ layout, liveTabIds: ['p1', 'p2', 'a', 'n'], pinned }), pinned })
    expect(findGroup(shown.root, 'g1')?.tabOrder).toEqual(['p1', 'p2', 'n', 'a'])
  })
})

describe('fix1 B2 — 연속 새 탭 요청: 화면 순서 = 요청 순서(도착 순서 무관)', () => {
  const slot = { groupId: 'g1', afterTabId: 't1' }
  const base: GroupLayout = { root: leaf('g1', ['t1', 't2'], 't1'), activeGroupId: 'g1' }
  /** 도착 = reconcile 착지(활성 탭 오른쪽) 뒤 기억 자리로 옮긴다 — App 의 두 단계를 순수 함수로 그대로. */
  const arrive = (layout: GroupLayout, tabId: string, precedingTabIds: string[]): GroupLayout => {
    const live = [...listGroups(layout.root).flatMap((group) => group.tabOrder), tabId]
    const landed = reconcileLayout({ layout, liveTabIds: live })
    const target = newTabPlacement({ layout: landed, slot, tabId, precedingTabIds })
    if (target === null) return landed
    const group = findGroup(landed.root, target.groupId)
    const order = (group?.tabOrder ?? []).filter((id) => id !== tabId)
    return { ...landed, root: leaf('g1', [...order.slice(0, target.index), tabId, ...order.slice(target.index)], 't1') }
  }
  it('첫 요청(a) 먼저 도착 → 둘째(b, 앞선 a) 도착: t1, a, b, t2', () => {
    const afterA = arrive(base, 'a', [])
    expect(findGroup(afterA.root, 'g1')?.tabOrder).toEqual(['t1', 'a', 't2'])
    expect(findGroup(arrive(afterA, 'b', ['a']).root, 'g1')?.tabOrder).toEqual(['t1', 'a', 'b', 't2'])
  })
  it('둘째(b) 먼저 도착 → 첫 요청(a) 도착: 역시 t1, a, b, t2', () => {
    const afterB = arrive(base, 'b', ['a'])
    expect(findGroup(afterB.root, 'g1')?.tabOrder).toEqual(['t1', 'b', 't2'])
    expect(findGroup(arrive(afterB, 'a', []).root, 'g1')?.tabOrder).toEqual(['t1', 'a', 'b', 't2'])
  })
  it('앞선 요청 탭이 기준 탭 바로 뒤에 이어 서 있지 않으면(사용자가 옮김) 기준 탭 바로 뒤', () => {
    const moved: GroupLayout = { root: leaf('g1', ['t1', 't2', 'a'], 't1'), activeGroupId: 'g1' }
    expect(newTabPlacement({ layout: moved, slot, tabId: 'b', precedingTabIds: ['a'] })).toEqual({ groupId: 'g1', index: 1 })
  })
  it('자리 키 — 영역·기준 탭이 같으면 같은 키', () => {
    expect(newTabSlotKey(slot)).toBe(newTabSlotKey({ groupId: 'g1', afterTabId: 't1' }))
    expect(newTabSlotKey(slot)).not.toBe(newTabSlotKey({ groupId: 'g1', afterTabId: 't2' }))
    expect(newTabSlotKey({ groupId: 'g1', afterTabId: null })).not.toBe(newTabSlotKey(slot))
  })
})

describe('fix1 B5 — 기억 없는 도착의 갈래 이름', () => {
  it('⌘⇧T 다시 열기 탭은 「다시 열기」, 그 밖 처음 본 탭은 「기억 없음」, 이미 본 탭은 로그 없음', () => {
    expect(unrememberedArrivalBranch({ firstSeen: true, reopening: true })).toBe('reopen')
    expect(unrememberedArrivalBranch({ firstSeen: true, reopening: false })).toBe('unremembered')
    expect(unrememberedArrivalBranch({ firstSeen: false, reopening: true })).toBeNull()
  })
})
