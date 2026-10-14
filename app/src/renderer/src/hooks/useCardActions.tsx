// 카드 메뉴의 App 층 (LIFE-478) — 고정 집합 · 삭제 중 집합 · 정보 수정/삭제 대화 · ⌘⌥R/⌘⇧⌫ · Option 누름 · hover 카드.
//
// 쓰기·삭제는 main 의 IPC(`setWorktreeMeta`·`deleteWorktree`)를 부르고 main 은 CLI 와 같은 런타임 명령을 돈다 — 여기에는 검증·순서가 없다.
// 결과는 다음 상태 내보내기(`desktop.changed()` → 트리 재조립)로 화면에 온다. 실패는 알림·대화 안 오류로 보인다(K1ⓓ).
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { AppState, RepoRow, WorktreeDeletePreview, WorktreeMetaUpdate, WorktreeRow } from '../../../shared/types.js'
import { deleteDecision, deleteResultNotice, isEditableFocus, userMovedActive } from '../card-menu.js'
import { getSettings, updateSettings } from '../settings-store.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { pickPane } from '../pane-utils.js'
import { worktreeDisplayName } from '../worktree-name.js'
import type { SidebarCardProps } from '../components/Sidebar.js'
import { DeleteWorktreeDialog } from '../components/DeleteWorktreeDialog.js'
import { WorktreeMetaDialog } from '../components/WorktreeMetaDialog.js'
import { usePersistentCollapse } from './usePersistentCollapse.js'

/** 이 훅이 읽는 상태는 레포 목록뿐이다(시험이 전체 AppState 없이 돌게). */
type ReposState = Pick<AppState, 'repos'>

type DeleteTarget = { path: string; name: string; preview: WorktreeDeletePreview | null }

/** 「다시 묻지 않음」 저장 직후 한 번(D5 — Orca 198 토스트 「다음번에는 이 확인을 건너뛰겠습니다. 설정에서 이를 변경할 수 있습니다.」). */
type RunDeleteInput = { target: { path: string; name: string }; force: boolean; saved: Promise<boolean> | null }

export const SKIP_DELETE_SAVED_NOTE = ' · 다음부터 깨끗한 워크트리는 묻지 않고 삭제합니다 — 설정 › 일반에서 되돌릴 수 있습니다'
/** 「다시 묻지 않음」 저장 실패(fix1 R1-02) — 삭제는 사용자가 확인했으므로 그대로 진행하고, 다음에도 묻는다는 사실만 알린다. */
export const SKIP_DELETE_FAILED_NOTE = ' · 설정을 저장하지 못해 다음에도 묻습니다'

/** Option(Alt) 을 누르고 있나 — 198 휴지통은 그동안만 마운트된다(`workspace-delete-quick-action.ts`). 창 blur 에 풀린다. */
function useAltHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => setHeld(event.altKey)
    const release = (): void => setHeld(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', release)
    }
  }, [])
  return held
}

/**
 * 삭제 미리보기 — IPC 자체가 reject 하면(LIFE-524 — transport 오류) main 의 읽기 실패와 같은 `{ ok: false }` 로 바꾼다.
 * 창은 「읽는 중」 에 멈추지 않고 읽기 실패로 서고(닫고 다시 고를 수 있다), unhandled rejection 도 없다.
 */
function readDeletePreview(path: string): Promise<WorktreeDeletePreview> {
  return window.corral.previewWorktreeDelete({ path }).catch((error: unknown) => ({
    ok: false,
    code: 'ipc_failed',
    error: error instanceof Error ? error.message : String(error),
  }))
}

function findRow(state: ReposState | null, path: string): { repo: RepoRow; worktree: WorktreeRow } | null {
  for (const repo of state?.repos ?? []) for (const worktree of repo.worktrees) if (worktree.path === path) return { repo, worktree }
  return null
}

export function useCardActions(input: {
  stateRef: RefObject<ReposState | null>
  state: ReposState | null
  activeWorkspaceId: string | null
  actions: LifecycleActions
  revealPane: (paneId: string) => void
  /** MRU pane 기록(최근 먼저) — 활성 워크트리를 지운 뒤 옮겨 갈 곳(198 「최근 방문한 같은 레포 형제」). */
  mruHistory: () => readonly string[]
  notify: (message: string) => void
  /** LIFE-591 E3ⓓ — 지우기 전에 그 worktree 의 수정된 파일 탭을 묻는다(false = 지우지 않는다). 없으면 묻지 않는다. */
  guardDelete?: (path: string) => Promise<boolean>
}) {
  const pins = usePersistentCollapse('pinnedWorktrees')
  const altHeld = useAltHeld()
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set())
  const deletingRef = useRef(deleting)
  deletingRef.current = deleting
  const [metaPath, setMetaPath] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [revealRequest, setRevealRequest] = useState<{ path: string; rename: boolean; seq: number } | null>(null)
  const hoveredRef = useRef<string | null>(null)
  const latest = useRef(input)
  latest.current = input
  /**
   * 활성 워크트리를 지우는 중인 것 (리뷰 r1 C-03) — 경로 → 그 워크스페이스 id · 사용자가 그동안 다른 곳을 골랐나.
   * 삭제가 끝난 시점에 이 값으로 다시 판정한다(확인 시점의 값에 고정하면 그사이 고른 활성을 빼앗는다).
   */
  const activeDeletes = useRef(new Map<string, { workspaceId: string; userMoved: boolean }>())
  useEffect(() => {
    const liveWorkspaceIds = new Set(
      (latest.current.state?.repos ?? []).flatMap((repo) => repo.worktrees).flatMap((row) => (row.workspace === null ? [] : [row.workspace.workspaceId])),
    )
    for (const record of activeDeletes.current.values()) {
      if (userMovedActive({ deletedWorkspaceId: record.workspaceId, activeWorkspaceId: input.activeWorkspaceId, liveWorkspaceIds })) record.userMoved = true
    }
  }, [input.activeWorkspaceId])

  const setMeta = useCallback(async (update: WorktreeMetaUpdate): Promise<string | null> => {
    const result = await window.corral.setWorktreeMeta(update)
    return result.ok ? null : `${result.error} (${result.code})`
  }, [])

  /** 확인 없이 지우려고 미리보기를 읽는 중인 경로 — 그동안 같은 카드의 두 번째 요청을 거른다(LIFE-516 K5ⓒ). */
  const skipPreviewing = useRef(new Set<string>())
  /** `requestDelete` 는 안정 identity(useCallback) 라 매 렌더의 `runDelete` 를 여기서 읽는다. */
  const runDeleteRef = useRef<((input: RunDeleteInput) => void) | null>(null)

  const requestDelete = useCallback((worktree: WorktreeRow): void => {
    if (!worktree.isLinked || deletingRef.current.has(worktree.path) || skipPreviewing.current.has(worktree.path)) return
    const target = { path: worktree.path, name: worktreeDisplayName(worktree) }
    // LIFE-516 K5ⓒ·D4 — 「워크트리를 삭제하기 전에 확인」 이 꺼져 있으면 미리보기를 먼저 읽고, **「삭제」 판정(깨끗·한가)일 때만** 창 없이
    // non-force 로 지운다. 강제·막힘·읽기 실패면 지금 창을 띄운다 — dirty·live 세션은 설정과 무관하게 확인을 지난다.
    if (getSettings().skipDeleteWorktreeConfirm) {
      skipPreviewing.current.add(target.path)
      void readDeletePreview(worktree.path).then((preview) => {
        skipPreviewing.current.delete(target.path)
        if (preview.ok && deleteDecision(preview).kind === 'delete') {
          runDeleteRef.current?.({ target, force: false, saved: null })
          return
        }
        setDeleteTarget({ ...target, preview })
      })
      return
    }
    setDeleteTarget({ ...target, preview: null })
    void readDeletePreview(worktree.path).then((preview) => {
      setDeleteTarget((current) => (current?.path === target.path ? { ...target, preview } : current))
    })
  }, [])

  /** 활성을 옮긴다 (K7ⓖ · 198 `active-worktree-focus-after-delete.ts:42-67`) — 같은 레포에서 가장 최근에 쓴 형제 → 주 체크아웃. */
  const moveActiveAway = (deleted: { repoRoot: string; path: string }): void => {
    const state = latest.current.stateRef.current
    const repo = state?.repos.find((row) => row.root === deleted.repoRoot)
    if (repo === undefined) return
    const siblings = repo.worktrees.filter((row) => row.path !== deleted.path)
    const paneOwner = new Map<string, WorktreeRow>()
    for (const row of siblings) for (const tab of row.workspace?.tabs ?? []) for (const pane of tab.panes) paneOwner.set(pane.paneId, row)
    const recent = latest.current.mruHistory().map((paneId) => paneOwner.get(paneId)).find((row) => row !== undefined && row.isLinked)
    const target = recent ?? siblings.find((row) => !row.isLinked)
    if (target === undefined) return
    if (target.workspace === null) {
      latest.current.actions.openWorktree(repo.root, target)
      return
    }
    latest.current.actions.activateWorkspace(target.workspace.workspaceId)
    const firstTab = target.workspace.tabs[0]
    const pane = firstTab === undefined ? null : pickPane(firstTab)
    if (pane !== null) latest.current.revealPane(pane.paneId)
  }

  const confirmDelete = (input: { force: boolean; dontAskAgain: boolean }): void => {
    const target = deleteTarget
    if (target === null) return
    setDeleteTarget(null)
    // LIFE-516 K5ⓑ — 체크 + 「삭제」 만 저장한다(체크박스는 「삭제」 판정에만 있다). 삭제는 지금과 같은 non-force.
    // 삭제 진행과 저장 성공은 따로다(fix1 R1-02) — 알림은 저장 결과를 보고 고른다.
    runDelete({ target, force: input.force, saved: input.dontAskAgain ? updateSettings({ skipDeleteWorktreeConfirm: true }) : null })
  }

  /** 삭제 실행 — 확인 창의 「삭제」/「강제 삭제」 와 확인 생략 경로(LIFE-516)가 같이 쓴다. `saved` = 방금 시작한 「다시 묻지 않음」 저장(없으면 null) — 성공이면 결과 알림에 되돌리는 자리를 한 번 붙이고(D5), 실패면 실패를 붙인다(fix1 R1-02). */
  const runDelete = (input: RunDeleteInput & { guarded?: boolean }): void => {
    const { target, force } = input
    const guard = latest.current.guardDelete
    if (guard !== undefined && input.guarded !== true) {
      void guard(target.path).then((ok) => {
        if (ok) runDelete({ ...input, guarded: true })
      })
      return
    }
    const found = findRow(latest.current.stateRef.current, target.path)
    const workspaceId = found?.worktree.openWorkspaceId ?? null
    if (workspaceId !== null && workspaceId === latest.current.activeWorkspaceId) activeDeletes.current.set(target.path, { workspaceId, userMoved: false })
    setDeleting((prev) => new Set(prev).add(target.path))
    void Promise.all([window.corral.deleteWorktree({ path: target.path, force }), input.saved]).then(([result, saved]) => {
      const skipNote = saved === null ? '' : saved ? SKIP_DELETE_SAVED_NOTE : SKIP_DELETE_FAILED_NOTE
      setDeleting((prev) => {
        const next = new Set(prev)
        next.delete(target.path)
        return next
      })
      const activeDelete = activeDeletes.current.get(target.path)
      activeDeletes.current.delete(target.path)
      if (!result.ok) {
        latest.current.notify(`워크트리 ${target.name} 를 삭제하지 못했습니다: ${result.error} (${result.code})${skipNote}`)
        return
      }
      pins.remove(target.path)
      latest.current.notify(`${deleteResultNotice({ name: target.name, preservedBranch: result.preservedBranch, warning: result.warning })}${skipNote}`)
      // 삭제가 끝난 지금 다시 판정 — 그사이 사용자가 다른 카드를 골랐으면 그대로 둔다.
      if (activeDelete !== undefined && !activeDelete.userMoved && found !== null) moveActiveAway({ repoRoot: found.repo.root, path: target.path })
    })
  }

  runDeleteRef.current = runDelete

  /** ⌘⌥R (198 `workspace.rename` — 활성 워크트리를 드러낸 뒤 그 카드에서 인라인 rename). 활성 없으면 아무 일 없음. */
  const renameActive = (): void => {
    const state = latest.current.stateRef.current
    const active = state?.repos.flatMap((repo) => repo.worktrees).find((row) => row.openWorkspaceId !== null && row.openWorkspaceId === latest.current.activeWorkspaceId)
    if (active === undefined) return
    setRevealRequest((prev) => ({ path: active.path, rename: true, seq: (prev?.seq ?? 0) + 1 }))
  }

  /** ⌘⇧⌫ (198 `workspace.delete` — hover 중인 카드). 입력란 포커스(터미널은 아니다)·주 체크아웃·삭제 중이면 무시(대화 열림은 단축키 막힘이 거른다). */
  const deleteHovered = (): void => {
    const path = hoveredRef.current
    if (path === null) return
    if (isEditableFocus(document.activeElement)) return
    const found = findRow(latest.current.stateRef.current, path)
    if (found !== null) requestDelete(found.worktree)
  }

  const metaRow = metaPath === null ? null : findRow(input.state, metaPath)
  const dialogs = (
    <>
      {metaRow === null ? null : (
        <WorktreeMetaDialog
          key={metaRow.worktree.path}
          worktree={metaRow.worktree}
          onSave={(patch) => setMeta({ path: metaRow.worktree.path, ...patch })}
          onClose={() => setMetaPath(null)}
        />
      )}
      {deleteTarget === null ? null : (
        <DeleteWorktreeDialog
          key={deleteTarget.path}
          name={deleteTarget.name}
          path={deleteTarget.path}
          preview={deleteTarget.preview}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </>
  )

  // 안 읽음 장부(`unread`)는 App 이 `useUnread` 로 얹는다(LIFE-471).
  const sidebarCards: Omit<SidebarCardProps, 'unread'> = {
    pinned: pins.values,
    togglePin: pins.toggle,
    deleting,
    altHeld,
    setMeta,
    openDetails: (worktree) => setMetaPath(worktree.path),
    requestDelete,
    notify: input.notify,
    onHoverCard: (path) => {
      hoveredRef.current = path
    },
    revealRequest,
    // 단축키 표시는 키맵을 아는 App 이 덮는다.
    deleteShortcut: null,
  }

  return {
    sidebarCards,
    dialogs,
    /** 대화가 열려 있다 — 단축키를 막는다(App `modalBlocked`). */
    blocked: metaRow !== null || deleteTarget !== null,
    renameActive,
    deleteHovered,
  }
}
