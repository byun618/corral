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
}

/** 가운데 층 = herdr workspace (00-analysis.md §3 결정). 그 아래 pane 이 잎으로 달린다. */
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
  panes: PaneRow[]
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
  /** 선택 대상은 pane 이다 (기준 L2). */
  selectedPaneId: string | null
  /** 진단 UI(S3 프로브)를 띄우는 실행인가 — 패키징된 앱이거나 계측이 아니면 false. */
  diagnostics: boolean
}

/** preload 가 contextBridge 로 노출하는 채널별 메서드. ipcRenderer 를 통째로 넘기지 않는다. */
export type CorralApi = {
  getState: () => Promise<AppState>
  onState: (listener: (state: AppState) => void) => () => void
  selectSession: (name: string) => Promise<void>
  selectPane: (paneId: string | null) => Promise<void>
  refreshSessions: () => Promise<void>
  /** 렌더러가 실제로 그린 시점을 main 로그에 남긴다 (L3 의 "반영 시각"). */
  reportRendered: (revision: number) => void
  /** S3 근거용 — 렌더러 컨텍스트에서 실제로 무엇이 막혀 있는지 main 로그에 남긴다. */
  reportProbe: (name: string, detail: Record<string, string>) => void
  /** preload 가 자기 컨텍스트에서 관측한 값 (S3). */
  preloadEnv: { sandboxed: boolean; contextIsolated: boolean; exposedMethods: string[] }
}
