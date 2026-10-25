// @vitest-environment happy-dom
/* global window, document, requestAnimationFrame */
// LIFE-675 K7 — `corral:revealPane`(Resource 「이동」·CLI `worktree create --activate`)을 받으면 덮는 설정·작업 페이지가 닫히고
// 대상 pane 이 선택·포커스된다. 실제 App 마운트 + 진짜 `TerminalPane`(xterm 만 가짜 — TerminalPane.focus.test.tsx 와 같은 걸음:
// `open()` 이 `.xterm-helper-textarea` 를 만들고 `focus()` 가 그것을 포커스한다). 합성 state = worktree 둘(`/r` 에 탭 t1·t2, `/r-b` 에 탭 t3).
// happy-dom 은 inert 의 포커스 차단을 모델링하지 않는다 — 실제 Chromium 포커스는 최종 관문(K1 ⓒ)이 본다.
import { act, Component, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KeybindingStore } from '../../main/keybindings.js'
import { UiPrefsStore } from '../../main/ui-prefs.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { emptyAgentState } from '../../shared/agent-state.js'

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options = {}
    unicode = { activeVersion: '' }
    buffer = { active: { cursorX: 0, cursorY: 0, getLine: () => undefined } }
    textarea = null
    loadAddon() {}
    open(container) {
      this.textarea = document.createElement('textarea')
      this.textarea.className = 'xterm-helper-textarea'
      container.appendChild(this.textarea)
    }
    focus() { this.textarea?.focus() }
    registerLinkProvider() { return { dispose: () => {} } }
    onSelectionChange() { return { dispose: () => {} } }
    onData() { return { dispose: () => {} } }
    attachCustomKeyEventHandler() {}
    input() {}
    hasSelection() { return false }
    write(_data, done) { done?.() }
    resize() {}
    dispose() { this.textarea?.remove() }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
const { App } = await import('./App.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

class Boundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error: String(error) } }
  render() { return this.state.error === null ? this.props.children : createElement('div', { 'data-render-error': true }, this.state.error) }
}

const cleanups = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const pane = (paneId, tabId, workspaceId) => ({ paneId, tabId, workspaceId, title: '', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: paneId === 'p1', agentSession: null, digest: EMPTY_SESSION_DIGEST })
const tab = (tabId, workspaceId, number, panes) => ({ tabId, workspaceId, label: '', number, order: number - 1, agentStatus: 'idle', focused: tabId === 't1', panes, digest: EMPTY_SESSION_DIGEST })
const gitStatus = (branch) => ({ branch, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false })
const worktree = ({ path: worktreePath, branch, isLinked, workspaceId, number, tabs }) => ({
  path: worktreePath, branch, isLinked, openWorkspaceId: workspaceId, gitStatus: gitStatus(branch), displayName: null, comment: null, parentPath: isLinked ? '/r' : null,
  workspace: { workspaceId, label: branch, number, agentStatus: 'idle', focused: workspaceId === 'w1', tabs },
})

async function mount() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l675-app-'))
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = { ...new UiPrefsStore(folder).get(), sidebarCollapsed: false }
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'ready' }, backend: { kind: 'ok' },
    registry: { file: path.join(folder, 'registry'), roots: ['/r'], lastError: null }, registryGeneration: 0,
    repos: [{ root: '/r', name: 'r', error: null, worktrees: [
      worktree({ path: '/r', branch: 'main', isLinked: false, workspaceId: 'w1', number: 1, tabs: [tab('t1', 'w1', 1, [pane('p1', 't1', 'w1')]), tab('t2', 'w1', 2, [pane('p2', 't2', 'w1')])] }),
      worktree({ path: '/r-b', branch: 'feat-b', isLinked: true, workspaceId: 'w2', number: 2, tabs: [tab('t3', 'w2', 1, [pane('p3', 't3', 'w2')])] }),
    ] }],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] }, herdrTabIds: null,
  }
  const revealListeners = []
  const api = {
    getState: async () => state,
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    onRevealPane: (listener) => { revealListeners.push(listener); return () => { revealListeners.splice(revealListeners.indexOf(listener), 1) } },
  }
  Reflect.set(window, 'corral', new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Boundary, null, createElement(App))) })
  await act(async () => {})
  cleanups.push(() => { act(() => root.unmount()); host.remove(); fs.rmSync(folder, { recursive: true, force: true }) })
  const q = (selector) => host.querySelector(selector)
  const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })
  return {
    q,
    click: async (selector) => { await act(async () => { q(selector).click() }) },
    reveal: async (paneId) => { await act(async () => { for (const listener of revealListeners) listener(paneId) }); await frame() },
    /** 덮개·선택·포커스를 한 값으로 — 단언 실패 때 어느 칸이 어긋났는지 바로 보인다. */
    view: () => {
      const body = q('.app-body')
      const tasks = q('[data-tasks-page]')
      const selected = q('[data-term-pane-box].is-selected')
      return {
        settings: q('[data-settings-overlay]') !== null,
        tasks: tasks !== null && !tasks.classList.contains('is-closed'),
        inert: body.inert === true || body.hasAttribute('inert'),
        selected: selected?.getAttribute('data-term-pane-box') ?? null,
        focusInSelected: selected !== null && selected.contains(document.activeElement),
      }
    },
  }
}

const moved = (paneId) => ({ settings: false, tasks: false, inert: false, selected: paneId, focusInSelected: true })

it('설정이 열린 채 다른 worktree 의 pane 으로 이동 요청 → 설정이 닫히고 대상 pane 이 선택·포커스된다', async () => {
  const app = await mount()
  expect(app.q('[data-render-error]')).toBeNull()
  await app.click('[data-settings-open]')
  expect(app.view()).toMatchObject({ settings: true, inert: true, focusInSelected: false })
  await app.reveal('p3')
  expect(app.view()).toEqual(moved('p3'))
})

it('작업 페이지가 열린 채 다른 worktree 의 pane 으로 이동 요청 → 작업 페이지가 닫히고 대상 pane 이 선택·포커스된다', async () => {
  const app = await mount()
  await app.click('[data-tasks-open]')
  expect(app.view()).toMatchObject({ tasks: true, focusInSelected: false })
  await app.reveal('p3')
  expect(app.view()).toEqual(moved('p3'))
})

it('설정이 열린 채 같은 worktree 의 다른 탭 pane 으로 이동 요청 → 설정이 닫히고 그 pane 이 선택·포커스된다', async () => {
  const app = await mount()
  await app.click('[data-settings-open]')
  expect(app.view()).toMatchObject({ settings: true, inert: true, focusInSelected: false })
  await app.reveal('p2')
  expect(app.view()).toEqual(moved('p2'))
})

it('덮개가 없을 때 이동 요청은 설정·작업 페이지를 열지 않고 대상 pane 으로 간다', async () => {
  const app = await mount()
  await app.reveal('p3')
  expect(app.view()).toEqual(moved('p3'))
})
