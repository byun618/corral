// 활성 workspace 동기화 규칙 (LIFE-490) — `useLifecycleActions` 의 동기화 effect 가 이 함수 하나로 판정한다.
//
// 결함: 링크 워크트리를 열면 IPC 응답(새 workspace id)이 **그 workspace 가 state 에 들어오기 전에** 온다
// (격리 계측 `specs/LIFE-490-sidebar-card/raw/claude/k1/` — 응답 뒤 약 0.2~0.3초에 도착). 그 사이 다른 state push 가
// 오면 옛 규칙은 「활성 id 가 열린 목록에 없다」 를 「닫혔다」 로 읽어 focused(= 함께 열린 main)로 승격했고,
// 새 workspace 가 나중에 들어와도 활성은 이미 main 이었다.
//
// 그래서 방금 연(만든) workspace 는 **보류**로 표시한다 — 보류 중이고 기한 전이면 목록에 없어도 지우지 않는다.
// 목록에 들어오면 보류는 풀리고, 기한이 지나도 안 들어오면 옛 규칙(focused → 첫 workspace)으로 돌아간다(죽은 id 에 머물지 않는다).

/**
 * 보류 기한. 실측 도착 지연은 0.2~0.7초였다(K1ⓐ). main 의 트리 재구성은 레포마다 `git worktree list`(상한 5초) +
 * herdr 왕복을 직렬로 도므로 그 상한의 두 배를 둔다 — 늦은 도착을 놓치는 쪽보다 실패를 10초 늦게 정리하는 쪽이 싸다.
 */
export const PENDING_ACTIVE_MS = 10_000

export type PendingActive = { workspaceId: string; deadline: number }

export type ActiveSync = { next: string | null; pending: PendingActive | null }

/**
 * 지금 활성(`current`)·보류·열린 workspace 목록으로 다음 활성과 보류를 정한다.
 *  - 활성이 열린 목록에 있으면 그대로(그 id 의 보류는 풀린다 — 도착했다)
 *  - 활성이 보류 대상이고 기한 전이면 그대로(아직 도착 전)
 *  - 아니면 focused → 첫 workspace → null (재기동·닫힘·보류 만료가 모두 이 길)
 */
export function syncActiveWorkspace(input: {
  current: string | null
  pending: PendingActive | null
  open: readonly { workspaceId: string; focused: boolean }[]
  now: number
}): ActiveSync {
  const { current, pending, open, now } = input
  if (current !== null && open.some((workspace) => workspace.workspaceId === current)) return { next: current, pending: null }
  if (current !== null && pending !== null && pending.workspaceId === current && now < pending.deadline) return { next: current, pending }
  const promoted = open.find((workspace) => workspace.focused) ?? open[0] ?? null
  return { next: promoted?.workspaceId ?? null, pending: null }
}
