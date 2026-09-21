// **어댑터의 유일한 공개 입구** (기준 N2).
//
// 어댑터 바깥(main 의 나머지·preload·renderer)은 `internal/` 을 직접 import 하지 않는다 —
// 여기 다시 내보낸 것만 쓴다. 그리고 여기서 나가는 값은 전부 `shared/types.ts` 의 corral 타입이다:
// herdr 의 봉투·필드 이름·프로토콜 enum 은 이 디렉터리 안에서 끝난다.
//
// 기계 검사: `npm run check:boundary` (scripts/check-boundary.mjs). 사람 눈은 근거가 아니다.

export { SessionLink } from './internal/link.js'
export { listSessions, SESSION_POLL_MS, type SessionHandle } from './internal/sessions.js'
export { readOpenWorkspaces, type OpenWorkspaceMap } from './internal/worktrees.js'
export { readIntegrations, type IntegrationScan } from './internal/integrations.js'
export { DEFAULT_RESYNC_MS } from './internal/link.js'
export { TerminalStreams, type StreamHooks } from './internal/stream.js'
export {
  closePane,
  neighborPane,
  resizePane,
  splitPane,
  zoomPane,
  type PaneOutcome,
} from './internal/panes.js'
export {
  closeTab,
  renameTab,
  closeWorkspace,
  createRow,
  createWorktree,
  openWorkspace,
  openWorktree,
  probeForeground,
  type CloseTabOutcome,
  type RenameTabOutcome,
  type CreateRowOutcome,
  type ForegroundProbe,
  type WorktreeOutcome,
} from './internal/lifecycle.js'
export { TerminalBackend, type TerminalIdentity, type TerminalOperation, type AgentObservation, type AgentManifestObservation } from './internal/terminal-backend.js'
