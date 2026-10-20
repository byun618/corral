// design-handoff.md §2 StatusBar — LIFE-636 이 틀을 다시 짰다(02-kickoff 「오른쪽 세그먼트 슬롯 계약」):
//   ⓞ 왼쪽 끝 브랜치 라벨 + git 배지 ① 사용량 슬롯(provider 칩·팝오버) ② spacer ③ 오른쪽 세그먼트 슬롯.
// groups·panes·agents·xterm 은 지웠다(LIFE-636 — 사용자: 「한 번도 본 적이 없다」). 브랜치 라벨·git 배지는 게이트 ① 수정 1 에서 되살렸다.
// §5 "상태바 = 창 전역 합계" — git 배지는 이 창에 등록된 전체 worktree 의 dirty/ahead/behind 합. 폭이 모자라면 라벨이 먼저 말줄임된다(CSS).
// 오른쪽 슬롯의 자식은 메모리 한 줄뿐이고 그 줄은 LIFE-637 경계라 **바이트 그대로** 둔다(들여쓰기 포함 — 637 이 그 한 줄을 자기 세그먼트로 바꾼다).
import { StatusBarUsage } from './StatusBarUsage.js'

export function StatusBar({
  inert = false,
  activeWorktreeLabel,
  dirtyTotal,
  aheadTotal,
  behindTotal,
  resourceSegment,
}: {
  inert?: boolean
  activeWorktreeLabel: string | null
  dirtyTotal: number
  aheadTotal: number
  behindTotal: number
  resourceSegment: React.ReactNode
}): React.JSX.Element {
  const label = `corral${activeWorktreeLabel === null ? '' : ` / ${activeWorktreeLabel}`}`
  return (
    <div className="statusbar" data-statusbar inert={inert}>
      <span className="statusbar-repo" title={label}>{label}</span>
      <span className="statusbar-badge tone-dirty">●{dirtyTotal}</span>
      <span className="statusbar-badge tone-ahead">↑{aheadTotal}</span>
      <span className="statusbar-badge tone-behind">↓{behindTotal}</span>
      <div className="statusbar-usage" data-statusbar-usage>
        <StatusBarUsage suspended={inert} />
      </div>
      <div className="statusbar-spacer" />
      <div className="statusbar-segments" data-statusbar-segments>
      {resourceSegment}
      </div>
    </div>
  )
}
