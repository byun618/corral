// design-handoff.md §2 CreateWorktreeModal — 브랜치·경로 2필드, 경로는 브랜치에서 자동 생성.
// 로직은 옛 App.tsx 587-678줄 그대로(텍스트 입력 — OS 다이얼로그 아님, L7) — 자리와 스타일만 바뀜.
import { useState } from 'react'
import type { WorktreeActionResult } from '../../../shared/types.js'

export function CreateWorktreeModal({
  repoRoot,
  create,
  onClose,
  onDone,
}: {
  repoRoot: string
  /** 생성 IPC — 성공하면 새 워크트리를 활성으로 세우는 라이프사이클 경로(LIFE-490 D3, `useLifecycleActions.createWorktree`). */
  create: (input: { repoRoot: string; branch: string; path: string }) => Promise<WorktreeActionResult>
  onClose: () => void
  onDone: (message: string) => void
}): React.JSX.Element {
  const worktreesDir = `${repoRoot}/.claude/worktrees`
  const derivePath = (branch: string): string => {
    const slug = branch.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    return slug.length === 0 ? `${worktreesDir}/` : `${worktreesDir}/${slug}`
  }

  const [branch, setBranch] = useState('')
  const [pathValue, setPathValue] = useState('')
  const [pathEdited, setPathEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const effectivePath = pathEdited ? pathValue : derivePath(branch)

  const submit = async (): Promise<void> => {
    if (branch.trim().length === 0) {
      setNote('branch 이름을 넣어라')
      return
    }
    setBusy(true)
    setNote(null)
    try {
      const result = await create({ repoRoot, branch: branch.trim(), path: effectivePath })
      if (result.ok) {
        onDone(`worktree 만듦: ${branch.trim()}`)
        return
      }
      if (result.rejection) setNote(`herdr 거절 (${result.rejection.code}): ${result.rejection.message}`)
      else setNote(`실패: ${result.error ?? '알 수 없음'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" data-modal-scrim onClick={onClose}>
      <div className="modal modal-create" data-create-worktree-modal onClick={(event) => event.stopPropagation()}>
        <div className="modal-head modal-head-create">
          <div>
            <h2 className="modal-title">워크트리 생성</h2>
            <p className="modal-subtitle">{repoRoot}</p>
          </div>
          <button className="modal-close" data-create-worktree-close aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">브랜치</span>
            <input
              className="field-input"
              data-worktree-branch-input
              value={branch}
              placeholder="issue/LIFE-357-follow-up"
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">경로</span>
            <input
              className="field-input"
              data-worktree-path-input
              value={effectivePath}
              onChange={(event) => {
                setPathEdited(true)
                setPathValue(event.target.value)
              }}
            />
            <span className="field-hint">브랜치 이름에서 자동 생성 — 필요하면 수정</span>
          </label>
        </div>
        {note === null ? null : (
          <p className="modal-note" data-worktree-create-note>
            {note}
          </p>
        )}
        <div className="modal-footer">
          <button className="btn-ghost" data-create-worktree-cancel onClick={onClose}>
            취소
          </button>
          <button className="btn-accent" data-worktree-create-submit disabled={busy} onClick={() => void submit()}>
            생성
          </button>
        </div>
      </div>
    </div>
  )
}
