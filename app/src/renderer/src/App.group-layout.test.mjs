// @vitest-environment happy-dom
/* global window, document, setTimeout, KeyboardEvent, MouseEvent */
// LIFE-825 — 영역 레이아웃 조작의 App 배선(App.group-focus.test.mjs 의 마운트를 따른다). 영역 3개(가로·세로 섞임, 터미널·파일·diff 섞임):
//   g1(왼쪽, 터미널 t1·t2) | g2(오른쪽 위, 파일 a.ts) / g3(오른쪽 아래, diff)
//   · C1 ⌘⌥W·헤더 ✕ 목적지(영역 MRU → 공간 이웃)·본문 포커스  · C2 경계 더블클릭  · C3 균등화(⊞·팔레트, 영역 1개 흐림)
//   · C4 ⌘⌥Enter 최대화·해제 조건·저장 0·영역 1개 안내  · C5 새 터미널 탭 자리(요청 순간 기억·앱 밖 도착)  · C6 비활성 영역 우클릭 포커스  · C7 활성 = 포커스
import { act, Component, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeybindingStore } from '../../main/keybindings.js'
import { UiPrefsStore } from '../../main/ui-prefs.js'
import { DEFAULT_SETTINGS } from '../../shared/terminal-settings.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { emptyAgentState } from '../../shared/agent-state.js'
import { resetSettingsStoreForTest } from './settings-store.js'
import { LAYOUT_FORMAT } from './group-tree.js'
import { diffTabId } from '../../shared/scm.js'

/**
 * 가짜 TerminalPane — 진짜와 같은 규칙(`focusToken` 이 바뀌고 0 이 아니며 `focusable` 일 때 포커스, TerminalPane.tsx:551-557)으로 **포커스 가능한 본문**을 낸다(fix2 D2).
 * 포커스한 pane 은 `termFocusLog` 에 남는다 — 「메뉴 닫힘이 본문 포커스 길(focusGroupTab → selectPane → focusToken)을 탔나」를 본다.
 */
const termFocusLog = []
vi.mock('./TerminalPane.js', async () => {
  const React = await import('react')
  return {
    TerminalPane: ({ paneId, focusable = false, focusToken = 0 }) => {
      const ref = React.useRef(null)
      const focusableRef = React.useRef(focusable)
      focusableRef.current = focusable
      React.useEffect(() => {
        if (focusToken === 0 || !focusableRef.current) return
        termFocusLog.push(paneId)
        ref.current?.focus()
      }, [focusToken])
      return React.createElement('div', { ref, tabIndex: -1, 'data-fake-term': paneId })
    },
    keepTerminalFocus: () => {},
  }
})
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

/** 둘째 이후 worktree(fix1 A1 — 교차 worktree): `{ path, workspaceId, panes, layout }`. 첫 worktree 는 `/r`·`w1`(활성). */
async function mount({ layout = THREE(), panes = { t1: ['p1'], t2: ['p2'] }, terminalGroups = [], others = [], readFile = null, neighborOf = null, neighborDelayMs = 0, neighborRejects = 0, createRow = null, prefsPatch = {} } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l825-app-'))
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = { ...new UiPrefsStore(folder).get(), sidebarCollapsed: false, rightPanelOpen: false, rightPanelView: 'explorer', groupLayouts: [{ worktreePath: '/r', layoutFormat: LAYOUT_FORMAT, layout }, ...others.filter((other) => other.layout !== undefined).map((other) => ({ worktreePath: other.path, layoutFormat: LAYOUT_FORMAT, layout: other.layout }))], ...prefsPatch }
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
  const calls = { neighbor: [], zoom: [], split: [], order: [], create: [], prefs: [], sync: [], closeTabs: [] }
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
    setUiPrefs: (patch) => { calls.prefs.push(patch) },
    syncTermGroups: (requests) => { calls.sync.push(requests) },
    createRow: async (input) => { calls.create.push(input); return createRow === null ? { ok: false, error: 'no' } : createRow(input) },
    setShortcutRecording: async () => {},
    focusPaneDirection: async (input) => {
      calls.neighbor.push(input)
      calls.order.push('neighbor')
      if (neighborDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, neighborDelayMs))
      if (calls.neighbor.length <= neighborRejects) throw new Error('ipc rejected')
      return { ok: true, paneId: neighborOf === null ? neighbor.next : (neighborOf[`${input.paneId}:${input.direction}`] ?? null) }
    },
    termZoom: (input) => { calls.zoom.push(input); calls.order.push(`zoom:${input.paneId}`) },
    closeTabs: async (input) => { calls.closeTabs.push(input.tabIds); return { outcome: 'closed', closed: [] } },
    splitPane: async (input) => { calls.split.push(input); calls.order.push('split'); return { ok: true, paneId: null } },
  }
  const listeners = {}
  api.onRevealPane = (listener) => { listeners.revealPane = listener; return () => {} }
  api.onState = (listener) => { listeners.state = listener; return () => {} }
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
    /** herdr 에서 탭이 도착한다 — 활성 worktree(w1)의 탭 목록을 바꾼 새 상태를 민다. */
    arrive: async (tabIds) => {
      const next = { ...state, revision: state.revision + 1, repos: state.repos.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((worktree, index) => (index !== 0 ? worktree : { ...worktree, workspace: { ...worktree.workspace, tabs: tabIds.map((tabId, order) => tabOf(tabId, order + 1, [paneOf(`p-${tabId}`, tabId)])) } })) })) }
      Object.assign(state, next)
      await act(async () => { listeners.state(next) })
      await settle(5)
    },
    savedLayouts: () => calls.prefs.filter((patch) => patch.groupLayouts !== undefined).map((patch) => JSON.stringify(patch.groupLayouts)),
    active: () => q('.tab-group.is-active-group')?.getAttribute('data-tab-group') ?? null,
    focused: () => document.activeElement?.closest('[data-tab-group]')?.getAttribute('data-tab-group') ?? null,
    activeTabOf: (groupId) => q(`[data-tab-group="${groupId}"] [data-main-tab][data-active="true"]`)?.getAttribute('data-main-tab') ?? null,
    tabsOf: (groupId) => [...document.querySelectorAll(`[data-tab-group="${groupId}"] [data-main-tab]`)].map((tab) => tab.getAttribute('data-main-tab')),
    noticeTitle: () => q('.inline-notice-text')?.getAttribute('title') ?? null,
    mouse: async (type, target, init = {}) => { await act(async () => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })) }); await settle() },
  }
}

const ARROW = { left: { key: 'ArrowLeft' }, right: { key: 'ArrowRight' }, up: { key: 'ArrowUp' }, down: { key: 'ArrowDown' } }
const cmdAlt = (direction) => ({ ...ARROW[direction], metaKey: true, altKey: true })
const cmdAltW = { key: 'w', code: 'KeyW', metaKey: true, altKey: true }
const cmdAltEnter = { key: 'Enter', code: 'Enter', metaKey: true, altKey: true }
/** 분할 마디 비율 — 화면 flex-basis 첫 쪽(%)에서 읽는다. */
const basisOf = (splitId) => document.querySelector(`[data-group-split="${splitId}"] > .group-split-side`)?.style.flexBasis ?? null
/** 그 영역 **본문**(파일 보기 — 편집기 자리)에 포커스가 있나 — 헤더의 탭 요소가 받은 포커스와 가른다. */
const bodyFocused = (groupId) => document.querySelector(`[data-tab-group="${groupId}"] [data-file-view]`)?.contains(document.activeElement) ?? false
const openHeaderMenu = async (app, groupId) => {
  await app.mouse('mousedown', app.q(`[data-group-menu="${groupId}"]`))
  await app.mouse('click', app.q(`[data-group-menu="${groupId}"]`))
}

it('C1ⓐⓒ·C7 — ⌘⌥W: 남은 탭·활성·본문 포커스가 영역 MRU 에서 닫는 영역 다음으로 최근인 영역으로(트리 첫 영역이 아니다)', async () => {
  const app = await mount()
  await app.key(cmdAlt('right')) // g2
  await app.key(cmdAlt('down')) // g3 — 영역 MRU: g3, g2, g1
  expect(app.active()).toBe('g3')
  await app.key(cmdAlt('up')) // g2 — MRU: g2, g3, g1
  await app.key(cmdAltW) // g2 닫기 → MRU 다음 = g3 (base 는 트리 첫 영역 g1)
  expect(app.q('[data-tab-group="g2"]')).toBeNull()
  expect(app.tabsOf('g3')).toEqual([DIFF, FILE])
  expect(app.active()).toBe('g3')
  expect(app.activeTabOf('g3')).toBe(FILE) // 닫는 영역의 활성 탭이 받는 영역의 활성 탭
  expect(app.focused()).toBe('g3')
  expect(app.tabsOf('g1')).toEqual(['t1', 't2'])
})

it('C1ⓑ — MRU 에 다른 영역이 없으면(첫 활성 그대로) 공간 이웃: 아래 g3 를 닫으면 위 g2 로', async () => {
  const app = await mount({ layout: THREE('g3') })
  expect(app.active()).toBe('g3')
  await app.key(cmdAltW)
  expect(app.tabsOf('g2')).toEqual([FILE, DIFF])
  expect(app.active()).toBe('g2')
  expect(app.activeTabOf('g2')).toBe(DIFF)
  expect(app.focused()).toBe('g2')
})

it('C1ⓐ·C7 — 팔레트 「활성 영역 닫기」 도 같은 길(MRU 다음 영역으로 탭·활성·본문 포커스)', async () => {
  // 빈 영역(ⓓ)은 영역이 둘 이상이면 배치가 접어 App 에 서지 않는다 — 빈 영역 닫기 목적지는 단위 시험(closeGroup ⓓ)이 본다.
  const app = await mount({ layout: THREE('g1') })
  await app.mouse('mousedown', app.q('[data-diff-group="g3"]')) // MRU: g3, g1
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`)) // MRU: g2, g3, g1
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  await app.mouse('click', app.q('[data-palette-entry="group.close:0"]'))
  expect(app.q('[data-tab-group="g2"]')).toBeNull()
  expect(app.tabsOf('g3')).toEqual([DIFF, FILE])
  expect(app.active()).toBe('g3')
  expect(app.focused()).toBe('g3')
})

it('C1ⓔ — 영역 1개면 ⌘⌥W 무동작', async () => {
  const app = await mount({ layout: { root: leaf('g1', ['t1', 't2']), activeGroupId: 'g1' } })
  await app.key(cmdAltW)
  expect(app.tabsOf('g1')).toEqual(['t1', 't2'])
  expect(app.active()).toBe('g1')
})

it('C2 — 경계 더블클릭: 그 경계의 같은 방향 줄만 고르게, 첫 클릭의 mouseup 커밋이 리셋을 덮지 않음, 저장은 ratio 숫자뿐', async () => {
  const layout = { root: { kind: 'split', direction: 'row', ratio: 0.3, first: leaf('g1', ['t1', 't2']), second: { kind: 'split', direction: 'column', ratio: 0.8, first: leaf('g2', [FILE]), second: leaf('g3', [DIFF]) } }, activeGroupId: 'g1' }
  const app = await mount({ layout })
  expect(basisOf('g1|g2')).toBe('30.0000%')
  const divider = app.q('[data-group-divider="g1|g2"]')
  await app.mouse('mousedown', divider, { detail: 1 })
  await app.mouse('mouseup', document, { detail: 1 })
  await app.mouse('mousedown', divider, { detail: 2 })
  await app.mouse('mouseup', document, { detail: 2 })
  await app.mouse('dblclick', divider, { detail: 2 })
  expect(basisOf('g1|g2')).toBe('50.0000%')
  expect(basisOf('g2|g3')).toBe('80.0000%') // 다른 줄 그대로
  const last = JSON.parse(app.savedLayouts().at(-1))
  expect(last[0].layout.root.ratio).toBe(0.5)
  expect(Object.keys(last[0].layout.root).sort()).toEqual(['direction', 'first', 'kind', 'ratio', 'second'])
})

it('C3·C7 — ⊞ 메뉴 「영역 크기 균등화」: 모든 줄을 고르게, 활성 영역 = 포커스 영역', async () => {
  const layout = { root: { kind: 'split', direction: 'row', ratio: 0.3, first: leaf('g1', ['t1', 't2']), second: { kind: 'split', direction: 'column', ratio: 0.8, first: leaf('g2', [FILE]), second: leaf('g3', [DIFF]) } }, activeGroupId: 'g2' }
  const app = await mount({ layout })
  await openHeaderMenu(app, 'g2')
  const even = app.q('[data-file-tab-menu-header-mode] .context-menu-item, [data-file-tab-menu-header-mode] [role="menuitem"]')
  const item = [...document.querySelectorAll('[data-file-tab-menu-header-mode] *')].find((node) => node.textContent === '영역 크기 균등화')
  expect(item ?? even).toBeTruthy()
  await app.mouse('click', item)
  expect(basisOf('g1|g2')).toBe('50.0000%')
  expect(basisOf('g2|g3')).toBe('50.0000%')
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
})

it('C3·C4ⓖ — 영역 1개면 ⊞ 메뉴 두 항목 흐림 + 이유, ⌘⌥Enter 는 안내 한 줄(무음 실패 0)', async () => {
  const app = await mount({ layout: { root: leaf('g1', ['t1', 't2']), activeGroupId: 'g1' } })
  await openHeaderMenu(app, 'g1')
  const maximize = app.q('[data-group-layout-maximize]')
  const even = app.q('[data-group-layout-even]')
  expect(maximize?.getAttribute('data-disabled')).toBe('true')
  expect(maximize?.getAttribute('title')).toBe('영역이 하나뿐이다')
  expect(even?.getAttribute('data-disabled')).toBe('true')
  await app.key({ key: 'Escape' })
  await app.key(cmdAltEnter)
  expect(app.noticeTitle()).toContain('영역이 하나뿐이다')
  expect(app.q('.pane-grid.has-maximized')).toBeNull()
})

it('C4ⓐⓒⓓⓕ·C7 — ⌘⌥Enter 최대화: 그 영역만 덮고 다른 영역은 마운트된 채 숨김(크기 그대로), 저장 JSON 무변경, 다시 누르면 해제·비율 그대로', async () => {
  const app = await mount({ layout: THREE('g2') })
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  const savedBefore = app.savedLayouts()
  const basisBefore = [basisOf('g1|g2'), basisOf('g2|g3')]
  await app.key(cmdAltEnter)
  expect(app.q('[data-pane-grid]')?.getAttribute('data-maximized-group')).toBe('g2')
  expect(app.q('[data-tab-group="g2"]')?.classList.contains('is-maximized')).toBe(true)
  // ⓑ 숨은 영역은 언마운트·display:none 이 아니다 — 같은 상자(분할 쪽 flex-basis 그대로)에 그대로 있다
  expect(app.q('[data-tab-group="g1"]')).not.toBeNull()
  expect(app.q('[data-tab-group="g3"]')).not.toBeNull()
  expect([basisOf('g1|g2'), basisOf('g2|g3')]).toEqual(basisBefore)
  expect(app.q('[data-group-maximized="g2"]')).not.toBeNull() // ⓕ 헤더 해제 단추
  expect(app.savedLayouts()).toEqual(savedBefore) // ⓓ 저장 0
  expect(app.active()).toBe('g2')
  expect(app.focused()).toBe('g2')
  await openHeaderMenu(app, 'g2')
  expect([...document.querySelectorAll('[data-file-tab-menu-header-mode] *')].some((node) => node.textContent === '영역 최대화 해제')).toBe(true)
  await app.key({ key: 'Escape' })
  await app.key(cmdAltEnter) // 다시 토글 → 해제
  expect(app.q('.pane-grid.has-maximized')).toBeNull()
  expect([basisOf('g1|g2'), basisOf('g2|g3')]).toEqual(basisBefore)
  expect(app.savedLayouts()).toEqual(savedBefore)
  expect(app.focused()).toBe('g2')
})

it('C4ⓔ — 숨은 영역 활성(⌘⌥방향·⌃`·reveal)·균등화·분할·닫기는 최대화를 푼다, 해제 뒤 그 영역으로 돌아와도 다시 최대화되지 않는다', async () => {
  const app = await mount({ layout: THREE('g2') })
  const maximized = () => app.q('[data-pane-grid]')?.getAttribute('data-maximized-group') ?? null
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  await app.key(cmdAltEnter)
  expect(maximized()).toBe('g2')
  await app.key(cmdAlt('down')) // 숨은 g3 활성 → 해제
  expect(maximized()).toBeNull()
  expect(app.focused()).toBe('g3')
  await app.key(cmdAlt('up')) // g2 로 돌아와도 다시 최대화되지 않는다(기록을 지웠다)
  expect(maximized()).toBeNull()
  await app.key(cmdAltEnter)
  expect(maximized()).toBe('g2')
  await app.key({ key: '`', code: 'Backquote', ctrlKey: true }) // 편집기 → 터미널 영역 g1(숨음)
  expect(app.active()).toBe('g1')
  expect(maximized()).toBeNull()
  await app.key(cmdAltEnter) // g1 최대화
  expect(maximized()).toBe('g1')
  await app.reveal('p1') // 같은 영역 reveal — 그대로
  expect(maximized()).toBe('g1')
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`)) // 숨은 영역 탭 클릭(관측 길 — 숨어 있어도 DOM 은 있다)
  expect(maximized()).toBeNull()
  await app.key(cmdAltEnter) // g2
  await openHeaderMenu(app, 'g2')
  await app.mouse('click', [...document.querySelectorAll('[data-file-tab-menu-header-mode] *')].find((node) => node.textContent === '영역 크기 균등화'))
  expect(maximized()).toBeNull() // 균등화
  expect(app.focused()).toBe('g2')
  await app.mouse('click', app.q('[data-tab-group="g1"] [data-main-tab="t1"]'))
  await app.key(cmdAltEnter) // g1
  expect(maximized()).toBe('g1')
  await app.key({ key: 'd', code: 'KeyD', metaKey: true, altKey: true }) // 영역 분할 → 모양 바뀜
  expect(maximized()).toBeNull()
  await app.key(cmdAltEnter) // 새 영역 최대화
  expect(maximized()).not.toBeNull()
  await app.key(cmdAltW) // 영역 닫기
  expect(maximized()).toBeNull()
})

it('C4ⓘ — 영역 최대화와 pane 줌(⌘⇧Z)은 서로 깃발을 바꾸지 않는다', async () => {
  const app = await mount({ layout: THREE('g1'), panes: { t1: ['p1', 'p9'], t2: ['p2'] } })
  await app.key(cmdAltEnter)
  expect(app.q('[data-pane-grid]')?.getAttribute('data-maximized-group')).toBe('g1')
  await app.key({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true })
  expect(app.calls.zoom).toHaveLength(1)
  expect(app.q('[data-pane-grid]')?.getAttribute('data-maximized-group')).toBe('g1')
  const zoomsBefore = app.calls.zoom.length
  await app.key(cmdAltEnter)
  expect(app.calls.zoom).toHaveLength(zoomsBefore)
})

it('C3·C4 — 팔레트 「영역 최대화 / 해제」(⌘⌥↩)·「영역 크기 균등화」(키 없음): 영역이 둘 이상이면 파일 탭에서도 켜짐, 하나면 흐림 + 이유', async () => {
  const layout = { root: { kind: 'split', direction: 'row', ratio: 0.3, first: leaf('g1', ['t1', 't2']), second: { kind: 'split', direction: 'column', ratio: 0.8, first: leaf('g2', [FILE]), second: leaf('g3', [DIFF]) } }, activeGroupId: 'g2' }
  const app = await mount({ layout })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  const maximize = app.q('[data-palette-entry="group.maximize:0"]')
  expect(maximize?.getAttribute('aria-disabled')).toBe('false')
  expect(maximize?.textContent).toContain('⌘⌥Enter')
  const even = app.q('[data-palette-entry="group.even:0"]')
  expect(even?.getAttribute('aria-disabled')).toBe('false')
  await app.mouse('click', even)
  expect(basisOf('g1|g2')).toBe('50.0000%')
  expect(basisOf('g2|g3')).toBe('50.0000%')
  expect(app.focused()).toBe('g2')
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  await app.mouse('click', app.q('[data-palette-entry="group.maximize:0"]'))
  expect(app.q('[data-pane-grid]')?.getAttribute('data-maximized-group')).toBe('g2')
  expect(app.focused()).toBe('g2')
})

it('C3·C4ⓖ — 영역 1개면 팔레트 두 항목 흐림 + 이유', async () => {
  const app = await mount({ layout: { root: leaf('g1', ['t1', 't2']), activeGroupId: 'g1' } })
  await app.key({ key: 'k', code: 'KeyK', metaKey: true })
  for (const id of ['group.even:0', 'group.maximize:0']) {
    const entry = app.q(`[data-palette-entry="${id}"]`)
    expect(entry?.getAttribute('aria-disabled')).toBe('true')
    expect(entry?.textContent).toContain('영역이 하나뿐이다')
  }
})

it('C5ⓐ — ⌘T: 요청 순간 활성 영역·활성 탭 오른쪽을 기억, 도착 전에 다른 영역으로 옮겨도 그 자리에(base 는 도착 때 활성 영역 끝)', async () => {
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  const app = await mount({ createRow: async () => { await gate; return { ok: true, tabId: 't9', paneId: 'p-t9' } } })
  expect(app.active()).toBe('g1')
  expect(app.activeTabOf('g1')).toBe('t1')
  await app.key({ key: 't', code: 'KeyT', metaKey: true })
  expect(app.calls.create).toHaveLength(1)
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`)) // 도착 전에 다른 영역
  expect(app.active()).toBe('g2')
  await app.arrive(['t1', 't2', 't9']) // 응답보다 먼저 도착 — 그 순간은 도착 때 자리(g2 FILE 오른쪽)
  await act(async () => { release() })
  await app.settle(5)
  expect(app.tabsOf('g1')).toEqual(['t1', 't9', 't2'])
  expect(app.tabsOf('g2')).toEqual([FILE])
  expect(app.activeTabOf('g1')).toBe('t9') // reveal base 그대로(그 탭 활성)
})

it('C5ⓒ — 요청 없이 도착한 탭(앱 밖 생성)은 도착 때 활성 영역·활성 탭 오른쪽', async () => {
  const app = await mount({ layout: THREE('g1'), panes: { t1: ['p1'], t2: ['p2'] } })
  await app.arrive(['t1', 't2', 't8'])
  expect(app.tabsOf('g1')).toEqual(['t1', 't8', 't2'])
  expect(app.activeTabOf('g1')).toBe('t1') // 활성 그대로(앱 밖 탭은 펴지 않는다 — base)
})

it('C5ⓑ — 기억한 영역이 그사이 사라졌으면 도착 때 활성 영역의 활성 탭 오른쪽', async () => {
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  const app = await mount({ layout: THREE('g3'), createRow: async () => { await gate; return { ok: true, tabId: 't9', paneId: 'p-t9' } } })
  await app.mouse('click', app.q('[data-tab-group="g1"] [data-main-tab="t1"]'))
  await app.mouse('mousedown', app.q('[data-diff-group="g3"]'))
  expect(app.active()).toBe('g3')
  await app.key({ key: 't', code: 'KeyT', metaKey: true }) // 자리 = g3(diff 오른쪽)
  expect(app.calls.create).toHaveLength(1)
  await app.key(cmdAltW) // g3 닫기 → 탭은 MRU 다음(g1)으로
  expect(app.q('[data-tab-group="g3"]')).toBeNull()
  expect(app.active()).toBe('g1')
  expect(app.tabsOf('g1')).toEqual(['t1', 't2', DIFF])
  await app.mouse('click', app.q('[data-tab-group="g1"] [data-main-tab="t1"]')) // 도착 때 활성 탭 = t1(가운데에 끼는지 보려고)
  await act(async () => { release() })
  await app.arrive(['t1', 't2', 't9'])
  expect(app.tabsOf('g1')).toEqual(['t1', 't9', 't2', DIFF])
  expect(app.tabsOf('g2')).toEqual([FILE])
})

it('C4 — 편집기 안 ⌘⌥Enter: 찾기 위젯이 열려 있으면 Monaco 「모두 바꾸기」에 양보(키 안 삼킴), 닫혀 있으면 앱이 최대화', async () => {
  const app = await mount({ layout: THREE('g2') })
  await app.mouse('click', app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  const editor = document.createElement('div')
  editor.setAttribute('data-file-editor', '')
  const find = document.createElement('div')
  find.className = 'editor-widget find-widget visible'
  const input = document.createElement('textarea')
  find.append(input)
  editor.append(find)
  app.q('[data-tab-group="g2"] [data-file-view]')?.append(editor)
  const yielded = await app.key(cmdAltEnter, input)
  expect(yielded.defaultPrevented).toBe(false)
  expect(app.q('.pane-grid.has-maximized')).toBeNull()
  find.classList.remove('visible')
  const taken = await app.key(cmdAltEnter, editor)
  expect(taken.defaultPrevented).toBe(true)
  expect(app.q('[data-pane-grid]')?.getAttribute('data-maximized-group')).toBe('g2')
})

it('C6·C7(fix1 B3) — 비활성 영역 파일 탭 우클릭: 누를 때는 활성만(메뉴는 열린 채), Esc 로 닫으면 본문 포커스가 그 영역, 그 상태 ⌘W 는 그 영역 탭', async () => {
  const app = await mount({ layout: THREE('g2') })
  await app.key(cmdAlt('down')) // 본문 포커스를 g3(diff)로 — 시작 포커스를 g2 본문 밖에 둔다
  expect(app.focused()).toBe('g3')
  const tab = app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`)
  await app.mouse('mousedown', tab, { button: 2 })
  await app.mouse('contextmenu', tab, { button: 2 })
  expect(app.active()).toBe('g2')
  expect(app.q('[data-file-tab-menu]')).not.toBeNull() // 메뉴가 열려 있다(누르는 순간 편집기 포커스로 닫히지 않음)
  expect(bodyFocused('g2')).toBe(false) // 본문 포커스는 아직 — 메뉴가 닫힐 때(누른 탭 요소가 받는 포커스는 브라우저 기본)
  await app.key({ key: 'Escape' })
  expect(app.q('[data-file-tab-menu]')).toBeNull()
  expect(app.active()).toBe('g2')
  expect(bodyFocused('g2')).toBe(true)
  await app.key({ key: 'w', code: 'KeyW', metaKey: true })
  expect(app.tabsOf('g2')).toEqual([])
  expect(app.tabsOf('g3')).toEqual([DIFF])
})

it('C6(fix1 B3) — 비활성 영역 터미널 탭 우클릭·탭바 빈 곳 우클릭: 메뉴 열린 채 활성만, 바깥 클릭·Esc 로 닫으면 그 영역 본문', async () => {
  const app = await mount({ layout: THREE('g3') })
  await app.mouse('mousedown', app.q('[data-diff-group="g3"]'))
  const t1 = app.q('[data-tab-group="g1"] [data-main-tab="t1"]')
  await app.mouse('mousedown', t1, { button: 2 })
  await app.mouse('contextmenu', t1, { button: 2 })
  expect(app.active()).toBe('g1')
  expect(app.q('[data-tab-menu="t1"]')).not.toBeNull()
  await app.key({ key: 'Escape' })
  expect(app.q('[data-tab-menu="t1"]')).toBeNull()
  expect(app.active()).toBe('g1') // 터미널 본문 포커스는 TerminalPane(가짜)라 활성까지만 — focusGroupTab 경유는 아래 빈 곳 갈래가 본다
  await app.mouse('mousedown', app.q('[data-diff-group="g3"]'))
  const strip = app.q('[data-main-tab-strip="g2"]')
  await app.mouse('mousedown', strip, { button: 2 })
  await app.mouse('contextmenu', strip, { button: 2 })
  expect(app.active()).toBe('g2')
  expect(app.q('[data-file-tab-menu-header-mode]')).not.toBeNull()
  expect(bodyFocused('g2')).toBe(false)
  await app.mouse('mousedown', document.body) // 바깥 클릭
  expect(app.q('[data-file-tab-menu-header-mode]')).toBeNull()
  expect(bodyFocused('g2')).toBe(true)
})

it('fix1 B1 — 최대화 중에는 접힌 사이드바 머리 여백·「오른쪽 패널 열기」가 최대화 영역에, 해제하면 원래 영역으로', async () => {
  const app = await mount({ layout: THREE('g3'), prefsPatch: { sidebarCollapsed: true, rightPanelOpen: false } })
  const spacerIn = () => app.q('[data-collapsed-head-spacer]')?.closest('[data-tab-group]')?.getAttribute('data-tab-group') ?? null
  const toggleIn = () => app.q('[data-right-panel-toggle="tabbar"]')?.closest('[data-tab-group]')?.getAttribute('data-tab-group') ?? null
  expect(spacerIn()).toBe('g1')
  expect(toggleIn()).toBe('g2')
  await app.mouse('mousedown', app.q('[data-diff-group="g3"]'))
  await app.key(cmdAltEnter) // 비모서리 g3 최대화
  expect(app.q('[data-pane-grid]')?.getAttribute('data-maximized-group')).toBe('g3')
  expect(spacerIn()).toBe('g3')
  expect(toggleIn()).toBe('g3')
  expect(document.querySelectorAll('[data-collapsed-head-spacer]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-right-panel-toggle="tabbar"]')).toHaveLength(1)
  await app.key(cmdAltEnter)
  expect(spacerIn()).toBe('g1')
  expect(toggleIn()).toBe('g2')
})

it('fix1 B2 — 앞 탭 도착 전 연속 ⌘T 2회: 화면 순서 = 요청 순서(t1, 첫째, 둘째, t2)', async () => {
  const gates = []
  const ids = ['t9', 't10']
  let calls = 0
  const app = await mount({ createRow: async () => { const tabId = ids[calls]; calls += 1; await new Promise((resolve) => gates.push(resolve)); return { ok: true, tabId, paneId: `p-${tabId}` } } })
  await app.key({ key: 't', code: 'KeyT', metaKey: true })
  await app.key({ key: 't', code: 'KeyT', metaKey: true })
  expect(app.calls.create).toHaveLength(2)
  await app.arrive(['t1', 't2', 't10', 't9']) // 둘 다 응답보다 먼저, 뒤 요청이 먼저 도착
  await act(async () => { for (const resolve of gates) resolve() })
  await app.settle(5)
  expect(app.tabsOf('g1')).toEqual(['t1', 't9', 't10', 't2'])
})

it('C2(fix1 B6) — 더블클릭의 둘째 누름은 드래그 고스트를 띄우지 않는다(첫 누름은 띄운다 — 양성 대조)', async () => {
  const app = await mount()
  const divider = app.q('[data-group-divider="g1|g2"]')
  await app.mouse('mousedown', divider, { detail: 1 })
  expect(app.q('.group-divider-ghost')).not.toBeNull()
  await app.mouse('mouseup', document, { detail: 1 })
  expect(app.q('.group-divider-ghost')).toBeNull()
  await app.mouse('mousedown', divider, { detail: 2 })
  expect(app.q('.group-divider-ghost')).toBeNull()
  await app.mouse('mouseup', document, { detail: 2 })
})

it('fix1 B2 — 연속 ⌘T 2회 뒤 첫 탭이 먼저 도착·활성되고 둘째가 나중에 도착해도 둘째는 첫째 뒤(t1, 첫째, 둘째, t2)', async () => {
  const gates = []
  const ids = ['t9', 't10']
  let calls = 0
  const app = await mount({ createRow: async () => { const tabId = ids[calls]; calls += 1; await new Promise((resolve) => gates.push(resolve)); return { ok: true, tabId, paneId: `p-${tabId}` } } })
  await app.key({ key: 't', code: 'KeyT', metaKey: true })
  await app.key({ key: 't', code: 'KeyT', metaKey: true }) // 두 요청 다 기준 탭 t1
  expect(app.calls.create).toHaveLength(2)
  await act(async () => { gates[0]?.() })
  await app.arrive(['t1', 't2', 't9'])
  expect(app.tabsOf('g1')).toEqual(['t1', 't9', 't2'])
  expect(app.activeTabOf('g1')).toBe('t9')
  await act(async () => { gates[1]?.() })
  await app.arrive(['t1', 't2', 't9', 't10'])
  expect(app.tabsOf('g1')).toEqual(['t1', 't9', 't10', 't2'])
})

/**
 * fix2 D1·D2 — 비활성 영역 우클릭 메뉴 셋 × 메뉴가 열린 동안의 다른 이동 넷. 시작: g3(diff) 활성·본문 포커스.
 * 메뉴: 터미널 탭(g1 t1) · 헤더(g1 — 터미널 활성) · 파일 탭(g2 FILE). 이동은 React 핸들러가 있는 실제 요소에 쏜다.
 */
const MENUS = {
  terminalTab: { groupId: 'g1', target: (app) => app.q('[data-tab-group="g1"] [data-main-tab="t1"]'), open: '[data-tab-menu="t1"]' },
  terminalHeader: { groupId: 'g1', target: (app) => app.q('[data-main-tab-strip="g1"]'), open: '[data-tab-menu-header-mode]' },
  fileTab: { groupId: 'g2', target: (app) => app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`), open: '[data-file-tab-menu]' },
}
const MOVES = {
  // 다른 영역 탭바의 탭 클릭(824 C6 — 활성 + 본문 포커스). 탭바 빈 곳 왼쪽 클릭은 base 부터 활성만이라(본문 포커스 안 옮김) 탭을 누른다.
  tabbarClick: async (app, from) => {
    const tab = from === 'g1' ? app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`) : app.q('[data-tab-group="g1"] [data-main-tab="t1"]')
    await app.mouse('mousedown', tab)
    await app.mouse('mouseup', tab)
    await app.mouse('click', tab)
  },
  bodyMouseDown: async (app) => { await app.mouse('mousedown', app.q('[data-diff-group="g3"]')) },
  cmdAltArrow: async (app, from) => { await app.key(cmdAlt(from === 'g1' ? 'right' : 'left')) },
  ctrlBackquote: async (app) => { await app.key({ key: '`', code: 'Backquote', ctrlKey: true }) },
}
const closeMenu = async (app, menu) => { if (app.q(menu.open) !== null) await app.key({ key: 'Escape' }) }
/** 그 영역 본문에 포커스가 있나 — 터미널은 가짜 본문, 파일·diff 는 보기 자리. */
const bodyFocusIn = () => document.activeElement?.closest('[data-fake-term], [data-file-view], [data-diff-group]')?.closest('[data-tab-group]')?.getAttribute('data-tab-group') ?? null
const openFromG3 = async (menu, options = {}) => {
  const app = await mount({ layout: THREE('g2'), ...options })
  await app.key(cmdAlt('down'))
  expect(app.active()).toBe('g3')
  const target = menu.target(app)
  await app.mouse('mousedown', target, { button: 2 })
  await app.mouse('contextmenu', target, { button: 2 })
  expect(app.active()).toBe(menu.groupId)
  expect(app.q(menu.open)).not.toBeNull()
  return app
}

describe('fix2 D1 — 우클릭으로 미뤄 둔 본문 포커스는 메뉴가 열린 동안의 다른 이동을 덮지 않는다', () => {
  for (const [menuName, menu] of Object.entries(MENUS)) {
    // 파일 탭 메뉴(ContextMenu)는 열린 동안 방향키를 메뉴 이동으로 먹는다(base, ContextMenu.tsx 키 처리) — ⌘⌥방향은 메뉴를 못 지나가 이 조합은 없다.
    for (const [moveName, move] of Object.entries(MOVES).filter(([name]) => !(menuName === 'fileTab' && name === 'cmdAltArrow'))) {
      it(`${menuName} × ${moveName}: 닫힌 뒤 활성·본문 포커스·⌘W 대상 = 옮겨 간 영역`, async () => {
        const app = await openFromG3(menu)
        await move(app, menu.groupId)
        const moved = app.active()
        expect(moved).not.toBe(menu.groupId)
        await closeMenu(app, menu)
        expect(app.q(menu.open)).toBeNull()
        expect(app.active()).toBe(moved)
        expect(bodyFocusIn()).toBe(moved)
        const movedTab = app.activeTabOf(moved)
        await app.key({ key: 'w', code: 'KeyW', metaKey: true })
        if (moved === 'g1') expect(app.calls.closeTabs).toEqual([[movedTab]])
        else expect(app.tabsOf(moved)).not.toContain(movedTab)
        expect(app.calls.closeTabs.flat()).not.toContain(menu.groupId === 'g1' ? 't1' : FILE)
        if (menu.groupId === 'g2' && moved !== 'g2') expect(app.tabsOf('g2')).toEqual([FILE])
      })
    }
    it(`${menuName} → Esc 만: 우클릭한 영역이 활성·본문 포커스, ⌘W 대상`, async () => {
      const app = await openFromG3(menu)
      const before = termFocusLog.length
      await app.key({ key: 'Escape' })
      expect(app.q(menu.open)).toBeNull()
      expect(app.active()).toBe(menu.groupId)
      expect(bodyFocusIn()).toBe(menu.groupId)
      // fix2 D2 — 터미널 갈래는 닫힘 알림이 본문 포커스 길(focusGroupTab → selectPane → focusToken)을 타서 가짜 본문이 한 번 더 포커스를 받는다.
      if (menu.groupId === 'g1') expect(termFocusLog.slice(before)).toEqual(['p1'])
      await app.key({ key: 'w', code: 'KeyW', metaKey: true })
      if (menu.groupId === 'g1') expect(app.calls.closeTabs).toEqual([['t1']])
      else expect(app.tabsOf('g2')).toEqual([])
    })
  }
})

const rightClick = async (app, target) => {
  await app.mouse('mousedown', target, { button: 2 })
  await app.mouse('contextmenu', target, { button: 2 })
}
const TERM2 = (activeGroupId) => ({
  root: { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('g1', ['t1']), second: { kind: 'split', direction: 'column', ratio: 0.5, first: leaf('g2', ['t2']), second: leaf('g3', [DIFF]) } },
  activeGroupId,
})

describe('fix3 E1 — 메뉴가 열린 채 다른 비활성 영역 우클릭 → 닫힘: 활성·본문 포커스·⌘W 대상 = 뒤 영역', () => {
  it('터미널(g1 t1) → 파일(g2)', async () => {
    const app = await openFromG3(MENUS.terminalTab)
    await rightClick(app, app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
    expect(app.q('[data-file-tab-menu]')).not.toBeNull()
    await closeMenu(app, MENUS.fileTab)
    expect(app.active()).toBe('g2')
    expect(bodyFocusIn()).toBe('g2')
    await app.key({ key: 'w', code: 'KeyW', metaKey: true })
    expect(app.tabsOf('g2')).toEqual([])
    expect(app.calls.closeTabs).toEqual([])
  })
  it('파일(g2) → 터미널(g1 t1)', async () => {
    const app = await openFromG3(MENUS.fileTab)
    await rightClick(app, app.q('[data-tab-group="g1"] [data-main-tab="t1"]'))
    expect(app.q('[data-tab-menu="t1"]')).not.toBeNull()
    await closeMenu(app, MENUS.terminalTab)
    expect(app.active()).toBe('g1')
    expect(bodyFocusIn()).toBe('g1')
    await app.key({ key: 'w', code: 'KeyW', metaKey: true })
    expect(app.calls.closeTabs).toEqual([['t1']])
    expect(app.tabsOf('g2')).toEqual([FILE])
  })
  it('터미널(g1 t1) → 터미널(g2 t2)', async () => {
    const app = await mount({ layout: TERM2('g2') })
    await app.key(cmdAlt('down'))
    expect(app.active()).toBe('g3')
    await rightClick(app, app.q('[data-tab-group="g1"] [data-main-tab="t1"]'))
    expect(app.q('[data-tab-menu="t1"]')).not.toBeNull()
    await rightClick(app, app.q('[data-tab-group="g2"] [data-main-tab="t2"]'))
    expect(app.q('[data-tab-menu="t2"]')).not.toBeNull()
    await app.key({ key: 'Escape' })
    expect(app.q('[data-tab-menu="t2"]')).toBeNull()
    expect(app.active()).toBe('g2')
    expect(bodyFocusIn()).toBe('g2')
    await app.key({ key: 'w', code: 'KeyW', metaKey: true })
    expect(app.calls.closeTabs).toEqual([['t2']])
  })
})

it('fix3 E2 — 메뉴가 열린 채 누른 ⌘⌥방향은 IPC 응답 전에 메뉴를 닫아도 이긴다: 응답 뒤 활성·본문 포커스 = 이웃 영역', async () => {
  const app = await mount({ layout: THREE('g2'), neighborDelayMs: 200 })
  await app.key(cmdAlt('down'))
  expect(app.active()).toBe('g3')
  await rightClick(app, app.q('[data-tab-group="g1"] [data-main-tab="t1"]'))
  expect(app.active()).toBe('g1')
  await app.key(cmdAlt('right')) // 터미널 활성이라 이웃 pane IPC 가 먼저 나간다(200ms 지연)
  expect(app.calls.neighbor).toHaveLength(1)
  await app.key({ key: 'Escape' }) // 응답 전에 메뉴를 닫는다
  expect(app.q('[data-tab-menu="t1"]')).toBeNull()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
  await app.settle(5)
  const moved = app.active()
  expect(moved).not.toBe('g1')
  expect(bodyFocusIn()).toBe(moved)
})

it('fix3 E3 — 같은 영역에서 우클릭을 연달아(파일 탭 a → b) 해도 메뉴가 닫히면 그 영역 본문', async () => {
  const FILE_B = 'file:b.ts'
  const layout = { root: { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('g1', ['t1', 't2']), second: { kind: 'split', direction: 'column', ratio: 0.5, first: leaf('g2', [FILE, FILE_B]), second: leaf('g3', [DIFF]) } }, activeGroupId: 'g2' }
  const app = await mount({ layout })
  await app.key(cmdAlt('down'))
  expect(app.active()).toBe('g3')
  await rightClick(app, app.q(`[data-tab-group="g2"] [data-main-tab="${FILE}"]`))
  expect(app.active()).toBe('g2')
  await rightClick(app, app.q(`[data-tab-group="g2"] [data-main-tab="${FILE_B}"]`))
  expect(app.q('[data-file-tab-menu]')).not.toBeNull()
  await app.key({ key: 'Escape' })
  expect(app.q('[data-file-tab-menu]')).toBeNull()
  expect(app.active()).toBe('g2')
  expect(bodyFocusIn()).toBe('g2')
})

describe('fix3 E4 — D3 App 배선: 기준 탭 없음·사라짐·다른 자리 요청 섞임에도 화면 순서 = 요청 순서', () => {
  /** createRow 를 요청 순서대로 tabIds 로 답하되 문을 열 때까지 붙든다. */
  const gated = (ids) => {
    const gates = []
    let calls = 0
    return { gates, createRow: async () => { const tabId = ids[calls]; calls += 1; await new Promise((resolve) => gates.push(resolve)); return { ok: true, tabId, paneId: `p-${tabId}` } } }
  }
  const cmdT = { key: 't', code: 'KeyT', metaKey: true }
  // App 에서 빈 영역은 영역이 하나뿐일 때만 선다(둘 이상이면 배치가 빈 영역을 접는다 — App.group-focus C8 과 같은 사실). 그래서 탭 0 인 worktree 의 한 영역으로 본다.
  it('빈 영역(탭 0, 기준 탭 없음) — 뒤 요청(n2) 먼저 도착 → 앞 요청(n1): n1, n2', async () => {
    const g = gated(['n1', 'n2'])
    const app = await mount({ layout: { root: leaf('g1', [], null), activeGroupId: 'g1' }, panes: {}, createRow: g.createRow })
    expect(app.q('[data-empty-group="g1"]')).not.toBeNull()
    await app.key(cmdT)
    await app.key(cmdT)
    expect(app.calls.create).toHaveLength(2)
    await act(async () => { for (const resolve of g.gates) resolve() })
    await app.settle(3)
    await app.arrive(['n2'])
    expect(app.tabsOf('g1')).toEqual(['n2'])
    await app.arrive(['n2', 'n1'])
    expect(app.tabsOf('g1')).toEqual(['n1', 'n2'])
  })
  it('기준 탭(t1)이 두 탭 도착 전 사라짐 — 뒤 요청 먼저 도착: t2, n1, n2', async () => {
    const g = gated(['n1', 'n2'])
    const app = await mount({ createRow: g.createRow })
    await app.key(cmdT)
    await app.key(cmdT)
    await act(async () => { for (const resolve of g.gates) resolve() })
    await app.settle(3)
    await app.arrive(['t2', 'n2'])
    expect(app.tabsOf('g1')).toEqual(['t2', 'n2'])
    await app.arrive(['t2', 'n2', 'n1'])
    expect(app.tabsOf('g1')).toEqual(['t2', 'n1', 'n2'])
  })
  it('같은 영역 다른 기준 탭 요청·다른 영역 요청이 섞여도 각자 자리: g1 t1, nc, t2, na / g2 FILE, nx', async () => {
    const g = gated(['na', 'nx', 'nc'])
    const layout = { root: { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('g1', ['t1', 't2'], 't2'), second: leaf('g2', [FILE]) }, activeGroupId: 'g1' }
    const app = await mount({ layout, createRow: g.createRow })
    await app.key(cmdT) // na — g1 기준 t2
    await app.key(cmdAlt('right'))
    expect(app.active()).toBe('g2')
    await app.key(cmdT) // nx — g2 기준 FILE
    const t1 = app.q('[data-tab-group="g1"] [data-main-tab="t1"]')
    await app.mouse('mousedown', t1)
    await app.mouse('click', t1)
    expect(app.active()).toBe('g1')
    expect(app.activeTabOf('g1')).toBe('t1')
    await app.key(cmdT) // nc — g1 기준 t1 (na 보다 뒤 요청, 다른 자리 키)
    expect(app.calls.create).toHaveLength(3)
    await act(async () => { for (const resolve of g.gates) resolve() })
    await app.settle(3)
    await app.arrive(['t1', 't2', 'nc'])
    await app.arrive(['t1', 't2', 'nc', 'nx'])
    await app.arrive(['t1', 't2', 'nc', 'nx', 'na'])
    expect(app.tabsOf('g1')).toEqual(['t1', 'nc', 't2', 'na'])
    expect(app.tabsOf('g2')).toEqual([FILE, 'nx'])
  })
})

describe('fix4 F1 — 메뉴를 연 채 이동 없이 끝난 ⌘⌥방향(가장자리·IPC 거절)은 미뤄 둔 포커스를 지우지 않는다: 닫힘 뒤 활성 = 본문 포커스 = 우클릭한 영역', () => {
  const wait = async (app, ms) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
    await app.settle(5)
  }
  const CASES = {
    // g1 은 왼쪽 이웃이 없다. 이웃 pane 도 없음(neighbor.next null).
    edge: { options: {}, key: 'left' },
    // 오른쪽엔 이웃 영역(g2)이 있지만 IPC 가 던져 이동 없이 끝난다.
    rejected: { options: { neighborRejects: 1 }, key: 'right' },
    // 지연 IPC 가장자리 — 응답 전에 메뉴를 닫는다(닫힘의 몫은 응답 뒤 이동 없음이 확인될 때 돈다).
    delayedEdge: { options: { neighborDelayMs: 200 }, key: 'left' },
  }
  for (const menuName of ['terminalTab', 'terminalHeader']) {
    const menu = MENUS[menuName]
    for (const [caseName, testCase] of Object.entries(CASES)) {
      it(`${menuName} × ${caseName}`, async () => {
        const app = await openFromG3(menu, testCase.options)
        await app.key(cmdAlt(testCase.key))
        expect(app.calls.neighbor).toHaveLength(1)
        if (caseName !== 'delayedEdge') await wait(app, 0)
        expect(app.active()).toBe('g1')
        await closeMenu(app, menu)
        expect(app.q(menu.open)).toBeNull()
        if (caseName === 'delayedEdge') {
          expect(bodyFocusIn()).not.toBe('g1') // 응답 전 — 아직 돌지 않는다
          await wait(app, 300)
        }
        expect(app.active()).toBe('g1')
        expect(bodyFocusIn()).toBe('g1')
        await app.key({ key: 'w', code: 'KeyW', metaKey: true })
        expect(app.calls.closeTabs).toEqual([['t1']])
      })
    }
  }
})
