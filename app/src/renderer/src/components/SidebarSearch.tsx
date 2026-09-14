// design-handoff.md §2 SidebarSearch — "검색 동작은 이번 라운드 범위 밖, 시각 스펙만".
// 01-criteria.md C6 도 이 컴포넌트는 정적 마크업으로 충분하다고 명시한다 — input 은 disabled.
export function SidebarSearch(): React.JSX.Element {
  return (
    <div className="sidebar-search" data-sidebar-search>
      <span className="sidebar-search-glyph">⌕</span>
      <input className="sidebar-search-input" placeholder="레포 · 워크트리 검색" disabled />
    </div>
  )
}
