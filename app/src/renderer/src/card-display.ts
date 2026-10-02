// 카드 표시 규칙 (LIFE-477) — Compact 카드 제목 hover 카드에 무엇을 싣나. 화면(`WorktreeBlock`)은 그리기만 한다.
//
// 198 기본 경로(`worktree-card-presentation.tsx` `titleWrapper`): Compact 카드의 제목 hover 는 **Compact 가 숨긴 것이 있을 때만** 붙는다 —
// 브랜치가 제목과 다르면 브랜치(identity header, branch-first), 그리고 체크된 속성의 상세(이슈·PR·노트…).
// corral 은 제목이 곧 브랜치 풀네임이라(`worktree-name.ts`) 앞 조건은 대상이 0 이고, 198 속성 상세는 없다(B8). 대신 Compact 가
// 제목 줄에서 숨기는 corral 고유 메타 **git 마크(dirty/ahead/behind)** 가 198 상세 자리다 — 사용자 결정 Q-W1(나), 2026-10-02.
import type { GitStatusSummary } from '../../shared/types.js'
import { gitMarkLabel, gitTone, type GitTone } from './git-marks.js'

export type CompactHover = {
  /** 브랜치 — 198 identity header 의 branch(mono). 브랜치가 없으면(detached) null. */
  branch: string | null
  /** 제목 — 브랜치와 다를 때만(198 `workspaceTitle !== branchName`). */
  title: string | null
  /** git 상태 — 마크 문자열(제목 줄과 같은 `●3 ↑2`)과 풀어 쓴 말. */
  git: { mark: string; tone: GitTone; words: string } | null
}

/**
 * Compact 제목 hover 카드 내용. **열 이유가 없으면 null** — 198 처럼 브랜치≠제목(corral 에선 대상 0)이거나 git 마크가 있을 때만 연다.
 * 열면 identity(브랜치 → 제목)와 git 상태를 함께 싣는다.
 */
export function compactHoverContent(input: { branch: string | null; title: string; gitStatus: GitStatusSummary }): CompactHover | null {
  const mark = gitMarkLabel(input.gitStatus)
  const branchDiffers = input.branch !== null && input.branch !== input.title
  if (!branchDiffers && mark === null) return null
  return {
    branch: input.branch,
    title: input.title !== input.branch ? input.title : null,
    git: mark === null ? null : { mark, tone: gitTone(input.gitStatus), words: gitStatusWords(input.gitStatus) },
  }
}

/** `변경 3 · 앞섬 2 · 뒤처짐 1` — 마크(`●3 ↑2 ↓1`)를 풀어 쓴 말. 마크와 같은 순서. */
export function gitStatusWords(status: GitStatusSummary): string {
  const dirtyCount = status.staged + status.unstaged + status.untracked + status.conflicted
  const parts: string[] = []
  if (dirtyCount > 0) parts.push(`변경 ${dirtyCount}`)
  if (status.ahead !== null && status.ahead > 0) parts.push(`앞섬 ${status.ahead}`)
  if (status.behind !== null && status.behind > 0) parts.push(`뒤처짐 ${status.behind}`)
  return parts.join(' · ')
}
