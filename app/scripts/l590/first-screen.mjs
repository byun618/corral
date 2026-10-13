// LIFE-590 E10 첫 화면 — 격리 개발 Electron(`l577/g-up.sh` /tmp/l590g-*)에서 fixture 레포를 열고 탐색기 클릭·더블클릭으로 파일 탭을 연 화면을 찍는다.
// 단계마다 앱 캡처(`shot` — 앱 창 capturePage, OS 화면 기록 없음) + 탭바·편집기 계산 스타일·worker 로드 여부를 JSON 으로. 시스템 클립보드는 쓰지 않는다(G5).
// 사용(app/ 에서): node scripts/l590/first-screen.mjs --root /tmp/l590g-s --repo /tmp/l590g-t/repo --out <dir>
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const repo = values.repo
const out = values.out
fs.mkdirSync(out, { recursive: true })
const steps = []
const shot = async (name) => {
  const result = await ctl(root, { cmd: 'shot', name })
  if (result.file) fs.copyFileSync(result.file, path.join(out, `corral-${name}.png`))
  return result.file ? `corral-${name}.png` : null
}
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `click ${selector}` })
const dblclick = (selector) => until(async () => (await ctl(root, { cmd: 'dblclick', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `dblclick ${selector}` })
const tabs = () =>
  evalJs(root, `[...document.querySelectorAll('[data-main-tab]')].map((el) => ({ id: el.dataset.mainTab, file: el.dataset.fileTab ?? null, active: el.dataset.active, preview: el.dataset.tabPreview ?? null, fontStyle: getComputedStyle(el.querySelector('.main-tab-label') ?? el).fontStyle, width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height), group: el.closest('[data-tab-group]')?.dataset.tabGroup }))`)
const editorReady = (rel) => until(async () => (await evalJs(root, `document.querySelector('[data-file-view="${rel}"] [data-editor-ready]')?.dataset.editorReady ?? null`)), { timeoutMs: 20_000, everyMs: 100, label: `editor ${rel}` })
const record = async (name, extra = {}) => {
  const file = await shot(name)
  steps.push({ name, shot: file, tabs: await tabs(), ...extra })
}

const pane = await repoPane(root, { repo })
await sleep(800)
// 창 크기 — VS Code 캡처와 같게
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
const panel = await evalJs(root, `document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)
if (panel !== 'open') await ctl(root, { cmd: 'key', keyCode: 'L', modifiers: ['meta'] })
await until(async () => (await evalJs(root, `document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
await sleep(400)
const scriptsBefore = await evalJs(root, `performance.getEntriesByType('resource').map((r) => r.name.split('/').pop()).filter((n) => n.endsWith('.js'))`)
await record('00-before-open', { scriptsBefore })

// ① 한 번 클릭 = 미리보기
await click('[data-explorer-row="src"]')
await sleep(300)
const t0 = Date.now()
await click('[data-explorer-row="src/sample.ts"]')
const ready = await editorReady('src/sample.ts')
const firstOpenMs = Date.now() - t0
await sleep(600)
const tokenSpans = await evalJs(root, `(() => { const lines = [...document.querySelectorAll('[data-file-view="src/sample.ts"] .view-line')].slice(0, 12); return lines.map((line) => [...line.querySelectorAll('span > span')].map((span) => [span.textContent, getComputedStyle(span).color, getComputedStyle(span).fontStyle])) })()`)
const editorStyle = await evalJs(root, `(() => { const ed = document.querySelector('[data-file-view="src/sample.ts"] .monaco-editor'); const line = ed?.querySelector('.view-line'); const cs = ed && getComputedStyle(ed.querySelector('.monaco-editor-background') ?? ed); return { background: cs?.backgroundColor ?? null, fontFamily: line && getComputedStyle(line).fontFamily, fontSize: line && getComputedStyle(line).fontSize, lineHeight: line && getComputedStyle(line).lineHeight, minimap: !!ed?.querySelector('.minimap'), gutter: ed?.querySelector('.line-numbers') && getComputedStyle(ed.querySelector('.line-numbers')).color } })()`)
const scriptsAfter = await evalJs(root, `performance.getEntriesByType('resource').map((r) => r.name.split('/').pop()).filter((n) => n.endsWith('.js'))`)
await record('01-preview-ts', { language: ready.value, firstOpenMs, editorStyle, tokenSpans, scriptsAfter })

// ② 다른 파일 한 번 클릭 = 같은 자리 교체
await click('[data-explorer-row="README.md"]')
await editorReady('README.md')
await sleep(400)
await record('02-preview-replaced')

// ③ 더블클릭 = 고정, 그다음 다른 파일 미리보기
await dblclick('[data-explorer-row="src/sample.ts"]')
await editorReady('src/sample.ts')
await sleep(300)
await click('[data-explorer-row="config"]')
await sleep(300)
await click('[data-explorer-row="config/settings.json"]')
await editorReady('config/settings.json')
await sleep(400)
await record('03-pinned-plus-preview')

// ④ 빈 파일·바이너리
await click('[data-explorer-row="empty.txt"]')
await editorReady('empty.txt')
await sleep(300)
await record('04-empty-file')
await click('[data-explorer-row="data.bin"]')
await until(async () => (await evalJs(root, `!!document.querySelector('[data-file-notice="binary"]')`)), { label: 'binary notice' })
await record('05-binary')

// ⑤ 파일 탭을 새 영역으로(오른쪽) — 파일 탭만 남은 영역
await click('[data-main-tab="file:src/sample.ts"]')
await sleep(200)
await ctl(root, { cmd: 'key', keyCode: 'D', modifiers: ['meta', 'alt'] })
await sleep(800)
await record('06-file-only-group')

// ⑥ 왼쪽 영역 탭 순서·worker·콘솔 — worker 가 뜬 흔적(리소스 목록 + Monaco 경고)
const resources = await evalJs(root, `performance.getEntriesByType('resource').map((r) => ({ name: r.name.split('/').pop(), type: r.initiatorType }))`)
writeJson(path.join(out, 'corral-steps.json'), { root, repo, pane, steps, resources })
console.log(JSON.stringify({ firstOpenMs, language: ready.value, steps: steps.map((step) => step.name) }))
