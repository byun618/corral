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
// (design-tokens.css --sidebar-w/--sidebar-min/--sidebar-max)이고, 리터럴이 아니라 런타임에
// CSS 변수에서 읽는다 (아래 tokenPx).
//
// 영속은 `localStorage` 가 아니라 `window.corral.getUiPrefs/setUiPrefs` (main 프로세스
// ui-prefs.ts, tmp→rename 원자적 쓰기) 를 쓴다 — 이 앱의 프로덕션 file:// 로드 경로에서
// localStorage 커밋이 재기동 후 사라지는 현상을 실측했다(C2, raw/claude-orca/c2-resize.json).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

// 폭 경계는 **토큰에서 읽는다** — 게이트 ① 수정 라운드(09-gate1-fix.md A) 가 원안(236/560)으로
// 되돌리며, 같은 값을 JS 리터럴로 또 적어 두면 토큰과 코드가 따로 노는 것을 실제로 겪었다
// (`-claude-orca` 라운드에서 토큰만 바꾸고 이 상수가 남아 클램프가 안 따라왔다). freeze v2
// 승계 요구사항 "값은 `--*` 변수로만 참조한다" 의 JS 쪽 이행이다.
const TOKEN_FALLBACK = { width: 280, min: 220, max: 500 } as const

function tokenPx(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  // getPropertyValue 는 선행 공백을 붙여 돌려준다 — trim 없이 parseFloat 하면 NaN 은 아니지만
  // 값이 비었을 때(''), parseFloat('') = NaN 이라 폴백으로 떨어뜨려야 한다.
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Orca 원본 `clampSidebarResizeWidth` 의 형태(그대로) — 경계값만 corral 토큰에서 온다. */
export function clampSidebarWidth(
  width: number,
  minWidth: number = tokenPx('--sidebar-min', TOKEN_FALLBACK.min),
  maxWidth: number = tokenPx('--sidebar-max', TOKEN_FALLBACK.max),
): number {
  return Math.min(maxWidth, Math.max(minWidth, width))
}

export function useSidebarResize(sidebarRef: React.RefObject<HTMLDivElement | null>): {
  width: number
  resizing: boolean
  onHandleMouseDown: (event: React.MouseEvent) => void
} {
  const [width, setWidthState] = useState<number>(() => tokenPx('--sidebar-w', TOKEN_FALLBACK.width))
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
        // LIFE-527 fix1 F9 — 위쪽 36px drag 띠 위에 깔리므로 no-drag. 아니면 머리 높이에서 끄는 동안 창이 끌린다(원본에는 없다).
        overlay.style.setProperty('-webkit-app-region', 'no-drag')
        document.body.appendChild(overlay)
        overlayRef.current = overlay
      }
    },
    [width],
  )

  return { width, resizing, onHandleMouseDown }
}
