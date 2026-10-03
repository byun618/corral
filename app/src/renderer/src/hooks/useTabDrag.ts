// 탭 드래그 컨트롤러 (LIFE-387 A1 · design-handoff.md §2 TabDrag/DropZoneOverlay).
//
// 판정은 `tab-drag.ts` 의 순수 함수가 다 한다 — 여기서는 실제 DOM(포인터 이벤트·사각형 실측)만
// 다룬다. `PaneGrid.beginDrag` 와 같은 결: 고스트만 그리고 **mouseup 에 1회 커밋**한다.

import { useCallback, useRef, useState } from 'react'
import {
  hasCrossedDragThreshold,
  isWithinTabbarGrace,
  resolveBodyDropTarget,
  resolveBodyZone,
  resolveTabbarIndex,
  type DropTarget,
  type Point,
} from '../tab-drag.js'

/** 오버레이가 그릴 것 — 판정(`DropTarget`)과 별개로 실측 사각형을 들고 있는다. */
export type TabDragVisual =
  | { kind: 'tabbar'; groupId: string; x: number; headerRect: DOMRect }
  | { kind: 'split'; groupId: string; zone: 'left' | 'right' | 'up' | 'down'; bodyRect: DOMRect }
  | { kind: 'merge'; groupId: string; bodyRect: DOMRect; empty: boolean }
  | { kind: 'invalid' | 'self-noop' }

export type TabDragState = {
  tabId: string
  fromGroupId: string
  point: Point
  target: DropTarget
  visual: TabDragVisual
}

export type TabDragApi = {
  /** 지금 드래그 중이면 고스트·오버레이가 그릴 상태. 6px 문턱 전엔 `null`(아직 클릭 취급). */
  dragState: TabDragState | null
  /** 탭의 `onMouseDown` 에 붙인다 — 왼쪽 버튼만 반응, `preventDefault` 는 안 한다(포커스 유지). */
  onArm: (event: React.MouseEvent, input: { tabId: string; fromGroupId: string }) => void
  /**
   * 드래그가 문턱을 넘겼다가 끝난 직후의 **다음 클릭 하나**를 삼킨다 — mouseup 뒤에 오는
   * 네이티브 click 이 탭 활성화를 또 부르는 걸 막는다. 탭의 `onClick` 맨 앞에서 부른다.
   */
  consumeClick: () => boolean
}

/** 드래그 중인 탭 자신의 그룹 컨테이너(`[data-tab-group]`)를 찾아 헤더/본문 사각형을 잰다. */
function resolveDropTarget(input: {
  point: Point
  fromGroupId: string
  ownTabCountOf: (groupId: string) => number
}): { target: DropTarget; visual: TabDragVisual } {
  const invalid = { target: { kind: 'invalid' as const }, visual: { kind: 'invalid' as const } }
  const container = document
    .elementsFromPoint(input.point.x, input.point.y)
    .map((element) => element.closest('[data-tab-group]'))
    .find((element): element is HTMLElement => element instanceof HTMLElement)
  if (container === undefined) return invalid
  const groupId = container.getAttribute('data-tab-group')
  if (groupId === null) return invalid

  const headerEl = container.querySelector('[data-group-header]')
  const headerRect = headerEl?.getBoundingClientRect()
  if (headerRect !== undefined && isWithinTabbarGrace({ headerRect, point: input.point })) {
    const centers = [...container.querySelectorAll('[data-main-tab]')].map((tabEl) => {
      const rect = tabEl.getBoundingClientRect()
      return rect.left + rect.width / 2
    })
    const index = resolveTabbarIndex(centers, input.point.x)
    return { target: { kind: 'tabbar', groupId, index }, visual: { kind: 'tabbar', groupId, x: input.point.x, headerRect } }
  }

  const bodyEl = container.querySelector('[data-term-group], [data-empty-group]')
  if (bodyEl === null) return invalid
  const bodyRect = bodyEl.getBoundingClientRect()
  const targetIsEmpty = bodyEl.matches('[data-empty-group]')
  const zone = resolveBodyZone({ bodyRect, point: input.point })
  const target = resolveBodyDropTarget({
    zone,
    targetGroupId: groupId,
    fromGroupId: input.fromGroupId,
    ownTabCount: input.ownTabCountOf(input.fromGroupId),
    targetIsEmpty,
  })
  const visual: TabDragVisual =
    target.kind === 'split' && zone !== 'center'
      ? { kind: 'split', groupId, zone, bodyRect }
      : target.kind === 'merge'
        ? { kind: 'merge', groupId, bodyRect, empty: targetIsEmpty }
        : { kind: target.kind === 'invalid' || target.kind === 'self-noop' ? target.kind : 'invalid' }
  return { target, visual }
}

export function useTabDrag(input: {
  ownTabCountOf: (groupId: string) => number
  onDrop: (input: { tabId: string; fromGroupId: string; target: DropTarget }) => void
}): TabDragApi {
  const [dragState, setDragState] = useState<TabDragState | null>(null)
  const consumeClickRef = useRef(false)
  const inputRef = useRef(input)
  inputRef.current = input

  const onArm = useCallback((event: React.MouseEvent, armInput: { tabId: string; fromGroupId: string }) => {
    if (event.button !== 0) return
    const start = { x: event.clientX, y: event.clientY }
    let dragging = false
    const stateRef: { current: TabDragState | null } = { current: null }

    const cleanup = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
      document.body.classList.remove('is-tab-drag')
      setDragState(null)
    }
    const finish = (commit: boolean): void => {
      cleanup()
      const last = stateRef.current
      if (commit && dragging && last !== null) {
        inputRef.current.onDrop({ tabId: armInput.tabId, fromGroupId: armInput.fromGroupId, target: last.target })
      }
      // 드롭이 원래 탭 밖(다른 영역·본문 가장자리)에서 끝나면 mouseup 뒤 click 이 그 탭에서
      // 아예 안 열려(공통 조상에서 뜬다) `consumeClick` 이 절대 안 불려 다음 진짜 클릭까지
      // 삼킨다 — 한 틱 뒤 스스로 내린다. 네이티브 click 은 mouseup 직후 **동기**로 뜨므로
      // 그 경로에서는 타이머가 돌기 전에 이미 정상 소비된다.
      if (dragging) {
        consumeClickRef.current = true
        window.setTimeout(() => {
          consumeClickRef.current = false
        }, 0)
      }
    }
    const resolveAt = (point: Point): void => {
      const { target, visual } = resolveDropTarget({ point, fromGroupId: armInput.fromGroupId, ownTabCountOf: inputRef.current.ownTabCountOf })
      const next: TabDragState = { tabId: armInput.tabId, fromGroupId: armInput.fromGroupId, point, target, visual }
      stateRef.current = next
      setDragState(next)
    }
    const onMove = (moveEvent: MouseEvent): void => {
      const point = { x: moveEvent.clientX, y: moveEvent.clientY }
      if (!dragging) {
        if (!hasCrossedDragThreshold(start, point)) return
        dragging = true
        // 동기로 붙여 바로 아래 첫 판정이 dock(sticky) 풀린 사각형을 읽게 한다(styles.css, r1 R1-01).
        document.body.classList.add('is-tab-drag')
      }
      resolveAt(point)
    }
    // 포인터가 멈춰 있어도 탭 스트립이 스크롤되면(chevron hover 자동 스크롤·휠) 탭 사각형이 움직인다 —
    // 마지막 포인터로 다시 판정해야 놓을 때 스크롤 뒤 위치로 커밋된다(r1 R1-02). scroll 은 버블링하지 않아 capture 로 받는다.
    const onScroll = (): void => {
      const last = stateRef.current
      if (dragging && last !== null) resolveAt(last.point)
    }
    const onUp = (): void => finish(true)
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') finish(false)
    }
    const onBlur = (): void => finish(false)

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
  }, [])

  const consumeClick = useCallback((): boolean => {
    if (!consumeClickRef.current) return false
    consumeClickRef.current = false
    return true
  }, [])

  return { dragState, onArm, consumeClick }
}
