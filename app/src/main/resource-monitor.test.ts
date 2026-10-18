// LIFE-637 — 주기 수집의 비용 규칙(R6ⓐⓒⓓ의 단위 근거). 최종 관문의 실측 카운터는 별도다.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourceSnapshot } from '../shared/resource.js'
import { createResourceMonitor, PROBE_RETRY_MS, RESOURCE_INTERVAL_MS, type ResourceMonitorDeps, type ResourcePaneSource } from './resource-monitor.js'

const PS = '  100 1 1.0 100\n  200 1 2.0 200\n  300 200 3.0 300\n  400 200 4.0 400\n'
const pane = (paneId: string): ResourcePaneSource => ({ paneId, tabId: `t-${paneId}`, workspaceId: 'w', groupKey: '/wt', groupLabel: 'wt', title: paneId, agent: null, tabPaneCount: 1, worktreeTabCount: 1 })

function harness(input: { panes: ResourcePaneSource[]; shellPids: Record<string, number | null>; visible?: boolean; intervalMs?: number }) {
  const state = { panes: input.panes, visible: input.visible ?? true, now: 1000, ps: PS, psFails: false }
  const emitted: ResourceSnapshot[] = []
  const probe = vi.fn(async (paneId: string) => input.shellPids[paneId] ?? null)
  const readPs = vi.fn(async () => {
    if (state.psFails) throw new Error('ps 없음')
    return state.ps
  })
  const deps: ResourceMonitorDeps = {
    intervalMs: input.intervalMs ?? RESOURCE_INTERVAL_MS,
    readPs,
    panes: () => state.panes,
    probeShellPid: probe,
    appRoots: () => [100],
    visible: () => state.visible,
    host: () => ({ totalMemory: 8, usedMemory: 4, cpuCoreCount: 2 }),
    emit: (snapshot) => emitted.push(snapshot),
    now: () => state.now,
    log: () => {},
  }
  return { state, emitted, probe, readPs, monitor: createResourceMonitor(deps) }
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
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.monitor.stats()).toMatchObject({ collections: 0, skippedHidden: 2, processInfoRequests: 0 })
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
    expect(snapshot?.panes[0]).toMatchObject({ paneId: 'a', title: 'a', measure: { state: 'measured', usage: { cpu: 3, memory: 300 * 1024 }, pids: [300] } })
    expect(snapshot?.herdr).toMatchObject({ state: 'measured', pids: [200, 400] })
    expect(snapshot?.app).toMatchObject({ state: 'measured', pids: [100] })
    expect(snapshot?.total).toEqual({ cpu: 10, memory: 1000 * 1024 })
    expect(snapshot?.stats.recentDurationsMs).toHaveLength(1)
    expect(h.monitor.latest()).toBe(snapshot)
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
    h.probe.mockImplementation(async () => 700)
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
