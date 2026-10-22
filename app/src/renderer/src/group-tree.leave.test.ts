// LIFE-691 K1 — 활성 탭이 영역을 떠난 뒤(닫기·옮기기) 원 영역의 다음 활성 탭 표 시험.
// 규칙(01-criteria R1–R3): 영역별 MRU 에서 떠난 탭이 아닌 가장 최근 탭 → 없으면 떠나기 전 tabOrder 의 오른쪽 이웃 → 왼쪽 이웃.
// 활성이 아닌 탭이 떠나면 활성 불변. 시나리오는 일감 원문 [세션1, 세션2, 파일1, 파일2] 그대로.

import { describe, expect, it } from 'vitest'
import { closeFileTab } from './file-tabs.js'
import {
  findGroup,
  leaf,
  mergeTabIntoGroup,
  moveTabWithinTabbar,
  partitionPinnedLayout,
  readStoredLayouts,
  reconcileLayout,
  removeTabFromGroup,
  splitGroup,
  splitGroupWithForeignTab,
  trackRecentTabs,
  updateGroup,
  withoutRecentTabs,
  type GroupLayout,
  type TabGroup,
} from './group-tree.js'

const S1 = 'w1:t1'
const S2 = 'w1:t2'
const F1 = 'file:a.md'
const F2 = 'file:b.md'
const OTHER = 'w1:t9'

/** [세션1, 세션2, 파일1, 파일2] 파일2 활성인 g1 + 다른 영역 g2(탭 하나). */
const scenario = (patch: Partial<TabGroup> = {}): GroupLayout => ({
  root: {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: leaf({ groupId: 'g1', tabOrder: [S1, S2, F1, F2], activeTabId: F2, ...patch }),
    second: leaf({ groupId: 'g2', tabOrder: [OTHER], activeTabId: OTHER }),
  },
  activeGroupId: 'g1',
})
const single = (group: TabGroup): GroupLayout => ({ root: leaf(group), activeGroupId: group.groupId })
const activeOf = (layout: GroupLayout, groupId: string): string | null => findGroup(layout.root, groupId)?.activeTabId ?? null

describe('K1ⓐ 활성 파일2 닫기 → 원 영역 파일1', () => {
  it('closeFileTab', () => {
    expect(activeOf(closeFileTab({ layout: scenario(), tabId: F2 }).layout, 'g1')).toBe(F1)
  })
})

describe('K1ⓑ 활성 파일2 새 영역으로(splitGroup) → 원 영역 파일1 · 활성 영역 = 새 영역(ⓘ)', () => {
  const cases = [
    { name: '오른쪽', direction: 'row', edge: 'after' },
    { name: '왼쪽', direction: 'row', edge: 'before' },
    { name: '아래', direction: 'column', edge: 'after' },
    { name: '위', direction: 'column', edge: 'before' },
  ] as const
  for (const { name, direction, edge } of cases)
    it(name, () => {
      const next = splitGroup({ layout: scenario(), groupId: 'g1', tabId: F2, direction, edge, newGroupId: 'g3' })
      expect(activeOf(next, 'g1')).toBe(F1)
      expect(next.activeGroupId).toBe('g3')
      expect(activeOf(next, 'g3')).toBe(F2)
    })
})

describe('K1ⓒ 활성 파일2 다른 영역으로 병합 → 원 영역 파일1 · 활성 영역 = 대상(ⓘ)', () => {
  it('mergeTabIntoGroup', () => {
    const next = mergeTabIntoGroup(scenario(), { tabId: F2, fromGroupId: 'g1', toGroupId: 'g2' })
    expect(activeOf(next, 'g1')).toBe(F1)
    expect(next.activeGroupId).toBe('g2')
  })
  it('moveTabWithinTabbar (다른 영역 탭바)', () => {
    const next = moveTabWithinTabbar(scenario(), { tabId: F2, fromGroupId: 'g1', toGroupId: 'g2', index: 0 })
    expect(activeOf(next, 'g1')).toBe(F1)
    expect(next.activeGroupId).toBe('g2')
  })
})

describe('K1ⓓ 활성 파일2 가장자리 드래그 → 원 영역 파일1', () => {
  it('제 영역 가장자리(splitGroup edge before)', () => {
    const next = splitGroup({ layout: scenario(), groupId: 'g1', tabId: F2, direction: 'row', edge: 'before', newGroupId: 'g3' })
    expect(activeOf(next, 'g1')).toBe(F1)
  })
  it('다른 영역 가장자리(splitGroupWithForeignTab)', () => {
    const next = splitGroupWithForeignTab({ layout: scenario(), tabId: F2, fromGroupId: 'g1', targetGroupId: 'g2', direction: 'column', edge: 'after', newGroupId: 'g3' })
    expect(activeOf(next, 'g1')).toBe(F1)
    expect(next.activeGroupId).toBe('g3')
  })
})

describe('K1ⓔ 활성 터미널 탭 닫기(reconcileLayout) — R1', () => {
  const S3 = 'w1:t3'
  it('맨 끝 터미널 닫기 → 왼쪽 이웃', () => {
    const layout = single({ groupId: 'g1', tabOrder: [S1, S2, S3], activeTabId: S3 })
    expect(activeOf(reconcileLayout({ layout, liveTabIds: [S1, S2] }), 'g1')).toBe(S2)
  })
  it('가운데 터미널 닫기 → 오른쪽 이웃', () => {
    const layout = single({ groupId: 'g1', tabOrder: [S1, S2, S3], activeTabId: S2 })
    expect(activeOf(reconcileLayout({ layout, liveTabIds: [S1, S3] }), 'g1')).toBe(S3)
  })
  it('사용자 시나리오 세션2 활성 닫기 → 오른쪽 파일1', () => {
    expect(activeOf(reconcileLayout({ layout: scenario({ activeTabId: S2 }), liveTabIds: [S1, OTHER] }), 'g1')).toBe(F1)
  })
  it('MRU 가 있으면 MRU — 세션1 → 세션2 방문 뒤 세션2 닫기 → 세션1', () => {
    const layout = scenario({ activeTabId: S2, recentTabIds: [F2, S1, S2] })
    expect(activeOf(reconcileLayout({ layout, liveTabIds: [S1, OTHER] }), 'g1')).toBe(S1)
  })
})

describe('K1ⓕ MRU 가 이웃과 갈리는 표', () => {
  const abcd = (patch: Partial<TabGroup>): GroupLayout => single({ groupId: 'g1', tabOrder: ['w1:a', 'w1:b', 'w1:c', 'w1:d'], activeTabId: 'w1:d', ...patch })
  it('[A,B,C,D] B → D 방문 뒤 D 닫기 = B (removeTabFromGroup)', () => {
    expect(activeOf(removeTabFromGroup(abcd({ recentTabIds: ['w1:b', 'w1:d'] }), 'g1', 'w1:d'), 'g1')).toBe('w1:b')
  })
  it('[A,B,C,D] B → D 방문 뒤 D 닫기 = B (reconcileLayout)', () => {
    expect(activeOf(reconcileLayout({ layout: abcd({ recentTabIds: ['w1:b', 'w1:d'] }), liveTabIds: ['w1:a', 'w1:b', 'w1:c'] }), 'g1')).toBe('w1:b')
  })
  it('같은 흐름을 trackRecentTabs 로 기록해도 B', () => {
    const atB = trackRecentTabs(abcd({ activeTabId: 'w1:b' }))
    const atD = trackRecentTabs(updateGroup(atB, 'g1', (group) => ({ ...group, activeTabId: 'w1:d' })))
    expect(findGroup(atD.root, 'g1')?.recentTabIds).toEqual(['w1:b', 'w1:d'])
    expect(activeOf(removeTabFromGroup(atD, 'g1', 'w1:d'), 'g1')).toBe('w1:b')
  })
  it('MRU 비어 활성만(재기동 직후) — 가운데 탭 닫기 = 오른쪽', () => {
    expect(activeOf(removeTabFromGroup(abcd({ activeTabId: 'w1:b', recentTabIds: ['w1:b'] }), 'g1', 'w1:b'), 'g1')).toBe('w1:c')
    expect(activeOf(removeTabFromGroup(abcd({ activeTabId: 'w1:b' }), 'g1', 'w1:b'), 'g1')).toBe('w1:c')
  })
  it('MRU 비어 활성만(재기동 직후) — 맨 끝 닫기 = 왼쪽', () => {
    expect(activeOf(removeTabFromGroup(abcd({ recentTabIds: ['w1:d'] }), 'g1', 'w1:d'), 'g1')).toBe('w1:c')
  })
  it('MRU 의 가장 최근이 이미 떠난 탭이면 그 다음', () => {
    expect(activeOf(removeTabFromGroup(abcd({ recentTabIds: ['w1:a', 'w1:gone', 'w1:d'] }), 'g1', 'w1:d'), 'g1')).toBe('w1:a')
  })
})

describe('K1ⓖ R2 — 비활성 탭이 떠나면 활성 불변', () => {
  it('비활성 파일1 닫기', () => {
    expect(activeOf(closeFileTab({ layout: scenario(), tabId: F1 }).layout, 'g1')).toBe(F2)
  })
  it('비활성 세션1 새 영역으로', () => {
    expect(activeOf(splitGroup({ layout: scenario(), groupId: 'g1', tabId: S1, direction: 'row', newGroupId: 'g3' }), 'g1')).toBe(F2)
  })
  it('비활성 세션1 병합', () => {
    expect(activeOf(mergeTabIntoGroup(scenario(), { tabId: S1, fromGroupId: 'g1', toGroupId: 'g2' }), 'g1')).toBe(F2)
  })
  it('비활성 터미널 세션2 닫기(reconcileLayout)', () => {
    expect(activeOf(reconcileLayout({ layout: scenario(), liveTabIds: [S1, OTHER] }), 'g1')).toBe(F2)
  })
})

describe('K1ⓗ 핀 접두부·미리보기 탭이 섞여도 같은 결과', () => {
  it('세션2 핀 → [세션2, 세션1, 파일1, 파일2(미리보기)] 파일2 닫기 = 파일1', () => {
    const pinned = partitionPinnedLayout({ layout: scenario({ previewTabId: F2 }), pinned: new Set([S2]) })
    expect(findGroup(pinned.root, 'g1')?.tabOrder).toEqual([S2, S1, F1, F2])
    const closed = closeFileTab({ layout: pinned, tabId: F2 }).layout
    expect(activeOf(closed, 'g1')).toBe(F1)
    expect(findGroup(closed.root, 'g1')?.previewTabId).toBeNull()
  })
  it('미리보기 파일2 새 영역으로 = 파일1', () => {
    expect(activeOf(splitGroup({ layout: scenario({ previewTabId: F2 }), groupId: 'g1', tabId: F2, direction: 'row', newGroupId: 'g3' }), 'g1')).toBe(F1)
  })
})

describe('R3 — 영역별 MRU 기록', () => {
  it('활성 탭을 tail 에, 배치에 없는 탭은 뺀다 · 바뀐 것이 없으면 같은 객체', () => {
    const layout = scenario({ recentTabIds: [F2, 'file:gone.md', S1] })
    const tracked = trackRecentTabs(layout)
    expect(findGroup(tracked.root, 'g1')?.recentTabIds).toEqual([S1, F2])
    expect(findGroup(tracked.root, 'g2')?.recentTabIds).toEqual([OTHER])
    expect(trackRecentTabs(tracked)).toBe(tracked)
  })
  it('영역마다 따로 — 옮겨 간 탭은 원 영역 MRU 에서 빠지고 대상 영역 MRU 에 든다', () => {
    const tracked = trackRecentTabs(scenario({ recentTabIds: [S1, F2] }))
    const moved = trackRecentTabs(mergeTabIntoGroup(tracked, { tabId: F2, fromGroupId: 'g1', toGroupId: 'g2' }))
    expect(findGroup(moved.root, 'g1')?.recentTabIds).toEqual([S1])
    expect(findGroup(moved.root, 'g2')?.recentTabIds).toEqual([OTHER, F2])
  })
})

describe('K5 저장 형식 — MRU 는 저장 JSON 에 싣지 않는다', () => {
  it('withoutRecentTabs 뒤 JSON 에 recentTabIds 가 없고 읽기 결과가 같다', () => {
    const tracked = trackRecentTabs(scenario({ recentTabIds: [S1, F2], previewTabId: F2 }))
    const stored = withoutRecentTabs(tracked)
    const json = JSON.stringify([{ worktreePath: '/r', layout: stored, layoutFormat: 2 }])
    // 저장값 덤프(K5 근거) — 원자료 txt 에 실린다.
    console.log(`K5 저장값 덤프: ${json}`)
    expect(json).not.toContain('recentTabIds')
    expect(readStoredLayouts(JSON.parse(json))[0]?.layout).toEqual(stored)
    expect(withoutRecentTabs(stored)).toBe(stored)
  })
})
