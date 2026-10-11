// A1 으로 보내는 판단 (R1-A5) — 해지·해제·삭제 중·삭제 실패는 페어링 화면(A3·A4)에서도 A1 로, 첫 실행·진행 중 페어링은 흐름 안에 둔다.
import { describe, expect, it } from 'vitest'
import type { ConnState } from '../src/core/connection'
import { isIntro, shouldGoToIntro } from '../src/core/route'

const T = 1_000_000

describe('shouldGoToIntro', () => {
  const cases: [string, ConnState, string[], boolean][] = [
    ['A4 에서 revoked', { kind: 'unpaired', reason: 'revoked' }, ['pair', 'progress'], true],
    ['QR 화면에서 unauthorized', { kind: 'unpaired', reason: 'unauthorized' }, ['pair', 'scan'], true],
    ['홈에서 해제 중', { kind: 'unpairing', reason: 'user' }, ['home'], true],
    ['설정에서 삭제 실패', { kind: 'unpair_failed', reason: 'user' }, ['settings'], true],
    ['A3 진행 중 페어링(이유 없음)', { kind: 'unpaired', reason: null }, ['pair', 'progress'], false],
    ['QR 화면 첫 실행', { kind: 'unpaired', reason: null }, ['pair', 'scan'], false],
    ['홈인데 토큰 없음', { kind: 'unpaired', reason: null }, ['home'], true],
    ['이미 A1', { kind: 'unpaired', reason: 'revoked' }, ['pair'], false],
    ['이미 A1(index)', { kind: 'unpair_failed', reason: 'revoked' }, ['pair', 'index'], false],
    ['연결됨', { kind: 'connected', since: T, lastAliveAt: T }, ['pair', 'progress'], false],
    ['라우터 준비 전', { kind: 'unpaired', reason: 'revoked' }, [], false],
  ]
  it.each(cases)('%s', (_name, conn, segments, expected) => {
    expect(shouldGoToIntro(conn, segments)).toBe(expected)
  })

  it('isIntro', () => {
    expect(isIntro(['pair'])).toBe(true)
    expect(isIntro(['pair', 'index'])).toBe(true)
    expect(isIntro(['pair', 'scan'])).toBe(false)
    expect(isIntro(['home'])).toBe(false)
  })
})
