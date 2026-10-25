// LIFE-637 — 주기 수집의 비용 규칙(R6ⓐⓒⓓ의 단위 근거). 최종 관문의 실측 카운터는 별도다.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourceHost, ResourceSnapshot } from '../shared/resource.js'
import { parseFootprintTable, type FootprintTable } from './resource-collector.js'
import { createResourceMonitor, MISSING_RETRY_MS, NO_RUNTIME_REASON, PROBE_RETRY_MS, RESOURCE_INTERVAL_MS, type ResourceMonitorDeps, type ResourceOrphanSource, type ResourcePaneSource, type ShellProbe } from './resource-monitor.js'

// 고정 입력: pid ppid %cpu footprint(KB) — 앞 세 칸이 ps stdout(psOf 가 tpgid·이름을 붙인다), 넷째 칸이 도우미 footprint 표(바이트)가 된다(LIFE-676).
const PS = '  100 1 1.0 100\n  200 1 2.0 200\n  300 200 3.0 300\n  400 200 4.0 400\n'
// 앞 세 칸 뒤에 tpgid(= 자기 pid)·이름 `p<pid>` 를 붙인다(LIFE-688). 칸이 모자란 줄은 그대로.
const psOf = (text: string): string => text.split('\n').map((line) => {
  const cells = line.trim().split(/\s+/)
  return cells.length >= 3 ? [...cells.slice(0, 3), cells[0], `p${cells[0]}`].join(' ') : line.trim()
}).join('\n')
const fpOf = (text: string): FootprintTable => parseFootprintTable(text.split('\n').flatMap((line) => {
  const cells = line.trim().split(/\s+/)
  return cells.length === 4 && /^\d+$/.test(cells[3] ?? '') ? [`${cells[0]} ${Number(cells[3]) * 1024}`] : []
}).join('\n'))
const HOST: ResourceHost = { physicalMemory: 8, cpuCoreCount: 2, pressure: 'warning', swap: { used: 1, total: 2 }, compressed: 3 }
const pane = (paneId: string): ResourcePaneSource => ({ paneId, tabId: `t-${paneId}`, workspaceId: 'w', groupKey: '/wt', groupLabel: 'wt', title: paneId, agent: null })

function harness(input: { panes: ResourcePaneSource[]; shellPids: Record<string, number | null | 'missing'>; visible?: boolean; intervalMs?: number; orphans?: ResourceOrphanSource[] | null }) {
  const state: { panes: ResourcePaneSource[]; orphans: ResourceOrphanSource[] | null; visible: boolean; now: number; ps: string; psFails: boolean; footprint: FootprintTable | null; calls: string[] } = {
    panes: input.panes, orphans: input.orphans ?? null, visible: input.visible ?? true, now: 1000, ps: PS, psFails: false, footprint: null, calls: [],
  }
  const emitted: ResourceSnapshot[] = []
  // 숫자 = 셸 pid, 'missing' = herdr pane_not_found(런타임 없는 pane — LIFE-628 F5), null/없음 = 모름.
  const probe = vi.fn(async (paneId: string): Promise<ShellProbe> => {
    const value = input.shellPids[paneId] ?? null
    return value === null ? { kind: 'unknown' } : value === 'missing' ? { kind: 'missing' } : { kind: 'pid', pid: value }
  })
  const readPs = vi.fn(async () => {
    state.calls.push('ps')
    if (state.psFails) throw new Error('ps 없음')
    return psOf(state.ps)
  })
  const readFootprint = vi.fn(async () => {
    state.calls.push('footprint')
    return state.footprint ?? fpOf(state.ps)
  })
  const readHost = vi.fn(async () => {
    state.calls.push('host')
    return HOST
  })
  const log = vi.fn<(tag: string, data: Record<string, unknown>) => void>()
  const deps: ResourceMonitorDeps = {
    intervalMs: input.intervalMs ?? RESOURCE_INTERVAL_MS,
    readPs,
    readFootprint,
    panes: () => state.panes,
    orphans: () => state.orphans,
    probeShellPid: probe,
    appRoots: () => [100],
    visible: () => state.visible,
    readHost,
    emit: (snapshot) => emitted.push(snapshot),
    now: () => state.now,
    log,
  }
  return { state, emitted, probe, readPs, readFootprint, readHost, log, monitor: createResourceMonitor(deps) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('resource monitor', () => {
  it('주기는 2초 아래로 내려가지 않는다 (R6ⓐ)', () => {
    expect(harness({ panes: [], shellPids: {}, intervalMs: 500 }).monitor.stats().intervalMs).toBe(2000)
  })

  it('창이 숨김이면 ps·herdr 요청 0, 건너뛴 주기만 센다 (R6ⓒ)', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 }, visible: false })
    await h.monitor.tick()
    await h.monitor.tick()
    expect(h.readPs).not.toHaveBeenCalled()
    expect(h.readFootprint).not.toHaveBeenCalled()
    expect(h.readHost).not.toHaveBeenCalled()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.monitor.stats()).toMatchObject({ collections: 0, skippedHidden: 2, processInfoRequests: 0, footprintRuns: 0, hostReads: 0 })
    expect(h.emitted).toHaveLength(0)
  })

  it('pane 변화가 없는 주기에는 herdr 요청 0, 새 pane 만 묻는다 (R6ⓓ)', async () => {
    const h = harness({ panes: [pane('a'), pane('b')], shellPids: { a: 300, b: 400 } })
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
    await h.monitor.tick()
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
    h.state.panes = [pane('a'), pane('b'), pane('c')]
    await h.monitor.tick()
    expect(h.probe).toHaveBeenLastCalledWith('c')
    expect(h.monitor.stats()).toMatchObject({ collections: 4, processInfoRequests: 3 })
  })

  it('닫힌 pane 의 캐시는 지운다 — 같은 id 가 다시 오면 다시 묻는다', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    h.state.panes = []
    await h.monitor.tick()
    h.state.panes = [pane('a')]
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
  })

  it('셸 pid 를 못 얻은 pane 은 측정 불가, PROBE_RETRY_MS 뒤에만 다시 묻는다', async () => {
    const h = harness({ panes: [pane('x')], shellPids: { x: null } })
    await h.monitor.tick()
    expect(h.emitted.at(-1)?.panes[0]?.measure.state).toBe('unavailable')
    h.state.now += PROBE_RETRY_MS - 1
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(1)
    h.state.now += 1
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
  })

  it('스냅샷 — pane 행·전체·카운터', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    const snapshot = h.emitted.at(-1)
    expect(snapshot?.panes[0]).toMatchObject({ paneId: 'a', title: 'a', measure: { state: 'measured', usage: { cpu: 3, memory: { state: 'measured', bytes: 300 * 1024 } }, pids: [300] } })
    expect(snapshot?.herdr).toMatchObject({ state: 'measured', pids: [200, 400] })
    expect(snapshot?.app).toMatchObject({ state: 'measured', pids: [100] })
    expect(snapshot?.total).toEqual({ cpu: 10, memory: { state: 'measured', bytes: 1000 * 1024 } })
    expect(snapshot?.host).toEqual(HOST)
    expect(snapshot?.stats.recentDurationsMs).toHaveLength(1)
    expect(h.monitor.latest()).toBe(snapshot)
  })

  it('LIFE-688 — pane 행에 주 프로세스, 측정 불가·런타임 없음·ps 실패 행은 null · ps 1회·herdr 요청 불변', async () => {
    const h = harness({ panes: [pane('a'), pane('x'), pane('m')], shellPids: { a: 300, x: null, m: 'missing' } })
    await h.monitor.tick()
    const rows = h.emitted.at(-1)?.panes ?? []
    expect(rows.map((row) => [row.paneId, row.measure.state, row.main])).toEqual([
      ['a', 'measured', { pid: 300, name: 'p300' }],
      ['x', 'unavailable', null],
      ['m', 'unavailable', null],
    ])
    expect(h.readPs).toHaveBeenCalledTimes(1)
    expect(h.monitor.stats().processInfoRequests).toBe(3)
    await h.monitor.tick()
    expect(h.readPs).toHaveBeenCalledTimes(2)
    expect(h.monitor.stats().processInfoRequests).toBe(3)
    h.state.psFails = true
    await h.monitor.tick()
    expect(h.emitted.at(-1)?.panes.map((row) => row.main)).toEqual([null, null, null])
  })

  it('리뷰 r1 C-L4① · C-L1 — tpgid ≠ 셸이면 행 main 은 포그라운드 pid·이름, 이름 칸 없는 줄은 이름 null 로 측정 유지', async () => {
    const h = harness({ panes: [pane('a'), pane('b')], shellPids: { a: 300, b: 400 } })
    // footprint 표는 state.ps(4칸 고정 입력)에서, ps stdout 은 tpgid·이름을 직접 적은 표에서.
    h.state.ps = '  100 1 1.0 100\n  200 1 2.0 200\n  300 200 3.0 300\n  301 300 5.0 301\n  400 200 4.0 400\n  401 400 1.0 401\n'
    h.readPs.mockImplementation(async () => '  100 1 1.0 0 corral\n  200 1 2.0 0 herdr\n  300 200 3.0 301 zsh\n  301 300 5.0 301 2.1.296\n  400 200 4.0 401 zsh\n  401 400 1.0 401\n')
    await h.monitor.tick()
    const rows = h.emitted.at(-1)?.panes ?? []
    expect(rows.map((row) => [row.paneId, row.measure.state, row.main])).toEqual([
      ['a', 'measured', { pid: 301, name: '2.1.296' }],
      ['b', 'measured', { pid: 401, name: null }],
    ])
    expect(rows[0]?.measure).toMatchObject({ usage: { cpu: 8 }, pids: [300, 301] })
  })

  it('ps 가 실패하면 전부 측정 불가 — 전체 null(세그먼트 `—`)', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    h.state.psFails = true
    await h.monitor.tick()
    expect(h.emitted.at(-1)).toMatchObject({ total: null, unavailableCount: 3 })
  })

  it('소요 표본은 최근 30개만 둔다', async () => {
    const h = harness({ panes: [], shellPids: {} })
    for (let index = 0; index < 35; index += 1) await h.monitor.tick()
    expect(h.monitor.stats().recentDurationsMs).toHaveLength(30)
    expect(h.monitor.stats().collections).toBe(35)
  })

  it('start — 바로 한 번, 그 뒤 주기마다. stop 뒤에는 멈춘다', async () => {
    vi.useFakeTimers()
    const h = harness({ panes: [], shellPids: {} })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.stats().collections).toBe(1)
    await vi.advanceTimersByTimeAsync(RESOURCE_INTERVAL_MS - 1)
    expect(h.monitor.stats().collections).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.monitor.stats().collections).toBe(2)
    h.monitor.stop()
    await vi.advanceTimersByTimeAsync(RESOURCE_INTERVAL_MS * 3)
    expect(h.monitor.stats().collections).toBe(2)
  })
})

describe('셸 pid 캐시 자가 치유 (F1)', () => {
  it('캐시한 셸이 표에서 사라지면 그 주기에 한 번 다시 묻고 새 셸로 잰다 (리뷰 P1)', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    expect(h.emitted.at(-1)?.panes[0]?.measure).toMatchObject({ state: 'measured', pids: [300] })
    // herdr 가 같은 pane id 에 새 셸 700 을 넣었다.
    h.state.ps = '  100 1 1.0 100\n  200 1 2.0 200\n  700 200 7.0 700\n'
    h.probe.mockImplementation(async () => ({ kind: 'pid', pid: 700 }))
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
    expect(h.emitted.at(-1)?.panes[0]?.measure).toMatchObject({ state: 'measured', pids: [700] })
    // 그 뒤 변화 없는 주기는 다시 0 건.
    await h.monitor.tick()
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
  })

  it('다시 물어도 같은 죽은 pid 면 측정 불가로 두고 PROBE_RETRY_MS 뒤에만 다시 묻는다 — 매 주기 재질의 없음', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    h.state.ps = '  100 1 1.0 100\n  200 1 2.0 200\n'
    for (let index = 0; index < 5; index += 1) await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
    expect(h.emitted.at(-1)?.panes[0]?.measure).toEqual({ state: 'unavailable', reason: '셸 프로세스(pid 300)가 없다' })
    h.state.now += PROBE_RETRY_MS
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(3)
  })

  it('셸 pid 가 무관한 프로세스로 재사용되면(ppid 가 바뀜) 다시 묻고, herdr 가 같은 pid 를 주면 측정 불가 (리뷰 P5)', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    h.state.ps = '  100 1 1.0 100\n  200 1 2.0 200\n  300 1 77.0 900000\n'
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
    expect(h.emitted.at(-1)?.panes[0]?.measure).toEqual({ state: 'unavailable', reason: '셸 pid 300 의 부모가 바뀌었다(200 → 1) — pid 재사용 의심' })
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
  })

  it('표가 이상한 주기에는 캐시를 건드리지 않는다(재질의 0)', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    h.state.ps = '  100 1 1,0 100\n'
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(1)
  })
})

describe('다시 보임 (F10)', () => {
  it('wake — 다음 타이머를 기다리지 않고 곧바로 한 주기', async () => {
    vi.useFakeTimers()
    const h = harness({ panes: [], shellPids: {} })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.stats().collections).toBe(1)
    h.monitor.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.stats().collections).toBe(2)
    h.monitor.stop()
  })
  it('stop 뒤 wake 는 아무것도 하지 않는다', async () => {
    vi.useFakeTimers()
    const h = harness({ panes: [], shellPids: {} })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    h.monitor.stop()
    h.monitor.wake()
    await vi.advanceTimersByTimeAsync(RESOURCE_INTERVAL_MS * 2)
    expect(h.monitor.stats().collections).toBe(1)
  })
})

describe('wake 겹침 (R6ⓐ — wake 경로에서도 주기가 겹치지 않는다)', () => {
  it('진행 중인 주기에 wake 가 와도 ps 는 동시에 하나 — 끝난 뒤 한 번 더', async () => {
    vi.useFakeTimers()
    let concurrent = 0
    let maxConcurrent = 0
    const releases: (() => void)[] = []
    const h = harness({ panes: [], shellPids: {} })
    h.readPs.mockImplementation(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise<void>((resolve) => releases.push(resolve))
      concurrent -= 1
      return PS
    })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    h.monitor.wake()
    h.monitor.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(maxConcurrent).toBe(1)
    releases.shift()?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.stats().collections).toBe(1)
    // 대기 중이던 wake 한 번 — 곧바로 두 번째 주기(타이머를 기다리지 않는다).
    expect(h.readPs).toHaveBeenCalledTimes(2)
    releases.shift()?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.monitor.stats().collections).toBe(2)
    expect(maxConcurrent).toBe(1)
    h.monitor.stop()
  })

  it('LIFE-676 — 도우미는 ps 다음에 돈다(「표에 없음 = 끝남」 규칙의 전제)', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    expect(h.state.calls.filter((call) => call !== 'host')).toEqual(['ps', 'footprint'])
    expect(h.readHost).toHaveBeenCalledTimes(1)
  })

  it('LIFE-676 Q2 — 도우미 실패면 메모리만 측정 불가, CPU 는 그대로 · 사유가 바뀔 때만 로그', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    h.state.footprint = { kind: 'unavailable', reason: 'footprint 도우미가 없다 (/x)' }
    await h.monitor.tick()
    await h.monitor.tick()
    const snapshot = h.emitted.at(-1)
    expect(snapshot?.panes[0]?.measure).toEqual({ state: 'measured', usage: { cpu: 3, memory: { state: 'unavailable', reason: 'footprint 도우미가 없다 (/x)' } }, pids: [300] })
    expect(snapshot?.total).toEqual({ cpu: 10, memory: { state: 'unavailable', reason: 'footprint 도우미가 없다 (/x)' } })
    expect(snapshot?.unavailableCount).toBe(0)
    expect(h.log.mock.calls.filter(([tag]) => tag === 'resource.footprint')).toEqual([['resource.footprint', { reason: 'footprint 도우미가 없다 (/x)' }]])
    h.state.footprint = null
    await h.monitor.tick()
    expect(h.log.mock.calls.filter(([tag]) => tag === 'resource.footprint').at(-1)).toEqual(['resource.footprint', { reason: 'ok' }])
    expect(h.emitted.at(-1)?.total?.memory).toEqual({ state: 'measured', bytes: 1000 * 1024 })
  })

  it('LIFE-676 — ps 가 실패하면 도우미를 부르지 않는다', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    h.state.psFails = true
    await h.monitor.tick()
    expect(h.readFootprint).not.toHaveBeenCalled()
    expect(h.monitor.stats()).toMatchObject({ collections: 1, footprintRuns: 0, hostReads: 1 })
  })

  it('C1-5 — 도우미 실행 수·시스템 지표 읽기 수 카운터 = 실제 호출 수, 스냅샷에도 실린다', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    await h.monitor.tick()
    h.state.visible = false
    await h.monitor.tick()
    expect(h.readFootprint).toHaveBeenCalledTimes(2)
    expect(h.readHost).toHaveBeenCalledTimes(2)
    expect(h.monitor.stats()).toMatchObject({ collections: 2, skippedHidden: 1, footprintRuns: 2, hostReads: 2 })
    expect(h.emitted.at(-1)?.stats).toMatchObject({ footprintRuns: 2, hostReads: 2 })
  })

  it('C1-7(a) — ps 실패 주기 뒤 첫 정상 주기에 resource.footprint ok 를 남기지 않는다', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300 } })
    await h.monitor.tick()
    h.state.psFails = true
    await h.monitor.tick()
    h.state.psFails = false
    await h.monitor.tick()
    // 첫 주기는 기억(null)과 같아 남기지 않고, ps 실패 주기는 기억을 바꾸지 않는다 → 0줄.
    expect(h.log.mock.calls.filter(([tag]) => tag === 'resource.footprint')).toEqual([])
  })

  // LIFE-628 — 카드 밖 workspace 는 pane 과 같은 규칙으로 잰다: 그 자손은 herdr 행이 아니라 그 줄로 간다.
  const orphanOf = (workspaceId: string, paneIds: string[]): ResourceOrphanSource => ({ workspaceId, label: workspaceId, paths: [{ path: '/gone', exists: false }], ownerless: true, agents: ['claude'], stoppedAgents: [], paneIds })

  it('카드 밖 workspace — 그 pane 자손 합이 그 줄로, herdr 행에서는 빠지고 전체에는 든다 (LIFE-628)', async () => {
    // 200(herdr) ← 300(카드 pane a) · 400(카드 밖 pane z)
    const h = harness({ panes: [pane('a')], shellPids: { a: 300, z: 400 }, orphans: [orphanOf('w9', ['z'])] })
    await h.monitor.tick()
    const snapshot = h.emitted.at(-1)
    expect(snapshot?.orphans).toEqual([{ ...orphanOf('w9', ['z']), measure: { state: 'measured', usage: { cpu: 4, memory: { state: 'measured', bytes: 400 * 1024 } }, pids: [400] } }])
    expect(snapshot?.herdr).toEqual({ state: 'measured', usage: { cpu: 2, memory: { state: 'measured', bytes: 200 * 1024 } }, pids: [200] })
    expect(snapshot?.total?.cpu).toBe(10)
    expect(h.monitor.stats().processInfoRequests).toBe(2)
    await h.monitor.tick()
    expect(h.monitor.stats().processInfoRequests).toBe(2)
  })

  it('카드 밖 pane 의 셸 pid 를 모르면 그 줄은 측정 불가(사유), 가릴 수 없으면 orphans 는 null (LIFE-628)', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300, z: null }, orphans: [orphanOf('w9', ['z'])] })
    await h.monitor.tick()
    expect(h.emitted.at(-1)?.orphans?.[0]?.measure).toEqual({ state: 'unavailable', reason: '셸 pid 를 모른다' })
    h.state.orphans = null
    await h.monitor.tick()
    expect(h.emitted.at(-1)?.orphans).toBeNull()
  })

  it('F5 — pane_not_found(런타임 없음) pane 은 30초 재질의를 하지 않고, 줄은 「프로세스 없음」 사유', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300, z: 'missing' }, orphans: [orphanOf('w9', ['z'])] })
    await h.monitor.tick()
    expect(h.emitted.at(-1)?.orphans?.[0]?.measure).toEqual({ state: 'unavailable', reason: NO_RUNTIME_REASON })
    expect(h.probe.mock.calls.filter(([id]) => id === 'z')).toHaveLength(1)
    h.state.now += MISSING_RETRY_MS - 1
    await h.monitor.tick()
    await h.monitor.tick()
    expect(h.probe.mock.calls.filter(([id]) => id === 'z')).toHaveLength(1)
    // 목록에서 빠졌다 돌아오면(pane 세대 변화) 다시 묻는다.
    h.state.orphans = []
    await h.monitor.tick()
    h.state.orphans = [orphanOf('w9', ['z'])]
    await h.monitor.tick()
    expect(h.probe.mock.calls.filter(([id]) => id === 'z')).toHaveLength(2)
  })
  it('F5 — 그 밖의 실패(모름)는 지금처럼 30초 뒤 다시 묻는다(대조)', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300, z: null }, orphans: [orphanOf('w9', ['z'])] })
    await h.monitor.tick()
    h.state.now += PROBE_RETRY_MS
    await h.monitor.tick()
    expect(h.probe.mock.calls.filter(([id]) => id === 'z')).toHaveLength(2)
  })
  it('F5 — 카드 밖을 가릴 수 없는 틱(null)에도 카드 밖 pane 캐시를 지우지 않는다 — 돌아왔을 때 다시 묻지 않는다', async () => {
    const h = harness({ panes: [pane('a')], shellPids: { a: 300, z: 400, y: 'missing' }, orphans: [orphanOf('w9', ['z', 'y'])] })
    await h.monitor.tick()
    const before = h.probe.mock.calls.length
    h.state.orphans = null
    await h.monitor.tick()
    await h.monitor.tick()
    h.state.orphans = [orphanOf('w9', ['z', 'y'])]
    await h.monitor.tick()
    expect(h.probe.mock.calls.length).toBe(before)
    expect(h.monitor.stats().processInfoRequests).toBe(3)
  })
  it('G4 — 런타임 없음 pane 도 60초 뒤 한 번 다시 묻는다: 재기동 뒤 늦게 PTY 가 붙으면 측정으로 돌아온다', async () => {
    const shellPids: Record<string, number | null | 'missing'> = { a: 300, z: 'missing' }
    const h = harness({ panes: [pane('a')], shellPids, orphans: [orphanOf('w9', ['z'])] })
    await h.monitor.tick()
    expect(h.emitted.at(-1)?.orphans?.[0]?.measure).toEqual({ state: 'unavailable', reason: NO_RUNTIME_REASON })
    shellPids.z = 400
    h.state.now += MISSING_RETRY_MS
    await h.monitor.tick()
    expect(h.probe.mock.calls.filter(([id]) => id === 'z')).toHaveLength(2)
    expect(h.emitted.at(-1)?.orphans?.[0]?.measure).toEqual({ state: 'measured', usage: { cpu: 4, memory: { state: 'measured', bytes: 400 * 1024 } }, pids: [400] })
  })
})
