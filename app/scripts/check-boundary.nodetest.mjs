// LIFE-518 K3ⓖ — check:boundary 가 **실제 누출은 계속 잡고** 오탐 꼴은 통과시키는지 `npm test` 에서 지킨다.
// 대조 묶음·실행기는 scripts/l518/boundary-probes.mjs (src/ 전체를 임시 폴더에 복사해서 돌린다 — 실제 src/ 무접촉).
// 기준 검사기와의 전후 행렬은 scripts/l518/k3-matrix.mjs 가 따로 낸다.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { APP_DIR, PROBES, runProbes } from './l518/boundary-probes.mjs'

test('check:boundary — 양성 대조는 잡고 음성 대조(오탐 꼴)는 통과시킨다', () => {
  const { clean, cells } = runProbes(fs.readFileSync(path.join(APP_DIR, 'scripts/check-boundary.mjs'), 'utf8'))
  // 깨끗한 src 가 통과해야 칸마다의 exit 가 그 대조 하나의 효과다.
  assert.deepEqual({ exit: clean.exit, 위반: clean.위반, ipc: clean.ipc }, { exit: 0, 위반: 0, ipc: true })
  const wrong = PROBES.flatMap((probe, index) => {
    const cell = cells[index]
    const ok = probe.expect === null ? !cell.caught && cell.exit === 0 : cell.caught && cell.exit === 1
    return ok ? [] : [`${probe.id}: 기대 ${probe.expect ?? '위반 0'} · exit ${cell.exit} · ${JSON.stringify(cell.rules)} ${JSON.stringify(cell.tokens)}`]
  })
  assert.deepEqual(wrong, [])
})
