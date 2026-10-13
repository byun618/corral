// LIFE-590 E4ⓖ 성능 — 격리 개발 Electron, 크기별 `--runs`(기본 10)회: 탐색기 한 번 클릭 → 첫 내용 표시(편집기 준비 `data-editor-ready` 안에 그려진 줄 `.view-line` 이 생김, 또는 상한 안내).
// 회차마다 탭을 닫고 다시 연다(캐시된 탭 재사용 없음). 시간 = 클릭 명령을 보낸 시각 → 렌더러에서 조건이 처음 참으로 보인 시각(제어 왕복 포함 — 보수적).
// 첫 회 `first` 는 그 실행에서 편집기 코드를 처음 싣는 열기(지연 로딩 포함). 기준(코디 제안): 1 MB p95 ≤ 300 ms · 10 MB ≤ 2 s · 상한 초과 안내 ≤ 500 ms.
// 사용(app/ 에서): node scripts/l590/perf.mjs --root /tmp/l590g-p --repo /tmp/l590g-t/repo --out <file.json> [--runs 10]
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, pct, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, runs: { type: 'string', default: '10' } } })
checkRoot(values.root)
const root = values.root
const runs = Number(values.runs)
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 50, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })

await repoPane(root, { repo: values.repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
if ((await js(`document.querySelector('[data-explorer-row="big"]')?.getAttribute('aria-expanded')`)) !== 'true') await click('[data-explorer-row="big"]')
await until(() => js(`document.querySelector('[data-explorer-row="big/1mb.txt"]') !== null`), { label: 'big rows' })

const cases = [
  { name: '1mb', rel: 'big/1mb.txt', ready: (rel) => `!!document.querySelector('[data-file-view="${rel}"] [data-editor-ready] .view-line')`, limitP95: 300 },
  { name: '10mb', rel: 'big/10mb.txt', ready: (rel) => `!!document.querySelector('[data-file-view="${rel}"] [data-editor-ready] .view-line')`, limitMax: 2000 },
  { name: 'too-large-60mb', rel: 'big/60mb.txt', ready: () => `!!document.querySelector('[data-file-notice="too_large"]')`, limitMax: 500 },
]
const result = { root, runs, cases: {} }
let first = null
for (const item of cases) {
  const rows = []
  for (let i = 0; i < runs; i += 1) {
    const t0 = Date.now()
    await ctl(root, { cmd: 'click', selector: `[data-explorer-row="${item.rel}"]` })
    let ms = null
    try {
      await until(() => js(item.ready(item.rel)), { timeoutMs: 15_000, everyMs: 5, label: item.name })
      ms = Date.now() - t0
    } catch {
      ms = null
    }
    if (first === null) first = { rel: item.rel, ms }
    rows.push(ms)
    // 닫기 — 다음 회차가 새로 읽게(미리보기 탭이라 ⌘W 로 닫는다)
    await click(`[data-main-tab="file:${item.rel}"]`)
    await key('W', ['meta'])
    await until(() => js(`document.querySelector('[data-main-tab="file:${item.rel}"]') === null`), { label: 'closed' })
    await sleep(200)
  }
  const ok = rows.filter((value) => value !== null)
  const summary = { rows, p50: pct(ok, 50), p95: pct(ok, 95), max: ok.length ? Math.max(...ok) : null, failures: rows.length - ok.length }
  summary.pass = summary.failures === 0 && (item.limitP95 === undefined || summary.p95 <= item.limitP95) && (item.limitMax === undefined || summary.max <= item.limitMax)
  result.cases[item.name] = summary
  console.log(item.name, JSON.stringify(summary))
}
result.firstOpen = first
writeJson(values.out, result)
const failed = Object.entries(result.cases).filter(([, value]) => !value.pass).map(([name]) => name)
console.log(JSON.stringify({ firstOpen: first, failed }))
process.exit(failed.length === 0 ? 0 : 1)
