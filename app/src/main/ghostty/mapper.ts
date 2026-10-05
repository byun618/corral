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
import {
  ghosttyBool,
  ghosttyColor,
  ghosttyCursorStyle,
  ghosttyMetricModifier,
  ghosttyPaletteEntry,
  ghosttyTerminalColor,
  zigParseFloat,
} from './ghostty-grammar.js'

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

const TERMINAL_COLOR_KEYS: ReadonlySet<string> = new Set(['cursor-color', 'cursor-text', 'selection-background', 'selection-foreground'])

/**
 * Ghostty v1.3.1 이 이 할당을 **받는가**(fix2 R2-01 → fix3 에서 parseCLI 이식으로 바꿈). Ghostty 는 한 줄을 파싱하다 실패하면 진단만 남기고 그 필드를
 * 그대로 둔다(`cli/args.zig` 136 `parseIntoField(...) catch` → 다음 줄 · 348 `try parseCLI` 가 성공해야 대입). 그래서 거절된 줄은 앞의 유효 값·테마 값을
 * 지우지 않는다. 반대로 Ghostty 가 받는 값은 corral 이 못 옮겨도 앞 값을 덮는다 — 그때는 앞 값을 가져오지 않고 미지원 사유만 남긴다.
 * **길이 0** 인 값은 모든 키에서 「기본값으로 리셋」 이라 받는 값이다(args.zig 326-339 — 공백만 있는 값은 리셋이 아니다, fix3 R3-03).
 * 키별 문법은 `ghostty-grammar.ts`(Zig·Ghostty 파서 이식)와 RESULT 「fix3 · 수용 판정 표」. 문법을 모르는 키(corral 미지원 키)는 null — 마지막 값을 쓴다.
 */
function ghosttyAccepts({ key, value }: { key: string; value: string }): boolean | null {
  if (value.length === 0) return true
  if (TERMINAL_COLOR_KEYS.has(key)) return ghosttyTerminalColor(value) !== null
  switch (key) {
    case 'background':
    case 'foreground':
    case 'split-divider-color':
      return ghosttyColor(value) !== null
    case 'font-size':
    case 'unfocused-split-opacity':
      return zigParseFloat(value) !== null
    case 'adjust-cell-height':
      return ghosttyMetricModifier(value) !== null
    case 'cursor-style':
      return ghosttyCursorStyle(value) !== null
    case 'cursor-style-blink':
      return ghosttyBool(value) !== null
    default:
      return null
  }
}

/** Ghostty 가 받았지만 corral 이 옮기지 않는 숫자 표기(지수·16진·inf·nan·밑줄 등). */
const NUMBER_NOTATION_REASON = '10진 소수 표기만 옮김 (Ghostty 는 받는 지수·16진·inf·nan·밑줄 표기는 지원하지 않음)'
const UNCERTAIN_REASON = 'Ghostty 해석을 확정할 수 없어 가져오지 않음'

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
const COLOR_REASON = 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음'
/** Ghostty 도 거절하는 값에 붙인다 — 그 줄은 무시되고 앞 값(앞 줄·앞 파일·테마)이 남는다. */
const GHOSTTY_REJECTED = ' · Ghostty 도 받지 않아 이 줄은 무시됨'

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }

/** 색 — Ghostty `Color.parseCLI`/`TerminalColor.parseCLI` 로 읽고(trim 포함, fix3 R3-01), hex 일 때만 그 정규화 값을 옮긴다. */
function readColor({ value, terminal }: { value: string; terminal: boolean }): Checked<string> {
  const parsed = terminal ? ghosttyTerminalColor(value) : ghosttyColor(value)
  return parsed === null || parsed.hex === null ? { ok: false, reason: COLOR_REASON } : { ok: true, value: parsed.hex }
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

/** corral 은 10진 소수 표기만 옮긴다. Ghostty 도 거절하면 「숫자가 아님」, Ghostty 는 받는 다른 표기면 그 사유. */
function parseDecimal(value: string): Checked<number> {
  if (DECIMAL.test(value)) return { ok: true, value: Number(value) }
  return { ok: false, reason: zigParseFloat(value) === null ? '숫자가 아님' : NUMBER_NOTATION_REASON }
}

/**
 * font-family — 반복은 폴백 목록, **길이 0** 값만 목록 리셋(`RepeatableString.parseCLI` Config.zig 5958-5964 — 공백만 있는 값은 항목이다, fix3 R3-03),
 * **첫 값이 주 글꼴**(Ghostty 공식 문서 · c6). 주 글꼴 하나만 가져온다(W10). 주 글꼴 이름 양끝에 공백이 있으면 Ghostty 의 글꼴 찾기가 그 이름을
 * 어떻게 다루는지 확정할 수 없다(corral 은 trim 해서 저장한다) — 가져오지 않는다.
 */
function mapFontFamily({ values, patch, unsupported }: { values: string[]; patch: Partial<Settings>; unsupported: GhosttyUnsupportedKey[] }): void {
  const list: string[] = []
  for (const value of values) {
    if (value.length === 0) list.length = 0
    else list.push(value)
  }
  const primary = list[0]
  if (primary === undefined) {
    unsupported.push({ key: 'font-family', reason: '빈 값 — 글꼴 목록 리셋만 있어 가져올 글꼴이 없음' })
    return
  }
  if (primary !== primary.trim()) {
    unsupported.push({ key: 'font-family', reason: `"${primary}" — 양끝 공백이 있는 글꼴 이름 · ${UNCERTAIN_REASON}` })
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
 * palette — `N=COLOR` 항목마다(`Palette.parseCLI` Config.zig 5811-5830 → `ghosttyPaletteEntry`). 같은 인덱스는 뒤가 이긴다.
 * **길이 0** 값은 리셋(args.zig 326-339) — 그때까지 쌓인 palette(앞 파일·테마 것 포함, 테마가 목록 앞에 온다)를 지우고 사유 없이 넘어간다.
 * 공백만 있는 줄은 리셋이 아니라 `=` 가 없어 거절이다(fix3 R3-03). 다른 색 키(background 등)는 palette 가 아니라 건드리지 않는다(R1-01).
 * Ghostty 가 거절한 항목은 앞 항목·테마 값을 남기고(fix2 R2-01), Ghostty 는 받았지만 corral 이 못 옮기는 항목(X11 이름)은 그 인덱스의 앞 값도
 * 가져오지 않는다 — Ghostty 에서는 이 항목이 이겼다. 인덱스는 Zig `parseInt(u8, 기수 0)` 그대로라 `0x3`·`0b1`·`-0`·`0__1` 도 그 인덱스다(fix3 R3-02).
 */
function mapPalette({ values, overrides, unsupported }: { values: string[]; overrides: TerminalColorOverrides; unsupported: GhosttyUnsupportedKey[] }): void {
  for (const entry of values) {
    if (entry.length === 0) {
      for (const key of PALETTE_KEYS) delete overrides[key]
      continue
    }
    const parsed = ghosttyPaletteEntry(entry)
    if (parsed === null) {
      unsupported.push({ key: 'palette', reason: `"${entry}" — N=COLOR 형식이 아님 (N 은 Ghostty 정수 0~255, COLOR 는 hex·X11 이름)${GHOSTTY_REJECTED}` })
      continue
    }
    const target = PALETTE_KEYS[parsed.index]
    if (target === undefined) {
      unsupported.push({ key: 'palette', reason: `"${entry}" — 인덱스 16 이상은 지원하지 않음 (16색만)` })
      continue
    }
    if (parsed.hex === null) {
      unsupported.push({ key: 'palette', reason: `"${entry}" — ${COLOR_REASON}` })
      delete overrides[target]
      continue
    }
    overrides[target] = parsed.hex
  }
}

/**
 * 값 하나짜리 키 — Ghostty 는 뒤 값이 이긴다. 돌려주는 값: 거부 사유(받았으면 null).
 * 검증은 저장소 칸 규칙(`readSettingField`)을 그대로 거친다 — 저장소가 받을 값만 diff 에 오른다.
 */
function mapScalar({ key, value, patch, overrides }: { key: string; value: string; patch: Partial<Settings>; overrides: TerminalColorOverrides }): string | null {
  const colorTarget = COLOR_KEYS.get(key)
  if (colorTarget !== undefined) {
    const color = readColor({ value, terminal: TERMINAL_COLOR_KEYS.has(key) })
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
      const modifier = ghosttyMetricModifier(value)
      if (modifier === null || modifier.kind === 'absolute') return '백분율(%) 값만 받음 — 픽셀 값은 지원하지 않음'
      // 10진 표기 — `.5`·`14.` 처럼 한쪽이 빈 소수도 Zig parseFloat 가 받는 같은 수다(fix4 R4-03). 숫자는 `ghosttyMetricModifier` 가 이미 하나 이상 확인했다.
      const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(modifier.number)
      if (match === null) return NUMBER_NOTATION_REASON
      const lineHeight = readExactNumber({ key: 'terminalLineHeight', value: percentToLineHeight({ sign: match[1]!, whole: match[2]!, fraction: match[3] ?? '' }) })
      if (!lineHeight.ok) return `라인 높이 ${lineHeight.reason}`
      patch.terminalLineHeight = lineHeight.value
      return null
    }
    case 'unfocused-split-opacity': {
      const num = parseDecimal(value)
      if (!num.ok) return num.reason
      // Ghostty `finalize` 가 0.15~1 로 고정한다(Config.zig 4638) — Ghostty 가 실제로 쓰는 값을 옮긴다(fix3).
      const opacity = readExactNumber({ key: 'terminalInactivePaneOpacity', value: Math.min(1, Math.max(0.15, num.value)) })
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
      const color = readColor({ value, terminal: false })
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
