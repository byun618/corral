// @vitest-environment happy-dom
// LIFE-702 수정 r3 — H2(공백만 검색어 · 배치 숨김 출처의 보드 분기) · H4(필터 원인 빈 상태 = 필터를 지웠을 때 그 보기에 보일 카드가 있을 때만).
// H4 재현 출발점: 리뷰어 Grok 프로브 `raw/review/grok-r3-raw/probe-r3.test.tsx`.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import { TasksPage } from './TasksPage.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const BASE_CAPS: WorkCapabilities = { resolution: { state: 'on' }, querySearch: { state: 'hidden' },
  transition: { mode: 'any' }, placement: { state: 'on' }, relations: { state: 'on' }, parentChange: { state: 'on' },
  order: { state: 'on' }, cursorPaging: { state: 'disabled', reason: '커서 없음' },
  conflictCheck: { state: 'disabled', reason: 'x' }, comments: { state: 'disabled', reason: 'x' }, history: { state: 'disabled', reason: 'x' }, workLinkStore: { state: 'disabled', reason: 'x' },
}
const STATUSES: WorkStatus[] = [
  { key: 'todo', label: '할 일', category: 'todo', order: 0, color: null },
  { key: 'doing', label: '개발 중', category: 'in_progress', order: 1, color: null },
  { key: 'done', label: '완료', category: 'done', order: 2, color: null },
]
const DAY = 86_400_000
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
const item = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => ({ bodyLock: null, doneAt: null,
  spaceKey: 's1', title: `제목 ${over.key}`, body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'todo', category: 'todo', priority: 'medium', dueAt: null,
  parentId: null, placement: 'board', rank: '1', resolution: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [], ...over,
})
const done = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => item({ statusKey: 'done', category: 'done', resolution: 'completed', ...over })
const BUG = { key: 'bug', label: 'Bug', childKinds: [] }

let host: HTMLDivElement
let root: Root
let caps: WorkCapabilities
let items: WorkItem[]

function respond(request: WorkRequest, result: Extract<WorkResponse, { ok: true }>['result']): WorkResponse {
  return { requestId: request.requestId, connectionId: request.connectionId, ok: true, result }
}
function answer(request: WorkRequest): WorkResponse {
  const { call } = request
  switch (call.op) {
    case 'listSpaces': return respond(request, { op: 'listSpaces', spaces: [], capabilities: caps })
    case 'listStatuses': return respond(request, { op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task', childKinds: [] }, BUG] })
    case 'listItems': return respond(request, { op: 'listItems', items, nextCursor: null, truncated: false })
    default: return { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'unsupported', message: call.op, status: null } }
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  caps = BASE_CAPS
  let prefs: unknown = undefined
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: prefs }),
    setUiPrefs: (patch: { tasksPage?: unknown }) => { if ('tasksPage' in patch) prefs = patch.tasksPage },
    getWorkSettings: async (): Promise<WorkSettingsState> => ({
      sources: [{ accountFields: [], tokenHint: null, queryPattern: null, id: 'src-a', name: 'Source A', mono: 'SA', addLabel: '', formTitle: '', tokenLabel: '', tokenPrefix: null, keyPattern: 'K-\\d+' }],
      connections: [{ account: {},
        id: 'c1', sourceId: 'src-a', name: 'Source A', mono: 'SA', tokenTail: 'wxyz', addedAt: 0, generation: 1, status: 'ok', pending: null, error: null, checkedAt: 0,
        spaces: [{ key: 's1', name: 'corral', color: null, openCount: 1, hidden: false, capabilities: {} }], hiddenSpaceKeys: [], capabilities: caps,
      }],
      repoDefaults: [],
    }),
    onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => Promise.resolve(answer(request)),
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
async function renderPage(): Promise<void> {
  act(() => root.render(createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
}
const q = (selector: string): Element | null => host.querySelector(selector)
const cards = (): string[] => [...host.querySelectorAll('[data-issue-card]')].map((element) => element.getAttribute('data-issue-card') ?? '').sort()
const rowsIn = (selector: string): string[] => [...host.querySelectorAll(`${selector} [data-issue-row]`)].map((element) => element.getAttribute('data-issue-row') ?? '').sort()
function click(target: Element | null): void {
  if (target === null) throw new Error('클릭 대상 없음')
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function typeSearch(value: string): void {
  const input = q('[data-tasks-search]')
  if (!(input instanceof HTMLInputElement)) throw new Error('검색 칸 없음')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function pickKind(label: string): void {
  click(q('[data-filter="kind"]'))
  click([...host.querySelectorAll('[data-tasks-menu="kind"] [role="menuitemcheckbox"]')].find((element) => element.textContent?.includes(label)) ?? null)
}

describe('H2 숨김 경계', () => {
  it('공백만 검색어는 검색이 아니다 — 오래된 완료는 계속 숨는다', async () => {
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY) }), item({ id: 'i2', key: 'K-2', rank: '2' })]
    await renderPage()
    typeSearch('   ')
    await settle()
    expect(cards()).toEqual(['K-2'])
  })

  it('배치를 숨기는 출처(placement hidden)의 보드에서도 오래된 완료가 숨는다', async () => {
    caps = { ...BASE_CAPS, placement: { state: 'hidden' } }
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY), placement: null }), item({ id: 'i2', key: 'K-2', rank: '2', placement: null })]
    await renderPage()
    expect(q('[data-tasks-board]')).not.toBeNull()
    expect(cards()).toEqual(['K-2'])
  })
})

describe('H4 필터 원인 빈 상태 — 필터를 지웠을 때 그 보기에 보일 카드가 있을 때만', () => {
  it('Grok r3 장면 — 보드 배치는 전부 숨긴 완료, 열린 일감은 백로그에만: 보드에서 막힘 필터 → 필터 빈 상태 없이 보드 그대로', async () => {
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY) }), item({ id: 'i2', key: 'K-2', placement: 'backlog', rank: '2' })]
    await renderPage()
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-tasks-empty]')).toBeNull()
    expect(host.textContent).not.toContain('필터를 지우면 다시 보입니다')
    expect(q('[data-tasks-board]')).not.toBeNull()
    expect(host.textContent).not.toMatch(/숨김|숨긴/)
  })

  it('같은 자료의 백로그 보기 — 필터를 지우면 백로그 행이 보이니 필터 빈 상태', async () => {
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY) }), item({ id: 'i2', key: 'K-2', placement: 'backlog', rank: '2' })]
    await renderPage()
    click(q('[data-tasks-view-tab="backlog"]'))
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-tasks-empty="filter"]')).not.toBeNull()
    click(q('[data-clear-filters]'))
    await settle()
    expect(rowsIn('[data-backlog-section="backlog"]')).toEqual(['K-2'])
  })

  it('필터를 통과한 숨긴 완료가 있어도, 지우면 보일 열린 일감이 있으면 필터 빈 상태(검색 원인이 아니다)', async () => {
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY), kind: BUG }), item({ id: 'i2', key: 'K-2', rank: '2' })]
    await renderPage()
    pickKind('Bug')
    await settle()
    expect(q('[data-tasks-empty="filter"]')).not.toBeNull()
    expect(host.textContent).not.toContain('검색 결과 없음')
  })
})
