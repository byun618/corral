// 골격 재구성 재시도 스케줄 (LIFE-628 P1 — 리뷰 r3 N1).
//
// 카드 밖 판정이 골격 오류(gitError·openError)로 보류면 main 이 골격을 다시 세워 스스로 회복한다(G5). 그 재시도가
// ⓐ 영구 오류(사라진 등록 루트 등)에서 끝없이 돌고 ⓑ 재구성이 간격보다 길면 서로 겹쳐 세대 가드에 버려졌다. 규칙:
//   ① 진행 중 재구성이 있으면 걸지 않는다(세대 가드는 그대로 — 이것은 겹침 자체를 막는다)
//   ② 간격은 재구성이 **끝난** 때부터 잰다
//   ③ 연속 실패마다 간격을 늘린다(`REBUILD_BACKOFF_MS`), 성공하면 처음으로
//   ④ 영구 원인은 간격을 최대로 두고 사유를 낸다(패널이 「가릴 수 없다」 대신 그 사유를 보인다)
// 골격보다 새 workspace(fresh) 때문의 재구성도 ①②를 따른다(간격 `FRESH_REBUILD_MS`).
// 시각은 주입받는다 — index.ts 는 `rebuildTree` 시작·끝에 알리고 `due` 로 묻기만 한다.

import type { RepoSkeleton } from './tree.js'

export const REBUILD_BACKOFF_MS: readonly number[] = [5_000, 15_000, 60_000]
export const FRESH_REBUILD_MS = 5_000

/** 골격 하나의 상태 — 오류 없음 / 재시도로 풀릴 수 있는 오류 / 재시도로 안 풀리는 오류(사유). */
export type SkeletonHealth = { kind: 'ok' } | { kind: 'transient' } | { kind: 'permanent'; reason: string }

/**
 * 골격 오류 분류. 영구 = herdr 가 그 루트를 git 작업 트리로 보지 않는다(`not_git_worktree` — 루트 디렉터리가 사라졌거나 git 레포가 아님,
 * 리뷰 r3 실측) 또는 git 이 그 루트로 들어가지 못한다/레포가 아니라고 한다. 그 밖의 오류(타임아웃 등)는 일시로 본다.
 */
export function skeletonHealth(skeleton: readonly RepoSkeleton[]): SkeletonHealth {
  const failing = skeleton.filter((repo) => repo.gitError !== null || repo.openError !== null)
  if (failing.length === 0) return { kind: 'ok' }
  const dead = failing.filter((repo) =>
    repo.openError?.startsWith('not_git_worktree') === true || /cannot change to|not a git repository/i.test(repo.gitError ?? ''),
  )
  if (dead.length === 0) return { kind: 'transient' }
  // Y3 — 원인을 가정하지 않는다(권한 거부도 이 분류에 든다): 경로와 오류 요지만.
  return { kind: 'permanent', reason: `등록 레포를 읽을 수 없다 — ${dead.map((repo) => `${repo.root} (${errorGist(repo)})`).join(', ')}` }
}

/** 오류 요지 — herdr 쪽(코드가 있다)을 먼저, 없으면 git 쪽. 첫 줄 120자. */
function errorGist(repo: RepoSkeleton): string {
  const text = (repo.openError ?? repo.gitError ?? '').split('\n')[0] ?? ''
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

export type RebuildScheduler = {
  /** 재구성 시작 — 모든 `rebuildTree` 가 부른다. */
  started: () => void
  /** 재구성 끝. `health` = 받아들인 골격의 상태, null = 세대 가드가 버린 결과(실패·성공으로 세지 않는다). */
  finished: (health: SkeletonHealth | null) => void
  /** 지금 재구성을 걸어도 되는가 — 진행 중이 없고, 마지막 끝에서 그 종류의 간격이 지났다. */
  due: (kind: 'error' | 'fresh') => boolean
  /** 지금 기다리는 간격(ms) — 시험·로그용. */
  waitMs: (kind: 'error' | 'fresh') => number
  /** 영구 원인 사유(없으면 null) — 패널 안내. */
  permanentReason: () => string | null
}

export function createRebuildScheduler(input: { now: () => number }): RebuildScheduler {
  let running = 0
  let finishedAt = -Infinity
  let failures = 0
  let permanent: string | null = null
  const waitMs = (kind: 'error' | 'fresh'): number => {
    if (kind === 'fresh') return FRESH_REBUILD_MS
    const last = REBUILD_BACKOFF_MS.length - 1
    if (permanent !== null) return REBUILD_BACKOFF_MS[last] ?? 0
    return REBUILD_BACKOFF_MS[Math.min(Math.max(failures - 1, 0), last)] ?? 0
  }
  return {
    started: () => {
      running += 1
    },
    finished: (health) => {
      running = Math.max(0, running - 1)
      finishedAt = input.now()
      if (health === null) return
      switch (health.kind) {
        case 'ok':
          failures = 0
          permanent = null
          return
        case 'transient':
          failures += 1
          permanent = null
          return
        case 'permanent':
          failures += 1
          permanent = health.reason
          return
      }
    },
    due: (kind) => running === 0 && input.now() - finishedAt >= waitMs(kind),
    waitMs,
    permanentReason: () => permanent,
  }
}
