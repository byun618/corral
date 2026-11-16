// 영역 간 포커스·전환 (LIFE-824) — 판정만 모은 순수 함수. 화면·포커스 이동은 App 의 `focusGroupTab` 한 길이다.
//
// - 영역 MRU: 영역이 활성될 때마다 맨 앞에 둔다. **메모리 전용**(영속 0) — worktree 마다 따로(영역 id 는 worktree 배치 안에서만 뜻이 있다).
//   ⌃` 터미널↔편집기 전환이 후보가 여럿일 때 쓴다. 823 「옆으로 열기」 이웃 고르기·825 영역 닫기 뒤 활성 이동도 여기서 가져다 쓸 수 있다.
// - ⌃Tab MRU 의 파일·diff 탭 항목 키: pane id 와 섞이는 목록이라 worktree 경로를 붙인 키로 둔다(탭 id 체계 `file:`·`diff:` 는 그대로).
// - 줌 해제 판정(P6 Zⓐⓑ): 줌 중인 영역에서 숨은 pane 을 고르거나 분할하면 먼저 줌을 푼다(tmux `select-pane` 과 같은 규칙).
import { tabKindOf } from './file-tabs.js'

export function touchGroupMru(input: { history: readonly string[]; groupId: string }): string[] {
  return [input.groupId, ...input.history.filter((groupId) => groupId !== input.groupId)]
}

/** 영역 MRU 에서 배치에 없는 영역 id 를 뺀다 (fix1 A7 — 닫힌 영역 id 가 재사용돼 옛 순위를 물려받지 않게). */
export function pruneGroupMru(input: { history: readonly string[]; liveGroupIds: readonly string[] }): string[] {
  return input.history.filter((groupId) => input.liveGroupIds.includes(groupId))
}

/** 영역의 활성 탭 종류 — ⌃` 가 「터미널」과 「편집기(파일·diff)」를 가른다. 활성 탭이 없으면 `empty`. */
export type GroupBodyKind = 'terminal' | 'editor' | 'empty'

export function groupBodyKind(activeTabId: string | null): GroupBodyKind {
  if (activeTabId === null) return 'empty'
  return tabKindOf(activeTabId).kind === 'terminal' ? 'terminal' : 'editor'
}

/**
 * ⌃` (C2·P2) — 포커스 영역의 활성 탭이 터미널이면 편집기 영역으로, 편집기(또는 빈 영역)면 터미널 영역으로. 후보는 **보이는 영역**(각 영역의 활성 탭) 중
 * 그 종류인 영역이고, 여럿이면 영역 MRU 에서 최근, MRU 에 없으면 배치 순서 첫 번째. 후보가 없으면 `none` + 찾던 종류(안내 문구용).
 */
export function terminalEditorToggleTarget(input: {
  groups: readonly { groupId: string; activeTabId: string | null }[]
  activeGroupId: string | null
  recent: readonly string[]
}): { kind: 'go'; groupId: string } | { kind: 'none'; want: 'terminal' | 'editor' } {
  const current = input.groups.find((group) => group.groupId === input.activeGroupId)
  const want = current !== undefined && groupBodyKind(current.activeTabId) === 'terminal' ? 'editor' : 'terminal'
  const candidates = input.groups.filter((group) => group.groupId !== input.activeGroupId && groupBodyKind(group.activeTabId) === want).map((group) => group.groupId)
  const [first] = candidates
  if (first === undefined) return { kind: 'none', want }
  const recent = input.recent.find((groupId) => candidates.includes(groupId))
  return { kind: 'go', groupId: recent ?? first }
}

/** ⌃` 후보가 없을 때의 안내 한 줄. */
export function toggleNoneHint(want: 'terminal' | 'editor'): string {
  return want === 'editor' ? '전환할 편집기 영역이 없습니다 — 파일·diff 탭이 보이는 영역이 없다' : '전환할 터미널 영역이 없습니다 — 터미널 탭이 보이는 영역이 없다'
}

const EDITOR_MRU_PREFIX = 'editor\u0000'

/** ⌃Tab MRU 의 파일·diff 탭 항목 키 (C4ⓐ) — pane id 와 겹치지 않는 접두 + worktree 경로 + 탭 id. */
export function editorMruKey(input: { worktreePath: string; tabId: string }): string {
  return `${EDITOR_MRU_PREFIX}${input.worktreePath}\u0000${input.tabId}`
}

export function parseEditorMruKey(key: string): { worktreePath: string; tabId: string } | null {
  if (!key.startsWith(EDITOR_MRU_PREFIX)) return null
  const rest = key.slice(EDITOR_MRU_PREFIX.length)
  const cut = rest.lastIndexOf('\u0000')
  if (cut <= 0 || cut === rest.length - 1) return null
  return { worktreePath: rest.slice(0, cut), tabId: rest.slice(cut + 1) }
}

/** 영역 스트림 상태 중 줌 판정에 쓰는 만큼. */
type ZoomGroups = readonly { groupId: string; panes: readonly { paneId: string }[]; zoomedPaneId: string | null }[]

/** 그 pane 이 든 영역이 줌 중이면 그 영역 id (Zⓐ — 줌 중 분할은 줌을 풀고 한다). 줌이 아니거나 모르는 pane 이면 null. */
export function zoomedGroupOf(input: { groups: ZoomGroups; paneId: string }): string | null {
  const group = input.groups.find((row) => row.panes.some((pane) => pane.paneId === input.paneId))
  return group !== undefined && group.zoomedPaneId !== null ? group.groupId : null
}

/**
 * 그 pane 이 **줌에 가려** 있으면 줌을 걸고 있는 영역 id (Zⓑ — 숨은 pane 을 고르면 줌을 푼다). 같은 영역이 다른 pane 으로 줌 중일 때만이다.
 * 줌 중인 그 pane 자신이거나 줌이 없으면 null.
 */
export function zoomHiding(input: { groups: ZoomGroups; paneId: string }): string | null {
  const group = input.groups.find((row) => row.panes.some((pane) => pane.paneId === input.paneId))
  return group !== undefined && group.zoomedPaneId !== null && group.zoomedPaneId !== input.paneId ? group.groupId : null
}
