// LIFE-496 D36 — `+` 메뉴 omnibox 가 찾는 열린 탭 (App.tsx 에서 옮김 — 리뷰 r1 R1-05 테스트 자리).
// Orca 처럼 **현재 worktree 하나**의 탭을 **모든 영역**에서 모은다.
// 제목은 탭 스트립과 같은 `sessionTitle`, 위치는 영역 순서·탭 순서, 현재 탭 = 활성 영역의 활성 탭.
import { useMemo } from 'react'
import type { WorkspaceRow, WorktreeRow } from '../../../shared/types.js'
import { tabOrdinals } from '../fallback-ordinal.js'
import type { TabGroup } from '../group-tree.js'
import { sessionTitle, tabAgent } from '../session-title.js'
import type { OpenTabSearchEntry } from '../tab-create-menu.js'

export function useOpenTabEntries(input: {
  workspace: WorkspaceRow | null
  worktree: WorktreeRow | null
  groups: TabGroup[]
  activeGroupId: string | null
  home: string | null
  selectedPane: string | null
  /** 폴백 번호 배정표를 다 실었나 (App `ordinalsReady`). */
  ordinalsReady: boolean
}): OpenTabSearchEntry[] {
  const { workspace, worktree, groups, activeGroupId, home, selectedPane } = input
  return useMemo<OpenTabSearchEntry[]>(() => {
    if (workspace === null) return []
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
          branch: worktree?.branch ?? null,
          agent: tabAgent(tab),
          groupIndex,
          tabIndex,
          isCurrent: group.groupId === activeGroupId && tabId === activeTabId,
        }]
      }),
    )
  }, [workspace, worktree, groups, activeGroupId, home, selectedPane])
}
