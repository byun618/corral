// @vitest-environment happy-dom
// LIFE-745 작업 보드 부모·자식 관계 — 부모 칩(C1·C2) · 칩 클릭(C3) · 부모 보충(C4) · 묶기 레인(C5) · 레인 끌기(C6) · 리스트 그룹(C7) · 부모 필터(C8) · 설정 기억(C9).
// 가짜 preload(`window.corral`)로 그린다. 부모 K-10(체크포인트)은 백로그 배치라 보드에 카드가 없다 — 칩·레인 머리로만 보인다.
// 부모 ext-1(K-99)은 받은 행에 없다 — `getItem` 단건으로 보충된다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow, WorktreeRow } from '../../../shared/types.js'
import type { WorkCall, WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
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
const CHECKPOINT = { key: 'checkpoint', label: 'Checkpoint', childKinds: [] }
const item = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => ({ bodyLock: null, doneAt: null,
  spaceKey: 's1', title: `제목 ${over.key}`, body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'todo', category: 'todo', priority: 'medium', dueAt: null,
  parentId: null, placement: 'board', rank: null, resolution: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [], ...over,
})
const GIT = { branch: 'x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
function worktree({ path, branch }: { path: string; branch: string }): WorktreeRow {
  const key = /(?<![A-Za-z0-9])K-\d+(?![0-9])/.exec(branch)?.[0]
  return { path, branch, head: null, repoName: 'repo', isLinked: true, openWorkspaceId: 'w1', workspace: null, gitStatus: GIT, displayName: null, comment: null, parentPath: null,
    workLink: key === undefined ? null : { mode: 'auto', sourceId: 'src-a', connectionId: 'c1', key, itemId: null, connected: true } }
}

const EXT = item({ id: 'ext-1', key: 'K-99', title: '바깥 부모', kind: CHECKPOINT, rank: '0', statusKey: 'doing', category: 'in_progress', placement: 'backlog' })
const P1 = 'c1::p1'
const PEXT = 'c1::ext-1'
const WRITES = new Set(['changeStatus', 'setPlacement', 'setParent', 'reorder', 'updateItem', 'createItem'])

let host: HTMLDivElement
let root: Root
let settings: WorkSettingsState
let items: WorkItem[]
let calls: WorkCall[]
let getItemError: string | null
let hold: ((request: WorkRequest) => Promise<WorkResponse> | null) | null

function answer(request: WorkRequest): WorkResponse {
  const { requestId, connectionId, call } = request
  const ok = (result: Extract<WorkResponse, { ok: true }>['result']): WorkResponse => ({ requestId, connectionId, ok: true, result })
  const fail = (message: string): WorkResponse => ({ requestId, connectionId, ok: false, error: { kind: 'network', message, status: null } })
  switch (call.op) {
    case 'listSpaces': return ok({ op: 'listSpaces', spaces: [], capabilities: CAPS })
    case 'listStatuses': return ok({ op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task', childKinds: [] }, CHECKPOINT] })
    case 'listItems': return ok({ op: 'listItems', items, nextCursor: null, truncated: false })
    case 'findByKey': return ok({ op: 'findByKey', item: [...items, EXT].find((entry) => entry.key.toUpperCase() === call.key.toUpperCase()) ?? null })
    case 'getItem': {
      if (call.itemId === EXT.id && getItemError !== null) return fail(getItemError)
      const found = [...items, EXT].find((entry) => entry.id === call.itemId)
      return found === undefined ? fail('없음') : ok({ op: 'getItem', item: found })
    }
    case 'changeStatus': {
      const found = items.find((entry) => entry.id === call.itemId)
      if (found === undefined) return fail('없음')
      return ok({ op: 'changeStatus', item: { ...found, statusKey: call.statusKey, category: STATUSES.find((status) => status.key === call.statusKey)?.category ?? 'todo' } })
    }
    default: return { requestId, connectionId, ok: false, error: { kind: 'unsupported', message: 'x', status: null } }
  }
}

let prefs: unknown
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
    item({ id: 'p1', key: 'K-10', title: '공고 기능 개선', kind: CHECKPOINT, placement: 'backlog', rank: '1', parentId: 'ext-1' }),
    item({ id: 'a', key: 'K-11', title: '처리할 공고 화면', parentId: 'p1', rank: '2' }),
    item({ id: 'b', key: 'K-12', title: '수집 설정', parentId: 'p1', rank: '3', statusKey: 'doing', category: 'in_progress' }),
    item({ id: 'c', key: 'K-13', title: '정리', parentId: 'p1', rank: '4', statusKey: 'done', category: 'done' }),
    item({ id: 'd', key: 'K-20', title: '바깥 자식', parentId: 'ext-1', rank: '5' }),
    item({ id: 'e', key: 'K-30', title: '부모 없음 작업', rank: '6' }),
  ]
  calls = []
  getItemError = null
  hold = null
  prefs = undefined
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
  vi.restoreAllMocks()
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
async function renderPage({ open = true, repos = [] }: { open?: boolean; repos?: RepoRow[] } = {}): Promise<void> {
  act(() => root.render(createElement(TasksPage, { open, repos, activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
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
function typeSearch(value: string): void {
  const input = q('[data-tasks-search]')
  if (!(input instanceof HTMLInputElement)) throw new Error('검색 칸 없음')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const getItems = (itemId: string): WorkCall[] => calls.filter((call) => call.op === 'getItem' && call.itemId === itemId)
const writes = (): WorkCall[] => calls.filter((call) => WRITES.has(call.op))
const view = (name: string): void => click(q(`[data-tasks-view-tab="${name}"]`))

describe('C1 부모 칩 — 보드 카드', () => {
  it('자세히 — 종류 아이콘 + 키 + 제목, 부모가 백로그 배치(보드 밖)여도 칩이 보인다, 부모 없는 카드엔 칩 없음, title 에 조상 경로', async () => {
    await renderPage()
    expect(q('[data-issue-card="K-10"]')).toBeNull()
    const chip = q('[data-issue-card="K-11"] [data-parent-chip="K-10"]')
    expect(chip).not.toBeNull()
    expect(chip?.querySelector('.tasks-kind')).not.toBeNull()
    expect(chip?.querySelector('.tasks-parent-title')?.textContent).toBe('공고 기능 개선')
    // 경로 — 가장 가까운 조상부터, 보충한 K-99 까지.
    expect(chip?.getAttribute('title')).toBe('상위: K-10 공고 기능 개선 › K-99 바깥 부모')
    expect(q('[data-issue-card="K-30"] [data-parent-chip]')).toBeNull()
    // 칩은 제목 위 한 줄.
    const card = q('[data-issue-card="K-11"]')
    const children = [...(card?.children ?? [])]
    expect(children.findIndex((element) => element === chip)).toBeLessThan(children.findIndex((element) => element.classList.contains('tasks-card-title')))
  })

  it('간단히 — 종류 아이콘 + 키만, 제목은 title', async () => {
    await renderPage()
    click(q('[data-tasks-density]'))
    const chip = q('[data-issue-card="K-12"] [data-parent-chip="K-10"]')
    expect(q('[data-issue-card="K-12"]')?.classList.contains('is-compact')).toBe(true)
    expect(chip?.querySelector('.tasks-kind')).not.toBeNull()
    expect(chip?.querySelector('.tasks-parent-title')).toBeNull()
    expect(chip?.querySelector('.tasks-parent-key')?.textContent).toBe('K-10')
    expect(chip?.getAttribute('title')).toContain('K-10 공고 기능 개선')
  })
})

describe('C2 부모 칩 — 백로그 행 · 리스트 행 · 키 일치 · 작업 중 머리', () => {
  it('백로그 행 — 보드·백로그 섹션 모두, 같은 칩 컴포넌트', async () => {
    await renderPage()
    view('backlog')
    expect(q('[data-backlog-section="board"] [data-issue-row="K-11"] .tasks-parent-chip[data-parent-chip="K-10"]')).not.toBeNull()
    // 백로그 섹션의 K-10 자신도 부모(K-99, 보충)가 있다.
    expect(q('[data-backlog-section="backlog"] [data-issue-row="K-10"] [data-parent-chip="K-99"]')).not.toBeNull()
    expect(q('[data-issue-row="K-30"] [data-parent-chip]')).toBeNull()
  })

  it('리스트 행 — 제목 뒤 칩, 키 일치 결과 행도', async () => {
    await renderPage()
    view('list')
    const row = q('[data-issue-row="K-20"]')
    const chip = row?.querySelector('[data-parent-chip="K-99"]') ?? null
    expect(chip).not.toBeNull()
    const parts = [...(row?.children ?? [])]
    expect(parts.findIndex((element) => element === chip)).toBe(parts.findIndex((element) => element.classList.contains('tasks-row-title')) + 1)
    typeSearch('K-12')
    await settle()
    expect(q('.tasks-row.is-key-hit[data-issue-row="K-12"] [data-parent-chip="K-10"]')).not.toBeNull()
  })

  it('키 일치 — 보드 보기의 결과 줄에도(행 버튼 옆 형제)', async () => {
    await renderPage()
    typeSearch('K-11')
    await settle()
    const line = q('[data-search-hits] .tasks-key-hit-line')
    expect(line?.querySelector('[data-parent-chip="K-10"]')).not.toBeNull()
    expect(line?.querySelector('button [data-parent-chip]')).toBeNull()
  })

  it('작업 중 머리 — 찾은 작업의 부모 칩', async () => {
    await renderPage({ repos: [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-11-x' })] }] })
    view('working')
    await settle()
    expect(q('[data-working-item="K-11"] .tasks-working-head [data-parent-chip="K-10"]')).not.toBeNull()
  })
})

describe('C3 칩 클릭', () => {
  it('부모 상세를 오른쪽 패널에 연다 — 카드 선택은 바뀌지 않는다', async () => {
    await renderPage()
    click(q('[data-issue-card="K-11"] [data-parent-chip="K-10"]'))
    await settle()
    expect(q('[data-issue-detail="K-10"]')).not.toBeNull()
    expect(q('[data-issue-card="K-11"]')?.classList.contains('is-selected')).toBe(false)
    // 보충한 부모(보드에 없는 K-99)도 같은 경로로 연다.
    click(q('[data-issue-card="K-20"] [data-parent-chip="K-99"]'))
    await settle()
    expect(q('[data-issue-detail="K-99"]')).not.toBeNull()
  })

  it('칩 mousedown 은 카드 끌기를 시작하지 않는다', async () => {
    await renderPage()
    const target = q('[data-drop-zone="col:st:doing"]')
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
    mouse(q('[data-issue-card="K-11"] [data-parent-chip="K-10"]') ?? document, 'mousedown')
    mouse(document, 'mousemove', 50, 500)
    await settle()
    expect(q('.is-drag-source')).toBeNull()
    expect(q('[data-drop-gap]')).toBeNull()
    mouse(document, 'mouseup', 50, 500)
    await settle()
    expect(writes()).toEqual([])
  })
})

describe('C4 받은 행에 없는 부모 보충', () => {
  it('성공 — 받는 중 자리표시 → 받으면 칩, 부모 하나당 요청 하나(두 자식·조상 경로가 같은 부모)', async () => {
    const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => (request.call.op === 'getItem' ? new Promise((resolve) => { waits.push({ request, resolve }) }) : null)
    await renderPage()
    const loading = q('[data-issue-card="K-20"] [data-parent-chip]')
    expect(loading?.getAttribute('data-parent-state')).toBe('loading')
    expect(loading?.textContent).toBe('상위 작업…')
    // 진행 중에 화면이 다시 그려져도(밀도·보기 전환) 다시 보내지 않는다.
    click(q('[data-tasks-density]'))
    view('list')
    view('board')
    await settle()
    expect(getItems('ext-1')).toHaveLength(1)
    await act(async () => { for (const wait of waits) wait.resolve(answer(wait.request)) })
    await settle()
    expect(q('[data-issue-card="K-20"] [data-parent-chip="K-99"]')?.getAttribute('data-parent-state')).toBe('found')
    expect(getItems('ext-1')).toHaveLength(1)
    // 받은 행에 있는 부모(K-10)는 보내지 않는다.
    expect(getItems('p1')).toHaveLength(0)
  })

  it('실패 — 칩을 숨기지 않고 「부모를 불러오지 못함」 + title 에 오류', async () => {
    getItemError = '출처가 답하지 않습니다'
    await renderPage()
    const chip = q('[data-issue-card="K-20"] [data-parent-chip]')
    expect(chip?.getAttribute('data-parent-state')).toBe('error')
    expect(chip?.textContent).toBe('부모를 불러오지 못함')
    expect(chip?.getAttribute('title')).toBe('부모를 불러오지 못함 — 출처가 답하지 않습니다')
    expect(chip?.classList.contains('is-error')).toBe(true)
    expect(getItems('ext-1')).toHaveLength(1)
  })

  it('중복 억제 — 같은 화면 갱신마다 다시 보내지 않고, 스페이스 자료를 다시 읽으면 한 번 다시 받는다 · 쓰기 0', async () => {
    await renderPage()
    expect(getItems('ext-1')).toHaveLength(1)
    click(q('[data-tasks-density]'))
    view('backlog')
    view('list')
    view('board')
    await settle()
    expect(getItems('ext-1')).toHaveLength(1)
    // 닫았다 다시 열면 조용히 새로 받는다(R1-N) — 자료를 다시 읽었으니 보충도 다시.
    const lists = calls.filter((call) => call.op === 'listItems').length
    await renderPage({ open: false })
    await renderPage({ open: true })
    expect(calls.filter((call) => call.op === 'listItems').length).toBeGreaterThan(lists)
    expect(getItems('ext-1')).toHaveLength(2)
    expect(writes()).toEqual([])
  })
})

describe('C5 보드 묶기 — 부모', () => {
  it('부모마다 가로 레인(순서 값 순) · 부모 없음 레인 맨 끝 · 레인 머리 = 칩·상태·진행 n/m · 레인 안 카드는 칩 없음 · 칸 구성은 묶기 없음과 같다', async () => {
    await renderPage()
    const plain = qa('[data-board-column]').map((element) => element.getAttribute('data-board-column'))
    expect(q('[data-tasks-swimlane]')?.getAttribute('data-tasks-swimlane')).toBe('none')
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    expect(q('[data-tasks-swimlane]')?.getAttribute('data-tasks-swimlane')).toBe('parent')
    // K-99 순서 값 0 < K-10 순서 값 1 — 보충한 부모도 같은 규칙.
    expect(qa('[data-board-lane]').map((element) => element.getAttribute('data-board-lane'))).toEqual([PEXT, P1, 'none'])
    const head = q(`[data-board-lane="${P1}"] [data-lane-head]`)
    expect(head?.querySelector('[data-parent-chip="K-10"] .tasks-kind')).not.toBeNull()
    expect(head?.querySelector('[data-lane-status]')?.textContent).toBe('할 일')
    expect(head?.querySelector('[data-lane-progress]')?.getAttribute('data-lane-progress')).toBe('1/3')
    expect(head?.querySelector('.tasks-progress-bar')).not.toBeNull()
    expect(q(`[data-board-lane="${PEXT}"] [data-lane-head] [data-lane-status]`)?.textContent).toBe('개발 중')
    // K-99 의 받은 자식 = K-10(백로그) + K-20 — 보드 밖 자식도 센다(childProgress 규칙).
    expect(q(`[data-board-lane="${PEXT}"] [data-lane-head] [data-lane-progress]`)?.getAttribute('data-lane-progress')).toBe('0/2')
    expect(q('[data-board-lane="none"] [data-lane-head]')?.textContent).toContain('부모 없음')
    // 레인마다 묶기 없음과 같은 칸.
    for (const lane of qa('[data-board-lane]')) expect([...lane.querySelectorAll('[data-board-column]')].map((element) => element.getAttribute('data-board-column'))).toEqual(plain)
    expect([...(q(`[data-board-lane="${P1}"]`)?.querySelectorAll('[data-issue-card]') ?? [])].map((element) => element.getAttribute('data-issue-card'))).toEqual(['K-11', 'K-12', 'K-13'])
    expect(q(`[data-board-lane="${P1}"] [data-board-column="st:doing"] [data-issue-card="K-12"]`)).not.toBeNull()
    expect(q('[data-board-lane="none"] [data-issue-card="K-30"]')).not.toBeNull()
    expect(q('[data-board-lane] [data-issue-card] [data-parent-chip]')).toBeNull()
    expect(qa('[data-board-lane] [data-parent-chip]')).toHaveLength(2)
    // 부모(K-10)는 보드 밖이어도 레인이 생기고, 카드로는 없다.
    expect(q('[data-issue-card="K-10"]')).toBeNull()
  })

  it('접기 — 레인 머리는 남고 칸이 사라진다, 다시 펼친다', async () => {
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    click(q(`[data-board-lane="${P1}"] [data-lane-toggle]`))
    expect(q(`[data-board-lane="${P1}"] [data-lane-head]`)).not.toBeNull()
    expect(q(`[data-board-lane="${P1}"] [data-issue-card]`)).toBeNull()
    expect(q(`[data-board-lane="${P1}"] [data-lane-toggle]`)?.getAttribute('aria-expanded')).toBe('false')
    click(q(`[data-board-lane="${P1}"] [data-lane-toggle]`))
    expect(q(`[data-board-lane="${P1}"] [data-issue-card="K-11"]`)).not.toBeNull()
  })

  it('레인 머리 칩 클릭 = 부모 상세', async () => {
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    click(q(`[data-board-lane="${P1}"] [data-lane-head] [data-parent-chip]`))
    await settle()
    expect(q('[data-issue-detail="K-10"]')).not.toBeNull()
  })
})

describe('C6 묶기 상태의 끌기', () => {
  async function dragTo({ handle, zone }: { handle: Element | null; zone: string }): Promise<string | null> {
    const target = q(`[data-drop-zone="${zone}"]`)
    if (handle === null || target === null) throw new Error(`끌기 대상 없음 ${zone}`)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
    mouse(handle, 'mousedown')
    mouse(document, 'mousemove', 50, 500)
    await settle()
    const reason = target.closest('[data-board-column]')?.querySelector('[data-column-reason]')?.textContent ?? null
    mouse(document, 'mouseup', 50, 500)
    await settle()
    return reason
  }

  it('레인 안 상태 칸 이동 = 묶기 없음과 같은 쓰기(changeStatus)', async () => {
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    const reason = await dragTo({ handle: q('[data-issue-card="K-11"]'), zone: `col:st:doing@${P1}` })
    expect(reason).toBeNull()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ op: 'changeStatus', itemId: 'a', statusKey: 'doing' })
  })

  it('레인 사이 놓기는 막는다 — 놓일 칸에 이유, 쓰기 0', async () => {
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    const reason = await dragTo({ handle: q('[data-issue-card="K-11"]'), zone: 'col:st:doing@none' })
    expect(reason).toBe('부모 바꾸기는 상세에서 — 다른 부모 줄로는 옮길 수 없습니다')
    const same = await dragTo({ handle: q('[data-issue-card="K-30"]'), zone: `col:st:todo@${PEXT}` })
    expect(same).toBe('부모 바꾸기는 상세에서 — 다른 부모 줄로는 옮길 수 없습니다')
    expect(writes()).toEqual([])
    // 카드는 제자리.
    expect(q(`[data-board-lane="${P1}"] [data-board-column="st:todo"] [data-issue-card="K-11"]`)).not.toBeNull()
  })
})

describe('C7 리스트 그룹 「부모」', () => {
  it('그룹 머리 = 부모 칩 + 자식 진행 n/m, 「부모 없음」 그룹 끝', async () => {
    await renderPage()
    view('list')
    choose('[data-tasks-group]', 'parent')
    await settle()
    expect(qa('[data-list-group]').map((element) => element.getAttribute('data-list-group'))).toEqual([`parent:${PEXT}`, `parent:${P1}`, 'parent:none'])
    const head = q(`[data-list-group="parent:${P1}"]`)
    expect(head?.querySelector('[data-parent-chip="K-10"]')).not.toBeNull()
    expect(head?.querySelector('[data-lane-progress]')?.getAttribute('data-lane-progress')).toBe('1/3')
    expect(q('[data-list-group="parent:none"]')?.textContent).toContain('부모 없음')
    expect(q('[data-tasks-group] option[value="parent"]')?.textContent).toBe('부모')
  })
})

describe('C8 필터 「부모」', () => {
  it('메뉴에서 부모를 고르면 그 부모의 직계 자식만 — 네 보기 공통, 「필터 지우기」 가 함께 지운다', async () => {
    await renderPage({ repos: [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/a', branch: 'K-11-a' }), worktree({ path: '/repo/b', branch: 'K-30-b' })] }] })
    click(q('[data-filter="parent"]'))
    const options = qa('[data-tasks-menu="parent"] .tasks-menu-row').map((element) => element.textContent)
    // 받은 행 중 자식이 있는 작업(K-10) + 보충한 부모(K-99), 순서 값 순.
    expect(options).toEqual(['K-99 바깥 부모', 'K-10 공고 기능 개선'])
    click(qa('[data-tasks-menu="parent"] .tasks-menu-row')[1] ?? null)
    expect(q('[data-filter="parent"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(qa('[data-issue-card]').map((element) => element.getAttribute('data-issue-card')).sort()).toEqual(['K-11', 'K-12', 'K-13'])
    view('backlog')
    expect(qa('[data-issue-row]').map((element) => element.getAttribute('data-issue-row')).sort()).toEqual(['K-11', 'K-12', 'K-13'])
    view('list')
    expect(qa('[data-issue-row]').map((element) => element.getAttribute('data-issue-row')).sort()).toEqual(['K-11', 'K-12', 'K-13'])
    view('working')
    await settle()
    expect(qa('[data-working-item]').map((element) => element.getAttribute('data-working-item'))).toEqual(['K-11'])
    click(q('[data-clear-filters]'))
    expect(q('[data-filter="parent"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(qa('[data-working-item]').map((element) => element.getAttribute('data-working-item')).sort()).toEqual(['K-11', 'K-30'])
  })
})

describe('C9 설정 기억', () => {
  it('보드 묶기·리스트 그룹이 다시 띄운 뒤(새 마운트)에도 남는다', async () => {
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    view('list')
    choose('[data-tasks-group]', 'parent')
    view('board')
    await settle()
    expect(prefs).toMatchObject({ swimlane: 'parent', group: 'parent', view: 'board' })
    act(() => root.unmount())
    root = createRoot(host)
    await renderPage()
    expect(q('[data-tasks-swimlane]')?.getAttribute('data-tasks-swimlane')).toBe('parent')
    expect(q('[data-board-lane]')).not.toBeNull()
    view('list')
    expect(q(`[data-list-group="parent:${P1}"]`)).not.toBeNull()
  })

  it('옛 설정(묶기 칸 없음) — 묶기 없음으로 읽히고 다른 칸은 그대로', async () => {
    prefs = { view: 'board', density: 'compact', group: 'priority', filters: { kinds: [], priorities: [], blocked: false, working: false, dueWeek: false } }
    await renderPage()
    expect(q('[data-tasks-swimlane]')?.getAttribute('data-tasks-swimlane')).toBe('none')
    expect(q('[data-board-lane]')).toBeNull()
    expect(q('[data-tasks-density]')?.getAttribute('data-tasks-density')).toBe('compact')
    view('list')
    const group = q('[data-tasks-group]')
    expect(group instanceof HTMLSelectElement ? group.value : null).toBe('priority')
  })
})

// --- 수정 라운드 1 (리뷰 r1 R1-1~R1-5) ---

/** 끌기 시작만 — 포인터 아래 영역은 `elementFromPoint` 로 정한다. 끝은 `release`. */
function hover(zone: string): void {
  const target = q(`[data-drop-zone="${zone}"]`)
  if (target === null) throw new Error(`영역 없음 ${zone}`)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
}
async function release(): Promise<void> {
  mouse(document, 'mouseup', 60, 520)
  await settle()
}
const reasons = (): string[] => qa('[data-column-reason]').map((element) => element.closest('[data-drop-zone]') === null ? (element.parentElement?.querySelector('[data-drop-zone]')?.getAttribute('data-drop-zone') ?? '') : '')

describe('R1-1 묶기=부모 끌기 중 이유 문구는 포인터가 올라간 칸에만', () => {
  it('끌기 시작 = 문구 0(자기 레인 칸 위) · 막힌 칸 위 = 그 칸 1개 · 나머지 막힌 칸은 title 만', async () => {
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    hover(`col:st:todo@${P1}`)
    mouse(q('[data-issue-card="K-11"]') ?? document, 'mousedown')
    mouse(document, 'mousemove', 50, 500)
    await settle()
    expect(q('.is-drag-source')).not.toBeNull()
    expect(qa('[data-column-reason]')).toHaveLength(0)
    // 막힌 칸(다른 레인)은 흐림 + title.
    expect(q(`[data-board-lane="none"] [data-board-column="st:doing"]`)?.classList.contains('drag-blocked')).toBe(true)
    expect(q(`[data-board-lane="none"] [data-board-column="st:doing"]`)?.getAttribute('title')).toBe('부모 바꾸기는 상세에서 — 다른 부모 줄로는 옮길 수 없습니다')
    hover('col:st:doing@none')
    mouse(document, 'mousemove', 60, 520)
    await settle()
    expect(reasons()).toEqual(['col:st:doing@none'])
    await release()
    expect(writes()).toEqual([])
  })

  it('묶기 없음의 전이 막힘 이유는 그대로 칸마다 그린다(기존 동작)', async () => {
    settings = { ...settings, connections: settings.connections.map((connection) => ({ ...connection, capabilities: { ...CAPS, transition: { mode: 'allowed' } } })) }
    hold = (request) => (request.call.op === 'listTransitions' ? new Promise(() => {}) : null)
    await renderPage()
    hover('col:st:todo')
    mouse(q('[data-issue-card="K-11"]') ?? document, 'mousedown')
    mouse(document, 'mousemove', 50, 500)
    await settle()
    // 허용 전이를 받는 중 — 다른 상태 칸 둘(doing·done)에 포인터와 무관하게 이유가 뜬다.
    expect(qa('[data-column-reason]').map((element) => element.textContent)).toEqual(['허용 전이를 받는 중…', '허용 전이를 받는 중…'])
    await release()
  })
})

describe('R1-2 재읽기 때 받아 둔 부모를 버리지 않는다', () => {
  it('RV1 — 재읽기 응답을 기다리는 동안에도 칩·레인 머리는 받은 값 그대로, 새 답이 오면 덮는다', async () => {
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    expect(getItems('ext-1')).toHaveLength(1)
    const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => (request.call.op === 'getItem' ? new Promise((resolve) => { waits.push({ request, resolve }) }) : null)
    await renderPage({ open: false })
    await renderPage({ open: true })
    expect(getItems('ext-1')).toHaveLength(2)
    expect(q('[data-issue-card="K-20"]')).not.toBeNull()
    expect(q(`[data-board-lane="${PEXT}"] [data-lane-head] [data-parent-chip="K-99"]`)?.getAttribute('data-parent-state')).toBe('found')
    expect(qa('[data-board-lane]').map((element) => element.getAttribute('data-board-lane'))).toEqual([PEXT, P1, 'none'])
    await act(async () => { for (const wait of waits) wait.resolve({ requestId: wait.request.requestId, connectionId: wait.request.connectionId, ok: true, result: { op: 'getItem', item: { ...EXT, title: '바깥 부모 새 이름' } } }) })
    await settle()
    expect(q(`[data-board-lane="${PEXT}"] [data-lane-head] .tasks-parent-title`)?.textContent).toBe('바깥 부모 새 이름')
  })

  it('RV2 — 재요청이 실패해도 옛 「받음」 을 유지한다(옛 값이 없을 때만 실패 칩)', async () => {
    await renderPage()
    getItemError = '재요청 실패'
    await renderPage({ open: false })
    await renderPage({ open: true })
    expect(getItems('ext-1')).toHaveLength(2)
    const chip = q('[data-issue-card="K-20"] [data-parent-chip]')
    expect(chip?.getAttribute('data-parent-state')).toBe('found')
    expect(chip?.getAttribute('data-parent-chip')).toBe('K-99')
  })
})

describe('R1-3 늦은 응답 · 「+ 추가」 · aria-label · 레인 안 순서', () => {
  it('늦은 응답 — 재읽기(epoch 전환) 뒤 옛 요청 응답이 오면 그 답을 쓰고, 같은 부모에 두 번째 요청을 내지 않는다', async () => {
    const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => (request.call.op === 'getItem' ? new Promise((resolve) => { waits.push({ request, resolve }) }) : null)
    await renderPage()
    expect(getItems('ext-1')).toHaveLength(1)
    await renderPage({ open: false })
    await renderPage({ open: true })
    expect(getItems('ext-1')).toHaveLength(1)
    expect(q('[data-issue-card="K-20"] [data-parent-chip]')?.getAttribute('data-parent-state')).toBe('loading')
    await act(async () => { for (const wait of waits) wait.resolve(answer(wait.request)) })
    await settle()
    expect(q('[data-issue-card="K-20"] [data-parent-chip="K-99"]')?.getAttribute('data-parent-state')).toBe('found')
    expect(getItems('ext-1')).toHaveLength(1)
  })

  it('묶기=부모 에서는 칸 끝 「+ 추가」 가 없다(묶기 없음에는 있다)', async () => {
    await renderPage()
    expect(q('[data-inline-add-open]')).not.toBeNull()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    expect(q('[data-board-lane]')).not.toBeNull()
    expect(q('[data-inline-add-open]')).toBeNull()
    // 머리 「만들기」 는 남는다.
    expect(q('[data-tasks-create]')).not.toBeNull()
  })

  it('칩 aria-label — 「부모 열기 — 키 제목」, 받는 중·실패는 그 문구', async () => {
    getItemError = '끊김'
    await renderPage()
    expect(q('[data-issue-card="K-11"] [data-parent-chip="K-10"]')?.getAttribute('aria-label')).toBe('부모 열기 — K-10 공고 기능 개선')
    expect(q('[data-issue-card="K-20"] [data-parent-chip]')?.getAttribute('aria-label')).toBe('부모 열기 — 부모를 불러오지 못함')
  })

  it('레인 안 순서 바꾸기 = 묶기 없음과 같은 reorder 쓰기', async () => {
    items = items.map((entry) => (entry.id === 'b' ? { ...entry, statusKey: 'todo', category: 'todo' } : entry))
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    expect([...(q(`[data-board-lane="${P1}"] [data-board-column="st:todo"]`)?.querySelectorAll('[data-issue-card]') ?? [])].map((element) => element.getAttribute('data-issue-card'))).toEqual(['K-11', 'K-12'])
    hover(`col:st:todo@${P1}`)
    mouse(q('[data-issue-card="K-11"]') ?? document, 'mousedown')
    mouse(document, 'mousemove', 50, 500)
    await settle()
    await release()
    expect(writes()).toEqual([{ op: 'reorder', itemId: 'a', afterId: 'b' }])
  })
})

describe('R1-4 레인 접근 이름', () => {
  it('레인 구획·접기 버튼 이름에 부모 키·제목', async () => {
    await renderPage()
    choose('[data-tasks-swimlane]', 'parent')
    await settle()
    expect(q(`[data-board-lane="${P1}"]`)?.getAttribute('aria-label')).toBe('K-10 공고 기능 개선 레인')
    expect(q(`[data-board-lane="${P1}"] [data-lane-toggle]`)?.getAttribute('aria-label')).toBe('K-10 공고 기능 개선 레인 접기')
    expect(q('[data-board-lane="none"]')?.getAttribute('aria-label')).toBe('부모 없음 레인')
    click(q(`[data-board-lane="${P1}"] [data-lane-toggle]`))
    expect(q(`[data-board-lane="${P1}"] [data-lane-toggle]`)?.getAttribute('aria-label')).toBe('K-10 공고 기능 개선 레인 펼치기')
  })
})

describe('R1-5 보충 동시 요청 상한', () => {
  it(`받은 행 밖 부모 6개 — 한 번에 PARENT_REQUESTS_MAX(4)개까지, 앞 요청이 끝나면 나머지가 나간다`, async () => {
    items = Array.from({ length: 6 }, (_, index) => item({ id: `k${index}`, key: `K-${50 + index}`, parentId: `far-${index}` }))
    const waits: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    hold = (request) => (request.call.op === 'getItem' ? new Promise((resolve) => { waits.push({ request, resolve }) }) : null)
    const far = (request: WorkRequest): WorkResponse => {
      const id = request.call.op === 'getItem' ? request.call.itemId : ''
      return { requestId: request.requestId, connectionId: request.connectionId, ok: true, result: { op: 'getItem', item: item({ id, key: `K-${id}`, kind: CHECKPOINT }) } }
    }
    await renderPage()
    expect(calls.filter((call) => call.op === 'getItem')).toHaveLength(4)
    expect(qa('[data-parent-state="loading"]')).toHaveLength(6)
    await act(async () => { for (const wait of waits.splice(0, 2)) wait.resolve(far(wait.request)) })
    await settle()
    expect(calls.filter((call) => call.op === 'getItem')).toHaveLength(6)
    expect(qa('[data-parent-state="found"]')).toHaveLength(2)
    await act(async () => { for (const wait of waits.splice(0)) wait.resolve(far(wait.request)) })
    await settle()
    expect(qa('[data-parent-state="found"]')).toHaveLength(6)
    expect(new Set(calls.flatMap((call) => (call.op === 'getItem' ? [call.itemId] : []))).size).toBe(6)
  })
})
