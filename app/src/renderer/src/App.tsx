// 미니멀 세션 워크스페이스 — 왼쪽 3단 목록 + 오른쪽 터미널 자리.
//
//   repo        ← worktree.list (스냅샷의 workspace.worktree 는 대부분 비어 있다)
//    └ workspace ← session.snapshot 의 workspaces[]
//       └ pane   ← session.snapshot 의 panes[] — **선택 대상**이자 Step 2 ② 터미널이 붙을 단위
//
// 세션은 이 3단 위에서 "어느 서버에 붙을지"를 고르는 축이라 별도 섹션으로 둔다
// (00-analysis.md §3: 세션 층에는 구독이 없다 — 발견 + 선택까지가 이번 범위).

import { useEffect, useRef, useState } from 'react'
import type { AppState, LinkState, PaneRow, WorkspaceRow } from '../../shared/types'
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
  selectedPaneId: null,
}

type RepoGroup = { key: string; repoName: string | null; repoRoot: string | null; workspaces: WorkspaceRow[] }

function groupByRepo(workspaces: WorkspaceRow[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>()
  for (const workspace of workspaces) {
    const key = workspace.repoRoot ?? workspace.repoName ?? '(repo 없음)'
    const group = groups.get(key) ?? {
      key,
      repoName: workspace.repoName,
      repoRoot: workspace.repoRoot,
      workspaces: [],
    }
    group.workspaces.push(workspace)
    groups.set(key, group)
  }
  // repo 를 못 붙인 묶음은 맨 아래로 (실측상 홈 디렉터리처럼 git repo 가 아닌 workspace 가 있다).
  return [...groups.values()].sort((a, b) => {
    if (a.repoName === null) return b.repoName === null ? 0 : 1
    if (b.repoName === null) return -1
    return a.repoName.localeCompare(b.repoName)
  })
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
                    className={session.name === state.selectedSession ? 'row row-on' : 'row'}
                    onClick={() => void window.corral.selectSession(session.name)}
                  >
                    <span className="row-title">
                      {session.name}
                      {session.isDefault && <em className="tag">default</em>}
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
              repo · workspace · pane <small>구독 경유 실시간</small>
            </h2>
            {state.workspaces.length === 0 && <p className="empty">workspace 없음</p>}
            <div className="tree">
              {groupByRepo(state.workspaces).map((group) => (
                <div key={group.key} className="group">
                  <div className="group-head" title={group.repoRoot ?? ''}>
                    <span className="group-name">{group.repoName ?? '(repo 없음)'}</span>
                    <span className="group-count">{group.workspaces.length}</span>
                  </div>
                  {group.workspaces.map((workspace) => (
                    <div key={workspace.workspaceId} className="workspace">
                      <div className="workspace-head">
                        <span className={`dot dot-${workspace.agentStatus}`} />
                        <span className="workspace-name">{workspace.label}</span>
                        {workspace.branch !== null && <em className="tag">{workspace.branch}</em>}
                        {workspace.isLinkedWorktree === true && <em className="tag">linked</em>}
                        {workspace.focused && <em className="tag">focused</em>}
                      </div>
                      <div className="workspace-sub">
                        {workspace.workspaceId} · pane {workspace.paneCount} · tab {workspace.tabCount} ·{' '}
                        {workspace.agentStatus}
                      </div>
                      <ul className="list panes">
                        {workspace.panes.map((pane) => (
                          <PaneItem key={pane.paneId} pane={pane} selected={pane.paneId === state.selectedPaneId} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
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
        <SecurityProbe />
        {state.link.lastError !== null && <span className="warn">{state.link.lastError}</span>}
      </footer>
    </div>
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
