// 닫은 탭 기록 (LIFE-495 K6 · D34 ⌘⇧T) — 220 `store/slices/recently-closed-tabs.ts` 의 corral 판.
//
// 220 의미 그대로: 다시 열기는 **같은 시작 디렉터리의 새 셸**이다 — PTY·scrollback·에이전트는 되살리지 않는다. 사용자 이름·색·자리
// (영역·순번)를 복원하고 핀은 복원하지 않는다. worktree 별 최근 10개, 앱 메모리에만 있다(비영속).
// 기록하는 것은 **사용자 닫기**뿐이다(×·중클릭·메뉴·⌘W·bulk 는 탭마다 1건) — 프로세스가 끝나 사라진 탭·앱 정리는 부르는 쪽이 넣지 않는다.

export const RECENTLY_CLOSED_LIMIT = 10

/**
 * LIFE-590 — 닫은 **파일 탭**. 다시 열기 = 같은 파일을 같은 영역·자리에, 미리보기였으면 미리보기로(E3ⓓ). 셸을 만들지 않는다(herdr 무관).
 */
export type ClosedFileSnapshot = { kind: 'file'; worktreePath: string; rel: string; preview: boolean; groupId: string; index: number }

/** 닫은 탭 하나 — 터미널(`kind` 생략 = 터미널, 기존 기록 모양 그대로) 또는 파일. */
export type ClosedTabSnapshot = ClosedTerminalSnapshot | ClosedFileSnapshot

export type ClosedTerminalSnapshot = {
  kind?: 'terminal'
  /** 기록 묶음의 키 — 배치(`groupLayouts`)와 같이 worktree **경로**다(workspace id 는 herdr 재기동에 안 산다). */
  worktreePath: string
  /** 새 셸의 시작 디렉터리. 모르면 null — 다시 열 때 herdr 기본(워크스페이스 디렉터리)에 맡긴다. */
  cwd: string | null
  /** 사용자가 준 이름(없으면 null — 기본 제목으로 열린다). */
  label: string | null
  color: string | null
  /** 닫을 때 있던 영역과 그 영역 안 자리. 영역이 사라졌으면 다시 열 때 기본 착지(활성 영역 끝)에 맡긴다. */
  groupId: string
  index: number
}

/** worktree 경로 → 최근 닫은 탭(앞이 최근). 기록 모양은 시험이 좁혀 쓸 수 있게 열어 둔다. */
export type RecentlyClosed<T extends { worktreePath: string } = ClosedTabSnapshot> = Record<string, T[]>

/** 앞이 최근. 상한을 넘은 오래된 것은 버린다. */
export function pushClosed<T extends { worktreePath: string }>(input: { history: RecentlyClosed<T>; snapshot: T }): RecentlyClosed<T> {
  const { history, snapshot } = input
  const list = [snapshot, ...(history[snapshot.worktreePath] ?? [])].slice(0, RECENTLY_CLOSED_LIMIT)
  return { ...history, [snapshot.worktreePath]: list }
}

/** 가장 최근 것을 꺼낸다. 비어 있으면 아무것도 안 한다(K6ⓔ) — `snapshot: null`. */
export function popClosed<T extends { worktreePath: string }>(input: { history: RecentlyClosed<T>; worktreePath: string }): { history: RecentlyClosed<T>; snapshot: T | null } {
  const { history, worktreePath } = input
  const [snapshot, ...rest] = history[worktreePath] ?? []
  if (snapshot === undefined) return { history, snapshot: null }
  return { history: { ...history, [worktreePath]: rest }, snapshot }
}

/**
 * 시작 디렉터리 (U3) — 탭이 **보이던 pane** 의 cwd, 없으면 그 탭 첫 pane 의 cwd. herdr `foreground_cwd`(없으면 `cwd`)라 셸이 `cd` 한 곳이다.
 * pane 이 여럿인 탭도 셸 **하나**로 다시 연다(220 은 탭 = 터미널 하나다) — 사용자가 보고 있던 pane 이 그 탭을 대표한다.
 */
export function snapshotCwd(input: { panes: readonly { paneId: string; cwd: string | null }[]; shownPaneId: string | null }): string | null {
  const shown = input.panes.find((pane) => pane.paneId === input.shownPaneId)
  return shown?.cwd ?? input.panes.find((pane) => pane.cwd !== null)?.cwd ?? null
}

/** 다시 연 탭이 도착하면 놓을 자리·색 (K6). 탭 id 키 — 연속 ⌘⇧T 가 서로 덮어쓰지 않게(fix1 미확인 부기). */
export type PendingPlacement = { tabId: string; workspaceId: string; groupId: string; index: number; color: string | null }

export function addPlacement(input: { pending: ReadonlyMap<string, PendingPlacement>; placement: PendingPlacement }): Map<string, PendingPlacement> {
  return new Map([...input.pending, [input.placement.tabId, input.placement]])
}

/** 도착한(살아 있는) 탭의 자리를 꺼낸다 — 나머지는 남긴다. 순서 = 요청 순서. */
export function takeLivePlacements(input: { pending: ReadonlyMap<string, PendingPlacement>; liveTabIds: readonly string[] }): {
  ready: PendingPlacement[]
  pending: Map<string, PendingPlacement>
} {
  const live = new Set(input.liveTabIds)
  const ready = [...input.pending.values()].filter((placement) => live.has(placement.tabId))
  return { ready, pending: new Map([...input.pending].filter(([tabId]) => !live.has(tabId))) }
}

/**
 * 탐색기 이름 변경·이동(LIFE-592 E4ⓓ) — 그 worktree 의 닫은 **파일** 탭 기록 중 `from` 밑 경로를 `to` 쪽으로. ⌘⇧T 가 새 경로를 다시 연다.
 * `remap` 은 상대 경로 → 새 경로(밑이 아니면 null).
 */
export function remapClosedFiles(input: { history: RecentlyClosed; worktreePath: string; remap: (rel: string) => string | null }): RecentlyClosed {
  const list = input.history[input.worktreePath]
  if (list === undefined) return input.history
  let changed = false
  const next = list.map((snapshot) => {
    if (snapshot.kind !== 'file') return snapshot
    const rel = input.remap(snapshot.rel)
    if (rel === null) return snapshot
    changed = true
    return { ...snapshot, rel }
  })
  return changed ? { ...input.history, [input.worktreePath]: next } : input.history
}
