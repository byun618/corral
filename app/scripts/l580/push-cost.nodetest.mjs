// push-cost 집계 시험 (LIFE-580 R1 C3) — 같은 seq 의 합 · 표본 0 실패 · 기동 구간 나누기 · 구독자 0 push 제외.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { aggregatePushCost } from './push-cost.mjs'

const line = (entry) => JSON.stringify({ ts: 'x', ...entry })
const built = (seq, buildMs, at = 1000 + seq) => line({ at, tag: 'mobile.list_built', seq, bytes: 100, buildMs, subscribers: 1 })
const push = (seq, sendMs, at = 1001 + seq, subscribers = 1) => line({ at, tag: 'mobile.list_push', seq, subscribers, sendMs })

describe('push-cost (L10ⓓ)', () => {
  it('같은 seq 의 buildMs + sendMs 를 더해 p95 — 개별 값이 아니라 합으로 판정', () => {
    // 각각은 5 ms 안이지만 합은 5 ms 를 넘는다 — 개별 값으로 통과시키면 안 되는 경우.
    const text = [built(1, 3), push(1, 3), built(2, 1), push(2, 0.5), line({ tag: 'other', at: 1 })].join('\n')
    const result = aggregatePushCost({ text, limitMs: 5 })
    assert.equal(result.samples, 2)
    assert.equal(result.max, 6)
    assert.equal(result.p95, 6)
    assert.equal(result.verdict, '미달')
  })

  it('표본 0 이면 실패 — 빈 로그 · 만들기만 · 구독자 0 push', () => {
    assert.equal(aggregatePushCost({ text: '' }).verdict, '미달')
    assert.equal(aggregatePushCost({ text: [built(1, 1)].join('\n') }).verdict, '미달')
    const zeroSubs = aggregatePushCost({ text: [built(1, 1), push(1, 1, 1002, 0)].join('\n') })
    assert.equal(zeroSubs.samples, 0)
    assert.equal(zeroSubs.verdict, '미달')
  })

  it('기동이 바뀌어 seq 가 다시 1 — 구간을 나눠 짝을 맞춘다 · --since 앞 줄은 뺀다', () => {
    const text = [built(1, 1, 10), push(1, 1, 11), built(2, 1, 20), push(2, 1, 21), built(1, 2, 30), push(1, 2, 31)].join('\n')
    const all = aggregatePushCost({ text })
    assert.equal(all.segments, 2)
    assert.equal(all.samples, 3)
    assert.deepEqual(all.rows.map((row) => row.totalMs).sort(), [2, 2, 4])
    const later = aggregatePushCost({ text, since: 30 })
    assert.equal(later.samples, 1)
    assert.equal(later.rows[0].totalMs, 4)
  })

  it('양성 대조 — 합 p95 가 5 ms 안이면 통과', () => {
    const text = Array.from({ length: 20 }, (_, i) => [built(i + 1, 0.8), push(i + 1, 0.4)].join('\n')).join('\n')
    const result = aggregatePushCost({ text })
    assert.equal(result.samples, 20)
    assert.equal(result.p95, 1.2)
    assert.equal(result.verdict, '통과')
  })
})
