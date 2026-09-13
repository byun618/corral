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
import type { AgentKind, AgentStatus, AppState, PaneRow, RepoRow, TabRow, WorkspaceRow, WorktreeRow } from '../../shared/types.js'
import { TerminalPane } from './TerminalPane.js'

/** 제거 확인 문구의 두 번째 줄. **여기 한 자리에만** 둔다 — 계측이 대조하는 것도 이 문자열이다. */
const REMOVE_DISCLAIMER = '제거는 corral 목록에서만 빠진다 — 디스크의 폴더도, herdr 세션도 건드리지 않는다.'

/**
 * **에이전트 즉시 기동** 버튼 (게이트 ① G1). `+`(빈 탭)와 달리 누르는 즉시 그 에이전트를 띄운다
 * (`tab.create` + `agent.start`) — L1/L2 검증 자산(생성+기동 배선)을 유지한다. 빈 탭(셸,
 * `tab.create` 만)은 아래 `+` 버튼이 `kind:'shell'` 로 만든다. data-kind 값은 불변(하네스 계약).
 */
const AGENT_KINDS: Array<{ kind: AgentKind; label: string }> = [
  { kind: 'claude', label: 'claude' },
  { kind: 'codex', label: 'codex' },
  { kind: 'grok', label: 'grok' },
]

/**
 * 화면에 올리는 라이프사이클 동작 묶음 — Repo→Worktree→Workspace→Tab 으로 내려간다.
 * 한 객체로 묶어 내려서 컴포넌트마다 손잡이를 하나씩 늘어놓지 않는다 (관심사: 트리는 그리기,
 * 동작은 App 이 IPC 로).
 */
/** 닫기 대상 — 행(탭) 또는 worktree(workspace). 확인 모달과 IPC 갈래를 이걸로 가른다. */
type CloseTarget = { kind: 'tab'; tabId: string } | { kind: 'workspace'; workspaceId: string }

type LifecycleActions = {
  createRow: (workspaceId: string, kind: AgentKind) => void
  closeRow: (tabId: string) => void
  closeWorktree: (workspaceId: string) => void
  openWorktree: (repoRoot: string, worktree: WorktreeRow) => void
  openCreateWorktree: (repoRoot: string) => void
}

/** 화면 상단에 그대로 뜨는 라이프사이클 알림 (거절·실패·안내). L9 거절은 여기서 멈춘다. */
type LifecycleNotice =
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'info'; message: string } // 게이트 ① G4: 부모 함께 열림 같은 안내 한 줄

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
  /** 제거 확인을 띄운 레포. null 이면 확인 창이 없다. */
  const [pendingRemove, setPendingRemove] = useState<RepoRow | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  /** 터미널로 보고 있는 pane (R2). 선택은 렌더러의 상태고, 스트림 수명은 main 이 쥔다. */
  const [selectedPane, setSelectedPane] = useState<string | null>(null)
  /** 종료 확인 모달 (L4). 산 프로세스가 있을 때만. null 이면 확인 없이 이미 닫혔거나 닫을 게 없다. */
  const [pendingClose, setPendingClose] = useState<{ target: CloseTarget; foreground: string[] } | null>(null)
  /** 라이프사이클 거절·실패 알림 (L9 포함). 그대로 보이고 멈춘다. */
  const [lifecycleNotice, setLifecycleNotice] = useState<LifecycleNotice | null>(null)
  /** worktree 만들기 모달 (L7). null 이면 닫힘. */
  const [worktreeModal, setWorktreeModal] = useState<{ repoRoot: string } | null>(null)
  /**
   * 열기 in-flight 경로 (수정 1회차 M5). 같은 worktree 를 두 번 눌러도 두 번째는 무시한다 —
   * ref 라 같은 틱의 더블클릭도 잡는다 (state 는 리렌더 전이라 놓친다). main 도 같은 가드가 있어
   * 이건 방어의 앞선(빠른) 층이다.
   */
  const openingWorktrees = useRef<Set<string>>(new Set())
  /**
   * 마지막으로 상호작용한 workspace (게이트 ① G2 ⌘T 대상). "선택(포커스)" = 탭을 보는 것 →
   * 탭 생성·pane 선택 때 갱신한다. ref 라 키 핸들러가 최신값을 스테일 없이 읽는다. null 이면 no-op.
   */
  const lastWorkspaceRef = useRef<string | null>(null)

  useEffect(() => {
    void window.corral.getState().then(setState)
    return window.corral.onState(setState)
  }, [])

  /**
   * ⌘T (mac) / Ctrl+T — 선택/최근 workspace 에 **빈 탭** (게이트 ① G2). 대상이 없으면 no-op.
   * `+ 빈 탭` 클릭과 같은 경로(`createRow` kind:'shell' = tab.create 만)다. 문서에 걸어 포커스와
   * 무관하게 받는다. 기본 동작(있으면)은 막는다.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || (event.key !== 't' && event.key !== 'T')) return
      event.preventDefault()
      const workspaceId = lastWorkspaceRef.current
      if (workspaceId === null) return // 선택/최근 workspace 없음 → 무시
      setLifecycleNotice(null)
      void window.corral.createRow({ workspaceId, kind: 'shell' }).then((result) => {
        if (!result.ok) setLifecycleNotice({ kind: 'error', message: result.error ?? '탭 생성 실패' })
      })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
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

  /** 제거 확인도 같은 자리에서 ESC 로 닫는다 — 포커스가 어디에 있든 (위 주석과 같은 이유). */
  useEffect(() => {
    if (pendingRemove === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPendingRemove(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pendingRemove])

  /** 종료 확인 모달도 ESC 로 닫는다 (취소와 같다 — 행은 산다). */
  useEffect(() => {
    if (pendingClose === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPendingClose(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pendingClose])

  /** worktree 만들기 모달도 ESC 로 닫는다. */
  useEffect(() => {
    if (worktreeModal === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setWorktreeModal(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [worktreeModal])

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

  /**
   * 확인 창에서 「제거」를 누른 뒤 (게이트 ① 3번째 지시).
   *
   * 여기서 하는 일은 IPC 한 번이다 — 목록은 main 이 새 상태를 밀면 저절로 다시 그려진다.
   * 실패하면 창을 **닫지 않고** 그 안에 사유를 적는다. 조용히 닫히면 뺐는지 아닌지 모른다.
   */
  const removeRepo = async (repo: RepoRow): Promise<void> => {
    setRemoveError(null)
    const result = await window.corral.removeRepo(repo.root)
    if (!result.ok) {
      setRemoveError(result.error ?? '알 수 없음')
      return
    }
    setPendingRemove(null)
  }

  /**
   * 닫는다 (L3·L4·L9). `confirmed:false` 로 부르면 main 이 종료 게이트를 재고, 산 프로세스가
   * 있으면 `needs-confirm` 으로 돌아온다 — 그때만 모달을 띄운다. 셸만 있으면 바로 `closed` 라
   * 모달이 없다 (L3 오탐 0). `rejected` (L9)는 그대로 보이고 멈춘다 — corral 이 승격하지 않는다.
   */
  const closeTarget = async (target: CloseTarget, confirmed = false): Promise<void> => {
    setLifecycleNotice(null)
    const result =
      target.kind === 'tab'
        ? await window.corral.closeRow({ tabId: target.tabId, confirmed })
        : await window.corral.closeWorktree({ workspaceId: target.workspaceId, confirmed })
    switch (result.outcome) {
      case 'closed':
        setPendingClose(null)
        return
      case 'needs-confirm':
        setPendingClose({ target, foreground: result.foreground })
        return
      case 'rejected':
        setPendingClose(null)
        setLifecycleNotice({ kind: 'rejected', code: result.rejection.code, message: result.rejection.message })
        return
      case 'error':
        setPendingClose(null)
        setLifecycleNotice({ kind: 'error', message: result.error })
        return
    }
  }

  const createRow = async (workspaceId: string, kind: AgentKind): Promise<void> => {
    lastWorkspaceRef.current = workspaceId // G2: 상호작용한 workspace 를 ⌘T 대상으로 기록
    setLifecycleNotice(null)
    const result = await window.corral.createRow({ workspaceId, kind })
    if (!result.ok) setLifecycleNotice({ kind: 'error', message: result.error ?? '탭 생성 실패' })
    // 성공이면 store push 로 탭이 나타난다 — 여기서 목록을 만지지 않는다.
  }

  /** 탭(pane) 선택 — 터미널을 그 pane 으로. G2: 그 pane 의 workspace 를 ⌘T 대상으로 기록한다. */
  const selectPane = (paneId: string): void => {
    setSelectedPane(paneId)
    const ws = state.repos
      .flatMap((repo) => repo.worktrees)
      .map((worktree) => worktree.workspace)
      .find((workspace) => workspace?.tabs.some((tab) => tab.panes.some((pane) => pane.paneId === paneId)))
    if (ws) lastWorkspaceRef.current = ws.workspaceId
  }

  const openWorktree = async (repoRoot: string, worktree: WorktreeRow): Promise<void> => {
    // in-flight 재클릭 무시 (M5) — 진행 중이면 두 번째는 아무것도 안 한다 (고아 workspace 방지).
    if (openingWorktrees.current.has(worktree.path)) return
    openingWorktrees.current.add(worktree.path)
    setLifecycleNotice(null)
    try {
      const result = await window.corral.openWorktree({ repoRoot, path: worktree.path, isLinked: worktree.isLinked })
      if (result.rejection) setLifecycleNotice({ kind: 'rejected', code: result.rejection.code, message: result.rejection.message })
      // `deduped` (양성 중복 — 이미 여는 중) 는 알림으로 띄우지 않는다 (F-2: 문자열 비교 대신 필드).
      else if (!result.ok && !result.deduped) setLifecycleNotice({ kind: 'error', message: result.error ?? '열기 실패' })
      // G4: linked 를 열며 부모(main workspace)가 함께 열렸으면 안내 한 줄 (herdr 부모 필수 제약, P3).
      else if (result.ok && result.parentOpened)
        setLifecycleNotice({ kind: 'info', message: 'main workspace 를 함께 열었습니다 (herdr 제약)' })
    } finally {
      openingWorktrees.current.delete(worktree.path)
    }
  }

  const actions: LifecycleActions = {
    createRow: (workspaceId, kind) => void createRow(workspaceId, kind),
    closeRow: (tabId) => void closeTarget({ kind: 'tab', tabId }),
    closeWorktree: (workspaceId) => void closeTarget({ kind: 'workspace', workspaceId }),
    openWorktree: (repoRoot, worktree) => void openWorktree(repoRoot, worktree),
    openCreateWorktree: (repoRoot) => {
      setLifecycleNotice(null)
      setWorktreeModal({ repoRoot })
    },
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

      {lifecycleNotice === null ? null : (
        <div
          className={`lifecycle-notice ${lifecycleNotice.kind}`}
          data-lifecycle-notice
          data-notice-kind={lifecycleNotice.kind}
          data-notice-code={lifecycleNotice.kind === 'rejected' ? lifecycleNotice.code : ''}
        >
          <span className="lifecycle-notice-text">
            {lifecycleNotice.kind === 'rejected'
              ? `herdr 거절 (${lifecycleNotice.code}): ${lifecycleNotice.message}`
              : lifecycleNotice.kind === 'info'
                ? lifecycleNotice.message
                : `실패: ${lifecycleNotice.message}`}
          </span>
          <button className="lifecycle-notice-close" data-notice-dismiss aria-label="닫기" onClick={() => setLifecycleNotice(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="content">
        <main className="list">
          {state.repos.length === 0 ? (
            <p className="empty" data-empty>
              등록된 레포가 없다. 위의 「레포 추가」 로 폴더를 고른다.
            </p>
          ) : (
            state.repos.map((repo) => (
              <Repo
                key={repo.root}
                repo={repo}
                actions={actions}
                selectedPane={selectedPane}
                onSelectPane={selectPane}
                onRemove={() => {
                  setRemoveError(null)
                  setPendingRemove(repo)
                }}
              />
            ))
          )}
        </main>
        <TerminalPanel state={state} selectedPane={selectedPane} />
      </div>

      {pendingRemove === null ? null : (
        <ConfirmRemove
          repo={pendingRemove}
          error={removeError}
          onConfirm={() => void removeRepo(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      {pendingClose === null ? null : (
        <ConfirmClose
          target={pendingClose.target}
          foreground={pendingClose.foreground}
          onConfirm={() => void closeTarget(pendingClose.target, true)}
          onCancel={() => setPendingClose(null)}
        />
      )}

      {worktreeModal === null ? null : (
        <CreateWorktreeModal
          repoRoot={worktreeModal.repoRoot}
          onClose={() => setWorktreeModal(null)}
          onDone={(message) => {
            setWorktreeModal(null)
            setNotice(message)
          }}
        />
      )}

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

/**
 * 제거 확인 (게이트 ① 3번째 지시, 2026-09-12).
 *
 * 문구에 **이름과 루트 경로를 둘 다** 싣는다 — 이름만으로는 모자란다: 같은 basename 을 가진
 * 레포 둘을 등록해 두면 (`~/a/corral` 과 `~/b/corral`) 어느 쪽을 빼는지 확인 창이 말을 못 한다.
 *
 * 그리고 **무엇을 안 하는지**를 적는다. 이 버튼이 폴더를 지우거나 herdr 세션을 닫는다고
 * 오해하면 사람은 누르지 못한다. 안 하는 일을 적어 주는 것이 확인 단계의 값이다.
 */
function ConfirmRemove({
  repo,
  error,
  onConfirm,
  onCancel,
}: {
  repo: RepoRow
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="modal-scrim" data-modal-scrim onClick={onCancel}>
      <div className="modal" data-confirm-remove={repo.root} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title" data-confirm-title>
            레포 제거
          </h2>
          <button className="modal-close" data-confirm-close aria-label="닫기" onClick={onCancel}>
            ✕
          </button>
        </div>
        <p className="confirm-body">
          <span className="confirm-name" data-confirm-name>
            {repo.name}
          </span>
          <span className="path-hint" data-confirm-root>
            {repo.root}
          </span>
        </p>
        <p className="confirm-note" data-confirm-note>
          {REMOVE_DISCLAIMER}
        </p>
        {error === null ? null : (
          <p className="modal-note" data-confirm-error>
            빼지 못했다: {error}
          </p>
        )}
        <div className="confirm-actions">
          <button className="ghost" data-confirm-cancel onClick={onCancel}>
            취소
          </button>
          <button className="danger" data-confirm-ok onClick={onConfirm}>
            제거
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 종료 확인 (L4). **산 프로세스가 있을 때만** 뜬다 — 셸만 있는 행은 이 모달 없이 즉시 닫힌다.
 *
 * 판별자는 herdr `pane.process_info` 의 포그라운드 프로세스 그룹이고, 그 판정은 main 이 종료
 * 직전에 뜬다 (App 은 결과만 받는다). 무엇이 도는지를 그대로 보여 사람이 근거를 보고 정한다.
 * 취소는 무해(행 생존), 승인은 닫힌다. `window.confirm` 이 아니다 — 그건 렌더러(와 계측 채널)를
 * 얼린다 (LIFE-346 결정).
 */
function ConfirmClose({
  target,
  foreground,
  onConfirm,
  onCancel,
}: {
  target: CloseTarget
  foreground: string[]
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const what = target.kind === 'tab' ? '이 탭을' : '이 worktree 를'
  return (
    <div className="modal-scrim" data-modal-scrim onClick={onCancel}>
      <div className="modal" data-confirm-close-modal data-confirm-close-kind={target.kind} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title" data-confirm-close-title>
            {what} 닫을까
          </h2>
          <button className="modal-close" data-confirm-close-x aria-label="닫기" onClick={onCancel}>
            ✕
          </button>
        </div>
        <p className="confirm-note">포그라운드에 도는 프로세스가 있다. 닫으면 같이 종료된다.</p>
        <ul className="confirm-fg" data-confirm-close-fg>
          {foreground.map((item, index) => (
            <li key={index} className="path-hint">
              {item}
            </li>
          ))}
        </ul>
        <div className="confirm-actions">
          <button className="ghost" data-close-confirm-cancel onClick={onCancel}>
            취소
          </button>
          <button className="danger" data-close-confirm-ok onClick={onConfirm}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * worktree 만들기 (L7). **OS 다이얼로그가 아니라 텍스트 입력**으로 branch·path 를 받는다 —
 * 네이티브 폴더 선택기는 만들 폴더가 아직 없으니 애초에 맞지 않고, 텍스트 입력이면 계측이
 * 그 경로로 지나간다 (스텁 불필요).
 *
 * path 는 branch 를 건드릴 때마다 `<repoRoot>/.claude/worktrees/<branch>` 로 따라 채운다 (G6) —
 * 사람이 path 를 직접 만지기 전까지만(수동 우선). 프로젝트 규약대로 worktree 는 레포의
 * `.claude/worktrees/` 아래 형제 폴더에 둔다 — 그 위치를 기본값으로 준다. 빈 branch 면 그 폴더까지만.
 */
function CreateWorktreeModal({
  repoRoot,
  onClose,
  onDone,
}: {
  repoRoot: string
  onClose: () => void
  onDone: (message: string) => void
}): React.JSX.Element {
  const worktreesDir = `${repoRoot}/.claude/worktrees`
  // 슬래시 등은 평탄화한다 — worktree 는 .claude/worktrees/ 아래 형제 폴더(중첩 금지, AGENTS.md).
  const derivePath = (branch: string): string => {
    const slug = branch.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    return slug.length === 0 ? `${worktreesDir}/` : `${worktreesDir}/${slug}`
  }

  const [branch, setBranch] = useState('')
  const [pathValue, setPathValue] = useState('')
  const [pathEdited, setPathEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const effectivePath = pathEdited ? pathValue : derivePath(branch)

  const submit = async (): Promise<void> => {
    if (branch.trim().length === 0) {
      setNote('branch 이름을 넣어라')
      return
    }
    setBusy(true)
    setNote(null)
    try {
      const result = await window.corral.createWorktree({ repoRoot, branch: branch.trim(), path: effectivePath })
      if (result.ok) {
        onDone(`worktree 만듦: ${branch.trim()}`)
        return
      }
      if (result.rejection) setNote(`herdr 거절 (${result.rejection.code}): ${result.rejection.message}`)
      else setNote(`실패: ${result.error ?? '알 수 없음'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" data-modal-scrim onClick={onClose}>
      <div className="modal" data-create-worktree-modal onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">worktree 만들기</h2>
          <button className="modal-close" data-create-worktree-close aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <label className="field">
          <span className="field-label">branch</span>
          <input
            className="field-input"
            data-worktree-branch-input
            value={branch}
            placeholder="예: feature/foo"
            onChange={(event) => setBranch(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">path</span>
          <input
            className="field-input"
            data-worktree-path-input
            value={effectivePath}
            onChange={(event) => {
              setPathEdited(true)
              setPathValue(event.target.value)
            }}
          />
        </label>
        {note === null ? null : (
          <p className="modal-note" data-worktree-create-note>
            {note}
          </p>
        )}
        <div className="confirm-actions">
          <button className="ghost" data-create-worktree-cancel onClick={onClose}>
            취소
          </button>
          <button className="primary" data-worktree-create-submit disabled={busy} onClick={() => void submit()}>
            만들기
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 터미널 패널 (R2) — 선택된 pane 의 라이브 화면.
 *
 * **pane 이 목록에서 사라지면 뷰도 내린다.** main 은 이미 스트림을 닫았다 (stream.pane_gone) —
 * 여기서 TerminalPane 을 언마운트하지 않으면 죽은 pane 의 마지막 프레임이 산 것처럼 남는다.
 */
function TerminalPanel({ state, selectedPane }: { state: AppState; selectedPane: string | null }): React.JSX.Element {
  const paneIds = new Set(
    state.repos.flatMap((repo) =>
      repo.worktrees.flatMap((worktree) =>
        worktree.workspace === null
          ? []
          : worktree.workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.paneId)),
      ),
    ),
  )
  const alive = selectedPane !== null && paneIds.has(selectedPane)
  const terminal = state.terminal
  return (
    <section className="term-panel" data-term-panel>
      <div className="term-head" data-term-head>
        {alive ? (
          <>
            <span className="chip chip-id" data-term-pane-id>
              {selectedPane}
            </span>
            <span className={`chip term-phase-${terminal.phase}`} data-term-phase>
              {terminal.phase}
            </span>
            {terminal.cols === null ? null : (
              <span className="chip chip-count" data-term-size>
                {terminal.cols}×{terminal.rows}
              </span>
            )}
            {terminal.mouseReporting ? (
              <span className="chip" data-term-mouse>
                mouse
              </span>
            ) : null}
            {terminal.lastError === null ? null : (
              <span className="warn" data-term-error>
                {terminal.lastError}
              </span>
            )}
          </>
        ) : (
          <span className="meta">터미널 — 탭을 고르면 여기 뜬다</span>
        )}
      </div>
      {alive ? (
        <TerminalPane paneId={selectedPane} diagnostics={state.diagnostics} />
      ) : (
        <div className="term-empty" data-term-empty />
      )}
    </section>
  )
}

function Repo({
  repo,
  actions,
  selectedPane,
  onSelectPane,
  onRemove,
}: {
  repo: RepoRow
  actions: LifecycleActions
  selectedPane: string | null
  onSelectPane: (paneId: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const open = repo.worktrees.filter((item) => item.openWorkspaceId !== null).length
  return (
    <section className="repo" data-repo={repo.root}>
      <h2 className="repo-name">
        <span data-repo-name={repo.root}>{repo.name}</span>
        <span className="chip chip-count" data-chip-repo={repo.root}>
          worktree {repo.worktrees.length} · 열림 {open}
        </span>
        <span className="path-hint" title={repo.root}>{repo.root}</span>
        {/* 새 worktree 만들기 (L7). 텍스트 입력 모달을 연다. */}
        <button className="row-action" data-create-worktree={repo.root} title="새 worktree" onClick={() => actions.openCreateWorktree(repo.root)}>
          + worktree
        </button>
        {/*
          제거 손잡이. 지시는 "행 hover 시 제거 버튼 또는 컨텍스트 메뉴 — 구현 단순한 쪽" 이었고
          버튼을 골랐다. 다만 **쉼 상태에서도 보이게** 둔다(흐리게, hover 에서 또렷하게):
          `opacity:0` 으로 완전히 숨기면 `elementFromPoint` 는 여전히 그 버튼을 집어 주므로
          계측은 통과하는데 사람 눈에는 없는 버튼이 된다 — 관문 ⑤ 가 막으려는 바로 그 모양이다.
        */}
        <button className="row-remove" data-remove-repo={repo.root} title="목록에서 제거" onClick={onRemove}>
          제거
        </button>
      </h2>
      {repo.error === null ? null : (
        <p className="warn" data-repo-error={repo.root}>
          {repo.error}
        </p>
      )}
      {repo.worktrees.length === 0 ? (
        <p className="hint">worktree 를 못 읽었다.</p>
      ) : (
        repo.worktrees.map((worktree) => (
          <Worktree
            key={worktree.path}
            worktree={worktree}
            repoRoot={repo.root}
            actions={actions}
            selectedPane={selectedPane}
            onSelectPane={onSelectPane}
          />
        ))
      )}
    </section>
  )
}

function Worktree({
  worktree,
  repoRoot,
  actions,
  selectedPane,
  onSelectPane,
}: {
  worktree: WorktreeRow
  repoRoot: string
  actions: LifecycleActions
  selectedPane: string | null
  onSelectPane: (paneId: string) => void
}): React.JSX.Element {
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
        {/* 닫힌 worktree 는 여는 문(L6·L8), 열린 worktree 는 닫는 문(L9b). */}
        {isOpen ? (
          <button
            className="row-remove"
            data-close-worktree={worktree.path}
            data-close-workspace={worktree.openWorkspaceId ?? ''}
            title="worktree 닫기"
            onClick={() => worktree.openWorkspaceId !== null && actions.closeWorktree(worktree.openWorkspaceId)}
          >
            닫기
          </button>
        ) : (
          <button className="row-action" data-open-worktree={worktree.path} onClick={() => actions.openWorktree(repoRoot, worktree)}>
            열기
          </button>
        )}
        <span className="path-hint" title={worktree.path}>{worktree.path}</span>
      </div>
      {worktree.workspace === null ? null : (
        <Workspace workspace={worktree.workspace} actions={actions} selectedPane={selectedPane} onSelectPane={onSelectPane} />
      )}
    </div>
  )
}

function Workspace({
  workspace,
  actions,
  selectedPane,
  onSelectPane,
}: {
  workspace: WorkspaceRow
  actions: LifecycleActions
  selectedPane: string | null
  onSelectPane: (paneId: string) => void
}): React.JSX.Element {
  return (
    <div className="workspace" data-workspace={workspace.workspaceId}>
      <div className="workspace-head">
        <span className="ws-label">{workspace.label}</span>
        <span className="chip chip-id" data-workspace-id={workspace.workspaceId}>
          {workspace.workspaceId}
        </span>
        {/*
          새 탭 (L1·L2). 게이트 ① G1: **`+` 는 빈 탭(셸, tab.create 만)** 이 기본 — 그 안에서 사용자가
          직접 에이전트를 띄운다 (Orca 방식). 에이전트 버튼은 **즉시 기동** 경로로 남긴다 (L1 자산).
          data-create-row·data-kind 는 불변 — 계측이 좌표로 누르는 화면 계약이다 (G3: 워딩만 바꾼다).
        */}
        <span className="new-row" data-new-row={workspace.workspaceId}>
          <button
            className="row-action new-tab"
            data-create-row={workspace.workspaceId}
            data-kind="shell"
            title="빈 탭 (셸)"
            onClick={() => actions.createRow(workspace.workspaceId, 'shell')}
          >
            + 빈 탭
          </button>
          <span className="new-row-label">에이전트:</span>
          {AGENT_KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              className="row-action"
              data-create-row={workspace.workspaceId}
              data-kind={kind}
              title={`${label} 즉시 기동`}
              onClick={() => actions.createRow(workspace.workspaceId, kind)}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      {workspace.tabs.length === 0 ? (
        <p className="hint">탭 없음</p>
      ) : (
        workspace.tabs.map((tab) => (
          <Tab key={tab.tabId} tab={tab} actions={actions} selectedPane={selectedPane} onSelectPane={onSelectPane} />
        ))
      )}
    </div>
  )
}

function Tab({
  tab,
  actions,
  selectedPane,
  onSelectPane,
}: {
  tab: TabRow
  actions: LifecycleActions
  selectedPane: string | null
  onSelectPane: (paneId: string) => void
}): React.JSX.Element {
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
        {/* 탭 닫기 (L3·L4·L9a). main 이 종료 게이트를 재고, 산 프로세스가 있을 때만 모달이 뜬다. */}
        <button className="row-remove" data-close-tab={tab.tabId} title="탭 닫기" onClick={() => actions.closeRow(tab.tabId)}>
          닫기
        </button>
      </div>
      {tab.panes.map((pane) => (
        <Pane
          key={pane.paneId}
          pane={pane}
          selected={pane.paneId === selectedPane}
          onSelect={() => onSelectPane(pane.paneId)}
        />
      ))}
    </div>
  )
}

/**
 * pane 행 — 누르면 터미널이 이 pane 으로 붙는다 (R2). 행 전체가 손잡이다.
 * 버튼이 아니라 행 클릭인 이유: herdr·Orca 의 관습이 그렇고, 행 안의 칩은 정보지 조작이 아니다.
 */
function Pane({ pane, selected, onSelect }: { pane: PaneRow; selected: boolean; onSelect: () => void }): React.JSX.Element {
  return (
    <div className={`pane ${selected ? 'is-selected' : ''}`} data-pane={pane.paneId} onClick={onSelect}>
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
