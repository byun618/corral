// 오른쪽 패널 (LIFE-589 F1 · E1 · LIFE-682) — 머리는 Orca top 모드 activity bar(`right-sidebar-top-activity-bar.tsx`): 36px 줄에 보기 아이콘 단추
// (36×36 · 아이콘 16 · 활성 = 아래 2px 막대) + 오른쪽 끝 PanelRight 닫기. top 모드라 제목 글자는 없다. 보기 목록은 `right-panel-views.tsx` 한 곳.
// 왼쪽 가장자리 리사이저는 지금 보기의 폭을 바꾼다(보기별 폭, A3).
//
// **닫아도 마운트를 유지한다**(LIFE-589 E1ⓔ — Orca 는 언마운트하지만 corral 결정을 따른다). 보기를 바꿔도 각 보기 몸통은 마운트를 유지하고
// 안 보이는 쪽은 `hidden` — 탐색기의 펼침·선택·스크롤 상태가 사라지지 않는다(A11).
// 머리 단추 이름은 DOM 툴팁(`Tooltip` — Orca `TooltipContent side="bottom" sideOffset=6`)으로 띄운다. native `title` 은 쓰지 않는다(LIFE-755 — 실제 앱에서 안 떴다).
// 닫혀 있으면 여는 버튼은 오른쪽 위 영역 탭 줄 끝(Orca `TitlebarMainStrip` 의 `RightSidebarToggle` 자리)·작업 페이지 머리 끝에 선다 — App 이 그 자리에 넘긴다.
import type { Ref } from 'react'
import type { RightPanelView } from '../../../shared/types.js'
import { PanelRightIcon } from './SidebarIcons.js'
import { RIGHT_PANEL_VIEWS, viewLabel } from './right-panel-views.js'
import { Tooltip } from './Tooltip.js'

export function RightPanelToggle({ label, shortcut, onToggle, placement }: { label: string; shortcut: string | null; onToggle: () => void; placement: 'tabbar' | 'head' | 'tasks' }): React.JSX.Element {
  return (
    <Tooltip
      label={shortcut === null ? label : `${label} (${shortcut})`}
      render={(trigger) => (
        <button {...trigger} type="button" className={`right-panel-toggle is-${placement}`} data-right-panel-toggle={placement} aria-label={label} onClick={onToggle}>
          <PanelRightIcon className="sidebar-head-toggle-icon" />
        </button>
      )}
    />
  )
}

export function RightPanel({
  open,
  view,
  shortcutOf,
  onSelectView,
  panelRef,
  toggleShortcut,
  onToggle,
  onResizeStart,
  bodies,
}: {
  open: boolean
  view: RightPanelView
  /** 보기 단추 툴팁의 단축키 — 설정에서 바꾼 키를 따른다. 없으면 null. */
  shortcutOf: (view: RightPanelView) => string | null
  onSelectView: (view: RightPanelView) => void
  panelRef: Ref<HTMLDivElement>
  toggleShortcut: string | null
  onToggle: () => void
  onResizeStart: (event: React.MouseEvent) => void
  bodies: Record<RightPanelView, React.ReactNode>
}): React.JSX.Element {
  return (
    <div className={`right-panel-column${open ? '' : ' is-closed'}`} data-right-panel={open ? 'open' : 'closed'} data-right-panel-view={view} aria-hidden={!open} inert={!open}>
      {open ? (
        <div className="right-panel-resizer" data-right-panel-resizer="" onMouseDown={onResizeStart}>
          <div className="sidebar-resizer-line" />
        </div>
      ) : null}
      <div className="right-panel" ref={panelRef}>
        <div className="right-panel-head" data-right-panel-head="">
          <div className="right-panel-activity" data-right-panel-activity="" role="toolbar" aria-label="오른쪽 패널 보기">
            {RIGHT_PANEL_VIEWS.map((entry) => {
              const label = viewLabel({ title: entry.title, shortcut: shortcutOf(entry.id) })
              const active = entry.id === view
              const Icon = entry.icon
              return (
                <Tooltip
                  key={entry.id}
                  label={label}
                  render={(trigger) => (
                    <button
                      {...trigger}
                      type="button"
                      className={`right-panel-activity-btn${active ? ' is-active' : ''}`}
                      data-right-panel-view-btn={entry.id}
                      aria-pressed={active}
                      aria-label={label}
                      onClick={() => onSelectView(entry.id)}
                    >
                      <Icon className="right-panel-activity-icon" />
                      {active ? <span className="right-panel-activity-bar" aria-hidden /> : null}
                    </button>
                  )}
                />
              )
            })}
          </div>
          <RightPanelToggle label="오른쪽 패널 닫기" shortcut={toggleShortcut} onToggle={onToggle} placement="head" />
        </div>
        {RIGHT_PANEL_VIEWS.map((entry) => (
          <div key={entry.id} className="right-panel-body" data-right-panel-body={entry.id} hidden={entry.id !== view}>
            {bodies[entry.id]}
          </div>
        ))}
      </div>
    </div>
  )
}
