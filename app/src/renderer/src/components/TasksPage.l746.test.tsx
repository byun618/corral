// @vitest-environment happy-dom
// LIFE-746 보드 「묶기: 부모」 레인 밀도 — 완료 레인 순서·기본 접힘·토글 우선(C1) · 레인 안 빈 칸 얇게(C2) · 같은 레인 막힌 칸 이유가 목록을 밀지 않음(C3).
// 가짜 preload(`window.corral`)로 그린다. 부모 K-10(진행 레인)·K-40(완료 레인, 순서 값이 앞)은 백로그 배치라 카드가 없다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
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
const CHECKPOINT = { key: 'checkpoint', label: 'Checkpoint', childKinds: [] }
const item = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => ({ bodyLock: null, doneAt: null,
  spaceKey: 's1', title: `제목 ${over.key}`, body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'todo', category: 'todo', priority: 'medium', dueAt: null,
  parentId: null, placement: 'board', rank: null, resolution: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [], ...over,
})
const DONE: Pick<WorkItem, 'statusKey' | 'category'> = { statusKey: 'done', category: 'done' }
const P1 = 'c1::p1'
const P2 = 'c1::p2'
const WRITES = new Set(['changeStatus', 'setPlacement', 'setParent', 'reorder', 'updateItem', 'createItem'])

let host: HTMLDivElement
let root: Root
let settings: WorkSettingsState
let items: WorkItem[]
let calls: WorkCall[]
let hold: ((request: WorkRequest) => Promise<WorkResponse> | null) | null

function answer(request: WorkRequest): WorkResponse {
  const { requestId, connectionId, call } = request
  const ok = (result: Extract<WorkResponse, { ok: true }>['result']): WorkResponse => ({ requestId, connectionId, ok: true, result })
  const fail = (message: string): WorkResponse => ({ requestId, connectionId, ok: false, error: { kind: 'network', message, status: null } })
  switch (call.op) {
    case 'listSpaces': return ok({ op: 'listSpaces', spaces: [], capabilities: CAPS })
    case 'listStatuses': return ok({ op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task', childKinds: [] }, CHECKPOINT] })
    case 'listItems': return ok({ op: 'listItems', items, nextCursor: null, truncated: false })
    case 'getItem': {
      const found = items.find((entry) => entry.id === call.itemId)
      return found === undefined ? fail('없음') : ok({ op: 'getItem', item: found })
    }
    case 'changeStatus': {
      const found = items.find((entry) => entry.id === call.itemId)
      if (found === undefined) return fail('없음')
      return ok({ op: 'changeStatus', item: { ...found, statusKey: call.statusKey, category: STATUSES.find((entry) => entry.key === call.statusKey)?.category ?? 'todo' } })
    }
    default: return { requestId, connectionId, ok: false, error: { kind: 'unsupported', message: 'x', status: null } }
  }
}

let prefs: unknown
let prefWrites: number
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  settings = {
    sources: [{ accountFields: [], tokenHint: null, queryPattern: null, id: 'src-a', name: 'Source A', mono: 'SA', addLabel: '', formTitle: '', tokenLabel: '', tokenPrefix: null, keyPattern: 'K-\\d+' }],
    connections: [{ account: {},
      id: 'c1', sourceId: 'src-a', name: 'Source A', mono: 'SA', tokenTail: 'wxyz', addedAt: 0, generation: 1, status: 'ok', pending: null, error: null, checkedAt: 0,
      spaces: [{ key: 's1', name: 'corral', color: null, openCount: 2, hidden: false, capabilities: {} }], hiddenSpaceKeys: [], capabilities: CAPS,
    }],
    repoDefaults: [],
  }
  items = [
    // 완료 부모 K-40 의 순서 값(0)이 진행 부모 K-10(1)보다 앞 — 기존 규칙이면 맨 위.
    item({ id: 'p2', key: 'K-40', title: '끝난 묶음', kind: CHECKPOINT, placement: 'backlog', rank: '0' }),
    item({ id: 'p1', key: 'K-10', title: '공고 기능 개선', kind: CHECKPOINT, placement: 'backlog', rank: '1' }),
    item({ id: 'a', key: 'K-11', title: '처리할 공고 화면', parentId: 'p1', rank: '2' }),
    item({ id: 'b', key: 'K-12', title: '수집 설정', parentId: 'p1', rank: '3' }),
    item({ id: 'c', key: 'K-41', title: '끝난 하나', parentId: 'p2', rank: '4', ...DONE }),
    item({ id: 'f', key: 'K-42', title: '끝난 둘', parentId: 'p2', rank: '5', ...DONE }),
    item({ id: 'e', key: 'K-30', title: '부모 없음 작업', rank: '6' }),
  ]
  calls = []
  hold = null
  prefs = undefined
  prefWrites = 0
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: prefs }),
    setUiPrefs: (patch: { tasksPage?: unknown }) => {
      prefWrites += 1
      if ('tasksPage' in patch) prefs = patch.tasksPage
    },
    getWorkSettings: async () => settings,
    onWorkSettings: () => () => {},
    workRequest: (request: WorkRequest) => {
      calls.push(request.call)
      return hold?.(request) ?? Promise.resolve(answer(request))
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
async function renderPage({ open = true }: { open?: boolean } = {}): Promise<void> {
  act(() => root.render(createElement(TasksPageInPanel, { open, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
}
/** 다시 읽기 — 페이지를 닫았다 연다(받은 자료를 새로 받는다). */
async function reread(): Promise<void> {
  await renderPage({ open: false })
  await renderPage({ open: true })
}
const q = (selector: string): Element | null => host.querySelector(selector)
const qa = (selector: string): Element[] => [...host.querySelectorAll(selector)]
function click(target: Element | null): void {
  if (target === null) throw new Error('클릭 대상 없음')
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function mouse(target: EventTarget, name: string, x = 10, y = 10): void {
  act(() => { target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) })
}
function choose(selector: string, value: string): void {
  const select = q(selector)
  if (!(select instanceof HTMLSelectElement)) throw new Error(`선택 칸 없음 ${selector}`)
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const writes = (): WorkCall[] => calls.filter((call) => WRITES.has(call.op))
async function laned(): Promise<void> {
  await renderPage()
  choose('[data-tasks-swimlane]', 'parent')
  await settle()
}
const laneOrder = (): (string | null)[] => qa('[data-board-lane]').map((element) => element.getAttribute('data-board-lane'))
const expanded = (lane: string): string | null | undefined => q(`[data-board-lane="${lane}"] [data-lane-toggle]`)?.getAttribute('aria-expanded')
/** 포인터 아래 영역을 정한다(`elementFromPoint`). */
function hover(zone: string): void {
  const target = q(`[data-drop-zone="${zone}"]`)
  if (target === null) throw new Error(`영역 없음 ${zone}`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
}
async function startDrag({ card, zone }: { card: string; zone: string }): Promise<void> {
  hover(zone)
  mouse(q(`[data-issue-card="${card}"]`) ?? document, 'mousedown')
  mouse(document, 'mousemove', 50, 500)
  await settle()
}
async function release(): Promise<void> {
  mouse(document, 'mouseup', 60, 520)
  await settle()
}
const columnOf = ({ lane, column }: { lane: string; column: string }): Element | null => q(`[data-board-lane="${lane}"] [data-board-column="${column}"]`)
/** 칸의 직계 자식 구성 — 목록 앞에 줄이 끼면 첫 카드가 밀린다. */
const shape = (column: Element | null): string[] => [...(column?.children ?? [])].map((element) => element.className)

describe('C1 완료 레인 — 순서·기본 접힘·토글 우선', () => {
  it('진행 레인 → 완료 레인 → 부모 없음 · 완료 레인은 접힘(머리만), 진행 레인은 펼침 · 리스트 그룹 순서는 그대로', async () => {
    await laned()
    expect(laneOrder()).toEqual([P1, P2, 'none'])
    expect(q(`[data-board-lane="${P2}"]`)?.hasAttribute('data-lane-complete')).toBe(true)
    expect(q(`[data-board-lane="${P1}"]`)?.hasAttribute('data-lane-complete')).toBe(false)
    expect(expanded(P2)).toBe('false')
    expect(q(`[data-board-lane="${P2}"] [data-lane-head] [data-lane-progress]`)?.getAttribute('data-lane-progress')).toBe('2/2')
    expect(q(`[data-board-lane="${P2}"] [data-board-column]`)).toBeNull()
    expect(q(`[data-board-lane="${P2}"] [data-issue-card]`)).toBeNull()
    expect(expanded(P1)).toBe('true')
    expect(expanded('none')).toBe('true')
    expect(q(`[data-board-lane="${P1}"] [data-issue-card="K-11"]`)).not.toBeNull()
    // 리스트 그룹 「부모」 는 기존 순서 값 순(K-40 먼저).
    click(q('[data-tasks-view-tab="list"]'))
    choose('[data-tasks-group]', 'parent')
    await settle()
    expect(qa('[data-list-group]').map((element) => element.getAttribute('data-list-group'))).toEqual([`parent:${P2}`, `parent:${P1}`, 'parent:none'])
  })

  it('묶기 없음 보드는 그대로 — 레인 없음, 완료 카드도 완료 칸에', async () => {
    await renderPage()
    expect(q('[data-board-lane]')).toBeNull()
    expect(q('[data-board-column="st:done"] [data-issue-card="K-41"]')).not.toBeNull()
  })

  it('토글 우선 — 펼친 완료 레인은 다시 읽어도 펼침, 토글 안 한 레인은 데이터를 따른다(미완 → 완료면 뒤로·접힘)', async () => {
    await laned()
    click(q(`[data-board-lane="${P2}"] [data-lane-toggle]`))
    expect(expanded(P2)).toBe('true')
    expect(q(`[data-board-lane="${P2}"] [data-issue-card="K-41"]`)).not.toBeNull()
    // K-10 의 자식이 다 끝난다 — K-10 은 토글한 적이 없다.
    items = items.map((entry) => (entry.parentId === 'p1' ? { ...entry, ...DONE } : entry))
    await reread()
    expect(q(`[data-board-lane="${P1}"]`)?.hasAttribute('data-lane-complete')).toBe(true)
    // 둘 다 완료 — 완료 레인 안은 기존 순서(K-40 → K-10).
    expect(laneOrder()).toEqual([P2, P1, 'none'])
    expect(expanded(P1)).toBe('false')
    expect(expanded(P2)).toBe('true')
    // 사용자가 다시 접으면 그 선택이 이긴다.
    click(q(`[data-board-lane="${P2}"] [data-lane-toggle]`))
    expect(expanded(P2)).toBe('false')
  })

  it('토글 안 한 완료 레인이 미완이 되면 앞으로·펼침, 접어 둔 진행 레인은 완료가 돼도 접힘 그대로', async () => {
    await laned()
    click(q(`[data-board-lane="${P1}"] [data-lane-toggle]`))
    expect(expanded(P1)).toBe('false')
    items = items.map((entry) => (entry.id === 'f' ? { ...entry, statusKey: 'doing', category: 'in_progress' } : entry.parentId === 'p1' ? { ...entry, ...DONE } : entry))
    await reread()
    expect(laneOrder()).toEqual([P2, P1, 'none'])
    expect(expanded(P2)).toBe('true')
    expect(q(`[data-board-lane="${P2}"] [data-issue-card="K-42"]`)).not.toBeNull()
    expect(expanded(P1)).toBe('false')
    // 펼친 완료 레인 다시 펼치기 — 펼침이 이긴다.
    click(q(`[data-board-lane="${P1}"] [data-lane-toggle]`))
    expect(expanded(P1)).toBe('true')
  })

  it('영속하지 않는다 — 토글이 사용자 UI 설정을 쓰지 않고, 새 마운트는 다시 기본(완료 레인 접힘)', async () => {
    await laned()
    const before = { writes: prefWrites, prefs: JSON.stringify(prefs) }
    click(q(`[data-board-lane="${P2}"] [data-lane-toggle]`))
    click(q(`[data-board-lane="${P1}"] [data-lane-toggle]`))
    await settle()
    expect({ writes: prefWrites, prefs: JSON.stringify(prefs) }).toEqual(before)
    act(() => root.unmount())
    root = createRoot(host)
    await renderPage()
    expect(laneOrder()).toEqual([P1, P2, 'none'])
    expect(expanded(P2)).toBe('false')
    expect(expanded(P1)).toBe('true')
  })
})

describe('C2 레인 안 빈 칸 얇게', () => {
  it('카드 0 인 레인 칸만 얇다(표식) — 놓기 영역은 남고 칸 구성·순서는 레인마다 같다 · 카드 있는 칸·묶기 없음은 그대로', async () => {
    await renderPage()
    expect(qa('[data-column-thin]')).toHaveLength(0)
    const plain = qa('[data-board-column]').map((element) => element.getAttribute('data-board-column'))
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    // K-10 레인 — 할 일 칸만 카드(K-11·K-12), 개발 중·완료 칸은 빈 칸.
    expect(columnOf({ lane: P1, column: 'st:todo' })?.hasAttribute('data-column-thin')).toBe(false)
    expect(columnOf({ lane: P1, column: 'st:doing' })?.hasAttribute('data-column-thin')).toBe(true)
    expect(columnOf({ lane: P1, column: 'st:done' })?.classList.contains('is-thin')).toBe(true)
    expect(q(`[data-board-lane="${P1}"] [data-drop-zone="col:st:doing@${P1}"]`)).not.toBeNull()
    expect(q(`[data-board-lane="none"] [data-board-column="st:todo"]`)?.hasAttribute('data-column-thin')).toBe(false)
    // 레인 사이 칸 정렬 — 같은 칸 구성·순서, 같은 칸 클래스(너비 규칙 공유). 얇은 칸도 tasks-column.
    for (const lane of qa('[data-board-lane]').filter((element) => element.querySelector('[data-board-column]') !== null)) {
      expect([...lane.querySelectorAll('[data-board-column]')].map((element) => element.getAttribute('data-board-column'))).toEqual(plain)
      for (const column of lane.querySelectorAll('[data-board-column]')) expect(column.classList.contains('tasks-column')).toBe(true)
    }
  })

  it('끌기 중에도 얇은 그대로(보드가 밀리지 않음), 얇은 칸에 놓으면 기존과 같은 쓰기', async () => {
    await laned()
    await startDrag({ card: 'K-11', zone: `col:st:done@${P1}` })
    const target = columnOf({ lane: P1, column: 'st:done' })
    expect(q('.is-drag-source')).not.toBeNull()
    expect(target?.hasAttribute('data-column-thin')).toBe(true)
    expect(target?.classList.contains('is-over')).toBe(true)
    expect(target?.classList.contains('drag-target')).toBe(true)
    // 틈을 끼우지 않는다 — 얇은 칸은 높이가 그대로다.
    expect(target?.querySelector('[data-drop-gap]')).toBeNull()
    expect(columnOf({ lane: P1, column: 'st:doing' })?.hasAttribute('data-column-thin')).toBe(true)
    await release()
    expect(writes()).toEqual([expect.objectContaining({ op: 'changeStatus', itemId: 'a', statusKey: 'done' })])
  })

  it('카드 있는 칸에는 기존대로 틈이 생긴다', async () => {
    await laned()
    await startDrag({ card: 'K-30', zone: 'col:st:todo@none' })
    expect(columnOf({ lane: 'none', column: 'st:todo' })?.hasAttribute('data-column-thin')).toBe(false)
    expect(q('[data-board-lane="none"] [data-board-column="st:todo"] [data-drop-gap]')).not.toBeNull()
    await release()
  })
})

describe('C3 같은 레인 막힌 칸의 이유가 목록을 밀지 않음', () => {
  it('순서 금지(LIFE-612) — 끌기 시작·진행 중 원래 칸 목록 앞에 줄이 끼지 않는다, 문구는 포인터가 올라간 칸 안 오버레이 + title', async () => {
    settings = { ...settings, connections: settings.connections.map((connection) => ({ ...connection, capabilities: { ...CAPS, order: { state: 'disabled', reason: '순서 값을 쓰지 않는 출처' } } })) }
    await laned()
    const source = columnOf({ lane: P1, column: 'st:todo' })
    const before = shape(source)
    const firstBefore = source?.querySelector('[data-drop-zone] [data-issue-card]')?.getAttribute('data-issue-card')
    await startDrag({ card: 'K-11', zone: `col:st:todo@${P1}` })
    const reason = '순서를 바꿀 수 없습니다 — 순서 값을 쓰지 않는 출처'
    expect(source?.classList.contains('drag-blocked')).toBe(true)
    // 목록 위 줄(목록을 미는 형제)이 없다 — 칸 구성이 끌기 전과 같다.
    expect(shape(source)).toEqual(before)
    expect(source?.querySelector(':scope > [data-column-reason]')).toBeNull()
    // 첫 카드는 그대로 목록의 첫 카드.
    expect(source?.querySelector('[data-drop-zone] [data-issue-card]')?.getAttribute('data-issue-card')).toBe(firstBefore)
    // 문구는 사라지지 않는다 — 포인터가 있는 칸 안 오버레이(레이아웃 밖) + 칸 title.
    const overlay = source?.querySelector('[data-column-reason]')
    expect(overlay?.textContent).toBe(reason)
    expect(overlay?.getAttribute('data-column-reason')).toBe('overlay')
    expect(overlay?.classList.contains('is-overlay')).toBe(true)
    expect(source?.getAttribute('title')).toBe(reason)
    // 같은 레인 다른 칸으로 옮기면 원래 칸 문구는 title 로만 남고, 목록 앞 줄은 여전히 없다.
    hover(`col:st:doing@${P1}`)
    mouse(document, 'mousemove', 60, 520)
    await settle()
    expect(source?.querySelector('[data-column-reason]')).toBeNull()
    expect(source?.getAttribute('title')).toBe(reason)
    expect(shape(source)).toEqual(before)
    await release()
    expect(writes()).toEqual([expect.objectContaining({ op: 'changeStatus', itemId: 'a', statusKey: 'doing' })])
  })

  it('전이 막힘(허용 전이 받는 중) — 같은 레인 다른 칸들도 목록 위 줄 없이 흐림 + title, 포인터 칸만 오버레이', async () => {
    settings = { ...settings, connections: settings.connections.map((connection) => ({ ...connection, capabilities: { ...CAPS, transition: { mode: 'allowed' } } })) }
    hold = (request) => (request.call.op === 'listTransitions' ? new Promise(() => {}) : null)
    await laned()
    await startDrag({ card: 'K-30', zone: 'col:st:todo@none' })
    expect(qa('[data-column-reason]')).toHaveLength(0)
    const doing = columnOf({ lane: 'none', column: 'st:doing' })
    expect(doing?.classList.contains('drag-blocked')).toBe(true)
    expect(doing?.getAttribute('title')).toBe('허용 전이를 받는 중…')
    hover('col:st:doing@none')
    mouse(document, 'mousemove', 60, 520)
    await settle()
    expect(qa('[data-column-reason]').map((element) => [element.getAttribute('data-column-reason'), element.closest('[data-drop-zone]')?.getAttribute('data-drop-zone')])).toEqual([['overlay', 'col:st:doing@none']])
    await release()
    expect(writes()).toEqual([])
  })
})
