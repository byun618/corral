// LIFE-526 fix1 R1-02 대조 — 무해한 자식(빈 setInterval node)을 spawnSync timeout 으로 끊어 status null 을 만들고,
// native-footer-dry.mjs 와 **같은 판정 함수**(child-exit.mjs)가 nonzero 를 내는지, 그 값을 process.exit 로 넘긴 손자 프로세스의 실제 종료코드가 nonzero 인지 본다.
// 대조 둘: 타임아웃(음성 — 기대 2) · 정상 종료 status 0(양성 — 기대 0) · 정상 종료 status 1(기대 1). 옛 꼴(process.exit(run.status))의 종료코드도 같이 적는다.
// 사용(저장소 루트): node app/scripts/l526/child-exit-control.mjs <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { childExit } from './child-exit.mjs'

const out = path.resolve(process.argv[2])
fs.mkdirSync(out, { recursive: true })
const exitOf = (value) => spawnSync(process.execPath, ['-e', `process.exit(${JSON.stringify(value)})`]).status
const cases = [
  { name: 'timeout', args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 300, expect: 2 },
  { name: 'exit0', args: ['-e', 'process.exit(0)'], timeout: 10_000, expect: 0 },
  { name: 'exit1', args: ['-e', 'process.exit(1)'], timeout: 10_000, expect: 1 },
]
const rows = cases.map(({ name, args, timeout, expect }) => {
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout })
  const judged = childExit({ run })
  const realExit = exitOf(judged.code)
  const oldExit = exitOf(run.status)
  return { name, node: process.version, run: { status: run.status, signal: run.signal, error: run.error ? String(run.error.code ?? run.error) : null }, judged, realExit, oldExit, expect, pass: realExit === expect }
})
const result = { rows, pass: rows.every((row) => row.pass) }
fs.writeFileSync(path.join(out, 'child-exit-control.json'), `${JSON.stringify(result, null, 1)}\n`)
for (const row of rows) console.log(`${row.pass ? '통과' : '실패'} ${row.name}: status=${row.run.status} signal=${row.run.signal} error=${row.run.error} → 판정 exit ${row.realExit}(기대 ${row.expect}) · 옛 꼴 exit ${row.oldExit}`)
process.exit(result.pass ? 0 : 1)
