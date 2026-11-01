// @vitest-environment happy-dom
/* global window, document, requestAnimationFrame */
// LIFE-755 C5·C6 — 사이드바 링크 worktree 카드의 작업 줄 클릭 = 본문 그대로 + 오른쪽 패널에 그 작업 상세. 실제 App 마운트(xterm 만 가짜 —
// App.reveal-cover.test.mjs 와 같은 걸음) + 실제 WorkService·모의 출처(TasksPage.l682.test.tsx 와 같은 걸음).
// C6 「앱 재기동 뒤 페이지 미오픈」 = 연결을 더한 서비스와 같은 저장소로 **새 서비스**를 만든다(런타임 스페이스 목록이 비어 있다 — main 재시작과 같다).
// 합성 state = worktree 둘(`/r` 에 탭 t1·t2, `/r-b` 에 탭 t3 — CORE-2 에 링크).
import { act, Component, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KeybindingStore } from '../../main/keybindings.js'
import { UiPrefsStore } from '../../main/ui-prefs.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { MemoryActivity } from '../../main/work/activity-store.js'
import { mockSourceEntry, seedMockDemoState } from '../../main/work/mock-source.js'
import { WorkService } from '../../main/work/service.js'
import { WorkSourceRegistry } from '../../main/work/source.js'
import { CredentialVault } from '../../main/work/vault.js'
import { FakeCipher, MemoryStore } from '../../main/work/test-kit.js'
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
const worktree = ({ path: worktreePath, branch, isLinked, workspaceId, number, tabs, workLink = null }) => ({
  path: worktreePath, branch, isLinked, openWorkspaceId: workspaceId, gitStatus: gitStatus(branch), displayName: null, comment: null, parentPath: isLinked ? '/r' : null,
  workspace: { workspaceId, label: branch, number, agentStatus: 'idle', focused: workspaceId === 'w1', tabs }, workLink,
})

const settle = async (rounds = 10) => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** 연결 하나를 더한 뒤 같은 저장소로 새 서비스를 만든다 — 앱 재기동처럼 런타임 스페이스 목록이 비어 있다. */
async function freshService() {
  const state = seedMockDemoState()
  const store = new MemoryStore()
  const vault = new CredentialVault(new FakeCipher())
  const sources = new WorkSourceRegistry([mockSourceEntry({ state })])
  let seq = 0
  const deps = { store, vault, sources, activity: new MemoryActivity(), repos: () => [], now: () => Date.now(), newId: () => `id-${(seq += 1)}` }
  const first = new WorkService({ ...deps, onChange: () => {} })
  const added = await first.addConnection({ sourceId: 'mock-jira', token: 'mock_l755_fixture', replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const listeners = []
  const service = new WorkService({ ...deps, onChange: (value) => { for (const listener of listeners) listener(value) } })
  return { service, listeners, connectionId: service.settings().connections[0]?.id ?? '' }
}

async function mount({ itemId }) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'l755-app-'))
  const store = new KeybindingStore(folder)
  store.load()
  const prefs = { ...new UiPrefsStore(folder).get(), sidebarCollapsed: false }
  const work = await freshService()
  const calls = []
  const workLink = { mode: itemId === null ? 'auto' : 'explicit', sourceId: 'mock-jira', connectionId: work.connectionId, key: 'CORE-2', itemId, connected: true }
  const state = {
    revision: 1, sessions: [], sessionsError: null, selectedSession: null, sessionNote: null, link: { phase: 'ready' }, backend: { kind: 'ok' },
    registry: { file: path.join(folder, 'registry'), roots: ['/r'], lastError: null }, registryGeneration: 0,
    repos: [{ root: '/r', name: 'r', error: null, worktrees: [
      worktree({ path: '/r', branch: 'main', isLinked: false, workspaceId: 'w1', number: 1, tabs: [tab('t1', 'w1', 1, [pane('p1', 't1', 'w1')]), tab('t2', 'w1', 2, [pane('p2', 't2', 'w1')])] }),
      worktree({ path: '/r-b', branch: 'CORE-2-card', isLinked: true, workspaceId: 'w2', number: 2, tabs: [tab('t3', 'w2', 1, [pane('p3', 't3', 'w2')])], workLink }),
    ] }],
    terminal: { paneId: null, phase: 'idle', cols: null, rows: null, lastError: null, mouseReporting: false }, terminalGroups: [], integrations: [],
    retainedAgents: [], diagnostics: false, home: folder, orchestrationLineage: { state: 'ready', entries: [] }, herdrTabIds: null,
  }
  const api = {
    getState: async () => state,
    getUiPrefs: async () => prefs,
    getKeybindings: async () => store.get(),
    getWorkSettings: async () => work.service.settings(),
    onWorkSettings: (listener) => { work.listeners.push(listener); return () => { work.listeners.splice(work.listeners.indexOf(listener), 1) } },
    workRequest: (request) => { calls.push(request.call); return work.service.request(request) },
    workActivity: async (query) => work.service.activity(query),
  }
  Reflect.set(window, 'corral', new Proxy(api, { get: (target, key) => (typeof key === 'string' && key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null) }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Boundary, null, createElement(App))) })
  await settle()
  cleanups.push(() => { act(() => root.unmount()); host.remove(); fs.rmSync(folder, { recursive: true, force: true }) })
  const q = (selector) => document.querySelector(selector)
  return {
    q,
    calls,
    click: async (selector) => {
      const target = q(selector)
      if (target === null) throw new Error(`없음: ${selector}`)
      await act(async () => { target.click() })
      await settle()
    },
    /** 본문·작업 페이지·오른쪽 패널을 한 값으로 — 단언 실패 때 어느 칸이 어긋났는지 바로 보인다. */
    view: () => {
      const tasks = q('[data-tasks-page]')
      const panel = q('[data-right-panel]')
      const detail = q('[data-right-panel-body="detail"] [data-issue-detail]')
      return {
        tasks: tasks !== null && !tasks.classList.contains('is-closed'),
        activeTab: q('[data-main-tab][data-active="true"]')?.getAttribute('data-main-tab') ?? null,
        selected: q('[data-term-pane-box].is-selected')?.getAttribute('data-term-pane-box') ?? null,
        panel: panel?.getAttribute('data-right-panel') ?? null,
        panelView: panel?.getAttribute('data-right-panel-view') ?? null,
        detail: detail?.getAttribute('data-issue-detail') ?? null,
      }
    },
  }
}

const LINE = '[data-worktree-issue="CORE-2"]'
const title = (app) => app.q('[data-right-panel-body="detail"] [data-issue-title]')

for (const itemId of ['m-2', null]) {
  it(`C5 ⓐⓑⓒⓓⓔ 작업 줄 클릭(${itemId === null ? 'itemId 없음 — findByKey' : 'itemId 있음'}) → 작업 페이지 닫힌 채 · 본문 그대로 · 패널 상세에 그 작업`, async () => {
    const app = await mount({ itemId })
    expect(app.q('[data-render-error]')).toBeNull()
    expect(app.q(LINE)).not.toBeNull()
    const before = app.view()
    expect(before).toMatchObject({ tasks: false, activeTab: 't1', selected: 'p1', panel: 'closed', detail: null })
    await app.click(LINE)
    expect(app.view()).toEqual({ ...before, tasks: false, panel: 'open', panelView: 'detail', detail: 'CORE-2' })
    expect(app.q('[data-tasks-page]')?.classList.contains('is-closed')).toBe(true)
    // ⓓ 본문이 읽힌다 — 로딩 문구에서 멈추지 않는다.
    expect(title(app)?.value).toBe('카드 저장')
    if (itemId === null) expect(app.calls.some((call) => call.op === 'findByKey' && call.key === 'CORE-2')).toBe(true)
  })
}

it('C5 ⓖ 같은 줄 재클릭 = 패널 상세 그대로(숨기지 않는다)', async () => {
  const app = await mount({ itemId: 'm-2' })
  await app.click(LINE)
  const shown = app.view()
  await app.click(LINE)
  expect(app.view()).toEqual(shown)
  expect(shown).toMatchObject({ panel: 'open', panelView: 'detail', detail: 'CORE-2', tasks: false })
})

it('C5 ⓕ 작업 페이지가 열려 있으면 열린 채 상세만 바뀐다', async () => {
  const app = await mount({ itemId: 'm-2' })
  await app.click('[data-tasks-open]')
  expect(app.view().tasks).toBe(true)
  await app.click(LINE)
  expect(app.view()).toMatchObject({ tasks: true, panel: 'open', panelView: 'detail', detail: 'CORE-2' })
})

it('C6 페이지를 한 번도 안 연 실행 — 상세 머리 스페이스 이름·색이 페이지를 연 뒤와 같다 · 스페이스 목록은 연결 세대마다 한 번', async () => {
  const app = await mount({ itemId: 'm-2' })
  expect(app.calls.filter((call) => call.op === 'listSpaces')).toHaveLength(0)
  await app.click(LINE)
  const space = () => {
    const element = app.q('[data-right-panel-body="detail"] [data-issue-space="CORE"]')
    return { text: element?.textContent ?? null, dot: element?.querySelector('*')?.outerHTML ?? null }
  }
  const closed = space()
  expect(closed.text).toContain('Core Platform')
  expect(closed.dot).not.toBeNull()
  expect(app.calls.filter((call) => call.op === 'listSpaces')).toHaveLength(1)
  await app.click('[data-tasks-open]')
  expect(app.view().tasks).toBe(true)
  expect(space()).toEqual(closed)
  // 페이지를 열어도 이미 받은 연결 세대는 다시 보내지 않는다(R1-C).
  expect(app.calls.filter((call) => call.op === 'listSpaces')).toHaveLength(1)
})
