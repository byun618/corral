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
import type { AgentKind, AppState, CloseRowResult, CloseTabsResult, WorkspaceRow, WorktreeActionResult, WorktreeRow } from '../../../shared/types.js'
import { pendingActiveMs, syncActiveWorkspace, type PendingActive } from '../active-workspace.js'
import type { CloseTarget, LifecycleActions, LifecycleNotice, PendingClose } from '../lifecycle-types.js'
import { pickPane } from '../pane-utils.js'
import { isDefaultPositionLabel } from '../session-title.js'
import { LAUNCH_WATCHDOG_MS, launchWatchdogMessage, launchWatchdogVerdict, type LaunchWatch } from '../tab-create-menu.js'
/** 다른 요청의 확인 창이 떠 있는 동안 늦게 온 needs-confirm 을 버릴 때 알림(LIFE-516 fix2 R2-01ⓒ·D10) — 그 대상은 닫히지 않고 남는다.
 *  탭·워크트리 닫기 공통 문구(fix3 R3-01ⓑ). */
export const CLOSE_DEFERRED_NOTICE = '다른 닫기 확인이 진행 중이라 닫지 않았습니다 — 그 창을 마친 뒤 다시 닫으세요'
/** 닫기 IPC 자체가 reject 했을 때(LIFE-524 — 구조화된 결과가 아니다) 알림 문구. 탭은 닫히지 않았을 수 있다 — 다시 닫으면 다시 묻는다. */
export function closeRequestFailedMessage(error: unknown): string {
  return `닫기 요청이 실패했습니다 — 다시 시도하세요 (${error instanceof Error ? error.message : String(error)})`
}

export function useLifecycleActions(state: AppState | null): {
  selectedPane: string | null
  /**
   * 화면이 보이는 탭 = 활성 영역의 활성 **터미널** 탭 id (LIFE-691 K2). App 이 렌더마다 채운다 — 배치는 App 이 알고 이 훅은 모른다.
   * 선택 pane 이 그 탭째 닫히면 이 탭의 pane 으로 승격한다(화면 활성 탭 ≠ 입력 pane 의 탭이 남지 않게). 파일 탭이 활성이면 null.
   */
  shownTabRef: { current: string | null }
  selectPane: (paneId: string) => void
  /** 아직 store 에 없는 pane 을 **도착하면** 선택한다 (분할 직후 — F2-7). */
  selectPaneWhenReady: (paneId: string) => void
  /**
   * 방금 만든 **탭** — 배치에 들어오면 App 이 그 탭을 편다 (G2′ · §10-R35-1).
   *
   * pane 선택만으로는 부족하다: 이 앱은 **영역이 활성 탭을 정한다**(R3-a). 배치를 아는 것은
   * App 이고 이 훅은 모르므로, **무엇을 펴야 하는지만** 여기서 알리고 펴는 일은 App 이 한다.
   */
  pendingRevealTab: string | null
  revealTabHandled: () => void
  createShell: () => void
  /** ⌘⌥T 의 에이전트 갈래(LIFE-515) — ⌘T 와 같은 대상 workspace 에 `launchAgent`(워치독 포함). 대상이 없으면 no-op. */
  createAgentTab: (input: { kind: Exclude<AgentKind, 'shell'>; label: string }) => void
  activeWorkspaceId: string | null
  lifecycleNotice: LifecycleNotice | null
  dismissNotice: () => void
  pendingClose: PendingClose | null
  /** `before` 가 있으면 그것(설정 저장)이 끝난 뒤 닫는다. 한 요청은 한 번만 소비된다 — 두 번째 확인·저장 중 취소된 요청은 닫지 않는다(LIFE-516 fix1 R1-01). */
  confirmPendingClose: (input?: { before: () => Promise<void> }) => void
  cancelPendingClose: () => void
  worktreeModal: { repoRoot: string } | null
  closeWorktreeModal: () => void
  /** 생성 모달의 제출(LIFE-490 D3) — 성공하면 새 워크트리를 활성으로 세운다(열기와 같은 보류 장치). */
  createWorktree: (input: { repoRoot: string; branch: string; path: string }) => Promise<WorktreeActionResult>
  actions: LifecycleActions
} {
  const [selectedPane, setSelectedPane] = useState<string | null>(null)
  /** 선택 pane 이 속한 탭 — 그 pane 이 닫힌 뒤 승격 자리를 고르는 데 쓴다(LIFE-508, 아래 첫 pane 자동 선택 effect). */
  const selectedTabRef = useRef<string | null>(null)
  const shownTabRef = useRef<string | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null)
  const [lifecycleNotice, setLifecycleNotice] = useState<LifecycleNotice | null>(null)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  /**
   * 확인 창의 주인 — 창을 띄운 닫기 요청(요청마다 새 `token`)과 그 요청의 `onClosed`(state 에 함수를 싣지 않으려고 ref).
   * LIFE-516 fix2 R2-01: 창·콜백을 요청 정체에 묶는다. 주인이 있는 동안 다른 요청의 needs-confirm 은 창을 바꾸지 않고 버리며(D10),
   * 다른 요청의 완료는 이 창을 지우지 않는다.
   */
  const closeOwner = useRef<{ token: object; onClosed: ((closed: string[]) => void) | undefined } | null>(null)
  /** 창 주인이 있는 동안 버린 닫기 요청이 있었다(fix3 R3-01) — 주인 요청이 끝날 때 안내를 다시 띄운다(주인 확인 닫기가 알림을 비우므로). */
  const deferredClose = useRef(false)
  /** 확인으로 소비 중인 닫기 요청(LIFE-516 fix1 R1-01) — 같은 요청의 두 번째 확인을 막고, 취소가 비워 저장 뒤 늦은 닫기를 막는다. */
  const consumingClose = useRef<PendingClose | null>(null)
  const [worktreeModal, setWorktreeModal] = useState<{ repoRoot: string } | null>(null)

  /**
   * 열기 in-flight 경로 (수정 1회차 M5). 같은 worktree 를 두 번 눌러도 두 번째는 무시한다 —
   * ref 라 같은 틱의 더블클릭도 잡는다 (state 는 리렌더 전이라 놓친다).
   */
  const openingWorktrees = useRef<Set<string>>(new Set())
  /** ⌘T 핸들러가 스테일 없이 최신값을 읽게 하는 ref 거울 — state 는 렌더용, ref 는 키 핸들러용. */
  const lastWorkspaceRef = useRef<string | null>(null)
  /**
   * 방금 만든 pane — **store 에 나타나면 그때 선택한다** (수정 라운드 3 G2 · LIFE-373 F2-7).
   *
   * 응답이 오자마자 `setSelectedPane` 하면 안 된다. 그 시점의 `state` 에는 새 pane 이 아직
   * 없어서 ⓐ 터미널이 없는 id 를 가리키고 ⓑ 바로 아래 자동 선택 이펙트의 가드
   * (`panes.some(pane => pane.paneId === selectedPane)`)가 **false** 라 이펙트가 돌아
   * `focused ?? 첫 pane` 으로 내 선택을 덮는다. push 가 먼저 오면 안 덮이므로 **경합**이다 —
   * 하네스에서 우연히 통과할 수 있는 모양이라 ref 로 미뤄서 구조적으로 끊는다.
   */
  const pendingSelectRef = useRef<string | null>(null)
  /** 방금 만든 탭 (G2′). `state` 가 아니라 **배치**가 여는 것이라 App 으로 넘긴다. */
  const [pendingRevealTab, setPendingRevealTab] = useState<string | null>(null)

  /**
   * **기동 워치독** (LIFE-496 K1ⓔ · 게이트 ⓪ Q2 ⓐ) — Orca `QuickLaunchButton.waitForTerminalPty` 의 corral 등가물.
   *
   * Orca 는 "PTY 가 생겼나"를 5초 본다. corral 은 herdr 가 PTY 를 쥐고 `tab.create` 가 root pane 을 돌려준 뒤에야 `agent.start` 를
   * 부르므로 그 상태가 없다. 대신 조용히 묻히는 실패는 "**걸었는데 에이전트가 안 뜸**"이다 — U2 실측(`raw/claude/u2/`): 실행 파일이
   * 없어도 `agent.start` 는 성공하고 pane.agent 는 끝내 오지 않는다. 그래서 그 pane 의 `agent` 도착을 기다린다.
   * 기다리는 동안 한 번이라도 오면 성공으로 끝낸다(곧 나가 버린 에이전트를 실패로 세지 않는다). 기한에 판정은 순수 함수가 한다.
   * main 은 state push 와 IPC 응답의 순서를 보장하지 않는다 — 응답보다 먼저 온 감지는 **등록할 때 최신 state 로** 본다(리뷰 r1 R1-04).
   * 응답 전에 감지됐다가 응답 전에 사라진 경우(r2 R2-01)는 최신 state 에 없다. 그래서 **미해결 launch 가 있는 동안** 본 감지 pane 을
   * 모아 두고(`agentSeenWhilePending`), 응답의 paneId 와 맞춰 본다. 미해결 launch 가 하나도 없으면 비운다.
   */
  const stateRef = useRef<AppState | null>(state)
  stateRef.current = state
  const launchWatches = useRef(new Map<string, { watch: LaunchWatch; timer: ReturnType<typeof setTimeout> }>())
  const pendingLaunches = useRef(0)
  const agentSeenWhilePending = useRef(new Set<string>())
  useEffect(() => {
    if (state === null) return
    if (pendingLaunches.current > 0)
      for (const repo of state.repos)
        for (const worktree of repo.worktrees)
          for (const tab of worktree.workspace?.tabs ?? []) for (const pane of tab.panes) if (pane.agent != null) agentSeenWhilePending.current.add(pane.paneId)
    for (const [paneId, entry] of launchWatches.current) {
      if (findPane({ state, paneId })?.agent == null) continue
      clearTimeout(entry.timer)
      launchWatches.current.delete(paneId)
    }
  }, [state])
  /** 훅이 살아 있나 — 내려간 뒤 도착한 launch 응답이 워치독을 걸지 않게 한다(r3 R3-03). 감지 이력 정리도 같은 수명에 묶는다. */
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    const watches = launchWatches.current
    const seen = agentSeenWhilePending.current
    return () => {
      mountedRef.current = false
      for (const entry of watches.values()) clearTimeout(entry.timer)
      watches.clear()
      seen.clear()
    }
  }, [])
  const watchLaunch = useCallback((watch: LaunchWatch): void => {
    if (!mountedRef.current) return
    const latest = stateRef.current
    if (latest !== null && findPane({ state: latest, paneId: watch.paneId })?.agent != null) return
    const timer = setTimeout(() => {
      launchWatches.current.delete(watch.paneId)
      const current = stateRef.current
      const verdict = launchWatchdogVerdict({
        watch,
        pane: current === null ? null : findPane({ state: current, paneId: watch.paneId }),
        activeWorkspaceId: lastWorkspaceRef.current,
      })
      if (verdict === 'missing') setLifecycleNotice({ kind: 'error', message: launchWatchdogMessage(watch.label) })
    }, LAUNCH_WATCHDOG_MS)
    launchWatches.current.set(watch.paneId, { watch, timer })
  }, [])

  /**
   * 방금 열거나 만든 workspace 의 **보류** (LIFE-490) — 응답이 state 보다 먼저 와서 동기화 effect 가 그 id 를
   * 「닫힘」 으로 읽고 main 으로 승격하던 경합을 막는다. 판정은 `syncActiveWorkspace`(`active-workspace.ts`) 한 곳.
   */
  const pendingActiveRef = useRef<PendingActive | null>(null)
  /** 보류 기한 — 타이머가 보류를 지우고 동기화를 다시 돌린다(만료 판정은 이 타이머 하나 — fix1 F2). push 가 더 안 와도 죽은 id 에 머물지 않게. */
  const [pendingExpiry, setPendingExpiry] = useState(0)
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 사용자 활성 의도의 순번 — 활성을 바꾸는 사용자 동작(행·세션 클릭, 탭 만들기, 열기·생성 요청)마다 오른다.
   * 열기·생성 응답은 요청 때 잡은 순번이 그대로일 때만 활성을 가져간다 — 기다리는 사이 사용자가 다른 것을 누르면
   * 그 선택이 이긴다(늦게 도착한 앞 요청이 활성을 빼앗지 않는다).
   */
  const intentSeq = useRef(0)

  /** 활성만 바꾼다(의도 순번·보류는 그대로) — 동기화 effect 의 승격과 응답 채택이 쓴다. */
  const assignActive = useCallback((workspaceId: string | null) => {
    lastWorkspaceRef.current = workspaceId
    setActiveWorkspaceIdState(workspaceId)
  }, [])

  /**
   * 사용자 동작의 활성 — 새 의도다. 앞 요청의 보류는 버린다. 단 보류 중인 바로 그 workspace 로의 동작(열자마자 ⌘T·
   * 그 행 다시 클릭)은 같은 의도라 보류를 지킨다 — 지우면 도착 전 push 에 main 으로 승격했다(fix1 F1, r1 G-1).
   */
  const setActive = useCallback((workspaceId: string | null) => {
    intentSeq.current += 1
    if (pendingActiveRef.current?.workspaceId !== workspaceId) pendingActiveRef.current = null
    assignActive(workspaceId)
  }, [assignActive])

  /**
   * 열기·생성 응답의 workspace 를 활성으로 받는다. `seq` 는 요청할 때 올린 의도 순번 — 그 뒤 다른 의도가 있었으면 버린다.
   * 이미 state 에 있으면 그대로, 아직 없으면 보류를 걸고 기한에 동기화를 다시 돌린다.
   */
  const adoptOpened = useCallback((input: { workspaceId: string; seq: number }) => {
    if (input.seq !== intentSeq.current) return
    const repos = stateRef.current?.repos ?? []
    const known = repos.some((repo) => repo.worktrees.some((worktree) => worktree.workspace?.workspaceId === input.workspaceId))
    const pending: PendingActive | null = known ? null : { workspaceId: input.workspaceId }
    pendingActiveRef.current = pending
    assignActive(input.workspaceId)
    if (pending === null) return
    if (pendingTimer.current !== null) clearTimeout(pendingTimer.current)
    pendingTimer.current = setTimeout(() => {
      pendingTimer.current = null
      if (pendingActiveRef.current === pending) pendingActiveRef.current = null
      setPendingExpiry((count) => count + 1)
    }, pendingActiveMs({ repoCount: repos.length }))
  }, [assignActive])
  useEffect(() => () => {
    if (pendingTimer.current !== null) clearTimeout(pendingTimer.current)
  }, [])

  /**
   * `activeWorkspaceId` 동기화 — 사용자 상호작용(worktree 열기·pane 선택·행 생성) 밖에서도
   * herdr 에 이미 workspace 가 열려있는 채로 앱이 뜨면(재기동·재접속) 열린 workspace 중
   * focused 우선으로 승격한다. 대상이 닫힌 뒤 죽은 id 로 남는 것도 같이 정리한다.
   * 방금 연 workspace 가 아직 도착 전이면(보류) 지우지 않는다 — LIFE-490.
   */
  useEffect(() => {
    if (state === null) return
    const openWorkspaces = state.repos
      .flatMap((repo) => repo.worktrees)
      .map((worktree) => worktree.workspace)
      .filter((workspace): workspace is WorkspaceRow => workspace !== null)
    const current = lastWorkspaceRef.current
    const sync = syncActiveWorkspace({ current, pending: pendingActiveRef.current, open: openWorkspaces })
    pendingActiveRef.current = sync.pending
    if (sync.next !== current) assignActive(sync.next)
  }, [state, pendingExpiry, assignActive])

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
    const owner = workspace.tabs.find((tab) => tab.panes.some((pane) => pane.paneId === selectedPane))
    if (owner !== undefined) {
      selectedTabRef.current = owner.tabId
      return
    }
    const [firstPane] = panes
    if (firstPane === undefined) return
    // LIFE-508 — 선택 pane 이 닫혔는데(분할 pane ⌘W) 그 탭이 남아 있으면 **그 탭의 pane** 으로 승격한다. 화면은 영역의 활성 탭(= 그 탭)에서
    // `pickPane` 으로 고른 pane 을 보이므로(App `groupSelectedPaneId`) 같은 규칙이어야 MRU 맨 앞이 화면의 pane 이 된다. 워크스페이스 전체의
    // herdr 포커스로 가면 다른 탭의 pane 이 선택돼 MRU 맨 앞과 화면이 갈리고 ⌃Tab 이 화면을 안 움직였다.
    // LIFE-691 K2 — 그 탭째 닫혔으면 **화면이 보이는 탭**(활성 영역의 새 활성 탭 — MRU → 이웃)의 pane. herdr 포커스는 다른 탭일 수 있다.
    const sameTab = workspace.tabs.find((tab) => tab.tabId === selectedTabRef.current)
    const shownTab = workspace.tabs.find((tab) => tab.tabId === shownTabRef.current)
    const promoted =
      (sameTab === undefined ? null : pickPane(sameTab)) ?? (shownTab === undefined ? null : pickPane(shownTab)) ?? panes.find((pane) => pane.focused) ?? firstPane
    setSelectedPane(promoted.paneId)
  }, [state, activeWorkspaceId, selectedPane])

  /**
   * 닫는다 (L3·L4·L9). `confirmed:false` 로 부르면 main 이 종료 게이트를 재고, 산 프로세스가
   * 있으면 `needs-confirm` 으로 돌아온다 — 그때만 모달을 띄운다.
   */
  const closeTarget = useCallback(async (input: {
    target: CloseTarget
    confirmed: boolean
    onClosed?: (closed: string[]) => void
    /** 이 닫기 요청의 정체(fix2 R2-01) — 처음 요청 때 새로 만들고, 확인 뒤 닫기는 창 주인의 것을 그대로 쓴다. */
    token: object
    /** 확인 창이 보여 준 실행 중 pane — 확인 뒤 main 은 이 밖의 실행 중만 다시 묻는다(fix1 R1-05). */
    confirmedPaneIds?: string[]
  }): Promise<void> => {
    const { target, confirmed, onClosed, token } = input
    setLifecycleNotice(null)
    // 창을 이 요청이 가졌거나 아무도 안 가졌을 때만 창을 세운다. 다른 요청의 창이 떠 있으면 버린다 — 탭은 닫히지 않고 남는다(D10).
    const showConfirm = (pending: PendingClose): void => {
      if (closeOwner.current !== null && closeOwner.current.token !== token) {
        deferredClose.current = true
        setLifecycleNotice({ kind: 'info', message: CLOSE_DEFERRED_NOTICE })
        return
      }
      closeOwner.current = { token, onClosed }
      setPendingClose(pending)
    }
    // 완료는 자기 창만 지운다 — 확인이 필요 없어 바로 끝난 다른 요청이 떠 있는 창을 지우지 않게.
    // 돌려주는 값: 이 창이 떠 있는 동안 버린 요청이 있었으면 그 안내(fix3 R3-01) — 부른 쪽이 자기 결과 알림과 함께 띄운다.
    const release = (): string | null => {
      if (closeOwner.current?.token !== token) return null
      closeOwner.current = null
      setPendingClose(null)
      const note = deferredClose.current ? CLOSE_DEFERRED_NOTICE : null
      deferredClose.current = false
      return note
    }
    // 주인 요청의 rejected/error 가 먼저 보이고 버린 요청 안내는 뒤에 붙는다(D10). 닫힘이면 안내만 다시 띄운다.
    const withDeferred = (message: string, note: string | null): string => (note === null ? message : `${message} · ${note}`)
    const settle = (outcome: { kind: 'closed' } | { kind: 'rejected'; code: string; message: string } | { kind: 'error'; message: string }): void => {
      const note = release()
      switch (outcome.kind) {
        case 'closed':
          if (note !== null) setLifecycleNotice({ kind: 'info', message: note })
          return
        case 'rejected':
          setLifecycleNotice({ kind: 'rejected', code: outcome.code, message: withDeferred(outcome.message, note) })
          return
        case 'error':
          setLifecycleNotice({ kind: 'error', message: withDeferred(outcome.message, note) })
          return
      }
    }
    // LIFE-524 — IPC 자체 reject 는 `error` 결과와 같은 길로 정리한다: 이 요청의 확인창을 풀고(정책 「닫기」 — 창을 남기면 확인 단추가
    // 같은 실패를 되풀이할 뿐이다) 알림을 띄운다. 창이 풀리므로 같은 탭 닫기를 다시 부르면 처음부터 다시 묻는다(재시도).
    if (target.kind === 'tabs') {
      if (target.tabIds.length === 0) return
      let result: CloseTabsResult
      try {
        result = await window.corral.closeTabs({ tabIds: target.tabIds, confirmed, alwaysConfirm: target.alwaysConfirm, confirmedPaneIds: input.confirmedPaneIds ?? [] })
      } catch (error) {
        settle({ kind: 'error', message: closeRequestFailedMessage(error) })
        return
      }
      if (result.closed.length > 0) onClosed?.(result.closed)
      if (result.outcome === 'needs-confirm') {
        // 확인 뒤 닫다가 새 실행 중을 만나 멈췄으면 닫힌 탭은 위에서 기록했고, 남은 탭만 다시 묻는다.
        const remaining = target.tabIds.filter((tabId) => !result.closed.includes(tabId))
        showConfirm({ target: { ...target, tabIds: remaining }, foreground: result.running.flatMap((pane) => pane.foreground), running: result.running })
        return
      }
      if (result.outcome === 'rejected') settle({ kind: 'rejected', code: result.rejection.code, message: result.rejection.message })
      else if (result.outcome === 'error') settle({ kind: 'error', message: result.error })
      else settle({ kind: 'closed' })
      return
    }
    let result: CloseRowResult
    try {
      result = await window.corral.closeWorktree({ workspaceId: target.workspaceId, confirmed })
    } catch (error) {
      settle({ kind: 'error', message: closeRequestFailedMessage(error) })
      return
    }
    switch (result.outcome) {
      case 'closed':
        settle({ kind: 'closed' })
        return
      case 'needs-confirm':
        showConfirm({ target, foreground: result.foreground, running: [] })
        return
      case 'rejected':
        settle({ kind: 'rejected', code: result.rejection.code, message: result.rejection.message })
        return
      case 'error':
        settle({ kind: 'error', message: result.error })
        return
    }
  }, [])

  /**
   * 이름 바꾸기 (I-7). 종료 게이트가 없어 `needs-confirm` 갈래도 없다 — 성공이면 `tab_renamed`
   * 푸시로 목록이 알아서 바뀌므로 여기서 아무것도 만지지 않는다. 거절·실패만 알림으로 올린다
   * (승격 금지 — 이 알림 경로가 그 기준의 화면쪽 끝이다).
   */
  const renameRow = useCallback(
    async ({ tabId, label, tabNumber, tabCount }: { tabId: string; label: string; tabNumber: number; tabCount: number }): Promise<void> => {
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
      //
      // 수정 라운드 5 (G7): 판별자가 **`1..탭수` 범위**로 넓어졌으므로 차단도 같은 범위다.
      // 둘이 어긋나면 한쪽이 거짓말을 한다 — 범위 안 숫자로 개명을 허용해 놓고 화면에서는
      // 기본값으로 읽어 지워 버리는 자리가 정확히 그 어긋남이었다.
      if (label === String(tabNumber) || isDefaultPositionLabel(label, tabCount)) {
        setLifecycleNotice({
          kind: 'error',
          message: `"${label}" 은 herdr 가 자리 번호로 쓰는 기본 표찰(1~${tabCount})이라 이름으로 구분되지 않는다 — 다른 이름을 써라`,
        })
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

  /** 만든 pane 의 id 를 돌려준다(실패·pane 없음이면 null) — `launchAgent` 가 워치독을 건다. */
  const createRow = useCallback(
    async (input: {
      workspaceId: string
      kind: AgentKind
      /**
       * LIFE-495 K6 — 닫은 탭 다시 열기: 시작 디렉터리·이름을 싣고, 만든 탭 id 를 자리 복원에 넘긴다(펴기 전에).
       * 만들기가 실패하면 `onFailed` — 꺼낸 기록을 되돌린다(fix1 미확인 부기: 실패해도 기록이 사라졌다).
       */
      reopen?: { cwd: string | null; label: string | null; onTab: (tabId: string) => void; onFailed: () => void }
    }): Promise<string | null> => {
      const { workspaceId, kind, reopen } = input
      setActive(workspaceId) // G2: 상호작용한 workspace 를 ⌘T 대상 + 메인 탭바 대상으로 기록
      setLifecycleNotice(null)
      const result = await window.corral.createRow({
        workspaceId,
        kind,
        ...(reopen?.cwd == null ? {} : { cwd: reopen.cwd }),
        ...(reopen?.label == null ? {} : { label: reopen.label }),
      })
      if (!result.ok) {
        setLifecycleNotice({ kind: 'error', message: result.error ?? '탭 생성 실패' })
        reopen?.onFailed()
        return null
      }
      // G2 — **새 탭이 선택된다.** 이미 탭이 있는 worktree 에서는 자동 선택 이펙트가 안 돌아
      // (그 workspace 에 선택된 pane 이 이미 있다) 새 탭이 뒤에 조용히 생기기만 했다.
      // `CreateRowResult.paneId` 는 이미 렌더러까지 오던 값이다 — 버리고 있었을 뿐이다.
      // 선택은 pane 이 store 에 도착한 뒤에 한다(위 `pendingSelectRef` 주석).
      if (result.paneId !== null) pendingSelectRef.current = result.paneId
      // **G2′** — 새 탭을 화면에 띄우는 것은 pane 선택이 아니라 **영역의 활성 탭**이다(R3-a).
      // 여기서는 무엇을 펴야 하는지만 남기고, 배치를 아는 App 이 탭이 도착한 뒤 편다.
      // 이게 없으면 탭은 만들어지고 **뒤에 조용히 숨어 있다** — 게이트 ① 에서 사용자가 잡은 것.
      if (result.tabId === null) reopen?.onFailed()
      else reopen?.onTab(result.tabId)
      if (result.tabId !== null) setPendingRevealTab(result.tabId)
      return result.paneId
    },
    [setActive],
  )
  /** LIFE-496 D38 — `+` 메뉴 Quick-launch = `createRow` + 기동 워치독. */
  const launchAgent = useCallback(
    async ({ workspaceId, kind, label }: { workspaceId: string; kind: Exclude<AgentKind, 'shell'>; label: string }): Promise<void> => {
      pendingLaunches.current += 1
      let paneId: string | null = null
      try {
        paneId = await createRow({ workspaceId, kind })
      } finally {
        pendingLaunches.current -= 1
      }
      if (!mountedRef.current) return
      const seenBeforeResponse = paneId !== null && agentSeenWhilePending.current.has(paneId)
      if (pendingLaunches.current === 0) agentSeenWhilePending.current.clear()
      if (paneId !== null && !seenBeforeResponse) watchLaunch({ paneId, workspaceId, label })
    },
    [createRow, watchLaunch],
  )
  const revealTabHandled = useCallback((): void => setPendingRevealTab(null), [])

  /**
   * ⌘T (mac) / Ctrl+T — 선택/최근 workspace 에 **빈 탭** (게이트 ① G2). 대상이 없으면 no-op.
   * `+ 빈 탭` 클릭과 같은 경로(`createRow` kind:'shell' = tab.create 만)다.
   */
  const createShell = useCallback((): void => {
    const workspaceId = lastWorkspaceRef.current
    if (workspaceId !== null) void createRow({ workspaceId, kind: 'shell' })
  }, [createRow])
  const createAgentTab = useCallback(
    ({ kind, label }: { kind: Exclude<AgentKind, 'shell'>; label: string }): void => {
      const workspaceId = lastWorkspaceRef.current
      if (workspaceId !== null) void launchAgent({ workspaceId, kind, label })
    },
    [launchAgent],
  )

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

  /**
   * **분할 직후 새 pane 선택** (F2-7) — `createRow` 가 쓰던 `pendingSelectRef` 와 같은 길이다.
   *
   * 여기서 `selectPane` 을 바로 부르면 안 된다: 그 시점의 `state` 에는 새 pane 이 아직 없어서
   * 위 자동 선택 이펙트가 그것을 못 보고 **옛 pane 으로 되돌린다**(같은 경합). 도착을 기다린다.
   */
  const selectPaneWhenReady = useCallback((paneId: string): void => {
    pendingSelectRef.current = paneId
  }, [])

  const openWorktree = useCallback(
    async (repoRoot: string, worktree: WorktreeRow): Promise<void> => {
      // in-flight 재클릭 무시 (M5) — 진행 중이면 두 번째는 아무것도 안 한다 (고아 workspace 방지).
      if (openingWorktrees.current.has(worktree.path)) return
      openingWorktrees.current.add(worktree.path)
      // 여는 것도 사용자 의도다 — 앞서 기다리던 열기는 이 열기에 진다(LIFE-490 K2ⓒ).
      intentSeq.current += 1
      const seq = intentSeq.current
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
        // 응답은 그 workspace 가 state 에 들어오기 전에 올 수 있다 — 보류로 받는다(LIFE-490).
        if (result.ok && result.workspaceId !== null) adoptOpened({ workspaceId: result.workspaceId, seq })
      } finally {
        openingWorktrees.current.delete(worktree.path)
      }
    },
    [adoptOpened],
  )

  /**
   * 새 워크트리 생성 (LIFE-490 D3). 전에는 모달이 IPC 를 직접 부르고 활성을 건드리지 않아 새 워크트리가 뒤에 생기기만 했다
   * (198 은 생성 뒤 새 워크트리를 활성한다 — `worktree-jump-palette-create-worktree.ts:221`). 응답은 열기와 같은 경합에 걸리므로
   * 같은 보류로 받는다. 실패·거절이면 활성은 그대로다 — 알림은 모달이 띄운다.
   */
  const createWorktree = useCallback(
    async (input: { repoRoot: string; branch: string; path: string }): Promise<WorktreeActionResult> => {
      intentSeq.current += 1
      const seq = intentSeq.current
      const result = await window.corral.createWorktree(input)
      if (result.ok && result.workspaceId !== null) adoptOpened({ workspaceId: result.workspaceId, seq })
      return result
    },
    [adoptOpened],
  )

  const actions: LifecycleActions = {
    createRow: (workspaceId, kind) => void createRow({ workspaceId, kind }),
    reopenTab: (input) => void createRow({ workspaceId: input.workspaceId, kind: 'shell', reopen: input }),
    launchAgent: (input) => void launchAgent(input),
    closeTabs: ({ tabIds, alwaysConfirm, onClosed }) => {
      // 확인 모달이 떠 있는 동안 새 닫기 요청은 받지 않는다 — 모달은 한 번에 하나다(앞 요청의 onClosed 를 덮지 않게).
      if (pendingClose !== null) return
      void closeTarget({ target: { kind: 'tabs', tabIds, alwaysConfirm }, confirmed: false, onClosed, token: {} })
    },
    renameRow: (input) => void renameRow(input),
    clearRowName: (tabId) => void clearRowName(tabId),
    closeWorktree: (workspaceId) => void closeTarget({ target: { kind: 'workspace', workspaceId }, confirmed: false, token: {} }),
    openWorktree: (repoRoot, worktree) => void openWorktree(repoRoot, worktree),
    openCreateWorktree: (repoRoot) => {
      setLifecycleNotice(null)
      setWorktreeModal({ repoRoot })
    },
    activateWorkspace: (workspaceId) => setActive(workspaceId),
  }

  // 안정적인 함수 identity — ESC 닫기 useEffect 가 매 렌더 리스너를 갈아끼우지 않게.
  const dismissNotice = useCallback(() => setLifecycleNotice(null), [])
  const cancelPendingClose = useCallback(() => {
    // 취소 = 하나도 안 닫았다 — 다시 열기 기록도 없다.
    closeOwner.current = null
    consumingClose.current = null
    deferredClose.current = false
    setPendingClose(null)
  }, [])
  const closeWorktreeModal = useCallback(() => setWorktreeModal(null), [])
  const confirmPendingClose = useCallback((input?: { before: () => Promise<void> }) => {
    if (pendingClose === null || consumingClose.current === pendingClose) return
    const owner = closeOwner.current
    if (owner === null) return
    const request = pendingClose
    consumingClose.current = request
    // 콜백은 확인한 지금 잡는다(fix2 R2-01ⓐ) — 저장 뒤에 ref 를 다시 읽지 않는다.
    const close = (): void => {
      // 저장을 기다리는 동안 취소됐다 — 닫지 않는다.
      if (consumingClose.current !== request) return
      void closeTarget({ target: request.target, confirmed: true, onClosed: owner.onClosed, token: owner.token, confirmedPaneIds: request.running.map((pane) => pane.paneId) }).finally(() => {
        if (consumingClose.current === request) consumingClose.current = null
      })
    }
    if (input === undefined) close()
    else void input.before().then(close, close)
  }, [pendingClose, closeTarget])

  return {
    createShell,
    createAgentTab,
    selectedPane,
    shownTabRef,
    selectPane,
    selectPaneWhenReady,
    pendingRevealTab,
    revealTabHandled,
    activeWorkspaceId,
    lifecycleNotice,
    dismissNotice,
    pendingClose,
    confirmPendingClose,
    cancelPendingClose,
    worktreeModal,
    closeWorktreeModal,
    createWorktree,
    actions,
  }
}

function findPane({ state, paneId }: { state: AppState; paneId: string }): { workspaceId: string; agent: string | null } | null {
  for (const repo of state.repos)
    for (const worktree of repo.worktrees)
      for (const tab of worktree.workspace?.tabs ?? []) {
        const pane = tab.panes.find((entry) => entry.paneId === paneId)
        if (pane !== undefined) return pane
      }
  return null
}
