// 오른쪽 패널 열림·폭 (LIFE-589 E1ⓐⓑ) — 왼쪽 `useSidebarResize`(Orca 이식)와 같은 손잡이 방식을 거울로 쓴다.
//   · 폭 경계는 토큰(`--right-panel-w/min/max`)에서 읽는다 — 리터럴을 JS 에 또 두지 않는다(useSidebarResize 와 같은 이유)
//   · 드래그 중엔 rAF 로 DOM 폭만 바꾸고 mouseup 에 한 번 저장 · 전체 화면 투명 오버레이로 mouseup 유실 방지
//   · 손잡이는 패널 **왼쪽** 가장자리라 폭 = 시작 폭 − (현재 x − 시작 x)
// 영속은 `ui-prefs.json`(rightPanelOpen·rightPanelWidth) — 닫아도 패널 내용 상태(펼침·선택·스크롤)는 렌더러 메모리에 남는다(E1ⓔ).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const TOKEN_FALLBACK = { width: 300, min: 220, max: 640 } as const

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

export function useRightPanel(panelRef: React.RefObject<HTMLDivElement | null>): {
  open: boolean
  ready: boolean
  width: number
  resizing: boolean
  toggle: () => void
  show: () => void
  onHandleMouseDown: (event: React.MouseEvent) => void
} {
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const openRef = useRef(false)
  const [width, setWidthState] = useState<number>(() => tokenPx('--right-panel-w', TOKEN_FALLBACK.width))
  const [resizing, setResizing] = useState(false)
  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(width)
  const draftWidthRef = useRef(width)
  const frameRef = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    window.corral
      .getUiPrefs()
      .then((prefs) => {
        if (cancelled) return
        openRef.current = prefs.rightPanelOpen
        setOpen(prefs.rightPanelOpen)
        if (prefs.rightPanelWidth !== null) {
          const clamped = clampRightPanelWidth(prefs.rightPanelWidth)
          startWidthRef.current = clamped
          setWidthState(clamped)
        }
      })
      .catch(() => {
        // 읽기 실패 — 닫힘·기본폭.
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
  const toggle = useCallback(() => setOpenPersisted(!openRef.current), [setOpenPersisted])
  const show = useCallback(() => setOpenPersisted(true), [setOpenPersisted])

  const applyRenderedWidth = useCallback(
    (next: number) => {
      if (panelRef.current !== null) panelRef.current.style.width = `${next}px`
    },
    [panelRef],
  )

  useLayoutEffect(() => {
    if (isResizingRef.current) return
    draftWidthRef.current = width
    applyRenderedWidth(width)
  }, [applyRenderedWidth, width, open])

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
      setWidthState(finalWidth)
      window.corral.setUiPrefs({ rightPanelWidth: finalWidth })
    }
  }, [applyRenderedWidth, resetDocumentStyles])

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isResizingRef.current) return
      const next = clampRightPanelWidth(startWidthRef.current - (event.clientX - startXRef.current))
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
    [width],
  )

  return { open, ready, width, resizing, toggle, show, onHandleMouseDown }
}
