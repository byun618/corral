// design-handoff.md §2 WorktreeBlock — 항상 2줄(상태 도트+이름+기본칩+git마크 / 브랜치·경로),
// 선택 시에만 카드로 올라온다(별도 컴포넌트가 아니라 같은 블록의 선택 상태 — §1).
//
// 핸드오프 목업에는 없지만 01-criteria.md C1(필수)이 요구하는 "세션(탭) 생성·닫기" 진입점을
// 여기 얹는다 — MainTabBar 는 sessionCount>=2 에서만 존재해(C5) 0/1개일 때 "+" 를 못 둔다.
// RepoRow 의 hover-액션(+/⋯) idiom 을 그대로 재사용해 새 시각 어휘를 늘리지 않는다: "⋯" 메뉴에
// 빈 탭 생성 · 에이전트 즉시 기동(L1/L2 자산 보존) · worktree 닫기(기존 확인 게이트 경로 유지,
// §6 "액션을 추가하지 않았다"는 상시 노출 버튼 얘기라 hover 메뉴 항목으로는 기능을 지우지 않는다).
import { useState } from 'react'
import type { AgentKind, TabRow, WorktreeRow } from '../../../shared/types.js'
import { gitMarkLabel, gitTone } from '../git-marks.js'
import { AgentGroupHeader } from './AgentGroupHeader.js'
import { SessionRow } from './SessionRow.js'

const AGENT_KINDS: Array<{ kind: AgentKind; label: string }> = [
  { kind: 'claude', label: 'claude 기동' },
  { kind: 'codex', label: 'codex 기동' },
  { kind: 'grok', label: 'grok 기동' },
]

const GROUP_THRESHOLD = 3 // §1-1 "세션이 3개 이상인 worktree"

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
  const tabs = worktree.workspace?.tabs ?? []
  const hasGroup = tabs.length >= GROUP_THRESHOLD
  const showSessions = !hasGroup || !groupCollapsed
  const isOpen = worktree.workspace !== null

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
        <span className="worktree-name" data-worktree-branch={worktree.path} title={worktree.branch ?? worktree.path}>
          {worktree.branch ?? '(브랜치 없음)'}
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
      <div className="worktree-block-line2">
        <span className="worktree-sub" title={worktree.path}>
          {worktree.path}
        </span>
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

      {isOpen && hasGroup ? (
        <AgentGroupHeader
          worktreePath={worktree.path}
          count={tabs.length}
          collapsed={groupCollapsed}
          onToggle={(event) => {
            event.stopPropagation()
            onToggleGroup()
          }}
        />
      ) : null}

      {isOpen && showSessions
        ? tabs.map((tab) => (
            <SessionRow
              key={tab.tabId}
              tab={tab}
              active={tab.panes.some((pane) => pane.paneId === selectedPane)}
              onSelect={() => onSelectSession(tab)}
              onClose={() => onCloseSession(tab.tabId)}
            />
          ))
        : null}
      {isOpen && tabs.length === 0 ? <p className="worktree-empty-hint">세션 없음</p> : null}
    </div>
  )
}
