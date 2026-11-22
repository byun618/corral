// 카드·상태바 git 상태를 **그 경로만** 다시 읽는다 (LIFE-831 K7 — 원격 동작·커밋·amend 뒤).
//
// · 그 경로의 `git-status` 캐시를 지우고 한 번 읽어 골격의 그 worktree 줄만 갈아끼운다 — 다른 worktree 는 git 을 다시 돌리지 않는다(K7ⓒ).
// · 그보다 먼저 시작한 트리 재빌드가 동작 전 값을 들고 늦게 끝나면 새 값을 덮는다 — 읽은 값을 시각과 함께 두고 그 재빌드 결과에 덧씌운다(`overlay`).
// · 같은 경로를 겹쳐 부르면 마지막 요청의 값만 쓴다(앞 요청이 늦게 끝나 새 값을 덮지 않게).
import type { GitStatusSummary } from '../shared/types.js'
import type { RepoSkeleton } from './tree.js'

export class WorktreeStatusRefresh {
  private readonly fresh = new Map<string, { value: GitStatusSummary; at: number }>()
  private readonly seq = new Map<string, number>()

  constructor(private readonly deps: { read: (path: string) => Promise<GitStatusSummary>; invalidate: (path: string) => void; now?: () => number }) {}

  /** 캐시를 지우고 다시 읽는다 — 그 사이 같은 경로의 더 새 요청이 있었으면 null(쓰지 않는다). */
  async refresh(path: string): Promise<GitStatusSummary | null> {
    const seq = (this.seq.get(path) ?? 0) + 1
    this.seq.set(path, seq)
    const at = (this.deps.now ?? Date.now)()
    this.deps.invalidate(path)
    const value = await this.deps.read(path)
    if (this.seq.get(path) !== seq) return null
    this.fresh.set(path, { value, at })
    return value
  }

  /** 재빌드 결과에 그 재빌드보다 늦게 읽기 시작한 경로별 상태를 덧씌운다. 그 재빌드 시작 전에 읽은 것은 더 이상 필요 없어 버린다. */
  overlay(input: { built: RepoSkeleton[]; startedAt: number }): RepoSkeleton[] {
    const newer = new Map([...this.fresh].filter(([, entry]) => entry.at > input.startedAt))
    for (const [key, entry] of this.fresh) if (entry.at <= input.startedAt) this.fresh.delete(key)
    if (newer.size === 0) return input.built
    return input.built.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((worktree) => ({ ...worktree, gitStatus: newer.get(worktree.path)?.value ?? worktree.gitStatus })) }))
  }
}

/** 골격에서 그 경로의 worktree 줄만 갈아끼운다 — 없으면 `found: false`(그대로). */
export function patchWorktreeStatus(input: { skeleton: RepoSkeleton[]; path: string; value: GitStatusSummary }): { skeleton: RepoSkeleton[]; found: boolean } {
  let found = false
  const skeleton = input.skeleton.map((repo) => {
    if (!repo.worktrees.some((worktree) => worktree.path === input.path)) return repo
    found = true
    return { ...repo, worktrees: repo.worktrees.map((worktree) => (worktree.path === input.path ? { ...worktree, gitStatus: input.value } : worktree)) }
  })
  return { skeleton, found }
}
