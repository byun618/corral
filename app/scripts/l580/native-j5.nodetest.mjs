// native-j5 계산기 시험 (LIFE-580 R2-A4) — 원인 시각 기준 ⓑ · 원인 없는 전이 보류(5회에서 제외) · 보정 없음 보류 · 초과 미달 · 다음 원인 전 목록만 짝.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeNativeJ5 } from './native-j5.mjs'

const OFFSET = 400 // 서버(맥) − 폰
const recvLine = ({ seq, changedAt, delay, offsetMs = OFFSET }) => {
  const recvAt = changedAt - OFFSET + delay // 폰 시계
  return JSON.stringify({ at: new Date(recvAt).toISOString(), event: 'list_recv', seq, serverAt: changedAt + 5, changedAt, recvAt, offsetMs, rttMs: 40 })
}
const causeLine = (i, causeAt, exit = 0) => JSON.stringify({ i, state: i % 2 === 0 ? 'working' : 'idle', pane: 'w1:p9', causeAt, doneAt: causeAt + 20, exit })

describe('native-j5 계산 (R2-A4)', () => {
  it('ⓑ 는 원인 시각(보고 직전)부터 — main 적용 시각이 아니다 · 적용 시각은 참고값으로만', () => {
    // 원인 → main 적용 2500 ms, 적용 → 폰 200 ms. 적용 기준이면 0.2초지만 원인 기준 ⓑ 는 2.7초+.
    const phone = recvLine({ seq: 1, changedAt: 12_500, delay: 200 })
    const cause = causeLine(0, 10_000)
    const main = JSON.stringify({ at: 12_490, tag: 'agent.push.applied', changed: true })
    const result = computeNativeJ5({ phoneText: phone, causeText: cause, mainText: main, min: 1 })
    assert.equal(result.rows[0].aMs, 200)
    assert.equal(result.rows[0].bMs, 2_700)
    assert.equal(result.rows[0].causeToAppliedMs, 2_490)
    assert.equal(result.verdict, '통과')
    // 원인 → 적용이 4초면 적용 뒤 0.2초여도 미달(리뷰어 예).
    const slow = computeNativeJ5({ phoneText: recvLine({ seq: 1, changedAt: 14_000, delay: 200 }), causeText: cause, min: 1 })
    assert.equal(slow.rows[0].bMs, 4_200)
    assert.equal(slow.verdict, '미달')
  })

  it('원인 시각 없는 전이(보고 실패)는 보류 · 5회에 세지 않는다 → 4회뿐이면 미달', () => {
    const causes = [0, 1, 2, 3, 4].map((i) => causeLine(i, 10_000 + i * 8_000, i === 2 ? 1 : 0)).join('\n')
    const phone = [0, 1, 2, 3, 4].map((i) => recvLine({ seq: i + 1, changedAt: 10_300 + i * 8_000, delay: 150 })).join('\n')
    const result = computeNativeJ5({ phoneText: phone, causeText: causes })
    assert.equal(result.held, 1)
    assert.equal(result.counted, 4)
    assert.equal(result.verdict, '미달')
    // 양성 대조 — 다 성공한 5회.
    const ok = computeNativeJ5({ phoneText: phone, causeText: [0, 1, 2, 3, 4].map((i) => causeLine(i, 10_000 + i * 8_000)).join('\n') })
    assert.equal(ok.counted, 5)
    assert.equal(ok.verdict, '통과')
  })

  it('보정값 없는 수신은 보류 · 다음 원인 뒤에 만든 목록은 앞 전이의 짝이 아니다(미수신)', () => {
    const causes = [causeLine(0, 10_000), causeLine(1, 18_000)].join('\n')
    const phone = [recvLine({ seq: 1, changedAt: 10_300, delay: 100, offsetMs: null }), recvLine({ seq: 2, changedAt: 18_200, delay: 100 })].join('\n')
    const result = computeNativeJ5({ phoneText: phone, causeText: causes, min: 1 })
    assert.equal(result.rows[0].status, '보류')
    assert.equal(result.rows[1].status, '통과')
    const none = computeNativeJ5({ phoneText: recvLine({ seq: 2, changedAt: 18_200, delay: 100 }), causeText: causes, min: 1 })
    assert.equal(none.rows[0].status, '미수신')
    assert.equal(none.verdict, '미달')
  })
})
