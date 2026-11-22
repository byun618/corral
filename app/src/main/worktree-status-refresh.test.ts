// LIFE-831 K7 — 카드·상태바 git 상태 재조회는 그 경로만(캐시 무효화·git 1회), 재빌드가 먼저 읽은 낡은 값만 덮는다(스냅샷 순번), 겹친 요청은 마지막 값.
// 진짜 `getGitStatus` 캐시와의 경합 장면은 `git-status-race.test.ts`(수정 r1 C1).
import { describe, expect, it } from 'vitest'
import type { GitStatusSummary } from '../shared/types.js'
import type { RepoSkeleton } from './tree.js'
import { patchWorktreeStatus, WorktreeStatusRefresh } from './worktree-status-refresh.js'

const st = (ahead: number, behind = 0): GitStatusSummary => ({ branch: 'main', upstream: 'origin/main', ahead, behind, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null })
const tree = (values: Record<string, GitStatusSummary>): RepoSkeleton[] => [
  { root: '/repo', name: 'repo', error: null, gitError: null, openError: null, worktrees: Object.entries(values).map(([path, gitStatus]) => ({ path, branch: 'main', head: null, isLinked: false, openWorkspaceId: 'w', gitStatus })) },
]
const aheadOf = (skeleton: RepoSkeleton[], path: string): number | null | undefined => skeleton[0]?.worktrees.find((worktree) => worktree.path === path)?.gitStatus.ahead
/** 시험용 스냅샷 순번 — 값마다 붙인다. */
const snapshots = new WeakMap<GitStatusSummary, number>()
const at = (value: GitStatusSummary, snapshot: number): GitStatusSummary => (snapshots.set(value, snapshot), value)
const isLater = (candidate: GitStatusSummary, current: GitStatusSummary | undefined): boolean => current === undefined || (snapshots.get(candidate) ?? -1) > (snapshots.get(current) ?? -1)

describe('WorktreeStatusRefresh (K7)', () => {
  it('그 경로만 캐시를 무효화하고 한 번 읽는다 — 다른 worktree 는 git 0(K7ⓒ), 골격의 그 줄만 바뀐다', async () => {
    const invalidated: string[] = []
    const reads: string[] = []
    const refresh = new WorktreeStatusRefresh({ invalidate: (path) => invalidated.push(path), read: async (path) => (reads.push(path), st(3)), isLater })
    const value = await refresh.refresh('/a')
    expect(invalidated).toEqual(['/a'])
    expect(reads).toEqual(['/a'])
    const patched = patchWorktreeStatus({ skeleton: tree({ '/a': st(1), '/b': st(7) }), path: '/a', value: value ?? st(-1), isLater: () => true })
    expect(patched.found).toBe(true)
    expect(patched.changed).toBe(true)
    expect(aheadOf(patched.skeleton, '/a')).toBe(3)
    expect(aheadOf(patched.skeleton, '/b')).toBe(7)
    expect(patchWorktreeStatus({ skeleton: tree({ '/b': st(7) }), path: '/a', value: st(3), isLater: () => true }).found).toBe(false)
    // 골격이 더 나중 스냅샷이면 바꾸지 않는다(D1).
    const kept = patchWorktreeStatus({ skeleton: tree({ '/a': at(st(9), 20) }), path: '/a', value: at(st(3), 10), isLater })
    expect([kept.found, kept.changed, aheadOf(kept.skeleton, '/a')]).toEqual([true, false, 9])
  })
  it('재빌드가 먼저 읽은 값(순번 5)만 덮는다 · 나중에 읽은 값(순번 20)은 그대로 두고 갱신 값을 버린다 · 다른 경로는 건드리지 않는다', async () => {
    const refresh = new WorktreeStatusRefresh({ invalidate: () => {}, read: async () => at(st(2), 10), isLater })
    await refresh.refresh('/a')
    const overlaid = refresh.overlay({ built: tree({ '/a': at(st(1), 5), '/b': at(st(5), 6) }) })
    expect(aheadOf(overlaid, '/a')).toBe(2)
    expect(aheadOf(overlaid, '/b')).toBe(5)
    expect(aheadOf(refresh.overlay({ built: tree({ '/a': at(st(9), 20) }) }), '/a')).toBe(9)
    // 버린 뒤에는 더 낡은 재빌드가 와도 덮을 것이 없다.
    expect(aheadOf(refresh.overlay({ built: tree({ '/a': at(st(1), 3) }) }), '/a')).toBe(1)
  })
  it('같은 경로 겹친 요청 — 먼저 부른 것이 늦게 끝나면 버린다(null)', async () => {
    const resolvers: ((value: GitStatusSummary) => void)[] = []
    const refresh = new WorktreeStatusRefresh({ invalidate: () => {}, read: () => new Promise((resolve) => resolvers.push(resolve)), isLater })
    const first = refresh.refresh('/a')
    const second = refresh.refresh('/a')
    resolvers[1]?.(at(st(4), 8))
    resolvers[0]?.(at(st(1), 7))
    expect((await second)?.ahead).toBe(4)
    expect(await first).toBeNull()
    expect(aheadOf(refresh.overlay({ built: tree({ '/a': at(st(0), 1) }) }), '/a')).toBe(4)
  })
})
