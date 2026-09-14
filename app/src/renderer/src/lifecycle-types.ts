// 라이프사이클 화면 타입 — App(오케스트레이터)과 컴포넌트들이 공유한다.
// C6 분리 전 App.tsx 안에 있던 것을 그대로 옮겼다 (로직 불변, 자리만 바뀜).
//
// 출처: C1~C8 은 경쟁 브랜치(`-claude`) 공통 채점 기준이라 이 파일은 그쪽 것을 그대로 가져왔다
// (02-kickoff-orca.md "재사용 가능하면 재사용 권장" — Orca 이식이 아니라 corral 자체 코드이므로
// MIT 고지 대상 아님).

import type { AgentKind, WorktreeRow } from '../../shared/types.js'

/** 닫기 대상 — 행(탭) 또는 worktree(workspace). 확인 모달과 IPC 갈래를 이걸로 가른다. */
export type CloseTarget = { kind: 'tab'; tabId: string } | { kind: 'workspace'; workspaceId: string }

/**
 * 화면에 올리는 라이프사이클 동작 묶음 — Repo→Worktree→Workspace→Tab 으로 내려간다.
 * 한 객체로 묶어 내려서 컴포넌트마다 손잡이를 하나씩 늘어놓지 않는다 (관심사: 트리는 그리기,
 * 동작은 App 이 IPC 로).
 */
export type LifecycleActions = {
  createRow: (workspaceId: string, kind: AgentKind) => void
  closeRow: (tabId: string) => void
  /** LIFE-357 I-7 — 탭 이름을 사용자가 준 이름으로. 거절은 알림으로 그대로 올라온다. */
  renameRow: (tabId: string, label: string) => void
  closeWorktree: (workspaceId: string) => void
  openWorktree: (repoRoot: string, worktree: WorktreeRow) => void
  openCreateWorktree: (repoRoot: string) => void
  /** LIFE-357 신설 — worktree 행을 누르면 그 workspace 를 메인 탭바 대상으로 세운다. */
  activateWorkspace: (workspaceId: string) => void
}

/** 화면 상단에 그대로 뜨는 라이프사이클 알림 (거절·실패·안내). L9 거절은 여기서 멈춘다. */
export type LifecycleNotice =
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'info'; message: string } // 게이트 ① G4: 부모 함께 열림 같은 안내 한 줄
