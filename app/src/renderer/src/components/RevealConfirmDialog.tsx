import { useAnnounceDialog, useWindowEscape } from '../menu-bus.js'
import { CrosshairIcon } from './SidebarIcons.js'

/**
 * 198 「Reveal hidden workspace?」(`use-reveal-requests.ts:113-146`) — 확인에 처음 포커스, 「필터 유지」 면 아무 것도 안 바뀐다.
 * Esc 는 포커스와 무관하게 닫고(IME 조합 중 제외), 뜨면 열린 hover 카드를 닫는다 (r3 L-01 — 삭제·정보 수정 대화와 같은 배선).
 */
export function RevealConfirmDialog(props: { path: string; onKeep: () => void; onClear: () => void }): React.JSX.Element {
  const { path, onKeep, onClear } = props
  useAnnounceDialog()
  useWindowEscape({ onEscape: onKeep })
  return (
    <div className="modal-scrim" data-modal-scrim onMouseDown={onKeep}>
      <div className="modal modal-confirm" data-card-dialog="" data-reveal-confirm={path} role="dialog" aria-label="숨겨진 워크스페이스 보기" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head modal-head-plain">
          <h2 className="modal-title">
            <CrosshairIcon className="reveal-confirm-icon" /> 숨겨진 워크스페이스를 보일까요?
          </h2>
        </div>
        <div className="modal-body">
          <p className="modal-desc">활성 워크스페이스가 사이드바에서 숨겨져 있습니다. 보이려면 사이드바 필터를 지웁니다.</p>
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" data-reveal-keep-filters="" onClick={onKeep}>
            필터 유지
          </button>
          <button className="btn-accent" data-reveal-clear-filters="" autoFocus onClick={onClear}>
            필터 지우고 보기
          </button>
        </div>
      </div>
    </div>
  )
}
