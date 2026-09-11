// 화면 — `repo → worktree → tab → pane` 4단 목록 (기준 N4).
//
// **루트는 레포 레지스트리다.** herdr 가 아무것도 안 열고 있어도 등록한 레포는 그대로 보이고,
// 닫힌 worktree 는 열린 worktree 와 같은 자리에 `닫힘` 칩을 달고 앉는다.
//
// 칩은 **읽기 전용 반영**이다 (기준 N8). R1 은 상태를 만들지 않는다 —
// 칩이 말하는 두 가지는 각각 herdr 의 다음 값을 그대로 옮긴 것이다:
//   · worktree 열림/닫힘 → `worktree.list` 의 `open_workspace_id` 유무
//   · pane 의 에이전트 상태 → `pane.list` 의 `agent_status` (+ 이름은 `agent`)
//
// 계측이 누를 수 있게 손잡이마다 `data-*` 를 단다 — 선택자가 화면 계약이다.

import { useEffect, useRef, useState } from 'react'
import type { AgentStatus, AppState, PaneRow, RepoRow, TabRow, WorkspaceRow, WorktreeRow } from '../../shared/types.js'

/**
 * 칩이 **구분하는 상태의 전부**다 (기준 N8: "문서에 적고 그 전부를 대조한다").
 * `done` 이 없는 이유는 `shared/types.ts` 의 `AgentStatus` 주석 — herdr 0.9.0 이 그 값을
 * 만들지 않아 라이브 오라클과 대조할 길이 없다 (수정 1회차 M7).
 */
const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '대기',
  working: '작업중',
  blocked: '막힘',
  unknown: '미상',
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.corral.getState().then(setState)
    return window.corral.onState(setState)
  }, [])

  // 렌더가 실제로 끝난 revision 을 main 로그에 남긴다 — 반영 지연(A1)의 화면 쪽 끝점이다.
  const lastReported = useRef(-1)
  useEffect(() => {
    if (state === null || state.revision === lastReported.current) return
    lastReported.current = state.revision
    window.corral.reportRendered(state.revision)
  })

  if (state === null) return <div className="boot">부트스트랩…</div>

  const add = async (): Promise<void> => {
    const result = await window.corral.addRepo(draft)
    if (result.ok) {
      setDraft('')
      setNotice(`등록: ${result.root ?? draft}`)
      return
    }
    setNotice(`실패: ${result.error ?? '알 수 없음'}`)
  }

  return (
    <div className="app">
      <header className="header" data-header>
        <span className="brand">corral</span>
        <span className="session" data-session>
          {state.selectedSession ?? '(세션 없음)'}
        </span>
        <span className={`phase phase-${state.link.phase}`} data-link-phase>
          {state.link.phase}
        </span>
        <span className="meta" data-resync>
          재동기 {state.link.resyncCount}회{state.link.lastResyncNote === null ? '' : ` · ${state.link.lastResyncNote}`}
        </span>
        {state.link.droppingPush ? (
          <span className="meta warn" data-dropping>
            push 유실 주입 중{state.link.dropPushOnly === null ? '' : ` (${state.link.dropPushOnly.join('·')}만)`}
          </span>
        ) : null}
        {state.diagnostics ? (
          <span className="meta" data-revision>
            rev {state.revision}
          </span>
        ) : null}
      </header>

      <section className="add" data-add-repo-row>
        <input
          className="path"
          data-repo-input
          placeholder="레포 경로 (예: ~/repos/byun618/corral)"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
        />
        <button className="primary" data-add-repo onClick={() => void add()}>
          레포 추가
        </button>
        {notice === null ? null : (
          <span className="notice" data-add-notice>
            {notice}
          </span>
        )}
      </section>

      <main className="list">
        {state.repos.length === 0 ? (
          <p className="empty" data-empty>
            등록된 레포가 없다. 위에 레포 경로를 넣어 추가한다.
          </p>
        ) : (
          state.repos.map((repo) => <Repo key={repo.root} repo={repo} />)
        )}

        {state.unregistered.workspaces.length > 0 ? (
          <section className="repo" data-unregistered>
            <h2 className="repo-name">레지스트리 밖 workspace</h2>
            <p className="hint">이 workspace 들이 속한 레포는 아직 등록되지 않았다.</p>
            {state.unregistered.workspaces.map((workspace) => (
              <Workspace key={workspace.workspaceId} workspace={workspace} />
            ))}
          </section>
        ) : null}
      </main>

      <footer className="footer" data-footer>
        <span>레지스트리 {state.registry.file}</span>
        {state.registry.lastError === null ? null : <span className="warn">{state.registry.lastError}</span>}
        {state.sessionNote === null ? null : (
          <span className="warn" data-session-note>
            세션: {state.sessionNote}
          </span>
        )}
        {state.sessionsError === null ? null : <span className="warn">세션: {state.sessionsError}</span>}
        {state.link.lastError === null ? null : <span className="warn">링크: {state.link.lastError}</span>}
      </footer>
    </div>
  )
}

function Repo({ repo }: { repo: RepoRow }): React.JSX.Element {
  const open = repo.worktrees.filter((item) => item.openWorkspaceId !== null).length
  return (
    <section className="repo" data-repo={repo.root}>
      <h2 className="repo-name">
        <span data-repo-name={repo.root}>{repo.name}</span>
        <span className="chip chip-count" data-chip-repo={repo.root}>
          worktree {repo.worktrees.length} · 열림 {open}
        </span>
        <span className="path-hint">{repo.root}</span>
      </h2>
      {repo.error === null ? null : (
        <p className="warn" data-repo-error={repo.root}>
          {repo.error}
        </p>
      )}
      {repo.worktrees.length === 0 ? (
        <p className="hint">worktree 를 못 읽었다.</p>
      ) : (
        repo.worktrees.map((worktree) => <Worktree key={worktree.path} worktree={worktree} />)
      )}
    </section>
  )
}

function Worktree({ worktree }: { worktree: WorktreeRow }): React.JSX.Element {
  const isOpen = worktree.openWorkspaceId !== null
  return (
    <div className={`worktree ${isOpen ? 'is-open' : 'is-closed'}`} data-worktree={worktree.path}>
      <div className="worktree-head">
        <span className="branch" data-worktree-branch={worktree.path}>
          {worktree.branch ?? '(브랜치 없음)'}
        </span>
        {/* 칩의 정답 오라클은 herdr `worktree.list` 의 open_workspace_id 다 (N8). */}
        <span
          className={`chip ${isOpen ? 'chip-open' : 'chip-closed'}`}
          data-chip-worktree={worktree.path}
          data-chip-value={isOpen ? 'open' : 'closed'}
        >
          {isOpen ? '열림' : '닫힘'}
        </span>
        {worktree.isLinked ? <span className="chip chip-linked">linked</span> : null}
        <span className="path-hint">{worktree.path}</span>
      </div>
      {worktree.workspace === null ? null : <Workspace workspace={worktree.workspace} />}
    </div>
  )
}

function Workspace({ workspace }: { workspace: WorkspaceRow }): React.JSX.Element {
  return (
    <div className="workspace" data-workspace={workspace.workspaceId}>
      <div className="workspace-head">
        <span className="ws-label">{workspace.label}</span>
        <span className="chip chip-id" data-workspace-id={workspace.workspaceId}>
          {workspace.workspaceId}
        </span>
      </div>
      {workspace.tabs.length === 0 ? (
        <p className="hint">탭 없음</p>
      ) : (
        workspace.tabs.map((tab) => <Tab key={tab.tabId} tab={tab} />)
      )}
    </div>
  )
}

function Tab({ tab }: { tab: TabRow }): React.JSX.Element {
  return (
    <div className="tab" data-tab={tab.tabId} data-tab-order={tab.order} data-tab-number={tab.number}>
      <div className="tab-head">
        {/*
          **`number` 를 접두로 찍지 않는다** (수정 2회차 L-8 — grok + claude 보강).
          `number` 는 자리가 아니다: `tab.move` 로 옮겨도 안 바뀐다 (M5 실측). 그래서 순서를
          `order` 로 고친 뒤에도 접두만 남기면 목록 첫 줄이 `3. 1` 로 보인다 — 코드가 아는 모델과
          화면이 어긋난다. herdr 쪽에서 **자리를 말하는 필드는 `label`** 이고(옮기면 1·2·3 으로
          다시 붙는다 — `00-shapes-fix1.json`), 그래서 herdr 화면과 같은 것을 그대로 쓴다.
          `number`·`order` 는 계측이 읽을 수 있게 data 속성으로만 남긴다.
        */}
        <span className="tab-label">{tab.label}</span>
        <span className="chip chip-id">{tab.tabId}</span>
      </div>
      {tab.panes.map((pane) => (
        <Pane key={pane.paneId} pane={pane} />
      ))}
    </div>
  )
}

function Pane({ pane }: { pane: PaneRow }): React.JSX.Element {
  return (
    <div className="pane" data-pane={pane.paneId}>
      <span className="pane-title">{pane.title}</span>
      {/* 칩의 정답 오라클은 herdr `pane.list` 의 agent_status·agent 다 (N8). */}
      <span
        className={`chip chip-status chip-${pane.agentStatus}`}
        data-chip-pane={pane.paneId}
        data-chip-value={pane.agentStatus}
      >
        {STATUS_LABEL[pane.agentStatus]}
      </span>
      {pane.agent === null ? null : (
        <span className="chip chip-agent" data-chip-agent={pane.paneId} data-chip-value={pane.agent}>
          {pane.agent}
        </span>
      )}
      <span className="chip chip-id">{pane.paneId}</span>
    </div>
  )
}
