// 카드 상태 슬롯 (LIFE-468 K5ⓑ) — Orca 1.4.198 Detailed 의 `[data-worktree-card-status-slot]` + `StatusIndicator`.
//
// 슬롯은 `pt-[2px]` 의 16px 칸(Orca 는 이 칸이 안 읽음 토글 버튼 `size-4` 이다 — 안 읽음은 S5 LIFE-471 몫이라 corral 은
// 버튼 없이 같은 크기의 칸만 둔다), 그 안에 12px 표시(`h-3 w-3`):
//   working = 노란 스피너 8px · monitoring = Activity 12px 노랑 · permission = 질문 아이콘 12px 주황 ·
//   interrupted = 빨간 점 6px · done/active = 초록 점 8px · inactive = 회색 점 8px(neutral-500/40).
// 색은 467 이 옮겨 둔 Orca 팔레트 토큰(`--agent-dot-*`)을 그대로 쓴다.
import { WORKTREE_STATUS_LABEL, type WorktreeStatus } from '../worktree-status.js'
import { ActivityGlyph, QuestionGlyph } from './AgentStateDot.js'

function Indicator({ status }: { status: WorktreeStatus }): React.JSX.Element {
  switch (status) {
    case 'working':
      return <span className="worktree-status-spinner" />
    case 'monitoring':
      return <ActivityGlyph className="worktree-status-icon" />
    case 'permission':
      return <QuestionGlyph className="worktree-status-icon" />
    case 'interrupted':
      return <span className="worktree-status-fill is-small" />
    case 'done':
    case 'active':
    case 'inactive':
      return <span className="worktree-status-fill" />
  }
}

export function WorktreeStatusSlot({ status }: { status: WorktreeStatus }): React.JSX.Element {
  const label = WORKTREE_STATUS_LABEL[status]
  return (
    <div className="worktree-status-slot" data-worktree-card-status-slot="">
      <span className="worktree-status-box">
        <span className={`worktree-status st-${status}`} data-worktree-status={status} title={label} aria-label={label}>
          <Indicator status={status} />
        </span>
      </span>
    </div>
  )
}
