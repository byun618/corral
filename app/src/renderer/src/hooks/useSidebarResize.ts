// 사이드바 리사이즈 — Orca `useSidebarResize.ts` 이식 (C2, C9′ⓒ 구조 규칙).
//
// Ported from orca (github.com/stablyai/orca), MIT License, Copyright (c) 2026 Lovecast Inc.
// Source: src/renderer/src/hooks/useSidebarResize.ts (1-218줄) — 그대로 옮긴 것:
//   · rAF 배칭 — mousemove 마다 좌표는 ref 에 담고, 실제 DOM 폭 반영은 requestAnimationFrame
//     한 번으로 묶는다(17-19줄 원본 주석: "매 rerender 가 드래그 중 폭을 저장값으로 스냅백시켜
//     핸들이 커서보다 뒤처지는 느낌을 준다" — corral 도 같은 이유).
//   · window 리스너를 마운트 시 한 번만 붙이고 `isResizingRef` 플래그로 드래그 중인지만 검사
//     (드래그마다 리스너를 갈아끼우지 않는다 — 원본 165-183줄).
//   · 드래그 중 전체 화면 투명 오버레이(zIndex 최댓값)를 덮어 iframe/embed 가 mouseup 을
//     삼켜 드래그가 안 끝나는 문제를 막는다(원본 197-212줄 주석 그대로 포팅).
//   · mouseup 시 1회만 `setWidth` 호출 — draft 값이 실제로 바뀌었을 때만.
// corral 쪽 각색: Orca 는 폭 영속을 외부 store 에 맡기지만(이 훅은 `setWidth` 콜백만 받는다),
// corral 엔 store 가 없어(00-analysis §참고 재료 요약 — zustand 미도입) 이 훅 안에서 직접
// 영속한다. min/max·기본폭 값은 Orca 리터럴이 아니라 corral 토큰
// (design-tokens.css --sidebar-w/--sidebar-min, 밀도가 다르다 — 00-analysis 판단 유지)이다.
//
// 영속은 `localStorage` 가 아니라 `window.corral.getUiPrefs/setUiPrefs` (main 프로세스
// ui-prefs.ts, tmp→rename 원자적 쓰기) 를 쓴다 — 이 앱의 프로덕션 file:// 로드 경로에서
// localStorage 커밋이 재기동 후 사라지는 현상을 실측했다(C2, raw/claude-orca/c2-resize.json).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const DEFAULT_WIDTH = 322 // --sidebar-w
// 수정 2회차(08-fix-orca2.md D-1) — 이 브랜치의 그라운드 트루스는 Orca 다(02-kickoff-orca.md).
// 1회차는 "corral 밀도 스케일"을 이유로 236/560(Orca 대비 +7%/+12%)을 썼으나, 코디네이터
// 검산(verdict.md "-claude-orca 수정 1회차 판정 부록")이 그 근거가 이 브랜치엔 없다고 정정했다
// — Orca 리터럴을 그대로 채택한다(components/sidebar/index.tsx:33-34).
const MIN_WIDTH = 220 // --sidebar-min
const MAX_WIDTH = 500 // --sidebar-max

/** Orca 원본 `clampSidebarResizeWidth` (그대로). */
export function clampSidebarWidth(width: number, minWidth: number = MIN_WIDTH, maxWidth: number = MAX_WIDTH): number {
  return Math.min(maxWidth, Math.max(minWidth, width))
}

export function useSidebarResize(sidebarRef: React.RefObject<HTMLDivElement | null>): {
  width: number
  resizing: boolean
  onHandleMouseDown: (event: React.MouseEvent) => void
} {
  const [width, setWidthState] = useState<number>(DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)

  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(width)
  const draftWidthRef = useRef(width)
  const frameRef = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  // ui-prefs.json 은 main 프로세스 IPC 라 마운트 시 비동기로 1회 읽는다 — 기본폭으로
  // 먼저 그린 뒤 저장값이 오면 갱신(깜빡임은 초기 마운트 1프레임뿐이라 무시 가능한 수준).
  useEffect(() => {
    let cancelled = false
    window.corral
      .getUiPrefs()
      .then((prefs) => {
        if (cancelled || prefs.sidebarWidth === null) return
        const clamped = clampSidebarWidth(prefs.sidebarWidth)
        startWidthRef.current = clamped
        setWidthState(clamped)
      })
      .catch(() => {
        // 읽기 실패 — 기본폭 유지.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const applyRenderedWidth = useCallback(
    (next: number) => {
      if (sidebarRef.current !== null) sidebarRef.current.style.width = `${next}px`
    },
    [sidebarRef],
  )

  // width state 가 (드래그 밖에서) 바뀌면 DOM 도 맞춘다 — 원본 100-108줄.
  useLayoutEffect(() => {
    if (isResizingRef.current) return
    draftWidthRef.current = width
    applyRenderedWidth(width)
  }, [applyRenderedWidth, width])

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
      window.corral.setUiPrefs({ sidebarWidth: finalWidth }) // C2 — 재기동 후 폭 유지
    }
  }, [applyRenderedWidth, resetDocumentStyles])

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isResizingRef.current) return
      const next = clampSidebarWidth(startWidthRef.current + (event.clientX - startXRef.current))
      if (next === draftWidthRef.current) return
      draftWidthRef.current = next
      if (frameRef.current !== null) return
      // 드래그 중에는 DOM 을 직접 건드린다 — React state 를 매 프레임 갱신하지 않는다
      // (원본 91-94줄 이유: state 커밋마다 리렌더가 끼어들면 사이드바가 살짝 스냅백해 보인다).
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        applyRenderedWidth(draftWidthRef.current)
      })
    },
    [applyRenderedWidth],
  )

  // 리스너는 마운트 시 한 번만 — 드래그마다 add/remove 하지 않는다(원본 165-183줄).
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
      // 전체 화면 투명 오버레이 — iframe/embed 가 mouseup 을 삼켜 드래그가 안 끝나는 문제 방지
      // (원본 197-212줄 그대로).
      if (overlayRef.current === null) {
        const overlay = document.createElement('div')
        overlay.style.position = 'fixed'
        overlay.style.inset = '0'
        overlay.style.zIndex = '2147483647'
        overlay.style.cursor = 'col-resize'
        overlay.style.background = 'transparent'
        document.body.appendChild(overlay)
        overlayRef.current = overlay
      }
    },
    [width],
  )

  return { width, resizing, onHandleMouseDown }
}
