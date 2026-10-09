// 사이드바 목록 논리 (LIFE-470 · 448 S4-A) — 필터 → 정렬 → 그룹. 순수 함수만 둔다(DOM·저장 없음).
//
// 198 대응:
//   · 정렬 비교 = `smart-sort.ts:104-161` · attention 5클래스 = `smart-attention.ts:20-27,147-226`
//   · 프로젝트 순서 Recent = `section-order.ts:179-197` · 필터 = `visible-worktrees.ts:108-143`
//   · Group by None = 단일 「All」 헤더(`group-keys.ts:88-96`), Project = 레포 헤더
//
// **Manual 모드는 수동 순서(469 데이터)만 본다** — 에이전트 활동·선택·세션 열기/닫기는 순서 입력이 아니다(Orca #13847 교정, K7ⓔ).

import type { PaneRow, RepoRow, WorktreeRow } from '../../shared/types.js'
import type { SidebarSortBy, SidebarView } from '../../shared/sidebar-view.js'
import { agentDot } from './agent-dot.js'
import { orderAll, orderRepos, orderWorktrees, type LayoutGroup, type ManualOrder } from './manual-order.js'
import { worktreeDisplayName } from './worktree-name.js'
import { worktreeIdentity } from './worktree-identity.js'

// --- 필터 ------------------------------------------------------------------------------------------

/** 지금 등록된 레포 중 필터에 고른 것 — 제거된 레포 id 는 개수·필터에서 무시한다(198 `SidebarRepositoryFilterSection.tsx:55-65`, K3ⓓ). */
export function effectiveRepoFilter(input: { view: SidebarView; repos: readonly RepoRow[] }): string[] {
  const selected = new Set(input.view.repoFilter)
  return input.repos.filter((repo) => selected.has(repo.root)).map((repo) => repo.root)
}

/** 옵션 버튼 배지 숫자 — 켠 스위치 1개씩 + 고른 레포 1개씩(198 `workspace-options-menu-items.tsx:61-70`). */
export function activeFilterCount(input: { view: SidebarView; repos: readonly RepoRow[] }): number {
  const { view } = input
  return (view.hideDefaultBranch ? 1 : 0) + (view.hideDetachedHead ? 1 : 0) + effectiveRepoFilter(input).length
}

/** 배지 글자 — 9 넘으면 「9+」(198 `:66`). */
export function filterBadgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/**
 * detached HEAD — 198 `visible-worktree-kinds.ts:47` 처럼 identity 판정(`worktree-identity.ts`)이 `detached` 인 행만이다.
 * 브랜치도 HEAD 도 없는 행(bare 등)은 detached 로 세지 않는다(LIFE-491 — 전에는 `branch === null` 도 detached 로 셌다).
 */
export function isDetachedWorktree(worktree: WorktreeRow): boolean {
  return worktreeIdentity(worktree)?.kind === 'detached'
}

/** 198 `isDefaultBranchWorkspace` — 주 체크아웃이고 브랜치가 있다. 주 체크아웃이 detached 면 Hide detached HEAD 쪽이 숨긴다. */
export function isDefaultBranchWorktree(worktree: WorktreeRow): boolean {
  return !worktree.isLinked && !isDetachedWorktree(worktree) && worktree.branch !== null && worktree.branch.trim() !== ''
}

/** 한 워크트리가 지금 필터로 보이는가. 레포 필터는 레포 단위라 여기서는 보지 않는다(`visibleRepos`). */
export function passesWorktreeFilters(input: { view: SidebarView; worktree: WorktreeRow }): boolean {
  const { view, worktree } = input
  if (view.hideDefaultBranch && isDefaultBranchWorktree(worktree)) return false
  if (view.hideDetachedHead && isDetachedWorktree(worktree)) return false
  return true
}

function visibleRepos(input: { view: SidebarView; repos: readonly RepoRow[] }): RepoRow[] {
  const filter = new Set(effectiveRepoFilter(input))
  return filter.size === 0 ? [...input.repos] : input.repos.filter((repo) => filter.has(repo.root))
}

// --- 시각 · attention --------------------------------------------------------------------------------

/** 198 `AGENT_STATUS_STALE_AFTER_MS`(`shared/agent-status-freshness.ts:7`) — 「신선한 완료」(클래스 2)의 수명. */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

/** 에이전트 pane 만 — 셸 pane 은 상태가 `unknown` 이라 클래스 4 로 끌려 올라가면 안 된다(사이드바 행도 에이전트만 그린다). */
function agentPanes(worktree: WorktreeRow): PaneRow[] {
  return (worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes.filter((pane) => pane.agent !== null))
}

/**
 * Recent 시각 (U1) — 그 워크트리 pane 들의 「마지막 활동」 최댓값: 기록의 마지막 활동(`digest.lastActivityAt`)과 상태 관측 시각
 * (`agentState.observedAt`). 셸 pane 도 센다(터미널을 쓴 것도 활동이다). 닫힌 워크트리 = 0(시각 없음 → 이름순으로 뒤에).
 *
 * 198 은 워크트리 레코드의 `lastActivityAt`(PTY spawn·배경 이벤트·메타 편집이 올린다)이고, 생성 뒤 5분 유예(`CREATE_GRACE_MS`)를
 * 둔다. corral 워크트리에는 그런 칸·생성 시각이 없어(00-analysis U1) pane 이 준 시각으로 잰다. 생성 유예는 두지 않는다 —
 * 생성 시각을 모른다. 새 워크트리는 열자마자 pane 이 생겨 시각이 생기므로 대개 맨 위로 온다.
 */
export function worktreeRecentAt(worktree: WorktreeRow): number {
  let latest = 0
  for (const tab of worktree.workspace?.tabs ?? [])
    for (const pane of tab.panes) latest = Math.max(latest, pane.digest.lastActivityAt ?? 0, pane.agentState.observedAt)
  return latest
}

export type SmartClass = 1 | 2 | 3 | 4 | 5
export type Attention = { cls: SmartClass; at: number }
export const IDLE_ATTENTION: Attention = { cls: 5, at: 0 }

/** 지난 전이 중 가장 최근의 done·blocked 시각 — working 클래스 안 순서(198 `mostRecentAttentionInHistory`). */
function priorAttentionAt(pane: PaneRow): number | null {
  let latest = 0
  for (const entry of pane.agentState.history) if (entry.status === 'done' || entry.status === 'blocked') latest = Math.max(latest, entry.observedAt)
  return latest > 0 ? latest : null
}

/**
 * pane 하나의 attention (U2) — corral 점(467 `k4-dot-map.md`, `agent-dot.ts`)을 198 5클래스로 옮긴다:
 *
 * | 점 | 클래스 | 시각 |
 * | --- | --- | --- |
 * | waiting · blocked | 1 대기·질문 | 그 상태에 들어선 시각 |
 * | done (30분 안) | 2 신선한 완료 | 완료 시각(`enteredDoneAt`) |
 * | failed (30분 안) | 2 | 결과 시각 — 218 `#22944` 쪽(실패한 done 은 클래스 2). 198 에는 failed 가 없다 |
 * | working · monitoring | 3 | 지난 done/blocked 시각(없으면 working 시작) |
 * | unverifiable | 4 | 관측 시각 |
 * | interrupted · idle · 30분 지난 done/failed | 5 | 0 |
 *
 * interrupted 를 클래스 2 에서 빼는 것은 198·218 이 같다(사용자가 멈춘 턴은 주의 대상이 아니다).
 */
export function paneAttention(input: { pane: PaneRow; now: number }): Attention {
  const { pane, now } = input
  const dot = agentDot({
    agentStatus: pane.agentStatus,
    blockedReason: pane.agentState.blockedReason,
    pendingQuestions: pane.digest.pendingQuestions,
    turnOutcome: pane.digest.turnOutcome,
    lifecycle: pane.digest.lifecycle,
    freshness: { observedAt: pane.agentState.observedAt, observedVia: pane.agentState.observedVia, outcomeAt: pane.digest.turnOutcomeAt },
  })
  switch (dot) {
    case 'waiting':
    case 'blocked':
      return { cls: 1, at: pane.agentState.observedAt }
    case 'done': {
      const at = pane.agentState.enteredDoneAt ?? pane.agentState.observedAt
      return now - at > AGENT_STATUS_STALE_AFTER_MS ? IDLE_ATTENTION : { cls: 2, at }
    }
    case 'failed': {
      const at = pane.digest.turnOutcomeAt ?? pane.agentState.observedAt
      return now - at > AGENT_STATUS_STALE_AFTER_MS ? IDLE_ATTENTION : { cls: 2, at }
    }
    case 'working':
    case 'monitoring':
      return { cls: 3, at: priorAttentionAt(pane) ?? pane.agentState.observedAt }
    case 'unverifiable':
      return { cls: 4, at: pane.agentState.observedAt }
    case 'interrupted':
    case 'idle':
      return IDLE_ATTENTION
  }
}

/** 워크트리 attention — 가장 낮은 클래스가 이기고, 같은 클래스면 가장 늦은 시각(198 `resolveAttention`). */
export function worktreeAttention(input: { worktree: WorktreeRow; now: number }): Attention {
  let best = IDLE_ATTENTION
  for (const pane of agentPanes(input.worktree)) {
    const next = paneAttention({ pane, now: input.now })
    if (next.cls < best.cls || (next.cls === best.cls && next.at > best.at)) best = next
  }
  return best
}

// --- 정렬 ----------------------------------------------------------------------------------------------

export type SortItem = { repoRoot: string; repoName: string; worktree: WorktreeRow }

function compareLabel(input: { a: SortItem; b: SortItem }): number {
  return worktreeDisplayName(input.a.worktree).localeCompare(worktreeDisplayName(input.b.worktree))
}

/**
 * 비-manual 모드 비교 (198 `buildWorktreeComparator`). Manual 은 여기 오지 않는다 — 수동 순서 목록을 그대로 쓴다(`sortItems`).
 * 이름 = 1줄 표시 이름(브랜치 풀네임 — `worktree-name.ts`, 198 은 displayName → path basename).
 */
export function compareItems(input: { sortBy: Exclude<SidebarSortBy, 'manual'>; now: number; a: SortItem; b: SortItem }): number {
  const { sortBy, now, a, b } = input
  switch (sortBy) {
    case 'name':
      return compareLabel({ a, b })
    case 'smart': {
      const aw = worktreeAttention({ worktree: a.worktree, now })
      const bw = worktreeAttention({ worktree: b.worktree, now })
      return aw.cls - bw.cls || bw.at - aw.at || worktreeRecentAt(b.worktree) - worktreeRecentAt(a.worktree) || compareLabel({ a, b })
    }
    case 'recent':
      return worktreeRecentAt(b.worktree) - worktreeRecentAt(a.worktree) || compareLabel({ a, b })
    case 'repo':
      return a.repoName.localeCompare(b.repoName) || compareLabel({ a, b })
  }
}

/** `manualItems` = 수동 순서대로 늘어선 같은 항목들. Manual 이면 그대로, 아니면 그 모드로 정렬한다. */
export function sortItems(input: { sortBy: SidebarSortBy; now: number; manualItems: readonly SortItem[] }): SortItem[] {
  const { sortBy, now } = input
  if (sortBy === 'manual') return [...input.manualItems]
  return [...input.manualItems].sort((a, b) => compareItems({ sortBy, now, a, b }))
}

// --- 그룹 ------------------------------------------------------------------------------------------------

export type SidebarSection =
  /** Group by Project — 레포 헤더 + 그 레포 카드. */
  | { kind: 'repo'; repo: RepoRow; items: SortItem[] }
  /** Group by None — 단일 「All」 헤더(198 `group-keys.ts:88-96`) 아래 전 워크트리, 레포 헤더 없음. */
  | { kind: 'all'; items: SortItem[] }
  /**
   * Pinned (LIFE-478 K5 · 198 `build-rows.ts:100-149`) — 맨 위, 고정한 카드만, 순서 = 현재 정렬. 고정한 카드는 원래 그룹에서 **빠진다**
   * (198 기본 `showPinnedWorktreesInGroups: false` 단일 위치 — 게이트 ⓪ Q2). 필터는 그대로 적용된다(가려진 카드는 여기도 없다).
   */
  | { kind: 'pinned'; items: SortItem[] }

/**
 * 프로젝트 순서 Recent (198 `section-order.ts:179-197`) — 레포의 순위 = 보이는 워크트리 Recent 시각 최댓값 내림차순.
 * 활동 없는 레포는 활동 있는 레포 뒤, 그 안에서는 수동 순서(198 은 `repo.addedAt` 내림차순 → 수동 → 이름 — corral 레지스트리에는
 * 추가 시각이 없어 수동 순서로 바로 간다). `ordered` 는 수동 순서대로 들어온다.
 */
function orderRepoSections(input: { ordered: { repo: RepoRow; items: SortItem[] }[]; projectOrderBy: SidebarView['projectOrderBy'] }) {
  if (input.projectOrderBy === 'manual') return input.ordered
  const rank = new Map(input.ordered.map((section, index) => [section.repo.root, index]))
  const recentOf = (items: readonly SortItem[]): number => items.reduce((max, item) => Math.max(max, worktreeRecentAt(item.worktree)), 0)
  return [...input.ordered].sort((a, b) => {
    const ra = recentOf(a.items)
    const rb = recentOf(b.items)
    if (ra !== rb) return rb - ra
    return (rank.get(a.repo.root) ?? 0) - (rank.get(b.repo.root) ?? 0)
  })
}

/**
 * 목록 한 벌 — 필터·정렬·그룹을 다 건 구획들. 레포 필터에 걸린 레포는 구획째 빠진다. 스위치 필터로 카드가 0이 된 레포는
 * 헤더도 빼되, **필터가 하나도 없을 때의 빈 레포**(git 오류·워크트리 0)는 지금처럼 헤더를 남긴다(오류를 보여 주는 자리라서).
 */
/** 화면 구획 → 그룹별 카드 배치(LIFE-470 R2-01) — 비-manual → Manual 전환 드롭이 이 배치를 먼저 수동 순서로 확정한다(`materializeLayout`). */
export function sectionLayout(sections: readonly SidebarSection[]): LayoutGroup[] {
  return sections.flatMap((section): LayoutGroup[] => {
    const paths = section.items.map((item) => item.worktree.path)
    switch (section.kind) {
      case 'repo':
        return [{ kind: 'repo', root: section.repo.root, paths }]
      case 'all':
        return [{ kind: 'all', paths }]
      // 고정 카드는 끌기 대상이 아니다(K5ⓕ) — 그룹 배치에 없고, 원래 그룹 목록의 자리는 `refillSlots` 가 지킨다(가려진 카드와 같다).
      case 'pinned':
        return []
    }
  })
}

export function buildSidebarSections(input: {
  repos: readonly RepoRow[]
  view: SidebarView
  order: ManualOrder
  now: number
  /** 고정한 워크트리 경로(ui-prefs `pinnedWorktrees`). 없는 경로는 무시한다 — 삭제·레포 제거된 핀은 유령으로 안 남는다(K5ⓗ). */
  pinned?: ReadonlySet<string>
}): SidebarSection[] {
  const { view, order, now } = input
  const repos = visibleRepos({ view, repos: input.repos })
  const nameOf = new Map(repos.map((repo) => [repo.root, repo.name]))
  const passes = (item: SortItem): boolean => passesWorktreeFilters({ view, worktree: item.worktree })
  const pinned = pinnedSectionPaths({ repos: input.repos, visible: repos, view, pinned: input.pinned ?? NO_PINS })
  const keep = (item: SortItem): boolean => passes(item) && !pinned.has(item.worktree.path)
  // Pinned 순서 = 지금 정렬(198 `sortedIds`) — Manual 이면 평면 수동 순서(`orderAll`), 아니면 그 모드의 비교.
  const pinnedItems = pinned.size === 0 ? [] : sortItems({
    sortBy: view.sortBy,
    now,
    manualItems: orderAll({ repos, order })
      .map(({ repoRoot, worktree }) => ({ repoRoot, repoName: nameOf.get(repoRoot) ?? '', worktree }))
      .filter((item) => pinned.has(item.worktree.path) && passes(item)),
  })
  const pinnedSection: SidebarSection[] = pinnedItems.length === 0 ? [] : [{ kind: 'pinned', items: pinnedItems }]
  return [...pinnedSection, ...groupedSections({ repos, view, order, now, nameOf, keep })]
}

const NO_PINS: ReadonlySet<string> = new Set()

/**
 * Pinned 구획에 들어갈 경로 (수정 r1 M1 — Orca `pinned-section-worktrees.ts:8-41` `getPinnedSectionWorktrees`) — **보이는** 고정 카드에서 시작해
 * 부모 링크의 후손을 전부 따라 내려가며, 보이는(레포 필터·스위치 필터 통과) 후손을 함께 올린다. 가려진 중간 카드도 길로는 지나간다(Orca 와 같다).
 * 가려진 고정 카드는 출발점이 아니다(Orca 는 보이는 목록에서 `isPinned` 를 고른다). 고정을 풀면 후손은 원래 구획으로 돌아간다.
 */
function pinnedSectionPaths(input: { repos: readonly RepoRow[]; visible: readonly RepoRow[]; view: SidebarView; pinned: ReadonlySet<string> }): ReadonlySet<string> {
  if (input.pinned.size === 0) return input.pinned
  // 간선 = 전체 그래프의 유효 간선(같은 레포·순환 아님 — 수정 r2 R1-A·r3 R2-D). 순환 간선을 따라 다른 루트를 끌어올리지 않는다.
  const children = lineageGraph(input.repos).childrenOf
  const visible = new Set(
    input.visible.flatMap((repo) => repo.worktrees.filter((worktree) => passesWorktreeFilters({ view: input.view, worktree })).map((worktree) => worktree.path)),
  )
  const included = new Set<string>()
  const seen = new Set<string>()
  const pending = [...input.pinned].filter((path) => visible.has(path))
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    if (visible.has(path)) included.add(path)
    pending.push(...(children.get(path) ?? []))
  }
  return included
}

function groupedSections(input: {
  repos: readonly RepoRow[]
  view: SidebarView
  order: ManualOrder
  now: number
  nameOf: ReadonlyMap<string, string>
  keep: (item: SortItem) => boolean
}): SidebarSection[] {
  const { repos, view, order, now, nameOf, keep } = input
  switch (view.groupBy) {
    case 'none': {
      const manualItems = orderAll({ repos, order })
        .map(({ repoRoot, worktree }) => ({ repoRoot, repoName: nameOf.get(repoRoot) ?? '', worktree }))
        .filter(keep)
      return [{ kind: 'all', items: sortItems({ sortBy: view.sortBy, now, manualItems }) }]
    }
    case 'repo': {
      const switchFilterOn = view.hideDefaultBranch || view.hideDetachedHead
      const ordered = orderRepos({ repos, stored: order.repos })
        .map((repo) => {
          const manualItems = orderWorktrees({ worktrees: repo.worktrees, stored: order.worktrees[repo.root] })
            .map((worktree) => ({ repoRoot: repo.root, repoName: repo.name, worktree }))
            .filter(keep)
          return { repo, items: sortItems({ sortBy: view.sortBy, now, manualItems }) }
        })
        .filter((section) => !switchFilterOn || section.items.length > 0)
      return orderRepoSections({ ordered, projectOrderBy: view.projectOrderBy }).map((section) => ({ kind: 'repo', ...section }))
    }
  }
}

// --- 계보 중첩 (LIFE-576) -------------------------------------------------------------------------------
//
// Orca main `row-builders.ts` `appendWorktreeRows`(nestLineage) + `renderable-rows.ts` `buildRenderableRows` 대응 — 구획 하나의
// 카드(정렬 끝난 평면 목록)를 부모 아래 후손이 붙은 덩어리(unit)로 묶는다. 구획 빌드·지연(`useSettledSections`)은 평면 그대로 두고
// 그리기 직전에만 묶는다 — 순서·서명·필터 규칙은 하나도 안 바뀐다.
//   · 부모가 **같은 구획에 보이고 같은 레포**일 때만 중첩(D1, Orca `getSidebarLineageParent` 가 보이는 행에서만 부모를 찾는다).
//     다른 레포 부모는 Orca 유효 간선이 아니다(`shared/resolved-worktree-lineage.ts:14-25` `sharesWorktreeLineageBoundary` — repoId 동일,
//     수정 r2 R1-A) — 어느 보기에서든 평소 자리 + 메타 줄 `↳ 부모` 칩. 고정 끌어올림·순환·순서 줄 부모 해제도 같은 간선만 본다.
//   · 순환 구성원은 부모를 무시하고 루트로 그린다(Orca `cyclicLineageIds` — 「malformed cyclic lineage should not hide every participant」).
//     순환은 표시 구획이 아니라 전체 그래프에서 판정한다(`lineageGraph`, 수정 r3 R2-D).
//   · 깊이 상한 없음(O7). 자식 순서 = 구획 안 순서. 「N 하위」 N = **직계 자식 수**(Orca `lineageChildCount = children.length`).
//   · 접힌 부모(`collapsed` = 부모 경로)의 후손은 덩어리에서 빠진다(Orca `lineageCollapsed` → 자식 행을 내보내지 않음).

export type LineageRow = { item: SortItem; depth: number; childCount: number; collapsed: boolean }
/** 덩어리 하나 — 루트 카드 + 펼친 후손(문서 순서, 깊이 ≥ 1). 끌기·그리기 단위(Orca `lineage-group` 행·drag unit). */
export type LineageUnit = { root: LineageRow; descendants: LineageRow[] }

/**
 * 전체 계보 그래프의 유효 간선 (수정 r3 R2-D — Orca main `worktree-lineage-projection.ts` `getProjectedWorktreeLineageChildrenByParentId`·
 * `getCyclicProjectedWorktreeLineageIds`) — **표시 구획이 아니라 전체 레포 목록**에서 한 번 구한다. 필터·고정 수집·중첩·순서 줄 부모 해제·
 * 조상 펼침이 이 한 그래프를 공유한다 — 필터로 순환 일부를 숨겨도 남은 구성원은 여전히 순환이다.
 *   · 간선 = **같은 레포** 부모 링크(Orca `sharesWorktreeLineageBoundary`, 수정 r2 R1-A). 자기 자신·없는 부모·다른 레포 부모는 간선 없음.
 *   · 순환 구성원(`cyclic`)의 부모 간선은 버린다 — 구성원은 루트로 그리고, 고정 수집도 그 간선을 따르지 않는다. 순환 구성원을
 *     **부모로 가리키는** 순환 밖 카드의 간선은 유효하다(Orca `children={a:[c]}`).
 */
export type LineageGraph = { parentOf: ReadonlyMap<string, string>; childrenOf: ReadonlyMap<string, readonly string[]>; cyclic: ReadonlySet<string> }

export function lineageGraph(repos: readonly RepoRow[]): LineageGraph {
  const linked = new Map<string, string>()
  for (const repo of repos) {
    const inRepo = new Set(repo.worktrees.map((worktree) => worktree.path))
    for (const worktree of repo.worktrees)
      if (worktree.parentPath !== null && worktree.parentPath !== worktree.path && inRepo.has(worktree.parentPath)) linked.set(worktree.path, worktree.parentPath)
  }
  const cyclic = new Set<string>()
  const settled = new Set<string>()
  for (const start of linked.keys()) {
    const trail: string[] = []
    let cursor: string | undefined = start
    while (cursor !== undefined && !settled.has(cursor)) {
      const at = trail.indexOf(cursor)
      if (at >= 0) {
        for (const path of trail.slice(at)) cyclic.add(path)
        break
      }
      trail.push(cursor)
      cursor = linked.get(cursor)
    }
    for (const path of trail) settled.add(path)
  }
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  for (const [path, parentPath] of linked) {
    if (cyclic.has(path)) continue
    parentOf.set(path, parentPath)
    childrenOf.set(parentPath, [...(childrenOf.get(parentPath) ?? []), path])
  }
  return { parentOf, childrenOf, cyclic }
}

/**
 * 순서 줄에 놓았을 때 부모를 풀 카드인가 (수정 r1 M2 — Orca `getLineageRenderInfo(...).state === 'valid'`) — 전체 그래프에 유효 부모 간선이
 * 있다(부모가 같은 레포 목록에 있고 — 화면에 보이든 아니든 — 순환 구성원이 아니다). 부모 없는 카드·없는 부모를 가리키는 카드는 거짓.
 */
export function hasValidLineage(input: { repos: readonly RepoRow[]; path: string }): boolean {
  return lineageGraph(input.repos).parentOf.has(input.path)
}

/**
 * 그 카드를 가리는 접힌 조상 (K2ⓓ · Orca #25950, 수정 r2 R1-C) — 유효 간선을 따라 올라가며 `collapsed` 에 든 조상 경로.
 * 순환 구성원은 부모 간선이 없어(루트로 그린다) 사슬이 순환일 수 없다. 호출부가 이 경로들을 펼친다.
 */
export function collapsedAncestors(input: { graph: LineageGraph; path: string; collapsed: ReadonlySet<string> }): string[] {
  return lineageAncestors({ graph: input.graph, path: input.path }).filter((path) => input.collapsed.has(path))
}

/** 유효 간선으로 본 조상 경로(가까운 것부터). R2-B — 이 경로가 바뀌면 활성 카드의 접힌 새 조상을 펼친다. */
export function lineageAncestors(input: { graph: LineageGraph; path: string }): string[] {
  const out: string[] = []
  let cursor = input.graph.parentOf.get(input.path)
  while (cursor !== undefined && cursor !== input.path && !out.includes(cursor)) {
    out.push(cursor)
    cursor = input.graph.parentOf.get(cursor)
  }
  return out
}

export function nestSectionItems(input: { items: readonly SortItem[]; collapsed: ReadonlySet<string>; graph: LineageGraph }): LineageUnit[] {
  const { items, collapsed, graph } = input
  const byPath = new Map(items.map((item) => [item.worktree.path, item]))
  const children = new Map<string, SortItem[]>()
  const nested = new Set<string>()
  for (const item of items) {
    // 부모가 **같은 구획에 보일 때만** 중첩(D1) — 간선 유효성(같은 레포·순환 아님)은 전체 그래프가 정한다(R2-D).
    const parentPath = graph.parentOf.get(item.worktree.path)
    const parent = parentPath === undefined ? undefined : byPath.get(parentPath)
    if (parent === undefined) continue
    nested.add(item.worktree.path)
    children.set(parent.worktree.path, [...(children.get(parent.worktree.path) ?? []), item])
  }
  const emitted = new Set<string>()
  const rowOf = (item: SortItem, depth: number): LineageRow => {
    const childCount = children.get(item.worktree.path)?.length ?? 0
    return { item, depth, childCount, collapsed: childCount > 0 && collapsed.has(item.worktree.path) }
  }
  const units: LineageUnit[] = []
  for (const rootItem of items) {
    if (nested.has(rootItem.worktree.path) || emitted.has(rootItem.worktree.path)) continue
    emitted.add(rootItem.worktree.path)
    const root = rowOf(rootItem, 0)
    const descendants: LineageRow[] = []
    // 깊이 우선 — 스택이라 재귀 깊이 제한이 없다(Orca `emitPending`).
    const pending: { item: SortItem; depth: number }[] = root.collapsed ? [] : [...(children.get(rootItem.worktree.path) ?? [])].reverse().map((item) => ({ item, depth: 1 }))
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined || emitted.has(next.item.worktree.path)) continue
      emitted.add(next.item.worktree.path)
      const row = rowOf(next.item, next.depth)
      descendants.push(row)
      if (row.collapsed) continue
      for (const child of [...(children.get(next.item.worktree.path) ?? [])].reverse()) pending.push({ item: child, depth: next.depth + 1 })
    }
    units.push({ root, descendants })
  }
  return units
}

/** Orca `SIDEBAR_TREE_INDENT`(`indentation.ts`) — 계보 한 단계 들여쓰기. */
export const LINEAGE_INDENT_PX = 18
/**
 * 좁은 사이드바에서 깊은 단계 카드가 지켜야 할 최소 폭(px). Orca 는 깊이를 자르지 않는다(O7) — corral 도 깊이는 안 자르고,
 * 들여쓰기만 「부모 덩어리 폭 − 이 값」 에서 멈춰 카드가 사라지거나 옆으로 넘치지 않게 한다.
 */
export const LINEAGE_CARD_MIN_WIDTH_PX = 120

/** 후손 카드 행의 왼쪽 들여쓰기(CSS 값) — 깊이 × 18px, 단 부모 덩어리 폭에서 최소 폭을 뺀 값을 넘지 않는다. */
export function lineageIndent(depth: number): string {
  const steps = Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0))
  return `max(0px, min(${steps * LINEAGE_INDENT_PX}px, calc(100% - ${LINEAGE_CARD_MIN_WIDTH_PX}px)))`
}

/** 보이는 카드 수 — 빈 상태(필터로 비었나) 판정용. */
export function visibleCardCount(sections: readonly SidebarSection[]): number {
  return sections.reduce((sum, section) => sum + section.items.length, 0)
}

// --- 재정렬 지연 (U3) ----------------------------------------------------------------------------------

/** 198 `SORT_SETTLE_MS`(`use-sort-order.ts:24`) — 상태 변화로 카드가 움직이기 전 기다리는 시간. */
export const SORT_SETTLE_MS = 3000

/**
 * 지금 그린 배치(`shown`)를 새 계산(`next`)으로 언제 바꿀지 — `now`(바로) / `settle`(3초 뒤) / `same`.
 *
 * 198 은 smart 모드 재정렬만 3초 미룬다(워크트리 추가·삭제·manual 은 바로, `use-sort-order.ts:57-79`). corral 은 Recent 도
 * 활동 시각으로 움직이는 모드라 같이 미룬다(Recent·Agent Activity·Project order Recent). 미루지 않으면 에이전트 상태 하나 바뀔
 * 때마다 카드가 눈앞에서 튄다. **구성(어떤 구획에 어떤 카드)이 바뀌거나 옵션·수동 순서를 바꾸면 바로** — 사용자가 한 조작은 바로
 * 보인다(198 `use-sort-order.ts:66` — 수동 조작은 즉시. R1-04: Project order Recent 에서 카드를 끌어 놓은 것도 수동 조작이다).
 * 화면 순서가 같아도 옵션·구성·수동 순서가 바뀌었으면 `now` — 그려 둔 배치의 메타를 지금 값으로 맞춰야 다음 활동 변화를 옛 옵션과
 * 비교해 「사용자 조작」 으로 오인하지 않는다(R1-05).
 */
export function settleDecision(input: { shown: LayoutSignature; next: LayoutSignature; activityDriven: boolean }): 'now' | 'settle' | 'same' {
  const { shown, next } = input
  const metaChanged = shown.membership !== next.membership || shown.options !== next.options || shown.manual !== next.manual
  if (shown.order === next.order) return metaChanged ? 'now' : 'same'
  if (metaChanged || !input.activityDriven) return 'now'
  return 'settle'
}

/**
 * 배치 비교용 — `order` 는 순서까지, `membership` 은 구획별 집합만, `manual` 은 수동 순서 데이터(사용자 끌기·정규화가 바꾼다 — 활동은
 * 못 바꾼다), `layout` 은 지연 중 다시 채울 자리.
 */
export type LayoutSignature = { order: string; membership: string; options: string; manual: string; layout: { key: string; paths: string[] }[] }

export function sectionKey(section: SidebarSection): string {
  switch (section.kind) {
    case 'repo':
      return section.repo.root
    case 'all':
      return '*all'
    case 'pinned':
      return PINNED_SECTION_KEY
  }
}

/** Pinned 구획 키 — 접힘 상태도 이 키로 `collapsedRepos` 에 싣는다(경로가 아니라 겹치지 않는다). */
export const PINNED_SECTION_KEY = '*pinned'

export function layoutSignature(input: { sections: readonly SidebarSection[]; view: SidebarView; order: ManualOrder }): LayoutSignature {
  const layout = input.sections.map((section) => ({ key: sectionKey(section), paths: section.items.map((item) => item.worktree.path) }))
  const membership = layout.map((entry) => ({ key: entry.key, paths: [...entry.paths].sort() })).sort((a, b) => a.key.localeCompare(b.key))
  return { order: JSON.stringify(layout), membership: JSON.stringify(membership), options: JSON.stringify(arrangementOptions(input.view)), manual: JSON.stringify(input.order), layout }
}

/**
 * 배치를 정하는 옵션만 (LIFE-477 F11·U6) — 카드 표시 칸(레이아웃·속성·에이전트 레이아웃)은 구획·순서를 바꾸지 않으므로 서명에서 뺀다.
 * 넣으면 표시만 바꿔도 `settleDecision` 이 메타 변경으로 보고 대기 중인 활동 재정렬을 즉시 풀어 버린다.
 */
function arrangementOptions(view: SidebarView): Omit<SidebarView, 'cardLayout' | 'cardProperties' | 'agentActivityLayout'> {
  return {
    groupBy: view.groupBy,
    sortBy: view.sortBy,
    projectOrderBy: view.projectOrderBy,
    repoFilter: view.repoFilter,
    hideDefaultBranch: view.hideDefaultBranch,
    hideDetachedHead: view.hideDetachedHead,
  }
}

/** 지금 옵션이 활동 시각으로 순서가 움직이는가 — 지연을 거는 모드. */
export function isActivityDriven(view: SidebarView): boolean {
  return view.sortBy === 'smart' || view.sortBy === 'recent' || (view.groupBy === 'repo' && view.projectOrderBy === 'recent')
}

/**
 * 지연 중인 배치(`layout`)를 지금 데이터로 다시 채운다 — 카드 내용은 최신이고 **자리만** 그대로다. 구성이 어긋나면(호출부가
 * 막지만 방어로) 지금 계산을 그대로 돌려준다.
 */
export function applyShownLayout(input: { layout: readonly { key: string; paths: readonly string[] }[]; sections: readonly SidebarSection[] }): SidebarSection[] {
  const byKey = new Map(input.sections.map((section) => [sectionKey(section), section]))
  const out: SidebarSection[] = []
  for (const entry of input.layout) {
    const section = byKey.get(entry.key)
    if (section === undefined) return [...input.sections]
    const byPath = new Map(section.items.map((item) => [item.worktree.path, item]))
    const items: SortItem[] = []
    for (const path of entry.paths) {
      const item = byPath.get(path)
      if (item === undefined) return [...input.sections]
      items.push(item)
    }
    if (items.length !== section.items.length) return [...input.sections]
    out.push({ ...section, items })
  }
  return out.length === input.sections.length ? out : [...input.sections]
}
