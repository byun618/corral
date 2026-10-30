// @vitest-environment happy-dom
// LIFE-601 수정 r4 — 리뷰 r4(Codex) 지적 R4-A…E 마다 그 결함을 잡는 시험. 출발점: 리뷰어 프로브 `raw/review/codex-r4-raw/raw/new-probes.tsx`
// (TIME-LATE · FIND-W · RR-REOPEN · RR-READ · WORK-RETRY(-DOM) · UNDO-UI). 실제 LA adapter 로 보는 LA-TIME 은 main 을 import 해 `TasksPage.r4la.test.tsx`(mixed 검사)에 둔다.
// 하네스는 r2·r3 시험과 같다 — 서버는 상태를 가진 모의(`answer`). 되돌리기 버튼(R4-E)은 실제 Sonner Toaster DOM 으로 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow, WorktreeRow } from '../../../shared/types.js'
import type { WorkCall, WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import { Toaster, toast } from 'sonner'
import { useTasksPage, type MoveNotice, type TasksPageModel } from '../hooks/useTasksPage.js'
import { compareRank, moveAfter } from '../tasks-model.js'
import { TasksPageInPanel } from './TasksPage.harness.js'
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
const item = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => ({ bodyLock: null, doneAt: null, 
  spaceKey: 's1', title: `제목 ${over.key}`, body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'todo', category: 'todo', priority: 'medium', dueAt: null,
  parentId: null, placement: 'board', rank: null, resolution: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [], ...over,
})
const GIT = { branch: 'x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
function worktree({ path, branch }: { path: string; branch: string }): WorktreeRow {
  return { path, branch, head: null, repoName: 'repo', isLinked: true, openWorkspaceId: 'w1', workspace: null, gitStatus: GIT, displayName: null, comment: null, parentPath: null, workLink: fixtureLink(branch) }
}
// LIFE-603: 작업 중 보기는 main 이 실은 링크로 묶는다 — 고정값에 자동 링크 칸만 더한다(기대값 무변경).
function fixtureLink(branch: string): WorktreeRow['workLink'] {
  const key = /(?<![A-Za-z0-9])K-\d+(?![0-9])/.exec(branch)?.[0]
  return key === undefined ? null : { mode: 'auto', sourceId: 'src-a', connectionId: 'c1', key, itemId: null, connected: true }
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
    case 'listStatuses': return respond(request, { op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task', childKinds: [] }] })
    case 'listItems': return respond(request, { op: 'listItems', items: items.map(view), nextCursor: null, truncated: false })
    case 'findByKey': {
      const found = items.find((entry) => entry.key.toUpperCase() === call.key.toUpperCase())
      return respond(request, { op: 'findByKey', item: found === undefined ? null : view(found) })
    }
    case 'listTransitions': return respond(request, { blocked: [], op: 'listTransitions', statusKeys: ['doing'] })
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
  return { account: {}, 
    id, sourceId: 'src-a', name: 'Source A', mono: 'SA', tokenTail: tail, addedAt: 0, generation: 1, status: 'ok', pending: null, error: null, checkedAt: 0,
    spaces: [{ key: 's1', name: 'corral', color: null, openCount: 2, hidden: false, capabilities: {} }], hiddenSpaceKeys: [], capabilities: caps,
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  caps = BASE_CAPS
  settings = {
    sources: [{ accountFields: [], tokenHint: null, queryPattern: null, id: 'src-a', name: 'Source A', mono: 'SA', addLabel: '', formTitle: '', tokenLabel: '', tokenPrefix: null, keyPattern: 'K-\\d+' }],
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
  probeRepos = []
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
  return createElement(TasksPageInPanel, { open, repos, activeRepoRoot: null, shortcut: '⌘I', yieldKeys, onClose: () => { closed += 1 }, onOpenSettings: () => {}, onOpenWorktree: () => {} })
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
let probeRepos: RepoRow[] = []
let probeModel: TasksPageModel
const notices: MoveNotice[] = []
function Probe({ open, activeRepoRoot }: { open: boolean; activeRepoRoot: string | null }): null {
  probeModel = useTasksPage({ open, repos: probeRepos, activeRepoRoot, notify: (notice) => notices.push(notice) })
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

const server = (id = 'i1'): WorkItem | undefined => items.find((entry) => entry.id === id)

describe('R4-A 30초 기다림 한도는 확정 실패가 아니다 — 확인 지연, 답이 오면 서버로 수렴', () => {
  it('A1 30초 뒤: 잠금 해제 · 낙관적 값 유지 · 「확인 지연」 / 늦은 성공(서버 적용) → 실패 토스트·원복 없이 화면 = 서버', async () => {
    await probe()
    const waits = pending('changeStatus')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
      expect(probeModel.busy.size).toBe(0)
      expect(row().item.statusKey).toBe('doing')
      expect(notices.map((notice) => notice.kind)).toEqual(['delayed'])
      // 서버는 한도 뒤에야 적용하고 성공을 답한다.
      await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    } finally {
      vi.useRealTimers()
    }
    await settle()
    expect(server()?.statusKey).toBe('doing')
    expect(row().item.statusKey).toBe('doing')
    expect(notices.some((notice) => notice.kind === 'failed')).toBe(false)
    // 답이 오면 서버를 다시 읽는다.
    expect(ops('listItems').length).toBeGreaterThanOrEqual(2)
  })
  it('A2 늦은 실패 → 실패를 알리고 서버 재조회 값(옮기기 전)으로', async () => {
    await probe()
    const waits = pending('changeStatus')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
      expect(row().item.statusKey).toBe('doing')
      await act(async () => { waits[0]?.resolve(reject(waits[0].request)) })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    } finally {
      vi.useRealTimers()
    }
    await settle()
    expect(server()?.statusKey).toBe('todo')
    expect(row().item.statusKey).toBe('todo')
    expect(notices.map((notice) => notice.kind)).toEqual(['delayed', 'failed'])
  })
  it('A3 확인 지연 중 다른 목록 재조회가 와도 낙관적 값이 남는다(답이 오기 전)', async () => {
    await probe()
    pending('changeStatus')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
      hold = null
      await act(async () => { await probeModel.reload({ quiet: true }) })
    } finally {
      vi.useRealTimers()
    }
    await settle()
    expect(row().item.statusKey).toBe('doing')
  })
})

describe('R4-B 성공한 쓰기(되돌리기 포함)는 진행 중인 키 조회를 버리고 다시 보낸다', () => {
  it('B1 K-1 doing 성공 → K-1 키 조회 붙잡힘 → 되돌리기 성공 → 옛 조회 응답(doing) 도착 → 키 일치는 todo', async () => {
    await probe()
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    const undo = notices.find((notice) => notice.kind === 'moved')
    if (undo?.kind !== 'moved') throw new Error('되돌리기 없음')
    const waits: { snapshot: WorkResponse; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => (request.call.op === 'findByKey' ? new Promise((resolve) => waits.push({ snapshot: answer(request), resolve })) : null)
    act(() => probeModel.setQuery('K-1'))
    await settle()
    expect(waits).toHaveLength(1)
    act(() => { undo.undo() })
    await settle()
    expect(row().item.statusKey).toBe('todo')
    expect(server()?.statusKey).toBe('todo')
    // 되돌리기 성공이 진행 중 키 조회를 다시 보냈다.
    expect(waits).toHaveLength(2)
    await act(async () => { waits[0]?.resolve(waits[0].snapshot) })
    await settle()
    expect(probeModel.hits.every((hit) => hit.item.statusKey !== 'doing')).toBe(true)
    await act(async () => { waits[1]?.resolve(waits[1].snapshot) })
    await settle()
    expect(probeModel.hits[0]?.item.statusKey).toBe('todo')
  })
  it('B2 응답 순서가 반대여도(새 조회 먼저) 옛 응답이 덮지 않는다', async () => {
    await probe()
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    const undo = notices.find((notice) => notice.kind === 'moved')
    if (undo?.kind !== 'moved') throw new Error('되돌리기 없음')
    const waits: { snapshot: WorkResponse; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => (request.call.op === 'findByKey' ? new Promise((resolve) => waits.push({ snapshot: answer(request), resolve })) : null)
    act(() => probeModel.setQuery('K-1'))
    await settle()
    act(() => { undo.undo() })
    await settle()
    await act(async () => { waits[1]?.resolve(waits[1].snapshot) })
    await settle()
    await act(async () => { waits[0]?.resolve(waits[0].snapshot) })
    await settle()
    expect(probeModel.hits[0]?.item.statusKey).toBe('todo')
  })
})

describe('R4-C 목록 조회 시작 뒤 성공한 순서 변경이 옛 응답에 지워지지 않는다', () => {
  function holdReadsAndReorders(): { writes: { request: WorkRequest; resolve: (response: WorkResponse) => void }[]; reads: { snapshot: WorkResponse; resolve: (response: WorkResponse) => void }[] } {
    const writes: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    const reads: { snapshot: WorkResponse; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => {
      if (request.call.op === 'reorder') return new Promise((resolve) => writes.push({ request, resolve }))
      if (request.call.op === 'listItems') return new Promise((resolve) => reads.push({ snapshot: answer(request), resolve }))
      return null
    }
    return { writes, reads }
  }
  it('C1 A 순서 시작 → 닫고 다시 열기(옛 목록 조회) → B 순서 시작 → A 성공 → 옛 응답 도착: 화면 그대로 · 끝나면 화면 = 서버', async () => {
    items = items.map((entry) => ({ ...entry, placement: 'board' }))
    await probe()
    const { writes: waits, reads } = holdReadsAndReorders()
    moveNow({ row: row('i1'), intent: { kind: 'reorder', afterId: 'i4' } })
    await settle()
    await probe({ open: false })
    await probe({ open: true })
    moveNow({ row: row('i3'), intent: { kind: 'reorder', afterId: null } })
    await settle()
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    const before = shownOrder()
    await act(async () => { reads[0]?.resolve(reads[0].snapshot) })
    await settle()
    expect(shownOrder()).toEqual(before)
    hold = null
    await act(async () => { waits[1]?.resolve(answer(waits[1].request)) })
    await settle()
    expect(shownOrder()).toEqual(serverOrder())
  })
  it('C2 조용한 재조회 중 같은 흐름(직접 reload) — 옛 응답 뒤에도 화면 그대로', async () => {
    await probe()
    const { writes: waits, reads } = holdReadsAndReorders()
    moveNow({ row: row('i1'), intent: { kind: 'reorder', afterId: 'i4' } })
    await settle()
    act(() => { void probeModel.reload({ quiet: true }) })
    await settle()
    moveNow({ row: row('i3'), intent: { kind: 'reorder', afterId: null } })
    await settle()
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    const before = shownOrder()
    await act(async () => { reads[0]?.resolve(reads[0].snapshot) })
    await settle()
    expect(shownOrder()).toEqual(before)
    hold = null
    await act(async () => { waits[1]?.resolve(answer(waits[1].request)) })
    await settle()
    expect(shownOrder()).toEqual(serverOrder())
  })
})

describe('R4-D 「다시 시도」 가 오류 상태인 작업 중 조회도 다시 보낸다', () => {
  it('D1 hook — 작업 중 조회 network 실패 → retry → 찾음', async () => {
    probeRepos = [{ root: '/r', name: 'repo', error: null, worktrees: [worktree({ path: '/r/w', branch: 'K-1-work' })] }]
    hold = (request) => (request.call.op === 'findByKey' ? Promise.resolve(reject(request, 'network')) : null)
    await probe()
    expect(probeModel.working.get('c1::K-1')?.state).toBe('error')
    hold = null
    act(() => probeModel.retry())
    await settle()
    expect(probeModel.working.get('c1::K-1')?.state).toBe('found')
  })
  it('D2 DOM — 끊김 배너의 「다시 시도」 → 연결 복구 뒤 작업 중 오류 표시가 사라진다', async () => {
    hold = (request) => (request.call.op === 'findByKey' ? Promise.resolve(reject(request, 'network')) : null)
    const repos: RepoRow[] = [{ root: '/r', name: 'repo', error: null, worktrees: [worktree({ path: '/r/w', branch: 'K-1-work' })] }]
    await renderPage({ repos })
    click(q('[data-tasks-view-tab="working"]'))
    await settle()
    settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, status: 'offline', error: { message: 'network fixture', action: 'retry' } })) }
    act(() => settingsListener(settings))
    await settle()
    expect(q('[data-tasks-banner="offline"]')).not.toBeNull()
    expect(q('[data-working-missing="error"]')).not.toBeNull()
    hold = null
    click(q('[data-tasks-banner="offline"] button'))
    await settle()
    settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, status: 'ok', error: null })) }
    act(() => settingsListener(settings))
    await settle()
    expect(q('[data-tasks-banner]')).toBeNull()
    expect(q('[data-working-missing="error"]')).toBeNull()
    expect(ops('findByKey').length).toBe(2)
    expect(closed).toBe(0)
  })
})

describe('R4-E 잠금 중 되돌리기는 버튼을 없애지 않는다 — 잠금이 풀리면 같은 버튼으로 되돌린다(Sonner DOM)', () => {
  it('E1 K-1 상태 이동 토스트 → 같은 카드 배치 이동 확인 중 → 되돌리기 클릭: 쓰기 0 · 버튼 유지 → 확인 뒤 같은 버튼: todo 로', async () => {
    toast.dismiss()
    act(() => root.render(createElement('div', null, page(), createElement(Toaster))))
    await settle()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await settle()
    const original = (): Element | undefined => [...document.querySelectorAll('[data-toast="moved"]')].find((entry) => entry.textContent?.includes('K-1 → 개발 중'))
    expect(original()).toBeDefined()
    const waits = pending('setPlacement')
    click(q('[data-tasks-view-tab="backlog"]'))
    await settle()
    await dragTo({ handle: q('[data-issue-row="K-1"] .tasks-grip'), zone: 'sec:backlog' })
    expect(waits).toHaveLength(1)
    const before = writes().length
    click(original()?.querySelector('[data-toast-undo]') ?? null)
    await new Promise((resolve) => setTimeout(resolve, 250))
    await settle()
    expect(writes()).toHaveLength(before)
    expect(original()).toBeDefined()
    expect(document.querySelector('[data-toast="failed"]')?.textContent).toContain('확인하는 중')
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await settle()
    // 잠금이 풀린 뒤 같은 버튼(6초 안).
    click(original()?.querySelector('[data-toast-undo]') ?? null)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await settle()
    expect(writes()).toHaveLength(before + 1)
    expect(writes().at(-1)?.call).toMatchObject({ op: 'changeStatus', statusKey: 'todo' })
    expect(server()?.statusKey).toBe('todo')
    expect(closed).toBe(0)
    toast.dismiss()
  })
})
