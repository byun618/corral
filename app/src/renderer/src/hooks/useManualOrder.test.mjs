// useManualOrder hook 수준 시험 (LIFE-469 수정 라운드 1 — 리뷰 CDX-R1-04 재현을 실제 hook 에).
// React 스케줄만 가짜다(fake-react.test-helper.mjs). 제거 IPC 가 트리 재조립보다 먼저 답하는 순서를 그대로 흉내 낸다.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => import('./fake-react.test-helper.mjs'))

const { HookHost } = await import('./fake-react.test-helper.mjs')
const { useManualOrder } = await import('./useManualOrder.js')
const { orderRepos, orderWorktrees } = await import('../manual-order.js')

const worktree = (path, isLinked) => ({ path, branch: path.split('/').at(-1), isLinked, openWorkspaceId: null, workspace: null })
const repo = (root, linked = []) => ({ root, name: root, error: null, worktrees: [worktree(root, false), ...linked.map((path) => worktree(path, true))] })

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 가짜 main — 레지스트리(즉시 바뀜·세대 +1)와 트리 스냅샷(따로 늦게 옴)을 나눠 흉내 낸다. 렌더러가 보는 레지스트리는
 * `emit()` 때만 바뀐다(main `scheduleEmit` 은 IPC 응답 뒤 setTimeout 0). 트리는 `tree()` 로만 바뀐다 — main 의
 * `scheduleTree` 80ms 합침·`rebuildTree` 세대 버림 때문에 어떤 중간 트리는 아예 오지 않을 수 있다(R2-01).
 */
function setup(initial) {
  const writes = []
  vi.stubGlobal('window', { corral: { setUiPrefs: (patch) => writes.push(JSON.parse(JSON.stringify(patch))) } })
  const host = new HookHost()
  let registry = [...initial]
  let generation = 0
  let emitted = { roots: [...initial], generation: 0 }
  const linked = {}
  let repos = initial.map((root) => repo(root))
  const render = () => host.render(() => useManualOrder({ repos, registry: emitted }))
  return {
    writes,
    render,
    linked,
    remove(root) {
      registry = registry.filter((item) => item !== root)
      return ++generation
    },
    add(root) {
      if (!registry.includes(root)) registry = [...registry, root]
      return ++generation
    },
    emit() {
      emitted = { roots: [...registry].sort(), generation }
      return render()
    },
    tree(roots) {
      repos = roots.map((root) => repo(root, linked[root] ?? []))
      return render()
    },
    visible(api) {
      return orderRepos({ repos, stored: api.order.repos }).map((row) => row.root)
    },
    visibleWorktrees(api, root) {
      const row = repos.find((item) => item.root === root)
      return orderWorktrees({ worktrees: row.worktrees, stored: api.order.worktrees[root] }).map((item) => item.path)
    },
  }
}

describe('R1-04 — GUI 로 제거한 레포 키는 옛 목록으로 되살아나지 않는다', () => {
  it('[B,A,C] 에서 B 제거(트리 갱신 전) → D 등록 → B 재등록 = [A,C,D,B] (리뷰 r1 재현 removeThenRegister)', () => {
    const t = setup(['/a', '/b', '/c'])
    let api = t.render()
    api.hydrate({ manualRepoOrder: ['/b', '/a', '/c'], manualWorktreeOrder: { '/a': [], '/b': [], '/c': [] } })
    api = t.render()
    // 제거 IPC 응답 — 트리도, 렌더러가 본 레지스트리도 아직 B 를 담고 있다.
    api.forget({ root: '/b', registryGeneration: t.remove('/b') })
    api = t.render()
    expect(api.order.repos).toEqual(['/a', '/c'])
    expect(t.writes.at(-1)?.manualRepoOrder).toEqual(['/a', '/c'])
    api = t.emit()
    expect(api.order.repos).toEqual(['/a', '/c'])
    // 80ms 뒤 트리 재조립 — B 가 빠진다.
    api = t.tree(['/a', '/c'])
    t.add('/d')
    t.emit()
    api = t.tree(['/a', '/c', '/d'])
    t.add('/b')
    t.emit()
    api = t.tree(['/a', '/b', '/c', '/d'])
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
    const removedAt = t.remove('/b')
    t.emit()
    api = t.tree(['/a', '/c'])
    api.forget({ root: '/b', registryGeneration: removedAt })
    api = t.render()
    t.add('/d')
    t.emit()
    api = t.tree(['/a', '/c', '/d'])
    t.add('/b')
    t.emit()
    api = t.tree(['/a', '/b', '/c', '/d'])
    expect(api.order.repos).toEqual(['/a', '/c', '/d', '/b'])
  })

  it('앱 밖에서 사라진 레포(forget 없음)는 키를 지우지 않는다 — 기존 정책 유지(C1·#22285)', () => {
    const t = setup(['/a', '/b', '/c'])
    let api = t.render()
    api.hydrate({ manualRepoOrder: ['/b', '/a', '/c'], manualWorktreeOrder: {} })
    api = t.render()
    api = t.tree(['/a', '/c'])
    api = t.tree(['/a', '/b', '/c'])
    expect(t.visible(api)).toEqual(['/b', '/a', '/c'])
  })
})

describe('R2-01 — 제거·재등록 사이의 「B 없는」 스냅샷이 오지 않아도 대기 키가 풀린다', () => {
  // 리뷰 r2 재현 coalescedRemoveReadd: 기대 [A,C,B,D], B 의 새 워크트리는 주 체크아웃 바로 아래.
  function removeThenReaddWithoutAbsentTree({ deliverAbsentTree }) {
    const t = setup(['/a', '/b', '/c'])
    t.linked['/b'] = ['/b-wt/alpha']
    let api = t.tree(['/a', '/b', '/c'])
    api.hydrate({ manualRepoOrder: ['/b', '/a', '/c'], manualWorktreeOrder: { '/a': [], '/b': ['/b-wt/alpha'], '/c': [] } })
    api = t.render()
    api.forget({ root: '/b', registryGeneration: t.remove('/b') })
    api = t.render()
    api = t.emit()
    if (deliverAbsentTree) api = t.tree(['/a', '/c'])
    // 재등록 — 80ms 합침·세대 버림으로 B 없는 트리가 오지 않았을 수 있다.
    t.add('/b')
    api = t.emit()
    api = t.tree(['/a', '/b', '/c'])
    t.add('/d')
    api = t.emit()
    api = t.tree(['/a', '/b', '/c', '/d'])
    const reposAfter = { stored: api.order.repos, visible: t.visible(api) }
    t.linked['/b'] = ['/b-wt/alpha', '/b-wt/zulu']
    api = t.tree(['/a', '/b', '/c', '/d'])
    return { reposAfter, bWorktrees: t.visibleWorktrees(api, '/b'), storedB: api.order.worktrees['/b'] }
  }

  it('B 없는 트리 없이 재등록 → D 추가 = [A,C,B,D], B 새 워크트리 zulu = [main, zulu, alpha]', () => {
    const got = removeThenReaddWithoutAbsentTree({ deliverAbsentTree: false })
    expect(got.reposAfter).toEqual({ stored: ['/a', '/c', '/b', '/d'], visible: ['/a', '/c', '/b', '/d'] })
    expect(got.bWorktrees).toEqual(['/b', '/b-wt/zulu', '/b-wt/alpha'])
    expect(got.storedB).toEqual(['/b-wt/zulu', '/b-wt/alpha'])
  })

  it('양성 대조 — B 없는 트리를 한 번 받아도 같은 결과', () => {
    const got = removeThenReaddWithoutAbsentTree({ deliverAbsentTree: true })
    expect(got.reposAfter).toEqual({ stored: ['/a', '/c', '/b', '/d'], visible: ['/a', '/c', '/b', '/d'] })
    expect(got.bWorktrees).toEqual(['/b', '/b-wt/zulu', '/b-wt/alpha'])
  })

  it('제거 뒤 세대라도 B 가 레지스트리에 없으면(다른 레포 추가) 대기는 유지 — 옛 트리가 B 를 다시 끼우지 않는다', () => {
    const t = setup(['/a', '/b', '/c'])
    let api = t.render()
    api.hydrate({ manualRepoOrder: ['/b', '/a', '/c'], manualWorktreeOrder: {} })
    api = t.render()
    api.forget({ root: '/b', registryGeneration: t.remove('/b') })
    t.add('/d')
    api = t.emit()
    // 옛 트리(B 포함)가 아직 화면에 있다.
    api = t.tree(['/a', '/b', '/c'])
    expect(api.order.repos).toEqual(['/a', '/c'])
  })
})
