// pane 은 사이드바에서 더 이상 개별 행으로 뽑히지 않는다(design-handoff.md §1 — 상태바 ·
// 터미널 힌트줄로 대체 표현). 탭/worktree 를 고를 때 "그 안에서 보여줄 pane 하나"를 정하는
// 규칙만 여기 모은다 — focused 를 먼저 보고, 없으면 첫 pane.
import type { PaneRow, TabRow } from '../../shared/types.js'

export function pickPane(tab: TabRow): PaneRow | null {
  return tab.panes.find((pane) => pane.focused) ?? tab.panes[0] ?? null
}
