// 워크트리 삭제 확인 (LIFE-478 K7ⓑ) — 198 `DeleteWorktreeDialog.tsx`(대상 이름·경로·dirty 개수·자식 안내, 확인 = 강제).
//
// 198 은 확인 단추가 늘 강제 삭제다(`forceOnConfirm` 기본 true). corral 은 **이름을 정직하게** 붙인다 — 깨끗하고 한가하면 「삭제」,
// 아니면 「강제 삭제」 와 함께 강제로 넘기는 것을 하나씩 적는다(Orca #16526). 잠김·herdr 링크 없음은 단추가 없다.
// 「다시 묻지 않음」(LIFE-516 S37b — C16 의 450 보류 해소, 되돌리는 자리 = 설정 › 일반 「워크트리를 삭제하기 전에 확인」):
// 체크박스는 **미리보기 판정이 「삭제」(깨끗·한가)일 때만** 보인다(D4) — 강제·막힘·읽기 실패·읽는 중에는 없다. 그래서 생략 경로도
// 「삭제」 판정의 non-force 삭제뿐이고, dirty·live 세션이 있는 워크트리는 설정과 무관하게 이 창을 지난다(`useCardActions.tsx`).
// 체크 + 「삭제」 → `onConfirm({ force:false, dontAskAgain:true })`(저장은 부른 쪽). 취소·Esc 는 저장하지 않는다. 창이 다시 열리면 꺼짐.
import { useEffect, useRef, useState } from 'react'
import type { WorktreeDeletePreview } from '../../../shared/types.js'
import { deleteDecision } from '../card-menu.js'
import { DontAskAgain } from './DontAskAgain.js'
import { useAnnounceDialog, useWindowEscape } from '../menu-bus.js'

export function DeleteWorktreeDialog({
  name,
  path,
  preview,
  onConfirm,
  onClose,
}: {
  name: string
  path: string
  /** null = 아직 읽는 중. */
  preview: WorktreeDeletePreview | null
  onConfirm: (input: { force: boolean; dontAskAgain: boolean }) => void
  onClose: () => void
}): React.JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const decision = preview === null || !preview.ok ? null : deleteDecision(preview)
  const focusKind = preview === null ? 'loading' : (decision?.kind ?? 'error')
  useAnnounceDialog()
  useWindowEscape({ onEscape: onClose })
  useEffect(() => {
    // 첫 포커스 — 「삭제」(깨끗·한가)만 198 처럼 확인 단추(Delete 다음 Enter). 「강제 삭제」 는 Enter 한 번이 미커밋 변경을 지우므로
    // 「취소」 에(r2 R2B-08), 막힘·읽기 실패는 「닫기」/「취소」 에(R2B-01). 읽는 중에는 옮기지 않는다(Esc 는 포커스와 무관하게 닫는다).
    switch (focusKind) {
      case 'delete':
        confirmRef.current?.focus()
        return
      case 'force':
      case 'blocked':
      case 'error':
        cancelRef.current?.focus()
        return
      case 'loading':
        return
    }
  }, [focusKind])

  return (
    <div className="modal-scrim" data-modal-scrim onMouseDown={onClose}>
      <div
        className="modal modal-confirm"
        data-card-dialog=""
        data-delete-worktree-dialog={path}
        data-delete-decision={decision?.kind ?? (preview === null ? 'loading' : 'error')}
        role="dialog"
        aria-label="워크트리 삭제"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head modal-head-plain">
          <h2 className="modal-title">워크트리 삭제</h2>
          <button className="modal-close" aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">
            <span className="confirm-name">{name}</span> 을 git 에서 제거하고 워크트리 폴더를 지웁니다.
          </p>
          <p className="modal-code-block" data-delete-path="" title={path}>
            {path}
          </p>
          {preview === null ? <p className="modal-desc" data-delete-loading="">상태를 읽는 중…</p> : null}
          {preview !== null && !preview.ok ? (
            <p className="modal-note" data-delete-preview-error="">
              상태를 읽지 못했습니다: {preview.error}
            </p>
          ) : null}
          {preview !== null && preview.ok ? (
            <ul className="delete-facts" data-delete-facts="">
              <li data-delete-dirty={preview.dirtyCount}>커밋하지 않은 변경 {preview.dirtyCount}개</li>
              <li data-delete-sessions={preview.liveSessions ?? 'unknown'}>
                살아 있는 세션 {preview.liveSessions === null ? '알 수 없음' : `${preview.liveSessions}개`}
              </li>
              {preview.childPaths.length > 0 ? (
                <li data-delete-children={preview.childPaths.length}>하위 워크트리 {preview.childPaths.length}개 — 지우면 상위 링크가 풀립니다(하위는 지우지 않습니다)</li>
              ) : null}
              {preview.branch !== null && preview.branch !== '(detached)' ? (
                <li data-delete-branch="">브랜치 {preview.branch} — corral 이 만든 브랜치만 함께 지웁니다(병합 안 됐으면 남깁니다)</li>
              ) : null}
            </ul>
          ) : null}
          {decision?.kind === 'blocked' ? (
            <p className="modal-note delete-blocked" data-delete-blocked="">
              {decision.reason}
            </p>
          ) : null}
          {decision?.kind === 'force' ? (
            <div className="delete-force-warning" data-delete-force-warning="">
              <span className="delete-force-title">강제 삭제는 다음을 넘깁니다</span>
              <ul>
                {decision.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {decision?.kind === 'delete' ? <DontAskAgain label="깨끗한 워크트리는 다시 묻지 않기" checked={dontAskAgain} onChange={setDontAskAgain} /> : null}
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} className="btn-ghost" data-delete-cancel="" onClick={onClose}>
            {decision?.kind === 'blocked' ? '닫기' : '취소'}
          </button>
          {decision !== null && decision.kind !== 'blocked' ? (
            <button ref={confirmRef} className="btn-danger" data-delete-confirm={decision.kind} onClick={() => onConfirm({ force: decision.kind === 'force', dontAskAgain: decision.kind === 'delete' && dontAskAgain })}>
              {decision.kind === 'force' ? '강제 삭제' : '삭제'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
