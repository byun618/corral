// @vitest-environment happy-dom
// 사이드바 계보 배선 시험 (LIFE-576 수정 r3 R2-A~D) — 실제 Sidebar·useManualOrder 를 띄우고 **결과**(화면 카드 순서·정렬 모드·
// 활성 카드 가시성·투명 처리 대상)로 단언한다. 끌기 hook 은 가짜로 바꿔 Sidebar 가 넘긴 `onCommit`·`onNest`·`nestCandidates` 를 직접 부른다 —
// 그 배선이 빠지거나(리뷰 r2 변조 V09) `loaded`·조상 경로 의존이 빠지면 여기서 실패한다. 기하·사본은 `hooks/useSidebarReorder.lineage.test.mjs`.
// 출발점: 리뷰어 재현 `specs/LIFE-576-worktree-nesting/raw/review/codex-r2-raw/review-repro.test.tsx`(결함 관측 → 원하는 결과로 뒤집음).
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SIDEBAR_VIEW, type SidebarView } from '../../../shared/sidebar-view.js'
import type { WorktreeMetaUpdate, WorktreeRow } from '../../../shared/types.js'
import { useManualOrder } from '../hooks/useManualOrder.js'
import type { NestCommit, ReorderCommit, ReorderState } from '../hooks/useSidebarReorder.js'
import type { UnreadView } from '../hooks/useUnread.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { Sidebar } from './Sidebar.js'

type DragInput = {
  onCommit: (commit: ReorderCommit) => void
  nestCandidates?: (path: string) => ReadonlySet<string>
  onNest?: (nest: NestCommit) => void
}
const drag = vi.hoisted(() => {
  const holder: { input: DragInput | null; state: ReorderState | null } = { input: null, state: null }
  return holder
})
vi.mock('../hooks/useSidebarReorder.js', () => ({
  useSidebarReorder: (input: DragInput) => {
    drag.input = input
    return { state: drag.state, onRepoMouseDown() {}, onCardMouseDown() {}, onAllCardMouseDown() {} }
  },
}))

const noop = (): void => {}
const ACTIONS: LifecycleActions = {
  createRow: noop, reopenTab: noop, launchAgent: noop, closeTabs: noop, renameRow: noop, clearRowName: noop, closeWorktree: noop,
  openWorktree: noop, openCreateWorktree: noop, activateWorkspace: noop,
}
const GIT = { branch: 'x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
function wt(path: string, parentPath: string | null = null, patch: Partial<WorktreeRow> = {}): WorktreeRow {
  return { path, parentPath, branch: path.slice(1), isLinked: true, head: null, repoName: 'r', openWorkspaceId: null, workspace: null, gitStatus: GIT, displayName: null, comment: null, ...patch }
}

type Observed = {
  order: ReturnType<typeof useManualOrder>['order']
  view: SidebarView
  collapsed: ReadonlySet<string>
  /** Sidebar 밖에서 목록이 바뀐다(상위 피커·CLI → 트리 갱신). */
  setRows: (update: (prev: WorktreeRow[]) => WorktreeRow[]) => void
}
let root: Root
let container: HTMLElement
let observed: Observed
let meta: WorktreeMetaUpdate[]
let writes: unknown[]

function Harness(props: {
  rows: WorktreeRow[]
  order: string[]
  collapse?: string[]
  active?: string | null
  sortBy?: SidebarView['sortBy']
  groupBy?: SidebarView['groupBy']
  hideDetachedHead?: boolean
  loaded?: boolean
  pinned?: string[]
}): React.JSX.Element {
  const [rows, setRows] = useState(props.rows)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set(props.collapse ?? []))
  const [view, setView] = useState<SidebarView>({ ...DEFAULT_SIDEBAR_VIEW, sortBy: props.sortBy ?? 'manual', groupBy: props.groupBy ?? 'repo', hideDetachedHead: props.hideDetachedHead ?? false })
  const repos = [{ root: '/r', name: 'r', error: null, worktrees: rows }]
  const manual = useManualOrder({ repos, registry: { roots: ['/r'], generation: 1 } })
  useEffect(() => manual.hydrate({ manualRepoOrder: ['/r'], manualWorktreeOrder: { '/r': props.order }, manualFlatOrder: props.order }), [])
  observed = { order: manual.order, view, collapsed, setRows }
  const setMeta = async (update: WorktreeMetaUpdate): Promise<string | null> => {
    meta.push(update)
    setRows((prev) => prev.map((row) => (row.path === update.path && update.parentPath !== undefined ? { ...row, parentPath: update.parentPath } : row)))
    return null
  }
  const unread: UnreadView = { worktrees: new Set(), panes: new Set(), markRead: noop, markUnread: noop, toggle: noop }
  return (
    <Sidebar
      sidebarRef={{ current: null }}
      width={280}
      state={{ repos, integrations: [], home: '/tmp', retainedAgents: [], orchestrationLineage: { state: 'ready', entries: [] } }}
      activeWorkspaceId={props.active ?? null}
      selectedPane={null}
      selectPane={noop}
      closePane={noop}
      actions={ACTIONS}
      manualOrder={manual.order}
      // App `onReorder` 와 같은 규칙 — 비수동 정렬에서 순서가 바뀐 드롭이면 Manual 로(K7ⓐ).
      onReorder={({ commit, layout }) => {
        const toManual = commit.source.kind !== 'repo' && view.sortBy !== 'manual'
        const changed = manual.commit({ commit, layout: toManual ? layout : null })
        if (changed && toManual) setView((prev) => ({ ...prev, sortBy: 'manual' }))
      }}
      view={view}
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
      lineageCollapse={{
        values: collapsed,
        loaded: props.loaded ?? true,
        toggle: (path) => setCollapsed((prev) => (prev.has(path) ? new Set([...prev].filter((key) => key !== path)) : new Set([...prev, path]))),
        remove: (path) => setCollapsed((prev) => new Set([...prev].filter((key) => key !== path))),
      }}
      cards={{
        pinned: new Set(props.pinned ?? []),
        deleting: new Set(),
        altHeld: false,
        unread,
        togglePin: noop,
        setMeta,
        openDetails: noop,
        requestDelete: noop,
        notify: noop,
        onHoverCard: noop,
        revealRequest: null,
        deleteShortcut: null,
      }}
    />
  )
}

/** 화면 카드 경로(문서 순서) — 중첩 후손은 부모 행 안에 있어도 문서 순서로 부모 뒤다. */
const paths = (): (string | null)[] => [...container.querySelectorAll('[data-worktree]')].map((element) => element.getAttribute('data-worktree'))
const card = (path: string): Element | null => container.querySelector(`[data-worktree="${path}"]`)
const input = (): DragInput => {
  if (drag.input === null) throw new Error('useSidebarReorder 가 불리지 않았다')
  return drag.input
}
const show = async (element: React.JSX.Element): Promise<void> => {
  await act(async () => root.render(element))
}

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  meta = []
  writes = []
  drag.input = null
  drag.state = null
  vi.stubGlobal('corral', { setUiPrefs: (patch: unknown) => { writes.push(patch); return Promise.resolve() } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('R2-A 부모를 푸는 순서 드롭 = 표시 줄 자리에 착지 (Orca 와 다르게 — Orca main `worktree-manual-order.ts:144` 는 no-op)', () => {
  for (const groupBy of ['repo', 'none'] as const) {
    it(`부모 덩어리 바로 뒤 경계(평면 목록 같음) — 부모가 풀리고 카드는 부모 아래 그 자리, 저장 순서도 그 자리 (${groupBy})`, async () => {
      await show(<Harness rows={[wt('/c', '/p'), wt('/p'), wt('/z')]} order={['/c', '/p', '/z']} groupBy={groupBy} />)
      const before = paths()
      expect(before).toEqual(['/p', '/c', '/z'])
      const source = groupBy === 'repo' ? { kind: 'card' as const, repoRoot: '/r', path: '/c' } : { kind: 'all-card' as const, path: '/c' }
      await act(async () => input().onCommit({ source, keys: ['/p', '/c', '/z'], slot: 2 }))
      expect(meta).toEqual([{ path: '/c', parentPath: null }])
      expect(paths()).toEqual(['/p', '/c', '/z'])
      expect(groupBy === 'repo' ? observed.order.worktrees['/r'] : observed.order.all).toEqual(['/p', '/c', '/z'])
      // 풀린 뒤 c 는 루트 카드다(p 행 밖).
      expect(card('/p')?.contains(card('/c'))).toBe(false)
    })
  }

  it('이름 정렬 — 착지한 자리가 저장되고 Manual 로 전환(기존 순서 끌기와 같이)', async () => {
    await show(<Harness rows={[wt('/a', '/p'), wt('/p'), wt('/z')]} order={['/a', '/p', '/z']} sortBy="name" />)
    expect(paths()).toEqual(['/p', '/a', '/z'])
    await act(async () => input().onCommit({ source: { kind: 'card', repoRoot: '/r', path: '/a' }, keys: ['/p', '/a', '/z'], slot: 2 }))
    expect(observed.view.sortBy).toBe('manual')
    expect(paths()).toEqual(['/p', '/a', '/z'])
  })

  it('부모 해제가 없는 일반 드롭의 제자리는 그대로 no-op — 저장도 정렬 전환도 없다', async () => {
    await show(<Harness rows={[wt('/a'), wt('/p'), wt('/z')]} order={['/a', '/p', '/z']} sortBy="name" />)
    const writesBefore = writes.length
    await act(async () => input().onCommit({ source: { kind: 'card', repoRoot: '/r', path: '/p' }, keys: ['/a', '/p', '/z'], slot: 2 }))
    expect(meta).toEqual([])
    expect(observed.view.sortBy).toBe('name')
    expect(writes.length).toBe(writesBefore)
  })

  it('다른 자리로 놓으면 부모가 풀리고 그 자리로 간다(기존 동작)', async () => {
    await show(<Harness rows={[wt('/a'), wt('/p'), wt('/c', '/p'), wt('/z')]} order={['/a', '/p', '/c', '/z']} />)
    await act(async () => input().onCommit({ source: { kind: 'card', repoRoot: '/r', path: '/c' }, keys: ['/a', '/p', '/c', '/z'], slot: 0 }))
    expect(meta).toEqual([{ path: '/c', parentPath: null }])
    expect(paths()).toEqual(['/c', '/a', '/p', '/z'])
  })
})

describe('R2-B 활성 카드의 조상 경로가 바뀌면 접힌 새 조상을 펼친다', () => {
  it('활성 카드를 이미 접힌 부모에 끌어 넣으면(onNest) 부모가 펼쳐져 활성 카드가 보인다', async () => {
    await show(<Harness rows={[wt('/c', null, { openWorkspaceId: 'wc' }), wt('/p'), wt('/other', '/p')]} order={['/c', '/p', '/other']} collapse={['/p']} active="wc" />)
    expect(paths()).toContain('/c')
    expect(paths()).not.toContain('/other')
    await act(async () => input().onNest?.({ path: '/c', parentPath: '/p' }))
    expect(meta).toEqual([{ path: '/c', parentPath: '/p' }])
    expect(observed.collapsed.has('/p')).toBe(false)
    // 자식 순서 = 구획(저장) 순서 — c 가 other 보다 앞에 저장돼 있다.
    expect(paths()).toEqual(['/p', '/c', '/other'])
    expect(card('/p')?.contains(card('/c'))).toBe(true)
  })

  it('메뉴·CLI 로 부모가 바뀐 경우(목록 갱신만)도 같다 — 활성 경로·적재 상태가 그대로여도 접힌 새 조상 아래로 숨지 않는다', async () => {
    await show(<Harness rows={[wt('/p'), wt('/q'), wt('/c', '/q', { openWorkspaceId: 'wc' })]} order={['/p', '/q', '/c']} collapse={['/p']} active="wc" />)
    expect(paths()).toEqual(['/p', '/q', '/c'])
    // Sidebar 를 거치지 않는 parentPath 변경(CLI `worktree set --parent` → 트리 갱신).
    await act(async () => observed.setRows((prev) => prev.map((row) => (row.path === '/c' ? { ...row, parentPath: '/p' } : row))))
    expect(observed.collapsed.has('/p')).toBe(false)
    expect(paths()).toEqual(['/p', '/c', '/q'])
    expect(meta).toEqual([])
  })

  it('M10 — 사용자가 활성 카드의 조상을 직접 접는 것은 허용한다(다시 펼치지 않는다)', async () => {
    await show(<Harness rows={[wt('/p'), wt('/c', '/p', { openWorkspaceId: 'wc' })]} order={['/p', '/c']} active="wc" />)
    expect(paths()).toEqual(['/p', '/c'])
    const toggle = container.querySelector('[data-lineage-toggle="/p"]')
    expect(toggle).not.toBeNull()
    await act(async () => toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(observed.collapsed.has('/p')).toBe(true)
    expect(paths()).toEqual(['/p'])
  })

  it('R1-C 접힘 집합 적재(`loaded`) 뒤에 펼친다 — 적재 전에는 손대지 않는다', async () => {
    const props = { rows: [wt('/c', '/p', { openWorkspaceId: 'wc' }), wt('/p')], order: ['/p', '/c'], collapse: ['/p'], active: 'wc' }
    await show(<Harness {...props} loaded={false} />)
    expect(paths()).not.toContain('/c')
    await show(<Harness {...props} loaded={true} />)
    expect(paths()).toContain('/c')
    expect(observed.collapsed.has('/p')).toBe(false)
  })
})

describe('R2-C 하위 카드를 끄는 동안 원래 자리 투명 처리 = 끄는 덩어리 전부(평면 배치된 손자 포함)', () => {
  it('c 를 끌면(block c+g) c·g 둘 다 투명, 형제·부모·다른 카드는 아니다', async () => {
    drag.state = { source: { kind: 'card', repoRoot: '/r', path: '/c' }, indicatorY: 5, block: ['/c', '/g'] }
    await show(<Harness rows={[wt('/p'), wt('/c', '/p'), wt('/g', '/c'), wt('/s', '/p'), wt('/z')]} order={['/p', '/c', '/g', '/s', '/z']} />)
    const hidden = (path: string): boolean => card(path)?.classList.contains('is-reorder-source') ?? false
    expect(hidden('/c')).toBe(true)
    expect(hidden('/g')).toBe(true)
    // 손자는 c 행 안이 아니라 p 행 안에 평평하게 있다 — c 의 투명 처리로는 가려지지 않아 따로 표시해야 한다.
    expect(card('/c')?.contains(card('/g'))).toBe(false)
    expect(hidden('/s')).toBe(false)
    expect(hidden('/p')).toBe(false)
    expect(hidden('/z')).toBe(false)
  })
})

describe('R2-D 순환은 전체 그래프에서 — 필터로 일부를 숨겨도 남은 구성원은 루트(Orca projection)', () => {
  it('a→c→b→a 순환에서 c 를 필터로 숨기고 a 를 접어도 b 는 a 아래로 숨지 않는다', async () => {
    await show(
      <Harness rows={[wt('/a', '/c'), wt('/b', '/a'), wt('/c', '/b', { branch: null, head: 'abcdef0123456789' })]} order={['/a', '/b', '/c']} collapse={['/a']} hideDetachedHead />,
    )
    expect(paths()).toEqual(['/a', '/b'])
    expect(card('/a')?.contains(card('/b'))).toBe(false)
  })
})

describe('배선 — 상위 지정 후보 = 메뉴 피커와 같은 술어', () => {
  it('nestCandidates 는 자기·후손·현재 부모를 빼고 같은 레포 카드를 준다', async () => {
    await show(<Harness rows={[wt('/p'), wt('/c', '/p'), wt('/g', '/c'), wt('/z')]} order={['/p', '/c', '/g', '/z']} />)
    const candidates = input().nestCandidates?.('/c')
    expect([...(candidates ?? [])]).toEqual(['/z'])
  })
})
