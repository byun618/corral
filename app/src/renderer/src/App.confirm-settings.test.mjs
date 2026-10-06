// @vitest-environment happy-dom
/* global window, document, KeyboardEvent */
// LIFE-516 K3·K4·K2·K6 — 실제 App 마운트에서
//   · ⌘W(실제 keydown → 레지스트리 → `closeTabsByUser`) → 확인 창(실제 `ConfirmClose`) → 체크박스·확인/취소 클릭 → 설정 쓰기·닫기
//   · 설정 › 일반 토글 클릭 → 설정 쓰기 1회 · 다음 ⌘W 의 확인 여부
//   · 설정 › 외관 › 창 및 사이드바 세그먼트 ↔ 사이드바 옵션 메뉴 라디오 — 같은 상태·같은 프리셋
// main 쪽 `corral:closeTabs` 는 **제품 게이트 함수 `closeTabsGated` 그대로**에 설정 값(`confirmRunning`)을 넘겨 흉내 낸다 — 실행 중 판정만
// 테스트가 정한다(`running`). AppState 는 큰 타입이라 .mjs 로 둔다(App.default-agent.test.mjs 와 같은 걸음).
import { act, Component, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KeybindingStore } from '../../main/keybindings.js'
import { UiPrefsStore } from '../../main/ui-prefs.js'
import { closeTabsGated } from '../../main/close-tabs.js'
import { DEFAULT_SETTINGS } from '../../shared/terminal-settings.js'
import { COMPACT_SIDEBAR_CARD_PROPERTIES, DEFAULT_SIDEBAR_CARD_PROPERTIES } from '../../shared/sidebar-view.js'
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

/** `save`: 'now'(바로 저장) · 'held'(테스트가 `releaseSave()` 로 응답을 놓을 때까지 대기) · 'failed'(저장소 쓰기 실패 응답). */
async function mount({ settings: initial = {}, pinned = false, running = false, cardLayout = 'detailed', save = 'now' } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l516-app-'))
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = {
    ...new UiPrefsStore(folder).get(),
    sidebarCollapsed: false,
    sidebarCardLayout: cardLayout,
    tabMarks: pinned ? [{ tabId: 't1', workspaceId: 'w1', pinned: true, color: null }] : [],
  }
  const gitStatus = { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false }
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'ready' },
    registry: { file: path.join(folder, 'registry'), roots: ['/r'], lastError: null }, registryGeneration: 0,
    repos: [{ root: '/r', name: 'r', error: null, worktrees: [{ path: '/r', branch: 'main', isLinked: false, openWorkspaceId: 'w1', workspace: { workspaceId: 'w1', label: 'r', number: 1, agentStatus: 'idle', focused: true, tabs: [tabRow] }, gitStatus, displayName: null, comment: null, parentPath: null }] }],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] },
  }
  const runningPanes = new Set(running ? ['p1'] : [])
  const settingsWrites = []
  const closeCalls = []
  const closed = []
  const uiPrefsWrites = []
  const heldSaves = []
  let settings = { ...DEFAULT_SETTINGS, ...initial }
  let stateListener = null
  const api = {
    getState: async () => state,
    // LIFE-527 — 상태 push 를 테스트가 직접 보낸다(경로 ② 「대상 pane이 사라졌습니다」).
    onState: (listener) => { stateListener = listener; return () => { stateListener = null } },
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    getSettingsSync: () => settings,
    setSettings: async (patch) => {
      settingsWrites.push(patch)
      if (save === 'failed') return { status: 'failed', settings }
      if (save === 'held') await new Promise((resolve) => { heldSaves.push(resolve) })
      settings = { ...settings, ...patch }
      return { status: 'saved', settings }
    },
    // main `closeTabsByIds` 와 같은 걸음 — 설정을 닫기마다 읽는다.
    closeTabs: async (input) => {
      closeCalls.push({ ...input })
      return closeTabsGated({
        ...input,
        confirmRunning: !settings.skipCloseTerminalWithRunningProcessConfirm,
        panesOf: (tabId) => (tabId === 't1' && !closed.includes('t1') ? ['p1'] : null),
        probe: async (panes) => panes.filter((row) => runningPanes.has(row.paneId)).map((row) => ({ ...row, foreground: ['sleep 600'] })),
        close: async (tabId) => { closed.push(tabId); return { outcome: 'closed' } },
      })
    },
    setUiPrefs: (patch) => { uiPrefsWrites.push(patch) },
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
  const click = async (selector) => {
    const element = q(selector)
    if (element === null) throw new Error(`없음: ${selector}`)
    await act(async () => { element.click() })
    await act(async () => {})
  }
  return {
    q, click, settingsWrites, closeCalls, closed, uiPrefsWrites,
    state,
    push: (next) => stateListener?.(next),
    releaseSave: async () => {
      const resolve = heldSaves.shift()
      if (resolve === undefined) throw new Error('대기 중인 저장 없음')
      await act(async () => { resolve() })
      await act(async () => {})
    },
    // LIFE-527 D9 — 앱 수준 알림은 토스트(sonner). sonner 는 toast() 를 다음 틱에 그린다 — 한 틱 기다린 뒤 문서에서 찾는다.
    notice: async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
      return document.querySelector('[data-sonner-toast] [data-title]')?.textContent ?? null
    },
    closeKey: async () => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'w', code: 'KeyW', metaKey: true })) }); await act(async () => {}) },
    key: async (init) => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }) },
    modal: () => q('[data-confirm-close-modal]'),
    checkbox: () => q('[data-dont-ask-again-input]'),
  }
}

// --- K3 핀 탭 닫기 확인 ------------------------------------------------------------------------------------

it('K3ⓒ 핀 탭(한가) ⌘W → 핀 확인 창 + 「고정된 탭에 대해 다시 묻지 않기」 · 체크 + 확인 → 그 설정만 끄고 닫는다', async () => {
  const app = await mount({ pinned: true })
  expect(app.q('[data-render-error]')).toBeNull()
  await app.closeKey()
  expect(app.modal()?.getAttribute('data-confirm-close-kind')).toBe('pinned')
  expect(app.q('[data-dont-ask-again]')?.textContent).toBe('고정된 탭에 대해 다시 묻지 않기')
  expect(app.checkbox().checked).toBe(false)
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-ok]')
  expect(app.settingsWrites).toEqual([{ confirmClosePinnedTab: false }])
  expect(app.closed).toEqual(['t1'])
  expect(app.modal()).toBeNull()
})

it('K3ⓒ 체크 없이 확인 → 저장 안 하고 닫는다 · 체크 + 취소 → 저장 안 하고 닫지도 않는다 · 다시 열면 체크 해제', async () => {
  const app = await mount({ pinned: true })
  await app.closeKey()
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-cancel]')
  expect(app.modal()).toBeNull()
  expect(app.settingsWrites).toEqual([])
  expect(app.closed).toEqual([])
  await app.closeKey()
  expect(app.checkbox().checked).toBe(false)
  await app.click('[data-close-confirm-ok]')
  expect(app.settingsWrites).toEqual([])
  expect(app.closed).toEqual(['t1'])
})

it('K3ⓑ 핀 확인이 꺼져 있으면 한가한 핀 탭은 창 없이 닫힌다(alwaysConfirm false)', async () => {
  const app = await mount({ pinned: true, settings: { confirmClosePinnedTab: false } })
  await app.closeKey()
  expect(app.modal()).toBeNull()
  expect(app.closeCalls[0]).toMatchObject({ alwaysConfirm: false, confirmed: false })
  expect(app.closed).toEqual(['t1'])
})

it('K3ⓑ 핀 확인이 꺼져도 실행 중 확인은 남는다 — 실행 중 창(핀 안내 없음)', async () => {
  const app = await mount({ pinned: true, running: true, settings: { confirmClosePinnedTab: false } })
  await app.closeKey()
  expect(app.modal()?.getAttribute('data-confirm-close-kind')).toBe('command')
  expect(app.modal()?.textContent).not.toContain('고정돼 있다')
  expect(app.closed).toEqual([])
})

// --- K4 실행 중 닫기 ---------------------------------------------------------------------------------------

it('K4ⓐ 실행 중 ⌘W → 실행 중 창 + 「실행 중인 터미널에 대해 다시 묻지 않기」 · 체크 + 확인 → 설정 저장 + 닫힘(main 재판정 통과)', async () => {
  const app = await mount({ running: true })
  await app.closeKey()
  expect(app.modal()?.getAttribute('data-confirm-close-kind')).toBe('command')
  expect(app.q('[data-dont-ask-again]')?.textContent).toBe('실행 중인 터미널에 대해 다시 묻지 않기')
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-ok]')
  expect(app.settingsWrites).toEqual([{ skipCloseTerminalWithRunningProcessConfirm: true }])
  expect(app.closed).toEqual(['t1'])
})

it('K4ⓑ 실행 중 확인이 꺼져 있으면 실행 중이어도 창 없이 닫힌다 — main 게이트가 판정(미confirmed 한 번에 closed)', async () => {
  const app = await mount({ running: true, settings: { skipCloseTerminalWithRunningProcessConfirm: true } })
  await app.closeKey()
  expect(app.modal()).toBeNull()
  expect(app.closeCalls).toHaveLength(1)
  expect(app.closeCalls[0]).toMatchObject({ confirmed: false })
  expect(app.closed).toEqual(['t1'])
})

it('K4ⓐ 체크 + 취소 → 저장 안 함 · 창이 다시 열리면 체크 해제', async () => {
  const app = await mount({ running: true })
  await app.closeKey()
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-cancel]')
  expect(app.settingsWrites).toEqual([])
  await app.closeKey()
  expect(app.checkbox().checked).toBe(false)
})

it('K3ⓓ·D2 핀 + 실행 중(둘 다 켜짐) → 한 창(실행 중 문구 + 핀 안내) · 체크박스는 실행 중 설정만 끈다 · 다음 ⌘W 는 핀 창', async () => {
  const app = await mount({ pinned: true, running: true })
  await app.closeKey()
  expect(app.modal()?.getAttribute('data-confirm-close-kind')).toBe('command')
  expect(app.modal()?.textContent).toContain('이 탭은 고정돼 있다.')
  expect(app.q('[data-dont-ask-again]')?.textContent).toBe('실행 중인 터미널에 대해 다시 묻지 않기')
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-cancel]')
  // 취소했으니 아직 묻는다 — 이번엔 확인 대신 체크 + 확인으로 실행 중만 끈다. 탭은 닫히지만 핀 설정은 그대로.
  await app.closeKey()
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-ok]')
  expect(app.settingsWrites).toEqual([{ skipCloseTerminalWithRunningProcessConfirm: true }])
  expect(app.closed).toEqual(['t1'])
})

it('K3ⓓ 핀 + 실행 중 · 실행 중 확인만 꺼짐 → 핀 창(실행 중 줄 없음, 체크박스는 핀 설정)', async () => {
  const app = await mount({ pinned: true, running: true, settings: { skipCloseTerminalWithRunningProcessConfirm: true } })
  await app.closeKey()
  expect(app.modal()?.getAttribute('data-confirm-close-kind')).toBe('pinned')
  expect(app.modal()?.textContent).not.toContain('sleep 600')
  expect(app.q('[data-dont-ask-again]')?.textContent).toBe('고정된 탭에 대해 다시 묻지 않기')
})

it('K3ⓓ 핀 + 실행 중 · 둘 다 꺼짐 → 창 없이 닫힌다', async () => {
  const app = await mount({ pinned: true, running: true, settings: { confirmClosePinnedTab: false, skipCloseTerminalWithRunningProcessConfirm: true } })
  await app.closeKey()
  expect(app.modal()).toBeNull()
  expect(app.closed).toEqual(['t1'])
})

// --- K2 설정 › 일반 ------------------------------------------------------------------------------------------

const openGeneral = async (app) => {
  await app.key({ key: ',', code: 'Comma', metaKey: true })
  await app.click('[data-settings-nav-item="general"]')
}

it('K2ⓑⓓ 일반 — 세 토글이 기본값에서 「켜짐」 · 클릭 = 쓰기 1회(극성 반전 포함) · 꺼진 값도 그대로 보인다', async () => {
  const app = await mount()
  await openGeneral(app)
  const sw = (id) => app.q(`[data-settings-general-row="${id}"] [data-settings-switch]`)
  for (const id of ['confirm-close-pinned-tab', 'confirm-close-running-terminal', 'confirm-delete-worktree']) expect(sw(id).getAttribute('aria-checked')).toBe('true')
  await app.click('[data-settings-general-row="confirm-close-pinned-tab"] [data-settings-switch]')
  await app.click('[data-settings-general-row="confirm-close-running-terminal"] [data-settings-switch]')
  await app.click('[data-settings-general-row="confirm-delete-worktree"] [data-settings-switch]')
  expect(app.settingsWrites).toEqual([{ confirmClosePinnedTab: false }, { skipCloseTerminalWithRunningProcessConfirm: true }, { skipDeleteWorktreeConfirm: true }])
  for (const id of ['confirm-close-pinned-tab', 'confirm-close-running-terminal', 'confirm-delete-worktree']) expect(sw(id).getAttribute('aria-checked')).toBe('false')
  // 소제목 순서 — 탐색(핀 → 실행 중) / 워크스페이스(삭제), Orca 206+.
  expect([...app.q('[data-settings-section="general"]').querySelectorAll('[data-settings-subsection-header] h3')].map((el) => el.textContent)).toEqual(['탐색', '워크스페이스'])
  expect([...app.q('[data-settings-section="general"]').querySelectorAll('[data-settings-general-row]')].map((el) => el.getAttribute('data-settings-general-row'))).toEqual(['confirm-close-pinned-tab', 'confirm-close-running-terminal', 'confirm-delete-worktree'])
})

it('K4ⓕ 「다시 묻지 않음」 으로 끈 뒤 설정 › 일반에서 다시 켜면 다음 ⌘W 부터 다시 묻는다', async () => {
  const app = await mount({ running: true, settings: { skipCloseTerminalWithRunningProcessConfirm: true } })
  await openGeneral(app)
  expect(app.q('[data-settings-general-row="confirm-close-running-terminal"] [data-settings-switch]').getAttribute('aria-checked')).toBe('false')
  await app.click('[data-settings-general-row="confirm-close-running-terminal"] [data-settings-switch]')
  expect(app.settingsWrites).toEqual([{ skipCloseTerminalWithRunningProcessConfirm: false }])
  await app.click('[data-settings-back]')
  await app.closeKey()
  expect(app.modal()?.getAttribute('data-confirm-close-kind')).toBe('command')
  expect(app.closed).toEqual([])
})

// --- K6 카드 레이아웃 두 곳 같은 값 ----------------------------------------------------------------------------

it('K6ⓑⓒⓕ 설정 세그먼트 「간단히」 → 사이드바 카드·옵션 메뉴 라디오 같은 값 · `cardLayoutPreset` 프리셋으로 ui-prefs 저장', async () => {
  const app = await mount()
  expect(app.q('[data-card-layout]')?.getAttribute('data-card-layout')).toBe('detailed')
  await app.key({ key: ',', code: 'Comma', metaKey: true })
  await app.click('[data-settings-nav-item="appearance"]')
  const segment = (value) => app.q(`[data-settings-collapsible="window-sidebar"] [data-segment-value="${value}"]`)
  expect(segment('detailed').getAttribute('aria-checked')).toBe('true')
  expect([segment('detailed').textContent, segment('compact').textContent]).toEqual(['자세히', '간단히'])
  await app.click('[data-settings-collapsible="window-sidebar"] [data-segment-value="compact"]')
  expect(app.uiPrefsWrites.at(-1)).toEqual({ sidebarCardLayout: 'compact', sidebarCardProperties: [...COMPACT_SIDEBAR_CARD_PROPERTIES] })
  expect(segment('compact').getAttribute('aria-checked')).toBe('true')
  await app.click('[data-settings-back]')
  expect(app.q('[data-card-layout]')?.getAttribute('data-card-layout')).toBe('compact')
  await app.click('[data-sidebar-options]')
  await app.click('[data-submenu-trigger="card-layout"]')
  expect(app.q('[data-options-radio="card-layout-compact"]')?.getAttribute('aria-checked')).toBe('true')
  expect(app.q('[data-options-radio="card-layout-detailed"]')?.getAttribute('aria-checked')).toBe('false')
})

it('K6ⓒ 메뉴에서 「자세히」 → 설정 세그먼트가 같은 값(다시 열 때) · 두 경로가 같은 패치', async () => {
  const app = await mount({ cardLayout: 'compact' })
  expect(app.q('[data-card-layout]')?.getAttribute('data-card-layout')).toBe('compact')
  await app.click('[data-sidebar-options]')
  await app.click('[data-submenu-trigger="card-layout"]')
  await app.click('[data-options-radio="card-layout-detailed"]')
  const fromMenu = app.uiPrefsWrites.at(-1)
  expect(fromMenu).toEqual({ sidebarCardLayout: 'detailed', sidebarCardProperties: [...DEFAULT_SIDEBAR_CARD_PROPERTIES] })
  await app.key({ key: ',', code: 'Comma', metaKey: true })
  await app.click('[data-settings-nav-item="appearance"]')
  expect(app.q('[data-settings-collapsible="window-sidebar"] [data-segment-value="detailed"]').getAttribute('aria-checked')).toBe('true')
  await app.click('[data-settings-collapsible="window-sidebar"] [data-segment-value="compact"]')
  await app.click('[data-settings-collapsible="window-sidebar"] [data-segment-value="detailed"]')
  expect(app.uiPrefsWrites.at(-1)).toEqual(fromMenu)
})

// --- fix1 R1-01·R1-02 체크 + 확인 뒤 저장 대기·실패 -------------------------------------------------------------

it('R1-01 저장을 기다리는 동안 취소 → 저장 응답이 와도 닫지 않는다', async () => {
  const app = await mount({ running: true, save: 'held' })
  await app.closeKey()
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-ok]')
  expect(app.settingsWrites).toEqual([{ skipCloseTerminalWithRunningProcessConfirm: true }])
  expect(app.closeCalls.filter((call) => call.confirmed)).toEqual([])
  await app.click('[data-close-confirm-cancel]')
  expect(app.modal()).toBeNull()
  await app.releaseSave()
  expect(app.closed).toEqual([])
  expect(app.closeCalls.filter((call) => call.confirmed)).toEqual([])
})

it('R1-01 저장을 기다리는 동안 확인 두 번 → 확인된 닫기 IPC 는 한 번', async () => {
  const app = await mount({ running: true, save: 'held' })
  await app.closeKey()
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-ok]')
  await app.click('[data-close-confirm-ok]')
  expect(app.settingsWrites).toEqual([{ skipCloseTerminalWithRunningProcessConfirm: true }])
  await app.releaseSave()
  expect(app.closeCalls.filter((call) => call.confirmed)).toHaveLength(1)
  expect(app.closed).toEqual(['t1'])
  expect(app.modal()).toBeNull()
})

it('R1-01 저장 응답이 오면 닫는다(실제 closeTabsGated) · 체크 없이 확인 두 번도 닫기 IPC 한 번', async () => {
  const held = await mount({ running: true, save: 'held' })
  await held.closeKey()
  await held.click('[data-dont-ask-again-input]')
  await held.click('[data-close-confirm-ok]')
  expect(held.closed).toEqual([])
  await held.releaseSave()
  expect(held.closed).toEqual(['t1'])
  expect(held.closeCalls.at(-1)).toMatchObject({ tabIds: ['t1'], confirmed: true, confirmedPaneIds: ['p1'] })
  expect(await held.notice()).toBeNull()
  for (const cleanup of cleanups.splice(0)) cleanup()
  resetSettingsStoreForTest(null)
  const plain = await mount({ running: true })
  await plain.closeKey()
  const ok = plain.q('[data-close-confirm-ok]')
  if (ok === null) throw new Error('확인 버튼 없음')
  await act(async () => { ok.click(); ok.click() })
  await act(async () => {})
  expect(plain.closeCalls.filter((call) => call.confirmed)).toHaveLength(1)
  expect(plain.closed).toEqual(['t1'])
})

it('R1-02 체크 + 확인의 저장이 실패하면 알리고 닫기는 진행한다', async () => {
  const app = await mount({ running: true, save: 'failed' })
  await app.closeKey()
  await app.click('[data-dont-ask-again-input]')
  await app.click('[data-close-confirm-ok]')
  expect(app.closed).toEqual(['t1'])
  expect(await app.notice()).toContain('설정을 저장하지 못해 다음에도 묻습니다')
})

// --- LIFE-527 K4ⓐ 경로 ② — 앱 수준 알림(토스트) ----------------------------------------------------------------
it('LIFE-527 K4ⓐ ② — 팔레트에서 고른 pane 이 그 사이 사라졌으면 「대상 pane이 사라졌습니다」 토스트', async () => {
  const app = await mount()
  // 팔레트의 pane 항목은 연결된 세션에서만 누를 수 있다 — 연결된 상태를 먼저 민다.
  const live = { ...app.state, revision: 2, link: { phase: 'live' } }
  await act(async () => { app.push(live) })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const entry = app.q('[data-palette-entry="pane.switch:p1"]')
  expect(entry).not.toBeNull()
  // pane 이 빠진 상태 push 가 핸들러용 거울(stateRef)에 먼저 닿고 화면이 다시 그려지기 전에 누른다 — 한 act 안의 두 일.
  // UI 로는 이 틈을 만들 수 없다(push 와 렌더가 같은 콜백) — 이 경로는 방어 코드라 격리 실행이 아니라 여기서 일으킨다.
  const gone = { ...live, revision: 3, repos: live.repos.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((worktree) => ({ ...worktree, workspace: { ...worktree.workspace, tabs: [] } })) })) }
  await act(async () => { app.push(gone); entry.click() })
  expect(await app.notice()).toBe('대상 pane이 사라졌습니다')
})
