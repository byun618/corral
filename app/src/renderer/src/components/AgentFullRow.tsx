// 사이드바 에이전트 행 — Agent activity layout **Full list** (LIFE-477 B12·D16). Orca 1.4.198 `DashboardAgentRow`(인라인 카드 변형:
// `stateDotSize="sm"`·`hideExpand`·`hideLineageConnectors`, `WorktreeCardAgents.tsx:266-300`) 해부.
//
// 1줄 `flex items-center gap-1.5`: 자식 셰브론 `size-4`(또는 정렬용 빈 칸) · 상태 점 sm · 종류 아이콘 14px(서브에이전트 생략) ·
//      라벨 11px `leading-snug` 한 줄 잘림 · 모델 mono 10px `max-w-24` · 접힌 자식 `+N` · 오른쪽 `w-12` 시간(hover 시 그 자리에 닫기)
// 2줄 `mt-0.5 pl-5` 10px: 렌치 · 도구 이름 mono · 입력(잘림) — 규칙은 `AgentFullContent.tool`(working 이면 도구 없을 때 자리만)
// 3줄 `mt-0.5 pl-5` 10px: 「중단됨」 태그 + 마지막 메시지 한 줄 잘림. 둘 다 없으면 **공백 1자 div**(198 `DashboardAgentRowMessage.tsx:25-28`
//      그대로 — 공백뿐인 줄 상자는 접혀 실제로는 `mt-0.5` 만 남는다. 격리 실측으로 높이를 적는다)
// 행 `py-1`, 루트 `px-2` · 자식 `pl-5 pr-2`. 접힘 없이 늘 세 줄 규칙대로 그린다(펼침 버튼 `hideExpand`).
//
// corral 차이(의도적): 닫기는 live 행만(compact 행 D18 과 같다), 3줄에 corral 통지(기록 못 읽음 등) 포함.
// 「닫힌 탭」(retained) 행은 198 처럼 같은 칸의 ✕ 로 걷는다(LIFE-696 — 확인 대화 없음, 서브에이전트 행은 없음).
import { useState } from 'react'
import { AGENT_DOT_LABEL } from '../agent-dot.js'
import { elapsedAgoLabel } from '../session-activity.js'
import { AGENT_ICON } from '../session-glyphs.js'
import type { AgentRowNode } from '../sidebar-agents.js'
import { AgentIcon } from './AgentIcon.js'
import { AgentStateDot, Chevron } from './AgentStateDot.js'
import { WrenchIcon } from './SidebarIcons.js'

export function AgentFullRow({
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
  now: number
  focused: boolean
  child: boolean
  disclosure: { expanded: boolean; count: number; onToggle: () => void } | null
  reserveGutter: boolean
  onActivate: (paneId: string) => void
  onClose: (paneId: string) => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const time = elapsedAgoLabel({ at: node.timeAt, now })
  const { full } = node
  const canClose = node.source === 'live'
  const canDismiss = node.source === 'retained'
  const classes = [
    'agent-full-row',
    `source-${node.source}`,
    focused ? 'is-active' : '',
    node.unseenDone ? 'is-unseen-done' : '',
    child ? 'is-child' : '',
    node.activationPaneId === null ? 'is-inert' : '',
    hovered ? 'is-hovered' : '',
  ]
  return (
    <div
      className={classes.filter((item) => item.length > 0).join(' ')}
      data-agent-row={node.key}
      data-agent-full-row=""
      data-agent-row-source={node.source}
      data-agent-row-depth={child ? 1 : 0}
      data-tab={node.source === 'live' ? (node.tabId ?? undefined) : undefined}
      data-pane={node.source === 'live' ? node.paneId : undefined}
      data-unseen-done={node.unseenDone ? 'true' : undefined}
      data-focused-agent-pane={focused ? 'true' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(event) => {
        event.stopPropagation()
        if (node.activationPaneId !== null) onActivate(node.activationPaneId)
      }}
    >
      <div className="agent-full-line1">
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
          <span className={`agent-full-icon agent-${node.kind}`} data-agent-kind={node.kind} title={AGENT_ICON[node.kind].label}>
            <AgentIcon kind={node.kind} glyph={AGENT_ICON[node.kind].glyph} />
          </span>
        ) : null}
        <span className="agent-full-label" data-agent-full-label="" title={full.label}>
          {full.label}
        </span>
        {node.model === null ? null : (
          <span className="agent-row-model" title={node.model}>
            {node.model}
          </span>
        )}
        {disclosure !== null && !disclosure.expanded ? <span className="agent-row-child-count">+{disclosure.count}</span> : null}
        {/* 시간과 닫기가 한 칸(`w-12`)을 나눠 쓴다 — hover 면 시간이 비켜 서고 닫기가 선다(198 `DashboardAgentRowTrailingControls.tsx:107-140`). */}
        <span className="agent-full-trailing">
          {time === null ? null : (
            <span className={`agent-full-time ${(canClose || canDismiss) && hovered ? 'is-hidden' : ''}`} data-elapsed={time}>
              {time}
            </span>
          )}
          {canClose ? (
            <button
              className={`agent-full-close ${hovered ? 'is-active' : ''}`}
              data-close-pane={node.paneId}
              title="세션 닫기"
              aria-label="세션 닫기"
              onClick={(event) => {
                event.stopPropagation()
                onClose(node.paneId)
              }}
            >
              ×
            </button>
          ) : null}
          {canDismiss ? (
            <button
              className={`agent-full-close ${hovered ? 'is-active' : ''}`}
              data-dismiss-retained={node.paneId}
              title="닫힌 탭 걷기"
              aria-label="닫힌 탭 걷기"
              onClick={(event) => {
                event.stopPropagation()
                void window.corral.dismissRetained({ paneId: node.paneId })
              }}
            >
              ×
            </button>
          ) : null}
        </span>
      </div>
      {full.tool.kind === 'none' ? null : (
        <div className="agent-full-tool" data-agent-row-tool-slot="">
          {full.tool.kind === 'tool' ? (
            <div className="agent-full-tool-header" data-agent-row-tool-header="">
              <WrenchIcon className="agent-full-tool-icon" />
              <code className="agent-full-tool-name">{full.tool.name}</code>
              {full.tool.input === null ? null : (
                <span className="agent-full-tool-input" title={full.tool.input}>
                  {full.tool.input}
                </span>
              )}
            </div>
          ) : (
            <span className="agent-full-tool-placeholder" data-agent-row-tool-placeholder="" aria-hidden />
          )}
        </div>
      )}
      {!full.interrupted && full.message === null ? (
        <div className="agent-full-message is-empty" data-agent-row-message="empty">
          {' '}
        </div>
      ) : (
        <div className="agent-full-message" data-agent-row-message="">
          {full.interrupted ? (
            <span className="agent-full-interrupted" aria-label="사용자가 중단함">
              {AGENT_DOT_LABEL.interrupted}
            </span>
          ) : null}
          {full.message === null ? null : (
            <span className="agent-full-message-text" title={full.message}>
              {full.message}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
