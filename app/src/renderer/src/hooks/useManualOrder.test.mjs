// useManualOrder hook 수준 시험 (LIFE-469 수정 라운드 1 — 리뷰 CDX-R1-04 재현을 실제 hook 에).
// React 스케줄만 가짜다(fake-react.test-helper.mjs). 제거 IPC 가 트리 재조립보다 먼저 답하는 순서를 그대로 흉내 낸다.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => import('./fake-react.test-helper.mjs'))

const { HookHost } = await import('./fake-react.test-helper.mjs')
const { useManualOrder } = await import('./useManualOrder.js')
const { orderRepos } = await import('../manual-order.js')

const repo = (root) => ({ root, name: root, error: null, worktrees: [{ path: root, branch: 'main', isLinked: false, openWorkspaceId: null, workspace: null }] })

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup(initial) {
  const writes = []
  vi.stubGlobal('window', { corral: { setUiPrefs: (patch) => writes.push(JSON.parse(JSON.stringify(patch))) } })
  const host = new HookHost()
  let repos = initial.map(repo)
  const render = () => host.render(() => useManualOrder(repos))
  return {
    writes,
    render,
    setRepos(roots) {
      repos = roots.map(repo)
      return render()
    },
    visible(api) {
      return orderRepos({ repos, stored: api.order.repos }).map((row) => row.root)
    },
  }
}

describe('R1-04 — GUI 로 제거한 레포 키는 옛 목록으로 되살아나지 않는다', () => {
  it('[B,A,C] 에서 B 제거(트리 갱신 전) → D 등록 → B 재등록 = [A,C,D,B] (리뷰 재현 removeThenRegister)', () => {
    const t = setup(['/a', '/b', '/c'])
    let api = t.render()
    api.hydrate({ manualRepoOrder: ['/b', '/a', '/c'], manualWorktreeOrder: { '/a': [], '/b': [], '/c': [] } })
    api = t.render()
    // 제거 IPC 응답 — 트리는 아직 B 를 담고 있다.
    api.forget('/b')
    api = t.render()
    expect(api.order.repos).toEqual(['/a', '/c'])
    expect(t.writes.at(-1)?.manualRepoOrder).toEqual(['/a', '/c'])
    // 80ms 뒤 트리 재조립 — B 가 빠진다.
    api = t.setRepos(['/a', '/c'])
    api = t.setRepos(['/a', '/c', '/d'])
    api = t.setRepos(['/a', '/b', '/c', '/d'])
    expect(t.visible(api)).toEqual(['/a', '/c', '/d', '/b'])
    expect(api.order.repos).toEqual(['/a', '/c', '/d', '/b'])
    expect(t.writes.at(-1)?.manualRepoOrder).toEqual(['/a', '/c', '/d', '/b'])
    // 제거한 레포의 워크트리 순서 칸도 재등록 전까지 다시 적지 않았다.
    expect(t.writes.slice(0, -1).every((write) => !('/b' in write.manualWorktreeOrder))).toBe(true)
  })

  it('트리가 IPC 응답보다 먼저 와도 같다', () => {
    const t = setup(['/a', '/b', '/c'])
    let api = t.render()
    api.hydrate({ manualRepoOrder: ['/b', '/a', '/c'], manualWorktreeOrder: {} })
    api = t.render()
    api = t.setRepos(['/a', '/c'])
    api.forget('/b')
    api = t.render()
    api = t.setRepos(['/a', '/c', '/d'])
    api = t.setRepos(['/a', '/b', '/c', '/d'])
    expect(api.order.repos).toEqual(['/a', '/c', '/d', '/b'])
  })

  it('앱 밖에서 사라진 레포(forget 없음)는 키를 지우지 않는다 — 기존 정책 유지(C1·#22285)', () => {
    const t = setup(['/a', '/b', '/c'])
    let api = t.render()
    api.hydrate({ manualRepoOrder: ['/b', '/a', '/c'], manualWorktreeOrder: {} })
    api = t.render()
    api = t.setRepos(['/a', '/c'])
    api = t.setRepos(['/a', '/b', '/c'])
    expect(t.visible(api)).toEqual(['/b', '/a', '/c'])
  })
})
