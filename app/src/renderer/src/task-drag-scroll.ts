// 작업 끌기 중 자동 스크롤 (LIFE-670 P5) — 순수 함수. `useTaskDrag` 가 잰 스크롤 그릇의 가시 사각형과 포인터를 넘기면 이번 프레임의 이동량만 계산한다.
//
// - 가장자리 띠 40px 안에 포인터가 있으면 그 방향으로 민다. 가장자리에 가까울수록 빠르고 한 프레임 상한 20px.
// - 띠 밖(사각형 밖 포함)이면 0 — 포인터가 그릇을 벗어나면 멈춘다(패널 위로 나가도 멈춤).
// - 가로·세로는 따로 본다(모서리면 대각선). 사각형의 오른쪽은 호출자가 패널 왼쪽으로 깎아 넘긴다(덮기 폴백 때).

import type { Point } from './sidebar-reorder.js'

export const DRAG_SCROLL_EDGE_PX = 40
export const DRAG_SCROLL_MAX_PX = 20

export type ScrollRect = { left: number; top: number; right: number; bottom: number }

function axisStep({ at, start, end }: { at: number; start: number; end: number }): number {
  const band = Math.min(DRAG_SCROLL_EDGE_PX, (end - start) / 2)
  if (band <= 0) return 0
  const speed = (depth: number): number => Math.max(1, Math.round(DRAG_SCROLL_MAX_PX * Math.min(1, depth / band)))
  if (at < start + band) return -speed(start + band - at)
  if (at > end - band) return speed(at - (end - band))
  return 0
}

export function dragScrollStep({ point, rect }: { point: Point; rect: ScrollRect }): { dx: number; dy: number } {
  const inside = point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  if (!inside) return { dx: 0, dy: 0 }
  return {
    dx: axisStep({ at: point.x, start: rect.left, end: rect.right }),
    dy: axisStep({ at: point.y, start: rect.top, end: rect.bottom }),
  }
}
