// @vitest-environment happy-dom
/* global window, document, KeyboardEvent */
// LIFE-495 fix3 R3-01 — 빈 칸(null) 단축키 파일로 App 이 뜬다. 실제 `KeybindingStore` 에 `{"sidebar.toggle":[null]}` 저장 → 새 store 로 읽기 →
// 실제 App 마운트(사이드바 펼침·접힘). IPC 는 빈 state 합성, TerminalPane 은 mock. 렌더 오류는 경계 컴포넌트로 모은다(Codex r3 부록 A 와 같은 걸음).
// main 의 store 를 renderer 테스트가 부르므로 .mjs(tsconfig.web 은 src/main 을 싣지 않는다).
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

const dirs = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

async function mount(input) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l495-null-'))
  dirs.push(folder)
  new KeybindingStore(folder).save(input.overrides)
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = { ...new UiPrefsStore(folder).get(), sidebarCollapsed: input.collapsed }
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'stopped' },
    registry: { file: path.join(folder, 'registry'), roots: [], lastError: null }, registryGeneration: 0, repos: [],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] },
  }
  const api = { getState: async () => state, getUiPrefs: async () => prefs, getKeybindings: async () => store.get() }
  Reflect.set(window, 'corral', new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(createElement(Boundary, null, createElement(App))) })
    // LIFE-527 — 접기·펼치기는 사이드바 머리의 PanelLeft 토글 하나다(펼침 = 사이드바 칸 위, 접힘 = 떠 있는 머리). 단축키는 title 에 싣는다.
    const hide = host.querySelector('[data-sidebar-toggle="hide"]')
    const show = host.querySelector('[data-sidebar-toggle="show"]')
    // LIFE-527 K2ⓑ — 단축키를 차례로 누르고 그때마다 토글 상태(hide = 펼침 · show = 접힘)를 적는다.
    const afterKeys = []
    for (const init of input.keys ?? []) {
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
      afterKeys.push(host.querySelector('[data-sidebar-toggle]')?.getAttribute('data-sidebar-toggle') ?? null)
    }
    return {
      afterKeys,
      error: host.querySelector('[data-render-error]')?.textContent ?? null,
      app: host.querySelector('.app') !== null,
      toggle: hide === null ? null : hide.title,
      show: show === null ? null : { label: show.getAttribute('aria-label') ?? '', title: show.title },
    }
  } finally {
    act(() => root.unmount())
    host.remove()
  }
}

it('fix3 R3-01 대조 — 빈 재정의 파일은 지금처럼 뜬다(⌘B)', async () => {
  const shown = await mount({ overrides: {}, collapsed: false })
  expect(shown.error).toBeNull()
  expect(shown.toggle).toBe('사이드바 접기 (⌘B)')
})

it('fix3 R3-01 사이드바 단축키를 비운 파일 — 펼친 상태로 뜨고 접기 버튼이 남는다', async () => {
  const shown = await mount({ overrides: { 'sidebar.toggle': [null] }, collapsed: false })
  expect(shown.error).toBeNull()
  expect(shown.app).toBe(true)
  // 비운 칸이면 빈 괄호 없이 이름만(fix3 R3-01 — 「접기」 대체 규칙과 같은 취지: 버튼·툴팁이 빈 글자로 사라지지 않는다).
  expect(shown.toggle).toBe('사이드바 접기')
})

it('fix3 R3-01 사이드바 단축키를 비운 파일 — 접힌 상태로 뜨고 펼치기 버튼(떠 있는 머리)이 남는다(단축키 안내 없음)', async () => {
  const shown = await mount({ overrides: { 'sidebar.toggle': [null] }, collapsed: true })
  expect(shown.error).toBeNull()
  expect(shown.app).toBe(true)
  expect(shown.show?.label).toBe('사이드바 펼치기')
  expect(shown.show?.title).toBe('사이드바 펼치기')
})

it('LIFE-527 K2ⓑ — ⌘B 가 접고(떠 있는 머리 = show) 다시 ⌘B 가 펼친다(hide)', async () => {
  const meta = { key: 'b', code: 'KeyB', metaKey: true }
  const shown = await mount({ overrides: {}, collapsed: false, keys: [meta, meta] })
  expect(shown.error).toBeNull()
  expect(shown.afterKeys).toEqual(['show', 'hide'])
})

it('LIFE-527 K2ⓑ 대조 — 사이드바 단축키를 비우면 ⌘B 가 아무것도 안 한다(위 시험이 바인딩을 거친다는 대조)', async () => {
  const meta = { key: 'b', code: 'KeyB', metaKey: true }
  const shown = await mount({ overrides: { 'sidebar.toggle': [null] }, collapsed: false, keys: [meta] })
  expect(shown.error).toBeNull()
  expect(shown.afterKeys).toEqual(['hide'])
})
