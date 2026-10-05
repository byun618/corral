// 사용자 설정 — 터미널 외관 (LIFE-512 S11·S17·S18·S20). main 저장소(`main/settings.ts`)·렌더러(라이브 pane·미리보기·설정 화면)가
// 이 파일 **하나**를 본다: 칸 이름·기본값·범위·칸별 읽기 규칙·테마/글꼴 해석. 둘 중 한쪽에만 규칙이 있으면 두 진실이 생긴다.
//
// 기본값은 Orca v1.4.198 `shared/default-global-settings.ts`·`shared/constants.ts:37·76`·`shared/terminal-fonts.ts` 그대로
// (00-analysis B5·B6·B7, c4 §3). 칸 이름도 Orca 와 같게 둔다 — T3(LIFE-513) 가 Ghostty 가져오기를 옮길 때 대응표가 필요 없다.
//
// **ui-prefs.json 과 칸이 겹치지 않는다**(U8) — 이 파일은 사용자가 고른 값, ui-prefs 는 화면 상태(폭·접힘·순서·핀). 겹치지 않음은
// `main/settings.test.ts` 가 두 기본값의 키 교집합 0 으로 지킨다.
//
// **색 override**(LIFE-513 K7): `terminalColorOverrides` 는 Ghostty 가져오기가 만든 색 칸이다. `resolveTerminalTheme` 의 `overrides` 로 넘겨
// 테마 위에 덮는다(Orca `composeActiveTerminalTheme` ②). 패치의 이 칸은 **통째로 바꾼다** — 빈 객체 `{}` 가 비움이다(Orca 의 `undefined`
// 대신 — JSON 파일·IPC 에서 사라지지 않는 표현). 「테마를 고르면 override 를 지운다」(510 F12·Orca #22069)는 테마 선택 쓰기에 `{}` 를 싣는다.
import type { ITheme } from '@xterm/xterm'
import { TERMINAL_THEME_CATALOG } from './terminal-themes/index.js'
import { isRecord } from './json.js'

export const SETTINGS_VERSION = 1

export type TerminalCursorStyle = 'block' | 'bar' | 'underline'

export type Settings = {
  terminalFontSize: number
  terminalFontFamily: string
  terminalFontWeight: number
  terminalFontWeightBold: number
  terminalLineHeight: number
  /** 내장 테마 이름. 없는 이름이면 읽을 때 기본 테마로 떨어진다. Orca 의 다크 칸 이름 그대로(라이트 분리는 의도적 — S19). */
  terminalThemeDark: string
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorBlink: boolean
  terminalInactivePaneOpacity: number
  terminalDividerColorDark: string
  terminalDividerThicknessPx: number
  /** 테마 위에 덮는 색(Ghostty 가져오기, LIFE-513). 빈 객체 = 없음. 키는 `TERMINAL_COLOR_OVERRIDE_KEYS`, 값은 소문자 hex. */
  terminalColorOverrides: TerminalColorOverrides
}

export const DEFAULT_TERMINAL_THEME = 'Ghostty Default Style Dark'

/**
 * 부분 갱신 결과(main → 렌더러). `failed` 면 디스크에 쓰지 못한 것이다 — main 메모리도 바꾸지 않았고 `settings` 는 **저장된 값**이다.
 * 렌더러는 그 값으로 되돌린다(r1 R1-03: 예전에는 실패를 성공으로 돌려주고 같은 값 재시도를 「안 바뀜」 으로 버렸다).
 */
export type SettingsWriteResult =
  /** 디스크에 썼고 main 메모리를 확정했다 — main 이 푸시한다. */
  | { status: 'saved'; settings: Settings }
  /** 바뀐 칸이 없어 쓰지 않았다. */
  | { status: 'unchanged'; settings: Settings }
  /** 못 썼다 — `settings` 는 저장된 값, `error` 는 쓰기 예외(r2 R2-03: 상태별 union). */
  | { status: 'failed'; settings: Settings; error: string }

export const DEFAULT_SETTINGS: Settings = {
  terminalFontSize: 14,
  terminalFontFamily: 'SF Mono',
  terminalFontWeight: 500,
  terminalFontWeightBold: 700,
  terminalLineHeight: 1,
  terminalThemeDark: DEFAULT_TERMINAL_THEME,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalInactivePaneOpacity: 0.9,
  terminalDividerColorDark: '#3f3f46',
  terminalDividerThicknessPx: 3,
  terminalColorOverrides: {},
}

export type NumericSettingKey =
  | 'terminalFontSize'
  | 'terminalFontWeight'
  | 'terminalFontWeightBold'
  | 'terminalLineHeight'
  | 'terminalInactivePaneOpacity'
  | 'terminalDividerThicknessPx'
export type SettingRange = { min: number; max: number; step: number; integer: boolean }

/** 숫자 칸의 범위·단위 — 설정 화면(NumberField·± 버튼)과 저장소 검증이 같은 표를 본다. */
export const SETTINGS_RANGES: Record<NumericSettingKey, SettingRange> = {
  terminalFontSize: { min: 10, max: 24, step: 1, integer: true },
  terminalFontWeight: { min: 100, max: 900, step: 100, integer: true },
  terminalFontWeightBold: { min: 100, max: 900, step: 100, integer: true },
  terminalLineHeight: { min: 1, max: 3, step: 0.1, integer: false },
  terminalInactivePaneOpacity: { min: 0, max: 1, step: 0.05, integer: false },
  terminalDividerThicknessPx: { min: 1, max: 32, step: 1, integer: true },
}

/** 활성 pane 투명도·전환 시간 — Orca 도 화면에 노출하지 않는 값이다(`terminalActivePaneOpacity` 1 · 140ms). 상수로 둔다. */
export const ACTIVE_PANE_OPACITY = 1
export const PANE_OPACITY_TRANSITION_MS = 140

/** 글꼴군 제안 — Orca 198 `main/system-fonts.ts:140` 의 macOS 후보 목록 그대로(B7). 시스템 글꼴 열거는 하지 않는다(00-analysis §9). */
export const TERMINAL_FONT_SUGGESTIONS: readonly string[] = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code']

export const TERMINAL_THEME_NAMES: readonly string[] = Object.keys(TERMINAL_THEME_CATALOG).sort()

const CURSOR_STYLES: readonly TerminalCursorStyle[] = ['block', 'bar', 'underline']
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

/** 단위 반올림 — 0.1·0.05 단위의 부동소수 꼬리(1.2000000000000002)를 남기지 않는다(파일·화면이 같은 글자를 보게). */
function roundToUnit({ range, value }: { range: SettingRange; value: number }): number {
  return range.integer ? Math.round(value) : Math.round(value * 1000) / 1000
}

/**
 * **화면 입력**(± 버튼·숫자 입력 확정)용 — 범위 밖이면 끝값에 고정한다(K2ⓐ·K5ⓑ). 숫자가 아니면 null.
 * 파일·IPC 로 들어온 값에는 쓰지 않는다 — 그쪽은 `readNumericSetting`(범위 밖 = 그 칸 기본값, K1ⓐ).
 */
export function clampSetting({ key, value }: { key: NumericSettingKey; value: unknown }): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const range = SETTINGS_RANGES[key]
  return roundToUnit({ range, value: Math.min(range.max, Math.max(range.min, value)) })
}

/** **파일·IPC** 로 들어온 숫자 — 범위 밖이거나 숫자가 아니면 null(그 칸만 기본값/직전 값, K1ⓐ · r1 R1-02). */
export function readNumericSetting({ key, value }: { key: NumericSettingKey; value: unknown }): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const range = SETTINGS_RANGES[key]
  if (value < range.min || value > range.max) return null
  return roundToUnit({ range, value })
}

/**
 * 칸 하나를 읽는다(파일·IPC) — 손상·범위 밖·알 수 없는 값이면 **그 칸만** null(부른 쪽이 기본값/직전 값). 나머지 칸은 영향이 없다(K1ⓐ).
 * 범위 밖 숫자도 버린다(손으로 고친 30 → 그 칸 기본값). 범위 고정은 화면 입력(`clampSetting`)만 한다.
 */
export function readSettingField<K extends keyof Settings>(input: { key: K; value: unknown }): Settings[K] | null
export function readSettingField({ key, value }: { key: keyof Settings; value: unknown }): Settings[keyof Settings] | null {
  switch (key) {
    case 'terminalFontSize':
    case 'terminalFontWeight':
    case 'terminalFontWeightBold':
    case 'terminalLineHeight':
    case 'terminalInactivePaneOpacity':
    case 'terminalDividerThicknessPx':
      return readNumericSetting({ key, value })
    case 'terminalFontFamily':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 ? value.trim() : null
    case 'terminalThemeDark':
      return typeof value === 'string' && Object.hasOwn(TERMINAL_THEME_CATALOG, value) ? value : null
    case 'terminalCursorStyle':
      return CURSOR_STYLES.find((style) => style === value) ?? null
    case 'terminalCursorBlink':
      return typeof value === 'boolean' ? value : null
    case 'terminalDividerColorDark':
      return isHexColor(value) ? value.toLowerCase() : null
    case 'terminalColorOverrides':
      return readColorOverrides(value)
  }
}

/**
 * 색 override 칸 — **잘못된 키·값은 그 키만 버린다**(K7ⓐ). 객체가 아니면 칸 전체를 버린다(null).
 * 항목이 있었는데 하나도 살아남지 못하면 null — IPC 패치가 쓰레기 키만 보냈을 때 기존 override 를 지우지 않게 한다(비움은 `{}` 로만).
 */
function readColorOverrides(value: unknown): TerminalColorOverrides | null {
  if (!isRecord(value)) return null
  const out: TerminalColorOverrides = {}
  for (const key of TERMINAL_COLOR_OVERRIDE_KEYS) {
    const color = value[key]
    if (isHexColor(color)) out[key] = color.toLowerCase()
  }
  if (Object.keys(value).length > 0 && Object.keys(out).length === 0) return null
  return out
}

/** 칸 값이 같은가 — override 는 내용 비교(키 순서 무관). 나머지 칸은 원시값이라 `===`. */
export function settingValuesEqual({ a, b }: { a: unknown; b: unknown }): boolean {
  if (a === b) return true
  if (!isRecord(a) || !isRecord(b)) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/** 설정 복사본 — override 객체도 새로 만든다(받은 쪽이 고쳐도 원본이 바뀌지 않게). */
export function copySettings(settings: Settings): Settings {
  return { ...settings, terminalColorOverrides: { ...settings.terminalColorOverrides } }
}

const SETTING_KEYS: readonly (keyof Settings)[] = [
  'terminalFontSize',
  'terminalFontFamily',
  'terminalFontWeight',
  'terminalFontWeightBold',
  'terminalLineHeight',
  'terminalThemeDark',
  'terminalCursorStyle',
  'terminalCursorBlink',
  'terminalInactivePaneOpacity',
  'terminalDividerColorDark',
  'terminalDividerThicknessPx',
  'terminalColorOverrides',
]

/** 파일에서 읽은 객체 → 설정. 칸마다 따로 기본값으로 떨어진다. 객체가 아니면 전부 기본값. */
export function readSettings(parsed: unknown): Settings {
  const out: Settings = copySettings(DEFAULT_SETTINGS)
  if (!isRecord(parsed)) return out
  for (const key of SETTING_KEYS) {
    const value = readSettingField({ key, value: parsed[key] })
    if (value !== null) Object.assign(out, { [key]: value })
  }
  return out
}

/**
 * 렌더러가 보낸 부분 갱신을 검증해 **적용할 칸만** 돌려준다. 모르는 칸·잘못된 값은 버린다(그 칸은 직전 값 유지).
 * 버린 칸 이름은 `rejected` 로 — main 이 로그에 남긴다.
 */
export function sanitizeSettingsPatch(patch: unknown): { accepted: Partial<Settings>; rejected: string[] } {
  const accepted: Partial<Settings> = {}
  const rejected: string[] = []
  if (!isRecord(patch)) return { accepted, rejected: ['(객체 아님)'] }
  for (const [key, value] of Object.entries(patch)) {
    const known = SETTING_KEYS.find((name) => name === key)
    if (known === undefined) { rejected.push(key); continue }
    const read = readSettingField({ key: known, value })
    if (read === null) { rejected.push(key); continue }
    Object.assign(accepted, { [known]: read })
  }
  return { accepted, rejected }
}

// --- 해석 (라이브 pane·미리보기 공용 — 드리프트 금지, K3ⓔ) ------------------------------------------------

export type TerminalColorKey = Exclude<keyof ITheme, 'extendedAnsi'>

/**
 * override 로 받는 색 칸 — Orca `TerminalColorOverrides` 의 22칸(전경·배경·커서 2·선택 2·16색). Ghostty 키가 닿을 수 있는 칸이 이것뿐이다.
 * Orca 의 `bold` 는 xterm `ITheme` 에 없어 뺐다(Ghostty `bold-color` 는 지원되지 않는 키).
 */
export const TERMINAL_COLOR_OVERRIDE_KEYS = [
  'foreground', 'background', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const satisfies readonly TerminalColorKey[]
export type TerminalColorOverrideKey = (typeof TERMINAL_COLOR_OVERRIDE_KEYS)[number]
export type TerminalColorOverrides = Partial<Record<TerminalColorOverrideKey, string>>

/**
 * 테마 이름(+ override) → xterm 테마. **순수 함수**(K1ⓔ) — 같은 입력이면 같은 객체 모양. 없는 이름은 기본 테마.
 * 돌려주는 객체는 카탈로그와 분리된 복사본이다 — xterm 이 받은 객체를 고쳐도 카탈로그가 오염되지 않는다.
 */
export function resolveTerminalTheme(input: { themeName: string; overrides?: TerminalColorOverrides }): ITheme {
  const base = TERMINAL_THEME_CATALOG[input.themeName] ?? TERMINAL_THEME_CATALOG[DEFAULT_TERMINAL_THEME]!
  return { ...base, ...(input.overrides ?? {}) }
}

/** 두 테마가 같은 값인가 — 같으면 `options.theme` 를 다시 쓰지 않는다(Orca B14: 쓰면 팔레트가 새로 만들어져 OSC 4/10/11/12 가 날아간다). */
export function terminalThemesEqual({ a, b }: { a: ITheme | undefined; b: ITheme | undefined }): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (Reflect.get(a, key) !== Reflect.get(b, key)) return false
  return true
}

/** 글꼴군 → xterm `fontFamily`. 고른 글꼴 뒤에 macOS 폴백을 붙인다(Orca `buildFontFamily` 의 macOS 부분, 중복은 건너뛴다). */
const FONT_FALLBACKS: readonly string[] = ['SF Mono', 'Menlo', 'Monaco']
export function buildFontFamily(family: string): string {
  const trimmed = family.trim()
  const parts = trimmed.length > 0 ? [`"${trimmed}"`] : []
  for (const fallback of FONT_FALLBACKS) {
    if (!parts.some((part) => part.toLowerCase().includes(fallback.toLowerCase()))) parts.push(`"${fallback}"`)
  }
  parts.push('monospace')
  return parts.join(', ')
}

/** 셀 크기에 들어가는 글꼴 옵션 — 렌더 xterm 과 `measureCellSize` 가 **이 함수 하나**에서 받는다(K2ⓑ 원천 하나). */
export type TerminalFontOptions = { fontSize: number; fontFamily: string; fontWeight: number; fontWeightBold: number; lineHeight: number }
export function terminalFontOptions(settings: Settings): TerminalFontOptions {
  return {
    fontSize: settings.terminalFontSize,
    fontFamily: buildFontFamily(settings.terminalFontFamily),
    fontWeight: settings.terminalFontWeight,
    fontWeightBold: settings.terminalFontWeightBold,
    lineHeight: settings.terminalLineHeight,
  }
}

/**
 * 셀 크기를 바꾸는 값만 모은 열쇠 — 이것이 바뀔 때만 셀을 다시 잰다(K2ⓒⓕ). xterm 6.0.0 은 `fontFamily`·`fontSize` 로 글자를 재고
 * `lineHeight` 로 셀 높이를 곱한다(00-analysis §11 W1). 굵기·테마·커서는 셀을 안 바꾼다 — 격자 요청이 나가면 안 된다.
 */
export function cellMetricKey(settings: Settings): string {
  return `${settings.terminalFontSize}|${settings.terminalFontFamily}|${settings.terminalLineHeight}`
}

/** xterm 커서 옵션. 비활성 모양은 Orca `resolveTerminalCursorInactiveStyle` 그대로(block 만 outline). */
export function terminalCursorOptions(settings: Settings): { cursorStyle: TerminalCursorStyle; cursorInactiveStyle: TerminalCursorStyle | 'outline'; cursorBlink: boolean } {
  return {
    cursorStyle: settings.terminalCursorStyle,
    cursorInactiveStyle: settings.terminalCursorStyle === 'block' ? 'outline' : settings.terminalCursorStyle,
    cursorBlink: settings.terminalCursorBlink,
  }
}

// --- 대비 보정 (Orca `terminal-contrast-correction.ts` · `terminal-title-contrast.ts` 이식) --------------------
// 다크 배경 3 · 라이트 배경 4.5. 테마 16색이 실제로 먹는다(U9 — herdr 가 인덱스로 보낸다)는 실측이 있어 Orca 기본 동작을 따른다(00-analysis §9).

export const LIGHT_BG_MIN_CONTRAST = 4.5
export const DARK_BG_MIN_CONTRAST = 3

function parseHex(color: string | undefined): { r: number; g: number; b: number } | null {
  if (color === undefined) return null
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (match === null) return null
  const hex = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join('') : match[1]!
  return { r: Number.parseInt(hex.slice(0, 2), 16), g: Number.parseInt(hex.slice(2, 4), 16), b: Number.parseInt(hex.slice(4, 6), 16) }
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const toLinear = (channel: number): number => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b)
}

function contrastRatio({ a, b }: { a: { r: number; g: number; b: number }; b: { r: number; g: number; b: number } }): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 배경이 밝은가 — 검정 글자 대비가 흰 글자 대비 이상이면 밝다(Orca `isTerminalBackgroundLight`, 불투명 hex 만). */
export function isTerminalBackgroundLight(background: string | undefined): boolean {
  const rgb = parseHex(background)
  if (rgb === null) return false
  return contrastRatio({ a: { r: 0, g: 0, b: 0 }, b: rgb }) >= contrastRatio({ a: { r: 255, g: 255, b: 255 }, b: rgb })
}

export function resolveMinimumContrastRatio(background: string | undefined): number {
  return isTerminalBackgroundLight(background) ? LIGHT_BG_MIN_CONTRAST : DARK_BG_MIN_CONTRAST
}
