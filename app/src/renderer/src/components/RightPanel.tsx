// 오른쪽 패널 (LIFE-589 F1 · E1) — Orca `right-sidebar/index.tsx` 사이드 레이아웃의 머리(36px · 11px 대문자 제목 · 오른쪽 PanelRight 닫기)와
// 왼쪽 가장자리 리사이저. 탭(액티비티 바)은 하나뿐이라 두지 않는다(572 D1).
//
// **닫아도 마운트를 유지한다**(Orca 와 같다 — 폭 0 · 숨김). 펼침·선택·스크롤 상태가 사라지지 않게(E1ⓔ) 하고, 다시 열 때 리마운트 비용이 없다.
// 닫혀 있으면 여는 버튼은 오른쪽 위 영역 탭 줄 끝(Orca `TitlebarMainStrip` 의 `RightSidebarToggle` 자리)에 선다 — App 이 그 영역에 넘긴다.
import type { Ref } from 'react'
import { PanelRightIcon } from './SidebarIcons.js'

export function RightPanelToggle({ label, shortcut, onToggle, placement }: { label: string; shortcut: string | null; onToggle: () => void; placement: 'tabbar' | 'head' }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`right-panel-toggle is-${placement}`}
      data-right-panel-toggle={placement}
      aria-label={label}
      title={shortcut === null ? label : `${label} (${shortcut})`}
      onClick={onToggle}
    >
      <PanelRightIcon className="sidebar-head-toggle-icon" />
    </button>
  )
}

export function RightPanel({
  open,
  title,
  panelRef,
  toggleShortcut,
  onToggle,
  onResizeStart,
  children,
}: {
  open: boolean
  title: string
  panelRef: Ref<HTMLDivElement>
  toggleShortcut: string | null
  onToggle: () => void
  onResizeStart: (event: React.MouseEvent) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`right-panel-column${open ? '' : ' is-closed'}`} data-right-panel={open ? 'open' : 'closed'} aria-hidden={!open} inert={!open}>
      {open ? (
        <div className="right-panel-resizer" data-right-panel-resizer="" onMouseDown={onResizeStart}>
          <div className="sidebar-resizer-line" />
        </div>
      ) : null}
      <div className="right-panel" ref={panelRef}>
        <div className="right-panel-head" data-right-panel-head="">
          <span className="right-panel-title">{title}</span>
          <RightPanelToggle label="오른쪽 패널 닫기" shortcut={toggleShortcut} onToggle={onToggle} placement="head" />
        </div>
        {children}
      </div>
    </div>
  )
}
