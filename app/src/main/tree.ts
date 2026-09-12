// 목록 조립 — `repo → worktree → tab → pane` 4단 (기준 N4).
//
// **루트는 레지스트리다.** herdr 스냅샷이 아니다. 세 곳에서 읽어 하나로 짠다:
//   ① 레포 루트 목록  ← 레지스트리 (corral 소유 영속 상태)
//   ② worktree 구조   ← `git worktree list --porcelain`
//   ③ 열림상태·행     ← herdr (`worktree.list` 의 open_workspace_id · store 의 workspace 행)
//
// 그래서 **workspace 가 하나도 안 열린 레포도 목록에 있고**(①②만으로 그려진다),
// 닫힌 worktree 도 열린 것과 나란히 보인다.
//
// # 왜 두 걸음인가 (골격·붙이기)
//
// ①② 는 프로세스를 띄우고(git) 소켓을 왕복해야 해서 비싸고, 잘 안 바뀐다.
// ③ 의 행은 push 가 올 때마다 바뀐다 — pane 의 에이전트 상태 하나만 바뀌어도.
// 한 걸음으로 묶어 캐시하면 **상태만 바뀐 변화가 화면에 영영 안 닿는다**: 캐시된 행이 낡은 채로
// 실려 나간다 (N8 1회차에서 실제로 그렇게 됐다 — 저장소는 `blocked` 를 받았는데 화면은 `대기`).
// 그래서 비싼 쪽만 캐시하고(`buildSkeleton`), 행은 **내보낼 때마다 새로 붙인다**(`joinTree`).

import path from 'node:path'
import type { RepoRow, WorkspaceRow } from '../shared/types.js'
import { readOpenWorkspaces } from './adapter/index.js'
import { listGitWorktrees } from './git-worktrees.js'
import { log } from './log.js'

/** 비싼 쪽 — git·herdr 왕복으로 얻는 골격. 행은 아직 안 붙었다. */
export type RepoSkeleton = {
  root: string
  name: string
  error: string | null
  worktrees: Array<{ path: string; branch: string | null; isLinked: boolean; openWorkspaceId: string | null }>
}

export type Tree = { repos: RepoRow[] }

export async function buildSkeleton(input: {
  roots: readonly string[]
  /** 붙어 있는 세션 소켓. 없으면(세션 미선택) 열림상태는 전부 null 이 된다. */
  socketPath: string | null
}): Promise<RepoSkeleton[]> {
  const skeletons: RepoSkeleton[] = []
  for (const root of input.roots) {
    const git = await listGitWorktrees(root)
    const open =
      input.socketPath === null
        ? { byPath: new Map<string, string>(), repoName: null, error: null }
        : await readOpenWorkspaces(input.socketPath, root)
    const errors = [git.error, open.error].filter((item) => item !== null)
    skeletons.push({
      root,
      name: open.repoName ?? path.basename(root),
      error: errors.length === 0 ? null : errors.join(' · '),
      worktrees: git.worktrees.map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
        isLinked: worktree.isLinked,
        openWorkspaceId: open.byPath.get(worktree.path) ?? null,
      })),
    })
  }
  skeletons.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root))
  return skeletons
}

/** 싼 쪽 — 골격에 지금 저장소의 행을 붙인다. 내보낼 때마다 부른다. */
export function joinTree(skeleton: readonly RepoSkeleton[], workspaces: readonly WorkspaceRow[]): Tree {
  const byWorkspaceId = new Map<string, WorkspaceRow>()
  for (const workspace of workspaces) byWorkspaceId.set(workspace.workspaceId, workspace)
  const claimed = new Set<string>()

  const repos: RepoRow[] = skeleton.map((repo) => ({
    root: repo.root,
    name: repo.name,
    error: repo.error,
    worktrees: repo.worktrees.map((worktree) => {
      const workspace = worktree.openWorkspaceId === null ? null : (byWorkspaceId.get(worktree.openWorkspaceId) ?? null)
      if (workspace !== null) claimed.add(workspace.workspaceId)
      return {
        path: worktree.path,
        branch: worktree.branch,
        isLinked: worktree.isLinked,
        openWorkspaceId: worktree.openWorkspaceId,
        workspace,
      }
    }),
  }))

  /**
   * 어느 등록 레포에도 안 붙은 workspace.
   *
   * **여기 있던 판단은 뒤집혔다** (게이트 ① 사용자 지시, 2026-09-12). 원래는 "등록 안 된
   * workspace 를 조용히 숨기지 않는다 — 숨기면 목록이 herdr 와 어긋난 채로 맞다고 말하게 된다"
   * 였고, 그래서 화면 아래에 「레지스트리 밖 workspace」 칸을 뒀다. 사용자가 앱을 직접 굴려보고
   * **등록한 레포만 보이게 하라**고 결정했다 — 목록의 루트는 레지스트리라는 N4 의 뜻이
   * 화면에서도 그대로 지켜지는 쪽이다.
   *
   * 대신 **말없이 사라지지는 않게** 로그는 남긴다: 어긋남은 `tree.unregistered` 로 진단할 수
   * 있고, 화면에만 안 실린다. 그래서 이 필터는 계속 돈다.
   */
  const unregistered = workspaces.filter((workspace) => !claimed.has(workspace.workspaceId))
  if (unregistered.length > 0) {
    log('tree.unregistered', { count: unregistered.length, ids: unregistered.map((item) => item.workspaceId) })
  }
  return { repos }
}
