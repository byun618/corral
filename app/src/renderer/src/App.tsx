// 화면 오케스트레이터 — `repo → worktree → tab → pane` 4단 데이터를 Orca 배치(사이드바 카드 +
// 메인 탭바 + 상태바)로 그린다 (LIFE-357, Orca 직접 포팅 브랜치). 트리는 그리기, 동작은 IPC 로
// 내려보내는 관심사 분리는 그대로 유지한다 — 이 파일이 하는 일은 데이터를 각 컴포넌트에 나눠
// 주는 것뿐이고, 라이프사이클 로직 자체는 `hooks/useLifecycleActions.ts` 에 있다(옛 App.tsx
// 65-287줄에서 옮김, 로직 불변).
//
// 계측이 누를 수 있게 손잡이마다 `data-*` 를 단다 — 선택자가 화면 계약이다 (C7 매핑표 참고).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, PaneSplitDirection, RepoRow as RepoRowData, TabRow, WorkspaceRow } from '../../shared/types.js'
import { AddRepoModal } from './components/AddRepoModal.js'
import { ConfirmClose } from './components/ConfirmClose.js'
import { CreateWorktreeModal } from './components/CreateWorktreeModal.js'
import { EmptyGroup } from './components/EmptyGroup.js'
import { InlineNotice } from './components/InlineNotice.js'
import { GroupHeader } from './components/MainTabBar.js'
import { PaneGrid } from './components/PaneGrid.js'
import { tabOrdinals } from './fallback-ordinal.js'
import type { TabGroup } from './group-tree.js'
import type { LifecycleNotice } from './lifecycle-types.js'
import { paneTitleFrames, stabilizePaneTitles } from './pane-title-frames.js'
import { RemoveRepoConfirm } from './components/RemoveRepoConfirm.js'
import { Sidebar } from './components/Sidebar.js'
import { StatusBar } from './components/StatusBar.js'
import { TerminalChrome } from './components/TerminalChrome.js'
import './design-tokens.css'
import { useCellMetrics } from './hooks/useCellMetrics.js'
import { useGroupLayout } from './hooks/useGroupLayout.js'
import { useLifecycleActions } from './hooks/useLifecycleActions.js'
import { useTermGroupSync, type GroupDeclaration } from './hooks/useTermGroupSync.js'
import { useMemoryLabel } from './hooks/useMemoryLabel.js'
import { usePersistentCollapse } from './hooks/usePersistentCollapse.js'
import { useSidebarResize } from './hooks/useSidebarResize.js'
import { pickPane } from './pane-utils.js'
import { isAgentTab } from './session-title.js'
import { TerminalPane } from './TerminalPane.js'

function findWorkspace(state: AppState, workspaceId: string | null): WorkspaceRow | null {
  if (workspaceId === null) return null
  for (const repo of state.repos) {
    for (const worktree of repo.worktrees) {
      if (worktree.workspace !== null && worktree.workspace.workspaceId === workspaceId) return worktree.workspace
    }
  }
  return null
}

function findActiveTab(workspace: WorkspaceRow | null, selectedPane: string | null): TabRow | null {
  if (workspace === null) return null
  return workspace.tabs.find((tab) => tab.panes.some((pane) => pane.paneId === selectedPane)) ?? null
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalNote, setModalNote] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<RepoRowData | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const lifecycle = useLifecycleActions(state)
  const sidebarRef = useRef<HTMLDivElement | null>(null)
  const { width, onHandleMouseDown } = useSidebarResize(sidebarRef)
  const repoCollapse = usePersistentCollapse('collapsedRepos')
  const groupCollapse = usePersistentCollapse('collapsedGroups')
  const memoryLabel = useMemoryLabel()

  /**
   * 상태가 화면에 오기 **전에** pane 제목의 스피너 프레임을 억제한다 (C12).
   *
   * 한 자리에서 하는 이유는 사이드바와 탭바가 **같은 프레임**에 서야 하기 때문이다 — 각자
   * 억제하면 두 목록이 다른 글자에 멈춘다 (B6). 표시 함수는 순수하게 남는다.
   */
  /** 키 핸들러가 스테일 없이 최신 상태를 읽는 거울 — state 는 렌더용, ref 는 핸들러용. */
  const stateRef = useRef<AppState | null>(null)
  const receive = useCallback((next: AppState) => {
    const stabilized = { ...next, repos: stabilizePaneTitles({ repos: next.repos, frames: paneTitleFrames }) }
    stateRef.current = stabilized
    setState(stabilized)
  }, [])

  useEffect(() => {
    void window.corral.getState().then(receive)
    return window.corral.onState(receive)
  }, [receive])

  /**
   * 폴백 번호 배정표를 **첫 그림 전에** 싣는다 (C13).
   *
   * 다 싣기 전에는 부트 화면에 머문다 — 탭을 먼저 그리면 그 탭이 1번을 집어 저장값과 어긋나고,
   * 사용자 눈에는 번호가 한 번 튀었다가 제자리를 찾는 것으로 보인다. 읽기가 실패해도 화면은
   * 떠야 하므로 **실패도 「다 실었다」로 친다**(빈 배정표 = r7 동작).
   */
  const [ordinalsReady, setOrdinalsReady] = useState(false)
  /** 저장된 영역 배치 (F1-6) — 배정표와 **같은 읽기**에서 온다. 화면은 다 실은 뒤에 뜬다. */
  const [storedLayouts, setStoredLayouts] = useState<unknown[]>([])
  /** 마지막으로 저장한 배정표 — 안 바뀌었으면 파일을 다시 안 쓴다. */
  const savedOrdinals = useRef('')
  useEffect(() => {
    let cancelled = false
    window.corral
      .getUiPrefs()
      .then((prefs) => {
        if (cancelled) return
        tabOrdinals.hydrate(prefs.tabOrdinals)
        setStoredLayouts(prefs.groupLayouts)
      })
      .catch(() => {
        // 읽기 실패 — 빈 배정표로 간다.
      })
      .finally(() => {
        if (!cancelled) setOrdinalsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ESC 로 닫는다 — **문서에 건다** (모달 안 포커스 유무와 무관하게, 옛 App.tsx 121-161줄과 동일 이유).
  useEffect(() => {
    if (!modalOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setModalOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modalOpen])

  useEffect(() => {
    if (pendingRemove === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPendingRemove(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pendingRemove])

  useEffect(() => {
    if (lifecycle.pendingClose === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') lifecycle.cancelPendingClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lifecycle.pendingClose, lifecycle.cancelPendingClose])

  useEffect(() => {
    if (lifecycle.worktreeModal === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') lifecycle.closeWorktreeModal()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lifecycle.worktreeModal, lifecycle.closeWorktreeModal])

  /**
   * 폴백 번호 배정표를 **살아 있는 탭만** 남게 추린다 (C10, `fallback-ordinal.ts`).
   *
   * 배정은 컴포넌트가 처음 그릴 때 일어나고, 해제는 여기 한 곳에서만 한다 — 탭이 닫히면 그
   * 번호가 풀려 다음 탭이 그 자리를 쓴다. 렌더 뒤(effect)라 닫힌 탭의 번호가 **한 프레임** 더
   * 잡혀 있는데, 그 프레임에 새 탭이 생겨도 번호가 하나 밀릴 뿐 이미 그린 탭의 번호는 안 바뀐다.
   *
   * ⚠ **다 싣기 전에는 아무것도 하지 않는다** (`ordinalsReady`). 이 effect 는 화면이 부트 문구에
   * 머무는 동안에도 돈다 — 첫 상태가 hydrate 보다 먼저 오면 여기서 빈 배정표를 파일에 써서
   * 저장값을 지워버린다. 화면에서 실제로 그렇게 깨졌다 (raw/claude/r8-ordinal-wipe.md).
   * 추리는 범위도 **지금 열려 있는 워크스페이스 안**으로 좁힌다 — 같은 순간 열린 워크스페이스가
   * 하나도 없으면 `live` 가 비어서 배정표가 통째로 날아간다.
   */
  useEffect(() => {
    if (state === null || !ordinalsReady) return
    const live: string[] = []
    const shown: string[] = []
    for (const repo of state.repos) {
      for (const worktree of repo.worktrees) {
        const workspace = worktree.workspace
        if (workspace === null) continue
        shown.push(workspace.workspaceId)
        for (const tab of workspace.tabs) live.push(tab.tabId)
      }
    }
    tabOrdinals.keepOnly({ tabIds: live, groupIds: shown })
    // 배정이 **실제로 바뀐 때만** 저장한다 (C13) — 이 effect 는 상태 갱신마다 돌고,
    // ui-prefs 는 디바운스 없이 즉시 파일을 쓴다.
    const entries = tabOrdinals.entries()
    const serialized = JSON.stringify(entries)
    if (serialized === savedOrdinals.current) return
    savedOrdinals.current = serialized
    window.corral.setUiPrefs({ tabOrdinals: entries })
  }, [state, ordinalsReady])

  /**
   * pane 을 **다시 고른** 횟수 — 값이 바뀌면 활성 터미널이 포커스를 되찾는다 (TerminalPane).
   * 탭을 누른 뒤 곧바로 타건하는 흐름이 끊기지 않게 하는 자리다.
   */
  const [focusToken, setFocusToken] = useState(0)
  const selectPane = useCallback(
    (paneId: string) => {
      lifecycle.selectPane(paneId)
      setFocusToken((token) => token + 1)
    },
    [lifecycle],
  )

  /**
   * 사이드바에서 세션을 누르면 **그 탭이 배정된 영역으로 간다** (R3-e reveal — 옮기지 않는다).
   *
   * `selectPane` 만으로는 pane 만 바뀌고 그 탭을 안 보는 영역은 그대로라, 사용자가 누른 세션이
   * 화면 어디에도 안 뜨는 회차가 생긴다. 영역 활성 + 그 영역의 활성 탭까지 같이 옮긴다.
   */
  const revealPane = useCallback(
    (paneId: string) => {
      const owner = stateRef.current?.repos
        .flatMap((repo) => repo.worktrees)
        .flatMap((worktree) => worktree.workspace?.tabs ?? [])
        .find((tab) => tab.panes.some((pane) => pane.paneId === paneId))
      if (owner !== undefined) layoutRef.current.revealTab(owner.tabId)
      selectPane(paneId)
    },
    [selectPane],
  )

  // --- ① 영역 층 (LIFE-373) ------------------------------------------------------
  //
  // 화면이 보는 worktree 하나 → 그 worktree 의 영역 배치 → 영역마다 자기 탭 목록·활성 탭.
  // 영역 배치는 **worktree 경로**로 영속한다 (R3-h) — workspace_id 는 herdr 재기동에 안 산다.
  const activeWorktreeRow = useMemo(() => {
    if (state === null || lifecycle.activeWorkspaceId === null) return null
    return (
      state.repos
        .flatMap((repo) => repo.worktrees)
        .find((worktree) => worktree.openWorkspaceId !== null && worktree.openWorkspaceId === lifecycle.activeWorkspaceId) ?? null
    )
  }, [state, lifecycle.activeWorkspaceId])

  const activeWorkspaceRow = useMemo(
    () => (state === null ? null : findWorkspace(state, lifecycle.activeWorkspaceId)),
    [state, lifecycle.activeWorkspaceId],
  )
  /** 이 worktree 에 살아 있는 탭 — 배치를 추리는 기준이자 새 탭이 흘러드는 입구다 (F1-6·R3-d). */
  const liveTabIds = useMemo(() => activeWorkspaceRow?.tabs.map((tab) => tab.tabId) ?? [], [activeWorkspaceRow])
  const layout = useGroupLayout({
    worktreePath: activeWorktreeRow?.path ?? null,
    liveTabIds,
    ready: ordinalsReady,
    stored: storedLayouts,
  })

  const tabById = useCallback((tabId: string | null) => activeWorkspaceRow?.tabs.find((tab) => tab.tabId === tabId) ?? null, [activeWorkspaceRow])

  /**
   * 영역 선언 (§10-R13) — 영역 하나가 연결 하나다. `active` 인 영역이 **마지막에** 붙는다(S2-b).
   *
   * 탭이 없는 영역은 선언하지 않는다 — 붙을 탭이 없으면 연결을 열 이유가 없다(빈 상태 카드만).
   */
  const termGroups = useMemo<GroupDeclaration[]>(() => {
    const rows: GroupDeclaration[] = []
    for (const group of layout.groups) {
      const tab = tabById(group.activeTabId)
      if (tab === null) continue
      const pane = pickPane(tab)
      if (pane === null) continue
      rows.push({
        groupId: group.groupId,
        tabId: tab.tabId,
        activePaneId: pane.paneId,
        active: group.groupId === layout.activeGroupId,
      })
    }
    return rows
  }, [layout.groups, layout.activeGroupId, tabById])

  const cell = useCellMetrics()

  const termSync = useTermGroupSync({ groups: termGroups, cell })

  /** 키 핸들러가 읽는 배치 거울 — 핸들러를 매 렌더 다시 달지 않으려고 ref 로 둔다. */
  const layoutRef = useRef({
    activeGroupId: layout.activeGroupId,
    activeTabId: null as string | null,
    splitGroup: layout.splitGroup,
    closeGroup: layout.closeGroup,
    revealTab: layout.revealTab,
  })
  layoutRef.current = {
    activeGroupId: layout.activeGroupId,
    activeTabId: layout.groups.find((group) => group.groupId === layout.activeGroupId)?.activeTabId ?? null,
    splitGroup: layout.splitGroup,
    closeGroup: layout.closeGroup,
    revealTab: layout.revealTab,
  }
  /**
   * 영역을 활성으로 옮긴다 — **포커스 pane 도 같이 옮긴다**.
   *
   * 둘을 따로 두면 "B 영역을 눌렀는데 타건은 A 로 간다"가 된다. 활성 영역과 포커스 pane 은
   * 한 몸으로 움직여야 단축키(포커스 pane 기준)와 헤더(영역 기준)가 같은 것을 가리킨다.
   */
  const activateGroup = useCallback(
    (target: { groupId: string; paneId: string | null }): void => {
      layout.setActiveGroup(target.groupId)
      if (target.paneId !== null) selectPane(target.paneId)
    },
    [layout.setActiveGroup, selectPane],
  )

  // --- ② pane 동작 (대상 pane 을 **받아서** 한다) ---------------------------------
  //
  // 대상을 안에서 `selectedPane` 으로 집지 않는다. 영역이 여럿이라 그러면 **B 영역의 ▥ 를 눌렀는데
  // A 영역의 pane 이 쪼개진다** — 헤더 버튼은 자기 영역의 것이고, 그 영역을 활성화한다고 해서
  // 포커스 pane 이 같은 프레임에 따라오지도 않는다. 줄은 더 위험하다 — `session.zoom` 은 명부에 없는
  // paneId 를 무시하지만 서버 줄 깃발은 그대로 나가 격자와 서버 상태가 어긋난다(F2-3·S6가 재는 것).
  // 그래서 호출하는 쪽이 대상을 명시한다: 헤더·메뉴는 **그 영역의 활성 탭 pane**, 단축키는 포커스 pane.
  // 거절은 그대로 알림으로 올린다(강제로 밀지 않는다, §10-R8).
  const [paneError, setPaneError] = useState<string | null>(null)
  const splitPaneAt = useCallback(async (target: { paneId: string | null; direction: PaneSplitDirection }): Promise<void> => {
    if (target.paneId === null) return
    const result = await window.corral.splitPane({ paneId: target.paneId, direction: target.direction })
    setPaneError(result.ok ? null : result.error)
  }, [])
  const closePaneAt = useCallback(async (paneId: string | null): Promise<void> => {
    if (paneId === null) return
    const result = await window.corral.closePane({ paneId })
    setPaneError(result.ok ? null : result.error)
  }, [])

  /**
   * 줌 토글 (F2-3) — **격자 역산**이라 이 영역 상자의 격자를 같이 보낸다.
   *
   * 서버 rect 는 줌을 반영하지 않으므로(프리플라이트 ②) 화면은 "그 pane 의 inner 가 상자와
   * 같아지도록" 탭 격자를 키워서 그린다. 그 목표 격자가 곧 지금 상자의 격자다.
   */
  const toggleZoom = useCallback(
    (target: { groupId: string; paneId: string | null }): void => {
      const grid = termSync.gridOf(target.groupId)
      if (grid === null) return
      const current = stateRef.current?.terminalGroups.find((row) => row.groupId === target.groupId)?.zoomedPaneId ?? null
      // 이미 줄이 있으면 끄는 것이므로 대상은 null 이다. 켜는 쪽이면 대상이 없을 때 아무 것도 안 한다.
      if (current === null && target.paneId === null) return
      window.corral.termZoom({ groupId: target.groupId, paneId: current === null ? target.paneId : null, cols: grid.cols, rows: grid.rows })
    },
    [termSync],
  )

  /**
   * ① ② 단축키 — 한 자리에 모은다 (핸드오프 §1-6 "한 메뉴 두 섹션" 의 키 쪽).
   *
   *   ⌘D / ⌘⇧D      이 탭 **안에서** pane 분할 (herdr)
   *   ⌘⌥D / ⌘⌥⇧D   이 탭을 **새 영역으로** (화면)
   *   ⌘⌥W           영역 닫기 (F1-5)
   *   ⌘⇧Z           pane 줌 토글 (F2-3)
   *
   * ⌘T 는 `useLifecycleActions` 가 이미 들고 있다 — 두 군데서 같은 키를 잡지 않는다.
   * 편집 중인 입력칸에서는 아무것도 안 한다(리네임 입력이 `stopPropagation` 으로 먼저 막지만,
   * 그게 새면 여기서 한 번 더 막는다 — J-1 과 같은 두 겹 방어).
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        if (event.target.classList.contains('main-tab-rename')) return
      }
      const key = event.key.toLowerCase()
      if (key === 'd') {
        event.preventDefault()
        const direction = event.shiftKey ? 'down' : 'right'
        if (event.altKey) {
          const groupId = layoutRef.current.activeGroupId
          const tabId = layoutRef.current.activeTabId
          if (groupId === null || tabId === null) return
          layoutRef.current.splitGroup({ groupId, tabId, direction: direction === 'right' ? 'row' : 'column' })
          return
        }
        void splitPaneAt({ paneId: lifecycle.selectedPane, direction })
        return
      }
      if (key === 'w' && event.altKey) {
        event.preventDefault()
        const groupId = layoutRef.current.activeGroupId
        if (groupId !== null) layoutRef.current.closeGroup(groupId)
        return
      }
      if (key === 'z' && event.shiftKey) {
        event.preventDefault()
        const groupId = layoutRef.current.activeGroupId
        if (groupId !== null) toggleZoom({ groupId, paneId: lifecycle.selectedPane })
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [splitPaneAt, toggleZoom, lifecycle.selectedPane])

  // 렌더가 실제로 끝난 revision 을 main 로그에 남긴다 — 반영 지연(A1)의 화면 쪽 끝점이다.
  const lastReported = useRef(-1)
  useEffect(() => {
    if (state === null || state.revision === lastReported.current) return
    lastReported.current = state.revision
    window.corral.reportRendered(state.revision)
  })

  if (state === null || !ordinalsReady) return <div className="boot">부트스트랩…</div>

  const browse = async (): Promise<void> => {
    setBrowsing(true)
    setModalNote(null)
    try {
      const result = await window.corral.browseForRepos()
      if (result.canceled) return
      if (result.added.length > 0 || result.alreadyRegistered.length > 0) {
        setModalOpen(false)
        setNotice(result.message)
        return
      }
      setModalNote(result.message)
    } finally {
      setBrowsing(false)
    }
  }

  const removeRepo = async (repo: RepoRowData): Promise<void> => {
    setRemoveError(null)
    const result = await window.corral.removeRepo(repo.root)
    if (!result.ok) {
      setRemoveError(result.error ?? '알 수 없음')
      return
    }
    setPendingRemove(null)
  }

  /**
   * 영역 하나를 그린다 (F1-1·F1-3·F1-4) — 헤더 + 본문(활성 탭의 pane / 빈 상태 카드).
   *
   * 본문 상자(`.term-group`)가 **격자의 분모**다 (R13) — 그 상자에 `useTermGroupSync` 의 ref 를
   * 달아야 영역 크기가 곧 요청 격자가 된다. 영역이 하나뿐이면 `.term-group` 의 위치·패딩이
   * 전환 전과 같아 요청 격자도 같다(R13-a 실측).
   */
  /**
   * 영역 본문에 얹는 알림 (핸드오프 §2 InlineNotice K).
   *
   * **어느 영역에 뜨나**: 지금 포커스 영역이다. 핸드오프는 "그 탭이 활성인 영역"을 말하지만
   * `LifecycleNotice` 에 tabId 가 없다 — 라이프사이클 층이 탭을 안 실어 보낸다(App.tsx 의 옛
   * 창 단위 배너를 그대로 옮겨온 자리다). tabId 를 새로 뚫는 것은 ① 의 범위 밖이라, §10-R17-2 가
   * 구현자 재량으로 연 **기본안(포커스 영역)** 을 택하고 C5 로 기록한다.
   */
  const groupNotice: LifecycleNotice | null =
    lifecycle.lifecycleNotice ?? (paneError === null ? null : { kind: 'error', message: paneError })

  const renderGroup = ({ group, workspaceId }: { group: TabGroup; workspaceId: string }): React.JSX.Element => {
    const groupTabs = group.tabOrder.map((tabId) => tabById(tabId)).filter((tab): tab is TabRow => tab !== null)
    const groupActiveTab = tabById(group.activeTabId)
    const groupPane = groupActiveTab === null ? null : pickPane(groupActiveTab)
    const isActiveGroup = group.groupId === layout.activeGroupId
    const canCloseGroup = layout.groups.length > 1 ? () => layout.closeGroup(group.groupId) : null
    const groupState = state.terminalGroups.find((row) => row.groupId === group.groupId) ?? null
    return (
      <div className={`tab-group ${isActiveGroup ? 'is-active-group' : ''}`} data-tab-group={group.groupId} key={group.groupId}>
        <GroupHeader
          groupId={group.groupId}
          tabs={groupTabs}
          home={state.home}
          selectedPane={lifecycle.selectedPane}
          activeTabId={group.activeTabId}
          activeGroup={isActiveGroup}
          paneCount={groupActiveTab?.panes.length ?? 0}
          zoomed={groupState?.zoomedPaneId != null}
          onActivate={() => activateGroup({ groupId: group.groupId, paneId: groupPane?.paneId ?? null })}
          onSelectTab={(tab) => {
            layout.setActiveTab({ groupId: group.groupId, tabId: tab.tabId })
            const pane = pickPane(tab)
            if (pane !== null) selectPane(pane.paneId)
          }}
          onCreateShell={() => lifecycle.actions.createRow(workspaceId, 'shell')}
          onCloseTab={(tab) => lifecycle.actions.closeRow(tab.tabId)}
          onRenameTab={({ tab, label, tabCount }) => lifecycle.actions.renameRow({ tabId: tab.tabId, label, tabNumber: tab.number, tabCount })}
          onClearTabName={(tab) => lifecycle.actions.clearRowName(tab.tabId)}
          onSplitPane={(direction) => void splitPaneAt({ paneId: groupPane?.paneId ?? null, direction })}
          onMoveToGroup={({ tabId, direction }) => layout.splitGroup({ groupId: group.groupId, tabId, direction })}
          onZoom={() => toggleZoom({ groupId: group.groupId, paneId: groupPane?.paneId ?? null })}
          onClosePane={() => void closePaneAt(groupPane?.paneId ?? null)}
          onCloseGroup={canCloseGroup}
        />
        {isActiveGroup && groupNotice !== null ? (
          <InlineNotice
            notice={groupNotice}
            onDismiss={() => {
              setPaneError(null)
              lifecycle.dismissNotice()
            }}
          />
        ) : null}
        {groupPane === null ? (
          <EmptyGroup
            groupId={group.groupId}
            activeGroup={isActiveGroup}
            onCreateShell={() => lifecycle.actions.createRow(workspaceId, 'shell')}
            onCloseGroup={canCloseGroup}
          />
        ) : (
          <div
            className="term-group"
            data-term-group={group.groupId}
            ref={termSync.boxRef(group.groupId)}
            onMouseDown={() => activateGroup({ groupId: group.groupId, paneId: groupPane.paneId })}
          >
            <TerminalPane
              paneId={groupPane.paneId}
              diagnostics={state.diagnostics}
              focusable={isActiveGroup}
              focusToken={isActiveGroup ? focusToken : 0}
            />
          </div>
        )}
      </div>
    )
  }

  const activeWorkspace = findWorkspace(state, lifecycle.activeWorkspaceId)
  const activeWorktree = state.repos
    .flatMap((repo) => repo.worktrees)
    .find((worktree) => worktree.openWorkspaceId !== null && worktree.openWorkspaceId === lifecycle.activeWorkspaceId)
  const activeTab = findActiveTab(activeWorkspace, lifecycle.selectedPane)

  const allWorktrees = state.repos.flatMap((repo) => repo.worktrees)
  const dirtyTotal = allWorktrees.reduce(
    (sum, worktree) =>
      sum + worktree.gitStatus.staged + worktree.gitStatus.unstaged + worktree.gitStatus.untracked + worktree.gitStatus.conflicted,
    0,
  )
  const aheadTotal = allWorktrees.reduce((sum, worktree) => sum + (worktree.gitStatus.ahead ?? 0), 0)
  const behindTotal = allWorktrees.reduce((sum, worktree) => sum + (worktree.gitStatus.behind ?? 0), 0)

  // 활성 worktree 의 **전체** pane 수 (핸드오프 I) — 영역이 여럿이면 활성 탭 하나로는 못 센다.
  const paneCount = activeWorkspace?.tabs.reduce((sum, tab) => sum + tab.panes.length, 0) ?? 0
  const zoomedAnywhere = state.terminalGroups.some((group) => group.zoomedPaneId !== null)
  // 상태바의 `{n} agents` 는 **에이전트 세션 수**다 — 전체 탭 수가 아니다.
  // 09-gate1-fix.md D 가 사이드바를 에이전트 세션만 그리게 하고 01-criteria.md 부록이 "세션"을
  // 갈라 정의한 뒤로, 전체 탭을 "agents" 라고 부르면 사이드바(2행)와 상태바("4 agents")가
  // 같은 화면에서 서로 다른 말을 한다. E 의 원칙("근거 없는 수를 …인 양 보여주지 마라")과
  // 같은 결이라 라벨이 세는 것과 맞췄다. **지시서에 없던 판단이므로 결과 문서에 적는다.**
  const agentCount = activeWorkspace?.tabs.filter(isAgentTab).length ?? 0
  const terminal = state.terminal

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar
          sidebarRef={sidebarRef}
          width={width}
          state={state}
          activeWorkspaceId={lifecycle.activeWorkspaceId}
          selectedPane={lifecycle.selectedPane}
          selectPane={revealPane}
          actions={lifecycle.actions}
          isRepoCollapsed={repoCollapse.isCollapsed}
          toggleRepoCollapsed={repoCollapse.toggle}
          isGroupCollapsed={groupCollapse.isCollapsed}
          toggleGroupCollapsed={groupCollapse.toggle}
          onAddRepo={() => setModalOpen(true)}
          onRemoveRepo={(root) => {
            const repo = state.repos.find((item) => item.root === root)
            if (repo === undefined) return
            setRemoveError(null)
            setPendingRemove(repo)
          }}
          onRefresh={() => void window.corral.getState().then(setState)}
          groupGlyphOf={(worktreePath) => {
            // R17-2 공백 2 — 영속 스키마(R3-h)가 영역 수를 그대로 주므로 **넣는다**(비용 0).
            if (layout.groupCountOf(worktreePath) < 2) return null
            return layout.splitDirectionOf(worktreePath) === 'column' ? '⊟' : '◫'
          }}
        />
        <div className="sidebar-resizer" data-sidebar-resizer onMouseDown={onHandleMouseDown}>
          <div className="sidebar-resizer-line" data-sidebar-resizer-line />
        </div>

        <div className="main-area" data-main-area>
          {notice === null ? null : (
            <div className="inline-notice tone-info" data-add-notice>
              <span className="inline-notice-dot" />
              <span className="inline-notice-text">{notice}</span>
              <div className="inline-notice-spacer" />
              <button className="inline-notice-dismiss" onClick={() => setNotice(null)}>
                해제
              </button>
            </div>
          )}

          <TerminalChrome activeTab={activeTab}>
            {activeWorkspace === null || layout.layout === null ? (
              <div className="term-empty" data-term-empty />
            ) : (
              <PaneGrid
                root={layout.layout.root}
                onCommitRatio={layout.setRatio}
                cell={cell}
                renderGroup={(group) => renderGroup({ group, workspaceId: activeWorkspace.workspaceId })}
              />
            )}
          </TerminalChrome>
        </div>
      </div>

      <StatusBar
        activeWorktreeLabel={activeWorktree?.branch ?? activeWorktree?.path ?? null}
        dirtyTotal={dirtyTotal}
        aheadTotal={aheadTotal}
        behindTotal={behindTotal}
        groupCount={layout.groups.length}
        paneCount={paneCount}
        zoomed={zoomedAnywhere}
        agentCount={agentCount}
        termSize={terminal.cols === null || terminal.rows === null ? null : { cols: terminal.cols, rows: terminal.rows }}
        memoryLabel={memoryLabel}
      />

      {modalOpen ? (
        <AddRepoModal browsing={browsing} note={modalNote} onBrowse={() => void browse()} onClose={() => setModalOpen(false)} />
      ) : null}

      {pendingRemove === null ? null : (
        <RemoveRepoConfirm
          repo={pendingRemove}
          error={removeError}
          onConfirm={() => void removeRepo(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      {lifecycle.pendingClose === null ? null : (
        <ConfirmClose
          target={lifecycle.pendingClose.target}
          foreground={lifecycle.pendingClose.foreground}
          onConfirm={lifecycle.confirmPendingClose}
          onCancel={lifecycle.cancelPendingClose}
        />
      )}

      {lifecycle.worktreeModal === null ? null : (
        <CreateWorktreeModal
          repoRoot={lifecycle.worktreeModal.repoRoot}
          onClose={lifecycle.closeWorktreeModal}
          onDone={(message) => {
            lifecycle.closeWorktreeModal()
            setNotice(message)
          }}
        />
      )}
    </div>
  )
}
