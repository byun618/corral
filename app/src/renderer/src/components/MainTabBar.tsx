// design-handoff.md §2 MainTabBar — `sessionCount >= 2` 일 때만 존재(Orca 규칙, C5/C9′).
// 활성 탭은 배경이 터미널과 이어지고, 비활성은 톤 차이로만. 우측 고정 `+`(빈 탭) · 활성 worktree 라벨.
import type { TabRow } from '../../../shared/types.js'

export function MainTabBar({
  tabs,
  selectedPane,
  activeWorktreeLabel,
  onSelectTab,
  onCreateShell,
}: {
  tabs: TabRow[]
  selectedPane: string | null
  activeWorktreeLabel: string
  onSelectTab: (tab: TabRow) => void
  onCreateShell: () => void
}): React.JSX.Element | null {
  if (tabs.length < 2) return null // C5 통과선 — 1개 이하면 탭바 자체가 DOM 에 없다
  return (
    <div className="main-tabbar" data-main-tabbar>
      {tabs.map((tab) => {
        const active = tab.panes.some((pane) => pane.paneId === selectedPane)
        return (
          <div
            key={tab.tabId}
            className={`main-tab ${active ? 'is-active' : ''}`}
            data-main-tab={tab.tabId}
            onClick={() => onSelectTab(tab)}
          >
            <span className={`main-tab-dot tone-${tab.agentStatus === 'working' ? 'accent' : 'neutral'}`} />
            <span className="main-tab-label">{tab.label}</span>
          </div>
        )
      })}
      <button className="main-tab-add" data-main-tabbar-add title="빈 탭" onClick={onCreateShell}>
        +
      </button>
      <div className="main-tabbar-spacer" />
      <span className="main-tabbar-active-worktree" data-main-tabbar-worktree title={activeWorktreeLabel}>
        {activeWorktreeLabel}
      </span>
    </div>
  )
}
