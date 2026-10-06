// LIFE-527 fix2 H5 — 창 bounds 를 직접 읽어 애니메이션이 멎을 때까지 기다린다(더블클릭 확대·원복 판정용, 다음 행 boundsBefore 추론 대신).
// 실행: node settle-bounds.mjs <창 번호>  → {settled, samples:[{t,bounds}]} — 100ms 간격, 연속 3회 같으면 멎음, 최대 3초.
import { execFileSync } from 'node:child_process'
const windowNumber = Number(process.argv[2])
const read = () => JSON.parse(execFileSync('/tmp/l527-cgwin', ['list'], { encoding: 'utf8' })).find((w) => w.number === windowNumber)?.bounds ?? null
const samples = []
const start = Date.now()
let same = 0
while (Date.now() - start < 3000) {
  const bounds = read()
  const last = samples.at(-1)?.bounds
  same = last && JSON.stringify(last) === JSON.stringify(bounds) ? same + 1 : 0
  samples.push({ t: Date.now() - start, bounds })
  if (same >= 2) break
  execFileSync('/bin/sleep', ['0.1'])
}
console.log(JSON.stringify({ settled: same >= 2 ? samples.at(-1).bounds : null, samples }))
