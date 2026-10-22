// worktree 의 **열림상태**를 herdr 에 묻는다 (기준 N4ⓒ).
//
// 구조(어떤 worktree 가 있나)는 git 이 진실이고 이 파일이 대답하지 않는다 — main 의
// `git-worktrees.ts` 가 `git worktree list` 로 읽는다. 여기가 대답하는 것은 **그 체크아웃을
// herdr 가 지금 열고 있나** 하나뿐이고, 그 답은 `worktree.list` 의 `open_workspace_id` 다.
//
// 실측(raw/claude/00-shapes.json): `worktree.list {cwd}` 는 그 cwd 의 레포 **전체** worktree 를
// 주고, 열려 있는 줄에만 `open_workspace_id` 가 붙는다. 레포가 이 세션에 하나도 안 열려 있어도
// 응답은 정상이고(열림 표시가 없을 뿐), git 이 아닌 경로는 `not_git_worktree` 로 거절한다.

import { isRecord, readArray, readRecord, readString } from '../../../shared/json.js'
import { canonicalPath } from '../../canonical-path.js'
import { request } from './request.js'

/**
 * 경로 → 그 체크아웃을 열고 있는 workspace id. 열려 있지 않은 경로는 맵에 없다.
 * `prunable` = herdr 가 `is_prunable: true` 로 준 경로(디렉터리가 사라졌고 `git worktree prune` 전 — LIFE-628 G2). herdr 는 그런 줄에도
 * `open_workspace_id` 를 붙이므로 `byPath` 에는 들어 있다 — 귀속으로 셀지는 부르는 쪽이 정한다(골격은 git 이 그 경로를 버려 어차피 안 붙는다).
 */
export type OpenWorkspaceMap = { byPath: Map<string, string>; prunable: Set<string>; repoName: string | null; error: string | null }

export async function readOpenWorkspaces(socketPath: string, repoRoot: string): Promise<OpenWorkspaceMap> {
  const byPath = new Map<string, string>()
  const prunable = new Set<string>()
  try {
    const response = await request(socketPath, 'worktree.list', { cwd: repoRoot }, { reason: 'worktree' })
    if (response.error) {
      return { byPath, prunable, repoName: null, error: `${response.error.code ?? 'error'}: ${response.error.message ?? ''}` }
    }
    const result = response.result
    if (!isRecord(result)) return { byPath, prunable, repoName: null, error: 'worktree.list 응답 모양이 아니다' }
    for (const item of readArray(result, 'worktrees')) {
      if (!isRecord(item)) continue
      const itemPath = readString(item, 'path')
      const openId = readString(item, 'open_workspace_id')
      if (itemPath === null || openId === null) continue
      // git 쪽과 같은 정규화 (수정 1회차 L8). 두 쪽이 다른 canonical path 를 주면 조인이 조용히 빗나간다.
      byPath.set(canonicalPath(itemPath), openId)
      if (item['is_prunable'] === true) prunable.add(canonicalPath(itemPath))
    }
    const source = readRecord(result, 'source')
    return { byPath, prunable, repoName: source === null ? null : readString(source, 'repo_name'), error: null }
  } catch (error) {
    return { byPath, prunable, repoName: null, error: String(error) }
  }
}
