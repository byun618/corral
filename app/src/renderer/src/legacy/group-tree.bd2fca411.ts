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

/** 오른쪽 위 모서리 영역 — 오른쪽 패널을 여는 버튼이 그 영역 탭 줄 끝에 선다(LIFE-589). row = 좌우(뒤가 오른쪽), column = 위아래(앞이 위). */
export function topRightGroupId(node: GroupNode): string {
  switch (node.kind) {
    case 'leaf':
      return node.group.groupId
    case 'split':
      return topRightGroupId(node.direction === 'row' ? node.second : node.first)
  }
}

export function leaf(group: TabGroup): GroupNode {
  return { kind: 'leaf', group }
}

/**
 * 탭이 하나뿐인 영역에서 «새 영역으로 옮기기»가 안 되는 이유 — **한 곳에서만 쓴다** (§10-R35-2).
 *
 * 탭 메뉴는 항목을 흐리고 이 문구를 `title` 로 달았는데 키보드(`⌘⌥D`)는 **아무 말도 안 했다**
 * (부류 ④ 무음 실패). 두 경로가 같은 사실을 말하므로 문구도 한 자리에서 가져간다.
 */
export const ONE_TAB_IN_GROUP = '이 영역에 탭이 하나뿐이다'

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
 * `direction: 'row'` = 가로 분할(좌우), `'column'` = 세로 분할(상하). `edge: 'after'`(기본,
 * 기존 `⌘⌥D`/`⌘⌥⇧D` 그대로) 면 새 영역이 뒤(오른쪽/아래), `'before'` 면 앞(왼쪽/위) — LIFE-387
 * 탭 드래그가 본문 왼쪽/위 가장자리에 놓였을 때 쓴다(핸드오프 §1 Q1 "왼/위 = 앞"). 새 영역이
 * 활성이 된다. 원 영역의 탭이 하나뿐이면 **아무것도 하지 않는다** — 빈 영역을 만드는 경로가 되면
 * 안 된다(핸드오프 §1-6 "원 영역에 탭이 하나뿐이면 비활성").
 */
export function splitGroup(input: {
  layout: GroupLayout
  groupId: string
  tabId: string
  direction: 'row' | 'column'
  newGroupId: string
  edge?: 'before' | 'after'
}): GroupLayout {
  const source = findGroup(input.layout.root, input.groupId)
  if (source === null) return input.layout
  if (!source.tabOrder.includes(input.tabId)) return input.layout
  if (source.tabOrder.length < 2) return input.layout

  const edge = input.edge ?? 'after'
  const remaining = source.tabOrder.filter((tabId) => tabId !== input.tabId)
  const moved: TabGroup = { groupId: input.newGroupId, tabOrder: [input.tabId], activeTabId: input.tabId }

  const replace = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf': {
        if (node.group.groupId !== input.groupId) return node
        const stayed = leaf({
          ...node.group,
          tabOrder: remaining,
          // 빠져나간 탭이 활성이었으면 남은 것 중 앞쪽을 활성으로 (§4 "인접 탭 활성" 과 같은 결).
          activeTabId: node.group.activeTabId === input.tabId ? (remaining[0] ?? null) : node.group.activeTabId,
        })
        return edge === 'before'
          ? { kind: 'split', direction: input.direction, ratio: 0.5, first: leaf(moved), second: stayed }
          : { kind: 'split', direction: input.direction, ratio: 0.5, first: stayed, second: leaf(moved) }
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
 * 다른 영역의 탭을 이 영역 가장자리로 끌어 새 영역을 만든다 (LIFE-387 A1, 핸드오프 §4
 * "본문 가장자리 · 대상 영역").
 *
 * `splitGroup` 과 다른 점: 빼내는 탭이 **`targetGroupId` 가 아니라 `fromGroupId` 에 있다.**
 * `fromGroupId === targetGroupId`(제 영역 가장자리)면 이 함수를 쓰지 말고 `splitGroup` 을 그대로
 * 써라 — 그쪽은 `tabOrder.length < 2` 로 이미 무효 케이스(탭 1개 + 제 영역 가장자리)를 막는다.
 * 여기는 원 영역이 반드시 다른 영역이므로 원 영역의 탭이 1개여도(=원 영역이 사라지는 경우도)
 * 유효하다 — `removeTabFromGroup` 이 그 collapse 를 처리한다.
 */
export function splitGroupWithForeignTab(input: {
  layout: GroupLayout
  tabId: string
  fromGroupId: string
  targetGroupId: string
  direction: 'row' | 'column'
  edge: 'before' | 'after'
  newGroupId: string
}): GroupLayout {
  if (input.fromGroupId === input.targetGroupId) return input.layout
  const from = findGroup(input.layout.root, input.fromGroupId)
  if (from === null || !from.tabOrder.includes(input.tabId)) return input.layout
  if (findGroup(input.layout.root, input.targetGroupId) === null) return input.layout

  const removed = removeTabFromGroup(input.layout, input.fromGroupId, input.tabId)
  const moved: TabGroup = { groupId: input.newGroupId, tabOrder: [input.tabId], activeTabId: input.tabId }

  const replace = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf': {
        if (node.group.groupId !== input.targetGroupId) return node
        return input.edge === 'before'
          ? { kind: 'split', direction: input.direction, ratio: 0.5, first: leaf(moved), second: node }
          : { kind: 'split', direction: input.direction, ratio: 0.5, first: node, second: leaf(moved) }
      }
      case 'split': {
        const first = replace(node.first)
        const second = replace(node.second)
        return first === node.first && second === node.second ? node : { ...node, first, second }
      }
    }
  }

  return { root: replace(removed.root), activeGroupId: input.newGroupId }
}

/**
 * 그룹이 자식 없이 빈 채로 트리에서 사라진다 — `closeGroup` 의 collapse 부분만 떼어낸 것.
 *
 * `closeGroup` 은 남은 탭을 형제(heir)로 병합하는데(사용자가 명시적으로 "이 영역 닫기"를 눌러서
 * 탭 목적지를 모를 때 쓰는 로직), `removeTabFromGroup` 은 호출부가 탭의 목적지를 이미 알고
 * 별도로 옮기는 중이라 그 병합이 필요 없다 — 오히려 병합하면 탭이 두 곳에 동시에 실린다.
 */
function collapseEmptyGroup(layout: GroupLayout, groupId: string): GroupLayout {
  const groups = listGroups(layout.root)
  if (groups.length < 2) return layout
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
  const nextActive = listGroups(pruned).some((group) => group.groupId === layout.activeGroupId)
    ? layout.activeGroupId
    : (listGroups(pruned)[0]?.groupId ?? layout.activeGroupId)
  return { root: pruned, activeGroupId: nextActive }
}

/**
 * 탭 하나를 영역에서 뺀다 — 마지막 탭이면 그 영역째 접힌다(LIFE-387 §1-A `lastTabOut`).
 *
 * 드래그·크로스그룹 이동/병합/분할이 전부 이 함수로 "원 영역에서 뗀다" 단계를 공유한다.
 */
export function removeTabFromGroup(layout: GroupLayout, groupId: string, tabId: string): GroupLayout {
  const group = findGroup(layout.root, groupId)
  if (group === null || !group.tabOrder.includes(tabId)) return layout
  const remaining = group.tabOrder.filter((id) => id !== tabId)
  const updated = updateGroup(layout, groupId, (g) => ({
    ...g,
    tabOrder: remaining,
    activeTabId: g.activeTabId === tabId ? (remaining[0] ?? null) : g.activeTabId,
  }))
  if (remaining.length > 0) return updated
  return collapseEmptyGroup(updated, groupId)
}

/**
 * 탭바 안 드롭 — 같은 영역이면 순서만, 다른 영역이면 이동까지 (LIFE-387 §4 "탭바 재정렬"/"탭바 이동").
 *
 * `index` 는 **목적지 영역의 드롭 이후 tabOrder 기준** 삽입 위치(0 ~ length). 같은 영역 재정렬은
 * 드래그 중이던 탭을 먼저 빼고 나서 그 인덱스에 넣는다 — 그래야 "탭 셋 중 가운데를 맨 끝으로"
 * 같은 이동에서 index 셈이 어긋나지 않는다.
 */
export function moveTabWithinTabbar(
  layout: GroupLayout,
  input: { tabId: string; fromGroupId: string; toGroupId: string; index: number },
): GroupLayout {
  if (input.fromGroupId === input.toGroupId) {
    return updateGroup(layout, input.toGroupId, (g) => {
      const without = g.tabOrder.filter((id) => id !== input.tabId)
      const at = Math.max(0, Math.min(input.index, without.length))
      return { ...g, tabOrder: [...without.slice(0, at), input.tabId, ...without.slice(at)], activeTabId: input.tabId }
    })
  }
  const from = findGroup(layout.root, input.fromGroupId)
  if (from === null || !from.tabOrder.includes(input.tabId)) return layout
  if (findGroup(layout.root, input.toGroupId) === null) return layout

  const removed = removeTabFromGroup(layout, input.fromGroupId, input.tabId)
  const inserted = updateGroup(removed, input.toGroupId, (g) => {
    const at = Math.max(0, Math.min(input.index, g.tabOrder.length))
    return { ...g, tabOrder: [...g.tabOrder.slice(0, at), input.tabId, ...g.tabOrder.slice(at)], activeTabId: input.tabId }
  })
  return { ...inserted, activeGroupId: input.toGroupId }
}

/**
 * 다른 영역으로 병합 — 본문 중앙 드롭·빈 영역 드롭·"다른 영역으로 옮기기" 메뉴가 전부 이 함수를
 * 쓴다(LIFE-387 §4 "병합"). 대상 tabOrder 끝에 붙인다. 같은 영역이면 no-op(제 영역 중앙 드롭).
 */
export function mergeTabIntoGroup(
  layout: GroupLayout,
  input: { tabId: string; fromGroupId: string; toGroupId: string },
): GroupLayout {
  if (input.fromGroupId === input.toGroupId) return layout
  const from = findGroup(layout.root, input.fromGroupId)
  if (from === null || !from.tabOrder.includes(input.tabId)) return layout
  if (findGroup(layout.root, input.toGroupId) === null) return layout

  const removed = removeTabFromGroup(layout, input.fromGroupId, input.tabId)
  const merged = updateGroup(removed, input.toGroupId, (g) => ({
    ...g,
    tabOrder: g.tabOrder.includes(input.tabId) ? g.tabOrder : [...g.tabOrder, input.tabId],
    activeTabId: input.tabId,
  }))
  return { ...merged, activeGroupId: input.toGroupId }
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
  const withOrphans =
    orphans.length === 0
      ? pruned
      : mapGroup(pruned, landing.groupId, (group) => ({
          ...group,
          tabOrder: [...group.tabOrder, ...orphans],
          activeTabId: group.activeTabId ?? orphans[0] ?? null,
        }))
  /**
   * 마지막 탭을 **닫아서**(×) 영역이 비어도 접는다 — 기존 결정("닫기는 영역을 남긴다")을
   * 사용자가 뒤집었다(게이트 ① 수정, 04-manual-check-notes.md §5). 드래그로 끌어냈을 때
   * (`removeTabFromGroup`)와 같은 결로 맞춘다 — 영역이 하나뿐이면 접지 않는다(`collapseEmptyGroup`
   * 과 같은 하한선, `dropEmptyLeaves` 가 트리 전체를 지워버리면 `?? withOrphans` 로 되돌린다).
   * 어느 영역이 비든(방금 분리로 만든 것이든 원래 있던 것이든) 똑같이 접는다 — "방금 만든 영역만"
   * 으로 좁힐 근거가 없다(사용자 표현 "원래대로 돌아가면 좋을듯"은 일반 규칙으로 읽었다).
   *
   * **orphans 를 얹은 뒤에** 접어야 한다 — 얹기 전에 접으면(복원 실패 회차처럼 전부 비어 있다가
   * 착지 그룹에만 나중에 orphans 가 꽂히는 경우) 착지 그룹이 아직 비어 보여서 통째로 사라지고,
   * 정작 진짜로 계속 비어 있는 다른 그룹은 그 시점엔 안 지워진다.
   */
  const dropEmptyLeaves = (node: GroupNode): GroupNode | null => {
    switch (node.kind) {
      case 'leaf':
        return node.group.tabOrder.length === 0 ? null : node
      case 'split': {
        const first = dropEmptyLeaves(node.first)
        const second = dropEmptyLeaves(node.second)
        if (first === null) return second
        if (second === null) return first
        return first === node.first && second === node.second ? node : { ...node, first, second }
      }
    }
  }
  const root = dropEmptyLeaves(withOrphans) ?? withOrphans
  const finalGroups = listGroups(root)
  /**
   * 활성 영역도 **착지점을 따라간다** (§10-R32-1) — 단, 접힌 뒤에는 그 착지 그룹이 실제로
   * 남아 있는지 다시 확인한다(collapse 로 사라졌을 수 있다).
   */
  const preferredActiveGroupId = restoreFailed ? landing.groupId : input.layout.activeGroupId
  const activeGroupId = finalGroups.some((group) => group.groupId === preferredActiveGroupId)
    ? preferredActiveGroupId
    : (finalGroups.some((group) => group.groupId === head.groupId) ? head.groupId : (finalGroups[0]?.groupId ?? head.groupId))
  return { root, activeGroupId }
}

/**
 * herdr 에 이제 없는 탭을 **저장 배치**에서 걷는다 (LIFE-507). 남은 탭이 하나도 없으면 null — 그 worktree 의 배치를 버린다(다음에 열면 한 영역).
 *
 * `reconcileLayout` 의 「뼈대는 두고 첫 영역으로」 는 tabId 가 통째로 바뀌는 재기동을 위한 화면용 파생이다. 그런데 herdr 0.9.0 은 닫힌
 * 워크스페이스의 id 를 재기동 뒤 다시 쓴다(00-analysis F2) — 옛 배치를 남겨 두면 같은 worktree 를 다시 연 새 탭(`w2:t1` …)이 옛 영역 자리에
 * 그대로 앉는다. 근거 `herdrTabIds` 는 herdr 세션 전체의 산 탭(링크 live 일 때만)이라 덜 온 상태에 지우지 않는다.
 * 산 탭만으로 `reconcileLayout` 을 돌린다 — 넘기는 목록이 배치 안 탭의 부분집합이라 고아(새로 끌어들일 탭)가 없고, 빈 영역만 접힌다.
 */
export function dropDeadTabs(input: { layout: GroupLayout; herdrTabIds: ReadonlySet<string> }): GroupLayout | null {
  const held = listGroups(input.layout.root).flatMap((group) => group.tabOrder)
  const kept = held.filter((tabId) => input.herdrTabIds.has(tabId))
  if (kept.length === 0) return null
  if (kept.length === held.length) return input.layout
  return reconcileLayout({ layout: input.layout, liveTabIds: kept })
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

// --- 핀 접두부 (LIFE-495 K3ⓓ) ------------------------------------------------------

/**
 * 모든 영역에서 핀 탭을 `tabOrder` 의 **맨 앞 연속 구간**으로 모은다 — 안정 분할(핀끼리·나머지끼리 상대 순서 유지).
 *
 * 220 은 이 분할을 pin/unpin·새 탭 때만 하고 드래그·다시 열기에서는 안 해서 핀 탭이 핀 아닌 탭 뒤로 갈 수 있다(#12928 류,
 * 00-analysis F2). corral 은 **배치를 읽고 바꾸는 모든 길**(`useGroupLayout` 의 파생·`mutate`)에서 이 함수를 지나게 해 한 자리에서
 * 지킨다. 그러면 규칙이 저절로 나온다:
 *   · pin   — 그 탭은 핀 구간 **끝**으로(이미 핀 구간 뒤에 있던 탭이라 안정 분할이 거기 놓는다)
 *   · unpin — 남은 핀 탭 바로 뒤 = 첫 핀 아닌 자리로
 *   · 드래그·다시 열기·병합 — 경계를 넘은 탭은 **경계에 붙는다**
 * 핀은 탭에 붙어 다닌다(id 키) — 다른 영역으로 옮겨도 핀이고 그 영역의 핀 구간 끝에 선다(U6).
 * 바뀐 영역이 없으면 같은 객체를 돌려준다(리렌더·저장 비교가 안 흔들린다).
 */
export function partitionPinnedLayout(input: { layout: GroupLayout; pinned: ReadonlySet<string> }): GroupLayout {
  const { layout, pinned } = input
  if (pinned.size === 0) return layout
  const apply = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf': {
        const order = partitionPinnedOrder({ tabOrder: node.group.tabOrder, pinned })
        return order === node.group.tabOrder ? node : leaf({ ...node.group, tabOrder: order })
      }
      case 'split': {
        const first = apply(node.first)
        const second = apply(node.second)
        return first === node.first && second === node.second ? node : { ...node, first, second }
      }
    }
  }
  const root = apply(layout.root)
  return root === layout.root ? layout : { ...layout, root }
}

export function partitionPinnedOrder(input: { tabOrder: string[]; pinned: ReadonlySet<string> }): string[] {
  const { tabOrder, pinned } = input
  const head = tabOrder.filter((tabId) => pinned.has(tabId))
  if (head.length === 0) return tabOrder
  const next = [...head, ...tabOrder.filter((tabId) => !pinned.has(tabId))]
  return next.every((tabId, index) => tabId === tabOrder[index]) ? tabOrder : next
}

/**
 * 탭을 그 영역의 그 자리로 옮긴다 (LIFE-495 K6 다시 열기의 자리 복원). 자리는 0~길이로 clamp, 영역이 없거나 탭이 배치에 없으면 그대로다.
 * 핀 구간 안쪽 자리는 부르는 쪽의 `partitionPinnedLayout` 이 경계로 민다.
 */
export function placeTab(input: { layout: GroupLayout; tabId: string; groupId: string; index: number }): GroupLayout {
  const { layout } = input
  const from = groupOfTab(layout.root, input.tabId)
  if (from === null || findGroup(layout.root, input.groupId) === null) return layout
  return moveTabWithinTabbar(layout, { tabId: input.tabId, fromGroupId: from.groupId, toGroupId: input.groupId, index: input.index })
}
