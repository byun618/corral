// 사이드바 Workspace options 값 (LIFE-470 · 448 S4-A) — 모양과 읽기 규칙. main(`ui-prefs.ts`)과 렌더러가 같이 쓴다.
//
// 198 대응(`shared/constants.ts:254-284`): groupBy · sortBy · projectOrderBy · filterRepoIds · hideDefaultBranchWorkspace ·
// hideDetachedHeadWorkspaces. 198 은 UI state 에 두고 corral 은 `ui-prefs.json` 칸에 둔다(00-analysis U5).
//
// 의도적 차이:
//   · 기본 Sort by = `manual`(198 `recent`) — 게이트 ⓪ Q2. 469 로 사용자가 정한 순서가 업그레이드 뒤 그대로 보인다.
//   · Group by 는 `none`·`repo` 둘뿐(198 은 Status·PR 포함 4) — D29e(Status = Kanban 워크플로, PR = 이슈·PR 연동 경계).
//   · 필터는 Hide default branch · Hide detached HEAD 둘(D29j — Sleep·자동화·CLI 출처·원격 클라이언트 개념 없음).

export const SIDEBAR_GROUP_BY = ['none', 'repo'] as const
export type SidebarGroupBy = (typeof SIDEBAR_GROUP_BY)[number]

export const SIDEBAR_SORT_BY = ['name', 'smart', 'recent', 'repo', 'manual'] as const
export type SidebarSortBy = (typeof SIDEBAR_SORT_BY)[number]

export const SIDEBAR_PROJECT_ORDER = ['manual', 'recent'] as const
export type SidebarProjectOrder = (typeof SIDEBAR_PROJECT_ORDER)[number]

// 카드 표시 (LIFE-477 · 448 S4-B) — 198 기본(classic) 경로 `WorktreeCardDisplayMenuSection.tsx:95-198`.
//   · Card layout: `compactWorktreeCards`(global settings) → `cardLayout`
//   · Show properties: `worktreeCardProperties`(UI state) → `cardProperties`. corral 에 대응 있는 속성은 `inline-agents`(에이전트 활동)
//     하나뿐이다(게이트 ⓪ Q1 — GitHub ticket·Linear·Jira·PR/MR·Automation·Notes·Ports 는 D25 사유로 없음, 브랜치 토글은 198 기본 경로에 없다).
//     198 의 고정 속성 `status`·`unread` 는 끌 수 없어 칸에 두지 않는다 — 상태 점은 늘 그린다.
//   · Agent activity layout: `agentActivityDisplayMode`(UI state) → `agentActivityLayout`
export const SIDEBAR_CARD_LAYOUT = ['detailed', 'compact'] as const
export type SidebarCardLayout = (typeof SIDEBAR_CARD_LAYOUT)[number]

/** 정규 순서(198 `WORKTREE_CARD_PROPERTIES` 중 corral 이 가진 것). */
export const SIDEBAR_CARD_PROPERTIES = ['inline-agents'] as const
export type SidebarCardProperty = (typeof SIDEBAR_CARD_PROPERTIES)[number]

export const SIDEBAR_AGENT_ACTIVITY_LAYOUT = ['compact', 'full'] as const
export type SidebarAgentActivityLayout = (typeof SIDEBAR_AGENT_ACTIVITY_LAYOUT)[number]

/** 198 `DEFAULT_WORKTREE_CARD_PROPERTIES` 중 corral 이 가진 것 — 에이전트 활동 켬. */
export const DEFAULT_SIDEBAR_CARD_PROPERTIES: readonly SidebarCardProperty[] = ['inline-agents']
/** 198 `COMPACT_WORKTREE_CARD_PROPERTIES` = `['status']` — 고정 속성만, 에이전트 활동 꺼짐. */
export const COMPACT_SIDEBAR_CARD_PROPERTIES: readonly SidebarCardProperty[] = []

export type SidebarView = {
  groupBy: SidebarGroupBy
  sortBy: SidebarSortBy
  projectOrderBy: SidebarProjectOrder
  /** Show › Projects — 고른 레포 root. 비면 전체(198 `filterRepoIds`). */
  repoFilter: string[]
  /** Filters › Hide default branch — 주 체크아웃(브랜치 있음)을 숨긴다(198 `isDefaultBranchWorkspace`). */
  hideDefaultBranch: boolean
  /** Filters › Hide detached HEAD — 브랜치 없는 워크트리를 숨긴다(198 `isDetachedHeadWorkspace`). */
  hideDetachedHead: boolean
  /** Card layout — Detailed(기본) / Compact(198 `compactWorktreeCards`). */
  cardLayout: SidebarCardLayout
  /** Show properties — 켠 속성(정규 순서, 중복 없음). */
  cardProperties: SidebarCardProperty[]
  /** Show properties › Agent activity layout — Compact(묶음 알약·한 줄 행, 467) / Full list(루트마다 3줄 행). */
  agentActivityLayout: SidebarAgentActivityLayout
}

export const DEFAULT_SIDEBAR_VIEW: SidebarView = {
  groupBy: 'repo',
  sortBy: 'manual',
  projectOrderBy: 'manual',
  repoFilter: [],
  hideDefaultBranch: false,
  hideDetachedHead: false,
  cardLayout: 'detailed',
  cardProperties: [...DEFAULT_SIDEBAR_CARD_PROPERTIES],
  agentActivityLayout: 'compact',
}

function pick<T extends string>(input: { value: unknown; allowed: readonly T[]; fallback: T }): T {
  return input.allowed.find((item) => item === input.value) ?? input.fallback
}

function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
}

/**
 * 속성 목록 정규화 — 198 `normalizeWorktreeCardProperties`(`shared/worktree/card-properties.ts:61-72`) 그대로:
 * 모르는 id 는 버리고, 중복을 없애고, 정규 순서로. 배열이 아니면(없음·타입 틀림) 기본값, 빈 배열은 빈 배열(= 고정 속성만 — 198 `[]` → `['status','unread']`).
 */
export function normalizeCardProperties(value: unknown): SidebarCardProperty[] {
  if (!Array.isArray(value)) return [...DEFAULT_SIDEBAR_CARD_PROPERTIES]
  return SIDEBAR_CARD_PROPERTIES.filter((property) => value.includes(property))
}

/**
 * 레이아웃 전환의 부수효과 — 198 `getWorktreeCardModeUpdates`(`card-properties.ts:74-91`): 레이아웃은 **프리셋**이라 속성이 통째로 바뀐다
 * (게이트 ⓪ Q2). Compact → 에이전트 활동 끔, Detailed → 켬. 같은 레이아웃을 다시 골라도 다시 적용된다(198 Radix `MenuRadioItem` 은
 * 이미 고른 값에도 `onValueChange` 를 부른다 — `checkForDefaultPrevented: false`). Agent activity layout 은 안 바뀐다.
 */
export function cardLayoutPreset(layout: SidebarCardLayout): Pick<SidebarView, 'cardLayout' | 'cardProperties'> {
  return {
    cardLayout: layout,
    cardProperties: [...(layout === 'compact' ? COMPACT_SIDEBAR_CARD_PROPERTIES : DEFAULT_SIDEBAR_CARD_PROPERTIES)],
  }
}

/**
 * 에이전트 목록을 카드에 그리나 — 198 `showInlineAgentList = cardProps.includes('inline-agents') && (newCardStyle || !compactCards)`
 * (`use-worktree-card-secondary-details.ts:91`). **Compact 카드는 켜져 있어도 그리지 않는다.** 상태 점은 이 값과 무관하다.
 */
export function showsInlineAgents(view: Pick<SidebarView, 'cardLayout' | 'cardProperties'>): boolean {
  return view.cardProperties.includes('inline-agents') && view.cardLayout !== 'compact'
}

/**
 * 저장된 칸을 하나씩 읽는다 — 칸마다 따로 기본값으로 떨어진다(K9ⓓ: 타입 틀림·모르는 모드 문자열이 다른 칸을 깨뜨리지 않는다).
 * 470 이전 파일(칸 없음)은 전부 기본값 = 지금 화면 그대로(K9ⓑ). 477 이전 파일(카드 표시 칸 없음)도 같다(477 K7ⓑ).
 */
export function readSidebarView(record: Record<string, unknown>): SidebarView {
  return {
    groupBy: pick({ value: record['sidebarGroupBy'], allowed: SIDEBAR_GROUP_BY, fallback: DEFAULT_SIDEBAR_VIEW.groupBy }),
    sortBy: pick({ value: record['sidebarSortBy'], allowed: SIDEBAR_SORT_BY, fallback: DEFAULT_SIDEBAR_VIEW.sortBy }),
    projectOrderBy: pick({ value: record['sidebarProjectOrderBy'], allowed: SIDEBAR_PROJECT_ORDER, fallback: DEFAULT_SIDEBAR_VIEW.projectOrderBy }),
    repoFilter: keyList(record['sidebarRepoFilter']),
    hideDefaultBranch: record['sidebarHideDefaultBranch'] === true,
    hideDetachedHead: record['sidebarHideDetachedHead'] === true,
    cardLayout: pick({ value: record['sidebarCardLayout'], allowed: SIDEBAR_CARD_LAYOUT, fallback: DEFAULT_SIDEBAR_VIEW.cardLayout }),
    cardProperties: normalizeCardProperties(record['sidebarCardProperties']),
    agentActivityLayout: pick({
      value: record['sidebarAgentActivityLayout'],
      allowed: SIDEBAR_AGENT_ACTIVITY_LAYOUT,
      fallback: DEFAULT_SIDEBAR_VIEW.agentActivityLayout,
    }),
  }
}

/** `ui-prefs.json` 칸 이름 — 저장은 평평하게(부분 갱신 IPC 가 칸 단위라서). */
export type SidebarViewPrefs = {
  sidebarGroupBy: SidebarGroupBy
  sidebarSortBy: SidebarSortBy
  sidebarProjectOrderBy: SidebarProjectOrder
  sidebarRepoFilter: string[]
  sidebarHideDefaultBranch: boolean
  sidebarHideDetachedHead: boolean
  sidebarCardLayout: SidebarCardLayout
  sidebarCardProperties: SidebarCardProperty[]
  sidebarAgentActivityLayout: SidebarAgentActivityLayout
}

export function sidebarViewToPrefs(view: SidebarView): SidebarViewPrefs {
  return {
    sidebarGroupBy: view.groupBy,
    sidebarSortBy: view.sortBy,
    sidebarProjectOrderBy: view.projectOrderBy,
    sidebarRepoFilter: [...view.repoFilter],
    sidebarHideDefaultBranch: view.hideDefaultBranch,
    sidebarHideDetachedHead: view.hideDetachedHead,
    sidebarCardLayout: view.cardLayout,
    sidebarCardProperties: [...view.cardProperties],
    sidebarAgentActivityLayout: view.agentActivityLayout,
  }
}
