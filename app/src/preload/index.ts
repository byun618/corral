// preload — contextBridge 로 **채널별 메서드만** 노출한다. ipcRenderer 를 통째로 넘기지 않는다.
//
// sandbox:true 에서는 이 파일이 **단일 CJS 번들**이어야 로드된다 (ESM preload 는 조용히 실패) —
// electron.vite.config.ts 의 preload output.format='cjs' 가 그 보장이다.
//
// 여기 오가는 타입은 전부 `shared/types.ts` 다. 어댑터는 이름조차 모른다 (기준 N2).

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { FILE_DROP_MAX_PATHS } from '../shared/terminal-paste.js'
import type {
  AddRepoResult,
  AgentKind,
  AppState,
  ClipboardImageSaveResult,
  BrowseReposResult,
  CloseRowResult,
  CorralApi,
  CreateRowResult,
  PaneActionResult,
  PaneNeighborResult,
  PaneSplitResult,
  PaneDirection,
  PaneSplitDirection,
  RemoveRepoResult,
  TerminalGroupRequest,
  TerminalFileDrop,
  TerminalFrame,
  TerminalScroll,
  RenameRowResult,
  CorralShortcut,
  CloseTabsResult,
  UiPrefs,
  WorktreeActionResult,
} from '../shared/types.js'
import type { Settings, SettingsWriteResult } from '../shared/terminal-settings.js'
import type { GhosttyImportPreview } from '../shared/ghostty-import.js'
import type { WindowChrome } from '../shared/window-chrome.js'
import type { MobilePairingResult, MobileStatus } from '../shared/mobile.js'
import type { ExplorerActionInput, ExplorerActionResult, ExplorerListResult, ExplorerPush } from '../shared/explorer.js'
import type { ExplorerDrop, ExplorerDropRegistration, ExplorerOpInput, ExplorerOpResult } from '../shared/explorer-ops.js'
import type { DirtyFile, FileDialogChoice, FileDialogRequest, FileReadResult, FileWatchPush, FileWriteInput, FileWriteResult, ImageReadResult } from '../shared/file-view.js'

const EXPOSED = [
  'getMobileStatus',
  'onMobileStatus',
  'createMobilePairing',
  'revokeMobileDevice',
  'recheckMobile',
  'getState',
  'refreshTree',
  'onState',
  'addRepo',
  'removeRepo',
  'browseForRepos',
  'refreshSessions',
  'startBackend',
  'getUiPrefs',
  'getKeybindings',
  'saveKeybindings',
  'setShortcutRecording',
  'setUiPrefs',
  'getSettingsSync',
  'setSettings',
  'onSettings',
  'previewGhosttyImport',
  'createRow',
  'closeRow',
  'closeTabs',
  'renameRow',
  'closeWorktree',
  'openWorktree',
  'createWorktree',
  'setWorktreeMeta',
  'previewWorktreeDelete',
  'deleteWorktree',
  'revealInFinder',
  'openInEditor',
  'copyPath',
  'explorerList',
  'explorerWatch',
  'explorerRefreshGit',
  'explorerAction',
  'onExplorerEvent',
  'readFile',
  'fileWatch',
  'readImage',
  'onFileEvent',
  'writeFile',
  'fileDialog',
  'setDirtyFiles',
  'onQuitRequested',
  'confirmQuit',
  'quitCancelled',
  'quitAck',
  'activateWindow',
  'reportRendered',
  'selectPane',
  'onRevealPane',
  'syncTermGroups',
  'termInput',
  'saveClipboardImage',
  'onFileDrop',
  'termScroll',
  'termZoom',
  'repaintPane',
  'splitPane',
  'resizePane',
  'closePane',
  'focusPaneDirection',
  'onTermFrame',
  'onShortcut',
  'getWindowChrome',
  'onWindowChrome',
  'syncWindowZoom',
  'preloadEnv',
]

/**
 * OS 파일 드롭 (LIFE-497 · D43). **preload 에서만** 경로를 얻을 수 있다 — `webUtils.getPathForFile` 은
 * 렌더러(격리 월드)에 없고, sandbox preload 가 쓸 수 있는 모듈이다. 그래서 document 캡처 단계에서 받는다.
 *
 * - `dragover` 에 파일이 실려 있으면 `preventDefault` — 안 하면 `drop` 이 안 온다.
 * - `drop` 은 **파일이면 어디서든** `preventDefault` 한다. Chromium 기본 동작은 파일을 창에 여는 것이라
 *   pane 밖(사이드바·탭바)에 떨어뜨려도 창이 파일로 이탈하면 안 된다 (K3ⓒ). 탭 DnD 는 포인터 이벤트라 여기 안 걸린다.
 * - 대상은 **드롭 지점의 pane** 상자(`data-term-pane-box`)다 — 포커스 pane 이 아니다. pane 밖이면 버린다.
 * - LIFE-592 — 탐색기 트리(`data-explorer-root` 안 `data-explorer-drop-dir`)도 대상이다. 그때는 경로를 렌더러에 주지 않고 main 에 맡겨 표지로 넘긴다.
 *   트리 안 끌어 옮기기는 포인터 이벤트(탭 끌기와 같은 방식)라 여기 걸리지 않는다(파일이 실린 드래그만 여기 온다).
 */
const fileDropListeners = new Set<(drop: TerminalFileDrop) => void>()
const explorerDropListeners = new Set<(drop: ExplorerDrop) => void>()
const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') === true
const dropPaneOf = (event: DragEvent): string | null => {
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement && entry.dataset.termPaneBox !== undefined) return entry.dataset.termPaneBox
  }
  return null
}
/**
 * LIFE-592 E7 — 탐색기 대상. 드롭 지점에서 가장 가까운 `data-explorer-drop-dir`(폴더 행 = 그 폴더, 파일 행 = 그 부모, 빈 영역 = 루트 '')과
 * 그 트리의 `data-explorer-root`. 루트·폴더 값은 렌더러 DOM 이 정하지만 main 이 다시 가둔다 — 여기서 정하는 것은 **원본 경로**뿐이다.
 */
const dropExplorerOf = (event: DragEvent): { root: string; dir: string } | null => {
  let dir: string | null = null
  for (const entry of event.composedPath()) {
    if (!(entry instanceof HTMLElement)) continue
    if (dir === null && entry.dataset.explorerDropDir !== undefined) dir = entry.dataset.explorerDropDir
    if (dir !== null && entry.dataset.explorerRoot !== undefined) return entry.dataset.explorerRoot === '' ? null : { root: entry.dataset.explorerRoot, dir }
  }
  return null
}
const emitFileDrop = (drop: TerminalFileDrop): void => {
  for (const listener of [...fileDropListeners]) listener(drop)
}
const emitExplorerDrop = (drop: ExplorerDrop): void => {
  for (const listener of [...explorerDropListeners]) listener(drop)
}
document.addEventListener(
  'dragover',
  (event) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = dropPaneOf(event) === null && dropExplorerOf(event) === null ? 'none' : 'copy'
  },
  true,
)
document.addEventListener(
  'drop',
  (event) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    const files = event.dataTransfer?.files
    const explorer = dropExplorerOf(event)
    // 탐색기 가져오기(LIFE-592 E7) — 실제 드롭(isTrusted)의 경로만 main 에 직접 맡긴다. 렌더러는 표지만 받는다(원본 경로를 만들 수 없다 — E7ⓓ).
    if (explorer !== null) {
      if (!event.isTrusted || files === undefined || files.length === 0) return
      if (files.length > FILE_DROP_MAX_PATHS) {
        emitExplorerDrop({ token: null, ...explorer, error: `한 번에 ${FILE_DROP_MAX_PATHS}개까지 가져올 수 있습니다(${files.length}개)` })
        return
      }
      const paths = [...files].map((file) => webUtils.getPathForFile(file)).filter((one) => one.length > 0)
      if (paths.length === 0) {
        emitExplorerDrop({ token: null, ...explorer, error: '경로를 읽을 수 없는 항목입니다(약속 파일·가상 파일)' })
        return
      }
      void ipcRenderer.invoke('corral:explorerDropPaths', paths).then((registered: ExplorerDropRegistration) => {
        emitExplorerDrop(registered.ok ? { token: registered.token, ...explorer, names: registered.names } : { token: null, ...explorer, error: registered.error })
      })
      return
    }
    const paneId = dropPaneOf(event)
    if (paneId === null || files === undefined || files.length === 0) return
    if (files.length > FILE_DROP_MAX_PATHS) {
      emitFileDrop({ status: 'rejected', paneId, reason: 'too-many-paths', count: files.length })
      return
    }
    const paths = [...files].map((file) => webUtils.getPathForFile(file)).filter((one) => one.length > 0)
    if (paths.length === 0) {
      // 경로를 못 읽는 항목(약속 파일·가상 파일) — 조용히 버리지 않고 알린다 (Orca #15782).
      emitFileDrop({ status: 'rejected', paneId, reason: 'unresolved-paths', count: files.length })
      return
    }
    emitFileDrop({ status: 'dropped', paneId, paths })
  },
  true,
)

const api: CorralApi = {
  getKeybindings: () => ipcRenderer.invoke('corral:getKeybindings'),
  saveKeybindings: (overrides) => ipcRenderer.invoke('corral:saveKeybindings', overrides),
  setShortcutRecording: (active) => ipcRenderer.invoke('corral:setShortcutRecording', active),
  getState: () => ipcRenderer.invoke('corral:getState'),
  refreshTree: () => ipcRenderer.invoke('corral:refreshTree'),
  onState: (listener: (state: AppState) => void) => {
    const handler = (_event: unknown, state: AppState): void => listener(state)
    ipcRenderer.on('corral:state', handler)
    return () => {
      ipcRenderer.removeListener('corral:state', handler)
    }
  },
  addRepo: (root: string): Promise<AddRepoResult> => ipcRenderer.invoke('corral:addRepo', root),
  removeRepo: (root: string): Promise<RemoveRepoResult> => ipcRenderer.invoke('corral:removeRepo', root),
  browseForRepos: (): Promise<BrowseReposResult> => ipcRenderer.invoke('corral:browseForRepos'),
  refreshSessions: () => ipcRenderer.invoke('corral:refreshSessions'),
  startBackend: () => ipcRenderer.invoke('corral:startBackend'),
  getUiPrefs: (): Promise<UiPrefs> => ipcRenderer.invoke('corral:getUiPrefs'),
  explorerList: (input: { root: string; rel: string }): Promise<ExplorerListResult> => ipcRenderer.invoke('corral:explorerList', input),
  explorerWatch: (input: { root: string; on: boolean }) => ipcRenderer.invoke('corral:explorerWatch', input),
  explorerRefreshGit: (root: string) => ipcRenderer.send('corral:explorerRefreshGit', root),
  explorerAction: (input: ExplorerActionInput): Promise<ExplorerActionResult> => ipcRenderer.invoke('corral:explorerAction', input),
  explorerOp: (input: ExplorerOpInput): Promise<ExplorerOpResult> => ipcRenderer.invoke('corral:explorerOp', input),
  explorerFocus: (focused: boolean) => ipcRenderer.send('corral:explorerFocus', focused),
  onExplorerDrop: (listener: (drop: ExplorerDrop) => void) => {
    explorerDropListeners.add(listener)
    return () => {
      explorerDropListeners.delete(listener)
    }
  },
  onExplorerEvent: (listener: (event: ExplorerPush) => void) => {
    const handler = (_event: unknown, push: ExplorerPush): void => listener(push)
    ipcRenderer.on('corral:explorerEvent', handler)
    return () => {
      ipcRenderer.removeListener('corral:explorerEvent', handler)
    }
  },
  readFile: (input: { root: string; rel: string }): Promise<FileReadResult> => ipcRenderer.invoke('corral:fileRead', input),
  readImage: (input: { root: string; rel: string }): Promise<ImageReadResult> => ipcRenderer.invoke('corral:fileReadImage', input),
  fileWatch: (input: { root: string; rels: string[] }): Promise<{ ok: boolean; count: number }> => ipcRenderer.invoke('corral:fileWatch', input),
  onFileEvent: (listener: (event: FileWatchPush) => void) => {
    const handler = (_event: unknown, push: FileWatchPush): void => listener(push)
    ipcRenderer.on('corral:fileEvent', handler)
    return () => {
      ipcRenderer.removeListener('corral:fileEvent', handler)
    }
  },
  // LIFE-591 F3 — 저장·확인 대화상자·수정 목록·종료 확인. 쓰기 가둠·상한·문구는 전부 main.
  writeFile: (input: FileWriteInput): Promise<FileWriteResult> => ipcRenderer.invoke('corral:fileWrite', input),
  fileDialog: (request: FileDialogRequest): Promise<FileDialogChoice> => ipcRenderer.invoke('corral:fileDialog', request),
  setDirtyFiles: (files: DirtyFile[]) => ipcRenderer.send('corral:dirtyFiles', files),
  onQuitRequested: (listener: (gen: number) => void) => {
    const handler = (_event: unknown, gen: unknown): void => listener(typeof gen === 'number' ? gen : -1)
    ipcRenderer.on('corral:quitRequested', handler)
    return () => {
      ipcRenderer.removeListener('corral:quitRequested', handler)
    }
  },
  /** 승인 — main 이 받았는지(무효가 된 요청 세대면 false, LIFE-591 수정 r5 R5-B). */
  confirmQuit: (gen: number): Promise<boolean> => ipcRenderer.invoke('corral:confirmQuit', gen),
  /** 종료 확인이 취소로 끝났다(LIFE-591 수정 r4 R4-A ⓒ) — main 이 이미 런타임 정리를 시작했었는지 돌려준다. */
  quitCancelled: (gen: number): Promise<{ runtimeClosed: boolean }> => ipcRenderer.invoke('corral:quitCancelled', gen),
  /** 종료 확인 요청을 받았다(LIFE-591 수정 r1 R1-I — main 의 무응답 판정 시계를 멈춘다). */
  quitAck: (gen: number) => ipcRenderer.send('corral:quitAck', gen),
  setUiPrefs: (patch: Partial<UiPrefs>) => ipcRenderer.send('corral:setUiPrefs', patch),
  // 사용자 설정 (LIFE-512) — 동기 읽기는 부팅 때 한 번(시작 2단 resize 방지, main 주석). 쓰기는 검증된 전체 값을 돌려준다.
  getSettingsSync: (): Settings => ipcRenderer.sendSync('corral:getSettingsSync'),
  setSettings: (patch: Partial<Settings>): Promise<SettingsWriteResult | null> => ipcRenderer.invoke('corral:setSettings', patch),
  onSettings: (listener: (settings: Settings) => void) => {
    const handler = (_event: unknown, settings: Settings): void => listener(settings)
    ipcRenderer.on('corral:settings', handler)
    return () => {
      ipcRenderer.removeListener('corral:settings', handler)
    }
  },
  // Ghostty 가져오기 미리보기 (LIFE-513) — 인자 없음(읽을 경로는 main 이 정한다). 아무것도 쓰지 않는다.
  previewGhosttyImport: (): Promise<GhosttyImportPreview | null> => ipcRenderer.invoke('corral:previewGhosttyImport'),
  createRow: (input: { workspaceId: string; kind: AgentKind; cwd?: string; label?: string }): Promise<CreateRowResult> =>
    ipcRenderer.invoke('corral:createRow', input),
  closeTabs: (input: { tabIds: string[]; confirmed?: boolean; alwaysConfirm?: boolean; confirmedPaneIds?: string[] }): Promise<CloseTabsResult> =>
    ipcRenderer.invoke('corral:closeTabs', input),
  closeRow: (input: { tabId: string; confirmed?: boolean }): Promise<CloseRowResult> =>
    ipcRenderer.invoke('corral:closeRow', input),
  renameRow: (input: { tabId: string; label: string }): Promise<RenameRowResult> =>
    ipcRenderer.invoke('corral:renameRow', input),
  closeWorktree: (input: { workspaceId: string; confirmed?: boolean }): Promise<CloseRowResult> =>
    ipcRenderer.invoke('corral:closeWorktree', input),
  openWorktree: (input: { repoRoot: string; path: string; isLinked: boolean }): Promise<WorktreeActionResult> =>
    ipcRenderer.invoke('corral:openWorktree', input),
  createWorktree: (input: { repoRoot: string; branch: string; path: string }): Promise<WorktreeActionResult> =>
    ipcRenderer.invoke('corral:createWorktree', input),
  setWorktreeMeta: (input) => ipcRenderer.invoke('corral:setWorktreeMeta', input),
  previewWorktreeDelete: (input) => ipcRenderer.invoke('corral:previewWorktreeDelete', input),
  deleteWorktree: (input) => ipcRenderer.invoke('corral:deleteWorktree', input),
  revealInFinder: (input) => ipcRenderer.invoke('corral:revealInFinder', input),
  openInEditor: (input) => ipcRenderer.invoke('corral:openInEditor', input),
  copyPath: (input) => ipcRenderer.invoke('corral:copyPath', input),
  activateWindow: () => ipcRenderer.send('corral:activateWindow'),
  reportRendered: (revision: number) => ipcRenderer.send('corral:reportRendered', revision),
  selectPane: (input: { paneId: string | null; cols?: number; rows?: number }) =>
    ipcRenderer.invoke('corral:selectPane', input),
  // 입력·리사이즈·스크롤은 send — 왕복 없는 한 방향이 레이턴시(S2)의 모양이다.
  syncTermGroups: (groups: TerminalGroupRequest[]) => ipcRenderer.send('corral:syncTermGroups', groups),
  termInput: (input: { paneId: string; data: string }) => ipcRenderer.send('corral:termInput', input),
  saveClipboardImage: (): Promise<ClipboardImageSaveResult> => ipcRenderer.invoke('corral:saveClipboardImage'),
  onFileDrop: (listener: (drop: TerminalFileDrop) => void) => {
    fileDropListeners.add(listener)
    return () => {
      fileDropListeners.delete(listener)
    }
  },
  termScroll: (input: { paneId: string } & TerminalScroll) => ipcRenderer.send('corral:termScroll', input),
  termZoom: (input: { groupId: string; paneId: string | null; cols: number; rows: number }) =>
    ipcRenderer.send('corral:termZoom', input),
  repaintPane: (input: { paneId: string }): Promise<void> => ipcRenderer.invoke('corral:repaintPane', input),
  splitPane: (input: { paneId: string; direction: PaneSplitDirection; ratio?: number }): Promise<PaneSplitResult> =>
    ipcRenderer.invoke('corral:splitPane', input),
  resizePane: (input: { paneId: string; direction: PaneDirection; amount: number }): Promise<PaneActionResult> =>
    ipcRenderer.invoke('corral:resizePane', input),
  closePane: (input: { paneId: string }): Promise<PaneActionResult> => ipcRenderer.invoke('corral:closePane', input),
  focusPaneDirection: (input: { paneId: string; direction: PaneDirection }): Promise<PaneNeighborResult> =>
    ipcRenderer.invoke('corral:focusPaneDirection', input),
  onTerminalFocus: (listener: (request: { id: string; paneId: string; deadlineAt: number }) => void) => {
    const handler = (_event: unknown, request: { id: string; paneId: string; deadlineAt: number }): void => listener(request)
    ipcRenderer.on('corral:terminalFocus', handler)
    return () => { ipcRenderer.removeListener('corral:terminalFocus', handler) }
  },
  terminalFocused: (id: string, paneId: string) => ipcRenderer.send('corral:terminalFocused', { id, paneId }),
  onRevealPane: (listener: (paneId: string) => void) => {
    const handler = (_event: unknown, paneId: string): void => listener(paneId)
    ipcRenderer.on('corral:revealPane', handler)
    return () => { ipcRenderer.removeListener('corral:revealPane', handler) }
  },
  onTermFrame: (listener: (frame: TerminalFrame) => void) => {
    const handler = (_event: unknown, frame: TerminalFrame): void => listener(frame)
    ipcRenderer.on('corral:termFrame', handler)
    return () => {
      ipcRenderer.removeListener('corral:termFrame', handler)
    }
  },
  onShortcut: (listener: (shortcut: CorralShortcut) => void) => {
    const handler = (_event: unknown, shortcut: CorralShortcut): void => listener(shortcut)
    ipcRenderer.on('corral:shortcut', handler)
    return () => {
      ipcRenderer.removeListener('corral:shortcut', handler)
    }
  },
  // LIFE-527 — 창 크롬(전체화면·줌). 줌 값은 main 이 자기 webContents 에서 읽는다 — 렌더러는 「바뀌었을지 모른다」만 알린다.
  getWindowChrome: (): Promise<WindowChrome | null> => ipcRenderer.invoke('corral:getWindowChrome'),
  onWindowChrome: (listener: (chrome: WindowChrome) => void) => {
    const handler = (_event: unknown, chrome: WindowChrome): void => listener(chrome)
    ipcRenderer.on('corral:windowChrome', handler)
    return () => {
      ipcRenderer.removeListener('corral:windowChrome', handler)
    }
  },
  syncWindowZoom: () => ipcRenderer.send('corral:syncWindowZoom'),
  // 설정 › Mobile (LIFE-577). push 는 상태만(토큰·코드 없음) — 코드는 createMobilePairing 응답에만.
  getMobileStatus: (): Promise<MobileStatus | null> => ipcRenderer.invoke('corral:getMobileStatus'),
  onMobileStatus: (listener: (status: MobileStatus) => void) => {
    const handler = (_event: unknown, status: MobileStatus): void => listener(status)
    ipcRenderer.on('corral:mobile', handler)
    return () => {
      ipcRenderer.removeListener('corral:mobile', handler)
    }
  },
  createMobilePairing: (): Promise<MobilePairingResult> => ipcRenderer.invoke('corral:createMobilePairing'),
  revokeMobileDevice: (input: { id: string }): Promise<{ ok: boolean }> => ipcRenderer.invoke('corral:revokeMobileDevice', input),
  recheckMobile: (): Promise<MobileStatus | null> => ipcRenderer.invoke('corral:recheckMobile'),
  // preload 자기 컨텍스트에서 관측한 값을 그대로 화면·로그에 싣는다 (보안 자세의 근거).
  preloadEnv: {
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
    exposedMethods: EXPOSED,
  },
}

contextBridge.exposeInMainWorld('corral', api)
