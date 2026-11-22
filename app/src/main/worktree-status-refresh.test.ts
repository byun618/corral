// LIFE-831 K7 — 카드·상태바 git 상태 재조회는 그 경로만(캐시 무효화·git 1회), 늦게 끝난 앞 재빌드가 새 값을 덮지 않는다, 겹친 요청은 마지막 값.
import { describe, expect, it } from 'vitest'
import type { GitStatusSummary } from '../shared/types.js'
import type { RepoSkeleton } from './tree.js'
import { patchWorktreeStatus, WorktreeStatusRefresh } from './worktree-status-refresh.js'

const st = (ahead: number, behind = 0): GitStatusSummary => ({ branch: 'main', upstream: 'origin/main', ahead, behind, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null })
const tree = (values: Record<string, GitStatusSummary>): RepoSkeleton[] => [
  { root: '/repo', name: 'repo', error: null, gitError: null, openError: null, worktrees: Object.entries(values).map(([path, gitStatus]) => ({ path, branch: 'main', head: null, isLinked: false, openWorkspaceId: 'w', gitStatus })) },
]
const aheadOf = (skeleton: RepoSkeleton[], path: string): number | null | undefined => skeleton[0]?.worktrees.find((worktree) => worktree.path === path)?.gitStatus.ahead

describe('WorktreeStatusRefresh (K7)', () => {
  it('그 경로만 캐시를 지우고 한 번 읽는다 — 다른 worktree 는 git 0(K7ⓒ), 골격의 그 줄만 바뀐다', async () => {
    const invalidated: string[] = []
    const reads: string[] = []
    const refresh = new WorktreeStatusRefresh({ invalidate: (path) => invalidated.push(path), read: async (path) => (reads.push(path), st(3)) })
    const value = await refresh.refresh('/a')
    expect(invalidated).toEqual(['/a'])
    expect(reads).toEqual(['/a'])
    const patched = patchWorktreeStatus({ skeleton: tree({ '/a': st(1), '/b': st(7) }), path: '/a', value: value ?? st(-1) })
    expect(patched.found).toBe(true)
    expect(aheadOf(patched.skeleton, '/a')).toBe(3)
    expect(aheadOf(patched.skeleton, '/b')).toBe(7)
    expect(patchWorktreeStatus({ skeleton: tree({ '/b': st(7) }), path: '/a', value: st(3) }).found).toBe(false)
  })
  it('앞서 시작한 재빌드가 동작 전 값을 들고 늦게 끝나도 새 값이 남는다 · 그 뒤 시작한 재빌드에는 덧씌우지 않는다', async () => {
    let clock = 100
    const refresh = new WorktreeStatusRefresh({ invalidate: () => {}, read: async () => st(2), now: () => clock })
    // 재빌드 R1 시작(시각 50) → 동작 끝 재조회(시각 100) → R1 이 옛 값(ahead 1)으로 끝남.
    await refresh.refresh('/a')
    const overlaid = refresh.overlay({ built: tree({ '/a': st(1), '/b': st(5) }), startedAt: 50 })
    expect(aheadOf(overlaid, '/a')).toBe(2)
    expect(aheadOf(overlaid, '/b')).toBe(5)
    // 재빌드 R2 는 재조회 뒤(시각 200) 시작 — 자기 값을 쓴다(덧씌우지 않는다).
    clock = 300
    expect(aheadOf(refresh.overlay({ built: tree({ '/a': st(9) }), startedAt: 200 }), '/a')).toBe(9)
    // R2 가 지운 뒤에는 더 앞선 재빌드가 와도 덧씌울 것이 없다.
    expect(aheadOf(refresh.overlay({ built: tree({ '/a': st(1) }), startedAt: 10 }), '/a')).toBe(1)
  })
  it('같은 경로 겹친 요청 — 먼저 부른 것이 늦게 끝나면 버린다(null)', async () => {
    const resolvers: ((value: GitStatusSummary) => void)[] = []
    const refresh = new WorktreeStatusRefresh({ invalidate: () => {}, read: () => new Promise((resolve) => resolvers.push(resolve)) })
    const first = refresh.refresh('/a')
    const second = refresh.refresh('/a')
    resolvers[1]?.(st(4))
    resolvers[0]?.(st(1))
    expect(await second).toEqual(st(4))
    expect(await first).toBeNull()
    expect(aheadOf(refresh.overlay({ built: tree({ '/a': st(0) }), startedAt: -1 }), '/a')).toBe(4)
  })
})
