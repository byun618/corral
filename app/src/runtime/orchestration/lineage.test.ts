/**
 * LIFE-459 — the parent record `worker-start` writes, and the lineage resolved from it.
 *
 * L1: what is recorded, and that a document from before the field loads unchanged.
 * L2: a parent survives only when the caller was placed in the backend and both generations still match.
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
import { resolveLineage, type LivePanes } from './lineage.js'
import { TerminalBackend, type TerminalIdentity } from '../../main/adapter/index.js'
import type { CallerIdentity } from '../contracts.js'
import { isRecord } from '../../shared/json.js'

const AT = '2026-09-30T00:00:00.000Z'
const target = (paneId: string, ptyId = `pty-${paneId}`, epoch = 'e1'): DispatchTarget => ({ handle: `h-${paneId}`, runtimeId: 'rt', epoch, ptyId, paneId })
type PaneSpawner = Extract<WorkerSpawner, { kind: 'pane' }>
const fromPane = ({ paneId, ...rest }: Partial<PaneSpawner> & { paneId: string }): WorkerSpawner =>
  ({ kind: 'pane', paneId, session: 's1', verifiedBy: 'session_name', epoch: 'e1', ptyId: `pty-${paneId}`, ...rest })

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
const lineageOf = (state: OrchestrationState, seen: LivePanes) => resolveLineage({ state, live: seen })
const parents = (state: OrchestrationState, seen: LivePanes) =>
  Object.fromEntries(lineageOf(state, seen).map(entry => [entry.paneId, entry.parentPaneId]))

describe('LIFE-459 L2 — a parent is kept only when the caller was placed and both generations match', () => {
  it('resolves the caller pane as the parent when everything matches', () => {
    const w = world()
    const id = w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    const entries = lineageOf(w.state, standard('w1:p1', 'w1:p2'))
    expect(entries).toEqual([{ paneId: 'w1:p2', runId: w.state.currentRunId, taskId: w.state.tasks[0]!.id, dispatchId: id, dispatchStatus: 'dispatched', parentPaneId: 'w1:p1' }])
  })

  it('drops the parent when the parent pane is closed', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    expect(parents(w.state, standard('w1:p2'))).toEqual({ 'w1:p2': null })
  })

  it('drops the parent when its pane id now holds a new PTY', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    expect(parents(w.state, live([['w1:p1', 'pty-new'], ['w1:p2', 'pty-w1:p2']]))).toEqual({ 'w1:p2': null })
  })

  it('drops the parent when the caller lived in another session', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1', session: 'other' }) })
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
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1', ptyId: null, epoch: null }) })
    expect(parents(w.state, standard('w1:p1', 'w1:p2'))).toEqual({ 'w1:p2': null })
  })

  it('gives no entry at all when the child pane is a new PTY or the backend generation moved', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    expect(lineageOf(w.state, live([['w1:p1', 'pty-w1:p1'], ['w1:p2', 'pty-other']]))).toEqual([])
    expect(lineageOf(w.state, live([['w1:p1', 'pty-w1:p1'], ['w1:p2', 'pty-w1:p2']], 'e2'))).toEqual([])
  })

  it('R3: a caller the runtime could not place never becomes a parent, even when its id and generation match', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1', session: null, verifiedBy: null }), paneSession: 'default' })
    expect(parents(w.state, { ...standard('w1:p1', 'w1:p2'), session: 'default' })).toEqual({ 'w1:p2': null })
  })

  it('a default-session caller placed by its socket keeps its parent', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1', session: null, verifiedBy: 'socket' }), paneSession: 'default' })
    expect(parents(w.state, { ...standard('w1:p1', 'w1:p2'), session: 'default' })).toEqual({ 'w1:p2': 'w1:p1' })
  })

  it('compares session names as they are: an attempt recorded with no session is not the default one', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }), paneSession: null })
    expect(lineageOf(w.state, { ...standard('w1:p1', 'w1:p2'), session: 'default' })).toEqual([])
  })
})

describe('LIFE-459 L3 — reuse, retries and lifetime', () => {
  it('a reused pane carries only the latest attempt\'s parent', () => {
    const w = world()
    const first = w.start({ pane: target('w1:p3'), spawner: fromPane({ paneId: 'w1:p1' }) })
    w.settle(first, 'completed')
    const second = w.start({ pane: target('w1:p3'), spawner: fromPane({ paneId: 'w1:p2' }) })
    const entries = lineageOf(w.state, standard('w1:p1', 'w1:p2', 'w1:p3'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ paneId: 'w1:p3', dispatchId: second, parentPaneId: 'w1:p2' })
  })

  it('a reused pane whose new caller was outside a pane does not inherit the old parent', () => {
    const w = world()
    const first = w.start({ pane: target('w1:p3'), spawner: fromPane({ paneId: 'w1:p1' }) })
    w.settle(first, 'completed')
    w.start({ pane: target('w1:p3'), spawner: { kind: 'outside_pane' } })
    expect(parents(w.state, standard('w1:p1', 'w1:p3'))).toEqual({ 'w1:p3': null })
  })

  it('a retry on another pane gives the new pane the parent, and the old pane keeps its own attempt', () => {
    const w = world()
    const first = w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    w.settle(first, 'failed')
    const task = w.state.dispatches[0]!.taskId
    w.start({ pane: target('w1:p3'), spawner: fromPane({ paneId: 'w1:p1' }), taskId: task })
    expect(parents(w.state, standard('w1:p1', 'w1:p2', 'w1:p3'))).toEqual({ 'w1:p2': 'w1:p1', 'w1:p3': 'w1:p1' })
    expect(parents(w.state, standard('w1:p1', 'w1:p3'))).toEqual({ 'w1:p3': 'w1:p1' })
  })

  it('an entry disappears when its pane closes or is released', () => {
    const w = world()
    const id = w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    expect(lineageOf(w.state, standard('w1:p1'))).toEqual([])
    w.settle(id, 'completed')
    w.release(id)
    expect(lineageOf(w.state, standard('w1:p1', 'w1:p2'))).toEqual([])
  })

  it('U5: a settled attempt keeps its lineage while its pane lives, with its status', () => {
    const w = world()
    const id = w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    w.settle(id, 'completed')
    expect(lineageOf(w.state, standard('w1:p1', 'w1:p2'))).toMatchObject([{ paneId: 'w1:p2', dispatchStatus: 'completed', parentPaneId: 'w1:p1' }])
  })

  it('ignores attempts that were not started as workers', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    const plain = { ...w.state, dispatches: w.state.dispatches.map(entry => ({ ...entry, worker: null })) }
    expect(lineageOf(plain, standard('w1:p1', 'w1:p2'))).toEqual([])
  })
})

describe('LIFE-459 L4 — depth and cycles', () => {
  it('a worker that starts a worker becomes its parent, to any depth', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    w.start({ pane: target('w1:p3'), spawner: fromPane({ paneId: 'w1:p2' }) })
    w.start({ pane: target('w1:p4'), spawner: fromPane({ paneId: 'w1:p3' }) })
    expect(parents(w.state, standard('w1:p1', 'w1:p2', 'w1:p3', 'w1:p4'))).toEqual({ 'w1:p2': 'w1:p1', 'w1:p3': 'w1:p2', 'w1:p4': 'w1:p3' })
  })

  it('a pane is never its own parent', () => {
    const w = world()
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p2' }) })
    expect(parents(w.state, standard('w1:p2'))).toEqual({ 'w1:p2': null })
  })

  it('cuts a two-pane loop made by reuse at the oldest attempt', () => {
    const w = world()
    const aInB = w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    w.settle(aInB, 'completed')
    // Later the worker pane hands the first pane a Task: p1's latest attempt names p2 as its parent.
    w.start({ pane: target('w1:p1'), spawner: fromPane({ paneId: 'w1:p2' }) })
    expect(parents(w.state, standard('w1:p1', 'w1:p2'))).toEqual({ 'w1:p2': null, 'w1:p1': 'w1:p2' })
  })

  it('cuts a three-pane loop once, and the result is a forest', () => {
    const w = world()
    const one = w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
    const two = w.start({ pane: target('w1:p3'), spawner: fromPane({ paneId: 'w1:p2' }) })
    w.settle(one, 'completed'); w.settle(two, 'completed')
    w.start({ pane: target('w1:p1'), spawner: fromPane({ paneId: 'w1:p3' }) })
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
    w.start({ pane: target('w1:p2'), spawner: fromPane({ paneId: 'w1:p1' }) })
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

const term = vi.hoisted(() => ({ create: { handle: 't1.child', epoch: 'e1', ptyId: 'pty-child', paneId: 'w1:p9' }, ready: false, waitRemaining: 0 }))
vi.mock('../terminal/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../terminal/index.js')>()
  return {
    ...actual,
    terminalModule: () => ({
      specs: [], validate: () => {},
      execute: async (inv: { command: string }, ctx: { deadlineAt: number }) => {
        // A real create takes a while (a pane, then an agent); the caller probe runs beside it.
        if (inv.command === 'terminal create') {
          await new Promise(resolve => setTimeout(resolve, 20))
          return { terminal: term.create, agent: { kind: 'claude' }, stages: { agent: { status: 'completed' } } }
        }
        if (inv.command === 'terminal show') return { terminal: term.create, agent: { kind: 'claude' } }
        // Unless a test says the agent is ready, the start stops right after the attempt is on disk.
        if (inv.command === 'terminal wait') {
          term.waitRemaining = ctx.deadlineAt - Date.now()
          return term.ready ? { satisfied: term.waitRemaining > 0, agent: { phase: 'idle' } } : { satisfied: false, agent: { phase: 'launching' } }
        }
        if (inv.command === 'terminal send') return {}
        if (inv.command === 'terminal prompt') return { record: { matchCount: 1, naiveCount: 1, cursorInvalidated: false, unavailableReason: null }, outcome: 'completed', wait: { requested: 'accepted', satisfied: true } }
        throw Error(inv.command)
      },
    }),
  }
})
const { orchestrationModule } = await import('./index.js')

const CALLER: TerminalIdentity = { epoch: 'e1', ptyId: 'pty-caller', paneId: 'w1:p1', tabId: 't', workspaceId: 'w', path: '/tmp', repo: '/tmp', title: 'caller' }
const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l459-sock-'))
/** The backend socket the runtime drives, and a link to it — the spelling a pane may be given. */
const BACKEND_SOCKET = path.join(socketDir, 'herdr.sock'), LINKED_SOCKET = path.join(socketDir, 'link.sock'), OTHER_SOCKET = path.join(socketDir, 'other.sock')
fs.writeFileSync(BACKEND_SOCKET, ''); fs.writeFileSync(OTHER_SOCKET, ''); fs.symlinkSync(BACKEND_SOCKET, LINKED_SOCKET)

interface StartInput { caller: CallerIdentity; session?: string; panes?: TerminalIdentity[]; reuse?: boolean; remainingMs?: number; hang?: boolean }
async function startFrom({ caller, session, panes, reuse = false, remainingMs = 10000, hang = false }: StartInput) {
  process.env.CORRAL_BACKEND_SOCKET = BACKEND_SOCKET
  if (session === undefined) delete process.env.CORRAL_SESSION
  else process.env.CORRAL_SESSION = session
  vi.restoreAllMocks()
  // `hang`: the backend answers nothing until the look's own budget runs out, then fails it.
  if (hang) vi.spyOn(TerminalBackend.prototype, 'epoch').mockImplementation(async budget =>
    new Promise((_, fail) => setTimeout(() => fail(Error('simulated backend timeout')), Math.max(0, (budget?.deadlineAt ?? Date.now()) - Date.now()))))
  else vi.spyOn(TerminalBackend.prototype, 'epoch').mockResolvedValue('e1')
  vi.spyOn(TerminalBackend.prototype, 'list').mockResolvedValue(panes ?? [CALLER])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l459-start-'))
  const run = createRun(emptyState(), 'lineage', new Date().toISOString())
  const made = createTask(run.state, { runId: run.run.id, spec: 'body', title: null, deps: [], at: new Date().toISOString() })
  const store = new OrchestrationStore(dir)
  store.write(made.state)
  const mod = orchestrationModule(dir)
  await new Promise(resolve => setTimeout(resolve, 5))
  const ctx = { runtimeId: 'runtime', instanceId: 'instance', userData: dir, signal: new AbortController().signal, deadlineAt: Date.now() + remainingMs, remote: false }
  const flags: Record<string, string> = reuse ? { task: made.task.id, terminal: term.create.handle } : { task: made.task.id, agent: 'claude', worktree: dir }
  const result = await mod.execute({ command: 'orchestration worker-start', flags: { ...flags, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: dir, caller }, ctx)
  if (!isRecord(result) || typeof result.dispatchId !== 'string') throw Error(`no attempt: ${JSON.stringify(result)}`)
  return { result, spawner: store.read().dispatches.find(entry => entry.id === result.dispatchId)!.worker!.spawner }
}
const spawnerFrom = async (input: StartInput) => (await startFrom(input)).spawner

describe('LIFE-459 L1 — worker-start records the caller pane', () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CORRAL_BACKEND_SOCKET; delete process.env.CORRAL_SESSION; term.ready = false })

  it('records the caller pane with the generation the backend reports for it', async () => {
    expect(await spawnerFrom({ caller: { paneId: 'w1:p1', session: 's1' }, session: 's1' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: 's1', verifiedBy: 'session_name', epoch: 'e1', ptyId: 'pty-caller' })
  })

  it('records a caller outside any pane as such, and guesses nothing', async () => {
    expect(await spawnerFrom({ caller: { paneId: null, session: null }, session: 's1' })).toEqual({ kind: 'outside_pane' })
  })

  it('records no generation for a caller in another session, or one the backend does not list', async () => {
    expect(await spawnerFrom({ caller: { paneId: 'w1:p1', session: 'other' }, session: 's1' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: 'other', verifiedBy: null, epoch: null, ptyId: null })
    expect(await spawnerFrom({ caller: { paneId: 'w1:p1', session: 's1' }, session: 's1', panes: [] }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: 's1', verifiedBy: 'session_name', epoch: null, ptyId: null })
  })

  it('R3: a caller with no session name and no socket is not placed, and no generation is read for it', async () => {
    // The reviewer's case: a runtime driving `default`, and a caller that says nothing about where it lives.
    expect(await spawnerFrom({ caller: { paneId: 'w1:p1', session: null }, session: 'default' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: null, verifiedBy: null, epoch: null, ptyId: null })
    expect(TerminalBackend.prototype.epoch).not.toHaveBeenCalled()
    expect(await spawnerFrom({ caller: { paneId: 'w1:p1', session: '' }, session: 'default' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: '', verifiedBy: null, epoch: null, ptyId: null })
    expect(TerminalBackend.prototype.epoch).not.toHaveBeenCalled()
  })

  it('places a default-session pane by its socket, whatever spelling of the path it was given', async () => {
    for (const socket of [BACKEND_SOCKET, LINKED_SOCKET])
      expect(await spawnerFrom({ caller: { paneId: 'w1:p1', session: null, socket }, session: 'default' }))
        .toEqual({ kind: 'pane', paneId: 'w1:p1', session: null, verifiedBy: 'socket', epoch: 'e1', ptyId: 'pty-caller' })
  })

  it('a socket that is not the backend\'s outweighs a matching session name, and a missing one places nothing', async () => {
    expect(await spawnerFrom({ caller: { paneId: 'w1:p1', session: 's1', socket: OTHER_SOCKET }, session: 's1' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: 's1', verifiedBy: null, epoch: null, ptyId: null })
    expect(await spawnerFrom({ caller: { paneId: 'w1:p1', session: null, socket: path.join(socketDir, 'gone.sock') }, session: 'default' }))
      .toEqual({ kind: 'pane', paneId: 'w1:p1', session: null, verifiedBy: null, epoch: null, ptyId: null })
  })
})

describe('LIFE-459 R2 — recording the parent never spends the start\'s time', () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CORRAL_BACKEND_SOCKET; delete process.env.CORRAL_SESSION; term.ready = false })

  it('a look at the backend that hangs to its budget leaves a reused pane start ready, with no generation recorded', async () => {
    // The reviewer's scenario: an existing pane reused with --terminal, no open attempt (so the plan
    // observes nothing), 3000 ms left, and a backend that answers nothing until its budget runs out.
    term.ready = true
    const started = Date.now()
    const { result, spawner } = await startFrom({ caller: { paneId: 'w1:p1', session: 's1' }, session: 's1', reuse: true, remainingMs: 3000, hang: true })
    // The look was made (beside the start), it just never answered in time.
    expect(TerminalBackend.prototype.epoch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ state: 'ready', stage: 'input_accepted' })
    expect(spawner).toEqual({ kind: 'pane', paneId: 'w1:p1', session: 's1', verifiedBy: 'session_name', epoch: null, ptyId: null })
    // readyBy = deadline - 2000 = 1000 ms after the start; nothing before the wait may eat into it.
    expect(term.waitRemaining).toBeGreaterThan(900)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
