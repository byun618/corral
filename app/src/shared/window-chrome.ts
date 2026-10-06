// LIFE-527 — 창 크롬(hiddenInset 신호등) 수치. Orca 198 `main/window/main-window-visual-lifecycle.ts:111-121` 그대로:
// 머리 36px 띠의 세로 중심(18 CSS px)에 신호등(지름 약 12px)의 중심을 맞춘다 — 위 끝 = 18×줌 − 6.
// main(창 옵션·줌 보정)과 렌더러(신호등 여백 폭)가 같은 값을 본다.

export const TRAFFIC_LIGHT_X = 16
export const TITLEBAR_CSS_CENTER = 18
export const TRAFFIC_LIGHT_RADIUS = 6
/** 신호등 여백 폭(줌 1) — Orca `.titlebar-traffic-light-pad { width: calc(80px / var(--ui-zoom-factor)) }`. */
export const TRAFFIC_LIGHT_PAD = 80

/** 줌 계수 → 신호등 위치. 비정상 값(0·음수·NaN)은 줌 1 로 읽는다 — 신호등을 창 밖으로 보내지 않는다. */
export function trafficLightPosition(zoomFactor: number): { x: number; y: number } {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return { x: TRAFFIC_LIGHT_X, y: Math.round(TITLEBAR_CSS_CENTER * zoom - TRAFFIC_LIGHT_RADIUS) }
}

/** 렌더러가 머리를 그리는 데 필요한 창 상태. `mac` 이 아니면 hiddenInset 이 아니라 신호등 여백을 두지 않는다. */
export type WindowChrome = { mac: boolean; fullScreen: boolean; zoomFactor: number }

/** 신호등 여백을 두나 — Orca `TitlebarLeftControls.tsx:45` `isMac && !isFullScreen`. 전체화면에서는 신호등이 창 위에 없다. */
export function showsTrafficLightPad(chrome: WindowChrome): boolean {
  return chrome.mac && !chrome.fullScreen
}
