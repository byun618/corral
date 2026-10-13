// LIFE-590 E4ⓑ 토큰 색 자동 대조 — 기대 색 계산 + (corral DOM 색과) 글자 단위 대조.
// 기대 = VS Code 1.142 문법·Dark 2026 테마(`src/renderer/src/assets/textmate/` — tm-import 반입본)를 **VS Code 자신의 엔진**으로 토큰화한 색:
//   설치본 VS Code 의 `node_modules.asar` 에서 vscode-textmate·vscode-oniguruma(WASM)를 꺼내 쓴다 — corral 쪽 엔진(@shikijs 포크 + JS 정규식)과 독립.
//   (꺼낸 사본은 `/tmp/l590-oracle` — 사용자 VS Code 설치본은 읽기만 한다.) 테마 평탄화(dark_vs→…→2026-dark)는 tm-import 결과를 같이 쓴다 —
//   그 단계의 독립 확인은 E4ⓒ(설치본 VS Code DOM 색 나란히)가 맡는다.
// 실제 = corral 편집기 DOM 계산 색(`first-screen.mjs` 의 tokenSpans 와 같은 모양: 줄마다 [글, rgb(...), fontStyle][]).
//
// 사용(app/ 에서):
//   node scripts/l590/token-colors.mjs expect --file <샘플> [--out expected.json]
//   node scripts/l590/token-colors.mjs compare --expected expected.json --actual actual.json [--out diff.json]   (불일치 0 이면 exit 0)
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const ASSETS = path.resolve(import.meta.dirname, '../../src/renderer/src/assets/textmate')
const VSCODE_ASAR = '/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar'
const ORACLE = '/tmp/l590-oracle'
const require = createRequire(import.meta.url)

function extractOracle() {
  const asar = require('@electron/asar')
  const files = ['vscode-oniguruma/release/main.js', 'vscode-oniguruma/release/onig.wasm', 'vscode-oniguruma/package.json', 'vscode-textmate/release/main.js', 'vscode-textmate/package.json']
  for (const file of files) {
    const target = path.join(ORACLE, 'node_modules', file)
    if (fs.existsSync(target)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, asar.extractFile(VSCODE_ASAR, file))
  }
  const version = (name) => JSON.parse(fs.readFileSync(path.join(ORACLE, 'node_modules', name, 'package.json'), 'utf8')).version
  return { textmate: version('vscode-textmate'), oniguruma: version('vscode-oniguruma') }
}

/** corral `languageOf` 와 같은 규칙(파일 이름 표 → 가장 긴 확장자). 다르면 그것도 불일치로 드러나게 따로 적는다. */
function languageOf(rel, languages) {
  const name = path.basename(rel)
  const byName = languages.find((row) => row.filenames.includes(name))
  if (byName) return byName
  let best = null
  for (const row of languages) for (const ext of row.extensions) if (name.toLowerCase().endsWith(ext) && ext.length > (best?.ext.length ?? 0)) best = { row, ext }
  return best?.row ?? null
}

async function expect(file) {
  const versions = extractOracle()
  const oracleRequire = createRequire(path.join(ORACLE, 'node_modules/'))
  const onig = oracleRequire('vscode-oniguruma')
  const vsctm = oracleRequire('vscode-textmate')
  await onig.loadWASM(fs.readFileSync(path.join(ORACLE, 'node_modules/vscode-oniguruma/release/onig.wasm')).buffer)
  const { languages, grammars } = JSON.parse(fs.readFileSync(path.join(ASSETS, 'languages.json'), 'utf8'))
  const theme = JSON.parse(fs.readFileSync(path.join(ASSETS, 'dark-2026.json'), 'utf8'))
  const language = languageOf(file, languages)
  const lines = fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/)
  const fallback = theme.colors['editor.foreground']
  if (language === null) return { file, versions, language: null, lines: lines.map((line) => [[0, line.length, fallback, 0]]) }
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (patterns) => new onig.OnigScanner(patterns), createOnigString: (text) => new onig.OnigString(text) }),
    theme: { name: 'Dark 2026', settings: theme.settings },
    loadGrammar: async (scopeName) => {
      const row = grammars.find((item) => item.scopeName === scopeName)
      if (!row) return null
      return vsctm.parseRawGrammar(fs.readFileSync(path.join(ASSETS, 'grammars', row.file), 'utf8'), row.file)
    },
    getInjections: (scopeName) => grammars.filter((row) => row.injectTo.includes(scopeName)).map((row) => row.scopeName),
  })
  const grammarRow = grammars.find((row) => row.scopeName === language.scopeName)
  const tokenTypes = Object.fromEntries(Object.entries(grammarRow?.tokenTypes ?? {}).map(([selector, type]) => [selector, type === 'comment' ? 1 : type === 'string' ? 2 : type === 'regex' ? 3 : 0]))
  const grammar = await registry.loadGrammarWithConfiguration(language.scopeName, 1, { tokenTypes })
  const colorMap = registry.getColorMap()
  let state = vsctm.INITIAL
  const out = []
  for (const line of lines) {
    const result = grammar.tokenizeLine2(line, state)
    const tokens = []
    for (let index = 0; index < result.tokens.length; index += 2) {
      const start = result.tokens[index]
      const end = index + 2 < result.tokens.length ? result.tokens[index + 2] : line.length
      const metadata = result.tokens[index + 1]
      tokens.push([start, end, colorMap[vsctm.EncodedTokenMetadata?.getForeground?.(metadata) ?? (metadata >>> 15) & 0x1ff], (metadata >>> 11) & 0xf])
    }
    out.push(tokens)
    state = result.ruleStack
  }
  return { file, versions, language: language.id, lines: out }
}

const hex = (rgb) => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb)
  return match ? `#${match.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}` : rgb.toLowerCase()
}

/**
 * 괄호쌍 색칠(`editor.bracketPairColorization` — VS Code·Monaco 기본 켬)은 TextMate 색 **위에** 깊이별 색을 덧칠한다. Dark 2026 은 이 색을 정하지 않아
 * VS Code 기본(`editorBracketHighlight.foreground1~3` dark = #FFD700·#DA70D6·#179FFF)이 쓰인다 — 괄호 글자가 이 색이면 불일치가 아니라 `bracketPair` 로 따로 센다
 * (VS Code 캡처에도 같은 덧칠이 보인다 — E4ⓒ).
 */
const BRACKET_COLORS = new Set(['#ffd700', '#da70d6', '#179fff'])
const BRACKETS = new Set([...'{}[]()<>'])

/** 글자 단위 대조 — 공백은 색이 안 보이니 뺀다. 글꼴 모양은 italic(1)만 본다(DOM fontStyle 로 보이는 것). */
function compare(expected, actual) {
  const mismatches = []
  let checked = 0
  let bracketPair = 0
  expected.lines.forEach((tokens, lineIndex) => {
    const spans = actual.lines[lineIndex]
    if (spans === undefined) return
    const chars = spans.flatMap(([text, color, fontStyle]) => [...text].map((ch) => ({ ch, color: hex(color), italic: fontStyle === 'italic' })))
    for (const [start, end, color, fontStyle] of tokens) {
      for (let column = start; column < end && column < chars.length; column += 1) {
        const got = chars[column]
        if (/\s/.test(got.ch)) continue
        checked += 1
        // `${`(템플릿 괄호 — JS 언어 구성 brackets 첫 짝, colorizedBracketPairs 가 없으면 괄호쌍 색 대상)의 `$` 도 괄호 덧칠이다.
        const templateBracket = got.ch === '$' && chars[column + 1]?.ch === '{'
        if ((BRACKETS.has(got.ch) || templateBracket) && BRACKET_COLORS.has(got.color)) {
          bracketPair += 1
          continue
        }
        const want = { color: color.toLowerCase().slice(0, 7), italic: (fontStyle & 1) === 1 }
        if (got.color !== want.color || got.italic !== want.italic) mismatches.push({ line: lineIndex + 1, column: column + 1, ch: got.ch, want, got: { color: got.color, italic: got.italic } })
      }
    }
  })
  return { file: expected.file, language: expected.language, checked, bracketPair, mismatches: mismatches.length, details: mismatches }
}

const [command, ...rest] = process.argv.slice(2)
const { values } = parseArgs({ args: rest, options: { file: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, out: { type: 'string' } } })
const write = (value) => (values.out ? fs.writeFileSync(values.out, JSON.stringify(value, null, 1) + '\n') : console.log(JSON.stringify(value)))
if (command === 'expect') write(await expect(values.file))
else if (command === 'compare') {
  const result = compare(JSON.parse(fs.readFileSync(values.expected, 'utf8')), JSON.parse(fs.readFileSync(values.actual, 'utf8')))
  write(result)
  console.error(`checked=${result.checked} bracketPair=${result.bracketPair} mismatches=${result.mismatches}`)
  process.exit(result.mismatches === 0 ? 0 : 1)
} else throw new Error('명령: expect | compare')
