// MRU 전환의 **순수 모델** (LIFE-373 ③ · F3-2·F3-4).
//
// 여기 있는 것은 순서와 자리뿐이다 — 상태(기록)는 `App.tsx` 의 ref 가, 키는 main 의
// `before-input-event` 가 들고 있다. 이 파일이 순수해야 "취소 시 상태 변화 0"(F3-5)을
// 테스트로 잡을 수 있다.
//
// 단위·범위는 **pane 단위 · 전체 범위**다 (F3-4 · 핸드오프 §1-5): 열려 있는 **모든** worktree
// 의 pane 이 한 목록에 선다. worktree 경계를 넘는 것이 이 기능의 요점이라 여기서 안 거른다.

/** 목록 상한 (F3-4). 넘는 것은 **보이지도, 이동으로 닿지도 않는다** — 사이드바의 몫이다. */
export const MRU_LIMIT = 12

/** 최근 포커스 순서 — 앞이 최근. 같은 pane 은 한 번만 선다. */
export function touchMru(input: { history: readonly string[]; paneId: string }): string[] {
  return [input.paneId, ...input.history.filter((paneId) => paneId !== input.paneId)]
}

/**
 * 화면에 설 순서 — 기록에 있는 것 먼저(최근 순), 그 다음 **아직 한 번도 안 고른 pane** 을
 * 받은 순서 그대로.
 *
 * 뒤쪽 꼬리가 필요한 이유: 기록은 앱이 뜬 뒤의 것이라 방금 켠 창에서는 비어 있다. 그때 목록이
 * 한 줄뿐이면 `⌃Tab` 이 아무 데도 못 간다 — 사용자에게는 "안 먹는 키"다.
 * 죽은 pane(기록에는 있는데 지금 없는 것)은 여기서 빠진다.
 */
export function orderMru(input: { history: readonly string[]; livePaneIds: readonly string[] }): string[] {
  const live = new Set(input.livePaneIds)
  const taken = new Set<string>()
  const rows: string[] = []
  for (const paneId of input.history) {
    if (!live.has(paneId) || taken.has(paneId)) continue
    taken.add(paneId)
    rows.push(paneId)
  }
  for (const paneId of input.livePaneIds) {
    if (taken.has(paneId)) continue
    taken.add(paneId)
    rows.push(paneId)
  }
  return rows
}

/**
 * 여는 순간 고를 자리 (핸드오프 §4 "MRU 열기, 1번 선택").
 *
 * 앞으로면 **1번** — 0번은 지금 있는 pane 이므로, 한 번 눌렀다 놓는 흐름이 "직전 pane 으로"가
 * 된다(터미널·창 전환의 관습). 뒤로(`⇧`)면 맨 끝. 한 줄뿐이면 갈 곳이 없어 0 이다.
 */
export function openMru(input: { count: number; backward: boolean }): number {
  const length = Math.min(input.count, MRU_LIMIT)
  if (length <= 1) return 0
  return input.backward ? length - 1 : 1
}

/** 홀드 중 이동 — **상한 안에서** wrap 한다 (F3-2). */
export function stepMru(input: { index: number; count: number; backward: boolean }): number {
  const length = Math.min(input.count, MRU_LIMIT)
  if (length <= 0) return 0
  const next = input.index + (input.backward ? -1 : 1)
  return ((next % length) + length) % length
}

/**
 * 행 앞의 **위치 글리프** (핸드오프 §1-5) — 그 탭이 배정된 영역.
 *
 * 영역이 하나면 빈 표다: 어느 영역인지가 정보가 아니라 잡음이 된다. 둘이면 방향대로 반쪽
 * 글리프, 셋 이상이면 번호. `1 2 3` 는 사람이 세는 순서(배치 순)이고 영역 id 가 아니다.
 */
export function groupGlyphs(input: { groupIds: readonly string[]; direction: 'row' | 'column' | null }): Map<string, string> {
  const glyphs = new Map<string, string>()
  if (input.groupIds.length < 2) return glyphs
  const pair = input.direction === 'column' ? ['⬒', '⬓'] : ['◧', '◨']
  input.groupIds.forEach((groupId, index) => {
    glyphs.set(groupId, input.groupIds.length === 2 ? (pair[index] ?? '') : String(index + 1))
  })
  return glyphs
}
