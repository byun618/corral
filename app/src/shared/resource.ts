// 상태바 Resource Manager (LIFE-637 · LIFE-676) — main 수집기 ↔ 렌더러 세그먼트가 주고받는 모양.
//
// 메모리 = pid 별 phys_footprint 의 합 — 활동 상태 보기 「메모리」 열과 같은 값(압축·swap 된 몫 포함, LIFE-676).
//   도우미(`corral-footprint`)로 읽는다. 도우미·표가 실패하면 그 칸 메모리는 측정 불가 — RSS 로 대신하지 않는다(게이트 ⓪ Q2).
//   귀속 pid 중 일부만 못 읽으면(setuid-root 자식 `top`·`sudo` 의 EPERM 등) 읽힌 pid 의 합을 하한(`≥`)으로 낸다(리뷰 r1 C1-1).
// CPU = `ps %cpu` 합, 코어 하나 = 100 (코어당 원값). 맥 전체 대비(÷ 코어 수)는 표시 층이 한다(Q3).
// 「전체」 = corral 앱(main·renderer·helper) + herdr 서버 + 모든 pane 자손(637 Q2) — 한 pid 는 한 곳에만 센다.
import type { CloseTabsResult } from './types.js'

/**
 * 메모리 칸 — 측정값(바이트) · 하한(일부를 뺀 합, 사유) · 측정 불가(사유). CPU 가 살아 있어도 메모리만 못 잴 수 있다(Q2).
 * `partial` 의 `bytes` 는 실제 값보다 작거나 같다 — 표시는 `≥ x`.
 */
export type ResourceMemory =
  | { state: 'measured'; bytes: number }
  | { state: 'partial'; bytes: number; reason: string }
  | { state: 'unavailable'; reason: string }

export type ResourceUsage = {
  /** `ps %cpu` 합 — 코어 하나를 다 쓰면 100(코어당 원값). */
  cpu: number
  /** phys_footprint 합(활동 상태 보기 「메모리」 열 값의 합). */
  memory: ResourceMemory
}

/** 측정값 또는 측정 불가. 가짜 숫자를 내지 않는다 — 못 재면 사유를 싣는다. */
export type ResourceMeasure =
  | { state: 'measured'; usage: ResourceUsage; pids: number[] }
  | { state: 'unavailable'; reason: string }

/**
 * 여러 칸의 합. CPU 는 측정된 칸 전부, 메모리는 값(측정·하한)이 있는 칸만 더한다.
 * 하한 칸이 섞였거나 메모리를 못 잰 칸이 있으면 합도 하한(`partial`, 사유 「일부 pid 를 뺀 칸 n개 · 메모리를 못 잰 칸 m개」 → 툴팁 「메모리 하한 — …」)
 * — 빠진 합을 그대로 보이지 않는다(C1-1, 문구 r2 C2-5). 값이 있는 칸이 하나도 없으면 메모리는 측정 불가(첫 사유).
 */
export function sumUsage(usages: readonly ResourceUsage[]): ResourceUsage | null {
  if (usages.length === 0) return null
  let cpu = 0
  let bytes = 0
  let known = 0
  let partial = 0
  let firstReason: string | null = null
  for (const usage of usages) {
    cpu += usage.cpu
    switch (usage.memory.state) {
      case 'measured':
        bytes += usage.memory.bytes
        known += 1
        continue
      case 'partial':
        bytes += usage.memory.bytes
        known += 1
        partial += 1
        continue
      case 'unavailable':
        firstReason = firstReason ?? usage.memory.reason
        continue
    }
  }
  const missing = usages.length - known
  if (known === 0 && firstReason !== null) return { cpu, memory: { state: 'unavailable', reason: firstReason } }
  const notes = [
    ...(partial > 0 ? [`일부 pid 를 뺀 칸 ${partial}개`] : []),
    ...(missing > 0 ? [`메모리를 못 잰 칸 ${missing}개`] : []),
  ]
  const memory: ResourceMemory = notes.length === 0 ? { state: 'measured', bytes } : { state: 'partial', bytes, reason: notes.join(' · ') }
  return { cpu, memory }
}

export type ResourcePaneRow = {
  paneId: string
  tabId: string
  workspaceId: string
  /** worktree 묶음 열쇠 = worktree 경로. */
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
  /** 메모리 도우미를 실행한 횟수(누적, LIFE-676 C1-5 — 숨김 주기에는 늘지 않는다). */
  footprintRuns: number
  /** 시스템 지표(sysctl·vm_stat 한 벌)를 읽은 횟수(누적). */
  hostReads: number
  /** 최근 주기들의 main 쪽 소요(ms), 오래된 것부터 — 최대 30개. */
  recentDurationsMs: number[]
}

/** `kern.memorystatus_vm_pressure_level` — 1 정상 · 2 경고 · 4 위험. */
export type MemoryPressure = 'normal' | 'warning' | 'critical'

/** 패널 시스템 한 줄(게이트 ⓪ Q4)의 재료. 못 읽은 지표는 null — 그 조각만 `—` 로 보인다. */
export type ResourceHost = {
  /** 물리 메모리, 바이트(`os.totalmem()`). */
  physicalMemory: number
  /** 코어 수(`os.cpus().length`). 0 이면 모른다. */
  cpuCoreCount: number
  pressure: MemoryPressure | null
  /** `sysctl vm.swapusage`, 바이트. */
  swap: { used: number; total: number } | null
  /** `vm_stat` 「Pages occupied by compressor」 × 페이지 크기, 바이트. */
  compressed: number | null
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
  host: ResourceHost
  stats: ResourceStats
}

/**
 * 패널 「닫기」 의 길 — 클릭한 그 순간의 main 위상으로 정한다(H3 — 2초 낡은 스냅샷 칸으로 정하지 않는다).
 *   · pane    — 그 탭에 pane 이 둘 이상: pane 게이트(`corral:resourceClosePane`)
 *   · tab     — 그 탭의 마지막 pane: 기존 탭 닫기(`corral:closeTabs`). `lastInWorktree` 면 수정 문서 확인을 먼저(F7)
 *   · missing — 그 pane 이 이미 없다
 */
export type ResourceCloseRoute =
  | { kind: 'pane' }
  | { kind: 'tab'; tabId: string; worktreePath: string; lastInWorktree: boolean }
  | { kind: 'missing' }

/**
 * 패널 「닫기」 — 기존 실행 중 확인 게이트(`closeTabsGated`)의 결과를 그대로 쓴다.
 * `route-changed` = 대상이 지금 그 탭의 마지막 pane 이라 pane 게이트로 닫지 않았다(J2) — 렌더러가 길을 다시 묻는다.
 */
export type ResourceCloseResult = CloseTabsResult | { outcome: 'route-changed'; closed: string[] }
