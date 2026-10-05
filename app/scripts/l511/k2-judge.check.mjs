// LIFE-511 fix1 R1-07 — k2-judge.mjs 판별력 검사(양성·음성 대조). `node --test app/scripts/l511/k2-judge.check.mjs`
import fs from 'node:fs'
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

// r2 R2-01 — 커밋된 R056 원자료(fix1/iso-r4)로 양성·음성 대조. 리뷰가 재현한 변조 3종이 전부 실패해야 한다.
const R056 = new URL('../../../specs/LIFE-511-settings-frame/raw/claude/fix1/iso-r4/', import.meta.url)
const readR056 = (name) => fs.readFileSync(new URL(name, R056), 'utf8')

test('R056 원본 A 쌍(k2-base → k2-end)은 통과한다 — 양성 대조', () => {
  const verdict = judgeOutputPane({ before: readR056('read-k2-base-A.txt'), after: readR056('read-k2-end-A.txt'), label: 'A', stableCount: 60 })
  assert.deepEqual(verdict.problems, [])
  assert.equal(verdict.pass, true)
})

test('R056 A 후 텍스트 변조 3종(옛 tick 삭제 · 안정 블록 사이 삽입 · 프롬프트 삭제)은 실패한다 — 음성 대조', () => {
  const before = readR056('read-k2-base-A.txt')
  const after = readR056('read-k2-end-A.txt')
  const rows = after.split('\n')
  const variants = {
    oldTicksRemoved: rows.filter((line) => !/^tick A [1-8]\s*$/.test(line)).join('\n'),
    insertedInStable: rows.flatMap((line) => (line.startsWith('STABLE-A-030') ? ['CORRUPTED', line] : [line])).join('\n'),
    promptRemoved: rows.slice(rows.findIndex((line) => line.startsWith('STABLE-A-001'))).join('\n'),
  }
  // 변조가 실제로 일어났는지(같은 텍스트로 「실패」 를 보는 것이 아님)
  for (const [name, text] of Object.entries(variants)) assert.notEqual(text, after, name)
  for (const [name, text] of Object.entries(variants)) {
    const verdict = judgeOutputPane({ before, after: text, label: 'A', stableCount: 60 })
    assert.equal(verdict.pass, false, name)
    assert.ok(verdict.problems.some((problem) => problem.startsWith('전 텍스트가 그대로가 아니다')), `${name}: ${verdict.problems}`)
  }
})

test('R056 자기점검 쌍 — 무주입 구간은 통과, z 주입 구간은 꼬리의 다른 줄로 실패', () => {
  assert.equal(judgeOutputPane({ before: readR056('read-self-control-A.txt'), after: readR056('read-self-before-A.txt'), label: 'A', stableCount: 60 }).pass, true)
  const injected = judgeOutputPane({ before: readR056('read-self-before-A.txt'), after: readR056('read-self-after-A.txt'), label: 'A', stableCount: 60 })
  assert.ok(injected.problems.some((problem) => problem.startsWith('출력 대역에 다른 줄')), String(injected.problems))
})
