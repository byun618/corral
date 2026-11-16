// 탭 메뉴·탭 단축키의 순수 계산 (LIFE-495 K1ⓔ·K2ⓔ·K7ⓙ).
//
// 대상은 언제나 **한 영역의 시각 순서**(`TabGroup.tabOrder`)다 — 다른 영역의 탭은 닫지도 고르지도 않는다(220 `useTabGroupCloseScopeCommands`
// 가 활성 group 의 `tabOrder` 로 자르는 것과 같다). 화면·IPC 는 이 파일 밖이다.
import { isFileTabId } from './group-tree.js'

/**
 * `all` = 모두 닫기(VS Code `closeAllEditors({ excludeSticky: true })`) · `saved` = 저장된 탭 닫기(`savedOnly` — 수정 안 된 파일·diff 탭만, 터미널 제외) — LIFE-822.
 */
export type CloseScope = 'others' | 'right' | 'left' | 'all' | 'saved'

/**
 * 「다른 / 오른쪽 / 왼쪽 탭 닫기 · 모두 닫기 · 저장된 탭 닫기」가 닫을 탭 (K2ⓐ) — **핀 탭은 뺀다**(220·VS Code 관례).
 * 기준 탭이 그 영역에 없으면 빈 목록이다. `dirty` = 수정된 파일 탭 id(「저장된 탭 닫기」만 본다, 없으면 빈 집합).
 */
export function closeScopeTargets(input: { tabOrder: readonly string[]; tabId: string; scope: CloseScope; pinned: ReadonlySet<string>; dirty?: ReadonlySet<string> }): string[] {
  const index = input.tabOrder.indexOf(input.tabId)
  if (index === -1) return []
  const dirty = input.dirty ?? new Set<string>()
  const range = ((): readonly string[] => {
    switch (input.scope) {
      case 'others':
        return input.tabOrder.filter((tabId) => tabId !== input.tabId)
      case 'right':
        return input.tabOrder.slice(index + 1)
      case 'left':
        return input.tabOrder.slice(0, index)
      case 'all':
        return input.tabOrder
      case 'saved':
        return input.tabOrder.filter((tabId) => isFileTabId(tabId) && !dirty.has(tabId))
    }
  })()
  return range.filter((tabId) => !input.pinned.has(tabId))
}

/** 탭 메뉴의 항목 상태 (K1ⓔ·K2ⓑ·K3ⓑ) — 닫을 대상이 없으면 비활성이다(220 의 "활성인데 아무것도 안 함" 은 따르지 않는다, F5). */
export type TabMenuModel = {
  pinned: boolean
  canClose: boolean
  canCloseOthers: boolean
  canCloseRight: boolean
  canCloseLeft: boolean
  /** LIFE-822 — 모두 닫기·저장된 탭 닫기. */
  canCloseAll: boolean
  canCloseSaved: boolean
  /** 새 영역으로 옮기기 — 영역에 탭이 하나뿐이면 빈 영역을 만드는 경로가 되므로 비활성(LIFE-373). */
  canMoveToNewGroup: boolean
}

export function tabMenuModel(input: { tabOrder: readonly string[]; tabId: string; pinned: ReadonlySet<string>; dirty?: ReadonlySet<string> }): TabMenuModel {
  const count = (scope: CloseScope): number => closeScopeTargets({ ...input, scope }).length
  const pinned = input.pinned.has(input.tabId)
  return {
    pinned,
    canClose: !pinned,
    canCloseOthers: count('others') > 0,
    canCloseRight: count('right') > 0,
    canCloseLeft: count('left') > 0,
    canCloseAll: count('all') > 0,
    canCloseSaved: count('saved') > 0,
    canMoveToNewGroup: input.tabOrder.length > 1,
  }
}

/** 닫기 확인 창이 이미 떠 있어 새 터미널 닫기 요청이 받아지지 않을 때의 안내(LIFE-822 fix1 R1-3 — 무음 대신). */
export const CLOSE_CONFIRM_PENDING = '닫기 확인 창이 이미 열려 있다 — 그 창에 먼저 답한 뒤 다시 닫는다'

/**
 * 범위 닫기의 대상을 종류별로 (LIFE-822) — 영역 순서에서 **herdr 에 없는 터미널 id 를 먼저 뺀다**(탭바가 그리는 칸과 같은 집합 — 메뉴 활성 판정과
 * 실행 대상이 같은 것을 본다, fix1 R1-3). 없는 id 를 닫기 요청에 넣으면 main 이 아무것도 안 닫고 끝나 파일만 남는 무음이 된다.
 */
export function mixedCloseTargets(input: {
  tabOrder: readonly string[]
  tabId: string
  scope: CloseScope
  pinned: ReadonlySet<string>
  dirty?: ReadonlySet<string>
  isLiveTerminal: (tabId: string) => boolean
}): { files: string[]; terminals: string[] } {
  const tabOrder = input.tabOrder.filter((tabId) => isFileTabId(tabId) || input.isLiveTerminal(tabId))
  const targets = closeScopeTargets({ tabOrder, tabId: input.tabId, scope: input.scope, pinned: input.pinned, ...(input.dirty === undefined ? {} : { dirty: input.dirty }) })
  return { files: targets.filter((tabId) => isFileTabId(tabId)), terminals: targets.filter((tabId) => !isFileTabId(tabId)) }
}

/**
 * 파일·터미널이 섞인 여러 탭 닫기의 순서 (LIFE-822 B7) — 수정 파일 확인 → 터미널 닫기 요청 → **요청한 터미널이 전부 닫힌 뒤** 파일 닫기.
 * 어느 확인에서든 취소면 파일은 하나도 닫지 않는다(옛 순서는 파일을 먼저 닫아, 터미널 실행 중 확인을 취소하면 파일만 닫힌 채 남았다).
 *   · `confirmFiles` 는 「저장 안 함」 을 결정만 한다 — 버리기는 `closeFiles` 가 실제로 닫을 때(fix1 R1-1)
 *   · `onClosed(closed)` 는 닫힌 터미널 id 를 준다 — 확인 뒤 닫다가 새 실행 중을 만나 일부만 닫히고 다시 묻다 취소·거절·오류로 끝나면 파일은 남는다
 *     (이미 닫힌 터미널은 되돌릴 수 없다, fix1 R1-2). 다시 물어 나머지가 닫히면 그때 파일을 닫는다 — 파일 닫기는 한 번만
 *   · 닫기 확인 창이 이미 떠 있으면 터미널 요청이 받아지지 않는다 — 묻기 전·후 둘 다 거르고 `onBusy` 로 알린다(무음 금지, fix1 R1-3)
 * 터미널 대상이 없으면 파일만 닫는다.
 */
export async function closeMixedTabs(input: {
  fileTabIds: readonly string[]
  terminalTabIds: readonly string[]
  terminalsBusy: () => boolean
  onBusy: () => void
  confirmFiles: (tabIds: readonly string[]) => Promise<boolean>
  closeTerminals: (request: { tabIds: readonly string[]; onClosed: (closed: readonly string[]) => void }) => void
  closeFiles: (tabIds: readonly string[]) => void
}): Promise<void> {
  const busy = (): boolean => input.terminalTabIds.length > 0 && input.terminalsBusy()
  if (busy()) {
    input.onBusy()
    return
  }
  if (input.fileTabIds.length > 0 && !(await input.confirmFiles(input.fileTabIds))) return
  if (busy()) {
    input.onBusy()
    return
  }
  if (input.terminalTabIds.length === 0) {
    input.closeFiles(input.fileTabIds)
    return
  }
  const closed = new Set<string>()
  let filesClosed = false
  input.closeTerminals({
    tabIds: input.terminalTabIds,
    onClosed: (ids) => {
      for (const tabId of ids) closed.add(tabId)
      if (filesClosed || !input.terminalTabIds.every((tabId) => closed.has(tabId))) return
      filesClosed = true
      input.closeFiles(input.fileTabIds)
    },
  })
}

/** ⌘⇧[ ]·⌘⌥[ ]·⌃PgUp/Dn (K7ⓑⓒ) — 활성 영역 안에서 감긴다. 활성 탭이 없으면 첫(다음)·끝(이전) 탭. */
export function cycleTabTarget(input: { tabOrder: readonly string[]; activeTabId: string | null; direction: 1 | -1 }): string | null {
  const count = input.tabOrder.length
  if (count === 0) return null
  const index = input.activeTabId === null ? -1 : input.tabOrder.indexOf(input.activeTabId)
  if (index === -1) return input.tabOrder[input.direction === 1 ? 0 : count - 1] ?? null
  return input.tabOrder[(index + input.direction + count) % count] ?? null
}

/**
 * 이전/다음 탭이 **영역을 넘는다** (LIFE-824 C5 — VS Code `workbench.action.nextEditor`·`OpenNextEditor.navigate`). 활성 영역 안에서 다음이 있으면 그것,
 * 끝이면 영역 순서(`listGroups` — 배치 트리 순서)의 다음 영역 **첫** 탭, 처음에서 이전이면 이전 영역의 **마지막** 탭. 마지막 영역 끝 → 첫 영역(감긴다).
 * 탭이 0 인 영역은 건너뛴다. 영역이 하나면 `cycleTabTarget` 과 같은 결과다. 고른 탭이 지금 활성 탭이면(탭 하나뿐) null. 순수 판정.
 */
export function cycleAcrossGroups(input: {
  groups: readonly { groupId: string; tabOrder: readonly string[] }[]
  activeGroupId: string | null
  activeTabId: string | null
  direction: 1 | -1
}): { groupId: string; tabId: string } | null {
  const { groups, direction } = input
  const start = groups.findIndex((group) => group.groupId === input.activeGroupId)
  const own = groups[start]
  if (own === undefined) return null
  const index = input.activeTabId === null ? -1 : own.tabOrder.indexOf(input.activeTabId)
  // 활성 탭이 없는데 탭이 있으면 그 영역의 첫(다음)·끝(이전) — `cycleTabTarget` 과 같다.
  const inside = index === -1 ? (direction === 1 ? own.tabOrder[0] : own.tabOrder.at(-1)) : own.tabOrder[index + direction]
  if (inside !== undefined && inside !== null) return { groupId: own.groupId, tabId: inside }
  // 영역 끝 — 다음(이전) 영역부터 감아 돈다. 자기 영역까지 돌아오면 자기 첫(끝) 탭이다(영역 하나면 영역 안 순환).
  for (let step = 1; step <= groups.length; step++) {
    const group = groups[(start + direction * step + groups.length * step) % groups.length]
    const tabId = group === undefined ? undefined : direction === 1 ? group.tabOrder[0] : group.tabOrder.at(-1)
    if (group === undefined || tabId === undefined) continue
    if (group.groupId === own.groupId && tabId === input.activeTabId) return null
    return { groupId: group.groupId, tabId }
  }
  return null
}

/** ⌃1–9 (K7ⓓ) — 활성 영역의 N번째(0 기준 index). 없으면 null(no-op). ⌃9 는 9번째다 — 마지막 탭이 아니다(220 과 같다). */
export function tabAtIndex(input: { tabOrder: readonly string[]; index: number }): string | null {
  return input.tabOrder[input.index] ?? null
}

/** 사이드바 닫기 판정에 필요한 만큼의 state 모양 — 테스트가 AppState 전체를 만들지 않게. */
type ReposShape = readonly {
  worktrees: readonly { path: string; workspace: { workspaceId: string; tabs: readonly { tabId: string; panes: readonly { paneId: string }[] }[] } | null }[]
}[]

/**
 * 사이드바 세션 닫기의 길 (LIFE-495 K3ⓒ · fix1 R1-02). 그 pane 이 **핀 탭의 마지막 pane** 이면 탭 닫기 길(핀 확인·게이트·다시 열기 기록),
 * 아니면 기존 pane 닫기. 소유 탭은 활성 워크스페이스가 아니라 **전체 state** 에서 찾는다 — 사이드바는 모든 워크스페이스의 세션을 닫을 수 있고,
 * 닫기 단추는 클릭을 카드로 올리지 않아 그 워크스페이스가 활성이 되지도 않는다(`SessionRow` stopPropagation).
 */
export function sidebarCloseRoute(input: { repos: ReposShape; paneId: string; pinned: ReadonlySet<string> }):
  | { kind: 'tab'; worktreePath: string; workspaceId: string; tabId: string }
  | { kind: 'pane' } {
  for (const repo of input.repos) {
    for (const worktree of repo.worktrees) {
      const workspace = worktree.workspace
      if (workspace === null) continue
      const tab = workspace.tabs.find((row) => row.panes.some((pane) => pane.paneId === input.paneId))
      if (tab === undefined) continue
      return tab.panes.length === 1 && input.pinned.has(tab.tabId)
        ? { kind: 'tab', worktreePath: worktree.path, workspaceId: workspace.workspaceId, tabId: tab.tabId }
        : { kind: 'pane' }
    }
  }
  return { kind: 'pane' }
}
