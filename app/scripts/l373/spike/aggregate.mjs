// 회차 원자료를 시나리오별 **중앙값**으로 접는다. 회차 간 흔들림(min~max)도 같이 남긴다 —
// writeP95 가 n8 에서 회차마다 6.9↔21.6ms 로 갈렸다. 중앙값만 쓰면 그 사실이 사라진다.
//
// 입력은 `runs/*.json`(실행 단위 원본)이다. summary*.json 은 그 실행 호출의 부분집합일 수
// 있어(필터 실행이 덮어쓴다) 집계 입력으로 쓰지 않는다.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(path.dirname(path.dirname(path.dirname(HERE))))
const RAW = path.join(REPO, 'specs/LIFE-373-mru-pane-split/raw/spike')
const RUNS = path.join(RAW, 'runs')

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
for (const file of fs.readdirSync(RUNS).sort()) {
  if (!file.endsWith('.json')) continue
  const run = JSON.parse(fs.readFileSync(path.join(RUNS, file), 'utf8'))
  if (run.failed === true) {
    console.warn('skip failed run', file)
    continue
  }
  const name = run.scenario.name
  if (!byName.has(name)) byName.set(name, [])
  byName.get(name).push(run)
}

const IDLE_CPU = 1.8 // 대조군 c-idle-* 의 중앙값 — 프레임당 비용 계산에서 뺀다

const rows = []
for (const [name, runs] of byName) {
  const s = runs[0].scenario
  const g = (fn) => runs.map(fn)
  const cpu = median(g((r) => r.ps.rendererCpuPct))
  const written = median(g((r) => r.totals.writtenPerSec))
  rows.push({
    name,
    group: s.group,
    panes: s.panes.count,
    geometry: `${s.panes.cols}x${s.panes.rows}`,
    mode: s.mode,
    paceMs: s.paceMs,
    skip: s.skip,
    activePanes: s.activePanes,
    observeDom: s.observeDom,
    scale: median(g((r) => r.scale)),
    reps: runs.length,
    writtenPerSecTotal: written,
    writtenPerSecPerPane: median(g((r) => r.totals.perPaneWrittenPerSec)),
    renderPerSecPerPane: median(g((r) => r.totals.perPaneRenderPassesPerSec)),
    renderPerSecTotal: +(median(g((r) => r.totals.perPaneRenderPassesPerSec)) * s.panes.count).toFixed(2),
    dropRate: median(g((r) => r.totals.dropRate)),
    bytesPerSec: median(g((r) => r.totals.bytesPerSec)),
    writeP50: median(g((r) => r.writeMs.p50)),
    writeP95: median(g((r) => r.writeMs.p95)),
    writeP95Span: span(g((r) => r.writeMs.p95)),
    writeMax: median(g((r) => r.writeMs.max)),
    queueP95: median(g((r) => r.queueMs.p95)),
    rafPerSec: median(g((r) => r.raf.perSec)),
    rafGapP50: median(g((r) => r.raf.gapMs.p50)),
    rafGapP95: median(g((r) => r.raf.gapMs.p95)),
    rafGapP95Span: span(g((r) => r.raf.gapMs.p95)),
    rafGapMax: median(g((r) => r.raf.gapMs.max)),
    longTaskCount: median(g((r) => r.longTasks.count)),
    longTaskMaxMs: median(g((r) => r.longTasks.maxMs)),
    cpuPct: cpu,
    cpuPctSpan: span(g((r) => r.ps.rendererCpuPct)),
    mainCpuPct: median(g((r) => r.ps.mainCpuPct)),
    rssMb: +(median(g((r) => r.ps.rssKbMax)) / 1024).toFixed(1),
    // 프레임 한 장(= pane 하나의 전체 리페인트)에 드는 렌더러 CPU 시간 추정.
    // (CPU% − idle CPU%) ÷ 초당 쓰기 수 ÷ 100 × 1000 ms
    msPerFrame: written > 0 && cpu !== null ? +(((cpu - IDLE_CPU) / 100 / written) * 1000).toFixed(2) : null,
  })
}

const order = ['control', 'M1', 'M3', 'M5']
rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name))
fs.writeFileSync(path.join(RAW, 'aggregate.json'), JSON.stringify({ idleCpuPct: IDLE_CPU, rows }, null, 2) + '\n')

const f = (v, d = 1) => (v === null || v === undefined ? '–' : typeof v === 'number' ? v.toFixed(d) : String(v))
const lines = [
  '| 시나리오 | 회차 | pane | 격자 | 모드 | 쓰기/s (전체) | 렌더/s (pane당) | write p50/p95 (ms) | rAF/s | rAF 간격 p95 (ms) | CPU% | ms/프레임 | RSS(MB) |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
]
for (const r of rows) {
  lines.push(
    `| ${r.name} | ${r.reps} | ${r.panes} | ${r.geometry} | ${r.mode}${r.skip === true ? '+skip' : r.skip === false ? '−skip' : ''} | ` +
      `${f(r.writtenPerSecTotal, 1)} | ${f(r.renderPerSecPerPane, 1)} | ${f(r.writeP50, 1)}/${f(r.writeP95, 1)} | ` +
      `${f(r.rafPerSec, 1)} | ${f(r.rafGapP95, 1)} | ${f(r.cpuPct, 1)} | ${f(r.msPerFrame, 2)} | ${f(r.rssMb, 0)} |`,
  )
}
fs.writeFileSync(path.join(RAW, 'aggregate-table.md'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
