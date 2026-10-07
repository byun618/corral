// worktree **구조**를 git 에게 묻는다 (기준 N4ⓒ).
//
// herdr 에게 묻지 않는 이유: herdr 의 `worktree.list` 도 같은 답을 주지만, 그러면 닫힌 레포의
// 목록이 herdr 세션의 생사에 묶인다. 구조는 레포의 사실이고 git 이 그 진실이다.
// herdr 에게는 **열림상태만** 묻는다 (adapter/internal/worktrees.ts).

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { canonicalPath } from './canonical-path.js'

const run = promisify(execFile)

/**
 * `branch` 는 브랜치 이름(짧은 꼴) — 브랜치가 없으면(detached HEAD·bare) `null`. 표시 문자열을 데이터 칸에 싣지 않는다(LIFE-491:
 * 전에는 detached 를 괄호 친 표시 문자열로 실어 그 문자열이 카드 제목·메타 줄에 그대로 나왔다). `head` 는 `HEAD <sha>` 줄의 전체 sha —
 * bare 레코드만 이 줄이 없어 `null` 이다(git-worktree 문서 Porcelain Format). detached 판정·표시는 렌더러 `worktree-identity.ts` 가 한다.
 */
export type GitWorktree = { path: string; branch: string | null; head: string | null; isLinked: boolean }

export type GitWorktreeScan = { worktrees: GitWorktree[]; error: string | null }

/** `git worktree list --porcelain` — 빈 줄로 나뉜 레코드, 첫 줄이 `worktree <path>`. */
export async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeScan> {
  try {
    const { stdout } = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { timeout: 5000 })
    return { worktrees: parseWorktreePorcelain({ stdout, exists: fs.existsSync }), error: null }
  } catch (error) {
    return { worktrees: [], error: String(error) }
  }
}

/** porcelain 판독(순수) — `exists` 는 디렉터리 존재 확인(시험에서 갈아 끼운다). */
export function parseWorktreePorcelain(input: { stdout: string; exists: (path: string) => boolean }): GitWorktree[] {
  const worktrees: GitWorktree[] = []
  let current: { path: string; branch: string | null; head: string | null } | null = null
  let records = 0
  const flush = (): void => {
    if (current === null) return
    // 첫 레코드가 주 체크아웃이다 — git 이 그 순서를 보장한다. 걸러진 레코드도 순번은 센다.
    const isLinked = records > 0
    records += 1
    // 디렉터리가 없는 항목(`rm -rf` 뒤 prunable)은 뺀다 — runtime `workspace/model.ts` 와 같은 규칙 (LIFE-445 S3).
    if (input.exists(current.path)) worktrees.push({ path: current.path, branch: current.branch, head: current.head, isLinked })
    current = null
  }
  for (const line of input.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      // herdr 쪽과 같은 정규화를 쓴다 (수정 1회차 L8) — 문자열 완전일치로 조인하기 때문이다.
      current = { path: canonicalPath(line.slice('worktree '.length).trim()), branch: null, head: null }
      continue
    }
    if (current === null) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim() || null
    else if (line.startsWith('branch ')) current.branch = shortBranch(line.slice('branch '.length).trim())
    // `detached` 줄은 값이 없다 — 브랜치 칸을 비워 두는 것으로 충분하다(브랜치 줄이 오지 않는다).
  }
  flush()
  return worktrees
}

function shortBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}
