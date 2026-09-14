// 세션 제목 — **사이드바 SessionRow 와 메인 MainTabBar 가 공유한다**
// (09-gate1-fix.md C-3: "세션 제목이 곧 탭 제목이다").
//
// 왜 `PaneRow.title` 을 안 쓰나 — **실측 결과다**, 추측이 아니다
// (원자료 raw/gate1-fix/c-title-probe.json · 판단 파생 c-title-decision.json, 2026-09-14):
//   · 셸 pane 의 title = `byun@host:/private/var/.../l357fix-title-probe-AgJzhO`
//     → 같은 worktree 의 셸 탭끼리 **완전히 동일**하고, 절대경로를 품는다.
//       §2.5 "절대경로는 행에 넣지 않는다" 와 정면 충돌한다.
//   · 에이전트 pane 의 title = `claude` → 에이전트 이름 그 자체. 아래 폴백이 주는 정보의
//     부분집합이고 번호가 없어 구분력이 더 낮다.
//   · `TabRow.label` = `"1"·"2"·"3"` → §2.5 "pane 인덱스나 숫자만 단독 표시 금지".
// 행 3개 중 서로 다른 title 은 2개였다 — 구분자로 못 쓴다. 그래서 09-gate1-fix.md C-2 의
// 폴백 갈래를 채택한다.
//
// 목업의 `impl: LIFE-357 claude — No orpha…` 같은 서술형 제목은 **Orca 의 자동 명명 기능**
// 산물이다. corral 엔 그 기능이 없고, 이번 라운드에서 만들지 않는다(별도 일감).
import type { TabRow } from '../../shared/types.js'

/** 이 탭에 붙은 에이전트 이름. pane 중 처음 붙은 것을 쓴다. 없으면 null. */
export function tabAgent(tab: TabRow): string | null {
  for (const pane of tab.panes) if (pane.agent !== null) return pane.agent
  return null
}

/** 에이전트가 붙은 탭인가 — 01-criteria.md 부록 "세션 용어 확정" 의 **사이드바 쪽 '세션'** 정의. */
export function isAgentTab(tab: TabRow): boolean {
  return tabAgent(tab) !== null
}

/** `claude 1` · `codex 2` · `세션 3`. 번호는 herdr 표찰(`TabRow.number`)이다. */
export function sessionTitle(tab: TabRow): string {
  const agent = tabAgent(tab)
  return agent === null ? `세션 ${tab.number}` : `${agent} ${tab.number}`
}
