// Ghostty v1.3.1 값 문법 — 매핑하는 키의 `parseCLI` 를 타입별로 그대로 옮겼다(LIFE-513 fix3). 값 모양 정규식으로 흉내 내지 않는다.
// 숫자는 Ghostty 가 쓰는 Zig 0.15.2(`build.zig.zon` minimum_zig_version) `std.fmt` 를 옮겼다. 줄 번호·표는 RESULT 「fix3 · 수용 판정 표」.
//
// 여기 함수는 **Ghostty 가 그 값을 받는가**(받으면 앞 값을 덮는다, 거절이면 진단만 남기고 필드를 그대로 둔다 — `cli/args.zig` 136·348)와
// corral 이 옮길 때 필요한 정규화 값만 돌려준다. corral 범위 검사는 `mapper.ts` 가 한다.
// Ghostty 해석을 옮기지 않은 문법(테마 쌍 안의 따옴표·이스케이프)은 `uncertain` 으로 돌려준다 — 그 키는 앞 값·뒤 값 모두 가져오지 않는다.
import { X11_COLOR_NAMES } from './x11-color-names.js'

/** Ghostty `cli/args.zig` 19 `whitespace = " \t"` — `std.mem.trim` 이 벗기는 문자. */
function trimGhostty(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, '')
}

/** Zig `std.ascii.toLower` — ASCII 만 바꾼다(JS `toLowerCase` 는 Kelvin `K` 같은 비 ASCII 도 바꿔 X11 이름에 잘못 걸린다). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32))
}

function digitValue(char: string): number {
  // Zig `std.fmt.charToDigit`(fmt.zig 585) — 0-9·A-Z·a-z 를 값으로, 그 밖은 무한대(어느 기수에서도 거절).
  const code = char.charCodeAt(0)
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 65 && code <= 90) return code - 55
  if (code >= 97 && code <= 122) return code - 87
  return Number.POSITIVE_INFINITY
}

/**
 * Zig 0.15.2 `std.fmt.parseInt(T, buf, base)`(fmt.zig 332·337·409). 받으면 값(BigInt), 거절이면 null.
 * 빈 문자열 거절 · 앞 `+`/`-` 하나 · base 0 이면 길이 > 2 이고 `0b`/`0o`/`0x`(대소문자 무시) 접두 · 첫·끝 `_` 거절, 가운데 `_` 는 몇 개든 건너뜀 ·
 * 자릿수는 `charToDigit < base` · 넘침(overflow)은 거절. 누적이 단조라 「최종 값이 타입 범위 안」 과 같다.
 */
export function zigParseInt({ text, base, min, max }: { text: string; base: number; min: bigint; max: bigint }): bigint | null {
  if (text.length === 0) return null
  const negative = text[0] === '-'
  const unsigned = text[0] === '+' || negative ? text.slice(1) : text
  if (unsigned.length === 0) return null
  let radix = base === 0 ? 10 : base
  let digits = unsigned
  if (base === 0 && unsigned.length > 2 && unsigned[0] === '0') {
    const prefix = asciiLower(unsigned[1]!)
    const prefixed = prefix === 'b' ? 2 : prefix === 'o' ? 8 : prefix === 'x' ? 16 : 0
    if (prefixed !== 0) { radix = prefixed; digits = unsigned.slice(2) }
  }
  if (digits[0] === '_' || digits.at(-1) === '_') return null
  let value = 0n
  for (const char of digits) {
    if (char === '_') continue
    const digit = digitValue(char)
    if (digit >= radix) return null
    value = value * BigInt(radix) + BigInt(digit)
  }
  const signed = negative ? -value : value
  return signed < min || signed > max ? null : signed
}

export const U8 = { min: 0n, max: 255n }
export const I32 = { min: -2147483648n, max: 2147483647n }

function isFloatDigit({ char, base }: { char: string | undefined; base: number }): boolean {
  if (char === undefined) return false
  return base === 10 ? char >= '0' && char <= '9' : /^[0-9a-fA-F]$/.test(char)
}

/** Zig `parse_float/parse.zig` `validUnderscores` — `_` 는 양옆이 그 기수의 숫자, 맨 앞·맨 끝·연속 금지. */
function validUnderscores({ body, base }: { body: string; base: number }): boolean {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '_') continue
    if (i === 0 || i + 1 === body.length) return false
    if (!isFloatDigit({ char: body[i - 1], base }) || !isFloatDigit({ char: body[i + 1], base })) return false
    i += 1
  }
  return true
}

/**
 * Zig 0.15.2 `parsePartialNumberBase` + `parseNumber`(parse_float/parse.zig) 의 **수용 문법**. 값 변환(Eisel-Lemire 등)은 수용 여부와 무관해 옮기지 않았다.
 * 정수부 숫자(`_` 건너뜀) · 선택 `.`+숫자 · 숫자가 하나도 없으면 거절 · 지수 문자(10진 e/E, 16진 p/P) 뒤 선택 부호 + 10진 숫자 필수 · 전부 소비 · `_` 규칙.
 */
function zigFloatNumber(rest: string): boolean {
  const hex = rest.length >= 2 && rest[0] === '0' && asciiLower(rest[1]!) === 'x'
  const body = hex ? rest.slice(2) : rest
  const base = hex ? 16 : 10
  let pos = 0
  let digits = 0
  let underscores = 0
  const scan = ({ radix }: { radix: number }): void => {
    while (pos < body.length) {
      if (isFloatDigit({ char: body[pos], base: radix })) { digits += 1; pos += 1 } else if (body[pos] === '_') { underscores += 1; pos += 1 } else return
    }
  }
  scan({ radix: base })
  if (body[pos] === '.') { pos += 1; scan({ radix: base }) }
  if (digits === 0) return false
  const expChar = hex ? 'p' : 'e'
  if (pos < body.length && asciiLower(body[pos]!) === expChar) {
    pos += 1
    if (body[pos] === '+' || body[pos] === '-') pos += 1
    if (!isFloatDigit({ char: body[pos], base: 10 })) return false
    const before = digits
    scan({ radix: 10 })
    digits = before
  }
  if (pos !== body.length) return false
  return underscores === 0 || validUnderscores({ body, base })
}

/** Zig 0.15.2 `std.fmt.parseFloat`(parse_float.zig 19) — 받으면 종류, 거절이면 null. 앞 부호 하나, 그 뒤 수 문법 또는 inf·infinity·nan(대소문자 무시). */
export function zigParseFloat(text: string): 'number' | 'special' | null {
  if (text.length === 0) return null
  const rest = text[0] === '-' || text[0] === '+' ? text.slice(1) : text
  if (rest.length === 0) return null
  if (zigFloatNumber(rest)) return 'number'
  return /^(inf|infinity|nan)$/i.test(rest) ? 'special' : null
}

/** `Color.parseCLI`(Config.zig 5395-5408) — trim(" \t") 뒤 X11 이름(대소문자 무시) 또는 `fromHex`(5439: 선택 `#` + 3·6자리 16진). hex 면 정규화 값, X11 이름이면 hex null. */
export function ghosttyColor(text: string): { hex: string | null } | null {
  const trimmed = trimGhostty(text)
  if (X11_COLOR_NAMES.has(asciiLower(trimmed))) return { hex: null }
  const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  if ((digits.length !== 3 && digits.length !== 6) || ![...digits].every((char) => digitValue(char) < 16)) return null
  return { hex: `#${asciiLower(digits)}` }
}

/** `TerminalColor.parseCLI`(Config.zig 5515-5520) — **trim 없이** `cell-foreground`·`cell-background` 와 같으면 그것, 아니면 `Color.parseCLI`. */
export function ghosttyTerminalColor(text: string): { hex: string | null } | null {
  if (text === 'cell-foreground' || text === 'cell-background') return { hex: null }
  return ghosttyColor(text)
}

/** `Palette.parseCLI`(Config.zig 5811-5830) — 첫 `=` 필수 · 인덱스 = `parseInt(u8, trim(" \t", 앞), 0)` · 색 = `Color.parseCLI(뒤)`. */
export function ghosttyPaletteEntry(text: string): { index: number; hex: string | null } | null {
  const eq = text.indexOf('=')
  if (eq === -1) return null
  const index = zigParseInt({ text: trimGhostty(text.slice(0, eq)), base: 0, ...U8 })
  if (index === null) return null
  const color = ghosttyColor(text.slice(eq + 1))
  return color === null ? null : { index: Number(index), hex: color.hex }
}

/**
 * `MetricModifier.parse`(font/Metrics.zig 460-479) — 끝이 `%` 면 `parseFloat(f64, 앞)`, 아니면 `parseInt(i32, 전체, 10)`(픽셀). trim 없음.
 * 퍼센트면 `%` 앞 글자를 그대로 돌려준다(corral 은 그중 10진 표기만 옮긴다 — `mapper.ts`).
 */
export function ghosttyMetricModifier(text: string): { kind: 'percent'; number: string } | { kind: 'absolute' } | null {
  if (text.endsWith('%')) {
    const number = text.slice(0, -1)
    return zigParseFloat(number) === null ? null : { kind: 'percent', number }
  }
  return zigParseInt({ text, base: 10, ...I32 }) === null ? null : { kind: 'absolute' }
}

/** `cli/args.zig` 654 `parseBool` — 1·t·T·true·0·f·F·false 만(trim 없음). */
export function ghosttyBool(text: string): boolean | null {
  if (text === '1' || text === 't' || text === 'T' || text === 'true') return true
  if (text === '0' || text === 'f' || text === 'F' || text === 'false') return false
  return null
}

/** `terminal.CursorStyle`(terminal/cursor.zig) 를 `std.meta.stringToEnum`(args.zig 443) — 이름이 정확히 같아야 한다. */
export function ghosttyCursorStyle(text: string): 'bar' | 'block' | 'underline' | 'block_hollow' | null {
  switch (text) {
    case 'bar':
    case 'block':
    case 'underline':
    case 'block_hollow':
      return text
    default:
      return null
  }
}

/**
 * `Theme.parseCLI`(Config.zig 9780-9805). `,`·`=`·`:` 가 있으면 `parseAutoStruct(Theme)`(args.zig 525-604): `CommaSplitter` 로 나눈 항목마다 첫 `:` 필수,
 * 키 = trim 해서 `light`·`dark` 중 하나, 값 = trim(빈 값도 받음), 두 키 모두 있어야 한다(필드 기본값 없음). 아니면 trim 한 이름 하나.
 * `CommaSplitter` 의 따옴표·이스케이프와 Zig 문자열 리터럴 해석은 옮기지 않았다 — 쌍 문법에 `"`·`\` 가 있으면 `uncertain`.
 * (빈 값은 이 함수 전에 args.zig 326-339 리셋으로 처리된다.)
 */
export function ghosttyTheme(text: string): { kind: 'single'; name: string } | { kind: 'pair' } | { kind: 'rejected' } | { kind: 'uncertain' } {
  if (!text.includes(',') && !text.includes('=') && !text.includes(':')) return { kind: 'single', name: trimGhostty(text) }
  if (text.includes('"') || text.includes('\\')) return { kind: 'uncertain' }
  // CommaSplitter: `,` 마다 자른다. 끝의 `,` 하나는 다음 항목을 만들지 않는다(index >= len 이면 끝).
  const entries = text.split(',')
  if (text.endsWith(',')) entries.pop()
  const seen = new Set<string>()
  for (const entry of entries) {
    const colon = entry.indexOf(':')
    if (colon === -1) return { kind: 'rejected' }
    const key = trimGhostty(entry.slice(0, colon))
    if (key !== 'light' && key !== 'dark') return { kind: 'rejected' }
    seen.add(key)
  }
  return seen.size === 2 ? { kind: 'pair' } : { kind: 'rejected' }
}
