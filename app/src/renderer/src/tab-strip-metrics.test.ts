// LIFE-494 K1 — 탭 스트립 넘침의 순수 계산. 기대값은 Orca `tab-strip-scroll-metrics.test.ts`(v1.4.219) 와 같은 상황에서 같은 값.
import { describe, expect, it } from 'vitest'
import {
  TAB_STRIP_THUMB_MIN_WIDTH_PX,
  computeTabStripScrollMetrics,
  computeTabStripThumbLayout,
  isTabStripAtEnd,
  sameTabStripScrollMetrics,
  tabStripMaskClassName,
  tabStripScrollStep,
  thumbDragScrollLeft,
  trackClickScrollLeft,
  wheelToHorizontal,
} from './tab-strip-metrics.js'

describe('computeTabStripScrollMetrics', () => {
  it('넘치지 않으면 양쪽 다 못 가고 썸은 전체', () => {
    expect(computeTabStripScrollMetrics({ scrollWidth: 400, clientWidth: 400, scrollLeft: 0 })).toEqual({
      hasOverflow: false, canScrollStart: false, canScrollEnd: false, thumbSizeFraction: 1, thumbOffsetFraction: 0,
    })
  })

  it('1px 넘침은 넘침이 아니다(오차)', () => {
    expect(computeTabStripScrollMetrics({ scrollWidth: 401, clientWidth: 400, scrollLeft: 0 }).hasOverflow).toBe(false)
  })

  it('맨 앞: 뒤로만 갈 수 있다', () => {
    const metrics = computeTabStripScrollMetrics({ scrollWidth: 1000, clientWidth: 400, scrollLeft: 0 })
    expect(metrics).toMatchObject({ hasOverflow: true, canScrollStart: false, canScrollEnd: true, thumbOffsetFraction: 0 })
    expect(metrics.thumbSizeFraction).toBeCloseTo(0.4)
  })

  it('가운데: 양쪽 다, 썸 위치는 비율', () => {
    expect(computeTabStripScrollMetrics({ scrollWidth: 1000, clientWidth: 400, scrollLeft: 300 })).toMatchObject({
      canScrollStart: true, canScrollEnd: true, thumbOffsetFraction: 0.5,
    })
  })

  it('맨 끝(1px 안쪽 포함): 앞으로만', () => {
    expect(computeTabStripScrollMetrics({ scrollWidth: 1000, clientWidth: 400, scrollLeft: 599.5 })).toMatchObject({
      canScrollStart: true, canScrollEnd: false,
    })
  })

  it('같은 값 판정은 0.002 미만 흔들림을 무시한다', () => {
    const a = computeTabStripScrollMetrics({ scrollWidth: 1000, clientWidth: 400, scrollLeft: 300 })
    const b = computeTabStripScrollMetrics({ scrollWidth: 1000, clientWidth: 400, scrollLeft: 300.5 })
    const c = computeTabStripScrollMetrics({ scrollWidth: 1000, clientWidth: 400, scrollLeft: 310 })
    expect(sameTabStripScrollMetrics(a, b)).toBe(true)
    expect(sameTabStripScrollMetrics(a, c)).toBe(false)
  })
})

describe('썸 배치', () => {
  it('폭 = 비율 × 트랙, 위치 = 오프셋 × 남는 폭', () => {
    expect(computeTabStripThumbLayout({ trackWidthPx: 400, metrics: { thumbSizeFraction: 0.4, thumbOffsetFraction: 0.5 } })).toEqual({ widthPx: 160, leftPx: 120 })
  })

  it('최소 18px, 트랙보다 넓지 않다, 트랙 0 이면 0', () => {
    expect(computeTabStripThumbLayout({ trackWidthPx: 400, metrics: { thumbSizeFraction: 0.01, thumbOffsetFraction: 1 } })).toEqual({
      widthPx: TAB_STRIP_THUMB_MIN_WIDTH_PX, leftPx: 400 - TAB_STRIP_THUMB_MIN_WIDTH_PX,
    })
    expect(computeTabStripThumbLayout({ trackWidthPx: 10, metrics: { thumbSizeFraction: 0.01, thumbOffsetFraction: 0 } }).widthPx).toBe(10)
    expect(computeTabStripThumbLayout({ trackWidthPx: 0, metrics: { thumbSizeFraction: 0.5, thumbOffsetFraction: 0.5 } })).toEqual({ widthPx: 0, leftPx: 0 })
  })

  it('썸 드래그: 트랙 남는 폭만큼 끌면 스크롤 끝까지, 범위 밖은 자른다', () => {
    const base = { trackWidthPx: 400, thumbWidthPx: 160, maxScrollLeft: 600 }
    expect(thumbDragScrollLeft({ ...base, startScrollLeft: 0, deltaX: 240 })).toBe(600)
    expect(thumbDragScrollLeft({ ...base, startScrollLeft: 0, deltaX: 120 })).toBe(300)
    expect(thumbDragScrollLeft({ ...base, startScrollLeft: 300, deltaX: -999 })).toBe(0)
    expect(thumbDragScrollLeft({ ...base, startScrollLeft: 300, deltaX: 999 })).toBe(600)
  })

  it('트랙 클릭: 썸 가운데가 클릭 자리로 (양끝은 자른다)', () => {
    const base = { trackWidthPx: 400, thumbWidthPx: 160, maxScrollLeft: 600 }
    expect(trackClickScrollLeft({ ...base, clickX: 200 })).toBe(300)
    expect(trackClickScrollLeft({ ...base, clickX: 10 })).toBe(0)
    expect(trackClickScrollLeft({ ...base, clickX: 395 })).toBe(600)
  })
})

describe('페이드 마스크 클래스', () => {
  const metrics = (canScrollStart: boolean, canScrollEnd: boolean) => ({ hasOverflow: canScrollStart || canScrollEnd, canScrollStart, canScrollEnd })

  it('넘치지 않으면 없음', () => {
    expect(tabStripMaskClassName({ metrics: { hasOverflow: false, canScrollStart: false, canScrollEnd: false }, dockedSide: null })).toBe('')
  })

  it('앞·뒤·양쪽', () => {
    expect(tabStripMaskClassName({ metrics: metrics(false, true), dockedSide: null })).toBe('is-fade-end')
    expect(tabStripMaskClassName({ metrics: metrics(true, false), dockedSide: null })).toBe('is-fade-start')
    expect(tabStripMaskClassName({ metrics: metrics(true, true), dockedSide: null })).toBe('is-fade-start is-fade-end')
  })

  it('활성 탭이 붙은 쪽은 끈다', () => {
    expect(tabStripMaskClassName({ metrics: metrics(true, true), dockedSide: 'start' })).toBe('is-fade-end')
    expect(tabStripMaskClassName({ metrics: metrics(true, true), dockedSide: 'end' })).toBe('is-fade-start')
    expect(tabStripMaskClassName({ metrics: metrics(false, true), dockedSide: 'end' })).toBe('')
  })
})

describe('스텝·끝 판정·휠', () => {
  it('스텝 = 폭의 75%, 최소 120', () => {
    expect(tabStripScrollStep(800)).toBe(600)
    expect(tabStripScrollStep(100)).toBe(120)
  })

  it('끝 판정은 2px 여유', () => {
    expect(isTabStripAtEnd({ scrollWidth: 1000, clientWidth: 400, scrollLeft: 598 })).toBe(true)
    expect(isTabStripAtEnd({ scrollWidth: 1000, clientWidth: 400, scrollLeft: 597 })).toBe(false)
    expect(isTabStripAtEnd({ scrollWidth: 400, clientWidth: 400, scrollLeft: 0 })).toBe(true)
  })

  it('휠: 넘칠 때 세로가 크면 가로로 바꾼다, 아니면 손대지 않는다', () => {
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 40, overflows: true })).toBe(40)
    expect(wheelToHorizontal({ deltaX: 0, deltaY: -40, overflows: true })).toBe(-40)
    expect(wheelToHorizontal({ deltaX: 30, deltaY: 10, overflows: true })).toBeNull()
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 40, overflows: false })).toBeNull()
  })
})
