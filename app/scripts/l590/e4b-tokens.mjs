// LIFE-590 E4ⓑ 토큰 색 자동 대조 — 언어 10종 샘플을 corral(격리 개발 Electron)에서 열어 편집기 DOM 계산 색을 글자 단위로 뜨고(실제),
// `token-colors.mjs expect`(설치본 VS Code 의 vscode-textmate + vscode-oniguruma 로 같은 문법·테마를 토큰화 — 기대)와 `compare` 한다.
// 샘플은 한 화면에 다 들어오는 길이(fixture `samples/`) — Monaco 는 보이는 줄만 DOM 에 그린다. 줄 번호는 `.view-line` 의 top 순서.
// 사용(app/ 에서): node scripts/l590/e4b-tokens.mjs --root /tmp/l590g-t4 --repo /tmp/l590g-t/repo --out <dir>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const repo = values.repo
fs.mkdirSync(values.out, { recursive: true })
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const expanded = async (rel) => (await js(`document.querySelector('[data-explorer-row="${rel}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'

const FILES = [
  { language: 'TypeScript', rel: 'src/sample.ts' },
  { language: 'TSX', rel: 'samples/app.tsx' },
  { language: 'JavaScript', rel: 'samples/util.js' },
  { language: 'JSON', rel: 'config/settings.json' },
  { language: 'Markdown', rel: 'README.md' },
  { language: 'CSS', rel: 'samples/style.css' },
  { language: 'HTML', rel: 'samples/page.html' },
  { language: 'YAML', rel: 'samples/config.yaml' },
  { language: 'Shell', rel: 'samples/run.sh' },
  { language: 'Python', rel: 'samples/tool.py' },
]

await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })

const summary = []
for (const file of FILES) {
  const parts = file.rel.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    if (!(await expanded(dir))) await click(`[data-explorer-row="${dir}"]`)
    await until(() => expanded(dir), { label: `expand ${dir}` })
  }
  await click(`[data-explorer-row="${file.rel}"]`)
  const ready = await until(() => js(`document.querySelector('[data-file-view="${file.rel}"] [data-editor-ready]')?.dataset.editorReady ?? null`), { label: `ready ${file.rel}` })
  await sleep(800) // 토큰화·괄호 색 덧칠이 끝나게
  const lines = await js(`(() => {
    const rows = [...document.querySelectorAll('[data-file-view="${file.rel}"] .view-lines .view-line')]
      .map((line) => ({ top: parseFloat(line.style.top), spans: [...line.querySelectorAll(':scope > span > span')].map((span) => [span.textContent.replace(/\\u00a0/g, ' '), getComputedStyle(span).color, getComputedStyle(span).fontStyle]) }))
      .sort((a, b) => a.top - b.top)
    return rows.map((row) => row.spans)
  })()`)
  const base = file.rel.replace(/[/.]/g, '_')
  const actualPath = path.join(values.out, `${base}.actual.json`)
  const expectedPath = path.join(values.out, `${base}.expected.json`)
  const diffPath = path.join(values.out, `${base}.diff.json`)
  writeJson(actualPath, { file: file.rel, language: ready.value, lines })
  const expect = spawnSync(process.execPath, ['scripts/l590/token-colors.mjs', 'expect', '--file', path.join(repo, file.rel), '--out', expectedPath], { encoding: 'utf8' })
  const compare = spawnSync(process.execPath, ['scripts/l590/token-colors.mjs', 'compare', '--expected', expectedPath, '--actual', actualPath, '--out', diffPath], { encoding: 'utf8' })
  const diff = fs.existsSync(diffPath) ? JSON.parse(fs.readFileSync(diffPath, 'utf8')) : null
  const row = { language: file.language, rel: file.rel, monacoLanguage: ready.value, lines: lines.length, checked: diff?.checked ?? null, bracketPair: diff?.bracketPair ?? null, mismatches: diff?.mismatches ?? null, expectExit: expect.status, compareExit: compare.status, stderr: (expect.stderr + compare.stderr).trim().slice(0, 300) }
  summary.push(row)
  console.log(JSON.stringify(row))
}
writeJson(path.join(values.out, 'summary.json'), { root, repo, summary })
const failed = summary.filter((row) => row.mismatches !== 0 || row.checked === null || row.checked === 0)
console.log(JSON.stringify({ languages: summary.length, failed: failed.map((row) => row.language) }))
process.exit(failed.length === 0 ? 0 : 1)
