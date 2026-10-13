// 워크트리 카드 활성화 (LIFE-601 C11) — 사이드바 카드 클릭과 작업 페이지 「작업 중」 줄 클릭이 **같은 경로**를 쓴다.
// 열린 워크스페이스가 없으면 열기(`openWorktree`), 있으면 그 워크스페이스 활성 → 첫 탭의 pane 선택(Sidebar 의 옛 `activateRow` 그대로).
// 첫 세션은 **에이전트 세션이 아니라 전체 탭의 첫 번째**다(09-gate1-fix.md D) — 블록 클릭은 worktree 전환이고, 전환 직후 탭바의 첫 탭과
// 활성 탭이 어긋나 보이지 않게 한다.
import type { WorktreeRow } from '../../shared/types.js'
import type { LifecycleActions } from './lifecycle-types.js'
import { pickPane } from './pane-utils.js'

export function activateWorktreeCard({ actions, repoRoot, worktree, selectPane }: {
  actions: Pick<LifecycleActions, 'openWorktree' | 'activateWorkspace'>
  repoRoot: string
  worktree: WorktreeRow
  selectPane: (paneId: string) => void
}): void {
  const workspace = worktree.workspace
  if (workspace === null) {
    actions.openWorktree(repoRoot, worktree)
    return
  }
  actions.activateWorkspace(workspace.workspaceId)
  const firstTab = workspace.tabs[0]
  if (firstTab === undefined) return
  const pane = pickPane(firstTab)
  if (pane !== null) selectPane(pane.paneId)
}
