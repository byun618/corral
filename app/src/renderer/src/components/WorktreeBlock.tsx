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
import { useEffect, useState } from 'react'
import type { AgentKind, IntegrationRow, OrchestrationLineage, RetainedAgentRow, WorktreeRow } from '../../../shared/types.js'
import { gitMarkLabel, gitTone } from '../git-marks.js'
import { collapsedSummary } from '../session-summary.js'
import { buildAgentRows, SUMMARY_MIN_ROOTS, type AgentRowNode } from '../sidebar-agents.js'
import { worktreeDisplayName } from '../worktree-name.js'
import { worktreeStatus } from '../worktree-status.js'
import { AgentGroupHeader } from './AgentGroupHeader.js'
import { EllipsisIcon, PlusIcon } from './AgentStateDot.js'
import { SessionRow } from './SessionRow.js'
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
  groupExpanded,
  onToggleGroup,
  onSelectBlock,
  onSelectSession,
  onCloseSession,
  onCloseWorktree,
  onCreateShell,
  onCreateAgent,
}: {
  worktree: WorktreeRow
  /** 사이드바에서 끌어 옮기는 중 (LIFE-469) — 열린 ⋯ 메뉴를 닫는다(K3ⓖ). */
  reordering: boolean
  /** 이 카드를 끄는 중. */
  dragging: boolean
  /** 카드 끌기 시작 (LIFE-469). 주 체크아웃은 `undefined` — 맨 위 고정이라 끌리지 않는다. */
  onCardMouseDown: ((event: React.MouseEvent) => void) | undefined
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
                onToggle: () =>
                  setFoldedParents((prev) => {
                    const next = new Set(prev)
                    if (next.has(node.key)) next.delete(node.key)
                    else next.add(node.key)
                    return next
                  }),
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

  return (
    <div
      className={`worktree-row ${dragging ? 'is-reorder-source' : ''}`}
      data-worktree={worktree.path}
      data-reorder-card={onCardMouseDown === undefined ? undefined : worktree.path}
      onMouseDown={onCardMouseDown}
    >
      <div
        className={`worktree-block ${selected ? 'is-selected' : 'worktree-card-hover'}`}
        data-worktree-card-surface=""
        data-worktree-card-active={selected ? 'primary' : undefined}
        data-chip-worktree={worktree.path}
        data-chip-value={worktree.openWorkspaceId !== null ? 'open' : 'closed'}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onSelectBlock}
      >
        <div className="worktree-card-content" data-worktree-card-parent-content="">
          <WorktreeStatusSlot status={status} />
          <div className="worktree-card-main">
            <div className="worktree-card-identity" data-worktree-card-hover-trigger="">
              <div className="worktree-block-line1">
                {/* `data-worktree-branch` 의 **값**은 하네스의 요소 위치 지정자다 — 건드리지 않는다
                    (09-gate1-fix.md B 경고). 툴팁 = 제목 전문 + 절대경로 — 절대경로는 여기서만 노출한다 (§2.5, K7 긴 이름). */}
                <span className="worktree-name" data-worktree-branch={worktree.path} data-worktree-title="" title={`${title}\n${worktree.path}`}>
                  {title}
                </span>
                {groupGlyph === null ? null : (
                  <span className="worktree-groups-glyph" data-worktree-groups={worktree.path} title="영역 레이아웃이 보존돼 있다">
                    {groupGlyph}
                  </span>
                )}
                {!worktree.isLinked ? (
                  <span className="worktree-chip" data-worktree-primary-badge="" title="주 워크트리 (원래 클론 폴더)">
                    기본
                  </span>
                ) : null}
                {isOpen ? (
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
              {branch === null && markLabel === null ? null : (
                <div className="worktree-block-line2" data-worktree-card-meta-row="">
                  {branch === null ? null : (
                    <span className="worktree-sub" data-worktree-meta-branch="" title={branch}>
                      {branch}
                    </span>
                  )}
                  {markLabel !== null ? <span className={`worktree-mark tone-${tone}`}>{markLabel}</span> : null}
                </div>
              )}
            </div>
            {/* 열린 workspace 가 없어도 그린다 — 마지막 pane 이 끝나고 workspace 가 사라진 worktree 의 보존 행(R1). */}
            {roots.length > 0 ? (
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
        {menuOpen ? (
          <div className="repo-row-menu worktree-menu" data-worktree-menu={worktree.path} onClick={(event) => event.stopPropagation()}>
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
