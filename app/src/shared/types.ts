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

export type RegistryState = {
  /** 레지스트리 파일이 실제로 어디 있나 — A2 의 근거이자 격리 확인용. */
  file: string
  roots: string[]
  lastError: string | null
}

export type AddRepoResult = { ok: boolean; root?: string; error?: string }

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
  /** 개발·계측 실행에서만 켜지는 진단 표시. */
  diagnostics: boolean
}

/** preload 가 렌더러에 노출하는 표면. 여기 없는 것은 렌더러가 부를 수 없다. */
export type CorralApi = {
  getState: () => Promise<AppState>
  onState: (listener: (state: AppState) => void) => () => void
  addRepo: (root: string) => Promise<AddRepoResult>
  browseForRepos: () => Promise<BrowseReposResult>
  refreshSessions: () => Promise<void>
  reportRendered: (revision: number) => void
  preloadEnv: { sandboxed: boolean; contextIsolated: boolean; exposedMethods: string[] }
}
