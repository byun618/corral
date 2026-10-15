// @vitest-environment happy-dom
// LIFE-603 R1-Q·R — 제목 요청 동시성 상한(4) · 오류 키 재요청(30초 뒤) · 못 찾음은 다시 묻지 않음.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkRequest, WorkResponse } from '../../../shared/work.js'
import { testRepo, testWorktree } from '../../../shared/test-rows.js'
import { useLinkTitles, type LinkTitle } from './useLinkTitles.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let root: Root
let container: HTMLElement
let seen: ReadonlyMap<string, LinkTitle> = new Map()

function Probe({ repos }: { repos: RepoRow[] }): null {
  seen = useLinkTitles({ repos, refresh: 0 })
  return null
}

const repoWith = (keys: string[]): RepoRow[] => [testRepo({ root: '/r', worktrees: keys.map((key) => testWorktree({ path: `/r/${key}`, branch: key, workLink: { mode: 'auto', sourceId: 'm', connectionId: 'c1', key, itemId: null, connected: true } })) })]
const missing = (request: WorkRequest): WorkResponse => ({ requestId: request.requestId, connectionId: request.connectionId, ok: true, result: { op: 'findByKey', item: null } })

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useLinkTitles', () => {
  it('링크 10개여도 동시에 나가는 요청은 4개까지 — 끝나는 대로 다음을 보내 전부 묻는다', async () => {
    const pending: { request: WorkRequest; resolve: (response: WorkResponse) => void }[] = []
    let peak = 0
    Reflect.set(window, 'corral', { workRequest: (request: WorkRequest) => new Promise<WorkResponse>((resolve) => { pending.push({ request, resolve }); peak = Math.max(peak, pending.length) }) })
    await act(async () => root.render(<Probe repos={repoWith(Array.from({ length: 10 }, (_, index) => `K-${index}`))} />))
    expect(pending).toHaveLength(4)
    while (pending.length > 0) {
      const next = pending.shift()
      if (next === undefined) break
      await act(async () => { next.resolve(missing(next.request)) })
    }
    expect(peak).toBe(4)
    expect([...seen.values()].every((title) => title.state === 'missing')).toBe(true)
    expect(seen.size).toBe(10)
  })
  it('오류는 30초 뒤 다시 묻고, 못 찾음은 다시 묻지 않는다', async () => {
    const requests: string[] = []
    let fail = true
    Reflect.set(window, 'corral', {
      workRequest: async (request: WorkRequest): Promise<WorkResponse> => {
        const key = request.call.op === 'findByKey' ? request.call.key : ''
        requests.push(key)
        if (key === 'E-1' && fail) return { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'network', message: '끊김', status: null } }
        return missing(request)
      },
    })
    await act(async () => root.render(<Probe repos={repoWith(['E-1', 'M-1'])} />))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(seen.get('c1::E-1')?.state).toBe('error')
    expect(requests.sort()).toEqual(['E-1', 'M-1'])
    fail = false
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(requests.filter((key) => key === 'E-1')).toHaveLength(2)
    expect(requests.filter((key) => key === 'M-1')).toHaveLength(1)
    expect(seen.get('c1::E-1')?.state).toBe('missing')
  })
})
