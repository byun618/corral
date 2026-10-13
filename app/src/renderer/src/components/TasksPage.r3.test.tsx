// @vitest-environment happy-dom
// LIFE-601 수정 r3 — 리뷰 r3(Codex) 지적 R3-A…J 마다 그 결함을 잡는 시험. 출발점: 리뷰어 프로브 `raw/review/codex-r3-raw/raw/ReviewR3.new.test.tsx`.
// 하네스는 r2 시험과 같다 — 서버는 상태를 가진 모의(`answer`: 쓰기를 저장하고 막힘을 지금 상태로 계산). 경합 시험은 **서버 재조회 값 = 화면**으로 본다.
// UI 경로(F·G·H·I·J)는 DOM 이벤트로 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow, WorktreeRow } from '../../../shared/types.js'
import type { WorkCall, WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import { useTasksPage, type MoveNotice, type TasksPageModel } from '../hooks/useTasksPage.js'
import { compareRank, moveAfter } from '../tasks-model.js'
import { TasksPage } from './TasksPage.js'
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const BASE_CAPS: WorkCapabilities = {
  transition: { mode: 'any' }, placement: { state: 'on' }, relations: { state: 'on' }, parentChange: { state: 'on' },
  order: { state: 'on' }, cursorPaging: { state: 'disabled', reason: '커서 없음' },
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
const GIT = { branch: 'x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
function worktree({ path, branch }: { path: string; branch: string }): WorktreeRow {
  return { path, branch, head: null, repoName: 'repo', isLinked: true, openWorkspaceId: 'w1', workspace: null, gitStatus: GIT, displayName: null, comment: null, parentPath: null }
}

let host: HTMLDivElement
let root: Root
let caps: WorkCapabilities
let settings: WorkSettingsState
let items: WorkItem[]
let calls: WorkRequest[]
let hold: ((request: WorkRequest) => Promise<WorkResponse> | null) | null
let closed: number
let settingsListener: (value: WorkSettingsState) => void

function respond(request: WorkRequest, result: Extract<WorkResponse, { ok: true }>['result']): WorkResponse {
  return { requestId: request.requestId, connectionId: request.connectionId, ok: true, result }
}
function reject(request: WorkRequest, kind: 'rejected' | 'network' | 'invalid_response' = 'rejected'): WorkResponse {
  return { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind, message: `${kind} (시험)`, status: null } }
}
/**
 * 상태를 가진 모의 서버(수정 r2) — 쓰기가 `items` 를 실제로 바꾸고, 막힘은 지금 상태로 계산한다(막는 작업이 완료면 빠진다).
 * 그래서 「화면 = 서버 재조회 값」 을 대조할 수 있다(R2-B·J·O).
 */
let blocks: Record<string, string[]>
function view(entry: WorkItem): WorkItem {
  const open = (blocks[entry.id] ?? []).flatMap((id) => {
    const blocker = items.find((candidate) => candidate.id === id)
    return blocker === undefined || blocker.category === 'done' ? [] : [{ id: blocker.id, key: blocker.key, title: blocker.title }]
  })
  return { ...entry, openBlockers: open, openBlockerCount: open.length }
}
function answer(request: WorkRequest): WorkResponse {
  const { call } = request
  const statusOf = (key: string): WorkStatus['category'] => STATUSES.find((status) => status.key === key)?.category ?? 'todo'
  const write = (id: string, change: (entry: WorkItem) => WorkItem): WorkItem | undefined => {
    items = items.map((entry) => (entry.id === id ? change(entry) : entry))
    const written = items.find((entry) => entry.id === id)
    return written === undefined ? undefined : view(written)
  }
  switch (call.op) {
    case 'listSpaces': return respond(request, { op: 'listSpaces', spaces: [], capabilities: caps })
    case 'listStatuses': return respond(request, { op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task' }] })
    case 'listItems': return respond(request, { op: 'listItems', items: items.map(view), nextCursor: null, truncated: false })
    case 'findByKey': {
      const found = items.find((entry) => entry.key.toUpperCase() === call.key.toUpperCase())
      return respond(request, { op: 'findByKey', item: found === undefined ? null : view(found) })
    }
    case 'listTransitions': return respond(request, { op: 'listTransitions', statusKeys: ['doing'] })
    case 'changeStatus': {
      const item = write(call.itemId, (entry) => ({ ...entry, statusKey: call.statusKey, category: statusOf(call.statusKey) }))
      return item === undefined ? reject(request) : respond(request, { op: 'changeStatus', item })
    }
    case 'setPlacement': {
      const item = write(call.itemId, (entry) => ({ ...entry, placement: call.placement }))
      return item === undefined ? reject(request) : respond(request, { op: 'setPlacement', item })
    }
    case 'reorder': {
      if (!items.some((entry) => entry.id === call.itemId)) return reject(request)
      items = moveAfter({ items, itemId: call.itemId, afterId: call.afterId })
      const item = items.find((entry) => entry.id === call.itemId)
      return item === undefined ? reject(request) : respond(request, { op: 'reorder', item: view(item) })
    }
    default: return reject(request)
  }
}
/** 서버 순서(rank) — 화면 순서와 대조. */
const serverOrder = (): string[] => [...items].sort(compareRank).map((entry) => entry.id)
const shownOrder = (): string[] => probeModel.rows.map((entry) => entry.item).sort(compareRank).map((entry) => entry.id)

function connection(id: string, tail: string): WorkSettingsState['connections'][number] {
  return {
    id, sourceId: 'src-a', name: 'Source A', mono: 'SA', tokenTail: tail, addedAt: 0, generation: 1, status: 'ok', pending: null, error: null, checkedAt: 0,
    spaces: [{ key: 's1', name: 'corral', color: null, openCount: 2, hidden: false }], hiddenSpaceKeys: [], capabilities: caps,
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  caps = BASE_CAPS
  settings = {
    sources: [{ id: 'src-a', name: 'Source A', mono: 'SA', addLabel: '', formTitle: '', tokenLabel: '', tokenPrefix: null, keyPattern: 'K-\\d+' }],
    connections: [connection('c1', 'wxyz')],
    repoDefaults: [],
  }
  items = [
    item({ id: 'i1', key: 'K-1', rank: '1' }),
    item({ id: 'i4', key: 'K-4', rank: '2' }),
    item({ id: 'i2', key: 'K-2', statusKey: 'doing', category: 'in_progress', rank: '3', openBlockerCount: 1, openBlockers: [{ id: 'i1', key: 'K-1', title: 'x' }] }),
    item({ id: 'i3', key: 'K-3', placement: 'backlog', rank: '4' }),
  ]
  blocks = { i2: ['i1'] }
  calls = []
  hold = null
  closed = 0
  notices.length = 0
  let prefs: unknown = undefined
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: prefs }),
    setUiPrefs: (patch: { tasksPage?: unknown }) => { if ('tasksPage' in patch) prefs = patch.tasksPage },
    getWorkSettings: async () => settings,
    onWorkSettings: (listener: (value: WorkSettingsState) => void) => { settingsListener = listener; return () => {} },
    workRequest: (request: WorkRequest) => {
      calls.push(request)
      return hold?.(request) ?? Promise.resolve(answer(request))
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const ops = (op: WorkCall['op']): WorkRequest[] => calls.filter((request) => request.call.op === op)

type PageProps = { open?: boolean; repos?: RepoRow[]; yieldKeys?: boolean }
function page({ open = true, repos = [], yieldKeys = false }: PageProps = {}) {
  return createElement(TasksPage, { open, repos, activeRepoRoot: null, shortcut: '⌘I', yieldKeys, onClose: () => { closed += 1 }, onOpenSettings: () => {}, onOpenWorktree: () => {} })
}
async function renderPage(props: PageProps = {}): Promise<void> {
  act(() => root.render(page(props)))
  await settle()
}

const q = (selector: string): Element | null => host.querySelector(selector)
function click(target: Element | null): void {
  if (target === null) throw new Error('클릭 대상 없음')
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function type(value: string): void {
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
/** 실제 끌기 경로 — 손잡이 mousedown → 문턱 넘는 move(놓을 영역은 elementFromPoint) → mouseup. */
async function dragTo({ handle, zone }: { handle: Element | null; zone: string }): Promise<void> {
  const target = q(`[data-drop-zone="${zone}"]`)
  if (handle === null || target === null) throw new Error(`끌기 대상 없음 ${zone}`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  mouse(handle, 'mousedown')
  mouse(document, 'mousemove', 50, 500)
  await settle()
  mouse(document, 'mouseup', 50, 500)
  await settle()
}
function startDrag({ handle, zone }: { handle: Element | null; zone: string }): void {
  const target = q(`[data-drop-zone="${zone}"]`)
  if (handle === null || target === null) throw new Error(`끌기 대상 없음 ${zone}`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
  mouse(handle, 'mousedown')
  mouse(document, 'mousemove', 50, 500)
}

let probeModel: TasksPageModel
const notices: MoveNotice[] = []
function Probe({ open, activeRepoRoot }: { open: boolean; activeRepoRoot: string | null }): null {
  probeModel = useTasksPage({ open, repos: [], activeRepoRoot, notify: (notice) => notices.push(notice) })
  return null
}
async function probe({ open = true, activeRepoRoot = null }: { open?: boolean; activeRepoRoot?: string | null } = {}): Promise<void> {
  act(() => root.render(createElement(Probe, { open, activeRepoRoot })))
  await settle()
}
function row(id = 'i1'): TasksPageModel['rows'][number] {
  const found = probeModel.rows.find((entry) => entry.item.id === id)
  if (found === undefined) throw new Error(`행 없음 ${id}`)
  return found
}
function pending(op: WorkCall['op']): { request: WorkRequest; resolve: (response: WorkResponse) => void }[] {
  const list: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
  hold = (request) => (request.call.op === op ? new Promise((resolve) => list.push({ request, resolve })) : null)
  return list
}

const moveNow = (request: Parameters<TasksPageModel['move']>[0]): void => { act(() => { void probeModel.move(request) }) }
const writes = (): WorkRequest[] => calls.filter((request) => request.call.op === 'changeStatus' || request.call.op === 'setPlacement' || request.call.op === 'reorder')

describe('R3-A 다른 카드 순서 쓰기 둘의 응답이 엇갈려도 화면 = 서버 순서', () => {
  /** 서버는 받는 즉시 적용하고, 응답 배달만 붙잡는다(flip 배달 뒤집기와 같은 결). */
  function holdReorders(): { request: WorkRequest; snapshot: WorkResponse; resolve: (response: WorkResponse) => void }[] {
    const waits: { request: WorkRequest; snapshot: WorkResponse; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => {
      if (request.call.op !== 'reorder') return null
      const snapshot = answer(request)
      return new Promise((resolve) => waits.push({ request, snapshot, resolve }))
    }
    return waits
  }
  it('A1 A(i1→i4 뒤) · B(i4→i2 뒤) 순서로 보내고 B 응답 먼저 → 끝나면 화면 = 서버 재조회 순서', async () => {
    await probe()
    const waits = holdReorders()
    moveNow({ row: row('i1'), intent: { kind: 'reorder', afterId: 'i4' } })
    await settle()
    moveNow({ row: row('i4'), intent: { kind: 'reorder', afterId: 'i2' } })
    await settle()
    expect(waits).toHaveLength(2)
    const optimistic = shownOrder()
    await act(async () => { waits[1]?.resolve(waits[1].snapshot) })
    await settle()
    // A 가 아직이면 다시 읽지 않는다 — 화면은 낙관적 순서 그대로(깜빡임 없음).
    expect(shownOrder()).toEqual(optimistic)
    const lists = ops('listItems').length
    await act(async () => { waits[0]?.resolve(waits[0].snapshot) })
    await settle()
    expect(ops('listItems').length).toBeGreaterThan(lists)
    expect(shownOrder()).toEqual(serverOrder())
  })
  it('A2 반대 순서(A 응답 먼저)도 끝나면 화면 = 서버 재조회 순서', async () => {
    await probe()
    const waits = holdReorders()
    moveNow({ row: row('i2'), intent: { kind: 'reorder', afterId: null } })
    await settle()
    moveNow({ row: row('i1'), intent: { kind: 'reorder', afterId: 'i3' } })
    await settle()
    await act(async () => { waits[0]?.resolve(waits[0].snapshot) })
    await act(async () => { waits[1]?.resolve(waits[1].snapshot) })
    await settle()
    expect(shownOrder()).toEqual(serverOrder())
  })
})

describe('R3-B 늦은 작업 중 조회가 성공한 쓰기를 덮지 않는다', () => {
  it('B1 첫 조회(todo 스냅숏) 보류 → 보드에서 doing 성공 → 옛 조회 도착 → 작업 중은 진행 중', async () => {
    const waits: { snapshot: WorkResponse; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => (request.call.op === 'findByKey' ? new Promise((resolve) => waits.push({ snapshot: answer(request), resolve })) : null)
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-1-test' })] }]
    await renderPage({ repos })
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    expect(items.find((entry) => entry.id === 'i1')?.statusKey).toBe('doing')
    await act(async () => { waits[0]?.resolve(waits[0].snapshot) })
    await settle()
    click(q('[data-tasks-view-tab="working"]'))
    await settle()
    expect(q('[data-working-item="K-1"] .cat-in_progress')).not.toBeNull()
  })
})

describe('R3-C 막은 쪽 완료 뒤 작업 중·키 조회의 막힘도 서버 값으로', () => {
  it('C1 K-1 완료 → 작업 중 「막힘」 필터에서 K-2 가 빠진다(DOM)', async () => {
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-2-test' })] }]
    await renderPage({ repos })
    click(q('[data-tasks-view-tab="working"]'))
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-working-item="K-2"]')).not.toBeNull()
    click(q('[data-filter="blocked"]'))
    click(q('[data-tasks-view-tab="board"]'))
    await settle()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:done' })
    expect(view(items.find((entry) => entry.id === 'i2') ?? item({ id: 'x', key: 'X' })).openBlockerCount).toBe(0)
    click(q('[data-tasks-view-tab="working"]'))
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-working-item="K-2"]')).toBeNull()
  })
  it('C2 키 조회 결과(K-2)도 완료 뒤 서버 값으로 — 막힘 0', async () => {
    await probe()
    act(() => probeModel.setQuery('K-2'))
    await settle()
    expect(probeModel.hits[0]?.item.openBlockerCount).toBe(1)
    await act(async () => { await probeModel.move({ row: row('i1'), intent: { kind: 'status', statusKey: 'done' } }) })
    await settle()
    expect(probeModel.hits[0]?.item.key).toBe('K-2')
    expect(probeModel.hits[0]?.item.openBlockerCount).toBe(0)
  })
})

describe('R3-D 이전 연결 세대의 미확정 쓰기는 새 세대로 넘어오지 않는다', () => {
  function bumpGeneration(): void {
    items = items.map((entry) => (entry.id === 'i1' ? { ...entry, statusKey: 'done', category: 'done' } : entry))
    settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, generation: entry.generation + 1 })) }
    act(() => settingsListener(settings))
  }
  it('D1 쓰기 보류 중 세대가 바뀌면 새 자료(done)가 그대로 · 잠금도 풀린다', async () => {
    await probe()
    pending('changeStatus')
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    expect(probeModel.busy.size).toBe(1)
    bumpGeneration()
    await settle()
    expect(row().item.statusKey).toBe('done')
    expect(probeModel.busy.size).toBe(0)
  })
  it('D2 옛 세대 쓰기가 늦게 실패해도 새 자료를 원복하지 않는다 · 오류 토스트도 없다', async () => {
    await probe()
    const waits = pending('changeStatus')
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    bumpGeneration()
    await settle()
    hold = (request) => (request.call.op === 'listItems' ? Promise.resolve(reject(request, 'network')) : null)
    const failed = notices.filter((notice) => notice.kind === 'failed').length
    await act(async () => { waits[0]?.resolve({ requestId: waits[0].request.requestId, connectionId: waits[0].request.connectionId, ok: false, error: { kind: 'not_connected', message: '옛 세대', status: null } }) })
    await settle()
    expect(row().item.statusKey).toBe('done')
    expect(notices.filter((notice) => notice.kind === 'failed')).toHaveLength(failed)
  })
})

describe('R3-E 요청 예외·무응답에도 잠금이 풀린다', () => {
  it('E1 preload Promise reject → 잠금 해제 · 원위치 · 오류 토스트 · 다음 쓰기 가능', async () => {
    await probe()
    hold = (request) => (request.call.op === 'changeStatus' ? Promise.reject(new Error('IPC reply channel closed')) : null)
    await act(async () => { await probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
    await settle()
    expect(probeModel.busy.size).toBe(0)
    expect(row().item.statusKey).toBe('todo')
    expect(notices.some((notice) => notice.kind === 'failed' && notice.message.includes('IPC reply channel closed'))).toBe(true)
    hold = null
    await act(async () => { await probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
    expect(row().item.statusKey).toBe('doing')
  })
  it('E2 응답이 끝내 오지 않으면 30초 뒤 실패로 — 잠금 해제 · 원위치', async () => {
    await probe()
    hold = (request) => (request.call.op === 'changeStatus' ? new Promise(() => {}) : null)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      act(() => { void probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
      expect(probeModel.busy.size).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(29_000) })
      expect(probeModel.busy.size).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
    } finally {
      vi.useRealTimers()
    }
    hold = null
    await settle()
    expect(probeModel.busy.size).toBe(0)
    expect(row().item.statusKey).toBe('todo')
  })
})

describe('R3-F 놓는 자리가 창 밖이거나 칸이 없으면 쓰기 0', () => {
  it('F1 창 밖 좌표 mouseup → 쓰기 0 · 사본 제거', async () => {
    await renderPage()
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    mouse(document, 'mouseup', -10, -10)
    await settle()
    expect(writes()).toHaveLength(0)
    expect(q('.tasks-drag-preview')).toBeNull()
    expect(closed).toBe(0)
  })
  it('F2 창 안이지만 놓는 자리에 칸이 없으면 쓰기 0', async () => {
    await renderPage()
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    vi.mocked(document.elementFromPoint).mockReturnValue(null)
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(writes()).toHaveLength(0)
  })
  it('F3 대조 — 칸 위에서 놓으면 쓰기 1', async () => {
    await renderPage()
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(writes()).toHaveLength(1)
  })
  it('F4 끄는 중 스페이스를 바꾸면 취소 — 옛 맥락의 칸에 쓰지 않는다', async () => {
    settings.connections[0]?.spaces?.push({ key: 's2', name: 'Second', hidden: false, color: null, openCount: 1 })
    await renderPage()
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    click(q('[data-space-switch]'))
    click(q('[data-space-row="s2"]'))
    await settle()
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(writes()).toHaveLength(0)
  })
})

describe('R3-G 「전체 → 작업 중」 에 숨긴 스페이스의 작업이 없다', () => {
  it('G1 숨긴 s2 의 K-9 worktree 는 빠지고, 보이는 s1 의 K-1 은 남는다', async () => {
    settings.connections[0]?.spaces?.push({ key: 's2', name: 'Hidden', hidden: false, color: null, openCount: 1 })
    const first = settings.connections[0]
    if (first !== undefined) first.hiddenSpaceKeys = ['s2']
    items.push(item({ id: 'ih', key: 'K-9', spaceKey: 's2' }))
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/a', branch: 'K-9-a' }), worktree({ path: '/repo/b', branch: 'K-1-b' })] }]
    await renderPage({ repos })
    click(q('[data-space-switch]'))
    click(q('[data-space-row="all"]'))
    await settle()
    click(q('[data-tasks-view-tab="working"]'))
    await settle()
    expect(q('[data-working-item="K-9"]')).toBeNull()
    expect(q('[data-working-item="K-1"]')).not.toBeNull()
  })
})

describe('R3-H 고른 스페이스에 작업 중 항목이 없으면 「작업 중 없음」', () => {
  it('H1 worktree 는 s1 에만 · s2 를 고르면 빈 상태 working(필터 탓 아님)', async () => {
    settings.connections[0]?.spaces?.push({ key: 's2', name: 'Second', hidden: false, color: null, openCount: 0 })
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-1-test' })] }]
    await renderPage({ repos })
    click(q('[data-space-switch]'))
    click(q('[data-space-row="s2"]'))
    await settle()
    click(q('[data-tasks-view-tab="working"]'))
    await settle()
    expect(q('[data-tasks-empty]')?.getAttribute('data-tasks-empty')).toBe('working')
  })
  it('H2 대조 — 같은 스페이스에 있는데 필터로 빠지면 filter', async () => {
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-1-test' })] }]
    await renderPage({ repos })
    click(q('[data-tasks-view-tab="working"]'))
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-tasks-empty]')?.getAttribute('data-tasks-empty')).toBe('filter')
  })
})

describe('R3-I 검색어를 바꾸면 새 응답 전까지 옛 키 일치를 보이지 않는다', () => {
  it('I1 K-1 일치 뒤 K-2 입력(응답 보류) → 키 일치 영역에 K-1 없음 · 응답 오면 K-2', async () => {
    await renderPage()
    type('K-1')
    await settle()
    expect(q('[data-search-hits]')?.textContent).toContain('K-1')
    const waits = pending('findByKey')
    type('K-2')
    await settle()
    expect(q('[data-search-hits]')?.textContent ?? '').not.toContain('K-1')
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    expect(q('[data-search-hits]')?.textContent).toContain('K-2')
  })
})

describe('R3-J 상한에서 잘린 목록의 그룹 수는 받은 것 표기', () => {
  it('J1 truncated · 커서 없음 → 그룹 머리에 「받은 것」 + 안내', async () => {
    hold = (request) => (request.call.op === 'listItems' ? Promise.resolve(respond(request, { op: 'listItems', items: items.map(view), nextCursor: null, truncated: true })) : null)
    await renderPage()
    click(q('[data-tasks-view-tab="list"]'))
    await settle()
    expect(q('[data-tasks-more="capped"]')).not.toBeNull()
    expect(q('[data-list-group]')?.textContent).toContain('받은 것')
    expect(q('[data-list-group]')?.getAttribute('title')).toContain('받아 둔 행 기준')
  })
  it('J2 대조 — 다 받았으면 표기 없음', async () => {
    await renderPage()
    click(q('[data-tasks-view-tab="list"]'))
    await settle()
    expect(q('[data-list-group]')?.textContent ?? '').not.toContain('받은 것')
  })
})
