// LIFE-636 E10 첫 화면 캡처용 preload 대역 — 실제 렌더러 번들(out/renderer)에 window.corral 을 채운다(contextIsolation:false).
// 사용량 스냅숏은 main 쪽 스크립트가 넘긴 값(실제 수집기 결과)이고, 나머지 앱 상태는 빈 상태(App.settings.test.mjs 와 같은 모양)다.
const { ipcRenderer } = require('electron')

const snapshot = ipcRenderer.sendSync('l636:snapshot')
const listeners = new Set()
const state = {
  revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'stopped' }, backend: { kind: 'ok' },
  registry: { file: '/tmp/l636-fs/registry', roots: [], lastError: null }, registryGeneration: 0, repos: [],
  terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
  retainedAgents: [], diagnostics: false, home: '/tmp/l636-fs', orchestrationLineage: { state: 'ready', entries: [] }, herdrTabIds: null,
}
const prefs = { sidebarWidth: null, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: [], expandedAgentGroups: [], tabOrdinals: [], groupLayouts: [], manualRepoOrder: [], manualWorktreeOrder: {} }
const api = {
  getState: async () => state,
  getUiPrefs: async () => prefs,
  getKeybindings: async () => ({}),
  getSettingsSync: () => ({}),
  getUsage: async () => snapshot,
  refreshUsage: async () => snapshot,
  onUsage: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  preloadEnv: { sandboxed: false, contextIsolated: false, exposedMethods: [] },
}
window.corral = new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) })
window.__l636push = (next) => { for (const listener of listeners) listener(next) }
