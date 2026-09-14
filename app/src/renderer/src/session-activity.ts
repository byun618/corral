// 세션 행 **2차 줄 문구** 와 우측 **경과 시간** (LIFE-366 ⓒ·D1).
//
// # 우선순위 — Orca 를 그대로 베끼지 않았다 (사유)
//
// Orca `getCompactAgentSecondary` (`worktree-card-compact-agent-row.tsx:26-57`) 의 순서는
// `Interrupted by user` → 침묵 시간 → 상태 단어 → **진행 중인 도구 이름** → 마지막 메시지 →
// 에이전트 종류다. 즉 "지금 무엇을 하고 있나" 를 마지막 메시지보다 **앞**에 둔다.
//
// corral 은 그 중 **가운데 셋을 쓸 수 없다.** 진행 중인 도구 이름은 herdr 가 주지 않고
// (`pane.report_agent` 의 `message` 를 herdr 통합 훅이 한 번도 안 부른다 — `00-analysis.md` §2.3),
// 상태 단어는 이미 왼쪽 글리프가 말하고 있으며(`session-glyphs.ts`), 침묵 시간은 **오른쪽 경과
// 시간 칸**이 말한다. 그 셋을 2차 줄에 또 쓰면 같은 말을 세 번 하게 된다.
//
// 그래서 corral 의 2차 줄은 **한 가지만** 말한다: *마지막으로 무슨 말을 했나.*
// Orca 가 그 순서로 덮으려 했던 문제(마지막 메시지가 한 턴 낡을 수 있다)는 다른 방법으로 푼다 —
// **판독 층이 tool_use 뿐인 턴을 건너뛰고 텍스트가 있는 턴까지 거슬러 올라가고**
// (`transcript-parse.ts`), 오른쪽 경과 시간은 그 낡은 말이 아니라 **최신 레코드 시각**을 쓴다.
// 그러면 "3분 전 · 이 말을 했다" 가 되어 실시간을 참칭하지 않는다 (기준 A8·B7).
//
// # 없는 값은 **없다고 쓴다**
//
// `null` 을 돌려주는 것과 "없음" 이라는 글자를 그리는 것은 다르다. 여기가 `null` 을 주면
// `SessionRow` 는 **빈 슬롯**을 그린다 (기준 B4 — 행 높이가 안 튄다). 지어낸 문자열로 채우지
// 않는다. 단 하나의 예외가 통합 미설치인데, 그건 "값이 없다" 가 아니라 **"corral 이 못 읽는
// 상태다"** 라 사용자가 알아야 한다 (기준 B8).

import type { IntegrationRow, SessionActivity, TabRow } from '../../shared/types.js'
import { tabAgent } from './session-title.js'

/** 2차 줄에 그릴 것 — 갈래를 화면이 switch 로 받는다. */
export type SecondaryLine =
  /** 그릴 것이 없다. **슬롯은 남긴다** (B4). */
  | { kind: 'empty' }
  /** 에이전트가 한 말. */
  | { kind: 'text'; text: string }
  /** corral 이 못 읽는 상태 — 왜 못 읽는지 한 줄로. */
  | { kind: 'notice'; text: string }

/**
 * 그 탭의 2차 줄.
 *
 * `integrations` 가 빈 배열이면 **아직 모르는 것**이지 미설치가 아니다 — 그때는 조용히 빈 슬롯이다
 * (`AppState.integrations` 주석과 같은 약속).
 */
export function secondaryLine(input: { tab: TabRow; integrations: readonly IntegrationRow[] }): SecondaryLine {
  const activity: SessionActivity = input.tab.digest.activity
  switch (activity.state) {
    case 'text':
      return { kind: 'text', text: activity.text }
    case 'unreadable':
      return { kind: 'notice', text: '기록을 읽지 못했다' }
    case 'unknown-format':
      // 두 경우가 같은 갈래로 온다 — ① 레코드 모양이 낯설다 ② 꼬리 창(2MB) 안에 어시스턴트
      // 텍스트가 없다. 그래서 문구를 **둘 다 참인 말**로 쓴다. "형식을 모른다" 라고 쓰면
      // ②에서 거짓말이 된다 (A8 이 막으려는 바로 그것 — 화면이 모르는 것을 안다고 하면 안 된다).
      return { kind: 'notice', text: '최근 기록에서 표시할 텍스트를 못 찾았다' }
    case 'unresolved':
      // 참조는 왔는데 파일이 아직 없다 — 방금 뜬 세션이 여기 선다. 곧 채워지므로 조용히 둔다.
      return { kind: 'empty' }
    case 'none':
      return noticeForMissingRef(input)
  }
}

/**
 * 참조 자체가 없을 때. 셸 탭이면 2차 줄이 **애초에 없는 것**이고(B1 은 세션 행 얘기다),
 * 에이전트 탭인데 없으면 통합 미설치가 가장 흔한 이유다 (A1·B8).
 */
function noticeForMissingRef(input: { tab: TabRow; integrations: readonly IntegrationRow[] }): SecondaryLine {
  const agent = tabAgent(input.tab)
  if (agent === null) return { kind: 'empty' } // 셸 탭
  const row = input.integrations.find((item) => item.agent === agent)
  if (row === undefined) return { kind: 'empty' } // 아직 모른다 / corral 이 못 읽는 에이전트
  if (row.state === 'not-installed') return { kind: 'notice', text: 'herdr 통합 미설치 — 기록을 못 읽는다' }
  if (row.state === 'outdated') return { kind: 'notice', text: 'herdr 통합이 낡았다 — 기록을 못 읽는다' }
  return { kind: 'empty' } // 설치는 됐고 아직 보고 전 — 곧 온다
}

/**
 * 경과 시간 문구 (D1). 핸드오프 §2 의 `now` / `44m` / `2h` 를 그대로 쓴다.
 *
 * `at` 은 **실재하는 시각**이어야 한다 — 트랜스크립트 레코드 timestamp 또는 파일 mtime
 * (`main/transcript.ts`). 렌더러가 그 행을 처음 본 시각을 쓰면 미달이다 (09-gate1-fix.md E).
 * 없으면 null 을 준다 — 칸을 지어낸 수로 채우지 않는다.
 */
export function elapsedLabel(at: number | null, now: number): string | null {
  if (at === null) return null
  const seconds = Math.floor((now - at) / 1000)
  if (seconds < 0) return 'now' // 시계 어긋남 — 음수를 보이느니 now 로 접는다
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
