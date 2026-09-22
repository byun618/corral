/**
 * LIFE-409 F9 — the transition table, startability, the reconcile decision and the store guard,
 * pinned as units. The live behaviour these rules produce is measured separately by
 * `scripts/l409/*` against a real backend; these tests pin the rules themselves so a later change
 * to them cannot pass unnoticed.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeError } from '../contracts.js'
import { OrchestrationStore, isOrchestrationState } from './store.js'
import { transition as exportedTransition, validateOrchestration, parseDeps, observationFor, type PaneSnapshot } from './index.js'
import {
  MANUAL_TRANSITIONS, TASK_STATUSES, applyReconcile, createDispatch, createRun, createTask,
  emptyState, exhausted, findDispatch, findTask, isId, mintId, reconcileDecision, runCounts, startability, transition,
  type DispatchTarget, type OrchestrationState, type PaneObservation, type TaskRecord, type TaskStatus,
} from './model.js'

const AT = '2026-09-22T00:00:00.000Z'
const LATER = '2026-09-22T01:00:00.000Z'
const target = (patch: Partial<DispatchTarget> = {}): DispatchTarget =>
  ({ handle: 't1.handle', runtimeId: 'runtime-1', epoch: 'epoch-1', ptyId: 'pty-1', paneId: 'pane-1', ...patch })
const code = (fn: () => unknown): string => {
  try { fn(); return 'no-error' } catch (error) { return error instanceof RuntimeError ? error.code : `not-runtime:${String(error)}` }
}

/** A run with one completed-capable dependency task, used to build every other starting shape. */
function seed() {
  const run = createRun(emptyState(), 'objective', AT)
  const dep = createTask(run.state, { runId: run.run.id, spec: 'dep', title: null, deps: [], at: AT })
  return { state: dep.state, runId: run.run.id, dep: dep.task }
}
/**
 * Put a fresh task into `from` using only the product's own moves — no record is ever hand-edited,
 * so a starting shape this helper cannot reach is a shape the product cannot produce either.
 */
function given(from: TaskStatus): { state: OrchestrationState; taskId: string; runId: string } {
  const base = seed()
  const created = createTask(base.state, { runId: base.runId, spec: 'subject', title: null, deps: from === 'pending' ? [base.dep.id] : [], at: AT })
  const taskId = created.task.id, runId = base.runId
  let state = created.state
  if (from === 'pending' || from === 'ready') return { state, taskId, runId }
  if (from === 'blocked') return { state: transition(state, { taskId, to: 'blocked', settledBy: 'task-update', at: AT }).state, taskId, runId }
  state = createDispatch(state, { task: created.task, target: target(), agent: null, agentAbsenceReason: 'no_managed_agent', at: AT }).state
  if (from === 'dispatched') return { state, taskId, runId }
  return { state: transition(state, { taskId, to: from === 'completed' ? 'completed' : 'failed', settledBy: 'task-update', at: AT }).state, taskId, runId }
}

describe('LIFE-409 transition table (F9)', () => {
  it('accepts exactly the frozen manual moves and refuses the other twenty-eight', () => {
    const observed: string[] = []
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const { state, taskId } = given(from)
        expect({ from, actual: findTask(state, taskId)!.status }).toEqual({ from, actual: from })
        const result = code(() => transition(state, { taskId, to, settledBy: 'task-update', at: LATER }))
        const allowed = MANUAL_TRANSITIONS[from].includes(to)
        expect({ from, to, result }).toEqual({ from, to, result: allowed ? 'no-error' : 'illegal_transition' })
        if (allowed) observed.push(`${from}->${to}`)
      }
    }
    expect(observed.sort()).toEqual([
      'blocked->pending', 'blocked->ready', 'dispatched->blocked', 'dispatched->completed', 'dispatched->failed',
      'failed->blocked', 'pending->blocked', 'ready->blocked',
    ])
  })

  it('names the two moves reviewers ask about: completed is terminal and ready never self-completes', () => {
    const completed = given('completed')
    expect(code(() => transition(completed.state, { taskId: completed.taskId, to: 'blocked', settledBy: 'task-update', at: LATER }))).toBe('illegal_transition')
    const ready = given('ready')
    expect(code(() => transition(ready.state, { taskId: ready.taskId, to: 'completed', settledBy: 'task-update', at: LATER }))).toBe('illegal_transition')
  })

  it('settles the open attempt and promotes dependents inside one returned document', () => {
    const base = seed()
    const second = createTask(base.state, { runId: base.runId, spec: 'second', title: null, deps: [], at: AT })
    const dependent = createTask(second.state, { runId: base.runId, spec: 'third', title: null, deps: [base.dep.id, second.task.id], at: AT })
    expect(dependent.task.status).toBe('pending')
    const dispatched = createDispatch(dependent.state, { task: base.dep, target: target(), agent: null, agentAbsenceReason: null, at: AT })
    const afterFirst = transition(dispatched.state, { taskId: base.dep.id, to: 'completed', result: { ok: true }, settledBy: 'task-update', at: LATER })
    expect(afterFirst.dispatch).toMatchObject({ id: dispatched.dispatch.id, status: 'completed', settledBy: 'task-update', settledAt: LATER })
    expect(afterFirst.task.result).toEqual({ ok: true })
    // Still pending: the dependent has a second, unmet dependency.
    expect(afterFirst.promoted).toEqual([])
    expect(findTask(afterFirst.state, dependent.task.id)!.status).toBe('pending')
    const secondDispatched = createDispatch(afterFirst.state, { task: findTask(afterFirst.state, second.task.id)!, target: target({ paneId: 'pane-2' }), agent: null, agentAbsenceReason: null, at: LATER })
    const afterSecond = transition(secondDispatched.state, { taskId: second.task.id, to: 'completed', settledBy: 'task-update', at: LATER })
    expect(afterSecond.promoted.map(row => row.id)).toEqual([dependent.task.id])
    expect(findTask(afterSecond.state, dependent.task.id)!.status).toBe('ready')
  })

  it('checks version, then legality, then attempt staleness, and every rejection is effect-free', () => {
    const { state, taskId } = given('dispatched')
    const open = findTask(state, taskId)!.currentDispatchId!
    const version = findTask(state, taskId)!.version
    const before = JSON.stringify(state)
    expect(code(() => transition(state, { taskId, to: 'completed', expectedVersion: version + 5, settledBy: 'task-update', at: LATER }))).toBe('version_conflict')
    expect(JSON.stringify(state)).toBe(before)
    // An illegal move wins over a stale attempt: settling twice is illegal_transition even when the
    // caller names the very attempt that settled it (F6, second half).
    const settled = transition(state, { taskId, to: 'completed', settledBy: 'task-update', at: LATER }).state
    const after = JSON.stringify(settled)
    expect(code(() => transition(settled, { taskId, to: 'completed', dispatchId: open, settledBy: 'task-update', at: LATER }))).toBe('illegal_transition')
    expect(JSON.stringify(settled)).toBe(after)
  })

  it('answers a superseded attempt with stale_dispatch and an unknown id with dispatch_not_found', () => {
    const { state, taskId } = given('dispatched')
    const first = findTask(state, taskId)!.currentDispatchId!
    // The reconcile path: the pane vanished, so the attempt is unknown and the task stays dispatched.
    const swept = applyReconcile(state, findDispatch(state, first)!, { kind: 'pane_gone' }, LATER, 'instance-1').state
    expect(findDispatch(swept, first)!.status).toBe('unknown')
    expect(findTask(swept, taskId)!.status).toBe('dispatched')
    const retry = createDispatch(swept, { task: findTask(swept, taskId)!, target: target({ ptyId: 'pty-2' }), agent: null, agentAbsenceReason: null, at: LATER })
    expect(retry.dispatch.attempt).toBe(2)
    expect(retry.task.attempts).toBe(2)
    expect(code(() => transition(retry.state, { taskId, to: 'completed', dispatchId: first, settledBy: 'task-update', at: LATER }))).toBe('stale_dispatch')
    expect(code(() => transition(retry.state, { taskId, to: 'completed', dispatchId: mintId('ctx'), settledBy: 'task-update', at: LATER }))).toBe('dispatch_not_found')
    // Omitting --dispatch settles whichever attempt is open, which is the human settle path.
    expect(transition(retry.state, { taskId, to: 'failed', settledBy: 'task-update', at: LATER }).dispatch?.id).toBe(retry.dispatch.id)
    // LIFE-410 reuses the same primitive; only the recorded author differs.
    expect(transition(retry.state, { taskId, to: 'completed', settledBy: 'worker_done', at: LATER }).dispatch?.settledBy).toBe('worker_done')
  })

  it('guards blocked -> ready on dependencies and always allows blocked -> pending', () => {
    const base = seed()
    const dependent = createTask(base.state, { runId: base.runId, spec: 'dependent', title: null, deps: [base.dep.id], at: AT })
    const blocked = transition(dependent.state, { taskId: dependent.task.id, to: 'blocked', settledBy: 'task-update', at: AT }).state
    expect(code(() => transition(blocked, { taskId: dependent.task.id, to: 'ready', settledBy: 'task-update', at: LATER }))).toBe('illegal_transition')
    expect(transition(blocked, { taskId: dependent.task.id, to: 'pending', settledBy: 'task-update', at: LATER }).task.status).toBe('pending')
  })

  it('is the same function LIFE-410 will import from the module entry point', () => {
    expect(exportedTransition).toBe(transition)
  })
})

describe('LIFE-409 startability (F4)', () => {
  it('refuses every non-startable shape with its own reason and allows a retry after a dead attempt', () => {
    for (const [from, reason] of [['pending', 'unmet_dependencies'], ['blocked', 'task_blocked'], ['dispatched', 'dispatch_active'], ['completed', 'task_completed']] as const) {
      const { state, taskId } = given(from)
      expect({ from, ...startability(state, findTask(state, taskId)!) }).toMatchObject({ from, startable: false, reason })
      expect(code(() => createDispatch(state, { task: findTask(state, taskId)!, target: target(), agent: null, agentAbsenceReason: null, at: LATER }))).toBe('task_not_startable')
    }
    for (const from of ['ready', 'failed'] as const) {
      const { state, taskId } = given(from)
      expect({ from, ...startability(state, findTask(state, taskId)!) }).toMatchObject({ from, startable: true })
      expect(createDispatch(state, { task: findTask(state, taskId)!, target: target(), agent: null, agentAbsenceReason: null, at: LATER }).dispatch.status).toBe('dispatched')
    }
  })

  it('names the unmet dependencies rather than only refusing', () => {
    const base = seed()
    const dependent = createTask(base.state, { runId: base.runId, spec: 'dependent', title: null, deps: [base.dep.id], at: AT })
    expect(startability(dependent.state, dependent.task)).toMatchObject({ startable: false, reason: 'unmet_dependencies', unmetDependencies: [base.dep.id] })
  })

  it('refuses a dependency from another run or from nowhere, and counts every status of a run', () => {
    const base = seed()
    const other = createRun(base.state, 'another', AT)
    expect(code(() => createTask(other.state, { runId: other.run.id, spec: 'cross', title: null, deps: [base.dep.id], at: AT }))).toBe('task_not_found')
    expect(code(() => createTask(base.state, { runId: base.runId, spec: 'ghost', title: null, deps: [mintId('task')], at: AT }))).toBe('task_not_found')
    const dispatched = createDispatch(base.state, { task: base.dep, target: target(), agent: null, agentAbsenceReason: null, at: AT }).state
    expect(runCounts(dispatched, base.runId).tasks).toMatchObject({ dispatched: 1, total: 1, completed: 0, pending: 0 })
    expect(runCounts(dispatched, base.runId).dispatches).toMatchObject({ dispatched: 1, total: 1, unknown: 0, failed: 0 })
    expect(runCounts(dispatched, other.run.id)).toMatchObject({ tasks: { total: 0 }, dispatches: { total: 0 } })
  })
})

describe('LIFE-409 reconcile (F5)', () => {
  it('maps each observation to the frozen row and never invents failed', () => {
    expect(reconcileDecision({ kind: 'live' })).toEqual({ live: true, observed: true, reason: 'pane_live', settle: false })
    expect(reconcileDecision({ kind: 'pane_gone' })).toEqual({ live: false, observed: true, reason: 'pane_gone', settle: true })
    expect(reconcileDecision({ kind: 'pty_replaced', observedPtyId: 'pty-2' })).toEqual({ live: false, observed: true, reason: 'pty_replaced', settle: true })
    expect(reconcileDecision({ kind: 'epoch_changed', observedEpoch: 'epoch-2' })).toEqual({ live: false, observed: true, reason: 'epoch_changed', settle: true })
    expect(reconcileDecision({ kind: 'unobserved', reason: 'backend_unavailable', detail: null })).toEqual({ live: 'unknown', observed: false, reason: 'backend_unavailable', settle: false })
    expect(reconcileDecision({ kind: 'unobserved', reason: 'observation_failed', detail: 'boom' })).toMatchObject({ live: 'unknown', observed: false, settle: false })
  })

  it('reads a live pane, a replacement and a moved generation out of one backend listing', () => {
    const snapshot: PaneSnapshot = { observed: true, epoch: 'epoch-1', panes: [{ paneId: 'pane-1', ptyId: 'pty-1' }] }
    expect(observationFor(snapshot, target())).toEqual({ kind: 'live' })
    expect(observationFor(snapshot, target({ paneId: 'pane-9' }))).toEqual({ kind: 'pane_gone' })
    expect(observationFor(snapshot, target({ ptyId: 'pty-0' }))).toEqual({ kind: 'pty_replaced', observedPtyId: 'pty-1' })
    expect(observationFor(snapshot, target({ epoch: 'epoch-0' }))).toEqual({ kind: 'epoch_changed', observedEpoch: 'epoch-1' })
    expect(observationFor({ observed: false, reason: 'observation_failed', detail: 'boom' }, target()))
      .toEqual({ kind: 'unobserved', reason: 'observation_failed', detail: 'boom' })
  })

  it('writes nothing when it could not look, and nothing when the answer has not changed', () => {
    const { state, taskId } = given('dispatched')
    const entry = findDispatch(state, findTask(state, taskId)!.currentDispatchId!)!
    const blind = applyReconcile(state, entry, { kind: 'unobserved', reason: 'backend_unavailable', detail: null }, LATER, 'instance-1')
    expect(blind.changed).toBe(false)
    expect(blind.state).toBe(state)
    expect(blind.dispatch.reconcile).toBeNull()
    const first = applyReconcile(state, entry, { kind: 'live' }, LATER, 'instance-1')
    expect(first.changed).toBe(true)
    expect(first.dispatch.reconcile).toEqual({ at: LATER, runtimeInstanceId: 'instance-1', observed: true, reason: 'pane_live' })
    expect(first.dispatch.status).toBe('dispatched')
    const again = applyReconcile(first.state, first.dispatch, { kind: 'live' }, '2026-09-22T02:00:00.000Z', 'instance-2')
    expect(again.changed).toBe(false)
    expect(JSON.stringify(again.state)).toBe(JSON.stringify(first.state))
    const gone = applyReconcile(first.state, first.dispatch, { kind: 'pane_gone' }, LATER, 'instance-1')
    expect(gone.dispatch).toMatchObject({ status: 'unknown', settledBy: 'reconcile', settledAt: LATER, reconcile: { observed: true, reason: 'pane_gone' } })
    expect(findTask(gone.state, taskId)!.status).toBe('dispatched')
    // Never `failed`, in any row of the table.
    for (const observation of [{ kind: 'pane_gone' }, { kind: 'pty_replaced', observedPtyId: 'x' }, { kind: 'epoch_changed', observedEpoch: 'y' }] as const)
      expect(applyReconcile(state, entry, observation, LATER, 'i').dispatch.status).toBe('unknown')
  })

  it('throws rather than falling through when a document claims a variant that does not exist', () => {
    const forged: PaneObservation = JSON.parse('{"kind":"invented_variant"}')
    expect(code(() => reconcileDecision(forged))).toBe('operation_failed')
    const forced: never[] = JSON.parse('["invented_status"]')
    expect(code(() => exhausted(forced[0]!))).toBe('operation_failed')
    const open = given('dispatched')
    const forgedTask: TaskRecord = JSON.parse(JSON.stringify({ ...findTask(open.state, open.taskId)!, status: 'invented_status' }))
    expect(code(() => startability(open.state, forgedTask))).toBe('operation_failed')
  })
})

describe('LIFE-409 store and validation (F8, F11)', () => {
  const profile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'l409-unit-'))

  it('round-trips a document, starts empty when absent and refuses a damaged one', () => {
    const dir = profile(), store = new OrchestrationStore(dir)
    expect(store.read()).toEqual(emptyState())
    const { state } = given('dispatched')
    store.write(state)
    expect(store.read()).toEqual(state)
    fs.writeFileSync(store.file, '{"schemaVersion":1,"currentRunId":null,"runs":[{"id":"nope"}],"tasks":[],"dispatches":[]}')
    expect(code(() => store.read())).toBe('storage_corrupt')
    fs.writeFileSync(store.file, 'not json at all')
    expect(code(() => store.read())).toBe('storage_corrupt')
    // A damaged document is never rewritten or truncated on corral's own initiative.
    expect(fs.readFileSync(store.file, 'utf8')).toBe('not json at all')
  })

  it('refuses a binding that points at a run the document does not contain', () => {
    const dir = profile(), store = new OrchestrationStore(dir)
    store.write({ ...emptyState(), currentRunId: mintId('run') })
    expect(code(() => store.read())).toBe('storage_corrupt')
  })

  it('creates nothing in the profile until something is written', () => {
    const dir = profile(), store = new OrchestrationStore(dir)
    expect(fs.existsSync(path.join(dir, 'runtime'))).toBe(false)
    expect(store.read()).toEqual(emptyState())
    expect(fs.existsSync(path.join(dir, 'runtime'))).toBe(false)
    store.write(emptyState())
    expect(fs.existsSync(store.file)).toBe(true)
  })

  it('accepts the documents the product writes and rejects foreign shapes', () => {
    const { state, taskId } = given('dispatched')
    expect(isOrchestrationState(state)).toBe(true)
    expect(isOrchestrationState(transition(state, { taskId, to: 'completed', result: [1, 'two'], settledBy: 'task-update', at: LATER }).state)).toBe(true)
    expect(isOrchestrationState({ ...state, schemaVersion: 2 })).toBe(false)
    expect(isOrchestrationState(null)).toBe(false)
    expect(isOrchestrationState({ ...state, dispatches: [{ id: 'ctx_zz' }] })).toBe(false)
  })

  it('mints ids with Orca prefixes and rejects the other kinds', () => {
    for (const kind of ['run', 'task', 'ctx'] as const) {
      const id = mintId(kind)
      expect(isId(kind, id)).toBe(true)
      expect(isId(kind, id.toUpperCase())).toBe(false)
    }
    expect(isId('task', mintId('run'))).toBe(false)
  })

  it('rejects malformed flags before anything is looked up', () => {
    const inv = (command: string, flags: Record<string, string | boolean>) => ({ command, flags, args: [], cwd: '/tmp' })
    expect(code(() => validateOrchestration(inv('orchestration task-create', { spec: 'x', deps: 'nope' })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv('orchestration task-update', { id: mintId('task'), status: 'nope' })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv('orchestration task-update', { id: mintId('task'), status: 'dispatched' })))).toBe('illegal_transition')
    expect(code(() => validateOrchestration(inv('orchestration task-update', { id: mintId('task'), status: 'completed', result: '{' })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv('orchestration dispatch-show', { id: mintId('ctx'), task: mintId('task') })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv('orchestration dispatch-show', {})))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv('orchestration task-list', { ready: true, status: 'failed' })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv('orchestration run-show', { id: mintId('task') })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv('orchestration run-create', { objective: 'x', 'request-id': 'nope' })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv('orchestration task-list', { ready: true, status: 'ready' })))).toBe('no-error')
    expect(parseDeps(' , ')).toEqual([])
    const ids = [mintId('task'), mintId('task')]
    expect(parseDeps(ids.join(', '))).toEqual(ids)
    expect(code(() => parseDeps(`${ids[0]!},${ids[0]!}`))).toBe('invalid_argument')
  })
})
