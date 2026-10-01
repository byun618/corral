// design-handoff.md §1 — 사이드바 4단 전개(repo 헤더 → worktree 2줄 블록 → 세션 행). 이 파일은
// C6 이 나열한 개별 컴포넌트(SidebarBrandBar 등)를 엮는 조립부다 — 자체는 판정표에 없는 이름이라
// 자유롭게 구조화했다.
import { useRef, type RefObject } from 'react'
import type { AgentKind, AppState, WorktreeRow } from '../../../shared/types.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { useNowTick } from '../hooks/useNowTick.js'
import { useSidebarReorder, type ReorderCommit } from '../hooks/useSidebarReorder.js'
import { orderRepos, orderWorktrees, type ManualOrder } from '../manual-order.js'
import { pickPane } from '../pane-utils.js'
import { flashPaneRim } from '../pane-rim-flash.js'
import { livePaneIdsOf, retainedByWorktree } from '../sidebar-agents.js'
import { RepoRow } from './RepoRow.js'
import { ReposSectionHeader } from './ReposSectionHeader.js'
import { SidebarBrandBar } from './SidebarBrandBar.js'
import { SidebarFooterToolbar } from './SidebarFooterToolbar.js'
import { SidebarSearch } from './SidebarSearch.js'
import { WorktreeBlock } from './WorktreeBlock.js'

export function Sidebar({
  onToggleSidebar,
  shortcutHint,
  sidebarRef,
  width,
  state,
  activeWorkspaceId,
  selectedPane,
  selectPane,
  closePane,
  actions,
  manualOrder,
  onReorder,
  isRepoCollapsed,
  toggleRepoCollapsed,
  isGroupExpanded,
  toggleGroupExpanded,
  onAddRepo,
  onRemoveRepo,
  onRefresh,
  groupGlyphOf,
}: {
  onToggleSidebar: () => void
  shortcutHint: string
  sidebarRef: RefObject<HTMLDivElement | null>
  width: number
  state: AppState
  activeWorkspaceId: string | null
  selectedPane: string | null
  selectPane: (paneId: string) => void
  closePane: (paneId: string) => void
  actions: LifecycleActions
  /** 레포·워크트리 수동 순서 (LIFE-469) — 표시 순서는 여기서 나온다. */
  manualOrder: ManualOrder
  onReorder: (commit: ReorderCommit) => void
  isRepoCollapsed: (root: string) => boolean
  toggleRepoCollapsed: (root: string) => void
  /** 에이전트 묶음 알약이 펼쳐져 있나 (LIFE-467 — 기본 접힘, 펼친 것만 영속). */
  isGroupExpanded: (worktreePath: string) => boolean
  toggleGroupExpanded: (worktreePath: string) => void
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
   *
   * 행이 주는 것은 pane id 하나다(LIFE-467 — 서브에이전트 행은 부모 pane, 보존 행은 아직 살아 있는 그 pane).
   * 그 pane 의 workspace 는 지금 상태에서 찾는다. 고른 뒤 pane 테두리를 한 번 번쩍인다(D11 — Orca 림 플래시 1.5s).
   */
  const onSelectSession = (paneId: string): void => {
    const workspaceId = workspaceOfPane(paneId)
    if (workspaceId === null) return
    if (workspaceId !== activeWorkspaceId) actions.activateWorkspace(workspaceId)
    selectPane(paneId)
    flashPaneRim(paneId)
  }
  const workspaceOfPane = (paneId: string): string | null => {
    for (const repo of state.repos)
      for (const worktree of repo.worktrees)
        for (const tab of worktree.workspace?.tabs ?? []) if (tab.panes.some((pane) => pane.paneId === paneId)) return tab.workspaceId
    return null
  }
  const listRef = useRef<HTMLDivElement | null>(null)
  const reorder = useSidebarReorder({ listRef, onCommit: onReorder })
  const dragSource = reorder.state?.source ?? null
  const livePaneIds = livePaneIdsOf(state.repos)
  const retainedOf = retainedByWorktree({ repos: state.repos, retained: state.retainedAgents })

  return (
    <div className={`sidebar ${reorder.state !== null ? 'is-reordering' : ''}`} data-sidebar ref={sidebarRef} style={{ width }}>
      <SidebarBrandBar onToggle={onToggleSidebar} shortcutHint={shortcutHint} />
      <SidebarSearch />
      <ReposSectionHeader onAddRepo={onAddRepo} />
      <div className="repo-list" data-repo-list ref={listRef}>
        {state.repos.length === 0 ? (
          <p className="sidebar-empty" data-empty>
            등록된 레포가 없다. 위의 「+」 로 폴더를 고른다.
          </p>
        ) : (
          orderRepos({ repos: state.repos, stored: manualOrder.repos }).map((repo) => (
            <RepoRow
              key={repo.root}
              repo={repo}
              reordering={reorder.state !== null}
              dragging={dragSource?.kind === 'repo' && dragSource.root === repo.root}
              onHeadMouseDown={(event) => reorder.onRepoMouseDown({ event, root: repo.root })}
              collapsed={isRepoCollapsed(repo.root)}
              onToggleCollapse={() => toggleRepoCollapsed(repo.root)}
              onCreateWorktree={() => actions.openCreateWorktree(repo.root)}
              onRemove={() => onRemoveRepo(repo.root)}
            >
              {orderWorktrees({ worktrees: repo.worktrees, stored: manualOrder.worktrees[repo.root] }).map((worktree) => {
                const selected = worktree.openWorkspaceId !== null && worktree.openWorkspaceId === activeWorkspaceId
                return (
                  <WorktreeBlock
                    key={worktree.path}
                    worktree={worktree}
                    reordering={reorder.state !== null}
                    dragging={dragSource?.kind === 'card' && dragSource.path === worktree.path}
                    // 주 체크아웃도 옮긴다(게이트 ① 사용자 수정 1 — 198 `section-order.ts:66-74` 고정과 의도적 차이).
                    onCardMouseDown={(event) => reorder.onCardMouseDown({ event, repoRoot: repo.root, path: worktree.path })}
                    integrations={state.integrations}
                    home={state.home}
                    now={now}
                    retained={retainedOf.get(worktree.path) ?? []}
                    lineage={state.orchestrationLineage}
                    livePaneIds={livePaneIds}
                    selected={selected}
                    selectedPane={selectedPane}
                    groupGlyph={selected ? null : groupGlyphOf(worktree.path)}
                    groupExpanded={isGroupExpanded(worktree.path)}
                    onToggleGroup={() => toggleGroupExpanded(worktree.path)}
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
                    onCloseSession={closePane}
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
        {reorder.state?.indicatorY != null ? <ReorderDropIndicator y={reorder.state.indicatorY} /> : null}
      </div>
      <SidebarFooterToolbar onRefresh={onRefresh} />
    </div>
  )
}

/**
 * 드롭 표시 줄 — 198 `WorktreeSidebarDropIndicator.tsx:17-25` 대응: 양끝 점 6px(`size-1.5`) + 가운데 막대 2px(`h-0.5`),
 * 색 `--worktree-sidebar-ring`, 바탕색 2px 그림자 테두리, `left-3 right-2 z-30`(sticky 헤더 z 20 위), 세로 가운데 맞춤.
 */
function ReorderDropIndicator({ y }: { y: number }): React.JSX.Element {
  return (
    <div className="reorder-drop-indicator" data-reorder-indicator="" role="presentation" style={{ top: `${y}px` }}>
      <span className="reorder-drop-dot" />
      <span className="reorder-drop-bar" />
      <span className="reorder-drop-dot" />
    </div>
  )
}
