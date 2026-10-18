// LIFE-593 최종 관문 E7 — G41~G47(corral)·G51~G53(20만) 표본을 모아 n·p50·p95(최근순위)·max. raw/claude/final 에서 실행: node <이 파일>(.mjs) → G69-e7-pool.json
import fs from 'node:fs'
const p = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : null }
const st = (a) => ({ n: a.length, p50: p(a, 0.5), p95: p(a, 0.95), max: a.length ? Math.max(...a) : null })
const groups = { corral: ['G41-e7-corral-1','G42-e7-corral-2','G43-e7-corral-3','G44-e7-corral-4','G45-e7-corral-5','G46-e7-corral-6','G47-e7-corral-7'], '200k': ['G51-e7-200k-1','G52-e7-200k-2','G53-e7-200k-3'] }
const out = {}
for (const [g, ids] of Object.entries(groups)) {
  const js = ids.map((id) => ({ id, ...JSON.parse(fs.readFileSync(id + '.json', 'utf8')) }))
  const num = (arr) => arr.map((s) => typeof s === 'number' ? s : s.ms).filter((v) => typeof v === 'number')
  out[g] = {
    runs: js.map((j) => ({ id: j.id, exit: j.exitCode, first: j.samples.firstOpenMs, keysMiss: j.summary.keys.misses, toggleMiss: j.summary.toggleOn?.misses, long: j.summary.longOver100, ignNm: j.ignoredList?.nm, ignGit: j.ignoredList?.git, total: j.listTotal })),
    first: st(js.map((j) => j.samples.firstOpenMs)),
    reopen: st(js.flatMap((j) => num(j.samples.reopenMs ?? []))),
    keys: st(js.flatMap((j) => num(j.samples.keys ?? []))),
    toggleOnAll: st(js.flatMap((j) => num(j.samples.toggleOnMs ?? []))),
    toggleOnFixed: st(js.filter((j) => ['G46-e7-corral-6','G47-e7-corral-7'].includes(j.id) || g === '200k').flatMap((j) => num(j.samples.toggleOnMs ?? []))),
    filterKeys: st(js.flatMap((j) => num(j.samples.filterKeys ?? []))),
    longOver100: js.reduce((a, j) => a + j.summary.longOver100, 0),
  }
}
fs.writeFileSync('G69-e7-pool.json', JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 1))
