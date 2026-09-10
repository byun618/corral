// 미니멀 세션 워크스페이스 — 왼쪽 3단 목록 + 오른쪽 터미널 자리.
//
//   repo           ← worktree.list 의 source (스냅샷의 workspace.worktree 는 대부분 비어 있다)
//    └ worktree    ← worktree.list 의 worktrees[] — **herdr 에 안 열린 것도 나온다**
//       └ workspace ← session.snapshot 의 workspaces[] (그 worktree 가 열려 있을 때만)
//          └ tab    ← session.snapshot 의 tabs[] — Orca 의 터미널 한 줄에 해당한다
//             └ pane ← 그 탭의 pane 이 **2개 이상일 때만** 펼친다. 선택 대상은 언제나 pane
//
// 탭에 pane 이 하나면 탭 줄을 누르는 것이 곧 그 pane 을 고르는 것이다 (기준 L2).
// 스플릿이 없는 화면에서 pane 줄이 안 보이는 이유가 이것이다 — Orca 와 같은 모양이다.
//
// 세션은 이 3단 위에서 "어느 서버에 붙을지"를 고르는 축이라 별도 섹션으로 둔다
// (00-analysis.md §3: 세션 층에는 구독이 없다 — 발견 + 선택까지가 이번 범위).

import { useEffect, useRef, useState } from 'react'
import type { AppState, LinkState, PaneRow, RepoGroupRow, TabRow, WorkspaceRow, WorktreeRow } from '../../shared/types'
import { SecurityProbe } from './SecurityProbe'

const EMPTY: AppState = {
  revision: 0,
  sessions: [],
  sessionsError: null,
  selectedSession: null,
  link: {
    phase: 'idle',
    sessionName: null,
    socketPath: null,
    attempt: 0,
    nextRetryInMs: null,
    lastError: null,
    lastPushAt: null,
    bufferedAtSnapshot: null,
  },
  workspaces: [],
  repos: [],
  selectedPaneId: null,
  diagnostics: false,
}

function rowClass(selected: boolean, running: boolean): string {
  return ['row', selected ? 'row-on' : null, running ? null : 'row-stopped'].filter((part) => part !== null).join(' ')
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>(EMPTY)
  const reported = useRef(-1)

  useEffect(() => {
    void window.corral.getState().then(setState)
    return window.corral.onState(setState)
  }, [])

  // L3 의 "반영 시각" — 실제로 그린 다음에 main 로그로 되돌려 보낸다.
  useEffect(() => {
    if (state.revision === reported.current) return
    reported.current = state.revision
    window.corral.reportRendered(state.revision)
  }, [state.revision])

  // L2 근거 — **화면에 실제로 몇 줄이 그려졌는지**를 렌더러가 직접 세어 main 로그로 보낸다.
  // 상태만 보고 "pane 줄이 없다"고 적으면 그건 렌더 규칙에 대한 주장이지 관측이 아니다.
  useEffect(() => {
    if (!state.diagnostics) return
    const tabs = state.repos.flatMap((group) => group.workspaces.flatMap((workspace) => workspace.tabs))
    window.corral.reportProbe('tree', {
      revision: String(state.revision),
      repoRows: String(state.repos.length),
      worktreeRows: String(state.repos.reduce((sum, group) => sum + group.worktrees.length, 0)),
      closedWorktreeRows: String(
        state.repos.reduce((sum, group) => sum + group.worktrees.filter((w) => w.openWorkspaceId === null).length, 0),
      ),
      tabRows: String(tabs.length),
      // 렌더 규칙 그대로: pane 줄은 pane 이 2개 이상인 탭 아래에만 그린다.
      paneRows: String(tabs.filter((tab) => tab.panes.length >= 2).reduce((sum, tab) => sum + tab.panes.length, 0)),
      splitTabs: String(tabs.filter((tab) => tab.panes.length >= 2).length),
    })
  }, [state])

  const selectedPane =
    state.workspaces.flatMap((row) => row.panes).find((pane) => pane.paneId === state.selectedPaneId) ?? null
  const selectedWorkspace =
    selectedPane === null ? null : (state.workspaces.find((row) => row.workspaceId === selectedPane.workspaceId) ?? null)

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">corral</span>
        <LinkBadge link={state.link} />
        <span className="rev">rev {state.revision}</span>
      </header>

      <div className="body">
        <aside className="sidebar">
          <section className="panel">
            <h2>
              세션 <small>발견 · 폴링 (구독 없음)</small>
            </h2>
            {state.sessions.length === 0 && <p className="empty">세션 없음</p>}
            <ul className="list">
              {state.sessions.map((session) => (
                <li key={session.name}>
                  <button
                    type="button"
                    className={rowClass(session.name === state.selectedSession, session.running)}
                    onClick={() => void window.corral.selectSession(session.name)}
                  >
                    <span className="row-title">
                      {/* session list 는 멈춘 세션도 준다 — 산 것과 죽은 것이 같아 보이면 안 된다. */}
                      <span className={session.running ? 'dot dot-idle' : 'dot dot-stopped'} />
                      {session.name}
                      {session.isDefault && <em className="tag">default</em>}
                      {!session.running && <em className="tag tag-stopped">stopped</em>}
                    </span>
                    <span className="row-sub">{session.socketPath}</span>
                  </button>
                </li>
              ))}
            </ul>
            {state.sessionsError !== null && <p className="warn">{state.sessionsError}</p>}
          </section>

          <section className="panel grow">
            <h2>
              repo · worktree · tab <small>구독 경유 실시간</small>
            </h2>
            {state.repos.length === 0 && <p className="empty">workspace 없음</p>}
            <div className="tree">
              {state.repos.map((group) => (
                <RepoGroup key={group.key} group={group} selectedPaneId={state.selectedPaneId} />
              ))}
            </div>
          </section>
        </aside>

        <main className="stage">
          {selectedPane === null ? (
            <div className="placeholder">
              <p className="placeholder-title">터미널 뷰</p>
              <p className="placeholder-body">
                왼쪽에서 pane 을 고르면 여기에 그 터미널이 붙는다.
                <br />
                렌더링·입력은 이 일감 범위 밖이다 (Step 2 ②).
              </p>
            </div>
          ) : (
            <div className="placeholder">
              <p className="placeholder-title">
                {selectedPane.title} <span className="mono">{selectedPane.paneId}</span>
              </p>
              <p className="placeholder-body">
                {selectedWorkspace?.label ?? selectedPane.workspaceId} · agent_status {selectedPane.agentStatus}
                {selectedPane.agent !== null && <> · agent {selectedPane.agent}</>}
                <br />
                <span className="mono">{selectedPane.cwd ?? ''}</span>
              </p>
              <p className="placeholder-note">터미널 뷰 자리 — 렌더링은 Step 2 ② (LIFE-345)</p>
            </div>
          )}
        </main>
      </div>

      <footer className="statusbar">
        {state.diagnostics && <SecurityProbe />}
        {state.link.lastError !== null && <span className="warn">{state.link.lastError}</span>}
      </footer>
    </div>
  )
}

function RepoGroup({ group, selectedPaneId }: { group: RepoGroupRow; selectedPaneId: string | null }): React.JSX.Element {
  const byId = new Map(group.workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  // worktree 로 짝지어진 workspace 는 그 아래에서 그린다. 못 짝지은 것(예: git repo 가 아닌 cwd)은 따로.
  const claimed = new Set(group.worktrees.map((worktree) => worktree.openWorkspaceId).filter((id) => id !== null))
  const loose = group.workspaces.filter((workspace) => !claimed.has(workspace.workspaceId))
  const openCount = group.worktrees.filter((worktree) => worktree.openWorkspaceId !== null).length

  return (
    <div className="group">
      <div className="group-head" title={group.repoRoot ?? ''}>
        <span className="group-name">{group.repoName ?? '(repo 없음)'}</span>
        <span className="group-count">
          {group.worktrees.length > 0 ? `${openCount}/${group.worktrees.length}` : group.workspaces.length}
        </span>
      </div>
      {group.worktrees.map((worktree) => (
        <WorktreeItem
          key={worktree.path}
          worktree={worktree}
          workspace={worktree.openWorkspaceId === null ? null : (byId.get(worktree.openWorkspaceId) ?? null)}
          selectedPaneId={selectedPaneId}
        />
      ))}
      {loose.map((workspace) => (
        <div key={workspace.workspaceId} className="worktree">
          <WorkspaceBody workspace={workspace} selectedPaneId={selectedPaneId} />
        </div>
      ))}
    </div>
  )
}

/** worktree 한 줄. 열려 있으면 그 아래로 탭이 달리고, 안 열렸으면 흐린 한 줄로 남는다. */
function WorktreeItem({
  worktree,
  workspace,
  selectedPaneId,
}: {
  worktree: WorktreeRow
  workspace: WorkspaceRow | null
  selectedPaneId: string | null
}): React.JSX.Element {
  return (
    <div className={workspace === null ? 'worktree worktree-closed' : 'worktree'}>
      <div className="worktree-head" title={worktree.path}>
        <span className={`dot dot-${workspace?.agentStatus ?? 'stopped'}`} />
        <span className="worktree-name">{worktree.branch ?? worktree.path}</span>
        {worktree.isLinkedWorktree && <em className="tag">linked</em>}
        {workspace === null && <em className="tag tag-stopped">닫힘</em>}
        {workspace?.focused === true && <em className="tag">focused</em>}
      </div>
      {workspace === null ? (
        <div className="worktree-sub">{worktree.path}</div>
      ) : (
        <WorkspaceBody workspace={workspace} selectedPaneId={selectedPaneId} />
      )}
    </div>
  )
}

function WorkspaceBody({
  workspace,
  selectedPaneId,
}: {
  workspace: WorkspaceRow
  selectedPaneId: string | null
}): React.JSX.Element {
  return (
    <>
      <div className="worktree-sub">
        {workspace.workspaceId} · {workspace.label} · tab {workspace.tabCount} · pane {workspace.paneCount}
      </div>
      <ul className="list tabs">
        {workspace.tabs.map((tab) => (
          <TabItem key={tab.tabId} tab={tab} selectedPaneId={selectedPaneId} />
        ))}
      </ul>
    </>
  )
}

/**
 * 탭 한 줄 = Orca 의 터미널 한 줄. pane 이 하나면 이 줄이 곧 그 pane 이고(눌러서 고른다),
 * **2개 이상일 때만** 아래로 pane 을 펼친다.
 */
function TabItem({ tab, selectedPaneId }: { tab: TabRow; selectedPaneId: string | null }): React.JSX.Element {
  const only = tab.panes.length === 1 ? (tab.panes[0] ?? null) : null
  const split = tab.panes.length >= 2
  const selected = only !== null && only.paneId === selectedPaneId
  const title = only?.title ?? tab.label
  const head = (
    <span className="row-title">
      <span className={`dot dot-${only?.agentStatus ?? tab.agentStatus}`} />
      <span className="pane-title">{title}</span>
      {only?.agent != null && <em className="tag">{only.agent}</em>}
      {split && <em className="tag">pane {tab.panes.length}</em>}
    </span>
  )
  const sub = (
    <span className="row-sub">
      {tab.tabId}
      {only !== null ? ` · ${only.paneId} · ${only.agentStatus}` : ` · 스플릿 ${tab.panes.length}`}
    </span>
  )
  return (
    <li>
      {only === null ? (
        <div className="row row-head">
          {head}
          {sub}
        </div>
      ) : (
        <button
          type="button"
          className={selected ? 'row row-on' : 'row'}
          onClick={() => void window.corral.selectPane(selected ? null : only.paneId)}
        >
          {head}
          {sub}
        </button>
      )}
      {split && (
        <ul className="list panes">
          {tab.panes.map((pane) => (
            <PaneItem key={pane.paneId} pane={pane} selected={pane.paneId === selectedPaneId} />
          ))}
        </ul>
      )}
    </li>
  )
}

function PaneItem({ pane, selected }: { pane: PaneRow; selected: boolean }): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={selected ? 'row pane-row row-on' : 'row pane-row'}
        onClick={() => void window.corral.selectPane(selected ? null : pane.paneId)}
      >
        <span className="row-title">
          <span className={`dot dot-${pane.agentStatus}`} />
          <span className="pane-title">{pane.title}</span>
          {pane.agent !== null && <em className="tag">{pane.agent}</em>}
        </span>
        <span className="row-sub">
          {pane.paneId} · {pane.agentStatus}
        </span>
      </button>
    </li>
  )
}

function LinkBadge({ link }: { link: LinkState }): React.JSX.Element {
  const label =
    link.phase === 'reconnecting' && link.nextRetryInMs !== null
      ? `reconnecting · 시도 ${link.attempt} · ${link.nextRetryInMs}ms 뒤`
      : link.phase
  return (
    <span className={`badge badge-${link.phase}`}>
      {label}
      {link.sessionName !== null && <span className="mono"> @{link.sessionName}</span>}
    </span>
  )
}
