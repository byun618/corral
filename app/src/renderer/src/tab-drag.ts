// 탭 드래그 판정 순수 함수 (LIFE-387 A1 · design-handoff.md §1 Q1, §4 동작 계약).
//
// DOM 은 여기 없다 — App.tsx 가 `elementsFromPoint`/`getBoundingClientRect` 로 잰 사각형을
// 넘기면 이 파일은 순수 계산만 한다(group-tree.ts·pane-geometry.ts 와 같은 결).

export type Rect = { left: number; top: number; width: number; height: number }
export type Point = { x: number; y: number }

/** 6px(`--tab-drag-arm`) — 클릭과 드래그를 가르는 거리. */
export const TAB_DRAG_ARM = 6

/** 8px(`--tabbar-grace`) — 탭바 판정을 헤더 아래로 늘리는 폭. */
export const TABBAR_GRACE = 8

/** 본문 가장자리 존 비율(`--dropzone-band`). */
export const DROPZONE_BAND = 0.25

export function hasCrossedDragThreshold(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= TAB_DRAG_ARM
}

/** 포인터가 탭바(헤더 + grace) 안인가 — 이 값이 참이면 재정렬/이동, 거짓이면 본문 5존. */
export function isWithinTabbarGrace(input: { headerRect: Rect; point: Point; grace?: number }): boolean {
  const grace = input.grace ?? TABBAR_GRACE
  return input.point.y <= input.headerRect.top + input.headerRect.height + grace
}

export type BodyZone = 'left' | 'right' | 'up' | 'down' | 'center'

/**
 * 본문 안 5존 — 네 변 중 **가장 가까운 변**이 band 안이면 그 변, 아니면 center.
 * 모서리 근처에서도 하나만 성립한다(핸드오프 §1 Q1 "모서리 애매함 없음").
 */
export function resolveBodyZone(input: { bodyRect: Rect; point: Point; band?: number }): BodyZone {
  const band = input.band ?? DROPZONE_BAND
  const { bodyRect, point } = input
  if (bodyRect.width <= 0 || bodyRect.height <= 0) return 'center'
  const localX = point.x - bodyRect.left
  const localY = point.y - bodyRect.top
  const candidates: { zone: BodyZone; frac: number }[] = [
    { zone: 'left', frac: localX / bodyRect.width },
    { zone: 'right', frac: (bodyRect.width - localX) / bodyRect.width },
    { zone: 'up', frac: localY / bodyRect.height },
    { zone: 'down', frac: (bodyRect.height - localY) / bodyRect.height },
  ]
  const nearest = candidates.reduce((best, candidate) => (candidate.frac < best.frac ? candidate : best))
  return nearest.frac < band ? nearest.zone : 'center'
}

/** 존 → `splitGroup`/`splitGroupWithForeignTab` 가 받는 방향·가장자리. */
export function splitParamsOfZone(zone: 'left' | 'right' | 'up' | 'down'): { direction: 'row' | 'column'; edge: 'before' | 'after' } {
  switch (zone) {
    case 'left':
      return { direction: 'row', edge: 'before' }
    case 'right':
      return { direction: 'row', edge: 'after' }
    case 'up':
      return { direction: 'column', edge: 'before' }
    case 'down':
      return { direction: 'column', edge: 'after' }
  }
}

/** 탭바 안 삽입 인덱스 — 탭 중점 x 좌표 배열 중 포인터보다 뒤에 있는 첫 자리. */
export function resolveTabbarIndex(tabCentersX: number[], pointerX: number): number {
  for (let index = 0; index < tabCentersX.length; index++) {
    const center = tabCentersX[index]
    if (center !== undefined && pointerX < center) return index
  }
  return tabCentersX.length
}

/** 최종 드롭 판정 하나 — App.tsx 가 이걸 보고 group-tree 함수 중 하나를 고른다. */
export type DropTarget =
  | { kind: 'tabbar'; groupId: string; index: number }
  | { kind: 'split'; groupId: string; direction: 'row' | 'column'; edge: 'before' | 'after' }
  | { kind: 'merge'; groupId: string }
  | { kind: 'self-noop' }
  | { kind: 'invalid' }

/**
 * 본문 존 + 자기 영역 여부 + 원 영역 탭 수를 합쳐 최종 판정으로 접는다(§4 동작 계약 표 그대로).
 *
 * `ownTabCount` 는 **원 영역(fromGroupId)** 의 탭 수다 — 무효 판정(F-A1-5 "제 영역 가장자리 +
 * 탭 1개")은 대상이 자기 자신이고 자기가 마지막 탭일 때만 성립한다.
 */
export function resolveBodyDropTarget(input: {
  zone: BodyZone
  targetGroupId: string
  fromGroupId: string
  ownTabCount: number
  targetIsEmpty: boolean
}): DropTarget {
  const { zone, targetGroupId, fromGroupId, ownTabCount, targetIsEmpty } = input
  const sameGroup = targetGroupId === fromGroupId
  // 빈 영역은 본문 전체가 병합 존이다(§1 Q3) — zone 계산과 무관하게 먼저 가른다.
  if (targetIsEmpty) return sameGroup ? { kind: 'self-noop' } : { kind: 'merge', groupId: targetGroupId }
  if (zone === 'center') return sameGroup ? { kind: 'self-noop' } : { kind: 'merge', groupId: targetGroupId }
  if (sameGroup && ownTabCount < 2) return { kind: 'invalid' }
  const { direction, edge } = splitParamsOfZone(zone)
  return { kind: 'split', groupId: targetGroupId, direction, edge }
}
