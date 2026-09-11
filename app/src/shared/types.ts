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
  /** 계측용 — push 를 일부러 버리고 있나 (N7 유실 주입). 평시에는 false. */
  droppingPush: boolean
  /**
   * 유실 주입을 **일부 이벤트에만** 걸었을 때 그 목록 (계측 전용, 수정 2회차 H-1 재측정).
   * `null` 이면 전부 버린다. "corral 이 일부를 모르는 상태" 를 실제 앱에서 만들려면
   * 전부가 아니라 **고른 이벤트만** 새어 나가게 해야 한다.
   */
  dropPushOnly: string[] | null
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

/**
 * 레지스트리에 없는 레포에서 열린 workspace.
 *
 * 목록의 루트는 레지스트리지만(N4), 등록 안 된 workspace 를 **조용히 숨기지는 않는다** —
 * 숨기면 목록이 herdr 와 어긋난 채로 "맞다" 고 말하게 된다 (N5 가 재는 것이 그 어긋남이다).
 * 평시에는 비어 있는 칸이고, 차 있으면 "등록하라" 는 신호다.
 */
export type UnregisteredGroup = {
  workspaces: WorkspaceRow[]
}

export type RegistryState = {
  /** 레지스트리 파일이 실제로 어디 있나 — A2 의 근거이자 격리 확인용. */
  file: string
  roots: string[]
  lastError: string | null
}

export type AddRepoResult = { ok: boolean; root?: string; error?: string }

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
  unregistered: UnregisteredGroup
  /** 개발·계측 실행에서만 켜지는 진단 표시. */
  diagnostics: boolean
}

/** preload 가 렌더러에 노출하는 표면. 여기 없는 것은 렌더러가 부를 수 없다. */
export type CorralApi = {
  getState: () => Promise<AppState>
  onState: (listener: (state: AppState) => void) => () => void
  addRepo: (root: string) => Promise<AddRepoResult>
  refreshSessions: () => Promise<void>
  reportRendered: (revision: number) => void
  preloadEnv: { sandboxed: boolean; contextIsolated: boolean; exposedMethods: string[] }
}
