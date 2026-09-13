// worktree **구조**를 git 에게 묻는다 (기준 N4ⓒ).
//
// herdr 에게 묻지 않는 이유: herdr 의 `worktree.list` 도 같은 답을 주지만, 그러면 닫힌 레포의
// 목록이 herdr 세션의 생사에 묶인다. 구조는 레포의 사실이고 git 이 그 진실이다.
// herdr 에게는 **열림상태만** 묻는다 (adapter/internal/worktrees.ts).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalPath } from './canonical-path.js'

const run = promisify(execFile)

export type GitWorktree = { path: string; branch: string | null; isLinked: boolean }

export type GitWorktreeScan = { worktrees: GitWorktree[]; error: string | null }

/** `git worktree list --porcelain` — 빈 줄로 나뉜 레코드, 첫 줄이 `worktree <path>`. */
export async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeScan> {
  try {
    const { stdout } = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { timeout: 5000 })
    const worktrees: GitWorktree[] = []
    let current: { path: string; branch: string | null } | null = null
    const flush = (): void => {
      if (current === null) return
      worktrees.push({
        path: current.path,
        branch: current.branch,
        // 첫 레코드가 주 체크아웃이다 — git 이 그 순서를 보장한다.
        isLinked: worktrees.length > 0,
      })
      current = null
    }
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush()
        // herdr 쪽과 같은 정규화를 쓴다 (수정 1회차 L8) — 문자열 완전일치로 조인하기 때문이다.
        current = { path: canonicalPath(line.slice('worktree '.length).trim()), branch: null }
        continue
      }
      if (current === null) continue
      if (line.startsWith('branch ')) current.branch = shortBranch(line.slice('branch '.length).trim())
      else if (line === 'detached') current.branch = '(detached)'
    }
    flush()
    return { worktrees, error: null }
  } catch (error) {
    return { worktrees: [], error: String(error) }
  }
}

function shortBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}
