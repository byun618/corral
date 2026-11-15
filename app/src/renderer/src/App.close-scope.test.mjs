// @vitest-environment happy-dom
/* global window, document, setTimeout, KeyboardEvent */
// LIFE-822 fix1 R1-6 — 섞인 범위 닫기의 **배선**을 실제 App 마운트로 거친다:
//   파일 탭 우클릭 「모두 닫기」 → App `closeScope` → `closeMixedTabs` → 수정 파일 확인(`confirmFilesByUser` deferDiscard)
//   → `closeTabsByUser`(onClosed 에 닫힌 id) → `lifecycle.closeTabs` → main 게이트 함수 `closeTabsGated` 그대로 → 확인 창(실제 `ConfirmClose`).
// 실행 중 판정만 테스트가 정한다(`running`). AppState 는 큰 타입이라 .mjs 로 둔다(App.confirm-settings.test.mjs 와 같은 걸음).
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
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { emptyAgentState } from '../../shared/agent-state.js'
import { resetSettingsStoreForTest } from './settings-store.js'
import { adoptDoc, disposeDoc, docKey, getDoc } from './file-docs.js'
import { LAYOUT_FORMAT } from './group-tree.js'
import { CLOSE_CONFIRM_PENDING } from './tab-actions.js'

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
const tabOf = (tabId, number, panes) => ({ tabId, workspaceId: 'w1', label: '', number, order: number - 1, agentStatus: 'idle', focused: tabId === 't1', panes, digest: EMPTY_SESSION_DIGEST })
const FILE = 'file:a.ts'

/** Monaco 모델 대신 — `adoptDoc` 이 쓰는 만큼만. `type()` = 편집 한 번(버전 +1, 변경 이벤트). */
function miniModel(text) {
  let value = text
  let version = 1
  const listeners = new Set()
  return {
    disposed: false,
    onDidChangeContent: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
    getAlternativeVersionId: () => version,
    getLinesContent: () => value.split('\n'),
    getValue: () => value,
    getValueLength: () => value.length,
    getEOL: () => '\n',
    getLineCount: () => value.split('\n').length,
    dispose() { this.disposed = true },
    type(extra) {
      value = `${extra}${value}`
      version += 1
      for (const listener of listeners) listener({ changes: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: extra }] })
    },
  }
}

/** `running` = 처음 실행 중인 pane. `startOnConfirm` = 첫 확인 뒤(닫는 사이) 새로 실행되는 pane — main 이 일부만 닫고 다시 묻는 길. */
/** `dialog: 'held'` = 수정 파일 확인 응답을 테스트가 `releaseDialog(choice)` 로 놓을 때까지 기다린다. `layout` = 저장 배치 루트(기본: 한 영역 t1·파일·t2). */
async function mount({ running = [], startOnConfirm = [], dialog = 'discard', layout = null } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l822-app-'))
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = {
    ...new UiPrefsStore(folder).get(),
    sidebarCollapsed: false,
    groupLayouts: [{ worktreePath: '/r', layoutFormat: LAYOUT_FORMAT, layout: layout ?? { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['t1', FILE, 't2'], activeTabId: 't1' } }, activeGroupId: 'g1' } }],
  }
  const gitStatus = { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false }
  const tabs = [tabOf('t1', 1, [paneOf('p1', 't1')]), tabOf('t2', 2, [paneOf('p2', 't2'), paneOf('p3', 't2')])]
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'ready' }, backend: { kind: 'ok' },
    registry: { file: path.join(folder, 'registry'), roots: ['/r'], lastError: null }, registryGeneration: 0,
    repos: [{ root: '/r', name: 'r', error: null, worktrees: [{ path: '/r', branch: 'main', isLinked: false, openWorkspaceId: 'w1', workspace: { workspaceId: 'w1', label: 'r', number: 1, agentStatus: 'idle', focused: true, tabs }, gitStatus, displayName: null, comment: null, parentPath: null }] }],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] }, herdrTabIds: null,
  }
  const runningPanes = new Set(running)
  const closeCalls = []
  const closed = []
  const dialogs = []
  const heldDialogs = []
  const splits = []
  const api = {
    getState: async () => state,
    onState: () => () => {},
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    getSettingsSync: () => DEFAULT_SETTINGS,
    setSettings: async () => ({ status: 'saved', settings: DEFAULT_SETTINGS }),
    fileDialog: async (request) => {
      dialogs.push(request)
      return dialog === 'held' ? new Promise((resolve) => { heldDialogs.push(resolve) }) : dialog
    },
    splitPane: async (input) => { splits.push(input); return { ok: false, error: 'test', paneId: null } },
    writeFile: async () => ({ ok: true, stamp: 's1', hash: 'h1' }),
    closeTabs: async (input) => {
      closeCalls.push({ ...input })
      if (input.confirmed) for (const paneId of startOnConfirm) runningPanes.add(paneId)
      return closeTabsGated({
        ...input,
        confirmRunning: true,
        panesOf: (tabId) => (closed.includes(tabId) ? null : (tabs.find((tab) => tab.tabId === tabId)?.panes.map((pane) => pane.paneId) ?? null)),
        probe: async (panes) => panes.filter((row) => runningPanes.has(row.paneId)).map((row) => ({ ...row, foreground: ['sleep 600'] })),
        close: async (tabId) => { closed.push(tabId); return { outcome: 'closed' } },
      })
    },
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
  cleanups.push(() => { act(() => root.unmount()); host.remove(); fs.rmSync(folder, { recursive: true, force: true }); disposeDoc(docKey('/r', 'a.ts')) })
  const q = (selector) => document.querySelector(selector)
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) }) }
  const click = async (selector) => {
    const element = q(selector)
    if (element === null) throw new Error(`없음: ${selector}`)
    await act(async () => { element.click() })
    await settle()
  }
  return {
    q, click, settle, closeCalls, closed, dialogs, splits,
    releaseDialog: async (choice) => {
      const resolve = heldDialogs.shift()
      if (resolve === undefined) throw new Error('대기 중인 확인 없음')
      await act(async () => { resolve(choice) })
      await settle()
    },
    key: async (init) => {
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
      await settle()
    },
    /** 파일 탭 우클릭 → 메뉴 항목. */
    fileMenu: async (action) => {
      const tab = q(`[data-main-tab="${FILE}"]`)
      if (tab === null) throw new Error('파일 탭 없음')
      await act(async () => { tab.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 10 })) })
      await click(`[data-file-tab-menu] [data-menu-action="${action}"]`)
    },
    fileTabShown: () => q(`[data-main-tab="${FILE}"]`) !== null,
    modal: () => q('[data-confirm-close-modal]'),
    notice: () => q('.inline-notice-text')?.textContent ?? null,
    /** 그 파일의 수정된 문서를 맡긴다(편집기를 연 것과 같은 저장소 상태). */
    dirtyDoc: () => {
      const model = miniModel('a')
      const doc = adoptDoc({ root: '/r', rel: 'a.ts', model, text: 'a', bom: false, stamp: 's0', hash: 'h0', readOnly: null, large: false })
      act(() => model.type('x'))
      return { doc, model }
    },
  }
}

it('ⓑ 실행 중 확인 → 터미널이 전부 닫힌 뒤 파일도 닫힌다', async () => {
  const app = await mount({ running: ['p1'] })
  expect(app.q('[data-render-error]')).toBeNull()
  expect(app.fileTabShown()).toBe(true)
  await app.fileMenu('close-all')
  expect(app.modal()).not.toBeNull()
  await app.click('[data-close-confirm-ok]')
  expect(app.closed).toEqual(['t1', 't2'])
  expect(app.fileTabShown()).toBe(false)
})

it('ⓐ 실행 중 확인 취소 → 아무것도 안 닫힌다(파일 탭 남음)', async () => {
  const app = await mount({ running: ['p1'] })
  await app.fileMenu('close-all')
  await app.click('[data-close-confirm-cancel]')
  expect(app.closed).toEqual([])
  expect(app.fileTabShown()).toBe(true)
})

it('fix1 R1-2 확인 뒤 일부만 닫히고(새 실행 중) 다시 묻다 취소 → 파일은 남는다', async () => {
  const app = await mount({ running: ['p1'], startOnConfirm: ['p3'] })
  await app.fileMenu('close-all')
  await app.click('[data-close-confirm-ok]')
  // t1 은 닫혔고 t2 의 새 실행 중(p3) 때문에 다시 묻는다
  expect(app.closed).toEqual(['t1'])
  expect(app.modal()).not.toBeNull()
  expect(app.fileTabShown()).toBe(true)
  await app.click('[data-close-confirm-cancel]')
  expect(app.fileTabShown()).toBe(true)
})

it('fix1 R1-2 일부만 닫힌 뒤 다시 물어 확인하면 그때 파일도 닫힌다', async () => {
  const again = await mount({ running: ['p1'], startOnConfirm: ['p3'] })
  await again.fileMenu('close-all')
  await again.click('[data-close-confirm-ok]')
  expect(again.fileTabShown()).toBe(true)
  await again.click('[data-close-confirm-ok]')
  expect(again.closed).toEqual(['t1', 't2'])
  expect(again.fileTabShown()).toBe(false)
})

it('fix1 R1-1 수정 파일 「저장 안 함」 뒤 터미널 확인 취소 → 문서·편집 내용이 그대로 남는다 · 확인하면 닫으며 버린다', async () => {
  const app = await mount({ running: ['p1'] })
  const { doc, model } = app.dirtyDoc()
  await app.fileMenu('close-all')
  expect(app.dialogs).toEqual([{ kind: 'close', files: ['a.ts'] }])
  expect(app.modal()).not.toBeNull()
  await app.click('[data-close-confirm-cancel]')
  expect(app.fileTabShown()).toBe(true)
  expect(getDoc(doc.key)).toBe(doc)
  expect(doc.dirty).toBe(true)
  expect(model.disposed).toBe(false)
  // 다시 — 이번엔 터미널도 확인. worktree 의 마지막 터미널을 닫아도 이미 답한 파일을 두 번 묻지 않는다.
  await app.fileMenu('close-all')
  await app.click('[data-close-confirm-ok]')
  expect(app.dialogs).toHaveLength(2)
  expect(app.fileTabShown()).toBe(false)
  expect(getDoc(doc.key)).toBeUndefined()
  expect(model.disposed).toBe(true)
})

it('fix1 R1-3 닫기 확인 창이 이미 떠 있으면 → 파일 확인도 터미널 요청도 없이 안내', async () => {
  const app = await mount({ running: ['p2'] })
  await app.fileMenu('close-right')
  expect(app.modal()).not.toBeNull()
  const calls = app.closeCalls.length
  await app.fileMenu('close-all')
  expect(app.closeCalls).toHaveLength(calls)
  expect(app.fileTabShown()).toBe(true)
  expect(app.notice()).toBe(CLOSE_CONFIRM_PENDING)
})

it('fix2 N1 파일 확인을 기다리는 사이 다른 닫기 확인 창이 떴으면 → 확인 뒤 터미널 요청 없이 안내 · 파일·문서 그대로', async () => {
  const app = await mount({ running: ['p2'], dialog: 'held' })
  const { doc, model } = app.dirtyDoc()
  await app.fileMenu('close-all')
  expect(app.dialogs).toHaveLength(1)
  // 파일 확인이 열린 사이 — 오른쪽 탭 닫기(t2 실행 중)로 닫기 확인 창이 뜬다
  await app.fileMenu('close-right')
  expect(app.modal()).not.toBeNull()
  const calls = app.closeCalls.length
  await app.releaseDialog('discard')
  expect(app.closeCalls).toHaveLength(calls)
  expect(app.notice()).toBe(CLOSE_CONFIRM_PENDING)
  expect(app.fileTabShown()).toBe(true)
  expect(getDoc(doc.key)).toBe(doc)
  expect(doc.dirty).toBe(true)
  expect(model.disposed).toBe(false)
})

const splitLayout = (groups) => ({
  root: { kind: 'split', direction: 'row', ratio: 0.5, first: { kind: 'leaf', group: groups[0] }, second: { kind: 'leaf', group: groups[1] } },
  activeGroupId: groups[1].groupId,
})

it('fix2 N2 ⌘D 배선 — 탭 1개 영역의 파일 탭이면 ⌘⌥D 로 안내하지 않는다 · splitPane 없음', async () => {
  const app = await mount({ layout: splitLayout([{ groupId: 'g1', tabOrder: ['t1', 't2'], activeTabId: 't1' }, { groupId: 'g2', tabOrder: [FILE], activeTabId: FILE }]) })
  expect(app.q('[data-render-error]')).toBeNull()
  await app.key({ key: 'd', code: 'KeyD', metaKey: true })
  expect(app.notice()).toContain('탭이 하나뿐이라 새 영역으로 옮길 수도 없다')
  expect(app.notice()).not.toContain('⌘⌥D')
  expect(app.splits).toEqual([])
})

it('fix2 N2 ⌘D 배선 — 탭 2개 이상 영역의 파일 탭이면 ⌘⌥D 로 새 영역 안내 · splitPane 없음', async () => {
  const app = await mount({ layout: splitLayout([{ groupId: 'g1', tabOrder: ['t1'], activeTabId: 't1' }, { groupId: 'g2', tabOrder: [FILE, 't2'], activeTabId: FILE }]) })
  await app.key({ key: 'd', code: 'KeyD', metaKey: true })
  expect(app.notice()).toBe('파일 탭은 pane 으로 나눌 수 없다 — ⌘⌥D 로 새 영역에 옮긴다')
  expect(app.splits).toEqual([])
})
