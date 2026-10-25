// 사이드바 에이전트 행 한 줄 (LIFE-467 D4) — Orca 1.4.198 compact 행(`worktree-card-compact-agent-row.tsx:94-310`) 해부.
//
// 좌→우: 자식 셰브론(자식 있을 때, 없으면 정렬용 빈 칸) · 상태 점 · 종류 아이콘(서브에이전트 행은 숨김) ·
// `앞 - 뒤` 한 칸(잘림 + 전문 툴팁) · 모델(mono, 폭 상한) · 접힌 자식 `+N` · 경과 시간 · hover 닫기(live 만).
// 「닫힌 탭」(retained) 행은 시간 칸과 한 자리를 나눈 hover ✕ 로 걷는다(LIFE-696 — 198 `DashboardAgentRowTrailingControls`, 확인 대화 없음).
// 높이 24px · 글자 11px (c4 §5.4). 한 줄이다 — LIFE-366 C8 의 "제목과 2차 줄을 같은 칸에서 같이 자른다" 가 그대로 산다.
//
// ## 굵기 — 1.4.217 기준 (B1)
//
// herdr `done` 은 「끝났는데 아직 안 봄」이다. 그 행의 앞 글을 굵고 밝게 그리고, 그 pane 을 보면 herdr 가 `idle` 로
// 내려 보통 굵기로 돌아온다. 198 compact 행은 이 굵기가 없다(#22857) — 1.4.217(#23327)이 고친 쪽을 따른다.
//
// ## hover 닫기 버튼은 남긴다 (D18)
//
// Orca 행에는 없다(retained 만 dismiss). corral 사이드바에서 세션을 닫는 진입점이 이 버튼 하나라(LIFE-357 C1 계약,
// 탭바는 2개 이상일 때만 선다) 지우면 기능이 사라진다. hover 에만 드러나 쉴 때의 행 모양은 Orca 와 같다.
import { useState } from 'react'
import type { AgentRowNode } from '../sidebar-agents.js'
import { elapsedLabel } from '../session-activity.js'
import { AGENT_ICON } from '../session-glyphs.js'
import { AgentIcon } from './AgentIcon.js'
import { AgentStateDot, Chevron } from './AgentStateDot.js'

export function SessionRow({
  node,
  now,
  focused,
  child,
  disclosure,
  reserveGutter,
  onActivate,
  onClose,
}: {
  node: AgentRowNode
  /** 흐르는 「지금」 — 경과 시간이 얼지 않게 한 곳에서 틱을 받는다 (`useNowTick`). */
  now: number
  /** 이 행의 pane 이 지금 선택된 pane 인가 — 글자를 밝게 올린다(Orca `isFocusedPane`). */
  focused: boolean
  /** 계보·서브에이전트 자식 행인가 (시각 깊이 1). */
  child: boolean
  /** 자식이 있으면 셰브론. 없으면 null. */
  disclosure: { expanded: boolean; count: number; onToggle: () => void } | null
  /** 자식 없는 루트가 셰브론 칸을 비워 두나 — 형제 중 셰브론이 있으면 점 열을 맞춘다(Orca `reserveDisclosureGutter`). */
  reserveGutter: boolean
  onActivate: (paneId: string) => void
  onClose: (paneId: string) => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const elapsed = node.timeAt === null ? null : elapsedLabel(node.timeAt, now)
  const inert = node.activationPaneId === null
  const classes = [
    'session-row',
    `source-${node.source}`,
    focused ? 'is-active' : '',
    node.unseenDone ? 'is-unseen-done' : '',
    child ? 'is-child' : '',
    disclosure !== null ? 'is-parent' : '',
    inert ? 'is-inert' : '',
  ]
  return (
    <div
      className={classes.filter((item) => item.length > 0).join(' ')}
      data-agent-row={node.key}
      data-agent-row-source={node.source}
      data-agent-row-depth={child ? 1 : 0}
      // 하네스(C3ⓑ·I-6)가 세는 속성은 **살아 있는 pane 행에만** 단다 — 자식·보존 행까지 세면 탭 수와 어긋난다.
      data-tab={node.source === 'live' ? (node.tabId ?? undefined) : undefined}
      data-pane={node.source === 'live' ? node.paneId : undefined}
      data-unseen-done={node.unseenDone ? 'true' : undefined}
      data-focused-agent-pane={focused ? 'true' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // ⚠ 버블링을 끊는다 (11-gate1-fix3.md I-6) — 이 행은 `.worktree-block` 안에 있고 그 블록의 onClick 은
      // 「첫 세션 선택」이다. 무반응 행(B2 — 죽은 pane 의 보존 행)도 끊는다: 눌렀는데 엉뚱한 탭이 열리면 안 된다.
      onClick={(event) => {
        event.stopPropagation()
        if (node.activationPaneId !== null) onActivate(node.activationPaneId)
      }}
    >
      {disclosure !== null ? (
        <button
          className="agent-row-disclosure"
          data-agent-row-toggle={node.key}
          aria-expanded={disclosure.expanded}
          title={`자식 ${disclosure.count}개 ${disclosure.expanded ? '접기' : '펼치기'}`}
          onClick={(event) => {
            event.stopPropagation()
            disclosure.onToggle()
          }}
        >
          <Chevron direction="right" className={`agent-row-chevron ${disclosure.expanded ? 'is-expanded' : ''}`} />
        </button>
      ) : reserveGutter ? (
        <span className="agent-row-gutter" aria-hidden />
      ) : null}
      <AgentStateDot dot={node.dot} />
      {node.showIcon && node.kind !== null ? (
        <span className={`session-row-agent agent-${node.kind}`} data-agent-kind={node.kind} title={AGENT_ICON[node.kind].label}>
          <AgentIcon kind={node.kind} glyph={AGENT_ICON[node.kind].glyph} />
        </span>
      ) : null}
      {/* **글 칸 하나** — 앞·뒤가 여기서 같이 잘린다. 전문은 툴팁이 쥔다 (LIFE-366 C8, Orca `:230-245`). */}
      <span className="session-row-text" title={node.text.full}>
        <span className="session-row-title">{node.text.leading}</span>
        {node.text.trailing === null ? null : (
          <span className="session-row-second">
            {' - '}
            {node.text.trailing}
          </span>
        )}
      </span>
      {node.model === null ? null : (
        <span className="agent-row-model" title={node.model}>
          {node.model}
        </span>
      )}
      {disclosure !== null && !disclosure.expanded ? <span className="agent-row-child-count">+{disclosure.count}</span> : null}
      {/* 경과 시각이 **실재할 때만** 그린다 (D1). 없으면 칸 자체가 없다 — 지어낸 수 대신 부재.
          보존 행은 시간과 걷기 ✕ 가 한 칸을 나눈다 — hover 면 시간이 비켜 서고 ✕ 가 선다(LIFE-696). */}
      {node.source === 'retained' ? (
        <span className="session-row-trailing">
          {elapsed === null ? null : (
            <span className={`session-row-elapsed ${hovered ? 'is-hidden' : ''}`} data-elapsed={elapsed}>
              {elapsed}
            </span>
          )}
          <button
            className={`session-row-dismiss ${hovered ? 'is-active' : ''}`}
            data-dismiss-retained={node.paneId}
            title="닫힌 탭 걷기"
            aria-label="닫힌 탭 걷기"
            onClick={(event) => {
              // 행 활성화로 번지지 않게 끊는다(C5ⓖ) — 보존 행 클릭은 그 worktree 로 옮긴다.
              event.stopPropagation()
              void window.corral.dismissRetained({ paneId: node.paneId })
            }}
          >
            ×
          </button>
        </span>
      ) : elapsed === null ? null : (
        <span className="session-row-elapsed" data-elapsed={elapsed}>
          {elapsed}
        </span>
      )}
      {/* hover 로만 opacity 를 바꾼다 — 조건부 렌더링하면 좌표 클릭 계측이 hover 없이 못 찾는다. */}
      {node.source === 'live' ? (
        <button
          className={`session-row-close ${hovered ? 'is-active' : ''}`}
          data-close-pane={node.paneId}
          title="세션 닫기"
          onClick={(event) => {
            event.stopPropagation()
            onClose(node.paneId)
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
