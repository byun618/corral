// 사이드바 머리 (LIFE-527 D4·D5) — Orca 198 `TitlebarLeftControls.tsx` + `main.css` `.titlebar-left`.
// 신호등 여백(macOS·전체화면 아님) · 앱 이름 · 사이드바 토글(lucide `PanelLeft` 16). 빈 자리는 창 드래그, 이름·토글은 no-drag.
// 펼침: 사이드바 칸 위 36px. 접힘: 같은 머리가 왼쪽 위에 떠서 첫 탭 줄과 겹친다(`floating`) — 그 탭 줄 앞에 같은 폭의
// no-drag 여백을 둬야 떠 있는 토글이 눌린다(Electron drag 히트테스트는 z-index 형제가 아니라 DOM 순서로 본다, Orca `TabGroupPanel.tsx:255`).
// Orca 의 Back/Forward(워크트리 내역)는 corral 에 기능이 없어 뺐다(범위 밖). 「c」 마크는 Orca 에 대응이 없어 뺐다(D4).
import type { Ref } from 'react'
import { PanelLeftIcon } from './SidebarIcons.js'

export function SidebarHead({
  floating,
  trafficLightPad,
  toggleLabel,
  toggleShortcut,
  onToggle,
  controlsRef,
}: {
  floating: boolean
  trafficLightPad: boolean
  /** 「사이드바 접기」 / 「사이드바 펼치기」 */
  toggleLabel: string
  /** 표시용 단축키(⌘B). 비운 칸(null)이면 툴팁에 단축키를 싣지 않는다(fix3 R3-01 — 빈 괄호를 만들지 않는다). */
  toggleShortcut: string | null
  onToggle: () => void
  /** 떠 있는 머리의 컨트롤 줄 폭을 재는 자리 — 탭 줄 no-drag 여백 폭이 된다(Orca `titlebarLeftControlsRef`). */
  controlsRef?: Ref<HTMLDivElement>
}): React.JSX.Element {
  return (
    <div className={`sidebar-head${floating ? ' is-floating' : ''}`} data-sidebar-head={floating ? 'floating' : 'docked'}>
      <div className="sidebar-head-controls" ref={controlsRef}>
        {trafficLightPad ? <div className="sidebar-head-traffic-pad" data-traffic-light-pad="" /> : <div className="sidebar-head-edge-pad" />}
        <div className="sidebar-head-app-name" data-app-name="">
          <span>corral</span>
        </div>
        <button
          type="button"
          className="sidebar-head-toggle"
          data-sidebar-toggle={floating ? 'show' : 'hide'}
          aria-label={toggleLabel}
          title={toggleShortcut === null ? toggleLabel : `${toggleLabel} (${toggleShortcut})`}
          onClick={onToggle}
        >
          <PanelLeftIcon className="sidebar-head-toggle-icon" />
        </button>
      </div>
    </div>
  )
}
