// 영역(탭 그룹) 트리 — ① 의 순수 모델 (LIFE-373 §1 · §10-R3).
//
// **corral 이 소유하는 herdr 밖 상태**다. herdr 는 pane 트리만 알고, "어느 탭이 어느 영역에
// 있나"는 화면의 것이다 (F1-6 주의: 레포 루트 목록에 이은 두 번째 사례).
//
// 모델은 **이진 분할 트리**다. 리프가 영역이고 가지는 방향(가로/세로) + 비율 하나를 든다.
// 평평한 목록으로 안 하는 이유: ⌘⌥D(오른쪽)와 ⌘⌥⇧D(아래)가 섞이면(목업 ⓓ) 한 방향
// 목록으로는 표현이 안 된다. 트리는 그 둘을 같은 연산 하나로 받는다.
//
// 여기 있는 함수는 전부 **순수**하고 트리를 새로 만들어 돌려준다 — React 상태로 그대로 쓴다.
// 화면·IPC·영속은 이 파일 밖(`useGroupLayout`)이다.

/** 한 영역 — Orca `TabGroup` 과 동형 (§10-R3-c: 영역이 자기 탭 목록을 소유한다). */
export type TabGroup = {
  groupId: string
  /** 이 영역에 **배정된** 탭들. 한 탭은 한 영역에만 있다 (R3-c). */
  tabOrder: string[]
  /** 영역마다 독립된 활성 탭 (R3-a) — 포커스 pane 에서 파생시키지 않는다. */
  activeTabId: string | null
}

export type GroupNode =
  | { kind: 'leaf'; group: TabGroup }
  | { kind: 'split'; direction: 'row' | 'column'; ratio: number; first: GroupNode; second: GroupNode }

/** 한 worktree 의 영역 배치 전부 (R3-h — 영속 단위가 이것이다). */
export type GroupLayout = {
  root: GroupNode
  activeGroupId: string
}

/** 비율 클램프 (F1-2) — 한쪽이 0 이 되면 그 영역은 못 돌아온다. */
export const RATIO_MIN = 0.15
export const RATIO_MAX = 0.85

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio))
}

export function leaf(group: TabGroup): GroupNode {
  return { kind: 'leaf', group }
}

export function singleLayout(input: { groupId: string; tabOrder: string[]; activeTabId: string | null }): GroupLayout {
  return {
    root: leaf({ groupId: input.groupId, tabOrder: [...input.tabOrder], activeTabId: input.activeTabId }),
    activeGroupId: input.groupId,
  }
}

export function listGroups(node: GroupNode): TabGroup[] {
  switch (node.kind) {
    case 'leaf':
      return [node.group]
    case 'split':
      return [...listGroups(node.first), ...listGroups(node.second)]
  }
}

export function findGroup(node: GroupNode, groupId: string): TabGroup | null {
  return listGroups(node).find((group) => group.groupId === groupId) ?? null
}

/** 그 탭이 배정된 영역 (R3-e reveal 의 목적지). */
export function groupOfTab(node: GroupNode, tabId: string): TabGroup | null {
  return listGroups(node).find((group) => group.tabOrder.includes(tabId)) ?? null
}

/** 리프 하나만 골라 바꾼다 — 나머지 가지는 **참조 그대로** 둔다(리렌더 범위를 좁힌다). */
function mapGroup(node: GroupNode, groupId: string, change: (group: TabGroup) => TabGroup): GroupNode {
  switch (node.kind) {
    case 'leaf':
      return node.group.groupId === groupId ? { kind: 'leaf', group: change(node.group) } : node
    case 'split': {
      const first = mapGroup(node.first, groupId, change)
      const second = mapGroup(node.second, groupId, change)
      return first === node.first && second === node.second ? node : { ...node, first, second }
    }
  }
}

export function updateGroup(layout: GroupLayout, groupId: string, change: (group: TabGroup) => TabGroup): GroupLayout {
  const root = mapGroup(layout.root, groupId, change)
  return root === layout.root ? layout : { ...layout, root }
}

/**
 * 영역을 쪼갠다 (F1-1) — **그 탭을 빼내** 새 영역에 넣는다.
 *
 * `direction: 'row'` = 오른쪽(⌘⌥D), `'column'` = 아래(⌘⌥⇧D). 새 영역이 활성이 된다.
 * 원 영역의 탭이 하나뿐이면 **아무것도 하지 않는다** — 빈 영역을 만드는 경로가 되면 안 된다
 * (핸드오프 §1-6 "원 영역에 탭이 하나뿐이면 비활성").
 */
export function splitGroup(input: {
  layout: GroupLayout
  groupId: string
  tabId: string
  direction: 'row' | 'column'
  newGroupId: string
}): GroupLayout {
  const source = findGroup(input.layout.root, input.groupId)
  if (source === null) return input.layout
  if (!source.tabOrder.includes(input.tabId)) return input.layout
  if (source.tabOrder.length < 2) return input.layout

  const remaining = source.tabOrder.filter((tabId) => tabId !== input.tabId)
  const moved: TabGroup = { groupId: input.newGroupId, tabOrder: [input.tabId], activeTabId: input.tabId }

  const replace = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf':
        if (node.group.groupId !== input.groupId) return node
        return {
          kind: 'split',
          direction: input.direction,
          ratio: 0.5,
          first: leaf({
            ...node.group,
            tabOrder: remaining,
            // 빠져나간 탭이 활성이었으면 남은 것 중 앞쪽을 활성으로 (§4 "인접 탭 활성" 과 같은 결).
            activeTabId: node.group.activeTabId === input.tabId ? (remaining[0] ?? null) : node.group.activeTabId,
          }),
          second: leaf(moved),
        }
      case 'split': {
        const first = replace(node.first)
        const second = replace(node.second)
        return first === node.first && second === node.second ? node : { ...node, first, second }
      }
    }
  }

  return { root: replace(input.layout.root), activeGroupId: input.newGroupId }
}

/**
 * 영역을 없애고 형제가 자리를 차지한다 (F1-5). 영역이 하나면 무효.
 *
 * 남아 있던 탭은 **형제 영역으로 넘긴다** — 영역을 닫는 것이 탭을 닫는 것이 되면 안 된다
 * (§4 는 빈 영역 닫기만 말하지만, 닫기 경로가 탭을 삼키는 구멍은 막아 둔다).
 */
export function closeGroup(layout: GroupLayout, groupId: string): GroupLayout {
  const groups = listGroups(layout.root)
  if (groups.length < 2) return layout
  const closing = groups.find((group) => group.groupId === groupId)
  if (closing === undefined) return layout

  const drop = (node: GroupNode): GroupNode | null => {
    switch (node.kind) {
      case 'leaf':
        return node.group.groupId === groupId ? null : node
      case 'split': {
        const first = drop(node.first)
        const second = drop(node.second)
        if (first === null) return second
        if (second === null) return first
        return first === node.first && second === node.second ? node : { ...node, first, second }
      }
    }
  }
  const pruned = drop(layout.root)
  if (pruned === null) return layout
  const adopted = closing.tabOrder

  const heir = listGroups(pruned)[0]
  if (heir === undefined) return layout
  const withTabs =
    adopted.length === 0
      ? pruned
      : mapGroup(pruned, heir.groupId, (group) => ({
          ...group,
          tabOrder: [...group.tabOrder, ...adopted.filter((tabId) => !group.tabOrder.includes(tabId))],
          activeTabId: group.activeTabId ?? (adopted[0] ?? null),
        }))

  const nextActive = listGroups(withTabs).some((group) => group.groupId === layout.activeGroupId)
    ? layout.activeGroupId
    : heir.groupId
  return { root: withTabs, activeGroupId: nextActive }
}

/** 분할 하나의 비율을 바꾼다 (F1-2 — mouseup 1회 커밋). 분할은 **자기 자식 id 쌍**으로 가린다. */
export function setRatio(layout: GroupLayout, splitId: string, ratio: number): GroupLayout {
  const apply = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf':
        return node
      case 'split': {
        if (splitIdOf(node) === splitId) return { ...node, ratio: clampRatio(ratio) }
        const first = apply(node.first)
        const second = apply(node.second)
        return first === node.first && second === node.second ? node : { ...node, first, second }
      }
    }
  }
  return { ...layout, root: apply(layout.root) }
}

/**
 * 분할 마디의 id — **양쪽 첫 영역 id 로 만든다**.
 *
 * 마디에 따로 id 를 주지 않는 이유: 그러면 영속 스키마에 의미 없는 id 가 하나 더 생기고,
 * 닫기·분할로 트리가 바뀔 때마다 그 id 를 이어 붙이는 일이 생긴다. 리프 id 는 어차피 유일하고
 * 트리 안에서 위치가 하나라 이 쌍이면 충분하다.
 */
export function splitIdOf(node: { first: GroupNode; second: GroupNode }): string {
  return `${firstGroupId(node.first)}|${firstGroupId(node.second)}`
}

function firstGroupId(node: GroupNode): string {
  switch (node.kind) {
    case 'leaf':
      return node.group.groupId
    case 'split':
      return firstGroupId(node.first)
  }
}

/**
 * 살아 있는 탭에 맞춰 배치를 추린다 — **F1-6 의 안전한 붕괴가 여기 있다.**
 *
 * herdr 서버가 재기동하면 `workspace_id` 가 바뀌어 저장된 tabId 가 하나도 안 맞는다(LIFE-344).
 * 그때 이 함수는 저장된 영역 **뼈대는 두되** 탭을 전부 첫 영역으로 보낸다 — 잘못된 영역에
 * 붙이거나 크래시하지 않는다. 어느 영역에도 없는 새 탭도 같은 길로 첫 영역에 들어간다(R3-d).
 */
export function reconcileLayout(input: { layout: GroupLayout; liveTabIds: string[] }): GroupLayout {
  const live = new Set(input.liveTabIds)
  const seen = new Set<string>()
  const prune = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf': {
        const tabOrder = node.group.tabOrder.filter((tabId) => {
          if (!live.has(tabId) || seen.has(tabId)) return false
          seen.add(tabId)
          return true
        })
        const activeTabId = node.group.activeTabId !== null && tabOrder.includes(node.group.activeTabId)
          ? node.group.activeTabId
          : (tabOrder[0] ?? null)
        if (tabOrder.length === node.group.tabOrder.length && activeTabId === node.group.activeTabId) return node
        return leaf({ ...node.group, tabOrder, activeTabId })
      }
      case 'split': {
        const first = prune(node.first)
        const second = prune(node.second)
        return first === node.first && second === node.second ? node : { ...node, first, second }
      }
    }
  }
  const pruned = prune(input.layout.root)
  const groups = listGroups(pruned)
  const head = groups[0]
  if (head === undefined) return input.layout
  const orphans = input.liveTabIds.filter((tabId) => !seen.has(tabId))
  /**
   * 어디에도 없는 탭이 갈 곳 (R3-d).
   *
   * 보통은 **포커스 영역**이다 — 새 탭·사이드바에서 연 탭이 여기로 들어온다. 다만 **하나도
   * 안 맞은 회차**(herdr 재기동으로 tabId 가 통째로 바뀐 경우)는 "새 탭이 왔다"가 아니라
   * "복원이 실패했다" 이므로 R3-d 의 뒷문장대로 **첫 영역**으로 모은다.
   */
  const restoreFailed = seen.size === 0 && orphans.length > 0
  const landing = restoreFailed
    ? head
    : (groups.find((group) => group.groupId === input.layout.activeGroupId) ?? head)
  const root =
    orphans.length === 0
      ? pruned
      : mapGroup(pruned, landing.groupId, (group) => ({
          ...group,
          tabOrder: [...group.tabOrder, ...orphans],
          activeTabId: group.activeTabId ?? orphans[0] ?? null,
        }))
  /**
   * 활성 영역도 **착지점을 따라간다** (§10-R32-1).
   *
   * 복원 실패면 탭은 전부 첫 영역으로 갔는데 `activeGroupId` 만 옛 영역에 남을 수 있다 — 그 영역은
   * 비어 있고, 활성 영역의 `activeTabId` 가 `null` 이면 `⌘D`·`⌘W`·`⌘⇧Z` 가 **조용히 no-op** 이 된다
   * (`closeTargetRef`·`splitPaneAt(null)`·`toggleZoom` 이 전부 활성 탭을 본다).
   * R3-d 가 "첫 영역으로 모은다"로 정한 의도는 **한 영역에서 다시 시작한다**이지
   * "탭은 첫 영역, 포커스는 빈 영역"이 아니다.
   */
  const activeGroupId = restoreFailed
    ? landing.groupId
    : groups.some((group) => group.groupId === input.layout.activeGroupId)
      ? input.layout.activeGroupId
      : head.groupId
  return { root, activeGroupId }
}

// --- 영속 (R3-h — worktree 단위) ------------------------------------------------

/** 저장 모양. 트리를 그대로 싣는다 — 읽을 때 모양을 확인한다(손으로 고친 파일 대비). */
export type StoredGroupLayout = { worktreePath: string; layout: GroupLayout }

function readNode(value: unknown): GroupNode | null {
  if (value === null || typeof value !== 'object') return null
  const kind = Reflect.get(value, 'kind')
  if (kind === 'leaf') {
    const group = Reflect.get(value, 'group')
    if (group === null || typeof group !== 'object') return null
    const groupId = Reflect.get(group, 'groupId')
    const tabOrder = Reflect.get(group, 'tabOrder')
    const activeTabId = Reflect.get(group, 'activeTabId')
    if (typeof groupId !== 'string' || groupId.length === 0) return null
    if (!Array.isArray(tabOrder)) return null
    return leaf({
      groupId,
      tabOrder: tabOrder.filter((item): item is string => typeof item === 'string'),
      activeTabId: typeof activeTabId === 'string' ? activeTabId : null,
    })
  }
  if (kind === 'split') {
    const direction = Reflect.get(value, 'direction')
    const ratio = Reflect.get(value, 'ratio')
    const first = readNode(Reflect.get(value, 'first'))
    const second = readNode(Reflect.get(value, 'second'))
    if (direction !== 'row' && direction !== 'column') return null
    if (first === null || second === null) return null
    return { kind: 'split', direction, ratio: clampRatio(typeof ratio === 'number' ? ratio : 0.5), first, second }
  }
  return null
}

export function readStoredLayouts(value: unknown): StoredGroupLayout[] {
  if (!Array.isArray(value)) return []
  const rows: StoredGroupLayout[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const worktreePath = Reflect.get(item, 'worktreePath')
    const stored = Reflect.get(item, 'layout')
    if (typeof worktreePath !== 'string' || worktreePath.length === 0) continue
    if (stored === null || typeof stored !== 'object') continue
    const root = readNode(Reflect.get(stored, 'root'))
    if (root === null) continue
    const activeGroupId = Reflect.get(stored, 'activeGroupId')
    const groups = listGroups(root)
    const head = groups[0]
    if (head === undefined) continue
    rows.push({
      worktreePath,
      layout: {
        root,
        activeGroupId:
          typeof activeGroupId === 'string' && groups.some((group) => group.groupId === activeGroupId) ? activeGroupId : head.groupId,
      },
    })
  }
  return rows
}
