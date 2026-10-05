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
import { X11_COLOR_NAMES } from './x11-color-names.js'

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

/**
 * Ghostty v1.3.1 이 **받는** 값인가(fix2 R2-01). Ghostty 는 한 줄을 파싱하다 실패하면 진단만 남기고 그 필드를 그대로 둔다
 * (`cli/args.zig` 136 `parseIntoField(...) catch` → 다음 줄 · 348 `try parseCLI` 가 성공해야 대입). 그래서 거절된 줄은 앞의 유효 값·테마 값을
 * 지우지 않는다. 반대로 Ghostty 가 받는 값은 corral 이 못 옮겨도 앞 값을 덮는다 — 그때는 앞 값을 가져오지 않고 미지원 사유만 남긴다.
 * 빈 값은 모든 키에서 「기본값으로 리셋」 이라 받는 값이다(args.zig 326-339).
 * 키 타입별 문법(Config.zig v1.3.1):
 *   · font-size `f32`·unfocused-split-opacity `f64` → `std.fmt.parseFloat`(10진·지수·16진 `0x…p…`·inf·nan, 자릿수 사이 `_`)
 *   · adjust-cell-height `MetricModifier`(font/Metrics.zig 460) → `<float>%` 또는 10진 정수(픽셀)
 *   · cursor-style `terminal.CursorStyle`(terminal/cursor.zig) → bar·block·underline·block_hollow (대소문자 그대로)
 *   · cursor-style-blink `?bool` → `parseBool`(args.zig 654): 1·t·T·true·0·f·F·false
 *   · background·foreground·split-divider-color `Color`(Config.zig 5395) → X11 이름(대소문자 무시) 또는 hex 3·6자리(`#` 생략 가능)
 *   · cursor-color·cursor-text·selection-* `TerminalColor`(5515) → `cell-foreground`·`cell-background` 또는 Color
 *   · palette `Palette.parseCLI`(5811) → `N=COLOR`, N 은 `parseInt(u8, 기수 0)`(0x·0o·0b 접두, 0~255)
 * 그 밖의 키(모르는 키·corral 미지원 키)는 문법을 따지지 않고 마지막 값을 쓴다 — 어느 값이든 사유가 같다.
 */
const ZIG_DEC_FLOAT = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/
const ZIG_HEX_FLOAT = /^[+-]?0[xX](?:[0-9a-fA-F](?:_?[0-9a-fA-F])*(?:\.(?:[0-9a-fA-F](?:_?[0-9a-fA-F])*)?)?|\.[0-9a-fA-F](?:_?[0-9a-fA-F])*)(?:[pP][+-]?\d(?:_?\d)*)?$/
const ZIG_SPECIAL_FLOAT = /^[+-]?(?:inf|infinity|nan)$/i
const ZIG_U8_BASE0 = /^\+?(?:0x[0-9a-f](?:_?[0-9a-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|\d(?:_?\d)*)$/i
const GHOSTTY_BOOLS: ReadonlySet<string> = new Set(['1', 't', 'T', 'true', '0', 'f', 'F', 'false'])
const GHOSTTY_CURSOR_STYLES: ReadonlySet<string> = new Set(['bar', 'block', 'underline', 'block_hollow'])
const TERMINAL_COLOR_KEYS: ReadonlySet<string> = new Set(['cursor-color', 'cursor-text', 'selection-background', 'selection-foreground'])

function ghosttyFloat(value: string): boolean {
  return ZIG_DEC_FLOAT.test(value) || ZIG_HEX_FLOAT.test(value) || ZIG_SPECIAL_FLOAT.test(value)
}

function ghosttyColor(value: string): boolean {
  return HEX_COLOR.test(value) || X11_COLOR_NAMES.has(value.toLowerCase())
}

/** Zig `parseInt(u8, s, 0)` — 받으면 값, 아니면 null. */
function ghosttyU8(text: string): number | null {
  if (!ZIG_U8_BASE0.test(text)) return null
  const digits = text.replace(/^\+/, '').replaceAll('_', '').toLowerCase()
  const value = digits.startsWith('0o') ? Number.parseInt(digits.slice(2), 8) : Number(digits)
  return value <= 255 ? value : null
}

/** 문법을 아는 키면 Ghostty 가 받는지, 모르면 null(문법을 따지지 않는다). */
function ghosttyAccepts({ key, value }: { key: string; value: string }): boolean | null {
  if (value.length === 0) return true
  if (COLOR_KEYS.has(key)) return ghosttyColor(value) || (TERMINAL_COLOR_KEYS.has(key) && (value === 'cell-foreground' || value === 'cell-background'))
  switch (key) {
    case 'font-size':
    case 'unfocused-split-opacity':
      return ghosttyFloat(value)
    case 'adjust-cell-height':
      return value.endsWith('%') ? ghosttyFloat(value.slice(0, -1)) : /^[+-]?\d+$/.test(value)
    case 'cursor-style':
      return GHOSTTY_CURSOR_STYLES.has(value)
    case 'cursor-style-blink':
      return GHOSTTY_BOOLS.has(value)
    case 'split-divider-color':
      return ghosttyColor(value)
    default:
      return null
  }
}

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
const COLOR_REASON = 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음'
/** Ghostty 도 거절하는 값에 붙인다 — 그 줄은 무시되고 앞 값(앞 줄·앞 파일·테마)이 남는다. */
const GHOSTTY_REJECTED = ' · Ghostty 도 받지 않아 이 줄은 무시됨'

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

/**
 * 백분율 → 줄 높이 배수를 **천분율 정수**로 셈한다(R1-02). `1 + 14 / 100` 은 1.1400000000000001 이라 「셋째 자리까지만」 에 걸린다 —
 * 입력 정밀도(백분율 소수 첫째 자리 = 배수 셋째 자리)를 넘는 값은 그대로 나누어 내보내 저장소 반올림 검사에 걸리게 한다(33.3333% → 거부).
 */
function percentToLineHeight({ sign, whole, fraction }: { sign: string; whole: string; fraction: string }): number {
  const digits = fraction.replace(/0+$/, '')
  if (digits.length > 1) return 1 + Number(`${sign}${whole}.${fraction}`) / 100
  const permille = Number(whole) * 10 + Number(digits || '0')
  return (1000 + (sign === '-' ? -permille : permille)) / 1000
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

/**
 * palette — `N=COLOR` 항목마다. 같은 인덱스는 뒤가 이긴다. 잘못된 항목은 항목별로 사유.
 * 빈 값은 Ghostty 문법상 리셋이다(`cli/args.zig` — 빈 문자열이면 필드를 기본값으로) — 그때까지 쌓인 palette(앞 파일·테마 것 포함, 테마가 목록 앞에 온다)를
 * 지우고 사유 없이 넘어간다. 다른 색 키(background 등)는 palette 가 아니라 건드리지 않는다(R1-01).
 */
function mapPalette({ values, overrides, unsupported }: { values: string[]; overrides: TerminalColorOverrides; unsupported: GhosttyUnsupportedKey[] }): void {
  for (const entry of values) {
    if (entry.trim().length === 0) {
      for (const key of PALETTE_KEYS) delete overrides[key]
      continue
    }
    const eq = entry.indexOf('=')
    const indexText = eq === -1 ? '' : entry.slice(0, eq).trim()
    const colorText = eq === -1 ? '' : entry.slice(eq + 1).trim()
    // Ghostty 가 받는 항목만 그 인덱스를 덮는다(fix2 R2-01). 거절된 항목은 앞 항목·테마 값을 남긴다.
    const ghosttyIndex = eq === -1 ? null : ghosttyU8(indexText)
    const accepted = ghosttyIndex !== null && ghosttyColor(colorText)
    // Ghostty 는 받았지만 corral 이 못 옮기는 항목은 그 인덱스의 앞 값도 가져오지 않는다 — Ghostty 에서는 이 항목이 이겼다.
    const overridden = accepted ? PALETTE_KEYS[ghosttyIndex] : undefined
    const reject = (reason: string): void => {
      unsupported.push({ key: 'palette', reason: `"${entry}" — ${reason}${accepted ? '' : GHOSTTY_REJECTED}` })
      if (overridden !== undefined) delete overrides[overridden]
    }
    if (!/^\d+$/.test(indexText)) { reject('N=COLOR 형식이 아님 (인덱스는 10진수)'); continue }
    const target = PALETTE_KEYS[Number(indexText)]
    if (target === undefined) { reject('인덱스 16 이상은 지원하지 않음 (16색만)'); continue }
    const color = readColor(colorText)
    if (!color.ok) { reject(color.reason); continue }
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
      const match = /^([+-]?)(\d+)(?:\.(\d+))?%$/.exec(value)
      if (match === null) return '백분율(%) 값만 받음 — 픽셀 값은 지원하지 않음'
      const lineHeight = readExactNumber({ key: 'terminalLineHeight', value: percentToLineHeight({ sign: match[1]!, whole: match[2]!, fraction: match[3] ?? '' }) })
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
    // Ghostty 가 받는 마지막 할당을 고른다(fix2 R2-01). 거절된 할당은 사유만 남기고 앞 값을 지우지 않는다.
    let chosen: string | null = null
    for (const candidate of values) {
      const accepted = ghosttyAccepts({ key, value: candidate })
      if (accepted === false) {
        const reason = mapScalar({ key, value: candidate, patch: {}, overrides: {} }) ?? '형식이 아님'
        unsupported.push({ key, reason: `${reason}${GHOSTTY_REJECTED}` })
      } else chosen = candidate
    }
    if (chosen === null) continue
    const value = chosen
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
