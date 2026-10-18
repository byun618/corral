// design-handoff.md §2 StatusBar — LIFE-636 이 틀을 다시 짰다(02-kickoff 「오른쪽 세그먼트 슬롯 계약」):
//   ① 왼쪽 사용량 슬롯(provider 칩·팝오버) ② spacer ③ 오른쪽 세그먼트 슬롯.
// 브랜치 라벨·git 배지·groups·panes·agents·xterm 은 지웠다(LIFE-636 — 사용자: 「한 번도 본 적이 없다」).
// 오른쪽 슬롯의 자식은 메모리 한 줄뿐이고 그 줄은 LIFE-637 경계라 **바이트 그대로** 둔다(들여쓰기 포함 — 637 이 그 한 줄을 자기 세그먼트로 바꾼다).
import { StatusBarUsage } from './StatusBarUsage.js'

export function StatusBar({
  inert = false,
  memoryLabel,
}: {
  inert?: boolean
  memoryLabel: string | null
}): React.JSX.Element {
  return (
    <div className="statusbar" data-statusbar inert={inert}>
      <div className="statusbar-usage" data-statusbar-usage>
        <StatusBarUsage suspended={inert} />
      </div>
      <div className="statusbar-spacer" />
      <div className="statusbar-segments" data-statusbar-segments>
      {memoryLabel === null ? null : <span>{memoryLabel}</span>}
      </div>
    </div>
  )
}
