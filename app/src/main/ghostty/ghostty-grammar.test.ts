// LIFE-513 fix3 — Ghostty v1.3.1 parseCLI·Zig 0.15.2 std.fmt 이식의 수용/거절 경계. 기대값은 Ghostty·Zig 소스 의미(RESULT 「fix3 · 수용 판정 표」).
import { describe, expect, it } from 'vitest'
import {
  I32,
  U8,
  ghosttyBool,
  ghosttyColor,
  ghosttyCursorStyle,
  ghosttyMetricModifier,
  ghosttyPaletteEntry,
  ghosttyTerminalColor,
  ghosttyTheme,
  zigParseFloat,
  zigParseInt,
} from './ghostty-grammar.js'

describe('zigParseInt — i32 기수 10(MetricModifier 픽셀, Metrics.zig 476)', () => {
  const i32 = (text: string): bigint | null => zigParseInt({ text, base: 10, ...I32 })
  it.each<[string, bigint | null]>([
    ['2147483647', 2147483647n], ['2147483648', null], ['-2147483648', -2147483648n], ['-2147483649', null],
    ['1_0', 10n], ['1__0', 10n], ['_10', null], ['10_', null], ['+5', 5n], ['-0', 0n], ['', null], ['+', null], ['-', null],
    ['0x10', null], [' 1', null], ['1 ', null], ['1.0', null],
  ])('%j → %s', (text, want) => { expect(i32(text)).toBe(want) })
})

describe('zigParseInt — u8 기수 0(palette 인덱스, Config.zig 5820)', () => {
  const u8 = (text: string): bigint | null => zigParseInt({ text, base: 0, ...U8 })
  it.each<[string, bigint | null]>([
    ['255', 255n], ['256', null], ['-0', 0n], ['-000', 0n], ['-1', null], ['0x0f', 15n], ['0X0F', 15n], ['0b1', 1n], ['0B11', 3n], ['0o7', 7n], ['0o8', null],
    ['0x', null], ['0b2', null], ['0_1', 1n], ['0__1', 1n], ['_1', null], ['1_', null], ['0x_f', null], ['0xf_', null], ['00', 0n], ['+0x10', 16n], ['0xff', 255n], ['0x100', null],
  ])('%j → %s', (text, want) => { expect(u8(text)).toBe(want) })
})

describe('zigParseFloat — Zig 0.15.2 parse_float 수용 문법(font-size f32 · opacity f64 · 퍼센트 f64)', () => {
  it.each<[string, 'number' | 'special' | null]>([
    ['14', 'number'], ['13.5', 'number'], ['.5', 'number'], ['5.', 'number'], ['-2', 'number'], ['+2', 'number'],
    ['1e1', 'number'], ['1E+1', 'number'], ['1e-1', 'number'], ['1e', null], ['e1', null], ['1e+', null], ['1e1_0', 'number'],
    ['0x1p3', 'number'], ['0x1.8', 'number'], ['0X1P-2', 'number'], ['0x', null], ['0x.p1', null], ['0x1e', 'number'],
    ['inf', 'special'], ['INF', 'special'], ['Infinity', 'special'], ['nan', 'special'], ['-inf', 'special'], ['+NaN', 'special'], ['infinit', null], ['infx', null],
    ['1_000', 'number'], ['1__0', null], ['_1', null], ['1_', null], ['1_.5', null], ['1._5', null], ['1_e5', null],
    ['', null], ['+', null], ['--1', null], [' 14', null], ['14 ', null], ['1.2.3', null], ['.', null], ['not-a-number', null], ['14 # big', null],
  ])('%j → %s', (text, want) => { expect(zigParseFloat(text)).toBe(want) })
})

describe('Color.parseCLI · TerminalColor.parseCLI (Config.zig 5395 · 5515)', () => {
  it('trim(space·tab) 뒤 hex — 정규화한 hex 를 돌려준다(R3-01)', () => {
    expect(ghosttyColor(' #abcdef ')).toEqual({ hex: '#abcdef' })
    expect(ghosttyColor('\t#ABC\t')).toEqual({ hex: '#abc' })
    expect(ghosttyColor('abc')).toEqual({ hex: '#abc' })
  })
  it('trim 뒤 X11 이름(ASCII 대소문자 무시) — 받지만 hex 없음', () => {
    expect(ghosttyColor(' red ')).toEqual({ hex: null })
    expect(ghosttyColor('Ghost White')).toEqual({ hex: null })
    expect(ghosttyColor('FoReStGReen')).toEqual({ hex: null })
  })
  it('거절 — 길이·문자·비 ASCII 대소문자(Kelvin K)', () => {
    for (const text of ['#abcd', '#', '', '#xyzxyz', 'nonsense', 'blacK', '\n#abc']) expect(ghosttyColor(text)).toBeNull()
  })
  it('TerminalColor — cell-foreground/background 는 trim 없이 정확히 같을 때만', () => {
    expect(ghosttyTerminalColor('cell-foreground')).toEqual({ hex: null })
    expect(ghosttyTerminalColor('cell-background')).toEqual({ hex: null })
    expect(ghosttyTerminalColor(' cell-foreground')).toBeNull()
    expect(ghosttyTerminalColor(' #abcdef ')).toEqual({ hex: '#abcdef' })
  })
})

describe('Palette.parseCLI (Config.zig 5811-5830)', () => {
  it.each<[string, { index: number; hex: string | null } | null]>([
    ['1=#fff', { index: 1, hex: '#fff' }], [' 1 = #fff ', { index: 1, hex: '#fff' }], ['\t1\t=\t#fff\t', { index: 1, hex: '#fff' }],
    ['-0=#abcdef', { index: 0, hex: '#abcdef' }], ['0__1=#abcdef', { index: 1, hex: '#abcdef' }], ['0x0f=#000', { index: 15, hex: '#000' }],
    ['255=red', { index: 255, hex: null }], ['256=#000', null], ['1=', null], ['=#fff', null], [' ', null], ['1#fff', null], ['1=#fff=x', null],
  ])('%j → %j', (text, want) => { expect(ghosttyPaletteEntry(text)).toEqual(want) })
})

describe('MetricModifier.parse (Metrics.zig 460-479)', () => {
  it.each<[string, ReturnType<typeof ghosttyMetricModifier>]>([
    ['20%', { kind: 'percent', number: '20' }], ['1e1%', { kind: 'percent', number: '1e1' }], ['%', null], [' 20%', null], ['20 %', null],
    ['1_0', { kind: 'absolute' }], ['2147483647', { kind: 'absolute' }], ['2147483648', null], ['-2147483649', null], ['2', { kind: 'absolute' }], ['2px', null],
  ])('%j → %j', (text, want) => { expect(ghosttyMetricModifier(text)).toEqual(want) })
})

describe('parseBool · CursorStyle', () => {
  it('parseBool(args.zig 654) — 1·t·T·true / 0·f·F·false, trim 없음', () => {
    expect(['1', 't', 'T', 'true'].map(ghosttyBool)).toEqual([true, true, true, true])
    expect(['0', 'f', 'F', 'false'].map(ghosttyBool)).toEqual([false, false, false, false])
    expect(['yes', 'TRUE', ' true', ''].map(ghosttyBool)).toEqual([null, null, null, null])
  })
  it('CursorStyle(stringToEnum) — 정확히 같은 이름만', () => {
    expect(['bar', 'block', 'underline', 'block_hollow'].map(ghosttyCursorStyle)).toEqual(['bar', 'block', 'underline', 'block_hollow'])
    expect(['beam', 'Bar', ' bar'].map(ghosttyCursorStyle)).toEqual([null, null, null])
  })
})

describe('Theme.parseCLI (Config.zig 9780-9805 · args.zig parseAutoStruct 525-604)', () => {
  it.each<[string, ReturnType<typeof ghosttyTheme>]>([
    ['Good', { kind: 'single', name: 'Good' }], [' Good\t', { kind: 'single', name: 'Good' }], ['Catppuccin Mocha', { kind: 'single', name: 'Catppuccin Mocha' }],
    ['light:a,dark:b', { kind: 'pair' }], ['dark:b,light:a', { kind: 'pair' }], [' light : a , dark : b ', { kind: 'pair' }], ['light:a,dark:b,', { kind: 'pair' }], ['light:,dark:b', { kind: 'pair' }],
    ['light:a', { kind: 'rejected' }], ['dark:a', { kind: 'rejected' }], ['garbage:value', { kind: 'rejected' }], ['foo=bar', { kind: 'rejected' }],
    ['light:a,,dark:b', { kind: 'rejected' }], [',light:a,dark:b', { kind: 'rejected' }], ['light:a,dark:b,extra:c', { kind: 'rejected' }], ['light=a,dark=b', { kind: 'rejected' }],
    ['light:"a",dark:b', { kind: 'uncertain' }], ['light:a\\,b,dark:c', { kind: 'uncertain' }],
  ])('%j → %j', (text, want) => { expect(ghosttyTheme(text)).toEqual(want) })
})
