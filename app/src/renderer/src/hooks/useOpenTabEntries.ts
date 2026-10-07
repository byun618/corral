// LIFE-496 D36 — `+` 메뉴 omnibox 가 찾는 열린 탭 (App.tsx 에서 옮김 — 리뷰 r1 R1-05 테스트 자리).
// Orca 처럼 **현재 worktree 하나**의 탭을 **모든 영역**에서 모은다.
// 제목은 탭 스트립과 같은 `sessionTitle`, 위치는 영역 순서·탭 순서, 현재 탭 = 활성 영역의 활성 탭.
import { useMemo } from 'react'
import type { WorkspaceRow, WorktreeRow } from '../../../shared/types.js'
import { tabOrdinals } from '../fallback-ordinal.js'
import type { TabGroup } from '../group-tree.js'
import { sessionTitle, tabAgent } from '../session-title.js'
import type { OpenTabSearchEntry } from '../tab-create-menu.js'
import { worktreeSearchContainer } from '../worktree-name.js'

export function useOpenTabEntries(input: {
  workspace: WorkspaceRow | null
  worktree: WorktreeRow | null
  groups: TabGroup[]
  activeGroupId: string | null
  home: string | null
  selectedPane: string | null
  /**
   * 폴백 번호 배정표를 다 실었나 (App `ordinalsReady`). 싣기 전에는 만들지 않는다 — 그때 `ordinalFor` 가 집은 번호는
   * `hydrate` 가 덮어 쓰고, `tabOrdinals` 는 모듈 상수라 memo 가 그 변화를 모른다(리뷰 r1 R1-05). 이 값이 재계산 신호다.
   * 한 번 배정한 번호는 탭이 닫히거나 워크스페이스를 옮길 때까지 안 바뀐다(fallback-ordinal ②) — 그 둘은 `workspace` 가 바뀐다.
   */
  ordinalsReady: boolean
}): OpenTabSearchEntry[] {
  const { workspace, worktree, groups, activeGroupId, home, selectedPane, ordinalsReady } = input
  return useMemo<OpenTabSearchEntry[]>(() => {
    if (workspace === null || !ordinalsReady) return []
    const tabCount = workspace.tabs.length
    const activeTabId = groups.find((group) => group.groupId === activeGroupId)?.activeTabId ?? null
    return groups.flatMap((group, groupIndex) =>
      group.tabOrder.flatMap((tabId, tabIndex) => {
        const tab = workspace.tabs.find((row) => row.tabId === tabId)
        if (tab === undefined) return []
        const ordinal = tabOrdinals.ordinalFor({ tabId: tab.tabId, groupId: tab.workspaceId })
        return [{
          tabId,
          groupId: group.groupId,
          title: sessionTitle({ tab, tabCount, ordinal, home, selectedPaneId: selectedPane }),
          branch: worktree === null ? null : worktreeSearchContainer(worktree),
          agent: tabAgent(tab),
          groupIndex,
          tabIndex,
          isCurrent: group.groupId === activeGroupId && tabId === activeTabId,
        }]
      }),
    )
  }, [workspace, worktree, groups, activeGroupId, home, selectedPane, ordinalsReady])
}
