// design-handoff.md §2 MainTabBar — **활성 workspace 가 있으면 탭 수와 무관하게 존재**한다
// (01-criteria.md 부록 C5′ / 11-gate1-fix3.md I-5). 마운트 조건은 `App.tsx` 의
// `activeWorkspace !== null` 하나뿐이고, 이 파일엔 탭 수 조건이 **없다**.
//
// 전 버전 주석은 "`sessionCount >= 2` 일 때만 존재(Orca 규칙)" 였는데 **그 근거가 사실이 아니었다.**
// 부록이 인용한 Orca `use-app-chrome-layout.ts:74` 의 `hasTabBar = tabCount >= 2` 는 같은 파일
// `:139` 의 타이틀바 확장 버튼 조건에만 쓰인다 — 탭 스트립을 가르는 상수가 아니다. Orca 는 탭
// 1개에서도 스트립을 그린다. 사용자 지시(*"하나만 있어도 저런식으로 나올 수 있게"*)와 이 사실
// 정정으로 C5 가 C5′ 로 개정됐다. 증명해야 할 상태는 2개(1/N)에서 **3개(0/1/N)** 로 늘었다.
//
// 활성 탭은 배경이 터미널과 이어지고, 비활성은 톤 차이로만. 우측 고정 `+`(빈 탭) · 활성 worktree 라벨.
//
// 닫기(×)는 탭 자체에 둔다 — 수정 1회차(07-fix-orca1.md M-2) 코디네이터 결정: freeze 된 C5 본문이
// "전환·생성(+)·닫기" 를 메인 탭바 위에서 요구하는데 1차 구현은 SessionRow(사이드바)의 닫기로
// 갈음했다. 그건 고정 문구 재해석이라 관문 ③ 위반 — `-claude` 형제 브랜치는 탭바에 닫기가 있어
// 같은 저울로 비교되지 않는다. hover 시에만 보이되 항상 DOM 에 있다(opacity 토글, SessionRow
// 결함 수정과 같은 패턴 — 조건부 렌더링하면 좌표 클릭 계측이 hover 없이는 못 찾는다).
//
// 탭 제목은 사이드바 SessionRow 와 **같은 함수**를 쓴다(`session-title.ts`) — 09-gate1-fix.md C-3
// "세션 제목이 곧 탭 제목이다". 탭바가 받는 목록 자체는 사이드바와 다르다: 여기는 그 worktree 의
// **전체 탭**(셸 포함), 사이드바는 에이전트 세션만 (01-criteria.md 부록 "세션 용어 확정").
import { useState } from 'react'
import type { TabRow } from '../../../shared/types.js'
import { agentIcon } from '../session-glyphs.js'
import { AgentIcon } from './AgentIcon.js'
import { sessionTitle, tabAgent } from '../session-title.js'

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
  // H-6 을 탭바에도 적용한다(구현자 판단) — 사이드바와 탭바가 같은 세션을 다른 기호로 보이면
  // 두 목록을 짝지어 읽을 수 없다. 탭바는 **셸 탭도** 보여주므로 에이전트가 없는 탭은 `shell`
  // 아이콘(`$`)으로 떨어뜨린다 — 여기서만 의미가 있는 구분이다(사이드바는 에이전트 세션만 그린다).
  const kind = agentIcon(tabAgent(tab) ?? 'shell')
  return (
    <div
      className={`main-tab ${active ? 'is-active' : ''}`}
      data-main-tab={tab.tabId}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      <span className={`main-tab-dot tone-${tab.agentStatus === 'working' ? 'accent' : 'neutral'}`} />
      {kind === null ? null : (
        <span className={`main-tab-agent agent-${kind.kind}`} data-agent-kind={kind.kind} title={kind.label}>
          <AgentIcon kind={kind.kind} glyph={kind.glyph} />
        </span>
      )}
      <span className="main-tab-label">{sessionTitle(tab)}</span>
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
}): React.JSX.Element {
  // 탭 수로 가르지 않는다(C5′). 탭이 0개여도 `+` 와 worktree 라벨이 남는 껍데기를 그린다 —
  // 마지막 탭을 닫았을 때 탭바가 통째로 사라지면 새 탭을 만들 진입점이 같이 사라진다.
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
