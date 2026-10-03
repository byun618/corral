// 탭 스트립 스크롤 썸 (LIFE-494 T2 D26) — Orca `TabStripScrollIndicator.tsx` @ #24276(main e3cb32791e): idle 3px·펼침 4px,
// 트랙 `muted-foreground/15`, 썸 드래그 `foreground/70`·hover `muted-foreground/80`·idle `muted-foreground/60`. 값은 styles.css.
// 넘칠 때만 있고, 스트립 hover·썸 hover·썸 드래그·스크롤 중(800ms)일 때만 보인다. 탭 드래그 중엔 완전히 비킨다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  computeTabStripThumbLayout,
  thumbDragScrollLeft,
  trackClickScrollLeft,
  type TabStripScrollMetrics,
  type TabStripThumbLayout,
} from '../tab-strip-metrics.js'

const SCROLLING_LINGER_MS = 800

export function TabStripScrollIndicator({
  metrics,
  stripRef,
  disabled,
}: {
  metrics: TabStripScrollMetrics
  stripRef: React.RefObject<HTMLDivElement | null>
  disabled: boolean
}): React.JSX.Element | null {
  const trackRef = useRef<HTMLDivElement>(null)
  const cleanupDragRef = useRef<(() => void) | null>(null)
  const [thumb, setThumb] = useState<TabStripThumbLayout>({ widthPx: 0, leftPx: 0 })
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [scrolling, setScrolling] = useState(false)

  const remeasure = useCallback((): void => {
    const track = trackRef.current
    if (track === null) return
    setThumb(computeTabStripThumbLayout({ trackWidthPx: track.clientWidth, metrics }))
  }, [metrics])

  useLayoutEffect(() => {
    remeasure()
    const track = trackRef.current
    if (track === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(remeasure)
    observer.observe(track)
    return () => observer.disconnect()
  }, [remeasure, metrics.hasOverflow])

  useEffect(() => {
    const strip = stripRef.current
    if (strip === null) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onScroll = (): void => {
      setScrolling(true)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => setScrolling(false), SCROLLING_LINGER_MS)
    }
    strip.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      strip.removeEventListener('scroll', onScroll)
      if (timer !== null) clearTimeout(timer)
    }
  }, [stripRef])

  // 썸을 끄는 도중 숨으면 창 리스너·body 커서가 남는다 — 숨을 때 정리한다.
  useEffect(() => {
    if (disabled || !metrics.hasOverflow) cleanupDragRef.current?.()
  }, [disabled, metrics.hasOverflow])
  useEffect(() => () => cleanupDragRef.current?.(), [])

  if (!metrics.hasOverflow) return null

  const onThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || disabled) return
    event.preventDefault()
    event.stopPropagation()
    const strip = stripRef.current
    const track = trackRef.current
    if (strip === null || track === null) return
    const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth)
    if (maxScrollLeft <= 0) return
    const startX = event.clientX
    const startScrollLeft = strip.scrollLeft
    const trackWidthPx = track.clientWidth
    const thumbWidthPx = thumb.widthPx
    setDragging(true)
    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    const onMove = (move: PointerEvent): void => {
      strip.scrollLeft = thumbDragScrollLeft({ startScrollLeft, deltaX: move.clientX - startX, trackWidthPx, thumbWidthPx, maxScrollLeft })
    }
    const cleanup = (): void => {
      setDragging(false)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      cleanupDragRef.current = null
    }
    cleanupDragRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || disabled || event.target !== trackRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const strip = stripRef.current
    const track = trackRef.current
    if (strip === null || track === null) return
    const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth)
    if (maxScrollLeft <= 0) return
    const left = trackClickScrollLeft({ clickX: event.clientX - track.getBoundingClientRect().left, trackWidthPx: track.clientWidth, thumbWidthPx: thumb.widthPx, maxScrollLeft })
    strip.scrollTo({ left, behavior: 'smooth' })
  }

  // 썸 위 휠도 스트립을 민다.
  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const strip = stripRef.current
    if (strip === null || disabled) return
    strip.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  }

  const expanded = !disabled && (hovered || dragging)
  const visible = !disabled && (hovered || dragging || scrolling)
  return (
    <div
      ref={trackRef}
      className={`tab-strip-scroll-track ${expanded ? 'is-expanded' : ''} ${disabled ? 'is-disabled' : visible ? 'is-visible' : ''}`}
      data-tab-strip-scroll-indicator=""
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={onTrackPointerDown}
      onWheel={onWheel}
      // 장식 레일 — 키보드·보조기기는 옆 chevron 으로 스크롤한다.
      aria-hidden
    >
      <div
        className={`tab-strip-scroll-thumb ${dragging ? 'is-dragging' : hovered ? 'is-hovered' : ''}`}
        data-tab-strip-scroll-thumb=""
        style={{ width: `${thumb.widthPx}px`, left: `${thumb.leftPx}px` }}
        onPointerDown={onThumbPointerDown}
      />
    </div>
  )
}
