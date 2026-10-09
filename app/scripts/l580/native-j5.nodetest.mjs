// native-j5 계산기 시험 (LIFE-580 R2-A4 · R3-A2) — 원인 시각 기준 ⓑ · 원인 없는 전이 보류(5회에서 제외) · 보정 없음 보류 · 초과 미달 ·
// 다음 원인 전 목록만 짝 · **대상 채널이 기대 상태로 바뀐 첫 목록만 짝**(다른 채널 먼저 · 대상 누락 · 같은 상태 반복 · 대상만).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeNativeJ5 } from './native-j5.mjs'
import { foldTargetDots, matchTransition } from './transition-match.mjs'

const OFFSET = 400 // 서버(맥) − 폰
const TARGET = 'w1:p9'
const OTHER = 'w1:p5'

/** 목록들(서버가 만든 순서) → 폰 `list_recv` 줄. `dots` = 그 목록의 채널 점 전체. `changes` 는 폰 `dotChanges` 와 같은 규칙(직전 대비, 첫 목록은 전부). */
function phoneLog(lists) {
  let before = new Map()
  return lists
    .map(({ seq, changedAt, builtAt = changedAt + 5, delay, offsetMs = OFFSET, dots, noChanges = false }) => {
      const recvAt = builtAt - OFFSET + delay // 폰 시계
      const after = new Map(Object.entries(dots))
      const changes = []
      for (const [id, dot] of after) if (before.get(id) !== dot) changes.push(`${id}=${dot}`)
      for (const id of before.keys()) if (!after.has(id)) changes.push(`${id}=-`)
      before = after
      const line = { at: new Date(recvAt).toISOString(), event: 'list_recv', seq, serverAt: builtAt, changedAt, recvAt, offsetMs, rttMs: 40 }
      return JSON.stringify(noChanges ? line : { ...line, changes: changes.join(',') })
    })
    .join('\n')
}
const causeLine = ({ i, causeAt, expect, exit = 0, target = TARGET }) => JSON.stringify({ i, state: expect, target, expect, pane: target, causeAt, doneAt: causeAt + 20, exit })
const STATES = ['working', 'idle', 'blocked', 'working', 'idle']

describe('native-j5 계산 (R2-A4)', () => {
  it('ⓑ 는 원인 시각(보고 직전)부터 — main 적용 시각이 아니다 · 적용 시각은 참고값으로만', () => {
    // 원인 → main 적용 2500 ms, 적용 → 폰 200 ms. 적용 기준이면 0.2초지만 원인 기준 ⓑ 는 2.7초+.
    const phone = phoneLog([
      { seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'idle' } },
      { seq: 2, changedAt: 12_500, builtAt: 12_500, delay: 200, dots: { [TARGET]: 'working' } },
    ])
    const cause = causeLine({ i: 0, causeAt: 10_000, expect: 'working' })
    const main = JSON.stringify({ at: 12_490, tag: 'agent.push.applied', changed: true })
    const result = computeNativeJ5({ phoneText: phone, causeText: cause, mainText: main, min: 1 })
    assert.equal(result.rows[0].aMs, 200)
    assert.equal(result.rows[0].bMs, 2_700)
    assert.equal(result.rows[0].causeToAppliedMs, 2_490)
    assert.equal(result.verdict, '통과')
    // 원인 → 적용이 4초면 적용 뒤 0.2초여도 미달(리뷰어 예).
    const slow = computeNativeJ5({
      phoneText: phoneLog([
        { seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'idle' } },
        { seq: 2, changedAt: 14_000, builtAt: 14_000, delay: 200, dots: { [TARGET]: 'working' } },
      ]),
      causeText: cause,
      min: 1,
    })
    assert.equal(slow.rows[0].bMs, 4_200)
    assert.equal(slow.verdict, '미달')
  })

  /** 대상만 바뀌는 5전이 — 원인마다 300 ms 뒤 목록, 150 ms 뒤 수신. */
  const fiveTargetOnly = (failAt = -1) => {
    const lists = [{ seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'blocked', [OTHER]: 'idle' } }]
    const causes = []
    STATES.forEach((expect, i) => {
      const causeAt = 10_000 + i * 8_000
      causes.push(causeLine({ i, causeAt, expect, exit: i === failAt ? 1 : 0 }))
      lists.push({ seq: i + 2, changedAt: causeAt + 300, delay: 150, dots: { [TARGET]: expect, [OTHER]: 'idle' } })
    })
    return { phoneText: phoneLog(lists), causeText: causes.join('\n') }
  }

  it('원인 시각 없는 전이(보고 실패)는 보류 · 5회에 세지 않는다 → 4회뿐이면 미달', () => {
    const result = computeNativeJ5(fiveTargetOnly(2))
    assert.equal(result.held, 1)
    assert.equal(result.counted, 4)
    assert.equal(result.verdict, '미달')
    // 양성 대조 — 다 성공한 5회.
    const ok = computeNativeJ5(fiveTargetOnly())
    assert.equal(ok.counted, 5)
    assert.equal(ok.verdict, '통과')
  })

  it('보정값 없는 수신은 보류 · 다음 원인 뒤에 만든 목록은 앞 전이의 짝이 아니다(미수신)', () => {
    const causes = [causeLine({ i: 0, causeAt: 10_000, expect: 'working' }), causeLine({ i: 1, causeAt: 18_000, expect: 'idle' })].join('\n')
    const phone = phoneLog([
      { seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'idle' } },
      { seq: 2, changedAt: 10_300, delay: 100, offsetMs: null, dots: { [TARGET]: 'working' } },
      { seq: 3, changedAt: 18_200, delay: 100, dots: { [TARGET]: 'idle' } },
    ])
    const result = computeNativeJ5({ phoneText: phone, causeText: causes, min: 1 })
    assert.equal(result.rows[0].status, '보류')
    assert.equal(result.rows[1].status, '통과')
    // 대상의 working 목록이 다음 원인 뒤에야 왔다 → 첫 전이는 미수신(세는 회차).
    const late = phoneLog([
      { seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'idle' } },
      { seq: 2, changedAt: 18_200, delay: 100, dots: { [TARGET]: 'working' } },
    ])
    const none = computeNativeJ5({ phoneText: late, causeText: causes, min: 1 })
    assert.equal(none.rows[0].status, '미수신')
    assert.equal(none.verdict, '미달')
  })
})

describe('R3-A2 전이 식별 — 대상 채널이 기대 상태로 바뀐 첫 목록만 짝', () => {
  /** 리뷰어 재현 모양: 대상 상태는 원인 +4000 ms 에 적용, 그 사이 다른 채널만 +100 ms 에 바뀐다. */
  const slowTargetWithOtherFirst = ({ dropTarget = false } = {}) => {
    const lists = [{ seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'blocked', [OTHER]: 'idle' } }]
    const causes = []
    let seq = 2
    let other = 'idle'
    let target = 'blocked'
    STATES.forEach((expect, i) => {
      const causeAt = 10_000 + i * 8_000
      causes.push(causeLine({ i, causeAt, expect }))
      other = other === 'idle' ? 'working' : 'idle'
      lists.push({ seq: seq++, changedAt: causeAt + 100, delay: 100, dots: { [TARGET]: target, [OTHER]: other } })
      if (!dropTarget) {
        target = expect
        lists.push({ seq: seq++, changedAt: causeAt + 4_000, delay: 100, dots: { [TARGET]: target, [OTHER]: other } })
      }
    })
    return { phoneText: phoneLog(lists), causeText: causes.join('\n') }
  }

  it('다른 채널이 먼저 바뀐다 — 다른 채널 목록(0.2초)이 아니라 대상 목록(4.1초+)을 골라 미달', () => {
    const result = computeNativeJ5(slowTargetWithOtherFirst())
    assert.equal(result.counted, 5)
    for (const row of result.rows) {
      assert.equal(row.status, '초과')
      assert.equal(row.dot, row.expect)
      assert.equal(row.bMs, 4_105)
    }
    assert.equal(result.verdict, '미달')
  })

  it('대상 상태 목록을 빼면 — 다른 채널 목록을 짝으로 삼지 않고 미수신 → 미달', () => {
    const result = computeNativeJ5(slowTargetWithOtherFirst({ dropTarget: true }))
    assert.equal(result.rows.filter((row) => row.status === '미수신').length, 4)
    assert.equal(result.verdict, '미달')
    assert.ok(result.rows.every((row) => row.status !== '통과'))
  })

  it('대상 누락 — 대상 채널이 어느 목록에도 없으면 보류(5회에서 제외) → 미달', () => {
    const lists = [{ seq: 1, changedAt: 9_000, delay: 50, dots: { [OTHER]: 'idle' } }]
    const causes = STATES.map((expect, i) => {
      lists.push({ seq: i + 2, changedAt: 10_000 + i * 8_000 + 100, delay: 100, dots: { [OTHER]: i % 2 === 0 ? 'working' : 'idle' } })
      return causeLine({ i, causeAt: 10_000 + i * 8_000, expect })
    })
    const result = computeNativeJ5({ phoneText: phoneLog(lists), causeText: causes.join('\n') })
    assert.equal(result.counted, 0)
    assert.equal(result.held, 5)
    assert.match(result.rows[0].why, /대상 확인 불가/)
    assert.equal(result.verdict, '미달')
    // 원인 줄에 대상·기대 상태가 없어도 보류.
    const bare = computeNativeJ5({ phoneText: fiveLike(), causeText: JSON.stringify({ i: 0, state: 'working', pane: TARGET, causeAt: 10_000, exit: 0 }), min: 1 })
    assert.equal(bare.rows[0].status, '보류')
    assert.match(bare.rows[0].why, /대상 채널·기대 상태 없음/)
  })

  it('같은 상태 반복 — 원인 직전에 이미 기대 상태면 전이가 아니라 보류(같은 점 목록을 짝으로 삼지 않는다)', () => {
    const phone = phoneLog([
      { seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'working', [OTHER]: 'idle' } },
      { seq: 2, changedAt: 10_100, delay: 100, dots: { [TARGET]: 'working', [OTHER]: 'working' } },
    ])
    const result = computeNativeJ5({ phoneText: phone, causeText: causeLine({ i: 0, causeAt: 10_000, expect: 'working' }), min: 1 })
    assert.equal(result.rows[0].status, '보류')
    assert.match(result.rows[0].why, /같은 상태 반복/)
    assert.equal(result.verdict, '미달')
  })

  it('대상만 바뀐다(양성) — 5전이 모두 그 목록 seq 로 통과', () => {
    const lists = [{ seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'blocked' } }]
    const causes = STATES.map((expect, i) => {
      lists.push({ seq: i + 2, changedAt: 10_000 + i * 8_000 + 300, delay: 150, dots: { [TARGET]: expect } })
      return causeLine({ i, causeAt: 10_000 + i * 8_000, expect })
    })
    const result = computeNativeJ5({ phoneText: phoneLog(lists), causeText: causes.join('\n') })
    assert.deepEqual(result.rows.map((row) => row.seq), [2, 3, 4, 5, 6])
    assert.equal(result.counted, 5)
    assert.equal(result.maxBMs, 455)
    assert.equal(result.verdict, '통과')
  })

  it('`changes` 없는 옛 기록 — 대상 점을 모르면 보류(짐작하지 않는다)', () => {
    const phone = phoneLog([
      { seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'idle' }, noChanges: true },
      { seq: 2, changedAt: 10_300, delay: 100, dots: { [TARGET]: 'working' }, noChanges: true },
    ])
    const result = computeNativeJ5({ phoneText: phone, causeText: causeLine({ i: 0, causeAt: 10_000, expect: 'working' }), min: 1 })
    assert.equal(result.rows[0].status, '보류')
  })

  it('matchTransition — 원인 전에 만든 목록은 기대 점이어도 짝이 아니다 · idle 은 done 점도 받는다', () => {
    const lists = foldTargetDots({ target: TARGET, recv: [
      { builtAt: 9_000, changes: `${TARGET}=working` },
      { builtAt: 9_900, changes: `${TARGET}=done` },
      { builtAt: 10_050, changes: `${OTHER}=idle` },
    ] })
    // 원인 직전에 이미 done(=idle 의 점) — 반복
    assert.equal(matchTransition({ lists, expect: 'idle', causeAt: 9_950 }).kind, 'held')
    // working → idle(done) 전이: 9_900 목록이 원인 뒤라 짝
    assert.equal(matchTransition({ lists, expect: 'idle', causeAt: 9_500 }).list.builtAt, 9_900)
    // 대상이 보이는데 기대 상태가 안 옴 → 미수신
    assert.equal(matchTransition({ lists, expect: 'blocked', causeAt: 9_950 }).kind, 'miss')
  })
})

function fiveLike() {
  return phoneLog([
    { seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'idle' } },
    { seq: 2, changedAt: 10_300, delay: 100, dots: { [TARGET]: 'working' } },
  ])
}

describe('R3-A4 원인 기록의 중단·정리 줄', () => {
  it('중단 줄이 있으면 미달 · release 줄은 전이로 세지 않고 정리 결과로만 낸다', () => {
    const lists = [{ seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'blocked' } }]
    const causes = STATES.map((expect, i) => {
      lists.push({ seq: i + 2, changedAt: 10_000 + i * 8_000 + 300, delay: 150, dots: { [TARGET]: expect } })
      return causeLine({ i, causeAt: 10_000 + i * 8_000, expect })
    })
    const release = JSON.stringify({ kind: 'release', reason: 'end', pane: TARGET, exit: 0 })
    const ok = computeNativeJ5({ phoneText: phoneLog(lists), causeText: [...causes, release].join('\n') })
    assert.equal(ok.rows.length, 5)
    assert.deepEqual(ok.cleanup, [{ reason: 'end', exit: 0 }])
    assert.equal(ok.verdict, '통과')
    const interrupted = JSON.stringify({ kind: 'interrupted', signal: 'SIGINT', pane: TARGET, at: 60_000 })
    const cut = computeNativeJ5({ phoneText: phoneLog(lists), causeText: [...causes, interrupted, JSON.stringify({ kind: 'release', reason: 'SIGINT', exit: 1 })].join('\n') })
    assert.equal(cut.counted, 5)
    assert.deepEqual(cut.aborted, [{ kind: 'interrupted', signal: 'SIGINT' }])
    assert.deepEqual(cut.cleanup, [{ reason: 'SIGINT', exit: 1 }])
    assert.equal(cut.verdict, '미달')
  })
})

describe('R4-A2 옛·새 기록 섞임 — 대상을 다시 명시하면 그때부터 안다', () => {
  const OLD = (seq, at) => JSON.stringify({ at: new Date(at).toISOString(), event: 'list_recv', seq, serverAt: at, changedAt: at, recvAt: at, offsetMs: 0, rttMs: 10 })
  const fiveAfter = (head) => {
    const lists = [{ seq: 1, changedAt: 9_000, delay: 50, dots: { [TARGET]: 'blocked', [OTHER]: 'idle' } }]
    const causes = STATES.map((expect, i) => {
      lists.push({ seq: i + 2, changedAt: 10_000 + i * 8_000 + 300, delay: 150, dots: { [TARGET]: expect, [OTHER]: 'idle' } })
      return causeLine({ i, causeAt: 10_000 + i * 8_000, expect })
    })
    return { phoneText: `${head}\n${phoneLog(lists)}`, causeText: causes.join('\n') }
  }

  it('옛 줄 하나 뒤 새 앱의 첫 목록(대상 명시)부터 — 5전이 모두 계산 · 통과(옛 줄 뺀 것과 같다)', () => {
    const mixed = computeNativeJ5(fiveAfter(OLD(90, 5_000)))
    const fresh = computeNativeJ5(fiveAfter(''))
    assert.equal(mixed.counted, 5)
    assert.equal(mixed.verdict, '통과')
    assert.deepEqual(mixed.rows.map((row) => row.bMs), fresh.rows.map((row) => row.bMs))
  })

  it('옛 줄 뒤 대상을 언급하지 않은 delta 만 있으면 짐작하지 않는다 — 대상 명시 전까지 보류', () => {
    const lists = foldTargetDots({ target: TARGET, recv: [
      { builtAt: 1, changes: `${TARGET}=idle` },
      { builtAt: 2 },
      { builtAt: 3, changes: `${OTHER}=working` },
      { builtAt: 4, changes: `${TARGET}=-` },
      { builtAt: 5, changes: `${OTHER}=idle` },
      { builtAt: 6, changes: `${TARGET}=working` },
    ] })
    assert.deepEqual(lists.map((list) => list.dot), ['idle', undefined, undefined, null, null, 'working'])
    // 원인이 대상 미확인 구간이면 보류, 명시(사라짐) 뒤면 판정
    assert.equal(matchTransition({ lists, expect: 'working', causeAt: 3.5 }).kind, 'held')
    assert.equal(matchTransition({ lists, expect: 'working', causeAt: 4.5 }).list.builtAt, 6)
  })
})
