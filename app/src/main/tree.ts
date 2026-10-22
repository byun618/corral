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
import type { AgentSessionRef, GitStatusSummary, LinkPhase, RepoRow, SessionDigest, WorkspaceRow } from '../shared/types.js'
import type { WorktreeMetadataRecord } from './registry.js'
import { readOpenWorkspaces, type OpenWorkspaceMap } from './adapter/index.js'
import { getGitStatus } from './git-status.js'
import { listGitWorktrees } from './git-worktrees.js'
import { log } from './log.js'

/** 비싼 쪽 — git·herdr 왕복으로 얻는 골격. 행은 아직 안 붙었다. */
export type RepoSkeleton = {
  root: string
  name: string
  error: string | null
  /** `git worktree list` 실패(타임아웃 포함) — worktree 가 비어 그 레포의 카드 workspace 가 카드 밖으로 보이므로 카드 밖 판정을 하지 않는다(LIFE-628 F1). */
  gitError: string | null
  /** herdr 열림상태(`worktree.list`) 읽기 실패 — 이 레포의 바인딩을 모르므로 카드 밖 판정을 하지 않는다(LIFE-628). 재동기가 성공하면 걷힌다(F7). */
  openError: string | null
  worktrees: Array<{
    path: string
    branch: string | null
    head: string | null
    isLinked: boolean
    openWorkspaceId: string | null
    /** git-status.ts 의 TTL 캐시를 지난 값 — buildSkeleton 이 매번 다시 부르지만 캐시가 막는다. */
    gitStatus: GitStatusSummary
  }>
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
    const worktrees = await Promise.all(
      git.worktrees.map(async (worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
        head: worktree.head,
        isLinked: worktree.isLinked,
        openWorkspaceId: open.byPath.get(worktree.path) ?? null,
        gitStatus: await getGitStatus(worktree.path),
      })),
    )
    skeletons.push({
      root,
      name: open.repoName ?? path.basename(root),
      error: errors.length === 0 ? null : errors.join(' · '),
      gitError: git.error,
      openError: open.error,
      worktrees,
    })
  }
  skeletons.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root))
  return skeletons
}

/**
 * 지금 열린 pane들의 세션 참조를 모은다 (LIFE-366) — **디스크는 안 건드린다.**
 *
 * 읽기와 붙이기를 가르는 이유는 `buildSkeleton`/`joinTree` 를 가른 이유와 같다: 내보내기는
 * push 마다 일어나는데(잦다) 디스크 읽기는 그 박자로 돌면 안 된다. 그래서 읽기는 main 의
 * 주기가 따로 돌리고(`index.ts refreshDigests`), 내보낼 때는 이미 읽어 둔 것을 **붙이기만** 한다.
 */
export function collectSessionRefs(workspaces: readonly WorkspaceRow[]): Map<string, AgentSessionRef | null> {
  const refs = new Map<string, AgentSessionRef | null>()
  for (const workspace of workspaces) for (const tab of workspace.tabs) {
    for (const pane of tab.panes) refs.set(pane.paneId, pane.agentSession)
  }
  return refs
}

/** 읽어 둔 지문을 행에 붙인다. 순수 함수 — 없는 pane은 어댑터가 놓고 간 빈 지문 그대로 둔다. */
export function attachDigests(
  workspaces: readonly WorkspaceRow[],
  digests: ReadonlyMap<string, SessionDigest>,
): WorkspaceRow[] {
  return workspaces.map((workspace) => ({
    ...workspace,
    tabs: workspace.tabs.map((tab) => {
      // 탭바는 기존처럼 첫 세션 참조의 지문을 쓴다. 선택 pane에 따라 바꾸지 않는다.
      const firstSession = tab.panes.find((pane) => pane.agentSession !== null)
      return {
        ...tab,
        digest: (firstSession && digests.get(firstSession.paneId)) ?? tab.digest,
        panes: tab.panes.map((pane) => ({ ...pane, digest: digests.get(pane.paneId) ?? pane.digest })),
      }
    }),
  }))
}

/**
 * 카드 밖 workspace (LIFE-628 S1) — 어느 worktree 카드에도 귀속되지 않은 workspace. `joinTree` 가 `tree.unregistered` 로
 * 로그만 남기는 것과 같은 집합이다: `joinTree` 는 골격의 `openWorkspaceId` 가 가리키는 workspace 를 (이중 바인딩이면 가장 긴 경로
 * 하나에) 붙이므로, 귀속 = 골격 어딘가의 `openWorkspaceId` 다. 로그를 남기지 않는 순수 함수라 주기 수집이 불러도 된다.
 */
export function cardlessWorkspaces(input: { skeleton: readonly RepoSkeleton[]; workspaces: readonly WorkspaceRow[] }): WorkspaceRow[] {
  const claimed = new Set<string>()
  for (const repo of input.skeleton) for (const worktree of repo.worktrees) if (worktree.openWorkspaceId !== null) claimed.add(worktree.openWorkspaceId)
  return input.workspaces.filter((workspace) => !claimed.has(workspace.workspaceId))
}

/**
 * 카드 밖 판정의 문 (LIFE-628 F1·F2) — 가릴 수 있을 때만 `cardlessWorkspaces` 를 돌려준다. 순수 함수라 가드를 시험으로 잠근다.
 * null(가릴 수 없다 — 빈 목록과 다르다):
 *   · 소켓이 없다 · 골격이 지금 소켓으로 만든 것이 아니다(세션 전환 직후·첫 골격 전 — 바인딩이 비어 전부 카드 밖으로 보인다)
 *   · 링크가 live 가 아니다(재접속 중 store 가 비어 있을 수 있다) · 제 세션이 아니다(폴백으로 남의 세션에 붙음)
 *   · 어느 레포든 골격이 불완전하다 — `git worktree list` 실패(`gitError`, H1) 또는 herdr `worktree.list` 실패(`openError`)
 * 신선도(F2 — 표시 쪽 창 막기): 골격은 그 빌드를 **시작한** 시각의 herdr 상태다. 그 뒤에 처음 보인 workspace 는 골격이 아직 모른다 —
 * 카드에 붙을 workspace 가 한 주기 카드 밖으로 보이는 창이다. 그래서 `firstSeenAt > skeletonStartedAt` 인 workspace 는 다음 골격까지
 * 목록에 올리지 않고 `fresh` 로 센다(부르는 쪽이 골격 재구성을 한 번 건다 — 진짜 카드 밖이면 다음 골격 뒤에 나타난다).
 * 처음 본 시각을 모르는 workspace 도 올리지 않는다(모르면 막는 쪽).
 */
export function cardlessGate(input: {
  socketPath: string | null
  skeleton: readonly RepoSkeleton[]
  skeletonSocket: string | null
  skeletonStartedAt: number | null
  linkPhase: LinkPhase
  ownSession: boolean
  workspaces: readonly WorkspaceRow[]
  firstSeenAt: ReadonlyMap<string, number>
}): { rows: WorkspaceRow[]; fresh: number } | null {
  if (input.socketPath === null || input.skeletonSocket !== input.socketPath || input.skeletonStartedAt === null) return null
  if (input.linkPhase !== 'live' || !input.ownSession) return null
  if (input.skeleton.some((repo) => repo.gitError !== null || repo.openError !== null)) return null
  const rows: WorkspaceRow[] = []
  let fresh = 0
  for (const workspace of cardlessWorkspaces({ skeleton: input.skeleton, workspaces: input.workspaces })) {
    const seen = input.firstSeenAt.get(workspace.workspaceId)
    if (seen === undefined || seen > input.skeletonStartedAt) fresh += 1
    else rows.push(workspace)
  }
  return { rows, fresh }
}

/**
 * 카드 귀속 권위 재독 (LIFE-628 F2·G2·G7) — 등록 레포마다 herdr `worktree.list` 를 그 자리에서 읽어 `open_workspace_id` 합집합을 낸다.
 * 한 루트라도 읽기 실패면 null(부르는 쪽은 닫지 않는다). `is_prunable` 경로의 id 는 세지 않는다 — 디렉터리가 없어 카드가 없는 것과 맞춘다
 * (셸에서 지운 worktree 의 세션을 prune 전에도 닫을 수 있게). 같은 id 가 살아 있는 다른 경로에도 붙어 있으면 귀속이다.
 */
export async function readClaimedWorkspaceIds(input: {
  roots: readonly string[]
  read: (root: string) => Promise<OpenWorkspaceMap>
  log: (tag: string, data: Record<string, unknown>) => void
}): Promise<Set<string> | null> {
  const claimed = new Set<string>()
  for (const root of input.roots) {
    const open = await input.read(root)
    if (open.error !== null) {
      input.log('resource.claimed_read_failed', { root, error: open.error })
      return null
    }
    for (const [path, id] of open.byPath) if (!open.prunable.has(path)) claimed.add(id)
  }
  return claimed
}

/** 레지스트리 `parentWorktreeId` = `<repoId>::<canonicalPath>`(`runtime/workspace/model.ts`) — 화면은 경로만 쓴다. */
export function parentPathOf(parentWorktreeId: string | null | undefined): string | null {
  if (typeof parentWorktreeId !== 'string') return null
  const cut = parentWorktreeId.indexOf('::')
  return cut < 0 ? null : parentWorktreeId.slice(cut + 2) || null
}

/**
 * 싼 쪽 — 골격에 지금 저장소의 행을 붙인다. 내보낼 때마다 부른다.
 * `metadata` = 레지스트리 워크트리 메타(LIFE-478) — 내보낼 때마다 새로 읽은 값이라 CLI `worktree set` 도 다음 내보내기에 보인다.
 */
export function joinTree(skeleton: readonly RepoSkeleton[], workspaces: readonly WorkspaceRow[], metadata: Readonly<Record<string, WorktreeMetadataRecord>> = {}): Tree {
  const byWorkspaceId = new Map<string, WorkspaceRow>()
  for (const workspace of workspaces) byWorkspaceId.set(workspace.workspaceId, workspace)

  /**
   * 한 workspace 는 정확히 **한 worktree** 에만 열려 있다 — 그 pane 의 cwd 가 한 곳이므로.
   *
   * 그런데 herdr 는 pane 이 nested worktree(=부모 main 디렉터리 **아래** 있는 worktree)로 오갈 때
   * open_workspace_id 를 부모·자식 **두 worktree 에 함께** 다는 과도기가 있다 (게이트 ① 버그 ①,
   * 실측: raw/claude/fix3/herdr-both-bind-probe.json). 그 순간의 골격이 얼면 두 worktree 의
   * `openWorkspaceId` 가 같은 wsId 가 되고, 아래 조립이 그 wsId 행을 두 worktree 에 다 붙여
   * **화면이 '열림 2'로 거짓말한다**. 그래서 가장 구체적인(경로가 가장 긴) worktree 하나에만
   * 붙이고 나머지는 걷는다 — 골격이 낡아 있어도 화면엔 이중 바인딩이 안 나온다. 골격 자체를
   * 진실로 되돌리는 것은 재동기의 바인딩 갱신이 한다 (index.ts refreshBindings).
   */
  const winnerPathByWs = new Map<string, string>()
  for (const repo of skeleton) {
    for (const worktree of repo.worktrees) {
      const id = worktree.openWorkspaceId
      if (id === null) continue
      const current = winnerPathByWs.get(id)
      if (current === undefined || worktree.path.length > current.length) winnerPathByWs.set(id, worktree.path)
    }
  }

  const claimed = new Set<string>()
  const dropped: Array<{ workspaceId: string; worktree: string; boundTo: string }> = []
  const repos: RepoRow[] = skeleton.map((repo) => ({
    root: repo.root,
    name: repo.name,
    error: repo.error,
    worktrees: repo.worktrees.map((worktree) => {
      const id = worktree.openWorkspaceId
      const wins = id !== null && winnerPathByWs.get(id) === worktree.path
      if (id !== null && !wins) dropped.push({ workspaceId: id, worktree: worktree.path, boundTo: winnerPathByWs.get(id) ?? '?' })
      const workspace = wins ? (byWorkspaceId.get(id) ?? null) : null
      if (workspace !== null) claimed.add(workspace.workspaceId)
      return {
        path: worktree.path,
        branch: worktree.branch,
        head: worktree.head,
        repoName: repo.name,
        isLinked: worktree.isLinked,
        // 진 worktree 는 openWorkspaceId 도 null 로 걷는다 — App.tsx 는 '열림 N'을 openWorkspaceId
        // 로(388·432줄), 워크스페이스 행을 workspace 로(450줄) 센다. 둘 다 걷어야 거짓말이 안 남는다.
        openWorkspaceId: wins ? id : null,
        workspace,
        gitStatus: worktree.gitStatus,
        displayName: metadata[worktree.path]?.displayName || null,
        comment: metadata[worktree.path]?.comment || null,
        parentPath: parentPathOf(metadata[worktree.path]?.parentWorktreeId),
      }
    }),
  }))
  if (dropped.length > 0) log('tree.double_bind', { dropped })

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
