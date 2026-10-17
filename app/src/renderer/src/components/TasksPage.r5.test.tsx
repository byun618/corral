// @vitest-environment happy-dom
// LIFE-622 — LIFE-601 리뷰 r5(Codex) 의 알려진 문제 R5-A·R5-B 를 잡는 시험. 출발점: 리뷰어 프로브 `specs/LIFE-601-tasks-page/raw/review/codex-r5-raw/raw/new-r5-probes.tsx`
// (R5-LAG-REPLAY · R5-LATE-NEW-FINAL · R5-LATE-UNDO) — 단언은 그대로 옮기고, 하네스는 r4 시험과 같다(서버는 상태를 가진 모의 `answer`).
// 더해서 늦은 되돌리기의 수명(C5): 같은 카드에 그 뒤 쓰기가 있으면 옛 되돌리기가 그 쓰기를 덮지 않는다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkCall, WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
import { useTasksPage, type MoveNotice, type TasksPageModel } from '../hooks/useTasksPage.js'
import { moveAfter } from '../tasks-model.js'
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

let host: HTMLDivElement
let root: Root
let caps: WorkCapabilities
let settings: WorkSettingsState
let items: WorkItem[]
let calls: WorkRequest[]
let hold: ((request: WorkRequest) => Promise<WorkResponse> | null) | null
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

/** 렌더러 30초 한도를 넘긴다(가짜 타이머). */
const pass = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('R5-A 같은 카드의 늦은 쓰기와 새 쓰기는 하나의 정합화 단위 — 옛 의도를 재조회 위에 다시 적용하지 않고, 마지막 쓰기 뒤 서버와 맞춘다', () => {
  it('R5-LAG-REPLAY 늦은 옛 상태 의도가 뒤에 확정된 새 쓰기 위의 재조회에 재적용되지 않는다 — 중간·최종 화면 = 서버', async () => {
    await probe()
    const waits: { request: WorkRequest; snapshot: WorkResponse; resolve: (response: WorkResponse) => void }[] = []
    // 첫 쓰기는 서버에 바로 적용되지만(snapshot) 답은 붙든다.
    hold = (request) => (request.call.op === 'changeStatus' && waits.length === 0 ? new Promise((resolve) => waits.push({ request, snapshot: answer(request), resolve })) : null)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await pass(30_001)
      expect(probeModel.busy.size).toBe(0)
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'todo' } })
      await pass(10)
      expect(row().item.statusKey).toBe('todo')
      await act(async () => probeModel.reload({ quiet: true }))
      expect(row().item.statusKey).toBe(server()?.statusKey)
      await act(async () => waits[0]?.resolve(waits[0].snapshot))
      await pass(10)
      expect(row().item.statusKey).toBe(server()?.statusKey)
      expect(server()?.statusKey).toBe('todo')
    } finally { vi.useRealTimers() }
  })

  it('R5-LATE-NEW-FINAL 옛 쓰기 늦은 답이 새 쓰기 답보다 먼저 와도 그 카드의 마지막 쓰기가 끝나면 서버와 맞춘다 — 배치', async () => {
    await probe()
    const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void; snapshot?: WorkResponse }[] = []
    // 둘째 쓰기는 보낼 때 서버에 적용(snapshot), 첫째는 답할 때 적용 — 서버 적용 순서 ≠ 응답 순서.
    hold = (request) => (request.call.op === 'setPlacement' ? new Promise((resolve) => { const snapshot = waits.length === 1 ? answer(request) : undefined; waits.push({ request, resolve, snapshot }) }) : null)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'placement', placement: 'backlog' } })
      await pass(30_001)
      moveNow({ row: row(), intent: { kind: 'placement', placement: 'board' } })
      await pass(1)
      expect(waits).toHaveLength(2)
      await act(async () => waits[0]?.resolve(answer(waits[0].request)))
      await pass(1)
      await act(async () => waits[1]?.resolve(waits[1].snapshot ?? reject(waits[1].request)))
      await pass(100)
      expect(probeModel.busy.size).toBe(0)
      expect(server()?.placement).toBe('backlog')
      expect(row().item.placement).toBe(server()?.placement)
    } finally { vi.useRealTimers() }
  })

  it('R5-LATE-NEW-FINAL 상태 갈래 — 같은 엇갈림에서 최종 화면 = 서버', async () => {
    await probe()
    const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void; snapshot?: WorkResponse }[] = []
    hold = (request) => (request.call.op === 'changeStatus' ? new Promise((resolve) => { const snapshot = waits.length === 1 ? answer(request) : undefined; waits.push({ request, resolve, snapshot }) }) : null)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await pass(30_001)
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'todo' } })
      await pass(1)
      expect(waits).toHaveLength(2)
      await act(async () => waits[0]?.resolve(answer(waits[0].request)))
      await pass(1)
      await act(async () => waits[1]?.resolve(waits[1].snapshot ?? reject(waits[1].request)))
      await pass(100)
      expect(server()?.statusKey).toBe('doing')
      expect(row().item.statusKey).toBe(server()?.statusKey)
    } finally { vi.useRealTimers() }
  })
})

describe('R5-B 30초를 넘겨 성공이 확정된 상태·배치 변경에도 되돌리기 — 후행 쓰기를 덮지 않는 수명', () => {
  it('R5-LATE-UNDO 늦게 확정된 배치 변경에 되돌리기 토스트, 누르면 옮기기 전으로', async () => {
    await probe()
    const waits = pending('setPlacement')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'placement', placement: 'backlog' } })
      await pass(30_001)
      await act(async () => waits[0]?.resolve(answer(waits[0].request)))
      await pass(1)
      expect(row().item.placement).toBe('backlog')
      const moved = notices.find((notice) => notice.kind === 'moved')
      expect(moved).toBeDefined()
      hold = null
      let taken = false
      act(() => { if (moved?.kind === 'moved') taken = moved.undo() })
      await pass(10)
      expect(taken).toBe(true)
      expect(server()?.placement).toBe('board')
      expect(row().item.placement).toBe('board')
    } finally { vi.useRealTimers() }
  })

  it('R5-LATE-UNDO 상태 갈래 — 늦게 확정된 상태 변경에도 되돌리기', async () => {
    await probe()
    const waits = pending('changeStatus')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await pass(30_001)
      await act(async () => waits[0]?.resolve(answer(waits[0].request)))
      await pass(1)
      expect(notices.filter((notice) => notice.kind === 'moved')).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('후행 쓰기 진행 중 — 옛 쓰기가 늦게 성공해도 되돌리기를 내지 않는다(같은 갈래의 후행 쓰기를 덮는 길 0)', async () => {
    await probe()
    const waits = pending('changeStatus')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await pass(30_001)
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'done' } })
      await pass(1)
      expect(waits).toHaveLength(2)
      // 서버 적용 순서 = 옛 → 새. 옛 답이 먼저 온다(그때 새 쓰기는 진행 중).
      await act(async () => waits[0]?.resolve(answer(waits[0].request)))
      await pass(10)
      expect(notices.some((notice) => notice.kind === 'moved')).toBe(false)
      await act(async () => waits[1]?.resolve(answer(waits[1].request)))
      await pass(10)
      expect(notices.filter((notice) => notice.kind === 'moved').map((notice) => (notice.kind === 'moved' ? notice.label : ''))).toEqual(['K-1 → 완료'])
      expect(server()?.statusKey).toBe('done')
      expect(row().item.statusKey).toBe('done')
    } finally { vi.useRealTimers() }
  })

  it('후행 쓰기 확정 뒤 — 앞서 받은 되돌리기를 눌러도 보내지 않는다(같은 갈래의 후행 쓰기를 덮지 않는다)', async () => {
    await probe()
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    const first = notices.find((notice) => notice.kind === 'moved')
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'done' } })
    await settle()
    const before = writes().length
    let taken: boolean | null = null
    act(() => { if (first?.kind === 'moved') taken = first.undo() })
    await settle()
    expect(taken).toBe(true)
    expect(writes()).toHaveLength(before)
    expect(server()?.statusKey).toBe('done')
    expect(notices.at(-1)).toMatchObject({ kind: 'failed' })
  })

  it('다른 갈래의 후행 쓰기(상태 뒤 배치)는 되돌리기를 무효로 하지 않는다 — 덮지 않는다(R4-E 그대로)', async () => {
    await probe()
    moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    const first = notices.find((notice) => notice.kind === 'moved')
    moveNow({ row: row(), intent: { kind: 'placement', placement: 'backlog' } })
    await settle()
    act(() => { if (first?.kind === 'moved') first.undo() })
    await settle()
    expect(server()).toMatchObject({ statusKey: 'todo', placement: 'backlog' })
  })

  it('다른 카드의 쓰기는 되돌리기를 무효로 하지 않는다', async () => {
    await probe()
    moveNow({ row: row(), intent: { kind: 'placement', placement: 'backlog' } })
    await settle()
    const first = notices.find((notice) => notice.kind === 'moved')
    moveNow({ row: row('i4'), intent: { kind: 'status', statusKey: 'doing' } })
    await settle()
    act(() => { if (first?.kind === 'moved') first.undo() })
    await settle()
    expect(server()?.placement).toBe('board')
    expect(server('i4')?.statusKey).toBe('doing')
  })

  it('늦은 성공 전에 연결 세대가 바뀌면 되돌리기 없음', async () => {
    await probe()
    const waits = pending('setPlacement')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'placement', placement: 'backlog' } })
      await pass(30_001)
      settings = { ...settings, connections: [{ ...connection('c1', 'wxyz'), generation: 2 }] }
      act(() => settingsListener(settings))
      await pass(10)
      await act(async () => waits[0]?.resolve(answer(waits[0].request)))
      await pass(10)
      expect(notices.some((notice) => notice.kind === 'moved')).toBe(false)
    } finally { vi.useRealTimers() }
  })
})

// LIFE-622 수정 1 — 리뷰 r1 X1-1(R1-A)·X1-2(R1-B). 출발점: `specs/LIFE-622-reconcile-conflict/raw/review/codex-r1-raw/TasksPage.codex-probe.test.tsx`(X1 detail-last · X2).
/** 상세 쓰기(writeItem) — 화면 경로와 같은 낙관 갱신을 싣는다. */
const writeNow = (call: Extract<WorkCall, { op: 'changeStatus' | 'setPlacement' }>): void => {
  const optimistic = (entry: WorkItem): WorkItem => (call.op === 'changeStatus' ? { ...entry, statusKey: call.statusKey, category: STATUSES.find((status) => status.key === call.statusKey)?.category ?? 'todo' } : { ...entry, placement: call.placement })
  act(() => { void probeModel.writeItem({ connectionId: 'c1', spaceKey: 's1', itemId: 'i1', call, optimistic }) })
}

describe('R1-A 보드·상세가 섞인 단위 — 마지막 답이 어느 쪽이든 마지막 정합화는 그 답의 반영 뒤', () => {
  const detailCalls: { name: string; board: Parameters<TasksPageModel['move']>[0]['intent']; detail: Extract<WorkCall, { op: 'changeStatus' | 'setPlacement' }> }[] = [
    { name: '보드 배치 · 상세 상태', board: { kind: 'placement', placement: 'backlog' }, detail: { op: 'changeStatus', itemId: 'i1', statusKey: 'doing', ifVersion: null } },
    { name: '보드 상태 · 상세 배치', board: { kind: 'status', statusKey: 'doing' }, detail: { op: 'setPlacement', itemId: 'i1', placement: 'backlog', ifVersion: null } },
  ]
  for (const { name, board, detail } of detailCalls) {
    for (const last of ['detail', 'board'] as const) {
      it(`${name} — ${last === 'detail' ? '상세' : '보드'} 답이 마지막(서버 적용은 반대 순서) → 최종 화면 = 서버`, async () => {
        await probe()
        const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void; snapshot?: WorkResponse }[] = []
        // 둘째 쓰기(상세)는 보낼 때 서버에 적용, 첫째(보드)는 답할 때 적용.
        hold = (request) => (request.call.op === 'changeStatus' || request.call.op === 'setPlacement' ? new Promise((resolve) => { const snapshot = waits.length === 1 ? answer(request) : undefined; waits.push({ request, resolve, snapshot }) }) : null)
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          moveNow({ row: row(), intent: board })
          await pass(30_001)
          writeNow(detail)
          await pass(1)
          expect(waits).toHaveLength(2)
          const boardAnswer = (): Promise<void> => act(async () => waits[0]?.resolve(answer(waits[0].request)))
          const detailAnswer = (): Promise<void> => act(async () => waits[1]?.resolve(waits[1].snapshot ?? reject(waits[1].request)))
          if (last === 'detail') { await boardAnswer(); await pass(1); await detailAnswer() } else { await detailAnswer(); await pass(1); await boardAnswer() }
          await pass(100)
          expect({ status: row().item.statusKey, placement: row().item.placement }).toEqual({ status: server()?.statusKey, placement: server()?.placement })
        } finally { vi.useRealTimers() }
      })
    }
  }
})

describe('R1-B 되돌리기 기준은 확인된 값일 때만 — 겹친 미확인 의도 위에서 시작한 쓰기는 거절된 값을 되살리지 않는다', () => {
  const restored = (): string[] => writes().slice(2).map((request) => (request.call.op === 'changeStatus' ? request.call.statusKey : ''))

  it('X2 늦은 성공 — 앞 쓰기 A 거절 · 뒤 쓰기 B 늦은 성공: B 의 되돌리기가 A 의 값(doing)을 저장하지 않는다', async () => {
    await probe()
    const waits = pending('changeStatus')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await pass(30_001)
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'done' } })
      await pass(30_001)
      await act(async () => waits[0]?.resolve(reject(waits[0].request)))
      await pass(1)
      await act(async () => waits[1]?.resolve(answer(waits[1].request)))
      await pass(10)
      expect(server()?.statusKey).toBe('done')
      hold = null
      const moved = notices.find((notice) => notice.kind === 'moved')
      act(() => { if (moved?.kind === 'moved') moved.undo() })
      await pass(10)
      expect(restored()).not.toContain('doing')
      expect(server()?.statusKey).not.toBe('doing')
      expect(row().item.statusKey).toBe(server()?.statusKey)
    } finally { vi.useRealTimers() }
  })

  it('즉시 성공 — 늦은 A 가 답하기 전에 B 가 바로 성공, 그 뒤 A 거절: B 의 되돌리기가 A 의 값을 저장하지 않는다', async () => {
    await probe()
    const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => (request.call.op === 'changeStatus' && waits.length === 0 ? new Promise((resolve) => waits.push({ request, resolve })) : null)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await pass(30_001)
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'done' } })
      await pass(10)
      await act(async () => waits[0]?.resolve(reject(waits[0].request)))
      await pass(10)
      hold = null
      const moved = notices.find((notice) => notice.kind === 'moved')
      act(() => { if (moved?.kind === 'moved') moved.undo() })
      await pass(10)
      expect(restored()).not.toContain('doing')
      expect(server()?.statusKey).not.toBe('doing')
    } finally { vi.useRealTimers() }
  })

  it('앞 쓰기가 늦게 실패한 뒤 재조회 전에 시작한 쓰기도 그 실패 값을 기준으로 삼지 않는다', async () => {
    await probe()
    const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    let holdList = false
    hold = (request) => {
      if (request.call.op === 'changeStatus' && waits.length === 0) return new Promise((resolve) => waits.push({ request, resolve }))
      // A 실패 뒤 재조회를 붙든다 — 그동안 화면엔 A 의 낙관 값(doing)이 남아 있다.
      if (request.call.op === 'listItems' && holdList) return new Promise(() => {})
      return null
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'doing' } })
      await pass(30_001)
      holdList = true
      await act(async () => waits[0]?.resolve(reject(waits[0].request)))
      await pass(1)
      expect(row().item.statusKey).toBe('doing')
      moveNow({ row: row(), intent: { kind: 'status', statusKey: 'done' } })
      await pass(10)
      hold = null
      const moved = notices.find((notice) => notice.kind === 'moved')
      act(() => { if (moved?.kind === 'moved') moved.undo() })
      await pass(10)
      expect(restored()).not.toContain('doing')
    } finally { vi.useRealTimers() }
  })
})
