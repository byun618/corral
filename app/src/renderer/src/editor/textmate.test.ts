// LIFE-590 E4ⓑ — TextMate 토큰화(JS 정규식 엔진) 단위. 전체 10개 언어 토큰 위치별 대조는 최종 관문(`scripts/l590/token-colors.mjs`)이 한다 —
// 여기서는 연결(문법 지연 로드·의존 문법·주입·이진 토큰 메타데이터·정규식 변환)이 맞는지만 본다.
import { describe, expect, it } from 'vitest'
import { EncodedTokenMetadata, type IRawGrammar } from '@shikijs/vscode-textmate'
import fs from 'node:fs'
import path from 'node:path'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import languagesJson from '../assets/textmate/languages.json'
import { createTextMate, DARK_2026, grammarDependencies, INITIAL, languageOf, normalizeGrammar, normalizeOnigPattern, plainMetadata, tokenizeLine } from './textmate.js'

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

describe('토큰화 → TextMate 이진 토큰', () => {
  const LANGUAGE = 7
  /** 그 글자 위치를 덮는 토큰의 메타데이터. */
  const metadataAt = (tokens: Uint32Array, at: number): number => {
    let found = tokens[1] ?? 0
    for (let index = 0; index < tokens.length; index += 2) if ((tokens[index] ?? 0) <= at) found = tokens[index + 1] ?? 0
    return found
  }
  it('TypeScript — 키워드·문자열·숫자가 테마 색, 메타데이터에 언어 id·문자열 종류', async () => {
    const tm = createTextMate()
    const grammar = await tm.grammar({ scopeName: 'source.ts', languageId: LANGUAGE })
    expect(grammar).not.toBeNull()
    const line = "const greeting = 'hi' + 42"
    const { tokens } = tokenizeLine({ grammar: grammar!, line, state: INITIAL, languageId: LANGUAGE })
    const colorAt = (text: string): string | undefined => tm.colorMap[EncodedTokenMetadata.getForeground(metadataAt(tokens, line.indexOf(text)))]?.toLowerCase()
    expect(colorAt("'hi'")).toBe(themeColorOf('string'))
    expect(colorAt('42')).toBe(themeColorOf('constant.numeric'))
    expect(colorAt('const')).not.toBe(tm.colorMap[1]?.toLowerCase())
    for (let index = 1; index < tokens.length; index += 2) expect(EncodedTokenMetadata.getLanguageId(tokens[index] ?? 0)).toBe(LANGUAGE)
    // 문자열 안은 표준 종류 String(2) — 괄호 짝이 문자열 안을 건너뛰는 근거
    expect(EncodedTokenMetadata.getTokenType(metadataAt(tokens, line.indexOf("'hi'") + 1))).toBe(2)
    expect(EncodedTokenMetadata.getTokenType(metadataAt(tokens, 0))).toBe(0)
  })
  it('`=>` 의 `>` 는 균형 괄호가 아니다(문법 unbalancedBracketScopes) — `(` 는 균형 괄호', async () => {
    const grammar = await createTextMate().grammar({ scopeName: 'source.ts', languageId: LANGUAGE })
    const line = 'const f = (x) => x >= 1'
    const { tokens } = tokenizeLine({ grammar: grammar!, line, state: INITIAL, languageId: LANGUAGE })
    expect(EncodedTokenMetadata.containsBalancedBrackets(metadataAt(tokens, line.indexOf('=>') + 1))).toBe(false)
    expect(EncodedTokenMetadata.containsBalancedBrackets(metadataAt(tokens, line.indexOf('>=')))).toBe(false)
    expect(EncodedTokenMetadata.containsBalancedBrackets(metadataAt(tokens, line.indexOf('(')))).toBe(true)
  })
  it('Markdown 펜스 안 TypeScript 도 칠해진다(의존 문법 미리 싣기)', async () => {
    const tm = createTextMate()
    const grammar = await tm.grammar({ scopeName: 'text.html.markdown', languageId: LANGUAGE })
    let state = INITIAL
    const colors = new Set<number>()
    for (const line of ['```ts', "const x = 'y'", '```']) {
      const result = tokenizeLine({ grammar: grammar!, line, state, languageId: LANGUAGE })
      state = result.endState
      for (let index = 1; index < result.tokens.length; index += 2) colors.add(EncodedTokenMetadata.getForeground(result.tokens[index] ?? 0))
    }
    expect(colors.size).toBeGreaterThan(3)
  })
  it('없는 문법 = null', async () => {
    expect(await createTextMate().grammar({ scopeName: 'source.nope', languageId: LANGUAGE })).toBeNull()
  })
  it('20000자 넘는 줄은 토큰화하지 않는다(VS Code maxTokenizationLineLength) — 기본 색 한 토큰', async () => {
    const grammar = await createTextMate().grammar({ scopeName: 'source.ts', languageId: LANGUAGE })
    expect([...tokenizeLine({ grammar: grammar!, line: 'a'.repeat(20_000), state: INITIAL, languageId: LANGUAGE }).tokens]).toEqual([0, plainMetadata(LANGUAGE)])
    expect(EncodedTokenMetadata.getForeground(plainMetadata(LANGUAGE))).toBe(1)
  })
})

describe('보조 함수', () => {
  it('grammarDependencies — 바깥 scope 만', () => {
    expect(grammarDependencies({ patterns: [{ include: '#x' }, { include: '$self' }, { include: 'source.css' }, { include: 'source.js#expr' }] }).sort()).toEqual(['source.css', 'source.js'])
  })
})

describe('Oniguruma → JS 정규식 변환 (E4ⓑ)', () => {
  it('`\\x{A B C}` 를 `\\x{A}\\x{B}\\x{C}` 로 — `\\\\x{…}`(글자 \\ 뒤 x)는 그대로', () => {
    expect(normalizeOnigPattern('[^\\x{85 2028 2029}\\r\\n]')).toBe('[^\\x{85}\\x{2028}\\x{2029}\\r\\n]')
    expect(normalizeOnigPattern('\\\\x{85 2028}')).toBe('\\\\x{85 2028}')
    expect(normalizeOnigPattern('\\x{41}')).toBe('\\x{41}')
  })
  // 남는 4 개(알려진 차이 — E9): JSON snippets 의 겹친 재귀 1 · YAML 블록 스칼라 머리(`|`·`>` 뒤 표시자)의 조건부 그룹 `(?(<chomp>)…)` 3.
  // forgiving 엔진에서는 그 패턴만 빠진다 — 색 차이는 E4ⓑ 대조(`e4b-tokens.mjs`)가 센다.
  it('반입 문법 36 개 전부 — 고친 뒤 엄격 모드 JS 엔진으로 컴파일 실패는 알려진 4 개뿐', () => {
    const strict = createJavaScriptRegexEngine({ forgiving: false })
    const base = path.resolve(import.meta.dirname, '../assets/textmate')
    const failures: string[] = []
    for (const row of languagesJson.grammars) {
      const raw = normalizeGrammar(JSON.parse(fs.readFileSync(path.join(base, 'grammars', row.file), 'utf8')))
      const patterns: string[] = []
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk)
        if (value === null || typeof value !== 'object') return
        for (const [key, item] of Object.entries(value)) {
          if (['match', 'begin', 'end', 'while'].includes(key) && typeof item === 'string') patterns.push(item)
          else walk(item)
        }
      }
      walk(raw)
      for (const pattern of patterns) {
        // end·while 의 역참조(\1)는 실행 때 채워진다 — 숫자 역참조를 글자로 바꿔 컴파일만 본다
        try {
          strict.createScanner([pattern.replace(/\\(\d+)/g, 'x')])
        } catch {
          failures.push(`${row.scopeName} ${pattern.slice(0, 80)}`)
        }
      }
    }
    expect(failures.map((failure) => failure.split(' ')[0])).toEqual(['source.json.comments.snippets', 'source.yaml.1.2', 'source.yaml.1.0', 'source.yaml.embedded'])
  })
})

describe('수정 r1 R1-D 문법 로드 상태 — 로딩 중·없음·완료', () => {
  const assets = path.resolve(import.meta.dirname, '../assets/textmate')
  const index: { grammars: { scopeName: string; file: string }[] } = JSON.parse(fs.readFileSync(path.join(assets, 'languages.json'), 'utf8'))
  const readReal = (scope: string): IRawGrammar | null => {
    const row = index.grammars.find((item) => item.scopeName === scope)
    return row === undefined ? null : JSON.parse(fs.readFileSync(path.join(assets, 'grammars', row.file), 'utf8'))
  }

  it('리뷰 grammar-real 조건 — Markdown 이 source.ts 를 싣는 동안 source.ts 를 요청해도 null 이 아니라 같은 완료를 기다린다', async () => {
    let release = (): void => undefined
    let entered = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const tm = createTextMate({
      loadRaw: async (scope) => {
        if (scope === 'source.ts') {
          entered()
          await gate
        }
        return readReal(scope)
      },
    })
    const markdown = tm.grammar({ scopeName: 'text.html.markdown', languageId: 1 })
    await inside
    const during = tm.grammar({ scopeName: 'source.ts', languageId: 2 })
    release()
    expect(await during).not.toBeNull()
    expect(await markdown).not.toBeNull()
  })

  const tiny: Record<string, IRawGrammar> = JSON.parse(
    JSON.stringify({
      outer: { scopeName: 'outer', patterns: [{ include: 'inner' }] },
      inner: { scopeName: 'inner', patterns: [{ name: 'string.quoted', match: 'hello' }, { begin: '\\(', end: '\\)', patterns: [{ include: 'outer' }] }] },
    }),
  )

  it('리뷰 grammar-repro 조건 — 병렬 로드(outer·inner)가 둘 다 성공하고 직렬과 같은 토큰(순환 include 포함)', async () => {
    const parallel = createTextMate({
      loadRaw: async (name) => {
        await new Promise((resolve) => setTimeout(resolve, name === 'inner' ? 80 : 1))
        return tiny[name] ?? null
      },
    })
    const [outer, inner] = await Promise.all([parallel.grammar({ scopeName: 'outer', languageId: 1 }), parallel.grammar({ scopeName: 'inner', languageId: 2 })])
    const serial = await createTextMate({ loadRaw: async (name) => tiny[name] ?? null }).grammar({ scopeName: 'outer', languageId: 1 })
    expect(outer?.tokenizeLine('hello', INITIAL).tokens).toEqual(serial?.tokenizeLine('hello', INITIAL).tokens)
    expect(inner?.tokenizeLine('hello', INITIAL).tokens[0]?.scopes).toContain('string.quoted')
  })

  it('읽기 실패는 캐시에 남지 않는다 — 다음 요청이 다시 싣는다 · 진짜 없는 문법은 null', async () => {
    let calls = 0
    const tm = createTextMate({
      loadRaw: async (name) => {
        if (name === 'inner' && (calls += 1) === 1) throw new Error('chunk load failed')
        return tiny[name] ?? null
      },
    })
    await expect(tm.grammar({ scopeName: 'inner', languageId: 1 })).rejects.toThrow('chunk load failed')
    expect(await tm.grammar({ scopeName: 'inner', languageId: 1 })).not.toBeNull()
    expect(await tm.grammar({ scopeName: 'missing', languageId: 1 })).toBeNull()
  })
})
