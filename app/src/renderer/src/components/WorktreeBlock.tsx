// design-handoff.md §2 WorktreeBlock — 1줄(상태 도트+이름+기본칩+git마크) + 2줄(브랜치명),
// 선택 시에만 카드로 올라온다(별도 컴포넌트가 아니라 같은 블록의 선택 상태 — §1).
//
// **§2.5 필드 매핑** (10-gate1-fix2.md H-2 로 갱신, 2026-09-14):
//   · 1줄 이름 = 브랜치 **leaf**(마지막 `/` 뒤), 2줄 = **브랜치 풀네임**. 이 구조는 유지된다.
//     `issue/LIFE-89` → 1줄 `LIFE-89` / 2줄 `issue/LIFE-89`
//     `main` → 1줄 `main` / 2줄 `main` — **중복이어도 2줄을 그린다.**
//   · §2.5 의 "1줄과 같으면 2줄을 숨기고 블록 높이를 줄인다"는 **철회됐다**(H-2). 사용자가
//     실물 Orca 스크린샷으로 반례를 냈다 — `main`/`main`, `ticket/012-…`/`ticket/012-…` 가
//     전부 2줄이고, 목업도 같은 47px 2줄 블록이다. 디자이너의 §2.5 는 화면을 안 보고 쓴 규칙이라
//     실물 대조가 이긴다.
//   · 절대경로는 행에 안 넣는다 — 1줄 이름의 `title` 툴팁과 CreateWorktreeModal 경로 필드에서만.
//     그래서 브랜치가 없는(detached) worktree 만은 2줄에 쓸 이름 자체가 없어 2줄을 비운다.
//   · 세션이 하나도 없는 worktree 도 2줄 블록 그대로다 — 블록만 남고 아래가 비는 게 정답이다.
//
// 핸드오프 목업에는 없지만 01-criteria.md C1(필수)이 요구하는 "세션(탭) 생성·닫기" 진입점을
// 여기 얹는다 — MainTabBar 는 sessionCount>=2 에서만 존재해(C5) 0/1개일 때 "+" 를 못 둔다.
// RepoRow 의 hover-액션(+/⋯) idiom 을 그대로 재사용해 새 시각 어휘를 늘리지 않는다: "⋯" 메뉴에
// 빈 탭 생성 · 에이전트 즉시 기동(L1/L2 자산 보존) · worktree 닫기(기존 확인 게이트 경로 유지,
// §6 "액션을 추가하지 않았다"는 상시 노출 버튼 얘기라 hover 메뉴 항목으로는 기능을 지우지 않는다).
import { useState } from 'react'
import type { AgentKind, TabRow, WorktreeRow } from '../../../shared/types.js'
import { gitMarkLabel, gitTone } from '../git-marks.js'
import { agentIcon, GLYPH } from '../session-glyphs.js'
import { isAgentTab, tabAgent } from '../session-title.js'
import { AgentGroupHeader } from './AgentGroupHeader.js'
import { SessionRow } from './SessionRow.js'

const AGENT_KINDS: Array<{ kind: AgentKind; label: string }> = [
  { kind: 'claude', label: 'claude 기동' },
  { kind: 'codex', label: 'codex 기동' },
  { kind: 'grok', label: 'grok 기동' },
]

// 01-criteria.md C3ⓑ + 부록 "세션 용어 확정" — 여기서 세는 "세션"은 **에이전트 세션**이다.
const GROUP_THRESHOLD = 3

/** 브랜치 leaf — 마지막 `/` 뒤. 슬래시가 없으면 풀네임 그대로다. */
function branchLeaf(branch: string): string {
  const index = branch.lastIndexOf('/')
  return index === -1 ? branch : branch.slice(index + 1)
}

export function WorktreeBlock({
  worktree,
  selected,
  selectedPane,
  groupCollapsed,
  onToggleGroup,
  onSelectBlock,
  onSelectSession,
  onCloseSession,
  onCloseWorktree,
  onCreateShell,
  onCreateAgent,
}: {
  worktree: WorktreeRow
  selected: boolean
  selectedPane: string | null
  groupCollapsed: boolean
  onToggleGroup: () => void
  onSelectBlock: () => void
  onSelectSession: (tab: TabRow) => void
  onCloseSession: (tabId: string) => void
  onCloseWorktree: () => void
  onCreateShell: () => void
  onCreateAgent: (kind: AgentKind) => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const tone = gitTone(worktree.gitStatus)
  const markLabel = gitMarkLabel(worktree.gitStatus)
  // **사이드바는 에이전트 세션만 그린다** (09-gate1-fix.md D · 01-criteria.md 부록).
  // 한 번 거른 목록을 행·그룹 임계값·헤더 카운트가 모두 공유한다 — 임계값 의미가 저절로 따라온다.
  // 탭바는 그대로 전체 탭을 받는다(App.tsx `tabs={activeWorkspace.tabs}`) — 두 곳의 역할이
  // 갈리는 것이 목적이다: 사이드바 = AI 세션, 탭바 = 그 worktree 의 모든 탭.
  const agentTabs = (worktree.workspace?.tabs ?? []).filter(isAgentTab)
  const hasGroup = agentTabs.length >= GROUP_THRESHOLD
  const showSessions = !hasGroup || !groupCollapsed
  // H-5 — 접힘은 "사라짐"이 아니라 **"압축됨"**으로 읽혀야 한다. 첫 세션의 글리프만 남기고
  // 나머지 개수를 `+N` 으로 접는다.
  const firstAgentTab = agentTabs[0] ?? null
  const collapsedSummary =
    hasGroup && groupCollapsed && firstAgentTab !== null
      ? { status: GLYPH[firstAgentTab.agentStatus], kind: agentIcon(tabAgent(firstAgentTab)), hiddenCount: agentTabs.length - 1 }
      : null
  const isOpen = worktree.workspace !== null

  const branch = worktree.branch
  const line1Name = branch === null ? '(브랜치 없음)' : branchLeaf(branch)
  // 2줄은 **항상** 풀네임이다 — leaf 와 같아도 그린다 (H-2). 브랜치가 없는 worktree 만
  // 예외인데, 그건 규칙의 예외가 아니라 쓸 이름이 없어서다(절대경로는 §2.5 가 행에 금지).
  const line2Branch = branch

  return (
    <div
      className={`worktree-block ${selected ? 'is-selected' : ''}`}
      data-worktree={worktree.path}
      data-chip-worktree={worktree.path}
      data-chip-value={worktree.openWorkspaceId !== null ? 'open' : 'closed'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelectBlock}
    >
      <div className="worktree-block-line1">
        <span className={`worktree-dot tone-${selected ? 'accent' : tone}`} />
        {/* `data-worktree-branch` 의 **값**은 하네스의 요소 위치 지정자다 — 건드리지 않는다
            (09-gate1-fix.md B 경고). 바뀌는 것은 렌더 텍스트뿐이다.
            절대경로는 여기 `title` 툴팁에서만 노출한다 (§2.5). */}
        <span className="worktree-name" data-worktree-branch={worktree.path} title={worktree.path}>
          {line1Name}
        </span>
        {!worktree.isLinked ? <span className="worktree-chip">기본</span> : null}
        <div className="worktree-block-spacer" />
        {isOpen ? (
          <div className={`worktree-block-actions ${hovered || menuOpen ? 'is-active' : ''}`} data-worktree-actions={worktree.path}>
            <button
              className="repo-row-action-btn"
              data-create-row={worktree.openWorkspaceId ?? ''}
              data-kind="shell"
              title="빈 탭"
              onClick={(event) => {
                event.stopPropagation()
                onCreateShell()
              }}
            >
              +
            </button>
            <button
              className="repo-row-action-btn"
              data-worktree-menu-toggle={worktree.path}
              title="더보기"
              onClick={(event) => {
                event.stopPropagation()
                setMenuOpen((prev) => !prev)
              }}
            >
              ⋯
            </button>
          </div>
        ) : null}
        {markLabel !== null ? <span className={`worktree-mark tone-${tone}`}>{markLabel}</span> : null}
      </div>
      {line2Branch === null ? null : (
        <div className="worktree-block-line2">
          <span className="worktree-sub">{line2Branch}</span>
        </div>
      )}

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

      {isOpen && hasGroup ? (
        <AgentGroupHeader
          worktreePath={worktree.path}
          count={agentTabs.length}
          collapsed={groupCollapsed}
          onToggle={(event) => {
            event.stopPropagation()
            onToggleGroup()
          }}
        />
      ) : null}

      {/* 접힘 요약 행 — **`data-tab` 을 쓰지 않는다.** C3ⓑ 하네스가 "접힌 자식은 DOM 미존재"를
          `[data-tab]` 개수로 검사하므로, 여기에 그 속성을 달면 접혀도 세션 행이 남은 것으로
          집계돼 통과선이 깨진다. 세션 행이 아니라 헤더의 접힘 표현이라 별도 마크업이 맞다. */}
      {isOpen && collapsedSummary !== null ? (
        <div
          className="agent-group-summary"
          data-agent-group-summary={worktree.path}
          title={`세션 ${agentTabs.length}개 — 펼치기`}
          onClick={(event) => {
            event.stopPropagation()
            onToggleGroup()
          }}
        >
          <span className={`session-row-glyph tone-${collapsedSummary.status.tone}`}>{collapsedSummary.status.glyph}</span>
          {collapsedSummary.kind === null ? null : (
            <span className={`session-row-agent agent-${collapsedSummary.kind.kind}`} data-agent-kind={collapsedSummary.kind.kind}>
              {collapsedSummary.kind.glyph}
            </span>
          )}
          {collapsedSummary.hiddenCount > 0 ? (
            <span className="agent-group-summary-more" data-agent-group-hidden={collapsedSummary.hiddenCount}>
              +{collapsedSummary.hiddenCount}
            </span>
          ) : null}
          <div className="agent-group-spacer" />
          <span className="agent-group-summary-caret">›</span>
        </div>
      ) : null}

      {isOpen && showSessions
        ? agentTabs.map((tab) => (
            <SessionRow
              key={tab.tabId}
              tab={tab}
              active={tab.panes.some((pane) => pane.paneId === selectedPane)}
              onSelect={() => onSelectSession(tab)}
              onClose={() => onCloseSession(tab.tabId)}
            />
          ))
        : null}
      {/* 세션 없는 worktree 에 플레이스홀더를 넣지 않는다 — §2.5 "세션이 없는 worktree" 명시 금지,
          목업에도 없다. 블록만 남고 아래가 비는 게 정상이다. */}
    </div>
  )
}
