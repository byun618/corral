// 상태바 Resource Manager (LIFE-637) — main 수집기 ↔ 렌더러 세그먼트가 주고받는 모양.
//
// 메모리 = RSS(공유 메모리 중복 포함, 게이트 ⓪ Q1). CPU = `ps %cpu` 합(코어 하나 = 100%).
// 「전체」 = corral 앱(main·renderer·helper) + herdr 서버 + 모든 pane 자손(Q2) — 한 pid 는 한 곳에만 센다.
import type { CloseTabsResult } from './types.js'

export type ResourceUsage = {
  /** `ps %cpu` 합 — 코어 하나를 다 쓰면 100. */
  cpu: number
  /** RSS 합, 바이트. */
  memory: number
}

/** 측정값 또는 측정 불가. 가짜 숫자를 내지 않는다 — 못 재면 사유를 싣는다. */
export type ResourceMeasure =
  | { state: 'measured'; usage: ResourceUsage; pids: number[] }
  | { state: 'unavailable'; reason: string }

export type ResourcePaneRow = {
  paneId: string
  tabId: string
  workspaceId: string
  /** worktree 묶음 열쇠 — worktree 경로, 없으면 workspace id. */
  groupKey: string
  groupLabel: string
  title: string
  /** herdr 가 감지한 에이전트 이름. 셸이면 null. */
  agent: string | null
  measure: ResourceMeasure
}

/** 비용 관문(R6)에서 세는 카운터 — 앱이 켜진 뒤 누적. */
export type ResourceStats = {
  intervalMs: number
  /** 실제로 ps 를 돌린 주기 수. */
  collections: number
  /** 창이 숨김·최소화라 건너뛴 주기 수(그 주기에는 ps·herdr 요청 0). */
  skippedHidden: number
  /** herdr 에 셸 pid 를 물은 횟수(누적). pane 변화가 없는 주기에는 늘지 않는다. */
  processInfoRequests: number
  /** 최근 주기들의 main 쪽 소요(ms), 오래된 것부터 — 최대 30개. */
  recentDurationsMs: number[]
}

export type ResourceSnapshot = {
  collectedAt: number
  /** 앱 + herdr + pane 중 측정된 것의 합. 하나도 못 재면 null. */
  total: ResourceUsage | null
  /** 측정 불가인 칸 수(앱·herdr·pane). 0 이 아니면 total 은 그만큼 빠진 합이다. */
  unavailableCount: number
  app: ResourceMeasure
  herdr: ResourceMeasure
  panes: ResourcePaneRow[]
  host: { totalMemory: number; usedMemory: number; cpuCoreCount: number }
  stats: ResourceStats
}

/** 패널 「닫기」 — 기존 실행 중 확인 게이트(`closeTabsGated`)의 결과를 그대로 쓴다. */
export type ResourceCloseResult = CloseTabsResult
