// fix2 R2-02 — 보존된 격리 원값(iso-k2.json)을 새 산식(measured 셀 gridForBox)으로 다시 판정한다. 다시 실행하지 않는다 — 기록된 상자·셀·선언·pane 만 쓴다.
// 사용: node rejudge-grid.mjs --in <iso-k2.json> --run <R###> --out <json>   종료코드: 전부 일치 0 · 하나라도 불일치 1
import fs from 'node:fs'
import { declarationMatches, distributionMatches, expectedGridFor, expectedGridOf, gapOf } from './grid-oracle.mjs'

const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
const raw = JSON.parse(fs.readFileSync(args.in, 'utf8'))
const step = (name) => raw.steps.find((row) => row.name === name)
const base = step('base')
const baseExpected = expectedGridOf(base)
const baseGap = gapOf({ panes: base.panes, expected: baseExpected })
const liveCell = (entry) => entry.appearance.find((row) => row.live)?.live ?? null

const scenes = [
  { scene: 'once', step: 'k2d-after-plus', recorded: raw.k2dOnce },
  { scene: 'burst', step: 'k2d-after-burst', recorded: raw.k2dBurst },
  { scene: 'typing', step: 'k2d-after-typing', recorded: raw.k2dTyping },
]
const rows = scenes.map(({ scene, step: name, recorded }) => {
  const entry = step(name)
  const expected = expectedGridOf(entry)
  const declaration = recorded.syncDeclarations.at(-1)
  return {
    scene,
    box: entry.box,
    cell: { live: liveCell(entry), measured: entry.probeCell?.measured ?? null },
    expectedMeasured: expected,
    expectedLiveOld: expectedGridFor({ box: entry.box, cell: liveCell(entry) }),
    recordedExpectedOld: recorded.expected,
    declaration,
    panes: entry.panes.map((pane) => `${pane.cols}x${pane.rows}`),
    declaredMatches: declarationMatches({ declaration, expected }),
    distributionMatches: distributionMatches({ panes: entry.panes, expected, baseGap }),
  }
})
// 재기동 첫 선언(K2ⓔ) — 영역이 둘이라 영역마다 같은 기대값이다(같은 상자 폭 · 이 장면은 기록 상자가 첫 영역 하나).
const back = step('restart-workspace')
const restartExpected = expectedGridOf(back)
const firstRestart = raw.k2e.syncDeclarations[0]
rows.push({ scene: 'restart-first', box: back.box, cell: { live: liveCell(back), measured: back.probeCell?.measured ?? null }, expectedMeasured: restartExpected, expectedLiveOld: expectedGridFor({ box: back.box, cell: liveCell(back) }), recordedExpectedOld: raw.k2e.expectedWithSavedCell, declaration: firstRestart, declaredMatches: declarationMatches({ declaration: firstRestart, expected: restartExpected }), distributionMatches: null })

const pass = rows.every((row) => row.declaredMatches && row.distributionMatches !== false)
const out = { run: args.run, in: args.in, rule: 'expected = gridForBox(parseInt(box) / probe measured cell) — grid-oracle.mjs', base: { expected: baseExpected, gap: baseGap, expectedLiveOld: expectedGridFor({ box: base.box, cell: liveCell(base) }) }, rows, pass }
fs.writeFileSync(args.out, `${JSON.stringify(out, null, 1)}\n`)
for (const row of rows) console.log(`[rejudge ${args.run}] ${row.scene} expected(measured)=${row.expectedMeasured?.cols}x${row.expectedMeasured?.rows} old(live)=${row.expectedLiveOld?.cols}x${row.expectedLiveOld?.rows} decl=${row.declaration} declared=${row.declaredMatches} distribution=${row.distributionMatches}`)
console.log(`[rejudge ${args.run}] pass=${pass}`)
process.exit(pass ? 0 : 1)
