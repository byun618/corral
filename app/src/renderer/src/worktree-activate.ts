// 워크트리 카드 활성화 (LIFE-601 C11) — 사이드바 카드 클릭과 작업 페이지 「작업 중」 줄 클릭이 **같은 경로**를 쓴다.
// 열린 워크스페이스가 없으면 열기(`openWorktree`), 있으면 그 워크스페이스 활성 → 그 worktree 배치가 보던 탭으로 돌아간다(LIFE-824 C7·P4 — `returnTo`).
// 배치가 없거나 활성 탭이 없을 때만 옛 규칙: 첫 탭의 pane 선택. 첫 세션은 **에이전트 세션이 아니라 전체 탭의 첫 번째**다(09-gate1-fix.md D) — 블록 클릭은
// worktree 전환이고, 전환 직후 탭바의 첫 탭과 활성 탭이 어긋나 보이지 않게 한다.
import type { WorktreeRow } from '../../shared/types.js'
import { findGroup, isFileTabId, type GroupLayout } from './group-tree.js'
import type { LifecycleActions } from './lifecycle-types.js'
import { pickPane } from './pane-utils.js'

export function activateWorktreeCard({ actions, repoRoot, worktree, selectPane, returnTo }: {
  actions: Pick<LifecycleActions, 'openWorktree' | 'activateWorkspace'>
  repoRoot: string
  worktree: WorktreeRow
  selectPane: (paneId: string) => void
  /** 그 worktree 배치가 보던 탭으로 갔으면 참 — 거짓이면 옛 규칙(첫 탭). 없으면 옛 규칙만. */
  returnTo?: (worktree: WorktreeRow) => boolean
}): void {
  const workspace = worktree.workspace
  if (workspace === null) {
    actions.openWorktree(repoRoot, worktree)
    return
  }
  actions.activateWorkspace(workspace.workspaceId)
  if (returnTo?.(worktree) === true) return
  const firstTab = workspace.tabs[0]
  if (firstTab === undefined) return
  const pane = pickPane(firstTab)
  if (pane !== null) selectPane(pane.paneId)
}

/**
 * worktree 로 돌아갈 자리 (LIFE-824 C7·P4) — 그 worktree 배치(보이는 모양 그대로)의 **활성 영역·그 영역의 활성 탭**. 순수 판정.
 * 활성 탭이 파일·diff 탭이면 그 탭(덮지 않는다), 터미널 탭이면 그 탭이 herdr 에 살아 있을 때만. 배치가 없거나 활성 탭이 없으면 null(옛 규칙 tabs[0]).
 */
export function worktreeReturnTarget(input: { layout: GroupLayout | null; liveTabIds: readonly string[] }): { groupId: string; tabId: string } | null {
  if (input.layout === null) return null
  const group = findGroup(input.layout.root, input.layout.activeGroupId)
  const tabId = group?.activeTabId ?? null
  if (group === null || tabId === null) return null
  if (!isFileTabId(tabId) && !input.liveTabIds.includes(tabId)) return null
  return { groupId: group.groupId, tabId }
}
