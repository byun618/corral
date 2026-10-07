// 활성 workspace 동기화 규칙 (LIFE-490) — `useLifecycleActions` 의 동기화 effect 가 이 함수 하나로 판정한다.
//
// 결함: 링크 워크트리를 열면 IPC 응답(새 workspace id)이 **그 workspace 가 state 에 들어오기 전에** 온다
// (격리 계측 `specs/LIFE-490-sidebar-card/raw/claude/k1/` — 응답 뒤 0.5초 안쪽에 도착). 그 사이 다른 state push 가
// 오면 옛 규칙은 「활성 id 가 열린 목록에 없다」 를 「닫혔다」 로 읽어 focused(= 함께 열린 main)로 승격했고,
// 새 workspace 가 나중에 들어와도 활성은 이미 main 이었다.
//
// 그래서 방금 연(만든) workspace 는 **보류**로 표시한다 — 보류 중이면 목록에 없어도 지우지 않는다.
// 목록에 들어오면 보류는 풀리고, 기한까지 안 들어오면 옛 규칙(focused → 첫 workspace)으로 돌아간다(죽은 id 에 머물지 않는다).
// 기한은 훅의 타이머가 보류를 지우는 것으로만 끝난다 — 벽시계 비교를 두지 않는다(fix1 F2, r1 L4: 타이머가 벽시계 기한보다
// 먼저 울리면 보류가 남은 채 다시 걸 타이머가 없었다).

/**
 * 레포 하나의 트리 재구성 상한. main 의 `buildSkeleton` 은 레포를 **직렬로** 돌고, 레포마다
 * `git worktree list`(timeout 5초, `git-worktrees.ts`) → herdr `worktree.list`(요청 기본 5초, `adapter/internal/request.ts`)
 * → 워크트리별 `git status`(병렬, 8초, `git-status.ts GIT_STATUS_TIMEOUT_MS`) 를 기다린다 — 최악 18초.
 */
export const TREE_REBUILD_MS_PER_REPO = 18_000

/**
 * 보류 기한 = 재구성 두 번(응답이 올 때 이미 돌던 재구성 + 새 workspace 를 싣는 재구성) × 레포 수의 상한.
 * 실측 도착 지연(응답 → state 도착)은 0.5초 안쪽이었다(K1ⓐ `raw/claude/k1/<회차>/race-order.md`) — 기한은 상한을 덮는 값이고,
 * 늦은 도착을 놓치면 결함이 그대로 돌아오므로 실패(끝내 안 옴)를 늦게 정리하는 쪽을 택한다.
 * (r0 의 고정 10초는 「레포 하나 git 상한 × 2」 라는 틀린 근거였다 — r1 G-2.)
 */
export function pendingActiveMs(input: { repoCount: number }): number {
  return 2 * Math.max(1, input.repoCount) * TREE_REBUILD_MS_PER_REPO
}

export type PendingActive = { workspaceId: string }

export type ActiveSync = { next: string | null; pending: PendingActive | null }

/**
 * 지금 활성(`current`)·보류·열린 workspace 목록으로 다음 활성과 보류를 정한다.
 *  - 활성이 열린 목록에 있으면 그대로(그 id 의 보류는 풀린다 — 도착했다)
 *  - 활성이 보류 대상이면 그대로(아직 도착 전 — 기한은 훅의 타이머가 보류를 지워 끝낸다)
 *  - 아니면 focused → 첫 workspace → null (재기동·닫힘·보류 만료가 모두 이 길)
 */
export function syncActiveWorkspace(input: {
  current: string | null
  pending: PendingActive | null
  open: readonly { workspaceId: string; focused: boolean }[]
}): ActiveSync {
  const { current, pending, open } = input
  if (current !== null && open.some((workspace) => workspace.workspaceId === current)) return { next: current, pending: null }
  if (current !== null && pending !== null && pending.workspaceId === current) return { next: current, pending }
  const promoted = open.find((workspace) => workspace.focused) ?? open[0] ?? null
  return { next: promoted?.workspaceId ?? null, pending: null }
}
