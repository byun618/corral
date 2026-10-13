// LIFE-590 E4ⓑ — VS Code TextMate 문법·기본 다크 테마(Dark 2026) 반입. npm 의존성이 아니라 **파일**로 들인다(F1 Seti 선례, 출처 버전 기록).
//   · 문법: 아래 EXTENSIONS 의 내장 확장 `contributes.grammars` 를 그대로 복사(`grammars/<scopeName>.json`) — 주입 문법(injectTo) 포함
//   · 언어 표: 같은 확장의 `contributes.languages`(확장자·파일 이름 → 언어 id) + 언어 id → 문법 scopeName(`languages.json`)
//   · 테마: `2026-dark.json → dark_modern → dark_plus → dark_vs` include 체인을 VS Code `colorThemeData.ts` 와 같은 순서로 펼친다
//     (포함된 쪽 tokenColors 먼저, 포함한 쪽이 뒤에 붙는다 · 첫 규칙 = editor.foreground/background 기본 · 끝에 dark 기본 token.* 4개)
//   · 고지: VS Code LICENSE.txt(MIT) + 확장별 `cgmanifest.json`(상류 문법 출처·라이선스) 사본
// 사용: node scripts/l590/tm-import.mjs <vscode 소스 루트>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const EXTENSIONS = ['typescript-basics', 'javascript', 'json', 'markdown-basics', 'css', 'scss', 'less', 'html', 'yaml', 'shellscript', 'python', 'rust', 'go', 'xml', 'sql', 'docker', 'ini', 'make', 'diff', 'java']
// 문법이 .tmLanguage(plist)인 것은 반입하지 않는다 — JSON 만(`source.js.regexp` 는 JavaScript 문법이 쓰지 않는 보조 문법).
const vscode = process.argv[2]
if (vscode === undefined) throw new Error('사용: node scripts/l590/tm-import.mjs <vscode 소스 루트>')
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../src/renderer/src/assets/textmate')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'grammars'), { recursive: true })
fs.mkdirSync(path.join(out, 'notices'), { recursive: true })
fs.mkdirSync(path.join(out, 'language-configuration'), { recursive: true })

// JSONC → JSON — 문자열 밖의 줄·블록 주석과 꼬리 쉼표를 걷는다(테마 파일이 JSONC 다).
const stripJsonc = (text) => {
  let result = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      result += text.slice(i, j + 1)
      i = j
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      result += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
    } else result += ch
  }
  return result.replace(/,(\s*[}\]])/g, '$1')
}
const languages = []
const grammars = []
for (const dir of EXTENSIONS) {
  const root = path.join(vscode, 'extensions', dir)
  const contributes = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes ?? {}
  for (const grammar of contributes.grammars ?? []) {
    if (!grammar.path.endsWith('.json')) continue
    const file = `${grammar.scopeName}.json`
    // 같은 scopeName 을 두 언어가 쓰면(yaml·dockercompose) 문법 파일은 하나다.
    if (!grammars.some((row) => row.scopeName === grammar.scopeName)) {
      fs.copyFileSync(path.join(root, grammar.path), path.join(out, 'grammars', file))
      // tokenTypes = 문자열·주석·정규식 판정 덮어쓰기(VS Code 가 문법과 함께 넘긴다 — 괄호 짝·괄호 색이 문자열 안을 건너뛰는 근거).
      grammars.push({ scopeName: grammar.scopeName, file, injectTo: grammar.injectTo ?? [], embeddedLanguages: grammar.embeddedLanguages ?? {}, tokenTypes: grammar.tokenTypes ?? {}, balancedBracketScopes: grammar.balancedBracketScopes ?? null, unbalancedBracketScopes: grammar.unbalancedBracketScopes ?? null })
    }
    if (typeof grammar.language === 'string') {
      const row = languages.find((item) => item.id === grammar.language)
      if (row === undefined) languages.push({ id: grammar.language, scopeName: grammar.scopeName, extensions: [], filenames: [] })
      else if (row.scopeName === undefined) row.scopeName = grammar.scopeName
    }
  }
  for (const language of contributes.languages ?? []) {
    const row = languages.find((item) => item.id === language.id)
    if (row === undefined) continue
    // 언어 구성(괄호·주석·접기 표지·단어 패턴·들여쓰기 규칙) — VS Code 와 같은 괄호 색·괄호 짝·접기를 내려면 같이 있어야 한다. JSONC → JSON 으로 옮긴다.
    if (typeof language.configuration === 'string' && row.configuration === undefined) {
      const config = JSON.parse(stripJsonc(fs.readFileSync(path.join(root, language.configuration), 'utf8')))
      fs.writeFileSync(path.join(out, 'language-configuration', `${language.id}.json`), JSON.stringify(config, null, 1) + '\n')
      row.configuration = `${language.id}.json`
    }
    for (const ext of language.extensions ?? []) if (!row.extensions.includes(ext.toLowerCase())) row.extensions.push(ext.toLowerCase())
    for (const name of language.filenames ?? []) if (!row.filenames.includes(name)) row.filenames.push(name)
  }
  const manifest = path.join(root, 'cgmanifest.json')
  if (fs.existsSync(manifest)) fs.copyFileSync(manifest, path.join(out, 'notices', `${dir}.cgmanifest.json`))
}

// 테마 체인 — VS Code `_loadColorTheme`: include 를 먼저 읽고(재귀) 자기 colors 를 덮어쓰고 tokenColors 를 뒤에 붙인다.
const themeDir = path.join(vscode, 'extensions/theme-defaults/themes')
const chain = []
const colors = {}
const tokenColors = []
const readTheme = (file) => {
  const value = JSON.parse(stripJsonc(fs.readFileSync(path.join(themeDir, file), 'utf8')))
  if (value.include) readTheme(value.include.replace(/^\.\//, ''))
  chain.push(file)
  Object.assign(colors, value.colors ?? {})
  tokenColors.push(...(value.tokenColors ?? []))
}
readTheme('2026-dark.json')
const normalize = (color) => (typeof color === 'string' ? color.toLowerCase() : undefined)
// `ColorThemeData.tokenColors` — 첫 규칙은 scope 없는 기본(editor.foreground·background), 그 뒤 scope 있는 규칙만, token.info-token 이 없으면 dark 기본 4개.
const settings = [{ settings: { foreground: normalize(colors['editor.foreground']), background: normalize(colors['editor.background']) } }]
for (const rule of tokenColors) {
  if (!rule.scope || !rule.settings) continue
  settings.push({ scope: rule.scope, settings: { foreground: normalize(rule.settings.foreground), background: normalize(rule.settings.background), fontStyle: rule.settings.fontStyle } })
}
if (!settings.some((rule) => rule.scope === 'token.info-token')) {
  settings.push(
    { scope: 'token.info-token', settings: { foreground: '#6796e6' } },
    { scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
    { scope: 'token.error-token', settings: { foreground: '#f44747' } },
    { scope: 'token.debug-token', settings: { foreground: '#b267e6' } },
  )
}
const pick = ['editor.foreground', 'editor.background', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'editor.selectionBackground', 'editor.inactiveSelectionBackground', 'editor.lineHighlightBackground', 'editor.lineHighlightBorder', 'editorCursor.foreground', 'editorWhitespace.foreground', 'editorIndentGuide.background1', 'editorIndentGuide.activeBackground1', 'editor.findMatchBackground', 'editor.findMatchHighlightBackground', 'editorWidget.background', 'editorWidget.border', 'scrollbarSlider.background', 'scrollbarSlider.hoverBackground', 'scrollbarSlider.activeBackground', 'editorGutter.background', 'editorBracketMatch.background', 'editorBracketMatch.border', 'editor.wordHighlightBackground', 'tab.activeForeground', 'tab.inactiveForeground', 'tab.activeBackground', 'tab.inactiveBackground', 'tab.border', 'tab.activeBorderTop', 'editorGroupHeader.tabsBackground']
const editorColors = Object.fromEntries(pick.filter((key) => colors[key] !== undefined).map((key) => [key, colors[key]]))
const commit = execFileSync('git', ['-C', vscode, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const version = JSON.parse(fs.readFileSync(path.join(vscode, 'package.json'), 'utf8')).version
const source = `microsoft/vscode ${version} (${commit})`
fs.writeFileSync(path.join(out, 'dark-2026.json'), JSON.stringify({ source: `${source} extensions/theme-defaults/themes ${chain.join(' → ')}`, name: 'Dark 2026', settings, colors: editorColors }, null, 1) + '\n')
fs.writeFileSync(path.join(out, 'languages.json'), JSON.stringify({ source: `${source} extensions/{${EXTENSIONS.join(',')}}/package.json contributes.grammars·languages`, languages, grammars }, null, 1) + '\n')
fs.copyFileSync(path.join(vscode, 'LICENSE.txt'), path.join(out, 'notices/VSCODE-LICENSE.txt'))
fs.writeFileSync(path.join(out, 'SOURCE.md'), `# 반입 출처 (LIFE-590)\n\n- ${source} — MIT(\`notices/VSCODE-LICENSE.txt\`).\n- \`grammars/*.json\`: \`extensions/{${EXTENSIONS.join(',')}}/syntaxes\` 사본(내용 무변경). 상류 문법 저장소·라이선스는 확장별 \`notices/<확장>.cgmanifest.json\`.\n- \`languages.json\`: 같은 확장 매니페스트의 \`contributes.languages\`·\`contributes.grammars\`(tokenTypes·bracket scopes 포함) 에서 생성.\n- \`language-configuration/<언어>.json\`: 같은 확장의 \`language-configuration.json\`(JSONC → JSON, 내용 무변경).\n- \`dark-2026.json\`: \`extensions/theme-defaults/themes/${chain.join(' → ')}\` include 체인을 \`colorThemeData.ts\` 순서로 펼친 TextMate 규칙 + 편집기 색 일부.\n- 생성: \`app/scripts/l590/tm-import.mjs\`.\n`)
console.log(JSON.stringify({ version, commit, chain, rules: settings.length, languages: languages.length, grammars: grammars.length }))
