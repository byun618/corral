// 워크트리 카드 (LIFE-468 D22·D23) — Orca 1.4.198 **Detailed(기본)·구 카드** 해부:
//   [data-worktree] 행 래퍼(Orca `[data-worktree-id]`) → 카드 표면(`data-worktree-card-surface`, 선택 시
//   `data-worktree-card-active="primary"`) → [상태 슬롯 | 본문 열(제목 줄 · 메타 줄 · 에이전트 목록)].
//
// · 상태 슬롯 = 워크트리의 **에이전트 활동 집계**(`worktree-status.ts`) — git 상태가 아니다(Orca `StatusIndicator`).
// · 제목 = 표시 이름(`worktreeDisplayName` — 브랜치 풀네임), 메타 줄 = 브랜치. **같아도 둘 다 그린다** — 198 Detailed 가
//   그렇다(`showBranch` 는 Detailed 에서 같아도 참, 01-criteria 기준 변경 1 · LIFE-357 H-2 사용자 결정과 일치).
// · 주 워크트리 = 외곽선 배지(Orca `primary` 배지 외관, 문구 「기본」 — 한국어 UI). 별은 Compact 전용이라 없다.
// · git 상태(dirty/ahead/behind)는 corral 고유 정보라 메타 줄 오른쪽(Orca 의 상세·포트 자리)에 둔다 — 의도적 추가.
// · hover `+`/`⋯`(빈 탭·에이전트 기동·worktree 닫기)는 corral 고유 진입점이라 유지한다 — 제목 줄 오른쪽에 겹쳐 hover 때만.
//   01-criteria C1 의 「세션(탭) 생성·닫기」 진입점이다(MainTabBar 는 탭 2개 이상에서만 선다).
// · 선택 표시는 표면만 바꾼다 — 옛 「이름 밝힘·점 accent 강제」는 198 에 없어 뺐다(K6ⓔ).
//
// ## Card layout · Show properties · Agent activity layout (LIFE-477 · 448 S4-B)
//
// · Compact(198 `worktree-card-presentation.tsx:73-111`): 메타 줄 없음 · 세로 패딩 8px(`py-2` 제목만 카드) · 「기본」 칩 대신 오른쪽 끝 ★ ·
//   레포 이름은 제목 앞 칩(Group by None 일 때 — 198 인라인 repo 칩, corral 은 레포 아이콘이 없어 이름 칩) · **에이전트 목록 없음**(상태 점은 남는다).
//   git 마크는 제목 줄에 안 그리고 제목 hover 카드로 옮긴다(Q-W1 사용자 결정 — `card-display.ts`).
// · 에이전트 활동 끔(`cardProperties` 에 `inline-agents` 없음) → 목록(알약·행) 전체가 사라지고 상태 점은 남는다.
// · Full list → 루트마다 3줄 행(`AgentFullRow`), 묶음 알약 없음, 자식은 기본 펼침.
import { useEffect, useRef, useState } from 'react'
import type { AgentKind, IntegrationRow, OrchestrationLineage, RetainedAgentRow, WorktreeRow } from '../../../shared/types.js'
import type { SidebarAgentActivityLayout, SidebarCardLayout } from '../../../shared/sidebar-view.js'
import { compactHoverContent, type CompactHover } from '../card-display.js'
import { gitMarkLabel, gitTone } from '../git-marks.js'
import { collapsedSummary } from '../session-summary.js'
import { buildAgentRows, SUMMARY_MIN_ROOTS, type AgentRowNode } from '../sidebar-agents.js'
import { worktreeDisplayName } from '../worktree-name.js'
import { worktreeStatus } from '../worktree-status.js'
import { AgentFullRow } from './AgentFullRow.js'
import { AgentGroupHeader } from './AgentGroupHeader.js'
import { EllipsisIcon, PlusIcon } from './AgentStateDot.js'
import { HoverCard } from './HoverCard.js'
import { SessionRow } from './SessionRow.js'
import { NoteIcon, StarIcon, TrashIcon } from './SidebarIcons.js'
import { useMenuBus } from '../menu-bus.js'
import { WorktreeStatusSlot } from './WorktreeStatusSlot.js'

const AGENT_KINDS: Array<{ kind: AgentKind; label: string }> = [
  { kind: 'claude', label: 'claude 기동' },
  { kind: 'codex', label: 'codex 기동' },
  { kind: 'grok', label: 'grok 기동' },
]

export function WorktreeBlock({
  worktree,
  reordering,
  dragging,
  onCardMouseDown,
  selected,
  selectedPane,
  groupGlyph,
  integrations,
  home,
  now,
  retained,
  lineage,
  livePaneIds,
  unreadPanes = NO_UNREAD,
  groupExpanded,
  onToggleGroup,
  onSelectBlock,
  onSelectSession,
  onCloseSession,
  onCloseWorktree,
  onCreateShell,
  onCreateAgent,
  repoLabel = null,
  layout = 'detailed',
  showAgents = true,
  agentLayout = 'compact',
  card = NO_CARD_ACTIONS,
}: {
  /** 카드 메뉴 쪽 상태·손잡이 (LIFE-478) — 우클릭·rename·삭제·고정·Reveal 번쩍. 기본값은 아무 것도 안 한다(옛 호출부·시험). */
  card?: CardActions
  /** Card layout (LIFE-477) — 기본 Detailed. */
  layout?: SidebarCardLayout
  /** 에이전트 목록을 그리나 — `showsInlineAgents(view)`(에이전트 활동 켬 + Detailed). 상태 점과는 무관하다. */
  showAgents?: boolean
  /** Agent activity layout — Compact(467 알약·한 줄) / Full list(3줄). */
  agentLayout?: SidebarAgentActivityLayout
  worktree: WorktreeRow
  /**
   * 레포 이름 (LIFE-470) — Group by None 처럼 레포 헤더가 없는 구획에서만 준다. 둘째 줄 앞에 붙어 같은 브랜치 이름(`main`)의
   * 카드가 어느 레포인지 가른다(198 은 카드 메타의 프로젝트 배지). 레포 헤더 아래에서는 null.
   */
  repoLabel?: string | null
  /** 사이드바에서 끌어 옮기는 중 (LIFE-469) — 열린 ⋯ 메뉴를 닫는다(K3ⓖ). */
  reordering: boolean
  /** 이 카드를 끄는 중. */
  dragging: boolean
  /** 카드 끌기 시작 (LIFE-469) — 주 체크아웃 포함 모든 카드(게이트 ① 사용자 수정 1). */
  onCardMouseDown: (event: React.MouseEvent) => void
  selected: boolean
  /**
   * 보존된 영역 레이아웃의 예고 (LIFE-373 L-③ · §2 Sidebar WorktreeBlock).
   *
   * 비활성 worktree 에 영역이 2개 이상이면 `◫`(좌우) / `⊟`(상하). "돌아가면 저 모양으로
   * 복원된다"를 미리 말한다. 활성 worktree 는 지금 화면이 그 모양이라 표시하지 않는다.
   */
  groupGlyph: string | null
  selectedPane: string | null
  /** herdr 통합 설치 상태 — 2차 줄이 "왜 비었나" 를 말할 때 쓴다 (LIFE-366 B8). */
  integrations: readonly IntegrationRow[]
  /** 셸 탭 폴백이 경로를 접는 데 쓴다 (LIFE-366 C9). `AppState.home` 그대로다. */
  home: string
  /** 흐르는 「지금」 — 경과 시간용 (LIFE-366 D1). */
  now: number
  /** 닫힌 탭의 완료 기록 — **이 worktree 의 것만** (`retainedByWorktree`, LIFE-467 D9 · R1). 열린 workspace 가 없어도 행이 된다. */
  retained: readonly RetainedAgentRow[]
  /** orchestration 계보 (LIFE-459) — 부모·자식 행 (LIFE-467 D8). */
  lineage: OrchestrationLineage
  /** 앱 전체의 살아 있는 pane — 보존 행이 갈 곳이 있나 (B2). */
  livePaneIds: ReadonlySet<string>
  /** 확인 안 된 완료가 있는 pane (LIFE-471 `useUnread`) — 행 굵기·행 점·상태 칸. 기본은 없음(옛 호출부·시험). */
  unreadPanes?: ReadonlySet<string>
  /** 묶음 알약이 펼쳐져 있나 — worktree 별로 영속한다(ui-prefs `expandedAgentGroups`). 기본은 접힘(Orca 와 같다). */
  groupExpanded: boolean
  onToggleGroup: () => void
  onSelectBlock: () => void
  onSelectSession: (paneId: string) => void
  onCloseSession: (paneId: string) => void
  onCloseWorktree: () => void
  onCreateShell: () => void
  onCreateAgent: (kind: AgentKind) => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // K2ⓖ — 카드 ⋯ 도 메뉴 하나 규칙(다른 메뉴가 열리면 닫힘)과 바깥 클릭·Esc 닫기를 갖는다.
  useMenuBus({ open: menuOpen, close: () => setMenuOpen(false) })
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent): void => {
      // ⋯ 단추 자신은 토글이 맡는다(여기서 닫으면 같은 클릭이 다시 연다).
      if (event.target instanceof Element && event.target.closest('[data-worktree-menu-toggle]') !== null) return
      if (!(event.target instanceof Node) || menuRef.current?.contains(event.target) !== true) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menuOpen])
  /** 접은 계보 부모 — 기본은 펼침이다(Orca: "spawned child agents are actionable work", `WorktreeCardAgents.tsx:256`). */
  const [foldedParents, setFoldedParents] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (reordering) setMenuOpen(false)
  }, [reordering])
  const tone = gitTone(worktree.gitStatus)
  const markLabel = gitMarkLabel(worktree.gitStatus)
  // **사이드바는 에이전트 세션만 그린다** (09-gate1-fix.md D). 행 나무(`sidebar-agents.ts`)가 셸 탭을 거르고
  // 계보·서브에이전트·보존 행을 한 번에 엮는다 — 알약 임계·요약·펼친 목록이 전부 이 루트 목록 하나를 본다.
  const roots = buildAgentRows({
    tabs: worktree.workspace?.tabs ?? [],
    retained,
    lineage,
    livePaneIds,
    integrations,
    home,
    unreadPanes,
  })
  const hasGroup = roots.length >= SUMMARY_MIN_ROOTS
  const showRows = !hasGroup || groupExpanded
  const summary = hasGroup ? collapsedSummary({ rows: roots }) : null
  const anyRootHasChildren = roots.some((node) => node.children.length > 0)
  const isOpen = worktree.workspace !== null

  // 표시 이름은 **정렬 키와 같은 함수**에서 온다 — 둘이 갈라져서 보이는 이름 기준 역순이
  // 나온 적이 있다(worktree-name.ts 주석).
  const title = worktreeDisplayName(worktree)
  // 메타 줄 = 브랜치. 브랜치가 없는(detached) worktree 만 비운다 — 절대경로는 행에 안 넣는다(§2.5, 툴팁에만).
  const branch = worktree.branch
  const status = worktreeStatus({ rows: roots, hasOpenTabs: (worktree.workspace?.tabs.length ?? 0) > 0 })
  const compact = layout === 'compact'
  const hover = compact ? compactHoverContent({ branch, title, gitStatus: worktree.gitStatus, comment: worktree.comment, parent: card.parentName }) : null
  const full = agentLayout === 'full'

  const toggleFolded = (key: string): void =>
    setFoldedParents((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const renderRow = ({ node, child }: { node: AgentRowNode; child: boolean }): React.JSX.Element => {
    const hasChildren = !child && node.children.length > 0
    return (
      <SessionRow
        key={node.key}
        node={node}
        now={now}
        focused={node.source === 'live' && node.paneId === selectedPane}
        child={child}
        disclosure={
          hasChildren
            ? {
                expanded: !foldedParents.has(node.key),
                count: node.children.length,
                onToggle: () => toggleFolded(node.key),
              }
            : null
        }
        reserveGutter={!child && !hasChildren && anyRootHasChildren}
        onActivate={onSelectSession}
        onClose={onCloseSession}
      />
    )
  }
  const renderBranch = (node: AgentRowNode): React.JSX.Element => (
    <div className="agent-branch" key={node.key}>
      {renderRow({ node, child: false })}
      {node.children.length > 0 && !foldedParents.has(node.key) ? (
        <div className="agent-lineage-children" data-agent-children={node.key}>
          {node.children.map((childNode) => renderRow({ node: childNode, child: true }))}
        </div>
      ) : null}
    </div>
  )
  // Full list — 같은 나무·같은 접힘 상태, 행만 3줄(`AgentFullRow`). 198 `renderAgentBranch`(`WorktreeCardAgents.tsx:243-303`).
  const renderFullRow = ({ node, child }: { node: AgentRowNode; child: boolean }): React.JSX.Element => {
    const hasChildren = !child && node.children.length > 0
    return (
      <AgentFullRow
        key={node.key}
        node={node}
        now={now}
        focused={node.source === 'live' && node.paneId === selectedPane}
        child={child}
        disclosure={hasChildren ? { expanded: !foldedParents.has(node.key), count: node.children.length, onToggle: () => toggleFolded(node.key) } : null}
        reserveGutter={!child && !hasChildren && anyRootHasChildren}
        onActivate={onSelectSession}
        onClose={onCloseSession}
      />
    )
  }
  const renderFullBranch = (node: AgentRowNode): React.JSX.Element => (
    <div className="agent-full-branch" key={node.key}>
      {renderFullRow({ node, child: false })}
      {node.children.length > 0 && !foldedParents.has(node.key) ? (
        <div className="agent-lineage-children is-full" data-agent-children={node.key}>
          {node.children.map((childNode) => renderFullRow({ node: childNode, child: true }))}
        </div>
      ) : null}
    </div>
  )

  return (
    <div
      className={`worktree-row ${dragging ? 'is-reorder-source' : ''}`}
      data-worktree={worktree.path}
      data-reorder-card={card.reorderable ? worktree.path : undefined}
      data-worktree-pinned={card.pinned ? '' : undefined}
      onMouseDown={card.reorderable ? onCardMouseDown : undefined}
    >
      <div
        className={`worktree-block ${selected ? 'is-selected' : 'worktree-card-hover'} ${compact ? 'is-compact' : ''} ${card.deleting ? 'is-deleting' : ''} ${card.flash ? 'card-reveal-flash' : ''}`}
        data-worktree-deleting={card.deleting ? '' : undefined}
        data-worktree-card-surface=""
        data-card-layout={layout}
        data-worktree-card-active={selected ? 'primary' : undefined}
        data-chip-worktree={worktree.path}
        data-chip-value={worktree.openWorkspaceId !== null ? 'open' : 'closed'}
        onMouseEnter={() => {
          setHovered(true)
          card.onHover(true)
        }}
        onMouseLeave={() => {
          setHovered(false)
          card.onHover(false)
        }}
        onClick={() => {
          // 삭제 중 카드는 클릭을 삼킨다(198 `use-worktree-card-activation-actions.ts:71-75`).
          if (!card.deleting) onSelectBlock()
        }}
        // 우클릭 = 메뉴. 카드를 활성화하지 않고 끌기도 시작하지 않는다(K2ⓑ — 끌기는 왼쪽 단추만 무장한다).
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          card.onContextMenu({ x: event.clientX, y: event.clientY })
        }}
        // 제목 밖 더블클릭 = 상세 대화(198 `activation-actions.ts:119-135`). 에이전트 목록·단추 위는 제외.
        onDoubleClick={(event) => {
          if (card.deleting) return
          if (event.target instanceof Element && event.target.closest('.agent-list, button, input, textarea, [data-worktree-title]') !== null) return
          card.onOpenDetails()
        }}
      >
        <div className="worktree-card-content" data-worktree-card-parent-content="">
          {/* 삭제 중 카드는 클릭을 삼킨다(198) — 벨 모양은 그대로 두고 토글만 막는다. */}
          <WorktreeStatusSlot status={status} unread={card.unread} onToggleUnread={() => {
            if (!card.deleting) card.onToggleUnread()
          }} />
          <div className="worktree-card-main">
            <div className="worktree-card-identity" data-worktree-card-hover-trigger="">
              <div className="worktree-block-line1">
                {/* `data-worktree-branch` 의 **값**은 하네스의 요소 위치 지정자다 — 건드리지 않는다
                    (09-gate1-fix.md B 경고). 툴팁 = 제목 전문 + 절대경로 — 절대경로는 여기서만 노출한다 (§2.5, K7 긴 이름). */}
                {compact && repoLabel !== null ? (
                  <span className="worktree-repo-chip" data-worktree-repo-chip="" title={repoLabel}>
                    {repoLabel}
                  </span>
                ) : null}
                {card.renaming ? (
                  <InlineRename title={title} path={worktree.path} onCommit={card.onRenameCommit} onCancel={card.onRenameCancel} />
                ) : (
                  <HoverCard
                    content={hover === null ? null : <CompactHoverBody hover={hover} />}
                    suppressed={reordering}
                    testId={worktree.path}
                    render={(trigger) => (
                      // hover 카드가 있으면 네이티브 툴팁을 겹치지 않는다(198 `titleWrapper` 주석 — 「don't stack the title's truncation tooltip」).
                      <span
                        {...trigger}
                        className="worktree-name"
                        data-worktree-branch={worktree.path}
                        data-worktree-title=""
                        title={hover === null ? `${title}\n${worktree.path}` : undefined}
                        // 제목 더블클릭 = 인라인 rename(198 `WorktreeTitleInlineRename.tsx:188-198`).
                        onDoubleClick={(event) => {
                          event.stopPropagation()
                          if (!card.deleting) card.onBeginRename()
                        }}
                      >
                        {title}
                      </span>
                    )}
                  />
                )}
                {worktree.comment === null ? null : (
                  // 198 노트 배지(`WorktreeCardMetaBadges.tsx:81-90` StickyNote 「Workspace notes」) + hover 로 내용(Notes 절).
                  <HoverCard
                    content={<NoteHoverBody comment={worktree.comment} />}
                    suppressed={reordering}
                    openDelay={250}
                    testId={`${worktree.path}#note`}
                    render={(trigger) => (
                      <span {...trigger} className="worktree-note-badge" data-worktree-note-badge="" aria-label="워크스페이스 메모">
                        <NoteIcon className="worktree-note-icon" />
                      </span>
                    )}
                  />
                )}
                {groupGlyph === null ? null : (
                  <span className="worktree-groups-glyph" data-worktree-groups={worktree.path} title="영역 레이아웃이 보존돼 있다">
                    {groupGlyph}
                  </span>
                )}
                {!worktree.isLinked && !compact ? (
                  <span className="worktree-chip" data-worktree-primary-badge="" title="주 워크트리 (원래 클론 폴더)">
                    기본
                  </span>
                ) : null}
                {!worktree.isLinked && compact ? (
                  <span className="worktree-primary-star" data-worktree-primary-star="" title="주 워크트리 (원래 클론 폴더)" aria-label="주 워크트리">
                    <StarIcon className="worktree-primary-star-icon" />
                  </span>
                ) : null}
                {card.showTrash && hovered && worktree.isLinked && !card.deleting ? (
                  // Option 을 누르고 있는 동안만(198 `workspace-delete-quick-action.ts:21-31`) — 같은 확인 대화로 간다.
                  <button
                    className="repo-row-action-btn worktree-trash-btn"
                    data-worktree-trash={worktree.path}
                    title="워크트리 삭제"
                    aria-label="워크트리 삭제"
                    onClick={(event) => {
                      event.stopPropagation()
                      card.onDelete()
                    }}
                  >
                    <TrashIcon className="repo-row-action-icon is-small" />
                  </button>
                ) : null}
                {isOpen && !card.deleting ? (
                  <div className={`worktree-block-actions ${hovered || menuOpen ? 'is-active' : ''}`} data-worktree-actions={worktree.path}>
                    <button
                      className="repo-row-action-btn"
                      data-create-row={worktree.openWorkspaceId ?? ''}
                      data-kind="shell"
                      title="빈 탭"
                      aria-label="빈 탭"
                      onClick={(event) => {
                        event.stopPropagation()
                        onCreateShell()
                      }}
                    >
                      <PlusIcon className="repo-row-action-icon is-small" />
                    </button>
                    <button
                      className="repo-row-action-btn"
                      data-worktree-menu-toggle={worktree.path}
                      title="더보기"
                      aria-label="더보기"
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenuOpen((prev) => !prev)
                      }}
                    >
                      <EllipsisIcon className="repo-row-action-icon" />
                    </button>
                  </div>
                ) : null}
              </div>
              {compact || (branch === null && markLabel === null && repoLabel === null && card.parentName === null) ? null : (
                <div className="worktree-block-line2" data-worktree-card-meta-row="">
                  {repoLabel === null ? null : (
                    <span className="worktree-repo-label" data-worktree-repo-label="" title={repoLabel}>
                      {repoLabel}
                    </span>
                  )}
                  {branch === null ? null : (
                    <span className="worktree-sub" data-worktree-meta-branch="" title={branch}>
                      {branch}
                    </span>
                  )}
                  {card.parentName === null ? null : (
                    // 198 은 자식을 부모 아래 중첩해 보인다 — corral 은 중첩을 만들지 않고(게이트 ⓪ Q4) 메타 줄에 상위 이름을 적는다(K6ⓔ).
                    <span className="worktree-parent-chip" data-worktree-parent={worktree.parentPath ?? ''} title={`상위 워크트리: ${card.parentName}`}>
                      ↳ {card.parentName}
                    </span>
                  )}
                  {markLabel !== null ? <span className={`worktree-mark tone-${tone}`}>{markLabel}</span> : null}
                </div>
              )}
            </div>
            {/* 열린 workspace 가 없어도 그린다 — 마지막 pane 이 끝나고 workspace 가 사라진 worktree 의 보존 행(R1). */}
            {showAgents && roots.length > 0 && full ? (
              <div className="agent-list is-full" data-full-agent-list={worktree.path} onClick={(event) => event.stopPropagation()}>
                {roots.map((node) => renderFullBranch(node))}
              </div>
            ) : null}
            {showAgents && roots.length > 0 && !full ? (
              // 목록 한 덩어리 — 본문 열에서 왼쪽으로 8px 내어 나간다(Orca `[data-compact-agent-list]` `-ml-2`, 이관 ④).
              <div className={`agent-list ${hasGroup ? 'is-grouped' : ''}`} data-compact-agent-list={worktree.path} onClick={(event) => event.stopPropagation()}>
                {hasGroup && summary !== null ? (
                  <AgentGroupHeader
                    worktreePath={worktree.path}
                    count={roots.length}
                    summary={summary}
                    expanded={groupExpanded}
                    onToggle={(event) => {
                      event.stopPropagation()
                      onToggleGroup()
                    }}
                  />
                ) : null}
                {/* 접힌 알약 아래 행은 **DOM 에 없다** — C3ⓑ 하네스가 `[data-tab]` 개수로 「접힌 자식 DOM 미존재」를 본다.
                    펼칠 때만 짧은 등장 애니메이션을 준다(`agent-list-rows` — Orca reveal 키프레임). */}
                {showRows ? (
                  <div className={`agent-list-rows ${hasGroup ? 'is-revealed' : ''}`}>
                    {roots.map((node) => renderBranch(node))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {card.deleting ? (
          <div className="worktree-deleting-pill" data-worktree-deleting-pill="">
            삭제 중…
          </div>
        ) : null}
        {menuOpen ? (
          <div ref={menuRef} className="repo-row-menu worktree-menu" data-worktree-menu={worktree.path} onClick={(event) => event.stopPropagation()}>
            <div
              className="repo-row-menu-item"
              data-worktree-create-shell={worktree.path}
              onClick={() => {
                setMenuOpen(false)
                onCreateShell()
              }}
            >
              <span className="repo-row-menu-glyph">+</span>
              <span>빈 탭</span>
            </div>
            {AGENT_KINDS.map(({ kind, label }) => (
              <div
                key={kind}
                className="repo-row-menu-item"
                data-worktree-create-agent={worktree.path}
                data-kind={kind}
                onClick={() => {
                  setMenuOpen(false)
                  onCreateAgent(kind)
                }}
              >
                <span className="repo-row-menu-glyph">›</span>
                <span>{label}</span>
              </div>
            ))}
            <div className="repo-row-menu-sep" />
            <div
              className="repo-row-menu-item repo-row-menu-danger"
              data-close-worktree={worktree.path}
              onClick={() => {
                setMenuOpen(false)
                onCloseWorktree()
              }}
            >
              <span className="repo-row-menu-glyph">−</span>
              <span>worktree 닫기</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Compact 제목 hover 카드 내용 — 198 `WorktreeCardHoverIdentityHeader`(branch-first: 브랜치 mono → 제목) + corral git 상태(Q-W1). */
function CompactHoverBody({ hover }: { hover: CompactHover }): React.JSX.Element {
  return (
    <div className="hover-card-body">
      {hover.branch === null && hover.title === null ? null : (
        <div className="hover-card-identity" data-worktree-hover-identity-header="">
          {hover.branch === null ? null : <div className="hover-card-branch">{hover.branch}</div>}
          {hover.title === null ? null : <div className="hover-card-title">{hover.title}</div>}
        </div>
      )}
      {hover.git === null ? null : (
        <div className="hover-card-section" data-hover-git="">
          <span className={`worktree-mark tone-${hover.git.tone}`}>{hover.git.mark}</span>
          <span className="hover-card-git-words">{hover.git.words}</span>
        </div>
      )}
      {hover.parent === undefined ? null : (
        <div className="hover-card-section" data-hover-parent="">
          <span className="hover-card-label">상위</span>
          <span>{hover.parent}</span>
        </div>
      )}
      {hover.comment === undefined ? null : <NoteHoverBody comment={hover.comment} />}
    </div>
  )
}

/** 198 hover 카드 「Notes」 절 — 마크다운 렌더는 하지 않고 줄바꿈을 지킨 글자로 보인다. */
function NoteHoverBody({ comment }: { comment: string }): React.JSX.Element {
  return (
    <div className="hover-card-section hover-card-notes" data-hover-notes="">
      <span className="hover-card-label">메모</span>
      <span className="hover-card-notes-text">{comment}</span>
    </div>
  )
}

/**
 * 제목 인라인 rename (198 `WorktreeTitleInlineRename.tsx`) — 글자가 선택된 채 열린다. Enter 확정 · Esc 취소 · blur 확정 ·
 * **빈 값·같은 값 = 취소**(브랜치로 되돌리지 않는다 — 그건 상세 대화의 빈 값) · IME 조합 중 Enter 무시.
 * `data-inline-rename` — 단축키 처리기가 이 입력에 양보하고(useKeybindings), 끌기 무장도 input 이라 안 된다(NON_HANDLE_SELECTOR).
 */
function InlineRename({ title, path, onCommit, onCancel }: { title: string; path: string; onCommit: (name: string) => void; onCancel: () => void }): React.JSX.Element {
  const [value, setValue] = useState(title)
  const ref = useRef<HTMLInputElement | null>(null)
  const done = useRef(false)
  /** 사용자가 입력을 떠났나 — 바깥 포인터 누름 · Tab. 그 밖의 blur 는 프로그램이 포커스를 가져간 것이다. */
  const userLeft = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
    const onPointer = (event: PointerEvent): void => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) userLeft.current = true
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') userLeft.current = true
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])
  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    const next = value.trim()
    if (!commit || next === '' || next === title) onCancel()
    else onCommit(next)
  }
  return (
    <input
      ref={ref}
      className="worktree-name-input"
      data-inline-rename={path}
      value={value}
      aria-label="워크트리 이름"
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      // 제목 더블클릭의 첫 클릭이 카드를 활성화하면 뒤늦게 터미널이 포커스를 가져간다 — 그 blur 로 rename 이 바로 닫히지 않게
      // 입력으로 되돌린다. 바깥을 누르거나 Tab · 창 전환(document 포커스 잃음)으로 떠나면 198 처럼 확정.
      onBlur={() => {
        if (!userLeft.current && document.hasFocus()) {
          requestAnimationFrame(() => {
            if (!done.current) ref.current?.focus()
          })
          return
        }
        finish(true)
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(false)
        }
      }}
    />
  )
}

/** 카드 메뉴 쪽 손잡이 (LIFE-478). Sidebar 가 채운다. */
export type CardActions = {
  /** 끌기 대상인가 — Pinned 구획 카드는 아니다(K5ⓕ). */
  reorderable: boolean
  pinned: boolean
  deleting: boolean
  renaming: boolean
  /** Reveal 번쩍 중(K9ⓔ). */
  flash: boolean
  /** Option 을 누르고 있다 — hover 중 휴지통(K7ⓗ). */
  showTrash: boolean
  /** 상위 워크트리 표시 이름 — 없으면 null. */
  parentName: string | null
  /** 안 읽음 벨이 켜져 있나 (LIFE-471 K5). */
  unread: boolean
  /** 벨 클릭 — 메뉴 Mark Read/Unread 와 같은 동작. */
  onToggleUnread: () => void
  onContextMenu: (point: { x: number; y: number }) => void
  onBeginRename: () => void
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
  onOpenDetails: () => void
  onDelete: () => void
  onHover: (hovered: boolean) => void
}

const noop = (): void => {}
const NO_UNREAD: ReadonlySet<string> = new Set()
export const NO_CARD_ACTIONS: CardActions = {
  reorderable: true,
  pinned: false,
  deleting: false,
  renaming: false,
  flash: false,
  showTrash: false,
  parentName: null,
  unread: false,
  onToggleUnread: noop,
  onContextMenu: noop,
  onBeginRename: noop,
  onRenameCommit: noop,
  onRenameCancel: noop,
  onOpenDetails: noop,
  onDelete: noop,
  onHover: noop,
}
