// 탭 스트립 넘침의 순수 계산 (LIFE-494 T2) — Orca v1.4.219 `tab-strip-scroll-metrics.ts`·`tab-strip-overflow-navigation.ts`
// 의 계산 조각을 그대로 옮긴다. DOM 을 읽는 쪽은 `tab-strip-geometry.ts`, 훅은 `hooks/useTabStripOverflow.ts`.

export type TabStripScrollMetrics = {
  hasOverflow: boolean
  canScrollStart: boolean
  canScrollEnd: boolean
  /** 스트립 뷰포트가 보여 주는 몫(전체 탭 폭 대비). */
  thumbSizeFraction: number
  /** 0 = 맨 앞, 1 = 맨 끝. */
  thumbOffsetFraction: number
}

export type TabStripThumbLayout = { widthPx: number; leftPx: number }

/** 활성 탭이 붙은 가장자리 — Orca `ActiveTabDockSide`. */
export type TabStripDockSide = 'start' | 'end'

export const TAB_STRIP_THUMB_MIN_WIDTH_PX = 18
const OVERFLOW_EPSILON_PX = 1
const SCROLL_FRACTION = 0.75
const MIN_SCROLL_STEP_PX = 120

export const EMPTY_TAB_STRIP_METRICS: TabStripScrollMetrics = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false,
  thumbSizeFraction: 1,
  thumbOffsetFraction: 0,
}

type ScrollBox = { scrollWidth: number; clientWidth: number; scrollLeft: number }

export function computeTabStripScrollMetrics(box: ScrollBox): TabStripScrollMetrics {
  const maxScrollLeft = Math.max(0, box.scrollWidth - box.clientWidth)
  const hasOverflow = maxScrollLeft > OVERFLOW_EPSILON_PX
  return {
    hasOverflow,
    canScrollStart: hasOverflow && box.scrollLeft > OVERFLOW_EPSILON_PX,
    canScrollEnd: hasOverflow && box.scrollLeft < maxScrollLeft - OVERFLOW_EPSILON_PX,
    thumbSizeFraction: box.scrollWidth > 0 ? Math.min(1, box.clientWidth / box.scrollWidth) : 1,
    thumbOffsetFraction: hasOverflow ? box.scrollLeft / maxScrollLeft : 0,
  }
}

export function sameTabStripScrollMetrics(left: TabStripScrollMetrics, right: TabStripScrollMetrics): boolean {
  return (
    left.hasOverflow === right.hasOverflow &&
    left.canScrollStart === right.canScrollStart &&
    left.canScrollEnd === right.canScrollEnd &&
    Math.abs(left.thumbSizeFraction - right.thumbSizeFraction) < 0.002 &&
    Math.abs(left.thumbOffsetFraction - right.thumbOffsetFraction) < 0.002
  )
}

/** 썸 폭·위치 — 최소 18px, 트랙 안에서 스크롤 비율만큼. */
export function computeTabStripThumbLayout(input: {
  trackWidthPx: number
  metrics: Pick<TabStripScrollMetrics, 'thumbSizeFraction' | 'thumbOffsetFraction'>
}): TabStripThumbLayout {
  if (input.trackWidthPx <= 0) return { widthPx: 0, leftPx: 0 }
  const widthPx = Math.min(input.trackWidthPx, Math.max(TAB_STRIP_THUMB_MIN_WIDTH_PX, input.metrics.thumbSizeFraction * input.trackWidthPx))
  return { widthPx, leftPx: input.metrics.thumbOffsetFraction * Math.max(0, input.trackWidthPx - widthPx) }
}

/** 썸을 끈 거리 → 스트립 scrollLeft (0..최대로 자른다). */
export function thumbDragScrollLeft(input: { startScrollLeft: number; deltaX: number; trackWidthPx: number; thumbWidthPx: number; maxScrollLeft: number }): number {
  const maxLeft = Math.max(1, input.trackWidthPx - input.thumbWidthPx)
  const next = input.startScrollLeft + (input.deltaX / maxLeft) * input.maxScrollLeft
  return Math.max(0, Math.min(input.maxScrollLeft, next))
}

/** 트랙 클릭 → 썸 가운데가 클릭 자리에 오게 하는 scrollLeft. */
export function trackClickScrollLeft(input: { clickX: number; trackWidthPx: number; thumbWidthPx: number; maxScrollLeft: number }): number {
  const maxLeft = Math.max(1, input.trackWidthPx - input.thumbWidthPx)
  const thumbLeft = Math.max(0, Math.min(maxLeft, input.clickX - input.thumbWidthPx / 2))
  return (thumbLeft / maxLeft) * input.maxScrollLeft
}

/**
 * 페이드 마스크 클래스 — 앞으로 갈 수 있으면 앞, 뒤로 갈 수 있으면 뒤. 활성 탭이 붙은 쪽은 끈다
 * (페이드가 거기 붙은 활성 탭을 흐리게 지운다, #24010).
 */
export function tabStripMaskClassName(input: {
  metrics: Pick<TabStripScrollMetrics, 'hasOverflow' | 'canScrollStart' | 'canScrollEnd'>
  dockedSide: TabStripDockSide | null
}): string {
  if (!input.metrics.hasOverflow) return ''
  const classes: string[] = []
  if (input.metrics.canScrollStart && input.dockedSide !== 'start') classes.push('is-fade-start')
  if (input.metrics.canScrollEnd && input.dockedSide !== 'end') classes.push('is-fade-end')
  return classes.join(' ')
}

/** chevron 한 번의 이동 — 스트립 폭의 75%, 최소 120px. */
export function tabStripScrollStep(clientWidth: number): number {
  return Math.max(MIN_SCROLL_STEP_PX, clientWidth * SCROLL_FRACTION)
}

/** 끝에 붙어 있나 — 2px 여유(Orca `isTabStripScrolledToEnd`). */
export function isTabStripAtEnd(box: ScrollBox): boolean {
  return box.scrollLeft >= Math.max(0, box.scrollWidth - box.clientWidth) - 2
}

/** 휠 한 번을 스트립 가로 이동으로 바꿀지 — 넘칠 때, 세로가 가로보다 클 때만(가로 휠·트랙패드 가로 밀기는 브라우저 기본 그대로). */
export function wheelToHorizontal(input: { deltaX: number; deltaY: number; overflows: boolean }): number | null {
  if (!input.overflows) return null
  if (Math.abs(input.deltaY) <= Math.abs(input.deltaX)) return null
  return input.deltaY
}
