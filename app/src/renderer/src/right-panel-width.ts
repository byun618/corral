// 오른쪽 패널 렌더 폭 (LIFE-682 A10) — 기억한 폭을 창에 맞춰 깎는다. Orca `right-sidebar-width.ts` 처럼 렌더 상한을 창 폭에서 구하되,
// 가운데 영역(`.main-area`)이 `--w-tasks-body-min` 아래로 눌리지 않는 쪽을 상한으로 잡는다(덮기 폴백을 대신한다).
//   · 렌더 폭 = min(기억한 폭, 창 폭 − 사이드바 폭 − 가운데 최소 폭), 아래로는 최소 폭(220)에서 멈춘다
//   · **기억값은 바꾸지 않는다** — 창을 다시 넓히면 기억한 폭으로 돌아간다(줄어든 렌더 폭으로 덮지 않는다)
// 입력이 창 폭·사이드바 폭뿐이라(가운데 영역을 재지 않는다) 렌더 폭이 다시 입력으로 돌아오는 고리가 없다 — 임계 근처에서 떨지 않는다.

export function panelRenderWidth({ stored, windowWidth, sidebarWidth, mainMin, min }: {
  stored: number
  windowWidth: number
  sidebarWidth: number
  mainMin: number
  min: number
}): number {
  return Math.max(min, Math.min(stored, windowWidth - sidebarWidth - mainMin))
}

/** 리사이저가 끌 수 있는 상한 — 토큰 상한과 지금 창에서 남는 폭 중 작은 쪽(최소 폭 아래로는 내리지 않는다). */
export function panelDragMax({ max, windowWidth, sidebarWidth, mainMin, min }: {
  max: number
  windowWidth: number
  sidebarWidth: number
  mainMin: number
  min: number
}): number {
  return Math.max(min, Math.min(max, windowWidth - sidebarWidth - mainMin))
}
