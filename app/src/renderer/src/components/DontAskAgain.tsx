// 「다시 묻지 않음」 체크박스 (LIFE-516 K3ⓒ·K4ⓐ·K5ⓐ) — 닫기 확인 창·워크트리 삭제 창이 같이 쓴다.
// Orca 198 `PinnedTabCloseDialog.tsx:75-87`·`CloseTerminalDialog.tsx`·`DeleteWorktreeSkipConfirmOption.tsx` 의 자리(본문 아래·버튼 위)와 결.
// 관례(00-analysis W8): 처음엔 꺼짐 · 확인 버튼을 눌렀을 때만 저장 · 취소는 저장 안 함 — 저장은 부른 쪽이 `checked` 를 보고 한다.
export function DontAskAgain({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): React.JSX.Element {
  return (
    <label className="modal-dont-ask" data-dont-ask-again>
      <input type="checkbox" checked={checked} data-dont-ask-again-input onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}
