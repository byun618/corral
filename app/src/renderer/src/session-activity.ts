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
// 그래서 corral 의 2차 줄은 **두 가지만** 말한다: *지금 무슨 도구를 돌리나* (일하는 중일 때) ·
// *마지막으로 무슨 말을 했나*.
//
// ## 「진행 중 도구」 갈래를 되살렸다 (수정 라운드 5, B9 — Orca 동등)
//
// 위 문단은 원래 이 갈래를 "herdr 가 안 준다" 는 이유로 뺐다. 절반만 맞았다 — herdr 통합은
// 여전히 `message` 를 안 부르지만, **트랜스크립트에 그 값이 있다.** 마지막 어시스턴트 턴이
// `tool_use` 뿐이면 그게 지금 돌고 있는 도구다 (`transcript-parse.ts` 의 `tool`).
//
// 게이트는 Orca 와 같다: **`working` 일 때만** 쓴다 (`agent-row-tool-preview.ts:12`
// `showsAgentToolPreview`). 도구 값은 자기를 세운 턴보다 오래 살아남아서, 다른 상태에서 쓰면
// 끝난 일을 "하는 중" 이라고 말하게 된다 — 기준 B9 이 "`unknown`·`idle` 에서는 지어내지 않는다"
// 로 못 박은 자리다. Orca 의 `waiting` 은 corral 에 대응 상태가 없어 안 따른다 (`blocked` 는
// 승인 대기라 "도구를 돌리는 중" 과 다르다).
//
// 낡은 마지막 메시지 문제는 그대로 두 방법으로도 푼다 — 판독 층이 tool_use 뿐인 턴을 건너뛰고
// 텍스트가 있는 턴까지 거슬러 올라가고, 오른쪽 경과 시간은 **최신 레코드 시각**을 쓴다.
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
  // **진행 중 도구가 마지막 말보다 앞이다** (B9, Orca `worktree-card-compact-agent-row.tsx:26-57`
  // 과 같은 순서) — 단 그 pane 이 실제로 일하는 중일 때만.
  const tool = runningTool(input.tab)
  if (tool !== null) return { kind: 'text', text: tool }
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
 * 지금 돌고 있는 도구 한 줄 (`Bash: cd …`). 아니면 null.
 *
 * 상태는 **에이전트가 붙은 pane 의 것**을 본다 (`tabAgent` 와 같은 규칙 — 처음 붙은 pane).
 * 탭 단위 상태(`TabRow.agentStatus`)가 아니라 pane 단위인 이유는 기준 B9 의 문언 그대로다:
 * 지문을 만든 그 세션이 일하는 중인지를 물어야 한다.
 *
 * 값 자체는 판독층이 관측된 모양에서만 만든다 — 없으면 이름만 오고(`input: null`), 그것도
 * 없으면 여기까지 안 온다.
 */
function runningTool(tab: TabRow): string | null {
  const tool = tab.digest.tool
  if (tool === null) return null
  const pane = tab.panes.find((row) => row.agent !== null) ?? null
  if (pane === null || pane.agentStatus !== 'working') return null
  return tool.input === null ? tool.name : `${tool.name}: ${tool.input}`
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
