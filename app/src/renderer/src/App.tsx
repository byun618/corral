// 미니멀 세션 워크스페이스 — 왼쪽 목록 + 오른쪽 터미널 자리.
//
// 왼쪽 목록 1행 = herdr **workspace** 다 (00-analysis.md §3). 세션은 그 위에서 "어느 서버에
// 붙을지"를 고르는 축이라 별도 섹션으로 둔다 — 이번 범위는 발견 + 선택까지.

import { useEffect, useRef, useState } from 'react'
import type { AppState, LinkState, WorkspaceRow } from '../../shared/types'
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
  selectedWorkspaceId: null,
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

  const selected = state.workspaces.find((row) => row.workspaceId === state.selectedWorkspaceId) ?? null

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
              workspace <small>구독 경유 실시간</small>
            </h2>
            {state.workspaces.length === 0 && <p className="empty">workspace 없음</p>}
            <ul className="list">
              {state.workspaces.map((row) => (
                <WorkspaceItem
                  key={row.workspaceId}
                  row={row}
                  selected={row.workspaceId === state.selectedWorkspaceId}
                />
              ))}
            </ul>
          </section>
        </aside>

        <main className="stage">
          {selected === null ? (
            <div className="placeholder">
              <p className="placeholder-title">터미널 뷰</p>
              <p className="placeholder-body">
                왼쪽에서 workspace 를 고르면 여기에 그 pane 들이 붙는다.
                <br />
                렌더링·입력은 이 일감 범위 밖이다 (Step 2 ②).
              </p>
            </div>
          ) : (
            <div className="placeholder">
              <p className="placeholder-title">
                {selected.label} <span className="mono">{selected.workspaceId}</span>
              </p>
              <p className="placeholder-body">
                pane {selected.paneCount} · tab {selected.tabCount} · agent_status {selected.agentStatus}
                {selected.repoName !== null && <> · repo {selected.repoName}</>}
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

function WorkspaceItem({ row, selected }: { row: WorkspaceRow; selected: boolean }): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={selected ? 'row row-on' : 'row'}
        onClick={() => void window.corral.selectWorkspace(selected ? null : row.workspaceId)}
      >
        <span className="row-title">
          <span className={`dot dot-${row.agentStatus}`} />
          {row.label}
          {row.focused && <em className="tag">focused</em>}
        </span>
        <span className="row-sub">
          {row.workspaceId} · pane {row.paneCount} · tab {row.tabCount} · {row.agentStatus}
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
