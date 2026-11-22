// 카드·상태바 git 상태를 **그 경로만** 다시 읽는다 (LIFE-831 K7 — 원격 동작·커밋·amend 뒤).
//
// · 그 경로의 `git-status` 캐시를 무효화하고(세대 올림 — 그 전에 시작한 읽기는 캐시에 못 들어간다) 한 번 읽어 골격의 그 worktree 줄만 갈아끼운다
//   — 다른 worktree 는 git 을 다시 돌리지 않는다(K7ⓒ).
// · 값 고르기는 캐시와 같은 한 규칙 **「나중 스냅샷만 이긴다」**(`isLater` = `git-status.ts` `isLaterSnapshot` — 수정 r1 C1·r2 D1):
//   경로 갱신 patch 는 골격의 지금 값보다 나중 스냅샷일 때만 심고, 재빌드 overlay 는 재빌드 값이 갱신 값보다 이른 스냅샷일 때만 갱신 값으로 덮는다.
// · 같은 경로를 겹쳐 부르면 마지막 요청의 값만 쓴다(앞 요청이 늦게 끝나 새 값을 덮지 않게).
import type { GitStatusSummary } from '../shared/types.js'
import type { RepoSkeleton } from './tree.js'

/** `candidate` 가 `current` 보다 나중 스냅샷인가. */
export type IsLater = (candidate: GitStatusSummary, current: GitStatusSummary | undefined) => boolean

export class WorktreeStatusRefresh {
  private readonly fresh = new Map<string, GitStatusSummary>()
  private readonly seq = new Map<string, number>()

  constructor(private readonly deps: { read: (path: string) => Promise<GitStatusSummary>; invalidate: (path: string) => void; isLater: IsLater }) {}

  /** 무효화하고 다시 읽는다 — 그 사이 같은 경로의 더 새 요청이 있었으면 null(쓰지 않는다). */
  async refresh(path: string): Promise<GitStatusSummary | null> {
    const seq = (this.seq.get(path) ?? 0) + 1
    this.seq.set(path, seq)
    this.deps.invalidate(path)
    const value = await this.deps.read(path)
    if (this.seq.get(path) !== seq) return null
    if (this.deps.isLater(value, this.fresh.get(path))) this.fresh.set(path, value)
    return value
  }

  /** 재빌드 결과에서 갱신 값보다 이른(낡은) 경로 값만 갱신 값으로 덮는다. 재빌드가 같거나 더 나중 값을 들고 왔으면 그 경로의 갱신 값은 버린다. */
  overlay(input: { built: RepoSkeleton[] }): RepoSkeleton[] {
    if (this.fresh.size === 0) return input.built
    return input.built.map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((worktree) => {
        const value = this.fresh.get(worktree.path)
        if (value === undefined) return worktree
        if (this.deps.isLater(value, worktree.gitStatus)) return { ...worktree, gitStatus: value }
        this.fresh.delete(worktree.path)
        return worktree
      }),
    }))
  }
}

/** 골격에서 그 경로의 worktree 줄을 갈아끼운다 — 골격의 지금 값보다 나중 스냅샷일 때만(D1). `found` = 그 경로가 골격에 있었나, `changed` = 실제로 바꿨나. */
export function patchWorktreeStatus(input: { skeleton: RepoSkeleton[]; path: string; value: GitStatusSummary; isLater: IsLater }): { skeleton: RepoSkeleton[]; found: boolean; changed: boolean } {
  let found = false
  let changed = false
  const skeleton = input.skeleton.map((repo) => {
    if (!repo.worktrees.some((worktree) => worktree.path === input.path)) return repo
    found = true
    return {
      ...repo,
      worktrees: repo.worktrees.map((worktree) => {
        if (worktree.path !== input.path || !input.isLater(input.value, worktree.gitStatus)) return worktree
        changed = true
        return { ...worktree, gitStatus: input.value }
      }),
    }
  })
  return { skeleton, found, changed }
}
