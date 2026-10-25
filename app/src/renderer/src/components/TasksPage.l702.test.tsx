// @vitest-environment happy-dom
// LIFE-702 — 오래된 완료(done + doneAt 14일 이상)를 보드·백로그에서 숨긴다. 검색어가 있으면 풀고, 리스트·작업 중·키 일치·상세·자식 진행도는 그대로.
// D3 보드·백로그 숨김 · D4 검색 중 해제 · D5 숨기지 않는 곳 · D6 빈 상태 원인. DOM 이벤트(click·input)로 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoRow, WorktreeRow } from '../../../shared/types.js'
import type { WorkCapabilities, WorkItem, WorkRequest, WorkResponse, WorkSettingsState, WorkStatus } from '../../../shared/work.js'
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
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
const item = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => ({ bodyLock: null, doneAt: null,
  spaceKey: 's1', title: `제목 ${over.key}`, body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'todo', category: 'todo', priority: 'medium', dueAt: null,
  parentId: null, placement: 'board', rank: null, resolution: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [], ...over,
})
const done = (over: Partial<WorkItem> & { id: string; key: string }): WorkItem => item({ statusKey: 'done', category: 'done', resolution: 'completed', ...over })
const GIT = { branch: 'x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
function worktree({ path, branch }: { path: string; branch: string }): WorktreeRow {
  const key = /(?<![A-Za-z0-9])K-\d+(?![0-9])/.exec(branch)?.[0]
  return {
    path, branch, head: null, repoName: 'repo', isLinked: true, openWorkspaceId: 'w1', workspace: null, gitStatus: GIT, displayName: null, comment: null, parentPath: null,
    workLink: key === undefined ? null : { mode: 'auto', sourceId: 'src-a', connectionId: 'c1', key, itemId: null, connected: true },
  }
}

let host: HTMLDivElement
let root: Root
let settings: WorkSettingsState
let items: WorkItem[]
let nextCursor: string | null

function respond(request: WorkRequest, result: Extract<WorkResponse, { ok: true }>['result']): WorkResponse {
  return { requestId: request.requestId, connectionId: request.connectionId, ok: true, result }
}
function answer(request: WorkRequest): WorkResponse {
  const { call } = request
  switch (call.op) {
    case 'listSpaces': return respond(request, { op: 'listSpaces', spaces: [], capabilities: CAPS })
    case 'listStatuses': return respond(request, { op: 'listStatuses', statuses: STATUSES, kinds: [{ key: 'task', label: 'Task', childKinds: [] }, { key: 'bug', label: 'Bug', childKinds: [] }] })
    case 'listItems': return respond(request, { op: 'listItems', items: call.cursor === null ? items : [], nextCursor: call.cursor === null ? nextCursor : null, truncated: false })
    case 'findByKey': return respond(request, { op: 'findByKey', item: items.find((entry) => entry.key.toUpperCase() === call.key.toUpperCase()) ?? null })
    case 'getItem': {
      const found = items.find((entry) => entry.id === call.itemId)
      return found === undefined
        ? { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'rejected', message: '없음', status: null } }
        : respond(request, { op: 'getItem', item: { ...found, body: '', relations: [] } })
    }
    default: return { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'unsupported', message: 'x', status: null } }
  }
}

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
  // K-1 열림 · K-2 오래된 완료(20일) · K-3 최근 완료(3일) · K-4 완료인데 doneAt null · K-5 백로그의 오래된 완료(30일)
  items = [
    item({ id: 'i1', key: 'K-1', rank: '1' }),
    done({ id: 'i2', key: 'K-2', rank: '2', doneAt: ago(20) }),
    done({ id: 'i3', key: 'K-3', rank: '3', doneAt: ago(3) }),
    done({ id: 'i4', key: 'K-4', rank: '4', doneAt: null }),
    done({ id: 'i5', key: 'K-5', rank: '5', doneAt: ago(30), placement: 'backlog' }),
  ]
  nextCursor = null
  let prefs: unknown = undefined
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: prefs }),
    setUiPrefs: (patch: { tasksPage?: unknown }) => { if ('tasksPage' in patch) prefs = patch.tasksPage },
    getWorkSettings: async () => settings,
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
  for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
async function renderPage(repos: RepoRow[] = []): Promise<void> {
  act(() => root.render(createElement(TasksPage, { open: true, repos, activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
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
const view = (name: 'board' | 'backlog' | 'list' | 'working'): void => click(q(`[data-tasks-view-tab="${name}"]`))
const cards = (): string[] => [...host.querySelectorAll('[data-issue-card]')].map((element) => element.getAttribute('data-issue-card') ?? '').sort()
const rowsIn = (selector: string): string[] => [...host.querySelectorAll(`${selector} [data-issue-row]`)].map((element) => element.getAttribute('data-issue-row') ?? '').sort()

describe('D3 보드·백로그에서 숨김', () => {
  it('보드 — 오래된 완료(K-2)만 빠지고 최근 완료·doneAt null 완료는 보인다 · 칸·밴드 건수는 보이는 것만', async () => {
    await renderPage()
    expect(q('[data-tasks-board]')).not.toBeNull()
    expect(cards()).toEqual(['K-1', 'K-3', 'K-4'])
    expect(q('[data-board-column="st:done"] .tasks-column-count')?.textContent).toBe('2')
    expect(q('[data-board-band="done"] .tasks-band-count')?.textContent).toBe('2')
  })

  it('백로그 — 보드 구역의 K-2 · 백로그 구역의 K-5 가 빠지고 건수도 보이는 것만', async () => {
    await renderPage()
    view('backlog')
    expect(q('[data-tasks-backlog]')).not.toBeNull()
    expect(rowsIn('[data-backlog-section="board"]')).toEqual(['K-1', 'K-3', 'K-4'])
    expect(rowsIn('[data-backlog-section="backlog"]')).toEqual([])
    expect(q('[data-backlog-section="board"] .tasks-column-count')?.textContent).toBe('3')
    expect(q('[data-backlog-section="backlog"] .tasks-column-count')?.textContent).toBe('0')
  })
})

describe('D4 검색 중 해제', () => {
  it('보드 — 검색어에 맞는 오래된 완료가 다시 보이고, 지우면 다시 숨는다', async () => {
    await renderPage()
    type('제목 K-2')
    await settle()
    expect(cards()).toEqual(['K-2'])
    type('제목')
    await settle()
    expect(cards()).toEqual(['K-1', 'K-2', 'K-3', 'K-4'])
    type('')
    await settle()
    expect(cards()).toEqual(['K-1', 'K-3', 'K-4'])
  })

  it('백로그 — 검색 중에는 K-5 가 백로그 구역에 보인다', async () => {
    await renderPage()
    view('backlog')
    type('제목')
    await settle()
    expect(rowsIn('[data-backlog-section="backlog"]')).toEqual(['K-5'])
    type('')
    await settle()
    expect(rowsIn('[data-backlog-section="backlog"]')).toEqual([])
  })

  it('필터만 켜면 숨김 유지 — 종류 필터는 검색이 아니다', async () => {
    items = [...items, done({ id: 'i6', key: 'K-6', rank: '6', doneAt: ago(40), kind: { key: 'bug', label: 'Bug', childKinds: [] } }), item({ id: 'i7', key: 'K-7', rank: '7', kind: { key: 'bug', label: 'Bug', childKinds: [] } })]
    await renderPage()
    click(q('[data-filter="kind"]'))
    click([...host.querySelectorAll('[data-tasks-menu="kind"] [role="menuitemcheckbox"]')].find((element) => element.textContent?.includes('Bug')) ?? null)
    await settle()
    expect(cards()).toEqual(['K-7'])
  })
})

describe('D5 숨기지 않는 곳', () => {
  it('리스트 보기 — 오래된 완료도 지금처럼 보인다', async () => {
    await renderPage()
    view('list')
    expect(q('[data-tasks-list]')).not.toBeNull()
    expect(rowsIn('[data-tasks-list]')).toEqual(['K-1', 'K-2', 'K-3', 'K-4', 'K-5'])
  })

  it('작업 중 보기 — 오래된 완료의 worktree 도 보인다', async () => {
    await renderPage([{ root: '/repo', name: 'repo', error: null, worktrees: [worktree({ path: '/repo/wt', branch: 'K-2-old' })] }])
    view('working')
    await settle()
    expect(q('[data-working-item="K-2"]')).not.toBeNull()
  })

  it('키 일치 영역 — 오래된 완료의 키로 찾으면 맨 앞에 보이고, 누르면 상세가 열린다', async () => {
    await renderPage()
    type('K-2')
    await settle()
    const hit = q('.tasks-key-hit-row[data-issue-row="K-2"]')
    expect(hit).not.toBeNull()
    click(hit)
    await settle()
    expect(q('[data-issue-detail]')).not.toBeNull()
  })

  it('자식 진행도 — 숨긴 자식도 센다(1/2)', async () => {
    items = [
      item({ id: 'p1', key: 'K-10', rank: '1', kind: { key: 'checkpoint', label: 'Checkpoint', childKinds: ['task'] } }),
      done({ id: 'c1', key: 'K-11', rank: '2', parentId: 'p1', doneAt: ago(20) }),
      item({ id: 'c2', key: 'K-12', rank: '3', parentId: 'p1' }),
    ]
    await renderPage()
    expect(cards()).toEqual(['K-10', 'K-12'])
    expect(q('[data-issue-card="K-10"] [data-issue-progress]')?.textContent).toContain('자식 1/2')
  })

  it('숨긴 건수 안내를 그리지 않는다', async () => {
    await renderPage()
    expect(host.textContent).not.toMatch(/숨김|숨긴/)
    view('backlog')
    expect(host.textContent).not.toMatch(/숨김|숨긴/)
  })
})

describe('D6 빈 상태 원인', () => {
  it('보드 — 보이는 것이 숨김 때문에만 0 이면 검색·필터 빈 상태 대신 보드를 그대로 그린다', async () => {
    items = [done({ id: 'i2', key: 'K-2', doneAt: ago(20) })]
    await renderPage()
    expect(q('[data-tasks-empty]')).toBeNull()
    expect(q('[data-clear-filters]')).toBeNull()
    expect(host.textContent).not.toContain('검색 결과 없음')
    expect(host.textContent).not.toContain('필터에 맞는 작업이 없습니다')
    expect(host.textContent).not.toContain('검색어 지우기')
    expect(q('[data-tasks-board]')).not.toBeNull()
    expect(cards()).toEqual([])
  })

  it('백로그 — 같은 경우 백로그 보기를 그대로 그린다', async () => {
    items = [done({ id: 'i2', key: 'K-2', doneAt: ago(20) }), done({ id: 'i5', key: 'K-5', doneAt: ago(30), placement: 'backlog' })]
    await renderPage()
    view('backlog')
    expect(q('[data-tasks-empty]')).toBeNull()
    expect(q('[data-tasks-backlog]')).not.toBeNull()
    expect(host.textContent).not.toContain('검색 결과 없음')
  })

  it('필터가 켜져 있고 보이는 것이 0 이면 필터 빈 상태(원인 = 필터)', async () => {
    items = [done({ id: 'i2', key: 'K-2', doneAt: ago(20) })]
    await renderPage()
    click(q('[data-filter="blocked"]'))
    expect(q('[data-tasks-empty="filter"]')).not.toBeNull()
  })

  it('다음 쪽이 있으면 「더 불러오기」 가 남는다(R2-M)', async () => {
    items = [done({ id: 'i2', key: 'K-2', doneAt: ago(20) })]
    nextCursor = 'next'
    await renderPage()
    expect(q('[data-tasks-empty]')).toBeNull()
    expect(q('[data-tasks-more-button]')).not.toBeNull()
  })

  it('대조 — 리스트 보기는 숨기지 않으니 같은 자료에서 행이 보인다', async () => {
    items = [done({ id: 'i2', key: 'K-2', doneAt: ago(20) })]
    await renderPage()
    view('list')
    expect(rowsIn('[data-tasks-list]')).toEqual(['K-2'])
  })
})
