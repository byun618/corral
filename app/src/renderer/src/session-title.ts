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
// ## 거절 목록은 **폐지됐다** (C11, 수정 라운드 8)
//
// r1~r7 은 벤더 유휴 기본값(`claude`·`Claude Code`)과 셸 프롬프트 문자열을 거절했다. 근거였던
// G1 신고를 코디네이터가 「내용 거절」로 읽었는데 **사용자 뜻은 「길이」**였다
// (*"내가 거절한 건 문자열이 길어지는 걸 거절한 거지, orca와 동일하게 자르면 되잖아"*).
// 그래서 길이는 **자르는 것**으로 잡고(C11ⓓ 왼쪽 절단 15자), 프롬프트 모양은 herdr 가 안 주는
// OSC 1 값을 **우리가 만들어 넣고**(C11ⓒ), 거절은 **pane ID 하나만** 남겼다(C11ⓔ — 그건 남의
// 제목이 아니라 어댑터의 자체 폴백이다). 자세한 사유는 `paneTitleLabel` 주석에 있다.
//
// ## 상태 접두사(`✳`)와 스피너는 이제 **보인다**
//
// r7 까지 "corral 에서 한 번도 관측되지 않았다" 고 적혀 있었는데, 사유가 달랐다 — 어댑터가
// `terminal_title_stripped`(herdr 가 `✳` 를 벗긴 값)를 먼저 읽고 있었다(00-analysis.md §2.4).
// C11ⓑ 가 원문 `terminal_title` 로 바꿨으므로 접두사가 산다. 프레임마다 바뀌는 스피너는
// `pane-title-frames.ts`(C12)가 상태 단계에서 억제한다 — 여기 오는 제목은 이미 안정된 값이다.
import type { PaneRow, TabRow } from '../../shared/types.js'

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
 * 탭 제목을 모는 pane — **포커스된 pane** (C14, 수정 라운드 8).
 *
 * Orca `title-spawn-bell.ts:60-65` 의 사유 그대로다:
 *
 * ```ts
 * // Why: only the focused pane should drive the tab title — otherwise two
 * // agents in split panes cause rapid title flickering as each emits OSC
 * // sequences. Only the active split's title propagates to the tab.
 * ```
 *
 * **corral 이 지금 보여주는 pane 이 먼저다.** Orca 의 `manager.getActivePane()` 에 해당하는 것이
 * corral 에서는 `selectedPane`(렌더러가 고른 pane)이다 — 화면에 그 pane 이 떠 있는데 제목은 옆
 * pane 의 것이면, 사용자가 보는 것과 제목이 어긋난다. herdr 의 `focused` 는 **연결마다 따로**라
 * (control 구독이 `pane.focused` 를 일부러 안 받는다 — `adapter/internal/protocol.ts` 의 제외 목록)
 * corral 이 늘 최신으로 아는 값이 아니다. 그래서 순서는 **보여주는 pane → herdr 가 말한 focused
 * → 첫 pane** 이다. 마지막 칸은 비활성 탭(선택된 pane 이 그 탭에 없다)이 제목을 잃지 않게 한다.
 */
function titlePane(input: { tab: TabRow; selectedPaneId: string | null }): PaneRow | null {
  const { tab, selectedPaneId } = input
  const shown = selectedPaneId === null ? undefined : tab.panes.find((pane) => pane.paneId === selectedPaneId)
  return shown ?? tab.panes.find((pane) => pane.focused) ?? tab.panes[0] ?? null
}

/**
 * 그 pane 의 cwd 를 **zsh 가 OSC 1 에 넣었을 값**으로 만든다 (C9 · C11ⓒ). 없으면 null.
 */
function paneCwdLabel(input: { pane: PaneRow; home: string | null }): string | null {
  const cwd = input.pane.cwd
  if (cwd === null) return null
  const dir = cwd.trim()
  if (dir.length === 0) return null
  return truncatePathLeft(homeRelativeDir({ dir, home: input.home }))
}

/**
 * 제목으로 쓸 수 있는 pane 제목 — 없으면 `null`.
 *
 * ## 거절을 **폐지했다** (C11, 수정 라운드 8) — 사용자 지시 "orca와 동일하게"
 *
 * r1~r7 의 거절 목록은 **벤더 유휴 기본값**(`claude`·`Claude Code`)과 **셸 프롬프트 문자열**을
 * 통째로 쫓아냈다. 그 근거는 G1 신고였는데, 코디네이터가 그 신고를 「내용 거절」로 읽은 것이
 * **잘못이었다** — 사용자 뜻은 *"내가 거절한 건 문자열이 길어지는 걸 거절한 거지, orca와 동일하게
 * 자르면 되잖아"* 로, **길이** 문제였다. 거절은 길이의 해법이 아니라 과잉이었고, 그 과잉이
 * corral 을 Orca 에서 멀어지게 했다 (`05-orca-parity.md` §6).
 *
 * 그래서 이제 남는 것은 **네 가지 처리**다:
 *
 *   · **pane ID(`wG:p3`) 는 계속 거절한다** (C11ⓔ) — 이건 터미널이 보낸 제목이 아니라
 *     corral 어댑터가 제목 필드를 하나도 못 찾았을 때 넣는 **자체 폴백**(`store.ts` 의 `?? id`)이다.
 *     남의 값을 거절하는 게 아니라 내 폴백을 안 쓰는 것이라 성격이 다르다.
 *   · **프롬프트 모양은 cwd 값으로 바꾼다** (C11ⓒ) — herdr 는 OSC **2**(`%n@%m:%~`)만 주는데
 *     그걸 그냥 15자로 자르면 홈에서 `..-MacBookPro:~` 가 되어 Orca 화면(`~`)과 **어긋난다**.
 *     zsh 가 OSC 1 에 넣었을 값(`%15<..<%~%<<`)을 우리가 만들어 넣으면 글자가 같아진다.
 *   · **그 외는 그대로 두되 15자가 넘으면 왼쪽을 자른다** (C11ⓓ) — 길이만 잡는다.
 *   · 갓 뜬 claude 탭의 `✳ Claude Code` 는 이제 **그대로 뜬다** (C11ⓐⓑ). 재료(`ai-title`·첫 발화)가
 *     있는 세션은 C1′ 순서상 계속 자기 제목을 쓰므로, 이 값이 보이는 자리는 Orca 와 정확히 같다.
 *
 * 스피너 프레임 억제는 **상태가 화면에 들어오기 전**에 끝난다 (`pane-title-frames.ts`, C12) —
 * 여기 오는 `pane.title` 은 이미 안정된 프레임이다.
 */
export function paneTitleLabel(input: { tab: TabRow; home: string | null; selectedPaneId?: string | null }): string | null {
  const pane = titlePane({ tab: input.tab, selectedPaneId: input.selectedPaneId ?? null })
  if (pane === null) return null
  const title = pane.title.trim()
  if (title.length === 0) return null
  if (PANE_ID_TITLE.test(title)) return null
  if (SHELL_PROMPT_TITLE.test(title)) return paneCwdLabel({ pane, home: input.home })
  return truncatePathLeft(title)
}

/**
 * **사용자가 직접 준 이름** (`TabRow.label`) — 없으면 `null`.
 *
 * herdr 의 기본 label 은 **워크스페이스 안 1-기반 위치**다. 코디네이터 실측(격리 세션, 탭 7개를
 * 만들고 두 번째를 닫음, `04-gate1-check.md` §7, `(tab_id, label, number)`):
 *
 *   생성 직후   `t1,1,1` `t2,2,2` `t3,3,3` `t4,4,4` `t5,5,5` `t6,6,6` `t7,7,7`
 *   `t2` 닫은 뒤 `t1,1,1` **`t3,2,3`** **`t4,3,4`** **`t5,4,5`** `t6,5,6` `t7,6,7`
 *
 * 즉 **탭을 하나라도 닫으면** `label !== String(number)` 가 된다. 이 함수가 맨 위 티어라, 기본
 * label 을 이름으로 읽으면 `ai-title`·첫 발화·터미널 제목이 **전부 가려진다** (수정 라운드 4 G5).
 *
 * ## 위치 **정확 일치**에서 **1..탭수 범위**로 넓혔다 (수정 라운드 5 G7)
 *
 * r4 는 "label 이 그 탭의 지금 자리와 같은가" 로 봤다. 그 조건이 **탭을 닫는 과도기에 깨진다**:
 * herdr 가 label 을 다시 매긴 봉투와 목록 갱신이 같은 틱에 안 오므로, 잠깐 `label "2"` 인 탭이
 * 배열 자리 1 에 선다. 그 한 프레임 동안 기본 label 이 이름으로 읽혀 제목이
 * `main 2` → `2` → `main 2` 로 **깜빡였다** (`05-orca-parity.md` §5 G7).
 *
 * 그래서 판별을 **자리 하나**가 아니라 **자리의 범위**로 본다 — `1..탭수` 안의 순수 정수는
 * 어느 것이든 herdr 가 줄 수 있는 기본 label 이다. 과도기의 어긋난 짝도 이 범위 안이라
 * 깜빡임이 사라진다.
 *
 * 세 줄 다 필요하다:
 *   · `String(tab.number)` — 늦게 온 봉투로 **옛 기본값**이 남은 경우. 탭이 줄어들면
 *     `number` 가 탭수보다 커서 범위 규칙만으로는 안 걸린다 (예: 2탭 워크스페이스의 `label "3"`)
 *   · `1..탭수` 순수 정수 — 지금 herdr 가 주는 기본값과 그 과도기 모양
 *   · 탭수를 모르면(`null`) 범위 비교를 **안 한다** — 모르는 값으로 사용자 이름을 지우지 않는다
 *
 * J-4 회귀(LIFE-357)는 그대로 산다: 탭 이름을 `357` 로 바꾸면 워크스페이스에 탭이 357개가
 * 아닌 한 범위 밖이라 **이름으로 산다.**
 *
 * 남는 한 칸(탭수 이하의 숫자로 개명)은 여기서 못 가른다 — 저장된 값과 기본값이 같은 문자열이라
 * 사후에 구분할 방법이 없다. 그래서 **보내기 전에** 막고 알린다 (`useLifecycleActions.renameRow`).
 */
export function userLabel(input: { tab: TabRow; tabCount: number | null }): string | null {
  const { tab, tabCount } = input
  const label = tab.label.trim()
  if (label.length === 0) return null
  if (label === String(tab.number)) return null
  if (tabCount !== null && isDefaultPositionLabel(label, tabCount)) return null
  return label
}

/** `1..탭수` 안의 **순수 정수** 인가 — herdr 가 기본 label 로 줄 수 있는 문자열의 집합이다. */
export function isDefaultPositionLabel(label: string, tabCount: number): boolean {
  if (!/^\d+$/.test(label)) return false
  const value = Number(label)
  return Number.isInteger(value) && value >= 1 && value <= tabCount
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

/**
 * **세션의 첫 사용자 발화**를 정제한 제목 (C5). 없으면 null.
 *
 * 값은 판독층이 만든다 (`main/transcript-parse.ts` 의 `cleanFirstPrompt` — Orca
 * `deriveGeneratedTabTitle` 과 같은 결). 여기서는 그 값을 **쓸지만** 정한다: 소유자 확인과
 * 하네스 턴 건너뛰기는 이미 판독층에서 끝났다 (C2·C5).
 */
export function firstPromptTitle(tab: TabRow): string | null {
  const prompt = tab.digest.firstPrompt
  if (prompt === null) return null
  const trimmed = prompt.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 경로 표찰의 길이 — zsh `%15<..<%~%<<` 의 15 다 (`05-orca-parity.md` §5.2). */
const PATH_LABEL_MAX = 15
const PATH_LABEL_MARK = '..'

/**
 * 절대경로를 **홈 상대**로 접는다 — zsh 의 `%~` 와 같은 규칙. 홈 밖이면 그대로 둔다.
 *
 * `home` 은 main 이 실어 보낸 그 프로세스의 홈이다 (`AppState.home`). 계측 실행에서는 격리
 * HOME 이라 스크래치 레포도 `~/…` 로 접힌다 — 화면이 사용자 홈을 가정하면 안 되는 이유다.
 */
export function homeRelativeDir(input: { dir: string; home: string | null }): string {
  const { dir, home } = input
  if (home === null) return dir
  const root = home.endsWith('/') ? home.slice(0, -1) : home
  if (root.length === 0) return dir
  if (dir === root) return '~'
  return dir.startsWith(`${root}/`) ? `~${dir.slice(root.length)}` : dir
}

/**
 * **왼쪽을 자른다** — 15자 이하면 그대로, 넘으면 `..` + 뒤 13자 (C9).
 *
 * 오른쪽이 아니라 왼쪽을 자르는 이유는 사용자가 본 화면이 그렇기 때문이다: oh-my-zsh 가
 * `%15<..<%~%<<` 로 쏘는 값이고, 경로에서 사람이 읽는 부분은 **끝**이다
 * (`~/…/worktrees/LIFE-366-session-identity` → `..sion-identity`).
 */
export function truncatePathLeft(label: string): string {
  if (label.length <= PATH_LABEL_MAX) return label
  return `${PATH_LABEL_MARK}${label.slice(PATH_LABEL_MARK.length - PATH_LABEL_MAX)}`
}

/**
 * **셸 탭 폴백 — 잘린 경로** (C9, 수정 라운드 7). cwd 를 모르면 null 이고 그때 `terminal N` 이다.
 *
 * Orca 는 거절 목록이 없어서 셸이 쏜 OSC 를 그대로 띄우고, 사용자가 화면에서 본 짧은 글자는
 * oh-my-zsh 가 **OSC 1** 로 쏜 `%15<..<%~%<<` 였다. 그런데 **herdr 는 OSC 1 을 안 준다**
 * (`PaneInfo` 에 `title`·`terminal_title`·`terminal_title_stripped` 뿐) — 그대로 따르면
 * OSC 2 의 `byun@host:~/repos/…` 긴 문자열이 뜨고, 그게 사용자가 G1 로 신고한 그 문자열이다.
 * 그래서 **같은 값을 corral 이 계산한다** (사용자 결정 "그렇게 짤라서 가",
 * `05-orca-parity.md` §5.2).
 *
 * cwd 는 `tabAgent` 와 같은 규칙으로 **처음 나오는 pane** 의 것을 쓴다.
 */
export function shellCwdLabel(input: { tab: TabRow; home: string | null }): string | null {
  for (const pane of input.tab.panes) {
    const label = paneCwdLabel({ pane, home: input.home })
    if (label !== null) return label
  }
  return null
}

/**
 * 세션 제목 — **사용자 이름 → `ai-title` → 첫 사용자 발화 → 터미널 제목 → 폴백**
 * (기준 C1′, 수정 라운드 5 「Orca 동등」).
 *
 * ⚠ **순서를 건드리지 마라.** 수정 라운드 8 이 터미널 제목의 *내용 정책*을 Orca 와 맞췄지만
 * (거절 폐지 — C11), 그 단은 여전히 **4단**이다. OSC 단을 `ai-title`·첫 발화 위로 올리면
 * 재료가 있는 세션까지 `✳ Claude Code` 가 되어 이 일감이 푸는 문제가 그대로 되돌아온다.
 *
 * ## 순서는 Orca 의 것이다 — 지어낸 순서가 아니다
 *
 * Orca `getAgentRowConversationName`(`shared/agent-row-conversation-name.ts:140-162`)에서
 * `aiVaultTitle`(= `ai-title`, 없으면 **첫 사용자 발화**)은 **4단**이고 라이브 터미널 제목은
 * **6단**이다. 즉 provider 가 붙인 이름과 사람이 친 첫 말이 **둘 다** 터미널 제목보다 위다.
 * 사용자 지시가 "orca 와 동일하게" 라 그 순서를 그대로 박는다 (`05-orca-parity.md` §3.1).
 *
 * 값의 성질도 그 순서를 지지한다. 터미널 제목은 OSC 로 흘러오는 **지금 상태**라 자주 바뀌고
 * 유휴 기본값(`Claude Code`)으로 되돌아간다. `ai-title` 과 첫 발화는 **그 세션의 이름**이라
 * 안정적이고, 같은 worktree 의 claude 둘을 가르는 것이 바로 그 둘이다 — 이 일감이 푸는 문제다.
 *
 * ## 폴백: 에이전트 탭 `claude N` · 셸 탭 **잘린 경로** → `terminal N` (P5/G8 · C9 · C10)
 *
 * 수정 라운드 3 이 셸 탭에 넣었던 **브랜치 티어는 걷어냈다** (사용자 결정). 브랜치 이름은 같은
 * worktree 의 셸 탭 전부에 같은 말을 붙이고, 사용자가 탭에서 기대하는 것은 터미널이라는 사실
 * 하나였다.
 *
 * 수정 라운드 7 이 그 자리에 **잘린 cwd** 를 넣는다 (C9) — 셸 탭에만이다. 에이전트 탭은
 * 트랜스크립트가 곧 이름이라 경로를 쓸 이유가 없고, 같은 worktree 의 셸 탭들이 같은 글자가
 * 되는 것은 브랜치 티어를 걷어낸 사유와 같지만 **사용자가 그 화면을 짚어 결정했다**
 * ("그렇게 짤라서 가" — `05-orca-parity.md` §5.2). cwd 를 모르면 `terminal N` 으로 떨어진다.
 *
 * `N` 은 **비어 있는 가장 작은 번호**다 (C10, `fallback-ordinal.ts`) — herdr 표찰
 * (`TabRow.number`)이 아니다. 표찰은 재사용이 없어서 탭을 여럿 닫으면 `terminal 7` 이 남는다.
 * 매 렌더에 자리로 다시 세는 것도 아니다 — 그러면 옆 탭을 닫을 때마다 폴백 제목이 바뀌어
 * G7 이 없앤 깜빡임이 폴백 자리에서 되살아난다. **배정은 한 번, 탭이 닫힐 때까지 그대로다.**
 *
 * Orca 의 나머지 단은 **일부러 안 따른다** (`05-orca-parity.md` §4): 상태 단어(`Done`·`Idle`)와
 * 에이전트 종류(`Claude`)는 왼쪽 글리프와 오른쪽 경과 시간이 이미 말한다. 퀵커맨드 라벨은
 * corral 에 기능 자체가 없다 (기준 C4).
 *
 * 사이드바와 탭바가 **이 함수 하나**를 공유한다 — 그래서 탭에서 이름을 바꾸면 사이드바가 같은
 * 틱에 따라온다 (09-gate1-fix.md C-3). 호출부마다 분기하면 두 목록이 갈라진다.
 *
 * `ordinal` 은 폴백 번호다 — 호출부가 `fallback-ordinal.ts` 의 배정표에서 받아 넣는다. 이 함수를
 * 순수하게 두려고 밖에서 받는다(배정은 상태다). `home` 은 셸 폴백이 경로를 접는 데만 쓴다.
 *
 * `tabCount` 는 **그 워크스페이스의 탭 수**다 — 맨 위 티어가 herdr 기본 label 을 가려내는 데
 * 쓴다 (G7). 사이드바처럼 에이전트 탭만 거른 목록의 길이를 넣으면 범위가 좁아져 기본 label 이
 * 다시 이름으로 산다.
 */
export function sessionTitle(input: {
  tab: TabRow
  tabCount: number | null
  ordinal: number
  home: string | null
  /** corral 이 지금 보여주는 pane (C14) — 그 pane 이 탭 제목을 몬다. 이 탭에 없으면 무시된다. */
  selectedPaneId?: string | null
}): string {
  const { tab, tabCount, ordinal, home } = input
  const named = userLabel({ tab, tabCount })
  if (named !== null) return named
  const provider = providerTitle(tab)
  if (provider !== null) return provider
  const prompt = firstPromptTitle(tab)
  if (prompt !== null) return prompt
  const label = paneTitleLabel({ tab, home, selectedPaneId: input.selectedPaneId ?? null })
  if (label !== null) return label
  const agent = tabAgent(tab)
  if (agent !== null) return `${agent} ${ordinal}`
  return shellCwdLabel({ tab, home }) ?? `terminal ${ordinal}`
}
