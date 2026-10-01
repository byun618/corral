// 사이드바 수동 순서 (LIFE-469 · 448 S3) — 순수 함수. DOM·저장은 여기 없다.
//
// **표현 = 키 배열**(레포 root 목록 · 레포별 연결 워크트리 path 목록). 198 은 숫자 rank(stride 1000, 이웃 사이
// 희소 삽입, 간격 고갈 때 재색인)를 쓰지만 corral 은 순서를 `ui-prefs.json` 한 파일에 통째로 쓰므로 rank 가
// 필요 없다 — 배열의 자리가 곧 순서라 간격 고갈·재색인이 생길 수 없다(00-analysis §6 「rank 표현은 재량」).
//
// 198 에서 가져온 규칙:
//   · 새 워크트리 → 그 레포 카드 목록 맨 위(198 `sortOrder: Date.now()`), 새 레포 → 맨 아래(`manual-repo-order.ts:43-69`).
// 198 과 의도적으로 다른 것(게이트 ① 사용자 수정 1, 사용자 결정): 198 은 주 체크아웃을 맨 위에 고정하지만
// (`section-order.ts:66-74`) corral 은 주 체크아웃도 다른 카드처럼 옮긴다 — 저장 목록에 주 체크아웃 path 도 담는다.
// 새 워크트리는 주 체크아웃보다도 위(목록 맨 위)에 온다.
//   · **이전**: 주 체크아웃 path 가 없는 저장 목록(469 수정 1 전 빌드는 연결 워크트리만 적었다)은 「주 체크아웃 먼저 →
//     저장 순서」로 읽는다 — 업그레이드로 화면이 바뀌지 않는다(K6ⓐ). 정규화가 그 자리에 주 체크아웃을 적어 둔다.
// 따라 하지 않는 것(C1, #22285): 기동·갱신 때 도는 정규화(`reconcileManualOrder`)는 **저장된 키의 상대 순서를
// 다시 매기지 않는다** — 새 키를 끼워 넣거나 확실히 사라진 키를 빼기만 한다.
import type { RepoRow, WorktreeRow } from '../../shared/types.js'
import { sortWorktrees } from './worktree-name.js'

/**
 * 저장되는 수동 순서. 정렬 **모드**는 여기 없다 — Sort by·Project order(LIFE-470)는 `ui-prefs` 의 별도 칸이고, 모드를 바꿔도
 * 이 데이터는 그대로 둔다(469 인계 — Manual 로 돌아오면 이전 순서).
 */
export type ManualOrder = {
  /** 레포 root, 위에서 아래 순. */
  repos: string[]
  /** 레포 root → 워크트리 path(주 체크아웃 포함 — 없으면 맨 앞으로 읽는다), 위에서 아래 순. */
  worktrees: Record<string, string[]>
  /**
   * Group by None 의 순서 — 워크트리 path, 위에서 아래 (LIFE-470). None 에서 끌어 놓은 적이 없으면 빈 목록이고 그때는
   * 레포 순서 → 레포 안 순서를 이어 붙여 읽는다(`orderAll`). 198 은 전역 rank 하나라 그룹 방식과 무관하게 같은 값을 쓴다 —
   * corral 은 레포별 목록(469)이 있어서 None 순서를 따로 두되, 끌어 놓을 때 서로에게 투영해 같은 상대 순서를 유지한다
   * (`applyAllMove`·`applyWorktreeMove`).
   */
  all: string[]
}

export const EMPTY_MANUAL_ORDER: ManualOrder = { repos: [], worktrees: {}, all: [] }

/** 문자열만 남기고 중복은 첫 자리만 — 손상된 칸(타입 틀림·중복 키)이 화면을 깨뜨리지 않게(K4ⓓ). */
export function readKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) if (typeof item === 'string' && item.length > 0) seen.add(item)
  return [...seen]
}

export function readWorktreeOrder(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [repoRoot, list] of Object.entries(value)) {
    if (repoRoot.length === 0 || !Array.isArray(list)) continue
    out[repoRoot] = readKeyList(list)
  }
  return out
}

/** 저장 목록에 있는 것은 그 순서로, 없는 것은 들어온 순서(=기본 순서) 그대로 뒤에. */
export function orderRepos(input: { repos: readonly RepoRow[]; stored: readonly string[] }): RepoRow[] {
  const byRoot = new Map(input.repos.map((repo) => [repo.root, repo]))
  const known: RepoRow[] = []
  for (const root of input.stored) {
    const repo = byRoot.get(root)
    if (repo !== undefined) known.push(repo)
  }
  const storedSet = new Set(input.stored)
  return [...known, ...input.repos.filter((repo) => !storedSet.has(repo.root))]
}

/**
 * 저장 목록을 주 체크아웃이 든 모양으로 읽는다 — 주 체크아웃 path 가 빠져 있으면 맨 앞에 붙인다(이전, K6ⓐ).
 * `worktrees` 는 기본 순서(`sortWorktrees`)여야 한다 — 주 체크아웃이 여럿이면 그 순서로 붙는다.
 */
function withMains(input: { worktrees: readonly WorktreeRow[]; stored: readonly string[] }): string[] {
  const storedSet = new Set(input.stored)
  const missingMains = input.worktrees.filter((worktree) => !worktree.isLinked && !storedSet.has(worktree.path)).map((worktree) => worktree.path)
  return missingMains.length === 0 ? [...input.stored] : [...missingMains, ...input.stored]
}

/**
 * 한 레포의 워크트리 표시 순서 — 저장 목록에 없는 워크트리(새것, 기본 순서) → 저장 순서(주 체크아웃 포함).
 * 주 체크아웃 path 가 없는 저장 목록은 주 체크아웃을 맨 앞으로 읽는다(`withMains`, 이전).
 * 저장 목록이 아예 없으면(`undefined`, 469 이전 사용자) 기본 순서(`sortWorktrees`) 그대로다(K6ⓐ).
 */
export function orderWorktrees(input: { worktrees: readonly WorktreeRow[]; stored: readonly string[] | undefined }): WorktreeRow[] {
  const base = sortWorktrees([...input.worktrees])
  if (input.stored === undefined) return base
  const stored = withMains({ worktrees: base, stored: input.stored })
  const byPath = new Map(base.map((worktree) => [worktree.path, worktree]))
  const storedSet = new Set(stored)
  const known: WorktreeRow[] = []
  for (const path of stored) {
    const worktree = byPath.get(path)
    if (worktree !== undefined) known.push(worktree)
  }
  return [...base.filter((worktree) => !storedSet.has(worktree.path)), ...known]
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/**
 * 목록이 바뀔 때마다 도는 정규화 — **저장된 키끼리의 상대 순서는 절대 바꾸지 않는다**(C1).
 *
 * - 레포: 처음 보는 root 를 맨 뒤에 붙인다. 지금 목록에 없는 root 는 **지우지 않는다** — 기동 직후 빈 목록이나
 *   일시 오류로 순서를 잃는 경로(#22285 의 결)를 막는다. 레포를 지울 때는 `forgetRepo` 가 명시로 뺀다.
 * - 워크트리: 처음 보는 워크트리를 그 레포 맨 앞(주 체크아웃보다도 위)에 끼운다(K5ⓐ). 주 체크아웃 path 가 없는
 *   저장 목록은 먼저 주 체크아웃을 맨 앞에 적는다(이전 — 지금 화면 그대로, K6ⓐ). 저장 목록이 없던 레포는 지금
 *   기본 순서를 그대로 적는다(materialize) — 그래야 이후의 새 워크트리를 「새것」으로 알아본다(K5ⓐ).
 *   사라진 path 는 **그 레포의 git 목록이 성공했을 때만**(오류 없음 + 주 체크아웃 있음) 뺀다.
 *
 * 바뀐 것이 없으면 `changed: false` — 호출부가 파일을 다시 쓰지 않는다.
 */
export function reconcileManualOrder(input: { order: ManualOrder; repos: readonly RepoRow[] }): { order: ManualOrder; changed: boolean } {
  const { order, repos } = input
  const repoSet = new Set(order.repos)
  const nextRepos = [...order.repos, ...repos.filter((repo) => !repoSet.has(repo.root)).map((repo) => repo.root)]
  let changed = !sameList(nextRepos, order.repos)

  const nextWorktrees: Record<string, string[]> = { ...order.worktrees }
  /** 확실히 사라진 path(그 레포 git 목록이 성공했는데 없음) — None 순서에서도 뺀다(LIFE-470 R1-03). */
  const gone = new Set<string>()
  for (const repo of repos) {
    const base = sortWorktrees([...repo.worktrees])
    const paths = base.map((worktree) => worktree.path)
    const stored = order.worktrees[repo.root]
    let next: string[]
    if (stored === undefined) {
      if (repo.error !== null) continue
      next = paths
    } else {
      const migrated = withMains({ worktrees: base, stored })
      const migratedSet = new Set(migrated)
      const fresh = paths.filter((path) => !migratedSet.has(path))
      const listed = repo.error === null && repo.worktrees.some((worktree) => !worktree.isLinked)
      const present = new Set(paths)
      next = [...fresh, ...(listed ? migrated.filter((path) => present.has(path)) : migrated)]
      if (listed) for (const path of migrated) if (!present.has(path)) gone.add(path)
      if (sameList(next, stored)) continue
    }
    nextWorktrees[repo.root] = next
    changed = true
  }
  const nextAll = reconcileFlat({ all: order.all, order: { repos: nextRepos, worktrees: nextWorktrees, all: order.all }, repos, gone })
  if (!sameList(nextAll, order.all)) changed = true
  return { order: changed ? { repos: nextRepos, worktrees: nextWorktrees, all: nextAll } : order, changed }
}

/**
 * None 순서 정규화 (LIFE-470 R1-03) — None 에서 한 번 끌어 놓아 `all` 이 적힌 뒤에는 레포별 목록과 **같은 권위 조건**으로 맞춘다:
 * 처음 보는 path 는 맨 앞(`orderAll` 이 새것을 맨 위로 읽는 자리 그대로 — 화면은 안 바뀐다), 확실히 사라진 path 는 뺀다. 지금 목록에
 * 없지만 확실히 사라졌다고 말할 수 없는 path(일시 오류·불완전 목록)는 자리 그대로 둔다. 적힌 적 없으면(빈 목록) 그대로 비워 둔다.
 * 새 path 를 적어 둬야 한쪽 그룹 방식에서 옮긴 상대 순서가 다른 쪽에 투영된다(`refillSlots` 는 목록에 있는 키만 옮긴다).
 */
function reconcileFlat(input: { all: readonly string[]; order: ManualOrder; repos: readonly RepoRow[]; gone: ReadonlySet<string> }): string[] {
  if (input.all.length === 0) return []
  const stored = new Set(input.all)
  const fresh = orderAll({ repos: input.repos, order: { ...input.order, all: [] } })
    .map((item) => item.worktree.path)
    .filter((path) => !stored.has(path))
  return [...fresh, ...input.all.filter((path) => !input.gone.has(path))]
}

/** 레포 등록 해제 뒤 — 다시 추가하면 198 처럼 맨 아래에 온다. */
export function forgetRepo(input: { order: ManualOrder; root: string }): ManualOrder {
  const worktrees = { ...input.order.worktrees }
  delete worktrees[input.root]
  // 그 레포 카드는 None 순서에서도 뺀다(R1-03) — 다시 추가하면 새것으로 들어온다.
  const removed = new Set(input.order.worktrees[input.root] ?? [])
  return { repos: input.order.repos.filter((root) => root !== input.root), worktrees, all: input.order.all.filter((path) => !removed.has(path)) }
}

/**
 * 끌어 놓기 한 번 — `keys` 는 **지금 화면 순서**(끄는 항목 포함), `slot` 은 그 목록 기준 경계 번호(0 = 맨 앞,
 * `keys.length` = 맨 뒤). 제자리면 `null`(파일을 쓰지 않는다).
 */
export function moveKey(input: { keys: readonly string[]; key: string; slot: number }): string[] | null {
  const from = input.keys.indexOf(input.key)
  if (from < 0) return null
  const slot = Math.max(0, Math.min(input.keys.length, Math.trunc(input.slot)))
  const to = slot > from ? slot - 1 : slot
  if (to === from) return null
  const next = input.keys.filter((key) => key !== input.key)
  next.splice(to, 0, input.key)
  return next
}

/**
 * 레포 드롭 반영 — 화면 순서로 다시 적는다. 지금 목록에 없는 저장 키(일시 오류 등)는 뒤에 그대로 붙여 잃지 않는다.
 */
export function applyRepoMove(input: { order: ManualOrder; visibleRoots: readonly string[]; root: string; slot: number }): ManualOrder | null {
  const moved = moveKey({ keys: input.visibleRoots, key: input.root, slot: input.slot })
  if (moved === null) return null
  const visible = new Set(input.visibleRoots)
  return { ...input.order, repos: [...moved, ...input.order.repos.filter((root) => !visible.has(root))] }
}

/**
 * 워크트리 드롭 반영 — `visiblePaths` 는 그 레포의 카드 화면 순서(주 체크아웃 포함, 필터 뒤). `worktrees` 는 그 레포의 지금 워크트리 전부.
 * 필터에 가려진 카드는 **자리를 지킨다**(LIFE-470 R1-02) — 필터 전 실효 순서에서 보이는 카드가 차지한 자리만 새 순서로 채운다.
 */
export function applyWorktreeMove(input: {
  order: ManualOrder
  repoRoot: string
  worktrees: readonly WorktreeRow[]
  visiblePaths: readonly string[]
  path: string
  slot: number
}): ManualOrder | null {
  const moved = moveKey({ keys: input.visiblePaths, key: input.path, slot: input.slot })
  if (moved === null) return null
  const effective = effectiveRepoList({ worktrees: input.worktrees, stored: input.order.worktrees[input.repoRoot] })
  // 화면에는 있는데 목록 행에 없는 키(방어) — 앞에 두어 채우기에서 빠지지 않게 한다.
  const effectiveSet = new Set(effective)
  const repoList = refillSlots({ list: [...moved.filter((path) => !effectiveSet.has(path)), ...effective], members: moved })
  // None 순서가 적혀 있으면 그 레포 카드들이 차지한 자리를 새 레포 안 순서로 다시 채운다(LIFE-470) — 198 전역 rank 처럼
  // 한쪽에서 바꾼 상대 순서가 다른 그룹 방식에서도 같다.
  return { ...input.order, worktrees: { ...input.order.worktrees, [input.repoRoot]: repoList }, all: refillSlots({ list: input.order.all, members: repoList }) }
}

/**
 * 한 레포의 필터 전 실효 순서 + 지금 목록에 없는 저장 키(자리 그대로) — `orderWorktrees` 가 그리는 순서에 일시적으로 빠진 키를 얹은 것.
 * 새것(저장 안 됨)이 맨 앞인 것도 `orderWorktrees` 와 같다.
 */
function effectiveRepoList(input: { worktrees: readonly WorktreeRow[]; stored: readonly string[] | undefined }): string[] {
  const base = sortWorktrees([...input.worktrees])
  if (input.stored === undefined) return base.map((worktree) => worktree.path)
  const stored = withMains({ worktrees: base, stored: input.stored })
  const storedSet = new Set(stored)
  return [...base.filter((worktree) => !storedSet.has(worktree.path)).map((worktree) => worktree.path), ...stored]
}

/**
 * `list` 에서 `members` 가 차지한 자리를 `members` 순서로 다시 채운다 — 다른 키의 자리는 그대로. `members` 중 `list` 에 없는
 * 키는 건드리지 않는다(그 키는 `orderAll` 이 「새것」으로 읽는다).
 */
function refillSlots(input: { list: readonly string[]; members: readonly string[] }): string[] {
  const inList = new Set(input.list)
  const queue = input.members.filter((key) => inList.has(key))
  const memberSet = new Set(queue)
  let next = 0
  return input.list.map((key) => (memberSet.has(key) ? (queue[next++] ?? key) : key))
}

/**
 * Group by None 의 수동 순서 (LIFE-470) — 저장 목록(`all`)에 없는 워크트리(새것, 기본 순서) → 저장 순서.
 * 기본 순서 = 레포 수동 순서 → 레포 안 수동 순서(469 데이터를 그대로 이어 붙인다). 저장 목록이 비어 있으면 기본 순서 그대로다.
 * 새 워크트리가 맨 위에 오는 것은 469 레포 안 규칙(새것 맨 위)과 같은 결이다.
 */
export function orderAll(input: { repos: readonly RepoRow[]; order: ManualOrder }): { repoRoot: string; worktree: WorktreeRow }[] {
  const base = orderRepos({ repos: input.repos, stored: input.order.repos }).flatMap((repo) =>
    orderWorktrees({ worktrees: repo.worktrees, stored: input.order.worktrees[repo.root] }).map((worktree) => ({ repoRoot: repo.root, worktree })),
  )
  if (input.order.all.length === 0) return base
  const byPath = new Map(base.map((item) => [item.worktree.path, item]))
  const stored = new Set(input.order.all)
  const known: { repoRoot: string; worktree: WorktreeRow }[] = []
  for (const path of input.order.all) {
    const item = byPath.get(path)
    if (item !== undefined) known.push(item)
  }
  return [...base.filter((item) => !stored.has(item.worktree.path)), ...known]
}

/**
 * None 구획 드롭 반영 (LIFE-470) — `visiblePaths` 는 None 구획의 카드 화면 순서(레포 섞임, 필터 뒤), `repos` 는 지금 목록 전부.
 * 필터 전 실효 순서(`orderAll` + 지금 목록에 없는 저장 키는 자리 그대로)에서 **보이는 카드가 차지한 자리만** 새 순서로 채운다 —
 * 필터에 가려진 카드는 첫 저장이든 기존 저장이든 자리를 지킨다(R1-02). 레포별 목록에도 투영한다 — 옮긴 카드 레포의 카드들이
 * 차지한 자리를 None 의 새 상대 순서로 다시 채운다(Project 로 돌아가도 같은 상대 순서).
 */
export function applyAllMove(input: {
  order: ManualOrder
  repos: readonly RepoRow[]
  visiblePaths: readonly string[]
  path: string
  slot: number
}): ManualOrder | null {
  const moved = moveKey({ keys: input.visiblePaths, key: input.path, slot: input.slot })
  if (moved === null) return null
  const effective = orderAll({ repos: input.repos, order: input.order }).map((item) => item.worktree.path)
  const storedSet = new Set(input.order.all)
  const full = input.order.all.length === 0 ? effective : [...effective.filter((path) => !storedSet.has(path)), ...input.order.all]
  const all = refillSlots({ list: full, members: moved })
  const repo = input.repos.find((row) => row.worktrees.some((worktree) => worktree.path === input.path))
  if (repo === undefined) return { ...input.order, all }
  const current = input.order.worktrees[repo.root]
  if (current === undefined) return { ...input.order, all }
  const repoPaths = new Set(repo.worktrees.map((worktree) => worktree.path))
  const sameRepo = all.filter((path) => repoPaths.has(path))
  return { ...input.order, all, worktrees: { ...input.order.worktrees, [repo.root]: refillSlots({ list: effectiveRepoList({ worktrees: repo.worktrees, stored: current }), members: sameRepo }) } }
}

/** 화면에 보이는 한 그룹의 카드 배치 — 레포 구획(Group by Project) 또는 None 구획 하나. `paths` 는 필터 뒤 화면 순서. */
export type LayoutGroup = { kind: 'repo'; root: string; paths: string[] } | { kind: 'all'; paths: string[] }

/**
 * 비-manual 정렬에서 끌어 Manual 로 바뀌는 드롭 (LIFE-470 R2-01) — 움직임을 반영하기 **전에** 보이는 모든 그룹의 지금 배치를
 * 수동 순서로 확정한다(198 `worktree-manual-order.ts:115-157` — 비-manual 에서 끌면 보이는 전 행에 rank 를 새로 매긴다).
 * 안 그러면 Manual 로 바뀌는 순간 끌지 않은 레포가 옛 수동 순서로 튄다. 그룹마다 필터 전 실효 순서에서 보이는 카드가 차지한
 * 자리만 화면 순서로 채운다 — 가려진 카드는 자리를 지킨다(R1-02). 레포 순서는 건드리지 않는다(Project order 는 별도 설정).
 *   · 레포 구획 → 그 레포 목록, None 순서가 적혀 있으면 그 레포 카드 자리에 투영
 *   · None 구획 → None 순서, 레포마다 그 레포 카드 자리에 투영
 */
export function materializeLayout(input: { order: ManualOrder; repos: readonly RepoRow[]; layout: readonly LayoutGroup[] }): ManualOrder {
  let order = input.order
  for (const group of input.layout) {
    switch (group.kind) {
      case 'repo': {
        const repo = input.repos.find((row) => row.root === group.root)
        if (repo === undefined) continue
        const repoList = refillSlots({ list: effectiveRepoList({ worktrees: repo.worktrees, stored: order.worktrees[repo.root] }), members: group.paths })
        order = { ...order, worktrees: { ...order.worktrees, [repo.root]: repoList }, all: refillSlots({ list: order.all, members: repoList }) }
        break
      }
      case 'all': {
        const effective = orderAll({ repos: input.repos, order }).map((item) => item.worktree.path)
        const storedSet = new Set(order.all)
        const full = order.all.length === 0 ? effective : [...effective.filter((path) => !storedSet.has(path)), ...order.all]
        const all = refillSlots({ list: full, members: group.paths })
        const worktrees = { ...order.worktrees }
        for (const repo of input.repos) {
          const repoPaths = new Set(repo.worktrees.map((worktree) => worktree.path))
          worktrees[repo.root] = refillSlots({ list: effectiveRepoList({ worktrees: repo.worktrees, stored: order.worktrees[repo.root] }), members: all.filter((path) => repoPaths.has(path)) })
        }
        order = { ...order, all, worktrees }
        break
      }
    }
  }
  return order
}
