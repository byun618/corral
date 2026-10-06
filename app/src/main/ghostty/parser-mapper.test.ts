// Ghostty 줄 파서·매퍼 (LIFE-513 K2) — Ghostty v1.3.1 `LineIterator` 규칙(D2)·corral 칸 검증(D6)·font-family 첫 값(D4)·font-weight 없음(D5)·
// corral 에 칸이 없는 키(D7). 일부 사례는 Orca 198 `parser.test.ts`·`mapper.test.ts` 의 입력을 옮겨 corral 기대값으로 바꿨다.
import { describe, expect, it } from 'vitest'
import { mapGhosttyToCorral } from './mapper.js'
import { MAX_LINE_BYTES, mergeGhosttyConfig, parseGhosttyConfig, parseGhosttyFile, skipUtf8Bom } from './parser.js'

const map = (content: string): ReturnType<typeof mapGhosttyToCorral> => mapGhosttyToCorral(parseGhosttyConfig(content))
const reasonsOf = ({ content, key }: { content: string; key: string }): string[] => map(content).unsupported.filter((entry) => entry.key === key).map((entry) => entry.reason)

describe('parseGhosttyConfig — Ghostty LineIterator 규칙(K2ⓐ)', () => {
  it('key = value · 양끝 공백 · CR · 빈 줄 · # 로 시작하는 줄', () => {
    const parsed = parseGhosttyConfig('  font-size = 14  \r\n\n# comment\n   # indented comment\nfont-family=Menlo\n')
    expect([...parsed]).toEqual([['font-size', ['14']], ['font-family', ['Menlo']]])
  })

  it('값 뒤 # 는 주석이 아니라 값의 일부다(D2 — Orca 는 잘랐다)', () => {
    expect(parseGhosttyConfig('font-size = 14 # big').get('font-size')).toEqual(['14 # big'])
    expect(parseGhosttyConfig('background = #1a1b26').get('background')).toEqual(['#1a1b26'])
  })

  it('큰따옴표만 벗긴다 — 작은따옴표는 값에 남는다(D2)', () => {
    expect(parseGhosttyConfig('font-family = "JetBrains Mono"').get('font-family')).toEqual(['JetBrains Mono'])
    expect(parseGhosttyConfig("font-family = 'JetBrains Mono'").get('font-family')).toEqual(["'JetBrains Mono'"])
    expect(parseGhosttyConfig('font-family = ""').get('font-family')).toEqual([''])
    expect(parseGhosttyConfig('font-family = "').get('font-family')).toEqual(['"'])
  })

  it('= 없는 줄·빈 키는 무시하고 같은 키 반복은 순서대로 남긴다', () => {
    const parsed = parseGhosttyConfig('just-a-word\n= value\npalette = 0=#000000\npalette = 1=#ff0000\n')
    expect([...parsed]).toEqual([['palette', ['0=#000000', '1=#ff0000']]])
  })

  it('__proto__ 같은 키도 그냥 키다(Map)', () => {
    expect(parseGhosttyConfig('__proto__ = x').get('__proto__')).toEqual(['x'])
  })

  it('파일 병합 — 모든 키의 할당을 순서대로 이어 붙인다(어느 값이 남는지는 매퍼가 Ghostty 문법으로 고른다, fix2 R2-01)', () => {
    const target = parseGhosttyConfig('font-size = 12\npalette = 0=#000000\nfont-family = A\n')
    mergeGhosttyConfig({ target, next: parseGhosttyConfig('font-size = 16\npalette = 0=#111111\nfont-family = B\n') })
    expect(target.get('font-size')).toEqual(['12', '16'])
    expect(target.get('palette')).toEqual(['0=#000000', '0=#111111'])
    expect(target.get('font-family')).toEqual(['A', 'B'])
  })
})

describe('mapGhosttyToCorral — 키별 정상·경계·거부(K2ⓑⓒⓕ)', () => {
  it('이 사용자의 실제 구성(Menlo 14)', () => {
    expect(map('font-family = Menlo\nfont-size = 14\n')).toEqual({ patch: { terminalFontFamily: 'Menlo', terminalFontSize: 14 }, unsupported: [] })
  })

  it('font-size — 정수 10~24 만, 소수·범위 밖은 쓰지 않고 사유(D6)', () => {
    expect(map('font-size = 10').patch).toEqual({ terminalFontSize: 10 })
    expect(map('font-size = 24').patch).toEqual({ terminalFontSize: 24 })
    expect(map('font-size = 13.5').patch).toEqual({})
    expect(reasonsOf({ content: 'font-size = 13.5', key: 'font-size' })[0]).toContain('정수만')
    expect(reasonsOf({ content: 'font-size = 30', key: 'font-size' })[0]).toContain('범위 10~24 정수 밖')
    expect(reasonsOf({ content: 'font-size = 9', key: 'font-size' })[0]).toContain('밖')
    expect(reasonsOf({ content: 'font-size = big', key: 'font-size' })).toEqual(['숫자가 아님 · Ghostty 도 받지 않아 이 줄은 무시됨'])
    expect(reasonsOf({ content: 'font-size = 1e1', key: 'font-size' })).toEqual(['10진 소수 표기만 옮김 (Ghostty 는 받는 지수·16진·inf·nan·밑줄 표기는 지원하지 않음)'])
  })

  it('값 뒤 # 는 검증에 걸려 지원되지 않는 키가 된다(D2)', () => {
    expect(map('font-size = 14 # big')).toEqual({ patch: {}, unsupported: [{ key: 'font-size', reason: '숫자가 아님 · Ghostty 도 받지 않아 이 줄은 무시됨' }] })
  })

  it('반복 키는 마지막 값(font-family·palette 제외)', () => {
    expect(map('font-size = 12\nfont-size = 16').patch).toEqual({ terminalFontSize: 16 })
  })

  it('Ghostty 가 거절하는 마지막 할당은 앞의 유효 값을 지우지 않는다 — 한 파일(fix2 R2-01)', () => {
    const result = map('font-size = 18\nfont-size = not-a-number\nbackground = #101010\nbackground = #xyzxyz\ncursor-style = bar\ncursor-style = beam\n')
    expect(result.patch).toEqual({ terminalFontSize: 18, terminalCursorStyle: 'bar', terminalColorOverrides: { background: '#101010' } })
    expect(result.unsupported).toEqual([
      { key: 'font-size', reason: '숫자가 아님 · Ghostty 도 받지 않아 이 줄은 무시됨' },
      { key: 'background', reason: 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음 · Ghostty 도 받지 않아 이 줄은 무시됨' },
      { key: 'cursor-style', reason: 'block·bar·underline 만 받음 · Ghostty 도 받지 않아 이 줄은 무시됨' },
    ])
  })

  it('음성 대조 — Ghostty 는 받지만 corral 이 못 옮기는 마지막 값은 앞 값으로 되돌리지 않는다(font-size 18 → 13.5 · red · cell-foreground · block_hollow, fix2 R2-01)', () => {
    expect(map('font-size = 18\nfont-size = 13.5\n')).toEqual({ patch: {}, unsupported: [{ key: 'font-size', reason: '정수만 받음 (반올림하지 않음, 범위 10~24 정수)' }] })
    expect(map('background = #101010\nbackground = red\n').patch).toEqual({})
    expect(map('selection-foreground = #101010\nselection-foreground = cell-foreground\n').patch).toEqual({})
    expect(map('cursor-style = bar\ncursor-style = block_hollow\n').patch).toEqual({})
    expect(map('font-size = 18\nfont-size = 1e1\n').patch).toEqual({})
    expect(map('cursor-style-blink = false\ncursor-style-blink = t\n').patch).toEqual({})
    // 빈 값 리셋은 그대로 — 앞 값을 지우고 기본값(가져오지 않음)
    expect(map('font-size = 18\nfont-size =\n')).toEqual({ patch: {}, unsupported: [{ key: 'font-size', reason: '빈 값 — 기본값으로 되돌리는 설정은 가져오지 않음' }] })
  })

  it('palette 도 같은 규칙 — Ghostty 거절 항목은 앞 값 유지, Ghostty 는 받지만 corral 이 못 옮기는 항목은 그 인덱스 앞 값을 가져오지 않음(fix2 R2-01)', () => {
    const kept = map('palette = 1=#111111\npalette = 1=#xyzxyz\npalette = 2=#222222\npalette = 2=nonsense\npalette = 3=#333333\npalette = 300=#444444\n')
    expect(kept.patch).toEqual({ terminalColorOverrides: { red: '#111111', green: '#222222', yellow: '#333333' } })
    expect(kept.unsupported.map((entry) => entry.reason)).toEqual([
      '"1=#xyzxyz" — N=COLOR 형식이 아님 (N 은 Ghostty 정수 0~255, COLOR 는 hex·X11 이름) · Ghostty 도 받지 않아 이 줄은 무시됨',
      '"2=nonsense" — N=COLOR 형식이 아님 (N 은 Ghostty 정수 0~255, COLOR 는 hex·X11 이름) · Ghostty 도 받지 않아 이 줄은 무시됨',
      '"300=#444444" — N=COLOR 형식이 아님 (N 은 Ghostty 정수 0~255, COLOR 는 hex·X11 이름) · Ghostty 도 받지 않아 이 줄은 무시됨',
    ])
    const shadowed = map('palette = 1=#111111\npalette = 1=red\npalette = 3=#333333\npalette = 0x3=#abcdef\npalette = 4=#444444\npalette = 20=#000000\n')
    // 1=red 는 Ghostty 가 받아 앞 1 을 덮는다(corral 은 X11 이름 미지원 → 1 없음) · 0x3 은 Zig parseInt(u8, 기수 0) 로 인덱스 3(fix3 R3-02)
    expect(shadowed.patch).toEqual({ terminalColorOverrides: { yellow: '#abcdef', blue: '#444444' } })
  })

  it('adjust-cell-height — % 만, 1~3 배, 반올림 없음', () => {
    expect(map('adjust-cell-height = 20%').patch).toEqual({ terminalLineHeight: 1.2 })
    expect(map('adjust-cell-height = +200%').patch).toEqual({ terminalLineHeight: 3 })
    expect(map('adjust-cell-height = 12.5%').patch).toEqual({ terminalLineHeight: 1.125 })
    expect(reasonsOf({ content: 'adjust-cell-height = 2', key: 'adjust-cell-height' })[0]).toContain('백분율')
    expect(reasonsOf({ content: 'adjust-cell-height = 250%', key: 'adjust-cell-height' })[0]).toContain('밖')
    expect(reasonsOf({ content: 'adjust-cell-height = -10%', key: 'adjust-cell-height' })[0]).toContain('밖')
    expect(reasonsOf({ content: 'adjust-cell-height = 33.3333%', key: 'adjust-cell-height' })[0]).toContain('셋째 자리')
  })

  it('adjust-cell-height — 백분율 산술 오차는 거부하지 않는다, 입력 정밀도 초과만 거부(R1-02)', () => {
    expect(map('adjust-cell-height = 14%').patch).toEqual({ terminalLineHeight: 1.14 })
    expect(map('adjust-cell-height = 36%').patch).toEqual({ terminalLineHeight: 1.36 })
    expect(map('adjust-cell-height = 10%').patch).toEqual({ terminalLineHeight: 1.1 })
    expect(map('adjust-cell-height = 14.50%').patch).toEqual({ terminalLineHeight: 1.145 })
    expect(map('adjust-cell-height = 0%').patch).toEqual({ terminalLineHeight: 1 })
    expect(reasonsOf({ content: 'adjust-cell-height = 14.25%', key: 'adjust-cell-height' })[0]).toContain('셋째 자리')
    expect(reasonsOf({ content: 'adjust-cell-height = 33.3333%', key: 'adjust-cell-height' })[0]).toContain('셋째 자리')
  })

  it('cursor-style — block·bar·underline, block_hollow 는 거부', () => {
    expect(map('cursor-style = bar').patch).toEqual({ terminalCursorStyle: 'bar' })
    expect(map('cursor-style = underline').patch).toEqual({ terminalCursorStyle: 'underline' })
    expect(map('cursor-style = block_hollow').patch).toEqual({})
    expect(reasonsOf({ content: 'cursor-style = block_hollow', key: 'cursor-style' })).toEqual(['block·bar·underline 만 받음'])
  })

  it('cursor-style-blink — true/false 만', () => {
    expect(map('cursor-style-blink = false').patch).toEqual({ terminalCursorBlink: false })
    expect(map('cursor-style-blink = true').patch).toEqual({ terminalCursorBlink: true })
    expect(reasonsOf({ content: 'cursor-style-blink = yes', key: 'cursor-style-blink' })).toEqual(['true·false 만 받음 · Ghostty 도 받지 않아 이 줄은 무시됨'])
  })

  it('unfocused-split-opacity — Ghostty finalize 의 0.15~1 고정값을 옮긴다(fix3, Config.zig 4638), 소수 셋째 자리까지', () => {
    expect(map('unfocused-split-opacity = 0.7').patch).toEqual({ terminalInactivePaneOpacity: 0.7 })
    expect(map('unfocused-split-opacity = 1').patch).toEqual({ terminalInactivePaneOpacity: 1 })
    expect(map('unfocused-split-opacity = 1.5').patch).toEqual({ terminalInactivePaneOpacity: 1 })
    expect(map('unfocused-split-opacity = 0.05').patch).toEqual({ terminalInactivePaneOpacity: 0.15 })
    expect(map('unfocused-split-opacity = -3').patch).toEqual({ terminalInactivePaneOpacity: 0.15 })
    expect(reasonsOf({ content: 'unfocused-split-opacity = 0.71234', key: 'unfocused-split-opacity' })[0]).toContain('셋째 자리')
  })

  it('split-divider-color — hex(# 없음·3자리 포함) → 다크 디바이더, 소문자. X11 이름은 거부', () => {
    expect(map('split-divider-color = #AABBCC').patch).toEqual({ terminalDividerColorDark: '#aabbcc' })
    expect(map('split-divider-color = 112233').patch).toEqual({ terminalDividerColorDark: '#112233' })
    expect(map('split-divider-color = #abc').patch).toEqual({ terminalDividerColorDark: '#abc' })
    expect(reasonsOf({ content: 'split-divider-color = red', key: 'split-divider-color' })[0]).toContain('hex')
  })

  it('색 키 → override(소문자, # 붙임). 특수값(cell-foreground)·X11 이름은 거부', () => {
    const result = map('background = 1A1B26\nforeground = #c0caf5\ncursor-color = #fff\ncursor-text = #000000\nselection-background = #33467c\nselection-foreground = #c0caf5\n')
    expect(result.patch).toEqual({ terminalColorOverrides: { background: '#1a1b26', foreground: '#c0caf5', cursor: '#fff', cursorAccent: '#000000', selectionBackground: '#33467c', selectionForeground: '#c0caf5' } })
    expect(result.unsupported).toEqual([])
    expect(reasonsOf({ content: 'selection-foreground = cell-foreground', key: 'selection-foreground' })[0]).toContain('hex')
    expect(reasonsOf({ content: 'background = rebeccapurple', key: 'background' })[0]).toContain('hex')
    expect(reasonsOf({ content: 'background = #12345', key: 'background' })[0]).toContain('hex')
  })

  it('palette — 0~15 만, 16 이상·잘못된 항목은 항목별 사유, 같은 인덱스는 뒤가 이긴다', () => {
    const result = map('palette = 0=#000000\npalette = 15=FFFFFF\npalette = 1=#f00\npalette = 16=#123456\npalette = 2=green\npalette = 0x3=#333333\npalette = nonsense\npalette = 0=#010101\n')
    expect(result.patch).toEqual({ terminalColorOverrides: { black: '#010101', brightWhite: '#ffffff', red: '#f00', yellow: '#333333' } })
    const reasons = result.unsupported.filter((entry) => entry.key === 'palette').map((entry) => entry.reason)
    expect(reasons).toHaveLength(3)
    expect(reasons[0]).toContain('"16=#123456" — 인덱스 16 이상')
    expect(reasons[1]).toContain('"2=green" — hex')
    expect(reasons[2]).toContain('"nonsense" — N=COLOR')
  })

  it('palette 빈 값은 리셋 — 앞 항목을 지우고 사유로 올리지 않는다, 다른 색 키는 그대로(R1-01)', () => {
    const result = map('background = #101010\npalette = 1=#123456\npalette =\npalette = 2=#abcdef\n')
    expect(result.patch).toEqual({ terminalColorOverrides: { background: '#101010', green: '#abcdef' } })
    expect(result.unsupported).toEqual([])
    expect(map('palette = 1=#123456\npalette = ""\n')).toEqual({ patch: {}, unsupported: [] })
  })

  it('font-family — 첫 값이 주 글꼴, 버린 폴백은 알린다(D4)', () => {
    const result = map('font-family = JetBrains Mono\nfont-family = Symbols Nerd Font\nfont-family = Apple Color Emoji\n')
    expect(result.patch).toEqual({ terminalFontFamily: 'JetBrains Mono' })
    expect(result.unsupported).toEqual([{ key: 'font-family', reason: '폴백 글꼴은 가져오지 않음: Symbols Nerd Font, Apple Color Emoji (주 글꼴 JetBrains Mono 만)' }])
  })

  it('font-family — 빈 값은 목록 리셋(그 뒤 첫 값이 주 글꼴), 리셋만 있으면 사유', () => {
    expect(map('font-family = A\nfont-family = ""\nfont-family = B\n')).toEqual({ patch: { terminalFontFamily: 'B' }, unsupported: [] })
    expect(map('font-family = A\nfont-family =\n')).toEqual({ patch: {}, unsupported: [{ key: 'font-family', reason: '빈 값 — 글꼴 목록 리셋만 있어 가져올 글꼴이 없음' }] })
    expect(reasonsOf({ content: `font-family = ${'X'.repeat(201)}`, key: 'font-family' })).toEqual(['글꼴 이름이 200자를 넘음'])
  })

  it('font-weight 는 Ghostty 에 없는 키 — 매핑하지 않는다(D5)', () => {
    expect(map('font-weight = 600')).toEqual({ patch: {}, unsupported: [{ key: 'font-weight', reason: 'corral 에 대응하는 설정이 없음' }] })
  })

  it('corral 에 칸이 없는 Orca 매핑 키 8개·모르는 키는 지원되지 않는 키(D7)', () => {
    const keys = ['background-opacity', 'macos-option-as-alt', 'window-padding-x', 'window-padding-y', 'mouse-hide-while-typing', 'cursor-opacity', 'focus-follows-mouse', 'middle-click-action', 'background-blur-radius', 'keybind']
    const result = map(keys.map((key) => `${key} = 1`).join('\n'))
    expect(result.patch).toEqual({})
    expect(result.unsupported).toEqual(keys.map((key) => ({ key, reason: 'corral 에 대응하는 설정이 없음' })))
  })

  it('bold-color·selection-word-chars·config-file 은 사유가 따로 있다', () => {
    expect(reasonsOf({ content: 'bold-color = #ffffff', key: 'bold-color' })[0]).toContain('굵은 글자')
    expect(reasonsOf({ content: 'selection-word-chars = abc', key: 'selection-word-chars' })[0]).toContain('반대')
    expect(reasonsOf({ content: 'config-file = other.conf', key: 'config-file' })[0]).toContain('포함 파일')
  })

  it('빈 값은 기본값 리셋 — 가져오지 않는다', () => {
    expect(map('font-size =')).toEqual({ patch: {}, unsupported: [{ key: 'font-size', reason: '빈 값 — 기본값으로 되돌리는 설정은 가져오지 않음' }] })
  })
})

describe('리뷰 r3 repro.mts 사례 — 기대값 = Ghostty 의미(fix3)', () => {
  it.each<[string, string, ReturnType<typeof mapGhosttyToCorral>]>([
    ['color-quoted-hex-space (R3-01)', 'background=#111111\nbackground=" #abcdef "', { patch: { terminalColorOverrides: { background: '#abcdef' } }, unsupported: [] }],
    ['color-quoted-x11-space (R3-01)', 'background=#111111\nbackground=" red "', { patch: {}, unsupported: [{ key: 'background', reason: 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음' }] }],
    ['terminal-color-quoted-x11-space (R3-01)', 'cursor-color=#111111\ncursor-color=" red "', { patch: {}, unsupported: [{ key: 'cursor-color', reason: 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음' }] }],
    ['divider-quoted-hex-space (R3-01)', 'split-divider-color=#111111\nsplit-divider-color=" #abcdef "', { patch: { terminalDividerColorDark: '#abcdef' }, unsupported: [] }],
    ['metric-int-underscore (R3-02)', 'adjust-cell-height=20%\nadjust-cell-height=1_0', { patch: {}, unsupported: [{ key: 'adjust-cell-height', reason: '백분율(%) 값만 받음 — 픽셀 값은 지원하지 않음' }] }],
    ['metric-int-overflow (R3-02)', 'adjust-cell-height=20%\nadjust-cell-height=2147483648', { patch: { terminalLineHeight: 1.2 }, unsupported: [{ key: 'adjust-cell-height', reason: '백분율(%) 값만 받음 — 픽셀 값은 지원하지 않음 · Ghostty 도 받지 않아 이 줄은 무시됨' }] }],
    ['palette-negative-zero (R3-02)', 'palette=0=#111111\npalette=-0=#abcdef', { patch: { terminalColorOverrides: { black: '#abcdef' } }, unsupported: [] }],
    ['palette-multi-underscore (R3-02)', 'palette=1=#111111\npalette=0__1=#abcdef', { patch: { terminalColorOverrides: { red: '#abcdef' } }, unsupported: [] }],
    ['palette-quoted-space (R3-03)', 'palette=1=#111111\npalette=" "', { patch: { terminalColorOverrides: { red: '#111111' } }, unsupported: [{ key: 'palette', reason: '" " — N=COLOR 형식이 아님 (N 은 Ghostty 정수 0~255, COLOR 는 hex·X11 이름) · Ghostty 도 받지 않아 이 줄은 무시됨' }] }],
    ['font-quoted-space (R3-03)', 'font-family=Menlo\nfont-family=" "\nfont-family=Monaco', { patch: { terminalFontFamily: 'Menlo' }, unsupported: [{ key: 'font-family', reason: '폴백 글꼴은 가져오지 않음:  , Monaco (주 글꼴 Menlo 만)' }] }],
    ['reset-then-reject', 'font-size=18\nfont-size=\nfont-size=nope', { patch: {}, unsupported: [{ key: 'font-size', reason: '숫자가 아님 · Ghostty 도 받지 않아 이 줄은 무시됨' }, { key: 'font-size', reason: '빈 값 — 기본값으로 되돌리는 설정은 가져오지 않음' }] }],
    ['reject-then-reset', 'font-size=18\nfont-size=nope\nfont-size=', { patch: {}, unsupported: [{ key: 'font-size', reason: '숫자가 아님 · Ghostty 도 받지 않아 이 줄은 무시됨' }, { key: 'font-size', reason: '빈 값 — 기본값으로 되돌리는 설정은 가져오지 않음' }] }],
    ['palette-reset-then-reject', 'palette=1=#111111\npalette=\npalette=1=wrong', { patch: {}, unsupported: [{ key: 'palette', reason: '"1=wrong" — N=COLOR 형식이 아님 (N 은 Ghostty 정수 0~255, COLOR 는 hex·X11 이름) · Ghostty 도 받지 않아 이 줄은 무시됨' }] }],
  ])('%s', (_name, content, want) => {
    expect(map(content)).toEqual(want)
  })

  it('색 앞뒤 탭도 trim(" \\t") — 탭 둘러싼 hex 를 가져온다', () => {
    expect(map('background=#111111\nbackground="\t#ABCDEF\t"').patch).toEqual({ terminalColorOverrides: { background: '#abcdef' } })
    expect(map('palette=2=#111111\npalette="2=\tred\t"').patch).toEqual({})
  })

  it('adjust-cell-height 0.0%~200.0% 2001 개는 천분율 그대로(edge-fixtures), 14.25%·33.3333% 는 거부', () => {
    for (let i = 0; i <= 2000; i += 1) expect(map(`adjust-cell-height=${(i / 10).toFixed(1)}%`).patch.terminalLineHeight).toBe((1000 + i) / 1000)
    for (const value of ['14.25%', '33.3333%']) expect(map(`adjust-cell-height=${value}`).patch.terminalLineHeight).toBeUndefined()
  })

  it('Ghostty 는 받지만 corral 이 옮기지 않는 숫자 표기 — 앞 값으로 되돌리지 않고 사유', () => {
    for (const value of ['1e1', '0x10', 'inf', 'nan', '1_4']) {
      expect(map(`font-size=18\nfont-size=${value}`)).toEqual({ patch: {}, unsupported: [{ key: 'font-size', reason: '10진 소수 표기만 옮김 (Ghostty 는 받는 지수·16진·inf·nan·밑줄 표기는 지원하지 않음)' }] })
    }
    expect(map('adjust-cell-height=20%\nadjust-cell-height=1e1%').patch).toEqual({})
    expect(map('adjust-cell-height=20%\nadjust-cell-height=1__0%').patch).toEqual({ terminalLineHeight: 1.2 })
  })

  it('불확정 = 가져오지 않음 — 주 글꼴 이름 양끝 공백은 Ghostty 해석을 확정할 수 없어 font-family 를 통째로 안 가져온다', () => {
    expect(map('font-family=" Menlo"\nfont-family=Monaco')).toEqual({ patch: {}, unsupported: [{ key: 'font-family', reason: '" Menlo" — 양끝 공백이 있는 글꼴 이름 · Ghostty 해석을 확정할 수 없어 가져오지 않음' }] })
    expect(map('font-family=" "')).toEqual({ patch: {}, unsupported: [{ key: 'font-family', reason: '" " — 양끝 공백이 있는 글꼴 이름 · Ghostty 해석을 확정할 수 없어 가져오지 않음' }] })
  })
})


describe('리뷰 r4 repro.mts·controls.mts 사례 — 기대값 = Ghostty 의미(fix4 R4-01~03)', () => {
  // repro.mts 9 사례 그대로(controls.mts 의 R4-01·02·03 줄은 결함 동작을 단언했다 — 여기서는 Ghostty 기대값으로 바꿨다).
  it.each<[string, string, ReturnType<typeof mapGhosttyToCorral>['patch']]>([
    ['unicode-nbsp-color', 'background = #111111\nbackground =\u00a0#222222\n', { terminalColorOverrides: { background: '#111111' } }],
    ['embedded-cr-font', 'font-size = 18\nfont-size =\r20\n', { terminalFontSize: 18 }],
    ['unicode-nbsp-reset', 'font-size = 18\nfont-size =\u00a0\n', { terminalFontSize: 18 }],
    ['overlong-comment', `font-size = 18\n#${'x'.repeat(4094)}\nfont-size = 20\n`, { terminalFontSize: 18 }],
    ['comment-limit-control', `font-size = 18\n#${'x'.repeat(4093)}\nfont-size = 20\n`, { terminalFontSize: 20 }],
    ['leading-dot-percent', 'adjust-cell-height = .5%\n', { terminalLineHeight: 1.005 }],
    ['trailing-dot-percent', 'adjust-cell-height = 14.%\n', { terminalLineHeight: 1.14 }],
    ['percent-spelling-control', 'adjust-cell-height = 0.5%\n', { terminalLineHeight: 1.005 }],
    ['quoted-cr-nan', 'font-size = 18\nfont-size = "nan\r"\n', { terminalFontSize: 18 }],
  ])('%s', (_name, content, patch) => {
    expect(map(content).patch).toEqual(patch)
  })

  it('controls — r1~r3 매핑 10 사례 · D19 고정 5 경계', () => {
    const oldCases: Array<[string, ReturnType<typeof mapGhosttyToCorral>['patch']]> = [
      ['palette=1=#fff\npalette=\npalette=2=#abc', { terminalColorOverrides: { green: '#abc' } }],
      ['font-size=18\nfont-size=nope', { terminalFontSize: 18 }],
      ['background=#111111\nbackground=" #abcdef "', { terminalColorOverrides: { background: '#abcdef' } }],
      ['background=#111111\nbackground=" red "', {}],
      ['adjust-cell-height=20%\nadjust-cell-height=1_0', {}],
      ['adjust-cell-height=20%\nadjust-cell-height=2147483648', { terminalLineHeight: 1.2 }],
      ['palette=0=#111111\npalette=-0=#abcdef', { terminalColorOverrides: { black: '#abcdef' } }],
      ['palette=1=#111111\npalette=0__1=#abcdef', { terminalColorOverrides: { red: '#abcdef' } }],
      ['font-family=Menlo\nfont-family=" "\nfont-family=Monaco', { terminalFontFamily: 'Menlo' }],
      ['palette=1=#111111\npalette=" "', { terminalColorOverrides: { red: '#111111' } }],
    ]
    for (const [content, patch] of oldCases) expect(map(content).patch).toEqual(patch)
    for (const [value, want] of [['-3', 0.15], ['0.05', 0.15], ['0.15', 0.15], ['0.7', 0.7], ['1.5', 1]] satisfies Array<[string, number]>) {
      expect(map(`unfocused-split-opacity=${value}`).patch.terminalInactivePaneOpacity).toBe(want)
    }
    expect(map('font-family=" Menlo "\nfont-family=Monaco').patch.terminalFontFamily).toBeUndefined()
  })

  it('R4-01 줄 바깥은 space·tab·CR, 키·값은 space·tab 만 — NBSP·세로 탭·폼 피드·안쪽 CR 은 남는다', () => {
    expect([...parseGhosttyConfig(' \t\rfont-size\t=\t14 \r\r\n')]).toEqual([['font-size', ['14']]])
    expect(parseGhosttyConfig('background =\u00a0#222222').get('background')).toEqual(['\u00a0#222222'])
    expect(parseGhosttyConfig('font-size =\r20').get('font-size')).toEqual(['\r20'])
    expect(parseGhosttyConfig('font-size = 20\v').get('font-size')).toEqual(['20\v'])
    expect(parseGhosttyConfig('\u00a0font-size = 20').get('\u00a0font-size')).toEqual(['20'])
    expect(parseGhosttyConfig('\u00a0# not a comment = x').get('\u00a0# not a comment')).toEqual(['x'])
    expect(parseGhosttyConfig('font-family = " Menlo "').get('font-family')).toEqual([' Menlo '])
    expect(parseGhosttyConfig('font-size = "nan\r"\r\n').get('font-size')).toEqual(['nan\r'])
  })

  it('R4-02 4094바이트 통과 · 4095바이트에서 그 파일 읽기 중단(주석·공백·CR 도 바이트로 센다)', () => {
    expect(MAX_LINE_BYTES).toBe(4094)
    const file = (content: string): ReturnType<typeof parseGhosttyFile> => parseGhosttyFile(Buffer.from(content, 'utf8'))
    const valueLine = (bytes: number): string => `font-size = 2${' '.repeat(bytes - 'font-size = 2'.length)}`
    expect(file(`${valueLine(4094)}\nbackground=#111111`)).toEqual({ config: new Map([['font-size', ['2']], ['background', ['#111111']]]), stoppedAtLine: null })
    expect(file(`font-size=18\n${valueLine(4095)}\nbackground=#111111`)).toEqual({ config: new Map([['font-size', ['18']]]), stoppedAtLine: 2 })
    expect(file(`font-size=18\n#${'x'.repeat(4093)}\r\nfont-size=20`)).toEqual({ config: new Map([['font-size', ['18']]]), stoppedAtLine: 2 })
    expect(file(`font-size=18\n\n${' '.repeat(4095)}\nfont-size=20`).stoppedAtLine).toBe(3)
    expect(file(`font-size=18\n#${'x'.repeat(4094)}`).stoppedAtLine).toBe(2)
  })

  it('R4-02 멀티바이트 문자가 경계에 걸친 줄 — 글자 수가 아니라 UTF-8 바이트로 센다', () => {
    const file = (content: string): ReturnType<typeof parseGhosttyFile> => parseGhosttyFile(Buffer.from(content, 'utf8'))
    // '가' = 3바이트. 4091 + 3 = 4094(통과), 4092 + 3 = 4095(중단 — 글자 수로는 4093 이라 문자열 길이로 세면 통과로 잘못 본다).
    expect(file(`#${'x'.repeat(4090)}가\nfont-size=20`)).toEqual({ config: new Map([['font-size', ['20']]]), stoppedAtLine: null })
    expect(file(`#${'x'.repeat(4091)}가\nfont-size=20`)).toEqual({ config: new Map(), stoppedAtLine: 1 })
    expect(`#${'x'.repeat(4091)}가`.length).toBe(4093)
    expect(file(`font-family = ${'가'.repeat(1360)}\nfont-size=20`).stoppedAtLine).toBe(null)
    expect(file(`font-family = ${'가'.repeat(1361)}\nfont-size=20`).stoppedAtLine).toBe(1)
  })

  it('BOM — 구성 파일만 건너뛴다(Config.loadReader), 줄 파서 자체는 BOM 을 키의 일부로 둔다(테마 파일 = loadTheme)', () => {
    const bom = Buffer.from('\ufefffont-size=18\n', 'utf8')
    expect([...parseGhosttyFile(skipUtf8Bom(bom)).config]).toEqual([['font-size', ['18']]])
    expect([...parseGhosttyFile(bom).config]).toEqual([['\ufefffont-size', ['18']]])
    expect(skipUtf8Bom(Buffer.from('font-size=18'))).toEqual(Buffer.from('font-size=18'))
    expect(skipUtf8Bom(Buffer.from([0xef, 0xbb]))).toEqual(Buffer.from([0xef, 0xbb]))
  })

  it('R4-03 백분율 .5%·14.%·-.5%·+14.% 는 같은 십진수(-.5% 는 -0.5% 와 같이 1~3 배 범위 밖 사유), 천분율 초과 정밀도는 거부 유지', () => {
    expect(map('adjust-cell-height=.5%').patch.terminalLineHeight).toBe(1.005)
    expect(map('adjust-cell-height=14.%').patch.terminalLineHeight).toBe(1.14)
    expect(map('adjust-cell-height=-.5%')).toEqual(map('adjust-cell-height=-0.5%'))
    expect(map('adjust-cell-height=+14.%').patch.terminalLineHeight).toBe(1.14)
    expect(map('adjust-cell-height=.0%').patch.terminalLineHeight).toBe(1)
    for (const value of ['.25%', '14.25%', '33.3333%']) expect(map(`adjust-cell-height=${value}`).patch.terminalLineHeight).toBeUndefined()
    for (const value of ['1e1%', '0x1p3%', 'inf%', 'nan%']) expect(reasonsOf({ content: `adjust-cell-height=${value}`, key: 'adjust-cell-height' })).toEqual(['10진 소수 표기만 옮김 (Ghostty 는 받는 지수·16진·inf·nan·밑줄 표기는 지원하지 않음)'])
  })
})

describe('기본 에이전트 칸 (LIFE-515 K1ⓓ)', () => {
  it('Ghostty 가져오기는 defaultAgent 칸을 건드리지 않는다 — 지원 키 전부 + 비슷한 이름의 키를 넣어도 패치에 없다', () => {
    const result = map('font-size = 16\nfont-family = Menlo\ncursor-style = bar\ncursor-style-blink = false\ntheme = Dracula\nbackground = #101010\npalette = 1=#ff0000\nadjust-cell-height = 10%\nunfocused-split-opacity = 0.8\nsplit-divider-color = #222222\ndefault-agent = codex\ndefaultAgent = codex\n')
    expect(Object.keys(result.patch)).not.toContain('defaultAgent')
    expect(result.patch.terminalFontSize).toBe(16)
  })
})

describe('확인 대화상자 칸 (LIFE-516 K1ⓓ)', () => {
  it('Ghostty 가져오기는 확인 칸 셋을 건드리지 않는다 — 지원 키 전부 + 같은 이름의 키를 넣어도 패치에 없다', () => {
    const result = map('font-size = 16\nfont-family = Menlo\ncursor-style = bar\ncursor-style-blink = false\ntheme = Dracula\nbackground = #101010\npalette = 1=#ff0000\nadjust-cell-height = 10%\nunfocused-split-opacity = 0.8\nsplit-divider-color = #222222\nconfirm-close-surface = false\nconfirmClosePinnedTab = false\nskipCloseTerminalWithRunningProcessConfirm = true\nskipDeleteWorktreeConfirm = true\n')
    for (const key of ['confirmClosePinnedTab', 'skipCloseTerminalWithRunningProcessConfirm', 'skipDeleteWorktreeConfirm']) expect(Object.keys(result.patch)).not.toContain(key)
    expect(result.patch.terminalFontSize).toBe(16)
  })
})
