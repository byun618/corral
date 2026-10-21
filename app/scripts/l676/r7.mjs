// LIFE-676 R7 — app/ 에서: node scripts/l676/r7.mjs <root> <out.json>
// ⓐⓑⓓ 연속 푸시 31개(30 간격): 주기 간격(collectedAt 차) · 그 주기 소요(recentDurationsMs 끝값) · pane 변화 없는 구간의 processInfoRequests 증가.
// ⓒ 숨김 전 마지막 푸시 stats → main 에서 창 hide → 8초 → show → 깨움 푸시 stats. 차이에서 깨움 주기 몫(collections·footprintRuns·hostReads 각 1)을 따로 적는다.
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'

const [root, out] = process.argv.slice(2)
const APP = process.cwd()
const cdp = (...args) => JSON.parse(execFileSync('node', [`${APP}/scripts/l676/cdp.mjs`, root, ...args], { encoding: 'utf8', timeout: 120000 }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const N = 31
const collect = `new Promise((resolve) => { const got = []; const stop = window.corral.onResourceSnapshot((s) => { got.push({ at: s.collectedAt, stats: s.stats, panes: s.panes.map((p) => p.paneId).sort().join(',') }); if (got.length === ${N}) { stop(); resolve(got) } }) })`
const pushes = cdp('eval', collect)
const gaps = pushes.slice(1).map((p, i) => p.at - pushes[i].at)
const durations = pushes.slice(1).map((p) => p.stats.recentDurationsMs.at(-1))
const sorted = (xs) => [...xs].sort((a, b) => a - b)
const q = (xs, f) => sorted(xs)[Math.min(xs.length - 1, Math.ceil(f * xs.length) - 1)]
const median = (xs) => { const s = sorted(xs); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const paneSetStable = new Set(pushes.map((p) => p.panes)).size === 1
const piDelta = pushes.at(-1).stats.processInfoRequests - pushes[0].stats.processInfoRequests
// ⓒ
const before = cdp('eval', `new Promise((resolve) => { const stop = window.corral.onResourceSnapshot((s) => { stop(); resolve({ at: s.collectedAt, stats: s.stats }) }) })`)
const hiddenAt = Date.now()
cdp('main', `(() => { const w = globalThis.__l676.electron.BrowserWindow.getAllWindows()[0]; w.hide(); return w.isVisible() })()`)
await sleep(8000)
const wakeExpr = `new Promise((resolve) => { const stop = window.corral.onResourceSnapshot((s) => { stop(); resolve({ at: s.collectedAt, stats: s.stats }) }) })`
// 깨움 푸시 구독은 별도 프로세스(비동기)로 먼저 걸고, 붙을 시간을 준 뒤 창을 다시 보인다 — 동기 실행이면 show 전에 막힌다.
const wakeP = new Promise((resolve, reject) => { execFile('node', [`${APP}/scripts/l676/cdp.mjs`, root, 'eval', wakeExpr], { encoding: 'utf8', timeout: 60000 }, (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout)))) })
await sleep(2000)
const shownAt = Date.now()
cdp('main', `(() => { const w = globalThis.__l676.electron.BrowserWindow.getAllWindows()[0]; w.showInactive(); return w.isVisible() })()`)
const wake = await wakeP
const d = (k) => wake.stats[k] - before.stats[k]
const hidden = { skippedHidden: d('skippedHidden'), collections: d('collections') - 1, footprintRuns: d('footprintRuns') - 1, hostReads: d('hostReads') - 1 }
const result = {
  a: { gapsMs: gaps, minGapMs: Math.min(...gaps), intervalMs: pushes[0].stats.intervalMs, pass: Math.min(...gaps) >= 2000 },
  b: { durationsMs: durations, n: durations.length, medianMs: median(durations), p95Ms: q(durations, 0.95), maxMs: Math.max(...durations), pass: durations.length >= 30 && median(durations) <= 300 },
  c: { before, wake, hiddenAt: new Date(hiddenAt).toISOString(), shownAt: new Date(shownAt).toISOString(), wakeCycle: '깨움 주기 몫 = collections·footprintRuns·hostReads 각 +1 (아래 hidden 은 그것을 뺀 숨김 구간 증가)', rawDelta: { skippedHidden: d('skippedHidden'), collections: d('collections'), footprintRuns: d('footprintRuns'), hostReads: d('hostReads') }, hidden, wakeGapAfterShowMs: wake.at - shownAt, pass: hidden.skippedHidden > 0 && hidden.collections === 0 && hidden.footprintRuns === 0 && hidden.hostReads === 0 },
  d: { paneSetStable, processInfoRequestsFirst: pushes[0].stats.processInfoRequests, processInfoRequestsLast: pushes.at(-1).stats.processInfoRequests, delta: piDelta, cycles: N - 1, pass: paneSetStable && piDelta === 0 },
}
result.pass = result.a.pass && result.b.pass && result.c.pass && result.d.pass
fs.writeFileSync(out, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ pass: result.pass, a: { min: result.a.minGapMs, pass: result.a.pass }, b: { median: result.b.medianMs, p95: result.b.p95Ms, pass: result.b.pass }, c: { raw: result.c.rawDelta, hidden, pass: result.c.pass }, d: { delta: piDelta, stable: paneSetStable, pass: result.d.pass } }))
