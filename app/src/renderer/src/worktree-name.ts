// worktree 표시 이름 — **정렬 키와 화면 표시가 같은 함수에서 나오게** 한다.
//
// 이 파일이 생긴 이유가 곧 버그 하나다: leaf 추출은 `WorktreeBlock` 안에, 정렬 키는
// `Sidebar` 안에 따로 있었다. 그래서 정렬은 풀네임(`ticket/012-…`)으로 하고 화면은
// leaf(`012-…`)만 보여줬고, `main` → `012-blend-instance-only` 같은 **보이는 이름 기준
// 역순**이 나왔다(풀네임으로는 `main` < `ticket/…` 이라 맞다). 사용자 지시 원문은
// *"워크트리의 순서는 뭐 이름순이든 뭐든 어쨋든 고정이야"* 였고, 사용자가 보는 이름은 leaf 다.
// 두 곳이 같은 함수를 부르면 이 어긋남이 구조적으로 불가능해진다.
import type { WorktreeRow } from '../../shared/types.js'

/** 브랜치 leaf — 마지막 `/` 뒤. 슬래시가 없으면 풀네임 그대로다. */
export function branchLeaf(branch: string): string {
  const index = branch.lastIndexOf('/')
  return index === -1 ? branch : branch.slice(index + 1)
}

/** 1줄에 실제로 그려지는 문자열. 정렬 1차 키가 이것이어야 한다. */
export function worktreeDisplayName(worktree: WorktreeRow): string {
  return worktree.branch === null ? '(브랜치 없음)' : branchLeaf(worktree.branch)
}

/** 2차 키 — 풀네임. `issue/LIFE-89` 와 `feature/LIFE-89` 처럼 leaf 가 겹칠 때 순서를 고정한다. */
function worktreeFullName(worktree: WorktreeRow): string {
  return worktree.branch ?? worktree.path
}

/**
 * worktree 정렬 — **보이는 이름 사전순 고정**.
 *
 * 키는 표시 이름(leaf) → 풀네임 두 단계뿐이다. **세션 수·열림 여부·선택 여부는 키에 넣지
 * 않는다** — 활성 상태를 키에 넣었다가 세션을 열고 닫을 때마다 목록이 눈앞에서 재배열된 것이
 * 이 규칙이 생긴 이유다(10-gate1-fix2.md H-1).
 *
 * herdr 가 주는 배열 순서를 그대로 쓰지 않는 이유도 같다 — 그 순서에는 고정 보장이 없다.
 * 2차 키까지 두면 leaf 동률에서도 결정적이라 `sort` 의 안정성에 기대지 않는다.
 */
export function sortWorktrees(worktrees: WorktreeRow[]): WorktreeRow[] {
  return [...worktrees].sort((a, b) => {
    const byLeaf = worktreeDisplayName(a).localeCompare(worktreeDisplayName(b))
    return byLeaf !== 0 ? byLeaf : worktreeFullName(a).localeCompare(worktreeFullName(b))
  })
}
