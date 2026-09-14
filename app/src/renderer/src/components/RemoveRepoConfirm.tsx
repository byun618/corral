// design-handoff.md §2 RemoveRepoConfirm — 대상 경로 + "디스크는 안 건드린다" 설명 + 잔존물 요약.
// 로직은 옛 App.tsx 의 ConfirmRemove(475-524줄) 그대로 — 자리와 스타일만 바뀜.
import type { RepoRow } from '../../../shared/types.js'

const REMOVE_DISCLAIMER = '등록 목록에서만 빠집니다. 디스크의 워크트리와 herdr 세션은 그대로 남습니다.'

export function RemoveRepoConfirm({
  repo,
  error,
  onConfirm,
  onCancel,
}: {
  repo: RepoRow
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const sessionCount = repo.worktrees.reduce((sum, worktree) => sum + (worktree.workspace?.tabs.length ?? 0), 0)
  return (
    <div className="modal-scrim" data-modal-scrim onClick={onCancel}>
      <div className="modal modal-confirm" data-confirm-remove={repo.root} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head modal-head-plain">
          <h2 className="modal-title" data-confirm-title>
            목록에서 레포를 제거할까요?
          </h2>
          <button className="modal-close" data-confirm-close aria-label="닫기" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-code-block" data-confirm-root title={repo.root}>
            {repo.root}
          </p>
          <p className="modal-desc" data-confirm-name>
            <span className="confirm-name">{repo.name}</span> — {REMOVE_DISCLAIMER}
          </p>
          <p className="modal-meta-line" data-confirm-note>
            <span className="dot tone-dirty" />
            {repo.worktrees.length}개 워크트리 · {sessionCount}개 세션이 디스크에 남습니다
          </p>
        </div>
        {error === null ? null : (
          <p className="modal-note" data-confirm-error>
            빼지 못했다: {error}
          </p>
        )}
        <div className="modal-footer">
          <button className="btn-ghost" data-confirm-cancel onClick={onCancel}>
            취소
          </button>
          <button className="btn-danger" data-confirm-ok onClick={onConfirm}>
            제거
          </button>
        </div>
      </div>
    </div>
  )
}
