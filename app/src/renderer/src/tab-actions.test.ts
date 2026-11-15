// LIFE-495 K1ⓔ·K2ⓔ·K7ⓙ — 탭 메뉴 항목 상태·bulk 닫기 대상·탭 순환의 순수 계산.
import { describe, expect, it } from 'vitest'
import { closeMixedTabs, closeScopeTargets, cycleTabTarget, mixedCloseTargets, sidebarCloseRoute, tabAtIndex, tabMenuModel } from './tab-actions.js'

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

describe('LIFE-822 B7 closeMixedTabs — 부분 결과 없음 (C6 · fix1 R1-2·R1-3)', () => {
  /**
   * 호출 순서 기록 + 확인 결과를 정하는 가짜. `terminal` = 터미널 닫기 요청이 어떻게 끝나나 —
   * all = 전부 닫힘 · cancel = 아무것도 안 닫힘(onClosed 없음) · partial = 일부만 닫히고 다시 묻다 취소 · partial-then-rest = 일부 뒤 다시 물어 나머지도 닫힘.
   */
  function harness(input: { filesOk: boolean; terminal: 'all' | 'cancel' | 'partial' | 'partial-then-rest'; busy?: boolean | (() => boolean) }) {
    const log: string[] = []
    const busy = input.busy
    const run = (tabs: { files: string[]; terminals: string[] }) =>
      closeMixedTabs({
        fileTabIds: tabs.files,
        terminalTabIds: tabs.terminals,
        terminalsBusy: () => (typeof busy === 'function' ? busy() : busy === true),
        onBusy: () => log.push('busy'),
        confirmFiles: async (tabIds) => {
          log.push(`confirm:${tabIds.join(',')}`)
          return input.filesOk
        },
        closeTerminals: ({ tabIds, onClosed }) => {
          log.push(`terminals:${tabIds.join(',')}`)
          if (input.terminal === 'all') onClosed(tabIds)
          if (input.terminal === 'partial') onClosed(tabIds.slice(0, 1))
          if (input.terminal === 'partial-then-rest') {
            onClosed(tabIds.slice(0, 1))
            onClosed(tabIds.slice(1))
            onClosed([])
          }
        },
        closeFiles: (tabIds) => log.push(`files:${tabIds.join(',')}`),
      })
    return { log, run }
  }
  const tabs = { files: ['file:a.ts', 'file:b.ts'], terminals: ['w1:t1', 'w1:t2'] }
  it('ⓐ 터미널 실행 중 확인 취소 → 파일은 닫히지 않는다', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'cancel' })
    await run(tabs)
    expect(log).toEqual(['confirm:file:a.ts,file:b.ts', 'terminals:w1:t1,w1:t2'])
  })
  it('ⓑ 확인 → 요청한 터미널이 전부 닫힌 뒤 파일 닫기 — 전부 닫힘', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'all' })
    await run(tabs)
    expect(log).toEqual(['confirm:file:a.ts,file:b.ts', 'terminals:w1:t1,w1:t2', 'files:file:a.ts,file:b.ts'])
  })
  it('ⓒ 수정 파일 확인 취소 → 터미널 닫기 요청도 없다', async () => {
    const { log, run } = harness({ filesOk: false, terminal: 'all' })
    await run(tabs)
    expect(log).toEqual(['confirm:file:a.ts,file:b.ts'])
  })
  it('ⓓ 터미널 대상 0 → 파일만(확인 뒤) 바로 닫힘', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'cancel' })
    await run({ files: ['file:a.ts'], terminals: [] })
    expect(log).toEqual(['confirm:file:a.ts', 'files:file:a.ts'])
  })
  it('fix1 R1-2 일부만 닫히고 끝나면(재확인 취소·거절·오류) 파일은 남는다', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'partial' })
    await run(tabs)
    expect(log.some((entry) => entry.startsWith('files:'))).toBe(false)
  })
  it('fix1 R1-2 일부 뒤 다시 물어 나머지도 닫히면 그때 파일을 한 번만 닫는다', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'partial-then-rest' })
    await run(tabs)
    expect(log.filter((entry) => entry.startsWith('files:'))).toEqual(['files:file:a.ts,file:b.ts'])
  })
  it('파일 대상 0 → 확인 없이 터미널만', async () => {
    const { log, run } = harness({ filesOk: false, terminal: 'all' })
    await run({ files: [], terminals: ['w1:t1'] })
    expect(log).toEqual(['terminals:w1:t1', 'files:'])
  })
  it('fix1 R1-3 닫기 확인 창이 이미 떠 있으면 묻기 전에 거르고 알린다 — 파일 확인도 시작하지 않는다', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'all', busy: true })
    await run(tabs)
    expect(log).toEqual(['busy'])
  })
  it('fix1 R1-3 파일을 묻는 사이 확인 창이 떴으면 터미널 요청 전에 거르고 알린다(파일도 안 닫힌다)', async () => {
    let calls = 0
    const { log, run } = harness({ filesOk: true, terminal: 'all', busy: () => (calls += 1) > 1 })
    await run(tabs)
    expect(log).toEqual(['confirm:file:a.ts,file:b.ts', 'busy'])
  })
  it('터미널 대상이 없으면 확인 창이 떠 있어도 파일만 닫는다(터미널 요청이 없으므로)', async () => {
    const { log, run } = harness({ filesOk: true, terminal: 'cancel', busy: true })
    await run({ files: ['file:a.ts'], terminals: [] })
    expect(log).toEqual(['confirm:file:a.ts', 'files:file:a.ts'])
  })
})

describe('fix1 R1-3 mixedCloseTargets — herdr 에 없는 터미널 id 는 대상·순서에서 빠진다', () => {
  const order = ['w1:t1', 'w1:dead', 'file:a.ts', 'w1:t2']
  const live = (tabId: string): boolean => tabId !== 'w1:dead'
  it('모두 닫기 — 없는 id 는 빼고 종류별로', () => {
    expect(mixedCloseTargets({ tabOrder: order, tabId: 'file:a.ts', scope: 'all', pinned: none, isLiveTerminal: live })).toEqual({ files: ['file:a.ts'], terminals: ['w1:t1', 'w1:t2'] })
  })
  it('왼쪽 탭 닫기 — 탭바가 그리는 칸 기준(없는 id 가 왼쪽에 있어도 대상 아님)', () => {
    expect(mixedCloseTargets({ tabOrder: order, tabId: 'file:a.ts', scope: 'left', pinned: none, isLiveTerminal: live })).toEqual({ files: [], terminals: ['w1:t1'] })
  })
  it('메뉴 활성 판정과 같은 집합 — 없는 id 만 있으면 tabMenuModel 도 흐림', () => {
    // 탭바는 없는 id 를 안 그린다 → 「오른쪽 탭 닫기」 흐림. 실행 대상도 0 이어야 한다(켜진 메뉴가 아무것도 안 닫는 무음이 없게).
    const withDead = ['file:a.ts', 'w1:dead']
    const shown = withDead.filter((tabId) => tabId.startsWith('file:') || live(tabId))
    expect(tabMenuModel({ tabOrder: shown, tabId: 'file:a.ts', pinned: none }).canCloseRight).toBe(false)
    expect(mixedCloseTargets({ tabOrder: withDead, tabId: 'file:a.ts', scope: 'right', pinned: none, isLiveTerminal: live })).toEqual({ files: [], terminals: [] })
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
