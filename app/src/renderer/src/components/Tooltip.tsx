// 아이콘 툴팁 (LIFE-755) — Orca `components/ui/tooltip.tsx` 기본 변형(Radix Tooltip)을 직접 만든다. 메뉴 라이브러리가 없어(react·xterm 만) HoverCard 처럼 부품을 둔다.
// OS 기본 `title` 툴팁은 실제 앱(드래그 줄 안 no-drag 단추)에서 안 떴다 — DOM 툴팁은 native 경로를 쓰지 않고 CDP 로 관측된다. 지키는 Orca 동작:
//   · `delayDuration=0` — 들어가면 바로 뜨고 떠나면 바로 닫힌다 · `disableHoverableContent` + `pointer-events-none` — 툴팁은 포인터를 받지 않는다
//   · `side="bottom" sideOffset=6`(activity-bar-buttons.tsx) — 단추 아래 가운데, 창 가장자리에서는 창 안으로 민다(Radix collision). 아래 자리가 없으면 위로 뒤집는다
//   · 누르면 닫힌다(Radix Trigger `onPointerDown`) — 클릭으로 보기를 바꾸거나 패널을 닫은 뒤 툴팁이 남지 않는다. 다시 보려면 나갔다 들어온다
//   · 키보드 포커스(`:focus-visible`)로 열리고 blur 로 닫힌다 · 한 번에 하나만 보인다
// corral 이 더하는 것: 창 blur·스크롤·resize·키 입력에 닫힌다(⌘L 로 패널이 닫혀 단추가 숨으면 mouseleave 가 오지 않는다).
// 패널(`overflow:hidden`)·머리 드래그 줄에 잘리지 않게 body 로 portal 한다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type TooltipTriggerProps = {
  ref: (element: HTMLElement | null) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onMouseDown: () => void
  onFocus: (event: React.FocusEvent<HTMLElement>) => void
  onBlur: () => void
  'aria-describedby': string | undefined
}

const SIDE_OFFSET = 6
const MARGIN = 8

let nextId = 0
/** 지금 열린 툴팁을 닫는 함수 — 다른 툴팁이 열리면 먼저 닫는다(한 번에 하나). */
let closeOpen: (() => void) | null = null

function focusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return false
  }
}

export function Tooltip({ label, render }: { label: string; render: (trigger: TooltipTriggerProps) => React.JSX.Element }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; arrow: number; side: 'bottom' | 'top' } | null>(null)
  const [id] = useState(() => `tooltip-${++nextId}`)
  const triggerRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback((): void => setOpen(false), [])
  const show = (): void => {
    if (closeOpen !== close) closeOpen?.()
    closeOpen = close
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onScroll = (): void => close()
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', close, true)
    return () => {
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [open, close])
  useEffect(() => () => {
    if (closeOpen === close) closeOpen = null
  }, [close])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const trigger = triggerRef.current
    const tip = tipRef.current
    if (trigger === null || tip === null) return
    const anchor = trigger.getBoundingClientRect()
    const box = tip.getBoundingClientRect()
    const center = anchor.left + anchor.width / 2
    const left = Math.max(MARGIN, Math.min(center - box.width / 2, window.innerWidth - box.width - MARGIN))
    const below = anchor.bottom + SIDE_OFFSET
    const side = below + box.height + MARGIN <= window.innerHeight || anchor.top - SIDE_OFFSET - box.height < MARGIN ? 'bottom' : 'top'
    const top = side === 'bottom' ? below : anchor.top - SIDE_OFFSET - box.height
    // 화살표는 툴팁을 밀어도 단추 가운데를 가리킨다.
    const arrow = Math.max(MARGIN, Math.min(center - left, box.width - MARGIN))
    setPosition((prev) => (prev !== null && prev.left === left && prev.top === top && prev.arrow === arrow && prev.side === side ? prev : { left, top, arrow, side }))
  })

  const trigger: TooltipTriggerProps = {
    ref: (element) => {
      triggerRef.current = element
    },
    onMouseEnter: show,
    onMouseLeave: close,
    onMouseDown: close,
    onFocus: (event) => {
      if (focusVisible(event.currentTarget)) show()
    },
    onBlur: close,
    'aria-describedby': open ? id : undefined,
  }

  return (
    <>
      {render(trigger)}
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              className="tooltip"
              data-tooltip=""
              data-side={position?.side ?? 'bottom'}
              role="tooltip"
              style={position === null ? { visibility: 'hidden', left: 0, top: 0 } : { left: position.left, top: position.top }}
            >
              {label}
              <span className="tooltip-arrow" aria-hidden style={position === null ? undefined : { left: position.arrow }} />
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
