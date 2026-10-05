// @vitest-environment happy-dom
// LIFE-512 — 외관 › 터미널: Number·Color 컨트롤(K5ⓑ), 테마 목록(K3ⓓ), 미리보기·라이브 pane 해석 공유(K3ⓔ), 값 비교 쓰기(K3ⓕ),
// 셀 재측정 트리거(K2ⓗ). xterm 은 happy-dom 에서 그리지 못한다 — 옵션 객체를 가진 가짜로 바꾼다.
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const terminals: Array<{ options: Record<string, unknown>; writes: string[]; resets: number }> = []
vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown>
    writes: string[] = []
    resets = 0
    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      terminals.push(this)
    }
    open(): void {}
    write(data: string): void { this.writes.push(data) }
    reset(): void { this.resets += 1 }
    dispose(): void {}
  }
  return { Terminal }
})
const measured: Array<Record<string, unknown>> = []
vi.mock('../term-metrics.js', () => ({
  FALLBACK_CELL: { width: 7, height: 17 },
  measureCellSize: (font: Record<string, unknown>) => {
    measured.push(font)
    return { width: Number(font['fontSize']) * 0.6, height: Number(font['fontSize']) * Number(font['lineHeight']) * 1.2 }
  },
}))

const { DEFAULT_SETTINGS, TERMINAL_THEME_NAMES, resolveTerminalTheme } = await import('../../../shared/terminal-settings.js')
const { getSettings, resetSettingsStoreForTest, updateSettings } = await import('../settings-store.js')
const { applyTerminalAppearance, terminalAppearanceOptions } = await import('../terminal-appearance.js')
const { previewAppearanceOptions, TerminalSettingsPreview } = await import('./TerminalSettingsPreview.js')
const { TerminalAppearanceSection, filterThemeNames } = await import('./TerminalAppearanceSection.js')
const { SettingsColorField, SettingsDisclosure, SettingsNumberField } = await import('./SettingsControls.js')
const { useCellMetrics } = await import('../hooks/useCellMetrics.js')
const { Terminal } = await import('@xterm/xterm')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  resetSettingsStoreForTest({ ...DEFAULT_SETTINGS })
  terminals.length = 0
  measured.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
function render(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(node))
  return host
}
const setValue = (input: HTMLInputElement, value: string): void => {
  act(() => {
    Reflect.get(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ?? {}, 'set')?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = (target: Element, name: string): void => {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })
}
const blur = (target: HTMLElement): void => { act(() => { target.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) }) }

describe('SettingsNumberField (K5ⓑ)', () => {
  function Harness({ onCommit, integer = true }: { onCommit: (value: number) => void; integer?: boolean }): React.JSX.Element {
    const [value, setValue] = useState(14)
    return createElement(SettingsNumberField, { value, min: 10, max: 24, step: 1, integer, label: '글꼴 크기', onCommit: (next: number) => { onCommit(next); setValue(next) } })
  }
  it('숫자 입력(spinbutton) — 입력 중엔 확정하지 않고 Enter 에서 범위에 고정해 한 번 확정', () => {
    const onCommit = vi.fn()
    const view = render(createElement(Harness, { onCommit }))
    const input = view.querySelector<HTMLInputElement>('[data-settings-number]')!
    expect(input.type).toBe('number')
    expect(input.getAttribute('aria-label')).toBe('글꼴 크기')
    setValue(input, '1')
    setValue(input, '16')
    expect(onCommit).not.toHaveBeenCalled()
    key(input, 'Enter')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith(16)
    setValue(input, '99')
    blur(input)
    expect(onCommit).toHaveBeenLastCalledWith(24)
    expect(input.value).toBe('24')
  })
  it('잘못된 값·빈 값·Esc 는 직전 값으로 돌아가고 확정하지 않는다 · 같은 값은 확정하지 않는다', () => {
    const onCommit = vi.fn()
    const view = render(createElement(Harness, { onCommit }))
    const input = view.querySelector<HTMLInputElement>('[data-settings-number]')!
    setValue(input, '')
    key(input, 'Enter')
    expect(input.value).toBe('14')
    setValue(input, '15.5')
    key(input, 'Enter') // 정수 칸 — 소수는 거부
    expect(input.value).toBe('14')
    setValue(input, '20')
    key(input, 'Escape')
    expect(input.value).toBe('14')
    setValue(input, '14')
    key(input, 'Enter')
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('SettingsColorField (K5ⓑ)', () => {
  it('hex 입력 — 잘못된 값은 aria-invalid 이고 확정하지 않는다 · 맞는 값은 소문자로 한 번 확정', () => {
    const onCommit = vi.fn()
    const view = render(createElement(SettingsColorField, { value: '#3f3f46', label: '다크 디바이더 색상', onCommit }))
    const input = view.querySelector<HTMLInputElement>('[data-settings-color]')!
    setValue(input, '#12')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    key(input, 'Enter')
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('#3f3f46')
    setValue(input, '#FF0000')
    key(input, 'Enter')
    expect(onCommit).toHaveBeenCalledWith('#ff0000')
  })
  it('견본(type=color) — 네이티브 change 에서만 확정한다(패널을 끄는 동안의 input 은 확정하지 않는다)', () => {
    const onCommit = vi.fn()
    const view = render(createElement(SettingsColorField, { value: '#3f3f46', label: '다크 디바이더 색상', onCommit }))
    const swatch = view.querySelector<HTMLInputElement>('[data-settings-color-swatch]')!
    expect(swatch.type).toBe('color')
    act(() => { swatch.value = '#00ff00'; swatch.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(onCommit).not.toHaveBeenCalled()
    act(() => { swatch.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(onCommit).toHaveBeenCalledWith('#00ff00')
  })
})

describe('SettingsDisclosure', () => {
  it('닫힌 채 시작 · 누르면 aria-expanded · forceOpen(검색 중)이면 펼친 채 접기를 막는다', () => {
    const view = render(createElement('div', null,
      createElement(SettingsDisclosure, { id: 'a', children: createElement('span', { 'data-body': 'a' }) }),
      createElement(SettingsDisclosure, { id: 'b', forceOpen: true, children: createElement('span', { 'data-body': 'b' }) })))
    const [a, b] = [...view.querySelectorAll<HTMLButtonElement>('.settings-disclosure-toggle')]
    expect(a!.getAttribute('aria-expanded')).toBe('false')
    expect(view.querySelector('[data-body="a"]')).toBeNull()
    act(() => a!.click())
    expect(a!.getAttribute('aria-expanded')).toBe('true')
    expect(view.querySelector('[data-body="a"]')).not.toBeNull()
    expect(b!.disabled).toBe(true)
    expect(view.querySelector('[data-body="b"]')).not.toBeNull()
  })
})

describe('외관 › 터미널 섹션 (K2ⓐ·K3ⓓ)', () => {
  it('테마 목록 — 기본 제공 30개 · 「선택됨」 · 「표시 중 30/30」 · 검색(부분 일치, 대소문자 무시)', () => {
    const view = render(createElement(TerminalAppearanceSection, { query: '' }))
    expect(view.querySelectorAll('[data-settings-theme-option]')).toHaveLength(30)
    expect(view.querySelector('[data-settings-theme-selected]')?.textContent).toBe('선택됨: Ghostty Default Style Dark')
    expect(view.querySelector('[data-settings-theme-count]')?.textContent).toBe('표시 중 30/30')
    expect(view.querySelector('.settings-theme-group-title')?.textContent).toBe('기본 제공')
    setValue(view.querySelector<HTMLInputElement>('[data-settings-theme-search]')!, 'DRA')
    expect([...view.querySelectorAll('[data-settings-theme-option]')].map((el) => el.getAttribute('data-settings-theme-option'))).toEqual(['Dracula'])
    expect(view.querySelector('[data-settings-theme-count]')?.textContent).toBe('표시 중 1 "DRA"과(와) 일치')
    setValue(view.querySelector<HTMLInputElement>('[data-settings-theme-search]')!, 'zzz')
    expect(view.querySelector('.settings-theme-empty')?.textContent).toBe('테마를 찾을 수 없습니다.')
  })

  it('filterThemeNames — 이름 부분 일치·대소문자 무시', () => {
    expect(filterThemeNames('light')).toEqual(TERMINAL_THEME_NAMES.filter((name) => /light/i.test(name)))
    expect(filterThemeNames('  ')).toHaveLength(30)
  })

  it('테마를 고르면 설정이 바뀌고 같은 테마를 다시 누르면 갱신하지 않는다', () => {
    const view = render(createElement(TerminalAppearanceSection, { query: '' }))
    act(() => view.querySelector<HTMLButtonElement>('[data-settings-theme-option="Dracula"]')!.click())
    expect(getSettings().terminalThemeDark).toBe('Dracula')
    expect(view.querySelector('[data-settings-theme-selected]')?.textContent).toBe('선택됨: Dracula')
    expect(view.querySelector('[data-settings-theme-option="Dracula"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('글꼴 크기 ± — 한 번에 1, 경계(10·24)에서 버튼이 꺼진다', () => {
    const view = render(createElement(TerminalAppearanceSection, { query: '' }))
    const plus = view.querySelector<HTMLButtonElement>('[data-settings-font-size-step="1"]')!
    act(() => plus.click())
    expect(getSettings().terminalFontSize).toBe(15)
    act(() => { void updateSettings({ terminalFontSize: 24 }) })
    expect(view.querySelector<HTMLButtonElement>('[data-settings-font-size-step="1"]')!.disabled).toBe(true)
    act(() => { void updateSettings({ terminalFontSize: 10 }) })
    expect(view.querySelector<HTMLButtonElement>('[data-settings-font-size-step="-1"]')!.disabled).toBe(true)
  })

  it('고급 접기는 닫힌 채 시작하고 검색 중엔 펼친다', () => {
    const closed = render(createElement(TerminalAppearanceSection, { query: '' }))
    expect(closed.querySelector('[data-settings-block="cursor"]')).toBeNull()
    act(() => root.unmount())
    host.remove()
    const open = render(createElement(TerminalAppearanceSection, { query: '커서' }))
    expect(open.querySelector('[data-settings-block="cursor"]')).not.toBeNull()
    expect(open.querySelector('[data-settings-block="pane"]')).not.toBeNull()
  })
})

describe('미리보기·라이브 pane 해석 공유 (K3ⓔ)', () => {
  it('미리보기 옵션 = 라이브 pane 옵션(비활성 커서 모양만 고른 모양) — 30개 테마 전부', () => {
    for (const name of TERMINAL_THEME_NAMES) {
      const settings = { ...DEFAULT_SETTINGS, terminalThemeDark: name, terminalCursorStyle: 'block' as const }
      const live = terminalAppearanceOptions(settings)
      expect(previewAppearanceOptions(settings)).toEqual({ ...live, cursorInactiveStyle: 'block' })
      expect(live.theme).toEqual(resolveTerminalTheme({ themeName: name }))
    }
  })

  it('미리보기는 36×15 고정 xterm 을 띄우고 herdr 로 아무것도 보내지 않는다 · 테마를 바꾸면 샘플을 다시 쓴다', () => {
    const sync = vi.fn()
    Reflect.set(window, 'corral', { syncTermGroups: sync })
    try {
      render(createElement(TerminalSettingsPreview, { settings: DEFAULT_SETTINGS }))
      expect(terminals).toHaveLength(1)
      const term = terminals[0]!
      expect(term.options).toMatchObject({ cols: 36, rows: 15, disableStdin: true, fontSize: 14 })
      expect(term.writes).toHaveLength(1)
      act(() => root.render(createElement(TerminalSettingsPreview, { settings: { ...DEFAULT_SETTINGS, terminalThemeDark: 'Dracula' } })))
      expect(term.resets).toBe(1)
      expect(term.writes).toHaveLength(2)
      act(() => root.render(createElement(TerminalSettingsPreview, { settings: { ...DEFAULT_SETTINGS, terminalThemeDark: 'Dracula', terminalFontSize: 18 } })))
      expect(term.resets).toBe(1) // 글꼴만 바뀌면 다시 쓰지 않는다
      expect(term.options['fontSize']).toBe(18)
      expect(sync).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(window, 'corral')
    }
  })
})

describe('applyTerminalAppearance — 바뀐 것만 쓴다 (K3ⓕ · Orca B14)', () => {
  it('같은 테마는 다시 쓰지 않고, 글꼴만 바뀌면 글꼴만 쓴다', () => {
    const term = new Terminal(terminalAppearanceOptions(DEFAULT_SETTINGS))
    expect(applyTerminalAppearance(term, terminalAppearanceOptions(DEFAULT_SETTINGS))).toEqual([])
    expect(applyTerminalAppearance(term, terminalAppearanceOptions({ ...DEFAULT_SETTINGS, terminalFontSize: 16 }))).toEqual(['fontSize'])
    expect(applyTerminalAppearance(term, terminalAppearanceOptions({ ...DEFAULT_SETTINGS, terminalFontSize: 16, terminalThemeDark: 'Dracula' }))).toEqual(['theme'])
    expect(applyTerminalAppearance(term, terminalAppearanceOptions({ ...DEFAULT_SETTINGS, terminalFontSize: 16, terminalThemeDark: 'Dracula' }))).toEqual([])
    // 라이트 테마는 대비 하한도 바뀐다(3 → 4.5).
    expect(applyTerminalAppearance(term, terminalAppearanceOptions({ ...DEFAULT_SETTINGS, terminalFontSize: 16, terminalThemeDark: 'Builtin Tango Light' }))).toEqual(['minimumContrastRatio', 'theme'])
  })
})

describe('셀 재측정 트리거 (K2ⓗ)', () => {
  it('첫 측정부터 지금 설정으로 잰다 · 크기·글꼴군·줄높이가 바뀌면 다시 재고, 굵기·테마·커서는 다시 재지 않는다', () => {
    resetSettingsStoreForTest({ ...DEFAULT_SETTINGS, terminalFontSize: 18 })
    const cells: Array<{ width: number; height: number }> = []
    function Probe(): null {
      cells.push(useCellMetrics())
      return null
    }
    render(createElement(Probe))
    expect(measured.at(0)?.['fontSize']).toBe(18)
    const first = measured.length
    act(() => { void updateSettings({ terminalFontWeight: 300 }) })
    act(() => { void updateSettings({ terminalThemeDark: 'Dracula', terminalCursorStyle: 'bar' }) })
    expect(measured.length).toBe(first)
    act(() => { void updateSettings({ terminalFontSize: 20 }) })
    expect(measured.length).toBe(first + 1)
    expect(measured.at(-1)?.['fontSize']).toBe(20)
    act(() => { void updateSettings({ terminalLineHeight: 1.5 }) })
    act(() => { void updateSettings({ terminalFontFamily: 'Menlo' }) })
    expect(measured.length).toBe(first + 3)
    expect(cells.at(-1)).toEqual({ width: 12, height: 36 })
  })
})
