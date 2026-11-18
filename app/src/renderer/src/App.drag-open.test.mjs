// @vitest-environment happy-dom
/* global window, document, setTimeout, KeyboardEvent, MouseEvent, Event, HTMLInputElement */
// LIFE-823 — App 배선을 실제 마운트로 거친다(App.close-scope.test.mjs 와 같은 걸음):
//   · C3 ⌘P ⌥Enter → `openListedFile(side)` → `placeFileAt(side)` → 활성 영역 오른쪽 새 분할(고정 탭)
//   · C2·P2 이미 열린 파일을 옆으로 열면 옮기지 않고 그 탭으로 가며 안내 한 줄(맥락이 바뀌는 길 — 822 의 맥락 지우기에 먹히지 않는다), F5 활성 영역이면 안내 없음
//   · C4 B4 파일 탭 끌기 고스트 = 파일 이름, B5 diff 탭 영역 본문 `[data-diff-group]`(fix1 F3 — App 이 groupId 를 넘기는 줄)
//   · C1 트리 밖 탐색기 끌기 → `useFileDrag` → `fileDrag.onDrop` 매핑 → 배치(fix1 F3 — 탭바 index·가운데·가장자리·빈 영역)
// 레이아웃이 없으니 영역 사각형을 씌운다: 헤더 0~32(탭 100px 씩), 본문 y 40~440 · x 0~400. `elementsFromPoint` = 겨눈 영역, `elementFromPoint` = 트리 밖(body).
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
import { DROP_BODY_SELECTOR } from './hooks/useTabDrag.js'
import { diffTabId } from '../../shared/scm.js'

vi.mock('./TerminalPane.js', () => ({ TerminalPane: () => null, keepTerminalFocus: () => {} }))
// diff 탭 본문(DiffView)이 편집기를 붙이지 않게 — DiffView.test 와 같은 가짜.
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

const paneOf = (paneId, tabId) => ({ paneId, tabId, workspaceId: 'w1', title: '', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: paneId === 'p1', agentSession: null, digest: EMPTY_SESSION_DIGEST })
const tabOf = (tabId, number, panes) => ({ tabId, workspaceId: 'w1', label: 'zsh', number, order: number - 1, agentStatus: 'idle', focused: tabId === 't1', panes, digest: EMPTY_SESSION_DIGEST })
const FILE = 'file:a.ts'

const DIFF = diffTabId({ mode: 'wt', rel: 'a.ts', orig: null })
const ONE_GROUP = { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1', FILE], activeTabId: 't1' } }, activeGroupId: 'g1' }

/** 레이아웃 가짜 — 끌기 판정이 재는 요소만. 원래 함수는 정리 때 돌려놓는다. */
function fakeGeometry() {
  const original = window.Element.prototype.getBoundingClientRect
  const rect = (x, y, width, height) => window.DOMRect.fromRect({ x, y, width, height })
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.matches('[data-group-header]')) return rect(0, 0, 400, 32)
    if (this.matches('[data-main-tab]')) {
      const header = this.closest('[data-group-header]')
      const index = header === null ? 0 : [...header.querySelectorAll('[data-main-tab]')].indexOf(this)
      return rect(index * 100, 0, 100, 32)
    }
    if (this.matches(DROP_BODY_SELECTOR)) return rect(0, 40, 400, 400)
    return original.call(this)
  }
  cleanups.push(() => { window.Element.prototype.getBoundingClientRect = original })
}

async function mount({ layout = ONE_GROUP, tabIds = ['t1'], rightPanelOpen = false } = {}) {
  fakeGeometry()
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l823-app-'))
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = {
    ...new UiPrefsStore(folder).get(),
    sidebarCollapsed: false,
    rightPanelOpen,
    rightPanelView: 'explorer',
    groupLayouts: [{ worktreePath: '/r', layoutFormat: LAYOUT_FORMAT, layout }],
  }
  const gitStatus = { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false }
  const tabs = tabIds.map((tabId, index) => tabOf(tabId, index + 1, [paneOf(`p${index + 1}`, tabId)]))
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
    explorerList: async ({ rel }) => ({ ok: true, real: rel, id: `id:${rel}`, entries: rel === '' ? [{ name: 'a.ts', kind: 'file', link: 'none' }, { name: 'b.ts', kind: 'file', link: 'none' }, { name: 'src', kind: 'dir', link: 'none' }] : [] }),
    scmRead: async () => ({ ok: true, kind: 'text', text: 'x', size: 1 }),
    setUiPrefs: () => {},
    setShortcutRecording: async () => {},
  }
  Reflect.set(window, 'corral', new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) }))
  // happy-dom 에는 없다 — 끌기 판정이 부른다. `aim` 이 겨눈 영역(없으면 영역 밖 = invalid). 탐색기 쪽 `elementFromPoint` 는 늘 트리 밖.
  const aim = { groupId: null }
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => { const group = aim.groupId === null ? null : document.querySelector(`[data-tab-group="${aim.groupId}"]`); return group === null ? [] : [group] } })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.body })
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
  const pointer = async (type, target, x, y) => {
    await act(async () => { target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) })
  }
  return {
    q, settle, key,
    /** 탐색기 행을 트리 밖으로 끌어 그 영역의 (x, y) 에 놓는다. */
    dragFromExplorer: async ({ rel, groupId, x, y }) => {
      for (let i = 0; i < 20 && q(`[data-explorer-row="${rel}"]`) === null; i += 1) await settle()
      const row = q(`[data-explorer-row="${rel}"]`)
      if (row === null) throw new Error(`탐색기 행 없음: ${rel}`)
      aim.groupId = groupId
      await pointer('pointerdown', row, 1000, 10)
      await pointer('pointermove', document, x + 30, y + 30)
      await pointer('pointermove', document, x, y)
      const during = {
        ghost: q('[data-tab-drag-ghost]')?.textContent ?? null,
        fill: q('[data-dropzone-fill], [data-dropzone-tabbar-marker]') !== null,
        // R2-L1 — 끌기 중 탭바 넘침 끌기 모드(`tabDragActive`)가 켜졌나
        dragActive: q(`[data-main-tab-strip-wrap="${groupId}"]`)?.hasAttribute('data-tab-drag-active') ?? null,
      }
      await pointer('pointerup', document, x, y)
      await settle()
      aim.groupId = null
      return during
    },
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

it('C2·P2 이미 열린 파일을 옆으로(다른 영역에 있음) — 옮기지 않고 그 탭으로, 안내 한 줄(전문 title)', async () => {
  // g1 = [t1, a.ts] · g2 = [t2](활성, 가장 오른쪽) — 옆 대상은 새 분할인데 a.ts 는 g1 에 있다 → 다른 자리
  const layout = { root: { kind: 'split', direction: 'row', ratio: 0.5, first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1', FILE], activeTabId: 't1' } }, second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: ['t2'], activeTabId: 't2' } } }, activeGroupId: 'g2' }
  const app = await mount({ layout, tabIds: ['t1', 't2'] })
  await app.quickOpen({ query: 'a.ts', altKey: true })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['t1', FILE] }, { groupId: 'g2', tabs: ['t2'] }])
  expect(app.q(`[data-main-tab="${FILE}"]`)?.getAttribute('data-active')).toBe('true')
  expect(app.noticeTitle()).toBe(alreadyOpenHint('a.ts'))
})

it('F5 이미 활성 영역에 있는 파일을 옆으로 — 그 탭으로 가되 안내 없음', async () => {
  const app = await mount()
  await app.quickOpen({ query: 'a.ts', altKey: true })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['t1', FILE] }])
  expect(app.q(`[data-main-tab="${FILE}"]`)?.getAttribute('data-active')).toBe('true')
  expect(app.noticeTitle()).toBeNull()
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

it('F3 B5 — diff 탭이 활성인 영역 본문에 `data-diff-group`(그 영역 id)', async () => {
  const app = await mount({ layout: { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1', DIFF], activeTabId: DIFF } }, activeGroupId: 'g1' } })
  expect(app.q('[data-render-error]')).toBeNull()
  expect(app.q('[data-tab-group="g1"] [data-diff-group]')?.getAttribute('data-diff-group')).toBe('g1')
})

it('F3 B5 — 탐색기 파일을 diff 본문 가장자리에 놓으면 분할', async () => {
  const app = await mount({ layout: { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1', DIFF], activeTabId: DIFF } }, activeGroupId: 'g1' }, rightPanelOpen: true })
  await app.dragFromExplorer({ rel: 'b.ts', groupId: 'g1', x: 390, y: 240 })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['t1', DIFF] }, { groupId: 'g2', tabs: ['file:b.ts'] }])
})

it('F3 C1ⓐ 트리 밖 끌기 → 탭바 index 0 자리에 고정 탭, 끌기 중 고스트·삽입선', async () => {
  const app = await mount({ rightPanelOpen: true })
  const during = await app.dragFromExplorer({ rel: 'b.ts', groupId: 'g1', x: 20, y: 10 })
  expect(during).toEqual({ ghost: 'b.ts', fill: true, dragActive: true })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['file:b.ts', 't1', FILE] }])
  expect(app.q('[data-main-tab-strip-wrap="g1"]')?.hasAttribute('data-tab-drag-active')).toBe(false)
  expect(app.q('[data-main-tab="file:b.ts"]')?.getAttribute('data-tab-preview')).toBe('false')
  expect(app.q('[data-drop-zone-overlay]')).toBeNull()
})

it('F3 C1ⓒ 가운데 → 그 영역 활성 탭(t1) 오른쪽', async () => {
  const app = await mount({ rightPanelOpen: true })
  await app.dragFromExplorer({ rel: 'b.ts', groupId: 'g1', x: 200, y: 240 })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['t1', 'file:b.ts', FILE] }])
})

it('F3 C1ⓑ 가장자리(아래) → 새 영역', async () => {
  const app = await mount({ rightPanelOpen: true })
  await app.dragFromExplorer({ rel: 'b.ts', groupId: 'g1', x: 200, y: 430 })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['t1', FILE] }, { groupId: 'g2', tabs: ['file:b.ts'] }])
})

it('R2-L2 C1ⓑ 왼쪽 가장자리 → 새 영역이 대상 앞(왼쪽)에', async () => {
  const app = await mount({ rightPanelOpen: true })
  await app.dragFromExplorer({ rel: 'b.ts', groupId: 'g1', x: 10, y: 240 })
  expect(app.groups()).toEqual([{ groupId: 'g2', tabs: ['file:b.ts'] }, { groupId: 'g1', tabs: ['t1', FILE] }])
})

it('F3·F1 빈 영역(탭 0) — 가장자리에 놓아도 그 영역에 열린다(한 영역)', async () => {
  const app = await mount({ layout: { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: [], activeTabId: null } }, activeGroupId: 'g1' }, tabIds: [], rightPanelOpen: true })
  expect(app.q('[data-empty-group]')).not.toBeNull()
  await app.dragFromExplorer({ rel: 'b.ts', groupId: 'g1', x: 390, y: 240 })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['file:b.ts'] }])
})

it('C2 폴더를 끌어 놓으면 배치 그대로', async () => {
  const app = await mount({ rightPanelOpen: true })
  const during = await app.dragFromExplorer({ rel: 'src', groupId: 'g1', x: 200, y: 240 })
  expect(during).toEqual({ ghost: 'src', fill: false, dragActive: true })
  expect(app.groups()).toEqual([{ groupId: 'g1', tabs: ['t1', FILE] }])
})
