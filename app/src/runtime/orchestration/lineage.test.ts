/**
 * LIFE-459 — the parent record `worker-start` writes, and the lineage resolved from it.
 *
 * L1: what is recorded, and that a document from before the field loads unchanged.
 * L2: a parent survives only when session and both generations still match.
 * L3: reused panes, retries, released panes, settled attempts (U5).
 * L4: depth, self-loops and cycles.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchestrationStore } from './store.js'
import { createDispatch, createRun, createTask, emptyState, transition, type DispatchTarget, type OrchestrationState, type WorkerSpawner } from './model.js'
import { emptyWorker, withWorker, replaceDispatchRecord } from './worker.js'
import { resolveLineage, sameBackendSession, type LivePanes } from './lineage.js'
import { TerminalBackend, type TerminalIdentity } from '../../main/adapter/index.js'
import { isRecord } from '../../shared/json.js'

const AT = '2026-09-30T00:00:00.000Z'
const target = (paneId: string, ptyId = `pty-${paneId}`, epoch = 'e1'): DispatchTarget => ({ handle: `h-${paneId}`, runtimeId: 'rt', epoch, ptyId, paneId })
const fromPane = (paneId: string, session: string | null = 's1', ptyId: string | null = `pty-${paneId}`, epoch: string | null = 'e1'): WorkerSpawner =>
  ({ kind: 'pane', paneId, session, epoch, ptyId })

/** A document with one Run, where `start` makes a new Task and starts one worker attempt for it. */
function world() {
  let state: OrchestrationState = createRun(emptyState(), 'lineage', AT).state
  const runId = state.currentRunId!
  const start = (input: { pane: DispatchTarget; spawner: WorkerSpawner | null; paneSession?: string | null; taskId?: string }): string => {
    let taskId = input.taskId
    if (taskId === undefined) {
      const made = createTask(state, { runId, spec: 'x', title: null, deps: [], at: AT })
      state = made.state
      taskId = made.task.id
    }
    const task = state.tasks.find(entry => entry.id === taskId)!
    const worker = emptyWorker({ launch: 'created', ownership: 'owned', paneSession: input.paneSession === undefined ? 's1' : input.paneSession, originDispatchId: null, spawner: input.spawner })
    const made = createDispatch(state, { task, target: input.pane, agent: null, agentAbsenceReason: 'test', worker, at: AT })
    state = made.state
    return made.dispatch.id
  }
  const settle = (dispatchId: string, to: 'completed' | 'failed') => {
    const entry = state.dispatches.find(row => row.id === dispatchId)!
    state = transition(state, { taskId: entry.taskId, to, settledBy: 'worker_done', at: AT }).state
  }
  const release = (dispatchId: string) => {
    const entry = state.dispatches.find(row => row.id === dispatchId)!
    state = replaceDispatchRecord(state, withWorker(entry, { release: { state: 'released', reason: 'test', at: AT, processAction: 'closed' } }, AT))
  }
  return { get state() { return state }, start, settle, release }
}
const live = (panes: [string, string][], epoch = 'e1', session: string | null = 's1'): LivePanes =>
  ({ session, epoch, panes: panes.map(([paneId, ptyId]) => ({ paneId, ptyId })) })
const standard = (...ids: string[]) => live(ids.map(id => [id, `pty-${id}`]))
const parents = (state: OrchestrationState, seen: LivePanes) =>
  Object.fromEntries(resolveLineage(state, seen).map(entry => [entry.paneId, entry.parentPaneId]))

describe('LIFE-459 L2 — a parent is kept only when session and both generations match', () => {
  it('resolves the caller pane as the parent when everything matches', () => {
    const w = world()
    const id = w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    const entries = resolveLineage(w.state, standard('w1:p1', 'w1:p2'))
    expect(entries).toEqual([{ paneId: 'w1:p2', runId: w.state.currentRunId, taskId: w.state.tasks[0]!.id, dispatchId: id, dispatchStatus: 'dispatched', parentPaneId: 'w1:p1' }])
  })

  it('drops the parent when the parent pane is closed', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    expect(parents(w.state, standard('w1:p2'))).toEqual({ 'w1:p2': null })
  })

  it('drops the parent when its pane id now holds a new PTY', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    expect(parents(w.state, live([['w1:p1', 'pty-new'], ['w1:p2', 'pty-w1:p2']]))).toEqual({ 'w1:p2': null })
  })

  it('drops the parent when the caller lived in another session', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1', 'other') })
    expect(parents(w.state, standard('w1:p1', 'w1:p2'))).toEqual({ 'w1:p2': null })
  })

  it('has no parent when the caller was outside any pane, or the record predates the field', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: { kind: 'outside_pane' } })
    w.start({ pane: target('w1:p3'), spawner: null })
    expect(parents(w.state, standard('w1:p1', 'w1:p2', 'w1:p3'))).toEqual({ 'w1:p2': null, 'w1:p3': null })
  })

  it('has no parent when the caller generation could not be read (the U2 fallback)', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1', 's1', null, null) })
    expect(parents(w.state, standard('w1:p1', 'w1:p2'))).toEqual({ 'w1:p2': null })
  })

  it('gives no entry at all when the child pane is a new PTY or the backend generation moved', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    expect(resolveLineage(w.state, live([['w1:p1', 'pty-w1:p1'], ['w1:p2', 'pty-other']]))).toEqual([])
    expect(resolveLineage(w.state, live([['w1:p1', 'pty-w1:p1'], ['w1:p2', 'pty-w1:p2']], 'e2'))).toEqual([])
  })

  it('treats an unset HERDR_SESSION and CORRAL_SESSION=default as the same session', () => {
    expect(sameBackendSession(null, 'default')).toBe(true)
    expect(sameBackendSession('', 'default')).toBe(true)
    expect(sameBackendSession('s1', 'default')).toBe(false)
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1', null), paneSession: 'default' })
    expect(parents(w.state, { ...standard('w1:p1', 'w1:p2'), session: 'default' })).toEqual({ 'w1:p2': 'w1:p1' })
  })
})

describe('LIFE-459 L3 — reuse, retries and lifetime', () => {
  it('a reused pane carries only the latest attempt\'s parent', () => {
    const w = world()
    const first = w.start({ pane: target('w1:p3'), spawner: fromPane('w1:p1') })
    w.settle(first, 'completed')
    const second = w.start({ pane: target('w1:p3'), spawner: fromPane('w1:p2') })
    const entries = resolveLineage(w.state, standard('w1:p1', 'w1:p2', 'w1:p3'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ paneId: 'w1:p3', dispatchId: second, parentPaneId: 'w1:p2' })
  })

  it('a reused pane whose new caller was outside a pane does not inherit the old parent', () => {
    const w = world()
    const first = w.start({ pane: target('w1:p3'), spawner: fromPane('w1:p1') })
    w.settle(first, 'completed')
    w.start({ pane: target('w1:p3'), spawner: { kind: 'outside_pane' } })
    expect(parents(w.state, standard('w1:p1', 'w1:p3'))).toEqual({ 'w1:p3': null })
  })

  it('a retry on another pane gives the new pane the parent, and the old pane keeps its own attempt', () => {
    const w = world()
    const first = w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    w.settle(first, 'failed')
    const task = w.state.dispatches[0]!.taskId
    w.start({ pane: target('w1:p3'), spawner: fromPane('w1:p1'), taskId: task })
    expect(parents(w.state, standard('w1:p1', 'w1:p2', 'w1:p3'))).toEqual({ 'w1:p2': 'w1:p1', 'w1:p3': 'w1:p1' })
    expect(parents(w.state, standard('w1:p1', 'w1:p3'))).toEqual({ 'w1:p3': 'w1:p1' })
  })

  it('an entry disappears when its pane closes or is released', () => {
    const w = world()
    const id = w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    expect(resolveLineage(w.state, standard('w1:p1'))).toEqual([])
    w.settle(id, 'completed')
    w.release(id)
    expect(resolveLineage(w.state, standard('w1:p1', 'w1:p2'))).toEqual([])
  })

  it('U5: a settled attempt keeps its lineage while its pane lives, with its status', () => {
    const w = world()
    const id = w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    w.settle(id, 'completed')
    expect(resolveLineage(w.state, standard('w1:p1', 'w1:p2'))).toMatchObject([{ paneId: 'w1:p2', dispatchStatus: 'completed', parentPaneId: 'w1:p1' }])
  })

  it('ignores attempts that were not started as workers', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    const plain = { ...w.state, dispatches: w.state.dispatches.map(entry => ({ ...entry, worker: null })) }
    expect(resolveLineage(plain, standard('w1:p1', 'w1:p2'))).toEqual([])
  })
})

describe('LIFE-459 L4 — depth and cycles', () => {
  it('a worker that starts a worker becomes its parent, to any depth', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    w.start({ pane: target('w1:p3'), spawner: fromPane('w1:p2') })
    w.start({ pane: target('w1:p4'), spawner: fromPane('w1:p3') })
    expect(parents(w.state, standard('w1:p1', 'w1:p2', 'w1:p3', 'w1:p4'))).toEqual({ 'w1:p2': 'w1:p1', 'w1:p3': 'w1:p2', 'w1:p4': 'w1:p3' })
  })

  it('a pane is never its own parent', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p2') })
    expect(parents(w.state, standard('w1:p2'))).toEqual({ 'w1:p2': null })
  })

  it('cuts a two-pane loop made by reuse at the oldest attempt', () => {
    const w = world()
    const aInB = w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    w.settle(aInB, 'completed')
    // Later the worker pane hands the first pane a Task: p1's latest attempt names p2 as its parent.
    w.start({ pane: target('w1:p1'), spawner: fromPane('w1:p2') })
    expect(parents(w.state, standard('w1:p1', 'w1:p2'))).toEqual({ 'w1:p2': null, 'w1:p1': 'w1:p2' })
  })

  it('cuts a three-pane loop once, and the result is a forest', () => {
    const w = world()
    const one = w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    const two = w.start({ pane: target('w1:p3'), spawner: fromPane('w1:p2') })
    w.settle(one, 'completed'); w.settle(two, 'completed')
    w.start({ pane: target('w1:p1'), spawner: fromPane('w1:p3') })
    const map = parents(w.state, standard('w1:p1', 'w1:p2', 'w1:p3'))
    expect(map).toEqual({ 'w1:p2': null, 'w1:p3': 'w1:p2', 'w1:p1': 'w1:p3' })
    for (const start of Object.keys(map)) {
      const seen = new Set<string>()
      for (let at: string | null | undefined = start; at != null; at = map[at]) {
        expect(seen.has(at)).toBe(false)
        seen.add(at)
      }
    }
  })
})

describe('LIFE-459 L1 — the record loads from a document that predates it', () => {
  it('fills an absent spawner with null and refuses a malformed one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l459-store-'))
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane('w1:p1') })
    const store = new OrchestrationStore(dir)
    const file = store.file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const legacy = JSON.parse(JSON.stringify(w.state))
    delete legacy.dispatches[0].worker.spawner
    fs.writeFileSync(file, JSON.stringify(legacy))
    const bytes = fs.readFileSync(file, 'utf8')
    expect(store.read().dispatches[0]!.worker!.spawner).toBeNull()
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    for (const broken of [{ kind: 'pane' }, { kind: 'pane', paneId: 'w1:p1', session: 1, epoch: null, ptyId: null }, { kind: 'elsewhere' }, 'w1:p1']) {
      legacy.dispatches[0].worker.spawner = broken
      fs.writeFileSync(file, JSON.stringify(legacy))
      expect(() => store.read()).toThrow(/not readable/)
    }
    legacy.dispatches[0].worker.spawner = { kind: 'outside_pane' }
    fs.writeFileSync(file, JSON.stringify(legacy))
    expect(store.read().dispatches[0]!.worker!.spawner).toEqual({ kind: 'outside_pane' })
  })
})

// --- worker-start writes it -----------------------------------------------------------------------

const term = vi.hoisted(() => ({ create: { handle: 't1.child', epoch: 'e1', ptyId: 'pty-child', paneId: 'w1:p9' } }))
vi.mock('../terminal/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../terminal/index.js')>()
  return {
    ...actual,
    terminalModule: () => ({
      specs: [], validate: () => {},
      execute: async (inv: { command: string }) => {
        if (inv.command === 'terminal create') return { terminal: term.create, agent: { kind: 'claude' }, stages: { agent: { status: 'completed' } } }
        // The record is written before readiness is asked, so an agent that never becomes ready is
        // enough to stop the start right after the attempt is on disk.
        if (inv.command === 'terminal wait') return { satisfied: false, agent: { phase: 'launching' } }
        throw Error(inv.command)
      },
    }),
  }
})
const { orchestrationModule } = await import('./index.js')

const CALLER: TerminalIdentity = { epoch: 'e1', ptyId: 'pty-caller', paneId: 'w1:p1', tabId: 't', workspaceId: 'w', path: '/tmp', repo: '/tmp', title: 'caller' }
async function startFrom(caller: { paneId: string | null; session: string | null }, env: { session?: string; panes?: TerminalIdentity[] } = {}) {
  process.env.CORRAL_BACKEND_SOCKET = '/tmp/l459-mock'
  if (env.session === undefined) delete process.env.CORRAL_SESSION
  else process.env.CORRAL_SESSION = env.session
  vi.spyOn(TerminalBackend.prototype, 'epoch').mockResolvedValue('e1')
  vi.spyOn(TerminalBackend.prototype, 'list').mockResolvedValue(env.panes ?? [CALLER])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l459-start-'))
  const run = createRun(emptyState(), 'lineage', new Date().toISOString())
  const made = createTask(run.state, { runId: run.run.id, spec: 'body', title: null, deps: [], at: new Date().toISOString() })
  const store = new OrchestrationStore(dir)
  store.write(made.state)
  const mod = orchestrationModule(dir)
  await new Promise(resolve => setTimeout(resolve, 5))
  const ctx = { runtimeId: 'runtime', instanceId: 'instance', userData: dir, signal: new AbortController().signal, deadlineAt: Date.now() + 10000, remote: false }
  const result = await mod.execute({ command: 'orchestration worker-start', flags: { task: made.task.id, agent: 'claude', worktree: dir, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: dir, caller }, ctx)
  if (!isRecord(result) || typeof result.dispatchId !== 'string') throw Error(`no attempt: ${JSON.stringify(result)}`)
  return store.read().dispatches.find(entry => entry.id === result.dispatchId)!.worker!.spawner
}

describe('LIFE-459 L1 — worker-start records the caller pane', () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CORRAL_BACKEND_SOCKET; delete process.env.CORRAL_SESSION })

  it('records the caller pane with the generation the backend reports for it', async () => {
    expect(await startFrom({ paneId: 'w1:p1', session: 's1' }, { session: 's1' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: 's1', epoch: 'e1', ptyId: 'pty-caller' })
  })

  it('records a caller outside any pane as such, and guesses nothing', async () => {
    expect(await startFrom({ paneId: null, session: null }, { session: 's1' })).toEqual({ kind: 'outside_pane' })
  })

  it('records no generation for a caller in another session, or one the backend does not list', async () => {
    expect(await startFrom({ paneId: 'w1:p1', session: 'other' }, { session: 's1' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: 'other', epoch: null, ptyId: null })
    expect(await startFrom({ paneId: 'w1:p1', session: 's1' }, { session: 's1', panes: [] }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: 's1', epoch: null, ptyId: null })
  })

  it('reads the generation for a default-session pane, where herdr leaves HERDR_SESSION unset', async () => {
    expect(await startFrom({ paneId: 'w1:p1', session: null }, { session: 'default' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: null, epoch: 'e1', ptyId: 'pty-caller' })
  })
})
