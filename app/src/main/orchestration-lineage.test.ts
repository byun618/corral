/**
 * LIFE-459 L6 — 계보만 바뀌어도 emit, 안 바뀌면 emit 없음. 그리고 부를 필요가 없을 때 백엔드를 안 부른다.
 * R1 — 화면 세션이 바뀌면 이전 세션의 계보는 즉시 내주지 않고, 바뀌는 사이 끝난 계산도 버린다.
 */
import { describe, expect, it } from 'vitest'
import { LineageFeed, type LineageSource } from './orchestration-lineage.js'
import type { PaneSnapshot } from '../runtime/orchestration/index.js'
import { createDispatch, createRun, createTask, emptyState, type OrchestrationState } from '../runtime/orchestration/model.js'
import { emptyWorker } from '../runtime/orchestration/worker.js'

const AT = '2026-09-30T00:00:00.000Z'
function stateWithChild(): OrchestrationState {
  const run = createRun(emptyState(), 'feed', AT)
  const task = createTask(run.state, { runId: run.run.id, spec: 'x', title: null, deps: [], at: AT })
  const worker = emptyWorker({ launch: 'created', ownership: 'owned', paneSession: 's1', originDispatchId: null,
    spawner: { kind: 'pane', paneId: 'w1:p1', session: 's1', verifiedBy: 'session_name', epoch: 'e1', ptyId: 'pty1' } })
  return createDispatch(task.state, { task: task.task, target: { handle: 'h', runtimeId: 'rt', epoch: 'e1', ptyId: 'pty2', paneId: 'w1:p2' }, agent: null, agentAbsenceReason: 'test', worker, at: AT }).state
}

interface World {
  stamp: string | null
  state: OrchestrationState
  corrupt: boolean
  reads: number
  observes: number
  livePanes: Set<string>
  snapshot: PaneSnapshot
  /** 설정하면 observe 가 이 약속이 풀릴 때까지 답하지 않는다. */
  pending: Promise<void> | null
  gui: string | null
  emits: number
}
function harness() {
  const world: World = {
    stamp: 'v1',
    state: stateWithChild(),
    corrupt: false,
    reads: 0,
    observes: 0,
    livePanes: new Set(['w1:p1', 'w1:p2']),
    snapshot: { observed: true, epoch: 'e1', panes: [{ paneId: 'w1:p1', ptyId: 'pty1' }, { paneId: 'w1:p2', ptyId: 'pty2' }] },
    gui: '/sock/s1',
    emits: 0,
    pending: null,
  }
  const source: LineageSource = {
    runtimeBackend: () => ({ socket: '/sock/s1', session: 's1' }),
    guiSocket: () => world.gui,
    livePaneIds: () => world.livePanes,
    stamp: () => world.stamp,
    read: () => {
      world.reads++
      if (world.corrupt) throw new Error('storage_corrupt')
      return world.state
    },
    observe: async () => { world.observes++; await world.pending; return world.snapshot },
    sameSocket: ({ a, b }) => a === b,
  }
  const feed = new LineageFeed({ source, onChange: () => { world.emits++ } })
  return { world, feed }
}

describe('LIFE-459 L6 — emit only when the lineage changes', () => {
  it('emits once for the first answer, then not again while nothing changes', async () => {
    const { world, feed } = harness()
    await feed.refresh()
    expect(world.emits).toBe(1)
    expect(feed.current()).toEqual({ state: 'ready', entries: [expect.objectContaining({ paneId: 'w1:p2', parentPaneId: 'w1:p1' })] })
    await feed.refresh(); await feed.refresh()
    expect(world.emits).toBe(1)
    // The document is parsed once per change of the file, not once per tick.
    expect(world.reads).toBe(1)
  })

  it('emits when only the lineage changes — the parent pane closes', async () => {
    const { world, feed } = harness()
    await feed.refresh()
    world.snapshot = { observed: true, epoch: 'e1', panes: [{ paneId: 'w1:p2', ptyId: 'pty2' }] }
    await feed.refresh()
    expect(world.emits).toBe(2)
    expect(feed.current()).toEqual({ state: 'ready', entries: [expect.objectContaining({ paneId: 'w1:p2', parentPaneId: null })] })
  })

  it('emits when the store changes, and re-reads it only then', async () => {
    const { world, feed } = harness()
    await feed.refresh()
    world.state = { ...world.state, dispatches: [] }
    await feed.refresh()
    expect(world.emits).toBe(1)
    world.stamp = 'v2'
    await feed.refresh()
    expect(world.reads).toBe(2)
    expect(world.emits).toBe(2)
    expect(feed.current()).toEqual({ state: 'ready', entries: [] })
  })

  it('does not ask the backend while no worker pane is alive in the screen session', async () => {
    const { world, feed } = harness()
    world.livePanes = new Set(['w1:p1'])
    await feed.refresh(); await feed.refresh()
    expect(world.observes).toBe(0)
    expect(feed.current()).toEqual({ state: 'ready', entries: [] })
  })

  it('says it cannot tell, rather than empty, when screen and runtime are in different sessions or the pane list is unreadable', async () => {
    const { world, feed } = harness()
    world.gui = '/sock/other'
    await feed.refresh()
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'session_mismatch' })
    // 화면이 돌아오는 순간 이미 '아직 모름' 이다 — 같은 답을 계산해도 다시 emit 하지 않는다.
    world.gui = '/sock/s1'
    world.snapshot = { observed: false, reason: 'observation_failed', detail: null }
    await feed.refresh()
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'unobserved' })
    world.stamp = 'v2'
    world.corrupt = true
    await feed.refresh()
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'store_unreadable' })
    expect(world.emits).toBe(2)
  })
})

describe('LIFE-459 R1 — a value belongs to the screen session it was computed for', () => {
  it('stops supplying the previous session\'s lineage the moment the screen switches', async () => {
    const { world, feed } = harness()
    await feed.refresh()
    expect(feed.current().state).toBe('ready')
    world.gui = '/sock/s2'
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'unobserved' })
    await feed.refresh()
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'session_mismatch' })
    // 돌아오면 그 세션에서 새로 계산한 값만 내준다.
    world.gui = '/sock/s1'
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'unobserved' })
    await feed.refresh()
    expect(feed.current().state).toBe('ready')
  })

  it('discards a computation that finishes after the screen switched', async () => {
    const { world, feed } = harness()
    let release = () => {}
    world.pending = new Promise(resolve => { release = resolve })
    const inFlight = feed.refresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    world.gui = '/sock/s2'
    release()
    await inFlight
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'unobserved' })
    expect(world.emits).toBe(0)
    // 원래 세션으로 돌아와도 버린 값이 살아나지 않는다.
    world.gui = '/sock/s1'
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'unobserved' })
  })
})
