// @vitest-environment happy-dom
/* global window, document, setTimeout, console, KeyboardEvent, MouseEvent */
// LIFE-824 — App 배선을 실제 마운트로 거친다(App.drag-open.test.mjs 와 같은 걸음). 영역 3개(가로·세로 섞임, 터미널·파일·diff 섞임):
//   g1(왼쪽, 터미널 t1·t2) | g2(오른쪽 위, 파일 a.ts) / g3(오른쪽 아래, diff)
//   · C1 ⌘⌥방향 영역 넘기(경계·파일·diff·편집기 안 ←→·끝 무동작)·이웃 pane 우선·팔레트 항목 켜짐  · C2 ⌃` 영역 MRU·후보 0 안내
//   · C4 ⌃Tab MRU 에 파일 탭·팔레트 편집기 탭 항목  · C5 이전/다음 탭 영역 넘기  · C6 파일 탭 클릭 포커스  · C7 활성 카드 재클릭이 파일 탭을 덮지 않음
//   · C8 각 경로 뒤 활성 영역 = 포커스 영역 · diff·빈 영역 본문 mousedown · ⌘W 가 포커스 영역 탭  · Zⓐⓑ 줌 중 분할·숨은 pane 선택은 줌 해제
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
import { diffTabId } from '../../shared/scm.js'

vi.mock('./TerminalPane.js', () => ({ TerminalPane: () => null, keepTerminalFocus: () => {} }))
vi.mock('./editor/monaco.js', () => {
  const editor = () => ({ setModel: () => {}, saveViewState: () => null, restoreViewState: () => {}, dispose: () => {} })
  return { languageFor: async () => 'plaintext', createModel: ({ text }) => ({ getValue: () => text, setValue: () => {}, dispose: () => {} }), createEditor: editor, createDiffEditor: editor }
})
const { App } = await import('./App.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

class Boundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error: String(error) } }
  render() { return this.state.error === null ? this.props.children : createElement('div', { 'data-render-error': true }, this.state.error) }
}

const cleanups = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); resetSettingsStoreForTest(null) })

const paneOf = (paneId, tabId, workspaceId = 'w1') => ({ paneId, tabId, workspaceId, title: '', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: paneId === 'p1', agentSession: null, digest: EMPTY_SESSION_DIGEST })
const tabOf = (tabId, number, panes, workspaceId = 'w1') => ({ tabId, workspaceId, label: 'zsh', number, order: number - 1, agentStatus: 'idle', focused: tabId === 't1', panes, digest: EMPTY_SESSION_DIGEST })
const FILE = 'file:a.ts'
const DIFF = diffTabId({ mode: 'wt', rel: 'a.ts', orig: null })
const leaf = (groupId, tabOrder, activeTabId = tabOrder[0] ?? null) => ({ kind: 'leaf', group: { groupId, tabOrder, activeTabId } })
const THREE = (activeGroupId = 'g1') => ({
  root: { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('g1', ['t1', 't2']), second: { kind: 'split', direction: 'column', ratio: 0.5, first: leaf('g2', [FILE]), second: leaf('g3', [DIFF]) } },
  activeGroupId,
})
const view = (paneId, x) => ({ paneId, rect: { x, y: 0, width: 40, height: 24 }, innerRect: { x, y: 0, width: 40, height: 24 }, focused: false, mouseReporting: false })

/** 둘째 이후 worktree(fix1 A1 — 교차 worktree): `{ path, workspaceId, panes, layout }`. 첫 worktree 는 `/r`·`w1`(활성). */
async function mount({ layout = THREE(), panes = { t1: ['p1'], t2: ['p2'] }, terminalGroups = [], others = [], readFile = null, neighborOf = null, neighborDelayMs = 0, neighborRejects = 0 } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l824-app-'))
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = { ...new UiPrefsStore(folder).get(), sidebarCollapsed: false, rightPanelOpen: false, rightPanelView: 'explorer', groupLayouts: [{ worktreePath: '/r', layoutFormat: LAYOUT_FORMAT, layout }, ...others.filter((other) => other.layout !== undefined).map((other) => ({ worktreePath: other.path, layoutFormat: LAYOUT_FORMAT, layout: other.layout }))] }
  const gitStatus = { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false }
  const tabs = Object.entries(panes).map(([tabId, ids], index) => tabOf(tabId, index + 1, ids.map((paneId) => paneOf(paneId, tabId))))
  const otherRows = others.map((other, index) => ({
    path: other.path, branch: `b${index}`, isLinked: true, openWorkspaceId: other.workspaceId,
    workspace: { workspaceId: other.workspaceId, label: other.path, number: index + 2, agentStatus: 'idle', focused: false, tabs: Object.entries(other.panes).map(([tabId, ids], tabIndex) => ({ ...tabOf(tabId, tabIndex + 1, ids.map((paneId) => ({ ...paneOf(paneId, tabId, other.workspaceId), focused: false })), other.workspaceId), focused: false })) },
    gitStatus: { branch: `b${index}`, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false }, displayName: null, comment: null, parentPath: '/r',
  }))
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'live' }, backend: { kind: 'ok' },
    registry: { file: path.join(folder, 'registry'), roots: ['/r'], lastError: null }, registryGeneration: 0,
    repos: [{ root: '/r', name: 'r', error: null, worktrees: [{ path: '/r', branch: 'main', isLinked: false, openWorkspaceId: 'w1', workspace: { workspaceId: 'w1', label: 'r', number: 1, agentStatus: 'idle', focused: true, tabs }, gitStatus, displayName: null, comment: null, parentPath: null }, ...otherRows] }],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups, integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] }, herdrTabIds: null,
  }
  const calls = { neighbor: [], zoom: [], split: [], order: [] }
  const neighbor = { next: null }
  const api = {
    getState: async () => state,
    onState: () => () => {},
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    getSettingsSync: () => DEFAULT_SETTINGS,
    setSettings: async () => ({ status: 'saved', settings: DEFAULT_SETTINGS }),
    readFile: readFile ?? (async () => ({ ok: true, kind: 'binary', size: 1, bytesRead: 1, stamp: 's0' })),
    scmRead: async () => ({ ok: true, kind: 'text', text: 'x', size: 1 }),
    setUiPrefs: () => {},
    setShortcutRecording: async () => {},
    focusPaneDirection: async (input) => {
      calls.neighbor.push(input)
      calls.order.push('neighbor')
      if (neighborDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, neighborDelayMs))
      if (calls.neighbor.length <= neighborRejects) throw new Error('ipc rejected')
      return { ok: true, paneId: neighborOf === null ? neighbor.next : (neighborOf[`${input.paneId}:${input.direction}`] ?? null) }
    },
    termZoom: (input) => { calls.zoom.push(input); calls.order.push(`zoom:${input.paneId}`) },
    splitPane: async (input) => { calls.split.push(input); calls.order.push('split'); return { ok: true, paneId: null } },
  }
  const listeners = {}
  api.onRevealPane = (listener) => { listeners.revealPane = listener; return () => {} }
  Reflect.set(window, 'corral', new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) }))
  resetSettingsStoreForTest(null)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Boundary, null, createElement(App))) })
  await act(async () => {})
  cleanups.push(() => { act(() => root.unmount()); host.remove(); fs.rmSync(folder, { recursive: true, force: true }) })
  const q = (selector) => document.querySelector(selector)
  const settle = async (rounds = 3) => { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
  const key = async (init, target = document.activeElement ?? document.body) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    await act(async () => { target.dispatchEvent(event) })
    await settle()
    return event
  }
  const keyUp = async (init) => {
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init })) })
    await settle()
  }
  return {
    q, settle, key, keyUp, calls, neighbor,
    /** main 이 보낸 pane 이동 요청(CLI·Resource 「이동」 — `requestedPane` 길, 포커스 순번을 안 올린다). */
    reveal: async (paneId) => { await act(async () => { listeners.revealPane(paneId) }); await settle(5) },
    active: () => q('.tab-group.is-active-group')?.getAttribute('data-tab-group') ?? null,
    focused: () => document.activeElement?.closest('[data-tab-group]')?.getAttribute('data-tab-group') ?? null,
    activeTabOf: (groupId) => q(`[data-tab-group="${groupId}"] [data-main-tab][data-active="true"]`)?.getAttribute('data-main-tab') ?? null,
    tabsOf: (groupId) => [...document.querySelectorAll(`[data-tab-group="${groupId}"] [data-main-tab]`)].map((tab) => tab.getAttribute('data-main-tab')),
    noticeTitle: () => q('.inline-notice-text')?.getAttribute('title') ?? null,
    mouse: async (type, target) => { await act(async () => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })) }); await settle() },
  }
}

const ARROW = { left: { key: 'ArrowLeft' }, right: { key: 'ArrowRight' }, up: { key: 'ArrowUp' }, down: { key: 'ArrowDown' } }
const cmdAlt = (direction) => ({ ...ARROW[direction], metaKey: true, altKey: true })

it('C1ⓑⓒⓔ·C8 — ⌘⌥방향: 터미널 경계 → 이웃 영역, 파일·diff 에서도 영역 이동, 끝이면 무동작. 매번 활성 영역 = 포커스 영역', async () => {
  const app = await mount()
  expect(app.q('[data-render-error]')).toBeNull()
  expect(app.active()).toBe('g1')
  await app.key(cmdAlt('right'))
  expect(app.calls.neighbor).toEqual([{ paneId: 'p1', direction: 'right' }]) // ⓐ 먼저 같은 탭 이웃 pane 을 묻는다 — 없으면(null) 영역으로
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
  await app.key(cmdAlt('down')) // 파일 탭(편집기 밖) — pane 을 묻지 않고 영역
  expect(app.active()).toBe('g3')
  expect(app.focused()).toBe('g3')
  expect(app.calls.neighbor).toHaveLength(1)
  await app.key(cmdAlt('left')) // diff 탭 → 왼쪽 터미널 영역
  expect(app.active()).toBe('g1')
  await app.key(cmdAlt('left')) // ⓔ 왼쪽 끝 — 무동작
  expect(app.active()).toBe('g1')
  await app.key(cmdAlt('up'))
  expect(app.active()).toBe('g1')
})

it('C1ⓐ — 같은 탭에 그 방향 이웃 pane 이 있으면 base 그대로(그 pane, 영역 그대로)', async () => {
  const app = await mount({ panes: { t1: ['p1', 'p9'], t2: ['p2'] } })
  app.neighbor.next = 'p9'
  await app.key(cmdAlt('right'))
  expect(app.calls.neighbor).toEqual([{ paneId: 'p1', direction: 'right' }])
  expect(app.active()).toBe('g1')
})

it('C1ⓓ — 편집기 안: ⌘⌥↑ 는 편집기에 양보(영역 그대로·키 안 삼킴), ⌘⌥← 는 앱이 가져가 영역 이동', async () => {
  const app = await mount({ layout: THREE('g2') })
  const editor = document.createElement('div')
  editor.setAttribute('data-file-editor', '')
  editor.tabIndex = -1
  app.q('[data-tab-group="g2"] [data-file-view]')?.append(editor)
  const up = await app.key(cmdAlt('up'), editor)
  expect(up.defaultPrevented).toBe(false)
  expect(app.active()).toBe('g2')
  const shiftLeft = await app.key({ ...cmdAlt('left'), shiftKey: true }, editor) // ⌘⌥⇧← 열 선택 — 양보
  expect(shiftLeft.defaultPrevented).toBe(false)
  expect(app.active()).toBe('g2')
  const left = await app.key(cmdAlt('left'), editor)
  expect(left.defaultPrevented).toBe(true)
  expect(app.active()).toBe('g1')
})

it('C1ⓕ — 팔레트 「인접 pane / 영역 포커스」 가 파일·diff 탭에서도 켜지고 같은 동작(diff 무음 실패 0)', async () => {
  const app = await mount({ layout: THREE('g3') })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const up = app.q('[data-palette-entry="terminal.focus:2"]')
  expect(up?.getAttribute('aria-disabled')).toBe('false')
  expect(up?.textContent).toContain('인접 pane / 영역 포커스')
  await app.mouse('click', up)
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  expect(app.q('[data-palette-entry="terminal.focus:0"]')?.getAttribute('aria-disabled')).toBe('false')
  await app.mouse('click', app.q('[data-palette-entry="terminal.focus:0"]'))
  expect(app.active()).toBe('g1')
})

it('C2 — ⌃`: 터미널 → 영역 MRU 최근 편집기 영역, 편집기 → 터미널, 편집기 안에서도 동작', async () => {
  const app = await mount()
  await app.key(cmdAlt('right')) // g2
  await app.key(cmdAlt('down')) // g3
  await app.key(cmdAlt('left')) // g1 — 영역 MRU: g1, g3, g2
  const toggle = { key: '`', code: 'Backquote', ctrlKey: true }
  await app.key(toggle)
  expect(app.active()).toBe('g3')
  expect(app.focused()).toBe('g3')
  await app.key(toggle)
  expect(app.active()).toBe('g1')
  await app.key(cmdAlt('right')) // g2 — MRU 최근 편집기 = g2
  await app.key(cmdAlt('left'))
  const editor = document.createElement('div')
  editor.setAttribute('data-file-editor', '')
  app.q('[data-tab-group="g2"] [data-file-view]')?.append(editor)
  await app.key(toggle)
  expect(app.active()).toBe('g2')
  const inEditor = await app.key(toggle, editor) // 편집기 안 — 양보하지 않는다
  expect(inEditor.defaultPrevented).toBe(true)
  expect(app.active()).toBe('g1')
})

it('C2 — 후보 0(편집기 영역 없음)이면 안내 한 줄', async () => {
  const app = await mount({ layout: { root: leaf('g1', ['t1', 't2']), activeGroupId: 'g1' } })
  await app.key({ key: '`', code: 'Backquote', ctrlKey: true })
  expect(app.active()).toBe('g1')
  expect(app.noticeTitle()).toContain('편집기 영역이 없습니다')
})

it('C4ⓐ — ⌃Tab MRU 에 파일 탭이 활성된 순서로 들고, 확정하면 그 영역 활성 + 본문 포커스', async () => {
  const app = await mount()
  await app.key(cmdAlt('right')) // 파일 탭 활성 → MRU 에 찍힘
  await app.key(cmdAlt('left')) // 터미널로 돌아옴 → p1 다시 맨 앞
  await app.key({ key: 'Tab', code: 'Tab', ctrlKey: true })
  const rows = [...document.querySelectorAll('[data-mru-row]')].map((row) => row.getAttribute('data-mru-row'))
  expect(rows[0]).toBe('p1')
  expect(rows[1]).toContain(FILE) // 방금 떠난 파일 탭이 두 번째(홀드가 고른 자리)
  expect(rows.some((row) => row?.includes(DIFF))).toBe(false) // fix1 A6 — 한 번도 활성 안 된 편집기 탭은 후보가 아니다(C4ⓐ 활성된 순서 · C4ⓔ)
  expect(rows).toContain('p2') // 터미널은 안 고른 것도 꼬리에(base 그대로)
  expect(app.q('[data-mru-row][data-mru-selected="true"]')?.textContent).toContain('a.ts')
  await app.keyUp({ key: 'Control' })
  expect(app.q('[data-mru]')).toBeNull()
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
})

it('C4ⓒ — 팔레트에 파일·diff 탭 전환 항목(터미널 pane.switch 와 나란히) — 고르면 그 영역 활성 + 본문 포커스', async () => {
  const app = await mount()
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const ids = [...document.querySelectorAll('[data-palette-entry]')].map((entry) => entry.getAttribute('data-palette-entry'))
  expect(ids.some((id) => id?.startsWith('pane.switch:p1'))).toBe(true)
  const diffEntry = [...document.querySelectorAll('[data-palette-entry^="editor.switch:"]')].find((entry) => entry.getAttribute('data-palette-entry')?.endsWith(DIFF))
  expect(diffEntry).toBeDefined()
  expect(ids.filter((id) => id?.startsWith('editor.switch:'))).toHaveLength(2)
  await app.mouse('click', diffEntry)
  expect(app.active()).toBe('g3')
  expect(app.focused()).toBe('g3')
})

it('C5 — 이전/다음 탭이 영역 끝에서 다음 영역 첫 탭으로, 마지막 → 첫 영역(wrap), 고른 탭 본문 포커스', async () => {
  const app = await mount()
  const next = { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true }
  const prev = { key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true }
  await app.key(next)
  expect([app.active(), app.activeTabOf('g1')]).toEqual(['g1', 't2'])
  await app.key(next)
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
  await app.key(next)
  expect(app.active()).toBe('g3')
  expect(app.focused()).toBe('g3')
  await app.key(next)
  expect([app.active(), app.activeTabOf('g1')]).toEqual(['g1', 't1'])
  await app.key(prev)
  expect(app.active()).toBe('g3')
  // ⌃1~9 는 영역 안 그대로(base)
  await app.key({ key: '1', code: 'Digit1', ctrlKey: true })
  expect(app.active()).toBe('g3')
})

it('C6·C8 — 파일 탭 클릭은 본문 포커스, diff 본문 mousedown 은 그 영역 활성, ⌘W 는 포커스 영역의 탭', async () => {
  const app = await mount()
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
  await app.mouse('mousedown', app.q('[data-diff-group="g3"]'))
  expect(app.active()).toBe('g3')
  await app.key(cmdAlt('up'))
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
  await app.key({ key: 'w', code: 'KeyW', metaKey: true })
  expect(app.tabsOf('g2')).toEqual([])
  expect(app.tabsOf('g1')).toEqual(['t1', 't2'])
  expect(app.tabsOf('g3')).toEqual([DIFF])
})

it('C8 — 빈 영역 본문 mousedown 은 그 영역을 활성으로(EmptyGroup 배선 — 영역이 둘 이상이면 배치가 빈 영역을 접어 App 에선 한 영역일 때만 선다)', async () => {
  const { EmptyGroup } = await import('./components/EmptyGroup.js')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const activated = []
  await act(async () => { root.render(createElement(EmptyGroup, { groupId: 'g4', activeGroup: false, onActivate: () => activated.push('g4'), onCreateShell: () => {}, onCloseGroup: null, isDropTarget: false })) })
  cleanups.push(() => { act(() => root.unmount()); host.remove() })
  const body = document.querySelector('[data-empty-group="g4"]')
  await act(async () => { body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  expect(activated).toEqual(['g4'])
  expect(body.getAttribute('tabindex')).toBe('-1')
})

it('C7 — 이미 활성인 worktree 카드 재클릭이 보던 파일 탭을 덮지 않는다(그 영역·탭 그대로 + 본문 포커스)', async () => {
  const app = await mount({ layout: THREE('g2') })
  expect(app.active()).toBe('g2')
  const surface = app.q('[data-worktree="/r"] [data-worktree-card-surface]')
  expect(surface).not.toBeNull()
  await app.mouse('click', surface)
  expect(app.active()).toBe('g2')
  expect(app.activeTabOf('g2')).toBe(FILE)
  expect(app.activeTabOf('g1')).toBe('t1')
  expect(app.focused()).toBe('g2')
})

it('Zⓐ — 줌 중 ⌘D 분할은 줌을 먼저 푼다', async () => {
  const terminalGroups = [{ groupId: 'g1', tabId: 't1', phase: 'streaming', grid: { cols: 80, rows: 24 }, panes: [view('p1', 0)], zoomedPaneId: 'p1', lastError: null }]
  const app = await mount({ panes: { t1: ['p1', 'p9'], t2: ['p2'] }, terminalGroups })
  await app.key({ key: 'd', code: 'KeyD', metaKey: true })
  expect(app.calls.zoom.map((call) => [call.groupId, call.paneId])).toEqual([['g1', null]])
  expect(app.calls.order).toEqual(['zoom:null', 'split'])
})

it('Zⓑ — 줌 중 ⌘⌥방향이 숨은 pane 을 고르면 줌을 풀고 그 pane, 줌한 pane 이면 줌 그대로', async () => {
  const terminalGroups = [{ groupId: 'g1', tabId: 't1', phase: 'streaming', grid: { cols: 80, rows: 24 }, panes: [view('p1', 0)], zoomedPaneId: 'p1', lastError: null }]
  const app = await mount({ panes: { t1: ['p1', 'p9'], t2: ['p2'] }, terminalGroups })
  app.neighbor.next = 'p1' // 자기 자신(줌한 pane) — 풀지 않는다
  await app.key(cmdAlt('left'))
  expect(app.calls.zoom).toEqual([])
  app.neighbor.next = 'p9'
  await app.key(cmdAlt('right'))
  expect(app.calls.zoom.map((call) => [call.groupId, call.paneId])).toEqual([['g1', null]])
  expect(app.active()).toBe('g1')
})

// --- fix1 (r1 리뷰 반영) ---------------------------------------------------------------------------------------------------------

const R2 = { path: '/r2', workspaceId: 'w2', panes: { t3: ['p3'] } }
const R3 = { path: '/r3', workspaceId: 'w3', panes: { t4: ['p4'] } }
const FILE_B = 'file:b.ts'
/** /r2 저장 배치 — 왼쪽 터미널 t3 | 오른쪽 파일 b.ts. */
const r2Layout = (activeGroupId) => ({ root: { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('h1', ['t3']), second: leaf('h2', [FILE_B]) }, activeGroupId })
const card = (app, path) => app.q(`[data-worktree="${path}"] [data-worktree-card-surface]`)

it('fix1 A1·C7 — 비활성 worktree 카드: 저장 활성 탭이 파일이면 그 worktree 로 가서 그 탭 활성 + 본문 포커스(미뤄 둔 포커스 길)', async () => {
  const app = await mount({ others: [{ ...R2, layout: r2Layout('h2') }] })
  expect(app.active()).toBe('g1')
  await app.mouse('click', card(app, '/r2'))
  await app.settle(5)
  expect(app.active()).toBe('h2')
  expect(app.activeTabOf('h2')).toBe(FILE_B)
  expect(app.focused()).toBe('h2')
})

it('fix1 A1·A3·C4ⓐ — 다른 worktree 의 편집기 탭: ⌃Tab ⇄ 행 확정으로 그 worktree·영역 활성 + 본문 포커스, 도착 뒤 MRU 맨 앞은 그 편집기', async () => {
  const app = await mount({ others: [{ ...R2, layout: r2Layout('h2') }] })
  await app.mouse('click', card(app, '/r2')) // b.ts 를 본다(기록) — 워크스페이스 전환이 선택 pane 을 p3 으로 바꿔도 맨 앞은 b.ts(A3)
  await app.settle(5)
  await app.key({ key: 'Tab', code: 'Tab', ctrlKey: true })
  const first = [...document.querySelectorAll('[data-mru-row]')].map((row) => row.getAttribute('data-mru-row'))
  expect(first[0]).toContain(FILE_B)
  await app.keyUp({ key: 'Escape' })
  await app.key({ key: 'Escape' })
  await app.mouse('click', card(app, '/r')) // /r 로 돌아온다(g1 터미널)
  await app.settle(5)
  expect(app.active()).toBe('g1')
  await app.key({ key: 'Tab', code: 'Tab', ctrlKey: true })
  const row = app.q('[data-mru-row][data-mru-selected="true"]')
  expect(row?.getAttribute('data-mru-row')).toContain(FILE_B)
  expect(row?.querySelector('.mru-row-place')?.textContent).toBe('⇄')
  await app.keyUp({ key: 'Control' })
  await app.settle(5)
  expect(app.active()).toBe('h2')
  expect(app.focused()).toBe('h2')
})

it('fix1 A1·C4ⓒ — 팔레트 editor.switch 로 다른 worktree 의 파일 탭(저장 활성은 터미널)', async () => {
  const app = await mount({ others: [{ ...R2, layout: r2Layout('h1') }] })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const entry = [...document.querySelectorAll('[data-palette-entry^="editor.switch:"]')].find((row) => row.getAttribute('data-palette-entry')?.endsWith(FILE_B))
  expect(entry).toBeDefined()
  await app.mouse('click', entry)
  await app.settle(5)
  expect(app.active()).toBe('h2')
  expect(app.activeTabOf('h2')).toBe(FILE_B)
  expect(app.focused()).toBe('h2')
})

it('fix1 A1 — 미뤄 둔 포커스의 수명: 전환 전에 다른 worktree 로 가 버리면 버린다(나중에 그 worktree 에 들어가도 옛 편집기가 포커스를 가져가지 않음)', async () => {
  const app = await mount({ others: [{ ...R2, layout: r2Layout('h1') }, { ...R3, layout: { root: leaf('k1', ['t4']), activeGroupId: 'k1' } }] })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const entry = [...document.querySelectorAll('[data-palette-entry^="editor.switch:"]')].find((row) => row.getAttribute('data-palette-entry')?.endsWith(FILE_B))
  // 같은 틱에 /r2 편집기로 가는 요청 + /r3 카드 클릭 — /r2 배치가 오기 전에 /r3 으로 간다
  await act(async () => {
    entry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    card(app, '/r3').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
  await app.settle(5)
  expect(app.active()).toBe('k1')
  await app.mouse('click', card(app, '/r2')) // 저장 활성은 터미널 h1 — 그대로여야 한다
  await app.settle(5)
  expect(app.active()).toBe('h1')
  expect(app.activeTabOf('h2')).toBe(FILE_B)
  expect(app.focused()).not.toBe('h2')
})

it('fix1 A2 — ⌘⌥→ 연타(응답 60ms 지연): 둘째 키가 첫 키 결과를 보고 경계를 넘는다(p1 → p9 → g2)', async () => {
  const app = await mount({ panes: { t1: ['p1', 'p9'], t2: ['p2'] }, neighborOf: { 'p1:right': 'p9' }, neighborDelayMs: 60 })
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...cmdAlt('right') }))
    await new Promise((resolve) => setTimeout(resolve, 15))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...cmdAlt('right') }))
  })
  await app.settle(12)
  expect(app.calls.neighbor).toEqual([{ paneId: 'p1', direction: 'right' }, { paneId: 'p9', direction: 'right' }])
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
})

it('fix1 A2 — 응답 전에 다른 영역을 누르면 늦은 응답이 그 조작을 덮지 않는다', async () => {
  const app = await mount({ neighborOf: {}, neighborDelayMs: 60 })
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...cmdAlt('down') })) // g1 아래 = 없음(응답 null) — 옛 길은 응답 뒤 배치로 g2 의 아래(g3)를 골랐다
  })
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  expect(app.active()).toBe('g2')
  await app.settle(8)
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
})

it('fix1 A8 — 편집기를 기다리는 동안 다른 영역으로 옮기면 늦게 붙은 편집기가 포커스를 가져가지 않는다', async () => {
  const app = await mount({ readFile: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, kind: 'binary', size: 1, bytesRead: 1, stamp: 's0' }), 200)) })
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`)) // 파일 로딩 중 — 포커스 대기
  expect(app.q('[data-tab-group="g2"] [data-file-notice="loading"]')).not.toBeNull()
  await app.key(cmdAlt('down')) // g2 → g3 (diff 본문 포커스)
  expect(app.active()).toBe('g3')
  await app.settle(15) // 파일이 붙는다
  expect(app.q('[data-tab-group="g2"] [data-file-notice="loading"]')).toBeNull()
  expect(app.active()).toBe('g3')
  expect(app.focused()).toBe('g3')
})

it('fix1 A12 — 팔레트 줌·분할은 파일·diff 탭 둘 다에서 흐림 + 이유', async () => {
  const app = await mount({ layout: THREE('g3') })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  for (const id of ['terminal.zoom:0', 'terminal.split:0', 'terminal.split:1']) {
    const entry = app.q(`[data-palette-entry="${id}"]`)
    expect(entry?.getAttribute('aria-disabled')).toBe('true')
    expect(entry?.textContent).toContain('파일·diff 탭에서는 쓸 수 없습니다')
  }
  expect(app.q('[data-palette-entry="terminal.focus:0"]')?.getAttribute('aria-disabled')).toBe('false')
})

// --- fix2 (r2 리뷰 반영) ---------------------------------------------------------------------------------------------------------

/** g1 = 터미널 t1 + 파일 a.ts | g2 = 터미널 t2. */
const MIXED = () => ({ root: { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('g1', ['t1', FILE], 't1'), second: leaf('g2', ['t2']) }, activeGroupId: 'g1' })
const pressLater = async (direction, then) => {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...cmdAlt(direction) }))
    await new Promise((resolve) => setTimeout(resolve, 15))
    then()
  })
}

it('fix2 B1 — ⌘⌥→ 응답 전에 같은 영역 파일 탭을 누르면 늦은 null 응답이 활성 영역을 옮기지 않는다', async () => {
  const app = await mount({ layout: MIXED(), neighborOf: {}, neighborDelayMs: 200 })
  const tab = app.q(`[data-tab-group="g1"] [data-main-tab="${FILE}"]`)
  await pressLater('right', () => {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
  await app.settle(15)
  expect(app.calls.neighbor).toEqual([{ paneId: 'p1', direction: 'right' }])
  expect(app.active()).toBe('g1')
  expect(app.activeTabOf('g1')).toBe(FILE)
  expect(app.focused()).toBe('g1')
})

it('fix2 B1·B2 — ⌘⌥→ 응답 전에 ⌃2(같은 영역 파일 탭)를 누르면 늦은 null 응답이 활성 영역을 옮기지 않는다', async () => {
  const app = await mount({ layout: MIXED(), neighborOf: {}, neighborDelayMs: 200 })
  await pressLater('right', () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '2', code: 'Digit2', ctrlKey: true }))
  })
  await app.settle(15)
  expect(app.calls.neighbor).toHaveLength(1)
  expect(app.active()).toBe('g1')
  expect(app.activeTabOf('g1')).toBe(FILE)
})

it('fix2 B2 — 파일을 기다리는 동안 터미널 탭을 마우스로 누르면 늦게 붙은 파일 보기가 포커스를 가져가지 않는다', async () => {
  const app = await mount({ readFile: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, kind: 'binary', size: 1, bytesRead: 1, stamp: 's0' }), 200)) })
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  expect(app.q('[data-tab-group="g2"] [data-file-notice="loading"]')).not.toBeNull()
  await app.mouse('click', app.q('[data-tab-group="g1"] [data-main-tab="t2"]'))
  expect(app.active()).toBe('g1')
  await app.settle(15)
  expect(app.q('[data-tab-group="g2"] [data-file-notice="loading"]')).toBeNull()
  expect(app.active()).toBe('g1')
  expect(app.focused()).not.toBe('g2')
})

const R3_EMPTY = { path: '/r3', workspaceId: 'w3', panes: {} }
const pickEditorB = () => [...document.querySelectorAll('[data-palette-entry^="editor.switch:"]')].find((row) => row.getAttribute('data-palette-entry')?.endsWith(FILE_B))

it('fix2 B3 떠난 자리 — 순번을 안 올리는 이탈(첫 탭 규칙 카드)로 다른 worktree 에 갔다가, 순번 없이(requestedPane) 목적지에 들어가도 옛 편집기가 펼쳐지지 않는다', async () => {
  const app = await mount({ others: [{ ...R2, layout: r2Layout('h1') }, R3_EMPTY] })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const entry = pickEditorB()
  await act(async () => {
    entry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    card(app, '/r3').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) // 탭 0 → 옛 규칙(activateWorkspace 만)
  })
  await app.settle(5)
  expect(app.q('[data-tab-group="h2"]')).toBeNull() // /r2 에 아직 안 들어갔다
  await app.reveal('p3') // /r2 의 터미널 pane 으로 — 순번 안 오름
  expect(app.active()).toBe('h1')
  expect(app.activeTabOf('h2')).toBe(FILE_B)
  expect(app.focused()).not.toBe('h2')
})

it('fix2 B3 순번 — 같은 worktree 안 탭 클릭(순번 오름)으로 떠나지 않고 다른 이동을 했으면, 뒤에 순번 없이 목적지에 들어가도 펼쳐지지 않는다', async () => {
  const app = await mount({ others: [{ ...R2, layout: r2Layout('h1') }] })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const entry = pickEditorB()
  await act(async () => {
    entry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    app.q('[data-tab-group="g1"] [data-main-tab="t2"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
  await app.settle(5)
  expect(app.active()).toBe('g1') // 떠난 자리(/r)에 머문다 — 떠난 자리 조건으로는 안 버려진다
  await app.reveal('p3')
  expect(app.active()).toBe('h1')
  expect(app.focused()).not.toBe('h2')
})

it('fix2 B4 — focusPaneDirection 이 거절돼도 경고를 남기고 다음 ⌘⌥방향은 그대로 동작한다', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const app = await mount({ neighborOf: {}, neighborRejects: 1 })
    await app.key(cmdAlt('right'))
    expect(app.active()).toBe('g1')
    expect(warn.mock.calls.some((call) => String(call[0]).includes('인접 pane / 영역 포커스 실패'))).toBe(true)
    await app.key(cmdAlt('right'))
    await app.settle(5)
    expect(app.calls.neighbor).toHaveLength(2)
    expect(app.active()).toBe('g2')
  } finally {
    warn.mockRestore()
  }
})

it('fix2 B4 — 키 반복이 줄에 쌓이지 않는다(진행 중 하나 + 대기 하나까지)', async () => {
  const app = await mount({ panes: { t1: ['p1', 'p9'], t2: ['p2'] }, neighborOf: { 'p1:down': 'p9', 'p9:down': 'p1' }, neighborDelayMs: 60 })
  await act(async () => {
    for (let i = 0; i < 5; i += 1) document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...cmdAlt('down') }))
  })
  await app.settle(20)
  expect(app.calls.neighbor).toHaveLength(2)
})

it('fix2 B5 — 영역을 닫고 같은 id 로 새 영역이 생겨도 ⌃` 후보는 지금 영역의 최근 순서', async () => {
  const FILE_C = 'file:c.ts'
  const layout = { root: { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('g1', ['t1']), second: { kind: 'split', direction: 'column', ratio: 0.5, first: leaf('g2', [DIFF]), second: leaf('g3', [FILE, FILE_C], FILE_C) } }, activeGroupId: 'g1' }
  const app = await mount({ layout })
  await app.mouse('mousedown', app.q('[data-diff-group="g2"]')) // 영역 MRU: g2 가 g3 보다 최근
  await app.mouse('click', app.q('[data-tab-group="g1"] [data-main-tab="t1"]'))
  await app.key({ key: '`', code: 'Backquote', ctrlKey: true })
  expect(app.active()).toBe('g2')
  await app.key({ key: 'w', code: 'KeyW', metaKey: true, altKey: true }) // g2 닫기
  expect(app.q('[data-tab-group="g2"]')).toBeNull()
  await app.mouse('click', app.q(`[data-tab-group="g3"] [data-main-tab="${FILE_C}"]`))
  await app.key({ key: 'd', code: 'KeyD', metaKey: true, altKey: true }) // c.ts 를 새 영역으로 — 비어 있는 id g2 를 다시 쓴다
  expect(app.activeTabOf('g2')).toBe(FILE_C)
  await app.mouse('click', app.q(`[data-tab-group="g3"] [data-main-tab="${FILE}"]`)) // 지금은 g3 가 새 g2 보다 최근
  await app.mouse('click', app.q('[data-tab-group="g1"] [data-main-tab="t1"]'))
  await app.key({ key: '`', code: 'Backquote', ctrlKey: true })
  expect(app.active()).toBe('g3')
})

it('fix2 B2 — ⌃1–9 로 터미널 탭(activateTab 길)으로 옮기면 순번이 올라, 미뤄 둔 편집기 포커스가 뒤에 순번 없이 목적지에 들어가도 펼쳐지지 않는다', async () => {
  const app = await mount({ others: [{ ...R2, layout: r2Layout('h2') }] })
  await act(async () => {
    card(app, '/r2').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) // 저장 활성 = 파일 → 미뤄 둔 포커스
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '2', code: 'Digit2', ctrlKey: true })) // 그 전에 /r 에서 ⌃2
  })
  await app.settle(5)
  expect(app.activeTabOf('g1')).toBe('t2')
  await app.reveal('p3') // 순번 없이 /r2 의 터미널로 — 옛 편집기(h2)로 가지 않는다
  expect(app.active()).toBe('h1')
  expect(app.focused()).not.toBe('h2')
})

// --- fix3 (r3 리뷰 반영) ---------------------------------------------------------------------------------------------------------

const slowFile = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, kind: 'binary', size: 1, bytesRead: 1, stamp: 's0' }), 200))

it('fix3 C-1 — 파일을 기다리는 동안 main 의 pane 이동 요청(requestedPane, 순번 안 오름)이 다른 영역으로 옮기면 늦게 붙은 파일 보기가 포커스를 가져가지 않는다', async () => {
  const app = await mount({ readFile: slowFile })
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  expect(app.q('[data-tab-group="g2"] [data-file-notice="loading"]')).not.toBeNull()
  await app.reveal('p1')
  expect(app.active()).toBe('g1')
  await app.settle(15)
  expect(app.q('[data-tab-group="g2"] [data-file-notice="loading"]')).toBeNull()
  expect(app.active()).toBe('g1')
  expect(app.focused()).not.toBe('g2')
})

it('fix3 C-2① — 파일을 기다리는 동안 ⌃` 로 터미널 영역에 가면 늦게 붙은 파일 보기가 포커스를 가져가지 않는다', async () => {
  const app = await mount({ readFile: slowFile })
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  await app.key({ key: '`', code: 'Backquote', ctrlKey: true })
  expect(app.active()).toBe('g1')
  await app.settle(15)
  expect(app.q('[data-tab-group="g2"] [data-file-notice="loading"]')).toBeNull()
  expect(app.active()).toBe('g1')
  expect(app.focused()).not.toBe('g2')
})

it('fix3 C-2① — 파일을 기다리는 동안 ⌘⌥ 로 다른 영역 터미널에 가서 이웃 pane 으로 옮겨도 늦게 붙은 파일 보기가 포커스를 가져가지 않는다', async () => {
  const app = await mount({ readFile: slowFile, panes: { t1: ['p1', 'p9'], t2: ['p2'] }, neighborOf: { 'p1:down': 'p9' } })
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  await app.key(cmdAlt('left')) // g2 → g1 (터미널)
  await app.key(cmdAlt('down')) // 같은 탭 이웃 pane p9
  expect(app.calls.neighbor.at(-1)).toEqual({ paneId: 'p1', direction: 'down' })
  expect(app.active()).toBe('g1')
  await app.settle(15)
  expect(app.active()).toBe('g1')
  expect(app.focused()).not.toBe('g2')
})

it('fix3 C-2② — 미뤄 둔 편집기 포커스가 drop 인 채(그 사이 다른 포커스 이동) 목적지 worktree 에 들어오면 펼치지 않는다', async () => {
  const app = await mount({ others: [{ ...R2, layout: r2Layout('h1') }] })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const entry = pickEditorB()
  await act(async () => {
    entry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) // /r2 로 전환 시작 + 미뤄 둔 포커스
    app.q('[data-diff-group="g3"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })) // 같은 틱 다른 포커스 이동(순번 오름, worktree 는 그대로 /r2 로 간다)
  })
  await app.settle(5)
  expect(app.q('[data-tab-group="h1"]')).not.toBeNull() // 목적지(/r2)에 들어왔다
  expect(app.active()).toBe('h1')
  expect(app.focused()).not.toBe('h2')
})

it('fix3 C-3 — 줄에 대기 중인 ⌘⌥ 키는 그 사이 클릭이 있으면 버린다(클릭한 상태에서 옛 키가 실행되지 않음)', async () => {
  const app = await mount({ neighborOf: {}, neighborDelayMs: 60 })
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...cmdAlt('left') }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...cmdAlt('left') })) // 줄에 대기
  })
  await app.mouse('mousedown', app.q('[data-diff-group="g3"]')) // 응답 전에 g3 클릭
  expect(app.active()).toBe('g3')
  await app.settle(10)
  expect(app.calls.neighbor).toHaveLength(1)
  expect(app.active()).toBe('g3') // 옛 둘째 키가 g3 에서 ← 로 g1 에 가지 않는다
})
