// design-handoff.md §1 — 사이드바 4단 전개(repo 헤더 → worktree 2줄 블록 → 세션 행). 이 파일은
// C6 이 나열한 개별 컴포넌트(SidebarBrandBar 등)를 엮는 조립부다 — 자체는 판정표에 없는 이름이라
// 자유롭게 구조화했다.
import type { RefObject } from 'react'
import type { AgentKind, AppState, TabRow, WorktreeRow } from '../../../shared/types.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { pickPane } from '../pane-utils.js'
import { RepoRow } from './RepoRow.js'
import { ReposSectionHeader } from './ReposSectionHeader.js'
import { SidebarBrandBar } from './SidebarBrandBar.js'
import { SidebarFooterToolbar } from './SidebarFooterToolbar.js'
import { SidebarSearch } from './SidebarSearch.js'
import { WorktreeBlock } from './WorktreeBlock.js'

export function Sidebar({
  sidebarRef,
  width,
  state,
  activeWorkspaceId,
  selectedPane,
  selectPane,
  actions,
  isRepoCollapsed,
  toggleRepoCollapsed,
  isGroupCollapsed,
  toggleGroupCollapsed,
  onAddRepo,
  onRemoveRepo,
  onRefresh,
}: {
  sidebarRef: RefObject<HTMLDivElement | null>
  width: number
  state: AppState
  activeWorkspaceId: string | null
  selectedPane: string | null
  selectPane: (paneId: string) => void
  actions: LifecycleActions
  isRepoCollapsed: (root: string) => boolean
  toggleRepoCollapsed: (root: string) => void
  isGroupCollapsed: (worktreePath: string) => boolean
  toggleGroupCollapsed: (worktreePath: string) => void
  onAddRepo: () => void
  onRemoveRepo: (root: string) => void
  onRefresh: () => void
}): React.JSX.Element {
  const selectFirstSession = (worktree: WorktreeRow): void => {
    const firstTab = worktree.workspace?.tabs[0]
    if (firstTab === undefined) return
    const pane = pickPane(firstTab)
    if (pane !== null) selectPane(pane.paneId)
  }

  const onSelectSession = (tab: TabRow): void => {
    const pane = pickPane(tab)
    if (pane !== null) selectPane(pane.paneId)
  }

  return (
    <div className="sidebar" data-sidebar ref={sidebarRef} style={{ width }}>
      <SidebarBrandBar />
      <SidebarSearch />
      <ReposSectionHeader onAddRepo={onAddRepo} />
      <div className="repo-list" data-repo-list>
        {state.repos.length === 0 ? (
          <p className="sidebar-empty" data-empty>
            등록된 레포가 없다. 위의 「+」 로 폴더를 고른다.
          </p>
        ) : (
          state.repos.map((repo) => (
            <RepoRow
              key={repo.root}
              repo={repo}
              collapsed={isRepoCollapsed(repo.root)}
              onToggleCollapse={() => toggleRepoCollapsed(repo.root)}
              onCreateWorktree={() => actions.openCreateWorktree(repo.root)}
              onRemove={() => onRemoveRepo(repo.root)}
            >
              {repo.worktrees.map((worktree) => {
                const selected = worktree.openWorkspaceId !== null && worktree.openWorkspaceId === activeWorkspaceId
                return (
                  <WorktreeBlock
                    key={worktree.path}
                    worktree={worktree}
                    selected={selected}
                    selectedPane={selectedPane}
                    groupCollapsed={isGroupCollapsed(worktree.path)}
                    onToggleGroup={() => toggleGroupCollapsed(worktree.path)}
                    onSelectBlock={() => {
                      const workspace = worktree.workspace
                      if (workspace === null) {
                        actions.openWorktree(repo.root, worktree)
                        return
                      }
                      actions.activateWorkspace(workspace.workspaceId)
                      selectFirstSession(worktree)
                    }}
                    onSelectSession={onSelectSession}
                    onCloseSession={(tabId) => actions.closeRow(tabId)}
                    onCloseWorktree={() => {
                      if (worktree.openWorkspaceId !== null) actions.closeWorktree(worktree.openWorkspaceId)
                    }}
                    onCreateShell={() => {
                      if (worktree.openWorkspaceId !== null) actions.createRow(worktree.openWorkspaceId, 'shell')
                    }}
                    onCreateAgent={(kind: AgentKind) => {
                      if (worktree.openWorkspaceId !== null) actions.createRow(worktree.openWorkspaceId, kind)
                    }}
                  />
                )
              })}
            </RepoRow>
          ))
        )}
      </div>
      <SidebarFooterToolbar onRefresh={onRefresh} />
    </div>
  )
}
