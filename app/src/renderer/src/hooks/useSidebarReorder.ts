// 사이드바 끌어 옮기기 컨트롤러 (LIFE-469) — 레포 헤더·연결 워크트리 카드.
//
// 판정은 `sidebar-reorder.ts` 순수 함수가 한다 — 여기서는 DOM(마우스 이벤트·사각형 실측·자동 스크롤)만 다룬다.
// 198 사이드바도 dnd-kit 이 아니라 자체 pointer 구현이고(00-analysis F1), corral 탭 드래그(`useTabDrag`)도 같은 결이라
// 라이브러리를 들이지 않는다. 마우스 이벤트를 쓰는 이유: 헤더에서 `mousedown` 의 기본 동작(글자 선택 시작)을 막아야
// SVG 아이콘에서 끌어도 글자 선택이 생기지 않는다(C4).
//
// 취소 = `Escape`(헤더·카드 모두 — C3) · 창 blur · 목록 밖 놓기. 문턱을 넘긴 드래그 뒤의 click 하나는 삼킨다
// (198 `header-drag-click-swallow.ts` — 놓은 자리의 접기·카드 선택이 또 불리지 않게).

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  hasCrossedReorderThreshold,
  nextAutoscrollTop,
  resolveCardDropSlot,
  resolveRepoDropSlot,
  type DropSlot,
  type ItemRect,
  type Point,
  type RepoSlotRect,
} from '../sidebar-reorder.js'

export type ReorderSource = { kind: 'repo'; root: string } | { kind: 'card'; repoRoot: string; path: string }

export type ReorderState = { source: ReorderSource; indicatorY: number | null }

/** 놓기 — `keys` 는 놓는 순간 화면에 보이던 순서(끄는 항목 포함), `slot` 은 그 기준 경계 번호. */
export type ReorderCommit = { source: ReorderSource; keys: string[]; slot: number }

/** 헤더에서 드래그로 치지 않는 곳 — 셰브론·⋯·+ 버튼과 열린 메뉴(U14, 198 `REPO_HEADER_ACTION_SELECTOR`). */
const NON_HANDLE_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"], [data-repo-row-actions], .repo-row-menu'

function isHandleTarget(target: EventTarget | null): boolean {
  // `Element` 로 본다 — 폴더 아이콘은 <svg> 라 HTMLElement 가 아니다(198 #8575, C4).
  return target instanceof Element && target.closest(NON_HANDLE_SELECTOR) === null
}

function contentY(list: HTMLElement, clientY: number): number {
  return clientY - list.getBoundingClientRect().top + list.scrollTop
}

function rectOf(list: HTMLElement, element: Element): ItemRect {
  const listTop = list.getBoundingClientRect().top - list.scrollTop
  const rect = element.getBoundingClientRect()
  return { top: rect.top - listTop, bottom: rect.bottom - listTop }
}

function repoGroups(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(':scope > [data-repo]')]
}

function measureRepos(list: HTMLElement): { keys: string[]; rects: RepoSlotRect[] } {
  const keys: string[] = []
  const rects: RepoSlotRect[] = []
  for (const group of repoGroups(list)) {
    const root = group.getAttribute('data-repo')
    const head = group.querySelector('[data-repo-head]')
    if (root === null || head === null) continue
    const box = rectOf(list, group)
    keys.push(root)
    rects.push({ top: box.top, headerBottom: rectOf(list, head).bottom, bottom: box.bottom })
  }
  return { keys, rects }
}

function measureCards(list: HTMLElement, repoRoot: string): { keys: string[]; rects: ItemRect[]; groupRange: ItemRect } | null {
  const group = repoGroups(list).find((element) => element.getAttribute('data-repo') === repoRoot)
  if (group === undefined) return null
  const keys: string[] = []
  const rects: ItemRect[] = []
  for (const card of group.querySelectorAll<HTMLElement>('[data-reorder-card]')) {
    const path = card.getAttribute('data-reorder-card')
    if (path === null) continue
    keys.push(path)
    rects.push(rectOf(list, card))
  }
  return { keys, rects, groupRange: rectOf(list, group) }
}

function resolveSlot(list: HTMLElement, source: ReorderSource, point: Point): { slot: DropSlot | null; keys: string[] } {
  const listRect = list.getBoundingClientRect()
  // 목록 좌우 밖 = 목록 밖(놓으면 취소).
  const outsideX = point.x < listRect.left || point.x > listRect.right
  const y = contentY(list, point.y)
  if (source.kind === 'repo') {
    const { keys, rects } = measureRepos(list)
    return { slot: outsideX ? null : resolveRepoDropSlot({ rects, y }), keys }
  }
  const cards = measureCards(list, source.repoRoot)
  if (cards === null) return { slot: null, keys: [] }
  return { slot: outsideX ? null : resolveCardDropSlot({ rects: cards.rects, groupRange: cards.groupRange, y }), keys: cards.keys }
}

export function useSidebarReorder(input: { listRef: React.RefObject<HTMLDivElement | null>; onCommit: (commit: ReorderCommit) => void }): {
  state: ReorderState | null
  /** 레포 헤더(`.repo-row`)의 `onMouseDown`. 레포가 1개면 시작하지 않는다(198 — 헤더 2개 이상일 때만, K1ⓒ). */
  onRepoMouseDown: (event: React.MouseEvent, root: string) => void
  /** 연결 워크트리 카드의 `onMouseDown`. 주 체크아웃에는 붙이지 않는다(맨 위 고정, K2ⓑ). */
  onCardMouseDown: (event: React.MouseEvent, repoRoot: string, path: string) => void
} {
  const [state, setState] = useState<ReorderState | null>(null)
  const inputRef = useRef(input)
  inputRef.current = input
  /** 진행 중인 드래그의 정리 함수 — 언마운트 때도 부른다. */
  const abortRef = useRef<(() => void) | null>(null)

  useEffect(() => () => abortRef.current?.(), [])

  const arm = useCallback((event: React.MouseEvent, source: ReorderSource) => {
    const list = inputRef.current.listRef.current
    if (event.button !== 0 || list === null || abortRef.current !== null) return
    if (!isHandleTarget(event.target)) return
    if (source.kind === 'repo') {
      if (repoGroups(list).length < 2) return
      // 헤더는 누르는 순간 글자 선택 시작을 막는다(C4). click 은 그대로 온다 — 문턱 미만이면 접기로 처리된다.
      event.preventDefault()
    }
    const start = { x: event.clientX, y: event.clientY }
    let point = start
    let dragging = false
    let slot: DropSlot | null = null
    let keys: string[] = []
    let frame = 0
    let lastFrameAt = 0

    const update = (): void => {
      const resolved = resolveSlot(list, source, point)
      slot = resolved.slot
      keys = resolved.keys
      setState({ source, indicatorY: slot === null ? null : slot.indicatorY })
    }
    const tick = (now: number): void => {
      const elapsed = lastFrameAt === 0 ? 16 : now - lastFrameAt
      lastFrameAt = now
      const next = nextAutoscrollTop({
        point,
        containerRect: list.getBoundingClientRect(),
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        elapsedMs: elapsed,
      })
      if (next !== null) {
        list.scrollTop = next
        update()
      }
      frame = requestAnimationFrame(tick)
    }
    const cleanup = (): void => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
      if (frame !== 0) cancelAnimationFrame(frame)
      document.body.classList.remove('is-sidebar-reorder')
      abortRef.current = null
      setState(null)
    }
    const finish = (commit: boolean): void => {
      const wasDragging = dragging
      const finalSlot = slot
      const finalKeys = keys
      cleanup()
      if (!wasDragging) return
      swallowNextClick()
      if (commit && finalSlot !== null) inputRef.current.onCommit({ source, keys: finalKeys, slot: finalSlot.slot })
    }
    const onMove = (moveEvent: MouseEvent): void => {
      point = { x: moveEvent.clientX, y: moveEvent.clientY }
      if (!dragging) {
        if (!hasCrossedReorderThreshold(start, point)) return
        dragging = true
        document.body.classList.add('is-sidebar-reorder')
        // 카드는 mousedown 을 막지 않았으니 문턱 전에 생긴 선택을 지운다.
        window.getSelection()?.removeAllRanges()
        frame = requestAnimationFrame(tick)
      }
      update()
    }
    const onUp = (): void => finish(true)
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape') return
      if (dragging) {
        // 앱의 다른 Escape 처리(모달 닫기 등)로 흘리지 않는다 — 이 키는 드래그 취소에 쓰였다.
        keyEvent.preventDefault()
        keyEvent.stopPropagation()
      }
      finish(false)
    }
    const onBlur = (): void => finish(false)

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    abortRef.current = () => finish(false)
  }, [])

  const onRepoMouseDown = useCallback((event: React.MouseEvent, root: string) => arm(event, { kind: 'repo', root }), [arm])
  const onCardMouseDown = useCallback(
    (event: React.MouseEvent, repoRoot: string, path: string) => arm(event, { kind: 'card', repoRoot, path }),
    [arm],
  )

  return { state, onRepoMouseDown, onCardMouseDown }
}

/**
 * 드래그 직후의 click 하나를 삼킨다 — mouseup 뒤 click 이 헤더 접기·카드 선택을 또 부르지 않게(K3ⓐ).
 * 놓은 자리가 원래 요소 밖이면 click 이 안 올 수 있어 한 틱 뒤 스스로 내린다(네이티브 click 은 mouseup 직후 동기로 온다).
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    window.removeEventListener('click', swallow, true)
  }
  window.addEventListener('click', swallow, true)
  window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}
