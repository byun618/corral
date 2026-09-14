// worktree git 상태 → 도트 색 + 마크 문자열 (design-handoff.md §2 WorktreeBlock, §5 상태 표현 분담).
// 판별자는 오라클(main/git-status.ts)이 이미 계산한 GitStatusSummary — 여기는 순수 표시 변환뿐이다.

import type { GitStatusSummary } from '../../shared/types.js'

export type GitTone = 'dirty' | 'ahead' | 'behind' | 'clean'

/** 우선순위: dirty > ahead > behind > clean (§2 표 — 도트·마크 색은 같은 우선순위를 쓴다). */
export function gitTone(status: GitStatusSummary): GitTone {
  if (status.dirty) return 'dirty'
  if (status.ahead !== null && status.ahead > 0) return 'ahead'
  if (status.behind !== null && status.behind > 0) return 'behind'
  return 'clean'
}

/** `●3 ↑2` · `↑1` · `●1` 형태 — 핸드오프 §2 예시 3개와 1:1 대응. 표시할 게 없으면 null. */
export function gitMarkLabel(status: GitStatusSummary): string | null {
  const dirtyCount = status.staged + status.unstaged + status.untracked + status.conflicted
  const parts: string[] = []
  if (dirtyCount > 0) parts.push(`●${dirtyCount}`)
  if (status.ahead !== null && status.ahead > 0) parts.push(`↑${status.ahead}`)
  if (status.behind !== null && status.behind > 0) parts.push(`↓${status.behind}`)
  return parts.length === 0 ? null : parts.join(' ')
}
