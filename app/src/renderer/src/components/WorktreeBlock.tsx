// design-handoff.md §2 WorktreeBlock — 1줄(상태 도트+이름+기본칩+git마크) + 2줄(브랜치명),
// 선택 시에만 카드로 올라온다(별도 컴포넌트가 아니라 같은 블록의 선택 상태 — §1).
//
// **§2.5 필드 매핑** (10-gate1-fix2.md H-2, 2026-09-15 재조정):
//   · 1줄 이름 = **브랜치 풀네임**, 2줄도 **브랜치 풀네임** — 둘이 항상 같은 문자열이다.
//     `feature/LIFE-358` → 1줄 `feature/LIFE-358` / 2줄 `feature/LIFE-358`.
//     leaf 만 자르던 이전(1줄 `LIFE-358`)은 Orca 대조 스크린샷을 본 사용자가
//     "접두사가 잘려 정보 손실"이라 판단해 되돌렸다(`worktree-name.ts` 참고) — 1줄·2줄이
//     같아진 건 이 되돌림의 결과지, 새로 정한 중복 규칙이 아니다.
//   · §2.5 의 "1줄과 같으면 2줄을 숨기고 블록 높이를 줄인다"는 **철회된 채로 유지**(H-2). 사용자가
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
import type { AgentKind, IntegrationRow, PaneRow, WorktreeRow } from '../../../shared/types.js'
import { gitMarkLabel, gitTone } from '../git-marks.js'
import { GLYPH, STATUS_LABEL } from '../session-glyphs.js'
import { AgentIcon } from './AgentIcon.js'
import { agentPanes } from '../session-title.js'
import { collapsedSummary } from '../session-summary.js'
import { worktreeDisplayName } from '../worktree-name.js'
import { AgentGroupHeader } from './AgentGroupHeader.js'
import { SessionRow } from './SessionRow.js'

const AGENT_KINDS: Array<{ kind: AgentKind; label: string }> = [
  { kind: 'claude', label: 'claude 기동' },
  { kind: 'codex', label: 'codex 기동' },
  { kind: 'grok', label: 'grok 기동' },
]

// 07-criteria-pane-sessions C-P5 — 에이전트 pane 3개부터 압축한다.
const GROUP_THRESHOLD = 3

export function WorktreeBlock({
  worktree,
  selected,
  selectedPane,
  groupGlyph,
  integrations,
  home,
  now,
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
  groupCollapsed: boolean
  onToggleGroup: () => void
  onSelectBlock: () => void
  onSelectSession: (pane: PaneRow) => void
  onCloseSession: (paneId: string) => void
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
  const panes = agentPanes(worktree.workspace?.tabs ?? [])
  const hasGroup = panes.length >= GROUP_THRESHOLD
  const showSessions = !hasGroup || !groupCollapsed
  // H-5 — 접힘은 "사라짐"이 아니라 **"압축됨"**으로 읽혀야 한다.
  //
  // 수정 라운드 5 (P6/C7): 압축의 단위가 **세션**에서 **상태 클러스터**로 바뀌었다. 첫 세션 하나의
  // 글리프 + `+N` 은 "무엇이 어떤 상태인가" 를 못 말한다 — 접힌 카드에서 사용자가 알고 싶은 것이
  // 그것이다. 규칙은 `session-summary.ts` 에 있고 여기서는 그리기만 한다.
  const summary = hasGroup && groupCollapsed && panes.length > 0 ? collapsedSummary({ panes }) : null
  const isOpen = worktree.workspace !== null

  const branch = worktree.branch
  // 표시 이름은 **정렬 키와 같은 함수**에서 온다 — 둘이 갈라져서 보이는 이름 기준 역순이
  // 나온 적이 있다(worktree-name.ts 주석).
  const line1Name = worktreeDisplayName(worktree)
  // 2줄은 **항상** 풀네임이다 — 1줄과 같아도 그린다 (H-2). 브랜치가 없는 worktree 만
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
        {groupGlyph === null ? null : (
          <span className="worktree-groups-glyph" data-worktree-groups={worktree.path} title="영역 레이아웃이 보존돼 있다">
            {groupGlyph}
          </span>
        )}
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
          count={panes.length}
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
      {isOpen && summary !== null ? (
        <div
          className="agent-group-summary"
          data-agent-group-summary={worktree.path}
          data-summary-clusters={summary.clusters.length}
          title={`세션 ${summary.total}개 — 펼치기`}
          onClick={(event) => {
            event.stopPropagation()
            onToggleGroup()
          }}
        >
          {summary.clusters.map((cluster) => (
            <span
              key={cluster.status}
              className="agent-group-cluster"
              data-summary-cluster={cluster.status}
              data-summary-count={cluster.count}
              title={`${STATUS_LABEL[cluster.status]} ${cluster.count}`}
            >
              <span className={`session-row-glyph tone-${GLYPH[cluster.status].tone}`}>{GLYPH[cluster.status].glyph}</span>
              {cluster.icons.map((icon) => (
                <span key={icon.kind} className={`session-row-agent agent-${icon.kind}`} data-agent-kind={icon.kind} title={icon.label}>
                  <AgentIcon kind={icon.kind} glyph={icon.glyph} />
                </span>
              ))}
              {/* `+N` 첫 층 — 이 클러스터에서 **아이콘이 안 붙은 세션 수**다(총수가 아니다). */}
              {cluster.hiddenIcons > 0 ? (
                <span className="agent-group-cluster-more" data-summary-hidden-icons={cluster.hiddenIcons}>
                  +{cluster.hiddenIcons}
                </span>
              ) : null}
            </span>
          ))}
          {/* `+N` 둘째 층 — 클러스터 상한(3)에 **잘려나간 클러스터들의 세션 합**이다. */}
          {summary.hiddenSessions > 0 ? (
            <span className="agent-group-summary-more" data-agent-group-hidden={summary.hiddenSessions}>
              +{summary.hiddenSessions}
            </span>
          ) : null}
          <div className="agent-group-spacer" />
          <span className="agent-group-summary-caret">›</span>
        </div>
      ) : null}

      {isOpen && showSessions
        ? panes.map((pane, index) => (
            <SessionRow
              key={pane.paneId}
              pane={pane}
              ordinal={index + 1}
              active={pane.paneId === selectedPane}
              integrations={integrations}
              home={home}
              now={now}
              onSelect={() => onSelectSession(pane)}
              onClose={() => onCloseSession(pane.paneId)}
            />
          ))
        : null}
      {/* 세션 없는 worktree 에 플레이스홀더를 넣지 않는다 — §2.5 "세션이 없는 worktree" 명시 금지,
          목업에도 없다. 블록만 남고 아래가 비는 게 정상이다. */}
    </div>
  )
}
