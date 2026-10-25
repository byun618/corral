// @vitest-environment happy-dom
// LIFE-702 수정 r1 — 리뷰 r1 지적 F1(낙관·성공 반영의 doneAt) · F3(now 틱) · F4(필터 + 숨김 빈 상태).
// F1 재현 출발점: 리뷰어 Grok 프로브 `raw/review/grok-r1-raw/probe-ui.test.tsx`. DOM 이벤트(mousedown/move/up·click·input)로 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import { DONE_HIDE_MS } from '../tasks-model.js'
import { TasksPage } from './TasksPage.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const CAPS: WorkCapabilities = { resolution: { state: 'on' }, querySearch: { state: 'hidden' },
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

let host: HTMLDivElement
let root: Root
let items: WorkItem[]
/** 쓰기 뒤 목록 재조회를 실패시킨다(리뷰어 재현의 「재조회 실패」). */
let failListAfterWrite: boolean
/** changeStatus 응답을 붙들어 「놓은 직후」 를 본다. */
let holdWrite: boolean
let releaseWrite: () => void
let writes: { doneAt: string | null }[]

function respond(request: WorkRequest, result: Extract<WorkResponse, { ok: true }>['result']): WorkResponse {
  return { requestId: request.requestId, connectionId: request.connectionId, ok: true, result }
}
function reject(request: WorkRequest, message: string): WorkResponse {
  return { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'rejected', message, status: null } }
}
/** 서버 쪽 상태 변경 — LA 규칙(진입=지금 · 이탈=null · done→done 유지). */
function serverChange(call: Extract<WorkRequest['call'], { op: 'changeStatus' }>): WorkItem | null {
  const found = items.find((entry) => entry.id === call.itemId)
  const status = STATUSES.find((entry) => entry.key === call.statusKey)
  if (found === undefined || status === undefined) return null
  const doneAt = status.category === 'done' ? (found.category === 'done' ? found.doneAt : new Date().toISOString()) : null
  const next: WorkItem = { ...found, statusKey: status.key, category: status.category, resolution: status.category === 'done' ? (call.resolution ?? 'completed') : null, doneAt }
  items = items.map((entry) => (entry.id === next.id ? next : entry))
  writes.push({ doneAt })
  return next
}
function answer(request: WorkRequest): Promise<WorkResponse> {
  const { call } = request
  switch (call.op) {
    case 'listSpaces': return Promise.resolve(respond(request, { op: 'listSpaces', spaces: [], capabilities: CAPS }))
    case 'listStatuses': return Promise.resolve(respond(request, { op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task', childKinds: [] }, { key: 'bug', label: 'Bug', childKinds: [] }] }))
    case 'listItems':
      if (failListAfterWrite && writes.length > 0) return new Promise((resolve) => setTimeout(() => resolve({ requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'network', message: '목록 재조회 실패', status: null } }), 30))
      return Promise.resolve(respond(request, { op: 'listItems', items, nextCursor: null, truncated: false }))
    case 'getItem': {
      const found = items.find((entry) => entry.id === call.itemId)
      return Promise.resolve(found === undefined ? reject(request, '없음') : respond(request, { op: 'getItem', item: { ...found, body: '', relations: [] } }))
    }
    case 'listTransitions': return Promise.resolve(respond(request, { op: 'listTransitions', statusKeys: STATUSES.map((status) => status.key), blocked: [] }))
    case 'changeStatus': {
      const send = (): WorkResponse => {
        const next = serverChange(call)
        return next === null ? reject(request, '없음') : respond(request, { op: 'changeStatus', item: { ...next, body: '', relations: [] } })
      }
      if (!holdWrite) return Promise.resolve(send())
      return new Promise((resolve) => { releaseWrite = () => resolve(send()) })
    }
    default: return Promise.resolve({ requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'unsupported', message: call.op, status: null } })
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  failListAfterWrite = false
  holdWrite = false
  releaseWrite = () => {}
  writes = []
  const settings: WorkSettingsState = {
    sources: [{ accountFields: [], tokenHint: null, queryPattern: null, id: 'src-a', name: 'Source A', mono: 'SA', addLabel: '', formTitle: '', tokenLabel: '', tokenPrefix: null, keyPattern: 'K-\\d+' }],
    connections: [{ account: {},
      id: 'c1', sourceId: 'src-a', name: 'Source A', mono: 'SA', tokenTail: 'wxyz', addedAt: 0, generation: 1, status: 'ok', pending: null, error: null, checkedAt: 0,
      spaces: [{ key: 's1', name: 'corral', color: null, openCount: 1, hidden: false, capabilities: {} }], hiddenSpaceKeys: [], capabilities: CAPS,
    }],
    repoDefaults: [],
  }
  let prefs: unknown = undefined
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: prefs }),
    setUiPrefs: (patch: { tasksPage?: unknown }) => { if ('tasksPage' in patch) prefs = patch.tasksPage },
    getWorkSettings: async () => settings,
    onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => answer(request),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const wait = async (ms: number): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }
async function renderPage(): Promise<void> {
  act(() => root.render(createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
}
const q = (selector: string): Element | null => host.querySelector(selector)
const cards = (): string[] => [...host.querySelectorAll('[data-issue-card]')].map((element) => element.getAttribute('data-issue-card') ?? '').sort()
function click(target: Element | null): void {
  if (target === null) throw new Error('클릭 대상 없음')
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function mouse(target: EventTarget, name: string, x = 10, y = 10): void {
  act(() => { target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) })
}
/** 실제 끌기 경로 — 손잡이 mousedown → 문턱 넘는 move → mouseup. 응답을 붙들었으면 놓은 직후에서 멈춘다. */
async function dragTo({ key, zone }: { key: string; zone: string }): Promise<void> {
  const handle = q(`[data-issue-card="${key}"]`)
  const target = q(`[data-drop-zone="${zone}"]`)
  if (handle === null || target === null) throw new Error(`끌기 대상 없음 ${key} → ${zone} · cards=${cards().join(',')}`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  mouse(handle, 'mousedown')
  mouse(document, 'mousemove', 50, 500)
  await settle()
  mouse(document, 'mouseup', 50, 500)
  await settle()
}

describe('F1 끌기 — 옛 doneAt 이 남은 비완료 카드를 완료로 옮겨도 보드에 남는다', () => {
  it('놓은 직후 · 성공 뒤 · 재조회 실패 뒤 모두 보인다', async () => {
    failListAfterWrite = true
    holdWrite = true
    items = [item({ id: 'i1', key: 'K-1', statusKey: 'doing', category: 'in_progress', doneAt: ago(20 * DAY) })]
    await renderPage()
    expect(cards()).toEqual(['K-1'])
    await dragTo({ key: 'K-1', zone: 'col:st:done' })
    expect(cards(), '놓은 직후').toEqual(['K-1'])
    act(() => releaseWrite())
    await settle()
    expect(writes[0]?.doneAt).not.toBeNull()
    expect(cards(), '성공 뒤').toEqual(['K-1'])
    await wait(60)
    await settle()
    expect(cards(), '재조회 실패 뒤').toEqual(['K-1'])
    expect(q('[data-board-column="st:done"] [data-issue-card="K-1"]')).not.toBeNull()
  })

  it('검색으로 드러낸 오래된 완료를 완료 밖으로 끈 뒤 성공 반영이 서버 doneAt(null)을 싣는다 — 검색을 지워도 할 일 칸에 남는다', async () => {
    failListAfterWrite = true
    items = [item({ id: 'i1', key: 'K-1', statusKey: 'done', category: 'done', resolution: 'completed', doneAt: ago(20 * DAY) }), item({ id: 'i2', key: 'K-2' })]
    await renderPage()
    expect(cards()).toEqual(['K-2'])
    const input = q('[data-tasks-search]')
    if (!(input instanceof HTMLInputElement)) throw new Error('검색 칸 없음')
    const type = (value: string): void => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    type('제목')
    await settle()
    expect(cards()).toEqual(['K-1', 'K-2'])
    await dragTo({ key: 'K-1', zone: 'col:st:todo' })
    await wait(60)
    await settle()
    type('')
    await settle()
    expect(writes[0]?.doneAt).toBeNull()
    expect(q('[data-board-column="st:todo"] [data-issue-card="K-1"]')).not.toBeNull()
  })
})

describe('F1 상세 — 낙관 반영도 doneAt 을 맞춘다', () => {
  it('상세에서 완료로 바꾸면 응답 전에도 카드가 보드에 남는다', async () => {
    holdWrite = true
    items = [item({ id: 'i1', key: 'K-1', statusKey: 'doing', category: 'in_progress', doneAt: ago(20 * DAY) })]
    await renderPage()
    click(q('[data-issue-card="K-1"]'))
    await settle()
    click(q('[data-issue-status]'))
    await settle()
    click(q('[data-status-row="done"][data-status-resolution="completed"]'))
    await settle()
    expect(writes).toHaveLength(0)
    expect(cards(), '응답 전').toEqual(['K-1'])
    act(() => releaseWrite())
    await settle()
    expect(cards(), '응답 뒤').toEqual(['K-1'])
  })
})

describe('F3 now 틱 — 경계 직전 카드가 1분 틱 뒤 보드에서 빠진다', () => {
  it('14일 30초 전에 보이던 완료가 60초 뒤 숨는다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    items = [item({ id: 'i1', key: 'K-1', statusKey: 'done', category: 'done', resolution: 'completed', doneAt: ago(DONE_HIDE_MS - 30_000) }), item({ id: 'i2', key: 'K-2' })]
    await renderPage()
    expect(cards()).toEqual(['K-1', 'K-2'])
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(cards()).toEqual(['K-2'])
  })
})

describe('F4 필터 + 숨김 — 「필터를 지우면 다시 보입니다」 가 거짓이 되지 않는다', () => {
  it('필터를 통과한 것이 오래된 완료뿐이면 필터 빈 상태 대신 보드를 그대로 그린다', async () => {
    items = [
      item({ id: 'i1', key: 'K-1', statusKey: 'done', category: 'done', resolution: 'completed', doneAt: ago(20 * DAY), kind: { key: 'bug', label: 'Bug', childKinds: [] } }),
    ]
    await renderPage()
    click(q('[data-filter="kind"]'))
    click([...host.querySelectorAll('[data-tasks-menu="kind"] [role="menuitemcheckbox"]')].find((element) => element.textContent?.includes('Bug')) ?? null)
    await settle()
    expect(q('[data-tasks-empty]')).toBeNull()
    expect(host.textContent).not.toContain('필터를 지우면 다시 보입니다')
    expect(q('[data-tasks-board]')).not.toBeNull()
    expect(host.textContent).not.toMatch(/숨김|숨긴/)
  })

  it('대조 — 필터를 통과한 행이 아예 없으면 지금처럼 필터 빈 상태', async () => {
    items = [item({ id: 'i1', key: 'K-1', statusKey: 'done', category: 'done', resolution: 'completed', doneAt: ago(20 * DAY) })]
    await renderPage()
    click(q('[data-filter="blocked"]'))
    expect(q('[data-tasks-empty="filter"]')).not.toBeNull()
  })
})
