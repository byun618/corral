// 탭 스트립 넘침 (LIFE-494 T2) — Orca v1.4.219 `tab-strip-overflow-navigation.ts`(휠·chevron 스텝·stick-to-end·앵커·reveal·dock 쪽)와
// `tab-strip-drag-scroll.ts`(드래그 중 chevron hover 180ms) 를 옮긴다. 계산은 `tab-strip-metrics.ts`·`tab-strip-geometry.ts`.
//
// T1 의 「ResizeObserver 가 폭 변화마다 활성 탭으로 무조건 재스크롤」을 대체한다. 그 장치가 막던 것(LIFE-493 k5/r3: 새 탭을 만든 직후
// 헤더 꼬리가 다음 렌더에 자리를 잡아 스트립 폭이 줄면 끝 탭이 39px 잘림)은 여기서 **stick-to-end** 가 막는다 — 새 탭을 끝까지 보이게
// 한 뒤 스트립이 끝에 붙어 있으면, 폭이 바뀌어도 끝에 다시 붙인다. 끝이 아니면 위치를 건드리지 않고(휠로 둘러보던 자리가 안 튄다),
// 활성 탭은 시야 밖이면 가장자리에 붙어(dock) 보인다.
//
// ⚠ 직접 고안한 스크롤 제어를 넣지 않는다 — Orca 는 끝 여백·커스텀 스크롤을 넣었다가 탭 깜빡임으로 되돌렸다(#14314 → #14450).
//
// Orca 의 「포인터 제스처 중엔 스트립을 안 움직인다」(`isTabStripPointerGestureActive`) 자리는 corral 의 **탭 드래그 중**이다 — corral 은
// 탭 활성화가 click(떼고 난 뒤)이라 누르는 동안 활성 탭이 바뀌지 않고, 남는 제스처는 드래그뿐이다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  EMPTY_TAB_STRIP_METRICS,
  computeTabStripScrollMetrics,
  isTabStripAtEnd,
  sameTabStripScrollMetrics,
  tabStripScrollStep,
  wheelToHorizontal,
  type TabStripDockSide,
  type TabStripScrollMetrics,
} from '../tab-strip-metrics.js'
import {
  captureTabStripScrollAnchor,
  findOffscreenOpenedSlot,
  findTabStripSlot,
  isLastTabStripSlot,
  readTabStripSlotIds,
  restoreTabStripScrollAnchor,
  revealTabStripSlot,
  tabStripDockSide,
  type TabStripScrollAnchor,
} from '../tab-strip-geometry.js'

export const TAB_STRIP_DRAG_SCROLL_INTERVAL_MS = 180

type Direction = 'start' | 'end'

export type TabStripOverflow = {
  stripRef: React.RefObject<HTMLDivElement | null>
  metrics: TabStripScrollMetrics
  dockSide: TabStripDockSide | null
  scrollByStep: (direction: Direction) => void
  /** chevron 의 pointerenter/leave — 탭 드래그 중일 때만 자동 스크롤한다. */
  onDragScrollEnter: (direction: Direction) => void
  onDragScrollLeave: () => void
}

/** 스트립과 그 직계 자식(탭)의 크기 변화 + 자식 추가·제거를 한 콜백으로 (Orca `bindTabStripContentResizeObservers`). */
function observeStripContent(input: { strip: HTMLElement; onResize: () => void }): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}
  const resizeObserver = new ResizeObserver(input.onResize)
  const observeTargets = (): void => {
    resizeObserver.disconnect()
    resizeObserver.observe(input.strip)
    for (const child of input.strip.children) resizeObserver.observe(child)
  }
  observeTargets()
  const mutationObserver = new MutationObserver(() => {
    observeTargets()
    input.onResize()
  })
  mutationObserver.observe(input.strip, { childList: true })
  return () => {
    resizeObserver.disconnect()
    mutationObserver.disconnect()
  }
}

export function useTabStripOverflow(input: {
  activeTabId: string | null
  /** 탭 순서(id 이어 붙임) — 바뀌면 열림·닫힘·끝 붙기를 다시 본다. */
  layoutKey: string
  /** 영역이 바뀌면(같은 컴포넌트에 다른 영역) 이전 탭 목록과 비교하지 않는다. */
  groupId: string
  /** 탭 드래그 중인가 (App `useTabDrag`) — dock 끔·스트립 고정·chevron 자동 스크롤 조건. */
  dragActive: boolean
}): TabStripOverflow {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const prevStripRef = useRef<{ groupId: string; tabIds: ReadonlySet<string> } | null>(null)
  const stickToEndRef = useRef(false)
  const tabClosedThisCommitRef = useRef(false)
  const activeTabIdRef = useRef<string | null>(null)
  const dragActiveRef = useRef(false)
  const hoverDeferredRevealIdsRef = useRef<Set<string>>(new Set())
  const scrollAnchorRef = useRef<{ activeTabId: string | null; anchor: TabStripScrollAnchor | null } | null>(null)
  const [metrics, setMetrics] = useState<TabStripScrollMetrics>(EMPTY_TAB_STRIP_METRICS)
  const [dockSide, setDockSide] = useState<TabStripDockSide | null>(null)

  const updateMetrics = useCallback((): void => {
    const strip = stripRef.current
    if (strip === null) return
    const next = computeTabStripScrollMetrics(strip)
    setMetrics((previous) => (sameTabStripScrollMetrics(previous, next) ? previous : next))
    setDockSide(tabStripDockSide(strip))
  }, [])

  const recordScrollAnchor = useCallback((): void => {
    const strip = stripRef.current
    if (strip === null) return
    const activeTabId = activeTabIdRef.current
    scrollAnchorRef.current = { activeTabId, anchor: captureTabStripScrollAnchor({ strip, activeTabId }) }
  }, [])

  const scrollByStep = useCallback((direction: Direction, behavior: ScrollBehavior = 'smooth'): void => {
    const strip = stripRef.current
    if (strip === null) return
    const step = tabStripScrollStep(strip.clientWidth)
    strip.scrollBy({ left: direction === 'start' ? -step : step, behavior })
  }, [])

  // 세로 휠 → 가로. React `onWheel` 은 passive 라 `preventDefault` 가 안 먹어 직접 단다.
  useEffect(() => {
    const strip = stripRef.current
    if (strip === null) return
    const onWheel = (event: WheelEvent): void => {
      const step = wheelToHorizontal({ deltaX: event.deltaX, deltaY: event.deltaY, overflows: strip.scrollWidth > strip.clientWidth })
      if (step === null) return
      event.preventDefault()
      strip.scrollLeft += step
      updateMetrics()
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [updateMetrics])

  // 스크롤 = 끝 붙기 갱신(사용자가 일부러 떠나면 그만 붙인다) · 크기 변화 = 끝에 붙어 있으면 끝으로 다시.
  useEffect(() => {
    const strip = stripRef.current
    if (strip === null) return
    const onScroll = (): void => {
      stickToEndRef.current = isTabStripAtEnd(strip)
      updateMetrics()
      recordScrollAnchor()
    }
    strip.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    const disconnect = observeStripContent({
      strip,
      onResize: () => {
        updateMetrics()
        if (stickToEndRef.current && !dragActiveRef.current) strip.scrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth)
        recordScrollAnchor()
      },
    })
    return () => {
      strip.removeEventListener('scroll', onScroll)
      disconnect()
    }
  }, [recordScrollAnchor, updateMetrics])

  // 포인터가 스트립 위에 있는 동안 배경에서 열린 탭은 reveal 을 미뤘다가 나갈 때 한다 — 누르려던 탭이 밀려나지 않게.
  useEffect(() => {
    const strip = stripRef.current
    if (strip === null) return
    const onPointerLeave = (): void => {
      const deferred = hoverDeferredRevealIdsRef.current
      if (deferred.size === 0) return
      hoverDeferredRevealIdsRef.current = new Set()
      if (dragActiveRef.current) return
      const knownIds = new Set([...readTabStripSlotIds(strip)].filter((id) => !deferred.has(id)))
      const opened = findOffscreenOpenedSlot({ strip, knownIds })
      if (opened === undefined) return
      revealTabStripSlot({ strip, slot: opened })
      stickToEndRef.current = isTabStripAtEnd(strip)
      updateMetrics()
      recordScrollAnchor()
    }
    strip.addEventListener('pointerleave', onPointerLeave)
    return () => strip.removeEventListener('pointerleave', onPointerLeave)
  }, [recordScrollAnchor, updateMetrics])

  // 아래 effect 들이 이번 커밋의 활성 탭·드래그 여부를 보되 그것 때문에 다시 돌지는 않게 ref 를 먼저 세운다.
  useLayoutEffect(() => {
    activeTabIdRef.current = input.activeTabId
    dragActiveRef.current = input.dragActive
  }, [input.activeTabId, input.dragActive])

  // 탭 목록 변화 — 열림(앵커 유지·화면 밖이면 reveal·끝 탭이 활성이면 끝으로) / 그 밖엔 끝에 붙어 있으면 끝으로.
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (strip === null) {
      prevStripRef.current = null
      return
    }
    const prev = prevStripRef.current
    const tabIds = readTabStripSlotIds(strip)
    prevStripRef.current = { groupId: input.groupId, tabIds }
    if (prev === null || prev.groupId !== input.groupId) {
      hoverDeferredRevealIdsRef.current = new Set()
      updateMetrics()
      return
    }
    const dragging = dragActiveRef.current
    // 수가 아니라 id 로 본다 — 탭 하나가 다른 탭을 갈아치우면 수는 그대로다.
    const tabOpened = [...tabIds].some((id) => !prev.tabIds.has(id))
    tabClosedThisCommitRef.current = !tabOpened && [...prev.tabIds].some((id) => !tabIds.has(id))
    const scrollToEnd = (stick: boolean): void => {
      const current = stripRef.current
      if (current === null) return
      current.scrollLeft = Math.max(0, current.scrollWidth - current.clientWidth)
      if (stick) stickToEndRef.current = true
      updateMetrics()
    }
    const recorded = scrollAnchorRef.current
    if (tabOpened && !dragging) {
      if (recorded?.activeTabId === activeTabIdRef.current) {
        // 보던 탭 주변에 끼어든 탭은 그 탭의 화면 x 를 지킨다 — 화면 밖에 들어온 탭만 스크롤하고, 활성 탭은 붙는다.
        if (recorded.anchor !== null) restoreTabStripScrollAnchor({ strip, anchor: recorded.anchor })
        if (strip.matches(':hover')) {
          for (const id of tabIds) if (!prev.tabIds.has(id)) hoverDeferredRevealIdsRef.current.add(id)
        } else {
          const opened = findOffscreenOpenedSlot({ strip, knownIds: prev.tabIds })
          if (opened !== undefined) revealTabStripSlot({ strip, slot: opened })
        }
        stickToEndRef.current = isTabStripAtEnd(strip)
      } else if (isLastTabStripSlot({ strip, tabId: activeTabIdRef.current })) {
        scrollToEnd(true)
        requestAnimationFrame(() => scrollToEnd(true))
      }
      // 가운데에 열리며 활성이 된 탭은 아래 활성 탭 effect 가 보이게 한다.
    } else if (stickToEndRef.current && !dragging) {
      scrollToEnd(false)
      // 이번 커밋 뒤의 reveal 이 끝에서 떠났을 수 있다 — 다시 본다.
      requestAnimationFrame(() => {
        if (stickToEndRef.current) scrollToEnd(false)
      })
    }
    updateMetrics()
    requestAnimationFrame(updateMetrics)
    recordScrollAnchor()
  }, [input.layoutKey, input.groupId, recordScrollAnchor, updateMetrics])

  // 활성 탭이 바뀌면 제자리에 보이게 — 단 드래그 중·탭을 닫은 커밋은 가만히 둔다(닫은 뒤 다음 활성 탭은 멀리 있을 수 있다.
  // 쫓아가면 스트립이 튄다 — 그 탭은 가장자리에 붙어 보인다).
  useLayoutEffect(() => {
    const strip = stripRef.current
    const activeTabId = input.activeTabId
    const slot = strip === null || activeTabId === null ? undefined : findTabStripSlot({ strip, tabId: activeTabId })
    if (strip === null || slot === undefined || dragActiveRef.current || tabClosedThisCommitRef.current) {
      requestAnimationFrame(updateMetrics)
      recordScrollAnchor()
      return
    }
    revealTabStripSlot({ strip, slot })
    // 스크롤 이벤트는 크기 감시 뒤에 온다 — 낡은 끝 붙기가 이 reveal 을 덮지 않게 지금 다시 잰다.
    stickToEndRef.current = isTabStripAtEnd(strip)
    requestAnimationFrame(updateMetrics)
    recordScrollAnchor()
  }, [input.activeTabId, recordScrollAnchor, updateMetrics])

  // 드래그가 시작·끝나면 dock 이 꺼지고 켜진다 — 스크롤·크기 변화 없이 붙는 쪽이 바뀐다.
  useLayoutEffect(() => {
    updateMetrics()
  }, [input.dragActive, updateMetrics])

  // 닫힘 표시는 그것을 세운 커밋 것이다 — 다음 커밋(탭 전환 등)으로 넘기지 않는다.
  useLayoutEffect(() => {
    tabClosedThisCommitRef.current = false
  })

  // 드래그 중 chevron hover → 180ms 마다 한 스텝. 그 방향으로 더 못 가면 멈춘다. 드래그가 끝나면 즉시 멈춘다.
  const intervalRef = useRef<number | null>(null)
  const metricsRef = useRef(metrics)
  useLayoutEffect(() => {
    metricsRef.current = metrics
  }, [metrics])
  const onDragScrollLeave = useCallback((): void => {
    if (intervalRef.current === null) return
    window.clearInterval(intervalRef.current)
    intervalRef.current = null
  }, [])
  const onDragScrollEnter = useCallback(
    (direction: Direction): void => {
      onDragScrollLeave()
      if (!dragActiveRef.current) return
      const canScroll = (): boolean => (direction === 'start' ? metricsRef.current.canScrollStart : metricsRef.current.canScrollEnd)
      if (!canScroll()) return
      const tick = (): void => {
        if (!canScroll() || !dragActiveRef.current) {
          onDragScrollLeave()
          return
        }
        scrollByStep(direction, 'auto')
      }
      tick()
      intervalRef.current = window.setInterval(tick, TAB_STRIP_DRAG_SCROLL_INTERVAL_MS)
    },
    [onDragScrollLeave, scrollByStep],
  )
  useEffect(() => {
    if (!input.dragActive) onDragScrollLeave()
  }, [input.dragActive, onDragScrollLeave])
  useEffect(() => onDragScrollLeave, [onDragScrollLeave])

  return { stripRef, metrics, dockSide, scrollByStep, onDragScrollEnter, onDragScrollLeave }
}
