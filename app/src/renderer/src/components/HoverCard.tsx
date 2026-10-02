// hover 카드 (LIFE-477 B4) — 198 `components/ui/hover-card.tsx`(Radix HoverCard) + `WorktreeCardMeta.tsx:183-200` 의 자체 부품.
// 메뉴 라이브러리가 없어(react·xterm 만) 옵션 메뉴처럼 직접 만든다. 지키는 198 동작:
//   · 트리거 hover → openDelay(기본 100 — Compact 제목) 뒤 열림, 떠나면 closeDelay(120) 뒤 닫힘. 내용 위로 옮겨 가면 유지
//   · 트리거 포커스로 열리고 blur 로 닫힌다(Radix Trigger `onFocus`·`onBlur`, 198 제목 `tabIndex=0`)
//   · `side="right" align="start" sideOffset=8` — 오른쪽 자리가 없으면 왼쪽으로 뒤집고, 위아래는 화면 안으로 민다(Radix collision)
//   · 내용 `w-80 max-h-[28rem] overflow-y-auto p-3 text-xs`
// corral 이 더하는 것(198 은 Radix 모달 메뉴·가상 목록이 대신 막는 것):
//   · `suppressed` 동안(드래그 중) 열리지 않고 열려 있으면 닫힌다 · 옵션 메뉴가 열려 있으면 열리지 않는다
//   · 어떤 스크롤에도 닫힌다(트리거가 움직이면 카드가 엉뚱한 자리에 남는다) · 창 blur 에 닫힌다
//   · 열림 대기(openDelay) 중의 스크롤·blur·resize 도 예약을 취소한다(LIFE-477 r1 R1 — 대기 중에는 열린 뒤 리스너가 없어 지나간 뒤 카드가 떴다)
// 재사용(478 카드 우클릭·⋯ 등): `content` 를 null 로 주면 트리거는 그냥 그려지고 카드는 없다 — 「보일 내용이 없으면 열리지 않는다」.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type HoverCardTriggerProps = {
  ref: (element: HTMLElement | null) => void
  tabIndex: number | undefined
  onMouseEnter: () => void
  onMouseLeave: () => void
  onFocus: () => void
  onBlur: () => void
  'aria-describedby': string | undefined
  'data-hover-card-trigger': string | undefined
}

/** 열려 있으면 안 열리는 위층 — 옵션 메뉴(198 Radix DropdownMenu 는 모달이라 바깥 hover 를 막는다). */
const BLOCKING_LAYER_SELECTOR = '[data-sidebar-options-menu]'
const MARGIN = 8

let nextId = 0

export function HoverCard({
  content,
  suppressed,
  openDelay = 100,
  closeDelay = 120,
  sideOffset = 8,
  testId,
  render,
}: {
  /** 카드 내용. null 이면 카드가 없다(트리거만 그린다). */
  content: React.ReactNode | null
  /** 드래그 중 등 — 열지 않고, 열려 있으면 닫는다. */
  suppressed: boolean
  openDelay?: number
  closeDelay?: number
  sideOffset?: number
  /** `data-hover-card` 값 — 하네스가 카드를 찾는 열쇠. */
  testId: string
  render: (trigger: HoverCardTriggerProps) => React.JSX.Element
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const [id] = useState(() => `hover-card-${++nextId}`)
  const triggerRef = useRef<HTMLElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<number | null>(null)
  /** 열림 대기 동안만 걸린 취소 리스너를 떼는 함수 — 예약이 끝나거나 취소되면 비운다. */
  const disarmRef = useRef<(() => void) | null>(null)
  const enabled = content !== null && !suppressed

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    disarmRef.current?.()
    disarmRef.current = null
  }, [])
  const schedule = (input: { next: boolean; delay: number }): void => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      disarmRef.current?.()
      disarmRef.current = null
      if (input.next && document.querySelector(BLOCKING_LAYER_SELECTOR) !== null) return
      setOpen(input.next)
    }, input.delay)
    if (!input.next) return
    // 열림 대기 중 — 열린 뒤 닫힘 리스너(아래 effect)와 같은 이벤트로 예약을 취소한다.
    window.addEventListener('scroll', clearTimer, true)
    window.addEventListener('blur', clearTimer)
    window.addEventListener('resize', clearTimer)
    disarmRef.current = () => {
      window.removeEventListener('scroll', clearTimer, true)
      window.removeEventListener('blur', clearTimer)
      window.removeEventListener('resize', clearTimer)
    }
  }
  const close = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])
  useEffect(() => {
    if (!enabled) close()
  }, [enabled, close])

  useEffect(() => {
    if (!open) return
    const onScroll = (): void => close()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const trigger = triggerRef.current
    const card = cardRef.current
    if (trigger === null || card === null) return
    const anchor = trigger.getBoundingClientRect()
    const box = card.getBoundingClientRect()
    const maxHeight = Math.max(0, window.innerHeight - MARGIN * 2)
    const height = Math.min(box.height, maxHeight)
    const right = anchor.right + sideOffset
    const left =
      right + box.width + MARGIN <= window.innerWidth ? right : Math.max(MARGIN, Math.min(anchor.left - sideOffset - box.width, window.innerWidth - box.width - MARGIN))
    const top = Math.max(MARGIN, Math.min(anchor.top, window.innerHeight - height - MARGIN))
    setPosition((prev) => (prev !== null && prev.left === left && prev.top === top && prev.maxHeight === maxHeight ? prev : { left, top, maxHeight }))
  })

  const trigger: HoverCardTriggerProps = {
    ref: (element) => {
      triggerRef.current = element
    },
    tabIndex: content === null ? undefined : 0,
    onMouseEnter: () => {
      if (enabled) schedule({ next: true, delay: openDelay })
    },
    onMouseLeave: () => {
      if (enabled) schedule({ next: false, delay: closeDelay })
      else clearTimer()
    },
    onFocus: () => {
      if (!enabled || document.querySelector(BLOCKING_LAYER_SELECTOR) !== null) return
      clearTimer()
      setOpen(true)
    },
    onBlur: close,
    'aria-describedby': open ? id : undefined,
    'data-hover-card-trigger': content === null ? undefined : testId,
  }

  return (
    <>
      {render(trigger)}
      {open && enabled
        ? createPortal(
            <div
              ref={cardRef}
              id={id}
              className="hover-card"
              data-hover-card={testId}
              role="tooltip"
              style={
                position === null
                  ? { visibility: 'hidden', left: 0, top: 0 }
                  : { left: position.left, top: position.top, maxHeight: `min(28rem, ${position.maxHeight}px)` }
              }
              onMouseEnter={clearTimer}
              onMouseLeave={() => schedule({ next: false, delay: closeDelay })}
              // 카드 안 클릭이 카드 밑(사이드바 카드 선택)으로 새지 않게 — 198 `onClick stopPropagation`.
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
