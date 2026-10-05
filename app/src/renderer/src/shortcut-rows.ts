// 설정 › 단축키 섹션의 표 모델 (LIFE-511 K6) — 순수 함수. 화면(`ShortcutsSection.tsx`)은 이 결과만 그린다.
// - 그룹: `ACTIONS` 의 `group` 칸(shared/keybindings.ts — Orca 198 Global · Tabs · Tab Navigation · Terminal Panes 대응). 그룹 순서는 아래 표,
//   그룹 안 순서는 `ACTIONS` 순서다. 액션 id 를 여기 적지 않는다 — 경계 검사(check:boundary R4)가 'tab.*'·'workspace.*' 를 herdr 메서드로 본다.
// - 필터: All / Modified(재정의 있음) / Unassigned(모든 칸이 「없음」) / Conflicts(지금 조합이 다른 칸과 겹침 — 검증된 파일이면 0).
// - 저장 전 충돌: 실제 저장 검증(`validateOverrides`)을 그대로 돌려 본다. 거절이면 그 문구를 보이고 저장 버튼을 막는다.
import { ACTIONS, bindingsFor, formatBinding, matchBinding, validateOverrides, type ActionId, type Keybindings } from '../../shared/keybindings.js'

type Action = (typeof ACTIONS)[number]

const GROUP_ORDER: readonly Action['group'][] = ['전역', '탭', '탭 이동', '터미널 pane']
export const SHORTCUT_GROUPS: readonly { title: string; ids: readonly ActionId[] }[] = GROUP_ORDER.map((title) => ({
  title,
  ids: ACTIONS.filter((action) => action.group === title).map((action) => action.id),
}))

export type ShortcutFilter = 'all' | 'modified' | 'unassigned' | 'conflicts'
export const SHORTCUT_FILTERS: readonly { id: ShortcutFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'modified', label: 'Modified' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'conflicts', label: 'Conflicts' },
]

export type ShortcutSlot = { variant: number; label: string; binding: string | null; isDefault: boolean }
export type ShortcutRow = { action: Action; groupTitle: string; slots: ShortcutSlot[]; modified: boolean; unassigned: boolean; conflicts: string[] }

function actionOf(id: ActionId): Action {
  return ACTIONS.find((action) => action.id === id)!
}

export function shortcutRows(overrides: Keybindings): ShortcutRow[] {
  // 칸마다 지금 쥔 조합 → 그 조합을 쥔 칸 수. 둘 이상이면 겹친다.
  const holders = new Map<string, number>()
  for (const action of ACTIONS) for (const binding of bindingsFor(action.id, overrides)) if (binding !== null) holders.set(binding, (holders.get(binding) ?? 0) + 1)
  return SHORTCUT_GROUPS.flatMap((group) => group.ids.map((id) => {
    const action = actionOf(id)
    const current = bindingsFor(id, overrides)
    const slots = action.defaultBinding.map((fallback, slot) => ({
      variant: slot,
      label: action.variants[action.bindingVariants[slot] ?? 0] ?? '',
      binding: current[slot] ?? null,
      isDefault: (current[slot] ?? null) === fallback,
    }))
    return {
      action,
      groupTitle: group.title,
      slots,
      modified: overrides[id] !== undefined,
      unassigned: slots.every((slot) => slot.binding === null),
      conflicts: slots.flatMap((slot) => (slot.binding !== null && (holders.get(slot.binding) ?? 0) > 1 ? [formatBinding(slot.binding)] : [])),
    }
  }))
}

export function matchesShortcutFilter(input: { row: ShortcutRow; filter: ShortcutFilter }): boolean {
  const { row } = input
  switch (input.filter) {
    case 'all':
      return true
    case 'modified':
      return row.modified
    case 'unassigned':
      return row.unassigned
    case 'conflicts':
      return row.conflicts.length > 0
  }
}

/**
 * 네 카운트 — **섹션 안 검색을 적용한 뒤, 상태 필터를 적용하기 전** 집합에서 센다(Orca 198 `shortcut-row-visibility.ts:77`
 * `baseVisibleRows`). 그래서 각 숫자가 그 필터를 눌렀을 때 보일 행 수다(r1 R1-03).
 */
export function shortcutFilterCounts(input: { rows: readonly ShortcutRow[]; query: string }): Record<ShortcutFilter, number> {
  const base = input.rows.filter((row) => matchesShortcutQuery({ row, query: input.query }))
  const count = (filter: ShortcutFilter): number => base.filter((row) => matchesShortcutFilter({ row, filter })).length
  return { all: count('all'), modified: count('modified'), unassigned: count('unassigned'), conflicts: count('conflicts') }
}

/** 단축키 섹션 안 검색 — 액션 이름·id·그룹·칸 이름·지금 조합(⌘K 처럼 기호로도). */
export function matchesShortcutQuery(input: { row: ShortcutRow; query: string }): boolean {
  const { row } = input
  const needle = input.query.trim().toLowerCase()
  if (needle === '') return true
  const haystack = [row.action.title, row.action.id, row.groupTitle, ...row.slots.map((slot) => slot.label), ...row.slots.flatMap((slot) => (slot.binding === null ? [] : [formatBinding(slot.binding)]))]
  return haystack.some((value) => value.toLowerCase().includes(needle))
}

export type ShortcutRowGroup = { title: string; rows: ShortcutRow[] }

export function visibleShortcutGroups(input: { rows: readonly ShortcutRow[]; filter: ShortcutFilter; query: string }): ShortcutRowGroup[] {
  return SHORTCUT_GROUPS.flatMap((group) => {
    const rows = input.rows.filter((row) => row.groupTitle === group.title && matchesShortcutFilter({ row, filter: input.filter }) && matchesShortcutQuery({ row, query: input.query }))
    return rows.length === 0 ? [] : [{ title: group.title, rows }]
  })
}

/** 한 칸을 바꾼 다음 재정의 — 비켜 선 빈 칸(null)은 빈 칸 그대로 둔다(LIFE-495 fix2 R2-01). */
export function withSlot(input: { overrides: Keybindings; id: ActionId; variant: number; binding: string | null }): Keybindings {
  const bindings = [...bindingsFor(input.id, input.overrides)]
  bindings[input.variant] = input.binding
  return { ...input.overrides, [input.id]: bindings }
}

export type CandidateStatus =
  | { kind: 'ok'; next: Keybindings }
  /** 저장은 되지만 그 조합을 기본값으로 쥔 양보 액션이 「없음」 이 된다. */
  | { kind: 'displaces'; next: Keybindings; title: string }
  | { kind: 'conflict'; message: string }
  /** 같은 칸에 같은 조합 — 바꿀 것이 없다. */
  | { kind: 'same' }

/** 기록한 조합을 저장하기 **전에** 판정한다(K6ⓒ). 저장 경계(main `keybindings.save`)와 같은 `validateOverrides` 를 쓴다. */
export function candidateStatus(input: { overrides: Keybindings; id: ActionId; variant: number; binding: string }): CandidateStatus {
  if (bindingsFor(input.id, input.overrides)[input.variant] === input.binding) return { kind: 'same' }
  const next = withSlot(input)
  try {
    validateOverrides(next)
  } catch (error) {
    return { kind: 'conflict', message: error instanceof Error ? error.message : String(error) }
  }
  const holder = matchBinding(input.binding, input.overrides)
  if (holder !== null && holder.id !== input.id) return { kind: 'displaces', next, title: actionOf(holder.id).title }
  return { kind: 'ok', next }
}
