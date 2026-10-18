// LIFE-589 E2ⓕ — VS Code 기본 파일 아이콘(Seti) 반입. npm 의존성이 아니라 **파일**로 들인다(출처 버전 기록).
//   seti.woff · vs-seti-icon-theme.json 을 그대로 복사하고, VS Code 내장 확장 매니페스트의 `contributes.languages`
//   (확장자·파일 이름 → 언어 id)에서 Seti `languageIds` 에 있는 언어만 골라 `seti-language-map.json` 을 만든다 —
//   VS Code 는 `.ts` 같은 파일을 확장자 표가 아니라 언어 id(typescript)로 아이콘에 잇기 때문이다.
// 사용: node scripts/l589/seti-import.mjs <vscode 소스 루트> <codicons 패키지 폴더(npm pack 풀린 package/)>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const [vscode, codicons] = process.argv.slice(2)
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../src/renderer/src/assets')
const seti = path.join(vscode, 'extensions/theme-seti')
fs.copyFileSync(path.join(seti, 'icons/seti.woff'), path.join(out, 'seti/seti.woff'))
fs.copyFileSync(path.join(seti, 'icons/vs-seti-icon-theme.json'), path.join(out, 'seti/vs-seti-icon-theme.json'))
fs.copyFileSync(path.join(seti, 'ThirdPartyNotices.txt'), path.join(out, 'seti/ThirdPartyNotices.txt'))
const theme = JSON.parse(fs.readFileSync(path.join(seti, 'icons/vs-seti-icon-theme.json'), 'utf8'))
const wanted = new Set(Object.keys(theme.languageIds))
const extensions = {}
const filenames = {}
for (const dir of fs.readdirSync(path.join(vscode, 'extensions')).sort()) {
  const manifest = path.join(vscode, 'extensions', dir, 'package.json')
  if (!fs.existsSync(manifest)) continue
  const languages = JSON.parse(fs.readFileSync(manifest, 'utf8')).contributes?.languages ?? []
  for (const language of languages) {
    if (!wanted.has(language.id)) continue
    for (const ext of language.extensions ?? []) {
      const key = ext.replace(/^\./, '').toLowerCase()
      if (key.length > 0 && extensions[key] === undefined) extensions[key] = language.id
    }
    for (const name of language.filenames ?? []) if (filenames[name.toLowerCase()] === undefined) filenames[name.toLowerCase()] = language.id
  }
}
const commit = execFileSync('git', ['-C', vscode, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const version = JSON.parse(fs.readFileSync(path.join(vscode, 'package.json'), 'utf8')).version
fs.writeFileSync(path.join(out, 'seti/seti-language-map.json'), JSON.stringify({ source: `microsoft/vscode ${version} (${commit}) extensions/*/package.json contributes.languages — Seti languageIds 에 있는 언어만`, extensions, filenames }, null, 1) + '\n')
fs.copyFileSync(path.join(codicons, 'dist/codicon.ttf'), path.join(out, 'codicons/codicon.ttf'))
fs.copyFileSync(path.join(codicons, 'LICENSE'), path.join(out, 'codicons/LICENSE'))
fs.copyFileSync(path.join(codicons, 'LICENSE-CODE'), path.join(out, 'codicons/LICENSE-CODE'))
const codiconVersion = JSON.parse(fs.readFileSync(path.join(codicons, 'package.json'), 'utf8')).version
fs.writeFileSync(path.join(out, 'seti/SOURCE.md'), `# 반입 출처 (LIFE-589)\n\n- Seti: microsoft/vscode ${version} (\`${commit}\`) \`extensions/theme-seti/icons/{seti.woff,vs-seti-icon-theme.json}\` · \`ThirdPartyNotices.txt\`(seti-ui, MIT) — VS Code MIT.\n- \`seti-language-map.json\`: 같은 커밋의 내장 확장 매니페스트에서 생성(\`app/scripts/l589/seti-import.mjs\`).\n- codicons: @vscode/codicons ${codiconVersion} \`dist/codicon.ttf\` — 글꼴 CC BY 4.0(\`../codicons/LICENSE\`), 코드 MIT(\`../codicons/LICENSE-CODE\`).\n`)
console.log(JSON.stringify({ version, commit, codiconVersion, extensions: Object.keys(extensions).length, filenames: Object.keys(filenames).length }))
