// VS Code 와 같은 토큰 색 (LIFE-590 E4ⓑ — D10 B) — VS Code 1.142 TextMate 문법·Dark 2026 테마(`assets/textmate/`, `scripts/l590/tm-import.mjs` 반입)를
// TextMate 엔진(`@shikijs/vscode-textmate` — vscode-textmate 포크)으로 토큰화한다. 정규식은 **JS 엔진**(`@shikijs/engine-javascript` — Oniguruma 패턴을
// JS RegExp 로 옮긴다)이라 WASM 이 없다 → CSP 무변경(`wasm-unsafe-eval` 불필요 — E7ⓔ). VS Code 는 같은 문법을 vscode-oniguruma(WASM)로 돈다 —
// 엔진 차이로 색이 갈리는지는 E4ⓑ 자동 대조(`scripts/l590/token-colors.mjs` 의 기대 색 = vscode-textmate + oniguruma)가 잰다.
//
// Monaco 에는 **TextMate 이진 토큰을 그대로** 준다(`tokenizeEncoded` — VS Code 와 같은 길): 메타데이터 = 언어 id·표준 종류(주석·문자열·정규식)·
// 균형 괄호 비트·글꼴 모양·전경/바탕 색 번호. 색 번호는 TextMate 색표 번호이고 Monaco 테마에 같은 색표를 `encodedTokensColors` 로 줘서 번호가 맞는다
// (`monaco.ts`). 문자열 토큰 경로는 Monaco 가 균형 괄호 비트를 늘 켜서 문법의 `unbalancedBracketScopes`(`=>` 의 `>` 등)가 사라지고 괄호쌍 색이
// 짝 없는 괄호(빨강)를 칠했다 — E4ⓑ 자동 대조로 찾은 차이(2026-10-13).
// 이 파일은 Monaco 를 import 하지 않는다 — 단위 시험이 node 에서 토큰화만 잰다.
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { INITIAL, Registry, type IGrammar, type IRawGrammar, type IRawTheme, type StateStack } from '@shikijs/vscode-textmate'
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
  /** 그 scopeName 문법(주입·내장 문법 포함)을 싣는다. `languageId` = 토큰 메타데이터에 실을 언어 번호(Monaco 의 인코딩 언어 id). 없으면 null. */
  grammar: (input: { scopeName: string; languageId: number }) => Promise<IGrammar | null>
  /** TextMate 색 번호 → `#rrggbb` (0 은 비어 있다). */
  colorMap: string[]
}

/**
 * Oniguruma 전용 표기 `\x{85 2028 2029}`(한 이스케이프에 코드포인트 여럿 = 그 글자들을 잇달아 쓴 것)를 `\x{85}\x{2028}\x{2029}` 로 푼다 — 뜻이 같다
 * (문자 클래스 안이면 각 글자가 멤버, 밖이면 글자 열). JS 정규식 엔진(oniguruma-to-es)이 이 표기를 못 옮겨 YAML 문법 패턴 145 개가 조용히 빠지고
 * 거의 모든 줄이 `invalid.illegal` 이 됐다(E4ⓑ 자동 대조로 찾음 — 2026-10-13). 반입한 문법 파일은 VS Code 원본 그대로 두고 **로드할 때** 고친다.
 * 앞에 홀수 개 `\` 가 있으면(글자 `\` 뒤의 x) 건드리지 않는다.
 */
export function normalizeOnigPattern(pattern: string): string {
  return pattern.replace(/(?<!\\)((?:\\\\)*)\\x\{([0-9A-Fa-f]+(?:[ \t]+[0-9A-Fa-f]+)+)\}/g, (_whole, slashes: string, list: string) =>
    slashes + list.split(/[ \t]+/).map((hex) => `\\x{${hex}}`).join(''),
  )
}

/** 문법 JSON 의 정규식 칸(match·begin·end·while)마다 `normalizeOnigPattern` — 원본은 건드리지 않고 고친 사본을 돌려준다. */
export function normalizeGrammar(raw: IRawGrammar): IRawGrammar {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['match', 'begin', 'end', 'while'].includes(key) && typeof item === 'string' ? normalizeOnigPattern(item) : walk(item)]))
  }
  const copy = walk(raw)
  return isRawGrammar(copy) ? copy : raw
}

function isRawGrammar(value: unknown): value is IRawGrammar {
  return value !== null && typeof value === 'object' && 'scopeName' in value && 'patterns' in value
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
    const loaded = await loadRaw(scopeName)
    const raw = loaded === null ? null : normalizeGrammar(loaded)
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
    grammar: async ({ scopeName, languageId }) => {
      await prefetch(scopeName)
      if (raws.get(scopeName) === null) return null
      // VS Code `TMGrammarFactory` 와 같이 문법 기여의 tokenTypes(문자열·주석 판정 덮어쓰기)·괄호 scope 를 같이 넘긴다.
      const row = GRAMMARS.find((item) => item.scopeName === scopeName)
      const tokenTypes = Object.fromEntries(Object.entries(row?.tokenTypes ?? {}).map(([selector, type]) => [selector, type === 'comment' ? 1 : type === 'string' ? 2 : type === 'regex' ? 3 : 0]))
      return registry.loadGrammarWithConfiguration(scopeName, languageId, {
        tokenTypes,
        // VS Code `TextMateTokenizationFeature` 와 같은 기본값 — 균형 괄호 scope 가 없으면 전부(`*`), 균형 아님은 없음.
        balancedBracketSelectors: row?.balancedBracketScopes ?? ['*'],
        unbalancedBracketSelectors: row?.unbalancedBracketScopes ?? [],
      })
    },
    colorMap: registry.getColorMap(),
  }
}

/** VS Code `editor.maxTokenizationLineLength` 기본 20000 — 넘는 줄은 토큰화하지 않는다(같은 값). */
export const MAX_TOKENIZATION_LINE_LENGTH = 20_000
/** 한 줄 토큰화 시간 상한 — VS Code TextMate 토큰화와 같은 500 ms. */
const TIME_LIMIT_MS = 500

export type LineTokens = { endState: StateStack; tokens: Uint32Array }

/** Monaco `nullTokenizeEncoded` 과 같은 한 토큰 — 기본 전경(1)·바탕(2), 종류 Other. 토큰화하지 않는 긴 줄에 쓴다. */
export function plainMetadata(languageId: number): number {
  return (languageId | (1 << 15) | (2 << 24)) >>> 0
}

/** 한 줄 → TextMate 이진 토큰 `[시작, 메타데이터, …]`. 메타데이터 비트 배치는 vscode-textmate 와 Monaco 가 같다(`EncodedTokenMetadata`). */
export function tokenizeLine(input: { grammar: IGrammar; line: string; state: StateStack; languageId: number }): LineTokens {
  if (input.line.length >= MAX_TOKENIZATION_LINE_LENGTH) return { endState: input.state, tokens: new Uint32Array([0, plainMetadata(input.languageId)]) }
  const result = input.grammar.tokenizeLine2(input.line, input.state, TIME_LIMIT_MS)
  return { endState: result.ruleStack, tokens: result.tokens }
}

export { INITIAL }
