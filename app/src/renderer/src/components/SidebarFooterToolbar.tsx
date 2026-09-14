// design-handoff.md §2 SidebarFooterToolbar — 좌 ⚙/?(설정·도움말, Step 5~7 화면 없음, §4),
// 우 ↻(worktree 상태 재조회) · ◫(패널 토글, 범위 밖). ↻ 만 실동작을 건다 — 나머지는 자리만.
export function SidebarFooterToolbar({ onRefresh }: { onRefresh: () => void }): React.JSX.Element {
  return (
    <div className="sidebar-footer" data-sidebar-footer>
      <span className="sidebar-footer-glyph" title="설정 (화면 없음 — Step 5~7)">
        ⚙
      </span>
      <span className="sidebar-footer-glyph" title="도움말 (화면 없음 — Step 5~7)">
        ?
      </span>
      <div className="sidebar-footer-spacer" />
      <button className="sidebar-footer-glyph sidebar-footer-btn" data-refresh-tree title="worktree 상태 재조회" onClick={onRefresh}>
        ↻
      </button>
      <span className="sidebar-footer-glyph" title="패널 토글 (범위 밖)">
        ◫
      </span>
    </div>
  )
}
