// Resource Manager 주기 수집 (LIFE-637) — ps·herdr·창 상태는 주입받는다(시험이 경계만 바꾼다).
//
// 비용 규칙(R6):
//   ⓐ 주기 ≥ 2초 — 한 주기가 끝난 뒤 다음 주기를 건다(겹치지 않는다).
//   ⓒ 창이 숨김·최소화면 그 주기는 ps 도 herdr 요청도 하지 않는다(`skippedHidden` 만 는다). 다시 보이면(`wake`) 곧바로 한 주기.
//   ⓓ 셸 pid 는 pane 별로 한 번 묻고 캐시한다. pane 변화도 루트 변화도 없는 주기의 herdr 요청은 0.
// 캐시 자가 치유(F1): herdr 는 같은 pane id 에 새 셸을 넣을 수 있다(handoff respawn·snapshot restore — 리뷰 r1 G1-2).
//   캐시한 셸 pid 가 ps 표에서 사라졌거나 그 ppid 가 처음 본 값과 달라지면, 직전 주기까지 맞던 pane 은 그 주기에 한 번 다시 묻는다.
//   다시 물어도 안 맞으면(또는 처음부터 안 맞으면) `PROBE_RETRY_MS` 뒤에만 다시 묻는다 — pane 당 주기당 1회 이하, 끝없는 재질의 없음.
//   ppid 가 바뀐 pid 를 herdr 가 그대로 주면 처음 본 부모를 유지해 그 pane 은 측정 불가(재사용 의심)로 둔다.
// CPU = `ps %cpu` 그대로(누적 시간 차분 아님) — RESULT 결정 1.
// 메모리(LIFE-676) = ps 다음에 도우미 footprint 표 — ps 뒤에 돌아야 「ps 에 있고 표에 없는 pid = 그 사이 끝남」 이 성립한다(collector 머리 주석).
// 시스템 지표(`readHost`)는 ps 와 나란히 돈다. 숨김 주기에는 셋 다 돌지 않는다.
import type { ResourceHost, ResourceMeasure, ResourceOrphanRow, ResourcePaneRow, ResourceSnapshot, ResourceStats } from '../shared/resource.js'
import { attribute, combineMeasures, parsePsTable, totalOf, type FootprintTable, type PsTable } from './resource-collector.js'

export const RESOURCE_INTERVAL_MS = 2000
export const PROBE_RETRY_MS = 30_000
/** 런타임 없음(`missing`) pane 의 느린 재질의 간격 (LIFE-628 G4) — 재기동 뒤 늦게 PTY 가 붙는 pane 이 측정으로 돌아오게. */
export const MISSING_RETRY_MS = 60_000
const DURATION_SAMPLES = 30

/** 수집 대상 pane — 표시에 쓰는 칸까지 main 이 채워 넘긴다. */
export type ResourcePaneSource = Omit<ResourcePaneRow, 'measure'>

/**
 * herdr 에 셸 pid 를 물은 결과 (LIFE-628 F5). `missing` = herdr 가 `pane_not_found` — 런타임(PTY)이 없는 pane 이라 셸 pid 를
 * 그때는 못 받는다. 그런 pane 은 30초 재질의 대신 `MISSING_RETRY_MS`(60초) 간격으로만 다시 묻는다(G4 — 늦게 PTY 가 붙는 pane).
 * 목록에서 빠졌다가 다시 오면 그때 새로 묻는다.
 */
export type ShellProbe = { kind: 'pid'; pid: number } | { kind: 'unknown' } | { kind: 'missing' }

/** 런타임 없는 pane 의 측정 칸 사유 — 프로세스가 없다(메모리를 쥐고 있지 않다). */
export const NO_RUNTIME_REASON = '프로세스 없음 — herdr 에 런타임이 없는 pane(재개 안 됨)'

/** 카드 밖 workspace(LIFE-628) — 표시 칸까지 main 이 채워 넘긴다. 그 pane 들도 카드 pane 과 같은 캐시·귀속 규칙으로 잰다. */
export type ResourceOrphanSource = Omit<ResourceOrphanRow, 'measure'>

export type ResourceMonitorDeps = {
  intervalMs: number
  /** `LC_ALL=C ps …` 의 stdout. 실패하면 throw. */
  readPs: () => Promise<string>
  /** 도우미 footprint 표. 던지지 않는다 — 실패는 `unavailable`(사유). */
  readFootprint: () => Promise<FootprintTable>
  panes: () => ResourcePaneSource[]
  /** 카드 밖 workspace. null = 지금은 가릴 수 없다(스냅샷 `orphans: null`). 없으면 늘 null. */
  orphans?: () => ResourceOrphanSource[] | null
  /** `orphans` 가 null 일 때의 영구 사유(P1). 없으면 null. */
  orphansReason?: () => string | null
  /** herdr 에 그 pane 의 셸 pid 를 묻는다(F5 — 런타임 없음은 `missing`). */
  probeShellPid: (paneId: string) => Promise<ShellProbe>
  /** main pid + Electron 역할 pid. */
  appRoots: () => number[]
  /** 창이 보이고 최소화되지 않았는가. */
  visible: () => boolean
  /** 시스템 줄 지표. 던지지 않는다 — 못 읽은 지표는 null. */
  readHost: () => Promise<ResourceHost>
  emit: (snapshot: ResourceSnapshot) => void
  now: () => number
  log: (tag: string, data: Record<string, unknown>) => void
}

/**
 * pane 하나의 셸 루트 캐시. `parentPid` = 이 셸 pid 를 ps 표에서 처음 봤을 때의 ppid(아직 못 봤으면 null).
 * `healthy` = 직전 주기에 표와 맞았는가 — 맞다가 어긋난 첫 주기에만 바로 다시 묻는다.
 */
type CachedRoot = { shellPid: number | null; missing: boolean; parentPid: number | null; probedAt: number; healthy: boolean }

export function createResourceMonitor(deps: ResourceMonitorDeps): {
  start: () => void
  stop: () => void
  /** 창이 다시 보였다 — 다음 타이머를 기다리지 않고 곧바로 한 주기(F10). 진행 중이면 그 주기가 끝난 뒤 한 번 더. */
  wake: () => void
  tick: () => Promise<void>
  latest: () => ResourceSnapshot | null
  stats: () => ResourceStats
} {
  const intervalMs = Math.max(RESOURCE_INTERVAL_MS, deps.intervalMs)
  const roots = new Map<string, CachedRoot>()
  const stats: ResourceStats = { intervalMs, collections: 0, skippedHidden: 0, processInfoRequests: 0, footprintRuns: 0, hostReads: 0, recentDurationsMs: [] }
  let latest: ResourceSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let inFlight = false
  let wakePending = false
  let lastFootprintReason: string | null = null
  let lastOrphanPanes: ReadonlySet<string> = new Set()

  const probe = async (paneId: string): Promise<{ shellPid: number | null; missing: boolean }> => {
    stats.processInfoRequests += 1
    const result = await deps.probeShellPid(paneId).catch((): ShellProbe => ({ kind: 'unknown' }))
    switch (result.kind) {
      case 'pid':
        return { shellPid: result.pid, missing: false }
      case 'unknown':
        return { shellPid: null, missing: false }
      case 'missing':
        return { shellPid: null, missing: true }
    }
  }

  /**
   * 새 pane 과 셸 pid 를 못 얻은 pane(재시도 시각이 된 것)만 묻는다. 런타임 없음(`missing`) pane 은 60초 간격으로만(F5·G4).
   * `keep` = 이번 틱에 재지는 않지만 캐시를 지우지 말 pane(카드 밖 판정이 null 인 틱의 직전 카드 밖 pane — F5).
   */
  const refreshRoots = async (input: { panes: readonly { paneId: string }[]; keep: ReadonlySet<string>; asked: Set<string> }): Promise<void> => {
    const live = new Set(input.panes.map((pane) => pane.paneId))
    for (const paneId of [...roots.keys()]) if (!live.has(paneId) && !input.keep.has(paneId)) roots.delete(paneId)
    const now = deps.now()
    const asks = input.panes.filter((pane) => {
      const cached = roots.get(pane.paneId)
      return cached === undefined || (cached.shellPid === null && now - cached.probedAt >= (cached.missing ? MISSING_RETRY_MS : PROBE_RETRY_MS))
    })
    for (const pane of asks) {
      const { shellPid, missing } = await probe(pane.paneId)
      input.asked.add(pane.paneId)
      roots.set(pane.paneId, { shellPid, missing, parentPid: null, probedAt: deps.now(), healthy: false })
    }
    if (asks.length > 0) deps.log('resource.probe', { asked: asks.length, reason: 'new-or-retry', total: stats.processInfoRequests })
  }

  /** 캐시한 루트를 이번 ps 표와 대조하고, 어긋난 pane 은 규칙대로 다시 묻는다(F1). */
  const verifyRoots = async (input: { panes: readonly { paneId: string }[]; table: PsTable; asked: Set<string> }): Promise<void> => {
    let reasked = 0
    for (const pane of input.panes) {
      const cached = roots.get(pane.paneId)
      if (cached === undefined || cached.shellPid === null) continue
      const row = input.table.rows.get(cached.shellPid)
      if (row !== undefined && (cached.parentPid === null || row.ppid === cached.parentPid)) {
        roots.set(pane.paneId, { ...cached, parentPid: cached.parentPid ?? row.ppid, healthy: true })
        continue
      }
      const due = cached.healthy || deps.now() - cached.probedAt >= PROBE_RETRY_MS
      if (input.asked.has(pane.paneId) || !due) {
        roots.set(pane.paneId, { ...cached, healthy: false })
        continue
      }
      const { shellPid, missing } = await probe(pane.paneId)
      input.asked.add(pane.paneId)
      reasked += 1
      const fresh = shellPid === null ? undefined : input.table.rows.get(shellPid)
      roots.set(
        pane.paneId,
        shellPid === cached.shellPid
          ? { ...cached, probedAt: deps.now(), healthy: false }
          : { shellPid, missing, parentPid: fresh?.ppid ?? null, probedAt: deps.now(), healthy: fresh !== undefined },
      )
    }
    if (reasked > 0) deps.log('resource.probe', { asked: reasked, reason: 'root-changed', total: stats.processInfoRequests })
  }

  const tick = async (): Promise<void> => {
    if (!deps.visible()) {
      stats.skippedHidden += 1
      return
    }
    const startedAt = deps.now()
    const panes = deps.panes()
    const orphans = deps.orphans?.() ?? null
    // 카드 pane 과 카드 밖 pane 을 한 캐시로 잰다 — 카드 밖 pane 의 자손이 herdr 행으로 빠지지 않게 pane 으로 먼저 잡는다.
    const measured = [...panes, ...(orphans ?? []).flatMap((orphan) => orphan.paneIds.map((paneId) => ({ paneId })))]
    // 카드 밖을 가릴 수 없는 틱(null)에는 직전 카드 밖 pane 의 캐시를 지우지 않는다 — 돌아왔을 때 전부 다시 묻지 않게(F5).
    if (orphans !== null) lastOrphanPanes = new Set(orphans.flatMap((orphan) => orphan.paneIds))
    const asked = new Set<string>()
    await refreshRoots({ panes: measured, keep: orphans === null ? lastOrphanPanes : new Set(), asked })
    stats.hostReads += 1
    const hostRead = deps.readHost()
    let stdout: string | null = null
    try {
      stdout = await deps.readPs()
    } catch (error) {
      deps.log('resource.ps_failed', { error: String(error) })
    }
    const table = stdout === null ? null : parsePsTable(stdout)
    const tableOk = table !== null && table.malformed === 0
    if (tableOk) stats.footprintRuns += 1
    const footprint: FootprintTable = tableOk ? await deps.readFootprint() : { kind: 'unavailable', reason: 'ps 표가 없다' }
    // 도우미를 실제로 돌린 주기에서, 사유가 바뀔 때만 남긴다 — 도우미가 없으면 2초마다 같은 줄이 쌓인다.
    // ps 가 실패한 주기는 도우미 결과가 아니므로 기억을 바꾸지 않는다(C1-7(a) — 그 뒤 첫 정상 주기에 'ok' 가 잘못 남지 않게).
    if (tableOk) {
      const footprintReason = footprint.kind === 'unavailable' ? footprint.reason : null
      if (footprintReason !== lastFootprintReason) deps.log('resource.footprint', { reason: footprintReason ?? 'ok' })
      lastFootprintReason = footprintReason
    }
    // 표가 없거나 이상하면 대조하지 않는다 — 깨진 표로 캐시를 지우면 멀쩡한 pane 을 다시 묻게 된다.
    if (table !== null && table.malformed === 0) await verifyRoots({ panes: measured, table, asked })
    const unavailable: ResourceMeasure = { state: 'unavailable', reason: 'ps 실행 실패' }
    const attribution = table === null
      ? { panes: new Map(measured.map((pane) => [pane.paneId, unavailable])), herdr: unavailable, app: unavailable }
      : attribute({
          table,
          footprint,
          panes: measured.map((pane) => {
            const cached = roots.get(pane.paneId)
            return { paneId: pane.paneId, shellPid: cached?.shellPid ?? null, expectedParent: cached?.parentPid ?? null }
          }),
          appRoots: deps.appRoots(),
        })
    const noRuntime: ResourceMeasure = { state: 'unavailable', reason: NO_RUNTIME_REASON }
    const measureOf = (paneId: string): ResourceMeasure => (roots.get(paneId)?.missing === true ? noRuntime : attribution.panes.get(paneId) ?? unavailable)
    const rows: ResourcePaneRow[] = panes.map((pane) => ({ ...pane, measure: measureOf(pane.paneId) }))
    const orphanRows: ResourceOrphanRow[] | null = orphans === null
      ? null
      : orphans.map((orphan) => ({ ...orphan, measure: combineMeasures(orphan.paneIds.map(measureOf)) }))
    const orphanPaneMeasures = (orphans ?? []).flatMap((orphan) => orphan.paneIds.map(measureOf))
    const { total, unavailableCount } = totalOf([attribution.app, attribution.herdr, ...rows.map((row) => row.measure), ...orphanPaneMeasures])
    const host = await hostRead
    stats.collections += 1
    stats.recentDurationsMs = [...stats.recentDurationsMs, deps.now() - startedAt].slice(-DURATION_SAMPLES)
    latest = {
      collectedAt: deps.now(),
      total,
      unavailableCount,
      app: attribution.app,
      herdr: attribution.herdr,
      panes: rows,
      orphans: orphanRows,
      orphansReason: orphanRows === null ? deps.orphansReason?.() ?? null : null,
      host,
      stats: { ...stats, recentDurationsMs: [...stats.recentDurationsMs] },
    }
    deps.emit(latest)
  }

  // 한 주기가 끝난 뒤에 다음 주기를 건다 — ps 가 느려도 주기가 겹치지 않는다.
  const cycle = (): void => {
    inFlight = true
    void tick()
      .catch((error: unknown) => deps.log('resource.tick_failed', { error: String(error) }))
      .finally(() => {
        inFlight = false
        if (!running) return
        if (wakePending) {
          wakePending = false
          cycle()
          return
        }
        timer = setTimeout(cycle, intervalMs)
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
      wakePending = false
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    wake: () => {
      if (!running) return
      if (inFlight) {
        wakePending = true
        return
      }
      if (timer !== null) clearTimeout(timer)
      timer = null
      cycle()
    },
    tick,
    latest: () => latest,
    stats: () => ({ ...stats, recentDurationsMs: [...stats.recentDurationsMs] }),
  }
}
