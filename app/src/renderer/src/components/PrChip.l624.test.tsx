// @vitest-environment happy-dom
// LIFE-624 C6·C7·C8·C11(화면) — 실행 영역 칩·흐린 이유, 작업 중 줄 칩(클릭은 base 그대로), 활동 PR 줄 문구·갈래, 보일 때만 묻기.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrBranchesResult, PrInfo, PrLookup } from '../../../shared/pr-status.js'
import type { CorralApi } from '../../../shared/types.js'
import type { WorkActivityChange, WorkActivityRecord } from '../../../shared/work.js'
import { usePrStatus } from '../hooks/usePrStatus.js'
import type { WorkingLookup } from '../hooks/useTasksPage.js'
import { activityCounts, activityRows, describeChange, passesActivity } from '../task-detail-model.js'
import { prTargets, type LinkedTree } from '../work-links-model.js'
import { WorkingList } from './TasksViews.js'
import { WorkLinksContext, WorkRunSection } from './WorkLinkChips.js'

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

const tree = (path: string, branch: string): LinkedTree => ({
  path, repoRoot: '/r', repoName: 'corral', branch, dot: null, activityAt: null,
  link: { mode: 'auto', sourceId: 'la', connectionId: 'c1', key: 'LIFE-1', itemId: null, connected: true },
  open: true, agent: null, question: null, focusPane: null,
})
const pr = (state: PrInfo['state'], number = 30): PrLookup => ({ kind: 'pr', pr: { number, state, url: `https://github.com/byun618/corral/pull/${number}`, headRefName: 'b', baseRefName: 'main', createdAt: null, mergedAt: null, closedAt: null } })
const LOADING: WorkingLookup = { state: 'loading' }
const err = (error: Extract<PrLookup, { kind: 'error' }>['error']): PrLookup => ({ kind: 'error', error, message: 'raw' })

const TREES = [
  tree('/w/draft', 'b-draft'), tree('/w/open', 'b-open'), tree('/w/merged', 'b-merged'), tree('/w/closed', 'b-closed'),
  tree('/w/none', 'b-none'), tree('/w/auth', 'b-auth'), tree('/w/nogh', 'b-nogh'), tree('/w/notgh', 'b-notgh'), tree('/w/unknown', 'b-unknown'),
]
const LOOKUPS = new Map<string, PrLookup>([
  ['/w/draft', pr('draft', 1)], ['/w/open', pr('open', 2)], ['/w/merged', pr('merged', 3)], ['/w/closed', pr('closed', 4)],
  ['/w/none', { kind: 'none' }], ['/w/auth', err('unauthenticated')], ['/w/nogh', err('no_gh')], ['/w/notgh', err('not_github')],
])

describe('C6 실행 영역 칩', () => {
  it('네 상태 칩 · PR 없음 = 칩 없음 · 오류 = 칩이 아닌 흐린 이유 · GitHub 원격 아님 = 아무것도', () => {
    act(() => root.render(createElement(WorkLinksContext.Provider, { value: { trees: TREES, open: () => undefined, machine: null, pr: LOOKUPS } },
      createElement(WorkRunSection, { trees: TREES, itemKey: 'LIFE-1', now: 0, actions: { reveal: () => undefined, start: () => undefined } }))))
    const box = (branch: string): Element | null => host.querySelector(`[data-work-tree="${branch}"] .issue-work-where`)
    expect(box('b-draft')?.querySelector('[data-pr-chip]')?.textContent).toBe('PR #1 · 초안')
    expect(box('b-open')?.querySelector('[data-pr-chip]')?.textContent).toBe('PR #2 · 열림')
    expect(box('b-merged')?.querySelector('[data-pr-chip]')?.textContent).toBe('PR #3 · 머지됨')
    expect(box('b-closed')?.querySelector('[data-pr-chip]')?.textContent).toBe('PR #4 · 닫힘')
    expect(box('b-merged')?.querySelector('.pr-chip')?.getAttribute('title')).toBe('https://github.com/byun618/corral/pull/3')
    for (const branch of ['b-none', 'b-auth', 'b-nogh', 'b-notgh', 'b-unknown']) expect(box(branch)?.querySelector('[data-pr-chip]')).toBeNull()
    expect(box('b-none')?.textContent).toBe('corral / b-none')
    expect(box('b-auth')?.querySelector('[data-pr-reason]')?.textContent).toBe('gh 로그인이 필요합니다')
    expect(box('b-nogh')?.querySelector('[data-pr-reason]')?.textContent).toBe('gh 가 없습니다')
    expect(box('b-auth')?.querySelector('.pr-reason')?.classList.contains('pr-chip')).toBe(false)
    expect(box('b-notgh')?.textContent).toBe('corral / b-notgh')
    expect(box('b-unknown')?.textContent).toBe('corral / b-unknown')
  })
  it('컨텍스트에 pr 이 없으면(옛 호출자) 칩 없음', () => {
    act(() => root.render(createElement(WorkLinksContext.Provider, { value: { trees: TREES, open: () => undefined, machine: null } },
      createElement(WorkRunSection, { trees: TREES, itemKey: 'LIFE-1', now: 0, actions: { reveal: () => undefined, start: () => undefined } }))))
    expect(host.querySelectorAll('[data-pr-chip],[data-pr-reason]')).toHaveLength(0)
  })
})

describe('C7 작업 중 줄 칩', () => {
  it('브랜치와 시간 사이에 칩 · 오류는 그리지 않음 · 칩을 눌러도 그 worktree 로(base 클릭)', () => {
    const opened: string[] = []
    const views = [{ entry: { key: 'LIFE-1', connectionId: 'c1', trees: TREES.map((one) => ({ ...one, activityAt: 1_000 })) }, lookup: LOADING }]
    act(() => root.render(createElement(WorkingList, { views, now: 61_000, onOpen: (picked) => opened.push(picked.path), pr: LOOKUPS })))
    const button = (branch: string): HTMLButtonElement | null => host.querySelector(`button[data-working-worktree="${branch}"]`)
    const merged = button('b-merged')
    const order = [...(merged?.children ?? [])].map((child) => child.className)
    expect(order).toEqual(['tasks-working-dot', 'tasks-working-state', 'tasks-working-branch', 'pr-chip is-merged', 'tasks-working-time', 'tasks-working-chevron'])
    expect(merged?.querySelector('[data-pr-chip]')?.textContent).toBe('PR #3 · 머지됨')
    for (const branch of ['b-none', 'b-auth', 'b-nogh', 'b-notgh', 'b-unknown']) {
      expect(button(branch)?.querySelector('[data-pr-chip],[data-pr-reason]')).toBeNull()
    }
    const chip = merged?.querySelector<HTMLElement>('[data-pr-chip]')
    act(() => chip?.click())
    act(() => button('b-auth')?.click())
    expect(opened).toEqual(['/w/merged', '/w/auth'])
  })
  it('pr 을 주지 않으면 base 와 같은 줄', () => {
    const views = [{ entry: { key: 'LIFE-1', connectionId: 'c1', trees: [TREES[2]!] }, lookup: LOADING }]
    act(() => root.render(createElement(WorkingList, { views, now: 0, onOpen: () => undefined })))
    expect([...(host.querySelector('button.tasks-working-tree')?.children ?? [])].map((child) => child.className)).toEqual(['tasks-working-dot', 'tasks-working-state', 'tasks-working-branch', 'tasks-working-chevron'])
  })
})

describe('C8 활동 PR 줄(화면)', () => {
  const change = (action: 'open' | 'merged' | 'closed', draft = false): Extract<WorkActivityChange, { event: 'pr' }> => ({ field: 'run', event: 'pr', action, worktree: '/w/x', number: 218, url: 'https://github.com/o/r/pull/218', branch: 'LIFE-372-la-issue-link', base: 'main', draft })
  it('문구 — 목업 「PR #218 초안을 열었습니다 — LIFE-372-la-issue-link → main」', () => {
    expect(describeChange({ change: change('open', true), statuses: [] })).toBe('PR #218 초안을 열었습니다 — LIFE-372-la-issue-link → main')
    expect(describeChange({ change: change('open'), statuses: [] })).toBe('PR #218 을 열었습니다 — LIFE-372-la-issue-link → main')
    expect(describeChange({ change: change('merged'), statuses: [] })).toBe('PR #218 이 머지됐습니다 — LIFE-372-la-issue-link → main')
    expect(describeChange({ change: { ...change('closed'), base: null }, statuses: [] })).toBe('PR #218 이 닫혔습니다 — LIFE-372-la-issue-link')
  })
  it('실행 갈래 · 전체에 보이고 at 순(PR 의 시각)', () => {
    const records: WorkActivityRecord[] = [
      { id: '1', connectionId: 'c1', itemId: '', itemKey: 'LIFE-1', at: 100, writeId: 'k1', eventKey: 'k1', change: change('open') },
      { id: '2', connectionId: 'c1', itemId: '', itemKey: 'LIFE-1', at: 300, writeId: 'k2', eventKey: 'k2', change: change('merged') },
      { id: '3', connectionId: 'c1', itemId: 'i', at: 200, writeId: 'w', change: { field: 'body', lines: 1 } },
    ]
    const rows = activityRows({ records, history: [], comments: [], statuses: [], sourceName: 'LA' })
    expect(rows.map((row) => row.id)).toEqual(['a:2', 'a:3', 'a:1'])
    expect(rows.filter((row) => passesActivity({ row, filter: 'run' })).map((row) => row.id)).toEqual(['a:2', 'a:1'])
    expect(rows.filter((row) => passesActivity({ row, filter: 'all' }))).toHaveLength(3)
    expect(activityCounts(rows)).toMatchObject({ all: 3, run: 2, change: 1 })
    expect(rows[0]).toMatchObject({ kind: 'run', who: 'GitHub' })
  })
})

describe('C11 보일 때만(화면)', () => {
  const linked = [tree('/w/b', 'b'), tree('/w/a', 'a')]
  it('prTargets — 페이지 닫힘 + 상세 숨김이면 빈 목록, 열리면 보이는 면의 worktree', () => {
    expect(prTargets({ pageOpen: false, detailShown: false, linked, detailTrees: [linked[0]!] })).toEqual([])
    expect(prTargets({ pageOpen: true, detailShown: false, linked, detailTrees: [] })).toEqual([{ path: '/w/a', branch: 'a' }, { path: '/w/b', branch: 'b' }])
    expect(prTargets({ pageOpen: false, detailShown: true, linked, detailTrees: [linked[0]!] })).toEqual([{ path: '/w/b', branch: 'b' }])
  })

  function Probe({ targets, seen }: { targets: { path: string; branch: string }[]; seen: (view: ReturnType<typeof usePrStatus>) => void }): null {
    seen(usePrStatus({ targets }))
    return null
  }
  it('대상이 비면 0 회 · 같은 대상 다시 그리기 0 회 · 브랜치가 바뀌거나 다시 열면 1 회 · 타이머 없음', async () => {
    const calls: string[][] = []
    const answer: PrBranchesResult = { lookups: { '/w/a': pr('merged') }, recorded: 2 }
    const prBranches: CorralApi['prBranches'] = async ({ paths }) => { calls.push(paths); return answer }
    const before: unknown = Reflect.get(window, 'corral')
    Reflect.set(window, 'corral', { prBranches })
    const timers = vi.spyOn(window, 'setInterval')
    const latest: { view: ReturnType<typeof usePrStatus> | null } = { view: null }
    const render = async (targets: { path: string; branch: string }[]): Promise<void> => {
      await act(async () => { root.render(createElement(Probe, { targets, seen: (next) => { latest.view = next } })) })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
    await render([])
    expect(calls).toHaveLength(0)
    await render([{ path: '/w/a', branch: 'a' }])
    await render([{ path: '/w/a', branch: 'a' }])
    expect(calls).toEqual([['/w/a']])
    expect(latest.view?.lookups.get('/w/a')).toEqual(pr('merged'))
    expect(latest.view?.recordedSeq).toBe(1)
    await render([{ path: '/w/a', branch: 'a2' }])
    expect(calls).toHaveLength(2)
    await render([])
    await render([{ path: '/w/a', branch: 'a2' }])
    expect(calls).toHaveLength(3)
    expect(timers).not.toHaveBeenCalled()
    Reflect.set(window, 'corral', before)
  })
})
