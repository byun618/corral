// LIFE-495 K3ⓓ — 핀 접두부 불변식: 모든 순서 변경 뒤에도 핀 탭은 tabOrder 의 맨 앞 연속 구간이다.
import { describe, expect, it } from 'vitest'
import {
  findGroup,
  listGroups,
  mergeTabIntoGroup,
  moveTabWithinTabbar,
  partitionPinnedLayout,
  partitionPinnedOrder,
  placeTab,
  reconcileLayout,
  singleLayout,
  splitGroup,
  type GroupLayout,
} from './group-tree.js'

const orderOf = (layout: GroupLayout, groupId = 'g1'): string[] => findGroup(layout.root, groupId)?.tabOrder ?? []
/** 불변식 — 모든 영역에서 핀 탭이 앞 구간에 모여 있다. */
function prefixHolds(layout: GroupLayout, pinned: ReadonlySet<string>): boolean {
  return listGroups(layout.root).every((group) => {
    const firstUnpinned = group.tabOrder.findIndex((tabId) => !pinned.has(tabId))
    return firstUnpinned === -1 || group.tabOrder.slice(firstUnpinned).every((tabId) => !pinned.has(tabId))
  })
}
const base = singleLayout({ groupId: 'g1', tabOrder: ['a', 'b', 'c', 'd'], activeTabId: 'a' })

describe('partitionPinnedOrder', () => {
  it('pin — 핀 구간의 끝으로(220 partitionPinnedTabOrder 와 같다)', () => {
    expect(partitionPinnedOrder(['p', 'a', 'b', 'c'], new Set(['p', 'c']))).toEqual(['p', 'c', 'a', 'b'])
  })
  it('unpin — 남은 핀 바로 뒤(첫 핀 아닌 자리)로', () => {
    // [p1, x, p2, a] 에서 x 를 풀었다 = 핀 집합 {p1, p2}
    expect(partitionPinnedOrder(['p1', 'x', 'p2', 'a'], new Set(['p1', 'p2']))).toEqual(['p1', 'p2', 'x', 'a'])
  })
  it('바뀔 게 없으면 같은 배열(참조)을 돌려준다', () => {
    const order = ['p', 'a']
    expect(partitionPinnedOrder(order, new Set(['p']))).toBe(order)
    expect(partitionPinnedOrder(order, new Set())).toBe(order)
  })
})

describe('partitionPinnedLayout — 순서 변경 경우별', () => {
  const pinned = new Set(['a', 'b'])
  const pinnedBase = partitionPinnedLayout(base, pinned)

  it('드래그 — 핀 탭을 핀 아닌 탭 뒤로 끌면 경계에 붙는다', () => {
    const dragged = partitionPinnedLayout(moveTabWithinTabbar(pinnedBase, { tabId: 'a', fromGroupId: 'g1', toGroupId: 'g1', index: 3 }), pinned)
    expect(orderOf(dragged)).toEqual(['b', 'a', 'c', 'd'])
    expect(prefixHolds(dragged, pinned)).toBe(true)
  })
  it('드래그 — 핀 아닌 탭을 핀 구간 안으로 끌면 경계 뒤에 붙는다', () => {
    const dragged = partitionPinnedLayout(moveTabWithinTabbar(pinnedBase, { tabId: 'd', fromGroupId: 'g1', toGroupId: 'g1', index: 0 }), pinned)
    expect(orderOf(dragged)).toEqual(['a', 'b', 'd', 'c'])
  })
  it('새 탭 — 끝에 붙는다(핀 구간 밖)', () => {
    const grown = partitionPinnedLayout(reconcileLayout({ layout: pinnedBase, liveTabIds: ['a', 'b', 'c', 'd', 'e'] }), pinned)
    expect(orderOf(grown)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  it('다시 열기(자리 복원) — 핀 구간 안쪽 자리면 경계로 clamp', () => {
    const live = reconcileLayout({ layout: pinnedBase, liveTabIds: ['a', 'b', 'c', 'd', 'r'] })
    const placed = partitionPinnedLayout(placeTab(live, { tabId: 'r', groupId: 'g1', index: 0 }), pinned)
    expect(orderOf(placed)).toEqual(['a', 'b', 'r', 'c', 'd'])
    expect(findGroup(placed.root, 'g1')?.activeTabId).toBe('r')
  })
  it('영역 간 이동·병합 — 핀은 따라가고 그 영역의 핀 구간 끝에 선다(U6)', () => {
    const split = partitionPinnedLayout(splitGroup({ layout: pinnedBase, groupId: 'g1', tabId: 'c', direction: 'row', newGroupId: 'g2' }), pinned)
    expect(orderOf(split, 'g2')).toEqual(['c'])
    const moved = partitionPinnedLayout(moveTabWithinTabbar(split, { tabId: 'a', fromGroupId: 'g1', toGroupId: 'g2', index: 1 }), pinned)
    expect(orderOf(moved, 'g2')).toEqual(['a', 'c'])
    const merged = partitionPinnedLayout(mergeTabIntoGroup(moved, { tabId: 'b', fromGroupId: 'g1', toGroupId: 'g2' }), pinned)
    expect(orderOf(merged, 'g2')).toEqual(['a', 'b', 'c'])
    expect(prefixHolds(merged, pinned)).toBe(true)
  })
  it('분할 — 남은 영역도 접두부를 지킨다', () => {
    const split = partitionPinnedLayout(splitGroup({ layout: pinnedBase, groupId: 'g1', tabId: 'a', direction: 'column', edge: 'before', newGroupId: 'g2' }), pinned)
    expect(orderOf(split)).toEqual(['b', 'c', 'd'])
    expect(prefixHolds(split, pinned)).toBe(true)
  })
  it('핀이 없으면 배치를 그대로(같은 객체) 돌려준다', () => {
    expect(partitionPinnedLayout(base, new Set())).toBe(base)
    expect(partitionPinnedLayout(pinnedBase, pinned)).toBe(pinnedBase)
  })
})

describe('placeTab', () => {
  it('영역이 없거나 탭이 배치에 없으면 그대로다', () => {
    expect(placeTab(base, { tabId: 'a', groupId: 'nope', index: 0 })).toBe(base)
    expect(placeTab(base, { tabId: 'zz', groupId: 'g1', index: 0 })).toBe(base)
  })
  it('자리는 0~길이로 clamp 된다', () => {
    expect(orderOf(placeTab(base, { tabId: 'a', groupId: 'g1', index: 99 }))).toEqual(['b', 'c', 'd', 'a'])
  })
})
