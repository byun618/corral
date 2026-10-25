import { CommandPalette } from './components/CommandPalette.js'
import { QuickOpen } from './components/QuickOpen.js'
import { dropRecentFile, pushRecentFile, readRecentFiles, type RecentFiles } from '../../shared/recent-files.js'
import type { PaletteEntry } from './palette-search.js'
import type { ShortcutHandlers } from './hooks/useKeybindings.js'
import { ACTIONS, bindingsFor, formatBinding, type ActionId } from '../../shared/keybindings.js'
import { BindingLabels } from './hooks/BindingLabels.js'
import { useKeybindings } from './hooks/useKeybindings.js'
import { SettingsPage } from './components/SettingsPage.js'
import { TasksPage, type TasksFocus } from './components/TasksPage.js'
import type { WorktreeTaskLine } from './components/WorktreeTask.js'
import { linkTitleId, useLinkTitles } from './hooks/useLinkTitles.js'
import { activateWorktreeCard } from './worktree-activate.js'
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, type SettingsSectionId } from './settings-registry.js'
// 화면 오케스트레이터 — `repo → worktree → tab → pane` 4단 데이터를 Orca 배치(사이드바 카드 +
// 메인 탭바 + 상태바)로 그린다 (LIFE-357, Orca 직접 포팅 브랜치). 트리는 그리기, 동작은 IPC 로
// 내려보내는 관심사 분리는 그대로 유지한다 — 이 파일이 하는 일은 데이터를 각 컴포넌트에 나눠
// 주는 것뿐이고, 라이프사이클 로직 자체는 `hooks/useLifecycleActions.ts` 에 있다(옛 App.tsx
// 65-287줄에서 옮김, 로직 불변).
//
// 계측이 누를 수 있게 손잡이마다 `data-*` 를 단다 — 선택자가 화면 계약이다 (C7 매핑표 참고).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentStatus, AppState, PaneDirection, PaneSplitDirection, RepoRow as RepoRowData, TabRow, WorkspaceRow, WorktreeRow } from '../../shared/types.js'
import { AddRepoModal } from './components/AddRepoModal.js'
import { ConfirmClose } from './components/ConfirmClose.js'
import { CreateWorktreeModal } from './components/CreateWorktreeModal.js'
import { DropZoneOverlay } from './components/DropZoneOverlay.js'
import { EmptyGroup } from './components/EmptyGroup.js'
import { BackendBanner, BackendCard, backendBlocksTerminal } from './components/BackendCard.js'
import { InlineNotice } from './components/InlineNotice.js'
import { GroupHeader, type GroupTabItem } from './components/MainTabBar.js'
import { MruSwitcher, type MruRow } from './components/MruSwitcher.js'
import { groupGlyphs, MRU_LIMIT, openMru, orderMru, stepMru, touchMru } from './mru-order.js'
import { numbersOf } from './pane-geometry.js'
import { PaneGrid } from './components/PaneGrid.js'
import { tabOrdinals } from './fallback-ordinal.js'
import { ONE_TAB_IN_GROUP, topRightGroupId } from './group-tree.js'
import type { TabGroup } from './group-tree.js'
import type { LifecycleNotice } from './lifecycle-types.js'
import { paneTitleFrames, stabilizePaneTitles } from './pane-title-frames.js'
import { RemoveRepoConfirm } from './components/RemoveRepoConfirm.js'
import { Sidebar } from './components/Sidebar.js'
import { SidebarHead } from './components/SidebarHead.js'
import { Toaster } from './components/Toaster.js'
import { useWindowChrome } from './hooks/useWindowChrome.js'
import { showsTrafficLightPad } from '../../shared/window-chrome.js'
import { toast } from 'sonner'
import { StatusBar } from './components/StatusBar.js'
import { kindLabel, TerminalChrome, type PaneStripItem } from './components/TerminalChrome.js'
import { elapsedLabel } from './session-activity.js'
import { paletteWorktreeName, worktreeDisplayName } from './worktree-name.js'
import './design-tokens.css'
import { useCellMetrics } from './hooks/useCellMetrics.js'
import { useGroupLayout } from './hooks/useGroupLayout.js'
import { useLifecycleActions } from './hooks/useLifecycleActions.js'
import { useTermGroupSync, type GroupDeclaration } from './hooks/useTermGroupSync.js'
import { ResourceSegment } from './components/ResourceSegment.js'
import { useManualOrder } from './hooks/useManualOrder.js'
import { useSidebarView } from './hooks/useSidebarView.js'
import { usePersistentCollapse } from './hooks/usePersistentCollapse.js'
import { useSidebarResize } from './hooks/useSidebarResize.js'
import { useRightPanel } from './hooks/useRightPanel.js'
import { useExplorer } from './hooks/useExplorer.js'
import { useFileOps } from './hooks/useFileOps.js'
import { createWatchHold, forgetMissing, type WatchPush } from './watch-hold.js'
import { RightPanel, RightPanelToggle } from './components/RightPanel.js'
import { Explorer } from './components/Explorer.js'
import { useCardActions } from './hooks/useCardActions.js'
import { useTabDrag } from './hooks/useTabDrag.js'
import { paneToFollow, pickPane } from './pane-utils.js'
import { useOpenTabEntries } from './hooks/useOpenTabEntries.js'
import { useUnread } from './hooks/useUnread.js'
import { PaneLayout, type PaneSeat } from './components/PaneLayout.js'
import { sessionTitle, userLabel } from './session-title.js'
import { closeScopeTargets, cycleTabTarget, sidebarCloseRoute, tabAtIndex, type CloseScope } from './tab-actions.js'
import { keepHerdrTabMarks, keepLiveTabMarks, markOf, pinnedTabIds, readTabMarks, setTabColor, setTabPinned, type TabMark } from './tab-marks.js'
import { popClosed, pushClosed, snapshotCwd, type ClosedTabSnapshot, type RecentlyClosed, addPlacement, takeLivePlacements, type PendingPlacement } from './recently-closed.js'
import { closeFollowTarget, fileTabId, fileTabLabel, fileTabsOf, isFileTabId, previewOf, recordCloseFollow, tabKindOf, terminalKeyTarget, type CloseFollow } from './file-tabs.js'
import { FileView, focusLiveEditor, type MarkdownModeStore, type ViewStateStore } from './components/FileView.js'
import { createMarkdownToggleHandler } from './markdown-toggle.js'
import { allDocs, dirtyDocs, disposeDoc, docKey, docsVersion, freezeEditing, getDoc, subscribeDocs, thawEditing, type FileDoc } from './file-docs.js'
import { confirmDiscardOrSave, dirtyFilesOf, saveDoc, type SaveDeps } from './file-save.js'
import { CLOSE_SKIP_FAILED_NOTICE, closeCopy } from './close-copy.js'
import { moveDirectionToSplit } from './components/TabContextMenu.js'
import { groupOfTab, listGroups, readStoredLayouts } from './group-tree.js'
import { keepTerminalFocus, TerminalPane } from './TerminalPane.js'
import { updateSettings, useSettings } from './settings-store.js'
import { resolveNewAgentTab } from './tab-create-menu.js'
import { terminalCssVars } from './terminal-appearance.js'

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
/** 상태가 오기 전 — 매 렌더 새 배열을 만들면 순서 정규화 effect 가 매번 돈다. */
/** Quick-launch 워치독 알림에 쓰는 이름 — Orca 카탈로그 라벨(`agent-catalog.tsx`). */
const AGENT_LAUNCH_LABEL = { claude: 'Claude', codex: 'Codex', grok: 'Grok' } as const
const NO_REPOS: AppState['repos'] = []
const NO_ROOTS: string[] = []
const MRU_HOLD_TIMEOUT_MS = 10_000
/** 작업 페이지가 열린 동안에도 사는 단축키 (LIFE-601 C4) — 나머지 워크스페이스 단축키는 삼키기만 한다. */
const TASKS_PAGE_SHORTCUTS: readonly ActionId[] = ['tasks.toggle', 'settings.open', 'sidebar.toggle']
/** LIFE-592 — 탐색기 이동 뒤 옛·새 경로 감시 push 를 더 버리는 시간(감시 디바운스보다 길게). */
const WATCH_HOLD_GRACE_MS = 1_000
/** LIFE-593 수정 r2 R2-G-04 — 저장된 배치(앱 시작 복원)에서 worktree 별 활성 파일 탭 경로. 처음 보일 때 한 번 최근 기록을 건너뛴다(사용자가 연 것이 아니다). */
function restoredActiveFiles(stored: unknown): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of readStoredLayouts(stored)) {
    const group = listGroups(row.layout.root).find((item) => item.groupId === row.layout.activeGroupId)
    const kind = group?.activeTabId === undefined || group.activeTabId === null ? null : tabKindOf(group.activeTabId)
    if (kind?.kind === 'file') out.set(row.worktreePath, kind.rel)
  }
  return out
}
/** 최근 기록 `ui-prefs.json` 쓰기 뭉침. */
const RECENT_SAVE_DEBOUNCE_MS = 500
const NO_RECENT: readonly string[] = []

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  // LIFE-527 D9 — 앱 수준 알림은 Orca 처럼 토스트(오른쪽 아래, 자동 사라짐). 옛 「해제까지 상주」 인라인 줄(탭 줄 위)은 없앴다.
  const notify = (message: string): void => {
    toast(message)
  }
  // --- LIFE-591 F3 파일 편집 — 문서 저장소(`file-docs.ts`)가 수정 여부의 진실이다. 바뀌면 탭 점·종료 관문 목록이 따라온다 ---
  const docsVer = useSyncExternalStore(subscribeDocs, docsVersion)
  const saveDeps: SaveDeps = { writeFile: window.corral.writeFile, fileDialog: window.corral.fileDialog, notify }
  const saveDepsRef = useRef(saveDeps)
  saveDepsRef.current = saveDeps
  // 수정 파일 목록을 main 에 민다(E3ⓒ — 종료 확인 관문이 동기 판정에 쓴다). 바뀐 때만.
  const sentDirty = useRef('[]')
  useEffect(() => {
    const files = dirtyFilesOf(allDocs())
    const serialized = JSON.stringify(files)
    if (serialized === sentDirty.current) return
    sentDirty.current = serialized
    window.corral.setDirtyFiles(files)
  }, [docsVer])
  // 렌더러 다시 불러오기(E3ⓕ) — 수정 파일이 있으면 막는다. main(`will-prevent-unload`)이 묻고, 고르면 그래도 내린다. 종료 확인을 지난 뒤면 main 이 묻지 않고 내린다.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirtyDocs().length === 0) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
  // 종료·창 닫기 확인(E3ⓒ) — main 이 런타임 정리 전에 막고 맡겼다. 저장/저장 안 함이면 다시 종료하라고 돌려준다. 취소면 아무것도 안 한다(앱·런타임 그대로).
  // 여러 worktree 의 파일이면 이름 앞에 worktree 폴더 이름을 붙인다.
  const quitPromptRef = useRef(false)
  // 받은 요청 중 가장 새 세대(수정 r5 R5-B) — 확인이 끝날 때 이 세대로 답한다(묻는 사이 새 요청이 왔으면 그 요청에 대한 답이다).
  // main 이 무응답 취소로 무효로 한 세대면 승인을 받지 않는다(아래 — 동결을 다시 푼다).
  const quitGenRef = useRef(0)
  useEffect(
    () =>
      window.corral.onQuitRequested((gen) => {
        quitGenRef.current = Math.max(quitGenRef.current, gen)
        // 받았다고 바로 알린다 — main 이 무응답(멈춘 렌더러) 판정 시계를 멈춘다(수정 r1 R1-I). 이미 묻는 중이어도 알린다.
        window.corral.quitAck(gen)
        if (quitPromptRef.current) return
        quitPromptRef.current = true
        // 대상 = 모든 문서(그때그때 — 확인·저장을 기다리는 사이 새로 수정된 문서도 다시 묻는다, 수정 r2 R2-A).
        // main 은 밀린 목록이 비어도 여기에 묻는다(수정 r4 R4-A) — 수정이 없으면 아래가 묻지 않고 같은 태스크 안에서 승인·동결까지 간다(그 사이 입력이 끼지 못한다).
        const label = (doc: FileDoc): string => (new Set(dirtyDocs().map((row) => row.root)).size > 1 ? `${doc.root.split('/').pop() ?? doc.root}/${doc.rel}` : doc.rel)
        void confirmDiscardOrSave({ targets: allDocs, deps: saveDepsRef.current, label })
          .then((ok) => {
            if (!ok) {
              // 취소 — 보통은 정리 전이라 할 일이 없다. 방어선(R4-A ⓒ): 동결돼 있었으면 풀고, main 이 이미 런타임을 정리했으면 알린다(창은 main 이 다시 보인다).
              thawEditing()
              void window.corral.quitCancelled(quitGenRef.current).then((result) => {
                if (result.runtimeClosed) notify('종료를 취소했지만 터미널 런타임은 이미 정리됐습니다 — 파일은 그대로 저장할 수 있습니다. 저장한 뒤 앱을 다시 시작하세요')
              })
              return
            }
            // 승인 — 이 순간(같은 마이크로태스크)부터 편집을 막고 main 에 알린다. 승인 뒤 정리 대기 중 친 글자가 조용히 사라지지 않게(R3-C).
            freezeEditing()
            void window.corral.confirmQuit(quitGenRef.current).then((accepted) => {
              // 무효가 된 요청(무응답 대화상자에서 취소한 종료)에 대한 늦은 승인 — main 이 받지 않았다. 편집을 다시 연다(R5-B).
              if (!accepted) thawEditing()
            })
          })
          .finally(() => {
            quitPromptRef.current = false
          })
      }),
    [],
  )
  /** 그 worktree 의 수정된 문서들을 묻는다(worktree 닫기·마지막 터미널 탭 닫기 — E3ⓓⓔ). 없으면 묻지 않고 true. 대상은 그 worktree 문서 전체를 그때그때(R2-A). */
  const confirmWorktreeDocs = (root: string): Promise<boolean> =>
    confirmDiscardOrSave({ targets: () => allDocs().filter((doc) => doc.root === root), deps: saveDepsRef.current })
  /**
   * worktree 삭제(E3ⓓ) — 지울 파일을 저장할 수는 없으니 「버리고 계속 / 취소」. 계속이면 그 worktree 문서를 전부 버린다.
   * 대화상자를 기다리는 사이 묻지 않은 문서가 새로 수정됐으면 그 목록으로 다시 묻는다(R2-A — 처음 목록만 보고 전부 버리지 않는다, 최대 3 번).
   */
  const confirmDeleteDocs = async (root: string): Promise<boolean> => {
    const asked = new Set<string>()
    for (let ask = 0; ask < 3; ask += 1) {
      const fresh = dirtyDocs().filter((doc) => doc.root === root && !asked.has(doc.key))
      if (fresh.length === 0) {
        for (const doc of allDocs()) if (doc.root === root) disposeDoc(doc.key)
        return true
      }
      if ((await window.corral.fileDialog({ kind: 'discard', files: fresh.map((doc) => doc.rel) })) !== 'discard') return false
      for (const doc of fresh) asked.add(doc.key)
    }
    return false
  }
  const [modalOpen, setModalOpen] = useState(false)
  const [modalNote, setModalNote] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteReturn = useRef<HTMLElement | null>(null)
  // LIFE-593 — ⌘P 빠른 열기(팔레트와 별도 대화상자 — Q1). 열기·닫기·포커스 복귀는 팔레트와 같은 방식. 「무시 파일 포함」 은 앱 실행 동안만 기억한다(Q3).
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const quickOpenReturn = useRef<HTMLElement | null>(null)
  const [quickOpenIgnored, setQuickOpenIgnored] = useState(false)
  /** 최근 연 파일(E5 — worktree 별, ui-prefs 영속). 첫 getUiPrefs 에서 읽는다. */
  const [recentFiles, setRecentFiles] = useState<RecentFiles>({})
  /** 기록 거울 — 저장할지(바뀌었는지)를 상태 갱신 밖에서 가린다. */
  const recentFilesRef = useRef<RecentFiles>({})
  const recentReady = useRef(false)
  /** 앱 시작 때 되살릴 worktree 별 활성 파일 탭(수정 r2 R2-G-04) — 그 worktree 에서 처음 보인 활성 파일 하나로 쓰고 버린다. */
  const recentRestored = useRef(new Map<string, string>())
  /** 탐색기 이름 필터 열기 요청(⌥⌘F — Q7). 바뀌면 탐색기가 머리 입력칸을 연다. */
  const [explorerFilterToken, setExplorerFilterToken] = useState(0)
  /**
   * 설정 페이지 (LIFE-511) — 열려 있으면 그 섹션. 워크스페이스는 언마운트도 `display:none` 도 하지 않고 **크기 그대로 덮는다**
   * (`.app-body.is-covered` = visibility:hidden + inert). `display:none` 이면 영역 상자가 0 으로 재져 모든 영역이 cols 2·rows 1 로
   * herdr 에 resize 요청된다(00-analysis A1, raw/claude/u1-before 실측) — 덮으면 ResizeObserver 가 발화하지 않는다.
   */
  const [settingsView, setSettingsView] = useState<SettingsSectionId | null>(null)
  /**
   * 작업 페이지 (LIFE-601) — **메인 영역만** 덮는다(사이드바는 그대로 보이고 조작된다). 덮는 방식은 설정과 같다: 메인 영역 내용을
   * `display:contents` 래퍼로 감싸 `visibility:hidden` + `inert` — 상자 크기가 그대로라 여닫기가 격자 요청을 내지 않는다.
   * 페이지는 처음 열 때 마운트되고 닫혀도 남는다(검색어·스크롤 복원 — C3).
   */
  const [tasksOpen, setTasksOpen] = useState(false)
  const [tasksMounted, setTasksMounted] = useState(false)
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
  const windowChrome = useWindowChrome()
  // LIFE-527 D5 — 떠 있는 머리(접힘)의 컨트롤 줄 폭 → 왼쪽 위 탭 줄 no-drag 여백 폭(Orca `--collapsed-sidebar-header-width`, `App.tsx:82`).
  // 줌·전체화면으로 폭이 바뀌면 따라간다(ResizeObserver). 터미널 외관 변수와 같이 루트에 건다.
  const floatingHeadRef = useRef<ResizeObserver | null>(null)
  const measureFloatingHead = useCallback((element: HTMLDivElement | null) => {
    floatingHeadRef.current?.disconnect()
    floatingHeadRef.current = null
    if (element === null) return
    const apply = (): void => document.documentElement.style.setProperty('--collapsed-sidebar-header-width', `${element.getBoundingClientRect().width}px`)
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    floatingHeadRef.current = observer
    apply()
  }, [])
  const sidebarRef = useRef<HTMLDivElement | null>(null)
  const { width, onHandleMouseDown } = useSidebarResize(sidebarRef)
  // LIFE-589 — 오른쪽 패널(⌘L)·탐색기(⌘⇧E). 패널을 닫아도 탐색기 상태는 여기 남는다(E1ⓔ).
  const rightPanelRef = useRef<HTMLDivElement | null>(null)
  const rightPanel = useRightPanel(rightPanelRef)
  const [explorerFocusToken, setExplorerFocusToken] = useState(0)
  const repoCollapse = usePersistentCollapse('collapsedRepos')
  // LIFE-467: 알약은 기본 **접힘**(Orca 와 같다) — 펼친 worktree 만 영속한다. 옛 `collapsedGroups`(기본 펼침)는 안 읽는다.
  const groupExpand = usePersistentCollapse('expandedAgentGroups')
  // LIFE-576 D6: 「N 하위」 는 기본 **펼침** — 접은 부모 경로만 영속한다(Orca `collapsedGroups` 의 `lineage:` 키).
  const lineageCollapse = usePersistentCollapse('collapsedLineage')
  // LIFE-469 — 레포·워크트리 수동 순서. 읽기는 아래 첫 getUiPrefs 에 얹는다(부트 화면이 내려가기 전에 순서가 선다).
  const manualOrder = useManualOrder({ repos: state?.repos ?? NO_REPOS, registry: { roots: state?.registry.roots ?? NO_ROOTS, generation: state?.registryGeneration ?? 0 } })
  // LIFE-470 — Workspace options(그룹·정렬·필터). 읽기는 manualOrder 와 같은 첫 getUiPrefs 에 얹는다.
  const sidebarView = useSidebarView()

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
  /**
   * 탭 핀·색 (LIFE-495 K3·K4) — ui-prefs `tabMarks`. 배정표와 같은 읽기에서 싣는다.
   * 저장 비교값의 초기값이 `'[]'` 인 이유는 `useGroupLayout` 의 `saved` 와 같다 — 싣기 전 빈 상태가 파일을 지우지 않게.
   */
  const [tabMarks, setTabMarks] = useState<TabMark[]>([])
  const savedTabMarks = useRef('[]')
  const pinnedTabs = useMemo(() => pinnedTabIds(tabMarks), [tabMarks])
  /** 마지막으로 저장한 배정표 — 안 바뀌었으면 파일을 다시 안 쓴다. */
  const savedOrdinals = useRef('')
  useEffect(() => {
    let cancelled = false
    window.corral
      .getUiPrefs()
      .then((prefs) => {
        if (cancelled) return
        tabOrdinals.hydrate(prefs.tabOrdinals)
        manualOrder.hydrate(prefs)
        sidebarView.hydrate(prefs)
        setStoredLayouts(prefs.groupLayouts)
        recentRestored.current = restoredActiveFiles(prefs.groupLayouts)
        const marks = readTabMarks(prefs.tabMarks)
        savedTabMarks.current = JSON.stringify(marks)
        setTabMarks(marks)
        sidebarCollapsedRef.current = prefs.sidebarCollapsed
        setSidebarCollapsed(prefs.sidebarCollapsed)
        recentFilesRef.current = readRecentFiles(prefs.recentFiles)
        setRecentFiles(recentFilesRef.current)
      })
      .catch(() => {
        // 읽기 실패 — 빈 배정표로 간다.
        manualOrder.hydrate(null)
      })
      .finally(() => {
        if (cancelled) return
        recentReady.current = true
        setOrdinalsReady(true)
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
    // LIFE-507 — herdr 세션 전체에 없는 탭(닫힌 워크스페이스 포함)의 번호도 푼다. 링크가 live 가 아니면(null) 모르는 것이라 손대지 않는다.
    const herdrTabIds = state.herdrTabIds
    if (herdrTabIds !== null) tabOrdinals.keepHerdrTabs(herdrTabIds)
    // LIFE-495 K4ⓒ — 닫힌 탭의 핀·색도 같은 규칙으로 지운다(보이는 워크스페이스 안의 죽은 탭만). LIFE-507 — herdr 전체에 없는 탭도.
    setTabMarks((marks) => {
      const shownPruned = keepLiveTabMarks({ marks, liveTabIds: live, shownWorkspaceIds: shown })
      const next = herdrTabIds === null ? shownPruned : keepHerdrTabMarks({ marks: shownPruned, herdrTabIds })
      return next.length === marks.length ? marks : next
    })
    // 배정이 **실제로 바뀐 때만** 저장한다 (C13) — 이 effect 는 상태 갱신마다 돌고,
    // ui-prefs 는 디바운스 없이 즉시 파일을 쓴다.
    const entries = tabOrdinals.entries()
    const serialized = JSON.stringify(entries)
    if (serialized === savedOrdinals.current) return
    savedOrdinals.current = serialized
    window.corral.setUiPrefs({ tabOrdinals: entries })
  }, [state, ordinalsReady])

  // 핀·색 저장 — 바뀐 때만 쓴다(ui-prefs 는 디바운스 없이 즉시 파일을 쓴다). 싣기 전에는 쓰지 않는다.
  useEffect(() => {
    if (!ordinalsReady) return
    const serialized = JSON.stringify(tabMarks)
    if (serialized === savedTabMarks.current) return
    savedTabMarks.current = serialized
    window.corral.setUiPrefs({ tabMarks })
  }, [tabMarks, ordinalsReady])

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
  /** LIFE-495 K6 — 다시 연 탭이 도착하면 놓을 자리·싣을 색(아래 「방금 만든 탭을 편다」 effect 가 소비한다). */
  const pendingPlacementsRef = useRef<Map<string, PendingPlacement>>(new Map())
  /** LIFE-495 K6 — 닫은 탭 기록(worktree 경로별 최근 10개, 비영속). 렌더 대상이 아니라 ref 다. */
  const recentlyClosedRef = useRef<RecentlyClosed>({})
  /** LIFE-590 E3ⓕ — 파일 탭 스크롤·선택 위치(Monaco view state). worktree 경로 → 탭 id 별. 비영속(재시작 복원은 열린 탭·순서·활성·미리보기까지). */
  const fileViewStatesRef = useRef<Map<string, ViewStateStore>>(new Map())
  const fileViewStatesOf = (worktreePath: string): ViewStateStore => {
    const found = fileViewStatesRef.current.get(worktreePath)
    if (found !== undefined) return found
    const made: ViewStateStore = new Map()
    fileViewStatesRef.current.set(worktreePath, made)
    return made
  }
  /** Markdown 원문/미리보기 기억 — view state 와 같이 worktree 마다 탭 id 별(E4ⓓ). */
  const markdownModesRef = useRef<Map<string, MarkdownModeStore>>(new Map())
  const markdownModesOf = (worktreePath: string): MarkdownModeStore => {
    const found = markdownModesRef.current.get(worktreePath)
    if (found !== undefined) return found
    const made: MarkdownModeStore = new Map()
    markdownModesRef.current.set(worktreePath, made)
    return made
  }
  /** 열린 파일 탭 감시 상태(E5) — main push 의 마지막 값, 키 = `루트\0상대 경로`. */
  const [fileWatchState, setFileWatchState] = useState<ReadonlyMap<string, { exists: boolean; stamp: string | null }>>(() => new Map())
  /**
   * LIFE-592 E4ⓒ — 탐색기가 옮기는(또는 되살리는) 경로의 감시 push 는 조작이 끝나고 잠시 뒤까지 화면에 반영하지 않는다(앱이 한 이동의 옛 경로 「삭제됨」 깜빡임 0).
   * 수정 r1 R1-D — 버리지 않고 경로별 마지막 push 를 들고 있다가 풀 때 반영한다(`watch-hold.ts`). 붙잡은 동안 온 실제 외부 변경이 영영 빠지지 않게.
   */
  const watchHoldRef = useRef(createWatchHold())
  const applyWatchPushes = useCallback((pushes: readonly WatchPush[]): void => {
    if (pushes.length === 0) return
    setFileWatchState((previous) => {
      let next: Map<string, { exists: boolean; stamp: string | null }> | null = null
      for (const push of pushes) {
        const key = `${push.root}\0${push.rel}`
        const before = (next ?? previous).get(key)
        if (before !== undefined && before.exists === push.exists && before.stamp === push.stamp) continue
        next ??= new Map(previous)
        next.set(key, { exists: push.exists, stamp: push.stamp })
      }
      return next ?? previous
    })
  }, [])
  const holdWatch = useCallback(
    (input: { root: string; prefixes: string[]; arriving?: string[] }): (() => void) => {
      const release = watchHoldRef.current.hold(input)
      const arriving = input.arriving
      if (arriving !== undefined) setFileWatchState((previous) => forgetMissing(previous, { root: input.root, prefixes: arriving }))
      // 늦게 오는 push(감시 디바운스) 몫으로 잠시 더 쥐었다가, 그 사이 온 마지막 상태를 반영한다.
      return () => {
        setTimeout(() => applyWatchPushes(release()), WATCH_HOLD_GRACE_MS)
      }
    },
    [applyWatchPushes],
  )
  useEffect(
    () =>
      window.corral.onFileEvent((push) => {
        if (watchHoldRef.current.intercept(push)) return
        applyWatchPushes([push])
      }),
    [applyWatchPushes],
  )
  /** LIFE-495 — 탭 이름 편집 요청(⌘R·메뉴 「제목 바꾸기」). 토큰이 오를 때마다 그 탭이 편집을 연다. */
  const [renameRequest, setRenameRequest] = useState<{ tabId: string; token: number } | null>(null)
  const requestRename = useCallback((tabId: string) => setRenameRequest((previous) => ({ tabId, token: (previous?.token ?? 0) + 1 })), [])
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
  // LIFE-675 — 이동(Resource 「이동」·CLI `worktree create --activate`)은 덮는 설정·작업 페이지를 닫고 간다(작업 페이지 안 이동과 같은 규칙).
  // 닫기와 요청이 한 렌더에 걸리므로 아래 효과의 `selectPane` 이 올리는 focusToken 은 덮개가 걷힌 뒤에 닿는다.
  useEffect(() => window.corral.onRevealPane(pane => {
    setSettingsView(null)
    setTasksOpen(false)
    requestedDeadline.current = null
    setRequestedPane(pane)
  }), [])
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
  /** 비동기 응답이 그 사이 worktree 가 바뀌었는지 보는 거울(LIFE-593 수정 r1 — ⌘P 열기 전 폴더 확인). */
  const activeWorktreeRowRef = useRef(activeWorktreeRow)
  activeWorktreeRowRef.current = activeWorktreeRow

  const explorer = useExplorer({ root: activeWorktreeRow?.path ?? null, active: rightPanel.open })

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
    pinned: pinnedTabs,
    herdrTabIds: state?.herdrTabIds ?? null,
  })

  const tabById = useCallback((tabId: string | null) => activeWorkspaceRow?.tabs.find((tab) => tab.tabId === tabId) ?? null, [activeWorkspaceRow])

  /** LIFE-496 D36 — `+` 메뉴 omnibox 가 찾는 열린 탭(현재 worktree · 모든 영역). */
  const openTabEntries = useOpenTabEntries({
    workspace: activeWorkspaceRow,
    worktree: activeWorktreeRow,
    groups: layout.groups,
    activeGroupId: layout.activeGroupId,
    home: state?.home ?? null,
    selectedPane: lifecycle.selectedPane,
    ordinalsReady,
  })

  /**
   * 안 읽음 장부 (LIFE-471) — 「보고 있는」 pane 후보 = **활성 영역의 선택 pane**(198 활성 worktree·탭·leaf). 아래 `renderGroup` 의
   * `groupSelectedPaneId` 와 같은 규칙: 창 전체 선택 pane 이 그 영역 탭에 있으면 그것, 아니면 그 탭이 보던 pane. 창이 보이고 포커스인지는 훅이 본다.
   */
  const activeGroupTab = tabById(layout.groups.find((group) => group.groupId === layout.activeGroupId)?.activeTabId ?? null)
  // LIFE-691 K2 — 터미널 탭이 닫혀 선택 pane 을 잃으면 이 탭의 pane 으로 승격한다(`useLifecycleActions`).
  lifecycle.shownTabRef.current = activeGroupTab?.tabId ?? null
  /**
   * LIFE-691 K2ⓐ — 파일 탭을 닫아(탭 닫기·탐색기 삭제/이동 — `noteFileClose`) 활성 영역의 활성 탭이 닫히고 새 활성이 터미널 탭이면 입력 pane 도 그 탭으로.
   * 닫기가 배치를 바꾼 **다음 렌더**에서 한 번 보고 버린다 — 판단은 `closeFollowTarget`(같은 worktree·활성 탭이 닫혔나·새 활성이 터미널인가).
   * 옮기기(새 영역·병합)는 기록하지 않는다(포커스가 옮긴 파일 영역이면 선택 pane 을 그대로 둔다 — K2ⓒ).
   */
  const closeFollowRef = useRef<CloseFollow | null>(null)
  useEffect(() => {
    const target = closeFollowTarget({
      pending: closeFollowRef.current,
      worktreePath: activeWorktreeRow?.path ?? null,
      activeTabId: layout.groups.find((group) => group.groupId === layout.activeGroupId)?.activeTabId ?? null,
    })
    closeFollowRef.current = null
    const paneId = target === null ? null : paneToFollow({ tab: tabById(target), selectedPane: lifecycle.selectedPane })
    if (paneId !== null) selectPane(paneId)
  }, [layout.layout])
  const viewedPaneId =
    activeGroupTab === null
      ? null
      : (activeGroupTab.panes.find((pane) => pane.paneId === lifecycle.selectedPane)?.paneId ?? pickPane(activeGroupTab)?.paneId ?? null)
  const unread = useUnread({ state, viewedPaneId, activeWorktree: activeWorktreeRow?.path ?? null })
  // LIFE-603 C11 — 사이드바 작업 줄의 제목 캐시. 작업 페이지가 닫힐 때마다 다시 받는다(페이지에서 바꾼 제목·상태).
  const [tasksFocus, setTasksFocus] = useState<TasksFocus | null>(null)
  const [titleRound, setTitleRound] = useState(0)
  useEffect(() => {
    if (!tasksOpen) setTitleRound((value) => value + 1)
  }, [tasksOpen])
  const linkTitles = useLinkTitles({ repos: state?.repos ?? NO_REPOS, refresh: titleRound })

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
    // LIFE-495 K6 — 다시 연 탭은 펴는 대신 **닫을 때의 영역·자리**로 놓는다(`placeTab` 이 그 영역·탭을 활성으로 한다).
    // 색도 여기서 싣는다 — 탭이 도착하기 전에 실으면 죽은 탭 정리(`keepLiveTabMarks`)가 지운다.
    // 자리는 탭 id 별 대기열이다 — 연속 ⌘⇧T 가 앞 요청의 자리·색을 덮지 않는다(fix1 미확인 부기).
    const taken = takeLivePlacements({ pending: pendingPlacementsRef.current, liveTabIds })
    pendingPlacementsRef.current = taken.pending
    const placed = new Set<string>()
    for (const placement of taken.ready) {
      const { tabId, workspaceId, color } = placement
      if (color !== null) setTabMarks((marks) => setTabColor({ marks, tabId, workspaceId, color }))
      if (!layout.groups.some((group) => group.groupId === placement.groupId)) continue
      layout.placeTab({ tabId, groupId: placement.groupId, index: placement.index })
      placed.add(tabId)
    }
    const tabId = lifecycle.pendingRevealTab
    if (tabId === null) return
    if (placed.has(tabId)) {
      lifecycle.revealTabHandled()
      return
    }
    // 자리를 기다리는(아직 안 온) 다시 연 탭은 펴지 않고 기다린다.
    if (pendingPlacementsRef.current.has(tabId)) return
    if (layout.revealTab(tabId)) lifecycle.revealTabHandled()
  }, [lifecycle.pendingRevealTab, lifecycle.revealTabHandled, layout.revealTab, layout.placeTab, layout.groups, liveTabIds, activeWorkspaceRow])

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
  // 터미널 외관 CSS 변수(pane 배경·비활성 투명도·디바이더, LIFE-512) — 칠하기 전에 문서 루트에 둔다(첫 화면부터 저장값).
  const settings = useSettings()
  useLayoutEffect(() => {
    const root = document.documentElement.style
    for (const [name, value] of Object.entries(terminalCssVars(settings))) root.setProperty(name, value)
  }, [settings])

  const termSync = useTermGroupSync({ groups: termGroups, cell })

  // LIFE-590 E5 — 활성 worktree 의 열린 파일 탭 전부(모든 영역·활성 여부 무관)를 main 감시에 맡긴다. 집합이 바뀔 때만 보낸다(통째로).
  // 패널 열림과 무관하다 — 탐색기 감시(F1)는 패널이 닫히면 멈추지만 이 감시는 탭이 열려 있는 동안 돈다(E5ⓑ).
  const watchRoot = activeWorktreeRow?.path ?? null
  const watchRels = layout.layout === null ? '' : fileTabsOf(layout.layout).map((tab) => tab.rel).sort().join('\n')
  useEffect(() => {
    if (watchRoot === null) return
    void window.corral.fileWatch({ root: watchRoot, rels: watchRels === '' ? [] : watchRels.split('\n') })
  }, [watchRoot, watchRels])

  // LIFE-591 E1ⓓ — 미리보기 탭을 편집하면 고정한다(VS Code `enablePreview`) — 수정 중인 탭이 다른 파일 한 번 클릭으로 교체되지 않게.
  const keepFileTab = layout.keepFile
  useEffect(() => {
    if (watchRoot === null) return
    for (const group of layout.groups) {
      const preview = previewOf(group)
      const kind = preview === null ? null : tabKindOf(preview)
      if (preview !== null && kind?.kind === 'file' && getDoc(docKey(watchRoot, kind.rel))?.dirty === true) keepFileTab(preview)
    }
  }, [docsVer, layout.groups, watchRoot, keepFileTab])

  // LIFE-590 E6 auto reveal — 활성 영역의 활성 탭이 파일 탭이면 탐색기가 그 파일을 따라간다(조상 펼침·선택·스크롤, 포커스는 그대로).
  // 패널이 닫혀 있으면 아무것도 안 하고, 열리면 그때 활성 파일을 보인다(open 이 의존성). 숨김 경로(`.git`·`node_modules`)는 `reveal` 이 거른다.
  const activeTabIdForReveal = layout.groups.find((group) => group.groupId === layout.activeGroupId)?.activeTabId ?? null
  const activeTabKind = activeTabIdForReveal === null ? null : tabKindOf(activeTabIdForReveal)
  const activeFileRel = activeTabKind?.kind === 'file' ? activeTabKind.rel : null
  const [revealRequest, setRevealRequest] = useState<{ rel: string; token: number } | null>(null)
  const revealFile = explorer.reveal
  useEffect(() => {
    if (!rightPanel.open || activeFileRel === null) return
    if (revealFile(activeFileRel)) setRevealRequest((previous) => ({ rel: activeFileRel, token: (previous?.token ?? 0) + 1 }))
  }, [rightPanel.open, activeFileRel, revealFile])

  // LIFE-593 E5ⓐ — 어느 경로로 열든(탐색기·⌘P·편집기 링크·⌘⇧T·탭 클릭) 활성 영역의 활성 탭이 파일 탭이 되면 그 worktree 기록 맨 앞에 둔다(ui-prefs 영속 — Q5).
  // 첫 ui-prefs 읽기 전에는 적지 않는다(저장된 기록을 빈 기록으로 덮지 않게).
  // 수정 r1 R1-C-09 · 수정 r2 R2-G-04 — 복원된 활성 탭만 넣지 않는다(시간 유예 없음 — 그 사이 사용자가 연 파일은 넣는다). 복원 = ① worktree 를 바꾼(또는 처음 본) 그 렌더에
  // 보인 활성 탭(그 worktree 배치가 되살린 것) ② 앱 시작 때 저장된 배치의 활성 파일 탭이 그 worktree 에서 처음 보일 때. 탭 전환은 그대로 넣는다.
  // 저장은 뭉쳐서(디바운스) 쓰고, 창이 닫힐 때 남은 것을 쓴다. 열어 보니 거절된 경로(파일 아님·가둠 밖)는 빼낸다(`forgetRecent` — R2-C-03).
  const recentRoot = activeWorktreeRow?.path ?? null
  const recentSeenRoot = useRef<{ root: string | null } | null>(null)
  const recentSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushRecentSave = useCallback(() => {
    if (recentSaveTimer.current === null) return
    clearTimeout(recentSaveTimer.current)
    recentSaveTimer.current = null
    window.corral.setUiPrefs({ recentFiles: recentFilesRef.current })
  }, [])
  useEffect(() => {
    window.addEventListener('beforeunload', flushRecentSave)
    return () => {
      window.removeEventListener('beforeunload', flushRecentSave)
      flushRecentSave()
    }
  }, [flushRecentSave])
  const saveRecent = (next: RecentFiles): void => {
    recentFilesRef.current = next
    setRecentFiles(next)
    if (recentSaveTimer.current !== null) clearTimeout(recentSaveTimer.current)
    recentSaveTimer.current = setTimeout(() => {
      recentSaveTimer.current = null
      window.corral.setUiPrefs({ recentFiles: recentFilesRef.current })
    }, RECENT_SAVE_DEBOUNCE_MS)
  }
  const saveRecentRef = useRef(saveRecent)
  saveRecentRef.current = saveRecent
  useEffect(() => {
    if (!recentReady.current) return
    const seen = recentSeenRoot.current
    recentSeenRoot.current = { root: recentRoot }
    if (recentRoot === null || activeFileRel === null) return
    const restored = recentRestored.current.get(recentRoot)
    if (restored !== undefined) {
      recentRestored.current.delete(recentRoot)
      if (restored === activeFileRel) return
    }
    if (seen === null || seen.root !== recentRoot) return
    const next = pushRecentFile({ recent: recentFilesRef.current, root: recentRoot, rel: activeFileRel })
    if (next !== recentFilesRef.current) saveRecentRef.current(next)
  }, [recentRoot, activeFileRel, ordinalsReady])
  /** 열어 보니 거절된 경로 — 그 worktree 기록에서 뺀다(어느 경로로 열었든 — 수정 r2 R2-C-03). */
  const forgetRecent = (input: { root: string; rel: string }): void => {
    const next = dropRecentFile({ recent: recentFilesRef.current, root: input.root, rel: input.rel })
    if (next !== recentFilesRef.current) saveRecent(next)
  }

  /** 키 핸들러가 읽는 배치 거울 — 핸들러를 매 렌더 다시 달지 않으려고 ref 로 둔다. */
  const layoutMirror = {
    activeGroupId: layout.activeGroupId,
    /** LIFE-495 — 탭 단축키(⌘⇧[ ]·⌃1–9)가 도는 활성 영역의 시각 순서. */
    activeTabOrder: layout.groups.find((group) => group.groupId === layout.activeGroupId)?.tabOrder ?? [],
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

  // LIFE-478 — 카드 메뉴의 App 층(고정·삭제·정보 수정 대화·⌘⌥R·⌘⇧⌫).
  const cardActions = useCardActions({
    stateRef,
    state,
    activeWorkspaceId: lifecycle.activeWorkspaceId,
    actions: lifecycle.actions,
    revealPane,
    mruHistory: () => mruHistoryRef.current,
    notify,
    guardDelete: confirmDeleteDocs,
  })

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
  const closeTargetRef = useRef<{ tabId: string | null; paneIds: string[]; file: boolean }>({ tabId: null, paneIds: [], file: false })
  {
    const activeId = layoutRef.current.activeTabId
    // LIFE-590 E3ⓐ — 활성 탭이 파일 탭이면 ⌘W 가 그 파일 탭을 닫는다.
    if (activeId !== null && isFileTabId(activeId)) closeTargetRef.current = { tabId: activeId, paneIds: [], file: true }
    else {
      const tab = tabById(activeId)
      closeTargetRef.current = { tabId: tab?.tabId ?? null, paneIds: tab?.panes.map((pane) => pane.paneId) ?? [], file: false }
    }
  }
  // --- LIFE-495 탭 닫기·다시 열기·탭 단축키 ----------------------------------------

  /** 탭 하나를 그 영역에서 활성으로 + 그 탭의 pane 으로 포커스(탭 클릭과 같은 길). */
  const activateTab = (input: { groupId: string; tab: TabRow }): void => {
    layout.setActiveTab({ groupId: input.groupId, tabId: input.tab.tabId })
    const pane = pickPane(input.tab)
    if (pane !== null) selectPane(pane.paneId)
  }

  /** 닫기 직전의 그 탭 — 다시 열기 기록(K6). 활성 worktree 밖이거나 배치에 없으면 null(기록하지 않는다). */
  const snapshotOf = (tabId: string): ClosedTabSnapshot | null => {
    // 소유 워크스페이스는 전체 state 에서 찾는다 — 사이드바는 활성이 아닌 워크스페이스의 탭도 닫는다(fix1 R1-02).
    const owner = (state?.repos ?? [])
      .flatMap((repo) => repo.worktrees)
      .flatMap((worktree) => {
        const tab = worktree.workspace?.tabs.find((row) => row.tabId === tabId)
        return worktree.workspace === null || tab === undefined ? [] : [{ worktreePath: worktree.path, workspace: worktree.workspace, tab }]
      })[0]
    if (owner === undefined) return null
    const { tab, workspace, worktreePath } = owner
    // 화면에 보이던 순서로 — 비활성 worktree 도 활성 배치와 같은 파생(reconcile + 핀 partition)을 거친 배치를 읽는다(fix2 R2-02).
    const shown =
      worktreePath === activeWorktreeRow?.path
        ? layout.layout
        : layout.layoutOf({ worktreePath, liveTabIds: workspace.tabs.map((row) => row.tabId), pinned: pinnedTabs })
    if (shown === null) return null
    const group = groupOfTab(shown.root, tabId)
    if (group === null) return null
    const shownPaneId = tab.panes.find((pane) => pane.paneId === lifecycle.selectedPane)?.paneId ?? pickPane(tab)?.paneId ?? null
    return {
      worktreePath,
      cwd: snapshotCwd({ panes: tab.panes, shownPaneId }),
      label: userLabel({ tab, tabCount: workspace.tabs.length }),
      color: markOf({ marks: tabMarks, tabId, workspaceId: tab.workspaceId })?.color ?? null,
      groupId: group.groupId,
      index: group.tabOrder.indexOf(tabId),
    }
  }

  /**
   * 사용자가 탭을 닫는다 (×·중클릭·메뉴·⌘W·bulk) — 실행 중 확인은 대상 전부를 모아 한 번, 핀 탭이 있으면 확인을 거친다(K3ⓒ).
   * 실제로 닫힌 탭만 다시 열기 기록에 넣는다(탭마다 1건). `anchor` = 「다른/오른쪽/왼쪽 탭 닫기」의 기준 탭 — 활성 탭이 닫혔으면 그 탭이 활성이 된다(K2ⓓ).
   */
  const closeTabsByUser = (input: { tabIds: string[]; anchor?: { groupId: string; tab: TabRow }; guarded?: boolean }): void => {
    if (input.tabIds.length === 0) return
    // LIFE-591 E3ⓔ — 이 닫기로 그 worktree 의 터미널 탭이 하나도 안 남으면 herdr workspace 가 닫히고 파일 탭이 화면에서 사라진다(F2 알려진 한계).
    // 그 worktree 에 수정된 파일이 있으면 먼저 묻는다(저장 / 저장 안 함 / 취소). 묻지 않고 닫히는 경로(셸 `exit` 등)에서는 문서가 저장소에 남아
    // 다시 열면 같은 수정 내용으로 돌아오고, 앱 종료 확인에도 잡힌다.
    const owner = (state?.repos ?? []).flatMap((repo) => repo.worktrees).find((row) => row.workspace?.tabs.some((tab) => input.tabIds.includes(tab.tabId)))
    const closesAll = owner?.workspace?.tabs.every((tab) => input.tabIds.includes(tab.tabId)) === true
    if (owner !== undefined && closesAll && dirtyDocs().some((doc) => doc.root === owner.path) && !input.guarded) {
      void confirmWorktreeDocs(owner.path).then((ok) => {
        if (ok) closeTabsByUser({ ...input, guarded: true })
      })
      return
    }
    const snapshots = input.tabIds.flatMap((tabId) => {
      const snapshot = snapshotOf(tabId)
      return snapshot === null ? [] : [{ tabId, snapshot }]
    })
    const anchor = input.anchor
    const activeBefore = anchor === undefined ? null : (layout.groups.find((group) => group.groupId === anchor.groupId)?.activeTabId ?? null)
    lifecycle.actions.closeTabs({
      tabIds: input.tabIds,
      // LIFE-516 K3ⓑ — 설정 › 일반 「고정된 탭을 닫기 전에 확인」 이 꺼지면 핀이라는 이유로는 묻지 않는다(실행 중 확인은 main 이 따로 본다).
      alwaysConfirm: settings.confirmClosePinnedTab && input.tabIds.some((tabId) => pinnedTabs.has(tabId)),
      onClosed: (closed) => {
        for (const entry of snapshots) if (closed.includes(entry.tabId)) recentlyClosedRef.current = pushClosed({ history: recentlyClosedRef.current, snapshot: entry.snapshot })
        if (anchor !== undefined && activeBefore !== null && closed.includes(activeBefore)) activateTab(anchor)
      },
    })
  }

  /**
   * 「다른/오른쪽/왼쪽 탭 닫기」 — 영역에 파일 탭이 섞여 있으면 **종류별로 나눠** 닫는다: 터미널 탭만 herdr 닫기(어댑터)로, 파일 탭은 배치에서만(LIFE-590 — 파일 탭은 herdr 를 부르지 않는다).
   * 기준 탭이 파일 탭이면 터미널 쪽 anchor 대신 닫은 뒤 그 파일 탭을 활성으로 둔다.
   */
  const closeScope = (input: { groupId: string; tabId: string; scope: CloseScope }): void => {
    const group = layout.groups.find((row) => row.groupId === input.groupId)
    if (group === undefined) return
    const targets = closeScopeTargets({ tabOrder: group.tabOrder, tabId: input.tabId, scope: input.scope, pinned: pinnedTabs })
    const files = targets.filter((tabId) => isFileTabId(tabId))
    const activeBefore = group.activeTabId
    // 수정된 파일 탭이 섞였으면 한 번에 묻는다(E3ⓐ 여러 개 닫기 — 파일 목록). 한 닫기 작업이라 확인을 다 마친 뒤에 닫는다 —
    // 취소면 파일 탭도 터미널 탭도 하나도 닫지 않는다(수정 r1 R1-J: 옛 코드는 확인을 기다리지 않고 터미널 탭부터 닫았다). 수정된 파일이 없으면 지금처럼 바로 닫힌다.
    const anchorTab = activeWorkspaceRow?.tabs.find((tab) => tab.tabId === input.tabId)
    closeFilesByUser(files, () => {
      if (isFileTabId(input.tabId) && activeBefore !== null && files.includes(activeBefore)) layout.setActiveTab({ groupId: input.groupId, tabId: input.tabId })
      closeTabsByUser({ tabIds: targets.filter((tabId) => !isFileTabId(tabId)), ...(anchorTab === undefined ? {} : { anchor: { groupId: input.groupId, tab: anchorTab } }) })
    })
  }

  /**
   * LIFE-590 — 파일 탭 닫기(×·중클릭·메뉴·⌘W·팔레트 「pane / 탭 닫기」). 닫은 자리를 다시 열기 기록에 넣는다(⌘⇧T = 같은 파일).
   * LIFE-591 E3 — 수정된 탭이 있으면 먼저 묻는다(저장 / 저장 안 함 / 취소, 여러 개면 목록 한 번). 닫히면 문서(모델)도 버린다 — 「저장 안 함」 뒤 ⌘⇧T 는 디스크 내용(E3ⓖ).
   * `onClosed` = 확인을 지나 닫은 뒤(취소면 부르지 않는다). 닫을 파일 탭이 없으면 바로 부른다.
   */
  const closeFilesByUser = (tabIds: string[], onClosed?: () => void): void => {
    const worktreePath = activeWorktreeRow?.path ?? null
    if (tabIds.length === 0) {
      onClosed?.()
      return
    }
    if (worktreePath === null) return
    // 대상 문서는 그때그때 찾는다 — 확인·저장을 기다리는 사이 처음엔 문서가 없던 탭(한 번도 안 연 탭)을 열어 편집해도 잡힌다(R2-A).
    const targets = (): FileDoc[] =>
      tabIds.flatMap((tabId) => {
        const kind = tabKindOf(tabId)
        const doc = kind.kind === 'file' ? getDoc(docKey(worktreePath, kind.rel)) : undefined
        return doc === undefined ? [] : [doc]
      })
    void confirmDiscardOrSave({ targets, deps: saveDepsRef.current }).then((ok) => {
      if (!ok) return
      for (const tabId of tabIds) closeFileNow({ worktreePath, tabId })
      onClosed?.()
    })
  }
  const closeFileByUser = (tabId: string): void => closeFilesByUser([tabId])
  /** LIFE-691 K2ⓐ — 파일 탭 닫기를 입력 pane 따라가기 대기에 싣는다(위 `closeFollowRef`). 활성 worktree 의 닫기만 실린다. */
  const noteFileClose = (input: { worktreePath: string; tabIds: readonly string[] }): void => {
    closeFollowRef.current = recordCloseFollow({
      pending: closeFollowRef.current,
      activeWorktreePath: activeWorktreeRowRef.current?.path ?? null,
      worktreePath: input.worktreePath,
      activeTabBefore: layoutRef.current.activeTabId,
      tabIds: input.tabIds,
    })
  }
  const closeFileNow = (input: { worktreePath: string; tabId: string }): void => {
    const { worktreePath, tabId } = input
    const kind = tabKindOf(tabId)
    if (kind.kind !== 'file') return
    fileViewStatesOf(worktreePath).delete(tabId)
    disposeDoc(docKey(worktreePath, kind.rel))
    noteFileClose({ worktreePath, tabIds: [tabId] })
    layout.closeFile({
      tabId,
      onClosed: (closed) => {
        recentlyClosedRef.current = pushClosed({ history: recentlyClosedRef.current, snapshot: { kind: 'file', worktreePath, rel: kind.rel, ...closed } })
      },
    })
  }

  /** LIFE-590 E2 — 탐색기에서 파일 열기. 미리보기 교체로 밀려난 파일은 닫은 탭 기록에(Orca 와 같다 — ⌘⇧T 로 돌아온다). */
  const openFileFromExplorer = (input: { rel: string; preview: boolean }): void => {
    const worktreePath = activeWorktreeRow?.path ?? null
    if (worktreePath === null) return
    layout.openFile({
      rel: input.rel,
      preview: input.preview,
      onReplaced: (replaced) => {
        // 교체로 밀려난 미리보기 탭의 문서 — 수정된 미리보기는 고정돼 교체되지 않으므로(E1ⓓ) 여기 오는 것은 수정 없는 문서다.
        const replacedDoc = getDoc(docKey(worktreePath, replaced.rel))
        if (replacedDoc !== undefined && !replacedDoc.dirty) disposeDoc(replacedDoc.key)
        recentlyClosedRef.current = pushClosed({ history: recentlyClosedRef.current, snapshot: { kind: 'file', worktreePath, rel: replaced.rel, preview: true, groupId: replaced.groupId, index: replaced.index } })
      },
    })
  }

  /**
   * LIFE-593 — 전체 목록(git)에서 고른 파일 열기: ⌘P(E3 — 고정 탭·편집기 포커스)·이름 필터 행(수정 r2 R2-C-03). 여는 경로는 탐색기와 같다(우회 IPC 없음).
   * 수정 r1 R1-C-02 — NFC 로 같은 파일 탭이 이미 있으면 그 경로로 연다(같은 탭). R1-C-05 — 부모 폴더 목록에서 그 이름이 폴더(폴더 링크)면 열지 않고 안내만 한다
   * (git 목록은 untracked·무시된 링크의 종류를 모른다). `focus` 면 연 뒤 포커스는 `focusOpenedFile`.
   */
  const openListedFile = (input: { rel: string; preview: boolean; focus: boolean }): void => {
    const worktreePath = activeWorktreeRow?.path ?? null
    if (worktreePath === null) return
    const nfc = input.rel.normalize('NFC')
    let target = input.rel
    for (const group of layout.groups)
      for (const tabId of group.tabOrder) {
        const kind = tabKindOf(tabId)
        if (kind.kind === 'file' && kind.rel !== input.rel && kind.rel.normalize('NFC') === nfc) target = kind.rel
      }
    const slash = target.lastIndexOf('/')
    const name = target.slice(slash + 1)
    void window.corral.explorerList({ root: worktreePath, rel: slash === -1 ? '' : target.slice(0, slash) }).then((listing) => {
      if ((activeWorktreeRowRef.current?.path ?? null) !== worktreePath) return
      const entry = listing.ok ? listing.entries.find((item) => item.name === name || item.name.normalize('NFC') === name.normalize('NFC')) : undefined
      if (entry?.kind === 'dir') {
        notify(`${target} 은(는) 폴더(링크)라 파일로 열지 않습니다`)
        return
      }
      openFileFromExplorer({ rel: target, preview: input.preview })
      if (input.focus) focusOpenedFile({ worktreePath, rel: target })
    })
  }
  const openFromQuickOpen = (rel: string): void => openListedFile({ rel, preview: false, focus: true })
  /**
   * 연 파일 탭에 포커스(수정 r1 R1-C-01·R1-C-06) — 편집기가 붙으면 편집기 핸들의 `focus()`(Monaco 0.57 은 EditContext — 입력 요소가 textarea 가 아니다).
   * 편집기가 없는 보기(이미지·바이너리·상한 초과·오류·Markdown 미리보기)면 그 보기 자리(`[data-file-view]`, tabIndex -1)에. 편집기는 비동기로 붙으므로 프레임마다 다시 본다(최대 약 2 s).
   */
  const focusOpenedFile = (input: { worktreePath: string; rel: string }): void => {
    const tabId = fileTabId(input.rel)
    const startedAt = performance.now()
    const attempt = (): void => {
      if (focusLiveEditor({ store: fileViewStatesOf(input.worktreePath), tabId })) return
      const view = document.querySelector<HTMLElement>(`.file-group[data-file-view="${CSS.escape(input.rel)}"]`)
      const waiting = view === null || view.querySelector('[data-file-editor], [data-file-notice="loading"]') !== null
      if (!waiting) view.focus({ preventScroll: true })
      else if (performance.now() - startedAt < 2_000) requestAnimationFrame(attempt)
      else view?.focus({ preventScroll: true })
    }
    requestAnimationFrame(attempt)
  }

  // LIFE-592 F4 — 탐색기 파일 조작(만들기·이름 바꾸기·이동·삭제·복제·가져오기·실행 취소).
  const fileOps = useFileOps({
    root: activeWorktreeRow?.path ?? null,
    explorer,
    // 탐색기 삭제·이동으로 닫히는 파일 탭도 입력 pane 따라가기에 싣는다(LIFE-691 f1 D).
    layout: {
      fileLayoutOf: layout.fileLayoutOf,
      retargetFiles: layout.retargetFiles,
      closeFiles: (input) => {
        noteFileClose(input)
        layout.closeFiles(input)
      },
    },
    viewStatesOf: fileViewStatesOf,
    markdownModesOf,
    recentlyClosedRef,
    notify,
    openFile: openFileFromExplorer,
    holdWatch,
  })
  const importDrop = fileOps.importDrop
  useEffect(() => window.corral.onExplorerDrop((drop) => void importDrop(drop)), [importDrop])

  /** ⌘⇧T (K6) — 활성 worktree 의 가장 최근 닫은 탭을 같은 시작 디렉터리의 새 셸로. 파일 탭이었으면 같은 파일을 같은 자리에(LIFE-590). 비어 있으면 아무것도 안 한다. */
  const reopenClosedTab = (): void => {
    const worktreePath = activeWorktreeRow?.path ?? null
    const workspaceId = activeWorkspaceRow?.workspaceId ?? null
    if (worktreePath === null || workspaceId === null) return
    const popped = popClosed({ history: recentlyClosedRef.current, worktreePath })
    if (popped.snapshot === null) return
    recentlyClosedRef.current = popped.history
    const snapshot = popped.snapshot
    if (snapshot.kind === 'file') {
      layout.reopenFile({ rel: snapshot.rel, groupId: snapshot.groupId, index: snapshot.index, preview: snapshot.preview })
      return
    }
    lifecycle.actions.reopenTab({
      workspaceId,
      cwd: snapshot.cwd,
      label: snapshot.label,
      onTab: (tabId) => {
        pendingPlacementsRef.current = addPlacement({
          pending: pendingPlacementsRef.current,
          placement: { tabId, workspaceId, groupId: snapshot.groupId, index: snapshot.index, color: snapshot.color },
        })
      },
      // 만들기가 실패하면 꺼낸 기록을 맨 앞으로 되돌린다 — 다음 ⌘⇧T 가 같은 탭을 다시 시도한다.
      onFailed: () => {
        recentlyClosedRef.current = pushClosed({ history: recentlyClosedRef.current, snapshot })
      },
    })
  }

  const togglePin = (tab: TabRow): void =>
    setTabMarks((marks) => setTabPinned({ marks, tabId: tab.tabId, workspaceId: tab.workspaceId, pinned: !pinnedTabIds(marks).has(tab.tabId) }))

  /** 활성 영역 안 탭 이동(⌘⇧[ ]·⌘⌥[ ]·⌃PgUp/Dn·⌃1–9) — 활성 영역의 시각 순서로 고르고 탭 클릭과 같은 길로 간다. */
  const selectTabInActiveGroup = (pick: (input: { tabOrder: readonly string[]; activeTabId: string | null }) => string | null): void => {
    const { activeGroupId, activeTabId, activeTabOrder } = layoutRef.current
    if (activeGroupId === null) return
    const picked = pick({ tabOrder: activeTabOrder, activeTabId })
    if (picked === null || picked === activeTabId) return
    // LIFE-590 E3ⓐ — 순환·⌃1–9 는 파일 탭도 센다(시각 순서 그대로). 파일 탭은 pane 이 없어 영역 활성 탭만 바꾼다.
    if (isFileTabId(picked)) {
      layout.setActiveTab({ groupId: activeGroupId, tabId: picked })
      return
    }
    const tab = tabById(picked)
    if (tab === null) return
    activateTab({ groupId: activeGroupId, tab })
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
  const modalBlocked = settingsView !== null || modalOpen || pendingRemove !== null || lifecycle.pendingClose !== null || lifecycle.worktreeModal !== null || cardActions.blocked
  const openQuickOpen = (): void => {
    // 팔레트 항목에서 오면 팔레트가 막 닫히는 중이다(이 렌더의 paletteOpen 은 아직 true) — 팔레트 열림은 단축키 쪽(useKeybindings blocked)이 막는다.
    if (modalBlocked || quickOpenOpen || document.querySelector('.main-tab-rename.is-editing')) return
    quickOpenReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    mruCancel()
    setQuickOpenOpen(true)
  }
  const openPalette = (): void => {
    if (modalBlocked || document.querySelector('.main-tab-rename.is-editing')) return
    paletteReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    mruCancel()
    setPaletteOpen(true)
  }
  // 설정이 열린 동안은 `modalBlocked` 라 워크스페이스 단축키(⌘T·⌘W·⌘D …)가 숨은 워크스페이스에 작용하지 않는다(K2ⓕ — 막는다).
  const openSettings = (section: SettingsSectionId = DEFAULT_SETTINGS_SECTION): void => {
    mruCancel()
    setSettingsView(section)
  }
  // 닫으면 직전 화면(워크스페이스)으로 돌아가고 활성 pane 이 포커스를 되찾는다 — `focusable` 이 true 로 바뀌는 것만으로는
  // 다시 포커스되지 않는다(TerminalPane focusToken 주석). 덮개가 걷힌(inert 해제) 다음 프레임에 올린다.
  const closeSettings = (): void => {
    setSettingsView(null)
    requestAnimationFrame(() => setFocusToken((value) => value + 1))
  }
  const openTasks = (): void => {
    mruCancel()
    setTasksMounted(true)
    setTasksOpen(true)
  }
  // 닫으면 덮개가 걷힌 다음 프레임에 활성 pane 이 포커스를 되찾는다(설정 닫기와 같다).
  const closeTasks = (): void => {
    setTasksOpen(false)
    requestAnimationFrame(() => setFocusToken((value) => value + 1))
  }
  /** 링크된 worktree 카드의 작업 줄 — 누르면 작업 페이지 + 그 작업 상세. 연결이 없거나 못 찾으면 키만. */
  const taskLineOf = (worktree: WorktreeRow): WorktreeTaskLine | null => {
    const link = worktree.workLink ?? null
    if (link === null) return null
    const found = link.connected ? linkTitles.get(linkTitleId(link)) : undefined
    const item = found?.state === 'found' ? found.item : null
    return {
      key: link.key,
      title: item?.title ?? null,
      kindLabel: item?.kind.label ?? null,
      statusLabel: null,
      blocked: (item?.openBlockerCount ?? 0) > 0,
      blockers: item?.openBlockers.map((blocker) => `${blocker.key} ${blocker.title}`) ?? [],
      onOpen: () => {
        openTasks()
        setTasksFocus((current) => ({ seq: (current?.seq ?? 0) + 1, connectionId: link.connectionId, itemId: link.itemId ?? item?.id ?? null, key: link.key }))
      },
    }
  }
  const toggleTasks = (): void => {
    if (tasksOpen) closeTasks()
    else openTasks()
  }
  // 터미널 pane 대상 단축키의 대상 — 파일 탭이 활성이면 null(무동작, 수정 r1 R1-B). ⌘W 는 `closeTargetRef` 가 종류를 따로 본다.
  const terminalTarget = (): string | null => terminalKeyTarget({ activeTabId: layoutRef.current.activeTabId, selectedPane: lifecycle.selectedPane })
  const handlers: ShortcutHandlers = {
    'palette.open': openPalette,
    'quickOpen.open': openQuickOpen,
    // 트리 포커스에서만 온다(범위 'explorer') — 탐색기 머리 입력칸을 연다.
    // 팔레트에서 고르면 패널이 닫혀 있을 수 있다 — 열고 연다.
    'explorer.filter': () => {
      rightPanel.show()
      setExplorerFilterToken((value) => value + 1)
    },
    'terminal.new': () => lifecycle.createShell(),
    'mru.open': (variant) => stepMruHold(variant === 1),
    'terminal.split': (variant) => void splitPaneAt({ paneId: terminalTarget(), direction: variant === 1 ? 'down' : 'right' }),
    'group.split': (variant) => {
      const { activeGroupId: groupId, activeTabId: tabId, activeTabCount } = layoutRef.current
      if (groupId === null || tabId === null) return
      if (activeTabCount < 2) { setGroupHint(ONE_TAB_IN_GROUP); return }
      setGroupHint(null)
      layoutRef.current.splitGroup({ groupId, tabId, direction: variant === 1 ? 'column' : 'row' })
    },
    'terminal.focus': (variant) => void focusNeighbor({ paneId: terminalTarget(), direction: (['left', 'right', 'up', 'down'] as const)[variant]! }),
    'group.close': () => {
      const groupId = layoutRef.current.activeGroupId
      if (groupId !== null) layoutRef.current.closeGroup(groupId)
    },
    'terminal.zoom': () => {
      const groupId = layoutRef.current.activeGroupId
      const activeTabId = layoutRef.current.activeTabId
      if (groupId !== null && !(activeTabId !== null && isFileTabId(activeTabId))) toggleZoom({ groupId, paneId: lifecycle.selectedPane })
    },
    'terminal.close': () => {
      const target = closeTargetRef.current
      if (target.tabId === null) return
      if (target.file) { closeFileByUser(target.tabId); return }
      if (target.paneIds.length <= 1) { closeTabsByUser({ tabIds: [target.tabId] }); return }
      void closePaneAt(target.paneIds.find((id) => id === lifecycle.selectedPane) ?? target.paneIds[0] ?? null)
    },
    'sidebar.toggle': toggleSidebar,
    'palette.search': openPalette,
    // 198 — 사이드바가 접혀 있으면 펼친 뒤 드러낸다(`app-command-handlers.ts:190-196` setSidebarOpen(true)).
    'workspace.rename': () => {
      if (sidebarCollapsedRef.current) toggleSidebar()
      cardActions.renameActive()
    },
    'workspace.delete': () => cardActions.deleteHovered(),
    'tab.reopenClosed': () => reopenClosedTab(),
    'tab.rename': () => {
      const tabId = layoutRef.current.activeTabId
      if (tabId !== null) requestRename(tabId)
    },
    'tab.cycle': (variant) => selectTabInActiveGroup(({ tabOrder, activeTabId }) => cycleTabTarget({ tabOrder, activeTabId, direction: variant === 1 ? -1 : 1 })),
    'tab.selectByIndex': (variant) => selectTabInActiveGroup(({ tabOrder }) => tabAtIndex({ tabOrder, index: variant })),
    'settings.open': () => openSettings(),
    'tasks.toggle': toggleTasks,
    'rightPanel.toggle': () => rightPanel.toggle(),
    // VS Code `workbench.view.explorer` — 닫혀 있으면 열고, 트리에 포커스(키가 터미널로 새지 않게 keydown 은 캡처 단계에서 이미 삼켰다).
    // LIFE-591 E2ⓐⓓ — 활성 영역의 활성 탭이 파일 탭이면 그 파일을 저장(편집기·탭바·탐색기 어디에 포커스가 있든). 터미널 탭이면 무동작 — 키는 이미 캡처 단계에서 삼켰다.
    'file.save': () => {
      const tabId = layoutRef.current.activeTabId
      const root = activeWorktreeRow?.path ?? null
      if (tabId === null || root === null) return
      const kind = tabKindOf(tabId)
      const doc = kind.kind === 'file' ? getDoc(docKey(root, kind.rel)) : undefined
      if (doc !== undefined) void saveDoc(doc, saveDepsRef.current)
    },
    // LIFE-629 — 포커스가 있는 Markdown 보기의 탭(없으면 — 팔레트 — 활성 탭)을 원문 ↔ 미리보기로, 그 영역을 활성으로, 바뀐 보기에 포커스(`markdown-toggle.ts`).
    'markdown.togglePreview': createMarkdownToggleHandler({
      root: () => activeWorktreeRow?.path ?? null,
      layout: () => layoutRef.current,
      focused: () => document.activeElement,
      markdownModesOf,
      activateGroup: (groupId) => activateGroup({ groupId, paneId: null }),
      focusOpenedFile,
    }),
    // LIFE-592 — 탐색기 트리 포커스에서만(범위 'explorer'). ⌘⌫ = 선택 항목 삭제(확인 뒤 휴지통), ⌘Z·⌘⇧Z = 탐색기 기록.
    'explorer.delete': () => {
      const selected = explorer.state?.selected ?? null
      if (selected !== null) void fileOps.trash(selected)
    },
    'explorer.undo': () => void fileOps.undo(),
    'explorer.redo': () => void fileOps.redo(),
    'explorer.show': () => {
      rightPanel.show()
      requestAnimationFrame(() => setExplorerFocusToken((value) => value + 1))
    },
    // LIFE-515 — 기본 Agent 로 새 탭. ⌘T 와 같은 대상 workspace·같은 생성 경로(createRow), 에이전트 갈래는 Quick-launch 와 같은 launchAgent(워치독).
    'terminal.newAgent': () => {
      const target = resolveNewAgentTab(settings.defaultAgent)
      switch (target.kind) {
        case 'agent':
          lifecycle.createAgentTab({ kind: target.agent, label: AGENT_LAUNCH_LABEL[target.agent] })
          return
        case 'shell':
          lifecycle.createShell()
          return
      }
    },
  }
  // 작업 페이지가 열린 동안 워크스페이스 단축키(⌘T·⌘W·⌘D …)는 숨은 워크스페이스에 작용하지 않는다 — 설정 페이지(K2ⓕ)와 같은 규칙.
  // 키는 useKeybindings 가 이미 삼켰으므로 터미널로 새지 않는다. 페이지 닫기(⌘I)·설정·사이드바 접기만 산다.
  const activeHandlers: ShortcutHandlers = { ...handlers }
  if (tasksOpen) for (const action of ACTIONS) if (!TASKS_PAGE_SHORTCUTS.includes(action.id)) activeHandlers[action.id] = () => undefined
  const keymap = useKeybindings(activeHandlers, modalBlocked || paletteOpen || quickOpenOpen, () => {
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
        if (result.message !== null) notify(result.message)
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
    manualOrder.forget({ root: repo.root, registryGeneration: result.registryGeneration ?? null })
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
    // LIFE-590 — 탭바는 배치 순서대로 터미널·파일 탭을 섞어 그린다. herdr 에 아직 없는 터미널 id 는 빠진다(기존과 같다).
    const groupPreview = previewOf(group)
    const groupItems: GroupTabItem[] = group.tabOrder.flatMap((tabId): GroupTabItem[] => {
      const kind = tabKindOf(tabId)
      if (kind.kind === 'file')
        return [
          {
            kind: 'file',
            tabId,
            rel: kind.rel,
            preview: groupPreview === tabId,
            deleted: activeWorktreeRow !== null && fileWatchState.get(`${activeWorktreeRow.path}\0${kind.rel}`)?.exists === false,
            dirty: activeWorktreeRow !== null && getDoc(docKey(activeWorktreeRow.path, kind.rel))?.dirty === true,
          },
        ]
      const tab = tabById(tabId)
      return tab === null ? [] : [{ kind: 'terminal', tab }]
    })
    const activeFile = group.activeTabId === null ? null : tabKindOf(group.activeTabId)
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
          headSpacer={sidebarCollapsed && settingsView === null && layout.groups[0]?.groupId === group.groupId}
          tailToggle={
            rightPanel.ready && !rightPanel.open && layout.layout !== null && topRightGroupId(layout.layout.root) === group.groupId ? (
              <RightPanelToggle label="오른쪽 패널 열기" shortcut={rightPanelToggleShortcut} onToggle={rightPanel.toggle} placement="tabbar" />
            ) : null
          }
          tabs={groupTabs}
          items={groupItems}
          onSelectFileTab={(tabId) => {
            if (tabDrag.consumeClick()) return
            layout.setActiveTab({ groupId: group.groupId, tabId })
          }}
          onCloseFileTab={closeFileByUser}
          onKeepFileTab={layout.keepFile}
          onCloseFileScope={({ tabId, scope }) => closeScope({ groupId: group.groupId, tabId, scope })}
          workspaceTabCount={activeWorkspaceRow?.tabs.length ?? groupTabs.length}
          home={state.home}
          selectedPane={groupSelectedPaneId}
          activeTabId={group.activeTabId}
          activeGroup={isActiveGroup}
          unreadPanes={unread.panes}
          paneCount={groupActiveTab?.panes.length ?? 0}
          grid={gridOfSelected}
          zoomed={groupState?.zoomedPaneId != null}
          onActivate={() => activateGroup({ groupId: group.groupId, paneId: groupSelectedPaneId })}
          onTabDragStart={(event, tabId) => tabDrag.onArm(event, { tabId, fromGroupId: group.groupId })}
          tabDragActive={tabDrag.dragState !== null}
          onSelectTab={(tab) => {
            // LIFE-387 A1 — 문턱을 넘긴 드래그 뒤에 따라오는 click 하나는 활성화로 치지 않는다.
            if (tabDrag.consumeClick()) return
            layout.setActiveTab({ groupId: group.groupId, tabId: tab.tabId })
            const pane = pickPane(tab)
            if (pane !== null) selectPane(pane.paneId)
          }}
          onCreateShell={() => lifecycle.actions.createRow(workspaceId, 'shell')}
          openTabEntries={openTabEntries}
          onLaunchAgent={(kind) => lifecycle.actions.launchAgent({ workspaceId, kind, label: AGENT_LAUNCH_LABEL[kind] })}
          onOpenAgentSettings={() => openSettings('agents')}
          onActivateOpenTab={({ tabId }) => {
            // 그 탭이 속한 영역에서 활성으로 + pane 선택(포커스 토큰) — 사이드바 세션 클릭과 같은 길(revealPane)이다.
            const target = tabById(tabId)
            const pane = target === null ? null : pickPane(target)
            if (pane !== null) revealPane(pane.paneId)
          }}
          onCloseTab={(tab) => closeTabsByUser({ tabIds: [tab.tabId] })}
          onRenameTab={({ tab, label, tabCount }) => lifecycle.actions.renameRow({ tabId: tab.tabId, label, tabNumber: tab.number, tabCount })}
          onClearTabName={(tab) => lifecycle.actions.clearRowName(tab.tabId)}
          onSplitPane={(direction) => void splitPaneAt({ paneId: groupSelectedPaneId, direction })}
          onSplitTab={({ tab, direction }) => {
            // F7 — 우클릭한 탭을 쪼갠다. 비활성 탭이면 먼저 활성으로(220 `TerminalTabSplitMenuSection.tsx:37-77`).
            if (tab.tabId === groupActiveTab?.tabId) {
              void splitPaneAt({ paneId: groupSelectedPaneId, direction })
              return
            }
            activateTab({ groupId: group.groupId, tab })
            void splitPaneAt({ paneId: pickPane(tab)?.paneId ?? null, direction })
          }}
          onMoveToGroup={({ tabId, direction }) => layout.splitGroup({ groupId: group.groupId, tabId, ...moveDirectionToSplit(direction) })}
          pinnedTabs={pinnedTabs}
          tabColorOf={(tabId) => {
            const tab = tabById(tabId)
            return tab === null ? null : (markOf({ marks: tabMarks, tabId, workspaceId: tab.workspaceId })?.color ?? null)
          }}
          renameRequest={renameRequest}
          onRequestRename={requestRename}
          onTogglePin={togglePin}
          onCloseScope={({ tab, scope }) => closeScope({ groupId: group.groupId, tabId: tab.tabId, scope })}
          onSetTabColor={({ tab, color }) => setTabMarks((marks) => setTabColor({ marks, tabId: tab.tabId, workspaceId: tab.workspaceId, color }))}
          onZoom={() => toggleZoom({ groupId: group.groupId, paneId: groupSelectedPaneId })}
          onClosePane={() => void closePaneAt(groupSelectedPaneId)}
          onCloseGroup={canCloseGroup}
          // LIFE-387 A1/B1 — "다른 영역으로 옮기기". 라벨은 herdr 원 label(sessionTitle 전체
          // 파생은 그 영역의 selectedPane 등 별도 문맥이 필요해 과한 비용 — 메뉴 한 줄 식별에는
          // 이 정도로 충분하다는 판단, 03-result.md 에 단순화로 기록).
          otherGroups={layout.groups
            .filter((other) => other.groupId !== group.groupId)
            .map((other) => {
              const kind = other.activeTabId === null ? null : tabKindOf(other.activeTabId)
              return { groupId: other.groupId, label: kind?.kind === 'file' ? fileTabLabel(kind.rel) : (tabById(other.activeTabId)?.label ?? '비어 있음') }
            })}
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
        {activeFile !== null && activeFile.kind === 'file' && activeWorktreeRow !== null ? (
          <FileView
            key={activeFile.tabId}
            root={activeWorktreeRow.path}
            rel={activeFile.rel}
            tabId={activeFile.tabId}
            groupId={group.groupId}
            viewStates={fileViewStatesOf(activeWorktreeRow.path)}
            markdownModes={markdownModesOf(activeWorktreeRow.path)}
            watched={fileWatchState.get(`${activeWorktreeRow.path}\0${activeFile.rel}`) ?? null}
            onActivate={() => activateGroup({ groupId: group.groupId, paneId: null })}
            onOpenFile={(rel) => openFileFromExplorer({ rel, preview: true })}
            onRefused={() => forgetRecent({ root: activeWorktreeRow.path, rel: activeFile.rel })}
          />
        ) : groupPane === null ? (
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
                    focusable={isActiveGroup && !paletteOpen && !quickOpenOpen && !modalBlocked && !tasksOpen}
                    focusToken={isActiveGroup && !paletteOpen && !quickOpenOpen && !modalBlocked && !tasksOpen ? focusToken : 0}
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
                focusable={isActiveGroup && !paletteOpen && !quickOpenOpen && !modalBlocked && !tasksOpen}
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

  const paletteEntries: PaletteEntry[] = []
  const connected = state.link.phase === 'live'
  // 수정 r1 R1-B — 파일 탭이 활성이면 pane 대상 명령은 무동작이라 팔레트에서도 막아 둔다.
  const TERMINAL_PANE_ACTIONS = new Set<string>(['terminal.split', 'terminal.focus', 'terminal.zoom'])
  const palettePaneAlive = !!activeWorkspace?.tabs.some(tab => tab.panes.some(pane => pane.paneId === lifecycle.selectedPane))
  for (const action of ACTIONS) {
    // ⌘⇧⌫ 는 hover 중인 카드가 대상이라 팔레트에서 부를 대상이 없다.
    if (action.id === 'palette.open' || action.id === 'palette.search' || action.id === 'workspace.delete') continue
    for (let variant = 0; variant < action.variants.length; variant++) {
      const id = action.id
      paletteEntries.push({ id: `${id}:${variant}`, title: `${action.title} · ${action.variants[variant]}`, detail: id,
        shortcut: bindingsFor(id, keymap.overrides).flatMap((binding, index) => (binding !== null && action.bindingVariants[index] === variant ? [formatBinding(binding)] : [])).join(' / '),
        disabled: id === 'sidebar.toggle' || id === 'settings.open' || id === 'quickOpen.open' || id === 'explorer.filter' ? undefined : !connected ? '연결된 세션이 없습니다' : !palettePaneAlive ? '선택된 pane이 없습니다' : activeFileRel !== null && TERMINAL_PANE_ACTIONS.has(id) ? '파일 탭에서는 쓸 수 없습니다' : id === 'group.split' && (layout.groups.find(group => group.groupId === layout.activeGroupId)?.tabOrder.length ?? 0) < 2 ? ONE_TAB_IN_GROUP : undefined,
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
  // 설정 섹션 — 내비와 같은 레지스트리(K1ⓒ). 옛 「단축키 설정」 항목은 「설정 › 단축키」 로 간다.
  for (const section of SETTINGS_SECTIONS) {
    paletteEntries.push({ id: `settings.section:${section.id}`, title: `설정 › ${section.title}`, detail: section.description, keywords: ['settings', '설정', ...section.searchEntries.flatMap((entry) => [entry.title, ...(entry.keywords ?? [])])].join(' '), run: () => openSettings(section.id) })
  }
  for (const kind of ['claude', 'codex', 'grok'] as const) paletteEntries.push({ id: `agent.start.${kind}`, title: `새 ${kind} 에이전트`, detail: activeWorktree?.path ?? 'worktree 선택 필요', disabled: !connected ? '연결된 세션이 없습니다' : !activeWorkspace ? '열린 worktree를 선택하세요' : undefined, run: () => { if (activeWorkspace) lifecycle.actions.createRow(activeWorkspace.workspaceId, kind) } })
  for (const repo of state.repos) {
    const primary = repo.worktrees.find(worktree => !worktree.isLinked)
    paletteEntries.push({ id: `repo.select:${repo.root}`, title: `레포 선택 · ${repo.root.split('/').at(-1)}`, detail: repo.root, disabled: !connected ? '연결된 세션이 없습니다' : undefined, run: () => { if (primary) lifecycle.actions.openWorktree(repo.root, primary) } })
    paletteEntries.push({ id: `worktree.create:${repo.root}`, title: '새 worktree 만들기', detail: repo.root, disabled: !connected ? '연결된 세션이 없습니다' : undefined, run: () => lifecycle.actions.openCreateWorktree(repo.root) })
    for (const worktree of repo.worktrees) {
      paletteEntries.push({ id: `worktree.open:${worktree.path}`, title: `${worktree.workspace ? 'worktree 전환' : 'worktree 열기'} · ${paletteWorktreeName(worktree)}`, detail: worktree.path, disabled: !connected ? '연결된 세션이 없습니다' : undefined, run: () => lifecycle.actions.openWorktree(repo.root, worktree) })
      for (const tab of worktree.workspace?.tabs ?? []) for (const pane of tab.panes) paletteEntries.push({ id: `pane.switch:${pane.paneId}`, title: sessionTitle({ tab, tabCount: worktree.workspace!.tabs.length, ordinal: tabOrdinals.ordinalFor({ tabId: tab.tabId, groupId: tab.workspaceId }), home: state.home, selectedPaneId: pane.paneId }), detail: `${worktree.path} · ${tab.tabId} · ${pane.paneId} · ${pane.agent ?? 'shell'}`, keywords: 'terminal tab pane switch', disabled: !connected ? '연결된 세션이 없습니다' : undefined, run: () => {
        const alive = stateRef.current?.repos.some(r => r.worktrees.some(w => w.workspace?.tabs.some(t => t.panes.some(p => p.paneId === pane.paneId))))
        if (!alive) { notify('대상 pane이 사라졌습니다'); return }
        revealPane(pane.paneId)
      } })
    }
  }

  // 사이드바 토글의 단축키 표시 — 비운 칸(null, fix2 R2-01)이면 툴팁에 단축키를 싣지 않는다.
  const sidebarToggleShortcut = ((binding) => (binding == null ? null : formatBinding(binding)))(bindingsFor('sidebar.toggle', keymap.overrides)[0])
  const rightPanelToggleShortcut = ((binding) => (binding == null ? null : formatBinding(binding)))(bindingsFor('rightPanel.toggle', keymap.overrides)[0])

  return (
    <BindingLabels.Provider value={keymap.overrides}>
    <div className="app">
      <div className="app-stack">
      <div className={`app-body${settingsView === null ? '' : ' is-covered'}`} inert={paletteOpen || quickOpenOpen || settingsView !== null}>
        {/* LIFE-527 D4·D5 — 사이드바 칸 = 머리(36px, 신호등·앱 이름·토글) + 사이드바. 접히면 머리만 왼쪽 위에 떠서 첫 탭 줄과 겹친다
            (Orca `AppWorkspaceShell.tsx` — 폭 0 칸 안의 absolute 머리). 머리는 DOM 에서 main-area 보다 앞이다 — drag 히트테스트 순서가 Orca 와 같다. */}
        {sidebarCollapsed ? (
          <div className="sidebar-column is-collapsed">
            <SidebarHead floating trafficLightPad={showsTrafficLightPad(windowChrome)} toggleLabel="사이드바 펼치기" toggleShortcut={sidebarToggleShortcut} onToggle={toggleSidebar} controlsRef={measureFloatingHead} />
          </div>
        ) : <>
        <div className="sidebar-column">
        <SidebarHead floating={false} trafficLightPad={showsTrafficLightPad(windowChrome)} toggleLabel="사이드바 접기" toggleShortcut={sidebarToggleShortcut} onToggle={toggleSidebar} />
        <Sidebar
          sidebarRef={sidebarRef}
          width={width}
          state={state}
          activeWorkspaceId={lifecycle.activeWorkspaceId}
          selectedPane={lifecycle.selectedPane}
          selectPane={revealPane}
          closePane={(paneId) => {
            // LIFE-495 K3ⓒ — 고정된 탭의 마지막 pane 을 사이드바에서 닫으면 탭이 닫히므로 탭 닫기 길(고정 확인·게이트·다시 열기 기록)로 보낸다.
            // 소유 탭은 전체 state 에서 찾는다(fix1 R1-02 — 활성이 아닌 워크스페이스의 핀 탭이 확인 없이 닫혔다).
            const route = sidebarCloseRoute({ repos: state?.repos ?? [], paneId, pinned: pinnedTabs })
            if (route.kind === 'tab') closeTabsByUser({ tabIds: [route.tabId] })
            else void closePaneAt(paneId)
          }}
          actions={{
            ...lifecycle.actions,
            // LIFE-591 E3ⓓ — 사이드바 카드 닫기: 그 worktree 에 수정된 파일이 있으면 먼저 묻는다(저장 / 저장 안 함 / 취소). 취소면 닫지 않는다.
            closeWorktree: (workspaceId) => {
              const row = state.repos.flatMap((repo) => repo.worktrees).find((worktree) => worktree.openWorkspaceId === workspaceId)
              if (row === undefined) {
                lifecycle.actions.closeWorktree(workspaceId)
                return
              }
              void confirmWorktreeDocs(row.path).then((ok) => {
                if (ok) lifecycle.actions.closeWorktree(workspaceId)
              })
            },
          }}
          manualOrder={manualOrder.order}
          onReorder={({ commit, layout }) => {
            // 비-manual 모드에서 카드를 끌어 **순서가 바뀌면** Sort by → Manual(198 `use-status-mutations.ts:135-160`, K7ⓐ).
            // 그 드롭은 보이는 전 그룹의 지금 배치를 먼저 수동 순서로 확정한다(R2-01) — 끌지 않은 레포도 Manual 화면에서 그대로다.
            // 안 바뀐 드래그는 모드를 안 건드린다(K7ⓑ).
            const toManual = commit.source.kind !== 'repo' && sidebarView.view.sortBy !== 'manual'
            const changed = manualOrder.commit({ commit, layout: toManual ? layout : null })
            if (changed && toManual) sidebarView.change({ sortBy: 'manual' })
          }}
          view={sidebarView.view}
          onChangeView={sidebarView.change}
          onOpenSearch={openPalette}
          taskLineOf={taskLineOf}
          tasks={{ open: tasksOpen, onToggle: toggleTasks, shortcut: ((binding) => (binding == null ? null : formatBinding(binding)))(bindingsFor('tasks.toggle', keymap.overrides)[0]) }}
          searchShortcut={((binding) => (binding == null ? null : formatBinding(binding)))(bindingsFor('palette.search', keymap.overrides)[0])}
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
          onRefresh={() => void window.corral.refreshTree().then(setState)}
          lineageCollapse={lineageCollapse}
          cards={{ ...cardActions.sidebarCards, unread, deleteShortcut: ((binding) => (binding == null ? null : formatBinding(binding)))(bindingsFor('workspace.delete', keymap.overrides)[0]) }}
          onOpenShortcuts={() => openSettings('shortcuts')}
          onOpenSettings={() => openSettings()}
          groupGlyphOf={(worktreePath) => {
            // R17-2 공백 2 — 영속 스키마(R3-h)가 영역 수를 그대로 주므로 **넣는다**(비용 0).
            if (layout.groupCountOf(worktreePath) < 2) return null
            return layout.splitDirectionOf(worktreePath) === 'column' ? '⊟' : '◫'
          }}
        />
        </div>
        {/* LIFE-468 D19 — 리사이저는 레이아웃 폭 0 의 닻 위에 겹쳐 뜬다(Orca `absolute -right-1.5 w-3`). 패널과 본문의 구분선은
            본문 왼쪽 테두리가 진다(Orca `border-l border-border`). */}
        <div className="sidebar-resizer-anchor">
          <div className="sidebar-resizer" data-sidebar-resizer onMouseDown={onHandleMouseDown}>
            <div className="sidebar-resizer-line" data-sidebar-resizer-line />
          </div>
        </div>

        </>}
        <div className="main-area" data-main-area>
          {/* LIFE-601 — 작업 페이지가 열리면 메인 영역 내용만 덮는다(visibility:hidden + inert, 상자는 그대로 — display:contents 래퍼라 배치도 그대로). */}
          <div className={`main-area-content${tasksOpen ? ' is-covered' : ''}`} data-main-area-content="" inert={tasksOpen}>
          {/* LIFE-527 D6 — 4px 드래그 띠 + 32px 영역 탭 줄 = 36px 기준선(Orca `TabGroupSplitLayout.tsx:316`). workspace-tools 줄(명령·단축키·
              사이드바 펼치기)과 앱 수준 알림 줄은 없앴다 — 팔레트는 사이드바 Search 줄·⌘K, 단축키는 하단 ? 메뉴, 펼치기는 떠 있는 머리(D7·D8·D5). */}
          <div className="top-drag-strip" data-top-drag-strip="" />

          <TerminalChrome panes={stripPanes}>
            {/* LIFE-485 D3 — 링크가 live 가 아닐 때의 원인·행동. 결정은 main(`decideBackend`)이 하고 여기는 그린다. */}
            {backendBlocksTerminal(state.backend) ? (
              <BackendCard status={state.backend} onStart={() => void window.corral.startBackend()} />
            ) : activeWorkspace === null || layout.layout === null ? (
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
          {/* LIFE-485 r1 R1-01 — 재연결 중은 격자를 걷지 않고 배너만 겹친다. */}
          <BackendBanner status={state.backend} />

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
          {tasksMounted ? (
            <TasksPage
              open={tasksOpen}
              repos={state.repos}
              activeRepoRoot={state.repos.find((repo) => repo.worktrees.some((worktree) => worktree === activeWorktree))?.root ?? null}
              shortcut={((binding) => (binding == null ? null : formatBinding(binding)))(bindingsFor('tasks.toggle', keymap.overrides)[0])}
              yieldKeys={modalBlocked || paletteOpen || quickOpenOpen}
              onClose={closeTasks}
              onOpenSettings={() => openSettings('connections')}
              onOpenWorktree={(tree) => {
                // 작업 중 줄 클릭 = 페이지 닫힘 + 그 worktree 활성 + 첫 세션 선택 — 사이드바 카드 클릭과 같은 함수(C11).
                const worktree = state.repos.find((repo) => repo.root === tree.repoRoot)?.worktrees.find((entry) => entry.path === tree.path)
                closeTasks()
                if (worktree !== undefined) activateWorktreeCard({ actions: lifecycle.actions, repoRoot: tree.repoRoot, worktree, selectPane: revealPane })
              }}
              unreadPanes={unread.panes}
              onRevealPane={(paneId) => {
                // 「터미널에서 답하기」 — 페이지를 닫고 그 pane 으로(사이드바 세션 클릭과 같은 길).
                closeTasks()
                revealPane(paneId)
              }}
              focus={tasksFocus}
            />
          ) : null}
        </div>
        <RightPanel
          open={rightPanel.open}
          title="탐색기"
          panelRef={rightPanelRef}
          toggleShortcut={rightPanelToggleShortcut}
          onToggle={rightPanel.toggle}
          onResizeStart={rightPanel.onHandleMouseDown}
        >
          <Explorer explorer={explorer} title={activeWorktree === undefined ? null : worktreeDisplayName(activeWorktree)} focusToken={explorerFocusToken} filterToken={explorerFilterToken} visible={rightPanel.open} revealRequest={revealRequest} onOpenFile={openFileFromExplorer} onOpenListed={(input) => openListedFile({ ...input, focus: false })} ops={fileOps} notify={notify} />
        </RightPanel>
      </div>
      {settingsView === null ? null : (
        // LIFE-527 D12 — Orca 설정 뷰는 전폭 36px 타이틀바(신호등 여백 + drag)를 유지한다. 설정 페이지는 그 아래에 선다.
        <div className="settings-overlay" data-settings-overlay="">
        <div className="settings-topbar" data-settings-topbar="">
          {showsTrafficLightPad(windowChrome) ? <div className="sidebar-head-traffic-pad" data-traffic-light-pad="" /> : null}
        </div>
        <SettingsPage section={settingsView} onSelectSection={setSettingsView} onClose={closeSettings} overrides={keymap.overrides} onChangeOverrides={keymap.setOverrides} sidebarView={sidebarView.view} onChangeSidebarView={sidebarView.change} repos={state?.repos ?? NO_REPOS} />
        </div>
      )}
      </div>

      <StatusBar
        inert={paletteOpen || quickOpenOpen}
        activeWorktreeLabel={activeWorktree === undefined ? null : (activeWorktree.branch ?? worktreeDisplayName(activeWorktree))}
        dirtyTotal={dirtyTotal}
        aheadTotal={aheadTotal}
        behindTotal={behindTotal}
        resourceSegment={<ResourceSegment />}
      />

      {paletteOpen ? <CommandPalette entries={paletteEntries} onClose={restore => {
        setPaletteOpen(false)
        if (restore) requestAnimationFrame(() => { if (paletteReturn.current?.isConnected) paletteReturn.current.focus(); else setFocusToken(value => value + 1) })
      }} /> : null}
      {quickOpenOpen ? (
        <QuickOpen
          root={activeWorktreeRow?.path ?? null}
          recent={activeWorktreeRow === null ? NO_RECENT : (recentFiles[activeWorktreeRow.path] ?? NO_RECENT)}
          includeIgnored={quickOpenIgnored}
          onIncludeIgnored={setQuickOpenIgnored}
          onOpen={openFromQuickOpen}
          onClose={(restore) => {
            setQuickOpenOpen(false)
            if (restore) requestAnimationFrame(() => { if (quickOpenReturn.current?.isConnected) quickOpenReturn.current.focus(); else setFocusToken((value) => value + 1) })
          }}
        />
      ) : null}
      {cardActions.dialogs}
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

      {lifecycle.pendingClose === null ? null : (() => {
        const pending = lifecycle.pendingClose
        if (pending.target.kind === 'workspace') {
          return (
            <ConfirmClose
              copy={closeCopy({ kind: 'worktree' })}
              rows={[{ key: pending.target.workspaceId, label: null, foreground: pending.foreground }]}
              onConfirm={() => lifecycle.confirmPendingClose()}
              onCancel={lifecycle.cancelPendingClose}
            />
          )
        }
        const tabIds = pending.target.tabIds
        // 핀이 확인 사유인 것은 요청 때 핀 확인이 켜져 있었을 때뿐이다(`alwaysConfirm`) — 꺼져 있으면 핀 줄·핀 안내를 싣지 않는다(LIFE-516 K3ⓑ).
        const pinnedAsks = (tabId: string): boolean => pending.target.kind === 'tabs' && pending.target.alwaysConfirm && pinnedTabs.has(tabId)
        const agentPaneIds = new Set(
          state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes).filter((pane) => pane.agent !== null).map((pane) => pane.paneId),
        )
        const rows = tabIds
          .filter((tabId) => pinnedAsks(tabId) || pending.running.some((pane) => pane.tabId === tabId))
          .map((tabId) => {
            const tab = tabById(tabId) ?? state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => worktree.workspace?.tabs ?? []).find((row) => row.tabId === tabId) ?? null
            const label =
              tab === null
                ? tabId
                : sessionTitle({ tab, tabCount: activeWorkspace?.tabs.length ?? null, ordinal: tabOrdinals.ordinalFor({ tabId, groupId: tab.workspaceId }), home: state.home, selectedPaneId: null })
            return { key: tabId, label, foreground: pending.running.filter((pane) => pane.tabId === tabId).flatMap((pane) => pane.foreground) }
          })
        const copy = closeCopy({ kind: 'tabs', tabCount: tabIds.length, running: pending.running, agentPaneIds, pinnedCount: tabIds.filter(pinnedAsks).length })
        return (
          <ConfirmClose
            key={`${tabIds.join(',')}|${pending.running.map((pane) => pane.paneId).join(',')}`}
            copy={copy}
            rows={rows}
            onConfirm={({ dontAskAgain }) => {
              // LIFE-516 K3ⓒ·K4ⓐ — 체크 + 확인만 저장(라벨이 이름 붙인 설정 하나), 그다음 닫는다. 취소는 저장하지 않는다.
              if (!dontAskAgain || copy.dontAskAgain === null) {
                lifecycle.confirmPendingClose()
                return
              }
              // 저장이 끝난 뒤 닫는다 — 그사이 취소·두 번째 확인은 닫기를 만들지 않는다(fix1 R1-01). 저장 실패면 알리고 닫기는 진행한다(R1-02).
              const patch = copy.dontAskAgain.patch
              lifecycle.confirmPendingClose({
                before: async () => {
                  if (!(await updateSettings(patch))) notify(CLOSE_SKIP_FAILED_NOTICE)
                },
              })
            }}
            onCancel={lifecycle.cancelPendingClose}
          />
        )
      })()}

      {lifecycle.worktreeModal === null ? null : (
        <CreateWorktreeModal
          repoRoot={lifecycle.worktreeModal.repoRoot}
          create={lifecycle.createWorktree}
          onClose={lifecycle.closeWorktreeModal}
          onDone={(message) => {
            lifecycle.closeWorktreeModal()
            notify(message)
          }}
        />
      )}

      <Toaster />

      {tabDrag.dragState === null ? null : (
        <DropZoneOverlay
          state={tabDrag.dragState}
          tabLabel={tabById(tabDrag.dragState.tabId)?.label ?? ''}
          tabColor={((tab) => (tab === null ? null : (markOf({ marks: tabMarks, tabId: tab.tabId, workspaceId: tab.workspaceId })?.color ?? null)))(tabById(tabDrag.dragState.tabId))}
        />
      )}
    </div>
    </BindingLabels.Provider>
  )
}
