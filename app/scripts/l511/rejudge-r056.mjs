// LIFE-511 fix2 R2-01 — 커밋된 R056 원자료(fix1/iso-r4)에 강화한 k2-judge 를 다시 적용한다. 앱을 띄우지 않는다.
// 기대: K2 구간(A·B·입력)과 무주입 대조 구간은 통과, 자기점검 주입 구간은 A·B·입력 셋 다 실패. 하나라도 어긋나면 종료코드 1.
// 사용: node rejudge-r056.mjs <iso-r4 폴더> <결과 json>
import fs from 'node:fs'
import path from 'node:path'
import { judgeInputs, judgeOutputPane, judgeQuietPane } from './k2-judge.mjs'

const [dir, outFile] = process.argv.slice(2)
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8')
const saved = JSON.parse(read('iso-fix1.json'))
const STABLE = 60
const echoes = saved.judges.k2.inputs.rows.find((row) => row.pane === 'B').got.length
const pair = ({ from, to, echoes: count }) => ({
  A: judgeOutputPane({ before: read(`read-${from}-A.txt`), after: read(`read-${to}-A.txt`), label: 'A', stableCount: STABLE }),
  B: judgeQuietPane({ before: read(`read-${from}-B.txt`), after: read(`read-${to}-B.txt`), label: 'B', stableCount: STABLE, echoes: count }),
})
const received = (rows) => Object.fromEntries(rows.map((row) => [row.pane, row.got]))
const result = {
  source: dir,
  k2: { ...pair({ from: 'k2-base', to: 'k2-end', echoes }), inputs: judgeInputs({ received: received(saved.judges.k2.inputs.rows), expected: { B: 'q'.repeat(echoes) } }) },
  selfControl: { ...pair({ from: 'self-control', to: 'self-before', echoes: 0 }), inputs: judgeInputs({ received: received(saved.judges.selfControl.inputs.rows), expected: {} }) },
  self: { ...pair({ from: 'self-before', to: 'self-after', echoes: 0 }), inputs: judgeInputs({ received: saved.judges.self.injected, expected: {} }) },
}
const expectations = [
  ['k2.A', result.k2.A.pass, true], ['k2.B', result.k2.B.pass, true], ['k2.inputs', result.k2.inputs.pass, true],
  ['selfControl.A', result.selfControl.A.pass, true], ['selfControl.B', result.selfControl.B.pass, true], ['selfControl.inputs', result.selfControl.inputs.pass, true],
  ['self.A', result.self.A.pass, false], ['self.B', result.self.B.pass, false], ['self.inputs', result.self.inputs.pass, false],
]
result.expectations = expectations.map(([name, got, want]) => ({ name, got, want, ok: got === want }))
fs.writeFileSync(outFile, `${JSON.stringify(result, null, 1)}\n`)
for (const row of result.expectations) console.log(row.ok ? '✔' : '✘', row.name, `pass=${row.got}`, `기대=${row.want}`)
console.log('A 문제(자기점검):', result.self.A.problems, '· B 문제(자기점검):', result.self.B.problems)
process.exit(result.expectations.every((row) => row.ok) ? 0 : 1)
