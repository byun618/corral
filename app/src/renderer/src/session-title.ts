// 세션 제목 — **사이드바 SessionRow 와 메인 MainTabBar 가 공유한다**
// (09-gate1-fix.md C-3: "세션 제목이 곧 탭 제목이다").
//
// ## `PaneRow.title` 을 **쓴다** — 1회차 결론을 뒤집은 재실측 결과다
//
// 1회차(`raw/gate1-fix/c-title-probe.json`)는 "쓸 수 있는 제목 소스가 없다"고 결론냈다.
// 그 실측이 틀렸다. 2회차(`raw/gate1-fix2/title-probe2.json`, 10-gate1-fix2.md H-4)에서
// 1회차의 결함 두 개를 고치고 다시 쟀다:
//
//   ① 1회차는 에이전트를 띄우고 **일을 안 시켰다** → 제목이 유휴 기본값에 머물렀다.
//      더 정확히는, claude 가 처음 보는 폴더에서 띄우는 **신뢰 확인 화면**에 내내 서 있었다.
//   ② 1회차의 OSC 주입은 **claude TUI 입력창으로 들어갔다** → 셸 제목 실험 자체가 무효였다.
//
// 2회차 실측값 (원자료가 근거다):
//   · 셸 pane 에 `printf '\033]0;PROBE-TITLE\007'` → `PaneRow.title` 이 122ms 만에
//     `PROBE-TITLE` 로 **바뀐다**. herdr 의 OSC 제목 전파는 살아 있다.
//   · claude 에게 실제 작업을 시키면 제목이 `Claude Code` → `SUMMARY.md 작성` 으로 바뀐다.
//     **작업 설명이 그대로 제목에 온다.**
//
// ## 거절 목록 — 전부 **관측된 형식**이다 (관측 안 된 형식은 다루지 않는다)
//
//   · `wG:p3` 꼴 — pane ID. §2.5 "pane 인덱스나 숫자만 단독 표시 금지".
//   · `byun@host:/private/var/...` 꼴 — 셸 프롬프트 제목. §2.5 "절대경로는 행에 넣지 않는다".
//   · `claude`(1회차) · `Claude Code`(2회차) — 유휴 기본값. 작업 설명이 아니라서 같은 종류의
//     탭이 전부 같은 제목이 된다(행 구분 불가 — 1회차가 셸 제목을 기각한 것과 같은 사유).
//
// **상태 접두사(`✳`·`. `·`* `·스피너)는 corral 에서 한 번도 관측되지 않았다.** 120~150ms 간격
// 연속 샘플링 2회에서 접두사 붙은 제목이 안 나왔다 — 그래서 접두사 분리 코드를 **만들지 않는다**
// (10-gate1-fix2.md H-4 "관측 안 된 형식을 미리 처리하지 마라"). 상태는 계속 `AgentStatus`
// 글리프가 맡는다. 접두사가 관측되면 그때 붙인다.
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

/** `wG:p3` — herdr pane ID 가 제목 자리에 올 때(최초 몇 프레임). */
const PANE_ID_TITLE = /^w[A-Za-z0-9]+:p\d+$/

/** `byun@sanghyunui-MacBookPro:/private/var/...` — zsh 가 OSC 로 쓰는 프롬프트 제목. */
const SHELL_PROMPT_TITLE = /^\S+@\S+:\//

/**
 * 유휴 기본값인가 — 에이전트 이름 그 자체(`claude`)이거나 관측된 제품명(`Claude Code`).
 * 제품명 목록을 넓게 지어내지 않는다: 나머지는 **에이전트 이름과 같은지**로 판정해 데이터에서 끌어낸다.
 */
function isVendorIdleTitle(title: string, agent: string | null): boolean {
  const normalized = title.toLowerCase()
  if (agent !== null && normalized === agent.toLowerCase()) return true
  return normalized === 'claude code'
}

/**
 * 제목으로 쓸 수 있는 `PaneRow.title` — 없으면 `null`.
 * 탭에 pane 이 여럿이면 먼저 쓸 만한 것을 준다.
 */
export function paneTitleLabel(tab: TabRow): string | null {
  const agent = tabAgent(tab)
  for (const pane of tab.panes) {
    if (pane.title === null) continue
    const title = pane.title.trim()
    if (title.length === 0) continue
    if (PANE_ID_TITLE.test(title)) continue
    if (SHELL_PROMPT_TITLE.test(title)) continue
    if (isVendorIdleTitle(title, agent)) continue
    return title
  }
  return null
}

/**
 * **사용자가 직접 준 이름** (`TabRow.label`) — 없으면 `null`.
 *
 * 판별자는 herdr 의 기본 label 이 **순수 숫자**(`"1"`)라는 실측이다 (09-gate1-fix.md C,
 * 재확인 `raw/gate1-fix3/rename/rename.json` 의 `labelBefore`). 숫자만이면 사람이 지은 이름이
 * 아니라 herdr 표찰이므로 다음 단으로 내려간다. 빈 문자열·공백도 이름이 아니다.
 *
 * 관측 기반 판별자라 **가정이 깨지면 원자료가 먼저 안다** — 위 JSON 이 리네임 전/후 label 을
 * 둘 다 들고 있어서, 기본값이 숫자가 아니게 되면 그 파일이 어긋난다.
 */
export function userLabel(tab: TabRow): string | null {
  const label = tab.label.trim()
  if (label.length === 0) return null
  if (/^\d+$/.test(label)) return null
  return label
}

/**
 * 세션 제목. **사용자 이름 → 터미널 제목 → 폴백** 순이다 (11-gate1-fix3.md I-7 ②).
 * 폴백은 `claude 1` · `codex 2` · `세션 3` — 번호는 herdr 표찰(`TabRow.number`)이다.
 *
 * 6단 전체(퀵커맨드 라벨·provider 세션 제목·LLM 자동 명명)와 2차 줄은 **Step 5 일감이다**
 * (`00-project.md` 2026-09-14 신설). 여기는 2단까지만 만든다.
 *
 * 사이드바와 탭바가 **이 함수 하나**를 공유한다 — 그래서 탭에서 이름을 바꾸면 사이드바가
 * 같은 틱에 따라온다. 호출부마다 분기하면 두 목록이 갈라진다.
 */
export function sessionTitle(tab: TabRow): string {
  const named = userLabel(tab)
  if (named !== null) return named
  const label = paneTitleLabel(tab)
  if (label !== null) return label
  const agent = tabAgent(tab)
  return agent === null ? `세션 ${tab.number}` : `${agent} ${tab.number}`
}
