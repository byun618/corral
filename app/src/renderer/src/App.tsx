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
import { linkTitleId, useLinkTitles, type LinkTitleReread } from './hooks/useLinkTitles.js'
import { activateWorktreeCard, worktreeReturnTarget } from './worktree-activate.js'
import { editorMruKey, parseEditorMruKey, pendingFocusVerdict, pruneGroupMru, terminalEditorToggleTarget, toggleNoneHint, touchGroupMru, zoomedGroupOf, zoomHiding } from './group-focus.js'
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
import { closeGroup as closeGroupIn, findGroup, neighborGroupId, newTabPlacement, newTabSlotKey, newTabSlotOf, ONE_GROUP, ONE_TAB_IN_GROUP, topRightGroupId, unrememberedArrivalBranch, type NewTabSlot } from './group-tree.js'
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
import { useScm } from './hooks/useScm.js'
import { usePrComments } from './hooks/usePrComments.js'
import { useFileOps } from './hooks/useFileOps.js'
import { createWatchHold, forgetMissing, type WatchPush } from './watch-hold.js'
import { RightPanel, RightPanelToggle } from './components/RightPanel.js'
import { RIGHT_PANEL_VIEWS } from './components/right-panel-views.js'
import { Explorer } from './components/Explorer.js'
import { ScmView } from './components/ScmView.js'
import { PrCommentsView } from './components/PrCommentsView.js'
import { DiffView } from './components/DiffView.js'
import { diffTabId, diffTitle, openOf, type ScmChange } from '../../shared/scm.js'
import { useCardActions } from './hooks/useCardActions.js'
import { useTabDrag } from './hooks/useTabDrag.js'
import { useFileDrag } from './hooks/useFileDrag.js'
import { paneToFollow, pickPane } from './pane-utils.js'
import { useOpenTabEntries } from './hooks/useOpenTabEntries.js'
import { useUnread } from './hooks/useUnread.js'
import { PaneLayout, type PaneSeat } from './components/PaneLayout.js'
import { sessionTitle, userLabel } from './session-title.js'
import { CLOSE_CONFIRM_PENDING, closeMixedTabs, cycleAcrossGroups, mixedCloseTargets, sidebarCloseRoute, tabAtIndex, type CloseScope } from './tab-actions.js'
import { keepHerdrTabMarks, keepLiveTabMarks, markOf, pinnedTabIds, readTabMarks, setTabColor, setTabPinned, type TabMark } from './tab-marks.js'
import { popClosed, pushClosed, snapshotCwd, type ClosedTabSnapshot, type RecentlyClosed, addPlacement, takeLivePlacements, type PendingPlacement } from './recently-closed.js'
import {
  alreadyOpenHint,
  closeFollowTarget,
  dragGhostLabel,
  fileTabId,
  fileTabLabel,
  fileTabsOf,
  hintAfterContextChange,
  hintContextKey,
  isFileTabId,
  previewOf,
  recordCloseFollow,
  splitKeyRoute,
  fileTabSplitHint,
  tabKindOf,
  type CarriedHint,
  type CloseFollow,
  type FilePlacement,
} from './file-tabs.js'
import { FileView, focusLiveEditor, type MarkdownModeStore, type ViewStateStore } from './components/FileView.js'
import { createMarkdownToggleHandler } from './markdown-toggle.js'
import { allDocs, dirtyDocs, disposeDoc, docKey, docsVersion, freezeEditing, getDoc, subscribeDocs, thawEditing, type FileDoc } from './file-docs.js'
import { confirmDiscardOrSave, dirtyFilesOf, saveDoc, type SaveDeps } from './file-save.js'
import { CLOSE_SKIP_FAILED_NOTICE, closeCopy } from './close-copy.js'
import { moveDirectionToSplit } from './components/TabContextMenu.js'
import { groupOfTab, listGroups, readStoredLayouts } from './group-tree.js'
import { keepTerminalFocus, TerminalPane } from './TerminalPane.js'
import { updateSettings, useSettings } from './settings-store.js'
import { isAgentAvailable, resolveNewAgentTab } from './tab-create-menu.js'
import { DETECTABLE_AGENTS } from '../../shared/agent-detection.js'
import { useAgentDetection, useRecheckAgentDetectionOnOpen } from './agent-detection-store.js'
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
/** LIFE-824 fix1 A1 — 다른 worktree 로 미뤄 둔 편집기 포커스를 기다리는 상한. 넘도록 그 worktree 배치가 안 오면 버린다. */
const PENDING_FOCUS_MS = 2_000
/** LIFE-824 fix1 A2 — ⌘⌥방향 줄 세우기: 고른 결과가 그려지길 기다리는 상한(바뀐 것이 없어 커밋이 안 오는 회차). */
const DIRECTION_SETTLE_MS = 150
const DIRECTION_QUEUE_MAX = 2
const PANE_DIRECTIONS: readonly PaneDirection[] = ['left', 'right', 'up', 'down']
/** 작업 페이지가 열린 동안에도 사는 단축키 (LIFE-601 C4) — 나머지 워크스페이스 단축키는 삼키기만 한다. */
// LIFE-682 A8 — 오른쪽 패널은 페이지와 무관한 전역 패널이라 작업 페이지에서도 ⌘L·⌘⇧E 가 돈다. 탐색기 범위 액션(필터·삭제·기록)은 트리 포커스에서만 오므로 같이 산다.
const TASKS_PAGE_SHORTCUTS: readonly ActionId[] = ['tasks.toggle', 'settings.open', 'sidebar.toggle', 'rightPanel.toggle', 'explorer.show', 'scm.show', 'explorer.filter', 'explorer.delete', 'explorer.undo', 'explorer.redo']
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
  const confirmWorktreeDocs = (root: string, except?: ReadonlySet<string>): Promise<boolean> =>
    confirmDiscardOrSave({ targets: () => allDocs().filter((doc) => doc.root === root && except?.has(doc.key) !== true), deps: saveDepsRef.current })
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
   * 페이지는 **앱 시작부터 마운트**돼(닫힌 채) 닫혀도 남는다(검색어·스크롤 복원 — C3). 작업 상세 상태를 이 페이지가 갖고 상세는 오른쪽 패널에
   * 그려지므로, 페이지를 한 번도 안 열어도 마지막 상세가 패널에 복원된다(LIFE-682 A5ⓓ). 닫힌 페이지는 목록을 받지 않는다(읽기 조건이 `open`).
   */
  const [tasksOpen, setTasksOpen] = useState(false)
  /** 작업 페이지의 만들기·시작 모달이 열려 있다(LIFE-682 r1) — 그동안 앱 단축키는 모달 뒤에 작용하지 않는다(시작 모달은 페이지가 닫힌 터미널 화면에서도 뜬다). */
  const [tasksModalOpen, setTasksModalOpen] = useState(false)
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
  // LIFE-822 fix2 N1 — 섞인 닫기는 파일 확인을 기다린 **뒤에도** 닫기 확인 창이 떠 있나를 본다. 클릭 렌더의 `lifecycle.pendingClose` 는 그 순간 값으로 굳어 있어
  // await 사이 새로 뜬 창을 못 본다 — 매 렌더 최신 값을 담는 ref 로 읽는다.
  const pendingCloseRef = useRef(lifecycle.pendingClose)
  pendingCloseRef.current = lifecycle.pendingClose
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
  const rightPanel = useRightPanel({ panelRef: rightPanelRef, sidebarWidth: sidebarCollapsed ? 0 : width })
  /** 오른쪽 패널 작업 상세 보기의 몸통 — TasksPage 가 상세 host 를 여기 붙인다(LIFE-682). */
  const [detailSlot, setDetailSlot] = useState<HTMLDivElement | null>(null)
  // 탐색기가 보일 때 = 패널 열림 + 탐색기 보기. 감시·auto reveal·필터는 이것으로 켠다(A11 — 상세 보기 동안 감시 0).
  const explorerVisible = rightPanel.open && rightPanel.view === 'explorer'
  // LIFE-683 — 소스 제어 보기. 감시·git 은 이 보기가 보일 때만(탐색기와 같은 루트면 한 벌 — S8).
  const scmVisible = rightPanel.open && rightPanel.view === 'scm'
  const prVisible = rightPanel.open && rightPanel.view === 'pr'
  const [scmFocusToken, setScmFocusToken] = useState(0)
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
  /**
   * LIFE-824 fix1 A1·A8 — 포커스 이동 순번. 새 이동(키·클릭·MRU·팔레트·세션 클릭)이 시작될 때마다 오른다. 본문 포커스 대기 루프(`focusOpenedFile`·`focusGroupBody`)와
   * 다른 worktree 로 미뤄 둔 편집기 포커스(`pendingFocusRef`)는 자기 순번이 아직 마지막일 때만 포커스를 옮긴다 — 늦게 붙은 편집기가 뒤 이동을 덮지 않게.
   */
  const focusSeqRef = useRef(0)
  /**
   * LIFE-825 미뤄 둔 메뉴 포커스 (fix3 정리·fix4 F1·low H1·H2) — **규칙 한 줄**: 탭바 우클릭은 활성 영역만 옮기고 토큰 하나를 남긴다. 그 우클릭이 연 메뉴가 닫힐 때
   * (Esc·바깥 클릭으로 닫혔고 ⌘⌥방향 요청이 진행 중이면 그 요청이 끝날 때까지 미뤄 — 항목 실행으로 닫히면 미루지 않는다), 그 토큰이 아직 마지막 우클릭의 것이고
   * 그 뒤 실제로 일어난 이동(포커스 순번 상승·⌘⌥방향 이동·CLI reveal)이 없으면 그 영역 본문에 포커스한다 — 아니면 아무것도 안 한다. 항목은 그 뒤에 돈다.
   * 칸은 하나(마지막 우클릭)다. 다른 우클릭이 덮어쓰고, 방향 이동(`focusDirectionOnce`)·reveal(`requestedPane`)이 실제로 일어나는 자리에서 비운다. 이동 없이 끝난 방향 요청(가장자리·거절)은 칸을 남긴다.
   */
  const menuDeferredFocusRef = useRef<{ token: number; seq: number; groupId: string; closed: boolean } | null>(null)
  const menuTokenSeqRef = useRef(0)
  const beginFocusMove = (): number => {
    focusSeqRef.current += 1
    return focusSeqRef.current
  }
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
      focusSeqRef.current += 1
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

  const explorer = useExplorer({ root: activeWorktreeRow?.path ?? null, active: explorerVisible })
  const scm = useScm({ root: activeWorktreeRow?.path ?? null, active: scmVisible })
  const prComments = usePrComments({ path: activeWorktreeRow?.path ?? null, active: prVisible })

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
  const tabByIdRef = useRef(tabById)
  tabByIdRef.current = tabById

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
  // LIFE-755 r1·r2 — 페이지가 닫힌 채 패널 상세에서 쓰기(연결 포함)가 성공하면 그 연결의 줄만 **기존 값을 남긴 채** 다시 받는다(`reread` — 작업 줄은 이제 페이지를 거치지 않는다).
  // 열린 페이지의 쓰기는 닫힘 갱신이 맡는다.
  const [tasksFocus, setTasksFocus] = useState<TasksFocus | null>(null)
  const [titleRound, setTitleRound] = useState(0)
  const [titleReread, setTitleReread] = useState<LinkTitleReread>(() => new Map())
  useEffect(() => {
    if (!tasksOpen) setTitleRound((value) => value + 1)
  }, [tasksOpen])
  const linkTitles = useLinkTitles({ repos: state?.repos ?? NO_REPOS, refresh: titleRound, reread: titleReread })

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

  /**
   * LIFE-823 C1·C2 — 탐색기 파일 끌어서 열기. 판정·오버레이는 탭 끌기와 같다(`resolveDropTarget` source file) — 커밋만 배치 없는 탭을 들이는 길(`placeFileAt`)이다.
   * 탭바 = 삽입, 가장자리 = 새 영역, 가운데(merge) = 그 영역 활성 탭 오른쪽. 폴더는 `useFileDrag` 가 거른다.
   */
  const fileDrag = useFileDrag({
    onDrop: ({ rel, target }) => {
      switch (target.kind) {
        case 'tabbar':
          placeFileAt({ rel, placement: { kind: 'tabbar', groupId: target.groupId, index: target.index } })
          return
        case 'split':
          placeFileAt({ rel, placement: { kind: 'split', groupId: target.groupId, direction: target.direction, edge: target.edge } })
          return
        case 'merge':
          placeFileAt({ rel, placement: { kind: 'center', groupId: target.groupId } })
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
    // low H2 — CLI·main reveal 은 순번을 안 올리지만 실제로 일어난 이동이다: 미뤄 둔 메뉴 포커스가 닫힘 때 되돌리지 않게 칸을 비운다.
    if (lifecycle.activeWorkspaceId !== owner.workspaceId) { menuDeferredFocusRef.current = null; selectPane(requestedPane); return }
    if (!layout.revealTab(owner.tabId)) return
    menuDeferredFocusRef.current = null
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
   * LIFE-825 C5·P6 — 새 터미널 탭 자리 기억. 요청한 순간(`createRow` — ⌘T·⌘⌥T·탭바 `+`·빈 영역 「새 탭」·사이드바 카드 `+`·팔레트 에이전트) 그 worktree 의
   * 활성 영역·활성 탭을 잡고(`newTabSlotOf`), 탭 id 가 오면 여기 둔다. 아래 「방금 만든 탭을 편다」 effect 가 탭이 도착하면 그 자리로 옮긴다(`newTabPlacement`).
   * 메모리 전용·탭 id 별(연속 ⌘T 가 앞 요청 자리를 덮지 않는다). 요청 없이 도착한 탭은 `reconcileLayout` 이 도착 때 활성 탭 오른쪽에 둔다.
   */
  const pendingNewTabSlotsRef = useRef<Map<string, { workspaceId: string; slot: NewTabSlot; token: number; precedingTokens: readonly number[] }>>(new Map())
  /**
   * fix1 B2 — 요청 순서 장부(토큰 = 요청 순번). `tabId` 는 응답에 채우고, `settled` 는 도착해 자리를 정했으면 참. 새 요청은 같은 자리를 잡은 **아직 안 놓인** 앞
   * 요청의 토큰을 들고 간다 — 도착 때 그 토큰의 탭 뒤로 선다(`newTabPlacement` `precedingTabIds`). 메모리 전용, 요청 수만큼(B7 알려진 한계와 같은 결).
   */
  const newTabRequestsRef = useRef<{ next: number; byToken: Map<number, { workspaceId: string; key: string; tabId: string | null; settled: boolean }> }>({ next: 0, byToken: new Map() })
  lifecycle.newTabRequestRef.current = (workspaceId) => {
    const worktree = stateRef.current?.repos.flatMap((repo) => repo.worktrees).find((row) => row.workspace?.workspaceId === workspaceId) ?? null
    if (worktree === null || worktree.workspace === null) return null
    const shown =
      worktree.path === activeWorktreeRowRef.current?.path
        ? layoutRef.current.layout
        : layout.layoutOf({ worktreePath: worktree.path, liveTabIds: worktree.workspace.tabs.map((tab) => tab.tabId), pinned: pinnedTabs })
    const slot = shown === null ? null : newTabSlotOf(shown)
    if (slot === null) return null
    const requests = newTabRequestsRef.current
    const key = newTabSlotKey(slot)
    const precedingTokens = [...requests.byToken].filter(([, request]) => request.workspaceId === workspaceId && request.key === key && !request.settled).map(([token]) => token)
    const token = requests.next
    requests.next += 1
    requests.byToken.set(token, { workspaceId, key, tabId: null, settled: false })
    return (tabId) => {
      const request = requests.byToken.get(token)
      if (request !== undefined) request.tabId = tabId
      pendingNewTabSlotsRef.current = new Map([...pendingNewTabSlotsRef.current, [tabId, { workspaceId, slot, token, precedingTokens }]])
    }
  }
  /** C5ⓗ 경합 갈래 계수용 — 활성 workspace 에서 지난 렌더까지 본 탭(새로 도착한 탭을 가른다). */
  const seenLiveTabsRef = useRef<{ workspaceId: string | null; tabIds: ReadonlySet<string> }>({ workspaceId: null, tabIds: new Set() })

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
    // LIFE-825 C5 — 기억한 자리로. 영역이 사라졌으면(ⓑ) 도착 때 자리(`reconcileLayout` 고아 착지 — 활성 영역·활성 탭 오른쪽) 그대로.
    // 갈래마다 한 줄 로그(C5ⓗ — G1 이 세어 증상과 짝짓는다).
    const seen = seenLiveTabsRef.current
    const workspaceId = activeWorkspaceRow?.workspaceId ?? null
    // fix1 B5 — ⌘⇧T 다시 열기 탭은 자기 자리(`pendingPlacementsRef`)로 간다 — 이 렌더에 꺼낸 것(`taken.ready`)·아직 기다리는 것 모두 「기억 없음」 갈래가 아니다.
    const reopening = new Set([...taken.ready.map((placement) => placement.tabId), ...pendingPlacementsRef.current.keys()])
    for (const tabId of liveTabIds) {
      const remembered = pendingNewTabSlotsRef.current.get(tabId)
      if (remembered === undefined) {
        const branch = unrememberedArrivalBranch({ firstSeen: seen.workspaceId === workspaceId && !seen.tabIds.has(tabId), reopening: reopening.has(tabId) })
        if (branch === 'reopen') console.info('[corral] LIFE-825 새 탭 자리: 다시 열기 자리(⌘⇧T)', tabId)
        else if (branch === 'unremembered') console.info('[corral] LIFE-825 새 탭 자리: 기억 없음 → 도착 때 자리', tabId)
        continue
      }
      if (remembered.workspaceId !== workspaceId || layout.layout === null) continue
      pendingNewTabSlotsRef.current = new Map([...pendingNewTabSlotsRef.current].filter(([id]) => id !== tabId))
      for (const request of newTabRequestsRef.current.byToken.values()) if (request.tabId === tabId) request.settled = true
      const precedingTabIds = remembered.precedingTokens.flatMap((token) => {
        const request = newTabRequestsRef.current.byToken.get(token)
        return request?.tabId == null ? [] : [request.tabId]
      })
      // fix2 D3 — 같은 자리를 나중에 요청해 이미 응답이 온 탭(그 요청은 이 탭이 안 놓였을 때 생겼다) — 이 탭은 그 앞에 선다.
      const key = newTabSlotKey(remembered.slot)
      const followingTabIds = [...newTabRequestsRef.current.byToken].flatMap(([token, request]) => (token > remembered.token && request.workspaceId === remembered.workspaceId && request.key === key && request.tabId !== null ? [request.tabId] : []))
      const target = newTabPlacement({ layout: layout.layout, slot: remembered.slot, tabId, precedingTabIds, followingTabIds })
      if (target === null) {
        console.info('[corral] LIFE-825 새 탭 자리: 기억 영역 사라짐 → 도착 때 자리', tabId)
        continue
      }
      console.info('[corral] LIFE-825 새 탭 자리: 기억한 자리로 놓음', tabId, target.groupId, target.index)
      layout.placeTab({ tabId, groupId: target.groupId, index: target.index })
      placed.add(tabId)
    }
    seenLiveTabsRef.current = { workspaceId, tabIds: new Set(liveTabIds) }
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
  // LIFE-520 — 앱 기동 때부터 감지 결과를 구독한다(⌘⌥T 가 메뉴·설정을 열기 전에도 결과를 본다).
  const agentDetection = useAgentDetection()
  // fix2 R2-03 — 셸 실패 결과면 팔레트를 열 때 다시 묻는다(팔레트의 「새 X 에이전트」 가 감지를 따른다).
  useRecheckAgentDetectionOnOpen(paletteOpen)
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
  // 탐색기가 안 보이면(패널 닫힘·상세 보기) 아무것도 안 하고, 보이면 그때 활성 파일을 보인다(보임이 의존성 — 보기를 탐색기로 돌릴 때도, LIFE-682 A11). 숨김 경로(`.git`·`node_modules`)는 `reveal` 이 거른다.
  const activeTabIdForReveal = layout.groups.find((group) => group.groupId === layout.activeGroupId)?.activeTabId ?? null
  const activeTabKind = activeTabIdForReveal === null ? null : tabKindOf(activeTabIdForReveal)
  const activeFileRel = activeTabKind?.kind === 'file' ? activeTabKind.rel : null
  const [revealRequest, setRevealRequest] = useState<{ rel: string; token: number } | null>(null)
  const revealFile = explorer.reveal
  useEffect(() => {
    if (!explorerVisible || activeFileRel === null) return
    if (revealFile(activeFileRel)) setRevealRequest((previous) => ({ rel: activeFileRel, token: (previous?.token ?? 0) + 1 }))
  }, [explorerVisible, activeFileRel, revealFile])

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
    /** LIFE-825 — 영역 닫기·최대화·균등화가 보는 화면 배치와 그 조작. */
    layout: layout.layout,
    toggleMaximize: layout.toggleMaximize,
    evenAll: layout.evenAll,
    /** LIFE-824 — 영역 넘는 이동(⌘⌥방향·⌃`·이전/다음 탭)이 보는 배치 전체. */
    groups: layout.groups,
    root: layout.layout?.root ?? null,
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
  /**
   * LIFE-824 C4ⓐ — 파일·diff 탭도 **활성된 순서로** 같은 기록에 찍는다(키 = `editorMruKey`, worktree 경로 + 탭 id). 편집기 탭에서 터미널 탭으로 돌아오면
   * 선택 pane 이 그대로여도 다시 찍는다 — 안 그러면 방금 떠난 파일이 지금 보는 터미널보다 최근으로 남는다.
   */
  const activeEditorKey = activeWorktreeRow !== null && activeTabIdForReveal !== null && isFileTabId(activeTabIdForReveal) ? editorMruKey({ worktreePath: activeWorktreeRow.path, tabId: activeTabIdForReveal }) : null
  useEffect(() => {
    if (lifecycle.selectedPane === null) return
    mruHistoryRef.current = touchMru({ history: mruHistoryRef.current, paneId: lifecycle.selectedPane })
    // fix1 A3 — 편집기 탭이 활성인 채 선택 pane 만 바뀌면(닫기 따라가기·워크스페이스 전환 자동 선택 등) 맨 앞은 지금 보는 편집기 그대로다 — ⌃Tab 이 제자리로 가지 않게.
    if (activeEditorKey !== null) mruHistoryRef.current = touchMru({ history: mruHistoryRef.current, paneId: activeEditorKey })
  }, [lifecycle.selectedPane])
  useEffect(() => {
    const key = activeEditorKey ?? lifecycle.selectedPane
    if (key !== null) mruHistoryRef.current = touchMru({ history: mruHistoryRef.current, paneId: key })
  }, [activeEditorKey])
  /** LIFE-824 C2 — 영역 MRU(worktree 경로별, 메모리 전용 — 영속 0). 영역이 활성될 때마다 맨 앞. ⌃` 후보 고르기가 읽는다(`group-focus.ts`). */
  const groupMruRef = useRef<Map<string, string[]>>(new Map())
  // fix1 A7 — 배치에 없는 영역 id 는 걸러 낸다(닫힌 영역 id 가 재사용되면 새 영역이 옛 순위를 물려받는다). 영역 구성이 바뀔 때도 다시 본다.
  const liveGroupIds = layout.groups.map((group) => group.groupId).join('\0')
  useEffect(() => {
    const path = activeWorktreeRow?.path ?? null
    if (path === null || layout.activeGroupId === null) return
    const pruned = pruneGroupMru({ history: groupMruRef.current.get(path) ?? [], liveGroupIds: liveGroupIds.split('\0') })
    groupMruRef.current.set(path, touchGroupMru({ history: pruned, groupId: layout.activeGroupId }))
  }, [activeWorktreeRow?.path, layout.activeGroupId, liveGroupIds])

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
  /**
   * LIFE-824 C4 — MRU·팔레트가 세는 **편집기 탭**(파일·diff) — 열린 모든 worktree 의 보이는 배치(활성은 지금 배치, 나머지는 저장 배치) 그대로.
   * 키는 `editorMruKey`. 터미널 행(`mruPanes`)과 순서·모양은 따로 둔다 — 터미널 항목·순서 회귀 0.
   */
  const mruEditors = useMemo(() => {
    if (state === null) return []
    const rows: { key: string; worktreePath: string; tabId: string; groupId: string; title: string; kindLabel: string; worktree: string; sameWorktree: boolean }[] = []
    for (const repo of state.repos) {
      for (const worktree of repo.worktrees) {
        const workspace = worktree.workspace
        if (workspace === null) continue
        const sameWorktree = workspace.workspaceId === lifecycle.activeWorkspaceId
        const shown = sameWorktree ? layout.layout : layout.layoutOf({ worktreePath: worktree.path, liveTabIds: workspace.tabs.map((tab) => tab.tabId), pinned: pinnedTabs })
        if (shown === null) continue
        for (const group of listGroups(shown.root)) {
          for (const tabId of group.tabOrder) {
            const kind = tabKindOf(tabId)
            if (kind.kind === 'terminal') continue
            rows.push({
              key: editorMruKey({ worktreePath: worktree.path, tabId }),
              worktreePath: worktree.path,
              tabId,
              groupId: group.groupId,
              title: kind.kind === 'file' ? fileTabLabel(kind.rel) : kind.target === null ? '(diff)' : diffTitle(kind.target),
              kindLabel: kind.kind === 'file' ? '파일' : 'diff',
              worktree: worktreeDisplayName(worktree),
              sameWorktree,
            })
          }
        }
      }
    }
    return rows
  }, [state, lifecycle.activeWorkspaceId, layout.layout, layout.layoutOf, pinnedTabs])
  const mruEditorsRef = useRef(mruEditors)
  mruEditorsRef.current = mruEditors
  /**
   * MRU 가 세는 전부 — 터미널 pane 먼저(옛 순서 그대로), 편집기 탭은 그 뒤. fix1 A6 — 편집기 탭은 **활성된 적 있는**(기록에 있는) 것만 —
   * 안 본 편집기 탭이 꼬리에 붙으면 ⌃⇧Tab·팔레트 「이전」 이 가장 오래된 터미널 대신 그리로 간다(C4ⓔ 터미널 순서 회귀 0).
   */
  const mruLiveIds = (): string[] => [
    ...mruPanesRef.current.map((pane) => pane.paneId),
    ...mruEditorsRef.current.map((editor) => editor.key).filter((key) => mruHistoryRef.current.includes(key)),
  ]
  /** MRU 항목으로 간다 — 편집기 키면 그 탭(다른 worktree 면 전환 뒤), 아니면 pane(옛 길 `revealPane`). */
  const goToMruEntry = (key: string): void => {
    const editor = parseEditorMruKey(key)
    if (editor === null) revealPane(key)
    else focusEditorTabIn(editor)
  }
  const goToMruEntryRef = useRef(goToMruEntry)
  goToMruEntryRef.current = goToMruEntry


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
    if (paneId === undefined || !mruLiveIds().includes(paneId)) {
      setFocusToken((token) => token + 1)
      return
    }
    goToMruEntryRef.current(paneId)
  }, [])

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
    const order = orderMru({ history: mruHistoryRef.current, livePaneIds: mruLiveIds() })
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
    beginFocusMove()
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
  const closeTabsByUser = (input: {
    tabIds: string[]
    anchor?: { groupId: string; tab: TabRow }
    guarded?: boolean
    /** 실제로 닫힌 터미널 id 와 함께(일부만일 수 있다) — 섞인 닫기가 「전부 닫혔나」 를 본다(LIFE-822 fix1 R1-2). */
    onClosed?: (closed: readonly string[]) => void
    /** 이미 확인을 마친 문서 키(섞인 닫기의 파일 — 「저장 안 함」 은 닫을 때 버리므로 아직 수정 상태다) — 아래 worktree 문서 확인에서 다시 묻지 않는다. */
    confirmedDocs?: ReadonlySet<string>
  }): void => {
    if (input.tabIds.length === 0) return
    // LIFE-591 E3ⓔ — 이 닫기로 그 worktree 의 터미널 탭이 하나도 안 남으면 herdr workspace 가 닫히고 파일 탭이 화면에서 사라진다(F2 알려진 한계).
    // 그 worktree 에 수정된 파일이 있으면 먼저 묻는다(저장 / 저장 안 함 / 취소). 묻지 않고 닫히는 경로(셸 `exit` 등)에서는 문서가 저장소에 남아
    // 다시 열면 같은 수정 내용으로 돌아오고, 앱 종료 확인에도 잡힌다.
    const owner = (state?.repos ?? []).flatMap((repo) => repo.worktrees).find((row) => row.workspace?.tabs.some((tab) => input.tabIds.includes(tab.tabId)))
    const closesAll = owner?.workspace?.tabs.every((tab) => input.tabIds.includes(tab.tabId)) === true
    if (owner !== undefined && closesAll && dirtyDocs().some((doc) => doc.root === owner.path && input.confirmedDocs?.has(doc.key) !== true) && !input.guarded) {
      void confirmWorktreeDocs(owner.path, input.confirmedDocs).then((ok) => {
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
        input.onClosed?.(closed)
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
    const worktreePath = activeWorktreeRow?.path ?? null
    // LIFE-822 — 「저장된 탭 닫기」는 수정된 파일 탭을 뺀다(diff 탭은 문서가 없어 늘 저장됨).
    const dirty = new Set(
      group.tabOrder.filter((tabId) => {
        const kind = tabKindOf(tabId)
        return worktreePath !== null && kind.kind === 'file' && getDoc(docKey(worktreePath, kind.rel))?.dirty === true
      }),
    )
    // herdr 에 없는 터미널 id 는 뺀다 — 탭바가 그리는 칸(메뉴 활성 판정)과 같은 집합(fix1 R1-3).
    const { files, terminals } = mixedCloseTargets({ tabOrder: group.tabOrder, tabId: input.tabId, scope: input.scope, pinned: pinnedTabs, dirty, isLiveTerminal: (tabId) => tabById(tabId) !== null })
    const activeBefore = group.activeTabId
    // 순서 (LIFE-822 B7): 수정 파일 확인(한 번에, E3ⓐ — 「저장 안 함」 은 결정만) → 터미널 닫기 요청(실행 중 확인) → **요청한 터미널이 전부 닫힌 뒤** 파일 닫기(그때 버린다).
    // 어느 확인에서 취소해도 파일·문서는 그대로다 — 옛 순서는 파일을 먼저 닫아 터미널 확인 취소 때 파일만 닫힌 채 남았다.
    const anchorTab = activeWorkspaceRow?.tabs.find((tab) => tab.tabId === input.tabId)
    const fileDocKeys = new Set(files.flatMap((tabId) => {
      const kind = tabKindOf(tabId)
      return worktreePath !== null && kind.kind === 'file' ? [docKey(worktreePath, kind.rel)] : []
    }))
    void closeMixedTabs({
      fileTabIds: files,
      terminalTabIds: terminals,
      terminalsBusy: () => pendingCloseRef.current !== null,
      onBusy: () => setGroupHint(CLOSE_CONFIRM_PENDING),
      confirmFiles: (tabIds) => confirmFilesByUser({ worktreePath, tabIds, deferDiscard: true }),
      closeTerminals: ({ tabIds, onClosed }) =>
        closeTabsByUser({ tabIds: [...tabIds], onClosed, confirmedDocs: fileDocKeys, ...(anchorTab === undefined ? {} : { anchor: { groupId: input.groupId, tab: anchorTab } }) }),
      closeFiles: (tabIds) => {
        if (worktreePath === null || tabIds.length === 0) return
        if (isFileTabId(input.tabId) && activeBefore !== null && tabIds.includes(activeBefore)) layout.setActiveTab({ groupId: input.groupId, tabId: input.tabId })
        for (const tabId of tabIds) closeFileNow({ worktreePath, tabId })
      },
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
    void confirmFilesByUser({ worktreePath, tabIds }).then((ok) => {
      if (!ok) return
      for (const tabId of tabIds) closeFileNow({ worktreePath, tabId })
      onClosed?.()
    })
  }
  /**
   * 수정된 파일 탭 확인만(저장 / 저장 안 함 / 취소) — 닫지는 않는다. 섞인 닫기(`closeScope`)가 터미널을 닫은 뒤에 파일을 닫으려고 나눴다(LIFE-822 B7).
   * `deferDiscard` = 「저장 안 함」 을 여기서 버리지 않고 `closeFileNow` 가 닫을 때 버린다(섞인 닫기만 — fix1 R1-1).
   */
  const confirmFilesByUser = (input: { worktreePath: string | null; tabIds: readonly string[]; deferDiscard?: boolean }): Promise<boolean> => {
    const { worktreePath, tabIds } = input
    if (worktreePath === null) return Promise.resolve(false)
    // 대상 문서는 그때그때 찾는다 — 확인·저장을 기다리는 사이 처음엔 문서가 없던 탭(한 번도 안 연 탭)을 열어 편집해도 잡힌다(R2-A).
    const targets = (): FileDoc[] =>
      tabIds.flatMap((tabId) => {
        const kind = tabKindOf(tabId)
        const doc = kind.kind === 'file' ? getDoc(docKey(worktreePath, kind.rel)) : undefined
        return doc === undefined ? [] : [doc]
      })
    return confirmDiscardOrSave({ targets, deps: saveDepsRef.current, deferDiscard: input.deferDiscard === true })
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
    // LIFE-683 — diff 탭은 문서가 없다. 닫기만(닫은 탭 기록 ⌘⇧T 는 파일 탭만 — 기록 형식 무변경).
    if (kind.kind === 'diff') {
      noteFileClose({ worktreePath, tabIds: [tabId] })
      layout.closeFile({ tabId })
      return
    }
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
        // LIFE-683 — 밀려난 것이 diff 탭이면 문서·닫은 탭 기록이 없다.
        if (tabKindOf(replaced.tabId).kind !== 'file') return
        // 교체로 밀려난 미리보기 탭의 문서 — 수정된 미리보기는 고정돼 교체되지 않으므로(E1ⓓ) 여기 오는 것은 수정 없는 문서다.
        const replacedDoc = getDoc(docKey(worktreePath, replaced.rel))
        if (replacedDoc !== undefined && !replacedDoc.dirty) disposeDoc(replacedDoc.key)
        recentlyClosedRef.current = pushClosed({ history: recentlyClosedRef.current, snapshot: { kind: 'file', worktreePath, rel: replaced.rel, preview: true, groupId: replaced.groupId, index: replaced.index } })
      },
    })
  }

  /**
   * LIFE-823 — 파일을 고른 자리에 연다(탐색기 끌어 놓기·옆으로 열기) — 고정 탭(P1). 이미 열린 파일이면 옮기지 않고 그 탭으로 가고(814 게이트 ⓪),
   * 놓은 자리가 지금 자리와 달랐으면 안내 한 줄(P2 — 오버레이가 보여 준 분할 등이 안 난 이유).
   */
  const placeFileAt = (input: { rel: string; placement: FilePlacement }): void => {
    const worktreePath = activeWorktreeRow?.path ?? null
    if (worktreePath === null) return
    const result = layout.placeFile(input)
    if (result.kind === 'already-open' && result.elsewhere)
      showHintAt({ message: alreadyOpenHint(input.rel), context: hintContextKey({ worktreePath, groupId: result.groupId, tabId: fileTabId(input.rel) }) })
  }
  /** 옆으로 열기(LIFE-823 C3·P3) — 탐색기 메뉴·⌥클릭·⌃Enter·⌘P ⌥Enter. */
  const openFileToSide = (rel: string): void => placeFileAt({ rel, placement: { kind: 'side' } })

  /**
   * LIFE-683 S5 — 소스 제어 행 열기. 추적 안 함·충돌·intent-to-add 는 보통 파일 탭(탐색기와 같은 경로), 나머지는 diff 탭(같은 미리보기·고정 규칙 — `openFileTab`).
   * 같은 대상은 같은 탭 id 라 다시 누르면 그 탭이 활성(중복 0). 밀려난 미리보기가 파일 탭이면 탐색기 열기와 같게 문서·닫은 탭 기록을 다룬다.
   */
  const openScmChange = (input: { change: ScmChange; preview: boolean }): void => {
    const opened = openOf(input.change)
    // fix r1 R1-04 — 하위 모듈은 내용 비교가 없다: 폴더 읽기 오류 탭 대신 안내.
    if (opened.kind === 'notice') {
      notify(opened.message)
      return
    }
    if (opened.kind === 'file') {
      openFileFromExplorer({ rel: opened.rel, preview: input.preview })
      return
    }
    const worktreePath = activeWorktreeRow?.path ?? null
    if (worktreePath === null) return
    layout.openFile({
      rel: opened.target.rel,
      preview: input.preview,
      tabId: diffTabId(opened.target),
      onReplaced: (replaced) => {
        if (tabKindOf(replaced.tabId).kind !== 'file') return
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
  const openListedFile = (input: { rel: string; preview: boolean; focus: boolean; side?: boolean }): void => {
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
      if (input.side === true) openFileToSide(target)
      else openFileFromExplorer({ rel: target, preview: input.preview })
      if (input.focus) focusOpenedFile({ worktreePath, rel: target })
    })
  }
  const openFromQuickOpen = (rel: string): void => openListedFile({ rel, preview: false, focus: true })
  const openFromQuickOpenToSide = (rel: string): void => openListedFile({ rel, preview: false, focus: true, side: true })
  /**
   * fix3 C-1 — 본문 포커스 대기 루프의 목적지 감시. 목적지(활성 탭·영역)가 한 번 선 뒤 다른 데로 바뀌면 거짓 — 순번을 안 올리는 이동
   * (`requestedPane`·닫기 따라가기·lifecycle 자동 선택)도 경로마다 막지 않고 여기서 한 번에 막는다. 아직 안 섰으면(배치 반영 전) 참으로 기다린다.
   */
  const destinationHeld = (here: () => boolean): (() => boolean) => {
    let reached = false
    return () => {
      if (here()) {
        reached = true
        return true
      }
      return !reached
    }
  }
  /**
   * 연 파일 탭에 포커스(수정 r1 R1-C-01·R1-C-06) — 편집기가 붙으면 편집기 핸들의 `focus()`(Monaco 0.57 은 EditContext — 입력 요소가 textarea 가 아니다).
   * 편집기가 없는 보기(이미지·바이너리·상한 초과·오류·Markdown 미리보기)면 그 보기 자리(`[data-file-view]`, tabIndex -1)에. 편집기는 비동기로 붙으므로 프레임마다 다시 본다(최대 약 2 s).
   */
  const focusOpenedFile = (input: { worktreePath: string; rel: string }): void => {
    const tabId = fileTabId(input.rel)
    const startedAt = performance.now()
    const seq = beginFocusMove()
    const aimed = destinationHeld(() => activeWorktreeRowRef.current?.path === input.worktreePath && layoutRef.current.activeTabId === tabId)
    const attempt = (): void => {
      // fix1 A8 — 그 사이 다른 포커스 이동이 시작됐으면 그만둔다(늦게 붙은 편집기가 포커스를 가져가지 않게).
      if (focusSeqRef.current !== seq) return
      // fix3 C-1 — 순번을 안 올리는 프로그램 이동(`requestedPane` 등)이 활성 탭을 바꿔도 그만둔다.
      if (!aimed()) return
      if (focusLiveEditor({ store: fileViewStatesOf(input.worktreePath), tabId })) return
      const view = document.querySelector<HTMLElement>(`.file-group[data-file-view="${CSS.escape(input.rel)}"]`)
      const waiting = view === null || view.querySelector('[data-file-editor], [data-file-notice="loading"]') !== null
      if (!waiting) view.focus({ preventScroll: true })
      else if (performance.now() - startedAt < 2_000) requestAnimationFrame(attempt)
      else view?.focus({ preventScroll: true })
    }
    requestAnimationFrame(attempt)
  }

  /**
   * LIFE-824 — **영역 활성 + 본문 포커스** 한 길(C1 ⌘⌥방향·C2 ⌃`·C4 MRU·열린 탭·팔레트·C5 이전/다음 탭·C6 탭 클릭·C7 worktree 복귀). 경로마다 따로 짜면
   * 활성 영역(⌘W 대상)과 포커스 영역이 경로 수만큼 어긋난다(C8). 본문 = 터미널 탭이면 그 탭에서 보던 pane(`selectPane` → focusToken), 파일 탭이면 편집기
   * (`focusOpenedFile` — 커서·스크롤은 편집기가 지킨다), diff 탭이면 diff 보기, 탭 없는 영역이면 빈 영역 상자. 활성 worktree 안에서만 — 다른 worktree 는 `focusEditorTabIn`.
   */
  const focusGroupTab = (target: { groupId: string; tabId: string | null }): void => {
    const worktreePath = activeWorktreeRowRef.current?.path ?? null
    const kind = target.tabId === null ? null : tabKindOf(target.tabId)
    if (target.tabId === null || kind === null) {
      layout.setActiveGroup(target.groupId)
      focusGroupBody({ groupId: target.groupId, selector: `[data-empty-group="${CSS.escape(target.groupId)}"]` })
      return
    }
    switch (kind.kind) {
      case 'terminal': {
        const tab = tabById(target.tabId)
        if (tab === null) return
        beginFocusMove()
        layout.setActiveTab({ groupId: target.groupId, tabId: target.tabId })
        const paneId = tab.panes.find((pane) => pane.paneId === lifecycle.selectedPane)?.paneId ?? pickPane(tab)?.paneId ?? null
        if (paneId !== null) selectPane(paneId)
        return
      }
      case 'file':
        layout.setActiveTab({ groupId: target.groupId, tabId: target.tabId })
        if (worktreePath !== null) focusOpenedFile({ worktreePath, rel: kind.rel })
        return
      case 'diff':
        layout.setActiveTab({ groupId: target.groupId, tabId: target.tabId })
        focusGroupBody({ groupId: target.groupId, selector: `[data-diff-group="${CSS.escape(target.groupId)}"]` })
        return
    }
  }
  /** 편집기가 아닌 본문(diff 보기·빈 영역)에 포커스 — 다음 렌더에 그려지므로 프레임마다 다시 본다(최대 약 1 s, `focusOpenedFile` 과 같은 결). */
  const focusGroupBody = (input: { groupId: string; selector: string }): void => {
    const startedAt = performance.now()
    const seq = beginFocusMove()
    const aimed = destinationHeld(() => layoutRef.current.activeGroupId === input.groupId)
    const attempt = (): void => {
      if (focusSeqRef.current !== seq) return
      if (!aimed()) return
      const body = document.querySelector<HTMLElement>(`[data-tab-group="${CSS.escape(input.groupId)}"] ${input.selector}`)
      if (body !== null) body.focus({ preventScroll: true })
      else if (performance.now() - startedAt < 1_000) requestAnimationFrame(attempt)
    }
    requestAnimationFrame(attempt)
  }
  /**
   * 편집기 탭(파일·diff)으로 — 어느 worktree 든(C4 MRU·팔레트·C7 복귀). 활성 worktree 면 바로 `focusGroupTab`, 아니면 그 worktree 를 활성으로 하고
   * 배치가 그 worktree 로 바뀐 렌더에서 편다(`pendingFocusRef` — `pendingRevealRef` 와 같은 이유: 같은 틱의 배치는 아직 옛 worktree 의 것).
   */
  /**
   * fix1 A1 — 미뤄 둔 편집기 포커스의 **수명**: 순번(`seq` — 그 뒤 다른 이동이 시작되면 무효) · 떠난 자리(`fromPath` — 활성 worktree 가 그 둘 아닌 곳으로 가면 무효)
   * · 기한(`deadline` — 전환이 끝내 안 일어나면 무효). 셋 중 하나라도 어긋나면 지운다 — 나중에 그 worktree 로 들어갈 때 옛 편집기가 포커스를 가져가지 않게.
   */
  const pendingFocusRef = useRef<{ worktreePath: string; tabId: string; fromPath: string | null; seq: number; deadline: number } | null>(null)
  const focusEditorTabIn = (target: { worktreePath: string; tabId: string }): void => {
    pendingFocusRef.current = null
    if ((activeWorktreeRowRef.current?.path ?? null) === target.worktreePath) {
      const owner = layout.layout === null ? null : groupOfTab(layout.layout.root, target.tabId)
      if (owner !== null) focusGroupTab({ groupId: owner.groupId, tabId: target.tabId })
      return
    }
    const workspace = stateRef.current?.repos.flatMap((repo) => repo.worktrees).find((row) => row.path === target.worktreePath)?.workspace ?? null
    if (workspace === null) return
    pendingFocusRef.current = { ...target, fromPath: activeWorktreeRowRef.current?.path ?? null, seq: beginFocusMove(), deadline: performance.now() + PENDING_FOCUS_MS }
    lifecycle.actions.activateWorkspace(workspace.workspaceId)
  }
  const focusGroupTabRef = useRef(focusGroupTab)
  focusGroupTabRef.current = focusGroupTab
  /**
   * LIFE-825 C1·C7 — 영역 닫기 한 길(⌘⌥W·팔레트·헤더 ✕·빈 영역 단추). 받는 영역 = 영역 MRU → 공간 이웃(`closeGroupHeir`). 닫는 영역이 활성이었으면
   * 받는 영역의 활성 탭으로 본문 포커스까지(`focusGroupTab`) — 닫힌 영역 DOM 의 포커스가 사라져 활성 영역 ≠ 포커스 영역이 되지 않게(00-analysis L1′).
   */
  const closeGroupAndFocus = (groupId: string): void => {
    const current = layoutRef.current.layout
    if (current === null) return
    const path = activeWorktreeRowRef.current?.path ?? null
    const recent = path === null ? [] : (groupMruRef.current.get(path) ?? [])
    const next = closeGroupIn(current, groupId, { recent })
    if (next === current) return
    layoutRef.current.closeGroup(groupId, { recent })
    if (current.activeGroupId !== groupId) return
    const heir = findGroup(next.root, next.activeGroupId)
    if (heir !== null) focusGroupTab({ groupId: heir.groupId, tabId: heir.activeTabId })
  }
  /** LIFE-825 C4·C7 — 영역 최대화 토글(⌘⌥Enter·팔레트·⊞ 메뉴·헤더 해제 단추). 그 영역이 활성 + 본문 포커스. 영역이 하나면 안내 한 줄(C4ⓖ). */
  const toggleMaximizeAndFocus = (groupId: string): void => {
    const current = layoutRef.current.layout
    if (current === null) return
    const group = findGroup(current.root, groupId)
    if (group === null) return
    if (listGroups(current.root).length < 2) {
      setGroupHint(ONE_GROUP)
      return
    }
    layoutRef.current.toggleMaximize(groupId)
    focusGroupTab({ groupId, tabId: group.activeTabId })
  }
  /** LIFE-825 C3·C7 — 영역 크기 균등화(팔레트·⊞ 메뉴, 키 없음). 최대화도 풀린다. 활성 영역 본문 포커스. 영역이 하나면 안내 한 줄. */
  const evenGroupsAndFocus = (): void => {
    const current = layoutRef.current.layout
    if (current === null) return
    if (listGroups(current.root).length < 2) {
      setGroupHint(ONE_GROUP)
      return
    }
    layoutRef.current.evenAll()
    const active = findGroup(current.root, current.activeGroupId)
    if (active !== null) focusGroupTab({ groupId: active.groupId, tabId: active.activeTabId })
  }
  useEffect(() => {
    const pending = pendingFocusRef.current
    if (pending === null) return
    const verdict = pendingFocusVerdict({ pending, seq: focusSeqRef.current, now: performance.now(), path: activeWorktreeRow?.path ?? null, layoutReady: layout.layout !== null })
    if (verdict === 'wait') return
    pendingFocusRef.current = null
    if (verdict === 'drop' || layout.layout === null) return
    const owner = groupOfTab(layout.layout.root, pending.tabId)
    if (owner !== null) focusGroupTabRef.current({ groupId: owner.groupId, tabId: pending.tabId })
  }, [layout.layout, activeWorktreeRow?.path])
  /**
   * LIFE-824 C7·P4 — worktree 카드(활성·비활성 재클릭 포함)·작업 페이지 줄: 그 worktree 배치가 보던 활성 영역·활성 탭으로 돌아간다(파일 탭이어도 덮지 않는다).
   * 배치가 없거나 활성 탭이 없으면 거짓 — `activateWorktreeCard` 가 옛 규칙(첫 탭)으로 간다. 사이드바 세션(pane) 클릭은 이 길이 아니다(그 pane 으로 — base).
   */
  const returnToWorktree = (worktree: WorktreeRow): boolean => {
    const workspace = worktree.workspace
    if (workspace === null) return false
    const liveTabIds = workspace.tabs.map((tab) => tab.tabId)
    const shown = worktree.path === activeWorktreeRowRef.current?.path ? layout.layout : layout.layoutOf({ worktreePath: worktree.path, liveTabIds, pinned: pinnedTabs })
    const target = worktreeReturnTarget({ layout: shown, liveTabIds })
    if (target === null) return false
    if (isFileTabId(target.tabId)) {
      focusEditorTabIn({ worktreePath: worktree.path, tabId: target.tabId })
      return true
    }
    const tab = workspace.tabs.find((row) => row.tabId === target.tabId)
    const pane = tab === undefined ? null : (tab.panes.find((row) => row.paneId === lifecycle.selectedPane) ?? pickPane(tab))
    if (pane === null) return false
    revealPane(pane.paneId)
    return true
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
      beginFocusMove()
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
      focusSeqRef.current += 1
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
  // LIFE-822 G1-1 — 안내는 띄운 맥락(worktree·활성 영역·그 영역의 활성 탭)에 묶인다 — 맥락이 바뀌면 지운다.
  // `paneError`·라이프사이클 알림은 여기서 안 지운다(수명 불변).
  const hintContext = hintContextKey({ worktreePath: activeWorktreeRow?.path ?? null, groupId: layoutMirror.activeGroupId, tabId: layoutMirror.activeTabId })
  const hintContextRef = useRef(hintContext)
  /** LIFE-823 P2 — 맥락을 바꾸며 띄우는 안내(이미 열린 탭으로 감)는 바뀐 뒤 맥락에 싣는다. */
  const carriedHintRef = useRef<CarriedHint | null>(null)
  useEffect(() => {
    if (hintContextRef.current === hintContext) return
    hintContextRef.current = hintContext
    setGroupHint(hintAfterContextChange({ carry: carriedHintRef.current, context: hintContext }))
    carriedHintRef.current = null
  }, [hintContext])
  /** 맥락(`context`)에 안내를 띄운다 — 지금 맥락이면 바로, 아니면 그 맥락으로 바뀔 때. */
  const showHintAt = (input: CarriedHint): void => {
    if (input.context === hintContextRef.current) {
      carriedHintRef.current = null
      setGroupHint(input.message)
      return
    }
    carriedHintRef.current = input
  }
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
  /**
   * LIFE-824 P6 — 줌 판정에 쓰는 영역별 상태: 그 영역 활성 탭의 pane 전부(herdr 탭 행 — 줌 중 스트림은 줌한 pane 하나만 싣는다) + 줌 중인 pane.
   * 렌더에 갇히지 않게 거울(`layoutRef`·`stateRef`)에서 읽는다.
   */
  const zoomGroupsNow = useCallback(
    () =>
      layoutRef.current.groups.map((group) => ({
        groupId: group.groupId,
        panes: tabByIdRef.current(group.activeTabId)?.panes ?? [],
        zoomedPaneId: stateRef.current?.terminalGroups.find((row) => row.groupId === group.groupId)?.zoomedPaneId ?? null,
      })),
    [],
  )
  const splitPaneAt = useCallback(
    async (target: { paneId: string | null; direction: PaneSplitDirection }): Promise<void> => {
      if (target.paneId === null) return
      // LIFE-824 Zⓐ — 줌 중에 쪼개면 새 pane 이 가려진 채 선택된다 — 줌을 먼저 푼다(tmux 와 같은 규칙).
      const zoomed = zoomedGroupOf({ groups: zoomGroupsNow(), paneId: target.paneId })
      if (zoomed !== null) toggleZoom({ groupId: zoomed, paneId: null })
      const result = await window.corral.splitPane({ paneId: target.paneId, direction: target.direction })
      setPaneError(result.ok ? null : result.error)
      // **분할 직후 새 pane 으로 선택을 옮긴다** (F2-7 — 게이트 ① 사용자 지적 1).
      // 서버 포커스는 계속 `focus: false` 다: 옮기는 것은 **렌더러의 선택**이고, herdr 세션 전역
      // 포커스는 안 끌고 간다 (F2-4 `pane.neighbor` 와 같은 논거). 새 pane 이 store 에 도착한
      // 뒤에 선택해야 자동 선택 이펙트가 그것을 덮지 않는다 — `selectPaneWhenReady` 가 그 자리다.
      if (result.ok && result.paneId !== null) lifecycle.selectPaneWhenReady(result.paneId)
    },
    [lifecycle.selectPaneWhenReady, zoomGroupsNow, toggleZoom],
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
  /**
   * LIFE-824 C1·P1 — 같은 탭에 그 방향 이웃 pane 이 있으면 그 pane(위 그대로), 없으면(경계·파일·diff·빈 영역) 그 방향 **이웃 영역**으로(`neighborGroupId` —
   * 배치 사각형). 그 방향에 영역도 없으면 무동작(base 와 같다). 대상 pane 은 활성 영역 활성 탭의 선택 pane 이다 — 창 전체 선택 pane 이 다른 영역에 있으면 쓰지 않는다.
   */
  /**
   * fix1 A2 — ⌘⌥방향 연타·응답 전 다른 조작. 호출을 **한 줄로 세우고**(앞 호출이 고른 결과가 그려진 뒤 다음 호출이 그 상태를 읽는다), 상태는 렌더에 갇히지 않게
   * 거울(`layoutRef`·`selectedPaneRef`·`activeWorktreeRowRef`)에서 읽는다. `pane.neighbor` 응답을 기다리는 사이 활성 영역·worktree·선택 pane 이 바뀌었으면
   * (사용자가 다른 곳을 눌렀다) 늦은 응답은 버린다 — 뒤 조작을 덮지 않는다.
   */
  const selectedPaneRef = useRef(lifecycle.selectedPane)
  selectedPaneRef.current = lifecycle.selectedPane
  const commitWaitersRef = useRef<(() => void)[]>([])
  useEffect(() => {
    for (const resolve of commitWaitersRef.current.splice(0)) resolve()
  })
  /** 다음 커밋(렌더 반영)까지 — 바뀐 것이 없어 커밋이 안 오면 짧은 상한 뒤 넘어간다. */
  const nextCommit = (): Promise<void> =>
    new Promise((resolve) => {
      commitWaitersRef.current.push(resolve)
      setTimeout(resolve, DIRECTION_SETTLE_MS)
    })
  const directionChainRef = useRef<Promise<void>>(Promise.resolve())
  /**
   * fix3 C-3 — 줄의 세대. 키를 누를 때 지금 순번을 잡고, 줄 안의 회차가 스스로 옮기면(방향 이동) 그 순번으로 고친다. 대기하던 회차는 시작할 때
   * 순번이 그 값이 아니면(그 사이 클릭·탭 선택 등 다른 포커스 이동) 버린다 — 클릭한 상태에서 옛 키가 실행되지 않게.
   */
  const directionSeqRef = useRef(0)
  const focusDirectionOnce = async (direction: PaneDirection): Promise<void> => {
    if (focusSeqRef.current !== directionSeqRef.current) return
    // fix2 B1 — 세대에 포커스 이동 순번을 넣는다: 같은 영역 탭 클릭·⌃1–9 처럼 셋(worktree·활성 영역·선택 pane)을 안 바꾸는 사용자 이동도 늦은 응답을 버리게.
    const snapshot = (): string => [activeWorktreeRowRef.current?.path ?? '', layoutRef.current.activeGroupId ?? '', selectedPaneRef.current ?? '', focusSeqRef.current].join('\0')
    const before = snapshot()
    const { activeTabId } = layoutRef.current
    const tab = activeTabId === null || isFileTabId(activeTabId) ? null : tabByIdRef.current(activeTabId)
    const paneId = tab === null ? null : (tab.panes.find((pane) => pane.paneId === selectedPaneRef.current)?.paneId ?? pickPane(tab)?.paneId ?? null)
    if (paneId !== null) {
      const result = await window.corral.focusPaneDirection({ paneId, direction })
      if (snapshot() !== before) return
      if (!result.ok) {
        setPaneError(result.error)
        return
      }
      setPaneError(null)
      if (result.paneId !== null) {
        // LIFE-824 Zⓑ — 줌에 가려진 pane 을 고르면 줌을 풀고 간다.
        const zoomed = zoomHiding({ groups: zoomGroupsNow(), paneId: result.paneId })
        if (zoomed !== null) toggleZoom({ groupId: zoomed, paneId: null })
        menuDeferredFocusRef.current = null
        directionSeqRef.current = beginFocusMove()
        selectPane(result.paneId)
        await nextCommit()
        return
      }
    }
    const { activeGroupId, root, groups } = layoutRef.current
    if (activeGroupId === null || root === null) return
    const neighbor = neighborGroupId({ root, groupId: activeGroupId, direction })
    const group = neighbor === null ? undefined : groups.find((row) => row.groupId === neighbor)
    if (group === undefined) return
    menuDeferredFocusRef.current = null
    focusGroupTabRef.current({ groupId: group.groupId, tabId: group.activeTabId })
    directionSeqRef.current = focusSeqRef.current
    await nextCommit()
  }
  const focusDirectionOnceRef = useRef(focusDirectionOnce)
  focusDirectionOnceRef.current = focusDirectionOnce
  /**
   * fix2 B4 — 줄에는 「진행 중 하나 + 대기 하나」 까지만 — 키를 누르고 있으면(반복) 무응답 herdr 앞에 호출이 쌓여 손을 뗀 뒤에도 수 초 움직인다.
   * 한 회차가 던져도(IPC 거절) 줄은 풀린다 — 경고를 남기고 다음 키는 그대로 동작한다.
   */
  const directionQueuedRef = useRef(0)
  const focusDirection = (direction: PaneDirection): void => {
    if (directionQueuedRef.current >= DIRECTION_QUEUE_MAX) return
    directionQueuedRef.current += 1
    directionSeqRef.current = focusSeqRef.current
    directionChainRef.current = directionChainRef.current
      .then(() => focusDirectionOnceRef.current(direction))
      .catch((error: unknown) => console.warn('[corral] 인접 pane / 영역 포커스 실패', error))
      .finally(() => {
        directionQueuedRef.current -= 1
        // fix4 F1 — 요청 중에 닫힌 메뉴의 몫. 줄이 비었는데 칸이 남아 있으면(이동 없이 끝남) 그때 돈다.
        const deferred = menuDeferredFocusRef.current
        if (directionQueuedRef.current === 0 && deferred !== null && deferred.closed) settleMenuDeferredFocus(deferred)
      })
  }
  /**
   * 미뤄 둔 메뉴 포커스를 끝낸다 — 칸을 비우고, 그 뒤 순번이 안 올랐으면 그 영역 본문에. fix4 F1 — 방향 요청이 진행 중이면 메뉴가 닫혀도 여기 오지 않고
   * 칸에 「닫힘」 만 적는다: 지금 포커스하면 순번이 올라 그 요청의 응답이 늦은 응답으로 버려지기 때문이다(E2). 응답이 이동하면 칸이 비고, 이동 없이 끝나면 위 `finally` 가 부른다.
   */
  const settleMenuDeferredFocus = (deferred: { seq: number; groupId: string }): void => {
    menuDeferredFocusRef.current = null
    // fix2 D1 — 메뉴가 열린 동안 다른 이동(탭바·본문 클릭·⌃` 등 순번을 올리는 모든 이동)이 있었으면 버린다(824 순번 규칙).
    if (deferred.seq !== focusSeqRef.current) return
    const group = layoutRef.current.groups.find((row) => row.groupId === deferred.groupId)
    if (group === undefined) return
    focusGroupTabRef.current({ groupId: group.groupId, tabId: group.activeTabId })
  }
  const closePaneAt = useCallback(async (paneId: string | null): Promise<void> => {
    if (paneId === null) return
    const result = await window.corral.closePane({ paneId })
    setPaneError(result.ok ? null : result.error)
  }, [])


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
    setTasksOpen(true)
  }
  // 닫으면 덮개가 걷힌 다음 프레임에 활성 pane 이 포커스를 되찾는다(설정 닫기와 같다).
  const closeTasks = (): void => {
    setTasksOpen(false)
    requestAnimationFrame(() => setFocusToken((value) => value + 1))
  }
  /** 링크된 worktree 카드의 작업 줄 — 누르면 오른쪽 패널에 그 작업 상세(본문은 그대로 — 작업 페이지를 열지도 닫지도 않는다, LIFE-755). 연결이 없거나 못 찾으면 키만. */
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
        setTasksFocus((current) => ({ seq: (current?.seq ?? 0) + 1, connectionId: link.connectionId, itemId: link.itemId ?? item?.id ?? null, key: link.key }))
      },
    }
  }
  const toggleTasks = (): void => {
    if (tasksOpen) closeTasks()
    else openTasks()
  }
  const handlers: ShortcutHandlers = {
    'palette.open': openPalette,
    'quickOpen.open': openQuickOpen,
    // 트리 포커스에서만 온다(범위 'explorer') — 탐색기 머리 입력칸을 연다.
    // 팔레트에서 고르면 패널이 닫혀 있을 수 있다 — 열고 연다.
    'explorer.filter': () => {
      rightPanel.show('explorer')
      setExplorerFilterToken((value) => value + 1)
    },
    'terminal.new': () => lifecycle.createShell(),
    'mru.open': (variant) => stepMruHold(variant === 1),
    'terminal.split': (variant) => {
      // LIFE-822 B1 — 파일 탭이 활성이면 무음 대신 안내 한 줄(동작은 붙이지 않는다). 편집기 안 ⌘D 는 여기 안 온다(EDITOR_YIELD_ACTIONS).
      const route = splitKeyRoute({ activeTabId: layoutRef.current.activeTabId, selectedPane: lifecycle.selectedPane })
      if (route.kind === 'file-tab') {
        const key = bindingsFor('group.split', keymap.overrides)[0]
        setGroupHint(fileTabSplitHint({ groupSplitKey: key == null ? null : formatBinding(key), tabCount: layoutRef.current.activeTabCount }))
        return
      }
      if (route.kind === 'split') void splitPaneAt({ paneId: route.paneId, direction: variant === 1 ? 'down' : 'right' })
    },
    'group.split': (variant) => {
      const { activeGroupId: groupId, activeTabId: tabId, activeTabCount } = layoutRef.current
      if (groupId === null || tabId === null) return
      if (activeTabCount < 2) { setGroupHint(ONE_TAB_IN_GROUP); return }
      setGroupHint(null)
      layoutRef.current.splitGroup({ groupId, tabId, direction: variant === 1 ? 'column' : 'row' })
    },
    'terminal.focus': (variant) => {
      const direction = PANE_DIRECTIONS[variant]
      if (direction !== undefined) focusDirection(direction)
    },
    'group.close': () => {
      const groupId = layoutRef.current.activeGroupId
      if (groupId !== null) closeGroupAndFocus(groupId)
    },
    'group.maximize': () => {
      const groupId = layoutRef.current.activeGroupId
      if (groupId !== null) toggleMaximizeAndFocus(groupId)
    },
    'group.even': () => evenGroupsAndFocus(),
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
    // LIFE-824 C5·P5 — 영역 끝이면 다음(이전) 영역으로 넘는다(VS Code nextEditor). herdr 에 아직 없는 터미널 id 는 탭바처럼 뺀다. 고른 탭은 본문 포커스.
    'tab.cycle': (variant) => {
      const { groups, activeGroupId, activeTabId } = layoutRef.current
      const shown = groups.map((group) => ({ groupId: group.groupId, tabOrder: group.tabOrder.filter((tabId) => isFileTabId(tabId) || tabById(tabId) !== null) }))
      const picked = cycleAcrossGroups({ groups: shown, activeGroupId, activeTabId, direction: variant === 1 ? -1 : 1 })
      if (picked !== null) focusGroupTab(picked)
    },
    // LIFE-824 C2·P2 — 터미널 ↔ 편집기(파일·diff) 영역. 후보가 없으면 안내 한 줄(무음 실패 0).
    'focus.toggleTerminalEditor': () => {
      const { groups, activeGroupId } = layoutRef.current
      const path = activeWorktreeRowRef.current?.path ?? null
      const target = terminalEditorToggleTarget({ groups, activeGroupId, recent: path === null ? [] : (groupMruRef.current.get(path) ?? []) })
      if (target.kind === 'none') {
        setGroupHint(toggleNoneHint(target.want))
        return
      }
      const group = groups.find((row) => row.groupId === target.groupId)
      if (group !== undefined) focusGroupTab({ groupId: group.groupId, tabId: group.activeTabId })
    },
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
      rightPanel.show('explorer')
      requestAnimationFrame(() => setExplorerFocusToken((value) => value + 1))
    },
    // LIFE-683 — VS Code `workbench.view.scm` 과 같은 뜻: 닫혀 있으면 열고 소스 제어 보기로, 목록에 포커스.
    'scm.show': () => {
      rightPanel.show('scm')
      requestAnimationFrame(() => setScmFocusToken((value) => value + 1))
    },
    // LIFE-515 — 기본 Agent 로 새 탭. ⌘T 와 같은 대상 workspace·같은 생성 경로(createRow), 에이전트 갈래는 Quick-launch 와 같은 launchAgent(워치독).
    'terminal.newAgent': () => {
      const target = resolveNewAgentTab({ defaultAgent: settings.defaultAgent, detection: agentDetection })
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
  const keymap = useKeybindings(activeHandlers, modalBlocked || paletteOpen || quickOpenOpen || tasksModalOpen, () => {
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
      if (kind.kind === 'diff')
        return [{ kind: 'file', tabId, rel: kind.target?.rel ?? tabId, preview: groupPreview === tabId, deleted: false, dirty: false, diffLabel: kind.target === null ? '(diff)' : diffTitle(kind.target) }]
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
    const canCloseGroup = layout.groups.length > 1 ? () => closeGroupAndFocus(group.groupId) : null
    const groupLayoutMenu = {
      maximized: layout.maximizedGroupId === group.groupId,
      disabledTitle: layout.groups.length > 1 ? null : ONE_GROUP,
      maximizeShortcut: groupMaximizeShortcut,
      onToggleMaximize: () => toggleMaximizeAndFocus(group.groupId),
      onEven: () => evenGroupsAndFocus(),
    }
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
      <div className={`tab-group ${isActiveGroup ? 'is-active-group' : ''}${layout.maximizedGroupId === group.groupId ? ' is-maximized' : ''}`} data-tab-group={group.groupId} key={group.groupId}>
        <GroupHeader
          groupId={group.groupId}
          headSpacer={sidebarCollapsed && settingsView === null && headSpacerGroupId === group.groupId}
          tailToggle={
            rightPanel.ready && !rightPanel.open && tailToggleGroupId === group.groupId ? (
              <RightPanelToggle label="오른쪽 패널 열기" shortcut={rightPanelToggleShortcut} onToggle={rightPanel.toggle} placement="tabbar" />
            ) : null
          }
          tabs={groupTabs}
          items={groupItems}
          onSelectFileTab={(tabId) => {
            if (tabDrag.consumeClick()) return
            // LIFE-824 C6 — 탭 클릭도 본문 포커스(편집기 커서·스크롤은 편집기가 지킨다).
            focusGroupTab({ groupId: group.groupId, tabId })
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
          onActivateOnly={() => {
            activateGroup({ groupId: group.groupId, paneId: null })
            menuTokenSeqRef.current += 1
            menuDeferredFocusRef.current = { token: menuTokenSeqRef.current, seq: focusSeqRef.current, groupId: group.groupId, closed: false }
            return menuTokenSeqRef.current
          }}
          onActivateFocus={({ token, byItem }) => {
            const deferred = menuDeferredFocusRef.current
            // fix3 E1 — 다른 우클릭의 칸이면 건드리지 않는다(겹친 메뉴에서 앞 메뉴의 닫힘이 뒤 우클릭의 몫을 지우거나 쓰지 않게).
            if (deferred === null || deferred.token !== token) return
            // low H1 — 항목 실행으로 닫히면 요청 중이어도 미루지 않는다(요청 없음과 같은 순서: 본문 포커스 → 항목이 자기 포커스·영역을 정한다).
            if (directionQueuedRef.current > 0 && !byItem) {
              menuDeferredFocusRef.current = { ...deferred, closed: true }
              return
            }
            settleMenuDeferredFocus(deferred)
          }}
          maximized={layout.maximizedGroupId === group.groupId}
          groupLayout={groupLayoutMenu}
          onTabDragStart={(event, tabId) => tabDrag.onArm(event, { tabId, fromGroupId: group.groupId })}
          // LIFE-823 F4 — 탐색기 파일 끌기도 탭바 넘침 끌기 모드(chevron 호버 스크롤·활성 탭 스크롤 억제)를 켠다.
          tabDragActive={tabDrag.dragState !== null || fileDrag.dragState !== null}
          onSelectTab={(tab) => {
            // LIFE-387 A1 — 문턱을 넘긴 드래그 뒤에 따라오는 click 하나는 활성화로 치지 않는다.
            if (tabDrag.consumeClick()) return
            beginFocusMove()
            layout.setActiveTab({ groupId: group.groupId, tabId: tab.tabId })
            const pane = pickPane(tab)
            if (pane !== null) selectPane(pane.paneId)
          }}
          onCreateShell={() => lifecycle.actions.createRow(workspaceId, 'shell')}
          openTabEntries={openTabEntries}
          onLaunchAgent={(kind) => lifecycle.actions.launchAgent({ workspaceId, kind, label: AGENT_LAUNCH_LABEL[kind] })}
          onOpenAgentSettings={() => openSettings('agents')}
          onActivateOpenTab={({ tabId, groupId }) => {
            // LIFE-824 C4ⓑ — 파일·diff 탭은 그 영역 활성 + 본문 포커스.
            if (isFileTabId(tabId)) {
              focusGroupTab({ groupId, tabId })
              return
            }
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
              return { groupId: other.groupId, label: kind?.kind === 'file' ? fileTabLabel(kind.rel) : kind?.kind === 'diff' ? (kind.target === null ? '(diff)' : diffTitle(kind.target)) : (tabById(other.activeTabId)?.label ?? '비어 있음') }
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
        {activeFile !== null && activeFile.kind === 'diff' && activeWorktreeRow !== null ? (
          <DiffView
            key={activeFile.tabId}
            root={activeWorktreeRow.path}
            target={activeFile.target}
            stamp={scm.stampOf(activeWorktreeRow.path)}
            // fix r1 R1-01 — 영역에 보이는 diff 탭은 그 루트 감시를 잡는다(작업 페이지·설정이 덮으면 안 보임 → 해제).
            watch={!tasksOpen && settingsView === null}
            onOpenFile={(rel) => openFileFromExplorer({ rel, preview: false })}
            groupId={group.groupId}
            // LIFE-824 C8 — diff 본문을 눌러도 그 영역이 활성(base 누락).
            onActivate={() => activateGroup({ groupId: group.groupId, paneId: null })}
          />
        ) : activeFile !== null && activeFile.kind === 'file' && activeWorktreeRow !== null ? (
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
            // LIFE-824 C8 — 빈 영역 본문을 눌러도 그 영역이 활성(base 누락).
            onActivate={() => activateGroup({ groupId: group.groupId, paneId: null })}
            onCreateShell={() => lifecycle.actions.createRow(workspaceId, 'shell')}
            onCloseGroup={canCloseGroup}
            // LIFE-387 B1 F-B1-6 — 빈 영역이 드래그의 유효 병합 타깃일 때만 켠다(§2 EmptyGroup).
            isDropTarget={[tabDrag.dragState, fileDrag.dragState].some((drag) => drag !== null && drag.target.kind === 'merge' && drag.target.groupId === group.groupId)}
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
                    focusable={isActiveGroup && !paletteOpen && !quickOpenOpen && !modalBlocked && !tasksModalOpen && !tasksOpen}
                    focusToken={isActiveGroup && !paletteOpen && !quickOpenOpen && !modalBlocked && !tasksModalOpen && !tasksOpen ? focusToken : 0}
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
                focusable={isActiveGroup && !paletteOpen && !quickOpenOpen && !modalBlocked && !tasksModalOpen && !tasksOpen}
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
      // LIFE-824 C4ⓐ — 편집기 탭(파일·diff) 행. 상태 점·경과는 없다(에이전트가 아니다 — 지어낸 값 대신 부재).
      const editor = entry === undefined ? mruEditors.find((row) => row.key === paneId) : undefined
      if (editor !== undefined) {
        mruRows.push({
          paneId,
          title: editor.title,
          groupGlyph: editor.sameWorktree ? (glyphs.get(editor.groupId) ?? '') : '⇄',
          otherWorktree: !editor.sameWorktree,
          status: null,
          paneDesc: editor.kindLabel,
          worktree: editor.worktree,
          elapsed: null,
        })
        continue
      }
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
  // LIFE-824 C1ⓕ — `terminal.focus` 는 파일·diff·빈 영역에서도 영역을 옮기므로 여기서 빠진다(diff 탭에서 켜진 채 무동작이던 무음 실패도 같이 사라진다).
  const TERMINAL_PANE_ACTIONS = new Set<string>(['terminal.split', 'terminal.zoom'])
  /** pane 없이도 도는 영역 이동(⌘⌥방향 — 이웃 영역·⌃`) — 선택 pane 이 없어도 켠다. */
  const GROUP_FOCUS_ACTIONS = new Set<string>(['terminal.focus', 'focus.toggleTerminalEditor'])
  /** LIFE-825 — 영역 배치 조작(최대화·균등화)은 pane 없이 돈다. 영역이 하나면 흐림 + 이유(C3·C4ⓖ). */
  const GROUP_LAYOUT_ACTIONS = new Set<string>(['group.maximize', 'group.even'])
  const palettePaneAlive = !!activeWorkspace?.tabs.some(tab => tab.panes.some(pane => pane.paneId === lifecycle.selectedPane))
  for (const action of ACTIONS) {
    // ⌘⇧⌫ 는 hover 중인 카드가 대상이라 팔레트에서 부를 대상이 없다.
    if (action.id === 'palette.open' || action.id === 'palette.search' || action.id === 'workspace.delete') continue
    for (let variant = 0; variant < action.variants.length; variant++) {
      const id = action.id
      paletteEntries.push({ id: `${id}:${variant}`, title: `${action.title} · ${action.variants[variant]}`, detail: id,
        shortcut: bindingsFor(id, keymap.overrides).flatMap((binding, index) => (binding !== null && action.bindingVariants[index] === variant ? [formatBinding(binding)] : [])).join(' / '),
        disabled: id === 'sidebar.toggle' || id === 'settings.open' || id === 'quickOpen.open' || id === 'explorer.filter' ? undefined : !connected ? '연결된 세션이 없습니다' : GROUP_LAYOUT_ACTIONS.has(id) ? (layout.groups.length < 2 ? ONE_GROUP : undefined) : GROUP_FOCUS_ACTIONS.has(id) ? undefined : !palettePaneAlive ? '선택된 pane이 없습니다' : activeTabIdForReveal !== null && isFileTabId(activeTabIdForReveal) && TERMINAL_PANE_ACTIONS.has(id) ? '파일·diff 탭에서는 쓸 수 없습니다' : id === 'group.split' && (layout.groups.find(group => group.groupId === layout.activeGroupId)?.tabOrder.length ?? 0) < 2 ? ONE_TAB_IN_GROUP : undefined,
        run: () => {
          if (id === 'mru.open') {
            const other = orderMru({ history: mruHistoryRef.current, livePaneIds: mruLiveIds() }).filter(id => id !== (activeEditorKey ?? lifecycle.selectedPane))
            const paneId = variant === 1 ? other.at(-1) : other[0]
            if (paneId) goToMruEntry(paneId)
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
  // LIFE-520 fix2 R2-01 — 감지된 에이전트만(감지 전·실패면 3종 그대로 = base).
  for (const kind of DETECTABLE_AGENTS.filter((agent) => isAgentAvailable({ agent, detection: agentDetection }))) paletteEntries.push({ id: `agent.start.${kind}`, title: `새 ${kind} 에이전트`, detail: activeWorktree?.path ?? 'worktree 선택 필요', disabled: !connected ? '연결된 세션이 없습니다' : !activeWorkspace ? '열린 worktree를 선택하세요' : undefined, run: () => { if (activeWorkspace) lifecycle.actions.createRow(activeWorkspace.workspaceId, kind) } })
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
  // LIFE-824 C4ⓒ — 파일·diff 탭 전환 항목(터미널 `pane.switch` 와 나란히, 열린 모든 worktree). 탭 id 체계는 그대로 — 항목 id 만 worktree 경로를 싣는다.
  for (const editor of mruEditors) {
    paletteEntries.push({ id: `editor.switch:${editor.key}`, title: editor.title, detail: `${editor.worktreePath} · ${editor.tabId} · ${editor.kindLabel}`, keywords: 'file diff editor tab switch 파일 탭 전환', run: () => {
      if (!mruEditorsRef.current.some((row) => row.key === editor.key)) { notify('대상 탭이 사라졌습니다'); return }
      focusEditorTabIn({ worktreePath: editor.worktreePath, tabId: editor.tabId })
    } })
  }

  // 사이드바 토글의 단축키 표시 — 비운 칸(null, fix2 R2-01)이면 툴팁에 단축키를 싣지 않는다.
  const sidebarToggleShortcut = ((binding) => (binding == null ? null : formatBinding(binding)))(bindingsFor('sidebar.toggle', keymap.overrides)[0])
  const rightPanelToggleShortcut = ((binding) => (binding == null ? null : formatBinding(binding)))(bindingsFor('rightPanel.toggle', keymap.overrides)[0])
  const groupMaximizeBinding = bindingsFor('group.maximize', keymap.overrides)[0]
  /** LIFE-825 — 영역 최대화 키 표시(⊞ 메뉴·헤더 해제 단추). 키를 끄면 빈 문자열. */
  const groupMaximizeShortcut = groupMaximizeBinding == null ? '' : formatBinding(groupMaximizeBinding)
  /**
   * LIFE-825 fix1 B1 — 접힌 사이드바 머리 여백·「오른쪽 패널 열기」 단추가 서는 영역. 평소는 맨 왼쪽 위(첫 영역)·맨 오른쪽 위 영역이고,
   * 최대화 중이면 화면에 보이는 영역이 그것 하나뿐이라 최대화 영역이다(숨은 영역에 남으면 탭 줄이 머리 밑으로 들어가고 단추가 사라진다).
   */
  const headSpacerGroupId = layout.maximizedGroupId ?? layout.groups[0]?.groupId ?? null
  const tailToggleGroupId = layout.maximizedGroupId ?? (layout.layout === null ? null : topRightGroupId(layout.layout.root))

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
          returnToWorktree={returnToWorktree}
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
              <BackendCard status={state.backend} onStart={() => void window.corral.startBackend()} onRetry={() => void window.corral.retryBackend()} />
            ) : activeWorkspace === null || layout.layout === null ? (
              <div className="term-empty" data-term-empty />
            ) : (
              <PaneGrid
                root={layout.layout.root}
                onCommitRatio={layout.setRatio}
                onResetRun={layout.evenRunAt}
                maximizedGroupId={layout.maximizedGroupId}
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
                goToMruEntry(paneId)
              }}
            />
          )}
          </div>
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
              if (worktree !== undefined) activateWorktreeCard({ actions: lifecycle.actions, repoRoot: tree.repoRoot, worktree, selectPane: revealPane, returnTo: returnToWorktree })
            }}
            unreadPanes={unread.panes}
            onRevealPane={(paneId) => {
              // 「터미널에서 답하기」 — 페이지를 닫고 그 pane 으로(사이드바 세션 클릭과 같은 길).
              closeTasks()
              revealPane(paneId)
            }}
            focus={tasksFocus}
            detailPanel={{ slot: detailSlot, shown: rightPanel.open && rightPanel.view === 'detail', show: () => rightPanel.show('detail'), hide: rightPanel.hide, openPage: openTasks }}
            onModalChange={setTasksModalOpen}
            onItemWritten={(connectionId) => { if (!tasksOpen) setTitleReread((current) => new Map(current).set(connectionId, (current.get(connectionId) ?? 0) + 1)) }}
            headTail={rightPanel.ready && !rightPanel.open ? <RightPanelToggle label="오른쪽 패널 열기" shortcut={rightPanelToggleShortcut} onToggle={rightPanel.toggle} placement="tasks" /> : null}
          />
        </div>
        <RightPanel
          open={rightPanel.open}
          view={rightPanel.view}
          shortcutOf={(view) => {
            const action = RIGHT_PANEL_VIEWS.find((entry) => entry.id === view)?.action ?? null
            const binding = action === null ? undefined : bindingsFor(action, keymap.overrides)[0]
            return binding == null ? null : formatBinding(binding)
          }}
          onSelectView={rightPanel.select}
          panelRef={rightPanelRef}
          toggleShortcut={rightPanelToggleShortcut}
          onToggle={rightPanel.toggle}
          onResizeStart={rightPanel.onHandleMouseDown}
          bodies={{
            explorer: <Explorer explorer={explorer} title={activeWorktree === undefined ? null : worktreeDisplayName(activeWorktree)} focusToken={explorerFocusToken} filterToken={explorerFilterToken} visible={explorerVisible} revealRequest={revealRequest} onOpenFile={openFileFromExplorer} onOpenListed={(input) => openListedFile({ ...input, focus: false })} onOpenToSide={openFileToSide} onFileDrag={fileDrag.onExplorerDrag} ops={fileOps} notify={notify} />,
            scm: <ScmView scm={scm} title={activeWorktree === undefined ? null : worktreeDisplayName(activeWorktree)} mode={scm.mode} onChangeMode={scm.setMode} focusToken={scmFocusToken} onOpen={openScmChange} />,
            pr: <PrCommentsView api={prComments} title={activeWorktree === undefined ? null : worktreeDisplayName(activeWorktree)} />,
            detail: <div ref={setDetailSlot} className="right-panel-detail" data-right-panel-detail="" />,
          }}
        />
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
          onOpenToSide={openFromQuickOpenToSide}
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
          tabLabel={dragGhostLabel({ tabId: tabDrag.dragState.tabId, terminalLabel: tabById(tabDrag.dragState.tabId)?.label ?? null })}
          tabColor={((tab) => (tab === null ? null : (markOf({ marks: tabMarks, tabId: tab.tabId, workspaceId: tab.workspaceId })?.color ?? null)))(tabById(tabDrag.dragState.tabId))}
        />
      )}
      {/* LIFE-823 — 탐색기 파일을 트리 밖으로 끄는 중: 같은 오버레이, 고스트 = 파일·폴더 이름. */}
      {fileDrag.dragState === null ? null : <DropZoneOverlay state={fileDrag.dragState} tabLabel={fileTabLabel(fileDrag.dragState.rel)} />}
    </div>
    </BindingLabels.Provider>
  )
}
