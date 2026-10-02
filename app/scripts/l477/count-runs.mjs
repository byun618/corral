// LIFE-477 수정 라운드 1 (R3) — `runs.md` 의 **칸만** 세어 항목별 실행 n/총 m 을 낸다(validation.md H8ⓑ). 원자료를 훑어 회차를 추측하지 않는다.
//   · 「실행 목록」 표: 한 실행 = 한 행(실행 id · … · 통과/실패 칸)
//   · 「항목별 결과」 표: (실행 id, 477 항목, 항목 결과) — 한 실행이 여러 항목을 판정하면 항목마다 한 행. 항목 n/m = 그 항목 행 중 「통과」 / 전체
// 정합 검사(하나라도 어긋나면 exit 1): 항목 표의 실행 id 가 실행 목록에 있다 · 실행 목록의 모든 id 가 항목 표에 한 번 이상 있다 ·
// 실행 목록 최종 칸이 「실패」 인데 항목 행이 전부 「통과」 이면 그 행 근거 칸이 비지 않았다(실패 사유가 다른 항목에 있거나 면제 사유가 적혀 있다).
// 사용: node count-runs.mjs <runs.md> [--out <md>]
import fs from 'node:fs'

const file = process.argv[2]
const outIndex = process.argv.indexOf('--out')
const text = fs.readFileSync(file, 'utf8')

const section = (title) => {
  const start = text.indexOf(`## ${title}`)
  if (start < 0) throw new Error(`「${title}」 절이 없다`)
  const rest = text.slice(start)
  const next = rest.indexOf('\n## ', 3)
  return (next < 0 ? rest : rest.slice(0, next)).split('\n').filter((line) => /^\| [A-Z]\d{3} \|/.test(line))
}
const cells = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim())

const runs = section('실행 목록').map((line) => {
  const c = cells(line)
  return { id: c[0], verdict: c[c.length - 1].startsWith('통과') ? '통과' : c[c.length - 1].startsWith('실패') ? '실패' : c[c.length - 1].startsWith('미확정') ? '미확정' : c[c.length - 1] }
})
const items = section('항목별 결과').map((line) => {
  const c = cells(line)
  return { id: c[0], item: c[1], result: c[2], basis: c[3] ?? '' }
})

const problems = []
const runIds = new Set(runs.map((run) => run.id))
if (runIds.size !== runs.length) problems.push('실행 목록에 같은 id 가 두 번')
for (const row of items) {
  if (!runIds.has(row.id)) problems.push(`항목 표의 ${row.id} 가 실행 목록에 없다`)
  if (!['통과', '실패', '미확정'].includes(row.result)) problems.push(`${row.id} ${row.item} 결과 칸 「${row.result}」`)
}
for (const run of runs) {
  const mine = items.filter((row) => row.id === run.id)
  if (mine.length === 0) problems.push(`실행 ${run.id} 가 항목 표에 없다`)
  if (!['통과', '실패', '미확정'].includes(run.verdict)) problems.push(`실행 ${run.id} 최종 칸 「${run.verdict}」`)
  if (run.verdict === '실패' && mine.length > 0 && mine.every((row) => row.result === '통과') && mine.every((row) => row.basis === ''))
    problems.push(`실행 ${run.id} 는 실패인데 항목 행이 전부 통과이고 사유가 없다`)
  if (run.verdict === '통과' && mine.some((row) => row.result === '실패')) problems.push(`실행 ${run.id} 는 통과인데 항목 실패 행이 있다`)
  if (run.verdict === '미확정' && mine.some((row) => row.result !== '미확정')) problems.push(`실행 ${run.id} 는 미확정(원자료 없음)인데 항목 행이 통과/실패다`)
}

const order = (item) => {
  const m = /^([A-Z]+)(\d+)$/.exec(item)
  return m === null ? [9, 0] : [m[1] === 'K' ? 0 : 1, Number(m[2])]
}
const byItem = new Map()
for (const row of items) {
  if (!byItem.has(row.item)) byItem.set(row.item, [])
  byItem.get(row.item).push(row)
}
const lines = [...byItem.entries()]
  .sort(([a], [b]) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])
  .map(([item, rows]) => {
    const pass = rows.filter((row) => row.result === '통과')
    const fail = rows.filter((row) => row.result === '실패')
    const open = rows.filter((row) => row.result === '미확정')
    const total = open.length > 0 ? '미확정' : String(rows.length)
    return `| ${item} | ${pass.length}/${total} | ${pass.map((row) => row.id).join(' ')} | ${fail.map((row) => row.id).join(' ') || '—'} | ${open.map((row) => row.id).join(' ') || '—'} |`
  })
const report = [
  '# LIFE-477 실행 회차 집계 — runs.md 칸만 센 값',
  '',
  `생성: \`node app/scripts/l477/count-runs.mjs ${file}\` — 「실행 목록」 ${runs.length}행 · 「항목별 결과」 ${items.length}행. 원자료는 읽지 않는다.`,
  '',
  '| 항목 | 실행 n/총 m | 통과 실행 | 실패 실행 | 미확정 |',
  '| --- | --- | --- | --- | --- |',
  ...lines,
  '',
  problems.length === 0 ? '정합 검사: 어긋남 0' : `정합 검사: **어긋남 ${problems.length}**\n\n${problems.map((p) => `- ${p}`).join('\n')}`,
  '',
].join('\n')
if (outIndex > 0) fs.writeFileSync(process.argv[outIndex + 1], report)
console.log(report)
process.exit(problems.length === 0 ? 0 : 1)
