// main ↔ preload ↔ renderer 가 함께 쓰는 타입. 런타임 코드를 넣지 않는다 (렌더러는 sandbox 안).

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

/** `herdr session list --json` 한 줄. 세션 층이 주는 필드가 전부다 — 상태·에이전트 정보는 없다. */
export type SessionInfo = {
  name: string
  isDefault: boolean
  running: boolean
  sessionDir: string
  socketPath: string
}

/** 잎 = pane. Step 2 ② 의 터미널이 붙을 단위이자 **선택 대상**이다. */
export type PaneRow = {
  paneId: string
  workspaceId: string
  tabId: string
  title: string
  agent: string | null
  agentStatus: AgentStatus
  cwd: string | null
  focused: boolean
  /**
   * L7 — corral 이 이 pane 의 변화를 마지막으로 본 시각(epoch ms). herdr 는 pane 에 타임스탬프를
   * 주지 않는다. **모르면 null 이고, 화면은 아무것도 안 쓴다** — 0초로 적지 않는다.
   */
  changedAt: number | null
}

/**
 * tab 층. **Orca 의 터미널 한 줄에 해당한다** — Orca 실측(`00-orca-terminal-list.json`)에서
 * `tabId`·`leafId` 가 herdr 의 tab·pane 과 1:1 이고, 지금 사용자 화면은 탭마다 leaf 가 하나라
 * 그 층이 접혀 보인다. 그래서 pane 은 **스플릿이 있을 때만** 아래로 펼친다 (기준 L2).
 */
export type TabRow = {
  tabId: string
  workspaceId: string
  label: string
  number: number
  agentStatus: AgentStatus
  focused: boolean
  /** 스냅샷이 준 카운터. 우리가 맵에서 센 수(`panes.length`)와 다를 수 있어 그대로 싣는다 */
  snapshotPaneCount: number | null
  panes: PaneRow[]
}

/** 가운데 층 = herdr workspace (00-analysis.md §3 결정). 그 아래 tab, 그 아래(조건부) pane. */
export type WorkspaceRow = {
  workspaceId: string
  label: string
  number: number
  paneCount: number
  tabCount: number
  agentStatus: AgentStatus
  focused: boolean
  /** 맨 위 층 = repo. worktree.list 로 얻는다 (스냅샷의 workspace.worktree 는 대부분 비어 있다). */
  repoName: string | null
  repoRoot: string | null
  branch: string | null
  isLinkedWorktree: boolean | null
  repoSource: 'snapshot' | 'worktree.list' | 'none'
  /** 이 workspace 가 열고 있는 checkout 경로 — worktree 행과 짝짓는 열쇠다 */
  checkoutPath: string | null
  tabs: TabRow[]
  /** workspace 안 pane 전부 (평평한 목록). 탭 구조와 별개로 계측·선택 검사에 쓴다 */
  panes: PaneRow[]
}

/**
 * repo 아래 worktree 한 줄. **herdr 에 workspace 가 안 열린 것도 포함한다** (기준 L2r) —
 * `worktree.list` 응답이 그 repo 의 worktree 를 전부 주는데 1회차는 하나만 쓰고 버렸다.
 */
export type WorktreeRow = {
  path: string
  branch: string | null
  label: string | null
  isLinkedWorktree: boolean
  /** 열려 있으면 그 workspace id. 우리가 들고 있는 workspace 와 경로로 맞춰 정한다 */
  openWorkspaceId: string | null
}

/** 맨 위 층 = repo. 열린 workspace 가 하나도 없는 repo 는 아예 나오지 않는다 (의도된 동작). */
export type RepoGroupRow = {
  key: string
  repoName: string | null
  repoRoot: string | null
  worktrees: WorktreeRow[]
  /** 이 repo 에 속하는 열린 workspace. worktree 와 못 짝지은 것은 여기에만 남는다 */
  workspaces: WorkspaceRow[]
}

/**
 * 소켓 계층의 상태 기계. 부트스트랩 순서가 그대로 상태 이름이 된다
 * (01-criteria.md K1: 구독 → ack → 버퍼링 → snapshot → 버퍼 적용).
 */
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
  socketPath: string | null
  attempt: number
  /** 다음 재시도까지 남은 지연(ms). 재연결 중이 아니면 null. */
  nextRetryInMs: number | null
  lastError: string | null
  /** 마지막으로 push 를 받은 시각(ms epoch). */
  lastPushAt: number | null
  bufferedAtSnapshot: number | null
}

export type AppState = {
  revision: number
  sessions: SessionInfo[]
  sessionsError: string | null
  selectedSession: string | null
  link: LinkState
  workspaces: WorkspaceRow[]
  /** 화면 왼쪽 트리의 실제 모양 — repo → worktree → workspace → tab → (조건부) pane */
  repos: RepoGroupRow[]
  /** 선택 대상은 pane 이다 (기준 L2). */
  selectedPaneId: string | null
  /** L8 — 접어 둔 workspace. **corral 로컬 상태**다 (herdr 에 저장하지 않는다). */
  collapsedWorkspaceIds: string[]
  /** 진단 UI(S3 프로브)를 띄우는 실행인가 — 패키징된 앱이거나 계측이 아니면 false. */
  diagnostics: boolean
  /** LIFE-345 — 선택한 pane 의 터미널 표면 상태. */
  terminal: TerminalState
  /** LIFE-346 — 진행 중이거나 실패한 생성·종료. 화면은 이걸 보고 "기동 중" 을 그린다. */
  lifecycle: LifecycleState
  /** LIFE-346 — UI 가 고르게 하는 시작 커맨드 4종. main 이 진실을 들고 있다 */
  launchKinds: string[]
}

/** preload 가 contextBridge 로 노출하는 채널별 메서드. ipcRenderer 를 통째로 넘기지 않는다. */
export type CorralApi = {
  getState: () => Promise<AppState>
  onState: (listener: (state: AppState) => void) => () => void
  selectSession: (name: string) => Promise<void>
  selectPane: (paneId: string | null) => Promise<void>
  /** L8 — worktree 의 세션 묶음을 접거나 편다. */
  toggleCollapse: (workspaceId: string) => Promise<void>
  refreshSessions: () => Promise<void>
  /** 렌더러가 실제로 그린 시점을 main 로그에 남긴다 (L3 의 "반영 시각"). */
  reportRendered: (revision: number) => void
  /** LIFE-345 — 재생 프레임 구독. main 이 만든 바이트를 그대로 `term.write()` 한다. */
  onTerminalFrame: (listener: (frame: TerminalFrame) => void) => () => void
  /** 사용자가 친 글자 (`pane.send_text`). 로컬 에코 없음 — herdr 를 돌아와야 보인다. */
  sendPaneText: (text: string) => Promise<{ ok: boolean; error?: string }>
  /** 특수키 (`pane.send_keys`). 이름으로 보낸다 — 모드를 아는 쪽은 herdr 다. */
  sendPaneKeys: (keys: string[]) => Promise<{ ok: boolean; error?: string }>
  /** LIFE-346 — 새 행. `kind` 가 `shell` 이면 `agent.start` 를 부르지 않는다. */
  createRow: (input: { workspaceId: string; kind: string; label: string | null }) => Promise<{
    ok: boolean
    launchId: string
    error?: string
  }>
  /** LIFE-346 — 행 종료. 에이전트가 도는 탭은 `confirmed:true` 없이는 아무것도 보내지 않는다 */
  closeRow: (input: { tabId: string; confirmed: boolean }) => Promise<CloseOutcome>
  /** 끝난 기동 기록 털기 — 탭이 안 만들어진 실패의 유일한 손잡이다 (1차 리뷰 중간 1). */
  dismissLaunch: (launchId: string) => Promise<boolean>
  /** S3 근거용 — 렌더러 컨텍스트에서 실제로 무엇이 막혀 있는지 main 로그에 남긴다. */
  reportProbe: (name: string, detail: Record<string, string>) => void
  /** preload 가 자기 컨텍스트에서 관측한 값 (S3). */
  preloadEnv: { sandboxed: boolean; contextIsolated: boolean; exposedMethods: string[] }
}

// ---------------------------------------------------------------------------
// LIFE-345 — 터미널 뷰 + 입력
// ---------------------------------------------------------------------------

/**
 * 터미널 격자. **herdr 것이고 corral 이 맞춰 그린다** — `pane.resize` 는 목표 cols×rows 를
 * 못 받고(스키마 102개 메서드 중 없음), `PaneReadResult` 에도 격자가 없다 (분석 §4-ⓐ·ⓓ).
 *
 * - `rows` 는 `PaneInfo.scroll.viewport_rows` 다. 실측에서 `stty` 의 행 수와 일치했다
 * - `cols` 는 **API 어디에도 없다.** `pane.layout` 의 rect 는 herdr 창의 배치 기하이고
 *   PTY 크기와 어긋난다 (실측: 스플릿 뒤 rect 60/60 인데 PTY 는 119/120).
 *   그래서 스냅샷에서 관측한 최대 행 폭을 바닥으로 삼고 layout 을 힌트로만 쓴다 —
 *   `source` 가 어느 쪽인지 말해 준다
 */
export type PaneGrid = {
  cols: number
  rows: number
  source: 'observed' | 'layout' | 'default'
  /** `pane.layout` 이 말한 폭 (참고값 — PTY 폭과 다를 수 있다) */
  layoutCols: number | null
  /** 스냅샷에서 실제로 본 최대 행 폭 */
  observedCols: number
}

/** 렌더러가 그대로 `term.write()` 할 바이트열. 만드는 곳은 main 이다 (로그에 그대로 남는다). */
export type TerminalFrame = {
  paneId: string
  /** pane 전환 세대. 렌더러는 자기가 아는 세대와 다르면 버린다 (LIFE-344 R3 와 같은 자리) */
  generation: number
  seq: number
  /** `attach` = 화면 초기화 + 스크롤백 씨앗, `screen` = 주기 재생 한 장 */
  kind: 'attach' | 'seed' | 'screen'
  bytes: string
  grid: PaneGrid
  /** 이 프레임을 부른 이유 — R1 정책의 트리거 이름이 그대로 들어간다 */
  reason: TerminalReadReason
  /** 이 프레임이 실린 스냅샷의 revision (`pane.read` 의 것 — 실측상 잘 안 움직인다) */
  revision: number | null
  at: number
}

export type TerminalReadReason =
  | 'attach'
  | 'event'
  | 'heartbeat'
  | 'input'
  | 'relive'
  | 'resize'
  | 'manual'

/** 터미널 표면의 상태. 죽은 pane 을 산 것처럼 그리지 않기 위한 것이 절반이다 (R5). */
export type TerminalState = {
  paneId: string | null
  generation: number
  grid: PaneGrid | null
  /** pane 이 살아 있나. `pane_closed`·`pane_exited` 를 보면 false 로 떨어지고 입력을 막는다 */
  alive: boolean
  /** 죽었다면 왜 */
  deadReason: string | null
  /** 스크롤백 씨앗으로 실제로 회수한 줄 수. 알트스크린 판은 0 이 정답이다 (T5) */
  seededLines: number | null
  /** 마지막 스냅샷 왕복 시간 */
  lastReadMs: number | null
  /** 마지막으로 화면을 갱신한 시각 */
  lastFrameAt: number | null
  /** 지금까지 보낸 프레임 수 · 요청 수 (R1 비용 근거) */
  frames: number
  reads: number
  /** 입력을 막고 있으면 그 사유 (격리 가드 포함) */
  inputBlocked: string | null
  /**
   * 붙기가 **약속 창을 넘겨 계속 실패**하고 있으면 그 사유. 없으면 null.
   *
   * 이 상태에서 화면에 그려져 있는 것은 **이 pane 의 것이 아니다** — 렌더러가 새 세대의
   * `screen` 프레임을 버리기 때문에 이전 pane 의 마지막 화면이 그대로 남는다. 살아 있는
   * 것처럼 두면 1차 H2 가 지적한 그 화면이고, 그래서 정직하게 덮는다 (2회차 리뷰 G5).
   */
  attachFailed: string | null
  /**
   * 붙은 **뒤에** 읽기가 이어서 실패하고 있으면 그 사실. 없으면 null (3회차 리뷰 N2).
   *
   * `attachFailed` 와 다른 층이다 — 이쪽 화면은 **이 pane 의 것이 맞고, 다만 그때 것**이다.
   * 그래서 덮지 않고 머리말에만 적는다. 낡은 진실을 통째로 가리면 사용자가 마지막으로 본
   * 것까지 잃는다.
   */
  staleScreen: string | null
}

// ---------------------------------------------------------------------------
// LIFE-346 — 행의 생성과 종료
// ---------------------------------------------------------------------------

/**
 * 기동의 단계. **`running` 은 관측으로만 도달한다** — `agent.start` 의 성공 응답은
 * `launch_pending:true` 라서 "떴다" 의 근거가 아니다 (00-analysis.md ⓓ, 기준 관문 ④).
 *
 * | 값 | 뜻 | 무엇을 보고 적나 |
 * | --- | --- | --- |
 * | `creating` | `tab.create` 가 나가 있다 | — |
 * | `starting` | `agent.start` 가 나가 있다 (재시도 포함) | — |
 * | `launching` | `agent.start` 가 돌아왔다. **아직 안 떴다** | `launch_pending:true` |
 * | `running` | 그 프로그램이 pane 의 포그라운드에 있다 | `pane.process_info` |
 * | `failed` | 거절·관측 실패 | 응답 코드 또는 예산 초과 |
 */
export type LaunchPhase = 'creating' | 'starting' | 'launching' | 'running' | 'failed'

/** 기동 한 건. 뜬 뒤에는 잠깐 남았다 사라지고, 실패는 그 탭이 사라질 때까지 남는다 (N4 정책). */
export type LaunchRow = {
  launchId: string
  sessionName: string
  workspaceId: string
  /** herdr agent kind, 또는 `shell`(=`agent.start` 를 부르지 않는다) */
  kind: string
  label: string | null
  cwd: string | null
  tabId: string | null
  paneId: string | null
  phase: LaunchPhase
  /** `agent_pane_busy` 로 튕겨 다시 건 횟수 (N3). 삼키지 않는다는 증거가 이 숫자다 */
  busyRetries: number
  /** 관측한 포그라운드 cmdline — "떴다" 의 유일한 근거 */
  observedCmdline: string | null
  error: string | null
  startedAt: number
  settledAt: number | null
}

/** 종료 한 건. 실측 ~0.65초가 걸리므로 그 동안 화면이 멈춘 것처럼 보이면 안 된다 (A1). */
export type ClosingRow = {
  tabId: string
  sessionName: string
  phase: 'closing' | 'failed'
  /** herdr 가 거절했으면 그 코드·메시지 그대로. 강제 종료로 승격하지 않는다 (N6 추가) */
  error: string | null
  startedAt: number
  settledAt: number | null
}

export type LifecycleState = { launches: LaunchRow[]; closings: ClosingRow[] }

/**
 * 종료 요청의 결과. `needsConfirm` 은 **아무것도 보내지 않고** 되돌아온 것이다 (N6).
 * `running` 은 그 탭에서 돌고 있는 것 — herdr 가 알아본 에이전트 + 지금 뜬 비(非)셸 포그라운드.
 */
export type CloseOutcome =
  | { ok: true }
  | { ok: false; needsConfirm: true; running: string[]; paneIds: string[] }
  | { ok: false; needsConfirm: false; error: string }

/** 렌더러가 보내는 특수키. `pane.send_keys` 어휘로 그대로 나간다 (실측 확인분만 쓴다). */
export type TerminalKey = 'Up' | 'Down' | 'Left' | 'Right' | 'Escape' | 'Tab'
