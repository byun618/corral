// 설정 › 외관 › 창 및 사이드바 (LIFE-516 S27 · K6). Orca 198 `AppearancePane.tsx:261-275`(PanelLeft 카드) ·
// `AppearanceWindowSidebarSection.tsx:206-240`(「워크스페이스 카드 레이아웃」 세그먼트)을 옮겼다. corral 은 **카드 레이아웃 한 행**뿐이다(D8),
// Advanced 접힘 없이 카드에 바로 둔다(D7). 라벨은 사이드바 옵션 메뉴와 같은 말(「자세히」/「간단히」, `CARD_LAYOUT_OPTIONS`).
//
// **원천은 ui-prefs `sidebarCardLayout` 하나**(U8) — 이 카드는 App 의 `useSidebarView()` 하나를 받아, 메뉴와 **같은 함수**(`cardLayoutPreset`)로
// **같은 상태**(`change`)를 바꾼다. 그래서 여기서 바꾸면 사이드바 카드·메뉴 라디오가 바로 같은 값이고, 메뉴에서 바꾸면 이 세그먼트가 같은 값이다.
import { cardLayoutPreset, type SidebarCardLayout, type SidebarView } from '../../../shared/sidebar-view.js'
import { SettingsCollapsibleCard, SettingsRow, SettingsSegmented } from './SettingsControls.js'
import { CARD_LAYOUT_OPTIONS } from './SidebarOptionsMenu.js'
import { PanelLeftIcon } from './SidebarIcons.js'

const SEGMENT_OPTIONS = CARD_LAYOUT_OPTIONS.map((option) => ({ value: option.id, label: option.label }))

export function WindowSidebarCard({ view, onChange, query }: { view: SidebarView; onChange: (patch: Partial<SidebarView>) => void; query: string }): React.JSX.Element {
  const current = CARD_LAYOUT_OPTIONS.find((option) => option.id === view.cardLayout)?.label ?? ''
  return (
    <SettingsCollapsibleCard id="window-sidebar" icon={<PanelLeftIcon className="settings-icon" />} title="창 및 사이드바" summary={`카드 레이아웃 ${current}`} forceOpen={query.trim() !== ''}>
      <section className="settings-appearance-block" data-settings-block="sidebar-card-layout">
        <div className="settings-rows">
          <SettingsRow
            label="카드 레이아웃"
            description="사이드바의 워크트리 카드를 자세히 또는 간단히 표시합니다. 사이드바 옵션 메뉴의 「카드 레이아웃」 과 같은 값입니다."
            control={<SettingsSegmented<SidebarCardLayout> value={view.cardLayout} options={SEGMENT_OPTIONS} label="카드 레이아웃" onChange={(next) => onChange(cardLayoutPreset(next))} />}
          />
        </div>
      </section>
    </SettingsCollapsibleCard>
  )
}
