// LIFE-511 fix1 R1-07 — k2-judge.mjs 판별력 검사(양성·음성 대조). `node --test app/scripts/l511/k2-judge.check.mjs`
import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeInputs, judgeOutputPane, judgeQuietPane } from './k2-judge.mjs'

const stable = (label, n = 5) => Array.from({ length: n }, (_, i) => `STABLE-${label}-${String(i + 1).padStart(3, '0')} abcd`)
const ticks = (label, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `tick ${label} ${from + i}`)
const join = (list) => `${list.join('\n')}\n\n`

test('입력 — 기대대로면 통과, 다른 pane 에 한 글자라도 가면 실패, 기대 pane 이 덜 받아도 실패', () => {
  assert.equal(judgeInputs({ received: { A: '', B: 'qq' }, expected: { B: 'qq' } }).pass, true)
  assert.deepEqual(judgeInputs({ received: { A: 'z', B: 'qq' }, expected: { B: 'qq' } }).bad.map((row) => row.pane), ['A'])
  assert.equal(judgeInputs({ received: { B: 'q' }, expected: { B: 'qq' } }).pass, false)
})

test('출력 pane — 안정 블록 그대로 + tick 연속 증가면 통과', () => {
  const before = join(['$ node pane-sink', ...stable('A'), ...ticks('A', 1, 3)])
  const after = join(['$ node pane-sink', ...stable('A'), ...ticks('A', 1, 40)])
  assert.equal(judgeOutputPane({ before, after, label: 'A', stableCount: 5 }).pass, true)
})

test('출력 pane 양성 대조 — 입력 메아리·훼손·안정 줄 변경·tick 끊김·출력 정지를 잡는다', () => {
  const before = join([...stable('A'), ...ticks('A', 1, 3)])
  const cases = {
    echo: join([...stable('A'), ...ticks('A', 1, 5), 'got 1B', ...ticks('A', 6, 9)]),
    corrupt: join([...stable('A'), ...ticks('A', 1, 5), 'CORRUPTED', ...ticks('A', 7, 9)]),
    stableChanged: join([...stable('A').map((line, i) => (i === 2 ? 'STABLE-A-003 zzzz' : line)), ...ticks('A', 1, 9)]),
    gap: join([...stable('A'), ...ticks('A', 1, 5), ...ticks('A', 7, 9)]),
    stalled: join([...stable('A'), ...ticks('A', 1, 3)]),
  }
  for (const [name, after] of Object.entries(cases)) assert.equal(judgeOutputPane({ before, after, label: 'A', stableCount: 5 }).pass, false, name)
})

test('조용한 pane — 전 텍스트 그대로 + got 1B 정확히 n 줄이면 통과', () => {
  const before = join(['$ node pane-sink', ...stable('B')])
  const after = join(['$ node pane-sink', ...stable('B'), 'got 1B', 'got 1B'])
  assert.equal(judgeQuietPane({ before, after, label: 'B', stableCount: 5, echoes: 2 }).pass, true)
})

test('조용한 pane 양성 대조 — 줄 훼손·삭제·다른 줄·메아리 수 틀림을 잡는다', () => {
  const before = join([...stable('B'), 'got 1B'])
  const cases = {
    corrupted: join([...stable('B').slice(0, 3), 'CORRUPTED', ...stable('B').slice(4), 'got 1B', 'got 1B']),
    removed: join([...stable('B').slice(1), 'got 1B', 'got 1B']),
    other: join([...stable('B'), 'got 1B', 'got 1B', 'xyz']),
    count: join([...stable('B'), 'got 1B', 'got 1B', 'got 1B']),
  }
  for (const [name, after] of Object.entries(cases)) assert.equal(judgeQuietPane({ before, after, label: 'B', stableCount: 5, echoes: 1 }).pass, false, name)
})
