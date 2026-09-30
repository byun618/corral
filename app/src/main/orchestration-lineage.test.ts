/**
 * LIFE-459 L6 — 계보만 바뀌어도 emit, 안 바뀌면 emit 없음. 그리고 부를 필요가 없을 때 백엔드를 안 부른다.
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
    spawner: { kind: 'pane', paneId: 'w1:p1', session: 's1', epoch: 'e1', ptyId: 'pty1' } })
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
    observe: async () => { world.observes++; return world.snapshot },
    sameSocket: (a, b) => a === b,
  }
  const feed = new LineageFeed(source, () => { world.emits++ })
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
    world.gui = '/sock/s1'
    world.snapshot = { observed: false, reason: 'observation_failed', detail: null }
    await feed.refresh()
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'unobserved' })
    world.stamp = 'v2'
    world.corrupt = true
    await feed.refresh()
    expect(feed.current()).toEqual({ state: 'unavailable', reason: 'store_unreadable' })
    expect(world.emits).toBe(3)
  })
})
