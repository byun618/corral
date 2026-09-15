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

/**
 * `byun@host:~` · `byun@host:~/repos/corral` · `byun@host:/private/var/...` —
 * oh-my-zsh 가 OSC 2 로 쏘는 프롬프트 제목 (`ZSH_THEME_TERM_TITLE_IDLE="%n@%m:%~"`,
 * `~/.oh-my-zsh/lib/termsupport.zsh:41`).
 *
 * ## `:\/` 에서 `:[~\/]` 로 넓혔다 — **격리가 만든 사각지대였다** (수정 라운드 3 G1)
 *
 * 옛 판별자는 `:` 뒤에 **`/`** 를 요구했다. 구현자도 리뷰어 셋도 전부 격리 HOME 에서 돌았고
 * 그 HOME 이 `/private/var/folders/…` 라 zsh 가 **절대경로**를 써서 표본이 전부 `:/` 였다.
 * 실환경 HOME 아래에서는 `%~` 가 `~` 로 접혀 `:~` · `:~/…` 가 되고, 그 셋이 전부 필터를
 * 통과해 긴 프롬프트 문자열이 탭 제목으로 떴다 (`04-gate1-check.md` §2 실측 4줄).
 * 그 4줄을 `session-title.test.ts` 에 그대로 박아 둔다 — 다음 라운드가 또 격리 표본만 보고
 * 좁히지 않게.
 */
const SHELL_PROMPT_TITLE = /^\S+@\S+:[~/]/

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
 * 판별자는 herdr 의 기본 label 이 **그 탭의 표찰 번호 문자열**이라는 실측이다
 * (09-gate1-fix.md C, 재확인 `raw/gate1-fix3/rename/rename.json` 의 `labelBefore`:
 * `number: 2` 인 탭의 `label: "2"`). 빈 문자열·공백도 이름이 아니다.
 *
 * ## `/^\d+$/` 에서 좁혔다 (J-4, fix3 리뷰 M2)
 *
 * 옛 판별자는 **모든** 숫자 label 을 거부해서, 사용자가 탭 이름을 `357` 로 바꾸면
 * herdr 는 저장에 성공하고 거절도 없는데 화면만 안 바뀌었다 — **성공한 조작을 말없이 버렸다.**
 * 이제 걸러지는 건 "그 탭의 기본 표찰"뿐이라 `357` 은 이름으로 산다.
 *
 * 남는 한 칸(탭을 **제 기본값과 같은 문자열**로 개명)은 여기서 못 가른다 — 저장된 값과 기본값이
 * 같은 문자열이라 사후에 구분할 방법이 없다. 그래서 **보내기 전에** 막고 사용자에게 알린다
 * (`useLifecycleActions.renameRow`). 화면이 거짓말하지 않는다는 요구는 그 둘로 함께 채운다.
 *
 * ## `number` 만 보던 것이 틀렸다 — 기본 label 은 **위치**다 (수정 라운드 4 G5, 높음)
 *
 * J-4 가 `/^\d+$/` 를 좁히면서 "herdr 기본 label = 그 탭의 `number` 문자열" 이라고 읽었다.
 * 그 전제가 틀렸다. 코디네이터 실측(격리 세션, 탭 7개 만들고 두 번째를 닫음,
 * `04-gate1-check.md` §7):
 *
 *   생성 직후   `t1,1,1` `t2,2,2` `t3,3,3` `t4,4,4` `t5,5,5` `t6,6,6` `t7,7,7`
 *   `t2` 닫은 뒤 `t1,1,1` **`t3,2,3`** **`t4,3,4`** **`t5,4,5`** `t6,5,6` `t7,6,7`   ← (tab_id, label, number)
 *
 * **herdr 기본 `label` = 워크스페이스 안 1-기반 위치**이고 닫으면 다시 매겨진다. `number` 는
 * 재사용 없는 생성 순번이다. 그래서 **탭을 하나라도 닫으면** `label !== String(number)` 가 되고,
 * 그때부터 이 함수가 기본 label 을 사용자 이름으로 읽었다 — `userLabel` 이 맨 위 티어라
 * `ai-title`·터미널 제목·브랜치가 **전부 가려졌다**(사용자 실환경 `wS`: `label"1" number 5` ·
 * `label"2" number 6` · `label"3" number 7`). 탭을 한 번도 안 닫은 워크스페이스에서는 안 보여서
 * 하네스·리뷰·앞 라운드 확인을 전부 통과했다.
 *
 * 그래서 **위치도 같이 본다.** 둘 중 하나와 같으면 기본값 모양이다:
 *   · `String(position)` — 지금 herdr 가 주는 기본값
 *   · `String(tab.number)` — 늦게 온 봉투 등으로 옛 기본값이 남아 있는 경우(J-4 가 보던 것)
 * 위치는 **`workspace.tabs` 전체 목록에서의 자리**다 (사이드바가 거르는 에이전트 탭 목록이 아니다).
 * 목록에서 못 찾으면 `null` 을 받고, 그때는 위치 비교를 **안 한다** — 모르는 값으로 이름을 지우지 않는다.
 *
 * J-4 회귀는 그대로 산다: 탭 이름을 `357` 로 바꾸면 그 탭의 위치도 `number` 도 357 이 아니라 **이름이다.**
 */
export function userLabel(input: { tab: TabRow; position: number | null }): string | null {
  const { tab, position } = input
  const label = tab.label.trim()
  if (label.length === 0) return null
  if (label === String(tab.number)) return null
  if (position !== null && label === String(position)) return null
  return label
}

/**
 * 이 탭이 **워크스페이스 안에서 몇 번째인가** — 1-기반. 목록에 없으면 `null`.
 *
 * 어댑터가 `workspace.tabs` 를 herdr 의 목록 순서(`order`)로 정렬해 준다
 * (`adapter/internal/store.ts:622`). 그래서 자리는 **배열 인덱스**로 센다 — `order` **값**이
 * 아니다: 탭을 닫아도 남은 탭의 `order` 값은 그대로라 구멍이 생기고(0,2,3…), 그 값을 위치로
 * 쓰면 herdr 가 다시 매긴 label 과 어긋난다.
 */
export function tabPosition(input: { tabs: readonly TabRow[]; tabId: string }): number | null {
  const index = input.tabs.findIndex((tab) => tab.tabId === input.tabId)
  return index === -1 ? null : index + 1
}

/**
 * provider 가 스스로 붙인 세션 제목 (claude `ai-title`). 없으면 null.
 *
 * **소유자 확인은 판독 층이 이미 했다** (`main/transcript-parse.ts` — 레코드의 `sessionId` 가
 * 그 pane 의 참조 id 와 같을 때만 싣는다, 기준 C2). Orca 도 `agent`+`sessionId` 가 맞을 때만
 * 쓴다 (`agent-row-conversation-name.ts:139-148`). 여기서는 온 값을 쓸지만 정한다.
 */
export function providerTitle(tab: TabRow): string | null {
  const title = tab.digest.providerTitle
  if (title === null) return null
  const trimmed = title.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 판독층이 detached HEAD 에 주는 표식 (`main/git-worktrees.ts:42`) — 브랜치 이름이 아니다. */
const DETACHED_HEAD = '(detached)'

/**
 * 세션 제목 — **사용자 이름 → provider 세션 제목 → 정제된 터미널 제목 → 브랜치 → 폴백**
 * (LIFE-366 C1 + 수정 라운드 3 G3). 폴백은 `claude 1` · `codex 2` · `세션 3` —
 * 번호는 herdr 표찰(`TabRow.number`)이다.
 *
 * ## 브랜치 티어는 **에이전트 없는 탭에만** 내려온다 (G3)
 *
 * 통과선이 "에이전트 탭은 영향을 안 받는다" 이고, 그 조건은 위 세 티어만으로는 안 지켜진다 —
 * 갓 띄운 에이전트 탭은 사용자 이름도 `ai-title` 도 없고 터미널 제목은 유휴 기본값(`Claude Code`)
 * 이라 **거절**되어 지금도 `claude N` 으로 떨어지는 자리가 있다. 브랜치를 무조건 끼우면 그 자리가
 * 브랜치 이름으로 덮인다. 그래서 `tabAgent(tab) === null` 일 때만 본다.
 *
 * 브랜치 뒤에 **표찰 번호를 붙인다** — 같은 worktree 의 셸 탭 둘이 같은 제목이 되면 안 된다
 * (기준 A4). `claude N` · `세션 N` 과 같은 모양이라 번호 규칙도 하나로 유지된다.
 *
 * 브랜치가 없으면(detached HEAD·非git) `세션 N` 이다 — 빈 문자열이나 `null` 을 그리지 않고,
 * `WorktreeRow.path` 로 대신하지도 않는다 (§2.5 "절대경로는 행에 넣지 않는다").
 * detached HEAD 는 판독층이 **`(detached)` 라는 표식 문자열**로 준다
 * (`main/git-worktrees.ts:42`) — 그건 브랜치 이름이 아니므로 여기서 없음으로 본다.
 * 그 표식을 제목에 그대로 쓰면 같은 상태의 worktree 가 전부 같은 이름이 된다(A4 위반).
 *
 * ## provider 제목이 터미널 제목보다 **위**인 이유
 *
 * 둘 다 "에이전트가 지금 무슨 일을 하나" 를 말하지만 출처가 다르다. 터미널 제목은 OSC 로
 * 흘러오는 **현재 상태**라 자주 바뀌고 유휴 기본값(`Claude Code`)으로 돌아간다. `ai-title` 은
 * claude 가 대화 전체를 보고 붙인 **그 세션의 이름**이라 안정적이고, 같은 worktree 의 claude
 * 두 개를 가르는 것이 바로 이 값이다 — 이 일감이 풀려는 문제가 그것이다.
 * (LIFE-357 의 2단은 그대로 남는다: 사용자가 준 이름은 여전히 맨 위다.)
 *
 * ⓑ 6단 중 **퀵커맨드 라벨·자체 LLM 명명은 넣지 않는다** (기준 C4, `00-analysis.md` §5):
 * corral 에 퀵커맨드 기능 자체가 없고, `ai-title` 이 이미 LLM 명명이다.
 *
 * 사이드바와 탭바가 **이 함수 하나**를 공유한다 — 그래서 탭에서 이름을 바꾸면 사이드바가
 * 같은 틱에 따라온다. 호출부마다 분기하면 두 목록이 갈라진다.
 *
 * `position` 은 **워크스페이스 전체 탭 목록에서의 1-기반 자리**다 (`tabPosition`). 맨 위 티어가
 * herdr 기본 label 을 가려내는 데 쓴다 (수정 라운드 4 G5) — 사이드바처럼 에이전트 탭만 거른
 * 목록의 인덱스를 넣으면 자리가 어긋나 기본 label 이 다시 이름으로 산다.
 */
export function sessionTitle(input: { tab: TabRow; branch: string | null; position: number | null }): string {
  const { tab, branch, position } = input
  const named = userLabel({ tab, position })
  if (named !== null) return named
  const provider = providerTitle(tab)
  if (provider !== null) return provider
  const label = paneTitleLabel(tab)
  if (label !== null) return label
  const agent = tabAgent(tab)
  if (agent !== null) return `${agent} ${tab.number}`
  const branchName = branch === null ? '' : branch.trim()
  if (branchName.length === 0 || branchName === DETACHED_HEAD) return `세션 ${tab.number}`
  return `${branchName} ${tab.number}`
}
