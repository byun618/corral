// LIFE-518 fix2~fix4 — 칸 묶음(JSON: [{ id, source, file?, expect? }])을 기준·직전 수정(fix4 에서 fix3 · fix5 에서 fix4)·지금 검사기로 돌려 비교한다.
// expect 기본값 'R4-wire-leak'(잡혀야 함), null 이면 오탐 꼴(안 잡혀야 함). file 기본값 renderer `.ts`.
// 사용: node scripts/l518/cells-compare.mjs <cells.json 경로 또는 git 경로 rev:path> — src 복사본에서만 돈다(G6).
// 지금 검사기가 기대와 다른 칸이 하나라도 있으면 exit 1 (fix3 R3-claude-03 — 관찰 표가 판정처럼 세이지 않게).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, runProbes } from './boundary-probes.mjs'

const [cellsArg] = process.argv.slice(2)
const git = (...args) => execFileSync('git', args, { cwd: APP_DIR, encoding: 'utf8' })
const raw = fs.existsSync(cellsArg) ? fs.readFileSync(cellsArg, 'utf8') : git('show', cellsArg)
const probes = JSON.parse(raw).map((cell) => ({
  id: cell.id,
  source: cell.source,
  expect: cell.expect === undefined ? 'R4-wire-leak' : cell.expect,
  file: cell.file ?? `src/renderer/src/boundary-probe-cells-${cell.id}.ts`,
}))
const CHECKERS = [
  { 이름: '기준 e92e66da', source: git('show', 'e92e66da:app/scripts/check-boundary.mjs') },
  { 이름: 'fix4 0b29b0df', source: git('show', '0b29b0df:app/scripts/check-boundary.mjs') },
  { 이름: '지금', source: fs.readFileSync(path.join(APP_DIR, 'scripts/check-boundary.mjs'), 'utf8') },
]
const results = CHECKERS.map((checker) => runProbes({ checkerSource: checker.source, probes }))
const mark = (cell) => (cell.caught ? '잡음' : '안 잡음')
console.log(`# 칸 묶음 비교 — ${cellsArg}\n\n- HEAD ${git('rev-parse', 'HEAD').trim()} · node ${process.version} · 깨끗한 src 지금 exit ${results[2].clean.exit} 위반 ${results[2].clean.위반}\n`)
console.log(`| 칸 | 기대 | ${CHECKERS.map((checker) => checker.이름).join(' | ')} | 지금 기대대로 | fix4→지금 |`)
console.log(`| --- | --- | ${CHECKERS.map(() => '---').join(' | ')} | --- | --- |`)
let mismatch = 0
probes.forEach((probe, index) => {
  const [b, f, h] = results.map((result) => result.cells[index])
  const ok = probe.expect === null ? !h.caught : h.caught
  if (!ok) mismatch++
  const change = f.caught === h.caught ? '같음' : h.caught ? '새로 잡음' : '새로 놓침'
  console.log(`| ${probe.id} | ${probe.expect ?? '위반 0'} | ${mark(b)} | ${mark(f)} | ${mark(h)} | ${ok ? '예' : '**아니오**'} | ${change} |`)
})
console.log(`\n지금 기대 불일치 ${mismatch}칸`)
process.exit(mismatch === 0 ? 0 : 1)
