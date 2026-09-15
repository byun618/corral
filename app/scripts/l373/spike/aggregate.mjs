// 3회차 원자료를 시나리오별 **중앙값**으로 접는다. 회차 간 흔들림(min~max)도 같이 남긴다 —
// writeP95 가 n8 에서 회차마다 6.9↔21.6ms 로 갈렸다. 중앙값만 쓰면 그 사실이 사라진다.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(path.dirname(path.dirname(path.dirname(HERE))))
const RAW = path.join(REPO, 'specs/LIFE-373-mru-pane-split/raw/spike')

const reps = ['summary.json', 'summary.r2.json', 'summary.r3.json']
  .map((f) => path.join(RAW, f))
  .filter((f) => fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))

const median = (values) => {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (v.length === 0) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? v[m] : +((v[m - 1] + v[m]) / 2).toFixed(3)
}
const span = (values) => {
  const v = values.filter((x) => typeof x === 'number')
  return v.length === 0 ? null : [Math.min(...v), Math.max(...v)]
}

const byName = new Map()
for (const rep of reps) {
  for (const run of rep.runs) {
    if (!byName.has(run.name)) byName.set(run.name, [])
    byName.get(run.name).push(run)
  }
}

const IDLE_CPU = 1.8 // 대조군 c-idle-* 의 중앙값 — 프레임당 비용 계산에서 뺀다

const rows = []
for (const [name, runs] of byName) {
  const g = (fn) => runs.map(fn)
  const cpu = median(g((r) => r.rendererCpuPct))
  const written = median(g((r) => r.writtenPerSecTotal))
  const rows_ = {
    name,
    group: runs[0].group,
    panes: runs[0].panes,
    geometry: runs[0].geometry,
    mode: runs[0].mode,
    skip: runs[0].skip,
    activePanes: runs[0].activePanes,
    observeDom: runs[0].observeDom,
    scale: runs[0].scale,
    n: runs.length,
    writtenPerSecTotal: written,
    writtenPerSecPerPane: median(g((r) => r.writtenPerSecPerPane)),
    renderPerSecPerPane: median(g((r) => r.renderPassesPerSecPerPane)),
    renderPerSecTotal: +(median(g((r) => r.renderPassesPerSecPerPane)) * runs[0].panes).toFixed(2),
    dropRate: median(g((r) => r.dropRate)),
    bytesPerSec: median(g((r) => r.bytesPerSec)),
    writeP50: median(g((r) => r.writeMs.p50)),
    writeP95: median(g((r) => r.writeMs.p95)),
    writeP95Span: span(g((r) => r.writeMs.p95)),
    writeMax: median(g((r) => r.writeMs.max)),
    queueP95: median(g((r) => r.queueMs.p95)),
    rafPerSec: median(g((r) => r.rafPerSec)),
    rafGapP50: median(g((r) => r.rafGapMs.p50)),
    rafGapP95: median(g((r) => r.rafGapMs.p95)),
    rafGapP95Span: span(g((r) => r.rafGapMs.p95)),
    rafGapMax: median(g((r) => r.rafGapMs.max)),
    longTaskCount: median(g((r) => r.longTasks.count)),
    longTaskMaxMs: median(g((r) => r.longTasks.maxMs)),
    cpuPct: cpu,
    cpuPctSpan: span(g((r) => r.rendererCpuPct)),
    mainCpuPct: median(g((r) => r.mainCpuPct)),
    rssMb: +(median(g((r) => r.rssKbMax)) / 1024).toFixed(1),
    // 프레임 한 장(= pane 하나의 전체 리페인트)에 드는 메인 코어 시간 추정.
    // (CPU% − idle CPU%) ÷ 초당 쓰기 수 ÷ 100 × 1000 ms
    msPerFrame:
      written > 0 && cpu !== null ? +(((cpu - IDLE_CPU) / 100 / written) * 1000).toFixed(2) : null,
  }
  rows.push(rows_)
}

const order = ['control', 'M1', 'M3', 'M5']
rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name))
fs.writeFileSync(path.join(RAW, 'aggregate.json'), JSON.stringify({ reps: reps.length, idleCpuPct: IDLE_CPU, rows }, null, 2) + '\n')

const f = (v, d = 1) => (v === null || v === undefined ? '–' : typeof v === 'number' ? v.toFixed(d) : String(v))
const lines = [
  '| 시나리오 | pane | 격자 | 모드 | 쓰기/s (전체) | 렌더/s (pane당) | write p95 (ms) | rAF 간격 p95 (ms) | CPU% | ms/프레임 | RSS(MB) |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
]
for (const r of rows) {
  lines.push(
    `| ${r.name} | ${r.panes} | ${r.geometry} | ${r.mode}${r.skip === true ? '+skip' : r.skip === false ? '−skip' : ''} | ` +
      `${f(r.writtenPerSecTotal, 1)} | ${f(r.renderPerSecPerPane, 1)} | ${f(r.writeP95, 1)} | ${f(r.rafGapP95, 1)} | ` +
      `${f(r.cpuPct, 1)} | ${f(r.msPerFrame, 2)} | ${f(r.rssMb, 0)} |`,
  )
}
fs.writeFileSync(path.join(RAW, 'aggregate-table.md'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
