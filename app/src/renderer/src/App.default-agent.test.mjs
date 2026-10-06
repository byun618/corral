// @vitest-environment happy-dom
/* global window, document, KeyboardEvent */
// LIFE-515 K3ⓒⓖ·K5ⓑ — 실제 App 마운트에서 ⌘⌥T(실제 keydown → 레지스트리 → 핸들러)가 기본 Agent 해석대로 `createRow` 를 부른다,
// 「Agent 설정…」 이 설정 › AI 기능 › 에이전트를 연다. IPC 는 합성 state(열린 workspace 하나·탭 하나), TerminalPane 은 mock.
// AppState 는 큰 타입이라 이 파일은 .mjs 로 둔다(App.settings.test.mjs 와 같은 걸음).
import { act, Component, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KeybindingStore } from '../../main/keybindings.js'
import { UiPrefsStore } from '../../main/ui-prefs.js'
import { DEFAULT_SETTINGS } from '../../shared/terminal-settings.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { emptyAgentState } from '../../shared/agent-state.js'
import { resetSettingsStoreForTest } from './settings-store.js'

vi.mock('./TerminalPane.js', () => ({ TerminalPane: () => null, keepTerminalFocus: () => {} }))
const { App } = await import('./App.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

class Boundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error: String(error) } }
  render() { return this.state.error === null ? this.props.children : createElement('div', { 'data-render-error': true }, this.state.error) }
}

const cleanups = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); resetSettingsStoreForTest(null) })

const pane = { paneId: 'p1', tabId: 't1', workspaceId: 'w1', title: '', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: true, agentSession: null, digest: EMPTY_SESSION_DIGEST }
const tabRow = { tabId: 't1', workspaceId: 'w1', label: '', number: 1, order: 0, agentStatus: 'idle', focused: true, panes: [pane], digest: EMPTY_SESSION_DIGEST }

async function mount({ defaultAgent, overrides = {} }) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l515-app-'))
  new KeybindingStore(folder).save(overrides)
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = { ...new UiPrefsStore(folder).get(), sidebarCollapsed: false }
  const gitStatus = { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false }
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'ready' },
    registry: { file: path.join(folder, 'registry'), roots: ['/r'], lastError: null }, registryGeneration: 0,
    repos: [{ root: '/r', name: 'r', error: null, worktrees: [{ path: '/r', branch: 'main', isLinked: false, openWorkspaceId: 'w1', workspace: { workspaceId: 'w1', label: 'r', number: 1, agentStatus: 'idle', focused: true, tabs: [tabRow] }, gitStatus, displayName: null, comment: null, parentPath: null }] }],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] },
  }
  const created = []
  const settingsWrites = []
  let settings = { ...DEFAULT_SETTINGS, defaultAgent }
  const api = {
    getState: async () => state,
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    getSettingsSync: () => settings,
    setSettings: async (patch) => { settingsWrites.push(patch); settings = { ...settings, ...patch }; return { status: 'saved', settings } },
    createRow: async (input) => { created.push(input); return { ok: true, paneId: null, tabId: null, error: null } },
    setUiPrefs: () => {},
    setShortcutRecording: async () => {},
  }
  Reflect.set(window, 'corral', new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) }))
  resetSettingsStoreForTest(null)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Boundary, null, createElement(App))) })
  await act(async () => {})
  cleanups.push(() => { act(() => root.unmount()); host.remove(); fs.rmSync(folder, { recursive: true, force: true }) })
  const q = (selector) => host.querySelector(selector)
  return {
    q, created, settingsWrites,
    key: async (init, target = document.body) => { await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }) },
  }
}
const CMD_OPT_T = { key: '†', code: 'KeyT', metaKey: true, altKey: true }

it.each([
  ['auto', { workspaceId: 'w1', kind: 'claude' }],
  ['claude', { workspaceId: 'w1', kind: 'claude' }],
  ['codex', { workspaceId: 'w1', kind: 'codex' }],
  ['grok', { workspaceId: 'w1', kind: 'grok' }],
  ['blank', { workspaceId: 'w1', kind: 'shell' }],
])('⌘⌥T — 기본값 %s → createRow %o (⌘T 와 같은 대상 workspace)', async (defaultAgent, expected) => {
  const app = await mount({ defaultAgent })
  expect(app.q('[data-render-error]')).toBeNull()
  await app.key(CMD_OPT_T)
  expect(app.created).toEqual([expected])
  // 대조: ⌘T 는 같은 workspace 에 빈 탭.
  await app.key({ key: 't', code: 'KeyT', metaKey: true })
  expect(app.created.at(-1)).toEqual({ workspaceId: 'w1', kind: 'shell' })
})

it('⌘⌥T 키 반복(repeat)은 무시한다 · 「없음」 으로 끄면 아무 일도 없다 · 재정의 조합이 연다', async () => {
  const app = await mount({ defaultAgent: 'codex' })
  await app.key({ ...CMD_OPT_T, repeat: true })
  expect(app.created).toEqual([])
  for (const cleanup of cleanups.splice(0)) cleanup()
  const off = await mount({ defaultAgent: 'codex', overrides: { 'terminal.newAgent': [null] } })
  await off.key(CMD_OPT_T)
  expect(off.created).toEqual([])
  for (const cleanup of cleanups.splice(0)) cleanup()
  const moved = await mount({ defaultAgent: 'codex', overrides: { 'terminal.newAgent': ['Mod+Alt+Shift+T'] } })
  await moved.key({ key: 'ˇ', code: 'KeyT', metaKey: true, altKey: true, shiftKey: true })
  expect(moved.created).toEqual([{ workspaceId: 'w1', kind: 'codex' }])
})

it('설정 페이지가 열린 동안 ⌘⌥T 는 숨은 워크스페이스에 탭을 만들지 않는다(⌘T 와 같은 규칙, K3ⓓ)', async () => {
  const app = await mount({ defaultAgent: 'codex' })
  await app.key({ key: ',', code: 'Comma', metaKey: true })
  expect(app.q('[data-settings-page]')).not.toBeNull()
  await app.key(CMD_OPT_T)
  await app.key({ key: 't', code: 'KeyT', metaKey: true })
  expect(app.created).toEqual([])
})

it('「Agent 설정…」 → 메뉴 닫힘 → 설정 › AI 기능 › 에이전트 · 다른 섹션을 보다 닫은 뒤에도 에이전트로 (K5ⓑ)', async () => {
  const app = await mount({ defaultAgent: 'auto' })
  const plus = app.q('[data-main-tabbar-add]')
  expect(plus).not.toBeNull()
  await act(async () => { plus.click() })
  await act(async () => { app.q('[data-tab-create-item="agent-settings"]').click() })
  expect(app.q('[data-tab-create-menu]')).toBeNull()
  expect(app.q('[data-settings-section="agents"]')).not.toBeNull()
  expect(app.q('[data-settings-nav-item="agents"]').getAttribute('aria-current')).toBe('page')
  // 단축키 섹션으로 옮겨 닫고 다시 「Agent 설정…」.
  await act(async () => { app.q('[data-settings-nav-item="shortcuts"]').click() })
  expect(app.q('[data-settings-section="shortcuts"]')).not.toBeNull()
  await act(async () => { app.q('[data-settings-back]').click() })
  expect(app.q('[data-settings-page]')).toBeNull()
  await act(async () => { app.q('[data-main-tabbar-add]').click() })
  await act(async () => { app.q('[data-tab-create-item="agent-settings"]').click() })
  expect(app.q('[data-settings-section="agents"]')).not.toBeNull()
  // 설정 화면의 pill 클릭 = 쓰기 1회.
  await act(async () => { app.q('[data-default-agent="grok"]').click() })
  expect(app.settingsWrites).toEqual([{ defaultAgent: 'grok' }])
})
