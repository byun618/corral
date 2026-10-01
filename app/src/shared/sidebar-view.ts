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
}

export const DEFAULT_SIDEBAR_VIEW: SidebarView = {
  groupBy: 'repo',
  sortBy: 'manual',
  projectOrderBy: 'manual',
  repoFilter: [],
  hideDefaultBranch: false,
  hideDetachedHead: false,
}

function pick<T extends string>(input: { value: unknown; allowed: readonly T[]; fallback: T }): T {
  return input.allowed.find((item) => item === input.value) ?? input.fallback
}

function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
}

/**
 * 저장된 칸을 하나씩 읽는다 — 칸마다 따로 기본값으로 떨어진다(K9ⓓ: 타입 틀림·모르는 모드 문자열이 다른 칸을 깨뜨리지 않는다).
 * 470 이전 파일(칸 없음)은 전부 기본값 = 지금 화면 그대로(K9ⓑ).
 */
export function readSidebarView(record: Record<string, unknown>): SidebarView {
  return {
    groupBy: pick({ value: record['sidebarGroupBy'], allowed: SIDEBAR_GROUP_BY, fallback: DEFAULT_SIDEBAR_VIEW.groupBy }),
    sortBy: pick({ value: record['sidebarSortBy'], allowed: SIDEBAR_SORT_BY, fallback: DEFAULT_SIDEBAR_VIEW.sortBy }),
    projectOrderBy: pick({ value: record['sidebarProjectOrderBy'], allowed: SIDEBAR_PROJECT_ORDER, fallback: DEFAULT_SIDEBAR_VIEW.projectOrderBy }),
    repoFilter: keyList(record['sidebarRepoFilter']),
    hideDefaultBranch: record['sidebarHideDefaultBranch'] === true,
    hideDetachedHead: record['sidebarHideDetachedHead'] === true,
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
}

export function sidebarViewToPrefs(view: SidebarView): SidebarViewPrefs {
  return {
    sidebarGroupBy: view.groupBy,
    sidebarSortBy: view.sortBy,
    sidebarProjectOrderBy: view.projectOrderBy,
    sidebarRepoFilter: [...view.repoFilter],
    sidebarHideDefaultBranch: view.hideDefaultBranch,
    sidebarHideDetachedHead: view.hideDetachedHead,
  }
}
