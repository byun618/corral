// LIFE-513 K8ⓔ — 외관 측정 차이 목록을 T2(LIFE-512) 마지막 회차와 대조한다. 새로 생기거나 사라지거나 값이 바뀐 차이 행만 낸다.
// 사용: node app/scripts/l513/diff-vs-t2.mjs <T2 diff.json> <T3 diff.json> > <out.md>
import fs from 'node:fs'
const [a, b] = process.argv.slice(2).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
const details = (f) => (Array.isArray(f.detail) ? f.detail : [{ prop: f.detail?.kind ?? '-', ...f.detail }])
const key = (f) => `${f.id}|${f.kind}|${details(f).map((d) => d.prop).join(',')}`
const show = (f) => `${f.id} (${f.kind}) ${details(f).map((d) => `${d.prop}: ${JSON.stringify(d.left)} → ${JSON.stringify(d.right)}${d.delta !== undefined ? ` Δ${d.delta}` : ''}`).join(' · ')}`
const mapA = new Map(a.findings.map((f) => [key(f), f]))
const mapB = new Map(b.findings.map((f) => [key(f), f]))
const lines = [`T2 ${a.findings.length}건 · T3 ${b.findings.length}건`, '', '## T3 에만 있음', '']
for (const [k, f] of mapB) if (!mapA.has(k)) lines.push(`- ${show(f)}`)
lines.push('', '## T2 에만 있음(T3 에서 사라짐)', '')
for (const [k, f] of mapA) if (!mapB.has(k)) lines.push(`- ${show(f)}`)
lines.push('', '## 같은 행, 값이 바뀜', '')
for (const [k, f] of mapB) { const old = mapA.get(k); if (old && JSON.stringify(old.detail) !== JSON.stringify(f.detail)) lines.push(`- T2: ${show(old)}`, `  T3: ${show(f)}`) }
console.log(lines.join('\n'))
