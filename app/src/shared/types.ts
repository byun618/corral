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

export type PaneRow = {
  paneId: string
  tabId: string
  workspaceId: string
  title: string
  agent: string | null
  agentStatus: AgentStatus
  cwd: string | null
  focused: boolean
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
export type UiPrefs = {
  sidebarWidth: number | null
  collapsedRepos: string[]
  collapsedGroups: string[]
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
  /** 개발·계측 실행에서만 켜지는 진단 표시. */
  diagnostics: boolean
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
  /** xterm onData 그대로 — 키·마우스 리포트·붙여넣기 전부 이 한 길이다. */
  termInput: (data: string) => void
  termResize: (size: { cols: number; rows: number }) => void
  termScroll: (scroll: TerminalScroll) => void
  onTermFrame: (listener: (frame: TerminalFrame) => void) => () => void
  preloadEnv: { sandboxed: boolean; contextIsolated: boolean; exposedMethods: string[] }
}
