// @vitest-environment happy-dom
// LIFE-603 C11 — 사이드바 작업 줄(자세히·간단히) · 키만(연결 없음·못 찾음) · 누르면 작업 열기 · 우클릭 「작업 떼기」 ·
// 제목 조회가 카드 렌더마다 요청을 내지 않음(요청 수). 하네스는 `Sidebar.tasks.test.tsx` 와 같은 결 — 실제 Sidebar 를 DOM 이벤트로.
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SIDEBAR_VIEW, type SidebarCardLayout } from '../../../shared/sidebar-view.js'
import type { RepoRow, WorktreeRow } from '../../../shared/types.js'
import type { WorkItem, WorkRequest, WorkResponse } from '../../../shared/work.js'
import { testRepo, testWorktree } from '../../../shared/test-rows.js'
import { useLinkTitles, linkTitleId, type LinkTitle } from '../hooks/useLinkTitles.js'
import { useManualOrder } from '../hooks/useManualOrder.js'
import type { UnreadView } from '../hooks/useUnread.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { Sidebar } from './Sidebar.js'
import type { WorktreeTaskLine } from './WorktreeTask.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const noop = (): void => {}
const link = (key: string, connected = true): WorktreeRow['workLink'] => ({ mode: 'auto', sourceId: 'mock-jira', connectionId: 'c1', key, itemId: null, connected })
const ROWS: WorktreeRow[] = [
  testWorktree({ path: '/r/a', branch: 'CORE-2-card', workLink: link('CORE-2') }),
  testWorktree({ path: '/r/b', branch: 'CORE-9-gone', workLink: link('CORE-9') }),
  testWorktree({ path: '/r/c', branch: 'main', workLink: null }),
]
const ITEM: WorkItem = { bodyLock: null, doneAt: null, 
  id: 'm-2', key: 'CORE-2', spaceKey: 'CORE', title: '카드 저장', body: null, kind: { key: 'story', label: 'Story', childKinds: [] }, statusKey: 'core-todo', category: 'todo', priority: 'medium', dueAt: null,
  parentId: null, placement: 'board', rank: null, resolution: null, openBlockerCount: 1, openBlockers: [{ id: 'm-1', key: 'CORE-1', title: '결제 개편' }], updatedAt: '', version: null, relations: null, workLinks: [],
}

let root: Root
let container: HTMLElement
let requests: WorkRequest[]
let detached: string[]
let focused: { key: string; itemId: string | null }[]

function answer(request: WorkRequest): WorkResponse {
  const item = request.call.op === 'findByKey' && request.call.key === 'CORE-2' ? ITEM : null
  return { requestId: request.requestId, connectionId: request.connectionId, ok: true, result: { op: 'findByKey', item } }
}

function Harness({ repos, layout, refresh }: { repos: RepoRow[]; layout: SidebarCardLayout; refresh: number }): React.JSX.Element {
  const manual = useManualOrder({ repos, registry: { roots: ['/r'], generation: 1 } })
  useEffect(() => manual.hydrate({ manualRepoOrder: ['/r'], manualWorktreeOrder: { '/r': ['/r/a', '/r/b', '/r/c'] }, manualFlatOrder: ['/r/a', '/r/b', '/r/c'] }), [])
  const titles = useLinkTitles({ repos, refresh })
  const actions: LifecycleActions = {
    createRow: noop, reopenTab: noop, launchAgent: noop, closeTabs: noop, renameRow: noop, clearRowName: noop, closeWorktree: noop,
    openWorktree: noop, openCreateWorktree: noop, activateWorkspace: noop,
  }
  const unread: UnreadView = { worktrees: new Set(), panes: new Set(), markRead: noop, markUnread: noop, toggle: noop }
  // App 의 taskLineOf 와 같은 모양 — 캐시만 읽는다.
  const taskLineOf = (worktree: WorktreeRow): WorktreeTaskLine | null => {
    const current = worktree.workLink ?? null
    if (current === null) return null
    const found: LinkTitle | undefined = current.connected ? titles.get(linkTitleId(current)) : undefined
    const item = found?.state === 'found' ? found.item : null
    return {
      key: current.key, title: item?.title ?? null, kindLabel: item?.kind.label ?? null, statusLabel: null,
      blocked: (item?.openBlockerCount ?? 0) > 0, blockers: item?.openBlockers.map((blocker) => blocker.key) ?? [],
      onOpen: () => { focused.push({ key: current.key, itemId: item?.id ?? null }) },
    }
  }
  return (
    <Sidebar
      sidebarRef={{ current: null }}
      width={280}
      state={{ repos, integrations: [], home: '/tmp', retainedAgents: [], orchestrationLineage: { state: 'ready', entries: [] } }}
      activeWorkspaceId={null}
      selectedPane={null}
      selectPane={noop}
      closePane={noop}
      actions={actions}
      manualOrder={manual.order}
      onReorder={noop}
      view={{ ...DEFAULT_SIDEBAR_VIEW, sortBy: 'manual', groupBy: 'repo', cardLayout: layout }}
      onChangeView={noop}
      onOpenSearch={noop}
      searchShortcut={null}
      isRepoCollapsed={() => false}
      toggleRepoCollapsed={noop}
      isGroupExpanded={() => false}
      toggleGroupExpanded={noop}
      onAddRepo={noop}
      onRemoveRepo={noop}
      onRefresh={noop}
      groupGlyphOf={() => null}
      onOpenShortcuts={noop}
      onOpenSettings={noop}
      lineageCollapse={{ values: new Set(), loaded: true, toggle: noop, remove: noop }}
      cards={{
        pinned: new Set(), deleting: new Set(), altHeld: false, unread, togglePin: noop, setMeta: async () => null,
        openDetails: noop, requestDelete: noop, notify: noop, onHoverCard: noop, revealRequest: null, deleteShortcut: null,
      }}
      taskLineOf={taskLineOf}
    />
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  requests = []
  detached = []
  focused = []
  Reflect.set(window, 'corral', {
    workRequest: async (request: WorkRequest) => { requests.push(request); return answer(request) },
    detachWorkLink: async ({ path }: { path: string }) => { detached.push(path); return { ok: true, mode: 'auto', sourceLink: null } },
    activateWindow: noop,
  })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
async function render({ repos = [testRepo({ root: '/r', worktrees: ROWS })], layout = 'detailed', refresh = 0 }: { repos?: RepoRow[]; layout?: SidebarCardLayout; refresh?: number } = {}): Promise<void> {
  await act(async () => root.render(<Harness repos={repos} layout={layout} refresh={refresh} />))
  await settle()
}
const lineOf = (path: string): Element | null => container.querySelector(`[data-worktree="${path}"] [data-worktree-issue]`)

describe('C11 작업 줄', () => {
  it('자세히 — 종류 · 키 · 제목, 막힘 점 · 못 찾은 작업은 키만 · 링크 없는 카드는 줄 없음', async () => {
    await render()
    const found = lineOf('/r/a')
    expect(found?.getAttribute('data-worktree-issue')).toBe('CORE-2')
    expect(found?.textContent).toBe('StoryCORE-2카드 저장')
    expect(found?.querySelector('[data-worktree-issue-blocked]')).not.toBeNull()
    expect(lineOf('/r/b')?.textContent).toBe('CORE-9')
    expect(lineOf('/r/c')).toBeNull()
  })
  it('간단히 — 제목 줄 끝 키 칩(막힘 빨간 점)', async () => {
    await render({ layout: 'compact' })
    const chip = container.querySelector('[data-worktree="/r/a"] .worktree-task-chip')
    expect(chip?.textContent).toBe('CORE-2')
    expect(chip?.querySelector('[data-worktree-issue-blocked]')).not.toBeNull()
  })
  it('누르면 그 작업을 연다(카드 클릭으로 새지 않음)', async () => {
    await render()
    await act(async () => { lineOf('/r/a')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(focused).toEqual([{ key: 'CORE-2', itemId: 'm-2' }])
  })
  it('연결이 해제된 링크는 키만 · 요청 0', async () => {
    await render({ repos: [testRepo({ root: '/r', worktrees: [testWorktree({ path: '/r/a', branch: 'CORE-2-card', workLink: link('CORE-2', false) })] })] })
    expect(lineOf('/r/a')?.textContent).toBe('CORE-2')
    expect(requests).toHaveLength(0)
  })
  it('제목 조회 = 키당 1회 — 다시 그려도(트리 push 10회) 늘지 않고, refresh 가 바뀌면 다시 1회', async () => {
    await render()
    expect(requests.map((request) => request.call.op === 'findByKey' ? request.call.key : '').sort()).toEqual(['CORE-2', 'CORE-9'])
    for (let index = 0; index < 10; index += 1) await render({ repos: [testRepo({ root: '/r', worktrees: ROWS.map((row) => ({ ...row })) })] })
    expect(requests).toHaveLength(2)
    await render({ refresh: 1 })
    expect(requests).toHaveLength(4)
  })
})

describe('C9·C11 우클릭 「작업 떼기」', () => {
  it('링크된 카드에만 있고 누르면 detachWorkLink(path)', async () => {
    await render()
    const open = async (path: string): Promise<string[]> => {
      const surface = container.querySelector(`[data-worktree="${path}"] [data-worktree-card-surface]`)
      await act(async () => { surface?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
      return [...document.querySelectorAll('[data-menu-action]')].map((entry) => entry.getAttribute('data-menu-action') ?? '')
    }
    expect(await open('/r/c')).not.toContain('detach-task')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(await open('/r/a')).toContain('detach-task')
    const item = document.querySelector('[data-menu-action="detach-task"]')
    await act(async () => { item?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(detached).toEqual(['/r/a'])
  })
})
