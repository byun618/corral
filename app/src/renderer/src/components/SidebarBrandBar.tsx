// design-handoff.md §2 SidebarBrandBar — corral 로고 + ⌘T 힌트(App.tsx 의 실제 단축키, LIFE-356 G2).
export function SidebarBrandBar(): React.JSX.Element {
  return (
    <div className="brandbar" data-brandbar>
      <span className="brandbar-mark">c</span>
      <span className="brandbar-name">corral</span>
      <span className="brandbar-hint">⌘T</span>
    </div>
  )
}
