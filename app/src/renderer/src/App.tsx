import { CommandPalette } from './components/CommandPalette.js'
import type { PaletteEntry } from './palette-search.js'
import type { ShortcutHandlers } from './hooks/useKeybindings.js'
import { ACTIONS, bindingsFor, formatBinding } from '../../shared/keybindings.js'
import { BindingLabels } from './hooks/BindingLabels.js'
import { useKeybindings } from './hooks/useKeybindings.js'
import { ShortcutSettings } from './components/ShortcutSettings.js'
// 화면 오케스트레이터 — `repo → worktree → tab → pane` 4단 데이터를 Orca 배치(사이드바 카드 +
// 메인 탭바 + 상태바)로 그린다 (LIFE-357, Orca 직접 포팅 브랜치). 트리는 그리기, 동작은 IPC 로
// 내려보내는 관심사 분리는 그대로 유지한다 — 이 파일이 하는 일은 데이터를 각 컴포넌트에 나눠
// 주는 것뿐이고, 라이프사이클 로직 자체는 `hooks/useLifecycleActions.ts` 에 있다(옛 App.tsx
// 65-287줄에서 옮김, 로직 불변).
//
// 계측이 누를 수 있게 손잡이마다 `data-*` 를 단다 — 선택자가 화면 계약이다 (C7 매핑표 참고).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentStatus, AppState, PaneDirection, PaneSplitDirection, RepoRow as RepoRowData, TabRow, WorkspaceRow } from '../../shared/types.js'
import { AddRepoModal } from './components/AddRepoModal.js'
import { ConfirmClose } from './components/ConfirmClose.js'
import { CreateWorktreeModal } from './components/CreateWorktreeModal.js'
import { DropZoneOverlay } from './components/DropZoneOverlay.js'
import { EmptyGroup } from './components/EmptyGroup.js'
import { InlineNotice } from './components/InlineNotice.js'
import { GroupHeader } from './components/MainTabBar.js'
import { MruSwitcher, type MruRow } from './components/MruSwitcher.js'
import { groupGlyphs, MRU_LIMIT, openMru, orderMru, stepMru, touchMru } from './mru-order.js'
import { numbersOf } from './pane-geometry.js'
import { PaneGrid } from './components/PaneGrid.js'
import { tabOrdinals } from './fallback-ordinal.js'
import { ONE_TAB_IN_GROUP } from './group-tree.js'
import type { TabGroup } from './group-tree.js'
import type { LifecycleNotice } from './lifecycle-types.js'
import { paneTitleFrames, stabilizePaneTitles } from './pane-title-frames.js'
import { RemoveRepoConfirm } from './components/RemoveRepoConfirm.js'
import { Sidebar } from './components/Sidebar.js'
import { StatusBar } from './components/StatusBar.js'
import { kindLabel, TerminalChrome, type PaneStripItem } from './components/TerminalChrome.js'
import { elapsedLabel } from './session-activity.js'
import { worktreeDisplayName } from './worktree-name.js'
import './design-tokens.css'
import { useCellMetrics } from './hooks/useCellMetrics.js'
import { useGroupLayout } from './hooks/useGroupLayout.js'
import { useLifecycleActions } from './hooks/useLifecycleActions.js'
import { useTermGroupSync, type GroupDeclaration } from './hooks/useTermGroupSync.js'
import { useMemoryLabel } from './hooks/useMemoryLabel.js'
import { usePersistentCollapse } from './hooks/usePersistentCollapse.js'
import { useSidebarResize } from './hooks/useSidebarResize.js'
import { useTabDrag } from './hooks/useTabDrag.js'
import { pickPane } from './pane-utils.js'
import { PaneLayout, type PaneSeat } from './components/PaneLayout.js'
import { agentPanes, sessionTitle } from './session-title.js'
import { keepTerminalFocus, TerminalPane } from './TerminalPane.js'

function findWorkspace(state: AppState, workspaceId: string | null): WorkspaceRow | null {
  if (workspaceId === null) return null
  for (const repo of state.repos) {
    for (const worktree of repo.worktrees) {
      if (worktree.workspace !== null && worktree.workspace.workspaceId === workspaceId) return worktree.workspace
    }
  }
  return null
}

/**
 * 홀드 중 **터미널이 키를 안 받는다**는 단서 (핸드오프 O) — xterm 이 포커스를 놓으면 모든
 * pane 의 커서가 저절로 외곽선이 된다. 픽셀 하나 새로 그리지 않고 이미 쓰는 어휘로 말한다.
 * 원복은 `focusToken` 을 올려서 한다 (취소도 확정도 포커스는 되돌아온다).
 */
function blurTerminal(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

/**
 * MRU 홀드 무동작 상한 (F3-3). `Control` keyup 도 창 blur 도 못 받은 회차를 여기서 끝낸다 —
 * 10초는 "홀드"로 볼 수 있는 상한을 넉넉히 넘긴 값이고, 넘겨 끝내는 쪽은 **취소**다.
 */
const MRU_HOLD_TIMEOUT_MS = 10_000

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalNote, setModalNote] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteReturn = useRef<HTMLElement | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const sidebarCollapsedRef = useRef(false)
  const toggleSidebar = (): void => {
    const next = !sidebarCollapsedRef.current
    sidebarCollapsedRef.current = next
    setSidebarCollapsed(next)
    window.corral.setUiPrefs({ sidebarCollapsed: next })
  }
  const [browsing, setBrowsing] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<RepoRowData | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const lifecycle = useLifecycleActions(state)
  const sidebarRef = useRef<HTMLDivElement | null>(null)
  const { width, onHandleMouseDown } = useSidebarResize(sidebarRef)
  const repoCollapse = usePersistentCollapse('collapsedRepos')
  // LIFE-467: 알약은 기본 **접힘**(Orca 와 같다) — 펼친 worktree 만 영속한다. 옛 `collapsedGroups`(기본 펼침)는 안 읽는다.
  const groupExpand = usePersistentCollapse('expandedAgentGroups')
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
        sidebarCollapsedRef.current = prefs.sidebarCollapsed
        setSidebarCollapsed(prefs.sidebarCollapsed)
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
    document.querySelector<HTMLButtonElement>('[data-close-confirm-cancel]')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') lifecycle.cancelPendingClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
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
  /**
   * **아직 못 편 reveal** — worktree 를 막 바꾼 순간의 배치는 아직 옛 worktree 의 것이다 (R3-i).
   *
   * `selectPane` 이 활성 workspace 를 옮기면 `useGroupLayout` 은 **다음 렌더**에 그 worktree 의
   * 배치를 들고 온다. 그래서 같은 틱의 `revealTab` 은 남의 배치에서 탭을 찾다가 false 로 끝난다.
   * 그 실패를 여기 적어 두고 배치가 바뀐 뒤 한 번 더 편다 — MRU 의 `⇄` 행이 이 길로 간다.
   */
  const pendingRevealRef = useRef<string | null>(null)
  const revealPane = useCallback(
    (paneId: string) => {
      const owner = stateRef.current?.repos
        .flatMap((repo) => repo.worktrees)
        .flatMap((worktree) => worktree.workspace?.tabs ?? [])
        .find((tab) => tab.panes.some((pane) => pane.paneId === paneId))
      pendingRevealRef.current = owner === undefined || layoutRef.current.revealTab(owner.tabId) ? null : owner.tabId
      selectPane(paneId)
    },
    [selectPane],
  )

  const [requestedPane, setRequestedPane] = useState<string | null>(null)
  const requestedDeadline = useRef<number | null>(null)
  useEffect(() => window.corral.onRevealPane(pane => { requestedDeadline.current = null; setRequestedPane(pane) }), [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = window.corral.onTerminalFocus(request => {
      if (timer) clearTimeout(timer)
      if (Date.now() >= request.deadlineAt) return
      requestedDeadline.current = request.deadlineAt
      setRequestedPane(request.paneId)
      const confirm = () => {
        if (Date.now() >= request.deadlineAt) { setRequestedPane(null); return }
        const selected = document.querySelector<HTMLElement>('[data-term-pane-box].is-selected')
        if (selected?.dataset.termPaneBox === request.paneId && selected.contains(document.activeElement)) {
          window.corral.terminalFocused(request.id, request.paneId)
          return
        }
        timer = setTimeout(confirm, 20)
      }
      timer = setTimeout(confirm, 20)
    })
    return () => { stop(); if (timer) clearTimeout(timer) }
  }, [])


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
   * LIFE-387 A1 — 탭 드래그. 판정은 `useTabDrag`(순수 함수 `tab-drag.ts` 를 DOM 에 잇는 층)가
   * 다 하고, 여기선 판정 결과를 어느 `layout` 함수로 커밋할지만 고른다(§4 동작 계약 표 그대로).
   */
  const tabDrag = useTabDrag({
    ownTabCountOf: (groupId) => layout.groups.find((group) => group.groupId === groupId)?.tabOrder.length ?? 0,
    onDrop: ({ tabId, fromGroupId, target }) => {
      switch (target.kind) {
        case 'tabbar':
          layout.moveTabWithinTabbar({ tabId, fromGroupId, toGroupId: target.groupId, index: target.index })
          return
        case 'split':
          if (target.groupId === fromGroupId) layout.splitGroup({ groupId: fromGroupId, tabId, direction: target.direction, edge: target.edge })
          else layout.splitGroupWithForeignTab({ tabId, fromGroupId, targetGroupId: target.groupId, direction: target.direction, edge: target.edge })
          return
        case 'merge':
          layout.mergeTabIntoGroup({ tabId, fromGroupId, toGroupId: target.groupId })
          return
        case 'self-noop':
        case 'invalid':
          return
      }
    },
  })

  // A CLI-created tab may arrive before the destination worktree layout has been restored.
  // Keep the request until both workspace and tab placement exist, then select the keyboard target.
  useEffect(() => {
    if (!requestedPane) return
    if (requestedDeadline.current !== null && Date.now() >= requestedDeadline.current) { setRequestedPane(null); return }
    const owner = state?.repos.flatMap(repo => repo.worktrees).flatMap(row => row.workspace?.tabs ?? [])
      .find(tab => tab.panes.some(pane => pane.paneId === requestedPane))
    if (!owner) return
    if (lifecycle.activeWorkspaceId !== owner.workspaceId) { selectPane(requestedPane); return }
    if (!layout.revealTab(owner.tabId)) return
    selectPane(requestedPane)
    setRequestedPane(null)
  }, [requestedPane, state, lifecycle.activeWorkspaceId, layout.revealTab, selectPane])

  /**
   * 못 편 reveal 을 **배치가 바뀐 뒤** 한 번 더 편다 (위 `pendingRevealRef`).
   *
   * 끝나는 갈래가 둘이다: 폈거나(`revealTab` true), 그 탭이 이 worktree 에 없거나. 후자까지
   * 지워야 옛 요청이 남아 **나중에 엉뚱한 탭을 스스로 여는** 일이 없다.
   */
  useEffect(() => {
    const tabId = pendingRevealRef.current
    if (tabId === null) return
    if (layout.revealTab(tabId) || !liveTabIds.includes(tabId)) pendingRevealRef.current = null
  }, [layout.revealTab, liveTabIds])

  /**
   * **방금 만든 탭을 편다** (G2′ · §10-R35-1) — `⌘T`·사이드바 `+`·메뉴 **세 경로 전부**가 여기로 온다.
   *
   * `createRow` 는 pane 선택만 예약했고 `activeTabId` 는 안 건드렸다. 이 앱은 **영역이 활성 탭을
   * 정하므로**(R3-a) 새 탭은 만들어지고도 **뒤에 조용히 숨어 있었다** — 게이트 ① 에서 사용자가
   * 잡은 것이고, 옛 통과선은 `selectedPane` 만 봐서 그걸 통과시켰다.
   *
   * 위 `pendingRevealRef` 와 같은 모양이되 **끝나는 조건이 다르다**: 그쪽은 이미 있는 탭을 겨누니
   * "이 worktree 에 없다"로 끝낼 수 있지만, 여기 탭은 **아직 안 왔을 뿐**이라 그 조건으로 지우면
   * 도착하기도 전에 요청을 버린다. **폈을 때만** 지운다.
   */
  useEffect(() => {
    const tabId = lifecycle.pendingRevealTab
    if (tabId === null) return
    if (layout.revealTab(tabId)) lifecycle.revealTabHandled()
  }, [lifecycle.pendingRevealTab, lifecycle.revealTabHandled, layout.revealTab, liveTabIds])

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
  const layoutMirror = {
    activeGroupId: layout.activeGroupId,
    activeTabId: layout.groups.find((group) => group.groupId === layout.activeGroupId)?.activeTabId ?? null,
    /** 활성 영역의 탭 수 — `⌘⌥D` 가 **거절 이유를 말하려면** 이게 필요하다 (G3′ · §10-R35-2). */
    activeTabCount: layout.groups.find((group) => group.groupId === layout.activeGroupId)?.tabOrder.length ?? 0,
    splitGroup: layout.splitGroup,
    closeGroup: layout.closeGroup,
    revealTab: layout.revealTab,
  }
  const layoutRef = useRef(layoutMirror)
  layoutRef.current = layoutMirror
  // --- ③ MRU 전환 (LIFE-373 · F3-1~F3-6) ------------------------------------------
  //
  // 키는 **document 의 캡처 단계**가 잡는다. 두 가지를 한 번에 푸는 자리다:
  //   ⓐ xterm 은 자기 textarea 에서 키를 듣는다 — 캡처는 document → … → textarea 순이라
  //     여기서 `stopPropagation()` 하면 **xterm 이 아예 못 본다**. `onData` 로 새지 않는다(R15).
  //   ⓑ main 의 `before-input-event` 에서 `preventDefault()` 하면 Chromium 이 **그 뒤 keyUp 을
  //     전부 버린다**(실측: `03-result.md` §10 「keyup 억제」. 내부 식별자 `suppress_events_until_keydown_`
  //     는 **추정**이고 공개 트리에서 확인 못 했다 — 근거는 이름이 아니라 그 실측이다). 홀드를 여는 `⌃Tab` 을 거기서
  //     삼키면 확정 신호인 `Control` keyup 이 같이 사라진다 — 기준서가 권한 경로(F3-1)가 그
  //     기준서의 다른 통과선(F3-2 "Ctrl keyup 확정")을 깨는 자리라, 실측을 따라 여기로 옮겼다.
  //
  // `⌃Tab` 은 메뉴가 안 쥔 키다(`menu-dump` 실측: 메뉴 액셀러레이터는 ⌘Q·⌘W·⌘A·⌘C·⌘V·⌘X 뿐).
  // 그래서 페이지가 직접 받을 수 있고, `⌘W` 와 달리 main 이 뺏어 올 이유가 없다.
  //
  // 화면이 들고 있는 것은 둘뿐이다: 최근 포커스 **기록**(ref — 렌더 대상이 아니다)과 홀드 중인
  // **목록 상태**. 순서·자리 계산은 전부 `mru-order.ts` 의 순수 함수다.

  /** 최근 포커스 순서 (앞이 최근). pane 을 고르는 **모든 길**이 여기 찍힌다 — 선택 자체를 보므로. */
  const mruHistoryRef = useRef<string[]>([])
  useEffect(() => {
    if (lifecycle.selectedPane === null) return
    mruHistoryRef.current = touchMru({ history: mruHistoryRef.current, paneId: lifecycle.selectedPane })
  }, [lifecycle.selectedPane])

  /**
   * 홀드 중 목록. `order` 는 **열 때 찍은 스냅숏**이다 — 홀드 사이에 상태 push 가 와도 고른
   * 자리가 발밑에서 안 밀린다. 그 사이 죽은 pane 은 그릴 때 빠지고, 확정해도 아무 일이 없다.
   */
  const [mru, setMru] = useState<{ order: string[]; index: number; at: number } | null>(null)
  /** 키 핸들러가 읽는 거울 (`closeTargetRef` 와 같은 결 — 뜻이 IPC 로 늦게 온다). */
  const mruRef = useRef<{ order: string[]; index: number; at: number } | null>(null)
  mruRef.current = mru

  /**
   * MRU 가 세는 pane — **열려 있는 모든 worktree** 다 (F3-4 전체 범위). 활성 worktree 로 안 좁힌다.
   */
  const mruPanes = useMemo(() => {
    if (state === null) return []
    const rows: {
      paneId: string
      tab: TabRow
      tabCount: number
      paneIndex: number
      agent: string | null
      status: AgentStatus
      worktree: string
      sameWorktree: boolean
    }[] = []
    for (const repo of state.repos) {
      for (const worktree of repo.worktrees) {
        const workspace = worktree.workspace
        if (workspace === null) continue
        const sameWorktree = workspace.workspaceId === lifecycle.activeWorkspaceId
        for (const tab of workspace.tabs) {
          tab.panes.forEach((pane, paneIndex) => {
            rows.push({
              paneId: pane.paneId,
              tab,
              tabCount: workspace.tabs.length,
              paneIndex,
              agent: pane.agent,
              status: pane.agentStatus,
              worktree: worktreeDisplayName(worktree),
              sameWorktree,
            })
          })
        }
      }
    }
    return rows
  }, [state, lifecycle.activeWorkspaceId])
  const mruPanesRef = useRef(mruPanes)
  mruPanesRef.current = mruPanes


  /** 홀드를 접고 포커스만 돌려준다 — **상태는 하나도 안 건드린다** (F3-5 취소 무결성). */
  const mruCancel = useCallback(() => {
    if (mruRef.current === null) return
    mruRef.current = null
    setMru(null)
    setFocusToken((token) => token + 1)
  }, [])

  /**
   * 고른 pane 으로 간다 (F3-2 확정).
   *
   * 같은 worktree 면 reveal + pane 포커스, 다른 worktree 면 `selectPane` 이 활성 workspace 를
   * 옮기고 `pendingRevealRef` 가 다음 배치에서 편다 (R3-i). 홀드 사이에 그 pane 이 죽었으면
   * **아무 데도 안 간다** — 없는 자리로 옮기느니 제자리다.
   */
  const mruCommit = useCallback(() => {
    const current = mruRef.current
    if (current === null) return
    mruRef.current = null
    setMru(null)
    const paneId = current.order[current.index]
    if (paneId === undefined || !mruPanesRef.current.some((pane) => pane.paneId === paneId)) {
      setFocusToken((token) => token + 1)
      return
    }
    revealPane(paneId)
  }, [revealPane])

  /**
   * 홀드 **무동작 상한** (F3-3 폴백). `Control` keyup 도 blur 도 못 받은 회차가 이 자리에 온다.
   * 넘겨 끝내는 쪽은 **취소**다 — 사용자가 안 고른 pane 으로 화면을 옮기느니 아무 일도 안 한다.
   */
  const mruTimerRef = useRef<number | null>(null)
  const mruArm = useCallback(() => {
    if (mruTimerRef.current !== null) window.clearTimeout(mruTimerRef.current)
    mruTimerRef.current = window.setTimeout(() => mruCancel(), MRU_HOLD_TIMEOUT_MS)
  }, [mruCancel])

  /**
   * `⌃Tab` 홀드 — **캡처 단계**에서 잡는다 (이 절 머리말 ⓐⓑ).
   *
   * 홀드 중에는 **모든 keydown 을 삼킨다**: 통과선이 "홀드 동안 어떤 pane 의 PTY 에도 1바이트도"
   * 이고(F3-6), 화면 약속도 "목록이 키를 받는 중"이다(핸드오프 O). `Control` keyup 은 **막지
   * 않는다** — 그게 확정 신호다(F3-3, electron#37336 이 경고한 자리).
   */
  /**
   * 키 핸들러가 부르는 동작들 — 리스너를 **한 번만** 달려고 ref 로 넘긴다.
   *
   * 의존성으로 넘기면 `revealPane` 이 매 렌더 새 함수라 effect 가 매번 다시 붙고, 그때마다
   * cleanup 이 돌아 **홀드 타이머를 지운다** — 실측에서 10초 타임아웃이 영영 안 왔다
   * (`raw/claude/f3-mru.json` 1회차 `F3_3_타임아웃.닫혔나: false`). 리스너를 고정하면
   * 타이머도 산다.
   */
  const mruOps = useRef({ commit: mruCommit, cancel: mruCancel, arm: mruArm })
  mruOps.current = { commit: mruCommit, cancel: mruCancel, arm: mruArm }

  const stepMruHold = (backward: boolean): void => {
    mruOps.current.arm()
    const current = mruRef.current
    if (current !== null) {
      const next = { ...current, index: stepMru({ index: current.index, count: current.order.length, backward }) }
      mruRef.current = next
      setMru(next)
      return
    }
    const order = orderMru({ history: mruHistoryRef.current, livePaneIds: mruPanesRef.current.map((pane) => pane.paneId) })
    if (order.length === 0) return
    blurTerminal()
    const opened = { order, index: openMru({ count: order.length, backward }), at: Date.now() }
    mruRef.current = opened
    setMru(opened)
  }

  useEffect(() => {
    const swallow = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (mruRef.current === null) return
      swallow(event)
      switch (event.key) {
        case 'Tab':
          // `Control` 이 유실돼도 `Tab` 은 목록의 것이다 (홀드가 열려 있는 동안에는).
          stepMruHold(event.shiftKey)
          return
        case 'Enter':
          mruOps.current.commit()
          return
        case 'Escape':
          mruOps.current.cancel()
          return
        case 'Control':
        case 'Shift':
        case 'Alt':
        case 'Meta':
          return
        default:
          // `Control` 이 이미 올라가 있다 = keyup 을 놓쳤다. 놓은 순간의 뜻대로 확정한다.
          if (!event.ctrlKey) mruOps.current.commit()
          return
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      // **절대 `preventDefault` 하지 않는다** (electron#37336) — 보기만 하고 확정한다.
      if (event.key === 'Control') mruOps.current.commit()
    }
    // 창이 포커스를 잃으면 취소 (F3-2 blur). keyup 을 못 받는 회차의 폴백이기도 하다.
    const onBlur = (): void => mruOps.current.cancel()
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      if (mruTimerRef.current !== null) window.clearTimeout(mruTimerRef.current)
    }
  }, [])

  /**
   * `⌘W` 가 겨누는 자리 (F2-5) — **활성 영역의 탭과 그 탭의 pane 들**.
   *
   * 키는 main 이 메뉴에서 뺏어 오므로(R23) 뜻이 IPC 로 늦게 도착한다. 그 사이 렌더가 몇 번
   * 돌든 **가장 최근 화면**을 겨눠야 해서 ref 로 둔다 — `layoutRef` 와 같은 결이다.
   */
  const closeTargetRef = useRef<{ tabId: string | null; paneIds: string[] }>({ tabId: null, paneIds: [] })
  {
    const tab = tabById(layoutRef.current.activeTabId)
    closeTargetRef.current = { tabId: tab?.tabId ?? null, paneIds: tab?.panes.map((pane) => pane.paneId) ?? [] }
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
  /** 거절이 아니라 **안내** 한 줄 (G3′) — 실패 문구(`실패: …`)로 감싸지 않는다. */
  const [groupHint, setGroupHint] = useState<string | null>(null)
  const splitPaneAt = useCallback(
    async (target: { paneId: string | null; direction: PaneSplitDirection }): Promise<void> => {
      if (target.paneId === null) return
      const result = await window.corral.splitPane({ paneId: target.paneId, direction: target.direction })
      setPaneError(result.ok ? null : result.error)
      // **분할 직후 새 pane 으로 선택을 옮긴다** (F2-7 — 게이트 ① 사용자 지적 1).
      // 서버 포커스는 계속 `focus: false` 다: 옮기는 것은 **렌더러의 선택**이고, herdr 세션 전역
      // 포커스는 안 끌고 간다 (F2-4 `pane.neighbor` 와 같은 논거). 새 pane 이 store 에 도착한
      // 뒤에 선택해야 자동 선택 이펙트가 그것을 덮지 않는다 — `selectPaneWhenReady` 가 그 자리다.
      if (result.ok && result.paneId !== null) lifecycle.selectPaneWhenReady(result.paneId)
    },
    [lifecycle.selectPaneWhenReady],
  )
  /** 경계 드래그 끝(F2-2). 끄는 동안은 아무것도 안 보내고 여기서 1회다. */
  const resizePaneAt = useCallback(
    async (input: { paneId: string; direction: PaneDirection; amount: number }): Promise<void> => {
      const result = await window.corral.resizePane(input)
      setPaneError(result.ok ? null : result.error)
    },
    [],
  )
  /**
   * 인접 pane 으로 포커스 (F2-4). **누가 이웃인지는 서버가 정한다** — 화면 좌표로 고르지 않는다.
   *
   * `terminal.focus_direction` 이 아니라 `pane.neighbor` 다(main 쪽 주석): focus_direction 은 herdr
   * 세션 전역 포커스를 움직여 사용자의 TUI 클라이언트까지 끌고 간다. 이웃이 없으면 아무것도 안 한다.
   */
  const focusNeighbor = useCallback(
    async (target: { paneId: string | null; direction: PaneDirection }): Promise<void> => {
      if (target.paneId === null) return
      const result = await window.corral.focusPaneDirection({ paneId: target.paneId, direction: target.direction })
      if (!result.ok) {
        setPaneError(result.error)
        return
      }
      setPaneError(null)
      if (result.paneId !== null) selectPane(result.paneId)
    },
    [selectPane],
  )
  const closePaneAt = useCallback(async (paneId: string | null): Promise<void> => {
    if (paneId === null) return
    const result = await window.corral.closePane({ paneId })
    setPaneError(result.ok ? null : result.error)
  }, [])

  /**
   * 줌 토글 (F2-3) — 이 영역 상자의 **지금 격자를 그대로** 같이 보낸다.
   *
   * **격자 역산은 §10-R22-1 에서 철회됐다.** 서버가 줌을 반영해 접어서 보내므로(줌 중에는 그
   * pane 하나만 서피스로 온다) 클라이언트가 격자를 키울 일이 없다 — 역산을 달았을 때 13칸 pane
   * 줌이 요청 격자를 1139×85(13.5배)로 부풀렸고, 걷어낸 뒤에는 135×53 그대로다.
   * 여기서 `cols`·`rows` 를 싣는 것은 **줌 토글이 격자를 안 흔든다**는 것을 서버 쪽에서도
   * 같은 수로 보게 하려는 것뿐이다 (F2-3d).
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

  // A single action lookup serves renderer keys and the existing main Cmd+W channel.
  const modalBlocked = shortcutsOpen || modalOpen || pendingRemove !== null || lifecycle.pendingClose !== null || lifecycle.worktreeModal !== null
  const openPalette = (): void => {
    if (modalBlocked || document.querySelector('.main-tab-rename.is-editing')) return
    paletteReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    mruCancel()
    setPaletteOpen(true)
  }
  const handlers: ShortcutHandlers = {
    'palette.open': openPalette,
    'terminal.new': () => lifecycle.createShell(),
    'mru.open': (variant) => stepMruHold(variant === 1),
    'terminal.split': (variant) => void splitPaneAt({ paneId: lifecycle.selectedPane, direction: variant === 1 ? 'down' : 'right' }),
    'group.split': (variant) => {
      const { activeGroupId: groupId, activeTabId: tabId, activeTabCount } = layoutRef.current
      if (groupId === null || tabId === null) return
      if (activeTabCount < 2) { setGroupHint(ONE_TAB_IN_GROUP); return }
      setGroupHint(null)
      layoutRef.current.splitGroup({ groupId, tabId, direction: variant === 1 ? 'column' : 'row' })
    },
    'terminal.focus': (variant) => void focusNeighbor({ paneId: lifecycle.selectedPane, direction: (['left', 'right', 'up', 'down'] as const)[variant]! }),
    'group.close': () => {
      const groupId = layoutRef.current.activeGroupId
      if (groupId !== null) layoutRef.current.closeGroup(groupId)
    },
    'terminal.zoom': () => {
      const groupId = layoutRef.current.activeGroupId
      if (groupId !== null) toggleZoom({ groupId, paneId: lifecycle.selectedPane })
    },
    'terminal.close': () => {
      const target = closeTargetRef.current
      if (target.tabId === null) return
      if (target.paneIds.length <= 1) { lifecycle.actions.closeRow(target.tabId); return }
      void closePaneAt(target.paneIds.find((id) => id === lifecycle.selectedPane) ?? target.paneIds[0] ?? null)
    },
    'sidebar.toggle': toggleSidebar,
  }
  const keymap = useKeybindings(handlers, modalBlocked || paletteOpen, () => {
    if (mruRef.current === null) return false
    mruCancel()
    return true
  })

  // 렌더가 실제로 끝난 revision 을 main 로그에 남긴다 — 반영 지연(A1)의 화면 쪽 끝점이다.
  const lastReported = useRef(-1)
  useEffect(() => {
    if (state === null || state.revision === lastReported.current) return
    lastReported.current = state.revision
    window.corral.reportRendered(state.revision)
  })

  if (state === null || !ordinalsReady || !keymap.ready) return <div className="boot">부트스트랩…</div>

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
    lifecycle.lifecycleNotice ??
    (paneError !== null ? { kind: 'error', message: paneError } : groupHint !== null ? { kind: 'info', message: groupHint } : null)

  const renderGroup = ({ group, workspaceId }: { group: TabGroup; workspaceId: string }): React.JSX.Element => {
    const groupTabs = group.tabOrder.map((tabId) => tabById(tabId)).filter((tab): tab is TabRow => tab !== null)
    const groupActiveTab = tabById(group.activeTabId)
    const groupPane = groupActiveTab === null ? null : pickPane(groupActiveTab)
    const isActiveGroup = group.groupId === layout.activeGroupId
    const canCloseGroup = layout.groups.length > 1 ? () => layout.closeGroup(group.groupId) : null
    const groupState = state.terminalGroups.find((row) => row.groupId === group.groupId) ?? null
    /**
     * **이 영역의 선택 pane** — 헤더 액션·포커스가 겨누는 대상이다 (② 에서 pane 이 여럿이 된다).
     *
     * 창 전체의 선택 pane 이 이 영역의 탭에 속할 때만 그것을 쓰고, 아니면 그 탭이 원래 보던
     * pane 으로 떨어진다. ① 에서 잡은 "헤더가 남의 pane 을 건드린다"의 pane 판이다 — 대상은
     * 언제나 **누른 그 영역** 안에서 나와야 한다.
     */
    const groupSelectedPaneId =
      groupActiveTab === null
        ? null
        : (groupActiveTab.panes.find((pane) => pane.paneId === lifecycle.selectedPane)?.paneId ?? groupPane?.paneId ?? null)
    /** 헤더가 보이는 격자 — **선택 pane 의 내용 셀**이다 (장식 제외, 줌 중엔 커진 값). */
    const selectedView = groupState?.panes.find((pane) => pane.paneId === groupSelectedPaneId) ?? null
    const gridOfSelected = selectedView === null ? null : { cols: selectedView.innerRect.width, rows: selectedView.innerRect.height }
    /** herdr 가 준 pane 사각형 + 같은 pane 의 목록 행(종류). 번호는 **화면 읽는 순서**다. */
    const paneNumbers = groupState === null ? new Map<string, number>() : numbersOf(groupState.panes)
    const seats: PaneSeat[] =
      groupState === null || groupActiveTab === null
        ? []
        : groupState.panes.map((view) => ({
            view,
            row: groupActiveTab.panes.find((pane) => pane.paneId === view.paneId) ?? null,
            number: paneNumbers.get(view.paneId) ?? 0,
          }))
    return (
      <div className={`tab-group ${isActiveGroup ? 'is-active-group' : ''}`} data-tab-group={group.groupId} key={group.groupId}>
        <GroupHeader
          groupId={group.groupId}
          tabs={groupTabs}
          workspaceTabCount={activeWorkspaceRow?.tabs.length ?? groupTabs.length}
          home={state.home}
          selectedPane={groupSelectedPaneId}
          activeTabId={group.activeTabId}
          activeGroup={isActiveGroup}
          paneCount={groupActiveTab?.panes.length ?? 0}
          grid={gridOfSelected}
          zoomed={groupState?.zoomedPaneId != null}
          onActivate={() => activateGroup({ groupId: group.groupId, paneId: groupSelectedPaneId })}
          onTabDragStart={(event, tabId) => tabDrag.onArm(event, { tabId, fromGroupId: group.groupId })}
          onSelectTab={(tab) => {
            // LIFE-387 A1 — 문턱을 넘긴 드래그 뒤에 따라오는 click 하나는 활성화로 치지 않는다.
            if (tabDrag.consumeClick()) return
            layout.setActiveTab({ groupId: group.groupId, tabId: tab.tabId })
            const pane = pickPane(tab)
            if (pane !== null) selectPane(pane.paneId)
          }}
          onCreateShell={() => lifecycle.actions.createRow(workspaceId, 'shell')}
          onCloseTab={(tab) => lifecycle.actions.closeRow(tab.tabId)}
          onRenameTab={({ tab, label, tabCount }) => lifecycle.actions.renameRow({ tabId: tab.tabId, label, tabNumber: tab.number, tabCount })}
          onClearTabName={(tab) => lifecycle.actions.clearRowName(tab.tabId)}
          onSplitPane={(direction) => void splitPaneAt({ paneId: groupSelectedPaneId, direction })}
          onMoveToGroup={({ tabId, direction }) => layout.splitGroup({ groupId: group.groupId, tabId, direction })}
          onZoom={() => toggleZoom({ groupId: group.groupId, paneId: groupSelectedPaneId })}
          onClosePane={() => void closePaneAt(groupSelectedPaneId)}
          onCloseGroup={canCloseGroup}
          // LIFE-387 A1/B1 — "다른 영역으로 옮기기". 라벨은 herdr 원 label(sessionTitle 전체
          // 파생은 그 영역의 selectedPane 등 별도 문맥이 필요해 과한 비용 — 메뉴 한 줄 식별에는
          // 이 정도로 충분하다는 판단, 03-result.md 에 단순화로 기록).
          otherGroups={layout.groups
            .filter((other) => other.groupId !== group.groupId)
            .map((other) => ({ groupId: other.groupId, label: tabById(other.activeTabId)?.label ?? '비어 있음' }))}
          onMoveToOtherGroup={({ tabId, targetGroupId }) =>
            layout.mergeTabIntoGroup({ tabId, fromGroupId: group.groupId, toGroupId: targetGroupId })
          }
        />
        {isActiveGroup && groupNotice !== null ? (
          <InlineNotice
            notice={groupNotice}
            onDismiss={() => {
              setPaneError(null)
              setGroupHint(null)
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
            // LIFE-387 B1 F-B1-6 — 빈 영역이 드래그의 유효 병합 타깃일 때만 켠다(§2 EmptyGroup).
            isDropTarget={
              tabDrag.dragState !== null &&
              tabDrag.dragState.target.kind === 'merge' &&
              tabDrag.dragState.target.groupId === group.groupId
            }
          />
        ) : (
          <div
            className="term-group"
            data-term-group={group.groupId}
            data-pane-count={seats.length}
            /**
             * 영역 **배경**을 눌렀을 때만 활성화한다 (F2-8).
             *
             * pane 상자를 누르면 그 상자의 `onMouseDown` 이 **먼저** 자기 paneId 로 활성화하는데,
             * 이 핸들러가 버블로 뒤따라 돌면서 `groupSelectedPaneId` — 렌더에 갇힌 **옛 선택** —
             * 으로 다시 `selectPane` 을 불러 **방금 고른 pane 을 덮었다**. 그래서 "핸들러는 붙어
             * 있고 이벤트도 도달하는데 선택이 안 바뀐다"로 보였다(게이트 ① 사용자 지적 2).
             * `stopPropagation` 으로 막지 않는 이유: 그러면 네이티브 이벤트가 문서까지 못 가서
             * 문서 mousedown 으로 닫는 메뉴(RepoRowMenu·TabContextMenu)가 안 닫힌다.
             */
            onMouseDown={(event) => {
              if (event.target instanceof Element && event.target.closest('[data-term-pane-box]') !== null) return
              keepTerminalFocus(event)
              activateGroup({ groupId: group.groupId, paneId: groupSelectedPaneId })
            }}
          >
            {/**
             * **격자의 분모이자 pane 좌표의 원점**이다 (R13).
             *
             * `.term-group` 을 재면 안 된다 — 전역 `box-sizing: border-box` 때문에
             * `getComputedStyle().width` 가 **패딩까지 포함한 값**을 준다. 실측: 1066×785 를
             * 돌려주는데 터미널이 실제로 서는 곳은 1034×769 라, 격자를 136×52 로 요청해 놓고
             * 132×51 만 보였다(오른쪽 4열·아래 1행이 잘렸다). 산식(FitAddon 이식)은 그대로 두고
             * **패딩이 없는 상자**를 재게 한다 — FitAddon 도 xterm 의 부모를 재고, 그 부모에는
             * 패딩이 없다. 그래서 C2 의 "같은 산식" 논거가 그대로 산다.
             */}
            <div className="term-pane-stack" data-term-box={group.groupId} ref={termSync.boxRef(group.groupId)}>
            {seats.length === 0 || groupState === null ? (
              // 첫 프레임 전에는 herdr 사각형이 없다 — 그 사이에도 터미널은 서 있어야 한다.
              // 단일 pane 경로(LIFE-353 C2)와 **같은 DOM** 이다.
              // pane 상자는 **자기 선택을 스스로 말한다** — 위 `.term-group` 가드가 pane 상자 안을
              // 건너뛰므로, 이 단일 pane 경로에도 같은 핸들러가 있어야 비활성 영역을 눌러 활성으로
              // 옮길 수 있다 (F1-3). PaneLayout 의 `onSelect` 와 같은 자리다.
              <div
                className="term-pane is-selected"
                data-term-pane-box={groupPane.paneId}
                style={{ inset: 0 }}
                onMouseDown={(event) => {
                  keepTerminalFocus(event)
                  activateGroup({ groupId: group.groupId, paneId: groupPane.paneId })
                }}
              >
                <div className="term-pane-inner" style={{ inset: 0 }}>
                  <TerminalPane
                    paneId={groupPane.paneId}
                    diagnostics={state.diagnostics}
                    focusable={isActiveGroup && !paletteOpen && !modalBlocked}
                    focusToken={isActiveGroup && !paletteOpen && !modalBlocked ? focusToken : 0}
                    /* 비활성 영역은 herdr 세션 포커스를 가져가지 않는다 (S2-b — PaneLayout 과 같은 규칙). */
                    announceFocus={isActiveGroup}
                  />
                </div>
              </div>
            ) : (
              <PaneLayout
                seats={seats}
                cell={cell}
                zoomedPaneId={groupState.zoomedPaneId}
                selectedPaneId={groupSelectedPaneId}
                focusable={isActiveGroup && !paletteOpen && !modalBlocked}
                focusToken={focusToken}
                diagnostics={state.diagnostics}
                onSelect={(paneId) => activateGroup({ groupId: group.groupId, paneId })}
                onCommitResize={(input) => void resizePaneAt(input)}
              />
            )}
            </div>
          </div>
        )}
      </div>
    )
  }

  const activeWorkspace = findWorkspace(state, lifecycle.activeWorkspaceId)
  const activeWorktree = state.repos
    .flatMap((repo) => repo.worktrees)
    .find((worktree) => worktree.openWorkspaceId !== null && worktree.openWorkspaceId === lifecycle.activeWorkspaceId)
  /**
   * 힌트줄 pane 스트립 (§10-R21-1b) — **활성 영역의** pane 들을 화면 읽는 순서로.
   *
   * 번호는 `numbersOf` 한 곳에서만 나온다. 스트립과 MRU 가 같은 수를 써야 하고, 레이아웃이
   * 안 바뀌면 흔들리지 않아야 한다 (코디네이터 단서 2개).
   */
  const activeGroupPanes = state.terminalGroups.find((group) => group.groupId === layout.activeGroupId)?.panes ?? []
  const agentOfPane = new Map(
    (activeWorkspace?.tabs ?? []).flatMap((tab) => tab.panes.map((pane) => [pane.paneId, pane.agent])),
  )
  const stripNumbers = numbersOf(activeGroupPanes)
  const stripPanes: PaneStripItem[] = [...activeGroupPanes]
    .sort((a, b) => (stripNumbers.get(a.paneId) ?? 0) - (stripNumbers.get(b.paneId) ?? 0))
    .map((view) => ({
      paneId: view.paneId,
      number: stripNumbers.get(view.paneId) ?? 0,
      agent: agentOfPane.get(view.paneId) ?? null,
      selected: view.paneId === lifecycle.selectedPane,
    }))

  /**
   * MRU 행 — **홀드 중에만** 만든다 (F3-4).
   *
   * 번호·종류는 스트립과 **같은 표**에서 나온다 (`numbersOf`·`kindLabel`, C5-8) — 두 자리가
   * 다른 수를 말하면 "pane 2" 가 어느 것인지 화면이 스스로 못 정한다. 서버 사각형이 없는 pane
   * (다른 worktree·안 보이는 탭)은 그 표에 없으므로 **탭 안 자리**로 떨어진다.
   */
  const mruRows: MruRow[] = []
  if (mru !== null) {
    const numbers = new Map<string, number>()
    for (const group of state.terminalGroups) for (const [paneId, number] of numbersOf(group.panes)) numbers.set(paneId, number)
    const root = layout.layout?.root ?? null
    const glyphs = groupGlyphs({
      groupIds: layout.groups.map((group) => group.groupId),
      direction: root !== null && root.kind === 'split' ? root.direction : null,
    })
    for (const paneId of mru.order.slice(0, MRU_LIMIT)) {
      const entry = mruPanes.find((pane) => pane.paneId === paneId)
      if (entry === undefined) continue // 홀드 사이에 죽은 pane — 없는 줄을 그리지 않는다
      const owner = entry.sameWorktree ? layout.groups.find((group) => group.tabOrder.includes(entry.tab.tabId)) : undefined
      const number = numbers.get(paneId) ?? entry.paneIndex + 1
      const kind = kindLabel(entry.agent)
      mruRows.push({
        paneId,
        title: sessionTitle({
          tab: entry.tab,
          tabCount: entry.tabCount,
          ordinal: tabOrdinals.ordinalFor({ tabId: entry.tab.tabId, groupId: entry.tab.workspaceId }),
          home: state.home,
          selectedPaneId: paneId,
        }),
        groupGlyph: entry.sameWorktree ? (owner === undefined ? '' : (glyphs.get(owner.groupId) ?? '')) : '⇄',
        otherWorktree: !entry.sameWorktree,
        status: entry.status,
        paneDesc: entry.tab.panes.length > 1 ? `pane ${number} · ${kind}` : kind,
        worktree: entry.worktree,
        // 경과는 **열 때 찍은 시각** 기준이다 — 홀드는 몇 초라 초시계를 새로 돌릴 이유가 없다.
        elapsed: elapsedLabel(entry.tab.digest.lastActivityAt, mru.at),
      })
    }
  }
  /** 고른 자리는 **id 로** 찾는다 — 죽은 pane 이 빠져도 강조가 한 줄 밀리지 않는다. */
  const mruSelectedIndex = mru === null ? -1 : mruRows.findIndex((row) => row.paneId === mru.order[mru.index])

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
  const agentCount = agentPanes(activeWorkspace?.tabs ?? []).length
  const terminal = state.terminal

  const paletteEntries: PaletteEntry[] = []
  const connected = state.link.phase === 'live'
  const palettePaneAlive = !!activeWorkspace?.tabs.some(tab => tab.panes.some(pane => pane.paneId === lifecycle.selectedPane))
  for (const action of ACTIONS) {
    if (action.id === 'palette.open') continue
    for (let variant = 0; variant < action.variants.length; variant++) {
      const id = action.id
      paletteEntries.push({ id: `${id}:${variant}`, title: `${action.title} · ${action.variants[variant]}`, detail: id,
        shortcut: bindingsFor(id, keymap.overrides).filter((_, index) => action.bindingVariants[index] === variant).map(formatBinding).join(' / '),
        disabled: id === 'sidebar.toggle' ? undefined : !connected ? '연결된 세션이 없습니다' : !palettePaneAlive ? '선택된 pane이 없습니다' : id === 'group.split' && (layout.groups.find(group => group.groupId === layout.activeGroupId)?.tabOrder.length ?? 0) < 2 ? ONE_TAB_IN_GROUP : undefined,
        run: () => {
          if (id === 'mru.open') {
            const other = orderMru({ history: mruHistoryRef.current, livePaneIds: mruPanes.map(pane => pane.paneId) }).filter(id => id !== lifecycle.selectedPane)
            const paneId = variant === 1 ? other.at(-1) : other[0]
            if (paneId) revealPane(paneId)
          } else handlers[id](variant)
          setFocusToken(value => value + 1)
        },
      })
    }
  }
  paletteEntries.push({ id: 'repo.add', title: '레포 등록', detail: '폴더 선택', keywords: 'add repository register', run: () => setModalOpen(true) })
  paletteEntries.push({ id: 'shortcuts.settings', title: '단축키 설정', detail: '키 바인딩 변경', run: () => setShortcutsOpen(true) })
  for (const kind of ['claude', 'codex', 'grok'] as const) paletteEntries.push({ id: `agent.start.${kind}`, title: `새 ${kind} 에이전트`, detail: activeWorktree?.path ?? 'worktree 선택 필요', disabled: !connected ? '연결된 세션이 없습니다' : !activeWorkspace ? '열린 worktree를 선택하세요' : undefined, run: () => { if (activeWorkspace) lifecycle.actions.createRow(activeWorkspace.workspaceId, kind) } })
  for (const repo of state.repos) {
    const primary = repo.worktrees.find(worktree => !worktree.isLinked)
    paletteEntries.push({ id: `repo.select:${repo.root}`, title: `레포 선택 · ${repo.root.split('/').at(-1)}`, detail: repo.root, disabled: !connected ? '연결된 세션이 없습니다' : undefined, run: () => { if (primary) lifecycle.actions.openWorktree(repo.root, primary) } })
    paletteEntries.push({ id: `worktree.create:${repo.root}`, title: '새 worktree 만들기', detail: repo.root, disabled: !connected ? '연결된 세션이 없습니다' : undefined, run: () => lifecycle.actions.openCreateWorktree(repo.root) })
    for (const worktree of repo.worktrees) {
      paletteEntries.push({ id: `worktree.open:${worktree.path}`, title: `${worktree.workspace ? 'worktree 전환' : 'worktree 열기'} · ${worktree.branch ?? worktree.path.split('/').at(-1)}`, detail: worktree.path, disabled: !connected ? '연결된 세션이 없습니다' : undefined, run: () => lifecycle.actions.openWorktree(repo.root, worktree) })
      for (const tab of worktree.workspace?.tabs ?? []) for (const pane of tab.panes) paletteEntries.push({ id: `pane.switch:${pane.paneId}`, title: sessionTitle({ tab, tabCount: worktree.workspace!.tabs.length, ordinal: tabOrdinals.ordinalFor({ tabId: tab.tabId, groupId: tab.workspaceId }), home: state.home, selectedPaneId: pane.paneId }), detail: `${worktree.path} · ${tab.tabId} · ${pane.paneId} · ${pane.agent ?? 'shell'}`, keywords: 'terminal tab pane switch', disabled: !connected ? '연결된 세션이 없습니다' : undefined, run: () => {
        const alive = stateRef.current?.repos.some(r => r.worktrees.some(w => w.workspace?.tabs.some(t => t.panes.some(p => p.paneId === pane.paneId))))
        if (!alive) { setNotice('대상 pane이 사라졌습니다'); return }
        revealPane(pane.paneId)
      } })
    }
  }

  return (
    <BindingLabels.Provider value={keymap.overrides}>
    <div className="app">
      <div className="app-body" inert={paletteOpen}>
        {sidebarCollapsed ? null : <>
        <Sidebar
          onToggleSidebar={toggleSidebar}
          shortcutHint={formatBinding(bindingsFor('sidebar.toggle', keymap.overrides)[0]!)}
          sidebarRef={sidebarRef}
          width={width}
          state={state}
          activeWorkspaceId={lifecycle.activeWorkspaceId}
          selectedPane={lifecycle.selectedPane}
          selectPane={revealPane}
          closePane={(paneId) => void closePaneAt(paneId)}
          actions={lifecycle.actions}
          isRepoCollapsed={repoCollapse.has}
          toggleRepoCollapsed={repoCollapse.toggle}
          isGroupExpanded={groupExpand.has}
          toggleGroupExpanded={groupExpand.toggle}
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

        </>}
        <div className="main-area" data-main-area>
          <div className="workspace-tools">
            {sidebarCollapsed ? <button data-sidebar-show onClick={toggleSidebar} title={formatBinding(bindingsFor('sidebar.toggle', keymap.overrides)[0]!)}>사이드바 펼치기</button> : null}
            <button data-palette-open disabled={modalBlocked} onClick={openPalette}>명령 {formatBinding(bindingsFor('palette.open', keymap.overrides)[0] ?? '')}</button>
            <button data-shortcuts-open onClick={() => { mruCancel(); setShortcutsOpen(true) }}>단축키</button>
          </div>
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

          <TerminalChrome panes={stripPanes}>
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

          {/* ③ MRU — scrim 이 없어 아래 터미널이 계속 보인다 (핸드오프 O). 행 클릭도 확정이다. */}
          {mru === null ? null : (
            <MruSwitcher
              rows={mruRows}
              selectedIndex={mruSelectedIndex}
              moreCount={Math.max(0, mru.order.length - MRU_LIMIT)}
              onPick={(paneId) => {
                setMru(null)
                revealPane(paneId)
              }}
            />
          )}
        </div>
      </div>

      <StatusBar
        inert={paletteOpen}
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

      {paletteOpen ? <CommandPalette entries={paletteEntries} onClose={restore => {
        setPaletteOpen(false)
        if (restore) requestAnimationFrame(() => { if (paletteReturn.current?.isConnected) paletteReturn.current.focus(); else setFocusToken(value => value + 1) })
      }} /> : null}
      {shortcutsOpen ? <ShortcutSettings overrides={keymap.overrides} onChange={keymap.setOverrides} onClose={() => setShortcutsOpen(false)} /> : null}
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

      {tabDrag.dragState === null ? null : (
        <DropZoneOverlay state={tabDrag.dragState} tabLabel={tabById(tabDrag.dragState.tabId)?.label ?? ''} />
      )}
    </div>
    </BindingLabels.Provider>
  )
}
