// @vitest-environment happy-dom
// 삭제 뒤 활성 이동 (LIFE-478 K7ⓖ · 리뷰 r1 C-03) — 활성 워크트리를 지우는 동안 사용자가 다른 카드를 고르면 삭제가 끝나도 활성을 빼앗지 않는다.
// 그대로였거나 닫힘에 따른 자동 승격만 있었으면 198 처럼 같은 레포 형제로 옮긴다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow, WorktreeDeletePreview, WorktreeDeleteResult, WorktreeRow } from '../../../shared/types.js'
import { DEFAULT_SETTINGS } from '../../../shared/terminal-settings.js'
import { getSettings, resetSettingsStoreForTest } from '../settings-store.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { SKIP_DELETE_FAILED_NOTE, SKIP_DELETE_SAVED_NOTE, useCardActions } from './useCardActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const row = (input: { path: string; linked: boolean; workspaceId: string | null }): WorktreeRow => ({
  path: input.path, branch: input.path.split('/').at(-1) ?? null, isLinked: input.linked, head: null, repoName: 'repo', openWorkspaceId: input.workspaceId,
  gitStatus: { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
  workspace: input.workspaceId === null ? null : { workspaceId: input.workspaceId, label: input.path, number: 1, agentStatus: 'idle', focused: false, tabs: [] },
  displayName: null, comment: null, parentPath: null,
})
const repo = (input: { aOpen: boolean }): RepoRow => ({
  root: '/r', name: 'r', error: null,
  worktrees: [row({ path: '/r', linked: false, workspaceId: 'w-main' }), row({ path: '/r-wt/a', linked: true, workspaceId: input.aOpen ? 'w-a' : null }), row({ path: '/r-wt/b', linked: true, workspaceId: 'w-b' })],
})

/** 없으면 설명을 붙여 throw 하는 조회 — 비 null 단언 대신 준비 조건을 드러낸다(LIFE-516 fix1 R1-06). */
const buttonOf = (selector: string): HTMLButtonElement => {
  const found = document.querySelector(selector)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`버튼 없음: ${selector}`)
  return found
}
const checkboxOf = (selector: string): HTMLInputElement => {
  const found = document.querySelector(selector)
  if (!(found instanceof HTMLInputElement)) throw new Error(`체크박스 없음: ${selector}`)
  return found
}
let host: HTMLDivElement
let root: Root
let activateWorkspace: ReturnType<typeof vi.fn<(id: string) => void>>
let finishDelete: (result: WorktreeDeleteResult) => void
let hook: ReturnType<typeof useCardActions> | null

function Harness(props: { repos: RepoRow[]; activeWorkspaceId: string | null }): React.JSX.Element {
  const state = { repos: props.repos }
  const actions: LifecycleActions = {
    createRow: () => {}, reopenTab: () => {}, launchAgent: () => {}, closeTabs: () => {}, renameRow: () => {}, clearRowName: () => {}, closeWorktree: () => {},
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

// --- LIFE-516 K5 — 「다시 묻지 않음」 · 확인 생략 분기 -----------------------------------------------------------
describe('워크트리 삭제 확인 생략 (LIFE-516 K5ⓑⓒⓓ)', () => {
  const notices: string[] = []
  const deletes: Array<{ path: string; force: boolean }> = []
  let previewOf: (path: string) => WorktreeDeletePreview
  function SkipHarness(props: { repos: RepoRow[] }): React.JSX.Element {
    const state = { repos: props.repos }
    const actions: LifecycleActions = {
      createRow: () => {}, reopenTab: () => {}, launchAgent: () => {}, closeTabs: () => {}, renameRow: () => {}, clearRowName: () => {}, closeWorktree: () => {},
      openWorktree: () => {}, openCreateWorktree: () => {}, activateWorkspace: () => {},
    }
    hook = useCardActions({ stateRef: { current: state }, state, activeWorkspaceId: null, actions, revealPane: () => {}, mruHistory: () => [], notify: (message) => notices.push(message) })
    return createElement('div', null, hook.dialogs)
  }
  const clean = (path: string): Extract<WorktreeDeletePreview, { ok: true }> => ({ ok: true, path, branch: 'a', isMain: false, locked: false, dirtyCount: 0, liveSessions: 0, backendError: null, childPaths: [] })
  beforeEach(() => {
    notices.length = 0
    deletes.length = 0
    previewOf = clean
    Reflect.set(window, 'corral', {
      getUiPrefs: () => Promise.resolve({ pinnedWorktrees: [] }),
      setUiPrefs: () => {},
      previewWorktreeDelete: ({ path }: { path: string }) => Promise.resolve(previewOf(path)),
      deleteWorktree: (input: { path: string; force: boolean }) => {
        deletes.push(input)
        return Promise.resolve(done)
      },
    })
  })
  afterEach(() => resetSettingsStoreForTest(null))
  const request = async (path: string): Promise<void> => {
    const target = repo({ aOpen: false }).worktrees.find((row) => row.path === path)
    if (target === undefined || hook === null) throw new Error('준비 실패')
    const current = hook
    act(() => current.sidebarCards.requestDelete(target))
    await act(async () => {})
  }

  it('설정 켜짐(기본): 깨끗해도 창 · 체크 + 「삭제」 → 설정 저장 + non-force 삭제 + 되돌리는 자리 안내 1회', async () => {
    resetSettingsStoreForTest({ ...DEFAULT_SETTINGS })
    act(() => root.render(createElement(SkipHarness, { repos: [repo({ aOpen: false })] })))
    await request('/r-wt/a')
    expect(document.querySelector('[data-delete-worktree-dialog]')).not.toBeNull()
    act(() => checkboxOf('[data-dont-ask-again-input]').click())
    await act(async () => buttonOf('[data-delete-confirm="delete"]').click())
    expect(getSettings().skipDeleteWorktreeConfirm).toBe(true)
    expect(deletes).toEqual([{ path: '/r-wt/a', force: false }])
    expect(notices).toEqual([`워크트리 a 를 삭제했습니다${SKIP_DELETE_SAVED_NOTE}`])
  })
  it('fix1 R1-02 체크 + 「삭제」 의 저장이 실패하면 삭제는 진행하고 되돌림 안내 대신 실패를 알린다', async () => {
    resetSettingsStoreForTest({ ...DEFAULT_SETTINGS })
    const writes: unknown[] = []
    Reflect.set(window.corral, 'setSettings', (patch: unknown) => {
      writes.push(patch)
      return Promise.resolve({ status: 'failed', settings: { ...DEFAULT_SETTINGS } })
    })
    act(() => root.render(createElement(SkipHarness, { repos: [repo({ aOpen: false })] })))
    await request('/r-wt/a')
    act(() => checkboxOf('[data-dont-ask-again-input]').click())
    await act(async () => buttonOf('[data-delete-confirm="delete"]').click())
    await act(async () => {})
    expect(writes).toEqual([{ skipDeleteWorktreeConfirm: true }])
    expect(getSettings().skipDeleteWorktreeConfirm).toBe(false)
    expect(deletes).toEqual([{ path: '/r-wt/a', force: false }])
    expect(notices).toEqual([`워크트리 a 를 삭제했습니다${SKIP_DELETE_FAILED_NOTE}`])
  })
  it('체크 + 취소 → 저장 안 함 · 체크 없이 「삭제」 → 저장 안 함', async () => {
    resetSettingsStoreForTest({ ...DEFAULT_SETTINGS })
    act(() => root.render(createElement(SkipHarness, { repos: [repo({ aOpen: false })] })))
    await request('/r-wt/a')
    act(() => checkboxOf('[data-dont-ask-again-input]').click())
    act(() => buttonOf('[data-delete-cancel]').click())
    expect(getSettings().skipDeleteWorktreeConfirm).toBe(false)
    await request('/r-wt/a')
    expect(checkboxOf('[data-dont-ask-again-input]').checked).toBe(false)
    await act(async () => buttonOf('[data-delete-confirm="delete"]').click())
    expect(getSettings().skipDeleteWorktreeConfirm).toBe(false)
    expect(notices).toEqual(['워크트리 a 를 삭제했습니다'])
  })
  it('설정 꺼짐 + 「삭제」 판정 → 창 없이 non-force 삭제', async () => {
    resetSettingsStoreForTest({ ...DEFAULT_SETTINGS, skipDeleteWorktreeConfirm: true })
    act(() => root.render(createElement(SkipHarness, { repos: [repo({ aOpen: false })] })))
    await request('/r-wt/a')
    expect(document.querySelector('[data-delete-worktree-dialog]')).toBeNull()
    expect(deletes).toEqual([{ path: '/r-wt/a', force: false }])
    expect(notices).toEqual(['워크트리 a 를 삭제했습니다'])
  })
  it.each([
    ['강제(dirty)', (path: string): WorktreeDeletePreview => ({ ...clean(path), dirtyCount: 3 }), 'force'],
    ['강제(live 세션)', (path: string): WorktreeDeletePreview => ({ ...clean(path), liveSessions: 1 }), 'force'],
    ['막힘(잠김)', (path: string): WorktreeDeletePreview => ({ ...clean(path), locked: true }), 'blocked'],
    ['막힘(herdr 미연결)', (path: string): WorktreeDeletePreview => ({ ...clean(path), liveSessions: null }), 'blocked'],
    ['미리보기 실패', (): WorktreeDeletePreview => ({ ok: false, code: 'x', error: 'y' }), 'error'],
  ])('설정 꺼짐이어도 %s 이면 지금 대화상자를 띄운다 — 지우지 않는다 · 체크박스 없음', async (_, preview, decision) => {
    resetSettingsStoreForTest({ ...DEFAULT_SETTINGS, skipDeleteWorktreeConfirm: true })
    previewOf = preview
    act(() => root.render(createElement(SkipHarness, { repos: [repo({ aOpen: false })] })))
    await request('/r-wt/a')
    expect(document.querySelector('[data-delete-worktree-dialog]')?.getAttribute('data-delete-decision')).toBe(decision)
    expect(document.querySelector('[data-dont-ask-again]')).toBeNull()
    expect(deletes).toEqual([])
  })
})
