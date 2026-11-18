// 우클릭·버튼 메뉴 공용 부품 (LIFE-478 K2) — 198 `WorktreeContextMenuView.tsx`(Radix DropdownMenu, modal=false, 포인터 위치 1px 트리거).
//
// 메뉴 라이브러리가 없어 직접 만든다. 지키는 것:
//   · 포인터 위치에 열리고 창 안으로 민다(4px 여백 — `TabContextMenu` 와 같은 clamp)
//   · ↑↓ Home End 이동(끝에서 감김) · Enter/Space 선택 · → 서브메뉴 열기 · ← 서브메뉴 닫기 · Esc 전부 닫기 · Tab 닫기
//   · 바깥 mousedown · 창 blur · 스크롤 · resize · 다른 메뉴 열림(`menu-bus`)에 닫힌다
//   · **강조는 포커스가 아니라 상태다** — hover(pointer move)와 키보드가 같은 `active` 를 움직인다. Orca #14545(다른 앱이 포커스일 때
//     우클릭하면 Chromium 이 비포커스 창의 focus 이벤트를 멈춰 Radix 강조·키보드 대상이 없다)를 따라 하지 않는다. 키 입력은 창이
//     앞에 와야 들어오므로 여는 쪽이 `window.corral.activateWindow()` 를 같이 부른다(198 뒤 수정 PR #14546 방향).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMenuBus } from '../menu-bus.js'

export type MenuEntry<A extends string> =
  | {
      kind: 'item'
      action: A
      label: string
      disabled?: boolean
      /** disabled 사유 등 — 네이티브 툴팁. */
      title?: string
      danger?: boolean
      shortcut?: string | null
      submenu?: MenuEntry<A>[]
    }
  | { kind: 'sep'; key: string }
  | { kind: 'label'; key: string; label: string }

const MARGIN = 4

type Selectable<A extends string> = Extract<MenuEntry<A>, { kind: 'item' }>
const isSelectable = <A extends string>(entry: MenuEntry<A>): entry is Selectable<A> => entry.kind === 'item' && entry.disabled !== true

export function ContextMenu<A extends string>({
  x,
  y,
  entries,
  onAction,
  onClose,
  attrs,
  className = '',
  above = false,
  toggleSelector,
}: {
  /** 메뉴를 여닫는 단추 — 그 위 mousedown 은 바깥 닫기에서 빼고 단추의 click 토글에 맡긴다(닫고 곧바로 다시 여는 것을 막는다). */
  toggleSelector?: string
  /** 점 위로 연다(하단 바 ? 메뉴 — 198 `side="top"`). */
  above?: boolean
  x: number
  y: number
  entries: MenuEntry<A>[]
  onAction: (action: A) => void
  onClose: () => void
  /** 루트에 붙일 `data-*` — 하네스·막는 층 선택자. */
  attrs?: Record<string, string>
  className?: string
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const subRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const [active, setActive] = useState<number | null>(null)
  /** 열린 서브메뉴의 부모 항목 index · 서브메뉴 안 강조 index(null = 부모에 머묾). */
  const [subOpen, setSubOpen] = useState<number | null>(null)
  const [subActive, setSubActive] = useState<number | null>(null)
  const [subPosition, setSubPosition] = useState<{ left: number; top: number } | null>(null)
  const close = useCallback(() => onClose(), [onClose])
  useMenuBus({ open: true, close })

  useLayoutEffect(() => {
    const element = rootRef.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - rect.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(above ? y - rect.height : y, window.innerHeight - rect.height - MARGIN)),
    })
  }, [x, y, above])

  // 서브메뉴 — 부모 항목 오른쪽, 자리가 없으면 왼쪽으로 뒤집고 위아래는 화면 안으로.
  useLayoutEffect(() => {
    if (subOpen === null) {
      setSubPosition(null)
      return
    }
    const parent = rootRef.current?.querySelector<HTMLElement>(`[data-menu-index="${subOpen}"]`)
    const sub = subRef.current
    if (parent === null || parent === undefined || sub === null) return
    const anchor = parent.getBoundingClientRect()
    const size = sub.getBoundingClientRect()
    const right = anchor.right + 2
    const left = right + size.width + MARGIN > window.innerWidth ? anchor.left - size.width - 2 : right
    setSubPosition({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, Math.min(anchor.top - 4, window.innerHeight - size.height - MARGIN)) })
  }, [subOpen, position])

  const select = useCallback(
    (entry: Selectable<A>, index: number): void => {
      if (entry.submenu !== undefined) {
        setSubOpen(index)
        setSubActive(entry.submenu.findIndex(isSelectable))
        return
      }
      onClose()
      onAction(entry.action)
    },
    [onAction, onClose],
  )

  // 키보드 — window capture 라 터미널·단축키 처리기보다 먼저 받는다. 메뉴가 열려 있는 동안 키는 메뉴의 것이다.
  const latest = useRef({ entries, active, subOpen, subActive, select })
  latest.current = { entries, active, subOpen, subActive, select }
  useEffect(() => {
    const step = (list: MenuEntry<A>[], from: number | null, delta: 1 | -1): number | null => {
      const indices = list.flatMap((entry, index) => (isSelectable(entry) ? [index] : []))
      if (indices.length === 0) return null
      if (from === null) return delta === 1 ? indices[0]! : indices[indices.length - 1]!
      const at = indices.indexOf(from)
      return indices[(at + delta + indices.length) % indices.length]!
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const { entries: list, active: current, subOpen: sub, subActive: subCurrent, select: choose } = latest.current
      const subList = sub === null ? null : (() => {
        const parent = list[sub]
        return parent?.kind === 'item' ? (parent.submenu ?? null) : null
      })()
      const inSub = subList !== null && subCurrent !== null
      let handled = true
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          const delta = event.key === 'ArrowDown' ? 1 : -1
          if (inSub) setSubActive(step(subList, subCurrent, delta))
          else {
            setSubOpen(null)
            setActive(step(list, current, delta))
          }
          break
        }
        case 'Home':
        case 'End': {
          const delta = event.key === 'Home' ? 1 : -1
          if (inSub) setSubActive(step(subList, null, delta))
          else setActive(step(list, null, delta))
          break
        }
        case 'ArrowRight': {
          const entry = current === null ? undefined : list[current]
          if (!inSub && entry !== undefined && isSelectable(entry) && entry.submenu !== undefined) choose(entry, current!)
          break
        }
        case 'ArrowLeft':
          if (sub !== null) {
            setSubOpen(null)
            setSubActive(null)
            setActive(sub)
          }
          break
        case 'Enter':
        case ' ': {
          if (inSub) {
            const entry = subList[subCurrent]
            if (entry !== undefined && isSelectable(entry)) choose(entry, subCurrent)
          } else {
            const entry = current === null ? undefined : list[current]
            if (entry !== undefined && isSelectable(entry)) choose(entry, current!)
          }
          break
        }
        case 'Escape':
        case 'Tab':
          onClose()
          break
        default:
          handled = false
      }
      if (!handled) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 닫힘 — 바깥 mousedown(우클릭 포함) · 창 blur · 스크롤 · resize.
  useEffect(() => {
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && (rootRef.current?.contains(target) === true || subRef.current?.contains(target) === true)
    const onDown = (event: MouseEvent): void => {
      if (toggleSelector !== undefined && event.target instanceof Element && event.target.closest(toggleSelector) !== null) return
      if (!inside(event.target)) onClose()
    }
    const onScroll = (event: Event): void => {
      if (!inside(event.target)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, toggleSelector])

  const renderEntries = (list: MenuEntry<A>[], level: 'root' | 'sub'): React.JSX.Element[] =>
    list.map((entry, index) => {
      switch (entry.kind) {
        case 'sep':
          return <div key={entry.key} className="repo-row-menu-sep" role="separator" />
        case 'label':
          return (
            <div key={entry.key} className="ctx-menu-label" data-menu-label="">
              {entry.label}
            </div>
          )
        case 'item': {
          const isActive = level === 'root' ? active === index : subActive === index
          const disabled = entry.disabled === true
          return (
            <div
              key={entry.action}
              role="menuitem"
              aria-disabled={disabled || undefined}
              aria-haspopup={entry.submenu === undefined ? undefined : 'menu'}
              title={entry.title}
              data-menu-action={entry.action}
              data-menu-index={level === 'root' ? index : undefined}
              data-menu-active={isActive ? '' : undefined}
              className={`repo-row-menu-item ctx-menu-item ${isActive ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''} ${entry.danger === true ? 'repo-row-menu-danger' : ''}`}
              onMouseMove={() => {
                if (level === 'root') {
                  if (active !== index) setActive(disabled ? null : index)
                  if (entry.submenu !== undefined && !disabled) {
                    if (subOpen !== index) {
                      setSubOpen(index)
                      setSubActive(null)
                    }
                  } else if (subOpen !== null) setSubOpen(null)
                } else if (subActive !== index) setSubActive(disabled ? null : index)
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                if (!disabled) select(entry, index)
              }}
            >
              <span className="ctx-menu-text">{entry.label}</span>
              {entry.shortcut ? <span className="ctx-menu-shortcut">{entry.shortcut}</span> : null}
              {entry.submenu !== undefined ? <span className="ctx-menu-chevron">›</span> : null}
            </div>
          )
        }
      }
    })

  const sub = subOpen === null ? null : entries[subOpen]
  return (
    <>
      <div
        ref={rootRef}
        className={`ctx-menu ${className}`}
        role="menu"
        data-context-menu=""
        {...attrs}
        style={{ left: position.left, top: position.top }}
        // LIFE-825 fix5 ⑧ — 메뉴 안 우클릭이 포털을 거쳐 연 탭의 onContextMenu 로 올라가지 않게(메뉴를 다시 열며 우클릭 토큰을 덮는다).
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {renderEntries(entries, 'root')}
      </div>
      {sub?.kind === 'item' && sub.submenu !== undefined ? (
        <div
          ref={subRef}
          className="ctx-menu ctx-submenu"
          role="menu"
          data-context-menu=""
          data-context-submenu={sub.action}
          style={subPosition === null ? { left: -9999, top: -9999 } : { left: subPosition.left, top: subPosition.top }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {renderEntries(sub.submenu, 'sub')}
        </div>
      ) : null}
    </>
  )
}
