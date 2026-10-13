// VS Code 와 같은 토큰 색 (LIFE-590 E4ⓑ — D10 B) — VS Code 1.142 TextMate 문법·Dark 2026 테마(`assets/textmate/`, `scripts/l590/tm-import.mjs` 반입)를
// TextMate 엔진(`@shikijs/vscode-textmate` — vscode-textmate 포크)으로 토큰화한다. 정규식은 **JS 엔진**(`@shikijs/engine-javascript` — Oniguruma 패턴을
// JS RegExp 로 옮긴다)이라 WASM 이 없다 → CSP 무변경(`wasm-unsafe-eval` 불필요 — E7ⓔ). VS Code 는 같은 문법을 vscode-oniguruma(WASM)로 돈다 —
// 엔진 차이로 색이 갈리는지는 E4ⓑ 자동 대조(`scripts/l590/token-colors.mjs` 의 기대 색 = vscode-textmate + oniguruma)가 잰다.
//
// Monaco 에는 **색 번호로 이름 붙인 토큰**을 준다: TextMate 메타데이터의 전경 색 번호 n·글꼴 모양 f → 토큰 `c<n>` / `c<n>.<f>`.
// 테마 규칙도 같은 이름으로 그 색 하나씩이라(`monacoRules`), Monaco 의 규칙 매칭(점 접두사)이 끼어들 여지 없이 TextMate 가 고른 색이 그대로 칠해진다.
// 이 파일은 Monaco 를 import 하지 않는다 — 단위 시험이 node 에서 토큰화만 잰다.
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { EncodedTokenMetadata, INITIAL, Registry, type IGrammar, type IRawGrammar, type IRawTheme, type StateStack } from '@shikijs/vscode-textmate'
import languagesJson from '../assets/textmate/languages.json'
import themeJson from '../assets/textmate/dark-2026.json'

type LanguageRow = { id: string; scopeName: string; extensions: string[]; filenames: string[]; configuration?: string }
type GrammarRow = { scopeName: string; file: string; injectTo: string[]; tokenTypes: Record<string, string | undefined>; balancedBracketScopes: string[] | null; unbalancedBracketScopes: string[] | null }

const LANGUAGES: LanguageRow[] = languagesJson.languages
const GRAMMARS: GrammarRow[] = languagesJson.grammars

/** 문법 파일 지연 로더 — 언어를 처음 쓸 때 그 JSON 청크만 내려받는다(번들 분리, E8ⓒ). */
const grammarLoaders = import.meta.glob<IRawGrammar>('../assets/textmate/grammars/*.json', { import: 'default' })

/** 테마 원본(VS Code `ColorThemeData.tokenColors` 순서) — 기대 색 계산 스크립트도 같은 파일을 읽는다. */
export const DARK_2026: { settings: IRawTheme['settings']; colors: Record<string, string> } = { settings: themeJson.settings as IRawTheme['settings'], colors: themeJson.colors }

/**
 * 파일 경로 → 언어 id. VS Code 처럼 **파일 이름 표가 먼저**, 그다음 확장자(가장 긴 일치 — `.d.ts` 같은 겹 확장자 대비). 모르면 null(= 일반 텍스트, E4ⓑ).
 * VS Code 의 `filenamePatterns`(glob)·첫 줄(`#!`) 판정은 반입하지 않았다 — 차이로 기록(E9).
 */
export function languageOf(rel: string): { id: string; scopeName: string; configuration: string | null } | null {
  const name = rel.split('/').pop() ?? rel
  const lower = name.toLowerCase()
  const byName = LANGUAGES.find((row) => row.filenames.includes(name))
  if (byName !== undefined) return { id: byName.id, scopeName: byName.scopeName, configuration: byName.configuration ?? null }
  let best: LanguageRow | null = null
  let bestLength = 0
  for (const row of LANGUAGES) {
    for (const ext of row.extensions) {
      if (lower.endsWith(ext) && ext.length > bestLength) {
        best = row
        bestLength = ext.length
      }
    }
  }
  return best === null ? null : { id: best.id, scopeName: best.scopeName, configuration: best.configuration ?? null }
}

export type TextMate = {
  /** 그 scopeName 문법(주입·내장 문법 포함)을 싣는다. 없으면 null. */
  grammar: (scopeName: string) => Promise<IGrammar | null>
  /** TextMate 색 번호 → `#rrggbb` (0 은 비어 있다). */
  colorMap: string[]
}

/** 문법 JSON 안의 바깥 문법 참조(`include: "source.css"`·`"source.css#rule"`) — 미리 실을 의존 문법. `#`·`$self`·`$base` 는 제 문법 안이다. */
export function grammarDependencies(raw: unknown): string[] {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (key === 'include' && typeof item === 'string' && !item.startsWith('#') && !item.startsWith('$')) found.add(item.split('#')[0] ?? item)
      else walk(item)
    }
  }
  walk(raw)
  return [...found]
}

/**
 * 한 레지스트리 — 앱 수명 동안 하나(문법 캐시). 이 엔진 포크는 **동기**라(문법 로더·onigLib 가 Promise 를 받지 않는다) 쓰기 전에 그 문법과
 * 의존 문법(include·주입)을 전부 미리 싣고 나서 `loadGrammar` 를 부른다. `loadRaw` 는 시험이 바꿔 끼운다.
 */
export function createTextMate(input: { loadRaw?: (scopeName: string) => Promise<IRawGrammar | null> } = {}): TextMate {
  const loadRaw =
    input.loadRaw ??
    (async (scopeName: string): Promise<IRawGrammar | null> => {
      const row = GRAMMARS.find((item) => item.scopeName === scopeName)
      const loader = row === undefined ? undefined : grammarLoaders[`../assets/textmate/grammars/${row.file}`]
      return loader === undefined ? null : loader()
    })
  const raws = new Map<string, IRawGrammar | null>()
  const injectionsOf = (scopeName: string): string[] => GRAMMARS.filter((row) => row.injectTo.includes(scopeName)).map((row) => row.scopeName)
  const prefetch = async (scopeName: string): Promise<void> => {
    if (raws.has(scopeName)) return
    raws.set(scopeName, null)
    const raw = await loadRaw(scopeName)
    raws.set(scopeName, raw)
    if (raw === null) return
    await Promise.all([...grammarDependencies(raw), ...injectionsOf(scopeName)].map((dependency) => prefetch(dependency)))
  }
  // forgiving — JS 로 못 옮기는 패턴 하나 때문에 문법 전체가 죽지 않게 그 패턴만 빠진다(그 자리 색 차이는 E4ⓑ 대조가 드러낸다).
  const engine = createJavaScriptRegexEngine({ forgiving: true })
  const registry = new Registry({
    // 엔진 → vscode-textmate `IOnigLib` (shiki core 와 같은 어댑터).
    onigLib: { createOnigScanner: (patterns) => engine.createScanner(patterns), createOnigString: (text) => engine.createString(text) },
    theme: { name: 'Dark 2026', settings: DARK_2026.settings },
    loadGrammar: (scopeName) => raws.get(scopeName) ?? null,
    getInjections: injectionsOf,
  })
  return {
    grammar: async (scopeName) => {
      await prefetch(scopeName)
      if (raws.get(scopeName) === null) return null
      // VS Code `TMGrammarFactory` 와 같이 문법 기여의 tokenTypes(문자열·주석 판정 덮어쓰기)·괄호 scope 를 같이 넘긴다.
      const row = GRAMMARS.find((item) => item.scopeName === scopeName)
      const tokenTypes = Object.fromEntries(Object.entries(row?.tokenTypes ?? {}).map(([selector, type]) => [selector, type === 'comment' ? 1 : type === 'string' ? 2 : type === 'regex' ? 3 : 0]))
      return registry.loadGrammarWithConfiguration(scopeName, 1, {
        tokenTypes,
        ...(row?.balancedBracketScopes ? { balancedBracketSelectors: row.balancedBracketScopes } : {}),
        ...(row?.unbalancedBracketScopes ? { unbalancedBracketSelectors: row.unbalancedBracketScopes } : {}),
      })
    },
    colorMap: registry.getColorMap(),
  }
}

/** VS Code `editor.maxTokenizationLineLength` 기본 20000 — 넘는 줄은 토큰화하지 않는다(같은 값). */
export const MAX_TOKENIZATION_LINE_LENGTH = 20_000
/** 한 줄 토큰화 시간 상한 — VS Code TextMate 토큰화와 같은 500 ms. */
const TIME_LIMIT_MS = 500

export type LineTokens = { endState: StateStack; tokens: { startIndex: number; scopes: string }[] }

/**
 * 한 줄 → Monaco 토큰. 이름은 `c<전경 색 번호>[.<글꼴 모양 비트>][.comment|.string|.regex]`.
 * 꼬리의 종류 낱말은 Monaco 가 토큰 이름에서 읽는 표준 종류(`toStandardTokenType`) — 괄호 짝·괄호 색이 문자열·주석 안 괄호를 건너뛰게(VS Code 는 메타데이터로 같은 것을 한다).
 * 색 규칙은 `c<n>` / `c<n>.<f>` 에만 있고 Monaco 규칙 매칭은 점 접두사라 꼬리가 색을 바꾸지 않는다.
 */
export function tokenizeLine(input: { grammar: IGrammar; line: string; state: StateStack }): LineTokens {
  if (input.line.length >= MAX_TOKENIZATION_LINE_LENGTH) return { endState: input.state, tokens: [{ startIndex: 0, scopes: '' }] }
  const result = input.grammar.tokenizeLine2(input.line, input.state, TIME_LIMIT_MS)
  const tokens: { startIndex: number; scopes: string }[] = []
  for (let index = 0; index < result.tokens.length; index += 2) {
    const metadata = result.tokens[index + 1] ?? 0
    const foreground = EncodedTokenMetadata.getForeground(metadata)
    const fontStyle = EncodedTokenMetadata.getFontStyle(metadata)
    const type = EncodedTokenMetadata.getTokenType(metadata)
    const kind = type === 1 ? '.comment' : type === 2 ? '.string' : type === 3 ? '.regex' : ''
    tokens.push({ startIndex: result.tokens[index] ?? 0, scopes: `${fontStyle > 0 ? `c${foreground}.${fontStyle}` : `c${foreground}`}${kind}` })
  }
  return { endState: result.ruleStack, tokens }
}

export { INITIAL }

/** 글꼴 모양 비트(TextMate `FontStyle`: 1 italic · 2 bold · 4 underline · 8 strikethrough) → Monaco 규칙 `fontStyle` 글. */
export function fontStyleText(bits: number): string {
  return [bits & 1 ? 'italic' : '', bits & 2 ? 'bold' : '', bits & 4 ? 'underline' : '', bits & 8 ? 'strikethrough' : ''].filter((part) => part.length > 0).join(' ')
}

/** Monaco 테마 규칙 — 색 번호마다 `c<n>` 과 글꼴 모양 15 가지 `c<n>.<f>`. 기본(이름 없는 토큰)은 테마 첫 규칙의 전경. */
export function monacoRules(colorMap: string[]): { token: string; foreground?: string; fontStyle?: string }[] {
  const strip = (color: string | undefined): string | undefined => (color === undefined ? undefined : color.replace(/^#/, '').slice(0, 6))
  const rules: { token: string; foreground?: string; fontStyle?: string }[] = [{ token: '', foreground: strip(colorMap[1]) }]
  for (let index = 1; index < colorMap.length; index += 1) {
    const foreground = strip(colorMap[index])
    rules.push({ token: `c${index}`, foreground })
    for (let bits = 1; bits < 16; bits += 1) rules.push({ token: `c${index}.${bits}`, foreground, fontStyle: fontStyleText(bits) })
  }
  return rules
}
