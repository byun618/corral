// 오른쪽 패널 열림·보기·폭 (LIFE-589 E1ⓐⓑ · LIFE-682 A2·A3·A10) — 왼쪽 `useSidebarResize`(Orca 이식)와 같은 손잡이 방식을 거울로 쓴다.
//   · 폭 경계는 토큰(`--right-panel-min/max`, 보기별 기본은 `right-panel-views.tsx` 의 토큰)에서 읽는다 — 리터럴을 JS 에 또 두지 않는다(useSidebarResize 와 같은 이유)
//   · 드래그 중엔 rAF 로 DOM 폭만 바꾸고 mouseup 에 한 번 저장 · 전체 화면 투명 오버레이로 mouseup 유실 방지
//   · 손잡이는 패널 **왼쪽** 가장자리라 폭 = 시작 폭 − (현재 x − 시작 x)
//   · 폭은 **보기마다 따로** 기억한다(LIFE-682 A3) — 끌기는 지금 보기의 폭만 바꾼다. 렌더 폭은 창에 맞춰 깎되 기억값은 덮지 않는다(A10, `right-panel-width.ts`)
// 영속은 `ui-prefs.json`(rightPanelOpen·rightPanelView·rightPanelWidth = 탐색기 폭·rightPanelDetailWidth) — 닫아도 패널 내용 상태(펼침·선택·스크롤)는 렌더러 메모리에 남는다(E1ⓔ).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RightPanelView } from '../../../shared/types.js'
import { RIGHT_PANEL_VIEWS } from '../components/right-panel-views.js'
import { panelDragMax, panelRenderWidth } from '../right-panel-width.js'

const TOKEN_FALLBACK = { min: 220, max: 640, mainMin: 400 } as const

function tokenPx(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name).trim())
  return Number.isFinite(parsed) ? parsed : fallback
}

export function clampRightPanelWidth(
  width: number,
  minWidth: number = tokenPx('--right-panel-min', TOKEN_FALLBACK.min),
  maxWidth: number = tokenPx('--right-panel-max', TOKEN_FALLBACK.max),
): number {
  return Math.min(maxWidth, Math.max(minWidth, width))
}

type Widths = Record<RightPanelView, number>

function defaultWidths(): Widths {
  const widths: Partial<Widths> = {}
  for (const view of RIGHT_PANEL_VIEWS) widths[view.id] = tokenPx(view.widthToken, view.widthFallback)
  return { explorer: widths.explorer ?? 300, detail: widths.detail ?? 560 }
}

/** 보기 → ui-prefs 칸. 탐색기 폭은 LIFE-589 때부터 있던 `rightPanelWidth` 를 그대로 쓴다(옛 파일 이어받기). */
function persistWidth({ view, width }: { view: RightPanelView; width: number }): void {
  switch (view) {
    case 'explorer':
      window.corral.setUiPrefs({ rightPanelWidth: width })
      return
    case 'detail':
      window.corral.setUiPrefs({ rightPanelDetailWidth: width })
      return
  }
}

export function useRightPanel({ panelRef, sidebarWidth }: {
  panelRef: React.RefObject<HTMLDivElement | null>
  /** 왼쪽 사이드바 칸의 지금 폭(접혔으면 0) — 렌더 상한(A10)에 쓴다. */
  sidebarWidth: number
}): {
  open: boolean
  ready: boolean
  view: RightPanelView
  /** 지금 보기의 렌더 폭(창에 맞춰 깎인 값). */
  width: number
  resizing: boolean
  toggle: () => void
  /** 연다 — 보기를 주면 그 보기로 바꾼다. */
  show: (view?: RightPanelView) => void
  /** 닫는다(숨기기 — 내용 상태는 남는다). */
  hide: () => void
  /** activity bar 단추 — 그 보기로 바꾼다. 활성 단추를 다시 눌러도 닫지 않는다(Orca, A2). */
  select: (view: RightPanelView) => void
  onHandleMouseDown: (event: React.MouseEvent) => void
} {
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const openRef = useRef(false)
  const [view, setViewState] = useState<RightPanelView>('explorer')
  const viewRef = useRef<RightPanelView>('explorer')
  const [widths, setWidths] = useState<Widths>(defaultWidths)
  const [windowWidth, setWindowWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  const [resizing, setResizing] = useState(false)
  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const dragMaxRef = useRef<number>(TOKEN_FALLBACK.max)
  const draftWidthRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  const min = tokenPx('--right-panel-min', TOKEN_FALLBACK.min)
  const mainMin = tokenPx('--w-tasks-body-min', TOKEN_FALLBACK.mainMin)
  const width = panelRenderWidth({ stored: widths[view], windowWidth, sidebarWidth, mainMin, min })

  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.corral
      .getUiPrefs()
      .then((prefs) => {
        if (cancelled) return
        openRef.current = prefs.rightPanelOpen
        setOpen(prefs.rightPanelOpen)
        // 모르는 보기 이름은 main 이 이미 탐색기로 돌렸다 — 렌더러 목록에 없는 보기도 한 번 더 막는다.
        const restored = RIGHT_PANEL_VIEWS.some((entry) => entry.id === prefs.rightPanelView) ? prefs.rightPanelView : 'explorer'
        viewRef.current = restored
        setViewState(restored)
        setWidths((current) => ({
          explorer: prefs.rightPanelWidth === null ? current.explorer : clampRightPanelWidth(prefs.rightPanelWidth),
          detail: prefs.rightPanelDetailWidth === null ? current.detail : clampRightPanelWidth(prefs.rightPanelDetailWidth),
        }))
      })
      .catch(() => {
        // 읽기 실패 — 닫힘·탐색기·기본폭.
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setOpenPersisted = useCallback((next: boolean) => {
    if (openRef.current === next) return
    openRef.current = next
    setOpen(next)
    window.corral.setUiPrefs({ rightPanelOpen: next })
  }, [])
  const setViewPersisted = useCallback((next: RightPanelView) => {
    if (viewRef.current === next) return
    viewRef.current = next
    setViewState(next)
    window.corral.setUiPrefs({ rightPanelView: next })
  }, [])
  const toggle = useCallback(() => setOpenPersisted(!openRef.current), [setOpenPersisted])
  const show = useCallback((next?: RightPanelView) => {
    if (next !== undefined) setViewPersisted(next)
    setOpenPersisted(true)
  }, [setOpenPersisted, setViewPersisted])
  const hide = useCallback(() => setOpenPersisted(false), [setOpenPersisted])
  const select = useCallback((next: RightPanelView) => setViewPersisted(next), [setViewPersisted])

  const applyRenderedWidth = useCallback(
    (next: number) => {
      if (panelRef.current !== null) panelRef.current.style.width = `${next}px`
    },
    [panelRef],
  )

  // 의존성 없이 매 커밋 맞춘다 — 패널 DOM 은 App 부트 화면 동안 없어서, 저장된 폭이 먼저 와도 패널이 마운트되는 커밋에 적용해야 한다(최종 관문 E1ⓑ).
  useLayoutEffect(() => {
    if (isResizingRef.current) return
    draftWidthRef.current = width
    if (panelRef.current !== null && panelRef.current.style.width !== `${width}px`) applyRenderedWidth(width)
  })

  const removeOverlay = useCallback(() => {
    const overlay = overlayRef.current
    if (overlay !== null && overlay.parentNode !== null) overlay.parentNode.removeChild(overlay)
    overlayRef.current = null
  }, [])

  const resetDocumentStyles = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    removeOverlay()
  }, [removeOverlay])

  const stopResize = useCallback(() => {
    if (!isResizingRef.current) return
    isResizingRef.current = false
    setResizing(false)
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    resetDocumentStyles()
    const finalWidth = draftWidthRef.current
    applyRenderedWidth(finalWidth)
    if (finalWidth !== startWidthRef.current) {
      const target = viewRef.current
      setWidths((current) => ({ ...current, [target]: finalWidth }))
      persistWidth({ view: target, width: finalWidth })
    }
  }, [applyRenderedWidth, resetDocumentStyles])

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isResizingRef.current) return
      const next = clampRightPanelWidth(startWidthRef.current - (event.clientX - startXRef.current), undefined, dragMaxRef.current)
      if (next === draftWidthRef.current) return
      draftWidthRef.current = next
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        applyRenderedWidth(draftWidthRef.current)
      })
    },
    [applyRenderedWidth],
  )

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopResize)
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopResize)
      window.removeEventListener('blur', stopResize)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      isResizingRef.current = false
      resetDocumentStyles()
    }
  }, [handleMouseMove, resetDocumentStyles, stopResize])

  const onHandleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      isResizingRef.current = true
      setResizing(true)
      startXRef.current = event.clientX
      startWidthRef.current = width
      draftWidthRef.current = width
      // 끌어서 가운데 영역을 최소 폭 아래로 누르지 않는다(A10) — 상한 = min(토큰 상한, 창에서 남는 폭).
      dragMaxRef.current = panelDragMax({ max: tokenPx('--right-panel-max', TOKEN_FALLBACK.max), windowWidth: window.innerWidth, sidebarWidth, mainMin, min })
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      if (overlayRef.current === null) {
        const overlay = document.createElement('div')
        overlay.style.position = 'fixed'
        overlay.style.inset = '0'
        overlay.style.zIndex = '2147483647'
        overlay.style.cursor = 'col-resize'
        overlay.style.background = 'transparent'
        overlay.style.setProperty('-webkit-app-region', 'no-drag')
        document.body.appendChild(overlay)
        overlayRef.current = overlay
      }
    },
    [width, sidebarWidth, mainMin, min],
  )

  return { open, ready, view, width, resizing, toggle, show, hide, select, onHandleMouseDown }
}
