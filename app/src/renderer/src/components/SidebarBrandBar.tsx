// Brand bar uses the live sidebar binding.
export function SidebarBrandBar({ onToggle, shortcutHint }: { onToggle: () => void; shortcutHint: string }): React.JSX.Element {
  return (
    <div className="brandbar" data-brandbar>
      <span className="brandbar-mark">c</span>
      <span className="brandbar-name">corral</span>
      <button className="brandbar-hint" onClick={onToggle} title="사이드바 접기" data-sidebar-toggle>{shortcutHint}</button>
    </div>
  )
}
