// LIFE-589 E3 기준선 — 구현 전 「목록 읽기」 원가(main 이 할 일의 하한): readdir(withFileTypes) + 항목마다 lstat, 각 20회 p50·p95.
// 사용: node scripts/l589/e3-readdir-probe.mjs <dir>... > out.json
import fs from 'node:fs/promises'
import path from 'node:path'
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] }
const out = []
for (const dir of process.argv.slice(2)) {
  const times = []
  let count = 0
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    await Promise.all(entries.map((entry) => fs.lstat(path.join(dir, entry.name))))
    times.push(performance.now() - t0)
    count = entries.length
  }
  out.push({ dir, entries: count, p50ms: Math.round(pct(times, 50) * 10) / 10, p95ms: Math.round(pct(times, 95) * 10) / 10 })
}
console.log(JSON.stringify({ at: new Date().toISOString(), node: process.version, runs: 20, results: out }, null, 2))
