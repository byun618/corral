// 화면 오케스트레이터 — `repo → worktree → tab → pane` 4단 데이터를 Orca 배치(사이드바 카드 +
// 메인 탭바 + 상태바)로 그린다 (LIFE-357, Orca 직접 포팅 브랜치). 트리는 그리기, 동작은 IPC 로
// 내려보내는 관심사 분리는 그대로 유지한다 — 이 파일이 하는 일은 데이터를 각 컴포넌트에 나눠
// 주는 것뿐이고, 라이프사이클 로직 자체는 `hooks/useLifecycleActions.ts` 에 있다(옛 App.tsx
// 65-287줄에서 옮김, 로직 불변).
//
// 계측이 누를 수 있게 손잡이마다 `data-*` 를 단다 — 선택자가 화면 계약이다 (C7 매핑표 참고).

import { useEffect, useRef, useState } from 'react'
import type { AppState, RepoRow as RepoRowData, TabRow, WorkspaceRow } from '../../shared/types.js'
import { AddRepoModal } from './components/AddRepoModal.js'
import { ConfirmClose } from './components/ConfirmClose.js'
import { CreateWorktreeModal } from './components/CreateWorktreeModal.js'
import { InlineNotice } from './components/InlineNotice.js'
import { MainTabBar } from './components/MainTabBar.js'
import { RemoveRepoConfirm } from './components/RemoveRepoConfirm.js'
import { Sidebar } from './components/Sidebar.js'
import { StatusBar } from './components/StatusBar.js'
import { TerminalChrome } from './components/TerminalChrome.js'
import './design-tokens.css'
import { useLifecycleActions } from './hooks/useLifecycleActions.js'
import { useMemoryLabel } from './hooks/useMemoryLabel.js'
import { usePersistentCollapse } from './hooks/usePersistentCollapse.js'
import { useSidebarResize } from './hooks/useSidebarResize.js'
import { pickPane } from './pane-utils.js'
import { TerminalPane } from './TerminalPane.js'

function findWorkspace(state: AppState, workspaceId: string | null): WorkspaceRow | null {
  if (workspaceId === null) return null
  for (const repo of state.repos) {
    for (const worktree of repo.worktrees) {
      if (worktree.workspace !== null && worktree.workspace.workspaceId === workspaceId) return worktree.workspace
    }
  }
  return null
}

function findActiveTab(workspace: WorkspaceRow | null, selectedPane: string | null): TabRow | null {
  if (workspace === null) return null
  return workspace.tabs.find((tab) => tab.panes.some((pane) => pane.paneId === selectedPane)) ?? null
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalNote, setModalNote] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<RepoRowData | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const lifecycle = useLifecycleActions(state)
  const sidebarRef = useRef<HTMLDivElement | null>(null)
  const { width, onHandleMouseDown } = useSidebarResize(sidebarRef)
  const repoCollapse = usePersistentCollapse('collapsedRepos')
  const groupCollapse = usePersistentCollapse('collapsedGroups')
  const memoryLabel = useMemoryLabel()

  useEffect(() => {
    void window.corral.getState().then(setState)
    return window.corral.onState(setState)
  }, [])

  // ESC 로 닫는다 — **문서에 건다** (모달 안 포커스 유무와 무관하게, 옛 App.tsx 121-161줄과 동일 이유).
  useEffect(() => {
    if (!modalOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setModalOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modalOpen])

  useEffect(() => {
    if (pendingRemove === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPendingRemove(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pendingRemove])

  useEffect(() => {
    if (lifecycle.pendingClose === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') lifecycle.cancelPendingClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lifecycle.pendingClose, lifecycle.cancelPendingClose])

  useEffect(() => {
    if (lifecycle.worktreeModal === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') lifecycle.closeWorktreeModal()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lifecycle.worktreeModal, lifecycle.closeWorktreeModal])

  // 렌더가 실제로 끝난 revision 을 main 로그에 남긴다 — 반영 지연(A1)의 화면 쪽 끝점이다.
  const lastReported = useRef(-1)
  useEffect(() => {
    if (state === null || state.revision === lastReported.current) return
    lastReported.current = state.revision
    window.corral.reportRendered(state.revision)
  })

  if (state === null) return <div className="boot">부트스트랩…</div>

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

  const removeRepo = async (repo: RepoRowData): Promise<void> => {
    setRemoveError(null)
    const result = await window.corral.removeRepo(repo.root)
    if (!result.ok) {
      setRemoveError(result.error ?? '알 수 없음')
      return
    }
    setPendingRemove(null)
  }

  const activeWorkspace = findWorkspace(state, lifecycle.activeWorkspaceId)
  const activeWorktree = state.repos
    .flatMap((repo) => repo.worktrees)
    .find((worktree) => worktree.openWorkspaceId !== null && worktree.openWorkspaceId === lifecycle.activeWorkspaceId)
  const activeTab = findActiveTab(activeWorkspace, lifecycle.selectedPane)

  const allWorktrees = state.repos.flatMap((repo) => repo.worktrees)
  const dirtyTotal = allWorktrees.reduce(
    (sum, worktree) =>
      sum + worktree.gitStatus.staged + worktree.gitStatus.unstaged + worktree.gitStatus.untracked + worktree.gitStatus.conflicted,
    0,
  )
  const aheadTotal = allWorktrees.reduce((sum, worktree) => sum + (worktree.gitStatus.ahead ?? 0), 0)
  const behindTotal = allWorktrees.reduce((sum, worktree) => sum + (worktree.gitStatus.behind ?? 0), 0)

  const paneCount = activeTab?.panes.length ?? 0
  const agentCount = activeWorkspace?.tabs.length ?? 0
  const terminal = state.terminal
  const terminalAlive =
    lifecycle.selectedPane !== null &&
    allWorktrees.some(
      (worktree) => worktree.workspace?.tabs.some((tab) => tab.panes.some((pane) => pane.paneId === lifecycle.selectedPane)) ?? false,
    )

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar
          sidebarRef={sidebarRef}
          width={width}
          state={state}
          activeWorkspaceId={lifecycle.activeWorkspaceId}
          selectedPane={lifecycle.selectedPane}
          selectPane={lifecycle.selectPane}
          actions={lifecycle.actions}
          isRepoCollapsed={repoCollapse.isCollapsed}
          toggleRepoCollapsed={repoCollapse.toggle}
          isGroupCollapsed={groupCollapse.isCollapsed}
          toggleGroupCollapsed={groupCollapse.toggle}
          onAddRepo={() => setModalOpen(true)}
          onRemoveRepo={(root) => {
            const repo = state.repos.find((item) => item.root === root)
            if (repo === undefined) return
            setRemoveError(null)
            setPendingRemove(repo)
          }}
          onRefresh={() => void window.corral.getState().then(setState)}
        />
        <div className="sidebar-resizer" data-sidebar-resizer onMouseDown={onHandleMouseDown} />

        <div className="main-area" data-main-area>
          {activeWorkspace !== null ? (
            <MainTabBar
              tabs={activeWorkspace.tabs}
              selectedPane={lifecycle.selectedPane}
              activeWorktreeLabel={activeWorktree?.branch ?? activeWorktree?.path ?? ''}
              onSelectTab={(tab) => {
                const pane = pickPane(tab)
                if (pane !== null) lifecycle.selectPane(pane.paneId)
              }}
              onCreateShell={() => {
                if (activeWorkspace !== null) lifecycle.actions.createRow(activeWorkspace.workspaceId, 'shell')
              }}
            />
          ) : null}

          {lifecycle.lifecycleNotice === null ? null : (
            <InlineNotice notice={lifecycle.lifecycleNotice} onDismiss={lifecycle.dismissNotice} />
          )}

          {notice === null ? null : (
            <div className="inline-notice tone-info" data-add-notice>
              <span className="inline-notice-dot" />
              <span className="inline-notice-text">{notice}</span>
              <div className="inline-notice-spacer" />
              <button className="inline-notice-dismiss" onClick={() => setNotice(null)}>
                해제
              </button>
            </div>
          )}

          <TerminalChrome activeTab={activeTab}>
            {terminalAlive && lifecycle.selectedPane !== null ? (
              <TerminalPane paneId={lifecycle.selectedPane} diagnostics={state.diagnostics} />
            ) : (
              <div className="term-empty" data-term-empty />
            )}
          </TerminalChrome>
        </div>
      </div>

      <StatusBar
        activeWorktreeLabel={activeWorktree?.branch ?? activeWorktree?.path ?? null}
        dirtyTotal={dirtyTotal}
        aheadTotal={aheadTotal}
        behindTotal={behindTotal}
        paneCount={paneCount}
        agentCount={agentCount}
        termSize={terminal.cols === null || terminal.rows === null ? null : { cols: terminal.cols, rows: terminal.rows }}
        memoryLabel={memoryLabel}
      />

      {modalOpen ? (
        <AddRepoModal browsing={browsing} note={modalNote} onBrowse={() => void browse()} onClose={() => setModalOpen(false)} />
      ) : null}

      {pendingRemove === null ? null : (
        <RemoveRepoConfirm
          repo={pendingRemove}
          error={removeError}
          onConfirm={() => void removeRepo(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      {lifecycle.pendingClose === null ? null : (
        <ConfirmClose
          target={lifecycle.pendingClose.target}
          foreground={lifecycle.pendingClose.foreground}
          onConfirm={lifecycle.confirmPendingClose}
          onCancel={lifecycle.cancelPendingClose}
        />
      )}

      {lifecycle.worktreeModal === null ? null : (
        <CreateWorktreeModal
          repoRoot={lifecycle.worktreeModal.repoRoot}
          onClose={lifecycle.closeWorktreeModal}
          onDone={(message) => {
            lifecycle.closeWorktreeModal()
            setNotice(message)
          }}
        />
      )}
    </div>
  )
}
