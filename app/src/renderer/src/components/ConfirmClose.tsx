// 종료 확인 모달 (L4) — 옛 App.tsx 534-576줄 그대로, 자리·스타일만 바뀜.
// 판별자는 herdr `pane.process_info` 의 포그라운드 프로세스 그룹 (main 이 종료 직전에 판정).
// LIFE-495 — 문구는 `close-copy.ts`(K5 에이전트/명령/핀), 탭 여럿을 닫을 때는 탭마다 한 줄(라벨 + 실행 중 프로세스)로 모아 한 번에 묻는다.
// LIFE-516 — `copy.dontAskAgain` 이 있으면 본문 아래 「다시 묻지 않음」 체크박스. 확인 때 `onConfirm({ dontAskAgain })` 로 체크 여부를 넘긴다
// (저장은 부른 쪽). 체크 상태는 창이 새로 열릴 때마다 꺼짐 — 부른 쪽이 창마다 `key` 를 바꾼다.
// LIFE-693 — 줄이 많아 창이 뷰포트를 넘으면 머리·바닥은 그대로 두고 본문만 세로 스크롤(`modal-confirm-close`, styles.css).
import { useState } from 'react'
import type { CloseCopy } from '../close-copy.js'
import { DontAskAgain } from './DontAskAgain.js'

export type ConfirmCloseRow = { key: string; label: string | null; foreground: string[] }

export function ConfirmClose({
  copy,
  rows,
  onConfirm,
  onCancel,
}: {
  copy: CloseCopy
  /** 탭 닫기: 실행 중이거나 고정된 탭마다 한 줄. worktree 닫기: 라벨 없는 한 줄에 프로세스 목록. */
  rows: ConfirmCloseRow[]
  onConfirm: (input: { dontAskAgain: boolean }) => void
  onCancel: () => void
}): React.JSX.Element {
  const [dontAskAgain, setDontAskAgain] = useState(false)
  return (
    <div className="modal-scrim" data-modal-scrim onClick={onCancel}>
      <div
        className="modal modal-confirm modal-confirm-close"
        data-confirm-close-modal
        data-confirm-close-kind={copy.kind}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head modal-head-plain">
          <h2 className="modal-title" data-confirm-close-title>
            {copy.title}
          </h2>
          <button className="modal-close" data-confirm-close-x aria-label="닫기" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="modal-body" data-confirm-close-scroll>
          {copy.body.map((line, index) => (
            <p key={index} className="modal-desc" data-confirm-close-body={index}>
              {line}
            </p>
          ))}
          <ul className="modal-list" data-confirm-close-fg>
            {rows.flatMap((row) => [
              ...(row.label === null ? [] : [<li key={`${row.key}:label`} className="modal-close-tab" data-confirm-close-tab={row.key}>{row.label}</li>]),
              ...row.foreground.map((item, index) => (
                <li key={`${row.key}:${index}`} className="modal-code-block">
                  {item}
                </li>
              )),
            ])}
          </ul>
          {copy.dontAskAgain === null ? null : <DontAskAgain label={copy.dontAskAgain.label} checked={dontAskAgain} onChange={setDontAskAgain} />}
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" data-close-confirm-cancel onClick={onCancel}>
            취소
          </button>
          <button className="btn-danger" data-close-confirm-ok onClick={() => onConfirm({ dontAskAgain: copy.dontAskAgain !== null && dontAskAgain })}>
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
