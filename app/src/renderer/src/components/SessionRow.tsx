// design-handoff.md §2 SessionRow — 상태 글리프 + 제목(말줄임) + 경과 시간.
// 클릭 → 해당 worktree 선택 + 세션(탭) 활성 (§4). 탭 닫기(L3·L4·L9a, 01-criteria C1)는 핸드오프
// 목업에 없는 동작이라 hover 시에만 드러나는 보조 버튼으로 얹는다(RepoRowActions 와 같은 결 —
// 밀도 유지 + 없어지지 않는 계약).
import { useState } from 'react'
import type { AgentStatus, TabRow } from '../../../shared/types.js'
import { elapsedLabel } from '../hooks/useElapsedLabel.js'

const GLYPH: Record<AgentStatus, { glyph: string; tone: 'accent' | 'dirty' | 'behind' | 'error' | 'faint' }> = {
  working: { glyph: '⚡', tone: 'dirty' },
  idle: { glyph: '◉', tone: 'behind' },
  blocked: { glyph: '!', tone: 'error' },
  unknown: { glyph: '·', tone: 'faint' },
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
      <span className="session-row-title">{tab.label}</span>
      <div className="session-row-spacer" />
      <span className="session-row-time">{elapsedLabel(tab.tabId)}</span>
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
