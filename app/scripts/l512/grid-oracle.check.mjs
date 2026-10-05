// R2-02 — 기대 격자 산식 검사. `node --test scripts/l512/grid-oracle.check.mjs` (vitest 수집 밖).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { declarationMatches, distributionMatches, expectedGridFor, expectedGridOf } from './grid-oracle.mjs'

describe('grid-oracle (R2-02)', () => {
  it('codex r2 재현 — typing 장면: measured 셀이면 89, live 셀이면 90(옛 하네스)', () => {
    const box = { width: '867px', height: '633px' }
    assert.deepEqual(expectedGridOf({ box, probeCell: { live: { width: 9.627906976744185, height: 19 }, measured: { width: 9.6375, height: 19 } } }), { cols: 89, rows: 33 })
    assert.deepEqual(expectedGridFor({ box, cell: { width: 9.627906976744185, height: 19 } }), { cols: 90, rows: 33 })
  })
  it('선언 대조 — 모든 영역이 기대 격자여야 한다 · 빈 선언은 불일치', () => {
    assert.equal(declarationMatches({ declaration: 'g1:w1:t2:89x33', expected: { cols: 89, rows: 33 } }), true)
    assert.equal(declarationMatches({ declaration: 'g1:w1:t2:89x33', expected: { cols: 90, rows: 33 } }), false)
    assert.equal(declarationMatches({ declaration: 'g1:w1:t1:43x33 g2:w1:t2:44x33', expected: { cols: 43, rows: 33 } }), false)
    assert.equal(declarationMatches({ declaration: '', expected: { cols: 43, rows: 33 } }), false)
  })
  it('분배 대조 — 틈이 기준과 같고 rows 가 전부 같아야 한다', () => {
    const expected = { cols: 89, rows: 33 }
    assert.equal(distributionMatches({ panes: [{ cols: 43, rows: 33 }, { cols: 43, rows: 33 }], expected, baseGap: 3 }), true)
    assert.equal(distributionMatches({ panes: [{ cols: 43, rows: 33 }, { cols: 43, rows: 33 }], expected, baseGap: 4 }), false)
    assert.equal(distributionMatches({ panes: [{ cols: 43, rows: 33 }, { cols: 43, rows: 32 }], expected, baseGap: 3 }), false)
  })
})
