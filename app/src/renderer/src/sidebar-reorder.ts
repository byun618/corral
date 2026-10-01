// 사이드바 끌어 옮기기 판정 (LIFE-469) — 순수 함수. `useSidebarReorder` 가 잰 사각형을 넘기면 여기서 계산만 한다
// (tab-drag.ts 와 같은 결). 좌표는 전부 **목록 스크롤 내용 기준 y**(clientY − 목록 top + scrollTop)다.
//
// 값의 출처 — Orca 1.4.198:
//   · 시작 임계 4px (`project-header-drag-contract.ts:46`, 카드 `SIDEBAR_POINTER_DRAG_THRESHOLD_PX`)
//   · 경계 밖 8px 여유 · 끝 슬롯 56px (`worktree-sidebar-drag-autoscroll.ts` `getWorktreeSidebarBoundaryDrop`)
//   · 자동 스크롤 가장자리 56px · 최대 960px/s · 한 프레임 최대 32ms · 바깥 48px 까지 (같은 파일)
//   · 헤더 띠 위면 헤더 중점으로, 구획 본문 위면 가까운 경계로(`worktree-sidebar-header-drop-preview.ts`, #8879 수정 — C5)

export const REORDER_DRAG_THRESHOLD_PX = 4
const DROP_BOUNDS_PADDING_PX = 8
export const EDGE_ZONE_PX = 56
const MAX_OUTSIDE_EDGE_PX = 48
const MAX_SCROLL_SPEED_PX_PER_SECOND = 960
const MAX_FRAME_MS = 32

export type Point = { x: number; y: number }

export function hasCrossedReorderThreshold(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= REORDER_DRAG_THRESHOLD_PX
}

/** 레포 묶음 하나 — `top`=묶음 윗변, `headerBottom`=헤더 아랫변, `bottom`=묶음 아랫변. */
export type RepoSlotRect = { top: number; headerBottom: number; bottom: number }
/** 카드 하나 — 카드 행 윗변·아랫변. */
export type ItemRect = { top: number; bottom: number }

export type DropSlot = { slot: number; indicatorY: number }

/** 경계 `slot` 의 표시 줄 y — 두 항목 사이 틈 가운데. 맨 앞·맨 뒤는 바깥쪽으로 2px. */
function boundaryY(rects: readonly ItemRect[], slot: number): number {
  const prev = rects[slot - 1]
  const next = rects[slot]
  if (prev !== undefined && next !== undefined) return (prev.bottom + next.top) / 2
  if (next !== undefined) return next.top
  return prev !== undefined ? prev.bottom : 0
}

/** 목록 위·아래 바깥 판정 (198 `getWorktreeSidebarBoundaryDrop`) — 끝 슬롯 56px 안이면 그 끝, 더 멀면 바깥(=취소). */
function edgeSlot(rects: readonly ItemRect[], y: number): DropSlot | 'outside' | 'inside' {
  const first = rects[0]
  const last = rects[rects.length - 1]
  if (first === undefined || last === undefined) return 'outside'
  if (y < first.top - DROP_BOUNDS_PADDING_PX) {
    return y >= first.top - EDGE_ZONE_PX ? { slot: 0, indicatorY: boundaryY(rects, 0) } : 'outside'
  }
  if (y > last.bottom + DROP_BOUNDS_PADDING_PX) {
    return y <= last.bottom + EDGE_ZONE_PX ? { slot: rects.length, indicatorY: boundaryY(rects, rects.length) } : 'outside'
  }
  return 'inside'
}

/**
 * 레포 헤더를 끄는 중 — 놓일 경계. 헤더 띠 위면 헤더 중점 기준 위/아래, 펼친 구획의 카드 위면 **가까운 경계**(C5:
 * 카드 영역 위에서도 표시가 사라지지 않는다). 목록에서 멀리 벗어나면 `null`(놓으면 취소).
 */
export function resolveRepoDropSlot(input: { rects: readonly RepoSlotRect[]; y: number }): DropSlot | null {
  const { rects, y } = input
  const edge = edgeSlot(rects, y)
  if (edge === 'outside') return null
  if (edge !== 'inside') return edge
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]
    if (rect === undefined || y < rect.top || y > rect.bottom) continue
    const pivot = y <= rect.headerBottom ? (rect.top + rect.headerBottom) / 2 : (rect.top + rect.bottom) / 2
    const slot = y < pivot ? index : index + 1
    return { slot, indicatorY: boundaryY(rects, slot) }
  }
  // 묶음 사이 틈 — 아래쪽 묶음의 윗경계.
  const slot = rects.findIndex((rect) => y < rect.top)
  const resolved = slot < 0 ? rects.length : slot
  return { slot: resolved, indicatorY: boundaryY(rects, resolved) }
}

/**
 * 카드를 끄는 중 — 같은 레포 **연결 워크트리** 사이 경계. `groupRange` 는 그 레포 묶음의 위·아래(다른 레포 위 = 취소,
 * K2ⓓ). 주 체크아웃은 `rects` 에 없으므로 맨 앞 경계(0)가 곧 「주 체크아웃 바로 아래」다 — 그 위로는 놓을 수 없다(K2ⓑ).
 */
export function resolveCardDropSlot(input: { rects: readonly ItemRect[]; groupRange: ItemRect; y: number }): DropSlot | null {
  const { rects, groupRange, y } = input
  if (y < groupRange.top || y > groupRange.bottom) return null
  const edge = edgeSlot(rects, y)
  if (edge === 'outside') return null
  if (edge !== 'inside') return edge
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]
    if (rect === undefined || y > rect.bottom + DROP_BOUNDS_PADDING_PX) continue
    const slot = y < (rect.top + rect.bottom) / 2 ? index : index + 1
    return { slot, indicatorY: boundaryY(rects, slot) }
  }
  return { slot: rects.length, indicatorY: boundaryY(rects, rects.length) }
}

/** 가장자리 자동 스크롤 (198 `getWorktreeSidebarDragAutoscroll`) — 다음 scrollTop, 움직일 게 없으면 `null`. */
export function nextAutoscrollTop(input: {
  point: Point
  containerRect: { left: number; right: number; top: number; bottom: number }
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  elapsedMs: number
}): number | null {
  const { point, containerRect } = input
  if (point.x < containerRect.left || point.x > containerRect.right) return null
  const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight)
  if (maxScrollTop <= 0) return null
  const elapsedMs = Math.max(0, Math.min(MAX_FRAME_MS, input.elapsedMs))
  if (elapsedMs <= 0) return null
  if (point.y < containerRect.top - MAX_OUTSIDE_EDGE_PX || point.y > containerRect.bottom + MAX_OUTSIDE_EDGE_PX) return null
  let direction: -1 | 1
  let intensity: number
  if (point.y <= containerRect.top + EDGE_ZONE_PX) {
    direction = -1
    intensity = Math.min(1, (containerRect.top + EDGE_ZONE_PX - point.y) / EDGE_ZONE_PX)
  } else if (point.y >= containerRect.bottom - EDGE_ZONE_PX) {
    direction = 1
    intensity = Math.min(1, (point.y - (containerRect.bottom - EDGE_ZONE_PX)) / EDGE_ZONE_PX)
  } else {
    return null
  }
  const scrollTop = Math.max(0, Math.min(maxScrollTop, input.scrollTop))
  const next = Math.max(0, Math.min(maxScrollTop, scrollTop + direction * intensity * MAX_SCROLL_SPEED_PX_PER_SECOND * (elapsedMs / 1000)))
  return next === scrollTop ? null : next
}
