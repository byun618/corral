// @vitest-environment happy-dom
// LIFE-601 수정 r1 R1-H — 작업 페이지가 열린 동안 사이드바 worktree 카드를 누르면 페이지가 닫히고 그 worktree 로 간다(핸드오프 §1 Q1).
// 실제 Sidebar 를 띄워 카드 표면을 클릭한다(DOM 이벤트 경로). 하네스는 `Sidebar.lineage.test.tsx` 와 같은 결.
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SIDEBAR_VIEW } from '../../../shared/sidebar-view.js'
import type { WorktreeRow } from '../../../shared/types.js'
import { useManualOrder } from '../hooks/useManualOrder.js'
import type { UnreadView } from '../hooks/useUnread.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { Sidebar } from './Sidebar.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const noop = (): void => {}
const GIT = { branch: 'x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
const ROWS: WorktreeRow[] = [
  { path: '/r/a', parentPath: null, branch: 'a', isLinked: true, head: null, repoName: 'r', openWorkspaceId: null, workspace: null, gitStatus: GIT, displayName: null, comment: null },
]

let root: Root
let container: HTMLElement
let opened: string[]
let toggles: number

function Harness({ tasksOpen }: { tasksOpen: boolean }): React.JSX.Element {
  const repos = [{ root: '/r', name: 'r', error: null, worktrees: ROWS }]
  const manual = useManualOrder({ repos, registry: { roots: ['/r'], generation: 1 } })
  useEffect(() => manual.hydrate({ manualRepoOrder: ['/r'], manualWorktreeOrder: { '/r': ['/r/a'] }, manualFlatOrder: ['/r/a'] }), [])
  const actions: LifecycleActions = {
    createRow: noop, reopenTab: noop, launchAgent: noop, closeTabs: noop, renameRow: noop, clearRowName: noop, closeWorktree: noop,
    openWorktree: (_repoRoot, worktree) => { opened.push(worktree.path) }, openCreateWorktree: noop, activateWorkspace: noop,
  }
  const unread: UnreadView = { worktrees: new Set(), panes: new Set(), markRead: noop, markUnread: noop, toggle: noop }
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
      view={{ ...DEFAULT_SIDEBAR_VIEW, sortBy: 'manual', groupBy: 'repo' }}
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
      tasks={{ open: tasksOpen, onToggle: () => { toggles += 1 }, shortcut: '⌘I' }}
    />
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  opened = []
  toggles = 0
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function clickCard({ tasksOpen }: { tasksOpen: boolean }): Promise<void> {
  await act(async () => root.render(<Harness tasksOpen={tasksOpen} />))
  const surface = container.querySelector('[data-worktree="/r/a"] [data-worktree-card-surface]')
  if (surface === null) throw new Error('카드 표면 없음')
  await act(async () => { surface.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('R1-H 사이드바 카드 클릭 = 작업 페이지 닫힘 + 그 worktree', () => {
  it('열려 있으면 닫기(토글) 1회 + worktree 열기', async () => {
    await clickCard({ tasksOpen: true })
    expect(opened).toEqual(['/r/a'])
    expect(toggles).toBe(1)
  })
  it('대조 — 닫혀 있으면 토글하지 않는다(열지 않는다)', async () => {
    await clickCard({ tasksOpen: false })
    expect(opened).toEqual(['/r/a'])
    expect(toggles).toBe(0)
  })
})
