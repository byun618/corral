// 종료 확인 모달 (L4) — 옛 App.tsx 534-576줄 그대로, 자리·스타일만 바뀜.
// 판별자는 herdr `pane.process_info` 의 포그라운드 프로세스 그룹 (main 이 종료 직전에 판정).
import type { CloseTarget } from '../lifecycle-types.js'

export function ConfirmClose({
  target,
  foreground,
  onConfirm,
  onCancel,
}: {
  target: CloseTarget
  foreground: string[]
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const what = target.kind === 'tab' ? '이 탭을' : '이 worktree 를'
  return (
    <div className="modal-scrim" data-modal-scrim onClick={onCancel}>
      <div
        className="modal modal-confirm"
        data-confirm-close-modal
        data-confirm-close-kind={target.kind}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head modal-head-plain">
          <h2 className="modal-title" data-confirm-close-title>
            {what} 닫을까
          </h2>
          <button className="modal-close" data-confirm-close-x aria-label="닫기" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">포그라운드에 도는 프로세스가 있다. 닫으면 같이 종료된다.</p>
          <ul className="modal-list" data-confirm-close-fg>
            {foreground.map((item, index) => (
              <li key={index} className="modal-code-block">
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" data-close-confirm-cancel onClick={onCancel}>
            취소
          </button>
          <button className="btn-danger" data-close-confirm-ok onClick={onConfirm}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
