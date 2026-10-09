// LIFE-576 R3-A 사본 기하 픽스처 — 리뷰 r3 `codex-r3-raw/browser-renderer.tsx` 를 이 worktree 상대 경로로 옮긴 것(합성 입력·fixture, K6 아님).
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Sidebar} from '../../../src/renderer/src/components/Sidebar.js';
import {useManualOrder} from '../../../src/renderer/src/hooks/useManualOrder.js';
import {DEFAULT_SIDEBAR_VIEW, type SidebarView} from '../../../src/shared/sidebar-view.js';
import type {WorktreeMetaUpdate, WorktreeRow} from '../../../src/shared/types.js';
import type {UnreadView} from '../../../src/renderer/src/hooks/useUnread.js';
import type {LifecycleActions} from '../../../src/renderer/src/lifecycle-types.js';
const noop = (): void => {}
const ACTIONS: LifecycleActions = {
  createRow: noop, reopenTab: noop, launchAgent: noop, closeTabs: noop, renameRow: noop, clearRowName: noop, closeWorktree: noop,
  openWorktree: noop, openCreateWorktree: noop, activateWorkspace: noop,
}
const GIT = { branch: 'x', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
function wt(path: string, parentPath: string | null = null, patch: Partial<WorktreeRow> = {}): WorktreeRow {
  return { path, parentPath, branch: path.slice(1), isLinked: true, head: null, repoName: 'r', openWorkspaceId: null, workspace: null, gitStatus: GIT, displayName: null, comment: null, ...patch }
}


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
  const setMeta = async (update: WorktreeMetaUpdate): Promise<string | null> => {
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


Reflect.set(window,'corral',{setUiPrefs:()=>Promise.resolve()});
const host=document.getElementById('root');
if(host===null) throw new Error('#root 없음');
const root=createRoot(host);
let sequence=0;
Reflect.set(window,'showCase',async(withGrandchild=false)=>{
root.render(<Harness key={++sequence} rows={[wt('/p'),wt('/c','/p'),...(withGrandchild?[wt('/g','/c')]:[]),wt('/z')]} order={['/p','/c','/g','/z']} />);
await new Promise(r=>setTimeout(r,100));
});
