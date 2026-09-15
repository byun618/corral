// 라이프사이클 동작 묶음 (C6 분리 전 App.tsx 65-287줄의 상태·핸들러들 — 로직 불변, 자리만 옮김).
//
// LIFE-357 신설분은 두 가지뿐이다: `activeWorkspaceId`(메인 탭바가 보여줄 workspace, state 로
// 승격 — 예전 `lastWorkspaceRef` 는 ⌘T 전용 ref 였다)와 `activateWorkspace` 액션(worktree 행
// 클릭이 부른다). 나머지는 App.tsx 에 있던 것을 그대로 옮겼다.
//
// 출처: C1~C8 은 경쟁 브랜치(`-claude`) 공통 채점 기준이라 이 파일은 그쪽 것을 그대로 가져왔다
// (02-kickoff-orca.md "재사용 가능하면 재사용 권장" — Orca 이식이 아니라 corral 자체 코드이므로
// MIT 고지 대상 아님).

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentKind, AppState, WorkspaceRow, WorktreeRow } from '../../../shared/types.js'
import type { CloseTarget, LifecycleActions, LifecycleNotice } from '../lifecycle-types.js'

export function useLifecycleActions(state: AppState | null): {
  selectedPane: string | null
  selectPane: (paneId: string) => void
  activeWorkspaceId: string | null
  lifecycleNotice: LifecycleNotice | null
  dismissNotice: () => void
  pendingClose: { target: CloseTarget; foreground: string[] } | null
  confirmPendingClose: () => void
  cancelPendingClose: () => void
  worktreeModal: { repoRoot: string } | null
  closeWorktreeModal: () => void
  actions: LifecycleActions
} {
  const [selectedPane, setSelectedPane] = useState<string | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null)
  const [lifecycleNotice, setLifecycleNotice] = useState<LifecycleNotice | null>(null)
  const [pendingClose, setPendingClose] = useState<{ target: CloseTarget; foreground: string[] } | null>(null)
  const [worktreeModal, setWorktreeModal] = useState<{ repoRoot: string } | null>(null)

  /**
   * 열기 in-flight 경로 (수정 1회차 M5). 같은 worktree 를 두 번 눌러도 두 번째는 무시한다 —
   * ref 라 같은 틱의 더블클릭도 잡는다 (state 는 리렌더 전이라 놓친다).
   */
  const openingWorktrees = useRef<Set<string>>(new Set())
  /** ⌘T 핸들러가 스테일 없이 최신값을 읽게 하는 ref 거울 — state 는 렌더용, ref 는 키 핸들러용. */
  const lastWorkspaceRef = useRef<string | null>(null)
  /**
   * 방금 만든 pane — **store 에 나타나면 그때 선택한다** (수정 라운드 3 G2).
   *
   * 응답이 오자마자 `setSelectedPane` 하면 안 된다. 그 시점의 `state` 에는 새 pane 이 아직
   * 없어서 ⓐ 터미널이 없는 id 를 가리키고 ⓑ 바로 아래 자동 선택 이펙트의 가드
   * (`panes.some(pane => pane.paneId === selectedPane)`)가 **false** 라 이펙트가 돌아
   * `focused ?? 첫 pane` 으로 내 선택을 덮는다. push 가 먼저 오면 안 덮이므로 **경합**이다 —
   * 하네스에서 우연히 통과할 수 있는 모양이라 ref 로 미뤄서 구조적으로 끊는다.
   */
  const pendingSelectRef = useRef<string | null>(null)

  const setActive = useCallback((workspaceId: string | null) => {
    lastWorkspaceRef.current = workspaceId
    setActiveWorkspaceIdState(workspaceId)
  }, [])

  /**
   * `activeWorkspaceId` 동기화 — 사용자 상호작용(worktree 열기·pane 선택·행 생성) 밖에서도
   * herdr 에 이미 workspace 가 열려있는 채로 앱이 뜨면(재기동·재접속) 열린 workspace 중
   * focused 우선으로 승격한다. 대상이 닫힌 뒤 죽은 id 로 남는 것도 같이 정리한다.
   */
  useEffect(() => {
    if (state === null) return
    const openWorkspaces = state.repos
      .flatMap((repo) => repo.worktrees)
      .map((worktree) => worktree.workspace)
      .filter((workspace): workspace is WorkspaceRow => workspace !== null)
    const current = lastWorkspaceRef.current
    if (current !== null && openWorkspaces.some((workspace) => workspace.workspaceId === current)) return
    const promoted = openWorkspaces.find((workspace) => workspace.focused) ?? openWorkspaces[0] ?? null
    const nextId = promoted?.workspaceId ?? null
    if (nextId !== current) setActive(nextId)
  }, [state, setActive])

  /**
   * worktree 를 연 직후 첫 pane 자동 선택. 핸드오프 §4는 "첫 세션 자동 활성"을 요구한다 —
   * "activeWorkspaceId 가 가리키는 workspace 에 selectedPane 이 없다"는 조건 하나로 열기·
   * 재기동(위 sync 이펙트가 activeWorkspaceId 를 세우는 경우)을 같은 경로로 덮는다.
   */
  useEffect(() => {
    if (state === null || activeWorkspaceId === null) return
    const workspace = state.repos
      .flatMap((repo) => repo.worktrees)
      .map((worktree) => worktree.workspace)
      .find((ws): ws is WorkspaceRow => ws !== null && ws.workspaceId === activeWorkspaceId)
    if (workspace === undefined) return
    const panes = workspace.tabs.flatMap((tab) => tab.panes)
    // G2 — 방금 만든 pane 이 **도착했으면** 그것을 선택한다. 아직이면 아무것도 안 한다:
    // 여기서 첫 pane 으로 승격해 버리면 곧 올 새 탭이 선택을 못 받는다(그게 결함이었다).
    const pending = pendingSelectRef.current
    if (pending !== null) {
      if (!panes.some((pane) => pane.paneId === pending)) return
      pendingSelectRef.current = null
      setSelectedPane(pending)
      return
    }
    if (panes.length === 0 || panes.some((pane) => pane.paneId === selectedPane)) return
    const [firstPane] = panes
    if (firstPane === undefined) return
    const promoted = panes.find((pane) => pane.focused) ?? firstPane
    setSelectedPane(promoted.paneId)
  }, [state, activeWorkspaceId, selectedPane])

  /**
   * 닫는다 (L3·L4·L9). `confirmed:false` 로 부르면 main 이 종료 게이트를 재고, 산 프로세스가
   * 있으면 `needs-confirm` 으로 돌아온다 — 그때만 모달을 띄운다.
   */
  const closeTarget = useCallback(async (target: CloseTarget, confirmed = false): Promise<void> => {
    setLifecycleNotice(null)
    const result =
      target.kind === 'tab'
        ? await window.corral.closeRow({ tabId: target.tabId, confirmed })
        : await window.corral.closeWorktree({ workspaceId: target.workspaceId, confirmed })
    switch (result.outcome) {
      case 'closed':
        setPendingClose(null)
        return
      case 'needs-confirm':
        setPendingClose({ target, foreground: result.foreground })
        return
      case 'rejected':
        setPendingClose(null)
        setLifecycleNotice({ kind: 'rejected', code: result.rejection.code, message: result.rejection.message })
        return
      case 'error':
        setPendingClose(null)
        setLifecycleNotice({ kind: 'error', message: result.error })
        return
    }
  }, [])

  /**
   * 이름 바꾸기 (I-7). 종료 게이트가 없어 `needs-confirm` 갈래도 없다 — 성공이면 `tab_renamed`
   * 푸시로 목록이 알아서 바뀌므로 여기서 아무것도 만지지 않는다. 거절·실패만 알림으로 올린다
   * (승격 금지 — 이 알림 경로가 그 기준의 화면쪽 끝이다).
   */
  const renameRow = useCallback(
    async ({ tabId, label, tabNumber, position }: { tabId: string; label: string; tabNumber: number; position: number }): Promise<void> => {
      setLifecycleNotice(null)
      // J-4 — **기본 표찰과 같은 이름은 보내기 전에 막는다.** herdr 는 이런 label 도 저장에
      // 성공하지만(grok 소켓 실측: `"42"` 저장됨) 화면 쪽에서는 `userLabel` 이 기본 표찰과
      // 구분할 수 없어 제목이 안 바뀐다 — 보내 놓고 아무 일도 안 일어난 것처럼 보이는 상태가
      // 이 라운드가 없애려는 바로 그 거짓말이다. 막고, 왜 막았는지 말한다.
      //
      // 수정 라운드 4 (G5): **자리 번호도 같이 막는다.** herdr 기본 label 은 `number` 가 아니라
      // 워크스페이스 안 1-기반 **자리**라(`session-title.userLabel` 주석의 실측표), 판별자가
      // 둘을 다 거절하게 된 이상 사전 차단도 같은 둘을 막아야 한다 — 안 그러면 자리 번호로
      // 개명한 순간 그 이름이 화면에서 조용히 사라진다(막으려던 거짓말이 반대편으로 돌아온다).
      if (label === String(tabNumber) || label === String(position)) {
        setLifecycleNotice({ kind: 'error', message: `"${label}" 은 이 탭의 기본 표찰과 같아 이름으로 구분되지 않는다 — 다른 이름을 써라` })
        return
      }
      const result = await window.corral.renameRow({ tabId, label })
      if (result.outcome === 'rejected')
        setLifecycleNotice({ kind: 'rejected', code: result.rejection.code, message: result.rejection.message })
      else if (result.outcome === 'error') setLifecycleNotice({ kind: 'error', message: result.error })
    },
    [],
  )

  /**
   * 이름 지우기 (LIFE-366 F1) — 빈 label 을 보낸다.
   *
   * 실측(`raw/claude/f1-f2-menu.json`): herdr `tab.rename` 은 빈 문자열을 **받아들인다**
   * (거절 없음, `label: ""` 로 저장). 그러면 `userLabel()` 이 빈 label 을 이름으로 안 세므로
   * 제목이 저절로 다음 티어로 떨어진다. 기준 F1 은 "herdr 가 거절하면 그 거절을 그대로 보인다"
   * 는 조건부였고, 실측상 거절이 없어 그 갈래는 안 타지만 **경로는 남겨 둔다** — 버전이 바뀌어
   * 거절이 시작되면 승격 없이 그대로 화면에 뜬다.
   */
  const clearRowName = useCallback(async (tabId: string): Promise<void> => {
    setLifecycleNotice(null)
    const result = await window.corral.renameRow({ tabId, label: '' })
    if (result.outcome === 'rejected')
      setLifecycleNotice({ kind: 'rejected', code: result.rejection.code, message: result.rejection.message })
    else if (result.outcome === 'error') setLifecycleNotice({ kind: 'error', message: result.error })
  }, [])

  const createRow = useCallback(
    async (workspaceId: string, kind: AgentKind): Promise<void> => {
      setActive(workspaceId) // G2: 상호작용한 workspace 를 ⌘T 대상 + 메인 탭바 대상으로 기록
      setLifecycleNotice(null)
      const result = await window.corral.createRow({ workspaceId, kind })
      if (!result.ok) {
        setLifecycleNotice({ kind: 'error', message: result.error ?? '탭 생성 실패' })
        return
      }
      // G2 — **새 탭이 선택된다.** 이미 탭이 있는 worktree 에서는 자동 선택 이펙트가 안 돌아
      // (그 workspace 에 선택된 pane 이 이미 있다) 새 탭이 뒤에 조용히 생기기만 했다.
      // `CreateRowResult.paneId` 는 이미 렌더러까지 오던 값이다 — 버리고 있었을 뿐이다.
      // 선택은 pane 이 store 에 도착한 뒤에 한다(위 `pendingSelectRef` 주석).
      if (result.paneId !== null) pendingSelectRef.current = result.paneId
    },
    [setActive],
  )

  /**
   * ⌘T (mac) / Ctrl+T — 선택/최근 workspace 에 **빈 탭** (게이트 ① G2). 대상이 없으면 no-op.
   * `+ 빈 탭` 클릭과 같은 경로(`createRow` kind:'shell' = tab.create 만)다.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || (event.key !== 't' && event.key !== 'T')) return
      event.preventDefault()
      const workspaceId = lastWorkspaceRef.current
      if (workspaceId === null) return
      // G2 — `+ 빈 탭` 과 **같은 함수**를 부른다. 옛 코드는 여기서 `window.corral.createRow` 를
      // 직접 불러서 포커스 이동 같은 뒤처리가 한쪽에만 붙을 수 있었다. 경로를 하나로 둔다.
      void createRow(workspaceId, 'shell')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [createRow])

  /** pane 선택 — 터미널을 그 pane 으로. G2: 그 pane 의 workspace 를 ⌘T·탭바 대상으로 기록한다. */
  const selectPane = useCallback(
    (paneId: string): void => {
      setSelectedPane(paneId)
      if (state === null) return
      const ws = state.repos
        .flatMap((repo) => repo.worktrees)
        .map((worktree) => worktree.workspace)
        .find((workspace) => workspace?.tabs.some((tab) => tab.panes.some((pane) => pane.paneId === paneId)))
      if (ws) setActive(ws.workspaceId)
    },
    [state, setActive],
  )

  const openWorktree = useCallback(
    async (repoRoot: string, worktree: WorktreeRow): Promise<void> => {
      // in-flight 재클릭 무시 (M5) — 진행 중이면 두 번째는 아무것도 안 한다 (고아 workspace 방지).
      if (openingWorktrees.current.has(worktree.path)) return
      openingWorktrees.current.add(worktree.path)
      setLifecycleNotice(null)
      try {
        const result = await window.corral.openWorktree({ repoRoot, path: worktree.path, isLinked: worktree.isLinked })
        if (result.rejection) setLifecycleNotice({ kind: 'rejected', code: result.rejection.code, message: result.rejection.message })
        // `deduped` (양성 중복 — 이미 여는 중) 는 알림으로 띄우지 않는다 (F-2: 문자열 비교 대신 필드).
        else if (!result.ok && !result.deduped) setLifecycleNotice({ kind: 'error', message: result.error ?? '열기 실패' })
        // G4: linked 를 열며 부모(main workspace)가 함께 열렸으면 안내 한 줄 (herdr 부모 필수 제약, P3).
        else if (result.ok && result.parentOpened)
          setLifecycleNotice({ kind: 'info', message: 'main workspace 를 함께 열었습니다 (herdr 제약)' })
        // 연 workspace 를 메인 탭바 대상으로 세운다 — 열자마자 탭을 만들 수 있어야 한다.
        if (result.ok && result.workspaceId !== null) setActive(result.workspaceId)
      } finally {
        openingWorktrees.current.delete(worktree.path)
      }
    },
    [setActive],
  )

  const actions: LifecycleActions = {
    createRow: (workspaceId, kind) => void createRow(workspaceId, kind),
    closeRow: (tabId) => void closeTarget({ kind: 'tab', tabId }),
    renameRow: (input) => void renameRow(input),
    clearRowName: (tabId) => void clearRowName(tabId),
    closeWorktree: (workspaceId) => void closeTarget({ kind: 'workspace', workspaceId }),
    openWorktree: (repoRoot, worktree) => void openWorktree(repoRoot, worktree),
    openCreateWorktree: (repoRoot) => {
      setLifecycleNotice(null)
      setWorktreeModal({ repoRoot })
    },
    activateWorkspace: (workspaceId) => setActive(workspaceId),
  }

  // 안정적인 함수 identity — ESC 닫기 useEffect 가 매 렌더 리스너를 갈아끼우지 않게.
  const dismissNotice = useCallback(() => setLifecycleNotice(null), [])
  const cancelPendingClose = useCallback(() => setPendingClose(null), [])
  const closeWorktreeModal = useCallback(() => setWorktreeModal(null), [])
  const confirmPendingClose = useCallback(() => {
    if (pendingClose !== null) void closeTarget(pendingClose.target, true)
  }, [pendingClose, closeTarget])

  return {
    selectedPane,
    selectPane,
    activeWorkspaceId,
    lifecycleNotice,
    dismissNotice,
    pendingClose,
    confirmPendingClose,
    cancelPendingClose,
    worktreeModal,
    closeWorktreeModal,
    actions,
  }
}
