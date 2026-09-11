// preload — contextBridge 로 **채널별 메서드만** 노출한다. ipcRenderer 를 통째로 넘기지 않는다.
//
// sandbox:true 에서는 이 파일이 CJS 로 번들되어야 로드된다 (ESM preload 는 조용히 실패).
// electron.vite.config.ts 의 preload output.format = 'cjs' 가 그 보장이다.

import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, CloseOutcome, TerminalFrame } from '../shared/types.js'

const EXPOSED = [
  'getState',
  'onState',
  'selectSession',
  'selectPane',
  'toggleCollapse',
  'refreshSessions',
  'reportRendered',
  'reportProbe',
  'preloadEnv',
  'onTerminalFrame',
  'sendPaneText',
  'sendPaneKeys',
  'createRow',
  'closeRow',
  'dismissLaunch',
]

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('corral:getState'),
  onState: (listener: (state: AppState) => void): (() => void) => {
    const handler = (_event: unknown, state: AppState): void => listener(state)
    ipcRenderer.on('corral:state', handler)
    return () => ipcRenderer.removeListener('corral:state', handler)
  },
  selectSession: (name: string): Promise<void> => ipcRenderer.invoke('corral:selectSession', name),
  selectPane: (paneId: string | null): Promise<void> => ipcRenderer.invoke('corral:selectPane', paneId),
  toggleCollapse: (workspaceId: string): Promise<void> => ipcRenderer.invoke('corral:toggleCollapse', workspaceId),
  refreshSessions: (): Promise<void> => ipcRenderer.invoke('corral:refreshSessions'),
  reportRendered: (revision: number): void => ipcRenderer.send('corral:reportRendered', revision),
  // LIFE-345 — 터미널. 프레임은 main 이 만들고 렌더러는 그대로 쓴다.
  onTerminalFrame: (listener: (frame: TerminalFrame) => void): (() => void) => {
    const handler = (_event: unknown, frame: TerminalFrame): void => listener(frame)
    ipcRenderer.on('corral:terminalFrame', handler)
    return () => ipcRenderer.removeListener('corral:terminalFrame', handler)
  },
  sendPaneText: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corral:paneText', text),
  sendPaneKeys: (keys: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corral:paneKeys', keys),
  // LIFE-346 — 행의 생성·종료. 확인(N6)은 main 이 강제한다: 에이전트가 도는 탭은
  // `confirmed:false` 로 부르면 `needsConfirm` 만 돌아오고 herdr 로는 아무것도 안 나간다.
  createRow: (input: { workspaceId: string; kind: string; label: string | null }): Promise<{
    ok: boolean
    launchId: string
    error?: string
  }> => ipcRenderer.invoke('corral:createRow', input),
  closeRow: (input: { tabId: string; confirmed: boolean }): Promise<CloseOutcome> =>
    ipcRenderer.invoke('corral:closeRow', input),
  dismissLaunch: (launchId: string): Promise<boolean> => ipcRenderer.invoke('corral:dismissLaunch', launchId),
  reportProbe: (name: string, detail: Record<string, string>): void =>
    ipcRenderer.send('corral:reportProbe', name, detail),
  // S3 근거 — preload 자기 컨텍스트에서 관측한 값을 그대로 화면·로그에 싣는다.
  preloadEnv: {
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
    exposedMethods: EXPOSED,
  },
}

contextBridge.exposeInMainWorld('corral', api)
