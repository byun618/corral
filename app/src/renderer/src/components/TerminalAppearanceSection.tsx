// 설정 › 외관 › 터미널 (LIFE-512 K2ⓐ·K3ⓓ·K4·K5) — Orca 198 `AppearancePane.tsx`(터미널 카드) · `TerminalAppearanceSection.tsx` ·
// `TerminalFontSizeSetting.tsx` · `TerminalAdvancedTypographyControls.tsx` · `TerminalThemeSections.tsx`(다크) · `TerminalThemePicker.tsx` ·
// `TerminalCursorAppearanceSection.tsx` · `TerminalPaneAppearanceSection.tsx` 의 배치를 옮겼다. 문구는 198 ko 로케일 그대로.
//
// 198 과 다른 점(사유는 RESULT 표): 테마 모드(다크/라이트) 세그먼트·「다크 모드와 일치」 없음(S19 라이트 분리 의도적) · Ghostty·Warp·YAML
// 가져오기 버튼 없음(Ghostty 는 T3, Warp·YAML 은 S22 의도적) · 리거처·커서 불투명도 없음(00-analysis §9 의도적) · 글꼴군은 자유 입력 +
// 198 제안 5개(시스템 글꼴 열거 없음) · 인터페이스·창 및 사이드바 카드 없음(그 설정이 corral 에 없다 — S30 의도적).
//
// 모든 값은 **확정 순간에만** 저장소로 간다(숫자 Enter/blur · ± 한 번 · 테마 한 번 클릭) — `settings-store.updateSettings`.
import { useState } from 'react'
import {
  DEFAULT_SETTINGS,
  SETTINGS_RANGES,
  TERMINAL_FONT_SUGGESTIONS,
  TERMINAL_THEME_NAMES,
  readSettingField,
  type Settings,
  type TerminalCursorStyle,
} from '../../../shared/terminal-settings.js'
import { updateSettings, useSettings } from '../settings-store.js'
import {
  SettingsCollapsibleCard,
  SettingsColorField,
  SettingsDisclosure,
  SettingsNumberField,
  SettingsRow,
  SettingsSegmented,
  SettingsSubsectionHeader,
  SettingsSwitch,
} from './SettingsControls.js'
import { MinusIcon, PlusIcon, TerminalSquareIcon } from './SidebarIcons.js'
import { TerminalSettingsPreview } from './TerminalSettingsPreview.js'

/** 확정 → 저장. 저장됐는지를 돌려준다 — 입력 칸이 실패 때 초안을 저장값으로 돌린다(r1 R1-03). */
const commit = (patch: Partial<Settings>): Promise<boolean> => updateSettings(patch)

function DefaultHint({ value }: { value: string | number }): React.JSX.Element {
  return <span className="settings-default-hint">· 기본: {value}</span>
}

/** 글꼴 크기 — − · 숫자 · + · px (198 `TerminalFontSizeSetting`). 경계에서 버튼을 끈다. */
function FontSizeControl({ value }: { value: number }): React.JSX.Element {
  const range = SETTINGS_RANGES.terminalFontSize
  return (
    <div className="settings-stepper" data-settings-font-size>
      <button type="button" className="settings-icon-button" data-settings-font-size-step="-1" aria-label="글꼴 크기 줄이기" disabled={value <= range.min} onClick={() => void commit({ terminalFontSize: Math.max(range.min, value - 1) })}>
        <MinusIcon className="settings-icon-xs" />
      </button>
      <SettingsNumberField value={value} min={range.min} max={range.max} step={range.step} integer field="font-size" label="글꼴 크기" width="sm" onCommit={(next) => commit({ terminalFontSize: next })} />
      <button type="button" className="settings-icon-button" data-settings-font-size-step="1" aria-label="글꼴 크기 키우기" disabled={value >= range.max} onClick={() => void commit({ terminalFontSize: Math.min(range.max, value + 1) })}>
        <PlusIcon className="settings-icon-xs" />
      </button>
      <span className="settings-suffix">px</span>
    </div>
  )
}

/** 글꼴군 — 자유 입력 + 198 제안(datalist). Enter·blur 에 확정, 빈 값·Esc 는 직전 값. */
function FontFamilyControl({ value }: { value: string }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setDraft(value)
  }
  const confirm = (): void => {
    // 저장소와 같은 검증(readSettingField — 빈 값·200자 초과 거부)을 먼저 본다. 못 넘으면 저장값으로 돌린다 — 저장소는 그 칸을 버리고
    // `unchanged` 를 돌려주므로 저장 결과만 보고는 초안이 남는다(r3 R3-01).
    const next = readSettingField({ key: 'terminalFontFamily', value: draft.trim() })
    if (next === null) { setDraft(value); return }
    setDraft(next)
    if (next !== value) void commit({ terminalFontFamily: next }).then((saved) => { if (!saved) setDraft(value) })
  }
  return (
    <>
      <input
        className="settings-input settings-font-input"
        data-settings-font-family
        aria-label="글꼴군"
        list="settings-font-suggestions"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={confirm}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); confirm() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(value) }
        }}
      />
      <datalist id="settings-font-suggestions">
        {TERMINAL_FONT_SUGGESTIONS.map((font) => <option key={font} value={font} />)}
      </datalist>
    </>
  )
}

/** 테마 목록 — 검색(이름 부분 일치, 대소문자 무시) · 「선택됨」 · 「표시 중 N/M」 · 기본 제공 그룹(198 `TerminalThemePicker`). */
export function filterThemeNames({ query, names = TERMINAL_THEME_NAMES }: { query: string; names?: readonly string[] }): string[] {
  const normalized = query.trim().toLowerCase()
  return normalized === '' ? [...names] : names.filter((name) => name.toLowerCase().includes(normalized))
}

function ThemePicker({ selected }: { selected: string }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const matching = filterThemeNames({ query })
  const trimmed = query.trim()
  return (
    <div className="settings-theme-picker" data-settings-theme-picker>
      <div className="settings-theme-heading">
        <div className="settings-row-label">어두운 테마</div>
        <p className="settings-row-description">다크 모드에서 사용되는 terminal 테마를 선택하세요.</p>
      </div>
      <input className="settings-input settings-theme-search" data-settings-theme-search aria-label="terminal 테마 검색" placeholder="terminal 테마 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="settings-theme-list">
        <div className="settings-theme-status">
          <span data-settings-theme-selected>선택됨: {selected}</span>
          <span data-settings-theme-count>표시 중 {matching.length}{trimmed === '' ? `/${TERMINAL_THEME_NAMES.length}` : ` "${trimmed}"과(와) 일치`}</span>
        </div>
        <div className="settings-theme-scroll">
          {matching.length === 0 ? (
            <div className="settings-theme-empty">테마를 찾을 수 없습니다.</div>
          ) : (
            <div className="settings-theme-group">
              <p className="settings-theme-group-title">기본 제공</p>
              {matching.map((name) => (
                <button key={name} type="button" className={`settings-theme-option${name === selected ? ' is-selected' : ''}`} aria-pressed={name === selected} data-settings-theme-option={name} onClick={() => { if (name !== selected) void commit({ terminalThemeDark: name }) }}>
                  <span className="settings-theme-name">{name}</span>
                  {name === selected ? <span className="settings-theme-current">현재</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const CURSOR_OPTIONS: readonly { value: TerminalCursorStyle; label: string }[] = [
  { value: 'bar', label: '막대' },
  { value: 'block', label: '블록' },
  { value: 'underline', label: '밑줄' },
]

export function TerminalAppearanceSection({ query }: { query: string }): React.JSX.Element {
  const settings = useSettings()
  const searching = query.trim() !== ''
  const ranges = SETTINGS_RANGES
  return (
    <SettingsCollapsibleCard id="terminal" icon={<TerminalSquareIcon className="settings-icon" />} title="터미널" summary={`${settings.terminalFontFamily} · ${settings.terminalFontSize}px`} forceOpen={searching}>
      <section className="settings-appearance-block" data-settings-block="typography">
        <SettingsSubsectionHeader title="Terminal 타이포그래피" />
        <div className="settings-indent settings-rows">
          <SettingsRow label="글꼴 크기" control={<FontSizeControl value={settings.terminalFontSize} />} />
          <SettingsRow label="글꼴군" control={<FontFamilyControl value={settings.terminalFontFamily} />} />
        </div>
        <div className="settings-indent">
          <SettingsDisclosure id="typography" forceOpen={searching}>
            <div className="settings-indent settings-rows">
              <SettingsRow
                label="글꼴 두께"
                description={<>terminal 텍스트 글꼴 두께를 제어합니다. <DefaultHint value={DEFAULT_SETTINGS.terminalFontWeight} /></>}
                control={<SettingsNumberField value={settings.terminalFontWeight} {...ranges.terminalFontWeight} field="font-weight" label="글꼴 두께" suffix="100-900" onCommit={(next) => commit({ terminalFontWeight: next })} />}
              />
              <SettingsRow
                label="Bold Font Weight"
                description={<>Font Weight 와 따로 조정합니다. 굵게가 그대로면 Font Weight 를 낮추거나 다른 글꼴을 고르세요. <DefaultHint value={DEFAULT_SETTINGS.terminalFontWeightBold} /></>}
                control={<SettingsNumberField value={settings.terminalFontWeightBold} {...ranges.terminalFontWeightBold} field="font-weight-bold" label="Bold Font Weight" suffix="100-900" onCommit={(next) => commit({ terminalFontWeightBold: next })} />}
              />
              <SettingsRow
                label="라인 높이"
                description={<>terminal 라인 높이 승수를 제어합니다. <DefaultHint value={DEFAULT_SETTINGS.terminalLineHeight} /></>}
                control={<SettingsNumberField value={settings.terminalLineHeight} {...ranges.terminalLineHeight} field="line-height" label="라인 높이" suffix="1-3" onCommit={(next) => commit({ terminalLineHeight: next })} />}
              />
            </div>
          </SettingsDisclosure>
        </div>
      </section>

      <section className="settings-appearance-block" data-settings-block="theme">
        <SettingsSubsectionHeader title="터미널 테마" />
        <div className="settings-indent settings-theme-stack">
          <ThemePicker selected={settings.terminalThemeDark} />
          <SettingsRow
            label="다크 디바이더 색상"
            description="어두운 모드에서 창 사이의 분할 구분선을 제어합니다."
            control={<SettingsColorField value={settings.terminalDividerColorDark} field="divider-color" label="다크 디바이더 색상" onCommit={(next) => commit({ terminalDividerColorDark: next })} />}
          />
          <SettingsDisclosure id="advanced" forceOpen={searching}>
            <div className="settings-indent">
              <section className="settings-appearance-group" data-settings-block="cursor">
                <SettingsSubsectionHeader title="Terminal 커서" />
                <div className="settings-indent settings-rows">
                  <SettingsRow label="Cursor 모양" control={<SettingsSegmented value={settings.terminalCursorStyle} options={CURSOR_OPTIONS} label="Cursor 모양" onChange={(next) => void commit({ terminalCursorStyle: next })} />} />
                  <SettingsRow label="깜박이는 Cursor" description="선택한 커서 모양의 깜박이는 변형을 사용합니다." control={<SettingsSwitch checked={settings.terminalCursorBlink} label="깜박이는 Cursor" onChange={(next) => void commit({ terminalCursorBlink: next })} />} />
                </div>
              </section>
              <section className="settings-appearance-group" data-settings-block="pane">
                <SettingsSubsectionHeader title="Terminal 패널" />
                <div className="settings-indent settings-rows">
                  <SettingsRow
                    label="비활성 창 불투명도"
                    description={<>포커스되지 않은 창을 흐리게 표시합니다. <DefaultHint value={DEFAULT_SETTINGS.terminalInactivePaneOpacity} /></>}
                    control={<SettingsNumberField value={settings.terminalInactivePaneOpacity} {...ranges.terminalInactivePaneOpacity} field="inactive-pane-opacity" label="비활성 창 불투명도" suffix="0-1" onCommit={(next) => commit({ terminalInactivePaneOpacity: next })} />}
                  />
                  <SettingsRow
                    label="구분선 두께"
                    description={<><DefaultHint value={DEFAULT_SETTINGS.terminalDividerThicknessPx} /></>}
                    control={<SettingsNumberField value={settings.terminalDividerThicknessPx} {...ranges.terminalDividerThicknessPx} field="divider-thickness" label="구분선 두께" suffix="px" onCommit={(next) => commit({ terminalDividerThicknessPx: next })} />}
                  />
                </div>
              </section>
            </div>
          </SettingsDisclosure>
          <TerminalSettingsPreview settings={settings} />
        </div>
      </section>
    </SettingsCollapsibleCard>
  )
}
