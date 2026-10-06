import fs from 'node:fs'
const dir = 'measure'
// 인자 없음 = 구현 회차(a r3 · b·c r2). `f1` = fix1 재측정(a·b 만 — c 는 탭바가 없어 다시 재지 않았다).
const suffix = process.argv[2] ?? null
const runs = fs.readdirSync(dir).filter(n => /k7-(before|after)-[abc]-(r[23]|f1)$/.test(n))
const pick = (side, set) => {
  if (suffix !== null) return runs.find(n => n.endsWith(`k7-${side}-${set}-${suffix}`))
  const want = set === 'a' ? (side === 'before' ? 'k7-before-a-r3' : 'k7-after-a-r3') : `k7-${side}-${set}-r2`
  return runs.find(n => n.endsWith(want))
}
const fmt = v => typeof v === 'number' ? Math.round(v * 100) / 100 : v
const rows = []
for (const set of suffix === null ? ['a', 'b', 'c'] : ['a', 'b']) {
  const b = pick('before', set), a = pick('after', set)
  for (const f of fs.readdirSync(`${dir}/${a}`).filter(n => n.endsWith('-diff.json'))) {
    const scene = f.replace('-diff.json', '')
    const load = r => { try { return JSON.parse(fs.readFileSync(`${dir}/${r}/${f}`, 'utf8')) } catch { return null } }
    const db = load(b), da = load(a)
    const by = d => { const m = new Map(); for (const x of d?.findings ?? []) { const k = `${x.id}|${x.kind}`; m.set(k, x) } return m }
    const mb = by(db), ma = by(da)
    rows.push({ scene, before: db?.findings.length ?? '없음', after: da?.findings.length ?? '없음', mb, ma })
  }
}
const lines = []
lines.push('| 장면 | 전 차이 | 후 차이 |', '| --- | --- | --- |')
for (const r of rows) lines.push(`| ${r.scene} | ${r.before} | ${r.after} |`)
lines.push('')
for (const r of rows) {
  lines.push(`### ${r.scene}`, '', '| 단위·종류 | 전 | 후 |', '| --- | --- | --- |')
  const keys = new Set([...r.mb.keys(), ...r.ma.keys()])
  const d = x => x ? [].concat(x.detail ?? []).map(e => e.prop ? `${e.prop} ${fmt(e.left)}→${fmt(e.right)}` : (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 90)).join('; ') || x.kind : '—'
  for (const k of [...keys].sort()) lines.push(`| ${k} | ${d(r.mb.get(k)).replace(/\|/g, '\\|')} | ${d(r.ma.get(k)).replace(/\|/g, '\\|')} |`)
  lines.push('')
}
console.log(`전: ${rows.length && pick('before','a')}, ${pick('before','b')}, ${pick('before','c')}\n후: ${pick('after','a')}, ${pick('after','b')}, ${pick('after','c')}\n`)
console.log(lines.join('\n'))
