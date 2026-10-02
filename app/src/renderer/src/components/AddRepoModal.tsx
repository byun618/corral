// 레포 추가 모달 (게이트 ① 2번째 지시, 2026-09-12) — 옛 App.tsx 429-464줄 그대로, 자리만 옮김.
// design-handoff.md 에는 이 모달의 시각 스펙이 없다("폼 UI 는 이번 범위 밖", §4) — CreateWorktreeModal
// 과 같은 modal-* 클래스로 톤만 맞춘다.
export function AddRepoModal({
  browsing,
  note,
  onBrowse,
  onClose,
}: {
  browsing: boolean
  note: string | null
  onBrowse: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="modal-scrim" data-modal-scrim onClick={onClose}>
      <div className="modal modal-confirm" data-add-repo-modal onClick={(event) => event.stopPropagation()}>
        <div className="modal-head modal-head-plain">
          <h2 className="modal-title" data-modal-title>
            프로젝트 추가
          </h2>
          <button className="modal-close" data-modal-close aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <button className="modal-item" data-browse-folder disabled={browsing} onClick={onBrowse}>
          <span className="modal-item-name">폴더 찾아보기</span>
          <span className="modal-item-hint">로컬 Git 레포 또는 레포가 많은 폴더</span>
        </button>
        {note === null ? null : (
          <p className="modal-note" data-browse-result>
            {note}
          </p>
        )}
      </div>
    </div>
  )
}
