// 라이프사이클 화면 타입 — App(오케스트레이터)과 컴포넌트들이 공유한다.
// C6 분리 전 App.tsx 안에 있던 것을 그대로 옮겼다 (로직 불변, 자리만 바뀜).
//
// 출처: C1~C8 은 경쟁 브랜치(`-claude`) 공통 채점 기준이라 이 파일은 그쪽 것을 그대로 가져왔다
// (02-kickoff-orca.md "재사용 가능하면 재사용 권장" — Orca 이식이 아니라 corral 자체 코드이므로
// MIT 고지 대상 아님).

import type { AgentKind, RunningPane, WorktreeRow } from '../../shared/types.js'

/**
 * 닫기 대상 — 탭 여럿(단건도 한 개짜리 목록) 또는 worktree(workspace). 확인 모달과 IPC 갈래를 이걸로 가른다.
 * `alwaysConfirm` = 핀 탭을 닫는다 — 실행 중이 아니어도 확인을 거친다(LIFE-495 K3ⓒ).
 */
export type CloseTarget = { kind: 'tabs'; tabIds: string[]; alwaysConfirm: boolean } | { kind: 'workspace'; workspaceId: string }

/** 확인 모달이 떠 있는 닫기 — `running` 은 탭 닫기에서 실행 중으로 판정된 pane(에이전트 문구를 가른다), worktree 닫기는 빈 배열. */
export type PendingClose = { target: CloseTarget; foreground: string[]; running: RunningPane[] }

/**
 * 화면에 올리는 라이프사이클 동작 묶음 — Repo→Worktree→Workspace→Tab 으로 내려간다.
 * 한 객체로 묶어 내려서 컴포넌트마다 손잡이를 하나씩 늘어놓지 않는다 (관심사: 트리는 그리기,
 * 동작은 App 이 IPC 로).
 */
export type LifecycleActions = {
  createRow: (workspaceId: string, kind: AgentKind) => void
  /** LIFE-495 K6 — 닫은 탭 다시 열기: 같은 시작 디렉터리·이름으로 **새 셸** 탭. `onTab` 은 만든 탭 id 로 펴기 전에 불린다(자리·색 복원). */
  reopenTab: (input: { workspaceId: string; cwd: string | null; label: string | null; onTab: (tabId: string) => void; onFailed: () => void }) => void
  /**
   * LIFE-496 D38 — `+` 메뉴 Quick-launch. `createRow` 와 같은 경로에 **기동 워치독**을 더한다(에이전트가 기한 안에 감지되지 않으면 알림).
   * 팔레트 「새 {kind} 에이전트」는 지금 동작 그대로 `createRow` 를 쓴다(K2ⓐ).
   */
  launchAgent: (input: { workspaceId: string; kind: Exclude<AgentKind, 'shell'>; label: string }) => void
  /**
   * 탭을 닫는다 (LIFE-495) — ×·중클릭·메뉴·⌘W·「다른/오른쪽/왼쪽 탭 닫기」가 모두 이 길이다. 실행 중 확인은 대상 전부를 모아 **모달 한 번**.
   * `onClosed` 는 실제로 닫힌 탭으로 불린다(닫은 탭 다시 열기 기록 — 확인을 취소하면 안 불린다).
   */
  closeTabs: (input: { tabIds: string[]; alwaysConfirm: boolean; onClosed: (closed: string[]) => void }) => void
  /**
   * LIFE-357 I-7 — 탭 이름을 사용자가 준 이름으로. 거절은 알림으로 그대로 올라온다.
   * `tabNumber` 는 J-4 의 "기본 표찰과 같은 이름" 가드가 쓴다 — 그 값은 보내기 전에 막는다.
   */
  renameRow: (input: { tabId: string; label: string; tabNumber: number; tabCount: number }) => void
  /**
   * LIFE-366 F1 — 사용자가 준 이름을 **지운다**. 제목은 다음 티어로 되돌아간다
   * (provider 제목 → 정제된 터미널 제목 → 폴백).
   *
   * 지우기가 `renameRow` 와 별개인 이유: 인라인 편집의 빈 확정은 **취소**다(I-7 ③ 결정).
   * 같은 손잡이에 얹으면 "아무것도 안 치고 Enter" 가 이름을 지워 버린다 — 다른 뜻의 조작이라
   * 다른 문을 낸다.
   */
  clearRowName: (tabId: string) => void
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
