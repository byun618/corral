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
import type {
  AppState,
  ClosingRow,
  LaunchRow,
  LifecycleState,
  LinkState,
  PaneRow,
  RepoGroupRow,
  TabRow,
  WorkspaceRow,
  WorktreeRow,
} from '../../shared/types'
import { SecurityProbe } from './SecurityProbe'
import { TerminalView } from './TerminalView'

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
  collapsedWorkspaceIds: [],
  diagnostics: false,
  terminal: {
    paneId: null,
    generation: 0,
    grid: null,
    alive: true,
    deadReason: null,
    seededLines: null,
    lastReadMs: null,
    lastFrameAt: null,
    frames: 0,
    reads: 0,
    attachFailed: null,
    staleScreen: null,
    inputBlocked: null,
  },
  lifecycle: { launches: [], closings: [] },
  launchKinds: [],
}

/**
 * L7 — Orca 행의 우측 경과. herdr 는 pane 에 타임스탬프를 주지 않으므로 corral 이 `pane.updated`
 * 의 `revision` 이 움직인 시각을 찍어 둔 것이다 (store.ts). **모르면 아무것도 쓰지 않는다** —
 * 스냅샷으로 처음 안 pane 은 언제 바뀌었는지 알 수 없고, 그걸 `0s` 로 적으면 거짓말이 된다.
 */
function elapsed(changedAt: number | null, now: number): string {
  if (changedAt === null) return ''
  const seconds = Math.max(0, Math.floor((now - changedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/**
 * 에이전트 글리프. Orca 는 이 자리에 에이전트를 나타내는 기호를 둔다.
 * **시각 디자인은 범위 밖이라** 아이콘 체계를 새로 만들지 않는다 — 이름을 그대로 쓰고,
 * 상태만 점으로 구분한다 (자리와 값이 이 항목이 묻는 것이다).
 */
function agentGlyph(agent: string | null): string {
  return agent ?? ''
}

function rowClass(selected: boolean, running: boolean): string {
  return ['row', selected ? 'row-on' : null, running ? null : 'row-stopped'].filter((part) => part !== null).join(' ')
}

/**
 * 종료 확인 (N6). **모달은 화면의 일이고, 막는 것은 main 의 일이다** —
 * 에이전트가 도는 탭은 `confirmed:false` 로 부르면 herdr 로 아무것도 안 나가고
 * `needsConfirm` 만 돌아온다 (lifecycle.ts). 그래서 이 상태는 "무엇을 물을지" 만 들고 있다.
 */
type ConfirmClose = { tabId: string; running: string[] }

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>(EMPTY)
  const [confirm, setConfirm] = useState<ConfirmClose | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const reported = useRef(-1)

  /** 종료를 요청한다. 확인이 필요하면 보내지 않고 물어본다 (되돌릴 수 없는 일이라서다). */
  const requestClose = async (tabId: string, confirmed: boolean): Promise<void> => {
    setNotice(null)
    const outcome = await window.corral.closeRow({ tabId, confirmed })
    if (outcome.ok) {
      setConfirm(null)
      return
    }
    if (outcome.needsConfirm) {
      setConfirm({ tabId, running: outcome.running })
      return
    }
    // herdr 가 거절했으면 **그대로** 보이고 멈춘다 — 강제 종료로 승격하지 않는다.
    setConfirm(null)
    setNotice(outcome.error)
  }

  const requestCreate = async (workspaceId: string, kind: string): Promise<void> => {
    setNotice(null)
    const result = await window.corral.createRow({ workspaceId, kind, label: null })
    if (!result.ok) setNotice(result.error ?? '새 행을 못 만들었다')
  }

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
    const hiddenTabs = state.repos
      .flatMap((group) => group.workspaces)
      .filter(
        (workspace) =>
          workspace.tabs.length >= 2 &&
          state.collapsedWorkspaceIds.includes(workspace.workspaceId) &&
          !workspace.tabs.some((tab) => tab.panes.some((pane) => pane.paneId === state.selectedPaneId)),
      )
      .reduce((sum, workspace) => sum + workspace.tabs.length, 0)
    window.corral.reportProbe('tree', {
      revision: String(state.revision),
      repoRows: String(state.repos.length),
      worktreeRows: String(state.repos.reduce((sum, group) => sum + group.worktrees.length, 0)),
      closedWorktreeRows: String(
        state.repos.reduce((sum, group) => sum + group.worktrees.filter((w) => w.openWorkspaceId === null).length, 0),
      ),
      // 그려진 탭 줄 수 = 전체 − 접혀서 안 그린 것. 데이터 개수가 아니라 화면 줄 수다.
      tabRows: String(tabs.length - hiddenTabs),
      tabRowsTotal: String(tabs.length),
      // 렌더 규칙 그대로: pane 줄은 pane 이 2개 이상인 탭 아래에만 그린다.
      paneRows: String(tabs.filter((tab) => tab.panes.length >= 2).reduce((sum, tab) => sum + tab.panes.length, 0)),
      splitTabs: String(tabs.filter((tab) => tab.panes.length >= 2).length),
      collapsedWorkspaces: String(state.collapsedWorkspaceIds.length),
      // L8 — 접힌 workspace 의 탭 줄은 그려지지 않는다. 실제로 안 그려졌는지 여기서 센다.
      hiddenTabRows: String(hiddenTabs),
      // L7 — 경과를 실제로 쓴 줄 수 (changedAt 을 아는 pane 만 쓴다)
      rowsWithElapsed: String(tabs.filter((tab) => tab.panes.some((pane) => pane.changedAt !== null)).length),
      agentsShown: String(
        tabs.flatMap((tab) => tab.panes).filter((pane) => pane.agent !== null).map((pane) => pane.agent).join('|'),
      ),
    })
  }, [state])

  // 경과 표시는 시계를 따라간다 — 상태가 안 바뀌어도 숫자는 흘러야 한다.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const selectedPane =
    state.workspaces.flatMap((row) => row.panes).find((pane) => pane.paneId === state.selectedPaneId) ?? null
  const selectedWorkspace =
    selectedPane === null ? null : (state.workspaces.find((row) => row.workspaceId === selectedPane.workspaceId) ?? null)
  // pane 이 사라지면 목록의 선택은 비지만(그 줄이 없다) 터미널은 마지막 화면을 들고 죽어 있다.
  // 그 상태를 계속 보여 준다 — 지워 버리면 무엇이 죽었는지 화면에 안 남는다 (R5).
  const showsDeadTerminal = selectedPane === null && state.terminal.paneId !== null && !state.terminal.alive

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
                <RepoGroup
                  key={group.key}
                  group={group}
                  selectedPaneId={state.selectedPaneId}
                  collapsedIds={state.collapsedWorkspaceIds}
                  now={now}
                  lifecycle={state.lifecycle}
                  launchKinds={state.launchKinds}
                  onCreate={requestCreate}
                  onClose={(tabId) => void requestClose(tabId, false)}
                />
              ))}
            </div>
          </section>
        </aside>

        <main className="stage">
          {selectedPane === null && !showsDeadTerminal ? (
            <div className="placeholder">
              <p className="placeholder-title">터미널 뷰</p>
              <p className="placeholder-body">
                왼쪽에서 pane 을 고르면 여기에 그 터미널이 붙는다.
              </p>
            </div>
          ) : (
            <TerminalView
              state={state.terminal}
              title={
                selectedPane === null
                  ? (state.terminal.paneId ?? '')
                  : `${selectedPane.title}  ${selectedPane.paneId}`
              }
              subtitle={
                selectedPane === null
                  ? '이 pane 은 더 이상 없다 — 마지막 화면'
                  : `${selectedWorkspace?.label ?? selectedPane.workspaceId} · ${selectedPane.agentStatus}${
                      selectedPane.agent === null ? '' : ` · ${selectedPane.agent}`
                    }`
              }
            />
          )}
        </main>
      </div>

      {confirm !== null && (
        <ConfirmCloseDialog
          confirm={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void requestClose(confirm.tabId, true)}
        />
      )}

      <footer className="statusbar">
        {state.diagnostics && <SecurityProbe />}
        {notice !== null && (
          <span className="warn" data-notice="lifecycle">
            {notice}
          </span>
        )}
        {state.link.lastError !== null && <span className="warn">{state.link.lastError}</span>}
      </footer>
    </div>
  )
}

/**
 * 되돌릴 수 없는 종료 앞의 한 걸음 (N6).
 *
 * `window.confirm` 을 쓰지 않는다 — 그건 렌더러의 자바스크립트를 통째로 멈추는 모달이라
 * 스크린샷도 계측 채널도 같이 멈춘다. 화면 안에 그리면 무엇을 물었는지가 그림으로 남는다.
 */
function ConfirmCloseDialog({
  confirm,
  onCancel,
  onConfirm,
}: {
  confirm: ConfirmClose
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <div className="modal-veil" data-modal="close-confirm">
      <div className="modal">
        <p className="modal-title">이 행을 종료할까</p>
        <p className="modal-body">
          <span className="mono">{confirm.tabId}</span> 에서 <b>{confirm.running.join(', ')}</b> 가 돌고 있다.
          종료하면 셸과 그 프로세스가 함께 죽는다 — 되돌릴 수 없다.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" data-confirm="cancel" onClick={onCancel}>
            취소
          </button>
          <button type="button" className="btn btn-danger" data-confirm="close" onClick={onConfirm}>
            종료한다
          </button>
        </div>
      </div>
    </div>
  )
}

/** 트리 아래로 함께 흐르는 LIFE-346 프롭 묶음. 층마다 따로 적지 않으려고 한 덩어리로 둔다. */
type LifecycleProps = {
  lifecycle: LifecycleState
  launchKinds: string[]
  onCreate: (workspaceId: string, kind: string) => void
  onClose: (tabId: string) => void
}

function RepoGroup({
  group,
  selectedPaneId,
  collapsedIds,
  now,
  ...life
}: {
  group: RepoGroupRow
  selectedPaneId: string | null
  collapsedIds: string[]
  now: number
} & LifecycleProps): React.JSX.Element {
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
          collapsedIds={collapsedIds}
          now={now}
          {...life}
        />
      ))}
      {loose.map((workspace) => (
        <div key={workspace.workspaceId} className="worktree">
          <WorkspaceBody
            workspace={workspace}
            selectedPaneId={selectedPaneId}
            collapsed={collapsedIds.includes(workspace.workspaceId)}
            now={now}
            {...life}
          />
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
  collapsedIds,
  now,
  ...life
}: {
  worktree: WorktreeRow
  workspace: WorkspaceRow | null
  selectedPaneId: string | null
  collapsedIds: string[]
  now: number
} & LifecycleProps): React.JSX.Element {
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
        <WorkspaceBody
          workspace={workspace}
          selectedPaneId={selectedPaneId}
          collapsed={collapsedIds.includes(workspace.workspaceId)}
          now={now}
          {...life}
        />
      )}
    </div>
  )
}

/**
 * L8 — worktree 에 세션(탭)이 여럿이면 `N agents` 한 줄로 묶어 접을 수 있게 한다 (Orca 와 같은 모양).
 * 접힘은 **corral 로컬 상태**다 — herdr 에 저장하지 않는다(저장할 자리도 없고, 화면 취향이다).
 */
function WorkspaceBody({
  workspace,
  selectedPaneId,
  collapsed,
  now,
  lifecycle,
  launchKinds,
  onCreate,
  onClose,
}: {
  workspace: WorkspaceRow
  selectedPaneId: string | null
  collapsed: boolean
  now: number
} & LifecycleProps): React.JSX.Element {
  const groupable = workspace.tabs.length >= 2
  // 선택된 pane 이 이 안에 있으면 접혀 있어도 펼쳐 보인다 — 고른 것이 화면에서 사라지면 안 된다.
  const holdsSelection =
    selectedPaneId !== null && workspace.tabs.some((tab) => tab.panes.some((pane) => pane.paneId === selectedPaneId))
  const hidden = groupable && collapsed && !holdsSelection
  const agents = workspace.tabs.filter((tab) => tab.panes.some((pane) => pane.agent !== null)).length

  return (
    <>
      <div className="worktree-sub">
        {workspace.workspaceId} · {workspace.label} · tab {workspace.tabCount} · pane {workspace.paneCount}
      </div>
      {groupable && (
        <button
          type="button"
          className="agents-toggle"
          onClick={() => void window.corral.toggleCollapse(workspace.workspaceId)}
        >
          {workspace.tabs.length} {agents > 0 ? `agents (${agents} 붙음)` : 'agents'} {hidden ? '⌄' : '⌃'}
        </button>
      )}
      {!hidden && (
        <ul className="list tabs">
          {workspace.tabs.map((tab) => (
            <TabItem
              key={tab.tabId}
              tab={tab}
              selectedPaneId={selectedPaneId}
              now={now}
              launch={lifecycle.launches.find((item) => item.tabId === tab.tabId) ?? null}
              closing={lifecycle.closings.find((item) => item.tabId === tab.tabId) ?? null}
              onClose={onClose}
            />
          ))}
          {/* 아직 탭이 안 생긴 기동 — **행이 생기기 전에도 무슨 일이 벌어지는지 보인다** */}
          {lifecycle.launches
            .filter((item) => item.tabId === null && item.workspaceId === workspace.workspaceId)
            .map((item) => (
              <li key={item.launchId}>
                <div className="row row-head row-pending" data-launch={item.launchId}>
                  <span className="row-title">
                    <span className="dot" />
                    <span className="pane-title">{item.kind}</span>
                    <LaunchBadge launch={item} />
                  </span>
                  <span className="row-sub">탭을 만드는 중</span>
                </div>
              </li>
            ))}
        </ul>
      )}
      {!hidden && (
        <RowLauncher workspaceId={workspace.workspaceId} launchKinds={launchKinds} onCreate={onCreate} />
      )}
    </>
  )
}

/**
 * 새 행 만들기. `+ 새 행` 을 누르면 시작 커맨드 4종이 펼쳐지고, 하나를 고르면 곧바로 만든다.
 *
 * cwd 를 묻지 않는다 — 그 workspace 가 열고 있는 worktree 에서 여는 것이 기본이고(A4),
 * 다른 곳에서 열고 싶다는 요구는 이 일감의 범위 밖이다(worktree·workspace 생성은 Step 4).
 * 이름도 묻지 않는다: herdr 가 탭 번호를 라벨로 붙이고, 행의 정체는 **무엇이 도는가**로
 * 드러난다 — 만들기 전에 사람이 지어내는 이름보다 그쪽이 정확하다.
 */
function RowLauncher({
  workspaceId,
  launchKinds,
  onCreate,
}: {
  workspaceId: string
  launchKinds: string[]
  onCreate: (workspaceId: string, kind: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="launcher">
      <button
        type="button"
        className="agents-toggle"
        data-new-row={workspaceId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '새 행 ⌃' : '+ 새 행'}
      </button>
      {open && (
        <div className="kinds" data-kinds={workspaceId}>
          {launchKinds.map((kind) => (
            <button
              type="button"
              key={kind}
              className="btn btn-kind"
              data-launch-kind={`${workspaceId}:${kind}`}
              onClick={() => {
                setOpen(false)
                onCreate(workspaceId, kind)
              }}
            >
              {kind}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 기동의 단계를 그대로 적는다 (N2).
 *
 * **`launching` 을 "떴다" 로 그리지 않는 것이 이 배지의 전부다.** `agent.start` 는 106ms 만에
 * `launch_pending:true` 로 돌아오고, grok 은 그로부터 5초 뒤에 실제로 뜬다. 그 사이를 정직하게
 * 쓰지 않으면 화면이 앞서 나간 거짓말을 한다.
 */
function LaunchBadge({ launch }: { launch: LaunchRow }): React.JSX.Element | null {
  if (launch.phase === 'running') return null
  const label =
    launch.phase === 'creating'
      ? '만드는 중'
      : launch.phase === 'starting'
        ? launch.busyRetries > 0
          ? `셸 기다리는 중 (재시도 ${launch.busyRetries})`
          : '거는 중'
        : launch.phase === 'launching'
          ? `${launch.kind} 기동 중`
          : `${launch.kind} 기동 실패`
  return (
    <em
      className={launch.phase === 'failed' ? 'tag tag-stopped' : 'tag tag-launching'}
      data-launch-phase={launch.phase}
      title={launch.error ?? ''}
    >
      {label}
    </em>
  )
}

/**
 * 탭 한 줄 = Orca 의 터미널 한 줄. pane 이 하나면 이 줄이 곧 그 pane 이고(눌러서 고른다),
 * **2개 이상일 때만** 아래로 pane 을 펼친다.
 */
function TabItem({
  tab,
  selectedPaneId,
  now,
  launch,
  closing,
  onClose,
}: {
  tab: TabRow
  selectedPaneId: string | null
  now: number
  launch: LaunchRow | null
  closing: ClosingRow | null
  onClose: (tabId: string) => void
}): React.JSX.Element {
  const only = tab.panes.length === 1 ? (tab.panes[0] ?? null) : null
  const split = tab.panes.length >= 2
  const selected = only !== null && only.paneId === selectedPaneId
  const title = only?.title ?? tab.label
  // 스플릿이면 그 탭 안에서 가장 최근에 바뀐 pane 의 시각을 쓴다.
  const changedAt =
    only?.changedAt ??
    tab.panes.reduce<number | null>(
      (best, pane) => (pane.changedAt === null ? best : best === null ? pane.changedAt : Math.max(best, pane.changedAt)),
      null,
    )
  const head = (
    <span className="row-title">
      <span className={`dot dot-${only?.agentStatus ?? tab.agentStatus}`} />
      {only?.agent != null && <em className="glyph">{agentGlyph(only.agent)}</em>}
      <span className="pane-title">{title}</span>
      {split && <em className="tag">pane {tab.panes.length}</em>}
      {launch !== null && <LaunchBadge launch={launch} />}
      {/* A1 — 종료는 실측 ~0.65초가 걸린다. 그 동안 화면이 멈춘 것처럼 보이면 안 된다. */}
      {closing?.phase === 'closing' && (
        <em className="tag tag-launching" data-closing={tab.tabId}>
          종료 중…
        </em>
      )}
      {closing?.phase === 'failed' && (
        <em className="tag tag-stopped" data-close-failed={tab.tabId} title={closing.error ?? ''}>
          종료 거절됨
        </em>
      )}
      <span className="row-age">{elapsed(changedAt, now)}</span>
    </span>
  )
  const sub = (
    <span className="row-sub">
      {tab.tabId}
      {only !== null ? ` · ${only.paneId} · ${only.agentStatus}` : ` · 스플릿 ${tab.panes.length}`}
      {launch?.phase === 'failed' && launch.error !== null ? ` · ${launch.error}` : ''}
    </span>
  )
  // 종료 버튼은 선택 버튼 **옆**에 둔다 — 버튼 안에 버튼을 넣을 수 없고, 무엇보다
  // "고르기" 와 "죽이기" 가 한 과녁을 공유하면 안 된다.
  const closeButton = (
    <button
      type="button"
      className="row-x"
      data-close-tab={tab.tabId}
      title="이 행을 종료한다"
      disabled={closing?.phase === 'closing'}
      onClick={() => onClose(tab.tabId)}
    >
      ×
    </button>
  )
  return (
    <li>
      <div className="row-line">
        {only === null ? (
          <div className="row row-head">
            {head}
            {sub}
          </div>
        ) : (
          <button
            type="button"
            className={selected ? 'row row-on' : 'row'}
            data-select-pane={only.paneId}
            onClick={() => void window.corral.selectPane(selected ? null : only.paneId)}
          >
            {head}
            {sub}
          </button>
        )}
        {closeButton}
      </div>
      {split && (
        <ul className="list panes">
          {tab.panes.map((pane) => (
            <PaneItem key={pane.paneId} pane={pane} selected={pane.paneId === selectedPaneId} now={now} />
          ))}
        </ul>
      )}
    </li>
  )
}

function PaneItem({
  pane,
  selected,
  now,
}: {
  pane: PaneRow
  selected: boolean
  now: number
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={selected ? 'row pane-row row-on' : 'row pane-row'}
        onClick={() => void window.corral.selectPane(selected ? null : pane.paneId)}
      >
        {/* Orca 의 행 배치 그대로: [상태 점][에이전트][제목] … [우측 경과] */}
        <span className="row-title">
          <span className={`dot dot-${pane.agentStatus}`} />
          {pane.agent !== null && <em className="glyph">{agentGlyph(pane.agent)}</em>}
          <span className="pane-title">{pane.title}</span>
          <span className="row-age">{elapsed(pane.changedAt, now)}</span>
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
