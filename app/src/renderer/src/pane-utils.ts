// pane 은 사이드바에서 더 이상 개별 행으로 뽑히지 않는다(design-handoff.md §1 — 상태바 ·
// 터미널 힌트줄로 대체 표현). 탭/worktree 를 고를 때 "그 안에서 보여줄 pane 하나"를 정하는
// 규칙만 여기 모은다 — focused 를 먼저 보고, 없으면 첫 pane.
import type { PaneRow, TabRow } from '../../shared/types.js'

export function pickPane(tab: TabRow): PaneRow | null {
  return tab.panes.find((pane) => pane.focused) ?? tab.panes[0] ?? null
}

/**
 * 입력 pane 이 화면을 따라간다 (LIFE-691 K2) — 화면에 보이는 활성 탭(터미널)에 선택 pane 이 없으면 그 탭에서 고를 pane(`pickPane`).
 * 이미 그 탭의 pane 이 선택돼 있거나 터미널 탭이 아니면(`tab` null — 파일 탭) null = 바꾸지 않는다.
 */
export function paneToFollow(input: { tab: TabRow | null; selectedPane: string | null }): string | null {
  if (input.tab === null) return null
  if (input.tab.panes.some((pane) => pane.paneId === input.selectedPane)) return null
  return pickPane(input.tab)?.paneId ?? null
}
