// @vitest-environment happy-dom
// LIFE-511 K1ⓐⓑⓒⓓⓔ·K2ⓐⓑⓕ·K6ⓐ — 실제 App 마운트에서 설정 진입로(⚙ · ⌘, · 팔레트 · ? 메뉴 · workspace-tools)와 덮기·차단.
// IPC 는 빈 state 합성(App.null-binding.test.mjs 와 같은 걸음), 키바인딩은 실제 `KeybindingStore` 를 거친다. TerminalPane 은 mock.
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
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l511-app-'))
  new KeybindingStore(folder).save(overrides)
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = { ...new UiPrefsStore(folder).get(), sidebarCollapsed: false }
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'stopped' },
    registry: { file: path.join(folder, 'registry'), roots: [], lastError: null }, registryGeneration: 0, repos: [],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] },
  }
  const calls = { setUiPrefs: [], saved: [] }
  const api = {
    getState: async () => state,
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    setUiPrefs: (patch) => { calls.setUiPrefs.push(patch) },
    saveKeybindings: async (next) => { try { store.save(next); calls.saved.push(store.get()); return { ok: true, overrides: store.get() } } catch (error) { return { ok: false, error: String(error.message ?? error) } } },
    setShortcutRecording: async () => {},
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
    click: async (selector) => { await act(async () => { q(selector).click() }) },
    key: async (init, target = document.body) => { await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }) },
    open: () => q('[data-settings-page]') !== null,
    covered: () => { const body = q('.app-body'); return { className: body.className, inert: body.inert === true || body.hasAttribute('inert') } },
  }
}
const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

it('⚙(사이드바 하단 버튼) — 설정 › 단축키를 연다 · 워크스페이스는 언마운트되지 않고 덮인다(is-covered + inert) · 모달 dialog 0', async () => {
  const app = await mount()
  expect(app.q('[data-render-error]')).toBeNull()
  expect(app.q('[data-settings-open]').tagName).toBe('BUTTON')
  const mainArea = app.q('[data-main-area]')
  await app.click('[data-settings-open]')
  expect(app.open()).toBe(true)
  expect(app.q('[data-settings-section="shortcuts"]')).not.toBeNull()
  expect(app.covered()).toEqual({ className: 'app-body is-covered', inert: true })
  // 같은 DOM 노드가 그대로 있다(언마운트·재마운트 없음).
  expect(app.q('[data-main-area]')).toBe(mainArea)
  expect(app.host.querySelector('[role="dialog"]')).toBeNull()
  expect(app.q('[data-statusbar]')).not.toBeNull()
  await app.click('[data-settings-back]')
  await frame()
  expect(app.open()).toBe(false)
  expect(app.covered()).toEqual({ className: 'app-body', inert: false })
})

it('⌘, — 레지스트리 액션으로 연다(Comma 물리 키)', async () => {
  const app = await mount()
  await app.key({ key: ',', code: 'Comma', metaKey: true })
  expect(app.open()).toBe(true)
})

it('⌘, — 사용자 재정의가 ⌘, 를 쓰면 설정 열기가 비켜 선다(그 재정의가 이긴다)', async () => {
  const app = await mount({ 'palette.open': ['Mod+,'] })
  await app.key({ key: ',', code: 'Comma', metaKey: true })
  expect(app.open()).toBe(false)
  expect(app.q('[data-command-palette]')).not.toBeNull()
})

it('⌘, — 「없음」 으로 두면 열리지 않는다 · 다른 조합으로 바꾸면 그 조합이 연다', async () => {
  const none = await mount({ 'settings.open': [null] })
  await none.key({ key: ',', code: 'Comma', metaKey: true })
  expect(none.open()).toBe(false)
  for (const cleanup of cleanups.splice(0)) cleanup()
  const moved = await mount({ 'settings.open': ['Mod+Shift+,'] })
  await moved.key({ key: ',', code: 'Comma', metaKey: true })
  expect(moved.open()).toBe(false)
  await moved.key({ key: '<', code: 'Comma', metaKey: true, shiftKey: true })
  expect(moved.open()).toBe(true)
})

it('팔레트 — 「설정 › 단축키」 항목(레지스트리와 같은 목록)으로 연다 · 옛 「단축키 설정」 항목은 없다', async () => {
  const app = await mount()
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  expect(app.q('[data-command-palette]')).not.toBeNull()
  expect(app.q('[data-palette-entry="shortcuts.settings"]')).toBeNull()
  const entry = app.q('[data-palette-entry="settings.section:shortcuts"]')
  expect(entry.textContent).toContain('설정 › 단축키')
  expect(app.q('[data-palette-entry="settings.open:0"]').textContent).toContain('설정 열기')
  await act(async () => { entry.click() })
  expect(app.open()).toBe(true)
  expect(app.q('[data-command-palette]')).toBeNull()
})

it('? 메뉴 「단축키」 — 설정 › 단축키로 간다', async () => {
  const app = await mount()
  await app.click('[data-help-menu-toggle]')
  await app.click('[data-help-menu] [data-menu-action="shortcuts"]')
  expect(app.open()).toBe(true)
  expect(app.q('[data-settings-nav-item="shortcuts"]').getAttribute('aria-current')).toBe('page')
})

it('workspace-tools 「단축키」 — 설정 › 단축키로 간다', async () => {
  const app = await mount()
  await app.click('[data-shortcuts-open]')
  expect(app.open()).toBe(true)
})

it('설정이 열린 동안 워크스페이스 단축키는 막힌다(K2ⓕ) — ⌘B 사이드바·⌘K 팔레트가 돌지 않는다 · 닫으면 다시 돈다', async () => {
  const app = await mount()
  await app.click('[data-settings-open]')
  const before = app.calls.setUiPrefs.length
  await app.key({ key: 'b', code: 'KeyB', metaKey: true })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  expect(app.calls.setUiPrefs.slice(before).some((patch) => 'sidebarCollapsed' in patch)).toBe(false)
  expect(app.q('[data-command-palette]')).toBeNull()
  expect(app.q('[data-sidebar]')).not.toBeNull()
  // ⌘, 를 다시 눌러도 겹쳐 열리지 않는다.
  await app.key({ key: ',', code: 'Comma', metaKey: true })
  expect(app.host.querySelectorAll('[data-settings-page]')).toHaveLength(1)
  // 닫고 나면(K8ⓒ) ⌘K·⌘B 가 그대로 돈다.
  await app.click('[data-settings-back]')
  await frame()
  await app.key({ key: 'b', code: 'KeyB', metaKey: true })
  expect(app.calls.setUiPrefs.some((patch) => patch.sidebarCollapsed === true)).toBe(true)
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  expect(app.q('[data-command-palette]')).not.toBeNull()
})

it('Esc 2단계로 닫힌다 · 단축키 편집이 설정 페이지에서 저장된다(keybindings.json)', async () => {
  const app = await mount()
  await app.click('[data-settings-open]')
  await app.click('[data-record="sidebar.toggle"][data-variant="0"]')
  await app.key({ key: 'g', code: 'KeyG', ctrlKey: true })
  await app.click('[data-save-binding]')
  expect(JSON.parse(fs.readFileSync(path.join(app.folder, 'keybindings.json'), 'utf8'))).toEqual({ 'sidebar.toggle': ['Control+G'] })
  // 사이드바 접기 버튼의 단축키 안내도 바로 바뀐다.
  expect(app.q('[data-sidebar-toggle]').textContent).toBe('⌃G')
  await app.key({ key: 'Escape' })
  expect(app.open()).toBe(true)
  await app.key({ key: 'Escape' })
  expect(app.open()).toBe(false)
})
