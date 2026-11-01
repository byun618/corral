// @vitest-environment happy-dom
// LIFE-624 C11(화면 통합) · C6 · C10 — 실제 `TasksPage`(패널 하네스) + 실제 `WorkService`(모의 출처). PR 상태는 보이는 면이 있을 때만 묻는다:
// 페이지 닫힘 + 상세 숨김 = prBranches 0 회 · 페이지 열림이어도 작업 중 보기가 아니면 0(r1 c1-3) · 작업 중 보기 = 그 행 · 상세만 보임 = 그 작업의 worktree + 열린 PR URL 재조회(prRefreshItem).
// 새 활동 줄이 남았으면(recorded > 0) 상세 활동을 다시 읽는다. 렌더러와 main 을 함께 import 하므로 mixed 검사(tsconfig.mixed.json)에 둔다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrBranchesResult, PrItemRefreshResult } from '../../../shared/pr-status.js'
import { testRepo, testWorktree } from '../../../shared/test-rows.js'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkActivityQuery } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { mockSourceEntry, seedMockDemoState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FakeCipher, MemoryStore } from '../../../main/work/test-kit.js'
import { TasksPageInPanel } from './TasksPage.harness.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const MERGED: PrBranchesResult['lookups'][string] = { kind: 'pr', pr: { number: 30, state: 'merged', url: 'https://github.com/byun618/corral/pull/30', headRefName: 'CORE-2-x', baseRefName: 'main', createdAt: null, mergedAt: null, closedAt: null } }

async function rig({ open, panelShown, detail, recorded = 0 }: { open: boolean; panelShown: boolean; detail: boolean; recorded?: number }) {
  const state = seedMockDemoState()
  let seq = 0
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]), activity: new MemoryActivity(),
    repos: () => [], onChange: () => undefined, now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token: 'mock_l624_fixture', replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const connectionId = service.settings().connections[0]?.id ?? ''
  const repos: RepoRow[] = [testRepo({ root: '/r', worktrees: [
    testWorktree({ path: '/r/core-2', branch: 'refs/heads/CORE-2-x', open: true, workLink: { mode: 'explicit', sourceId: 'mock-jira', connectionId, key: 'CORE-2', itemId: 'm-2', connected: true } }),
    testWorktree({ path: '/r/plain', branch: 'main' }),
  ] })]
  const branches: string[][] = []
  const refreshes: WorkActivityQuery[] = []
  const activityReads: WorkActivityQuery[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: detail ? { detail: { connectionId, itemId: 'm-2' } } : undefined }),
    setUiPrefs: () => undefined,
    getWorkSettings: async () => service.settings(),
    onWorkSettings: () => () => undefined,
    workRequest: (request: Parameters<WorkService['request']>[0]) => service.request(request),
    workActivity: async (query: WorkActivityQuery) => { activityReads.push(query); return service.activity(query) },
    startWorkStatus: async () => null,
    prBranches: async ({ paths }: { paths: string[] }): Promise<PrBranchesResult> => {
      branches.push(paths)
      return { lookups: Object.fromEntries(paths.map((path) => [path, MERGED])), recorded }
    },
    prRefreshItem: async (query: WorkActivityQuery): Promise<PrItemRefreshResult> => { refreshes.push(query); return { ok: true, checked: 0, recorded: 0 } },
  })
  const render = (next: { open: boolean; panelShown: boolean }): void => {
    act(() => root.render(createElement(TasksPageInPanel, {
      open: next.open, panelShown: next.panelShown, repos, activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false,
      onClose: () => undefined, onOpenSettings: () => undefined, onOpenWorktree: () => undefined, onOpenPage: () => undefined, headTail: null,
    })))
  }
  render({ open, panelShown })
  await settle()
  return { branches, refreshes, activityReads, render }
}

describe('C11 보일 때만 — 실제 작업 페이지', () => {
  it('페이지 닫힘 + 상세 없음 → prBranches · prRefreshItem 0 회', async () => {
    const r = await rig({ open: false, panelShown: false, detail: false })
    await settle()
    expect(r.branches).toEqual([])
    expect(r.refreshes).toEqual([])
  })
  it('페이지가 열려도 보드 보기 + 상세 닫힘이면 0 회(r1 c1-3) — 작업 중 보기로 가면 그 행만 1 회, 다시 그려도 그대로, 닫으면 멈춤, 다시 열면 1 회 더', async () => {
    const r = await rig({ open: false, panelShown: false, detail: false })
    r.render({ open: true, panelShown: false })
    await settle()
    expect(document.querySelector('[data-tasks-view]')?.getAttribute('data-tasks-view')).toBe('board')
    expect(r.branches).toEqual([])
    const tab = document.querySelector<HTMLElement>('[data-tasks-view-tab="working"]')
    expect(tab).not.toBeNull()
    act(() => { tab?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(document.querySelector('[data-tasks-view]')?.getAttribute('data-tasks-view')).toBe('working')
    expect(r.branches).toEqual([['/r/core-2']])
    expect(document.querySelector('[data-working-worktree="CORE-2-x"] [data-pr-chip]')?.textContent).toBe('PR #30 · 머지됨')
    r.render({ open: true, panelShown: false })
    await settle()
    expect(r.branches).toHaveLength(1)
    r.render({ open: false, panelShown: false })
    await settle()
    expect(r.branches).toHaveLength(1)
    r.render({ open: true, panelShown: false })
    await settle()
    expect(r.branches).toHaveLength(2)
  })
  it('상세만 보이면(페이지 닫힘) 그 작업의 worktree + 열린 PR URL 재조회 — 실행 영역에 칩', async () => {
    const r = await rig({ open: false, panelShown: true, detail: true })
    await settle()
    expect(document.querySelector('[data-issue-detail="CORE-2"]')).not.toBeNull()
    expect(r.branches).toEqual([['/r/core-2']])
    expect(r.refreshes).toEqual([{ connectionId: expect.any(String), itemId: 'm-2', itemKey: 'CORE-2' }])
    expect(document.querySelector('[data-work-tree="CORE-2-x"] [data-pr-chip]')?.textContent).toBe('PR #30 · 머지됨')
  })
  it('브랜치 조회가 새 줄을 남기면 상세 활동을 다시 읽는다', async () => {
    const quiet = await rig({ open: false, panelShown: true, detail: true, recorded: 0 })
    const before = quiet.activityReads.length
    act(() => root.unmount())
    root = createRoot(host)
    const loud = await rig({ open: false, panelShown: true, detail: true, recorded: 2 })
    expect(loud.activityReads.length).toBe(before + 1)
  })
})
