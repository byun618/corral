// design-handoff.md §2 WorktreeBlock — 1줄(상태 도트+이름+기본칩+git마크) + 2줄(브랜치명),
// 선택 시에만 카드로 올라온다(별도 컴포넌트가 아니라 같은 블록의 선택 상태 — §1).
//
// **§2.5 필드 매핑** (09-gate1-fix.md B + 코디네이터 목업 실측 보정, 2026-09-14):
//   · 1줄 이름 = 브랜치 **leaf**(마지막 `/` 뒤), 2줄 = **브랜치 풀네임**.
//     `issue/LIFE-89` → 1줄 `LIFE-89` / 2줄 `issue/LIFE-89` (다르므로 2줄 렌더)
//     `main` · `LIFE-357-layout-redesign-fix` → leaf == 풀네임 → **2줄 미렌더, 블록 높이 축소**
//   · 절대경로는 행에 안 넣는다 — 1줄 이름의 `title` 툴팁과 CreateWorktreeModal 경로 필드에서만.
//   · 목업 자체는 1줄·2줄이 같아도 둘 다 그려 블록이 47px 이지만, §2.5 가 그 뒤에 나온 정정이라
//     §2.5 가 우선한다. 슬래시 없는 브랜치가 많은 corral 에서 블록이 목업보다 납작해지는 것은
//     **의도된 결과**다 — 빈 2줄을 억지로 채우지 않는다.
//
// 핸드오프 목업에는 없지만 01-criteria.md C1(필수)이 요구하는 "세션(탭) 생성·닫기" 진입점을
// 여기 얹는다 — MainTabBar 는 sessionCount>=2 에서만 존재해(C5) 0/1개일 때 "+" 를 못 둔다.
// RepoRow 의 hover-액션(+/⋯) idiom 을 그대로 재사용해 새 시각 어휘를 늘리지 않는다: "⋯" 메뉴에
// 빈 탭 생성 · 에이전트 즉시 기동(L1/L2 자산 보존) · worktree 닫기(기존 확인 게이트 경로 유지,
// §6 "액션을 추가하지 않았다"는 상시 노출 버튼 얘기라 hover 메뉴 항목으로는 기능을 지우지 않는다).
import { useState } from 'react'
import type { AgentKind, TabRow, WorktreeRow } from '../../../shared/types.js'
import { gitMarkLabel, gitTone } from '../git-marks.js'
import { isAgentTab } from '../session-title.js'
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
  const isOpen = worktree.workspace !== null

  const branch = worktree.branch
  const line1Name = branch === null ? '(브랜치 없음)' : branchLeaf(branch)
  // 2줄은 leaf 와 다를 때만 — 같으면 렌더하지 않아 블록 높이가 줄어든다 (§2.5).
  const line2Branch = branch !== null && branch !== line1Name ? branch : null

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
