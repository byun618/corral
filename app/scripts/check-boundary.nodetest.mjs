// LIFE-518 K3ⓖ — check:boundary 가 **실제 누출은 계속 잡고** 오탐 꼴은 통과시키는지 `npm test` 에서 지킨다.
// 대조 묶음·실행기는 scripts/boundary-probes/boundary-probes.mjs (src/ 전체를 임시 폴더에 복사해서 돌린다 — 실제 src/ 무접촉).
// 기준 검사기와의 전후 행렬은 LIFE-518 관문(`k3-matrix.mjs`)이 따로 냈다.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { APP_DIR, PROBES, cellState, runProbes } from './boundary-probes/boundary-probes.mjs'

test('check:boundary — 양성 대조는 잡고 음성 대조(오탐 꼴)는 통과시킨다', () => {
  const { clean, cells } = runProbes({ checkerSource: fs.readFileSync(path.join(APP_DIR, 'scripts/check-boundary.mjs'), 'utf8') })
  // 깨끗한 src 가 통과해야 칸마다의 exit 가 그 대조 하나의 효과다.
  assert.deepEqual({ exit: clean.exit, 위반: clean.위반, ipc: clean.ipc }, { exit: 0, 위반: 0, ipc: true })
  const wrong = PROBES.flatMap((probe, index) => {
    const cell = cells[index]
    return cellState({ probe, cell }) !== 'fail' ? [] : [`${probe.id}: 기대 ${probe.expect ?? '위반 0'} · exit ${cell.exit} · ${JSON.stringify(cell.rules)} ${JSON.stringify(cell.tokens)} · 주석언급 ${JSON.stringify(cell.commentTokens)}`]
  })
  assert.deepEqual(wrong, [])
  // 알려진 미검출(LIFE-577 R3-N1)은 통과로 세지 않고 따로 드러낸다 — 실제 결과 그대로.
  const misses = PROBES.flatMap((probe, index) => (cellState({ probe, cell: cells[index] }) === 'known-miss' ? [`${probe.id}: 기대 ${probe.expect} · 실제 미검출(exit ${cells[index].exit}) — ${probe.knownMiss}`] : []))
  for (const miss of misses) console.log(`알려진 미검출 ${miss}`)
})

// LIFE-577 fix4 R4-A3 — 알려진 미검출 칸에서 검사기가 **실행 오류**(보고서 없음)를 내면 「미검출」 이 아니라 실패다. 리뷰어 r4 throw 주입 대조.
test('check:boundary — 알려진 미검출 칸의 검사기 실행 오류는 실패로 센다', () => {
  const probes = PROBES.filter((probe) => probe.knownMiss !== undefined)
  assert.ok(probes.length >= 2)
  const source = fs.readFileSync(path.join(APP_DIR, 'scripts/check-boundary.mjs'), 'utf8')
  const injection = `\nif (${probes.map((probe) => `fs.existsSync(path.join(process.cwd(), ${JSON.stringify(probe.file)}))`).join(' || ')}) throw new Error('injected probe-only checker crash')\n`
  const { clean, cells } = runProbes({ checkerSource: injection + source, probes })
  assert.equal(clean.exit, 0)
  assert.deepEqual(cells.map((cell, index) => cellState({ probe: probes[index], cell })), probes.map(() => 'fail'))
  // 합성 칸 — exit 2·보고서 없음도 실패, 정상 완료 미검출만 known-miss
  assert.equal(cellState({ probe: probes[0], cell: { exit: 2, caught: false, completed: false, rules: [], tokens: [], commentTokens: [] } }), 'fail')
  assert.equal(cellState({ probe: probes[0], cell: { exit: 0, caught: false, completed: true, rules: [], tokens: [], commentTokens: [] } }), 'known-miss')
})
