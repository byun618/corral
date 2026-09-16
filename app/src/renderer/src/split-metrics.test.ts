// 영역 경계 셀 스냅(F1-2)과 좁은 헤더 탭 접기(F1-7)의 **산술**만 여기서 잰다.
// 화면에 그 폭으로 서는지는 하네스가 본다.

import { describe, expect, it } from 'vitest'
import { snapSplitRatio } from './term-metrics.js'
import { shouldCompactTabs } from './components/MainTabBar.js'

const clamp = { min: 0.15, max: 0.85 }

describe('경계 셀 스냅 (F1-2)', () => {
  it('첫 쪽 폭이 셀의 정수배가 되도록 붙는다', () => {
    const snapped = snapSplitRatio({
      total: 1000,
      wanted: 503,
      overhead: { first: 0, second: 0 },
      unit: 7,
      minCells: 2,
      clamp,
    })
    expect(snapped.first).toBe(71) // floor(503 / 7)
    expect(snapped.ratio * 1000).toBeCloseTo(500.5, 6) // 71 × 7 + 반 칸 3.5
    expect(snapped.second).toBe(71) // floor(499 / 7)
  })

  it('터미널이 아닌 부분(헤더)을 빼고 센다', () => {
    const snapped = snapSplitRatio({
      total: 1000,
      wanted: 530,
      overhead: { first: 30, second: 30 },
      unit: 20,
      minCells: 1,
      clamp,
    })
    expect(snapped.first).toBe(25) // floor((530 − 30) / 20)
    expect(snapped.ratio * 1000).toBeCloseTo(540, 6) // 30 + 25 × 20 + 반 칸 10
    expect(snapped.second).toBe(21) // floor((1000 − 540 − 30) / 20)
  })

  it('비율 클램프 .15~.85 밖으로는 안 나간다 — 반 칸 비켜선 자리도 그 안이다', () => {
    const low = snapSplitRatio({ total: 1000, wanted: 5, overhead: { first: 0, second: 0 }, unit: 10, minCells: 2, clamp })
    expect(low.first).toBe(15)
    expect(low.ratio).toBeGreaterThanOrEqual(0.15)
    expect(low.ratio).toBeLessThanOrEqual(0.85)
    const high = snapSplitRatio({ total: 1000, wanted: 995, overhead: { first: 0, second: 0 }, unit: 10, minCells: 2, clamp })
    expect(high.first).toBe(84) // 85 칸이면 855px 로 .85 를 넘어 한 칸 물린다
    expect(high.ratio).toBeLessThanOrEqual(0.85)
  })

  it('셀 최소치가 비율 클램프보다 우선이다 — 상자가 좁으면 클램프 안이어도 물린다', () => {
    // 총 40px · 셀 10px · 최소 2칸 → 둘째 쪽 2칸(20px)을 남기면 첫 쪽은 최대 2칸이다.
    // .85 클램프만 보면 34px(3칸)까지 가지만 그러면 둘째가 1칸이 된다.
    const snapped = snapSplitRatio({ total: 40, wanted: 39, overhead: { first: 0, second: 0 }, unit: 10, minCells: 2, clamp })
    expect(snapped.first).toBe(2)
  })

  it('상자 폭이 0 이면 최소 비율로 떨어진다 (측정 전 프레임)', () => {
    const snapped = snapSplitRatio({ total: 0, wanted: 0, overhead: { first: 0, second: 0 }, unit: 7, minCells: 2, clamp })
    expect(snapped.ratio).toBe(0.15)
  })
})

describe('좁은 영역 탭 접기 (F1-7)', () => {
  // 쓸 수 있는 폭 = 영역폭 − 12(패딩) − 32(+) − 94(액션), 탭 하나 124.
  it('넓으면 안 접는다', () => {
    expect(shouldCompactTabs({ tabCount: 3, headerWidth: 900 })).toBe(false)
  })

  it('탭 폭 합이 남는 폭을 넘으면 접는다', () => {
    // 3 × 124 = 372 > 500 − 138 = 362
    expect(shouldCompactTabs({ tabCount: 3, headerWidth: 500 })).toBe(true)
    // 2 × 124 = 248 < 362
    expect(shouldCompactTabs({ tabCount: 2, headerWidth: 500 })).toBe(false)
  })

  it('폭을 아직 못 쟀으면 접지 않는다 (첫 프레임)', () => {
    expect(shouldCompactTabs({ tabCount: 9, headerWidth: 0 })).toBe(false)
  })
})
