// 사이드바 끌어 옮기기 판정 (LIFE-469) — 순수 함수. `useSidebarReorder` 가 잰 사각형을 넘기면 여기서 계산만 한다
// (tab-drag.ts 와 같은 결). 좌표는 전부 **목록 스크롤 내용 기준 y**(clientY − 목록 top + scrollTop)다.
//
// 값의 출처 — Orca 1.4.198:
//   · 시작 임계 4px (`project-header-drag-contract.ts:46`, 카드 `SIDEBAR_POINTER_DRAG_THRESHOLD_PX`)
//   · 경계 밖 8px 여유 · 끝 슬롯 56px (`worktree-sidebar-drag-autoscroll.ts` `getWorktreeSidebarBoundaryDrop`)
//   · 자동 스크롤 가장자리 56px · 최대 960px/s · 한 프레임 최대 32ms · 바깥 48px 까지 (같은 파일)
//   · 헤더 띠 위면 헤더 중점으로, 구획 본문 위면 가까운 경계로(`worktree-sidebar-header-drop-preview.ts`, #8879 수정 — C5)
//   · 행 밀림 미리 보기 = 바뀐 순서를 실측 높이·틈으로 다시 쌓은 자리 − 지금 자리, 0.5px 미만 무시, 끄는 항목 제외
//     (`worktree-drag-preview-offsets.ts` `buildWorktreeDragPreviewOffsets`). 표시 줄 = 끄는 항목이 들어갈 자리 윗변
//     (`worktree-sidebar-drop-preview.ts` `getWorktreeSidebarDropIndicatorY` — placeholderTop, 제자리면 끄는 항목 윗변)

export const REORDER_DRAG_THRESHOLD_PX = 4
const DROP_BOUNDS_PADDING_PX = 8
export const EDGE_ZONE_PX = 56
const MAX_OUTSIDE_EDGE_PX = 48
const MAX_SCROLL_SPEED_PX_PER_SECOND = 960
const MAX_FRAME_MS = 32

export type Point = { x: number; y: number }

export function hasCrossedReorderThreshold(input: { start: Point; current: Point }): boolean {
  const { start, current } = input
  return Math.hypot(current.x - start.x, current.y - start.y) >= REORDER_DRAG_THRESHOLD_PX
}

/**
 * 레포 묶음 하나 — `top`·`bottom`=묶음 윗변·아랫변, `headTop`·`headBottom`=헤더가 **지금 그려진** 윗변·아랫변.
 * 헤더는 묶음 안에서 sticky 라 스크롤되면 묶음 윗변과 떨어진다 — 둘을 따로 받아야 붙은 헤더의 중점이 맞는다(R1-05).
 */
export type RepoSlotRect = { top: number; bottom: number; headTop: number; headBottom: number }
/** 카드 하나 — 카드 행 윗변·아랫변. */
export type ItemRect = { top: number; bottom: number }

/** 목록 위·아래 바깥 판정 (198 `getWorktreeSidebarBoundaryDrop`) — 끝 슬롯 56px 안이면 그 끝, 더 멀면 바깥(=취소). */
function edgeSlot(rects: readonly ItemRect[], y: number): number | 'outside' | 'inside' {
  const first = rects[0]
  const last = rects[rects.length - 1]
  if (first === undefined || last === undefined) return 'outside'
  if (y < first.top - DROP_BOUNDS_PADDING_PX) return y >= first.top - EDGE_ZONE_PX ? 0 : 'outside'
  if (y > last.bottom + DROP_BOUNDS_PADDING_PX) return y <= last.bottom + EDGE_ZONE_PX ? rects.length : 'outside'
  return 'inside'
}

/**
 * 레포 헤더를 끄는 중 — 놓일 경계 번호(0 = 맨 앞). 헤더 위면 **헤더 실제 범위의 중점** 기준 위/아래(붙은 헤더 포함 —
 * R1-05), 펼친 구획의 카드 위면 **가까운 경계**(C5: 카드 영역 위에서도 표시가 사라지지 않는다). 목록에서 멀리 벗어나면
 * `null`(놓으면 취소). 사각형은 **밀리기 전** 자리여야 한다(K3ⓗⓒ — 밀린 자리로 재면 판정이 흔들린다).
 */
export function resolveRepoDropSlot(input: { rects: readonly RepoSlotRect[]; y: number }): number | null {
  const { rects, y } = input
  const edge = edgeSlot(rects, y)
  if (edge === 'outside') return null
  if (edge !== 'inside') return edge
  // 헤더를 먼저 본다 — 붙은 헤더는 자기 묶음 본문 위에 겹쳐 그려진다.
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]
    if (rect === undefined || y < rect.headTop || y > rect.headBottom) continue
    return y >= (rect.headTop + rect.headBottom) / 2 ? index + 1 : index
  }
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]
    if (rect === undefined || y < rect.top || y > rect.bottom) continue
    return y < (rect.top + rect.bottom) / 2 ? index : index + 1
  }
  // 묶음 사이 틈 — 아래쪽 묶음의 윗경계.
  const slot = rects.findIndex((rect) => y < rect.top)
  return slot < 0 ? rects.length : slot
}

/**
 * 카드를 끄는 중 — 같은 레포 카드(주 체크아웃 포함) 사이 경계 번호. `groupRange` 는 그 레포 묶음의 위·아래(다른 레포
 * 위 = 취소, K2ⓓ). 주 체크아웃도 `rects` 에 들어 있어 그 위(경계 0)에도 놓인다(게이트 ① 사용자 수정 1 — K2ⓑ 폐지).
 */
export function resolveCardDropSlot(input: { rects: readonly ItemRect[]; groupRange: ItemRect; y: number }): number | null {
  const { rects, groupRange, y } = input
  if (y < groupRange.top || y > groupRange.bottom) return null
  const edge = edgeSlot(rects, y)
  if (edge === 'outside') return null
  if (edge !== 'inside') return edge
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]
    if (rect === undefined || y > rect.bottom + DROP_BOUNDS_PADDING_PX) continue
    return y < (rect.top + rect.bottom) / 2 ? index : index + 1
  }
  return rects.length
}

// --- 끌어서 상위 지정 (LIFE-576 D3 — Orca main `worktree-lineage-drag-drop.ts`, #20412) --------------------------------
//
// 카드 내용 영역(`[data-worktree-card-parent-content]`)의 **안쪽 전체 = 상위 지정**, 위·아래 가장자리(높이 20%, 최대 8px)만 순서
// 이동 줄. 내용 영역 아랫변은 그 안의 첫 자식 행 윗변에서 자른다(부모 카드 안 자식 행은 부모 hit 영역이 아니다).
// 사각형은 **밀리기 전** 자리여야 한다(K3ⓔ — 순서 미리보기로 밀린 자리로 재면 판정이 흔들린다, O3).

const REORDER_GUTTER_RATIO = 0.2
const REORDER_GUTTER_MAX_HEIGHT_PX = 8

/** Orca `isWorktreeLineageDropZoneHit` 그대로 — 높이 0 이면 false, 경계값은 포함. */
export function isLineageDropZoneHit(input: { y: number; rect: ItemRect }): boolean {
  const height = Math.max(0, input.rect.bottom - input.rect.top)
  if (height <= 0) return false
  const gutter = Math.min(height * REORDER_GUTTER_RATIO, REORDER_GUTTER_MAX_HEIGHT_PX)
  return input.y >= input.rect.top + gutter && input.y <= input.rect.bottom - gutter
}

/** 상위 지정 후보 하나 — `rect` = 내용 영역(자식 행 윗변에서 자른 것). 무효 대상(자기·후손·다른 레포 등)은 호출부가 뺀다. */
export type LineageTargetRect = { key: string; rect: ItemRect }

/** 포인터 y 가 들어간 후보 — 없으면 null. 내용 영역은 서로 겹치지 않으니 첫 적중이 답이다. */
export function resolveLineageTarget(input: { targets: readonly LineageTargetRect[]; y: number }): string | null {
  return input.targets.find((target) => isLineageDropZoneHit({ y: input.y, rect: target.rect }))?.key ?? null
}

/**
 * 덩어리 경계 번호 → 평면 경계 번호 (Orca `getFullDropIndexForWorktreeDragUnit`) — 앞 덩어리들의 카드 수 합.
 * `sizes[i]` = i 번째 덩어리의 카드 수(루트 + 펼친 후손).
 */
export function unitSlotToFlat(input: { sizes: readonly number[]; slot: number }): number {
  const bounded = Math.max(0, Math.min(input.sizes.length, Math.trunc(input.slot)))
  let flat = 0
  for (let index = 0; index < bounded; index++) flat += input.sizes[index] ?? 0
  return flat
}

/**
 * 중첩된 자식을 끄는 중의 미리 보기 (수정 r1 M4 — Orca main `worktree-drag-units.ts`: 끄는 카드도 덩어리처럼 자리를 벌린다).
 * 끄는 카드는 부모 덩어리 안이라 덩어리 목록에 없다 — 놓일 경계 `slot` 뒤 덩어리들을 끄는 카드 높이 + 틈(틈의 중앙값)만큼 내리고,
 * 표시 줄 = 벌어진 자리 윗변(경계 덩어리 윗변, 맨 끝이면 마지막 덩어리 아랫변 + 틈). 사각형은 **밀리기 전** 자리다(K3ⓔ).
 */
export function buildInsertionPreview(input: { rects: readonly ItemRect[]; slot: number; height: number; view: ItemRect }): { offsets: number[]; indicatorY: number } {
  const { rects, view } = input
  const slot = Math.max(0, Math.min(rects.length, Math.trunc(input.slot)))
  const gaps: number[] = []
  for (let index = 1; index < rects.length; index++) gaps.push(Math.max(0, (rects[index]?.top ?? 0) - (rects[index - 1]?.bottom ?? 0)))
  const gap = median(gaps) ?? 0
  const shift = Math.max(0, input.height) + gap
  const offsets = rects.map((_, index) => (index >= slot && shift >= 0.5 ? shift : 0))
  const last = rects[rects.length - 1]
  const y = rects[slot]?.top ?? (last === undefined ? view.top : last.bottom + gap)
  return { offsets, indicatorY: clampToView({ y, view }) }
}

/** 표시 줄을 보이는 범위 안쪽으로 당기는 여유 — 붙은 헤더 윗변 바로 안쪽(점 3px + 테두리 2px). */
const INDICATOR_VIEW_INSET_PX = 5

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

/**
 * 놓일 자리 미리 보기 (198 `buildWorktreeDragPreviewOffsets` + `getWorktreeSidebarDropIndicatorY` 대응, K3ⓗⓑⓒ).
 *
 * `rects` 는 지금 순서의 **밀리기 전** 사각형, `from` 은 끄는 항목 자리, `slot` 은 놓일 경계. 바뀐 순서를 실측 높이와
 * 각 항목 뒤 틈(마지막은 틈의 중앙값)으로 첫 윗변부터 다시 쌓아 — `offsets[i]` = 다시 쌓은 윗변 − 지금 윗변(끄는 항목은 0,
 * 0.5px 미만 0). 표시 줄 = 끄는 항목이 들어갈 자리 윗변(placeholder), 제자리 놓기면 끄는 항목 윗변. 그 자리가 보이는
 * 범위 `view` 밖이면(붙은 헤더 앞 경계가 화면 위로 숨은 때 등) 범위 끝 안쪽 5px 로 당긴다 — 표시가 사라지지 않게.
 */
export function buildReorderPreview(input: {
  rects: readonly ItemRect[]
  from: number
  slot: number
  view: ItemRect
}): { offsets: number[]; indicatorY: number } {
  const { rects, from, view } = input
  const count = rects.length
  const offsets = rects.map(() => 0)
  const source = rects[from]
  if (source === undefined) return { offsets, indicatorY: clampToView({ y: view.top, view }) }
  const slot = Math.max(0, Math.min(count, Math.trunc(input.slot)))
  const to = slot > from ? slot - 1 : slot
  if (to === from) return { offsets, indicatorY: clampToView({ y: source.top, view }) }
  const order = rects.map((_, index) => index).filter((index) => index !== from)
  order.splice(to, 0, from)
  const gaps: number[] = []
  for (let index = 1; index < count; index++) gaps.push(Math.max(0, (rects[index]?.top ?? 0) - (rects[index - 1]?.bottom ?? 0)))
  const fallbackGap = median(gaps) ?? 0
  const gapAfter = (index: number): number => gaps[index] ?? fallbackGap
  let nextTop = rects[0]?.top ?? 0
  let placeholderTop = source.top
  for (const index of order) {
    const rect = rects[index]
    if (rect === undefined) continue
    if (index === from) placeholderTop = nextTop
    else {
      const offset = nextTop - rect.top
      offsets[index] = Math.abs(offset) < 0.5 ? 0 : offset
    }
    nextTop += rect.bottom - rect.top + gapAfter(index)
  }
  return { offsets, indicatorY: clampToView({ y: placeholderTop, view }) }
}

function clampToView(input: { y: number; view: ItemRect }): number {
  const { y, view } = input
  return Math.max(view.top + INDICATOR_VIEW_INSET_PX, Math.min(view.bottom - INDICATOR_VIEW_INSET_PX, y))
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
