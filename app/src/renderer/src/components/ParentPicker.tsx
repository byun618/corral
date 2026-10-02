// 상위 워크트리 피커 (LIFE-478 K6ⓐ) — 198 `WorktreeParentPickerPopover.tsx`: 카드 오른쪽 팝오버(w-80), 「Set parent for X」,
// 검색 입력 + 목록(상태 · 이름 · Current · 브랜치), ↑ ↓ Home End Enter, 빈 결과 문구. 후보 규칙은 `card-menu.ts parentCandidates`.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorktreeRow } from '../../../shared/types.js'
import { filterCandidates } from '../card-menu.js'
import { useMenuBus, useWindowEscape } from '../menu-bus.js'
import { worktreeDisplayName } from '../worktree-name.js'

const WIDTH = 320
const MARGIN = 8

export function ParentPicker({
  child,
  candidates,
  anchor,
  activePath,
  onPick,
  onClose,
}: {
  child: WorktreeRow
  candidates: readonly WorktreeRow[]
  /** 카드 사각형 — 오른쪽에 붙는다(자리가 없으면 왼쪽). */
  anchor: { left: number; right: number; top: number }
  /** 지금 활성 워크트리 — 「현재」 칩. */
  activePath: string | null
  onPick: (parent: WorktreeRow) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [top, setTop] = useState(anchor.top)
  useMenuBus({ open: true, close: onClose })
  // Esc 는 포커스와 무관하게(r2 R2B-01) — 안쪽 빈 곳을 눌러 포커스가 body 로 가도 닫힌다.
  useWindowEscape({ onEscape: onClose })
  const rows = filterCandidates({ candidates, query, nameOf: worktreeDisplayName })
  const left = anchor.right + MARGIN + WIDTH <= window.innerWidth ? anchor.right + MARGIN : Math.max(MARGIN, anchor.left - MARGIN - WIDTH)

  useLayoutEffect(() => {
    const height = rootRef.current?.getBoundingClientRect().height ?? 0
    setTop(Math.max(MARGIN, Math.min(anchor.top, window.innerHeight - height - MARGIN)))
  }, [anchor.top, rows.length])
  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setActive(0), [query])
  // 강조 행이 보이는 영역 밖이면 그만큼만 스크롤(r2 R2B-03) — Enter 가 안 보이는 행을 지정하지 않게. 포커스는 검색 입력에 둔다.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target) !== true) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    const last = rows.length - 1
    switch (event.key) {
      case 'ArrowDown':
        setActive((value) => (rows.length === 0 ? 0 : value >= last ? 0 : value + 1))
        break
      case 'ArrowUp':
        setActive((value) => (rows.length === 0 ? 0 : value <= 0 ? last : value - 1))
        break
      case 'Home':
        setActive(0)
        break
      case 'End':
        setActive(Math.max(0, last))
        break
      case 'Enter': {
        const row = rows[active]
        if (row !== undefined) onPick(row)
        break
      }
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div
      ref={rootRef}
      className="parent-picker"
      data-card-dialog=""
      data-parent-picker={child.path}
      style={{ left, top, width: WIDTH }}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="parent-picker-head">
        상위 지정 — <span className="confirm-name">{worktreeDisplayName(child)}</span>
      </div>
      <input
        ref={inputRef}
        className="field-input parent-picker-input"
        data-parent-picker-search=""
        placeholder="워크트리 검색…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div ref={listRef} className="parent-picker-list" role="listbox">
        {rows.length === 0 ? (
          <div className="parent-picker-empty" data-parent-picker-empty="">
            지정할 수 있는 워크트리가 없습니다
          </div>
        ) : (
          rows.map((row, index) => (
            <div
              key={row.path}
              role="option"
              aria-selected={index === active}
              className={`parent-picker-row ${index === active ? 'is-active' : ''}`}
              data-parent-candidate={row.path}
              onMouseMove={() => setActive(index)}
              onClick={() => onPick(row)}
            >
              <span className="parent-picker-name">{worktreeDisplayName(row)}</span>
              {row.path === activePath ? <span className="worktree-chip">현재</span> : null}
              {!row.isLinked ? <span className="worktree-chip">기본</span> : null}
              {row.branch !== null && row.branch !== worktreeDisplayName(row) ? <span className="parent-picker-branch">{row.branch}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
