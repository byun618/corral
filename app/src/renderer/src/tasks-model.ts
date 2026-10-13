// 작업 페이지 순수 로직 (LIFE-601) — 화면 컴포넌트·훅이 DOM 없이 부르는 계산만 둔다(tab-drag.ts·sidebar-reorder.ts 와 같은 결).
//
// - 출처 이름으로 분기하지 않는다(K3) — 출처 차이는 능력 표·상태 목록·descriptor 의 `keyPattern` 으로만 드러난다.
// - 영속 모양(`readTasksPrefs`)은 여기 한 곳이 안다 — main `ui-prefs.ts` 는 `tasksPage` 칸을 실어 나르기만 한다(`tabMarks` 선례).
// - 늦은 응답 폐기(C7): 요청마다 id 를 매기고, 같은 열쇠(목록 하나·작업 하나)에 대해 **마지막으로 보낸 id 의 응답만** 받는다(`LatestGate`).

import type {
  WorkCapabilities,
  WorkCapability,
  WorkCategory,
  WorkConnectionSummary,
  WorkItem,
  WorkPriority,
  WorkSettingsState,
  WorkStatus,
} from '../../shared/work.js'
import { WORK_PRIORITIES } from '../../shared/work.js'
import { isRecord } from '../../shared/json.js'
import type { AgentDot } from './agent-dot.js'

// --- 상태 모양 ---

export const TASKS_VIEWS = ['board', 'backlog', 'list', 'working'] as const
export type TasksView = (typeof TASKS_VIEWS)[number]
export const TASKS_VIEW_LABEL: Record<TasksView, string> = { board: '보드', backlog: '백로그', list: '리스트', working: '작업 중' }

export type TasksDensity = 'detailed' | 'compact'
export const TASKS_SORTS = ['rank', 'priority', 'due', 'key'] as const
export type TasksSort = (typeof TASKS_SORTS)[number]
export const TASKS_SORT_LABEL: Record<TasksSort, string> = { rank: '순서', priority: '우선순위', due: '마감', key: '키' }
export const TASKS_GROUPS = ['status', 'priority', 'none'] as const
export type TasksGroup = (typeof TASKS_GROUPS)[number]
export const TASKS_PRESETS = ['all', 'working', 'blocked', 'week'] as const
export type TasksPreset = (typeof TASKS_PRESETS)[number]
export const TASKS_PRESET_LABEL: Record<TasksPreset, string> = { all: '전체', working: '작업 중', blocked: '막힘', week: '이번 주 마감' }

/** 스페이스 선택 — 「전체」 또는 연결 하나의 스페이스 하나. */
export type TasksSpace = { kind: 'all' } | { kind: 'space'; connectionId: string; spaceKey: string }

export type TasksFilters = {
  kinds: string[]
  priorities: WorkPriority[]
  blocked: boolean
  working: boolean
  /** 프리셋 「이번 주 마감」 — 칩이 아니라 프리셋이 켠다. 「필터 지우기」 가 같이 끈다. */
  dueWeek: boolean
}

export const NO_FILTERS: TasksFilters = { kinds: [], priorities: [], blocked: false, working: false, dueWeek: false }

/** 앱 재시작 뒤에도 남는 것(C3) — 검색어·스크롤은 같은 실행 안에서만(페이지가 마운트를 유지한다). */
export type TasksPrefs = {
  space: TasksSpace | null
  view: TasksView
  filters: TasksFilters
  sort: TasksSort
  group: TasksGroup
  density: TasksDensity
  defaultPreset: TasksPreset
}

export const DEFAULT_TASKS_PREFS: TasksPrefs = { space: null, view: 'board', filters: NO_FILTERS, sort: 'rank', group: 'status', density: 'detailed', defaultPreset: 'all' }

function pick<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return list.find((entry) => entry === value) ?? fallback
}

function readSpace(value: unknown): TasksSpace | null {
  if (!isRecord(value)) return null
  if (value.kind === 'all') return { kind: 'all' }
  if (value.kind === 'space' && typeof value.connectionId === 'string' && value.connectionId.length > 0 && typeof value.spaceKey === 'string' && value.spaceKey.length > 0) {
    return { kind: 'space', connectionId: value.connectionId, spaceKey: value.spaceKey }
  }
  return null
}

function readFilters(value: unknown): TasksFilters {
  if (!isRecord(value)) return NO_FILTERS
  const kinds = Array.isArray(value.kinds) ? [...new Set(value.kinds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))] : []
  const priorities = Array.isArray(value.priorities) ? WORK_PRIORITIES.filter((entry) => Array.isArray(value.priorities) && value.priorities.includes(entry)) : []
  return { kinds, priorities, blocked: value.blocked === true, working: value.working === true, dueWeek: value.dueWeek === true }
}

/** 저장된 칸을 모양을 확인하며 읽는다 — 칸마다 따로 기본값으로 떨어진다(손상된 칸 하나가 다른 칸을 버리지 않게, LIFE-470 K9ⓓ 선례). */
export function readTasksPrefs(value: unknown): TasksPrefs {
  if (!isRecord(value)) return DEFAULT_TASKS_PREFS
  return {
    space: readSpace(value.space),
    view: pick(TASKS_VIEWS, value.view, DEFAULT_TASKS_PREFS.view),
    filters: readFilters(value.filters),
    sort: pick(TASKS_SORTS, value.sort, DEFAULT_TASKS_PREFS.sort),
    group: pick(TASKS_GROUPS, value.group, DEFAULT_TASKS_PREFS.group),
    density: value.density === 'compact' ? 'compact' : 'detailed',
    defaultPreset: pick(TASKS_PRESETS, value.defaultPreset, DEFAULT_TASKS_PREFS.defaultPreset),
  }
}

export function sameSpace(a: TasksSpace | null, b: TasksSpace | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'all' || b.kind === 'all') return a.kind === b.kind
  return a.connectionId === b.connectionId && a.spaceKey === b.spaceKey
}

export function spaceId(space: TasksSpace): string {
  return space.kind === 'all' ? 'all' : `${space.connectionId}::${space.spaceKey}`
}

// --- 스페이스 목록 (C2) ---

export type SpaceRow = { connectionId: string; key: string; name: string; color: string | null; openCount: number | null; repoDefault: boolean; colorIndex: number }
export type SpaceGroup = { connectionId: string; name: string; sub: string; status: WorkConnectionSummary['status']; rows: SpaceRow[] }

/**
 * 연결별 묶음. 같은 출처 연결이 둘 이상이면 머리 sub 에 토큰 끝 4자를 붙여 가른다(D3 · T1 잔여 결함).
 * 숨긴 스페이스는 빠진다. 색이 없으면 `--space-N` 을 전체 순서대로(1–7 순환).
 */
export function spaceGroups({ settings, repoRoot }: { settings: WorkSettingsState; repoRoot: string | null }): SpaceGroup[] {
  const bySource = new Map<string, number>()
  for (const connection of settings.connections) bySource.set(connection.sourceId, (bySource.get(connection.sourceId) ?? 0) + 1)
  let colorIndex = 0
  return settings.connections.map((connection) => {
    const twins = (bySource.get(connection.sourceId) ?? 0) > 1
    const hidden = new Set(connection.hiddenSpaceKeys)
    const rows = (connection.spaces ?? [])
      .filter((space) => !hidden.has(space.key) && !space.hidden)
      .map((space): SpaceRow => ({
        connectionId: connection.id,
        key: space.key,
        name: space.name,
        color: space.color,
        openCount: space.openCount,
        repoDefault: repoRoot !== null && settings.repoDefaults.some((row) => row.repoRoot === repoRoot && row.connectionId === connection.id && row.spaceKey === space.key),
        colorIndex: (colorIndex++ % 7) + 1,
      }))
    return { connectionId: connection.id, name: connection.name, sub: twins ? `토큰 …${connection.tokenTail}` : connection.mono, status: connection.status, rows }
  })
}

/**
 * 첫 진입 스페이스(C2) — 활성 worktree 레포의 기본 스페이스(보이는 것일 때), 없으면 마지막으로 본 스페이스(아직 보이면), 없으면 첫 스페이스.
 * 스페이스 목록을 아직 못 받았으면(연결은 있는데 spaces null) 마지막으로 본 것을 그대로 쓴다 — 받기 전에 지우지 않는다.
 */
export function initialSpace({ groups, settings, repoRoot, last }: { groups: SpaceGroup[]; settings: WorkSettingsState; repoRoot: string | null; last: TasksSpace | null }): TasksSpace | null {
  const visible = (space: TasksSpace): boolean =>
    space.kind === 'all' || groups.some((group) => group.connectionId === space.connectionId && group.rows.some((row) => row.key === space.spaceKey))
  const pending = (space: TasksSpace): boolean =>
    space.kind === 'space' && settings.connections.some((connection) => connection.id === space.connectionId && connection.spaces === null)
  if (repoRoot !== null) {
    const preferred = settings.repoDefaults.find((row) => row.repoRoot === repoRoot)
    if (preferred !== undefined) {
      const space: TasksSpace = { kind: 'space', connectionId: preferred.connectionId, spaceKey: preferred.spaceKey }
      if (visible(space)) return space
    }
  }
  if (last !== null && (visible(last) || pending(last))) return last
  const first = groups.find((group) => group.rows.length > 0)?.rows[0]
  return first === undefined ? (settings.connections.length > 0 ? { kind: 'all' } : null) : { kind: 'space', connectionId: first.connectionId, spaceKey: first.key }
}

// --- 불러온 자료 ---

/** 스페이스 하나 분량 — 「전체」 는 이것 여러 개. */
export type SpaceData = {
  connectionId: string
  spaceKey: string
  spaceName: string
  colorIndex: number
  color: string | null
  statuses: WorkStatus[]
  kinds: { key: string; label: string }[]
  items: WorkItem[]
  nextCursor: string | null
  truncated: boolean
}

export type TasksRow = { item: WorkItem; space: SpaceData; status: WorkStatus | null }

export function rowsOf(data: SpaceData[]): TasksRow[] {
  return data.flatMap((space) => space.items.map((item) => ({ item, space, status: space.statuses.find((status) => status.key === item.statusKey) ?? null })))
}

// --- 키 (E2·E3) ---

/** 출처 키 모양 → 검색어 전체가 키인가 / 브랜치 이름에서 키 찾기. 잘못된 패턴은 null(화면이 키 감지를 끈다). */
export function keyMatchers(pattern: string | null): { whole: RegExp; inside: RegExp } | null {
  if (pattern === null || pattern.length === 0) return null
  try {
    return { whole: new RegExp(`^(?:${pattern})$`, 'i'), inside: new RegExp(`(?<![A-Za-z0-9])(${pattern})(?![0-9])`, 'i') }
  } catch {
    return null
  }
}

/** 검색어가 그 출처의 키 모양이면 그 키(공백 제거·대문자). 아니면 null. */
export function searchKey({ query, pattern }: { query: string; pattern: string | null }): string | null {
  const matchers = keyMatchers(pattern)
  const trimmed = query.trim()
  return matchers !== null && matchers.whole.test(trimmed) ? trimmed.toUpperCase() : null
}

/** 브랜치 이름 속 키 — `LIFE-601-tasks-page` → `LIFE-601`. 없으면 null. */
export function branchKey({ branch, pattern }: { branch: string; pattern: string | null }): string | null {
  const matchers = keyMatchers(pattern)
  const found = matchers?.inside.exec(branch)
  return found?.[1] === undefined ? null : found[1].toUpperCase()
}

// --- 필터·검색 (C10) ---

export function filtersActive(filters: TasksFilters): boolean {
  return filters.kinds.length > 0 || filters.priorities.length > 0 || filters.blocked || filters.working || filters.dueWeek
}

const DAY_MS = 86_400_000

export function passesFilters({ row, filters, workingKeys, now }: { row: TasksRow; filters: TasksFilters; workingKeys: ReadonlySet<string>; now: number }): boolean {
  const { item } = row
  if (filters.kinds.length > 0 && !filters.kinds.includes(item.kind.key)) return false
  if (filters.priorities.length > 0 && (item.priority === null || !filters.priorities.includes(item.priority))) return false
  if (filters.blocked && item.openBlockerCount === 0) return false
  if (filters.working && !workingKeys.has(item.key.toUpperCase())) return false
  if (filters.dueWeek) {
    const due = item.dueAt === null ? Number.NaN : Date.parse(item.dueAt)
    if (Number.isNaN(due) || due > now + 7 * DAY_MS) return false
  }
  return true
}

export function passesText({ row, query }: { row: TasksRow; query: string }): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return row.item.title.toLowerCase().includes(needle) || row.item.key.toLowerCase().includes(needle)
}

/** 빈 상태의 원인(C5) — 오류 배너가 있으면 부르지 않는다. */
export type EmptyCause = 'space' | 'search' | 'filter' | 'working'

export function emptyCause({ total, afterFilter, query, view }: { total: number; afterFilter: number; query: string; view: TasksView }): EmptyCause {
  if (view === 'working') return 'working'
  if (total === 0) return 'space'
  if (query.trim().length > 0 && afterFilter > 0) return 'search'
  return afterFilter === 0 ? 'filter' : 'search'
}

// --- 보드 (C6) ---

export type BoardColumn = { id: string; label: string; category: WorkCategory; statusKey: string | null; unmapped: boolean; rows: TasksRow[]; fill: number }
export type BoardBand = { category: WorkCategory; label: string; columns: BoardColumn[]; count: number }

export const CATEGORY_LABEL: Record<WorkCategory, string> = { todo: '할 일', in_progress: '진행 중', done: '완료' }
const CATEGORIES: WorkCategory[] = ['todo', 'in_progress', 'done']

/** 순서 값 비교 — 숫자 순서 값(LA position)은 숫자로, 아니면 글자로. 같으면 키. */
export function compareRank(a: WorkItem, b: WorkItem): number {
  const left = a.rank ?? ''
  const right = b.rank ?? ''
  const ln = Number(left)
  const rn = Number(right)
  if (left !== '' && right !== '' && Number.isFinite(ln) && Number.isFinite(rn) && ln !== rn) return ln - rn
  return left.localeCompare(right) || a.key.localeCompare(b.key, undefined, { numeric: true })
}

export function byRank(a: TasksRow, b: TasksRow): number {
  return compareRank(a.item, b.item)
}

/**
 * 단일 스페이스 = 상태마다 칸(워크플로 순서), 분류 밴드로 묶는다. 목록에 있으나 상태 목록에 없는 상태의 작업은 마지막 점선 칸(사라지지 않는다).
 * 「전체」 = 분류 3칸(카드에 원래 상태 라벨 + 스페이스 점). 진행 중 칸의 `fill` = 워크플로 위치(원 채움 비율).
 */
export function boardBands({ rows, statuses, all }: { rows: TasksRow[]; statuses: WorkStatus[]; all: boolean }): BoardBand[] {
  const sorted = [...rows].sort(byRank)
  if (all) {
    return CATEGORIES.map((category) => {
      const columnRows = sorted.filter((row) => (row.status?.category ?? row.item.category) === category)
      const column: BoardColumn = { id: `cat:${category}`, label: CATEGORY_LABEL[category], category, statusKey: null, unmapped: false, rows: columnRows, fill: category === 'done' ? 1 : category === 'todo' ? 0 : 0.5 }
      return { category, label: CATEGORY_LABEL[category], columns: [column], count: columnRows.length }
    })
  }
  const ordered = [...statuses].sort((a, b) => a.order - b.order)
  const known = new Set(ordered.map((status) => status.key))
  const doing = ordered.filter((status) => status.category === 'in_progress')
  const bands: BoardBand[] = CATEGORIES.map((category) => {
    const columns = ordered
      .filter((status) => status.category === category)
      .map((status): BoardColumn => ({
        id: `st:${status.key}`,
        label: status.label,
        category,
        statusKey: status.key,
        unmapped: false,
        rows: sorted.filter((row) => row.item.statusKey === status.key),
        fill: category === 'done' ? 1 : category === 'todo' ? 0 : (doing.indexOf(status) + 1) / (doing.length + 1),
      }))
    return { category, label: CATEGORY_LABEL[category], columns, count: columns.reduce((sum, column) => sum + column.rows.length, 0) }
  }).filter((band) => band.columns.length > 0)
  const strays = sorted.filter((row) => !known.has(row.item.statusKey))
  if (strays.length > 0) {
    const last = bands[bands.length - 1]
    const column: BoardColumn = { id: 'st:__unmapped', label: '보드에 칸이 없는 상태', category: 'todo', statusKey: null, unmapped: true, rows: strays, fill: 0 }
    if (last !== undefined) {
      last.columns.push(column)
      last.count += strays.length
    } else bands.push({ category: 'todo', label: CATEGORY_LABEL.todo, columns: [column], count: strays.length })
  }
  return bands
}

/** 체크포인트(자식 있는 작업) 진행 — 자식 중 완료 분류 수 / 전체. 자식이 없으면 null. */
export function childProgress({ item, rows }: { item: WorkItem; rows: TasksRow[] }): { done: number; total: number; children: TasksRow[] } | null {
  const children = rows.filter((row) => row.item.parentId === item.id && row.item.spaceKey === item.spaceKey)
  if (children.length === 0) return null
  return { done: children.filter((row) => row.item.category === 'done').length, total: children.length, children }
}

/** 막힘 배지 문구(C6) — 「막힘 · KEY」, 둘 이상이면 「(외 N)」. 열린 막은 쪽이 없으면 null(완료 분류 막은 쪽은 출처가 이미 뺐다). */
export function blockedLabel(item: WorkItem): string | null {
  const first = item.openBlockers[0]
  if (first === undefined) return item.openBlockerCount > 0 ? `막힘 · ${item.openBlockerCount}` : null
  const more = Math.max(item.openBlockers.length, item.openBlockerCount) - 1
  return more > 0 ? `막힘 · ${first.key} (외 ${more})` : `막힘 · ${first.key}`
}

/** 마감 표시 — 지남(over) · 2일 안(soon) · 그 밖(normal). 없으면 null. */
export function dueTone({ dueAt, now }: { dueAt: string | null; now: number }): 'over' | 'soon' | 'normal' | null {
  if (dueAt === null) return null
  const due = Date.parse(dueAt)
  if (Number.isNaN(due)) return null
  if (due < now) return 'over'
  return due - now <= 2 * DAY_MS ? 'soon' : 'normal'
}

export function dueLabel(dueAt: string | null): string | null {
  if (dueAt === null) return null
  const date = new Date(dueAt)
  return Number.isNaN(date.getTime()) ? null : `${date.getMonth() + 1}/${date.getDate()}`
}

// --- 리스트 (C9) ---

const PRIORITY_RANK: Record<WorkPriority, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 }
export const PRIORITY_LABEL: Record<WorkPriority, string> = { highest: '가장 높음', high: '높음', medium: '보통', low: '낮음', lowest: '가장 낮음' }
export const PRIORITY_GLYPH: Record<WorkPriority, string | null> = { highest: '⇈', high: '↑', medium: null, low: '↓', lowest: '⇊' }

export function sortRows({ rows, sort }: { rows: TasksRow[]; sort: TasksSort }): TasksRow[] {
  const list = [...rows]
  switch (sort) {
    case 'rank':
      return list.sort(byRank)
    case 'priority':
      return list.sort((a, b) => (a.item.priority === null ? 9 : PRIORITY_RANK[a.item.priority]) - (b.item.priority === null ? 9 : PRIORITY_RANK[b.item.priority]) || byRank(a, b))
    case 'due':
      return list.sort((a, b) => (a.item.dueAt === null ? Infinity : Date.parse(a.item.dueAt)) - (b.item.dueAt === null ? Infinity : Date.parse(b.item.dueAt)) || byRank(a, b))
    case 'key':
      return list.sort((a, b) => a.item.key.localeCompare(b.item.key, undefined, { numeric: true }))
  }
}

export type ListGroup = { id: string; label: string; rows: TasksRow[] }

/**
 * 그룹 — **받아 둔 행 기준**(C9). 단일 스페이스의 「상태」 는 워크플로 순서대로 상태마다, 「전체」 는 분류마다. 빈 그룹은 그리지 않는다.
 */
export function groupRows({ rows, group, statuses, all }: { rows: TasksRow[]; group: TasksGroup; statuses: WorkStatus[]; all: boolean }): ListGroup[] {
  switch (group) {
    case 'none':
      return rows.length === 0 ? [] : [{ id: 'all', label: '전체', rows }]
    case 'priority': {
      const keys: (WorkPriority | null)[] = [...WORK_PRIORITIES, null]
      return keys
        .map((priority) => ({ id: `prio:${priority ?? 'none'}`, label: priority === null ? '우선순위 없음' : PRIORITY_LABEL[priority], rows: rows.filter((row) => row.item.priority === priority) }))
        .filter((entry) => entry.rows.length > 0)
    }
    case 'status': {
      if (all) {
        return CATEGORIES.map((category) => ({ id: `cat:${category}`, label: CATEGORY_LABEL[category], rows: rows.filter((row) => (row.status?.category ?? row.item.category) === category) })).filter((entry) => entry.rows.length > 0)
      }
      const ordered = [...statuses].sort((a, b) => a.order - b.order)
      const known = new Set(ordered.map((status) => status.key))
      const groups = ordered.map((status) => ({ id: `st:${status.key}`, label: status.label, rows: rows.filter((row) => row.item.statusKey === status.key) }))
      groups.push({ id: 'st:__unmapped', label: '보드에 칸이 없는 상태', rows: rows.filter((row) => !known.has(row.item.statusKey)) })
      return groups.filter((entry) => entry.rows.length > 0)
    }
  }
}

/** 프리셋 → 필터·정렬. 「작업 중」 = 작업 중 칩, 「막힘」 = 막힘 칩, 「이번 주 마감」 = 7일 안 마감 + 마감 순. */
export function applyPreset({ preset, sort }: { preset: TasksPreset; sort: TasksSort }): { filters: TasksFilters; sort: TasksSort } {
  switch (preset) {
    case 'all': return { filters: NO_FILTERS, sort }
    case 'working': return { filters: { ...NO_FILTERS, working: true }, sort }
    case 'blocked': return { filters: { ...NO_FILTERS, blocked: true }, sort }
    case 'week': return { filters: { ...NO_FILTERS, dueWeek: true }, sort: 'due' }
  }
}

/** 지금 필터가 어느 프리셋과 같으면 그 프리셋(칩 강조용). */
export function activePreset(filters: TasksFilters): TasksPreset | null {
  for (const preset of TASKS_PRESETS) {
    const shape = applyPreset({ preset, sort: 'rank' }).filters
    if (JSON.stringify(shape) === JSON.stringify(filters)) return preset
  }
  return null
}

// --- 능력·쓰기 (C5·C7·C8) ---

export type WriteBlock = { reason: string } | null

/** 연결 상태가 권한 부족·끊김·인증 실패면 쓰기 손잡이 흐림 + 이유. */
export function writeBlock(status: WorkConnectionSummary['status'] | null): WriteBlock {
  switch (status) {
    case 'forbidden': return { reason: '권한이 없어 바꿀 수 없습니다.' }
    case 'offline': return { reason: '출처에 닿지 않아 바꿀 수 없습니다 — 다시 시도하세요.' }
    case 'auth': return { reason: '인증이 끊겨 바꿀 수 없습니다 — 설정에서 토큰을 다시 붙여넣으세요.' }
    case 'keychain': return { reason: '자격을 풀지 못해 바꿀 수 없습니다.' }
    default: return null
  }
}

export function capabilityReason(capability: WorkCapability): string | null {
  return capability.state === 'disabled' ? capability.reason : null
}

/** 백로그 보기 — 배치 능력 `hidden` 이면 탭이 없다. 「전체」 는 연결마다 능력이 다를 수 있어 하나라도 켜져 있으면 둔다. */
export function viewsFor(capabilities: WorkCapabilities[]): TasksView[] {
  const placement = capabilities.length === 0 || capabilities.some((entry) => entry.placement.state !== 'hidden')
  return TASKS_VIEWS.filter((view) => view !== 'backlog' || placement)
}

// --- 끌기 판정 (C7) ---

export type DragIntent =
  | { kind: 'status'; statusKey: string }
  | { kind: 'reorder'; afterId: string | null }
  | { kind: 'placement'; placement: 'board' | 'backlog' }
  | { kind: 'none' }

/**
 * 보드 칸에 놓기 → 의도. 다른 칸 = 상태 변경(「전체」 의 분류 칸이면 그 작업 스페이스에서 그 분류의 첫 상태). 같은 칸 = 순서.
 * 점선 칸(칸 없는 상태)에는 놓을 수 없다.
 */
export function boardDropIntent({ row, column, afterId, statusesOf }: { row: TasksRow; column: BoardColumn; afterId: string | null; statusesOf: (row: TasksRow) => WorkStatus[] }): DragIntent {
  if (column.unmapped) return { kind: 'none' }
  const target = column.statusKey ?? [...statusesOf(row)].sort((a, b) => a.order - b.order).find((status) => status.category === column.category)?.key ?? null
  if (target === null) return { kind: 'none' }
  const sameColumn = column.statusKey === null ? (row.status?.category ?? row.item.category) === column.category : row.item.statusKey === target
  if (sameColumn) return { kind: 'reorder', afterId }
  return { kind: 'status', statusKey: target }
}

/** 낙관적 반영 — 작업 하나에 상태·분류·배치·순서를 덮어 쓴 새 목록. 순서는 「afterId 바로 뒤」 로 자리를 옮긴다. */
export function applyIntent({ items, itemId, intent, statuses }: { items: WorkItem[]; itemId: string; intent: DragIntent; statuses: WorkStatus[] }): WorkItem[] {
  const index = items.findIndex((item) => item.id === itemId)
  const current = items[index]
  if (current === undefined) return items
  switch (intent.kind) {
    case 'none':
      return items
    case 'status': {
      const status = statuses.find((entry) => entry.key === intent.statusKey)
      return items.map((item) => (item.id === itemId ? { ...item, statusKey: intent.statusKey, category: status?.category ?? item.category } : item))
    }
    case 'placement':
      return items.map((item) => (item.id === itemId ? { ...item, placement: intent.placement } : item))
    case 'reorder':
      return moveAfter({ items, itemId, afterId: intent.afterId })
  }
}

/**
 * 순서 값을 다시 매겨 `itemId` 를 `afterId` 바로 뒤로(null 이면 맨 앞). 화면 표시용 — 출처 순서 값은 응답이 덮는다.
 * 같은 순서 값 체계(숫자)를 쓰면 숫자로, 아니면 글자로 사이 값을 만든다.
 */
export function moveAfter({ items, itemId, afterId }: { items: WorkItem[]; itemId: string; afterId: string | null }): WorkItem[] {
  const ordered = [...items].sort(compareRank)
  const moving = ordered.find((item) => item.id === itemId)
  if (moving === undefined) return items
  const rest = ordered.filter((item) => item.id !== itemId)
  const at = afterId === null ? 0 : rest.findIndex((item) => item.id === afterId) + 1
  rest.splice(at < 0 ? rest.length : at, 0, moving)
  const ranks = new Map(rest.map((item, position) => [item.id, String(position).padStart(6, '0')]))
  return items.map((item) => ({ ...item, rank: ranks.get(item.id) ?? item.rank }))
}

// --- 늦은 응답 폐기 (C7) ---

/** 열쇠마다 마지막으로 보낸 요청 id. 응답이 그 id 가 아니면 버린다 — 연타·늦은 응답이 뒤 결과를 덮지 않는다. */
export class LatestGate {
  private readonly latest = new Map<string, string>()
  private seq = 0

  issue(key: string): string {
    this.seq += 1
    const id = `${key}#${this.seq}`
    this.latest.set(key, id)
    return id
  }

  accepts({ key, requestId }: { key: string; requestId: string }): boolean {
    return this.latest.get(key) === requestId
  }

  /** 이 열쇠에 진행 중인 요청을 모두 무효로(스페이스·필터가 바뀌어 커서를 버릴 때). */
  invalidate(key: string): void {
    this.seq += 1
    this.latest.set(key, `${key}#void${this.seq}`)
  }
}

// --- 키 (C4) ---

/** IME 조합 중인 키 — 조합 중 Esc 는 조합만 끝낸다(페이지를 닫지 않는다). `keyCode 229` 는 조합 키의 Chromium 표식(terminal-keys.ts 와 같다). */
export function imeComposing(event: { isComposing: boolean; keyCode: number }): boolean {
  return event.isComposing || event.keyCode === 229
}

// --- 작업 중 (C11) ---

/** 열린 worktree 하나 — 에이전트 점은 탭 선두와 같은 집계(`tab-status.ts`), 에이전트 pane 이 없으면 null. */
export type WorkingTree = { path: string; repoRoot: string; repoName: string; branch: string; dot: AgentDot | null }
export type WorkingEntry = { key: string; connectionId: string; trees: WorkingTree[] }

/**
 * 열린 worktree 브랜치에서 출처 키를 찾아 키별로 묶는다. 연결마다 그 출처의 키 모양으로 본다 — 같은 키를 두 연결이 다 알아보면
 * 둘 다 후보다(E2 조회로 어느 쪽에 있는지 가린다). 키 모양을 주지 않은 출처는 건너뛴다.
 */
export function detectWorking({ trees, patterns }: { trees: WorkingTree[]; patterns: { connectionId: string; pattern: string | null }[] }): WorkingEntry[] {
  const entries = new Map<string, WorkingEntry>()
  for (const { connectionId, pattern } of patterns) {
    for (const tree of trees) {
      const key = branchKey({ branch: tree.branch, pattern })
      if (key === null) continue
      const id = `${connectionId}::${key}`
      const entry = entries.get(id) ?? { key, connectionId, trees: [] }
      entry.trees.push(tree)
      entries.set(id, entry)
    }
  }
  return [...entries.values()]
}
