// **경계를 건너는 타입은 전부 여기 있다** (기준 N2ⓐ).
//
// herdr 의 와이어 모양(snake_case 필드·`PaneInfo`·프로토콜 enum)은 이 파일에 한 글자도 없다.
// 어댑터가 herdr 응답을 읽어 **corral 이 정의한 이 타입으로 옮겨 담는다**. 백엔드가 바뀌면
// 고치는 곳은 어댑터 한 층이고, 이 파일과 렌더러는 그대로다 — 그게 이 경계의 존재 이유다.
//
// 규칙: 이 파일은 아무것도 import 하지 않는다. import 가 생기면 그 순간 경계가 새기 시작한다.

/**
 * corral 이 **칩으로 구분하는** 에이전트 상태. herdr 와 값이 겹치지만 corral 의 정의다.
 *
 * `done` 이 여기 없는 이유 (수정 1회차 M7 — 기준 N8 은 "노출한 것 전부를 대조" 다):
 *   · herdr 0.9.0 스키마의 `AgentStatus`(이벤트·스냅샷·응답)에는 `done` 이 **있다**
 *   · `pane.report_agent` 가 받는 `PaneAgentState` 에는 **없다** — 그래서 그 거절은 스키마와 일치한다
 *   · 설치된 탐지 매니페스트(remote/*.toml)가 쓰는 state 는 blocked·idle·unknown·working 넷뿐이다
 * 즉 0.9.0 은 `done` 을 **만들지 않는다**. 만들 수 없는 값을 칩으로 노출하면 그 칩은 영영
 * 오라클과 대조할 수 없다. 어댑터는 `done` 이 와도 읽을 수 있고(미상으로 옮기고 로그에 남긴다),
 * 실제로 오기 시작하면 그때 칩을 늘린다 (이월).
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'unknown'

/**
 * herdr 세션 하나 — **렌더러가 보는 만큼**.
 *
 * 소켓 경로는 여기 없다 (수정 1회차 L9). 경계의 약속이 "herdr 소켓은 main/adapter 안" 인데
 * 진단용으로 렌더러까지 실어 보내면 그 약속이 화면 상태에서 새는 꼴이다. 소켓을 들고 다니는
 * 타입은 어댑터의 `SessionHandle` 이고 그건 main 밖으로 나가지 않는다.
 */
export type SessionInfo = {
  name: string
  isDefault: boolean
  running: boolean
}

/** 세션 링크가 지금 어느 걸음에 있나. */
export type LinkPhase =
  | 'idle'
  | 'connecting'
  | 'subscribing'
  | 'buffering'
  | 'snapshotting'
  | 'live'
  | 'reconnecting'
  | 'failed'

export type LinkState = {
  phase: LinkPhase
  sessionName: string | null
  attempt: number
  nextRetryInMs: number | null
  lastError: string | null
  lastPushAt: number | null
  /** 부트스트랩에서 스냅샷 전에 버퍼링한 push 수 — "구독 먼저" 가 실제로 일했다는 지문. */
  bufferedAtSnapshot: number | null
  /** 마지막 주기 재동기 시각과 그때 고친 것 (N7 의 화면 근거). */
  lastResyncAt: number | null
  lastResyncNote: string | null
  /** 지금까지 돈 재동기 횟수. */
  resyncCount: number
  /**
   * 계측용 — push 를 일부러 버리고 있나 (N7 유실 주입). 평시에는 false.
   * **어떤 이벤트를 골라 버리는지는 여기 안 싣는다** (수정 3회차 F3-L5): 그건 main 의 계측
   * 상태이고, 화면은 "주입 중" 이라는 사실만 알면 된다. 목록은 `link.drop_push` 로그에 있다.
   */
  droppingPush: boolean
}

// --- 목록 (repo → worktree → tab → pane) -------------------------------------

/**
 * 이 pane 에 붙은 에이전트가 **자기 세션을 스스로 밝힌 것** (LIFE-366).
 *
 * 출처는 herdr 가 자체 설치하는 통합 훅이다: 에이전트가 뜰 때(`SessionStart`) 훅이 herdr 소켓에
 * 자기 세션 id 를 보고하고, herdr 가 그것을 pane 에 실어 준다. corral 은 훅을 만들지도, 사용자
 * 에이전트 설정을 고치지도 않는다 (`00-analysis.md` §2.2).
 *
 * ## 왜 union 인가 — **실측은 `id` 뿐이다**
 *
 * herdr 스키마의 참조 갈래는 `id | path` 인데, 통합 3종(claude·codex·grok)을 전부 태워 보니
 * **셋 다 `id`** 로 왔다 (`raw/claude/a3-agent-session-probe.json`). claude 훅은 경로까지
 * 보내는데도 그렇다 — 경로만 보내면 herdr 는 참조 자체를 안 만든다
 * (`raw/claude/ref-semantics.json` ①). 즉 **파일을 찾는 일은 corral 몫**이다.
 * `path` 갈래는 스키마에 있어 union 으로 받아 두되, 관측된 적이 없다는 사실을 여기 적어 둔다.
 *
 * ## 한 번 박히면 안 바뀐다 (실측)
 *
 * 같은 pane 에 새 id·다른 에이전트·null 을 seq 를 올려 보고해도 herdr 는 **첫 값을 지킨다**
 * (`ref-semantics.json` ②③④). 그래서 한 pane 에서 `/clear`·`--resume` 로 세션이 갈리면
 * 참조가 낡는다 — corral 이 고칠 수 있는 자리가 아니라 herdr 상류의 일이다.
 */
export type AgentSessionRef =
  | { kind: 'id'; agent: string; source: string; id: string }
  | { kind: 'path'; agent: string; source: string; path: string }

export type PaneRow = {
  paneId: string
  tabId: string
  workspaceId: string
  title: string
  agent: string | null
  agentStatus: AgentStatus
  cwd: string | null
  focused: boolean
  /** 에이전트가 밝힌 세션 참조. 셸 탭·통합 미설치·보고 전에는 null. */
  agentSession: AgentSessionRef | null
}

/**
 * 세션 행 2차 줄에 실을 **마지막 활동 문구** (LIFE-366 ⓒ).
 *
 * `null` 하나로 뭉개지 않는다 (기준 E3): "셸 탭이라 애초에 없다" 와 "참조는 있는데 파일을
 * 못 찾았다" 와 "읽었는데 모양이 낯설다" 는 화면에서 **다르게 읽혀야 한다**. 특히 마지막 갈래는
 * 트랜스크립트 포맷이 공개 계약이 아니라는 사실(`00-analysis.md` §9.1)에 대한 대비다 —
 * 모양이 바뀌면 화면은 **모른다고 말해야지 지어내면 안 된다** (기준 A8).
 */
export type SessionActivity =
  /** 참조 자체가 없다 — 셸 탭이거나, 통합이 안 깔렸거나, 아직 보고 전이다. */
  | { state: 'none' }
  /** 참조는 있는데 그 id 의 파일을 못 찾았다 (에이전트가 다른 HOME 에서 돌거나 파일이 지워짐). */
  | { state: 'unresolved' }
  /** 파일은 찾았는데 읽지 못했다 (권한·삭제 경합 등). 사유는 진단용이라 짧게만 싣는다. */
  | { state: 'unreadable'; reason: string }
  /** 읽었는데 마지막 어시스턴트 텍스트를 못 찾았다 — 포맷이 낯설거나 꼬리 창 밖이다. */
  | { state: 'unknown-format' }
  /** 찾았다. `at` 은 그 발화의 시각(레코드 timestamp). 없으면 null. */
  | { state: 'text'; text: string; at: number | null }

/**
 * 진행 중인 도구 한 자리 (LIFE-366 B9, 수정 라운드 5).
 *
 * Orca 는 이 값을 훅에서 받지만(`agent-row-tool-preview.ts` 의 `toolName`·`toolInput`),
 * corral 은 herdr 통합이 `message` 를 안 부르므로(`00-analysis.md` §2.3) **트랜스크립트의
 * 마지막 어시스턴트 턴**에서 읽는다. `input` 은 관측된 키에서 고른 한 줄 미리보기다 —
 * 없으면 null 이고, 그때 화면은 도구 이름만 쓴다.
 */
export type SessionTool = { name: string; input: string | null }

/**
 * 트랜스크립트에서 읽어 낸 한 세션의 지문 — 2차 줄·제목 티어·경과 시간이 전부 여기서 나온다.
 * herdr 를 모르는 층이 만든다 (`main/transcript.ts`, `main/git-status.ts` 와 같은 결).
 */
export type SessionDigest = {
  activity: SessionActivity
  /**
   * provider 가 스스로 붙인 세션 제목 (claude 의 `ai-title` 레코드). 없으면 null.
   * **그 세션의 것임이 확인된 값만** 들어온다 (기준 C2) — 레코드의 `sessionId` 가 참조 id 와
   * 다르면 버린다.
   */
  providerTitle: string | null
  /**
   * **세션의 첫 사용자 발화**를 40자로 정제한 것 (C5, 수정 라운드 5). 없으면 null.
   *
   * 제목 티어에서 `ai-title` **아래**, 터미널 제목 **위**다 (C1′ — Orca `aiVaultTitle` 4단이
   * 라이브 제목 6단보다 위인 것과 같은 자리). 첫 발화는 세션 내내 안 바뀌므로 파일이 자라도
   * **한 번 읽어 캐시**한다 (C6).
   */
  firstPrompt: string | null
  /**
   * 마지막 어시스턴트 턴이 **도구 호출뿐일 때** 그 도구 (B9). 텍스트가 있는 턴이면 null.
   * 화면에 쓸지는 **그 pane 의 상태가 `working` 인지**가 정한다 — 판독층은 상태를 모른다.
   */
  tool: SessionTool | null
  /**
   * 마지막 활동 시각 (epoch ms). 트랜스크립트 레코드의 timestamp, 없으면 파일 mtime.
   * **렌더러가 그 행을 처음 본 시각이 아니다** — 09-gate1-fix.md E 가 지웠던 결함이 그것이었다.
   */
  lastActivityAt: number | null
}

/** 아무것도 못 읽은 상태의 지문. 셸 탭·통합 미설치가 여기 선다. */
export const EMPTY_SESSION_DIGEST: SessionDigest = {
  activity: { state: 'none' },
  providerTitle: null,
  firstPrompt: null,
  tool: null,
  lastActivityAt: null,
}

export type TabRow = {
  tabId: string
  workspaceId: string
  label: string
  /** herdr 가 붙인 표찰. **순서가 아니다** — 탭을 옮겨도 안 바뀐다 (수정 1회차 M5 실측). */
  number: number
  /** 목록에서의 자리. 화면은 이 순서로 그린다. */
  order: number
  agentStatus: AgentStatus
  focused: boolean
  panes: PaneRow[]
  /** 이 탭의 세션 지문 (LIFE-366). 읽을 게 없으면 `EMPTY_SESSION_DIGEST` 와 같은 모양이다. */
  digest: SessionDigest
}

export type WorkspaceRow = {
  workspaceId: string
  label: string
  number: number
  agentStatus: AgentStatus
  focused: boolean
  tabs: TabRow[]
}

/**
 * worktree 하나의 git 상태 요약 (LIFE-357 C4). `git status --porcelain=v2 --branch` 파싱 결과다 —
 * herdr 를 모른다(경계 규칙, 이 파일 맨 위 주석). ahead·behind 는 업스트림이 없으면 null.
 */
export type GitStatusSummary = {
  branch: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  dirty: boolean
  /** git 실행 자체가 실패했을 때만 채워진다 — worktree 줄은 그래도 보인다(레포 error 필드와 같은 결). */
  error: string | null
}

/** 한 worktree(체크아웃 한 벌). 구조는 git, 열림상태는 herdr 에서 온다 (기준 N4ⓒ). */
export type WorktreeRow = {
  path: string
  branch: string | null
  /** 링크된 worktree 인가 (아니면 레포의 주 체크아웃). */
  isLinked: boolean
  /** herdr `worktree.list` 가 준 열린 workspace. 닫혀 있으면 null. */
  openWorkspaceId: string | null
  /** 열려 있으면 그 workspace 의 행. 닫혀 있으면 null — 그래도 worktree 줄은 보인다. */
  workspace: WorkspaceRow | null
  /** git 상태 배지 (LIFE-357 C4) — TTL 캐시로 계산한다 (main/git-status.ts). */
  gitStatus: GitStatusSummary
}

/** 레지스트리에 등록된 레포 하나. **목록의 루트는 이것이다** (기준 N4). */
export type RepoRow = {
  /** 레지스트리가 소유하는 유일한 영속 값 — 레포 루트 경로 (기준 N3). */
  root: string
  name: string
  /** git·herdr 조회가 실패했으면 그 사유. 레포 줄 자체는 사라지지 않는다. */
  error: string | null
  worktrees: WorktreeRow[]
}

export type RegistryState = {
  /** 레지스트리 파일이 실제로 어디 있나 — A2 의 근거이자 격리 확인용. */
  file: string
  roots: string[]
  lastError: string | null
}

// --- 라이프사이클 (R3 — LIFE-356) --------------------------------------------

/**
 * 행 생성 시 고르는 종류. **corral 의 enum 이다** — 값이 herdr `kind` 문자열과 겹치지만
 * 옮기는 것은 어댑터가 한다 (`shell` 은 agent.start 를 안 부른다는 뜻의 corral 값).
 */
export type AgentKind = 'claude' | 'codex' | 'grok' | 'shell'

/** 세션 지문을 읽을 수 있는 에이전트 — `AgentKind` 에서 `shell` 을 뺀 것. */
export type TranscriptAgent = 'claude' | 'codex' | 'grok'

/**
 * herdr 통합 훅이 그 에이전트에 깔려 있나 (LIFE-366 A1·B8).
 *
 * 이 값이 `not-installed` 이면 `agentSession` 이 영영 안 오고, 그러면 2차 줄도 못 채운다.
 * 화면이 조용히 빈 줄을 보이면 사용자는 **고장으로 읽는다** — 그래서 이 사실을 올려 보낸다.
 * 설치하는 것은 herdr 가 할 일이고 corral 은 상태만 읽는다 (`00-analysis.md` §2.2 — 뒤집힌 전제).
 */
export type IntegrationRow = {
  agent: TranscriptAgent
  state: 'not-installed' | 'current' | 'outdated'
}

/**
 * 행 생성 결과 (L1·L2). `tab.create` → (셸이 아니면) `agent.start` 재시도.
 * 성공은 "걸었다"(launch_pending)까지다 — 기동 판정은 store 의 상태 칩이 뒤이어 반영한다.
 */
export type CreateRowResult = {
  ok: boolean
  paneId: string | null
  tabId: string | null
  /** `agent_pane_busy` 를 corral 이 흡수한 재시도 횟수 (L2 의 화면 근거). */
  retries: number
  error: string | null
}

/**
 * 행 종료 결과 (L3·L4·L9a). **판별자는 herdr `pane.process_info` 다** (관문 ⑤) —
 * 포그라운드 프로세스 그룹이 셸 pid 와 같으면 잃을 게 없다(즉시 닫힘), 다르면 확인.
 * `confirmed:true` 로 다시 부르면 확인 걸음을 건너뛴다.
 *
 * discriminated union — 화면은 `outcome` 으로 갈래를 정한다:
 *   · closed        — 닫혔다
 *   · needs-confirm — 산 프로세스가 있다. 모달을 띄우고 `foreground` 를 보인다
 *   · rejected      — herdr 가 그룹 닫기를 거절했다 (L9a). **그대로 보이고 멈춘다**
 *   · error         — 그 밖의 실패
 */
export type CloseRowResult =
  | { outcome: 'closed' }
  | { outcome: 'needs-confirm'; foreground: string[] }
  | { outcome: 'rejected'; rejection: { code: string; message: string } }
  | { outcome: 'error'; error: string }

/**
 * 탭 이름 변경 결과 (LIFE-357 I-7). 종료 게이트가 없으니 `needs-confirm` 이 없다 —
 * 이름은 잃을 게 없는 조작이다. herdr 거절은 **그대로** 올라온다(승격 금지, `closeRow` 와 같은 기준).
 */
export type RenameRowResult =
  | { outcome: 'renamed' }
  | { outcome: 'rejected'; rejection: { code: string; message: string } }
  | { outcome: 'error'; error: string }

/**
 * worktree/workspace 열기·만들기 결과 (L6·L7·L8).
 * `rejection` 은 herdr 가 그대로 돌려준 거절(예 `workspace_group_close_required`,
 * `linked_worktree_source`) — 화면에 그대로 보인다. corral 이 승격하지 않는다 (기준 L9).
 */
export type WorktreeActionResult = {
  ok: boolean
  workspaceId: string | null
  rejection: { code: string; message: string } | null
  error: string | null
  /**
   * 양성 중복 — 이미 여는 중이라 이 호출이 아무것도 안 했다 (수정 2회차 F-2). 렌더러는 이걸
   * 보고 알림을 띄우지 않는다 (문자열 비교 대신 필드로 판별 — 문구가 바뀌어도 안 깨진다).
   */
  deduped?: boolean
  /**
   * linked worktree 를 열며 부모(주 체크아웃) workspace 를 **이 호출이 함께 열었다** (게이트 ① G4).
   * herdr `worktree.open` 은 부모가 열려 있어야 하는 제약(P3) 때문에 부모가 딸려 열린다 — 그 사실을
   * 화면에 한 줄 알린다 (탭을 숨기지 않는다 = 상태 왜곡 금지, 기준 N8). 이미 열려 있었으면 false.
   */
  parentOpened?: boolean
}

export type AddRepoResult = { ok: boolean; root?: string; error?: string }

/**
 * 레포 하나를 목록에서 뺀 결과 (게이트 ① 3번째 지시, 2026-09-12).
 *
 * 빼는 것은 **corral 레지스트리의 그 줄 하나**뿐이다. 디스크의 폴더도, herdr 세션도 건드리지
 * 않는다 — 그래서 여기 돌려줄 것도 "어느 루트가 빠졌나" 하나로 족하다.
 */
export type RemoveRepoResult = { ok: boolean; root?: string; error?: string }

/**
 * 「폴더 찾아보기」 한 번의 결과 (게이트 ① 2번째 지시, 2026-09-12).
 *
 * 고른 폴더 하나가 여러 줄이 될 수 있어서 목록으로 돌려준다 — 레포가 많은 폴더를 고르면
 * **바로 아래 1단계 자식** 중 git 레포를 전부 넣는다. 화면이 "몇 개 넣었나" 를 말하려면
 * 넣은 것·이미 있던 것·실패한 것이 갈려 있어야 한다. 그래서 셋을 따로 싣는다.
 *
 * `canceled` 는 실패가 아니다 — 사용자가 네이티브 다이얼로그를 그냥 닫은 것이고,
 * 그때 화면은 아무 말도 하지 않는다.
 */
export type BrowseReposResult = {
  ok: boolean
  canceled: boolean
  /** 사용자가 고른 폴더. 취소면 null. */
  selected: string | null
  /** 고른 폴더 자체가 레포였나(`repo`), 아니면 자식을 훑었나(`scan`). 취소면 null. */
  mode: 'repo' | 'scan' | null
  /** 이번에 새로 들어간 레포 루트. */
  added: string[]
  /** 이미 레지스트리에 있던 것 — "0개 등록" 과 구분해야 안내가 안 거짓말한다. */
  alreadyRegistered: string[]
  failed: Array<{ path: string; error: string }>
  /** 화면에 그대로 띄우는 한 줄. 취소면 null. */
  message: string | null
}

// --- 화면 UI 상태 영속 (LIFE-357 C2·C3) --------------------------------------

/**
 * 사이드바 폭·접힘 상태 (main/ui-prefs.ts 가 파일로 영속). `localStorage` 가 아니라 IPC 로
 * main 에 저장한다 — 프로덕션 빌드(file:// 렌더러)에서 LocalStorage 커밋이 디스크에 반영되지
 * 않는 현상을 실측했다(ui-prefs.ts 주석 참고). `collapsedRepos`는 레포 루트 목록,
 * `collapsedGroups`는 AgentGroupHeader 가 접힌 worktree 경로 목록 — 접힌 것만 담는다(기본은 펼침).
 */
/**
 * 폴백 번호 배정 한 칸 (LIFE-366 C13, 수정 라운드 8) — `terminal N`·`claude N` 의 N.
 *
 * Orca 는 이 값을 `tab.defaultTitle` 에 저장한다. corral 은 herdr `tab.label` 에 **쓰면 안 되므로**
 * (`userLabel` 이 사용자 이름으로 읽어 G5 가 되살아난다) 화면 영속 파일에 싣는다.
 */
export type TabOrdinal = { tabId: string; groupId: string; ordinal: number }

export type UiPrefs = {
  sidebarWidth: number | null
  collapsedRepos: string[]
  collapsedGroups: string[]
  /** 폴백 번호 배정표 (C13) — 재기동해도 같은 탭이 같은 번호를 쓴다. */
  tabOrdinals: TabOrdinal[]
  /**
   * worktree 별 영역 배치 (LIFE-373 F1-6 · R3-h). 모양은 렌더러 `group-tree.ts` 가 안다 —
   * 여기서는 실어 나르기만 하므로 `unknown[]` 이다(저장소가 트리 모양을 또 알면 두 진실이 된다).
   */
  groupLayouts: unknown[]
}

// --- 터미널 스트림 (R2 — LIFE-353) -------------------------------------------

/** 스트림 링크가 지금 어느 걸음에 있나. link 의 LinkPhase 와 별개다 — 소켓이 다르다. */
export type TerminalPhase = 'idle' | 'connecting' | 'streaming' | 'failed'

export type TerminalState = {
  /** 지금 스트리밍 중(또는 시도 중)인 pane. 없으면 null. */
  paneId: string | null
  phase: TerminalPhase
  /** 마지막 프레임의 크기 (crop 결과 = pane 내용 영역). 아직 없으면 null. */
  cols: number | null
  rows: number | null
  /** 마지막 프레임 기준 — 이 pane 의 앱이 마우스를 받겠다고 했나. */
  mouseReporting: boolean
  lastError: string | null
}

/**
 * 터미널 프레임 하나 — main → renderer 로 미는 페이로드.
 *
 * `data` 는 ANSI 바이트다 (전체 리페인트, DEC 2026 BSU/ESU 로 감쌈 — 어댑터가 만든
 * **corral 의 표현**이고 herdr 와이어 모양이 아니다). Uint8Array 로 보낸다 —
 * structured clone 이 복사 없이 나르고, base64 왕복이 없다.
 */
export type TerminalFrame = {
  paneId: string
  seq: number
  cols: number
  rows: number
  mouseReporting: boolean
  data: Uint8Array
}

/** renderer → main 스크롤 요청. 좌표는 pane 내용 영역 기준 0-기반 셀. */
export type TerminalScroll = {
  direction: 'up' | 'down'
  lines: number
  column: number | null
  row: number | null
}

/** pane 리사이즈·이웃 이동의 방향. */
export type PaneDirection = 'left' | 'right' | 'up' | 'down'

/** **분할**의 방향은 둘뿐이다 — herdr 스키마 `SplitDirection` 에 좌/상 분할이 없다. */
export type PaneSplitDirection = 'right' | 'down'

/** pane 조작 결과 — 실패는 화면에 문구로 뜬다 (herdr 응답을 그대로 흘리지 않는다). */
export type PaneActionResult = { ok: true } | { ok: false; error: string }

/** 이웃 찾기 결과 — 포커스 이동은 렌더러가 한다 (선택 pane 의 주인이 렌더러라서). */
export type PaneNeighborResult = { ok: true; paneId: string | null } | { ok: false; error: string }

/** 셀 좌표 사각형 — 탭 격자(=한 연결이 받는 서피스) 기준. */
export type TerminalCellRect = { x: number; y: number; width: number; height: number }

/**
 * 영역이 붙은 탭 안 pane 하나의 기하 (LIFE-373 ②).
 *
 * **셀 단위**다. 렌더러는 이 값에 바닥 셀 크기를 곱해 pane DOM 상자를 만든다 — 픽셀에서
 * cols 를 되짚는 반대 방향은 쓰지 않는다 (§10-R13: herdr rect → DOM 이 진실 방향).
 */
export type TerminalPaneView = {
  paneId: string
  /** 장식(테두리·스크롤바) 포함 바깥 사각형. */
  rect: TerminalCellRect
  /** 내용만 — xterm 에 실리는 범위. */
  innerRect: TerminalCellRect
  focused: boolean
  mouseReporting: boolean
}

/** 영역 하나 = endpoint 연결 하나의 상태 (main → renderer). */
export type TerminalGroupState = {
  groupId: string
  /** 이 연결이 붙어 있는 탭. 아직 안 붙었으면 null. */
  tabId: string | null
  phase: TerminalPhase
  /** 마지막으로 요청한 탭 격자. */
  grid: { cols: number; rows: number } | null
  panes: TerminalPaneView[]
  /** 줌 중인 pane (클라이언트가 그린다 — 서버 rect 는 안 바뀐다). */
  zoomedPaneId: string | null
  lastError: string | null
}

/**
 * 렌더러가 선언하는 영역 구성 (renderer → main).
 *
 * 명령이 아니라 **선언**이다 — main 이 현재 연결과 대조해 열고·닫고·탭을 옮기고·격자를 맞춘다.
 * 부팅 복원·재접속·worktree 전환이 전부 이 한 길로 들어와 attach 순서(S2-b)가 한 곳에서 지켜진다.
 */
export type TerminalGroupRequest = {
  groupId: string
  tabId: string
  /** 이 탭에서 활성인 pane — attach 의 `pane.focus` 대상. */
  activePaneId: string
  /** 영역 상자가 정한 탭 격자 (셀). */
  cols: number
  rows: number
  /** 활성 영역인가 — attach 순서에서 **마지막**에 붙는다 (S2-b). */
  active: boolean
}

export type AppState = {
  revision: number
  sessions: SessionInfo[]
  sessionsError: string | null
  selectedSession: string | null
  /** 세션을 왜 그것으로 골랐나 / 왜 못 골랐나 (수정 1회차 M6). 평시에는 null. */
  sessionNote: string | null
  link: LinkState
  registry: RegistryState
  repos: RepoRow[]
  terminal: TerminalState
  /**
   * 영역별 스트림 상태 (LIFE-373). `terminal` 은 그중 **포커스 pane** 하나를 추린 것이라
   * LIFE-353 의 단일 pane 계약이 그대로 산다 (§10-R5).
   */
  terminalGroups: TerminalGroupState[]
  /**
   * herdr 통합 설치 상태 3종 (LIFE-366 A1). 아직 못 읽었으면 빈 배열 —
   * 화면은 "미설치" 와 "아직 모름" 을 구분해야 하므로 빈 배열을 미설치로 읽지 않는다.
   */
  integrations: IntegrationRow[]
  /** 개발·계측 실행에서만 켜지는 진단 표시. */
  diagnostics: boolean
  /**
   * 이 프로세스의 홈 디렉터리 (LIFE-366 C9, 수정 라운드 7).
   *
   * 셸 탭 폴백이 **홈 상대 경로**(`~/…`)를 잘라 쓰는데, 렌더러에는 `HOME` 을 알 길이 없다
   * (`os` 를 못 쓴다 — 경계 규칙). 그래서 main 이 자기 값을 한 번 실어 보낸다. 계측 실행은
   * 격리 HOME 으로 앱을 띄우므로 이 값도 그 격리 HOME 이다 — 화면이 사용자 홈을 가정하면
   * 격리 실행에서 접히지 않는다.
   */
  home: string
}

/** preload 가 렌더러에 노출하는 표면. 여기 없는 것은 렌더러가 부를 수 없다. */
export type CorralApi = {
  getState: () => Promise<AppState>
  onState: (listener: (state: AppState) => void) => () => void
  addRepo: (root: string) => Promise<AddRepoResult>
  removeRepo: (root: string) => Promise<RemoveRepoResult>
  browseForRepos: () => Promise<BrowseReposResult>
  refreshSessions: () => Promise<void>
  // --- 화면 UI 상태 영속 (C2·C3) ---
  getUiPrefs: () => Promise<UiPrefs>
  setUiPrefs: (patch: Partial<UiPrefs>) => void
  // --- 라이프사이클 (R3) ---
  /** 열린 workspace 에 새 행을 만든다 (tab.create → agent.start 재시도). */
  createRow: (input: { workspaceId: string; kind: AgentKind }) => Promise<CreateRowResult>
  /** 행(탭)을 닫는다. 판별자는 herdr process_info. `confirmed` 면 확인 걸음을 건너뛴다. */
  closeRow: (input: { tabId: string; confirmed?: boolean }) => Promise<CloseRowResult>
  /**
   * 탭 이름을 사용자가 준 이름으로 바꾼다 (I-7). herdr `tab.rename` 한 번 — corral 은 이름을
   * 따로 저장하지 않는다(herdr 가 들고 있고 재기동해도 남는다).
   */
  renameRow: (input: { tabId: string; label: string }) => Promise<RenameRowResult>
  /** 열린 worktree(=workspace)를 닫는다 (L9b). 그룹 열린 primary 면 herdr 가 거절 → 그대로 보인다. */
  closeWorktree: (input: { workspaceId: string; confirmed?: boolean }) => Promise<CloseRowResult>
  /** 닫힌 worktree 행을 연다. 주 체크아웃(isLinked=false)은 workspace.create, linked 는 worktree.open. */
  openWorktree: (input: { repoRoot: string; path: string; isLinked: boolean }) => Promise<WorktreeActionResult>
  /** 새 linked worktree 를 만든다 (branch·path 지정). OS 다이얼로그 없이 텍스트 입력으로. */
  createWorktree: (input: { repoRoot: string; branch: string; path: string }) => Promise<WorktreeActionResult>
  reportRendered: (revision: number) => void
  /**
   * pane 하나를 골라 스트림을 연다. paneId null 이면 닫는다. 결과는 state.terminal 로 돌아온다.
   * cols·rows 는 렌더러가 잰 터미널 영역 크기 — 첫 연결이 맞는 크기로 뜨게 한다 (없으면 80×24).
   */
  selectPane: (input: { paneId: string | null; cols?: number; rows?: number }) => Promise<void>
  /**
   * 영역 구성을 선언한다 (LIFE-373). main 이 현재 연결과 대조해 열고·닫고·탭을 옮기고·격자를 맞춘다.
   * 빈 배열이면 연결을 전부 닫는다.
   */
  syncTermGroups: (groups: TerminalGroupRequest[]) => void
  /**
   * xterm onData 그대로 — 키·마우스 리포트·붙여넣기 전부 이 한 길이다.
   * **어느 pane 인지 실어 보낸다**: 붙은 탭 밖 pane 이면 herdr 가 조용히 버리므로 main 이 막는다 (S1).
   */
  termInput: (input: { paneId: string; data: string }) => void
  /** 영역 상자가 정한 **탭 격자**를 1회 요청한다 (pane 단위가 아니다 — §10-R13). */
  termScroll: (input: { paneId: string } & TerminalScroll) => void
  /** 줌 — paneId null 이면 해제. 그리는 건 클라이언트, 격자만 역산해 요청한다 (F2-3). */
  termZoom: (input: { groupId: string; paneId: string | null; cols: number; rows: number }) => void
  // --- pane 분할 (② — herdr 소유) ---
  /** `pane.split`. 클라이언트가 트리를 발명하지 않는다 (F2-1). */
  /** 새 xterm 이 붙었을 때 마지막 화면을 다시 받는다 (S6). 서버에는 아무것도 안 보낸다. */
  repaintPane: (input: { paneId: string }) => Promise<void>
  splitPane: (input: { paneId: string; direction: PaneSplitDirection; ratio?: number }) => Promise<PaneActionResult>
  /** `pane.resize` — `amount` 는 **비율 델타**다(셀이 아니다). 드래그 끝에 1회만 부른다 (F2-2). */
  resizePane: (input: { paneId: string; direction: PaneDirection; amount: number }) => Promise<PaneActionResult>
  /** `pane.close`. 마지막 pane 이면 탭이 닫힌다 (F2-5). */
  closePane: (input: { paneId: string }) => Promise<PaneActionResult>
  /** `pane.focus_direction` — 인접 pane 포커스 이동은 서버가 정한다 (F2-4). */
  focusPaneDirection: (input: { paneId: string; direction: PaneDirection }) => Promise<PaneNeighborResult>
  onTermFrame: (listener: (frame: TerminalFrame) => void) => () => void
  preloadEnv: { sandboxed: boolean; contextIsolated: boolean; exposedMethods: string[] }
}
