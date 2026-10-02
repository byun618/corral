// 워크트리 정보 수정 대화 (LIFE-478 K3ⓒ) — 198 `WorktreeMetaDialog.tsx`(「Edit Worktree Details」) 의 표시 이름·Comment 두 칸.
// 이슈·PR 칸은 의도적으로 뺐다(D25). 198 규칙:
//   · 메뉴 「업데이트」 → 표시 이름에 포커스, 제목 밖 더블클릭도 같은 대화
//   · 표시 이름은 trim, **빈 값 저장 = 브랜치로 되돌림**(CLI `--display-name null` 과 같은 지움)
//   · Comment 는 Enter 저장 · Shift+Enter 줄바꿈 · 바뀐 칸만 보낸다
//   · 실패는 대화 안에 오류로, 대화는 남는다 · 성공이면 닫힌다
import { useEffect, useRef, useState } from 'react'
import type { WorktreeRow } from '../../../shared/types.js'
import { useAnnounceDialog, useWindowEscape } from '../menu-bus.js'

export function WorktreeMetaDialog({
  worktree,
  onSave,
  onClose,
}: {
  worktree: WorktreeRow
  /** 바뀐 칸만 담아 부른다. 오류면 문자열, 성공이면 null. */
  onSave: (patch: { displayName?: string | null; comment?: string | null }) => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  // 비교 기준 = 연 순간의 값(r2 R2B-06) — 연 동안 상태가 바뀌어도 건드리지 않은 칸은 보내지 않는다(새 값을 옛 값으로 덮지 않게).
  const [initial] = useState(() => ({ name: worktree.displayName ?? '', comment: worktree.comment ?? '' }))
  const [name, setName] = useState(initial.name)
  const [comment, setComment] = useState(initial.comment)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  // 저장 중에는 닫지 않는다(r2 R2B-05) — 닫으면 뒤이은 실패가 어디에도 안 보인다(K3ⓒ 「실패는 대화 안에」).
  const close = (): void => {
    if (!busy) onClose()
  }
  useAnnounceDialog()
  useWindowEscape({ onEscape: close })

  const submit = async (): Promise<void> => {
    if (busy) return
    const patch: { displayName?: string | null; comment?: string | null } = {}
    if (name.trim() !== initial.name) patch.displayName = name.trim() === '' ? null : name.trim()
    if (comment.trim() !== initial.comment) patch.comment = comment.trim() === '' ? null : comment.trim()
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    // 저장이 던져도(IPC reject) 「저장 중…」 에 갇히지 않고 오류를 대화 안에 보인다(r2 R2B-04).
    let failure: string | null
    try {
      failure = await onSave(patch)
    } catch (thrown) {
      failure = thrown instanceof Error ? thrown.message : String(thrown)
    } finally {
      setBusy(false)
    }
    if (failure === null) onClose()
    else setError(failure)
  }

  return (
    <div className="modal-scrim" data-modal-scrim onMouseDown={close}>
      <div
        className="modal modal-create"
        data-card-dialog=""
        data-worktree-meta-dialog={worktree.path}
        role="dialog"
        aria-label="워크트리 정보 수정"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 className="modal-title">워크트리 정보 수정</h2>
            <p className="modal-subtitle">{worktree.path}</p>
          </div>
          <button className="modal-close" aria-label="닫기" disabled={busy} onClick={close}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">표시 이름</span>
            <input
              ref={nameRef}
              className="field-input"
              data-meta-display-name=""
              value={name}
              placeholder={worktree.branch ?? '표시 이름…'}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <span className="field-hint">사이드바에 보이는 이름만 바뀝니다 — 디스크의 폴더는 그대로입니다. 비우면 브랜치 이름을 씁니다.</span>
          </label>
          <label className="field">
            <span className="field-label">코멘트</span>
            <textarea
              className="field-input field-textarea"
              data-meta-comment=""
              value={comment}
              rows={4}
              placeholder="이 워크트리에 대한 메모…"
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                // Enter 저장 · Shift+Enter 줄바꿈 (198 `WorktreeMetaDialog.tsx:291-301`). IME 조합 중 Enter 는 글자 확정이다.
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <span className="field-hint">Enter 저장 · Shift+Enter 줄바꿈</span>
          </label>
        </div>
        {error === null ? null : (
          <p className="modal-note" data-meta-error="">
            저장하지 못했습니다: {error}
          </p>
        )}
        <div className="modal-footer">
          <button className="btn-ghost" data-meta-cancel="" disabled={busy} onClick={close}>
            취소
          </button>
          <button className="btn-accent" data-meta-save="" disabled={busy} onClick={() => void submit()}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
