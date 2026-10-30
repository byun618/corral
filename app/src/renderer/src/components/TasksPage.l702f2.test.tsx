// @vitest-environment happy-dom
// LIFE-702 수정 r2 — 리뷰 r2 지적 G1(끌기 실패 원복·상세 되돌리기 낙관이 doneAt 을 원래 값으로) · G3(필터를 지워도 보일 행이 없으면 필터 빈 상태 금지).
// G1 재현 출발점: 리뷰어 Grok 프로브 `raw/review/grok-r2-raw/probe-r2.test.tsx`(재조회 응답을 페인트 뒤로 붙든다 — 사용자 경로의 IPC 와 같다).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import { TasksPageInPanel } from './TasksPage.harness.js'

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
const done = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => item({ statusKey: 'done', category: 'done', resolution: 'completed', ...over })

let host: HTMLDivElement
let root: Root
let items: WorkItem[]
let failWrite: boolean
/** 첫 목록 뒤의 재조회를 실패시킨다. */
let failList: boolean
/** 첫 목록 뒤의 재조회 응답을 붙든다(페인트 뒤 응답). */
let holdList: boolean
let releaseList: () => void
let holdWrite: boolean
let releaseWrite: () => void
let listCalls: number
let writes: number

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
  return next
}
function answer(request: WorkRequest): Promise<WorkResponse> {
  const { call } = request
  switch (call.op) {
    case 'listSpaces': return Promise.resolve(respond(request, { op: 'listSpaces', spaces: [], capabilities: CAPS }))
    case 'listStatuses': return Promise.resolve(respond(request, { op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task', childKinds: [] }, { key: 'bug', label: 'Bug', childKinds: [] }] }))
    case 'listItems': {
      listCalls += 1
      const later = listCalls > 1
      const send = (): WorkResponse => (failList && later
        ? { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'network', message: '목록 재조회 실패', status: null } }
        : respond(request, { op: 'listItems', items, nextCursor: null, truncated: false }))
      if (holdList && later) return new Promise((resolve) => { releaseList = () => resolve(send()) })
      return Promise.resolve(send())
    }
    case 'getItem': {
      const found = items.find((entry) => entry.id === call.itemId)
      return Promise.resolve(found === undefined ? reject(request, '없음') : respond(request, { op: 'getItem', item: { ...found, body: '', relations: [] } }))
    }
    case 'listTransitions': return Promise.resolve(respond(request, { op: 'listTransitions', statusKeys: STATUSES.map((status) => status.key), blocked: [] }))
    case 'changeStatus': {
      writes += 1
      const send = (): WorkResponse => {
        if (failWrite) return reject(request, '쓰기 거절')
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
  failWrite = false
  failList = false
  holdList = false
  holdWrite = false
  releaseList = () => {}
  releaseWrite = () => {}
  listCalls = 0
  writes = 0
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
  toast.dismiss()
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
  act(() => root.render(createElement('div', null,
    createElement(TasksPageInPanel, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }),
    createElement(Toaster))))
  await settle()
}
const q = (selector: string): Element | null => host.querySelector(selector)
const cards = (): string[] => [...host.querySelectorAll('[data-issue-card]')].map((element) => element.getAttribute('data-issue-card') ?? '').sort()
const columnOf = (key: string): string | null => host.querySelector(`[data-issue-card="${key}"]`)?.closest('[data-board-column]')?.getAttribute('data-board-column') ?? null
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
function mouse(target: EventTarget, name: string, x = 10, y = 10): void {
  act(() => { target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) })
}
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

describe('G1 끌기 실패 원복 — doneAt 을 이동 전 값으로', () => {
  it('검색으로 드러낸 오래된 완료를 할 일로 끌기 → 거절 → 재조회 실패(페인트 뒤) → 검색 지움 → 숨는다', async () => {
    failWrite = true
    failList = true
    holdList = true
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY) }), item({ id: 'i2', key: 'K-2', rank: '2' })]
    await renderPage()
    expect(cards()).toEqual(['K-2'])
    typeSearch('제목')
    await settle()
    expect(cards()).toEqual(['K-1', 'K-2'])
    await dragTo({ key: 'K-1', zone: 'col:st:todo' })
    await wait(40)
    await settle()
    expect(writes).toBe(1)
    expect(columnOf('K-1'), '원복 — 완료 칸').toBe('st:done')
    typeSearch('')
    await settle()
    expect(cards(), '재조회 전 · 검색 지움').toEqual(['K-2'])
    act(() => releaseList())
    await wait(40)
    await settle()
    expect(q('[data-tasks-banner="offline"]'), '재조회 실패 배너').not.toBeNull()
    expect(cards(), '재조회 실패 뒤').toEqual(['K-2'])
  })

  it('13일 된 완료 — 거절·재조회 실패 뒤 2일 지난 틱에 숨는다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    failWrite = true
    failList = true
    holdList = true
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(13 * DAY) }), item({ id: 'i2', key: 'K-2', rank: '2' })]
    await renderPage()
    expect(cards()).toEqual(['K-1', 'K-2'])
    await dragTo({ key: 'K-1', zone: 'col:st:todo' })
    await wait(40)
    await settle()
    expect(columnOf('K-1')).toBe('st:done')
    act(() => releaseList())
    await wait(40)
    await settle()
    expect(cards(), '재조회 실패 직후').toEqual(['K-1', 'K-2'])
    vi.setSystemTime(Date.now() + 2 * DAY)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(cards(), '2일 틱').toEqual(['K-2'])
  })
})

// 수정 r3 H1 — 되돌리기(할 일 → 완료)는 출처에서 done 「진입」 이라 서버가 새 시각을 쓴다. 옛 doneAt 을 되살리면 서버 어느 상태와도 다르고
// 응답 전까지 카드가 사라진다(리뷰 r3 Claude R3-1). 낙관은 optimisticDoneAt(진입 null) — 응답 전에도 보인다. r2 의 「응답 전 숨김」 기대를 바꿨다.
describe('상세 되돌리기 — 낙관 반영은 done 진입 규칙(응답 전에도 보임)', () => {
  it('오래된 완료를 상세에서 할 일로 바꾼 뒤 되돌리면, 응답 전에도 응답 뒤(서버 새 진입 시각)에도 보인다', async () => {
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY) }), item({ id: 'i2', key: 'K-2', rank: '2' })]
    await renderPage()
    typeSearch('제목')
    await settle()
    click(q('[data-issue-card="K-1"]'))
    await settle()
    click(q('[data-issue-status]'))
    await settle()
    click(q('[data-status-row="todo"]'))
    await settle()
    // 완료 → 할 일은 뒤로 가는 이동이라 확인을 묻는다.
    click(q('[data-confirm-ok]'))
    await settle()
    typeSearch('')
    await settle()
    expect(columnOf('K-1'), '할 일로 바뀐 뒤').toBe('st:todo')
    holdWrite = true
    const undo = [...document.querySelectorAll('[data-toast="moved"]')].find((element) => element.textContent?.includes('K-1'))?.querySelector('[data-toast-undo]') ?? null
    click(undo)
    await settle()
    expect(writes).toBe(2)
    expect(cards(), '되돌리기 응답 전 — 진입 낙관(null)이라 보임').toEqual(['K-1', 'K-2'])
    act(() => releaseWrite())
    await settle()
    expect(cards(), '응답 뒤 — 서버가 새 진입 시각').toEqual(['K-1', 'K-2'])
  })
})

describe('G3 필터를 지워도 보일 행이 없으면 필터 빈 상태를 쓰지 않는다', () => {
  it('스페이스가 전부 오래된 완료이고 필터가 그 행을 걸러 내도 「필터를 지우면 다시 보입니다」 가 없다', async () => {
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY) }), done({ id: 'i2', key: 'K-2', doneAt: ago(30 * DAY), rank: '2' })]
    await renderPage()
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-tasks-empty]')).toBeNull()
    expect(host.textContent).not.toContain('필터를 지우면 다시 보입니다')
    expect(q('[data-tasks-board]')).not.toBeNull()
    expect(host.textContent).not.toMatch(/숨김|숨긴/)
  })

  it('대조 — 필터를 지우면 보일 행(열린 일감)이 있으면 지금처럼 필터 빈 상태', async () => {
    items = [done({ id: 'i1', key: 'K-1', doneAt: ago(20 * DAY) }), item({ id: 'i2', key: 'K-2', rank: '2' })]
    await renderPage()
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-tasks-empty="filter"]')).not.toBeNull()
  })
})
