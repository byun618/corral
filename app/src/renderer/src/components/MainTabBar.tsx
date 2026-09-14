// design-handoff.md §2 MainTabBar — `sessionCount >= 2` 일 때만 존재(Orca 규칙, C5/C9′).
// 활성 탭은 배경이 터미널과 이어지고, 비활성은 톤 차이로만. 우측 고정 `+`(빈 탭) · 활성 worktree 라벨.
//
// 닫기(×)는 탭 자체에 둔다 — 수정 1회차(07-fix-orca1.md M-2) 코디네이터 결정: freeze 된 C5 본문이
// "전환·생성(+)·닫기" 를 메인 탭바 위에서 요구하는데 1차 구현은 SessionRow(사이드바)의 닫기로
// 갈음했다. 그건 고정 문구 재해석이라 관문 ③ 위반 — `-claude` 형제 브랜치는 탭바에 닫기가 있어
// 같은 저울로 비교되지 않는다. hover 시에만 보이되 항상 DOM 에 있다(opacity 토글, SessionRow
// 결함 수정과 같은 패턴 — 조건부 렌더링하면 좌표 클릭 계측이 hover 없이는 못 찾는다).
import { useState } from 'react'
import type { TabRow } from '../../../shared/types.js'

function MainTab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TabRow
  active: boolean
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className={`main-tab ${active ? 'is-active' : ''}`}
      data-main-tab={tab.tabId}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      <span className={`main-tab-dot tone-${tab.agentStatus === 'working' ? 'accent' : 'neutral'}`} />
      <span className="main-tab-label">{tab.label}</span>
      <button
        className={`main-tab-close ${hovered ? 'is-active' : ''}`}
        data-main-tab-close={tab.tabId}
        title="탭 닫기"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        ×
      </button>
    </div>
  )
}

export function MainTabBar({
  tabs,
  selectedPane,
  activeWorktreeLabel,
  onSelectTab,
  onCreateShell,
  onCloseTab,
}: {
  tabs: TabRow[]
  selectedPane: string | null
  activeWorktreeLabel: string
  onSelectTab: (tab: TabRow) => void
  onCreateShell: () => void
  onCloseTab: (tab: TabRow) => void
}): React.JSX.Element | null {
  if (tabs.length < 2) return null // C5 통과선 — 1개 이하면 탭바 자체가 DOM 에 없다
  return (
    <div className="main-tabbar" data-main-tabbar>
      {tabs.map((tab) => (
        <MainTab
          key={tab.tabId}
          tab={tab}
          active={tab.panes.some((pane) => pane.paneId === selectedPane)}
          onSelect={() => onSelectTab(tab)}
          onClose={() => onCloseTab(tab)}
        />
      ))}
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
