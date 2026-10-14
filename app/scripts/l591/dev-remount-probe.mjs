// LIFE-591 수정 r2 점검(판정 회차 아님) — R2Q09 E1e 실패(탭 왕복 뒤 화면 첫 줄이 'beta')가 시험 타이밍인지 스크롤 복원인지 가른다.
// edit-flows ① 과 같은 걸음(편집기 맨 앞 → 'Z' → 터미널 탭 → 파일 탭)을 N 번, 매번 다시 마운트 직후부터 3 s 동안 50 ms 간격으로 scrollTop·화면 첫 줄을 기록한다.
// 사용(app/ 에서, iso.sh 안): node scripts/l591/dev-remount-probe.mjs --root {ROOT} --repo /tmp/l591g-t/repo --out <dir> [--n 10]
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, n: { type: 'string', default: '10' } } })
checkRoot(values.root)
const root = values.root
const rel = 'notes/edit.txt'
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const file = path.join(values.repo, rel)
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')
await repoPane(root, { repo: values.repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelector('[data-explorer-row="notes"]') !== null`)), { label: 'notes row' })
if ((await js(`document.querySelector('[data-explorer-row="notes"]')?.getAttribute('aria-expanded')`)) !== 'true') await click('[data-explorer-row="notes"]')
await until(async () => (await js(`document.querySelector('[data-explorer-row="${rel}"]') !== null`)), { label: 'file row' })
await ctl(root, { cmd: 'dblclick', selector: `[data-explorer-row="${rel}"]` })
await until(() => js(`document.querySelector('[data-file-view="${rel}"] [data-editor-ready]') !== null`), { label: 'editor' })
const sample = () => js(`(() => { const v = document.querySelector('[data-file-view="${rel}"]'); const rows = [...(v?.querySelectorAll('.view-line') ?? [])]; rows.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)); const sc = v?.querySelector('.monaco-scrollable-element.editor-scrollable'); const lines = v?.querySelector('.view-lines'); return { first: rows[0]?.textContent ?? null, tops: rows.map((r) => r.style.top).slice(0, 3), linesTop: lines?.style.top ?? null, ready: v?.querySelector('[data-editor-ready]') !== null } })()`)
const rounds = []
const n = Number(values.n)
for (let round = 0; round < n; round += 1) {
  await click(`[data-file-view="${rel}"] .view-lines`)
  await key('Up', ['meta'])
  await key('Home')
  if (round === 0) await ctl(root, { cmd: 'type', text: 'Z' })
  await sleep(200)
  await click(`[data-main-tab]:not([data-file-tab])`)
  await until(() => js(`document.querySelector('[data-file-view="${rel}"]') === null`), { label: 'unmounted' })
  await click(`[data-file-tab="${rel}"]`)
  const t0 = Date.now()
  const samples = []
  while (Date.now() - t0 < 3000) {
    samples.push({ ms: Date.now() - t0, ...(await sample()) })
    await sleep(50)
  }
  const last = samples.at(-1)
  rounds.push({ round, finalFirst: last.first, finalLinesTop: last.linesTop, firstSeenZ: samples.find((s) => String(s.first).startsWith('Z'))?.ms ?? null, samples })
  console.log(JSON.stringify({ round, finalFirst: last.first, linesTop: last.linesTop, tops: last.tops, firstSeenZ: rounds.at(-1).firstSeenZ }))
}
writeJson(path.join(values.out, 'remount-probe.json'), { rel, rounds })
await ctl(root, { cmd: 'file-dialog-stub', answers: ['discard', 'discard'] })
