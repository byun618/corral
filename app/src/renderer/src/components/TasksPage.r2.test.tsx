// @vitest-environment happy-dom
// LIFE-601 수정 r2 — 리뷰 r2(Codex) 지적 R2-A…M·P 마다 그 결함을 잡는 시험. 출발점: 리뷰어 프로브 `raw/review/codex-r2-raw/raw/probes-v1·v3·final`.
// 쓰기 모델 단순화(카드당 확인 안 된 쓰기 하나 · 실패·모호하면 그 카드만 되돌리고 서버 재조회)를 전제로, 서버는 상태를 가진 모의(`answer`)다 —
// 경합 시험은 화면만이 아니라 **서버 재조회 값**과도 맞춘다. UI 경로(K·H·M·L·G)는 DOM 이벤트로 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAgentState } from '../../../shared/agent-state.js'
import { EMPTY_SESSION_DIGEST, type RepoRow, type WorkspaceRow, type WorktreeRow } from '../../../shared/types.js'
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

/** 마지막 활동이 `at` 인 pane 하나를 가진 열린 workspace(R2-P). */
function workspaceAt(at: number): WorkspaceRow {
  return {
    workspaceId: 'w1', label: 'repo', number: 1, focused: false, agentStatus: 'idle',
    tabs: [{ tabId: 't1', workspaceId: 'w1', label: 'tab', number: 1, order: 0, focused: false, agentStatus: 'idle', digest: EMPTY_SESSION_DIGEST,
      panes: [{ paneId: 'p1', tabId: 't1', workspaceId: 'w1', title: 'p1', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: false, agentSession: null,
        digest: { ...EMPTY_SESSION_DIGEST, lastActivityAt: at } }] }],
  }
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

describe('R2-A 쓰기 순서 — 카드당 확인 안 된 쓰기 하나 · 되돌리기는 확인된 값', () => {
  it('A1 같은 카드를 확인 전에 세 번 옮겨도 요청은 1회 · 나머지는 「확인하는 중」 으로 거절 · 서버 값 = 화면', async () => {
    const waits = pending('changeStatus')
    await probe()
    for (const statusKey of ['doing', 'done', 'todo']) { moveNow({ row: row(), intent: { kind: 'status', statusKey } }); await settle() }
    expect(waits).toHaveLength(1)
    expect(notices.filter((notice) => notice.kind === 'failed' && notice.message.includes('확인하는 중'))).toHaveLength(2)
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    expect(row().item.statusKey).toBe('doing')
    expect(items.find((entry) => entry.id === 'i1')?.statusKey).toBe('doing')
  })
  it('A2 거절된 낙관적 값은 되돌리기 값이 되지 않는다 — 거절(doing) 뒤 성공(done)의 되돌리기는 todo', async () => {
    const waits = pending('changeStatus')
    await probe()
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'done' } })
    await settle()
    expect(waits).toHaveLength(1)
    await act(async () => { waits[0]?.resolve(reject(waits[0].request)) })
    await settle()
    expect(row().item.statusKey).toBe('todo')
    hold = null
    await act(async () => { await probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'done' } }) })
    await settle()
    const moved = notices.findLast((notice) => notice.kind === 'moved')
    act(() => { if (moved?.kind === 'moved') moved.undo() })
    await settle()
    expect(writes().map((request) => (request.call.op === 'changeStatus' ? request.call.statusKey : ''))).toEqual(['doing', 'done', 'todo'])
    expect(row().item.statusKey).toBe('todo')
    expect(items.find((entry) => entry.id === 'i1')?.statusKey).toBe('todo')
  })
  it('A3 되돌리기도 확인 안 된 쓰기가 있으면 잠긴다 — 요청 0', async () => {
    await probe()
    await act(async () => { await probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
    const moved = notices.findLast((notice) => notice.kind === 'moved')
    const waits = pending('setPlacement')
    moveNow({ row: row(), intent: { kind: 'placement', placement: 'backlog' } })
    await settle()
    const before = writes().length
    act(() => { if (moved?.kind === 'moved') moved.undo() })
    await settle()
    expect(writes()).toHaveLength(before)
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
  })
  it('A4 확인 안 된 쓰기가 있는 카드는 끌기 손잡이가 잠긴다(UI) — 끌어도 쓰기 0, 확인 뒤 풀린다', async () => {
    const waits = pending('changeStatus')
    await renderPage()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    expect(waits).toHaveLength(1)
    expect(q('[data-issue-card="K-1"]')?.classList.contains('is-locked')).toBe(true)
    vi.restoreAllMocks()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:done' })
    expect(waits).toHaveLength(1)
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    expect(q('[data-issue-card="K-1"]')?.classList.contains('is-locked')).toBe(false)
  })
})

describe('R2-B 순서 실패는 그 카드만 되돌린다 — 다른 카드의 성공한 순서를 지우지 않는다', () => {
  it('B1 A(i1) 실패 · B(i3) 성공 → B 의 맨 앞이 남고, 화면 = 서버 재조회 순서', async () => {
    const waits = pending('reorder')
    await probe()
    moveNow({ row: row('i1'), intent: { kind: 'reorder', afterId: 'i4' } })
    await settle()
    moveNow({ row: row('i3'), intent: { kind: 'reorder', afterId: null } })
    await settle()
    await act(async () => { waits[1]?.resolve(answer(waits[1].request)) })
    await act(async () => { waits[0]?.resolve(reject(waits[0].request)) })
    await settle()
    expect(shownOrder()[0]).toBe('i3')
    expect(shownOrder()).toEqual(serverOrder())
    expect(serverOrder()).toEqual(['i3', 'i1', 'i4', 'i2'])
  })
  it('B2 실패 직후(재조회 전) 화면도 그 카드만 돌아가 있다', async () => {
    const reorders: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    const lists: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    await probe()
    hold = (request) => request.call.op === 'reorder' ? new Promise((resolve) => reorders.push({ request, resolve }))
      : request.call.op === 'listItems' ? new Promise((resolve) => lists.push({ request, resolve })) : null
    moveNow({ row: row('i1'), intent: { kind: 'reorder', afterId: 'i4' } })
    await settle()
    moveNow({ row: row('i3'), intent: { kind: 'reorder', afterId: null } })
    await settle()
    await act(async () => { reorders[1]?.resolve(answer(reorders[1].request)) })
    await act(async () => { reorders[0]?.resolve(reject(reorders[0].request)) })
    await settle()
    // i1 은 제 옛 자리(i4 앞)로만 돌아가고, 성공한 i3 의 앞자리는 그대로(옛 r1 은 스페이스 전체 순서를 되돌려 i3 이 맨 뒤로 갔다).
    const order = shownOrder()
    expect(order.indexOf('i3')).toBeLessThan(order.indexOf('i4'))
    expect(order.indexOf('i1')).toBeLessThan(order.indexOf('i4'))
    expect(lists.length).toBeGreaterThan(0)
    hold = null
    for (const entry of lists) await act(async () => { entry.resolve(answer(entry.request)) })
    await settle()
    expect(shownOrder()).toEqual(serverOrder())
  })
})

describe('R2-C 확인 안 된 쓰기 뒤에 시작한 재조회가 낙관적 자리를 덮지 않는다', () => {
  it('C1 상태 — 쓰기 대기 중 재조회(서버는 아직 todo) → doing 유지 · 확인 뒤 서버 재조회도 doing', async () => {
    const waits = pending('changeStatus')
    await probe()
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    await act(async () => { await probeModel.reload({ quiet: true }) })
    await settle()
    expect(row().item.statusKey).toBe('doing')
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await act(async () => { await probeModel.reload({ quiet: true }) })
    expect(row().item.statusKey).toBe('doing')
  })
  it('C2 순서 — 쓰기 대기 중 재조회 → 옮긴 자리 유지', async () => {
    const waits = pending('reorder')
    await probe()
    moveNow({ row: row('i3'), intent: { kind: 'reorder', afterId: null } })
    await settle()
    await act(async () => { await probeModel.reload({ quiet: true }) })
    await settle()
    expect(shownOrder()[0]).toBe('i3')
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    expect(shownOrder()).toEqual(serverOrder())
  })
})

describe('R2-D 대상이 0 이 되면 진행 중 불러오기를 버린다', () => {
  it('D1 스페이스가 모두 숨겨진 뒤 온 실패 응답 → 배너 없음', async () => {
    await probe()
    const waits = pending('listItems')
    act(() => { void probeModel.reload({ quiet: true }) })
    await settle()
    settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, spaces: [] })) }
    act(() => settingsListener(settings))
    await settle()
    await act(async () => { waits[0]?.resolve(reject(waits[0].request, 'network')) })
    await settle()
    expect(probeModel.banner).toBeNull()
  })
  it('D2 「전체」 진행 중 응답이 스페이스가 사라진 뒤 와도 행을 되살리지 않는다', async () => {
    await probe()
    act(() => probeModel.chooseSpace({ kind: 'all' }))
    await settle()
    const waits = pending('listItems')
    act(() => { void probeModel.reload({ quiet: true }) })
    await settle()
    settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, spaces: [] })) }
    act(() => settingsListener(settings))
    await settle()
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    expect(probeModel.rows).toHaveLength(0)
  })
})

describe('R2-E 연결 세대가 바뀌면(같은 스페이스 id) 다시 받는다', () => {
  it('E1 목록과 작업 중 조회를 새 세대로 다시 받는다', async () => {
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-1-test' })] }]
    await renderPage({ repos })
    const lists = ops('listItems').length
    const finds = ops('findByKey').length
    items = [item({ id: 'new-account-item', key: 'K-1', title: '새 계정 작업' })]
    settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, generation: entry.generation + 1 })) }
    act(() => settingsListener(settings))
    await settle()
    expect(ops('listItems').length).toBeGreaterThan(lists)
    expect(ops('findByKey').length).toBeGreaterThan(finds)
    expect(q('[data-issue-card="K-1"]')?.textContent).toContain('새 계정 작업')
  })
})

describe('R2-F 다시 열 때 덧 쪽 실패는 오류다', () => {
  it('F1 둘째 쪽 실패 → 배너 · 보이던 4행 유지 · 다음 성공 재열기는 다시 2쪽', async () => {
    hold = (request) => (request.call.op === 'listItems'
      ? Promise.resolve(respond(request, { op: 'listItems', items: request.call.cursor === null ? items.slice(0, 1) : items.slice(1), nextCursor: request.call.cursor === null ? 'next' : null, truncated: false }))
      : null)
    await probe()
    await act(async () => { await probeModel.loadMore() })
    expect(probeModel.rows).toHaveLength(4)
    await probe({ open: false })
    const ok = hold
    hold = (request) => (request.call.op === 'listItems'
      ? Promise.resolve(request.call.cursor === null ? respond(request, { op: 'listItems', items: items.slice(0, 1), nextCursor: 'next', truncated: false }) : reject(request, 'invalid_response'))
      : null)
    await probe({ open: true })
    expect(probeModel.banner).not.toBeNull()
    expect(probeModel.rows).toHaveLength(4)
    await probe({ open: false })
    hold = ok
    const before = ops('listItems').length
    await probe({ open: true })
    expect(ops('listItems').length - before).toBe(2)
    expect(probeModel.banner).toBeNull()
    expect(probeModel.rows).toHaveLength(4)
  })
})

describe('R2-G 키 조회 오류 배너의 「다시 시도」 는 키 조회를 다시 보낸다', () => {
  it('G1 invalid_response → 다시 시도 클릭 → findByKey 2회 · 배너 사라짐', async () => {
    hold = (request) => (request.call.op === 'findByKey' ? Promise.resolve(reject(request, 'invalid_response')) : null)
    await renderPage()
    type('K-1')
    await settle()
    expect(ops('findByKey')).toHaveLength(1)
    hold = null
    click(q('[data-tasks-retry]'))
    await settle()
    expect(ops('findByKey')).toHaveLength(2)
    expect(q('[data-tasks-banner]')).toBeNull()
  })
})

describe('R2-H 작업 중 보기 — 키 일치 · 글자 거르기 · 빈 상태 규칙', () => {
  it('H1 키 일치 결과가 작업 중 보기에도 보인다', async () => {
    await renderPage()
    click(q('[data-tasks-view-tab="working"]'))
    type('K-1')
    await settle()
    expect(q('[data-search-hit]')).not.toBeNull()
  })
  it('H2 못 찾은 항목(출처에 없음)도 글자로 걸러진다 · 빈 상태 원인은 「검색」', async () => {
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-999-test' })] }]
    await renderPage({ repos })
    click(q('[data-tasks-view-tab="working"]'))
    await settle()
    expect(q('[data-working-item="K-999"] [data-working-missing="missing"]')).not.toBeNull()
    type('unrelated word')
    await settle()
    expect(q('[data-working-item]')).toBeNull()
    expect(q('[data-tasks-empty]')?.getAttribute('data-tasks-empty')).toBe('search')
    type('K-999')
    await settle()
    expect(q('[data-working-item="K-999"]')).not.toBeNull()
  })
  it('H3 찾는 중·실패 항목도 글자로 걸러진다', async () => {
    hold = (request) => (request.call.op === 'findByKey' && request.call.key === 'K-5' ? Promise.resolve(reject(request, 'network')) : request.call.op === 'findByKey' && request.call.key === 'K-6' ? new Promise(() => {}) : null)
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/a', branch: 'K-5-a' }), worktree({ path: '/repo/b', branch: 'K-6-b' })] }]
    await renderPage({ repos })
    click(q('[data-tasks-view-tab="working"]'))
    await settle()
    expect(q('[data-working-item="K-5"] [data-working-missing="error"]')).not.toBeNull()
    expect(q('[data-working-item="K-6"] [data-working-missing="loading"]')).not.toBeNull()
    type('k-6')
    await settle()
    expect(q('[data-working-item="K-5"]')).toBeNull()
    expect(q('[data-working-item="K-6"]')).not.toBeNull()
  })
})

describe('R2-I 성공한 쓰기는 작업 중 보기에도 반영된다', () => {
  it('I1 K-1 을 doing 으로 끈 뒤 작업 중 보기 → 진행 중 원', async () => {
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-1-test' })] }]
    await renderPage({ repos })
    const finds = ops('findByKey').length
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    click(q('[data-tasks-view-tab="working"]'))
    await settle()
    expect(q('[data-working-item="K-1"] .tasks-status-circle')?.classList.contains('cat-in_progress')).toBe(true)
    expect(ops('findByKey')).toHaveLength(finds)
  })
})

describe('R2-J 완료 분류를 넘나들면 막힌 작업의 막힘 자료를 다시 받는다', () => {
  it('J1 막는 작업 K-1 을 done 으로 → K-2 막힘 배지가 사라지고 화면 = 서버 재조회', async () => {
    items = items.map((entry) => (entry.id === 'i1' ? { ...entry, statusKey: 'doing', category: 'in_progress' } : entry))
    await renderPage()
    expect(q('[data-issue-card="K-2"] [data-issue-blocked]')).not.toBeNull()
    const lists = ops('listItems').length
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:done' })
    expect(ops('listItems').length).toBeGreaterThan(lists)
    expect(q('[data-issue-card="K-2"] [data-issue-blocked]')).toBeNull()
    expect(view(items.find((entry) => entry.id === 'i2') ?? item({ id: 'x', key: 'X' })).openBlockerCount).toBe(0)
  })
  it('J2 다시 done 밖으로 → 막힘 배지가 돌아온다', async () => {
    items = items.map((entry) => (entry.id === 'i1' ? { ...entry, statusKey: 'done', category: 'done' } : entry))
    await renderPage()
    expect(q('[data-issue-card="K-2"] [data-issue-blocked]')).toBeNull()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    expect(q('[data-issue-card="K-2"] [data-issue-blocked]')).not.toBeNull()
  })
})

describe('R2-K 끄는 중 페이지가 닫히거나 위층이 열리면 끌기 취소', () => {
  it('K1 끄는 중 닫힘(⌘I) → mouseup 에 쓰기 0', async () => {
    await renderPage()
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    await renderPage({ open: false })
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(writes()).toHaveLength(0)
  })
  it('K2 끄는 중 위층(설정·팔레트) → mouseup 에 쓰기 0 · 사본 제거', async () => {
    await renderPage()
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    expect(q('.tasks-drag-preview')).not.toBeNull()
    await renderPage({ yieldKeys: true })
    expect(q('.tasks-drag-preview')).toBeNull()
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(writes()).toHaveLength(0)
    expect(closed).toBe(0)
  })
  it('K3 대조 — 닫지 않으면 같은 끌기가 쓰기 1회', async () => {
    await renderPage()
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(writes()).toHaveLength(1)
  })
})

describe('R2-L 「전체」 순서 바꾸기는 같은 연결·스페이스의 작업만 기준으로', () => {
  it('L1 다른 연결 작업 뒤에 놓아도 afterId 에 다른 연결 id 가 실리지 않는다', async () => {
    settings.connections = [connection('c1', 'abcd'), connection('c2', 'wxyz')]
    hold = (request) => (request.call.op === 'listItems'
      ? Promise.resolve(respond(request, { op: 'listItems', items: request.connectionId === 'c1'
        ? [item({ id: 'c1-b', key: 'K-3', rank: '0' }), item({ id: 'c1-a', key: 'K-1', rank: '1' })]
        : [item({ id: 'c2-only', key: 'K-2', rank: '2' })], nextCursor: null, truncated: false }))
      : null)
    await renderPage()
    click(q('[data-space-switch]'))
    click(q('[data-space-row="all"]'))
    await settle()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:cat:todo' })
    const sent = ops('reorder')
    expect(sent).toHaveLength(1)
    // 칸 = K-3(c1) · K-1(c1, 끄는 것) · K-2(c2) — 맨 뒤에 놓으면 바로 앞이 c2 작업이다. 기준은 그 앞의 같은 스페이스 작업 K-3.
    expect(sent[0]?.connectionId).toBe('c1')
    expect(sent[0]?.call).toMatchObject({ op: 'reorder', itemId: 'c1-a', afterId: 'c1-b' })
  })
})

describe('R2-M 거른 결과가 0 이어도 다음 쪽이 있으면 더 불러오기·목록 도구가 남는다', () => {
  it('M1 리스트 + 「막힘」 필터 · 첫 쪽에 막힌 작업 없음 → 더 불러오기 버튼 · 정렬 도구', async () => {
    hold = (request) => (request.call.op === 'listItems' ? Promise.resolve(respond(request, { op: 'listItems', items: items.slice(0, 1), nextCursor: 'next', truncated: false })) : null)
    await renderPage()
    click(q('[data-tasks-view-tab="list"]'))
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-tasks-more-button]')).not.toBeNull()
    expect(q('[data-tasks-list-tools]')).not.toBeNull()
  })
  it('M2 대조 — 다음 쪽이 없으면 필터 빈 상태', async () => {
    items = items.slice(0, 1)
    await renderPage()
    click(q('[data-tasks-view-tab="list"]'))
    click(q('[data-filter="blocked"]'))
    await settle()
    expect(q('[data-tasks-empty]')?.getAttribute('data-tasks-empty')).toBe('filter')
  })
})

describe('R2-P 작업 중 보기의 상대 시간은 열린 동안 흐른다', () => {
  it('P1 2분 지나면 now → 2m', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const tree = worktree({ path: '/repo/wt', branch: 'K-1-test' })
      const at = Date.now()
      const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [{ ...tree, workspace: workspaceAt(at) }] }]
      await renderPage({ repos })
      click(q('[data-tasks-view-tab="working"]'))
      await settle()
      expect(q('[data-working-time]')?.textContent).toBe('now')
      act(() => { vi.advanceTimersByTime(120_000) })
      expect(q('[data-working-time]')?.textContent).toBe('2m')
    } finally {
      vi.useRealTimers()
    }
  })
})
