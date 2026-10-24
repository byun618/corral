// @vitest-environment happy-dom
/* global window, document, KeyboardEvent, requestAnimationFrame */
// LIFE-675 K7 — `corral:revealPane`(Resource 「이동」·CLI `worktree create --activate`)을 받으면 덮는 설정·작업 페이지가 닫힌다.
// 마운트는 App.settings.test.mjs 와 같은 걸음(빈 state 합성·실제 `KeybindingStore`·TerminalPane mock). 수신 리스너만 붙잡아 직접 발화한다.
import { act, Component, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KeybindingStore } from '../../main/keybindings.js'
import { UiPrefsStore } from '../../main/ui-prefs.js'

vi.mock('./TerminalPane.js', () => ({ TerminalPane: () => null, keepTerminalFocus: () => {} }))
const { App } = await import('./App.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

class Boundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error: String(error) } }
  render() { return this.state.error === null ? this.props.children : createElement('div', { 'data-render-error': true }, this.state.error) }
}

const cleanups = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

async function mount(overrides = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l675-app-'))
  new KeybindingStore(folder).save(overrides)
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = { ...new UiPrefsStore(folder).get(), sidebarCollapsed: false }
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'stopped' }, backend: { kind: 'ok' },
    registry: { file: path.join(folder, 'registry'), roots: [], lastError: null }, registryGeneration: 0, repos: [],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] }, herdrTabIds: null,
  }
  const calls = { setUiPrefs: [], saved: [] }
  const revealListeners = []
  const api = {
    getState: async () => state,
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    setUiPrefs: (patch) => { calls.setUiPrefs.push(patch) },
    saveKeybindings: async (next) => { try { store.save(next); calls.saved.push(store.get()); return { ok: true, overrides: store.get() } } catch (error) { return { ok: false, error: String(error.message ?? error) } } },
    setShortcutRecording: async () => {},
    onRevealPane: (listener) => { revealListeners.push(listener); return () => { revealListeners.splice(revealListeners.indexOf(listener), 1) } },
  }
  Reflect.set(window, 'corral', new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Boundary, null, createElement(App))) })
  cleanups.push(() => { act(() => root.unmount()); host.remove(); fs.rmSync(folder, { recursive: true, force: true }) })
  const q = (selector) => host.querySelector(selector)
  return {
    host, calls, folder, q,
    reveal: async (paneId) => { await act(async () => { for (const listener of revealListeners) listener(paneId) }) },
    click: async (selector) => { await act(async () => { q(selector).click() }) },
    key: async (init, target = document.body) => { await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }) },
    open: () => q('[data-settings-page]') !== null,
    tasksOpen: () => { const page = q('[data-tasks-page]'); return page !== null && !page.classList.contains('is-closed') },
    covered: () => { const body = q('.app-body'); return { className: body.className, inert: body.inert === true || body.hasAttribute('inert') } },
  }
}
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

it('설정이 열린 채 이동 요청을 받으면 설정이 닫히고 워크스페이스 덮개가 걷힌다', async () => {
  const app = await mount()
  await app.click('[data-settings-open]')
  expect(app.open()).toBe(true)
  expect(app.covered()).toEqual({ className: 'app-body is-covered', inert: true })
  await app.reveal('w1:p1')
  await frame()
  expect(app.open()).toBe(false)
  expect(app.q('[data-settings-overlay]')).toBeNull()
  expect(app.covered()).toEqual({ className: 'app-body', inert: false })
})

it('작업 페이지가 열린 채 이동 요청을 받으면 작업 페이지가 닫힌다', async () => {
  const app = await mount()
  await app.click('[data-tasks-open]')
  expect(app.tasksOpen()).toBe(true)
  await app.reveal('w1:p1')
  await frame()
  expect(app.tasksOpen()).toBe(false)
  expect(app.q('[data-tasks-page]').classList.contains('is-closed')).toBe(true)
})

it('덮개가 없을 때 이동 요청은 설정·작업 페이지를 열지 않는다', async () => {
  const app = await mount()
  await app.reveal('w1:p1')
  await frame()
  expect(app.open()).toBe(false)
  expect(app.tasksOpen()).toBe(false)
  expect(app.covered()).toEqual({ className: 'app-body', inert: false })
})
