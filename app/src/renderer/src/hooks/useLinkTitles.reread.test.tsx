// @vitest-environment happy-dom
// LIFE-755 r3 R·Q·S·T — 쓰기 계기 재조회(`reread`): 연결 필터 · 줄마다 마지막 답만(tickets) · 오류는 받은 제목을 지우지 않음 ·
// 오류 재시도 타이머도 마지막 요청만 · 한 렌더에 연결 둘이 바뀌어도 둘 다 다시 묻는다.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkItem, WorkRequest, WorkResponse } from '../../../shared/work.js'
import { testRepo, testWorktree } from '../../../shared/test-rows.js'
import { useLinkTitles, type LinkTitle, type LinkTitleReread } from './useLinkTitles.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let root: Root
let container: HTMLElement
let seen: ReadonlyMap<string, LinkTitle> = new Map()
type Pending = { request: WorkRequest; resolve: (response: WorkResponse) => void }
let pending: Pending[] = []

function Probe({ repos, reread }: { repos: RepoRow[]; reread: LinkTitleReread }): null {
  seen = useLinkTitles({ repos, refresh: 0, reread })
  return null
}

/** 링크 둘 — K-1 은 연결 c1, K-2 는 연결 c2. */
const REPOS: RepoRow[] = [testRepo({ root: '/r', worktrees: [
  testWorktree({ path: '/r/a', branch: 'K-1', workLink: { mode: 'auto', sourceId: 'm', connectionId: 'c1', key: 'K-1', itemId: null, connected: true } }),
  testWorktree({ path: '/r/b', branch: 'K-2', workLink: { mode: 'auto', sourceId: 'm', connectionId: 'c2', key: 'K-2', itemId: null, connected: true } }),
] })]
const keyOf = (request: WorkRequest): string => (request.call.op === 'findByKey' ? request.call.key : '')
const item = ({ key, title }: { key: string; title: string }): WorkItem => ({
  bodyLock: null, doneAt: null, id: key, key, spaceKey: 'K', title, body: null, kind: { key: 'task', label: 'Task', childKinds: [] }, statusKey: 'todo', category: 'todo', priority: 'medium', dueAt: null,
  parentId: null, placement: 'board', rank: null, resolution: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [],
})
const found = (request: WorkRequest, title: string): WorkResponse => ({
  requestId: request.requestId, connectionId: request.connectionId, ok: true,
  result: { op: 'findByKey', item: item({ key: keyOf(request), title }) },
})
const failed = (request: WorkRequest): WorkResponse => ({ requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'network', message: '끊김', status: null } })
const titleOf = (id: string): string | null => { const value = seen.get(id); return value?.state === 'found' ? value.item.title : value?.state ?? null }
const asked = (key: string): number => pending.filter((entry) => keyOf(entry.request) === key).length

async function render(reread: LinkTitleReread): Promise<void> {
  await act(async () => root.render(<Probe repos={REPOS} reread={reread} />))
}
/** 기다리는 요청 중 key 의 n 번째(0부터)를 답한다. */
async function answer(key: string, index: number, response: (request: WorkRequest) => WorkResponse): Promise<void> {
  const target = pending.filter((entry) => keyOf(entry.request) === key)[index]
  if (target === undefined) throw new Error(`요청 없음 ${key}#${index}`)
  await act(async () => { target.resolve(response(target.request)) })
}

beforeEach(() => {
  vi.useFakeTimers()
  pending = []
  Reflect.set(window, 'corral', { workRequest: (request: WorkRequest) => new Promise<WorkResponse>((resolve) => { pending.push({ request, resolve }) }) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function loaded(): Promise<void> {
  await render(new Map())
  await answer('K-1', 0, (request) => found(request, '하나'))
  await answer('K-2', 0, (request) => found(request, '둘'))
  expect([titleOf('c1::K-1'), titleOf('c2::K-2')]).toEqual(['하나', '둘'])
}

describe('useLinkTitles reread', () => {
  it('연결 필터 — c1 회차만 바뀌면 c1 의 링크만 다시 묻는다(c2 findByKey 추가 0)', async () => {
    await loaded()
    await render(new Map([['c1', 1]]))
    expect([asked('K-1'), asked('K-2')]).toEqual([2, 1])
    await answer('K-1', 1, (request) => found(request, '하나 새'))
    expect([titleOf('c1::K-1'), titleOf('c2::K-2')]).toEqual(['하나 새', '둘'])
  })
  it('한 렌더에 연결 둘의 회차가 같이 바뀌어도 둘 다 다시 묻는다(r3 T)', async () => {
    await loaded()
    await render(new Map([['c1', 1], ['c2', 1]]))
    expect([asked('K-1'), asked('K-2')]).toEqual([2, 2])
  })
  it('tickets — 같은 줄의 앞선 답이 새 답보다 늦게 와도 새 답이 남는다', async () => {
    await loaded()
    await render(new Map([['c1', 1]]))
    await render(new Map([['c1', 2]]))
    expect(asked('K-1')).toBe(3)
    await answer('K-1', 2, (request) => found(request, '새 답'))
    await answer('K-1', 1, (request) => found(request, '앞선 답'))
    expect(titleOf('c1::K-1')).toBe('새 답')
  })
  it('재조회가 실패해도 받은 제목을 지우지 않고(r3 Q), 30초 뒤 다시 물어 새 값을 받는다', async () => {
    await loaded()
    await render(new Map([['c1', 1]]))
    await answer('K-1', 1, failed)
    expect(titleOf('c1::K-1')).toBe('하나')
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(asked('K-1')).toBe(3)
    await answer('K-1', 2, (request) => found(request, '재시도 값'))
    expect(titleOf('c1::K-1')).toBe('재시도 값')
  })
  it('오류 재시도 타이머는 그 사이 새 요청이 나갔으면 다시 묻지 않는다(r3 S)', async () => {
    await loaded()
    await render(new Map([['c1', 1]]))
    await answer('K-1', 1, failed)
    await render(new Map([['c1', 2]]))
    await answer('K-1', 2, (request) => found(request, '성공'))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(asked('K-1')).toBe(3)
    expect(titleOf('c1::K-1')).toBe('성공')
  })
})
