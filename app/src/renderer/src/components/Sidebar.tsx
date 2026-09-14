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
 * worktree 정렬 — **이름 사전순 고정**.
 *
 * 요구는 "열려 있는 세션과 상관없이 순서가 고정"이다. 그래서 정렬 키는 worktree 이름
 * (`branch ?? path`) 하나뿐이고, **세션 수·열림 여부·선택 여부는 키에 넣지 않는다** —
 * 활성 상태를 키에 넣었다가 세션을 열고 닫을 때마다 목록이 눈앞에서 재배열된 것이
 * 이 규칙이 생긴 이유다(10-gate1-fix2.md H-1).
 *
 * herdr 가 주는 배열 순서를 그대로 쓰지 않는 이유도 같다 — 그 순서에는 고정 보장이 없다.
 * 여기서 한 번 정렬해야 세션 상태와 무관하게 같은 순서가 나온다.
 */
function worktreeName(worktree: WorktreeRow): string {
  return worktree.branch ?? worktree.path
}

function sortWorktrees(worktrees: WorktreeRow[]): WorktreeRow[] {
  // 이름은 중복될 수 없어 동률 처리는 필요 없지만, `sort` 는 ES2019 부터 안정 정렬이라
  // 혹시 동률이 생겨도 들어온 순서가 유지된다.
  return [...worktrees].sort((a, b) => worktreeName(a).localeCompare(worktreeName(b)))
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
              {sortWorktrees(repo.worktrees).map((worktree) => {
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
