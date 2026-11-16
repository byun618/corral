// @vitest-environment happy-dom
/* global window, document, setTimeout, KeyboardEvent, MouseEvent, Event, HTMLInputElement */
// LIFE-823 — App 배선을 실제 마운트로 거친다(App.close-scope.test.mjs 와 같은 걸음):
//   · C3 ⌘P ⌥Enter → `openListedFile(side)` → `placeFileAt(side)` → 활성 영역 오른쪽 새 분할(고정 탭)
//   · C2·P2 이미 열린 파일을 옆으로 열면 옮기지 않고 그 탭으로 가며 안내 한 줄(맥락이 바뀌는 길 — 822 의 맥락 지우기에 먹히지 않는다)
//   · C4 B4 파일 탭 끌기 고스트 = 파일 이름
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
import { LAYOUT_FORMAT } from './group-tree.js'
import { alreadyOpenHint } from './file-tabs.js'

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

const paneOf = (paneId, tabId) => ({ paneId, tabId, workspaceId: 'w1', title: '', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: paneId === 'p1', agentSession: null, digest: EMPTY_SESSION_DIGEST })
const tabOf = (tabId, number, panes) => ({ tabId, workspaceId: 'w1', label: 'zsh', number, order: number - 1, agentStatus: 'idle', focused: tabId === 't1', panes, digest: EMPTY_SESSION_DIGEST })
const FILE = 'file:a.ts'

async function mount() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l823-app-'))
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = {
    ...new UiPrefsStore(folder).get(),
    sidebarCollapsed: false,
    groupLayouts: [{ worktreePath: '/r', layoutFormat: LAYOUT_FORMAT, layout: { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1', FILE], activeTabId: 't1' } }, activeGroupId: 'g1' } }],
  }
  const gitStatus = { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false }
  const tabs = [tabOf('t1', 1, [paneOf('p1', 't1')])]
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'ready' }, backend: { kind: 'ok' },
    registry: { file: path.join(folder, 'registry'), roots: ['/r'], lastError: null }, registryGeneration: 0,
    repos: [{ root: '/r', name: 'r', error: null, worktrees: [{ path: '/r', branch: 'main', isLinked: false, openWorkspaceId: 'w1', workspace: { workspaceId: 'w1', label: 'r', number: 1, agentStatus: 'idle', focused: true, tabs }, gitStatus, displayName: null, comment: null, parentPath: null }] }],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] }, herdrTabIds: null,
  }
  const api = {
    getState: async () => state,
    onState: () => () => {},
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    getSettingsSync: () => DEFAULT_SETTINGS,
    setSettings: async () => ({ status: 'saved', settings: DEFAULT_SETTINGS }),
    readFile: async () => ({ ok: true, kind: 'binary', size: 1, bytesRead: 1, stamp: 's0' }),
    fileList: async ({ root, includeIgnored }) => ({ ok: true, root, includeIgnored, paths: ['a.ts', 'b.ts'].join('\0'), truncated: false, ms: 1 }),
    explorerList: async () => ({ ok: true, entries: [{ name: 'a.ts', kind: 'file', link: 'none' }, { name: 'b.ts', kind: 'file', link: 'none' }] }),
    setUiPrefs: () => {},
    setShortcutRecording: async () => {},
  }
  Reflect.set(window, 'corral', new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) }))
  // happy-dom 에는 없다 — 끌기 판정이 부른다(영역 밖 = invalid).
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [] })
  resetSettingsStoreForTest(null)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Boundary, null, createElement(App))) })
  await act(async () => {})
  cleanups.push(() => { act(() => root.unmount()); host.remove(); fs.rmSync(folder, { recursive: true, force: true }) })
  const q = (selector) => document.querySelector(selector)
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) }) }
  const key = async (init, target = document.body) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
    await settle()
  }
  return {
    q, settle, key,
    /** ⌘P → 질의 → (⌥)Enter. */
    quickOpen: async ({ query, altKey }) => {
      await key({ key: 'p', code: 'KeyP', metaKey: true })
      const input = q('[data-quick-open-input]')
      if (input === null) throw new Error('⌘P 안 열림')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await key({ key: 'Enter', altKey }, input)
      for (let i = 0; i < 20 && q('[data-quick-open]') !== null; i += 1) await settle()
      await settle()
    },
    groups: () => [...document.querySelectorAll('[data-tab-group]')].map((group) => ({ groupId: group.getAttribute('data-tab-group'), tabs: [...group.querySelectorAll('[data-main-tab]')].map((tab) => tab.getAttribute('data-main-tab')) })),
    noticeTitle: () => q('.inline-notice-text')?.getAttribute('title') ?? null,
  }
}

it('C3 ⌘P ⌥Enter — 활성 영역 오른쪽 새 영역에 고정 탭', async () => {
  const app = await mount()
  expect(app.q('[data-render-error]')).toBeNull()
  await app.quickOpen({ query: 'b.ts', altKey: true })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['t1', FILE] }, { groupId: 'g2', tabs: ['file:b.ts'] }])
  expect(app.q('[data-main-tab="file:b.ts"]')?.getAttribute('data-tab-preview')).toBe('false')
})

it('C3 회귀 0 — ⌘P Enter 는 활성 영역(분할 없음)', async () => {
  const app = await mount()
  await app.quickOpen({ query: 'b.ts', altKey: false })
  expect(app.groups()).toHaveLength(1)
  expect(app.groups()[0]?.tabs).toContain('file:b.ts')
})

it('C2·P2 이미 열린 파일을 옆으로 — 옮기지 않고 그 탭으로, 안내 한 줄(전문 title)', async () => {
  const app = await mount()
  await app.quickOpen({ query: 'a.ts', altKey: true })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['t1', FILE] }])
  expect(app.q(`[data-main-tab="${FILE}"]`)?.getAttribute('data-active')).toBe('true')
  expect(app.noticeTitle()).toBe(alreadyOpenHint('a.ts'))
})

it('C4 B4 — 파일 탭 끌기 고스트 글자 = 파일 이름', async () => {
  const app = await mount()
  const tab = app.q(`[data-main-tab="${FILE}"]`)
  if (tab === null) throw new Error('파일 탭 없음')
  await act(async () => { tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50, clientY: 10 })) })
  await act(async () => { document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 90, clientY: 60 })) })
  expect(app.q('[data-tab-drag-ghost]')?.textContent).toBe('a.ts')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(app.q('[data-tab-drag-ghost]')).toBeNull()
})
