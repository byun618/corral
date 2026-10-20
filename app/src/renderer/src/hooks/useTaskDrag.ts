// 작업 카드·행 끌기 (LIFE-601 C7) — LIFE-469 사이드바 끌기(`useSidebarReorder`)와 같은 결의 자체 마우스 구현.
//
// - 라이브러리를 들이지 않는다: 앱의 탭·사이드바 끌기가 이미 자체 구현이고(00-analysis F13), 핸드오프 §5 가 그 방식(반투명 사본·밀림·삽입선)을 지정한다.
//   CSP·설치본 크기 변화도 없다.
// - 포인터 캡처를 쓰지 않는다 — 문서에 mousemove/mouseup 을 거는 것은 끄는 동안만이고, 시작은 작업 페이지 안 `[data-drag-item]` 에서만이라
//   탭·사이드바 끌기와 한 문서에서 다투지 않는다(작업 페이지가 열려 있으면 워크스페이스는 inert).
// - 시작 문턱 4px(`REORDER_DRAG_THRESHOLD_PX`) · 문턱 미만은 클릭 · 문턱을 넘긴 뒤의 click 하나는 삼킨다 · Esc·창 blur·놓을 곳 밖 = 취소.
//   `active` 가 꺼지면(페이지 닫힘·위층이 열림) 끄는 중이라도 취소한다 — 그 뒤 mouseup 은 쓰기를 보내지 않는다(R2-K). `scope`(스페이스)가 바뀌어도 취소.
// - 놓기는 **mouseup 좌표**로 다시 판정한다(R3-F) — 창 밖이거나 그 자리에 놓을 칸이 없으면 취소(마지막 mousemove 칸에 쓰지 않는다).
// - 놓일 자리 = 그 영역(`[data-drop-zone]`) 안 끄는 항목을 뺀 항목들의 중점 기준 번호. 화면은 그 번호에 사본 높이만큼 틈을 그려 밀어낸다.

import { useCallback, useEffect, useRef, useState } from 'react'
import { hasCrossedReorderThreshold, type Point } from '../sidebar-reorder.js'

export type TaskDragState = { itemId: string; zone: string | null; index: number; height: number }
export type TaskDrop = { itemId: string; zone: string; index: number }

const NON_HANDLE = 'button, a, input, textarea, select, [data-no-drag]'

function zoneAt(point: Point): HTMLElement | null {
  const hit = document.elementFromPoint(point.x, point.y)
  return hit instanceof Element ? hit.closest<HTMLElement>('[data-drop-zone]') : null
}

/** 영역 안 놓일 번호 — 끄는 항목·틈을 빼고 중점이 포인터 위인 항목 수. */
function indexIn({ zone, itemId, y }: { zone: HTMLElement; itemId: string; y: number }): number {
  const items = [...zone.querySelectorAll<HTMLElement>('[data-drag-item]')].filter((element) => element.dataset.dragItem !== itemId && element.closest('[data-drop-zone]') === zone)
  return items.filter((element) => {
    const rect = element.getBoundingClientRect()
    return rect.top + rect.height / 2 < y
  }).length
}

export function useTaskDrag({ rootRef, active, scope, onStart, onDrop, onEnd }: {
  rootRef: React.RefObject<HTMLElement | null>
  /** 끌기를 받을 수 있나 — 꺼지는 순간 진행 중 끌기를 취소한다(R2-K). */
  active: boolean
  /** 끄는 맥락(스페이스) — 바뀌면 진행 중 끌기를 취소한다(옛 맥락의 칸에 쓰지 않게). */
  scope: string
  onStart: (itemId: string) => void
  onDrop: (drop: TaskDrop) => void
  onEnd: () => void
}) {
  const [drag, setDrag] = useState<TaskDragState | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const latest = useRef({ onStart, onDrop, onEnd })
  latest.current = { onStart, onDrop, onEnd }
  const session = useRef<{ teardown: () => void; cancel: () => void } | null>(null)

  useEffect(() => () => session.current?.teardown(), [])
  useEffect(() => { if (!active) session.current?.cancel() }, [active])
  useEffect(() => () => session.current?.cancel(), [scope])

  const onMouseDown = useCallback((itemId: string, event: React.MouseEvent<HTMLElement>, blocked: string | null) => {
    if (event.button !== 0 || session.current !== null || !activeRef.current) return
    if (event.target instanceof Element && event.target.closest(NON_HANDLE) !== null) return
    const source = event.currentTarget.closest<HTMLElement>('[data-drag-item]') ?? event.currentTarget
    const start: Point = { x: event.clientX, y: event.clientY }
    let started = false
    let preview: HTMLElement | null = null
    let offset: Point = { x: 0, y: 0 }
    let current: TaskDragState | null = null

    const set = (next: TaskDragState | null): void => {
      current = next
      setDrag(next)
    }
    const begin = (point: Point): void => {
      started = true
      const rect = source.getBoundingClientRect()
      offset = { x: point.x - rect.left, y: point.y - rect.top }
      // 반투명 사본 — 작업 페이지 안에 붙여 페이지 범위 CSS 를 그대로 받는다(LIFE-469 와 같은 결).
      const clone = source.cloneNode(true)
      if (clone instanceof HTMLElement) {
        clone.classList.add('tasks-drag-preview')
        clone.removeAttribute('data-drag-item')
        clone.removeAttribute('data-issue-card')
        clone.removeAttribute('data-issue-row')
        clone.style.width = `${rect.width}px`
        clone.style.height = `${rect.height}px`
        clone.style.left = `${point.x - offset.x}px`
        clone.style.top = `${point.y - offset.y}px`
        ;(rootRef.current ?? document.body).appendChild(clone)
        preview = clone
      }
      set({ itemId, zone: null, index: 0, height: rect.height })
      latest.current.onStart(itemId)
    }
    const move = (point: Point): void => {
      if (preview !== null) {
        preview.style.left = `${point.x - offset.x}px`
        preview.style.top = `${point.y - offset.y}px`
      }
      const zone = zoneAt(point)
      const zoneId = zone?.dataset.dropZone ?? null
      const index = zone === null ? 0 : indexIn({ zone, itemId, y: point.y })
      if (current !== null && (current.zone !== zoneId || current.index !== index)) set({ ...current, zone: zoneId, index })
    }
    const finish = (commit: boolean): void => {
      teardown()
      if (!started) return
      // 문턱을 넘긴 끌기 뒤의 click 하나는 삼킨다 — 놓은 자리의 카드 선택이 또 불리지 않게.
      const swallow = (click: MouseEvent): void => { click.stopPropagation(); click.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      const last = current
      set(null)
      latest.current.onEnd()
      if (commit && last !== null && last.zone !== null) latest.current.onDrop({ itemId, zone: last.zone, index: last.index })
    }
    const onMove = (moveEvent: MouseEvent): void => {
      const point = { x: moveEvent.clientX, y: moveEvent.clientY }
      if (!started) {
        if (!hasCrossedReorderThreshold({ start, current: point })) return
        if (blocked !== null) return
        begin(point)
      }
      moveEvent.preventDefault()
      move(point)
    }
    const onUp = (upEvent: MouseEvent): void => {
      const point = { x: upEvent.clientX, y: upEvent.clientY }
      const inside = point.x >= 0 && point.y >= 0 && point.x <= window.innerWidth && point.y <= window.innerHeight
      if (!started || !inside) { finish(false); return }
      move(point)
      finish(current !== null && current.zone !== null)
    }
    const onKey = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape' || !started) return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      finish(false)
    }
    const onBlur = (): void => finish(false)
    const teardown = (): void => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      preview?.remove()
      preview = null
      session.current = null
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    session.current = { teardown, cancel: () => finish(false) }
    // 글자 선택 시작을 막는다(LIFE-469 C4).
    event.preventDefault()
  }, [rootRef])

  return { drag, onMouseDown }
}
