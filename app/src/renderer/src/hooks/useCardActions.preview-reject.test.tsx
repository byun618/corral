// @vitest-environment happy-dom
// LIFE-524 K3ⓒ — 삭제 미리보기 IPC(`previewWorktreeDelete`) 자체가 reject 해도 unhandled rejection 이 없고, 삭제 창이 「읽는 중」 에 멈추지 않는다.
// 확인 창 경로(설정 켜짐)와 확인 생략 경로(설정 꺼짐 — 미리보기를 먼저 읽는다) 둘 다. 생략 경로는 같은 카드 두 번째 요청이 막히지 않아야 한다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoRow, WorktreeRow } from '../../../shared/types.js'
import { DEFAULT_SETTINGS } from '../../../shared/terminal-settings.js'
import { resetSettingsStoreForTest } from '../settings-store.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import { useCardActions } from './useCardActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const linked: WorktreeRow = {
  path: '/r-wt/a', branch: 'a', isLinked: true, head: null, repoName: 'repo', openWorkspaceId: null,
  gitStatus: { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
  workspace: null, displayName: null, comment: null, parentPath: null,
}
const repos: RepoRow[] = [{ root: '/r', name: 'r', error: null, worktrees: [linked] }]

let host: HTMLDivElement
let root: Root
let hook: ReturnType<typeof useCardActions> | null
let previews = 0
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason)
}

function Harness(): React.JSX.Element {
  const state = { repos }
  const actions: LifecycleActions = {
    createRow: () => {}, reopenTab: () => {}, launchAgent: () => {}, closeTabs: () => {}, renameRow: () => {}, clearRowName: () => {}, closeWorktree: () => {},
    openWorktree: () => {}, openCreateWorktree: () => {}, activateWorkspace: () => {},
  }
  hook = useCardActions({ stateRef: { current: state }, state, activeWorkspaceId: null, actions, revealPane: () => {}, mruHistory: () => [], notify: () => {} })
  return createElement('div', null, hook.dialogs)
}
const request = async (): Promise<void> => {
  const current = hook
  if (current === null) throw new Error('준비 실패')
  act(() => current.sidebarCards.requestDelete(linked))
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0))
  })
}
const dialogDecision = (): string | null => document.querySelector('[data-delete-worktree-dialog]')?.getAttribute('data-delete-decision') ?? null

beforeEach(() => {
  previews = 0
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  hook = null
  Reflect.set(window, 'corral', {
    getUiPrefs: () => Promise.resolve({ pinnedWorktrees: [] }),
    setUiPrefs: () => {},
    previewWorktreeDelete: () => {
      previews += 1
      return Promise.reject(new Error('transport: ipc channel closed'))
    },
    deleteWorktree: () => Promise.resolve({ ok: true, preservedBranch: null, warning: null }),
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
  resetSettingsStoreForTest(null)
  process.off('unhandledRejection', onUnhandled)
})

describe('삭제 미리보기 IPC 자체 reject (LIFE-524 K3ⓒ)', () => {
  it('확인 창 경로 — unhandled 0, 창은 「읽는 중」 이 아니라 읽기 실패로 선다', async () => {
    resetSettingsStoreForTest({ ...DEFAULT_SETTINGS })
    act(() => root.render(createElement(Harness)))
    await request()
    expect(unhandled).toEqual([])
    expect(dialogDecision()).toBe('error')
    expect(document.querySelector('[data-delete-preview-error]')?.textContent).toContain('transport: ipc channel closed')
  })
  it('확인 생략 경로 — unhandled 0, 읽기 실패 창이 서고, 닫은 뒤 같은 카드 두 번째 요청이 다시 미리보기까지 간다', async () => {
    resetSettingsStoreForTest({ ...DEFAULT_SETTINGS, skipDeleteWorktreeConfirm: true })
    act(() => root.render(createElement(Harness)))
    await request()
    expect(unhandled).toEqual([])
    expect(dialogDecision()).toBe('error')
    const cancel = document.querySelector('[data-delete-cancel]')
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('취소 단추 없음')
    act(() => cancel.click())
    await request()
    expect(previews).toBe(2)
  })
})
