// 탭이 하나도 배정되지 않은 영역 (LIFE-373 F1-4 · 핸드오프 §1-9 기본안).
//
// **영역은 유지한다** — 마지막 탭을 닫아도 영역이 사라지지 않는다. 사라지게 하면 "탭을 닫았는데
// 화면 배치가 통째로 바뀌었다"가 되고, 되돌릴 길이 없다. 대신 이 카드가 두 문을 낸다:
// 새 탭(이 영역에 열린다) · 영역 닫기(영역이 2개 이상일 때만).
//
// ⓒ 모델의 한 줄이 여기 있다: **빈 영역이 받는 것은 새 탭뿐**이다. 사이드바에서 이미 열린 탭을
// 누르면 그 탭이 있는 영역으로 reveal 되고(R3-e) 이 영역은 그대로다.

export function EmptyGroup({
  groupId,
  activeGroup,
  onCreateShell,
  onCloseGroup,
}: {
  groupId: string
  activeGroup: boolean
  onCreateShell: () => void
  /** 영역이 하나뿐이면 `null` — 닫을 수 없다 (F1-5). */
  onCloseGroup: (() => void) | null
}): React.JSX.Element {
  return (
    <div className={`empty-group ${activeGroup ? 'is-active-group' : ''}`} data-empty-group={groupId}>
      <div className="empty-group-card">
        <span className="empty-group-title">탭이 없습니다</span>
        <div className="empty-group-buttons">
          <button className="empty-group-btn" data-empty-group-new={groupId} onClick={onCreateShell}>
            + 새 탭 ⌘T
          </button>
          {onCloseGroup === null ? null : (
            <button className="empty-group-btn" data-empty-group-close={groupId} onClick={onCloseGroup}>
              영역 닫기 ⌘⌥W
            </button>
          )}
        </div>
        <span className="empty-group-hint">새 탭은 이 영역에 열립니다 · 이미 열린 탭은 있는 영역으로 갑니다</span>
      </div>
    </div>
  )
}
