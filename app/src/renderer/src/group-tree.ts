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
import { DIFF_TAB_PREFIX } from '../../shared/scm.js'

/** 한 영역 — Orca `TabGroup` 과 동형 (§10-R3-c: 영역이 자기 탭 목록을 소유한다). */
export type TabGroup = {
  groupId: string
  /** 이 영역에 **배정된** 탭들. 한 탭은 한 영역에만 있다 (R3-c). */
  tabOrder: string[]
  /** 영역마다 독립된 활성 탭 (R3-a) — 포커스 pane 에서 파생시키지 않는다. */
  activeTabId: string | null
  /**
   * 이 영역의 **미리보기 파일 탭**(LIFE-590 E2 — 영역당 하나, 이탤릭, 다른 파일 한 번 클릭이 이 자리를 교체한다). 없으면 null·생략.
   * `tabOrder` 에 없는 값은 미리보기가 아니다(`file-tabs.ts` `previewOf` 가 확인한다). 터미널 탭은 미리보기가 될 수 없다.
   */
  previewTabId?: string | null
  /**
   * 이 영역의 **탭 MRU**(LIFE-691 R3) — 활성이 된 순서, 끝이 가장 최근. 활성 탭이 영역을 떠나면 여기서 다음 활성을 고른다(`nextActiveAfterLeave`).
   * **메모리 전용**이다 — 저장 때 `withoutRecentTabs` 로 빼고 `readNode` 도 읽지 않는다(`LAYOUT_FORMAT` 무변경). 재기동 직후엔 없다 → 이웃 폴백.
   * 기록은 `trackRecentTabs` 한 자리(`useGroupLayout` 의 `mutate`)에서만 한다.
   */
  recentTabIds?: string[]
}

/**
 * 파일 탭 id 접두사 (LIFE-590 — 종류 구분은 `file-tabs.ts`). 여기 두는 이유: 살아 있는 탭 추리기(`reconcileLayout`·`dropDeadTabs`)가
 * 파일 탭을 herdr 와 무관하게 살려 둬야 한다 — 파일 탭은 **배치에 있으면 열려 있다**.
 */
export const FILE_TAB_PREFIX = 'file:'

/**
 * 배치가 소유하는 편집기 탭인가 — 파일 탭(`file:`)과 diff 탭(`diff:`, LIFE-683). 둘 다 herdr 에 없고 pane 이 없다.
 * 종류를 가르는 것은 `file-tabs.ts` `tabKindOf` 다.
 */
export function isFileTabId(tabId: string): boolean {
  return (tabId.startsWith(FILE_TAB_PREFIX) && tabId.length > FILE_TAB_PREFIX.length) || (tabId.startsWith(DIFF_TAB_PREFIX) && tabId.length > DIFF_TAB_PREFIX.length)
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
 * 활성 탭이 영역을 떠난 뒤(닫기·옮기기) 그 영역의 다음 활성 탭 (LIFE-691 R1·R2 — Orca `tab-group-state.ts` 와 같은 규칙).
 *
 * `group` 은 **떠나기 전** 영역이다 — 이웃은 떠나기 전 `tabOrder` 로 센다. `kept` = 떠난 뒤 남는 탭(한 번에 여럿이 떠날 수 있다 — `reconcileLayout`).
 *   · 활성 탭이 남아 있으면 그대로(R2)
 *   · MRU 에서 남은 탭 중 가장 최근(R1)
 *   · 없으면 떠난 활성 탭 자리의 오른쪽에서 가장 가까운 남은 탭 → 왼쪽에서 가장 가까운 남은 탭
 * 활성이 없거나 `tabOrder` 에 없던 값이면 남은 첫 탭이다(전과 같다).
 */
export function nextActiveAfterLeave(input: { group: TabGroup; kept: readonly string[] }): string | null {
  const { group, kept } = input
  const active = group.activeTabId
  if (active !== null && kept.includes(active)) return active
  if (active === null) return kept[0] ?? null
  const recent = [...(group.recentTabIds ?? [])].reverse().find((tabId) => kept.includes(tabId))
  if (recent !== undefined) return recent
  const at = group.tabOrder.indexOf(active)
  if (at < 0) return kept[0] ?? null
  const right = group.tabOrder.slice(at + 1).find((tabId) => kept.includes(tabId))
  const left = group.tabOrder.slice(0, at).reverse().find((tabId) => kept.includes(tabId))
  return right ?? left ?? null
}

/**
 * 영역마다 탭 MRU 를 맞춘다 (LIFE-691 R3) — 활성 탭을 끝으로, 그 영역 `tabOrder` 에 없는 탭(떠난 탭)은 뺀다. 바뀐 영역이 없으면 같은 객체.
 *
 * 활성 탭을 바꾸는 길(클릭·파일 열기·⌃1–9·⌘⇧[ ]·reveal·MRU 전환·탭바 이동·옮겨 온 탭)이 전부 `useGroupLayout` 의 `mutate` 를 지나므로 거기서
 * 바꾸기 **전**에 한 번 부르면 기록이 빠지지 않는다 — 재기동 직후 저장값의 활성 탭도 든다. 바꾼 뒤의 활성은 다음 `mutate` 의 「전」이 넣는다
 * (그 사이 그 탭이 떠나도 떠난 탭은 `nextActiveAfterLeave` 의 후보가 아니라 차이가 없다 — LIFE-691 f1 E 에서 「뒤」 호출을 뺐다).
 */
export function trackRecentTabs(layout: GroupLayout): GroupLayout {
  const apply = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf': {
        const { group } = node
        const previous = group.recentTabIds ?? []
        const active = group.activeTabId
        const kept = previous.filter((tabId) => tabId !== active && group.tabOrder.includes(tabId))
        const next = active !== null && group.tabOrder.includes(active) ? [...kept, active] : kept
        const same = next.length === previous.length && next.every((tabId, index) => tabId === previous[index])
        return same && group.recentTabIds !== undefined ? node : leaf({ ...group, recentTabIds: next })
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

/** 저장할 배치 — 메모리 전용 MRU(`recentTabIds`)를 뺀다(LIFE-691 K5, 저장 JSON 에 새 칸 없음). 뺄 것이 없으면 같은 객체. */
export function withoutRecentTabs(layout: GroupLayout): GroupLayout {
  const apply = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf': {
        if (node.group.recentTabIds === undefined) return node
        // 저장 모양(`readNode` 가 읽는 칸)만 남긴다.
        const { groupId, tabOrder, activeTabId, previewTabId } = node.group
        return leaf({ groupId, tabOrder, activeTabId, ...(previewTabId === undefined ? {} : { previewTabId }) })
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

/**
 * 탭이 하나뿐인 영역에서 «새 영역으로 옮기기»가 안 되는 이유 — **한 곳에서만 쓴다** (§10-R35-2).
 *
 * 탭 메뉴는 항목을 흐리고 이 문구를 `title` 로 달았는데 키보드(`⌘⌥D`)는 **아무 말도 안 했다**
 * (부류 ④ 무음 실패). 두 경로가 같은 사실을 말하므로 문구도 한 자리에서 가져간다.
 */
export const ONE_TAB_IN_GROUP = '이 영역에 탭이 하나뿐이다'

/** 영역 최대화·균등화가 안 되는 이유 (LIFE-825 C3·C4ⓖ) — 키·팔레트·⊞ 메뉴가 같은 문구를 쓴다. */
export const ONE_GROUP = '영역이 하나뿐이다'

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
          ...(node.group.previewTabId === input.tabId ? { previewTabId: null } : {}),
          tabOrder: remaining,
          // 빠져나간 탭이 활성이었으면 MRU → 오른쪽 → 왼쪽 이웃 (LIFE-691 R1 — 닫기와 같은 규칙).
          activeTabId: nextActiveAfterLeave({ group: node.group, kept: remaining }),
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
    activeTabId: nextActiveAfterLeave({ group: g, kept: remaining }),
    // 미리보기 탭이 영역을 떠나면 그 영역의 미리보기 표시도 걷는다 — 옮긴 곳에서는 고정 탭이다(LIFE-590, 이동 = 고정).
    ...(g.previewTabId === tabId ? { previewTabId: null } : {}),
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
      // 같은 탭바 안에서 끌어도 미리보기는 고정된다(VS Code·E10 답 ⑤ — 수정 r1 R1-C). 다른 영역 이동은 `removeTabFromGroup` 이 걷는다.
      return { ...g, tabOrder: [...without.slice(0, at), input.tabId, ...without.slice(at)], activeTabId: input.tabId, ...(g.previewTabId === input.tabId ? { previewTabId: null } : {}) }
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
 * 닫는 영역의 탭·활성이 갈 영역 (LIFE-825 C1·P1 — VS Code `doRemoveGroupWithEditors`). 영역이 하나뿐이거나 모르는 영역이면 null.
 *   · 영역 MRU(`recent`, 앞이 최근)에서 닫는 영역 다음으로 최근인 살아 있는 영역 — 닫는 영역이 활성이면 MRU 둘째, 아니면 첫째(= 활성 영역)
 *   · MRU 에 후보가 없으면(재기동 직후 등) **공간 이웃** — 닫는 영역 자리를 차지하는 형제 쪽에서 닫는 영역과 맞닿은 영역(`neighborGroupId`, 겹침 최대·동점 위·왼쪽)
 */
export function closeGroupHeir(input: { root: GroupNode; groupId: string; recent: readonly string[] }): string | null {
  const live = listGroups(input.root).map((group) => group.groupId)
  if (live.length < 2 || !live.includes(input.groupId)) return null
  const recent = input.recent.find((groupId) => groupId !== input.groupId && live.includes(groupId))
  if (recent !== undefined) return recent
  const side = siblingSideOf({ node: input.root, groupId: input.groupId })
  return side === null ? null : neighborGroupId({ root: input.root, groupId: input.groupId, direction: side })
}

/** 그 영역(리프)의 형제가 어느 쪽에 있나 — 부모 분할이 row 면 앞 = 오른쪽 형제, 뒤 = 왼쪽 형제. column 이면 아래·위. 루트 리프면 null. */
function siblingSideOf(input: { node: GroupNode; groupId: string }): GroupDirection | null {
  const { node, groupId } = input
  if (node.kind === 'leaf') return null
  const isTarget = (child: GroupNode): boolean => child.kind === 'leaf' && child.group.groupId === groupId
  if (isTarget(node.first)) return node.direction === 'row' ? 'right' : 'down'
  if (isTarget(node.second)) return node.direction === 'row' ? 'left' : 'up'
  return siblingSideOf({ node: node.first, groupId }) ?? siblingSideOf({ node: node.second, groupId })
}

/**
 * 영역을 없애고 형제가 자리를 차지한다 (F1-5). 영역이 하나면 무효.
 *
 * 남아 있던 탭은 **받는 영역**(`closeGroupHeir` — 영역 MRU → 공간 이웃, LIFE-825 C1)의 `tabOrder` 끝으로 넘긴다 — 영역을 닫는 것이 탭을 닫는 것이 되면 안 된다.
 * 닫는 영역이 활성이었으면 받는 영역이 활성이 되고, 닫는 영역의 활성 탭이 받는 영역의 활성 탭이 된다(C1ⓒ). 활성이 아니었으면 받는 영역의 활성 탭은 그대로다.
 * `recent` 를 안 주면 MRU 없음 — 공간 이웃이다.
 */
export function closeGroup(layout: GroupLayout, groupId: string, options?: { recent?: readonly string[] }): GroupLayout {
  const groups = listGroups(layout.root)
  if (groups.length < 2) return layout
  const closing = groups.find((group) => group.groupId === groupId)
  if (closing === undefined) return layout
  const heirId = closeGroupHeir({ root: layout.root, groupId, recent: options?.recent ?? [] })
  if (heirId === null) return layout
  const wasActive = layout.activeGroupId === groupId

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

  const withTabs =
    adopted.length === 0
      ? pruned
      : mapGroup(pruned, heirId, (group) => ({
          ...group,
          tabOrder: [...group.tabOrder, ...adopted.filter((tabId) => !group.tabOrder.includes(tabId))],
          activeTabId: wasActive && closing.activeTabId !== null ? closing.activeTabId : (group.activeTabId ?? (adopted[0] ?? null)),
        }))

  return { root: withTabs, activeGroupId: wasActive ? heirId : layout.activeGroupId }
}

/**
 * 같은 방향 줄의 한 분할 마디가 가질 비율 — 앞 쪽에 든 줄 칸 수 / 이 마디 아래 줄 칸 수 (LIFE-825 C2·C3). 줄 칸 = 같은 방향 분할을 따라 내려가 만나는
 * 리프·반대 방향 분할(VS Code grid branch 의 자식). 줄의 모든 마디에 이 값을 주면 칸마다 1/n 이 된다. `RATIO_MIN·MAX` 는 `setRatio` 와 같이 클램프한다.
 */
function evenRatioOf(node: { direction: 'row' | 'column'; first: GroupNode; second: GroupNode }): number {
  const cells = (child: GroupNode): number => (child.kind === 'split' && child.direction === node.direction ? cells(child.first) + cells(child.second) : 1)
  const first = cells(node.first)
  return clampRatio(first / (first + cells(node.second)))
}

/** 줄의 분할 마디들(같은 방향으로 이어진 것)에 균등 비율을 준다. 반대 방향 분할 아래는 건드리지 않는다. */
function evenRun(node: GroupNode, direction: 'row' | 'column'): GroupNode {
  if (node.kind === 'leaf' || node.direction !== direction) return node
  const first = evenRun(node.first, direction)
  const second = evenRun(node.second, direction)
  const ratio = evenRatioOf(node)
  return ratio === node.ratio && first === node.first && second === node.second ? node : { ...node, ratio, first, second }
}

/**
 * 경계 더블클릭 리셋 (LIFE-825 C2 — VS Code `grid.ts` `onDidSashReset` → `distributeViewSizes(parentLocation)`, 재귀 아님): 그 경계(`splitId`)를 가진
 * **같은 방향 줄**의 칸들을 같은 크기로. 줄의 맨 위 마디 = 그 마디에서 같은 방향 부모를 따라 올라간 끝. 다른 줄은 그대로. 바뀐 것이 없으면 같은 객체.
 */
export function evenGroupRunAt(layout: GroupLayout, splitId: string): GroupLayout {
  const apply = (node: GroupNode, parentDirection: 'row' | 'column' | null): GroupNode => {
    if (node.kind === 'leaf') return node
    if (node.direction !== parentDirection && runContains(node, splitId)) return evenRun(node, node.direction)
    const first = apply(node.first, node.direction)
    const second = apply(node.second, node.direction)
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  const root = apply(layout.root, null)
  return root === layout.root ? layout : { ...layout, root }
}

/** 그 줄(같은 방향으로 이어진 마디들) 안에 그 분할이 있나. */
function runContains(node: GroupNode, splitId: string): boolean {
  if (node.kind === 'leaf') return false
  if (splitIdOf(node) === splitId) return true
  const inRun = (child: GroupNode): boolean => child.kind === 'split' && child.direction === node.direction && runContains(child, splitId)
  return inRun(node.first) || inRun(node.second)
}

/** 영역 크기 균등화 (LIFE-825 C3 — VS Code `evenEditorWidths` → `distributeViewSizes()` 재귀): **모든** 같은 방향 줄을 고르게. 바뀐 것이 없으면 같은 객체. */
export function evenAllGroups(layout: GroupLayout): GroupLayout {
  const apply = (node: GroupNode): GroupNode => {
    if (node.kind === 'leaf') return node
    const first = apply(node.first)
    const second = apply(node.second)
    const ratio = evenRatioOf(node)
    return ratio === node.ratio && first === node.first && second === node.second ? node : { ...node, ratio, first, second }
  }
  const root = apply(layout.root)
  return root === layout.root ? layout : { ...layout, root }
}

/**
 * 배치 **모양** 키 (LIFE-825 C4) — 영역 id 와 분할 방향만, 비율·탭은 뺀다. 영역 최대화는 이 키가 바뀌면(분할·닫기·끌어서 영역 생성·접힘) 풀린다.
 */
export function layoutShapeKey(node: GroupNode): string {
  switch (node.kind) {
    case 'leaf':
      return node.group.groupId
    case 'split':
      return `${node.direction}(${layoutShapeKey(node.first)},${layoutShapeKey(node.second)})`
  }
}

/** 메모리 전용 영역 최대화 기록 (LIFE-825 C4 — 저장 배치 밖). `shape` = 최대화한 순간의 `layoutShapeKey`. */
export type GroupMaximize = { groupId: string; shape: string }

/**
 * 지금 화면에서 최대화된 영역 (C4ⓔ 해제 조건을 한 자리에서): 기록이 있고 · 영역이 둘 이상이고 · 모양이 그대로이고 · 그 영역이 **활성**일 때만.
 * 숨은 영역이 활성되면(⌘⌥방향·⌃`·⌃Tab·reveal·사이드바 세션 클릭 …) 활성이 바뀌어 풀린다(VS Code `doRestoreGroup`). 아니면 null.
 */
export function maximizedGroupOf(input: { layout: GroupLayout; maximize: GroupMaximize | undefined }): string | null {
  const { layout, maximize } = input
  if (maximize === undefined) return null
  if (listGroups(layout.root).length < 2) return null
  if (layoutShapeKey(layout.root) !== maximize.shape) return null
  return layout.activeGroupId === maximize.groupId ? maximize.groupId : null
}

/** 새 터미널 탭 자리 (LIFE-825 C5·P6) — 요청한 순간의 활성 영역과 그 활성 탭(없으면 null = 영역 끝). */
export type NewTabSlot = { groupId: string; afterTabId: string | null }

/** 요청한 순간의 자리를 잡는다 — 그 worktree 배치의 활성 영역·활성 탭. */
export function newTabSlotOf(layout: GroupLayout): NewTabSlot | null {
  const group = findGroup(layout.root, layout.activeGroupId)
  if (group === null) return null
  return { groupId: group.groupId, afterTabId: group.activeTabId }
}

/**
 * 도착한 새 탭을 기억한 자리로 놓을 곳 (C5ⓐⓑ) — 영역이 있으면 그 영역에서 기억한 탭 바로 오른쪽(그 탭이 사라졌으면 그 영역의 지금 활성 탭 오른쪽, 그것도 없으면 끝).
 * 기억한 영역이 사라졌으면 null — 도착 때 자리(`reconcileLayout` 고아 착지 = 활성 영역·활성 탭 오른쪽) 그대로 둔다. `index` 는 `placeTab` 의 뜻(새 탭을 뺀 순서 기준).
 */
export function newTabPlacement(input: { layout: GroupLayout; slot: NewTabSlot; tabId: string }): { groupId: string; index: number } | null {
  const group = findGroup(input.layout.root, input.slot.groupId)
  if (group === null) return null
  const order = group.tabOrder.filter((tabId) => tabId !== input.tabId)
  const after = [input.slot.afterTabId, group.activeTabId === input.tabId ? null : group.activeTabId].find((tabId) => tabId !== null && order.includes(tabId)) ?? null
  return { groupId: group.groupId, index: after === null ? order.length : order.indexOf(after) + 1 }
}

/** 탭 목록에서 `after` 바로 오른쪽에 `added` 를 끼운다(없으면 끝). 순수 — 고아 착지(`reconcileLayout`)가 쓴다. */
function insertAfter(input: { tabOrder: readonly string[]; after: string | null; added: readonly string[] }): string[] {
  const at = input.after === null ? -1 : input.tabOrder.indexOf(input.after)
  if (at < 0) return [...input.tabOrder, ...input.added]
  return [...input.tabOrder.slice(0, at + 1), ...input.added, ...input.tabOrder.slice(at + 1)]
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
export function reconcileLayout(input: { layout: GroupLayout; liveTabIds: string[]; pinned?: ReadonlySet<string> }): GroupLayout {
  // 핀이 있으면 **화면 순서**(핀 접두부)로 먼저 맞춘다 — 닫힌 활성 탭의 이웃은 사용자가 보던 이웃이다(LIFE-691 f1 B). 핀이 없거나 이미 맞으면 같은 객체.
  const layout = input.pinned === undefined ? input.layout : partitionPinnedLayout({ layout: input.layout, pinned: input.pinned })
  const live = new Set(input.liveTabIds)
  const seen = new Set<string>()
  /** 맞은 **터미널** 탭 수 — 복원 실패 판정은 herdr 탭으로만 한다(파일 탭은 herdr 재기동과 무관하게 늘 맞는다 — LIFE-590). */
  let matchedTerminals = 0
  const prune = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf': {
        // 파일 탭(LIFE-590)은 herdr 목록과 무관하게 남긴다 — 배치에 있으면 열려 있다. 중복만 걷는다.
        const tabOrder = node.group.tabOrder.filter((tabId) => {
          const file = isFileTabId(tabId)
          if ((!file && !live.has(tabId)) || seen.has(tabId)) return false
          seen.add(tabId)
          if (!file) matchedTerminals += 1
          return true
        })
        // 활성 탭이 닫혔으면 MRU → 오른쪽 → 왼쪽 이웃 (LIFE-691 R1). 활성이 없던 영역은 전처럼 첫 탭.
        const activeTabId = nextActiveAfterLeave({ group: node.group, kept: tabOrder })
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
  const pruned = prune(layout.root)
  const groups = listGroups(pruned)
  const head = groups[0]
  if (head === undefined) return layout
  const orphans = input.liveTabIds.filter((tabId) => !seen.has(tabId))
  /**
   * 어디에도 없는 탭이 갈 곳 (R3-d).
   *
   * 보통은 **포커스 영역**이다 — 새 탭·사이드바에서 연 탭이 여기로 들어온다. 다만 **하나도
   * 안 맞은 회차**(herdr 재기동으로 tabId 가 통째로 바뀐 경우)는 "새 탭이 왔다"가 아니라
   * "복원이 실패했다" 이므로 R3-d 의 뒷문장대로 **첫 영역**으로 모은다.
   */
  const restoreFailed = matchedTerminals === 0 && orphans.length > 0
  const landing = restoreFailed
    ? head
    : (groups.find((group) => group.groupId === layout.activeGroupId) ?? head)
  const withOrphans =
    orphans.length === 0
      ? pruned
      : mapGroup(pruned, landing.groupId, (group) => ({
          ...group,
          // LIFE-825 C5ⓒ — 새 탭(요청 없이 도착한 탭 포함)은 착지 영역의 **활성 탭 바로 오른쪽**(파일 탭 `openNewTabInGroup` 과 같은 규칙). 복원 실패 회차는 base 그대로 끝(C5ⓓ).
          tabOrder: restoreFailed ? [...group.tabOrder, ...orphans] : insertAfter({ tabOrder: group.tabOrder, after: group.activeTabId, added: orphans }),
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
  const preferredActiveGroupId = restoreFailed ? landing.groupId : layout.activeGroupId
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
export function dropDeadTabs(input: { layout: GroupLayout; herdrTabIds: ReadonlySet<string>; pinned?: ReadonlySet<string> }): GroupLayout | null {
  const held = listGroups(input.layout.root).flatMap((group) => group.tabOrder)
  // 파일 탭(LIFE-590)은 herdr 에 없어도 산다 — 파일 탭만 남은 worktree 배치도 버리지 않는다(E1ⓐ).
  const kept = held.filter((tabId) => input.herdrTabIds.has(tabId) || isFileTabId(tabId))
  if (kept.length === 0) return null
  if (kept.length === held.length) return input.layout
  return reconcileLayout({ layout: input.layout, liveTabIds: kept, pinned: input.pinned })
}

// --- 영속 (R3-h — worktree 단위) ------------------------------------------------

/**
 * 저장 모양. 트리를 그대로 싣는다 — 읽을 때 모양을 확인한다(손으로 고친 파일 대비).
 *
 * **형식 2 (LIFE-590)** — `tabOrder` 에 파일 탭 id(`file:<상대 경로>`)가 섞이고 리프 영역에 `previewTabId` 가 붙는다. 행마다 `layoutFormat: 2` 표지를 쓴다.
 *   · 구 형식(표지 없음 = 1)을 새 코드가 읽으면 그대로다 — 파일 탭이 없을 뿐 모양이 같다(E1ⓒ)
 *   · 새 형식을 **구 코드**(기준 `bd2fca411` 빌드)가 읽으면: `readNode` 가 모르는 칸(`previewTabId`·`layoutFormat`)을 버리고, 파일 탭 id 는 herdr 에 없는
 *     탭이라 `reconcileLayout`·`dropDeadTabs` 가 걷는다 — 터미널 탭 배치·핀·색(`tabMarks` 는 따로 산다)은 그대로다(E1ⓓ). 그래서 id 를 문자열로 유지했다
 *   · 표지는 읽을 때 쓰지 않는다(형식 1·2 가 같은 읽기로 풀린다) — 다음 형식 변경이 갈래를 나눌 자리다
 */
export type StoredGroupLayout = { worktreePath: string; layout: GroupLayout; layoutFormat?: number }

/** 지금 쓰는 저장 형식(위 주석). */
export const LAYOUT_FORMAT = 2

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
    const ids = tabOrder.filter((item): item is string => typeof item === 'string')
    const previewTabId = Reflect.get(group, 'previewTabId')
    return leaf({
      groupId,
      tabOrder: ids,
      activeTabId: typeof activeTabId === 'string' ? activeTabId : null,
      // 미리보기는 그 영역에 있는 파일 탭일 때만 싣는다(LIFE-590).
      ...(typeof previewTabId === 'string' && isFileTabId(previewTabId) && ids.includes(previewTabId) ? { previewTabId } : {}),
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

// --- 배치에 없던 탭을 놓는다 (LIFE-823 — 탐색기 파일 끌어서 열기·옆으로 열기) ---------------------------------------------
//
// 위 이동 함수(`moveTabWithinTabbar`·`mergeTabIntoGroup`·`splitGroupWithForeignTab`)는 **이미 어느 영역에 있는 탭**을 옮긴다.
// 아래 셋은 **배치 어디에도 없는 탭**을 새로 들인다 — 출발 영역이 없으니 원 영역 빼기·접기가 없고, 대상이 탭 1개·빈 영역이어도 된다.
// 탭이 이미 배치에 있으면(어느 영역이든) 배치를 그대로 돌려준다 — 같은 탭이 두 곳에 실리지 않는다. 이미 열린 탭의 처리는 부르는 쪽(`file-tabs.ts` `placeFileTab`)이 한다.

/** 배치 어디에든 그 탭이 있나. */
function hasTab(layout: GroupLayout, tabId: string): boolean {
  return groupOfTab(layout.root, tabId) !== null
}

/** 탭바 삽입 — 그 영역의 `index`(0 ~ 길이, 벗어나면 끝으로 clamp) 자리에 끼우고 그 영역·그 탭을 활성으로. */
export function insertNewTabAt(input: { layout: GroupLayout; tabId: string; groupId: string; index: number }): GroupLayout {
  const { layout, tabId } = input
  if (hasTab(layout, tabId) || findGroup(layout.root, input.groupId) === null) return layout
  const inserted = updateGroup(layout, input.groupId, (group) => {
    const at = Math.max(0, Math.min(input.index, group.tabOrder.length))
    return { ...group, tabOrder: [...group.tabOrder.slice(0, at), tabId, ...group.tabOrder.slice(at)], activeTabId: tabId }
  })
  return { ...inserted, activeGroupId: input.groupId }
}

/** 가운데 열기 — 그 영역의 활성 탭 바로 오른쪽(활성이 없으면 끝)에 넣고 그 영역·그 탭을 활성으로(VS Code `openPositioning: right`). */
export function openNewTabInGroup(input: { layout: GroupLayout; tabId: string; groupId: string }): GroupLayout {
  const group = findGroup(input.layout.root, input.groupId)
  if (group === null) return input.layout
  const activeAt = group.activeTabId === null ? -1 : group.tabOrder.indexOf(group.activeTabId)
  return insertNewTabAt({ layout: input.layout, tabId: input.tabId, groupId: input.groupId, index: activeAt < 0 ? group.tabOrder.length : activeAt + 1 })
}

/**
 * 가장자리 분할 — 대상 영역 옆(`direction`·`edge` 는 `splitGroup` 과 같은 뜻)에 그 탭 하나만 든 새 영역을 만들고 새 영역을 활성으로.
 * 대상 영역의 탭 수는 보지 않는다(탭 1개도 된다). 단 대상이 **빈 영역**이면 그 빈 형제는 화면 배치(`reconcileLayout` 의 빈 영역 접기)에서 접혀
 * 한 영역이 된다 — 그래서 탐색기 끌기는 빈 영역 가장자리를 분할로 판정하지 않는다(`tab-drag.ts` `resolveFileBodyDropTarget`, C1ⓑ 정정 r1).
 */
export function splitGroupWithNewTab(input: {
  layout: GroupLayout
  tabId: string
  targetGroupId: string
  direction: 'row' | 'column'
  edge: 'before' | 'after'
  newGroupId: string
}): GroupLayout {
  const { layout } = input
  if (hasTab(layout, input.tabId) || findGroup(layout.root, input.targetGroupId) === null || findGroup(layout.root, input.newGroupId) !== null) return layout
  const added = leaf({ groupId: input.newGroupId, tabOrder: [input.tabId], activeTabId: input.tabId })
  const replace = (node: GroupNode): GroupNode => {
    switch (node.kind) {
      case 'leaf':
        if (node.group.groupId !== input.targetGroupId) return node
        return input.edge === 'before'
          ? { kind: 'split', direction: input.direction, ratio: 0.5, first: added, second: node }
          : { kind: 'split', direction: input.direction, ratio: 0.5, first: node, second: added }
      case 'split': {
        const first = replace(node.first)
        const second = replace(node.second)
        return first === node.first && second === node.second ? node : { ...node, first, second }
      }
    }
  }
  return { root: replace(layout.root), activeGroupId: input.newGroupId }
}

/** 영역 사각형 — 루트를 단위 정사각형(0~1)으로 놓고 분할 비율로 나눈 자리. 화면 픽셀이 아니라 배치 모양만 본다. */
export type GroupRect = { left: number; top: number; width: number; height: number }

/** 영역마다 사각형 (LIFE-823 F2) — `ratio` 는 앞(`first`) 쪽 몫이다(`PaneGrid` 와 같다). row = 좌우, column = 위아래. */
export function groupRects(root: GroupNode): Map<string, GroupRect> {
  const rects = new Map<string, GroupRect>()
  const walk = (node: GroupNode, rect: GroupRect): void => {
    switch (node.kind) {
      case 'leaf':
        rects.set(node.group.groupId, rect)
        return
      case 'split': {
        const ratio = clampRatio(node.ratio)
        if (node.direction === 'row') {
          walk(node.first, { ...rect, width: rect.width * ratio })
          walk(node.second, { ...rect, left: rect.left + rect.width * ratio, width: rect.width * (1 - ratio) })
        } else {
          walk(node.first, { ...rect, height: rect.height * ratio })
          walk(node.second, { ...rect, top: rect.top + rect.height * ratio, height: rect.height * (1 - ratio) })
        }
        return
      }
    }
  }
  walk(root, { left: 0, top: 0, width: 1, height: 1 })
  return rects
}

/** 부동소수 비교 여유 — 비율 곱셈 오차. */
const RECT_EPSILON = 1e-9

/** 영역 이웃 방향 (LIFE-824 — ⌘⌥방향키 영역 이동). `PaneDirection` 과 같은 이름이다. */
export type GroupDirection = 'left' | 'right' | 'up' | 'down'

/**
 * 그 영역의 **d 쪽 이웃들** (LIFE-823 F2 → LIFE-824 네 방향 일반화 — VS Code `grid.ts` `getNeighborViews`): 기준 영역의 d 쪽 변에 맞닿은 변을 가졌고
 * 수직 구간(좌우면 세로, 위아래면 가로)이 **겹치는** 영역(끝점만 닿는 것은 이웃이 아니다). 겹친 길이(`overlap`)와 사각형을 같이 돌려준다 — 고르는 규칙은 `neighborGroupId`.
 */
export function neighborGroups(input: { root: GroupNode; groupId: string; direction: GroupDirection }): { groupId: string; overlap: number; rect: GroupRect }[] {
  const { groupId, direction } = input
  const rects = groupRects(input.root)
  const from = rects.get(groupId)
  if (from === undefined) return []
  const horizontal = direction === 'left' || direction === 'right'
  const neighbors: { groupId: string; overlap: number; rect: GroupRect }[] = []
  for (const [id, rect] of rects) {
    if (id === groupId) continue
    const touches =
      direction === 'right' ? Math.abs(rect.left - (from.left + from.width)) <= RECT_EPSILON
      : direction === 'left' ? Math.abs(rect.left + rect.width - from.left) <= RECT_EPSILON
      : direction === 'down' ? Math.abs(rect.top - (from.top + from.height)) <= RECT_EPSILON
      : Math.abs(rect.top + rect.height - from.top) <= RECT_EPSILON
    if (!touches) continue
    const overlap = horizontal
      ? Math.min(from.top + from.height, rect.top + rect.height) - Math.max(from.top, rect.top)
      : Math.min(from.left + from.width, rect.left + rect.width) - Math.max(from.left, rect.left)
    if (overlap > RECT_EPSILON) neighbors.push({ groupId: id, overlap, rect })
  }
  return neighbors
}

/**
 * d 쪽 **이웃 영역 하나** (LIFE-824 01-criteria 용어 「이웃 영역」) — 이웃들 중 겹침이 큰 것, 같으면 위(좌우 이동)·왼쪽(위아래 이동). 없으면 null(그 방향 끝).
 * 823 「옆으로 열기」의 `rightNeighborGroupId` 는 이 함수의 오른쪽 판이다(결과 무변경).
 */
export function neighborGroupId(input: { root: GroupNode; groupId: string; direction: GroupDirection }): string | null {
  const horizontal = input.direction === 'left' || input.direction === 'right'
  const sorted = [...neighborGroups(input)].sort((a, b) =>
    Math.abs(b.overlap - a.overlap) > RECT_EPSILON ? b.overlap - a.overlap : horizontal ? a.rect.top - b.rect.top : a.rect.left - b.rect.left,
  )
  return sorted[0]?.groupId ?? null
}

/** 그 영역의 **오른쪽 이웃들** (LIFE-823 F2) — `neighborGroups` 의 오른쪽 판. */
export function rightNeighborGroups(input: { root: GroupNode; groupId: string }): { groupId: string; overlap: number; rect: GroupRect }[] {
  return neighborGroups({ ...input, direction: 'right' })
}

/**
 * 「옆으로 열기」 대상 영역 (LIFE-823 P3·F2 — VS Code `SIDE_GROUP` 의 `findGroup({ direction: right })`). 오른쪽 이웃들 중 겹침이 큰 것, 같으면 위.
 * 이웃이 없으면(가장 오른쪽 열) null. VS Code 는 여럿이면 영역 MRU 로 고르지만 823 결과를 바꾸지 않으려고 여기는 겹침 규칙 그대로 둔다(영역 MRU 는 LIFE-824 `group-focus.ts`).
 */
export function rightNeighborGroupId(input: { root: GroupNode; groupId: string }): string | null {
  return neighborGroupId({ ...input, direction: 'right' })
}
