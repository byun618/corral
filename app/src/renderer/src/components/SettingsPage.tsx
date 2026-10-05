// 설정 페이지 (LIFE-511 K2·K3·K5) — 워크스페이스(사이드바·탭바·pane)를 대체하는 전체 페이지. Orca 198 `settings-page-renderer.tsx` ·
// `SettingsSidebar.tsx` · `use-settings-page-effects.ts` 의 틀을 옮겼다: 왼쪽 내비 280(돌아가기 · 검색 · 그룹 제목 · 섹션 행) +
// 오른쪽 콘텐츠(가운데 정렬 max-w 896, 한 번에 섹션 하나).
// 이 컴포넌트는 워크스페이스를 **숨기지 않는다** — App 이 워크스페이스를 크기 그대로 둔 채 그 위에 이 페이지를 덮는다(00-analysis §3 ①).
// 그래서 터미널 영역의 ResizeObserver 가 발화하지 않고 herdr 격자 요청이 나가지 않는다.
//
// 키:
//   ⌘F       검색창 포커스·전체 선택(198 `settings.search` 기본값 Mod+F — corral 레지스트리에는 넣지 않았다, 설정 페이지 안에서만 산다)
//   Esc      단축키 섹션: 첫 Esc 는 확인 창(2.2초)을 열고 그 안의 두 번째 Esc 에서만 닫는다(198 `SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS`).
//            그 밖의 섹션: 바로 닫는다. 기록 중 Esc 는 단축키 섹션이 먼저 먹는다(기록 취소).
import { useEffect, useRef, useState } from 'react'
import type { Keybindings } from '../../../shared/keybindings.js'
import { settingsNavGroups, settingsSectionById, type SettingsSectionId } from '../settings-registry.js'
import { SettingsSection } from './SettingsControls.js'
import { ShortcutsSection } from './ShortcutsSection.js'
import { ArrowLeftIcon, KeyboardIcon, SearchIcon } from './SidebarIcons.js'
import './settings.css'

export const SETTINGS_ESCAPE_CONFIRM_MS = 2200

const SECTION_ICONS: Record<SettingsSectionId, (props: { className?: string }) => React.JSX.Element> = {
  shortcuts: KeyboardIcon,
}

export function SettingsPage({ section, onSelectSection, onClose, overrides, onChangeOverrides }: {
  section: SettingsSectionId
  onSelectSection: (section: SettingsSectionId) => void
  onClose: () => void
  overrides: Keybindings
  onChangeOverrides: (value: Keybindings) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [escapeArmed, setEscapeArmed] = useState(false)
  const escapeUntil = useRef(0)
  const search = useRef<HTMLInputElement>(null)
  const latest = useRef({ section, onClose })
  latest.current = { section, onClose }

  const groups = settingsNavGroups({ query })
  const visible = groups.flatMap((group) => group.sections)
  // 검색으로 지금 섹션이 빠지면 맞는 첫 섹션을 보인다(198 `getFallbackVisibleSection`).
  const shown = visible.find((row) => row.id === section) ?? visible[0] ?? null

  useEffect(() => {
    // 들어오면 검색창이 포커스를 갖는다(198 `searchAutoFocus` — 일반 진입). 터미널의 xterm 은 이미 inert 뒤에 있다.
    search.current?.focus()
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      const { section: current, onClose: close } = latest.current
      if (current !== 'shortcuts') { close(); return }
      event.preventDefault()
      const now = Date.now()
      if (now <= escapeUntil.current) {
        escapeUntil.current = 0
        close()
        return
      }
      escapeUntil.current = now + SETTINGS_ESCAPE_CONFIRM_MS
      setEscapeArmed(true)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => setEscapeArmed(false), SETTINGS_ESCAPE_CONFIRM_MS)
    }
    const onFind = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.code !== 'KeyF') return
      event.preventDefault()
      search.current?.focus()
      search.current?.select()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('keydown', onFind, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('keydown', onFind, true)
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  return (
    <div className="settings-page" data-settings-page>
      <aside className="settings-nav" data-settings-nav aria-label="설정">
        <div className="settings-nav-top">
          <button type="button" className="settings-back" data-settings-back onClick={onClose}>
            <ArrowLeftIcon className="settings-icon" />
            앱으로 돌아가기
          </button>
        </div>
        <div className="settings-nav-search" data-settings-search-box>
          <div className="settings-search-field">
            <SearchIcon className="settings-search-icon" />
            <input ref={search} data-settings-search aria-label="설정 검색" placeholder="설정 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
            {query === '' ? <span className="settings-search-hint" aria-hidden><kbd>⌘</kbd><kbd>F</kbd></span> : null}
          </div>
        </div>
        <div className="settings-nav-scroll" data-settings-nav-scroll>
          {groups.map((group) => (
            <div key={group.id} className="settings-nav-group" data-settings-group={group.id}>
              <p className="settings-nav-group-title" data-settings-group-title>{group.title}</p>
              {group.sections.map((row) => {
                const Icon = SECTION_ICONS[row.id]
                const active = shown?.id === row.id
                return (
                  <button key={row.id} type="button" className={`settings-nav-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} data-settings-nav-item={row.id} onClick={() => onSelectSection(row.id)}>
                    <Icon className="settings-icon" />
                    <span className="settings-nav-item-title">{row.title}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </aside>
      <div className={`settings-content${shown?.id === 'shortcuts' ? ' is-fill' : ''}`} data-settings-content>
        <div className="settings-content-inner" data-settings-content-inner>
          {shown === null ? (
            <div className="settings-empty" data-settings-empty>「{query.trim()}」 에 맞는 설정이 없습니다</div>
          ) : (
            <SettingsSection id={shown.id} title={settingsSectionById(shown.id).title} description={shown.description} fill={shown.id === 'shortcuts'}>
              {shown.id === 'shortcuts' ? <ShortcutsSection overrides={overrides} onChange={onChangeOverrides} /> : null}
            </SettingsSection>
          )}
        </div>
      </div>
      {escapeArmed ? <div className="settings-escape-confirm" role="status" data-settings-escape-confirm>Esc 를 한 번 더 누르면 설정을 닫습니다</div> : null}
    </div>
  )
}
