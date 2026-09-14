// design-handoff.md §2 StatusBar — 좌: `corral / {worktree}` + git 배지. 우: panes·agents·xterm·메모리.
// §5 "상태바 = 창 전역 합계" — git 배지는 이 창에 등록된 전체 worktree 의 dirty/ahead/behind 합.
// (worktree 1줄의 마크는 그 worktree 하나만의 값 — 같은 상태를 두 곳에서 반복하지 않는다는 원칙은
// "범위"로 지킨다: 하나는 전역 합, 하나는 개별.)
export function StatusBar({
  activeWorktreeLabel,
  dirtyTotal,
  aheadTotal,
  behindTotal,
  paneCount,
  agentCount,
  termSize,
  memoryLabel,
}: {
  activeWorktreeLabel: string | null
  dirtyTotal: number
  aheadTotal: number
  behindTotal: number
  paneCount: number
  agentCount: number
  termSize: { cols: number; rows: number } | null
  memoryLabel: string | null
}): React.JSX.Element {
  return (
    <div className="statusbar" data-statusbar>
      <span className="statusbar-repo">corral{activeWorktreeLabel === null ? '' : ` / ${activeWorktreeLabel}`}</span>
      <span className="statusbar-badge tone-dirty">●{dirtyTotal}</span>
      <span className="statusbar-badge tone-ahead">↑{aheadTotal}</span>
      <span className="statusbar-badge tone-behind">↓{behindTotal}</span>
      <div className="statusbar-spacer" />
      <span>{paneCount} panes</span>
      <span>{agentCount} agents</span>
      <span>{termSize === null ? 'xterm —' : `xterm ${termSize.cols}×${termSize.rows}`}</span>
      {memoryLabel === null ? null : <span>{memoryLabel}</span>}
    </div>
  )
}
