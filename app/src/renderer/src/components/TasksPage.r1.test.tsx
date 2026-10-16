// @vitest-environment happy-dom
// LIFE-601 수정 r1 — 리뷰 r1(Codex) 지적마다 그 결함을 잡는 시험. 출발점: 리뷰어 재현 `raw/review/codex-r1-raw/l601-r1-review-v4.test.tsx`.
// UI 경로 결함(A·G·I·J·L·O)은 DOM 이벤트(mousedown/move/up·click·keydown·input)로 본다 — 훅을 직접 부르지 않는다.
// 하위 계층 결함(E·F·M·N·D)은 훅을 띄워(`Probe`) 본다. R1-B 는 `TasksPage.service.test.tsx`(실제 WorkService 상태 push 까지).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow, WorktreeRow } from '../../../shared/types.js'
import type { WorkCall, WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import { useTasksPage, type MoveNotice, type TasksPageModel } from '../hooks/useTasksPage.js'
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
const item = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => ({ bodyLock: null, 
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
function answer(request: WorkRequest): WorkResponse {
  const { call } = request
  const statusOf = (key: string): WorkStatus['category'] => STATUSES.find((status) => status.key === key)?.category ?? 'todo'
  const found = (id: string): WorkItem | undefined => items.find((entry) => entry.id === id)
  switch (call.op) {
    case 'listSpaces': return respond(request, { op: 'listSpaces', spaces: [], capabilities: caps })
    case 'listStatuses': return respond(request, { op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task', childKinds: [] }] })
    case 'listItems': return respond(request, { op: 'listItems', items, nextCursor: null, truncated: false })
    case 'findByKey': return respond(request, { op: 'findByKey', item: items.find((entry) => entry.key.toUpperCase() === call.key.toUpperCase()) ?? null })
    case 'listTransitions': return respond(request, { blocked: [], op: 'listTransitions', statusKeys: ['doing'] })
    case 'changeStatus': {
      const current = found(call.itemId)
      return current === undefined ? reject(request) : respond(request, { op: 'changeStatus', item: { ...current, statusKey: call.statusKey, category: statusOf(call.statusKey) } })
    }
    case 'setPlacement': {
      const current = found(call.itemId)
      return current === undefined ? reject(request) : respond(request, { op: 'setPlacement', item: { ...current, placement: call.placement } })
    }
    case 'reorder': {
      const current = found(call.itemId)
      return current === undefined ? reject(request) : respond(request, { op: 'reorder', item: current })
    }
    default: return reject(request)
  }
}

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
function addSpace(): void {
  settings.connections[0]?.spaces?.push({ capabilities: {}, key: 's2', name: 'second', color: null, openCount: 0, hidden: false })
}
function pending(op: WorkCall['op']): { request: WorkRequest; resolve: (response: WorkResponse) => void }[] {
  const list: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
  hold = (request) => (request.call.op === op ? new Promise((resolve) => list.push({ request, resolve })) : null)
  return list
}

describe('R1-A 끌기 3종 — UI 에서 시작한 끌기가 실제로 쓰기를 보낸다', () => {
  it('보드 가로(다른 칸) = changeStatus 1회 · 카드가 그 칸으로', async () => {
    await renderPage()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    expect(ops('changeStatus').map((request) => request.call)).toEqual([{ op: 'changeStatus', itemId: 'i1', statusKey: 'doing', ifVersion: null }])
    expect(q('[data-board-column="st:doing"] [data-issue-card="K-1"]')).not.toBeNull()
  })
  it('보드 세로(같은 칸, 순서 on) = reorder 1회 · 맨 뒤로', async () => {
    await renderPage()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:todo' })
    expect(ops('reorder').map((request) => request.call)).toEqual([{ op: 'reorder', itemId: 'i1', afterId: 'i4' }])
  })
  it('백로그 섹션 사이 = setPlacement 1회 · 행이 백로그 섹션으로', async () => {
    await renderPage()
    click(q('[data-tasks-view-tab="backlog"]'))
    await dragTo({ handle: q('[data-issue-row="K-1"] .tasks-grip'), zone: 'sec:backlog' })
    expect(ops('setPlacement').map((request) => request.call)).toEqual([{ op: 'setPlacement', itemId: 'i1', placement: 'backlog', ifVersion: null }])
    expect(q('[data-backlog-section="backlog"] [data-issue-row="K-1"]')).not.toBeNull()
  })
  it('쓰기 거절 → 카드가 원래 칸으로 돌아간다(UI 경로)', async () => {
    hold = (request) => (request.call.op === 'changeStatus' ? Promise.resolve(reject(request)) : null)
    await renderPage()
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    expect(ops('changeStatus')).toHaveLength(1)
    expect(q('[data-board-column="st:todo"] [data-issue-card="K-1"]')).not.toBeNull()
  })
})

describe('C7 덧붙임 — 허용 전이(allowed) 목록을 받기 전·실패 시 fail-open 이 아니다', () => {
  it('받는 중이면 다른 칸이 흐림 + 이유, 놓아도 쓰기 0', async () => {
    caps = { ...BASE_CAPS, transition: { mode: 'allowed' } }
    settings.connections = [connection('c1', 'wxyz')]
    await renderPage()
    const waits = pending('listTransitions')
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    expect(waits).toHaveLength(1)
    const column = q('[data-board-column="st:doing"]')
    expect(column?.classList.contains('drag-blocked')).toBe(true)
    expect(column?.querySelector('[data-column-reason]')?.textContent).toContain('받는 중')
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(ops('changeStatus')).toHaveLength(0)
  })
  it('조회가 실패하면 흐림 + 실패 이유, 놓아도 쓰기 0', async () => {
    caps = { ...BASE_CAPS, transition: { mode: 'allowed' } }
    settings.connections = [connection('c1', 'wxyz')]
    await renderPage()
    hold = (request) => (request.call.op === 'listTransitions' ? Promise.resolve(reject(request, 'network')) : null)
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    await settle()
    const column = q('[data-board-column="st:doing"]')
    expect(column?.classList.contains('drag-blocked')).toBe(true)
    expect(column?.querySelector('[data-column-reason]')?.textContent).toContain('network (시험)')
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(ops('changeStatus')).toHaveLength(0)
  })
  it('받은 허용 전이만 열린다 — doing 은 쓰기, done 은 흐림', async () => {
    caps = { ...BASE_CAPS, transition: { mode: 'allowed' } }
    settings.connections = [connection('c1', 'wxyz')]
    await renderPage()
    startDrag({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:done' })
    await settle()
    expect(q('[data-board-column="st:done"]')?.classList.contains('drag-blocked')).toBe(true)
    expect(q('[data-board-column="st:doing"]')?.classList.contains('drag-target')).toBe(true)
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(ops('changeStatus')).toHaveLength(0)
    await dragTo({ handle: q('[data-issue-card="K-1"]'), zone: 'col:st:doing' })
    expect(ops('changeStatus')).toHaveLength(1)
  })
})

describe('R1-C 스페이스 목록 조회 실패 — 보존 · 자동 재요청 없음 · 「전체」 에서도 보인다', () => {
  it('network 실패 + 상태 push 3회 → listSpaces 1회 · 오프라인 배너 · 다시 시도 = 1회 더', async () => {
    const first = connection('c1', 'wxyz')
    settings.connections = [{ ...first, spaces: null }]
    let count = 0
    hold = (request) => {
      if (request.call.op !== 'listSpaces') return null
      count += 1
      return Promise.resolve().then(() => {
        if (count <= 3) {
          settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, status: 'offline', error: { message: 'offline spaces', action: 'retry' } })) }
          settingsListener(settings)
        }
        return reject(request, 'network')
      })
    }
    await renderPage()
    expect(count).toBe(1)
    expect(q('[data-tasks-page]')?.getAttribute('data-tasks-space')).toBe('all')
    expect(q('[data-tasks-banner="offline"]')).not.toBeNull()
    click(q('[data-tasks-retry]'))
    await settle()
    expect(count).toBe(2)
  })
  it('「전체」 에서 다른 연결의 스페이스 조회 실패도 배너로', async () => {
    settings.connections = [connection('c1', 'wxyz'), { ...connection('c2', 'abcd'), spaces: null }]
    hold = (request) => (request.call.op === 'listSpaces' ? Promise.resolve(reject(request, 'invalid_response')) : null)
    await renderPage()
    click(q('[data-space-switch]'))
    click(q('[data-space-row="all"]'))
    await settle()
    expect(q('[data-tasks-banner]')?.textContent).toContain('invalid_response (시험)')
  })
})

describe('R1-D 스페이스 선택 — 첫 선택 · 재열기 복원 · 유효성', () => {
  it('S1 레포 기본 s1 에서 s2 를 고르고 닫았다 열면 s2', async () => {
    addSpace()
    settings.repoDefaults = [{ repoRoot: '/repo', connectionId: 'c1', spaceKey: 's1' }]
    await probe({ activeRepoRoot: '/repo' })
    act(() => probeModel.chooseSpace({ kind: 'space', connectionId: 'c1', spaceKey: 's2' }))
    await settle()
    await probe({ open: false, activeRepoRoot: '/repo' })
    await probe({ open: true, activeRepoRoot: '/repo' })
    expect(probeModel.space).toMatchObject({ spaceKey: 's2' })
  })
  it('S2 열린 동안 고른 스페이스를 숨기면 보이는 스페이스로 바뀌고 옛 자료가 남지 않는다', async () => {
    addSpace()
    await probe()
    expect(probeModel.space).toMatchObject({ spaceKey: 's1' })
    settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, hiddenSpaceKeys: ['s1'] })) }
    act(() => settingsListener(settings))
    await settle()
    expect(probeModel.space).toMatchObject({ spaceKey: 's2' })
    expect(probeModel.rows.every((entry) => entry.space.spaceKey === 's2')).toBe(true)
  })
  it('S3 스페이스 목록이 늦게 와도 레포 기본을 고른다(「전체」 로 굳지 않는다)', async () => {
    addSpace()
    settings.repoDefaults = [{ repoRoot: '/repo', connectionId: 'c1', spaceKey: 's2' }]
    const spaces = settings.connections[0]?.spaces ?? null
    settings.connections = settings.connections.map((entry) => ({ ...entry, spaces: null }))
    hold = (request) => (request.call.op === 'listSpaces' ? new Promise(() => {}) : null)
    await probe({ activeRepoRoot: '/repo' })
    settings = { ...settings, connections: settings.connections.map((entry) => ({ ...entry, spaces })) }
    act(() => settingsListener(settings))
    await settle()
    expect(probeModel.space).toMatchObject({ spaceKey: 's2' })
  })
})

describe('R1-E 원복·되돌리기 — 확정 값과 보존한 맥락', () => {
  // 수정 r2(R2-A) — 같은 카드의 확인 안 된 쓰기는 하나뿐이다. 옛 M1·M1b·M1c(겹친 두 요청의 응답 순서)는 이제 일어나지 않는 경우라
  // 「두 번째 옮기기는 보내지 않는다」 로 바꿔 본다. 거절 뒤에는 서버를 다시 읽어 수렴한다.
  it('M1 확인 전 두 번째 옮기기는 보내지 않는다 · 첫 요청 거절 → todo + 서버 재조회', async () => {
    const waits = pending('changeStatus')
    await probe()
    act(() => { void probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
    await settle()
    act(() => { void probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'done' } }) })
    await settle()
    expect(waits).toHaveLength(1)
    const lists = ops('listItems').length
    await act(async () => { waits[0]?.resolve(reject(waits[0].request)) })
    await settle()
    expect(row().item.statusKey).toBe('todo')
    expect(ops('listItems').length).toBeGreaterThan(lists)
  })
  it('M1b 확인 전 두 번째 옮기기는 보내지 않는다 · 첫 요청 성공 → 그 서버 값(doing)', async () => {
    const waits = pending('changeStatus')
    await probe()
    act(() => { void probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
    await settle()
    act(() => { void probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'done' } }) })
    await settle()
    expect(waits).toHaveLength(1)
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    expect(row().item.statusKey).toBe('doing')
  })
  it('M1c 확인 뒤에는 다시 옮길 수 있다 — 두 번째 요청이 나가고 그 값이 남는다', async () => {
    const waits = pending('changeStatus')
    await probe()
    act(() => { void probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
    await settle()
    await act(async () => { waits[0]?.resolve(answer(waits[0].request)) })
    await settle()
    // (이 묶음의 모의 서버는 상태가 없어 완료 분류를 넘나들면 재조회가 todo 로 돌린다 — 그래서 done 밖 전이로 본다.)
    act(() => { void probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'todo' } }) })
    await settle()
    expect(waits).toHaveLength(2)
    expect(waits[1]?.request.call).toMatchObject({ statusKey: 'todo' })
    await act(async () => { waits[1]?.resolve(answer(waits[1].request)) })
    await settle()
    expect(row().item.statusKey).toBe('todo')
  })
  it('M3 다른 스페이스로 옮긴 뒤 되돌리기도 역요청을 보낸다', async () => {
    addSpace()
    await probe()
    await act(async () => { await probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
    const notice = notices.findLast((entry) => entry.kind === 'moved')
    act(() => probeModel.chooseSpace({ kind: 'space', connectionId: 'c1', spaceKey: 's2' }))
    await settle()
    const before = ops('changeStatus').length
    act(() => { if (notice?.kind === 'moved') notice.undo() })
    await settle()
    expect(ops('changeStatus')).toHaveLength(before + 1)
    expect(ops('changeStatus').at(-1)?.call).toMatchObject({ itemId: 'i1', statusKey: 'todo' })
  })
})

describe('R1-F 먼저 시작한 목록 응답이 나중에 성공한 변경을 덮지 않는다', () => {
  it('M2 조용한 새로고침 중 옮기기 성공 → 옛 목록 도착 → doing 유지', async () => {
    await probe()
    const lists = pending('listItems')
    act(() => { void probeModel.reload({ quiet: true }) })
    await settle()
    hold = null
    await act(async () => { await probeModel.move({ row: row(), intent: { kind: 'status', statusKey: 'doing' } }) })
    expect(row().item.statusKey).toBe('doing')
    await act(async () => { lists[0]?.resolve(answer(lists[0].request)) })
    await settle()
    expect(row().item.statusKey).toBe('doing')
  })
})

describe('R1-G 키 — 위층·바깥 입력을 가로채지 않는다', () => {
  it('바깥 입력의 Esc 는 기본 동작을 막지 않고 페이지를 닫지 않는다', async () => {
    await renderPage()
    const external = document.createElement('input')
    document.body.append(external)
    external.focus()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { external.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(closed).toBe(0)
  })
  it('위층(설정)이 열려 있으면(yieldKeys) body 의 Esc 두 번에도 페이지가 닫히지 않는다', async () => {
    await renderPage({ yieldKeys: true })
    for (let index = 0; index < 2; index += 1) act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(closed).toBe(0)
  })
  it('대조 — 위층이 없으면 페이지 안 Esc 는 닫는다', async () => {
    await renderPage()
    const pageRoot = q('[data-tasks-page]')
    if (pageRoot === null) throw new Error('페이지 없음')
    act(() => { pageRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(closed).toBe(1)
  })
})

describe('R1-I 공통 필터 — 작업 중 보기·키 조회 결과에도', () => {
  it('F1 「막힘」 을 켜면 안 막힌 작업 중 항목이 빠진다', async () => {
    const repos: RepoRow[] = [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-1-test' })] }]
    await renderPage({ repos })
    click(q('[data-tasks-view-tab="working"]'))
    expect(q('[data-working-item="K-1"]')).not.toBeNull()
    click(q('[data-filter="blocked"]'))
    expect(q('[data-working-item="K-1"]')).toBeNull()
  })
  it('F3 「막힘」 + 안 막힌 키 검색 → 키 일치 결과가 필터를 우회하지 않는다', async () => {
    await renderPage()
    click(q('[data-filter="blocked"]'))
    type('K-1')
    await settle()
    expect(q('[data-search-hit]')).toBeNull()
  })
})

describe('R1-J 정확한 키가 맨 앞', () => {
  it('F2 K-20(앞 순서)·K-2 목록에서 K-2 검색 → 첫 행 K-2 + 키 일치, 그 행은 한 번만', async () => {
    items = [item({ id: 'i20', key: 'K-20', rank: '0' }), item({ id: 'i2', key: 'K-2', rank: '1' })]
    await renderPage()
    click(q('[data-tasks-view-tab="list"]'))
    type('K-2')
    await settle()
    const keys = [...host.querySelectorAll('[data-issue-row]')].map((element) => element.getAttribute('data-issue-row'))
    expect(keys).toEqual(['K-2', 'K-20'])
    expect(q('[data-issue-row="K-2"] [data-search-hit]')).not.toBeNull()
  })
})

describe('R1-K 키 조회 오류는 「검색 결과 없음」 이 아니다', () => {
  it('E1 findByKey invalid_response → 배너, 빈 상태 아님', async () => {
    hold = (request) => (request.call.op === 'findByKey' ? Promise.resolve(reject(request, 'invalid_response')) : null)
    await renderPage()
    type('K-999')
    await settle()
    expect(q('[data-tasks-banner]')?.textContent).toContain('invalid_response (시험)')
    expect(q('[data-tasks-empty="search"]')).toBeNull()
  })
})

describe('R1-L 화면 정체 = (연결, 작업 id)', () => {
  it('I1 두 연결이 같은 id 를 주면 선택은 하나 · React key 경고 없음 · 끌기는 그 연결로 쓴다', async () => {
    settings.connections = [connection('c1', 'wxyz'), connection('c2', 'abcd')]
    items = [item({ id: 'i1', key: 'K-1' })]
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderPage()
    click(q('[data-space-switch]'))
    click(q('[data-space-row="all"]'))
    await settle()
    const cards = host.querySelectorAll('[data-issue-card]')
    expect(cards).toHaveLength(2)
    click(cards[1] ?? null)
    expect(host.querySelectorAll('[data-issue-card].is-selected')).toHaveLength(1)
    expect(errors.mock.calls.some((args) => String(args[0]).includes('same key'))).toBe(false)
    // 고른 카드는 상세 첫 읽기 동안 끌기가 잠긴다(LIFE-602 R6-D) — 읽기가 끝난 뒤 끈다.
    await settle()
    await dragTo({ handle: host.querySelectorAll('[data-issue-card]')[1] ?? null, zone: 'col:cat:in_progress' })
    expect(ops('changeStatus').map((request) => request.connectionId)).toEqual(['c2'])
  })
})

describe('R1-M·N 페이지', () => {
  it('P1 버린 「더 불러오기」 응답이 새 요청의 loading 을 풀지 않는다', async () => {
    await probe()
    const more: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => {
      if (request.call.op !== 'listItems') return null
      if (request.call.cursor === null) return Promise.resolve(respond(request, { op: 'listItems', items: items.slice(0, 1), nextCursor: 'next', truncated: false }))
      return new Promise((resolve) => more.push({ request, resolve }))
    }
    await act(async () => { await probeModel.reload({ quiet: true }) })
    act(() => { void probeModel.loadMore() })
    await settle()
    act(() => probeModel.invalidateMore())
    act(() => { void probeModel.loadMore() })
    await settle()
    expect(probeModel.load.loadingMore).toBe(true)
    await act(async () => { more[0]?.resolve(respond(more[0].request, { op: 'listItems', items: [], nextCursor: null, truncated: false })) })
    await settle()
    expect(probeModel.load.loadingMore).toBe(true)
  })
  it('P2 닫았다 열어도 더 받은 쪽이 남는다', async () => {
    hold = (request) => (request.call.op === 'listItems'
      ? Promise.resolve(respond(request, { op: 'listItems', items: request.call.cursor === null ? items.slice(0, 1) : items.slice(1), nextCursor: request.call.cursor === null ? 'next' : null, truncated: false }))
      : null)
    await probe()
    await act(async () => { await probeModel.loadMore() })
    expect(probeModel.rows).toHaveLength(4)
    await probe({ open: false })
    await probe({ open: true })
    await settle()
    expect(probeModel.rows).toHaveLength(4)
  })
})

describe('R1-O 배치 disabled = 백로그 탭 흐림 + 이유', () => {
  it('C8 placement disabled → aria-disabled · title 이유 · 눌러도 보기 안 바뀜', async () => {
    caps = { ...BASE_CAPS, placement: { state: 'disabled', reason: 'placement locked' } }
    settings.connections = [connection('c1', 'wxyz')]
    await renderPage()
    const tab = q('[data-tasks-view-tab="backlog"]')
    expect(tab?.getAttribute('aria-disabled')).toBe('true')
    expect(tab?.getAttribute('title')).toContain('placement locked')
    click(tab)
    expect(q('[data-tasks-page]')?.getAttribute('data-tasks-view')).toBe('board')
  })
})
