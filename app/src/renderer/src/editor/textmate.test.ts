// LIFE-590 E4ⓑ — TextMate 토큰화(JS 정규식 엔진) 단위. 전체 10개 언어 토큰 위치별 대조는 최종 관문(`scripts/l590/token-colors.mjs`)이 한다 —
// 여기서는 연결(문법 지연 로드·의존 문법·주입·색 번호 이름·테마 규칙)이 맞는지만 본다.
import { describe, expect, it } from 'vitest'
import { createTextMate, DARK_2026, fontStyleText, grammarDependencies, INITIAL, languageOf, monacoRules, tokenizeLine } from './textmate.js'

/** 테마에서 그 scope 하나에 직접 걸린 마지막 규칙의 전경(이 시험이 고른 단순 scope 에만 쓴다). */
const themeColorOf = (scope: string): string | undefined =>
  [...DARK_2026.settings].reverse().find((rule) => (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).includes(scope))?.settings.foreground?.toLowerCase()

describe('languageOf — 파일 이름 표 먼저, 그다음 가장 긴 확장자', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/A.TSX', 'typescriptreact'],
    ['x.mjs', 'javascript'],
    ['package.json', 'json'],
    ['.babelrc', 'jsonc'],
    ['README.md', 'markdown'],
    ['a/b/style.css', 'css'],
    ['index.html', 'html'],
    ['ci.yml', 'yaml'],
    ['run.sh', 'shellscript'],
    ['.zshrc', 'shellscript'],
    ['main.py', 'python'],
    ['Dockerfile', 'dockerfile'],
    ['Makefile', 'makefile'],
  ])('%s → %s', (rel, id) => {
    expect(languageOf(rel)?.id).toBe(id)
  })
  it('모르는 확장자·확장자 없는 이름 = null(일반 텍스트)', () => {
    expect(languageOf('notes.unknownext')).toBeNull()
    expect(languageOf('LICENSE')).toBeNull()
  })
})

describe('토큰화 → 색 번호 토큰', () => {
  it('TypeScript — 키워드·문자열·숫자가 테마 색으로, 이름은 c<n>', async () => {
    const tm = createTextMate()
    const grammar = await tm.grammar('source.ts')
    expect(grammar).not.toBeNull()
    const line = "const greeting = 'hi' + 42"
    const { tokens } = tokenizeLine({ grammar: grammar!, line, state: INITIAL })
    const colorAt = (text: string): string | undefined => {
      const at = line.indexOf(text)
      const token = [...tokens].reverse().find((item) => item.startIndex <= at)
      const index = Number(token?.scopes.split('.')[0]?.slice(1))
      return tm.colorMap[index]?.toLowerCase()
    }
    expect(colorAt("'hi'")).toBe(themeColorOf('string'))
    expect(colorAt('42')).toBe(themeColorOf('constant.numeric'))
    expect(colorAt('const')).not.toBe(tm.colorMap[1]?.toLowerCase())
    for (const token of tokens) expect(token.scopes).toMatch(/^c\d+(\.\d+)?(\.(comment|string|regex))?$/)
    // 문자열 토큰은 표준 종류 `string` 꼬리를 단다(괄호 짝이 문자열 안을 건너뛰는 근거)
    expect([...tokens].reverse().find((token) => token.startIndex <= line.indexOf("'hi'") + 1)?.scopes).toMatch(/\.string$/)
    expect(tokens[0]?.scopes).not.toMatch(/\.string$/)
  })
  it('Markdown 펜스 안 TypeScript 도 칠해진다(의존 문법 미리 싣기)', async () => {
    const tm = createTextMate()
    const grammar = await tm.grammar('text.html.markdown')
    let state = INITIAL
    const lines = ['```ts', "const x = 'y'", '```']
    const colors: string[] = []
    for (const line of lines) {
      const result = tokenizeLine({ grammar: grammar!, line, state })
      state = result.endState
      colors.push(...result.tokens.map((token) => token.scopes))
    }
    expect(new Set(colors).size).toBeGreaterThan(3)
  })
  it('없는 문법 = null', async () => {
    expect(await createTextMate().grammar('source.nope')).toBeNull()
  })
  it('20000자 넘는 줄은 토큰화하지 않는다(VS Code maxTokenizationLineLength)', async () => {
    const grammar = await createTextMate().grammar('source.ts')
    expect(tokenizeLine({ grammar: grammar!, line: 'a'.repeat(20_000), state: INITIAL }).tokens).toEqual([{ startIndex: 0, scopes: '' }])
  })
})

describe('Monaco 규칙·보조 함수', () => {
  it('색 번호마다 c<n> + 글꼴 모양 15 가지', () => {
    const rules = monacoRules(['', '#AABBCC', '#112233'])
    expect(rules[0]).toEqual({ token: '', foreground: 'AABBCC' })
    expect(rules.find((rule) => rule.token === 'c2')).toEqual({ token: 'c2', foreground: '112233' })
    expect(rules.find((rule) => rule.token === 'c2.3')).toEqual({ token: 'c2.3', foreground: '112233', fontStyle: 'italic bold' })
    expect(rules.length).toBe(1 + 2 * 16)
  })
  it('fontStyleText', () => {
    expect(fontStyleText(0)).toBe('')
    expect(fontStyleText(1 | 8)).toBe('italic strikethrough')
  })
  it('grammarDependencies — 바깥 scope 만', () => {
    expect(grammarDependencies({ patterns: [{ include: '#x' }, { include: '$self' }, { include: 'source.css' }, { include: 'source.js#expr' }] }).sort()).toEqual(['source.css', 'source.js'])
  })
})
