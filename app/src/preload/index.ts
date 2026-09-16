// preload — contextBridge 로 **채널별 메서드만** 노출한다. ipcRenderer 를 통째로 넘기지 않는다.
//
// sandbox:true 에서는 이 파일이 **단일 CJS 번들**이어야 로드된다 (ESM preload 는 조용히 실패) —
// electron.vite.config.ts 의 preload output.format='cjs' 가 그 보장이다.
//
// 여기 오가는 타입은 전부 `shared/types.ts` 다. 어댑터는 이름조차 모른다 (기준 N2).

import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddRepoResult,
  AgentKind,
  AppState,
  BrowseReposResult,
  CloseRowResult,
  CorralApi,
  CreateRowResult,
  PaneActionResult,
  PaneNeighborResult,
  PaneDirection,
  PaneSplitDirection,
  RemoveRepoResult,
  TerminalGroupRequest,
  TerminalFrame,
  TerminalScroll,
  RenameRowResult,
  UiPrefs,
  WorktreeActionResult,
} from '../shared/types.js'

const EXPOSED = [
  'getState',
  'onState',
  'addRepo',
  'removeRepo',
  'browseForRepos',
  'refreshSessions',
  'getUiPrefs',
  'setUiPrefs',
  'createRow',
  'closeRow',
  'renameRow',
  'closeWorktree',
  'openWorktree',
  'createWorktree',
  'reportRendered',
  'selectPane',
  'syncTermGroups',
  'termInput',
  'termScroll',
  'termZoom',
  'repaintPane',
  'splitPane',
  'resizePane',
  'closePane',
  'focusPaneDirection',
  'onTermFrame',
  'preloadEnv',
]

const api: CorralApi = {
  getState: () => ipcRenderer.invoke('corral:getState'),
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
  getUiPrefs: (): Promise<UiPrefs> => ipcRenderer.invoke('corral:getUiPrefs'),
  setUiPrefs: (patch: Partial<UiPrefs>) => ipcRenderer.send('corral:setUiPrefs', patch),
  createRow: (input: { workspaceId: string; kind: AgentKind }): Promise<CreateRowResult> =>
    ipcRenderer.invoke('corral:createRow', input),
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
  reportRendered: (revision: number) => ipcRenderer.send('corral:reportRendered', revision),
  selectPane: (input: { paneId: string | null; cols?: number; rows?: number }) =>
    ipcRenderer.invoke('corral:selectPane', input),
  // 입력·리사이즈·스크롤은 send — 왕복 없는 한 방향이 레이턴시(S2)의 모양이다.
  syncTermGroups: (groups: TerminalGroupRequest[]) => ipcRenderer.send('corral:syncTermGroups', groups),
  termInput: (input: { paneId: string; data: string }) => ipcRenderer.send('corral:termInput', input),
  termScroll: (input: { paneId: string } & TerminalScroll) => ipcRenderer.send('corral:termScroll', input),
  termZoom: (input: { groupId: string; paneId: string | null; cols: number; rows: number }) =>
    ipcRenderer.send('corral:termZoom', input),
  repaintPane: (input: { paneId: string }): Promise<void> => ipcRenderer.invoke('corral:repaintPane', input),
  splitPane: (input: { paneId: string; direction: PaneSplitDirection; ratio?: number }): Promise<PaneActionResult> =>
    ipcRenderer.invoke('corral:splitPane', input),
  resizePane: (input: { paneId: string; direction: PaneDirection; amount: number }): Promise<PaneActionResult> =>
    ipcRenderer.invoke('corral:resizePane', input),
  closePane: (input: { paneId: string }): Promise<PaneActionResult> => ipcRenderer.invoke('corral:closePane', input),
  focusPaneDirection: (input: { paneId: string; direction: PaneDirection }): Promise<PaneNeighborResult> =>
    ipcRenderer.invoke('corral:focusPaneDirection', input),
  onTermFrame: (listener: (frame: TerminalFrame) => void) => {
    const handler = (_event: unknown, frame: TerminalFrame): void => listener(frame)
    ipcRenderer.on('corral:termFrame', handler)
    return () => {
      ipcRenderer.removeListener('corral:termFrame', handler)
    }
  },
  // preload 자기 컨텍스트에서 관측한 값을 그대로 화면·로그에 싣는다 (보안 자세의 근거).
  preloadEnv: {
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
    exposedMethods: EXPOSED,
  },
}

contextBridge.exposeInMainWorld('corral', api)
