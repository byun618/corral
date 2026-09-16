// design-handoff.md §1 — 사이드바 4단 전개(repo 헤더 → worktree 2줄 블록 → 세션 행). 이 파일은
// C6 이 나열한 개별 컴포넌트(SidebarBrandBar 등)를 엮는 조립부다 — 자체는 판정표에 없는 이름이라
// 자유롭게 구조화했다.
import type { RefObject } from 'react'
import type { AgentKind, AppState, TabRow, WorktreeRow } from '../../../shared/types.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { useNowTick } from '../hooks/useNowTick.js'
import { pickPane } from '../pane-utils.js'
import { sortWorktrees } from '../worktree-name.js'
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
  groupGlyphOf,
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
  /** 비활성 worktree 의 보존된 영역 레이아웃 글리프 (LIFE-373). 없으면 null. */
  groupGlyphOf: (worktreePath: string) => string | null
}): React.JSX.Element {
  // 경과 시간이 얼지 않게 **한 곳에서만** 시계를 돌린다 (LIFE-366 D1) — 행마다 타이머를 두면
  // 세션 수만큼 타이머가 생긴다.
  const now = useNowTick()
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

  /**
   * 세션 행 클릭 — **그 탭의 workspace 를 먼저 활성화**하고 pane 을 고른다 (11-gate1-fix3.md I-6).
   *
   * 전에는 `selectPane` 만 불렀다. 그래서 활성이 아닌 worktree 의 세션을 누르면 터미널만 바뀌고
   * 탭바·상태바는 딴 workspace 를 계속 가리켰다 — `App.tsx` 의 `activeWorkspace` 가
   * `activeWorkspaceId` 를 따르기 때문이다. `onSelectBlock` 이
   * `activateWorkspace` → `selectFirstSession` 순으로 하는 것과 같은 결로 맞춘다.
   */
  const onSelectSession = (tab: TabRow): void => {
    if (tab.workspaceId !== activeWorkspaceId) actions.activateWorkspace(tab.workspaceId)
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
                    integrations={state.integrations}
                    home={state.home}
                    now={now}
                    selected={selected}
                    selectedPane={selectedPane}
                    groupGlyph={selected ? null : groupGlyphOf(worktree.path)}
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
