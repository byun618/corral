// 수동 순서 계산 단위 시험 (LIFE-469 K4ⓒ·K5·K6ⓐ·K7). 끌기 화면은 격리·네이티브 실행이 본다 — 여기서는 순서만.

import { describe, expect, it } from 'vitest'
import type { RepoRow, WorktreeRow } from '../../shared/types.js'
import {
  applyRepoMove,
  applyWorktreeMove,
  EMPTY_MANUAL_ORDER,
  forgetRepo,
  moveKey,
  orderRepos,
  orderWorktrees,
  readKeyList,
  readWorktreeOrder,
  reconcileManualOrder,
  type ManualOrder,
} from './manual-order.js'
import { sortWorktrees } from './worktree-name.js'

const GIT = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }

function wt(path: string, branch: string | null, isLinked = true): WorktreeRow {
  return { path, branch, isLinked, openWorkspaceId: null, workspace: null, gitStatus: { ...GIT, branch } }
}

function repo(root: string, linked: Array<[string, string | null]>, options: { error?: string; name?: string } = {}): RepoRow {
  return {
    root,
    name: options.name ?? root.split('/').pop() ?? root,
    error: options.error ?? null,
    worktrees: [wt(root, 'main', false), ...linked.map(([path, branch]) => wt(path, branch))],
  }
}

const paths = (rows: readonly WorktreeRow[]): string[] => rows.map((row) => row.path)
const roots = (rows: readonly RepoRow[]): string[] => rows.map((row) => row.root)

describe('K6ⓐ 저장된 순서가 없으면 이전 빌드 순서 그대로', () => {
  it('레포 = 들어온 순서(main 이 이름순으로 준다), 워크트리 = 주 체크아웃 → 이름순(sortWorktrees)', () => {
    const repos = [repo('/r/alpha', []), repo('/r/beta', []), repo('/r/gamma', [])]
    expect(roots(orderRepos({ repos, stored: [] }))).toEqual(['/r/alpha', '/r/beta', '/r/gamma'])
    const r = repo('/r/a', [['/r/a/z', 'zeta'], ['/r/a/b', 'beta'], ['/r/a/d', null]])
    const shuffled = [...r.worktrees].reverse()
    expect(paths(orderWorktrees({ worktrees: shuffled, stored: undefined }))).toEqual(paths(sortWorktrees(r.worktrees)))
    expect(paths(orderWorktrees({ worktrees: shuffled, stored: undefined }))[0]).toBe('/r/a')
  })

  it('첫 정규화(materialize) 뒤에도 화면 순서는 같다', () => {
    const repos = [repo('/r/a', [['/r/a/z', 'zeta'], ['/r/a/b', 'beta']]), repo('/r/b', [])]
    const before = repos.map((row) => paths(orderWorktrees({ worktrees: row.worktrees, stored: undefined })))
    const { order, changed } = reconcileManualOrder({ order: EMPTY_MANUAL_ORDER, repos })
    expect(changed).toBe(true)
    expect(order.repos).toEqual(['/r/a', '/r/b'])
    expect(order.worktrees).toEqual({ '/r/a': ['/r/a/b', '/r/a/z'], '/r/b': [] })
    expect(roots(orderRepos({ repos, stored: order.repos }))).toEqual(['/r/a', '/r/b'])
    expect(repos.map((row) => paths(orderWorktrees({ worktrees: row.worktrees, stored: order.worktrees[row.root] })))).toEqual(before)
  })
})

describe('K4ⓒ 정규화는 저장된 상대 순서를 다시 매기지 않는다 (C1)', () => {
  const stored: ManualOrder = { repos: ['/r/c', '/r/a', '/r/b'], worktrees: { '/r/a': ['/r/a/z', '/r/a/b', '/r/a/m'] } }
  const repos = [
    repo('/r/a', [['/r/a/b', 'b'], ['/r/a/m', 'm'], ['/r/a/z', 'z']]),
    repo('/r/b', []),
    repo('/r/c', []),
  ]

  it('같은 목록이면 바꾸지 않는다(파일을 다시 쓰지 않는다)', () => {
    const materialized = reconcileManualOrder({ order: stored, repos }).order
    const again = reconcileManualOrder({ order: materialized, repos })
    expect(again.changed).toBe(false)
    expect(again.order).toBe(materialized)
    expect(materialized.repos).toEqual(stored.repos)
    expect(materialized.worktrees['/r/a']).toEqual(stored.worktrees['/r/a'])
  })

  it('표시 = 저장 순서(이름순이 아니다)', () => {
    expect(roots(orderRepos({ repos, stored: stored.repos }))).toEqual(['/r/c', '/r/a', '/r/b'])
    expect(paths(orderWorktrees({ worktrees: repos[0]!.worktrees, stored: stored.worktrees['/r/a'] }))).toEqual(['/r/a', '/r/a/z', '/r/a/b', '/r/a/m'])
  })

  it('사라진 워크트리(앱 밖 git worktree remove) — 그 키만 빠지고 남은 순서 그대로', () => {
    const gone = [repo('/r/a', [['/r/a/b', 'b'], ['/r/a/m', 'm']]), repos[1]!, repos[2]!]
    const { order } = reconcileManualOrder({ order: stored, repos: gone })
    expect(order.worktrees['/r/a']).toEqual(['/r/a/b', '/r/a/m'])
    expect(order.repos).toEqual(stored.repos)
  })

  it('git 조회 오류인 레포는 사라진 것처럼 보여도 저장 키를 지우지 않는다', () => {
    const broken = [repo('/r/a', [], { error: 'git: boom' }), repos[1]!, repos[2]!]
    const { order } = reconcileManualOrder({ order: stored, repos: broken })
    expect(order.worktrees['/r/a']).toEqual(stored.worktrees['/r/a'])
    // 복구되면 원래 순서로 돌아온다.
    expect(paths(orderWorktrees({ worktrees: repos[0]!.worktrees, stored: order.worktrees['/r/a'] }))).toEqual(['/r/a', '/r/a/z', '/r/a/b', '/r/a/m'])
  })

  it('목록에서 레포가 잠시 빠져도(기동 직후 빈 목록 등) 레포 순서를 지우지 않는다', () => {
    expect(reconcileManualOrder({ order: stored, repos: [] }).changed).toBe(false)
    const { order } = reconcileManualOrder({ order: stored, repos: [repos[1]!] })
    expect(order.repos).toEqual(stored.repos)
    expect(order.worktrees['/r/a']).toEqual(stored.worktrees['/r/a'])
  })

  it('레포 제거(forgetRepo) — 그 키만 빠지고 남은 순서 그대로', () => {
    const next = forgetRepo({ order: stored, root: '/r/a' })
    expect(next.repos).toEqual(['/r/c', '/r/b'])
    expect(next.worktrees['/r/a']).toBeUndefined()
  })

  it('세션을 열고 닫아도(openWorkspaceId 변화) 순서가 움직이지 않는다 (H-1)', () => {
    const opened = repos.map((row) => ({ ...row, worktrees: row.worktrees.map((item) => ({ ...item, openWorkspaceId: item.path === '/r/a/m' ? 'w9' : null })) }))
    const { changed } = reconcileManualOrder({ order: reconcileManualOrder({ order: stored, repos }).order, repos: opened })
    expect(changed).toBe(false)
    expect(paths(orderWorktrees({ worktrees: opened[0]!.worktrees, stored: stored.worktrees['/r/a'] }))).toEqual(['/r/a', '/r/a/z', '/r/a/b', '/r/a/m'])
  })
})

describe('K5 새 항목 자리 = 198', () => {
  const stored: ManualOrder = { repos: ['/r/c', '/r/a'], worktrees: { '/r/a': ['/r/a/z', '/r/a/b'] } }

  it('ⓐ 새 워크트리 → 연결 워크트리 맨 위(주 체크아웃 바로 아래), 기존 상대 순서 무변경', () => {
    const repos = [repo('/r/a', [['/r/a/b', 'b'], ['/r/a/z', 'z'], ['/r/a/new', 'aaa-new']]), repo('/r/c', [])]
    expect(paths(orderWorktrees({ worktrees: repos[0]!.worktrees, stored: stored.worktrees['/r/a'] }))).toEqual(['/r/a', '/r/a/new', '/r/a/z', '/r/a/b'])
    const { order } = reconcileManualOrder({ order: stored, repos })
    expect(order.worktrees['/r/a']).toEqual(['/r/a/new', '/r/a/z', '/r/a/b'])
    // 그다음 또 하나 생기면 그것이 맨 위 — 198 의 `sortOrder: Date.now()` 와 같은 「최신이 위」.
    const more = [repo('/r/a', [['/r/a/b', 'b'], ['/r/a/z', 'z'], ['/r/a/new', 'aaa-new'], ['/r/a/newer', 'zzz']]), repo('/r/c', [])]
    expect(reconcileManualOrder({ order, repos: more }).order.worktrees['/r/a']).toEqual(['/r/a/newer', '/r/a/new', '/r/a/z', '/r/a/b'])
  })

  it('ⓑ 새 레포 → 맨 아래, 기존 상대 순서 무변경', () => {
    const repos = [repo('/r/a', [['/r/a/b', 'b'], ['/r/a/z', 'z']]), repo('/r/aa-new', []), repo('/r/c', [])]
    expect(roots(orderRepos({ repos, stored: stored.repos }))).toEqual(['/r/c', '/r/a', '/r/aa-new'])
    const { order } = reconcileManualOrder({ order: stored, repos })
    expect(order.repos).toEqual(['/r/c', '/r/a', '/r/aa-new'])
    expect(order.worktrees['/r/aa-new']).toEqual([])
  })

  it('제거했다 다시 추가한 레포도 맨 아래', () => {
    const removed = forgetRepo({ order: stored, root: '/r/c' })
    const repos = [repo('/r/a', [['/r/a/b', 'b'], ['/r/a/z', 'z']]), repo('/r/c', [])]
    expect(reconcileManualOrder({ order: removed, repos }).order.repos).toEqual(['/r/a', '/r/c'])
  })
})

describe('K7 옮기기 (moveKey·applyRepoMove·applyWorktreeMove)', () => {
  const keys = ['a', 'b', 'c', 'd']

  it('맨 앞·맨 뒤·가운데로', () => {
    expect(moveKey({ keys, key: 'c', slot: 0 })).toEqual(['c', 'a', 'b', 'd'])
    expect(moveKey({ keys, key: 'a', slot: 4 })).toEqual(['b', 'c', 'd', 'a'])
    expect(moveKey({ keys, key: 'a', slot: 2 })).toEqual(['b', 'a', 'c', 'd'])
    expect(moveKey({ keys, key: 'd', slot: 1 })).toEqual(['a', 'd', 'b', 'c'])
  })

  it('제자리(자기 위·아래 경계)면 null — 파일을 쓰지 않는다', () => {
    expect(moveKey({ keys, key: 'b', slot: 1 })).toBeNull()
    expect(moveKey({ keys, key: 'b', slot: 2 })).toBeNull()
    expect(moveKey({ keys, key: 'x', slot: 0 })).toBeNull()
  })

  it('범위 밖 slot 은 끝으로 자른다', () => {
    expect(moveKey({ keys, key: 'b', slot: 99 })).toEqual(['a', 'c', 'd', 'b'])
    expect(moveKey({ keys, key: 'b', slot: -3 })).toEqual(['b', 'a', 'c', 'd'])
  })

  it('여러 번 옮겨도 간격 고갈이 없다 — 키 배열이라 재색인이 필요 없다', () => {
    let order = ['a', 'b', 'c']
    for (let index = 0; index < 500; index++) order = moveKey({ keys: order, key: order[2]!, slot: 1 }) ?? order
    expect([...order].sort()).toEqual(['a', 'b', 'c'])
    expect(order).toHaveLength(3)
  })

  it('레포 옮기기는 화면 순서로 다시 적고, 화면에 없던 저장 키는 뒤에 그대로 둔다', () => {
    const order: ManualOrder = { repos: ['/r/a', '/gone', '/r/b', '/r/c'], worktrees: {} }
    const next = applyRepoMove({ order, visibleRoots: ['/r/a', '/r/b', '/r/c'], root: '/r/c', slot: 0 })
    expect(next?.repos).toEqual(['/r/c', '/r/a', '/r/b', '/gone'])
  })

  it('워크트리 옮기기는 그 레포 목록만 바꾼다 — 다른 레포·레포 순서 무변경', () => {
    const order: ManualOrder = { repos: ['/r/a', '/r/b'], worktrees: { '/r/a': ['/r/a/1', '/r/a/2', '/r/a/3'], '/r/b': ['/r/b/1'] } }
    const next = applyWorktreeMove({ order, repoRoot: '/r/a', visiblePaths: ['/r/a/1', '/r/a/2', '/r/a/3'], path: '/r/a/3', slot: 0 })
    expect(next).toEqual({ repos: ['/r/a', '/r/b'], worktrees: { '/r/a': ['/r/a/3', '/r/a/1', '/r/a/2'], '/r/b': ['/r/b/1'] } })
  })

  it('주 체크아웃은 저장 목록에 없고 늘 맨 위다 — 저장 목록 맨 앞으로 옮겨도 그 아래', () => {
    const r = repo('/r/a', [['/r/a/1', 'x'], ['/r/a/2', 'y']])
    const next = applyWorktreeMove({ order: EMPTY_MANUAL_ORDER, repoRoot: '/r/a', visiblePaths: ['/r/a/1', '/r/a/2'], path: '/r/a/2', slot: 0 })
    expect(paths(orderWorktrees({ worktrees: r.worktrees, stored: next?.worktrees['/r/a'] }))).toEqual(['/r/a', '/r/a/2', '/r/a/1'])
    // 손으로 주 체크아웃 path 를 저장 목록에 넣어도 맨 위 고정은 그대로다.
    expect(paths(orderWorktrees({ worktrees: r.worktrees, stored: ['/r/a/2', '/r/a', '/r/a/1'] }))).toEqual(['/r/a', '/r/a/2', '/r/a/1'])
  })

  it('끌기 대상에서 빠지는 카드 종류가 없다 — detached·열림/닫힘 모두 저장 목록에 들어간다 (C2)', () => {
    const r: RepoRow = {
      root: '/r/a', name: 'a', error: null,
      worktrees: [wt('/r/a', 'main', false), wt('/r/a/det', null), { ...wt('/r/a/open', 'open'), openWorkspaceId: 'w1' }, wt('/r/a/closed', 'closed')],
    }
    const { order } = reconcileManualOrder({ order: EMPTY_MANUAL_ORDER, repos: [r] })
    expect([...(order.worktrees['/r/a'] ?? [])].sort()).toEqual(['/r/a/closed', '/r/a/det', '/r/a/open'])
  })
})

describe('읽기 — 손상된 칸 (K4ⓓ)', () => {
  it('문자열만·중복은 첫 자리만', () => {
    expect(readKeyList(['a', 1, 'b', 'a', null, ''])).toEqual(['a', 'b'])
    expect(readKeyList('a')).toEqual([])
    expect(readWorktreeOrder({ '/r': ['x', 'x', 2], '/s': 'nope' })).toEqual({ '/r': ['x'] })
    expect(readWorktreeOrder(['x'])).toEqual({})
    expect(readWorktreeOrder(null)).toEqual({})
  })
})
