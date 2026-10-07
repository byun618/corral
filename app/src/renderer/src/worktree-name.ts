// worktree 표시 이름 — **정렬 키와 화면 표시가 같은 함수에서 나오게** 한다.
//
// 이 파일이 생긴 이유가 곧 버그 하나다: 1줄 표시 로직은 `WorktreeBlock` 안에, 정렬 키는
// `Sidebar` 안에 따로 있어서 둘이 다른 문자열을 기준으로 움직인 적이 있다. 두 곳이 같은
// 함수를 부르면 이 어긋남이 구조적으로 불가능해진다.
//
// 2026-09-15: 1줄 표시를 브랜치 leaf(마지막 `/` 뒤)에서 **브랜치 풀네임**으로 되돌렸다
// (사용자 지시 — Orca 대조 스크린샷, `feature/LIFE-358` 이 leaf 로 잘려 `LIFE-358` 만 보이는
// 게 오히려 정보 손실이라는 판단). 2줄은 그대로 풀네임이라 지금은 1·2줄이 같은 문자열이지만,
// `WorktreeBlock` 의 H-2 규칙(2줄은 1줄과 같아도 그린다)이 이미 그 중복을 허용한다.
import type { WorktreeRow } from '../../shared/types.js'

/**
 * 1줄에 실제로 그려지는 문자열 — 레지스트리 표시 이름(LIFE-478, CLI `worktree set --display-name` 과 같은 칸) → 없으면 브랜치 풀네임.
 * 정렬 1차 키가 이것이어야 한다(198 도 displayName 으로 정렬).
 *
 * **표시 이름이 브랜치와 같아도 그 값을 그대로 쓴다** — Orca #15908(표시 이름 = 브랜치를 「오버라이드 없음」 으로 보고 엉뚱한 값으로
 * 떨어짐)을 따라 하지 않는다. 비교 없이 있으면 쓰고 없으면 브랜치다.
 *
 * 브랜치가 없으면(detached HEAD — LIFE-491) **레포 이름 → 폴더 이름**이다. 198 이 같다: 자동 표시 이름 =
 * `branchShort || repo.displayName || basename(path)`(`main/ipc/worktree-metadata-merge.ts:21`). 어느 커밋인지는 메타 줄 배지가 말한다.
 */
export function worktreeDisplayName(worktree: Pick<WorktreeRow, 'displayName' | 'branch' | 'repoName' | 'path'>): string {
  const named = worktree.displayName ?? worktree.branch
  if (named != null && named !== '') return named
  if (worktree.repoName && worktree.repoName.trim() !== '') return worktree.repoName
  return worktree.path.split('/').filter((part) => part !== '').at(-1) ?? worktree.path
}

/**
 * 1차 키 — **주 체크아웃이 맨 위**. 사용자 지시 *"각 레포에서 main은 항상 위로 오게 해줘"*
 * (11-gate1-fix3.md I-1).
 *
 * 판정은 `isLinked === false` 다. **브랜치 이름이 `'main'` 인지로 재지 않는다** — `master` 를
 * 쓰거나 기본 브랜치를 바꾼 레포에서 조용히 틀린다. 사용자가 말한 "main" 은 그 레포의
 * *주 체크아웃*이지 특정 이름이 아니다(`types.ts:125` 주석이 권위).
 *
 * **H-1 을 지운 게 아니다.** H-1 의 요구는 "세션 상태가 순서에 영향을 주지 않을 것"이었고
 * `isLinked` 는 세션과 무관한 **정적** 속성이라 그 요구를 그대로 만족한다 — 세션 축이 아니라
 * 정적 축이 하나 **앞에 붙었다**.
 */
function mainCheckoutRank(worktree: WorktreeRow): number {
  return worktree.isLinked ? 1 : 0
}

/**
 * worktree 정렬 — **주 체크아웃 먼저, 그다음 보이는 이름(풀네임) 사전순 고정**.
 *
 * 키는 주 체크아웃 여부(I-1) → 표시 이름(이제 풀네임이라 leaf 동률 문제가 없다) 두 단계다.
 * **세션 수·열림 여부·선택 여부는 키에 넣지 않는다** — 활성 상태를 키에 넣었다가 세션을 열고
 * 닫을 때마다 목록이 눈앞에서 재배열된 것이 이 규칙이 생긴 이유다(10-gate1-fix2.md H-1).
 *
 * herdr 가 주는 배열 순서를 그대로 쓰지 않는 이유도 같다 — 그 순서에는 고정 보장이 없다.
 */
export function sortWorktrees(worktrees: WorktreeRow[]): WorktreeRow[] {
  return [...worktrees].sort((a, b) => {
    const byMain = mainCheckoutRank(a) - mainCheckoutRank(b)
    return byMain !== 0 ? byMain : worktreeDisplayName(a).localeCompare(worktreeDisplayName(b))
  })
}
