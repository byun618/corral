// 영역 트리 단위 시험 — F1-1·F1-5·F1-2·F1-6 의 **모델 쪽 계약**만 여기서 잰다.
// 화면에 실제로 그렇게 서는지는 하네스가 본다.

import { describe, expect, it } from 'vitest'
import {
  closeGroup,
  groupOfTab,
  listGroups,
  reconcileLayout,
  readStoredLayouts,
  setRatio,
  singleLayout,
  splitGroup,
  splitIdOf,
  type GroupLayout,
} from './group-tree.js'

const base = (): GroupLayout => singleLayout({ groupId: 'g1', tabOrder: ['t1', 't2', 't3'], activeTabId: 't1' })

describe('영역 분할 (F1-1)', () => {
  it('그 탭을 빼내 새 영역에 넣고 새 영역이 활성이 된다', () => {
    const next = splitGroup({ layout: base(), groupId: 'g1', tabId: 't2', direction: 'row', newGroupId: 'g2' })
    expect(listGroups(next.root).map((group) => group.tabOrder)).toEqual([['t1', 't3'], ['t2']])
    expect(next.activeGroupId).toBe('g2')
    expect(groupOfTab(next.root, 't2')?.groupId).toBe('g2')
  })

  it('원 영역의 탭이 하나뿐이면 아무 일도 없다 (빈 영역을 만들지 않는다)', () => {
    const one = singleLayout({ groupId: 'g1', tabOrder: ['t1'], activeTabId: 't1' })
    expect(splitGroup({ layout: one, groupId: 'g1', tabId: 't1', direction: 'row', newGroupId: 'g2' })).toBe(one)
  })

  it('빠져나간 탭이 활성이었으면 남은 것 중 앞쪽이 활성이 된다', () => {
    const next = splitGroup({ layout: base(), groupId: 'g1', tabId: 't1', direction: 'column', newGroupId: 'g2' })
    expect(listGroups(next.root)[0]?.activeTabId).toBe('t2')
  })

  it('가로 분할 뒤 세로 분할이 섞여도 트리가 받는다 (목업 ⓓ)', () => {
    const right = splitGroup({ layout: base(), groupId: 'g1', tabId: 't2', direction: 'row', newGroupId: 'g2' })
    const down = splitGroup({ layout: right, groupId: 'g1', tabId: 't3', direction: 'column', newGroupId: 'g3' })
    expect(listGroups(down.root).map((group) => group.groupId)).toEqual(['g1', 'g3', 'g2'])
    expect(down.root.kind === 'split' ? down.root.direction : null).toBe('row')
  })
})

describe('영역 닫기 (F1-5)', () => {
  it('형제가 자리를 차지하고 남은 탭은 형제가 받는다', () => {
    const split = splitGroup({ layout: base(), groupId: 'g1', tabId: 't2', direction: 'row', newGroupId: 'g2' })
    const closed = closeGroup(split, 'g2')
    expect(closed.root.kind).toBe('leaf')
    expect(listGroups(closed.root)[0]?.tabOrder).toEqual(['t1', 't3', 't2'])
    expect(closed.activeGroupId).toBe('g1')
  })

  it('영역이 하나면 무효다', () => {
    const one = base()
    expect(closeGroup(one, 'g1')).toBe(one)
  })
})

describe('비율 (F1-2)', () => {
  it('클램프 .15~.85 안으로 들어온다', () => {
    const split = splitGroup({ layout: base(), groupId: 'g1', tabId: 't2', direction: 'row', newGroupId: 'g2' })
    const id = split.root.kind === 'split' ? splitIdOf(split.root) : ''
    expect(setRatio(split, id, 0.02).root).toMatchObject({ ratio: 0.15 })
    expect(setRatio(split, id, 0.98).root).toMatchObject({ ratio: 0.85 })
    expect(setRatio(split, id, 0.3).root).toMatchObject({ ratio: 0.3 })
  })
})

describe('살아 있는 탭에 맞춰 추리기 (F1-6 안전한 붕괴)', () => {
  it('죽은 탭은 빠지고 새 탭은 **포커스 영역**으로 간다 (R3-d)', () => {
    const split = splitGroup({ layout: base(), groupId: 'g1', tabId: 't2', direction: 'row', newGroupId: 'g2' })
    expect(split.activeGroupId).toBe('g2')
    const next = reconcileLayout({ layout: split, liveTabIds: ['t1', 't2', 't9'] })
    expect(listGroups(next.root).map((group) => group.tabOrder)).toEqual([['t1'], ['t2', 't9']])
  })

  it('herdr 재기동으로 tabId 가 **하나도** 안 맞으면 탭도 **활성 영역도** 첫 영역으로 간다 (R32-1)', () => {
    const split = splitGroup({ layout: base(), groupId: 'g1', tabId: 't2', direction: 'row', newGroupId: 'g2' })
    expect(split.activeGroupId).toBe('g2') // 분할 직후 활성 영역은 새 영역이다
    const next = reconcileLayout({ layout: split, liveTabIds: ['w9:t1', 'w9:t2'] })
    expect(listGroups(next.root).map((group) => group.tabOrder)).toEqual([['w9:t1', 'w9:t2'], []])
    expect(listGroups(next.root)[0]?.activeTabId).toBe('w9:t1')
    // 탭만 옮기고 활성 영역을 빈 g2 에 두면 활성 탭이 null 이 되어 ⌘D·⌘W·⌘⇧Z 가 조용히 안 먹는다.
    expect(next.activeGroupId).toBe('g1')
    const active = listGroups(next.root).find((group) => group.groupId === next.activeGroupId)
    expect(active?.activeTabId).not.toBeNull()
  })

  it('같은 탭이 두 영역에 실려 있으면 앞쪽만 남는다', () => {
    const broken: GroupLayout = {
      activeGroupId: 'g1',
      root: {
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1'], activeTabId: 't1' } },
        second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: ['t1'], activeTabId: 't1' } },
      },
    }
    const next = reconcileLayout({ layout: broken, liveTabIds: ['t1'] })
    expect(listGroups(next.root).map((group) => group.tabOrder)).toEqual([['t1'], []])
  })
})

describe('영속 읽기', () => {
  it('모양이 깨진 항목은 버리고 성한 것만 남긴다', () => {
    const rows = readStoredLayouts([
      { worktreePath: '/a', layout: { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1'], activeTabId: 't1' } }, activeGroupId: 'g1' } },
      { worktreePath: '/b', layout: { root: { kind: 'split' } } },
      { layout: { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: [], activeTabId: null } } } },
      'nope',
    ])
    expect(rows.map((row) => row.worktreePath)).toEqual(['/a'])
  })

  it('저장된 activeGroupId 가 트리에 없으면 첫 영역으로 되돌린다', () => {
    const rows = readStoredLayouts([
      {
        worktreePath: '/a',
        layout: { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: [], activeTabId: null } }, activeGroupId: 'gone' },
      },
    ])
    expect(rows[0]?.layout.activeGroupId).toBe('g1')
  })

  it('비율은 읽으면서 클램프된다', () => {
    const rows = readStoredLayouts([
      {
        worktreePath: '/a',
        layout: {
          activeGroupId: 'g1',
          root: {
            kind: 'split',
            direction: 'column',
            ratio: 9,
            first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: [], activeTabId: null } },
            second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: [], activeTabId: null } },
          },
        },
      },
    ])
    expect(rows[0]?.layout.root).toMatchObject({ ratio: 0.85 })
  })
})
