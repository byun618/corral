// LIFE-590 수정 r1 R1-B·R1-C 격리 회귀(리뷰 `gui-repro.mjs` 조건 그대로 + 판정).
// R1-C: 미리보기 파일 탭을 **같은 탭바 안에서** 터미널 탭 앞으로 끌면 고정 → 다음 파일 한 번 클릭이 그 탭을 교체하지 않는다.
// R1-B: 파일 탭이 활성이고 편집기에 포커스일 때 터미널 대상 키(⌘D·⌘⇧D 분할 · ⌘⇧Z 줌 · ⌘⌥→ 인접 포커스)가 숨은 터미널을 건드리지 않는다
//       (herdr pane 수·줌 표시·활성 탭 그대로). **양성 대조**: 같은 실행에서 터미널 탭으로 바꾸면 ⌘D 가 pane 을 늘리고 ⌘⇧Z 가 줌을 켠다.
// 사용(app/ 에서): node scripts/l590/fix-r1-keys.mjs --root /tmp/l590g-* --repo /tmp/l590g-t/repo --out <json>
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, herdr, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const open = async (rel) => {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    if ((await js(`document.querySelector('[data-explorer-row="${dir}"]')?.getAttribute('aria-expanded') ?? null`)) !== 'true') await click(`[data-explorer-row="${dir}"]`)
  }
  await click(`[data-explorer-row="${rel}"]`)
  await until(() => js(`!!document.querySelector('[data-file-view="${rel}"] [data-editor-ready]')`), { label: `ready ${rel}` })
}
const tabs = () => js(`[...document.querySelectorAll('[data-main-tab]')].map((e) => ({ id: e.dataset.mainTab, preview: e.dataset.tabPreview ?? null, active: e.dataset.active }))`)
const rect = (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
const drag = async (from, to) => {
  const y = Math.round(from.y + from.h / 2)
  const x0 = Math.round(from.x + from.w / 2)
  const x1 = Math.round(to.x + 5)
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: x0, y })
  for (let i = 1; i <= 12; i += 1) {
    await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * i) / 12), y })
    await sleep(25)
  }
  await sleep(150)
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: x1, y })
  await sleep(400)
}
const paneCount = async () => ((await herdr(root, 'pane.list')).panes ?? []).length
const zoomChips = () => js(`document.querySelectorAll('[data-group-zoom-chip]').length`)
const snapshot = async () => ({ tabs: await tabs(), panes: await paneCount(), zoom: await zoomChips(), focusInFile: await js(`!!document.activeElement?.closest('[data-file-view]')`) })

const out = {}
await repoPane(root, { repo: values.repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })

// ── R1-C
await open('README.md')
const terminal = (await tabs()).find((tab) => !tab.id.startsWith('file:'))?.id
if (terminal === undefined) throw new Error('터미널 탭이 없다')
out.beforeDrag = await tabs()
await drag(await rect('[data-main-tab="file:README.md"]'), await rect(`[data-main-tab="${terminal}"]`))
out.afterDrag = await tabs()
await open('src/sample.ts')
out.afterNextPreview = await tabs()
const readmeAfterDrag = out.afterDrag.find((tab) => tab.id === 'file:README.md')
const order = out.afterDrag.map((tab) => tab.id)

// ── R1-B — 파일 탭 활성 + 편집기 포커스
await click('[data-file-view="src/sample.ts"] [data-file-editor]')
out.beforeKeys = await snapshot()
const presses = [
  ['D', ['meta'], '⌘D'],
  ['D', ['meta', 'shift'], '⌘⇧D'],
  ['Z', ['meta', 'shift'], '⌘⇧Z'],
  ['Right', ['meta', 'alt'], '⌘⌥→'],
]
out.onFile = []
for (const [code, modifiers, label] of presses) {
  await key(code, modifiers)
  await sleep(1500)
  out.onFile.push({ label, ...(await snapshot()) })
}
// 양성 대조 — 터미널 탭으로 바꾼 뒤 같은 키
await click(`[data-main-tab="${terminal}"]`)
await sleep(500)
const terminalBefore = await snapshot()
await key('D', ['meta'])
const split = await until(async () => ((await paneCount()) > terminalBefore.panes ? true : null), { timeoutMs: 8000, label: 'terminal split' }).then(() => true, () => false)
await sleep(800)
await key('Z', ['meta', 'shift'])
const zoomed = await until(async () => ((await zoomChips()) > 0 ? true : null), { timeoutMs: 5000, label: 'terminal zoom' }).then(() => true, () => false)
out.positive = { terminalBefore, after: await snapshot(), split, zoomed }

const checks = {
  'R1-C-dragged-before-terminal': order.indexOf('file:README.md') < order.indexOf(terminal),
  'R1-C-pinned-after-same-tabbar-drag': readmeAfterDrag?.preview === 'false',
  'R1-C-survives-next-preview': out.afterNextPreview.some((tab) => tab.id === 'file:README.md') && out.afterNextPreview.some((tab) => tab.id === 'file:src/sample.ts'),
  'R1-B-focus-in-file-editor': out.beforeKeys.focusInFile === true,
  'R1-B-no-pane-change-on-file': out.onFile.every((row) => row.panes === out.beforeKeys.panes),
  'R1-B-no-zoom-on-file': out.onFile.every((row) => row.zoom === out.beforeKeys.zoom),
  'R1-B-file-still-active': out.onFile.every((row) => row.tabs.find((tab) => tab.active === 'true')?.id === 'file:src/sample.ts'),
  'positive-terminal-split': split,
  'positive-terminal-zoom': zoomed,
}
out.checks = checks
writeJson(values.out, out)
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
console.log(JSON.stringify({ beforeDrag: out.beforeDrag, afterDrag: out.afterDrag, afterNextPreview: out.afterNextPreview, beforeKeys: out.beforeKeys.panes, onFile: out.onFile.map((row) => [row.label, row.panes, row.zoom]), positive: { split, zoomed }, failed }))
process.exit(failed.length === 0 ? 0 : 1)
