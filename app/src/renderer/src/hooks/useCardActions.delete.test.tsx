// @vitest-environment happy-dom
// 삭제 뒤 활성 이동 (LIFE-478 K7ⓖ · 리뷰 r1 C-03) — 활성 워크트리를 지우는 동안 사용자가 다른 카드를 고르면 삭제가 끝나도 활성을 빼앗지 않는다.
// 그대로였거나 닫힘에 따른 자동 승격만 있었으면 198 처럼 같은 레포 형제로 옮긴다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow, WorktreeDeleteResult, WorktreeRow } from '../../../shared/types.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { useCardActions } from './useCardActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const row = (input: { path: string; linked: boolean; workspaceId: string | null }): WorktreeRow => ({
  path: input.path, branch: input.path.split('/').at(-1) ?? null, isLinked: input.linked, openWorkspaceId: input.workspaceId,
  gitStatus: { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
  workspace: input.workspaceId === null ? null : { workspaceId: input.workspaceId, label: input.path, number: 1, agentStatus: 'idle', focused: false, tabs: [] },
  displayName: null, comment: null, parentPath: null,
})
const repo = (input: { aOpen: boolean }): RepoRow => ({
  root: '/r', name: 'r', error: null,
  worktrees: [row({ path: '/r', linked: false, workspaceId: 'w-main' }), row({ path: '/r-wt/a', linked: true, workspaceId: input.aOpen ? 'w-a' : null }), row({ path: '/r-wt/b', linked: true, workspaceId: 'w-b' })],
})

let host: HTMLDivElement
let root: Root
let activateWorkspace: ReturnType<typeof vi.fn<(id: string) => void>>
let finishDelete: (result: WorktreeDeleteResult) => void
let hook: ReturnType<typeof useCardActions> | null

function Harness(props: { repos: RepoRow[]; activeWorkspaceId: string | null }): React.JSX.Element {
  const state = { repos: props.repos }
  const actions: LifecycleActions = {
    createRow: () => {}, closeRow: () => {}, renameRow: () => {}, clearRowName: () => {}, closeWorktree: () => {},
    openWorktree: () => {}, openCreateWorktree: () => {}, activateWorkspace,
  }
  hook = useCardActions({ stateRef: { current: state }, state, activeWorkspaceId: props.activeWorkspaceId, actions, revealPane: () => {}, mruHistory: () => [], notify: () => {} })
  return createElement('div', null, hook.dialogs)
}
const render = (props: { repos: RepoRow[]; activeWorkspaceId: string | null }): void => act(() => root.render(createElement(Harness, props)))

/** 활성 a 를 지우기 시작한다 — 미리보기(깨끗·한가) → 「삭제」. 삭제는 `finishDelete` 를 부를 때까지 끝나지 않는다. */
async function startDeletingA(): Promise<void> {
  render({ repos: [repo({ aOpen: true })], activeWorkspaceId: 'w-a' })
  const a = repo({ aOpen: true }).worktrees[1]
  if (a === undefined || hook === null) throw new Error('준비 실패')
  const current = hook
  act(() => current.sidebarCards.requestDelete(a))
  await act(async () => {})
  const confirm = document.querySelector<HTMLButtonElement>('[data-delete-confirm="delete"]')
  if (confirm === null) throw new Error('삭제 단추 없음')
  act(() => confirm.click())
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  hook = null
  activateWorkspace = vi.fn<(id: string) => void>()
  Reflect.set(window, 'corral', {
    getUiPrefs: () => Promise.resolve({ pinnedWorktrees: [] }),
    setUiPrefs: () => {},
    previewWorktreeDelete: ({ path }: { path: string }) =>
      Promise.resolve({ ok: true, path, branch: 'a', isMain: false, locked: false, dirtyCount: 0, liveSessions: 0, backendError: null, childPaths: [] }),
    deleteWorktree: () =>
      new Promise<WorktreeDeleteResult>((resolve) => {
        finishDelete = resolve
      }),
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
})

const done: WorktreeDeleteResult = { ok: true, preservedBranch: null, warning: null }

describe('삭제 뒤 활성 이동 (C-03)', () => {
  it('삭제 중 사용자가 다른 카드(b)를 고르면 끝나도 활성을 빼앗지 않는다', async () => {
    await startDeletingA()
    render({ repos: [repo({ aOpen: true })], activeWorkspaceId: 'w-b' })
    render({ repos: [repo({ aOpen: false })], activeWorkspaceId: 'w-b' })
    await act(async () => finishDelete(done))
    expect(activateWorkspace).not.toHaveBeenCalled()
  })
  it('그대로면 끝난 뒤 같은 레포 형제(주 체크아웃)로 옮긴다', async () => {
    await startDeletingA()
    await act(async () => finishDelete(done))
    expect(activateWorkspace).toHaveBeenCalledWith('w-main')
  })
  it('닫힘에 따른 자동 승격(워크스페이스가 사라진 뒤의 활성 변화)은 사용자의 선택이 아니다 — 옮긴다', async () => {
    await startDeletingA()
    render({ repos: [repo({ aOpen: false })], activeWorkspaceId: 'w-b' })
    await act(async () => finishDelete(done))
    expect(activateWorkspace).toHaveBeenCalledWith('w-main')
  })
  it('실패하면 옮기지 않는다', async () => {
    await startDeletingA()
    await act(async () => finishDelete({ ok: false, code: 'x', error: 'y' }))
    expect(activateWorkspace).not.toHaveBeenCalled()
  })
})
