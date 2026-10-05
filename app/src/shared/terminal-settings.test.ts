// 설정 스키마·해석 함수 (LIFE-512 K1ⓔ·K2ⓗ·K3ⓑⓓ) — 순수 함수만 본다.
import { describe, expect, it } from 'vitest'
import { TERMINAL_THEME_CATALOG } from './terminal-themes/index.js'
import {
  DEFAULT_SETTINGS,
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEME_NAMES,
  buildFontFamily,
  cellMetricKey,
  clampSetting,
  readNumericSetting,
  readSettings,
  resolveMinimumContrastRatio,
  resolveTerminalTheme,
  sanitizeSettingsPatch,
  terminalCursorOptions,
  terminalFontOptions,
  terminalThemesEqual,
  type Settings,
} from './terminal-settings.js'

describe('내장 테마 카탈로그', () => {
  it('30개이고 기본 테마가 들어 있다', () => {
    expect(TERMINAL_THEME_NAMES).toHaveLength(30)
    expect(TERMINAL_THEME_NAMES).toContain(DEFAULT_TERMINAL_THEME)
    expect(TERMINAL_THEME_NAMES[0]).toBe('Ayu Dark') // 198 화면 순서(이름순) — 510 캡처 p1
  })

  it('테마마다 22칸(배경·전경·커서·cursorAccent·선택 2·16색)', () => {
    for (const name of TERMINAL_THEME_NAMES) expect(Object.keys(TERMINAL_THEME_CATALOG[name]!).sort()).toHaveLength(22)
  })
})

describe('resolveTerminalTheme — 순수 함수 (T3 override 자리)', () => {
  it('같은 이름이면 같은 값, 카탈로그와 분리된 복사본', () => {
    const a = resolveTerminalTheme({ themeName: 'Dracula' })
    const b = resolveTerminalTheme({ themeName: 'Dracula' })
    expect(a).toEqual(b)
    expect(a).not.toBe(TERMINAL_THEME_CATALOG['Dracula'])
    a.background = '#000000'
    expect(TERMINAL_THEME_CATALOG['Dracula']!.background).toBe('#282a36')
  })

  it('없는 이름은 기본 테마', () => {
    expect(resolveTerminalTheme({ themeName: 'Nope' })).toEqual(TERMINAL_THEME_CATALOG[DEFAULT_TERMINAL_THEME])
  })

  it('override 는 테마 위에 덮는다(T3 가 쓸 자리)', () => {
    const theme = resolveTerminalTheme({ themeName: 'Dracula', overrides: { red: '#ff0000' } })
    expect(theme.red).toBe('#ff0000')
    expect(theme.background).toBe('#282a36')
  })

  it('terminalThemesEqual — 값 비교', () => {
    expect(terminalThemesEqual({ a: resolveTerminalTheme({ themeName: 'Nord' }), b: resolveTerminalTheme({ themeName: 'Nord' }) })).toBe(true)
    expect(terminalThemesEqual({ a: resolveTerminalTheme({ themeName: 'Nord' }), b: resolveTerminalTheme({ themeName: 'Dracula' }) })).toBe(false)
    expect(terminalThemesEqual({ a: undefined, b: resolveTerminalTheme({ themeName: 'Nord' }) })).toBe(false)
  })
})

describe('범위·잘못된 입력 (K2ⓗ)', () => {
  it('clampSetting — 범위 고정·단위·숫자 아님', () => {
    expect(clampSetting({ key: 'terminalFontSize', value: 9 })).toBe(10)
    expect(clampSetting({ key: 'terminalFontSize', value: 25 })).toBe(24)
    expect(clampSetting({ key: 'terminalFontSize', value: 15.6 })).toBe(16)
    expect(clampSetting({ key: 'terminalLineHeight', value: 1.2000000000000002 })).toBe(1.2)
    expect(clampSetting({ key: 'terminalInactivePaneOpacity', value: 2 })).toBe(1)
    expect(clampSetting({ key: 'terminalDividerThicknessPx', value: 0 })).toBe(1)
    expect(clampSetting({ key: 'terminalFontSize', value: Number.NaN })).toBeNull()
    expect(clampSetting({ key: 'terminalFontSize', value: '14' })).toBeNull()
  })

  it('readNumericSetting(파일·IPC) — 범위 밖·숫자 아님은 null, 범위 안은 단위 반올림 (r1 R1-02)', () => {
    expect(readNumericSetting({ key: 'terminalFontSize', value: 99 })).toBeNull()
    expect(readNumericSetting({ key: 'terminalInactivePaneOpacity', value: -1 })).toBeNull()
    expect(readNumericSetting({ key: 'terminalDividerThicknessPx', value: 0 })).toBeNull()
    expect(readNumericSetting({ key: 'terminalFontSize', value: '14' })).toBeNull()
    expect(readNumericSetting({ key: 'terminalLineHeight', value: 1.2000000000000002 })).toBe(1.2)
    expect(readNumericSetting({ key: 'terminalFontSize', value: 24 })).toBe(24)
  })

  it('readSettings — 범위 밖 숫자는 그 칸만 기본값(극단값 고정 아님), 나머지는 생존 (K1ⓐ · r1 R1-02 재현 입력)', () => {
    expect(readSettings({ terminalFontSize: 99, terminalInactivePaneOpacity: -1, terminalDividerThicknessPx: 99, terminalThemeDark: 'Dracula' })).toEqual({ ...DEFAULT_SETTINGS, terminalThemeDark: 'Dracula' })
  })

  it('readSettings — 객체 아님은 전부 기본값, 글꼴군 공백·hex 아님은 그 칸만', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(readSettings({ terminalFontFamily: '   ', terminalDividerColorDark: 'blue', terminalFontSize: 12 })).toEqual({ ...DEFAULT_SETTINGS, terminalFontSize: 12 })
    expect(readSettings({ terminalDividerColorDark: '#ABC' }).terminalDividerColorDark).toBe('#abc')
  })

  it('sanitizeSettingsPatch — 모르는 칸·잘못된 값은 버린 칸으로', () => {
    expect(sanitizeSettingsPatch({ terminalFontSize: 16, foo: 1, terminalCursorStyle: 'beam' })).toEqual({ accepted: { terminalFontSize: 16 }, rejected: ['foo', 'terminalCursorStyle'] })
    expect(sanitizeSettingsPatch('x').accepted).toEqual({})
    expect(sanitizeSettingsPatch({ terminalFontSize: 30, terminalLineHeight: 1.5 })).toEqual({ accepted: { terminalLineHeight: 1.5 }, rejected: ['terminalFontSize'] })
  })
})

describe('글꼴·셀 열쇠 (K2ⓑⓕ)', () => {
  it('buildFontFamily — 고른 글꼴 뒤에 macOS 폴백, 중복 없이', () => {
    expect(buildFontFamily('SF Mono')).toBe('"SF Mono", "Menlo", "Monaco", monospace')
    expect(buildFontFamily('JetBrains Mono')).toBe('"JetBrains Mono", "SF Mono", "Menlo", "Monaco", monospace')
  })

  it('terminalFontOptions — 설정 그대로 xterm 옵션', () => {
    expect(terminalFontOptions(DEFAULT_SETTINGS)).toEqual({ fontSize: 14, fontFamily: '"SF Mono", "Menlo", "Monaco", monospace', fontWeight: 500, fontWeightBold: 700, lineHeight: 1 })
  })

  it('cellMetricKey — 크기·글꼴군·줄높이만 바꾸고, 굵기·테마·커서·투명도·디바이더는 바꾸지 않는다', () => {
    const base = cellMetricKey(DEFAULT_SETTINGS)
    for (const patch of [{ terminalFontSize: 16 }, { terminalFontFamily: 'Menlo' }, { terminalLineHeight: 1.2 }]) {
      expect(cellMetricKey({ ...DEFAULT_SETTINGS, ...patch })).not.toBe(base)
    }
    const nonMetric: Partial<Settings>[] = [{ terminalFontWeight: 400 }, { terminalFontWeightBold: 800 }, { terminalThemeDark: 'Dracula' }, { terminalCursorStyle: 'bar' }, { terminalCursorBlink: false }, { terminalInactivePaneOpacity: 0.5 }, { terminalDividerColorDark: '#ff0000' }, { terminalDividerThicknessPx: 8 }]
    for (const patch of nonMetric) {
      expect(cellMetricKey({ ...DEFAULT_SETTINGS, ...patch })).toBe(base)
    }
  })

  it('terminalCursorOptions — block 이면 비활성 outline, 나머지는 같은 모양', () => {
    expect(terminalCursorOptions(DEFAULT_SETTINGS)).toEqual({ cursorStyle: 'block', cursorInactiveStyle: 'outline', cursorBlink: true })
    expect(terminalCursorOptions({ ...DEFAULT_SETTINGS, terminalCursorStyle: 'bar', terminalCursorBlink: false })).toEqual({ cursorStyle: 'bar', cursorInactiveStyle: 'bar', cursorBlink: false })
  })
})

describe('대비 보정 (Orca #7934 이식)', () => {
  it('다크 배경 3 · 라이트 배경 4.5', () => {
    expect(resolveMinimumContrastRatio('#282c34')).toBe(3)
    expect(resolveMinimumContrastRatio(resolveTerminalTheme({ themeName: 'Builtin Tango Light' }).background)).toBe(4.5)
    expect(resolveMinimumContrastRatio(undefined)).toBe(3)
  })
})
