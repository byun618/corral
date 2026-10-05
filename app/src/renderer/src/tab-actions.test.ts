// LIFE-495 K1ⓔ·K2ⓔ·K7ⓙ — 탭 메뉴 항목 상태·bulk 닫기 대상·탭 순환의 순수 계산.
import { describe, expect, it } from 'vitest'
import { closeScopeTargets, cycleTabTarget, sidebarCloseRoute, tabAtIndex, tabMenuModel } from './tab-actions.js'

const order = ['a', 'b', 'c', 'd', 'e']
const none = new Set<string>()

describe('closeScopeTargets — 영역 안 시각 순서, 핀 제외(K2ⓐ)', () => {
  it('다른 탭 = 자기 제외 전부 · 오른쪽 = 뒤 전부 · 왼쪽 = 앞 전부', () => {
    expect(closeScopeTargets({ tabOrder: order, tabId: 'c', scope: 'others', pinned: none })).toEqual(['a', 'b', 'd', 'e'])
    expect(closeScopeTargets({ tabOrder: order, tabId: 'c', scope: 'right', pinned: none })).toEqual(['d', 'e'])
    expect(closeScopeTargets({ tabOrder: order, tabId: 'c', scope: 'left', pinned: none })).toEqual(['a', 'b'])
  })
  it('핀 탭은 대상에서 빠진다', () => {
    const pinned = new Set(['a', 'b'])
    expect(closeScopeTargets({ tabOrder: order, tabId: 'c', scope: 'others', pinned })).toEqual(['d', 'e'])
    expect(closeScopeTargets({ tabOrder: order, tabId: 'c', scope: 'left', pinned })).toEqual([])
  })
  it('기준 탭이 핀이어도 그 탭은 대상이 아니다 · 영역에 없는 탭이면 빈 목록', () => {
    expect(closeScopeTargets({ tabOrder: order, tabId: 'a', scope: 'others', pinned: new Set(['a']) })).toEqual(['b', 'c', 'd', 'e'])
    expect(closeScopeTargets({ tabOrder: order, tabId: 'zz', scope: 'others', pinned: none })).toEqual([])
  })
  it('끝 탭 — 오른쪽 없음, 첫 탭 — 왼쪽 없음', () => {
    expect(closeScopeTargets({ tabOrder: order, tabId: 'e', scope: 'right', pinned: none })).toEqual([])
    expect(closeScopeTargets({ tabOrder: order, tabId: 'a', scope: 'left', pinned: none })).toEqual([])
  })
})

describe('tabMenuModel — 닫을 대상이 없으면 비활성(K2ⓑ, 220 F5 와 다르다)', () => {
  it('오른쪽에 핀 탭만 있으면 「오른쪽 탭 닫기」 비활성', () => {
    const model = tabMenuModel({ tabOrder: ['p1', 'x', 'p2'], tabId: 'x', pinned: new Set(['p1', 'p2']) })
    expect(model).toEqual({ pinned: false, canClose: true, canCloseOthers: false, canCloseRight: false, canCloseLeft: false, canMoveToNewGroup: true })
  })
  it('핀 탭 — 「닫기」 비활성, 핀 표시', () => {
    const model = tabMenuModel({ tabOrder: ['p1', 'x'], tabId: 'p1', pinned: new Set(['p1']) })
    expect(model.pinned).toBe(true)
    expect(model.canClose).toBe(false)
    expect(model.canCloseRight).toBe(true)
  })
  it('탭 하나뿐 — 닫기만 되고 bulk·옮기기 비활성', () => {
    expect(tabMenuModel({ tabOrder: ['x'], tabId: 'x', pinned: none })).toEqual({ pinned: false, canClose: true, canCloseOthers: false, canCloseRight: false, canCloseLeft: false, canMoveToNewGroup: false })
  })
})

describe('cycleTabTarget — 활성 영역 안 wrap(K7ⓑⓒ)', () => {
  it('다음·이전, 끝에서 감긴다', () => {
    expect(cycleTabTarget({ tabOrder: order, activeTabId: 'c', direction: 1 })).toBe('d')
    expect(cycleTabTarget({ tabOrder: order, activeTabId: 'c', direction: -1 })).toBe('b')
    expect(cycleTabTarget({ tabOrder: order, activeTabId: 'e', direction: 1 })).toBe('a')
    expect(cycleTabTarget({ tabOrder: order, activeTabId: 'a', direction: -1 })).toBe('e')
  })
  it('탭 하나면 자기 자신 · 없으면 null · 활성 탭이 없으면 첫/끝', () => {
    expect(cycleTabTarget({ tabOrder: ['a'], activeTabId: 'a', direction: 1 })).toBe('a')
    expect(cycleTabTarget({ tabOrder: [], activeTabId: null, direction: 1 })).toBeNull()
    expect(cycleTabTarget({ tabOrder: order, activeTabId: null, direction: 1 })).toBe('a')
    expect(cycleTabTarget({ tabOrder: order, activeTabId: 'zz', direction: -1 })).toBe('e')
  })
})

describe('tabAtIndex — ⌃1–9(K7ⓓ)', () => {
  it('N번째, 없으면 null(no-op), ⌃9 는 9번째(마지막 아님)', () => {
    expect(tabAtIndex({ tabOrder: order, index: 0 })).toBe('a')
    expect(tabAtIndex({ tabOrder: order, index: 4 })).toBe('e')
    expect(tabAtIndex({ tabOrder: order, index: 5 })).toBeNull()
    expect(tabAtIndex({ tabOrder: order, index: 8 })).toBeNull()
    const ten = Array.from({ length: 10 }, (_, index) => `t${index}`)
    expect(tabAtIndex({ tabOrder: ten, index: 8 })).toBe('t8')
  })
})

describe('fix1 R1-02 sidebarCloseRoute — 사이드바 세션 닫기의 소유 탭은 전체 state 에서 찾는다', () => {
  const repos = [
    {
      worktrees: [
        { path: '/w/a', workspace: { workspaceId: 'wA', tabs: [{ tabId: 'wA:t1', panes: [{ paneId: 'pA' }] }] } },
        { path: '/w/b', workspace: { workspaceId: 'wB', tabs: [{ tabId: 'wB:t1', panes: [{ paneId: 'pB' }] }, { tabId: 'wB:t2', panes: [{ paneId: 'pB2' }, { paneId: 'pB3' }] }] } },
        { path: '/w/c', workspace: null },
      ],
    },
  ]
  it('비활성 워크스페이스 B 의 핀 탭(pane 1개) → 탭 닫기 길, 소유 = B', () => {
    expect(sidebarCloseRoute({ repos, paneId: 'pB', pinned: new Set(['wB:t1']) })).toEqual({ kind: 'tab', worktreePath: '/w/b', workspaceId: 'wB', tabId: 'wB:t1' })
  })
  it('핀 아닌 탭·pane 여럿인 핀 탭·모르는 pane → pane 닫기 길', () => {
    expect(sidebarCloseRoute({ repos, paneId: 'pB', pinned: new Set() })).toEqual({ kind: 'pane' })
    expect(sidebarCloseRoute({ repos, paneId: 'pB2', pinned: new Set(['wB:t2']) })).toEqual({ kind: 'pane' })
    expect(sidebarCloseRoute({ repos, paneId: 'zz', pinned: new Set(['wB:t1']) })).toEqual({ kind: 'pane' })
  })
})
