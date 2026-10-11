// R2-A3 — 정상 페어링 뒤 뒤로 가기. 설치된 @react-navigation/routers 의 실제 StackRouter 에 화면 코드의 router 호출 순서를 준다
// (리뷰어 stack-probe.mjs 모양). expo-router 는 dismissAll → POP_TO_TOP, replace → REPLACE 로 보낸다(routing.js). 네이티브 제스처 실행은 아니다.
import { CommonActions, StackActions, StackRouter, type StackNavigationState } from '@react-navigation/routers'
import { describe, expect, it } from 'vitest'
import type { ConnState } from '../src/core/connection'
import { shouldGoHome, shouldGoToIntro } from '../src/core/route'

const T = 1_000_000
type Params = Record<string, object | undefined>
const router = StackRouter({ initialRouteName: 'pair/index' })
const config = { routeNames: ['pair/index', 'pair/scan', 'pair/progress', 'home', 'settings'], routeParamList: {}, routeGetIdList: {} }

type Action = Parameters<typeof router.getStateForAction>[1]

/** 처리 안 됨(null)은 null 로, 처리됐으면 완전한 스택 상태(stale: false)만 돌려준다. */
function apply(state: StackNavigationState<Params>, action: Action): StackNavigationState<Params> | null {
  const next = router.getStateForAction(state, action, config)
  if (next === null) return null
  if (next.stale !== false) throw new Error('부분 상태')
  return next
}

function names(state: StackNavigationState<Params>): string[] {
  return state.routes.map((route) => route.name)
}

/** 루트 레이아웃 가드 — 화면 이름을 segments 로 바꿔 `shouldGoToIntro`·`shouldGoHome` 을 그대로 쓴다. */
function guard(conn: ConnState, state: StackNavigationState<Params>): StackNavigationState<Params> {
  let current = state
  for (let i = 0; i < 5; i += 1) {
    const top = current.routes[current.index]?.name ?? ''
    const segments = top === 'pair/index' ? ['pair'] : top.split('/')
    const target = shouldGoToIntro(conn, segments) ? 'pair/index' : shouldGoHome(conn, segments) ? 'home' : null
    if (target === null) return current
    const next = apply(current, StackActions.replace(target))
    if (next === null) throw new Error('replace 미처리')
    current = next
  }
  throw new Error('가드 루프')
}

const connected: ConnState = { kind: 'connected', since: T, lastAliveAt: T }
const pairing: ConnState = { kind: 'unpaired', reason: null }

describe('R2-A3 — 실제 StackRouter', () => {
  it('성공 경로: A1 → 스캔 → A3/A4 → 「대화방 보기」(dismissAll + replace home) → 스택 [home], 뒤로는 앱 밖(처리 안 됨)', () => {
    let state: StackNavigationState<Params> | null = router.getInitialState(config)
    const steps: [string, Action][] = [
      ['QR 버튼', StackActions.push('pair/scan')],
      ['스캔 수락', StackActions.replace('pair/progress')],
      ['대화방 보기 — dismissAll', StackActions.popToTop()],
      ['대화방 보기 — replace', StackActions.replace('home')],
    ]
    for (const [, action] of steps) {
      if (state === null) throw new Error('상태 없음')
      state = apply(state, action)
    }
    if (state === null) throw new Error('상태 없음')
    expect(names(state)).toEqual(['home'])
    expect(apply(state, CommonActions.goBack())).toBeNull()
  })

  it('양성 대조 — 고치기 전 순서(replace home 만)는 뒤로 가면 A1 에 떨어진다 → 가드가 홈으로 되돌린다', () => {
    let state: StackNavigationState<Params> | null = router.getInitialState(config)
    const actions: Action[] = [StackActions.push('pair/scan'), StackActions.replace('pair/progress'), StackActions.replace('home'), CommonActions.goBack()]
    for (const action of actions) {
      if (state === null) throw new Error('상태 없음')
      state = apply(state, action)
    }
    if (state === null) throw new Error('상태 없음')
    expect(names(state)).toEqual(['pair/index'])
    expect(names(guard(connected, state))).toEqual(['home'])
  })

  it('해지 뒤 A1 · 첫 페어링 A3 — 가드 루프·충돌 없음', () => {
    const home = guard(connected, router.getInitialState(config))
    expect(names(home)).toEqual(['home'])
    const revoked = guard({ kind: 'unpaired', reason: 'revoked' }, home)
    expect(names(revoked)).toEqual(['pair/index'])
    let state: StackNavigationState<Params> | null = apply(revoked, StackActions.push('pair/scan'))
    if (state === null) throw new Error('상태 없음')
    expect(names(guard(pairing, state))).toEqual(['pair/index', 'pair/scan'])
    state = apply(state, StackActions.replace('pair/progress'))
    if (state === null) throw new Error('상태 없음')
    expect(names(guard(pairing, state))).toEqual(['pair/index', 'pair/progress'])
    // A4 성공 화면은 연결됨이어도 그대로
    expect(names(guard(connected, state))).toEqual(['pair/index', 'pair/progress'])
  })
})

describe('shouldGoHome', () => {
  const cases: [string, ConnState, string[], boolean][] = [
    ['연결됨 A1', connected, ['pair'], true],
    ['연결됨 A1(index)', connected, ['pair', 'index'], true],
    ['재연결 중 스캔', { kind: 'reconnecting', since: T, lastConnectedAt: null, attempt: 0, reason: 'closed', offline: false }, ['pair', 'scan'], true],
    ['확인 중 A1', { kind: 'checking', since: T, lastConnectedAt: T }, ['pair'], true],
    ['불일치 A1', { kind: 'mismatch', at: T, supported: [2] }, ['pair'], true],
    ['연결됨 A4', connected, ['pair', 'progress'], false],
    ['연결됨 홈', connected, ['home'], false],
    ['첫 실행 A1', pairing, ['pair'], false],
    ['해제 중 A1', { kind: 'unpairing', reason: 'user' }, ['pair'], false],
    ['로딩', { kind: 'loading' }, ['pair'], false],
  ]
  it.each(cases)('%s', (_name, conn, segments, expected) => {
    expect(shouldGoHome(conn, segments)).toBe(expected)
  })

  it('A1 행과 홈 행은 겹치지 않는다(모든 상태 × 화면)', () => {
    const conns: ConnState[] = [
      { kind: 'loading' },
      pairing,
      { kind: 'unpaired', reason: 'revoked' },
      connected,
      { kind: 'checking', since: T, lastConnectedAt: T },
      { kind: 'reconnecting', since: T, lastConnectedAt: null, attempt: 0, reason: 'closed', offline: true },
      { kind: 'mismatch', at: T, supported: [] },
      { kind: 'unpairing', reason: 'user' },
      { kind: 'unpair_failed', reason: 'user' },
    ]
    const screens = [['pair'], ['pair', 'index'], ['pair', 'scan'], ['pair', 'progress'], ['home'], ['settings'], ['log']]
    for (const conn of conns) for (const segments of screens) expect(shouldGoToIntro(conn, segments) && shouldGoHome(conn, segments)).toBe(false)
  })
})
