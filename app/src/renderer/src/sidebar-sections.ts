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
  const pinned = input.pinned ?? NO_PINS
  const repos = visibleRepos({ view, repos: input.repos })
  const nameOf = new Map(repos.map((repo) => [repo.root, repo.name]))
  const passes = (item: SortItem): boolean => passesWorktreeFilters({ view, worktree: item.worktree })
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
