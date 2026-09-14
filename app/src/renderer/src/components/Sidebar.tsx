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

/**
 * worktree 정렬 (09-gate1-fix.md B) — **선택됨 → 열린 workspace 있음 → 그 외**.
 *
 * 왜 이 순서인가: 사이드바에서 손이 가는 빈도 그대로다. 지금 보고 있는 것이 맨 위, 열려 있어
 * 한 번 클릭으로 전환되는 것이 그다음, 아직 안 연 것이 아래. 목업의 블록 순서도 선택된 카드가
 * 위에 오는 배치다.
 *
 * **동률은 기존 순서를 유지한다** — `Array.prototype.sort` 는 ES2019 부터 안정 정렬이 보장되므로
 * 같은 등급 안에서는 들어온 순서(= git worktree 열거 순서)가 그대로 남는다. 등급이 흔들리지 않는
 * 한 목록이 눈앞에서 재배열되지 않는다는 뜻이다.
 */
function worktreeRank(worktree: WorktreeRow, activeWorkspaceId: string | null): number {
  if (worktree.openWorkspaceId !== null && worktree.openWorkspaceId === activeWorkspaceId) return 0
  if (worktree.openWorkspaceId !== null) return 1
  return 2
}

function sortWorktrees(worktrees: WorktreeRow[], activeWorkspaceId: string | null): WorktreeRow[] {
  return [...worktrees].sort((a, b) => worktreeRank(a, activeWorkspaceId) - worktreeRank(b, activeWorkspaceId))
}

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
  /**
   * 블록 클릭 시 자동 활성화할 세션 (§4 "첫 세션 자동 활성").
   *
   * **에이전트 세션이 아니라 전체 탭의 첫 번째**를 고른다 (09-gate1-fix.md D 하 결정, 기록용):
   * 블록 클릭은 *worktree 전환*이지 세션 선택이 아니고, 전환 직후 화면에 뜨는 탭바는 전체 탭을
   * 보여준다. 여기서 에이전트 탭만 고르면 탭바의 첫 탭과 활성 탭이 어긋나 보인다.
   * 사이드바의 에이전트-only 필터는 *목록에 무엇을 나열하는가* 의 규칙이고, 이 자동 선택은
   * 그 목록과 무관한 workspace 진입 동작이다.
   */
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
              {sortWorktrees(repo.worktrees, activeWorkspaceId).map((worktree) => {
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
