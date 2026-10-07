// 워크트리 git identity 판정 (LIFE-491) — 브랜치가 있으면 `branch`, 없고 HEAD 가 있으면 `detached`, 둘 다 없으면 null.
// Orca v1.4.198 `lib/worktree-git-identity-display.ts` 를 옮겼다(MIT) — 문구·짧은 sha 규칙(`head.trim().slice(0, 7)`)이 198 과 글자 단위로 같다.
// 198 의 `sourceControlLabel`(소스 컨트롤 화면용)은 corral 에 그 화면이 없어 뺐다.
// 「detached HEAD 숨기기」 필터·카드 메타 배지·제목 폴백이 모두 이 함수 하나로 판정한다 — head 도 없는 행(bare 등)은 detached 가 아니다.
import type { WorktreeRow } from '../../shared/types.js'

export type WorktreeIdentity =
  | { kind: 'branch'; branchName: string }
  | { kind: 'detached'; shortHead: string; sidebarLabel: string; tooltip: string }

export function worktreeIdentity(worktree: Pick<WorktreeRow, 'branch' | 'head'>): WorktreeIdentity | null {
  const branchName = (worktree.branch ?? '').replace(/^refs\/heads\//, '').trim()
  if (branchName !== '') return { kind: 'branch', branchName }
  const shortHead = (worktree.head ?? '').trim().slice(0, 7)
  if (shortHead === '') return null
  return {
    kind: 'detached',
    shortHead,
    sidebarLabel: `Detached HEAD @ ${shortHead}`,
    tooltip: `Detached HEAD at ${shortHead}. You are viewing a commit, not a branch.`,
  }
}
