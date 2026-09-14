// design-handoff.md §2 SessionRow — 상태 글리프 + 제목(말줄임).
// 클릭 → 해당 worktree 선택 + 세션(탭) 활성 (§4). 탭 닫기(L3·L4·L9a, 01-criteria C1)는 핸드오프
// 목업에 없는 동작이라 hover 시에만 드러나는 보조 버튼으로 얹는다(RepoRowActions 와 같은 결 —
// 밀도 유지 + 없어지지 않는 계약).
//
// **경과 시간 칸은 없다** (09-gate1-fix.md E). §2 는 "마지막 활동 경과"를 요구하지만 corral 의
// 데이터 모델에는 그런 시각이 없다 — `TabRow` 에 활동 시각 필드가 없고, 구현이 쓰던 값은
// 렌더러가 그 tabId 를 **처음 관측한** 시각부터의 경과였다. 근거 없는 수를 마지막 활동인 양
// 보이지 않는다. 필드가 생기면 그때 되살린다.
import { useState } from 'react'
import type { AgentStatus, TabRow } from '../../../shared/types.js'
import { sessionTitle } from '../session-title.js'

/**
 * §2.5 SessionRow 글리프 표. corral 의 `AgentStatus` 네 값에 대응시킨다.
 *
 * 스펙에 있으나 **못 그리는 두 칸**(09-gate1-fix.md E — 만들지 않고 명시한다):
 *   · 완료 `✓` `--accent` — corral 에 `done` 상태가 없다. herdr 0.9.0 이 `pane.report_agent`
 *     경로로 `done` 을 만들지 않기 때문이다 (`shared/types.ts` AgentStatus 주석).
 *   · 에러 `✕` `--st-error` — `AgentStatus` 에 `error` 가 없다. 가장 가까운 `blocked` 는
 *     "막혔다"이지 "실패했다"가 아니라 같은 칸으로 셈하지 않는다.
 * 미상은 §2.5 원문대로 `◉` + `--fg-faint` 다 (실행 중 `◉` 와 글리프가 같고 색으로 갈린다).
 */
const GLYPH: Record<AgentStatus, { glyph: string; tone: 'accent' | 'dirty' | 'behind' | 'error' | 'faint' }> = {
  working: { glyph: '⚡', tone: 'dirty' },
  idle: { glyph: '◉', tone: 'behind' },
  blocked: { glyph: '!', tone: 'error' },
  unknown: { glyph: '◉', tone: 'faint' },
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '대기',
  working: '작업중',
  blocked: '막힘',
  unknown: '미상',
}

export function SessionRow({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TabRow
  active: boolean
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const { glyph, tone } = GLYPH[tab.agentStatus]
  return (
    <div
      className={`session-row ${active ? 'is-active' : ''}`}
      data-tab={tab.tabId}
      data-tab-order={tab.order}
      data-tab-number={tab.number}
      title={STATUS_LABEL[tab.agentStatus]}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      <span className={`session-row-glyph tone-${tone}`}>{glyph}</span>
      <span className="session-row-title">{sessionTitle(tab)}</span>
      <div className="session-row-spacer" />
      {/* hover 로만 opacity 를 바꾼다 — 조건부 렌더링하면 좌표/elementFromPoint 클릭이
          hover 없이는(mousemove 없이 click 만 보내는 계측 채널) 못 찾는다(WorktreeBlock 과 같은 결). */}
      <button
        className={`session-row-close ${hovered ? 'is-active' : ''}`}
        data-close-tab={tab.tabId}
        title="탭 닫기"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        ×
      </button>
    </div>
  )
}
