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
  const [notice, setNotice] = useState<string | null>(null)
  /** 모달이 떠 있나 · 모달 안에 붙는 결과 줄 (0개일 때는 모달을 안 닫고 여기 적는다). */
  const [modalOpen, setModalOpen] = useState(false)
  const [modalNote, setModalNote] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    void window.corral.getState().then(setState)
    return window.corral.onState(setState)
  }, [])

  /**
   * ESC 로 닫는다 — **문서에 건다.** 모달 `div` 의 `onKeyDown` 은 그 안에 포커스가 있어야만
   * 불리는데, 모달을 연 직후 포커스는 아직 버튼에 있다. 계측도 사람도 같은 자리를 지난다.
   */
  useEffect(() => {
    if (!modalOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setModalOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modalOpen])

  // 렌더가 실제로 끝난 revision 을 main 로그에 남긴다 — 반영 지연(A1)의 화면 쪽 끝점이다.
  const lastReported = useRef(-1)
  useEffect(() => {
    if (state === null || state.revision === lastReported.current) return
    lastReported.current = state.revision
    window.corral.reportRendered(state.revision)
  })

  if (state === null) return <div className="boot">부트스트랩…</div>

  /**
   * 「폴더 찾아보기」 — 네이티브 폴더 선택기는 **main 이 연다** (경계 규칙: 렌더러는 dialog 를
   * 모른다). 여기서 하는 일은 IPC 한 번과 그 결과를 화면에 옮기는 것뿐이다.
   *
   * 결과 처리는 세 갈래다: 하나라도 등록됐으면 모달을 닫고 위쪽 알림으로, 하나도 못 찾았으면
   * **모달을 연 채** 그 안에 적고(다시 고를 수 있게), 취소면 아무 말도 안 한다.
   */
  const browse = async (): Promise<void> => {
    setBrowsing(true)
    setModalNote(null)
    try {
      const result = await window.corral.browseForRepos()
      if (result.canceled) return
      if (result.added.length > 0 || result.alreadyRegistered.length > 0) {
        setModalOpen(false)
        setNotice(result.message)
        return
      }
      setModalNote(result.message)
    } finally {
      setBrowsing(false)
    }
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
            push 유실 주입 중
          </span>
        ) : null}
        {state.diagnostics ? (
          <span className="meta" data-revision>
            rev {state.revision}
          </span>
        ) : null}
      </header>

      <section className="add" data-add-repo-row>
        <button className="primary" data-add-repo onClick={() => setModalOpen(true)}>
          레포 추가
        </button>
        {notice === null ? null : (
          <span className="notice" data-add-notice>
            {notice}
          </span>
        )}
      </section>

      {modalOpen ? (
        <AddRepoModal
          browsing={browsing}
          note={modalNote}
          onBrowse={() => void browse()}
          onClose={() => setModalOpen(false)}
        />
      ) : null}

      <main className="list">
        {state.repos.length === 0 ? (
          <p className="empty" data-empty>
            등록된 레포가 없다. 위의 「레포 추가」 로 폴더를 고른다.
          </p>
        ) : (
          state.repos.map((repo) => <Repo key={repo.root} repo={repo} />)
        )}
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

/**
 * 레포 추가 모달 (게이트 ① 2번째 지시, 2026-09-12).
 *
 * R1 에 있는 항목은 **「폴더 찾아보기」 하나뿐**이다. 지시 (4) 가 호스트 셀렉터·URL 복제·
 * 새 프로젝트 만들기를 R1 범위 밖으로 잘랐다 — 자리만 비워 두지 말고 아예 안 만든다.
 */
function AddRepoModal({
  browsing,
  note,
  onBrowse,
  onClose,
}: {
  browsing: boolean
  note: string | null
  onBrowse: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="modal-scrim" data-modal-scrim onClick={onClose}>
      {/* 창 안쪽 클릭은 닫기로 안 샌다. 닫는 길은 X 와 ESC 두 개다 (지시 (1)). */}
      <div className="modal" data-add-repo-modal onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title" data-modal-title>
            레포 추가
          </h2>
          <button className="modal-close" data-modal-close aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <button className="modal-item" data-browse-folder disabled={browsing} onClick={onBrowse}>
          <span className="modal-item-name">폴더 찾아보기</span>
          <span className="modal-item-hint">로컬 Git 레포 또는 레포가 많은 폴더</span>
        </button>
        {note === null ? null : (
          <p className="modal-note" data-browse-result>
            {note}
          </p>
        )}
      </div>
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
