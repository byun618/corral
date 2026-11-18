// design-handoff.md §2 InlineNotice — 탭바 아래 28px, 해제 가능. 라이프사이클 거절·실패·안내를
// 여기서 보인다(옛 App.tsx 의 상단 배너 자리를 대신한다 — §1-2 "알림 배너 삭제 → 탭바 아래").
// LIFE-822 G1-2 — 문구는 한 줄(넘치면 말줄임), 전문은 `title` 툴팁.
import type { LifecycleNotice } from '../lifecycle-types.js'

export function InlineNotice({ notice, onDismiss }: { notice: LifecycleNotice; onDismiss: () => void }): React.JSX.Element {
  const text =
    notice.kind === 'rejected'
      ? `herdr 거절 (${notice.code}): ${notice.message}`
      : notice.kind === 'info'
        ? notice.message
        : `실패: ${notice.message}`
  return (
    <div
      className={`inline-notice tone-${notice.kind}`}
      data-lifecycle-notice
      data-notice-kind={notice.kind}
      data-notice-code={notice.kind === 'rejected' ? notice.code : ''}
    >
      <span className="inline-notice-dot" />
      <span className="inline-notice-text" title={text}>{text}</span>
      <div className="inline-notice-spacer" />
      <button className="inline-notice-dismiss" data-notice-dismiss onClick={onDismiss}>
        해제
      </button>
    </div>
  )
}
