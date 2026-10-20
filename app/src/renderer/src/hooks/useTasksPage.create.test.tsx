// @vitest-environment happy-dom
// LIFE-604 R2-F — 페이지 생성 잠금(`creating`)을 직접 본다. 화면은 phase·보내는 중 표시가 먼저 막아 이 잠금에 닿지 않는다 —
// 마지막 칸막이라 시험이 없으면 지워도 모른다(리뷰 r2 변이 M-g). 같은 열쇠로 동시에 두 번 → 출처 요청 1건 · 둘째는 보내지 않고 실패.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkRequest, WorkResponse } from '../../../shared/work.js'
import { useTasksPage, type CreateOutcome, type TasksPageModel } from './useTasksPage.js'

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
})

let model: TasksPageModel | null = null
function Probe(): null {
  model = useTasksPage({ open: false, repos: [], activeRepoRoot: null, notify: () => {} })
  return null
}

describe('페이지 생성 잠금 (R2-F)', () => {
  it('같은 잠금 열쇠로 겹쳐 보내면 출처 요청 1건 — 둘째는 보내지 않고 실패, 첫째가 끝나면 다시 보낼 수 있다', async () => {
    const sent: WorkRequest[] = []
    const release: (() => void)[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      getWorkSettings: async () => ({ sources: [], connections: [], repoDefaults: [] }),
      onWorkSettings: () => () => {},
      workRequest: (request: WorkRequest): Promise<WorkResponse> => {
        sent.push(request)
        const answer: WorkResponse = { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'rejected', message: '거절', status: null } }
        // 첫 요청만 붙잡는다 — 잠금을 빼도 둘째가 바로 끝나 시험이 매달리지 않고 「출처 요청 1건」 단언에서 실패한다(R3-G(c)).
        if (sent.length > 1) return Promise.resolve(answer)
        return new Promise((resolve) => { release.push(() => resolve(answer)) })
      },
    })
    act(() => root.render(createElement(Probe)))
    if (model === null) throw new Error('훅 없음')
    const page = model
    const call: WorkCall = { op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: 't' }
    let first: Promise<CreateOutcome> | null = null
    let second: CreateOutcome | null = null
    await act(async () => {
      first = page.createItem({ lockKey: 'create:modal', connectionId: 'c1', call })
      second = await page.createItem({ lockKey: 'create:modal', connectionId: 'c1', call })
    })
    expect(sent.filter((request) => request.call.op === 'createItem')).toHaveLength(1)
    expect(second).toMatchObject({ kind: 'failed', error: { kind: 'invalid_request' } })
    await act(async () => { for (const done of release.splice(0)) done(); await first })
    // 잠금이 풀렸다 — 다시 보낸다.
    await act(async () => {
      const again = page.createItem({ lockKey: 'create:modal', connectionId: 'c1', call })
      await Promise.resolve()
      for (const done of release.splice(0)) done()
      await again
    })
    expect(sent.filter((request) => request.call.op === 'createItem')).toHaveLength(2)
  })
})
