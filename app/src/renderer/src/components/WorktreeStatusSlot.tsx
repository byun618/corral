// 카드 상태 슬롯 (LIFE-468 K5ⓑ) — Orca 1.4.198 Detailed 의 `[data-worktree-card-status-slot]` + `StatusIndicator`.
//
// 슬롯은 `pt-[2px]` 의 16px 칸, 그 안에 12px 표시(`h-3 w-3`):
//   working = 노란 스피너 8px · monitoring = Activity 12px 노랑 · permission = 질문 아이콘 12px 주황 ·
//   interrupted = 빨간 점 6px · done/active = 초록 점 8px · inactive = 회색 점 8px(neutral-500/40).
// 색은 467 이 옮겨 둔 Orca 팔레트 토큰(`--agent-dot-*`)을 그대로 쓴다.
//
// LIFE-471 K5 — 198 classic 카드(`showUnreadQuickAction`, `WorktreeCardStatusSlot.tsx`)처럼 **16px 칸 자체가 안 읽음 토글 버튼**이다:
//   · 벨 켜짐 = 상태 표시를 **대체하는** 채운 벨 13px amber(working·permission 보다도 앞 — 198 그대로)
//   · 벨 꺼짐 = 기존 상태 표시 + hover·포커스 때 흐린 벨 12px(상태 표시는 그동안 숨는다)
//   · 클릭 = 토글(메뉴 Mark Read/Unread 와 같은 동작). 카드를 활성화하지 않고 끌기를 시작하지 않는다(198 `stopQuickActionPointerPropagation`).
import { UNREAD_ACTION_LABEL } from '../unread.js'
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

/** 198 `FilledBellIcon`(`WorktreeCardHelpers.tsx:38-49`) 경로. 탭 선두 벨(LIFE-493)도 같은 경로를 쓴다. */
export const FILLED_BELL_PATH =
  'M5.25 9A6.75 6.75 0 0 1 12 2.25 6.75 6.75 0 0 1 18.75 9v3.75c0 .526.214 1.03.594 1.407l.53.532a.75.75 0 0 1-.53 1.28H4.656a.75.75 0 0 1-.53-1.28l.53-.532A1.989 1.989 0 0 0 5.25 12.75V9Zm6.75 12a3 3 0 0 0 2.996-2.825.75.75 0 0 0-.748-.8h-4.5a.75.75 0 0 0-.748.8A3 3 0 0 0 12 21Z'

function FilledBellGlyph(): React.JSX.Element {
  return (
    <svg className="worktree-unread-bell" viewBox="0 0 24 24" aria-hidden="true" data-worktree-unread-bell="">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={FILLED_BELL_PATH} />
    </svg>
  )
}

/** lucide `Bell`(198 hover 흐린 벨) — 선 아이콘. */
function BellGlyph(): React.JSX.Element {
  return (
    <svg className="worktree-unread-hint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </svg>
  )
}

export function WorktreeStatusSlot({ status, unread = false, onToggleUnread = null }: {
  status: WorktreeStatus
  /** 벨 켜짐(worktree 안 읽음). */
  unread?: boolean
  /** 없으면 버튼 없는 칸(옛 호출부·시험). */
  onToggleUnread?: (() => void) | null
}): React.JSX.Element {
  const label = WORKTREE_STATUS_LABEL[status]
  const indicator = (
    <span className={`worktree-status st-${status}`} data-worktree-status={status} title={onToggleUnread === null ? label : undefined} aria-label={label}>
      <Indicator status={status} />
    </span>
  )
  if (onToggleUnread === null) {
    return (
      <div className="worktree-status-slot" data-worktree-card-status-slot="">
        <span className="worktree-status-box">{indicator}</span>
      </div>
    )
  }
  const action = unread ? UNREAD_ACTION_LABEL.read : UNREAD_ACTION_LABEL.unread
  return (
    <div className="worktree-status-slot" data-worktree-card-status-slot="">
      <button
        type="button"
        className={`worktree-status-box worktree-unread-toggle ${unread ? 'is-unread' : ''}`}
        data-worktree-unread-toggle={unread ? 'unread' : 'read'}
        aria-label={action}
        // 198: 읽음이면 「상태 · Mark unread」, 안 읽음이면 「Mark read」.
        title={unread ? action : `${label} · ${action}`}
        // 끌기는 카드 줄의 mousedown 이 무장한다(LIFE-469) — 여기서 끊어야 벨 클릭이 끌기를 시작하지 않는다.
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onToggleUnread()
        }}
      >
        {unread ? (
          <FilledBellGlyph />
        ) : (
          <>
            {indicator}
            <BellGlyph />
          </>
        )}
      </button>
    </div>
  )
}
