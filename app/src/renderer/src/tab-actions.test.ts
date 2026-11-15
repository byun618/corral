// LIFE-495 K1ⓔ·K2ⓔ·K7ⓙ — 탭 메뉴 항목 상태·bulk 닫기 대상·탭 순환의 순수 계산.
import { describe, expect, it } from 'vitest'
import { closeMixedTabs, closeScopeTargets, cycleTabTarget, sidebarCloseRoute, tabAtIndex, tabMenuModel } from './tab-actions.js'

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
    expect(model).toEqual({ pinned: false, canClose: true, canCloseOthers: false, canCloseRight: false, canCloseLeft: false, canCloseAll: true, canCloseSaved: false, canMoveToNewGroup: true })
  })
  it('핀 탭 — 「닫기」 비활성, 핀 표시', () => {
    const model = tabMenuModel({ tabOrder: ['p1', 'x'], tabId: 'p1', pinned: new Set(['p1']) })
    expect(model.pinned).toBe(true)
    expect(model.canClose).toBe(false)
    expect(model.canCloseRight).toBe(true)
  })
  it('탭 하나뿐 — 닫기만 되고 bulk·옮기기 비활성', () => {
    expect(tabMenuModel({ tabOrder: ['x'], tabId: 'x', pinned: none })).toEqual({ pinned: false, canClose: true, canCloseOthers: false, canCloseRight: false, canCloseLeft: false, canCloseAll: true, canCloseSaved: false, canMoveToNewGroup: false })
  })
})

describe('LIFE-822 모두 닫기·저장된 탭 닫기 (C7)', () => {
  const mixed = ['w1:t1', 'file:a.ts', 'w1:t2', 'file:b.ts', 'diff:working:c.ts']
  it('모두 닫기 = 영역의 핀 아닌 모든 탭(파일·터미널 섞임, 기준 탭 포함)', () => {
    expect(closeScopeTargets({ tabOrder: mixed, tabId: 'file:a.ts', scope: 'all', pinned: none })).toEqual(mixed)
    expect(closeScopeTargets({ tabOrder: mixed, tabId: 'file:a.ts', scope: 'all', pinned: new Set(['w1:t1']) })).toEqual(['file:a.ts', 'w1:t2', 'file:b.ts', 'diff:working:c.ts'])
  })
  it('저장된 탭 닫기 = 핀 아니고 수정 안 된 파일·diff 탭만 — 터미널 제외', () => {
    expect(closeScopeTargets({ tabOrder: mixed, tabId: 'w1:t1', scope: 'saved', pinned: none, dirty: new Set(['file:b.ts']) })).toEqual(['file:a.ts', 'diff:working:c.ts'])
    expect(closeScopeTargets({ tabOrder: mixed, tabId: 'w1:t1', scope: 'saved', pinned: none })).toEqual(['file:a.ts', 'file:b.ts', 'diff:working:c.ts'])
  })
  it('대상 0 이면 흐림 — 핀만 남은 영역은 모두 닫기 흐림, 터미널·수정 파일만 있으면 저장된 탭 닫기 흐림', () => {
    expect(tabMenuModel({ tabOrder: ['p1'], tabId: 'p1', pinned: new Set(['p1']) }).canCloseAll).toBe(false)
    const model = tabMenuModel({ tabOrder: ['w1:t1', 'file:a.ts'], tabId: 'w1:t1', pinned: none, dirty: new Set(['file:a.ts']) })
    expect(model.canCloseSaved).toBe(false)
    expect(model.canCloseAll).toBe(true)
    expect(tabMenuModel({ tabOrder: ['w1:t1', 'file:a.ts'], tabId: 'w1:t1', pinned: none }).canCloseSaved).toBe(true)
  })
  it('왼쪽 탭 닫기 — 기준 왼쪽의 핀 아닌 탭(파일·터미널 섞임), 첫 탭이면 흐림 (C5)', () => {
    expect(closeScopeTargets({ tabOrder: mixed, tabId: 'file:b.ts', scope: 'left', pinned: new Set(['w1:t2']) })).toEqual(['w1:t1', 'file:a.ts'])
    expect(tabMenuModel({ tabOrder: mixed, tabId: 'w1:t1', pinned: none }).canCloseLeft).toBe(false)
  })
})

describe('LIFE-822 B7 closeMixedTabs — 부분 결과 없음 (C6)', () => {
  /** 호출 순서 기록 + 확인 결과를 정하는 가짜. `terminal` = 터미널 닫기 요청이 어떻게 끝나나(closed = onClosed 를 부름, cancel = 안 부름, twice = 두 번 부름). */
  function harness(input: { filesOk: boolean; terminal: 'closed' | 'cancel' | 'twice' }) {
    const log: string[] = []
    const run = (tabs: { files: string[]; terminals: string[] }) =>
      closeMixedTabs({
        fileTabIds: tabs.files,
        terminalTabIds: tabs.terminals,
        confirmFiles: async (tabIds) => {
          log.push(`confirm:${tabIds.join(',')}`)
          return input.filesOk
        },
        closeTerminals: ({ tabIds, onClosed }) => {
          log.push(`terminals:${tabIds.join(',')}`)
          if (input.terminal === 'closed') onClosed()
          if (input.terminal === 'twice') {
            onClosed()
            onClosed()
          }
        },
        closeFiles: (tabIds) => log.push(`files:${tabIds.join(',')}`),
      })
    return { log, run }
  }
  const tabs = { files: ['file:a.ts', 'file:b.ts'], terminals: ['w1:t1'] }
  it('ⓐ 터미널 실행 중 확인 취소 → 하나도 안 닫힘(파일 탭 남음)', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'cancel' })
    await run(tabs)
    expect(log).toEqual(['confirm:file:a.ts,file:b.ts', 'terminals:w1:t1'])
  })
  it('ⓑ 확인 → 터미널이 실제로 닫힌 뒤 파일 닫기 — 전부 닫힘', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'closed' })
    await run(tabs)
    expect(log).toEqual(['confirm:file:a.ts,file:b.ts', 'terminals:w1:t1', 'files:file:a.ts,file:b.ts'])
  })
  it('ⓒ 수정 파일 확인 취소 → 터미널 닫기 요청도 없다', async () => {
    const { log, run } = harness({ filesOk: false, terminal: 'closed' })
    await run(tabs)
    expect(log).toEqual(['confirm:file:a.ts,file:b.ts'])
  })
  it('ⓓ 터미널 대상 0 → 파일만(확인 뒤) 바로 닫힘', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'cancel' })
    await run({ files: ['file:a.ts'], terminals: [] })
    expect(log).toEqual(['confirm:file:a.ts', 'files:file:a.ts'])
  })
  it('파일 대상 0 → 확인 없이 터미널만 · onClosed 가 두 번 와도(확인 뒤 새 실행 중) 파일 닫기는 한 번', async () => {
    const only = harness({ filesOk: false, terminal: 'closed' })
    await only.run({ files: [], terminals: ['w1:t1'] })
    expect(only.log).toEqual(['terminals:w1:t1', 'files:'])
    const twice = harness({ filesOk: true, terminal: 'twice' })
    await twice.run(tabs)
    expect(twice.log.filter((entry) => entry.startsWith('files:'))).toHaveLength(1)
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
