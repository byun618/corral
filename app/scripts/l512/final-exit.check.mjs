// R1-05 양성 대조 — 잔존 문자열을 주입하면 실패로 바뀌어야 한다. `node --test scripts/l512/final-exit.check.mjs` (vitest 수집 밖 — k2-judge.check.mjs 와 같은 이름 규칙).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { finalExit, ledgerResult, LEFTOVER_EXIT } from './final-exit.mjs'

describe('finalExit (R1-05)', () => {
  it('잔존 없음 + 검사 통과 → 0 · 통과', () => {
    const out = finalExit({ exitCode: 0, left: '' })
    assert.deepEqual(out, { exitCode: 0, leftover: false })
    assert.equal(ledgerResult({ ...out, error: undefined, failed: [] }), '통과')
  })
  it('양성 대조: 잔존 주입 + 검사 통과 → nonzero · 원장 실패', () => {
    const out = finalExit({ exitCode: 0, left: '12345 /tmp/l512i6/herdr server\n' })
    assert.equal(out.exitCode, LEFTOVER_EXIT)
    assert.notEqual(out.exitCode, 0)
    assert.match(ledgerResult({ ...out, error: undefined, failed: [] }), /^실패 — .*잔존/)
  })
  it('검사 실패와 잔존이 겹치면 먼저 난 종료코드를 두고 이유에 둘 다 적는다', () => {
    const out = finalExit({ exitCode: 1, left: '1 x' })
    assert.equal(out.exitCode, 1)
    assert.equal(ledgerResult({ ...out, error: undefined, failed: ['k7-pane-values'] }), '실패 — k7-pane-values · 끝에 프로세스 잔존(guard-after.txt)')
  })
  it('공백뿐인 pgrep 출력은 잔존이 아니다', () => {
    assert.equal(finalExit({ exitCode: 0, left: '\n' }).exitCode, 0)
  })
})
