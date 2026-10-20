// 작업 상세 패널 배치 (LIFE-670 P4) — 순수 함수. 패널 모드에서 보기 영역을 밀어낼지(나란히) 덮을지(LIFE-602 동작)를 정한다.
//
// - 밀기 = `.tasks-main` 이 오른쪽에 패널 폭만큼 안쪽 여백을 두고 패널이 그 여백에 앉는다. 보기 영역 = 머리 아래 폭 − 패널 폭.
// - 그 가용 폭이 최소(`--w-tasks-body-min`) 미만이면 덮기로 물러난다 — 리사이저는 두지 않는다(LIFE-602 결정 유지).
// - 입력 폭은 `.tasks-main` 의 **테두리 상자** 폭이다. 밀기는 안쪽 여백만 바꾸므로 그 폭은 상태와 무관하다 —
//   그래서 단일 임계로도 밀기↔덮기가 프레임마다 번갈아 뛰지 않는다(내용 상자 폭을 쓰면 밀기가 입력을 줄여 되먹임이 생긴다).
// - 전체 모드(⤢)는 늘 덮기다.

export type DetailLayout = 'none' | 'push' | 'overlay' | 'full'

export function detailLayout({ open, full, mainWidth, panelWidth, minBodyWidth }: {
  open: boolean
  full: boolean
  mainWidth: number
  /** 토큰을 못 읽었으면 null — 덮기로 물러난다. */
  panelWidth: number | null
  minBodyWidth: number | null
}): DetailLayout {
  if (!open) return 'none'
  if (full) return 'full'
  if (panelWidth === null || minBodyWidth === null) return 'overlay'
  return mainWidth - panelWidth >= minBodyWidth ? 'push' : 'overlay'
}

/** CSS 길이 토큰(`560px`)을 숫자로 — 못 읽으면 null(호출자가 덮기로 물러난다). */
export function pxToken(value: string): number | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value)
  return match === null ? null : Number(match[1])
}
