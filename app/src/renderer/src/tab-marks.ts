// 탭 핀·색 (LIFE-495 K3·K4) — 화면이 혼자 쓰는 탭 표시 상태. 영속은 ui-prefs `tabMarks`.
//
// **왜 ui-prefs 인가** (00-analysis F13): 탭 이름은 herdr label 이지만 거기 다른 값을 싣는 것은 G5 재발이다(`userLabel` 이 이름으로
// 읽는다). 순서·배치(`groupLayouts`)·폴백 번호(`tabOrdinals`)와 같은 자리다. 키도 `tabOrdinals` 와 같이 `{tabId, workspaceId}` 다.
// **한계**: herdr tab id 는 herdr 서버가 재기동하면 다시 매겨진다 — 그때는 배치와 같이 핀·색도 잃는다(옛 칸이 새 탭과 우연히 같은
// id 면 그 탭에 붙을 수 있다 — 배치·폴백 번호와 같은 한계, RESULT 에 적는다). corral 만 재기동하면 그대로다.
//
// 여기 있는 함수는 전부 순수하다 — 배열을 새로 만들어 돌려준다.

export type TabMark = { tabId: string; workspaceId: string; pinned: boolean; color: string | null }

/** 탭 색 10개 (K4ⓐ) — 값·순서 = Orca 220 `SortableTabContextMenu.tsx` `TAB_COLORS`. 이름은 corral UI 언어(한국어). */
export const TAB_COLORS: readonly { label: string; value: string | null }[] = [
  { label: '없음', value: null },
  { label: '파랑', value: '#3b82f6' },
  { label: '보라', value: '#a855f7' },
  { label: '분홍', value: '#ec4899' },
  { label: '빨강', value: '#ef4444' },
  { label: '주황', value: '#f97316' },
  { label: '노랑', value: '#eab308' },
  { label: '초록', value: '#22c55e' },
  { label: '청록', value: '#14b8a6' },
  { label: '회색', value: '#9ca3af' },
]

const COLOR_VALUES = new Set(TAB_COLORS.flatMap((entry) => (entry.value === null ? [] : [entry.value])))

/** 저장된 칸을 **모양을 확인하며** 읽는다 — 모르는 색·빈 id·기본값(핀 아님·색 없음)은 버린다. 같은 탭이 두 번이면 앞의 것. */
export function readTabMarks(value: unknown): TabMark[] {
  if (!Array.isArray(value)) return []
  const rows: TabMark[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const tabId: unknown = Reflect.get(item, 'tabId')
    const workspaceId: unknown = Reflect.get(item, 'workspaceId')
    const pinned: unknown = Reflect.get(item, 'pinned')
    const color: unknown = Reflect.get(item, 'color')
    if (typeof tabId !== 'string' || tabId.length === 0 || typeof workspaceId !== 'string') continue
    const mark: TabMark = { tabId, workspaceId, pinned: pinned === true, color: typeof color === 'string' && COLOR_VALUES.has(color) ? color : null }
    const key = `${workspaceId}\n${tabId}`
    if (isDefault(mark) || seen.has(key)) continue
    seen.add(key)
    rows.push(mark)
  }
  return rows
}

function isDefault(mark: TabMark): boolean {
  return !mark.pinned && mark.color === null
}

function update(input: { marks: readonly TabMark[]; target: { tabId: string; workspaceId: string }; change: (mark: TabMark) => TabMark }): TabMark[] {
  const { marks, target, change } = input
  const current = marks.find((mark) => mark.tabId === target.tabId && mark.workspaceId === target.workspaceId) ?? { tabId: target.tabId, workspaceId: target.workspaceId, pinned: false, color: null }
  const next = change(current)
  const rest = marks.filter((mark) => !(mark.tabId === target.tabId && mark.workspaceId === target.workspaceId))
  // 기본값으로 돌아온 칸은 지운다 — 파일에 의미 없는 칸이 쌓이지 않게.
  return isDefault(next) ? rest : [...rest, next]
}

export function setTabPinned(input: { marks: readonly TabMark[]; tabId: string; workspaceId: string; pinned: boolean }): TabMark[] {
  return update({ marks: input.marks, target: input, change: (mark) => ({ ...mark, pinned: input.pinned }) })
}

export function setTabColor(input: { marks: readonly TabMark[]; tabId: string; workspaceId: string; color: string | null }): TabMark[] {
  const color = input.color !== null && COLOR_VALUES.has(input.color) ? input.color : null
  return update({ marks: input.marks, target: input, change: (mark) => ({ ...mark, color }) })
}

/**
 * 닫힌 탭의 칸을 지운다 (K4ⓒ 정리 규칙) — `tabOrdinals.keepOnly` 와 같은 규칙: **지금 보이는 워크스페이스 안에서만** 죽은 탭을 지운다.
 * 보이지 않는 워크스페이스의 칸은 손대지 않는다 — 상태가 덜 왔거나 잠깐 닫힌 순간에 통째로 날아가지 않게.
 */
export function keepLiveTabMarks(input: { marks: readonly TabMark[]; liveTabIds: readonly string[]; shownWorkspaceIds: readonly string[] }): TabMark[] {
  const { marks } = input
  const live = new Set(input.liveTabIds)
  const shown = new Set(input.shownWorkspaceIds)
  const next = marks.filter((mark) => !shown.has(mark.workspaceId) || live.has(mark.tabId))
  return next.length === marks.length ? [...marks] : next
}

export function markOf(input: { marks: readonly TabMark[]; tabId: string; workspaceId: string }): TabMark | null {
  return input.marks.find((mark) => mark.tabId === input.tabId && mark.workspaceId === input.workspaceId) ?? null
}

export function pinnedTabIds(marks: readonly TabMark[]): Set<string> {
  return new Set(marks.filter((mark) => mark.pinned).map((mark) => mark.tabId))
}
