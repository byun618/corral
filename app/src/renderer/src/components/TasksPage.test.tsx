// @vitest-environment happy-dom
// LIFE-601 작업 페이지 화면 — 가짜 preload(`window.corral`)로 그리기·배너·빈 상태·키·끌기 반영/되돌리기/실패 원위치/늦은 응답 폐기를 본다.
// 출처 id 는 중립 이름(`src-a`)이다 — 화면은 출처를 모르고 main 이 준 descriptor·능력 표만 본다(K3).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkCapabilities, WorkError, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import { useTasksPage, type MoveNotice, type TasksPageModel } from '../hooks/useTasksPage.js'
import { TasksPage } from './TasksPage.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const CAPS: WorkCapabilities = {
  transition: { mode: 'any' }, placement: { state: 'on' }, relations: { state: 'on' }, parentChange: { state: 'on' },
  order: { state: 'disabled', reason: '순서 도구가 없습니다 (테스트)' }, cursorPaging: { state: 'disabled', reason: '커서 없음' },
  conflictCheck: { state: 'disabled', reason: 'x' }, comments: { state: 'disabled', reason: 'x' }, workLinkStore: { state: 'disabled', reason: 'x' },
}
const STATUSES: WorkStatus[] = [
  { key: 'todo', label: '할 일', category: 'todo', order: 0, color: null },
  { key: 'doing', label: '개발 중', category: 'in_progress', order: 1, color: null },
  { key: 'done', label: '완료', category: 'done', order: 2, color: null },
]
const item = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => ({
  spaceKey: 's1', title: `제목 ${over.key}`, body: null, kind: { key: 'task', label: 'Task' }, statusKey: 'todo', category: 'todo', priority: 'medium', dueAt: null,
  parentId: null, placement: 'board', rank: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [], ...over,
})

let host: HTMLDivElement
let root: Root
let settings: WorkSettingsState
let items: WorkItem[]
let listError: WorkError | null
let calls: WorkCall[]
/** 연산마다 응답을 직접 풀 수 있게 — 없으면 즉시 답한다. */
let hold: ((request: WorkRequest) => Promise<WorkResponse> | null) | null
let closed: number

function answer(request: WorkRequest): WorkResponse {
  const { requestId, connectionId, call } = request
  const ok = (result: Extract<WorkResponse, { ok: true }>['result']): WorkResponse => ({ requestId, connectionId, ok: true, result })
  switch (call.op) {
    case 'listSpaces': return ok({ op: 'listSpaces', spaces: [], capabilities: CAPS })
    case 'listStatuses': return ok({ op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task' }, { key: 'bug', label: 'Bug' }] })
    case 'listItems': return listError === null ? ok({ op: 'listItems', items, nextCursor: null, truncated: false }) : { requestId, connectionId, ok: false, error: listError }
    case 'findByKey': return ok({ op: 'findByKey', item: items.find((entry) => entry.key.toUpperCase() === call.key.toUpperCase()) ?? null })
    case 'changeStatus': {
      const found = items.find((entry) => entry.id === call.itemId)
      if (found === undefined) return { requestId, connectionId, ok: false, error: { kind: 'rejected', message: '없음', status: null } }
      return ok({ op: 'changeStatus', item: { ...found, statusKey: call.statusKey, category: STATUSES.find((status) => status.key === call.statusKey)?.category ?? 'todo' } })
    }
    default: return { requestId, connectionId, ok: false, error: { kind: 'unsupported', message: 'x', status: null } }
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  settings = {
    sources: [{ id: 'src-a', name: 'Source A', mono: 'SA', addLabel: '', formTitle: '', tokenLabel: '', tokenPrefix: null, keyPattern: 'K-\\d+' }],
    connections: [{
      id: 'c1', sourceId: 'src-a', name: 'Source A', mono: 'SA', tokenTail: 'wxyz', addedAt: 0, generation: 1, status: 'ok', pending: null, error: null, checkedAt: 0,
      spaces: [{ key: 's1', name: 'corral', color: null, openCount: 2, hidden: false }], hiddenSpaceKeys: [], capabilities: CAPS,
    }],
    repoDefaults: [],
  }
  items = [
    item({ id: 'i1', key: 'K-1' }),
    item({ id: 'i2', key: 'K-2', statusKey: 'doing', category: 'in_progress', openBlockerCount: 1, openBlockers: [{ id: 'i1', key: 'K-1', title: 'x' }] }),
    item({ id: 'i3', key: 'K-3', statusKey: 'legal', placement: 'backlog' }),
  ]
  listError = null
  calls = []
  hold = null
  closed = 0
  let prefs: unknown = undefined
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: prefs }),
    setUiPrefs: (patch: { tasksPage?: unknown }) => { if ('tasksPage' in patch) prefs = patch.tasksPage },
    getWorkSettings: async () => settings,
    onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => {
      calls.push(request.call)
      return hold?.(request) ?? Promise.resolve(answer(request))
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function renderPage(): Promise<void> {
  act(() => root.render(createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', onClose: () => { closed += 1 }, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
}

const q = (selector: string): Element | null => host.querySelector(selector)
const key = (target: EventTarget, init: KeyboardEventInit): void => { act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }) }

describe('그리기 (C6·C13 계측)', () => {
  it('보드 — 분류 밴드 · 상태 칸 · 칸 없는 상태 점선 칸 · 막힘 배지 · 백로그 작업은 보드에 없다', async () => {
    items[2] = { ...items[2]!, placement: 'board' }
    await renderPage()
    for (const selector of ['[data-tasks-page]', '[data-tasks-views]', '[data-space-switch]', '[data-tasks-search]', '[data-tasks-close]', '[data-tasks-filters]', '[data-filter="kind"]', '[data-filter="priority"]', '[data-filter="blocked"]', '[data-filter="working"]', '[data-tasks-board]', '[data-board-band="todo"]']) {
      expect(q(selector), selector).not.toBeNull()
    }
    expect([...host.querySelectorAll('[data-board-column]')].map((element) => element.getAttribute('data-board-column'))).toEqual(['st:todo', 'st:doing', 'st:done', 'st:__unmapped'])
    expect(q('[data-board-column="st:__unmapped"] [data-issue-card="K-3"]')).not.toBeNull()
    expect(q('[data-issue-card="K-2"] [data-issue-blocked]')?.textContent).toContain('막힘 · K-1')
    // 만들기 진입점은 그리지 않는다(D5).
    expect(q('[data-tasks-create]')).toBeNull()
    expect(q('[data-inline-add]')).toBeNull()
  })

  it('카드 클릭 = 선택 표시만, 다시 누르면 해제(D2)', async () => {
    await renderPage()
    const card = q('[data-issue-card="K-1"]')
    act(() => { card?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(q('[data-issue-card="K-1"]')?.classList.contains('is-selected')).toBe(true)
    act(() => { q('[data-issue-card="K-1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(q('[data-issue-card="K-1"]')?.classList.contains('is-selected')).toBe(false)
  })
})

describe('불러오기·배너·빈 상태 (C5) — 분기마다 그 오류를 만들어 본다', () => {
  it('연결 없음', async () => {
    settings = { ...settings, connections: [] }
    await renderPage()
    expect(q('[data-tasks-empty="no-connection"]')).not.toBeNull()
  })

  for (const [kind, banner] of [['auth', 'auth'], ['forbidden', 'forbidden'], ['network', 'offline']] as const) {
    it(`${kind} 오류 → 배너 ${banner} · 빈 상태를 그리지 않는다`, async () => {
      listError = { kind, message: `${kind} 사유`, status: null }
      await renderPage()
      expect(q(`[data-tasks-banner="${banner}"]`)).not.toBeNull()
      expect(q('[data-tasks-empty]')).toBeNull()
      expect(q('[data-tasks-board]')).toBeNull()
    })
  }

  it('불러오는 중 표시', async () => {
    let release: () => void = () => {}
    hold = (request) => (request.call.op === 'listItems' ? new Promise((resolve) => { release = () => resolve(answer(request)) }) : null)
    await renderPage()
    expect(q('[data-tasks-loading]')).not.toBeNull()
    release()
    await settle()
    expect(q('[data-tasks-loading]')).toBeNull()
    expect(q('[data-tasks-board]')).not.toBeNull()
  })

  it('빈 상태 — 스페이스 비어 있음 · 필터 때문 · 검색 결과 없음', async () => {
    items = []
    await renderPage()
    expect(q('[data-tasks-empty="space"]')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    items = [item({ id: 'i1', key: 'K-1' })]
    await renderPage()
    act(() => { q('[data-filter="blocked"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(q('[data-tasks-empty="filter"]')).not.toBeNull()
    expect(q('[data-clear-filters]')).not.toBeNull()
    act(() => { q('[data-clear-filters]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(q('[data-clear-filters]')).toBeNull()
  })
})

describe('키 (C4)', () => {
  it('1–4 보기 전환 · 입력 중에는 글자 · / 검색 포커스 · Esc 단계(입력 blur → 닫기)', async () => {
    await renderPage()
    key(document.body, { key: '2' })
    expect(q('[data-tasks-backlog]')).not.toBeNull()
    expect(q('[data-backlog-section="backlog"] [data-issue-row="K-3"]')).not.toBeNull()
    key(document.body, { key: '3' })
    expect(q('[data-tasks-list]')).not.toBeNull()
    key(document.body, { key: '/' })
    const search = q('[data-tasks-search]')
    expect(document.activeElement).toBe(search)
    key(search ?? document.body, { key: '1' })
    expect(q('[data-tasks-list]')).not.toBeNull()
    key(search ?? document.body, { key: 'Escape' })
    expect(document.activeElement).not.toBe(search)
    expect(closed).toBe(0)
    key(document.body, { key: 'Escape', isComposing: true })
    expect(closed).toBe(0)
    key(document.body, { key: 'Escape' })
    expect(closed).toBe(1)
  })
})

describe('검색 (C10)', () => {
  it('키 모양이면 키 조회(E2)를 보내고, 아니면 텍스트로 거른다', async () => {
    await renderPage()
    const search = q('[data-tasks-search]')
    if (!(search instanceof HTMLInputElement)) throw new Error('search')
    const type = (value: string): void => {
      act(() => {
        Reflect.get(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ?? {}, 'set')?.call(search, value)
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    type('k-2')
    await settle()
    expect(calls.some((call) => call.op === 'findByKey' && call.key === 'K-2')).toBe(true)
    type('제목 K-1')
    await settle()
    expect(q('[data-issue-card="K-1"]')).not.toBeNull()
    expect(q('[data-issue-card="K-2"]')).toBeNull()
  })
})

describe('끌기 반영 (C7) — 훅 수준', () => {
  let model: TasksPageModel | null = null
  const notices: MoveNotice[] = []
  function Probe(): null {
    model = useTasksPage({ open: true, repos: [], activeRepoRoot: null, notify: (notice) => notices.push(notice) })
    return null
  }
  const mount = async (): Promise<TasksPageModel> => {
    notices.length = 0
    act(() => root.render(createElement(Probe)))
    await settle()
    if (model === null) throw new Error('model')
    return model
  }
  const rowOf = (current: TasksPageModel, id: string) => {
    const row = current.rows.find((entry) => entry.item.id === id)
    if (row === undefined) throw new Error(id)
    return row
  }

  it('즉시 반영 → 되돌리기 토스트 → 되돌리면 이전 값 요청이 나가고 화면도 돌아간다', async () => {
    let current = await mount()
    await act(async () => { void current.move({ row: rowOf(current, 'i1'), intent: { kind: 'status', statusKey: 'doing' } }) })
    await settle()
    current = model ?? current
    expect(rowOf(current, 'i1').item.statusKey).toBe('doing')
    const moved = notices.find((notice) => notice.kind === 'moved')
    if (moved === undefined || moved.kind !== 'moved') throw new Error('no undo toast')
    act(() => moved.undo())
    await settle()
    current = model ?? current
    expect(calls.filter((call) => call.op === 'changeStatus').map((call) => (call.op === 'changeStatus' ? call.statusKey : ''))).toEqual(['doing', 'todo'])
    expect(rowOf(current, 'i1').item.statusKey).toBe('todo')
    expect(notices.some((notice) => notice.kind === 'undone')).toBe(true)
  })

  it('출처가 거절하면 원래 자리로 + 오류 토스트', async () => {
    hold = (request) => (request.call.op === 'changeStatus' ? Promise.resolve({ requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'rejected', message: '워크플로에 이 전이가 없습니다.', status: null } }) : null)
    let current = await mount()
    await act(async () => { void current.move({ row: rowOf(current, 'i1'), intent: { kind: 'status', statusKey: 'done' } }) })
    await settle()
    current = model ?? current
    expect(rowOf(current, 'i1').item.statusKey).toBe('todo')
    expect(notices.some((notice) => notice.kind === 'failed' && notice.message.includes('워크플로'))).toBe(true)
  })

  it('늦은 응답 폐기 — 같은 작업에 두 번 옮기고 앞 응답이 늦게 오면 뒤 결과가 남는다', async () => {
    const pending: Array<{ request: WorkRequest; resolve: (response: WorkResponse) => void }> = []
    hold = (request) => (request.call.op === 'changeStatus' ? new Promise((resolve) => { pending.push({ request, resolve }) }) : null)
    let current = await mount()
    await act(async () => { void current.move({ row: rowOf(current, 'i1'), intent: { kind: 'status', statusKey: 'doing' } }) })
    await settle()
    current = model ?? current
    await act(async () => { void current.move({ row: rowOf(current, 'i1'), intent: { kind: 'status', statusKey: 'done' } }) })
    await settle()
    expect(pending).toHaveLength(2)
    const [first, second] = pending
    if (first === undefined || second === undefined) throw new Error('pending')
    // 뒤 요청이 먼저 답하고, 앞 요청이 늦게 답한다.
    await act(async () => { second.resolve(answer(second.request)) })
    await settle()
    await act(async () => { first.resolve(answer(first.request)) })
    await settle()
    current = model ?? current
    expect(rowOf(current, 'i1').item.statusKey).toBe('done')
    expect(notices.filter((notice) => notice.kind === 'moved')).toHaveLength(1)
  })
})
