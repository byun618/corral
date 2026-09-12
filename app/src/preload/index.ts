// preload — contextBridge 로 **채널별 메서드만** 노출한다. ipcRenderer 를 통째로 넘기지 않는다.
//
// sandbox:true 에서는 이 파일이 **단일 CJS 번들**이어야 로드된다 (ESM preload 는 조용히 실패) —
// electron.vite.config.ts 의 preload output.format='cjs' 가 그 보장이다.
//
// 여기 오가는 타입은 전부 `shared/types.ts` 다. 어댑터는 이름조차 모른다 (기준 N2).

import { contextBridge, ipcRenderer } from 'electron'
import type { AddRepoResult, AppState, BrowseReposResult, CorralApi, RemoveRepoResult } from '../shared/types.js'

const EXPOSED = [
  'getState',
  'onState',
  'addRepo',
  'removeRepo',
  'browseForRepos',
  'refreshSessions',
  'reportRendered',
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
  reportRendered: (revision: number) => ipcRenderer.send('corral:reportRendered', revision),
  // preload 자기 컨텍스트에서 관측한 값을 그대로 화면·로그에 싣는다 (보안 자세의 근거).
  preloadEnv: {
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
    exposedMethods: EXPOSED,
  },
}

contextBridge.exposeInMainWorld('corral', api)
