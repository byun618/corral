// 목록 조립 — `repo → worktree → tab → pane` 4단 (기준 N4).
//
// **루트는 레지스트리다.** herdr 스냅샷이 아니다. 세 곳에서 읽어 하나로 짠다:
//   ① 레포 루트 목록  ← 레지스트리 (corral 소유 영속 상태)
//   ② worktree 구조   ← `git worktree list --porcelain`
//   ③ 열림상태·행     ← herdr (`worktree.list` 의 open_workspace_id · store 의 workspace 행)
//
// 그래서 **workspace 가 하나도 안 열린 레포도 목록에 있고**(①②만으로 그려진다),
// 닫힌 worktree 도 열린 것과 나란히 보인다.

import path from 'node:path'
import type { RepoRow, UnregisteredGroup, WorkspaceRow, WorktreeRow } from '../shared/types.js'
import { listGitWorktrees } from './git-worktrees.js'
import { readOpenWorkspaces } from './adapter/index.js'
import { log } from './log.js'

export type TreeInput = {
  roots: readonly string[]
  /** herdr store 가 지금 들고 있는 workspace 행 전부. */
  workspaces: readonly WorkspaceRow[]
  /** 붙어 있는 세션 소켓. 없으면(세션 미선택) 열림상태는 전부 null 이 된다. */
  socketPath: string | null
}

export type Tree = { repos: RepoRow[]; unregistered: UnregisteredGroup }

export async function buildTree(input: TreeInput): Promise<Tree> {
  const byWorkspaceId = new Map<string, WorkspaceRow>()
  for (const workspace of input.workspaces) byWorkspaceId.set(workspace.workspaceId, workspace)
  const claimed = new Set<string>()

  const repos: RepoRow[] = []
  for (const root of input.roots) {
    const git = await listGitWorktrees(root)
    const open =
      input.socketPath === null
        ? { byPath: new Map<string, string>(), repoName: null, error: null }
        : await readOpenWorkspaces(input.socketPath, root)

    const worktrees: WorktreeRow[] = git.worktrees.map((worktree) => {
      const openWorkspaceId = open.byPath.get(worktree.path) ?? null
      const workspace = openWorkspaceId === null ? null : (byWorkspaceId.get(openWorkspaceId) ?? null)
      if (workspace !== null) claimed.add(workspace.workspaceId)
      return {
        path: worktree.path,
        branch: worktree.branch,
        isLinked: worktree.isLinked,
        openWorkspaceId,
        workspace,
      }
    })

    const errors = [git.error, open.error].filter((item) => item !== null)
    repos.push({
      root,
      name: open.repoName ?? path.basename(root),
      error: errors.length === 0 ? null : errors.join(' · '),
      worktrees,
    })
  }
  repos.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root))

  /**
   * 어느 등록 레포에도 안 붙은 workspace.
   *
   * 목록의 루트는 레지스트리지만(N4), 등록 안 된 workspace 를 **조용히 숨기지는 않는다** —
   * 숨기면 목록이 herdr 와 어긋난 채로 "맞다" 고 말하게 된다. 평시엔 비어 있는 칸이다.
   */
  const unregistered = input.workspaces.filter((workspace) => !claimed.has(workspace.workspaceId))
  if (unregistered.length > 0) {
    log('tree.unregistered', { count: unregistered.length, ids: unregistered.map((item) => item.workspaceId) })
  }
  return { repos, unregistered: { workspaces: unregistered } }
}
