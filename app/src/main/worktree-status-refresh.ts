// 카드·상태바 git 상태를 **그 경로만** 다시 읽는다 (LIFE-831 K7 — 원격 동작·커밋·amend 뒤).
//
// · 그 경로의 `git-status` 캐시를 무효화하고(세대 올림 — 그 전에 시작한 읽기는 캐시에 못 들어간다) 한 번 읽어 골격의 그 worktree 줄만 갈아끼운다
//   — 다른 worktree 는 git 을 다시 돌리지 않는다(K7ⓒ).
// · 트리 재빌드가 들고 온 값과 비교는 **스냅샷 순번**(읽기 시작 순 — `gitStatusSnapshot`)으로 한다(수정 r1 C1): 재빌드 값이 갱신 값보다 먼저 읽은 것일 때만
//   갱신 값으로 덮는다. 재빌드가 더 나중에 읽은 값은 그대로 둔다(재빌드 시작 시각이 아니라 그 경로를 읽은 순서).
// · 같은 경로를 겹쳐 부르면 마지막 요청의 값만 쓴다(앞 요청이 늦게 끝나 새 값을 덮지 않게).
import type { GitStatusSummary } from '../shared/types.js'
import type { RepoSkeleton } from './tree.js'

export class WorktreeStatusRefresh {
  private readonly fresh = new Map<string, { value: GitStatusSummary; snapshot: number }>()
  private readonly seq = new Map<string, number>()

  constructor(
    private readonly deps: {
      read: (path: string) => Promise<GitStatusSummary>
      invalidate: (path: string) => void
      /** 값의 스냅샷 순번(클수록 나중에 읽음) — 모르면 undefined(가장 낡은 것으로 본다). */
      snapshotOf: (value: GitStatusSummary) => number | undefined
    },
  ) {}

  /** 무효화하고 다시 읽는다 — 그 사이 같은 경로의 더 새 요청이 있었으면 null(쓰지 않는다). */
  async refresh(path: string): Promise<GitStatusSummary | null> {
    const seq = (this.seq.get(path) ?? 0) + 1
    this.seq.set(path, seq)
    this.deps.invalidate(path)
    const value = await this.deps.read(path)
    if (this.seq.get(path) !== seq) return null
    this.fresh.set(path, { value, snapshot: this.deps.snapshotOf(value) ?? Number.MAX_SAFE_INTEGER })
    return value
  }

  /** 재빌드 결과에서 갱신 값보다 먼저 읽은(낡은) 경로 값만 갱신 값으로 덮는다. 재빌드가 같거나 더 새 값을 들고 왔으면 그 경로의 갱신 값은 더 쓸 일이 없어 버린다. */
  overlay(input: { built: RepoSkeleton[] }): RepoSkeleton[] {
    if (this.fresh.size === 0) return input.built
    return input.built.map((repo) => ({
      ...repo,
      worktrees: repo.worktrees.map((worktree) => {
        const entry = this.fresh.get(worktree.path)
        if (entry === undefined) return worktree
        if ((this.deps.snapshotOf(worktree.gitStatus) ?? -1) < entry.snapshot) return { ...worktree, gitStatus: entry.value }
        this.fresh.delete(worktree.path)
        return worktree
      }),
    }))
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
