// 탭 메뉴·탭 단축키의 순수 계산 (LIFE-495 K1ⓔ·K2ⓔ·K7ⓙ).
//
// 대상은 언제나 **한 영역의 시각 순서**(`TabGroup.tabOrder`)다 — 다른 영역의 탭은 닫지도 고르지도 않는다(220 `useTabGroupCloseScopeCommands`
// 가 활성 group 의 `tabOrder` 로 자르는 것과 같다). 화면·IPC 는 이 파일 밖이다.

export type CloseScope = 'others' | 'right' | 'left'

/**
 * 「다른 탭 닫기 / 오른쪽 탭 닫기 / 왼쪽 탭 닫기」가 닫을 탭 (K2ⓐ) — **핀 탭은 뺀다**(220·VS Code 관례).
 * 기준 탭이 그 영역에 없으면 빈 목록이다.
 */
export function closeScopeTargets(input: { tabOrder: readonly string[]; tabId: string; scope: CloseScope; pinned: ReadonlySet<string> }): string[] {
  const index = input.tabOrder.indexOf(input.tabId)
  if (index === -1) return []
  const range =
    input.scope === 'others'
      ? input.tabOrder.filter((tabId) => tabId !== input.tabId)
      : input.scope === 'right'
        ? input.tabOrder.slice(index + 1)
        : input.tabOrder.slice(0, index)
  return range.filter((tabId) => !input.pinned.has(tabId))
}

/** 탭 메뉴의 항목 상태 (K1ⓔ·K2ⓑ·K3ⓑ) — 닫을 대상이 없으면 비활성이다(220 의 "활성인데 아무것도 안 함" 은 따르지 않는다, F5). */
export type TabMenuModel = {
  pinned: boolean
  canClose: boolean
  canCloseOthers: boolean
  canCloseRight: boolean
  canCloseLeft: boolean
  /** 새 영역으로 옮기기 — 영역에 탭이 하나뿐이면 빈 영역을 만드는 경로가 되므로 비활성(LIFE-373). */
  canMoveToNewGroup: boolean
}

export function tabMenuModel(input: { tabOrder: readonly string[]; tabId: string; pinned: ReadonlySet<string> }): TabMenuModel {
  const count = (scope: CloseScope): number => closeScopeTargets({ ...input, scope }).length
  const pinned = input.pinned.has(input.tabId)
  return {
    pinned,
    canClose: !pinned,
    canCloseOthers: count('others') > 0,
    canCloseRight: count('right') > 0,
    canCloseLeft: count('left') > 0,
    canMoveToNewGroup: input.tabOrder.length > 1,
  }
}

/** ⌘⇧[ ]·⌘⌥[ ]·⌃PgUp/Dn (K7ⓑⓒ) — 활성 영역 안에서 감긴다. 활성 탭이 없으면 첫(다음)·끝(이전) 탭. */
export function cycleTabTarget(input: { tabOrder: readonly string[]; activeTabId: string | null; direction: 1 | -1 }): string | null {
  const count = input.tabOrder.length
  if (count === 0) return null
  const index = input.activeTabId === null ? -1 : input.tabOrder.indexOf(input.activeTabId)
  if (index === -1) return input.tabOrder[input.direction === 1 ? 0 : count - 1] ?? null
  return input.tabOrder[(index + input.direction + count) % count] ?? null
}

/** ⌃1–9 (K7ⓓ) — 활성 영역의 N번째(0 기준 index). 없으면 null(no-op). ⌃9 는 9번째다 — 마지막 탭이 아니다(220 과 같다). */
export function tabAtIndex(input: { tabOrder: readonly string[]; index: number }): string | null {
  return input.tabOrder[input.index] ?? null
}

/** 사이드바 닫기 판정에 필요한 만큼의 state 모양 — 테스트가 AppState 전체를 만들지 않게. */
type ReposShape = readonly {
  worktrees: readonly { path: string; workspace: { workspaceId: string; tabs: readonly { tabId: string; panes: readonly { paneId: string }[] }[] } | null }[]
}[]

/**
 * 사이드바 세션 닫기의 길 (LIFE-495 K3ⓒ · fix1 R1-02). 그 pane 이 **핀 탭의 마지막 pane** 이면 탭 닫기 길(핀 확인·게이트·다시 열기 기록),
 * 아니면 기존 pane 닫기. 소유 탭은 활성 워크스페이스가 아니라 **전체 state** 에서 찾는다 — 사이드바는 모든 워크스페이스의 세션을 닫을 수 있고,
 * 닫기 단추는 클릭을 카드로 올리지 않아 그 워크스페이스가 활성이 되지도 않는다(`SessionRow` stopPropagation).
 */
export function sidebarCloseRoute(input: { repos: ReposShape; paneId: string; pinned: ReadonlySet<string> }):
  | { kind: 'tab'; worktreePath: string; workspaceId: string; tabId: string }
  | { kind: 'pane' } {
  for (const repo of input.repos) {
    for (const worktree of repo.worktrees) {
      const workspace = worktree.workspace
      if (workspace === null) continue
      const tab = workspace.tabs.find((row) => row.panes.some((pane) => pane.paneId === input.paneId))
      if (tab === undefined) continue
      return tab.panes.length === 1 && input.pinned.has(tab.tabId)
        ? { kind: 'tab', worktreePath: worktree.path, workspaceId: workspace.workspaceId, tabId: tab.tabId }
        : { kind: 'pane' }
    }
  }
  return { kind: 'pane' }
}
