// Ghostty 키 → corral 설정 칸 (LIFE-513 K2ⓑ~ⓔ). Orca v1.4.198 `src/main/ghostty/mapper.ts` 에서 옮겨 corral 칸에 맞게 고쳤다(MIT, 고지 `./NOTICE.md`).
//
// Orca 와 다른 점(00-analysis §4, 사유는 RESULT 표):
//   · corral 에 칸이 있는 키만 옮긴다 — Orca 가 자기 칸으로 옮기던 opacity·패딩·option-as-alt 등 8개는 「지원되지 않는 키」(D7)
//   · `font-weight` 매핑 없음 — Ghostty v1.3.1 `Config.zig` 에 그 키가 없다(D5). 들어오면 모르는 키
//   · font-family 반복 = Ghostty 의미(첫 값이 주 글꼴, 빈 값은 목록 리셋). Orca 는 마지막 값을 썼다(D4 · Orca #15985)
//   · 값 검증 = **corral 저장소의 칸 검증(`readSettingField`)과 같은 규칙**, 그리고 조용히 바꾸지 않는다 — 반올림·범위 고정이 일어나야 들어가는
//     값은 쓰지 않고 사유를 붙여 올린다(D6). 예: font-size 13.5(정수 칸) · 30(10~24 밖) · cursor-style `block_hollow` · X11 색 이름
//   · palette 는 0~15 만(corral override 는 16색 칸). 16 이상·잘못된 항목은 항목별로 사유를 붙인다
import type { GhosttyUnsupportedKey } from '../../shared/ghostty-import.js'
import {
  SETTINGS_RANGES,
  readSettingField,
  type NumericSettingKey,
  type Settings,
  type TerminalColorOverrideKey,
  type TerminalColorOverrides,
} from '../../shared/terminal-settings.js'
import type { GhosttyConfig } from './parser.js'

const PALETTE_KEYS: readonly TerminalColorOverrideKey[] = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

/** Ghostty 색 키 → override 칸(Orca 대응 그대로). */
const COLOR_KEYS: ReadonlyMap<string, TerminalColorOverrideKey> = new Map([
  ['background', 'background'],
  ['foreground', 'foreground'],
  ['cursor-color', 'cursor'],
  ['cursor-text', 'cursorAccent'],
  ['selection-background', 'selectionBackground'],
  ['selection-foreground', 'selectionForeground'],
])

/** 이유가 따로 있는 미지원 키. 나머지 모르는 키는 「corral 에 대응하는 설정이 없음」. */
const KNOWN_UNSUPPORTED: ReadonlyMap<string, string> = new Map([
  ['bold-color', 'xterm 테마에 굵은 글자 색 칸이 없음'],
  ['selection-word-chars', 'Ghostty 의 단어 문자와 xterm 의 단어 구분자는 뜻이 반대라 옮기지 않음'],
  ['config-file', '포함 파일은 따라가지 않음'],
])

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
const COLOR_REASON = 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음'

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }

function readColor(value: string): Checked<string> {
  const match = HEX_COLOR.exec(value)
  return match === null ? { ok: false, reason: COLOR_REASON } : { ok: true, value: `#${match[1]!.toLowerCase()}` }
}

function rangeText(key: NumericSettingKey): string {
  const range = SETTINGS_RANGES[key]
  return `${range.min}~${range.max}${range.integer ? ' 정수' : ''}`
}

/** 숫자 칸 — 저장소 검증을 통과하고 **값이 그대로 남을 때만** 받는다(반올림이 일어나면 거부). */
function readExactNumber({ key, value }: { key: NumericSettingKey; value: number }): Checked<number> {
  const read = readSettingField({ key, value })
  if (read === null) return { ok: false, reason: `corral 범위 ${rangeText(key)} 밖` }
  if (read !== value) return { ok: false, reason: SETTINGS_RANGES[key].integer ? `정수만 받음 (반올림하지 않음, 범위 ${rangeText(key)})` : '소수 셋째 자리까지만 받음 (반올림하지 않음)' }
  return { ok: true, value: read }
}

function parseDecimal(value: string): Checked<number> {
  return DECIMAL.test(value) ? { ok: true, value: Number(value) } : { ok: false, reason: '숫자가 아님' }
}

/** font-family — 반복은 폴백 목록, 빈 값은 목록 리셋, **첫 값이 주 글꼴**(Ghostty 공식 문서 · c6). 주 글꼴 하나만 가져온다(W10). */
function mapFontFamily({ values, patch, unsupported }: { values: string[]; patch: Partial<Settings>; unsupported: GhosttyUnsupportedKey[] }): void {
  const list: string[] = []
  for (const value of values) {
    if (value.trim().length === 0) list.length = 0
    else list.push(value.trim())
  }
  const primary = list[0]
  if (primary === undefined) {
    unsupported.push({ key: 'font-family', reason: '빈 값 — 글꼴 목록 리셋만 있어 가져올 글꼴이 없음' })
    return
  }
  const read = readSettingField({ key: 'terminalFontFamily', value: primary })
  if (read === null) {
    unsupported.push({ key: 'font-family', reason: '글꼴 이름이 200자를 넘음' })
    return
  }
  patch.terminalFontFamily = read
  if (list.length > 1) unsupported.push({ key: 'font-family', reason: `폴백 글꼴은 가져오지 않음: ${list.slice(1).join(', ')} (주 글꼴 ${read} 만)` })
}

/** palette — `N=COLOR` 항목마다. 같은 인덱스는 뒤가 이긴다. 잘못된 항목은 항목별로 사유. */
function mapPalette({ values, overrides, unsupported }: { values: string[]; overrides: TerminalColorOverrides; unsupported: GhosttyUnsupportedKey[] }): void {
  for (const entry of values) {
    const eq = entry.indexOf('=')
    const indexText = eq === -1 ? '' : entry.slice(0, eq).trim()
    const colorText = eq === -1 ? '' : entry.slice(eq + 1).trim()
    if (!/^\d+$/.test(indexText)) {
      unsupported.push({ key: 'palette', reason: `"${entry}" — N=COLOR 형식이 아님 (인덱스는 10진수)` })
      continue
    }
    const target = PALETTE_KEYS[Number(indexText)]
    if (target === undefined) {
      unsupported.push({ key: 'palette', reason: `"${entry}" — 인덱스 16 이상은 지원하지 않음 (16색만)` })
      continue
    }
    const color = readColor(colorText)
    if (!color.ok) {
      unsupported.push({ key: 'palette', reason: `"${entry}" — ${color.reason}` })
      continue
    }
    overrides[target] = color.value
  }
}

/**
 * 값 하나짜리 키 — Ghostty 는 뒤 값이 이긴다. 돌려주는 값: 거부 사유(받았으면 null).
 * 검증은 저장소 칸 규칙(`readSettingField`)을 그대로 거친다 — 저장소가 받을 값만 diff 에 오른다.
 */
function mapScalar({ key, value, patch, overrides }: { key: string; value: string; patch: Partial<Settings>; overrides: TerminalColorOverrides }): string | null {
  const colorTarget = COLOR_KEYS.get(key)
  if (colorTarget !== undefined) {
    const color = readColor(value)
    if (!color.ok) return color.reason
    overrides[colorTarget] = color.value
    return null
  }
  switch (key) {
    case 'font-size': {
      const num = parseDecimal(value)
      if (!num.ok) return num.reason
      const size = readExactNumber({ key: 'terminalFontSize', value: num.value })
      if (!size.ok) return size.reason
      patch.terminalFontSize = size.value
      return null
    }
    case 'adjust-cell-height': {
      // 백분율만 줄 높이 배수로 옮길 수 있다 — 픽셀 값은 셀 높이를 알아야 해서 옮기지 않는다(Orca 주석과 같다).
      const match = /^([+-]?\d+(\.\d+)?)%$/.exec(value)
      if (match === null) return '백분율(%) 값만 받음 — 픽셀 값은 지원하지 않음'
      const lineHeight = readExactNumber({ key: 'terminalLineHeight', value: 1 + Number(match[1]) / 100 })
      if (!lineHeight.ok) return `라인 높이 ${lineHeight.reason}`
      patch.terminalLineHeight = lineHeight.value
      return null
    }
    case 'unfocused-split-opacity': {
      const num = parseDecimal(value)
      if (!num.ok) return num.reason
      const opacity = readExactNumber({ key: 'terminalInactivePaneOpacity', value: num.value })
      if (!opacity.ok) return opacity.reason
      patch.terminalInactivePaneOpacity = opacity.value
      return null
    }
    case 'cursor-style': {
      const style = readSettingField({ key: 'terminalCursorStyle', value })
      if (style === null) return 'block·bar·underline 만 받음'
      patch.terminalCursorStyle = style
      return null
    }
    case 'cursor-style-blink': {
      if (value !== 'true' && value !== 'false') return 'true·false 만 받음'
      patch.terminalCursorBlink = value === 'true'
      return null
    }
    case 'split-divider-color': {
      const color = readColor(value)
      if (!color.ok) return color.reason
      const read = readSettingField({ key: 'terminalDividerColorDark', value: color.value })
      if (read === null) return COLOR_REASON
      patch.terminalDividerColorDark = read
      return null
    }
    default:
      return KNOWN_UNSUPPORTED.get(key) ?? 'corral 에 대응하는 설정이 없음'
  }
}

export function mapGhosttyToCorral(config: GhosttyConfig): { patch: Partial<Settings>; unsupported: GhosttyUnsupportedKey[] } {
  const patch: Partial<Settings> = {}
  const overrides: TerminalColorOverrides = {}
  const unsupported: GhosttyUnsupportedKey[] = []
  for (const [key, values] of config) {
    if (key === 'font-family') { mapFontFamily({ values, patch, unsupported }); continue }
    if (key === 'palette') { mapPalette({ values, overrides, unsupported }); continue }
    const value = values.at(-1) ?? ''
    if (value.length === 0 && !KNOWN_UNSUPPORTED.has(key)) {
      unsupported.push({ key, reason: '빈 값 — 기본값으로 되돌리는 설정은 가져오지 않음' })
      continue
    }
    const reason = mapScalar({ key, value, patch, overrides })
    if (reason !== null) unsupported.push({ key, reason })
  }
  if (Object.keys(overrides).length > 0) patch.terminalColorOverrides = overrides
  return { patch, unsupported }
}
