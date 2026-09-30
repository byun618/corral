// 에이전트 묶음 **알약** (LIFE-467 D1·D2) — Orca 1.4.198 `CompactAgentSummaryButton`(`worktree-card-compact-agents.tsx:77-191`).
//
// 알약 하나가 요약이자 펼침 토글이다. 접혀 있으면 상태 그룹(최대 3) × 종류 아이콘(그룹당 최대 3) + `+N` 두 층을
// 테두리 있는 알약 안에 그리고, 펼치면 테두리를 벗고 「N agents」 머리줄이 된다(Orca `:139-143` — 펼친 목록은 조용한
// 나무라 알약 겉모습은 접힌 상태에만 준다). 오른쪽 끝 `ChevronDown` 은 접혔을 때 -90° 로 누워 있다.
//
// 루트 에이전트 **2개부터** 선다(`SUMMARY_MIN_ROOTS` — Orca `summaryAgents.length > 1`). 전의 corral 은 3개부터
// 헤더 + 요약 행 두 칸이었다(C-P5). 요약 규칙(`session-summary.ts`)은 그때 이식해 둔 것을 그대로 쓴다.
import type { CollapsedSummary } from '../session-summary.js'
import { AGENT_DOT_LABEL } from '../agent-dot.js'
import { AGENT_ICON } from '../session-glyphs.js'
import { AgentIcon } from './AgentIcon.js'
import { AgentStateDot, Chevron } from './AgentStateDot.js'

export function AgentGroupHeader({
  worktreePath,
  count,
  summary,
  expanded,
  onToggle,
}: {
  worktreePath: string
  /** 루트 에이전트 수. */
  count: number
  summary: CollapsedSummary
  expanded: boolean
  onToggle: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const described = summary.clusters.map((cluster) => `${AGENT_DOT_LABEL[cluster.dot]} ${cluster.count}`).join(', ')
  return (
    <button
      className={`agent-group-pill ${expanded ? 'is-expanded' : ''}`}
      data-agent-group={worktreePath}
      data-agent-group-expanded={expanded ? 'true' : 'false'}
      data-summary-clusters={summary.clusters.length}
      aria-expanded={expanded}
      title={expanded ? `에이전트 ${count}개 — 접기` : `에이전트 ${count}개 (${described}) — 펼치기`}
      onClick={onToggle}
    >
      {expanded ? (
        <span className="agent-group-label">{count} agents</span>
      ) : (
        <>
          <span className="agent-group-clusters" aria-hidden>
            {summary.clusters.map((cluster) => (
              <span key={cluster.dot} className="agent-group-cluster" data-summary-cluster={cluster.dot} data-summary-count={cluster.count}>
                <AgentStateDot dot={cluster.dot} title={`${AGENT_DOT_LABEL[cluster.dot]} ${cluster.count}`} />
                {/* 같은 상태의 종류 아이콘은 겹쳐 한 무리로 읽힌다 (Orca `-space-x-0.5`). */}
                <span className="agent-group-cluster-icons">
                  {cluster.icons.map((icon) => (
                    <span key={icon.kind} className={`agent-group-cluster-icon agent-${icon.kind}`} data-agent-kind={icon.kind} title={icon.label}>
                      <AgentIcon kind={icon.kind} glyph={AGENT_ICON[icon.kind].glyph} />
                    </span>
                  ))}
                </span>
                {/* `+N` 첫 층 — 이 무리에서 **아이콘이 안 붙은 행 수**다(총수가 아니다). */}
                {cluster.hiddenIcons > 0 ? (
                  <span className="agent-group-cluster-more" data-summary-hidden-icons={cluster.hiddenIcons}>
                    +{cluster.hiddenIcons}
                  </span>
                ) : null}
              </span>
            ))}
          </span>
          {/* `+N` 둘째 층 — 무리 상한(3)에 **잘려나간 무리들의 행 합**이다. */}
          {summary.hiddenSessions > 0 ? (
            <span className="agent-group-summary-more" data-agent-group-hidden={summary.hiddenSessions}>
              +{summary.hiddenSessions}
            </span>
          ) : null}
        </>
      )}
      <Chevron direction="down" className="agent-group-caret" />
    </button>
  )
}
