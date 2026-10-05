// 탭 메뉴·탭 단축키의 순수 계산 (LIFE-495 K1ⓔ·K2ⓔ·K7ⓙ).
//
// 대상은 언제나 **한 영역의 시각 순서**(`TabGroup.tabOrder`)다 — 다른 영역의 탭은 닫지도 고르지도 않는다(220 `useTabGroupCloseScopeCommands`
// 가 활성 group 의 `tabOrder` 로 자르는 것과 같다). 화면·IPC 는 이 파일 밖이다.

export type CloseScope = 'others' | 'right' | 'left'

/**
 * 「다른 탭 닫기 / 오른쪽 탭 닫기 / 왼쪽 탭 닫기」가 닫을 탭 (K2ⓐ) — **핀 탭은 뺀다**(220·VS Code 관례).
 * 기준 탭이 그 영역에 없으면 빈 목록이다.
 */
export function closeScopeTargets(input: { tabOrder: readonly string[]; tabId: string; scope: CloseScope; pinned: ReadonlySet<string> }): string[] {
  const index = input.tabOrder.indexOf(input.tabId)
  if (index === -1) return []
  const range =
    input.scope === 'others'
      ? input.tabOrder.filter((tabId) => tabId !== input.tabId)
      : input.scope === 'right'
        ? input.tabOrder.slice(index + 1)
        : input.tabOrder.slice(0, index)
  return range.filter((tabId) => !input.pinned.has(tabId))
}

/** 탭 메뉴의 항목 상태 (K1ⓔ·K2ⓑ·K3ⓑ) — 닫을 대상이 없으면 비활성이다(220 의 "활성인데 아무것도 안 함" 은 따르지 않는다, F5). */
export type TabMenuModel = {
  pinned: boolean
  canClose: boolean
  canCloseOthers: boolean
  canCloseRight: boolean
  canCloseLeft: boolean
  /** 새 영역으로 옮기기 — 영역에 탭이 하나뿐이면 빈 영역을 만드는 경로가 되므로 비활성(LIFE-373). */
  canMoveToNewGroup: boolean
}

export function tabMenuModel(input: { tabOrder: readonly string[]; tabId: string; pinned: ReadonlySet<string> }): TabMenuModel {
  const count = (scope: CloseScope): number => closeScopeTargets({ ...input, scope }).length
  const pinned = input.pinned.has(input.tabId)
  return {
    pinned,
    canClose: !pinned,
    canCloseOthers: count('others') > 0,
    canCloseRight: count('right') > 0,
    canCloseLeft: count('left') > 0,
    canMoveToNewGroup: input.tabOrder.length > 1,
  }
}

/** ⌘⇧[ ]·⌘⌥[ ]·⌃PgUp/Dn (K7ⓑⓒ) — 활성 영역 안에서 감긴다. 활성 탭이 없으면 첫(다음)·끝(이전) 탭. */
export function cycleTabTarget(input: { tabOrder: readonly string[]; activeTabId: string | null; direction: 1 | -1 }): string | null {
  const count = input.tabOrder.length
  if (count === 0) return null
  const index = input.activeTabId === null ? -1 : input.tabOrder.indexOf(input.activeTabId)
  if (index === -1) return input.tabOrder[input.direction === 1 ? 0 : count - 1] ?? null
  return input.tabOrder[(index + input.direction + count) % count] ?? null
}

/** ⌃1–9 (K7ⓓ) — 활성 영역의 N번째(0 기준 index). 없으면 null(no-op). ⌃9 는 9번째다 — 마지막 탭이 아니다(220 과 같다). */
export function tabAtIndex(input: { tabOrder: readonly string[]; index: number }): string | null {
  return input.tabOrder[input.index] ?? null
}
