// LIFE-590 E8ⓒ 지연 로딩 — 편집기 코드(Monaco·TextMate·Markdown·이미지 청크)가 **첫 파일 탭 전에는 실행되지 않는지**. file:// 에서는 resource timing 이 비어
// (first-screen 회차에서 확인) 청크가 남긴 전역으로 본다: `MonacoEnvironment`(monaco.ts 가 싣는 순간 설정) · Monaco 스타일(`.monaco-editor` 규칙) · `<script>` 목록.
// 양성 대조 = 같은 실행에서 파일 탭을 연 **뒤**에는 같은 탐침이 참이 된다.
// 사용(app/ 에서): node scripts/l590/lazy-check.mjs --root /tmp/l590g-* --repo /tmp/l590g-t/repo --out <json>
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const js = (expression) => evalJs(root, expression)
const probe = () => js(`({
  monacoEnvironment: typeof globalThis.MonacoEnvironment,
  monacoCss: [...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => String(rule.selectorText ?? '').includes('.monaco-editor')) } catch { return false } }),
  scripts: [...document.scripts].map((s) => s.src.split('/').pop()),
  modulePreloads: [...document.querySelectorAll('link[rel="modulepreload"]')].map((l) => l.href.split('/').pop()),
})`)
await repoPane(root, { repo: values.repo })
await sleep(1500)
const before = await probe()
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await ctl(root, { cmd: 'key', keyCode: 'L', modifiers: ['meta'] })
await until(() => js(`!!document.querySelector('[data-explorer-row="README.md"]')`), { label: 'row' })
await until(async () => (await ctl(root, { cmd: 'click', selector: '[data-explorer-row="README.md"]' })).ok === true, { label: 'click' })
await until(() => js(`!!document.querySelector('[data-file-view="README.md"] [data-editor-ready]')`), { label: 'editor' })
const after = await probe()
const pass = before.monacoEnvironment === 'undefined' && !before.monacoCss && after.monacoEnvironment === 'object' && after.monacoCss && !before.modulePreloads.some((name) => /monaco|textmate|source\./.test(name))
writeJson(values.out, { before, after, pass })
console.log(JSON.stringify({ before: { env: before.monacoEnvironment, css: before.monacoCss, preloads: before.modulePreloads }, after: { env: after.monacoEnvironment, css: after.monacoCss }, pass }))
process.exit(pass ? 0 : 1)
