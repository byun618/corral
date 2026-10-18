// Resource Manager 주기 수집 (LIFE-637) — ps·herdr·창 상태는 주입받는다(시험이 경계만 바꾼다).
//
// 비용 규칙(R6):
//   ⓐ 주기 ≥ 2초 — 한 주기가 끝난 뒤 다음 주기를 건다(겹치지 않는다).
//   ⓒ 창이 숨김·최소화면 그 주기는 ps 도 herdr 요청도 하지 않는다(`skippedHidden` 만 는다).
//   ⓓ 셸 pid 는 pane 수명 동안 변하지 않는다 — pane 별로 한 번만 묻고 캐시한다. pane 변화가 없는 주기의 herdr 요청은 0.
//      묻기에 실패한 pane 만 `PROBE_RETRY_MS` 뒤에 다시 묻는다.
// CPU = `ps %cpu` 그대로(누적 시간 차분 아님) — 실측에서 macOS `ps %cpu` 가 2초 안에 따라와(00-analysis a03) 주기 2초 표본이면
// 차분과 크게 다르지 않고, 차분은 pid 별 이전 값 보관·pid 재사용 처리가 더 든다.
import type { ResourceMeasure, ResourcePaneRow, ResourceSnapshot, ResourceStats } from '../shared/resource.js'
import { attribute, parsePsTable, totalOf } from './resource-collector.js'

export const RESOURCE_INTERVAL_MS = 2000
export const PROBE_RETRY_MS = 30_000
const DURATION_SAMPLES = 30

/** 수집 대상 pane — 표시에 쓰는 칸까지 main 이 채워 넘긴다. */
export type ResourcePaneSource = Omit<ResourcePaneRow, 'measure'>

export type ResourceMonitorDeps = {
  intervalMs: number
  /** `LC_ALL=C ps …` 의 stdout. 실패하면 throw. */
  readPs: () => Promise<string>
  panes: () => ResourcePaneSource[]
  /** herdr 에 그 pane 의 셸 pid 를 묻는다. 모르면 null. */
  probeShellPid: (paneId: string) => Promise<number | null>
  /** main pid + Electron 역할 pid. */
  appRoots: () => number[]
  /** 창이 보이고 최소화되지 않았는가. */
  visible: () => boolean
  host: () => ResourceSnapshot['host']
  emit: (snapshot: ResourceSnapshot) => void
  now: () => number
  log: (tag: string, data: Record<string, unknown>) => void
}

type CachedRoot = { shellPid: number | null; probedAt: number }

export function createResourceMonitor(deps: ResourceMonitorDeps): {
  start: () => void
  stop: () => void
  tick: () => Promise<void>
  latest: () => ResourceSnapshot | null
  stats: () => ResourceStats
} {
  const intervalMs = Math.max(RESOURCE_INTERVAL_MS, deps.intervalMs)
  const roots = new Map<string, CachedRoot>()
  const stats: ResourceStats = { intervalMs, collections: 0, skippedHidden: 0, processInfoRequests: 0, recentDurationsMs: [] }
  let latest: ResourceSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  const refreshRoots = async (panes: readonly ResourcePaneSource[]): Promise<void> => {
    const live = new Set(panes.map((pane) => pane.paneId))
    for (const paneId of [...roots.keys()]) if (!live.has(paneId)) roots.delete(paneId)
    const now = deps.now()
    const asks = panes.filter((pane) => {
      const cached = roots.get(pane.paneId)
      return cached === undefined || (cached.shellPid === null && now - cached.probedAt >= PROBE_RETRY_MS)
    })
    if (asks.length === 0) return
    for (const pane of asks) {
      stats.processInfoRequests += 1
      const shellPid = await deps.probeShellPid(pane.paneId).catch(() => null)
      roots.set(pane.paneId, { shellPid, probedAt: deps.now() })
    }
    deps.log('resource.probe', { asked: asks.length, total: stats.processInfoRequests })
  }

  const tick = async (): Promise<void> => {
    if (!deps.visible()) {
      stats.skippedHidden += 1
      return
    }
    const startedAt = deps.now()
    const panes = deps.panes()
    await refreshRoots(panes)
    let stdout: string | null = null
    try {
      stdout = await deps.readPs()
    } catch (error) {
      deps.log('resource.ps_failed', { error: String(error) })
    }
    const unavailable: ResourceMeasure = { state: 'unavailable', reason: 'ps 실행 실패' }
    const attribution = stdout === null
      ? { panes: new Map(panes.map((pane) => [pane.paneId, unavailable])), herdr: unavailable, app: unavailable }
      : attribute({ table: parsePsTable(stdout), panes: panes.map((pane) => ({ paneId: pane.paneId, shellPid: roots.get(pane.paneId)?.shellPid ?? null })), appRoots: deps.appRoots() })
    const rows: ResourcePaneRow[] = panes.map((pane) => ({ ...pane, measure: attribution.panes.get(pane.paneId) ?? unavailable }))
    const { total, unavailableCount } = totalOf([attribution.app, attribution.herdr, ...rows.map((row) => row.measure)])
    stats.collections += 1
    stats.recentDurationsMs = [...stats.recentDurationsMs, deps.now() - startedAt].slice(-DURATION_SAMPLES)
    latest = {
      collectedAt: deps.now(),
      total,
      unavailableCount,
      app: attribution.app,
      herdr: attribution.herdr,
      panes: rows,
      host: deps.host(),
      stats: { ...stats, recentDurationsMs: [...stats.recentDurationsMs] },
    }
    deps.emit(latest)
  }

  // 한 주기가 끝난 뒤에 다음 주기를 건다 — ps 가 느려도 주기가 겹치지 않는다.
  const cycle = (): void => {
    void tick()
      .catch((error: unknown) => deps.log('resource.tick_failed', { error: String(error) }))
      .finally(() => {
        if (running) timer = setTimeout(cycle, intervalMs)
      })
  }

  return {
    start: () => {
      if (running) return
      running = true
      cycle()
    },
    stop: () => {
      running = false
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    tick,
    latest: () => latest,
    stats: () => ({ ...stats, recentDurationsMs: [...stats.recentDurationsMs] }),
  }
}
