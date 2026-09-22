/**
 * LIFE-409 F9 — the transition table, startability, the reconcile decision and the store guard,
 * pinned as units. The live behaviour these rules produce is measured separately by
 * `scripts/l409/*` against a real backend; these tests pin the rules themselves so a later change
 * to them cannot pass unnoticed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeError } from '../contracts.js'
import { isRecord } from '../../shared/json.js'
import { OrchestrationStore, isOrchestrationState } from './store.js'
import { transition as exportedTransition, validateOrchestration, parseDeps, observationFor, budgeted, flattenReceiptError, receiptsOwnTheAnswer, type PaneSnapshot } from './index.js'
import {
  MANUAL_TRANSITIONS, TASK_STATUSES, applyReconcile, createDispatch, createRun, createTask,
  activeDispatch, emptyState, exhausted, findDispatch, findTask, isId, latestDispatch, mintId, reconcileDecision, runCounts, startability, transition,
  type AgentSnapshot, type DispatchTarget, type IdKind, type OrchestrationState, type PaneObservation,
  type StartabilityReason, type TaskRecord, type TaskStatus,
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
function given(from: TaskStatus | 'dispatched-reconciled'): { state: OrchestrationState; taskId: string; runId: string } {
  const base = seed()
  const created = createTask(base.state, { runId: base.runId, spec: 'subject', title: null, deps: from === 'pending' ? [base.dep.id] : [], at: AT })
  const taskId = created.task.id, runId = base.runId
  let state = created.state
  if (from === 'pending' || from === 'ready') return { state, taskId, runId }
  if (from === 'blocked') return { state: transition(state, { taskId, to: 'blocked', settledBy: 'task-update', at: AT }).state, taskId, runId }
  state = createDispatch(state, { task: created.task, target: target(), agent: null, agentAbsenceReason: 'no_managed_agent', at: AT }).state
  if (from === 'dispatched') return { state, taskId, runId }
  // The same status with the attempt already settled `unknown` — the shape a dead pane leaves.
  if (from === 'dispatched-reconciled')
    return { state: applyReconcile(state, latestDispatch(state, taskId)!, { kind: 'pane_gone' }, AT, 'seed').state, taskId, runId }
  return { state: transition(state, { taskId, to: from === 'completed' ? 'completed' : 'failed', settledBy: 'task-update', at: AT }).state, taskId, runId }
}

describe('LIFE-409 transition table (F9)', () => {
  it('accepts exactly the frozen manual moves and refuses the other twenty-eight', () => {
    const observed: string[] = []
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        // The table itself is unconditional, so the `dispatched` row is measured with the attempt
        // already closed by reconcile. The conditional guard that an *open* attempt puts on
        // `→ blocked` (R1) is a separate rule and has its own tests below.
        const { state, taskId } = given(from === 'dispatched' ? 'dispatched-reconciled' : from)
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
    const refusals: [TaskStatus, StartabilityReason][] = [['pending', 'unmet_dependencies'], ['blocked', 'task_blocked'], ['dispatched', 'dispatch_active'], ['completed', 'task_completed']]
    for (const [from, reason] of refusals) {
      const { state, taskId } = given(from)
      expect({ from, ...startability(state, findTask(state, taskId)!) }).toMatchObject({ from, startable: false, reason })
      expect(code(() => createDispatch(state, { task: findTask(state, taskId)!, target: target(), agent: null, agentAbsenceReason: null, at: LATER }))).toBe('task_not_startable')
    }
    const startable: TaskStatus[] = ['ready', 'failed']
    for (const from of startable) {
      const { state, taskId } = given(from)
      expect({ from, ...startability(state, findTask(state, taskId)!) }).toMatchObject({ from, startable: true })
      expect(createDispatch(state, { task: findTask(state, taskId)!, target: target(), agent: null, agentAbsenceReason: null, at: LATER }).dispatch.status).toBe('dispatched')
    }
  })

  it('no longer has a blocked detour to walk back through (r0 behaviour, refused since r1)', () => {
    // In r0 `dispatched → blocked → ready` was legal and left a `ready` Task owning a live attempt;
    // startability refused the second dispatch. Since r1 the detour is refused at its first step
    // (R1), so the shape cannot be built at all — the startability guard stays as a second net.
    const base = seed()
    const created = createTask(base.state, { runId: base.runId, spec: 'detour', title: null, deps: [], at: AT })
    const taskId = created.task.id
    const first = createDispatch(created.state, { task: created.task, target: target(), agent: null, agentAbsenceReason: null, at: AT })
    expect(code(() => transition(first.state, { taskId, to: 'blocked', settledBy: 'task-update', at: LATER }))).toBe('illegal_transition')
    expect(findDispatch(first.state, first.dispatch.id)!.status).toBe('dispatched')
    expect(startability(first.state, findTask(first.state, taskId)!)).toMatchObject({ startable: false, reason: 'dispatch_active', activeDispatchId: first.dispatch.id })
    // Reconcile is the exit: the pane is gone, the attempt is unknown, and both moves open up.
    const gone = applyReconcile(first.state, findDispatch(first.state, first.dispatch.id)!, { kind: 'pane_gone' }, LATER, 'instance-1').state
    expect(transition(gone, { taskId, to: 'blocked', settledBy: 'task-update', at: LATER }).task.status).toBe('blocked')
    expect(createDispatch(gone, { task: findTask(gone, taskId)!, target: target({ paneId: 'pane-2' }), agent: null, agentAbsenceReason: null, at: LATER }).dispatch.attempt).toBe(2)
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
    const settling: PaneObservation[] = [{ kind: 'pane_gone' }, { kind: 'pty_replaced', observedPtyId: 'x' }, { kind: 'epoch_changed', observedEpoch: 'y' }]
    for (const observation of settling)
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
    const kinds: IdKind[] = ['run', 'task', 'ctx']
    for (const kind of kinds) {
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

// --- r1 fix round ---------------------------------------------------------------------------------
// Each case below is a review finding (verdict.md 1차 판정) written as a regression first: R1/C2/G1,
// R3/C9/G2, C4 and C5. They failed against c26b68a before the fix in this round.

/** A JSON round trip, so a damaged document can be built without a single type assertion. */
function document(state: OrchestrationState): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(state))
  if (!isRecord(parsed)) throw new Error('a state document is a record')
  return parsed
}
function entry(doc: Record<string, unknown>, key: string, index: number): Record<string, unknown> {
  const list = doc[key]
  if (!Array.isArray(list)) throw new Error(`${key} is not an array`)
  const item: unknown = list[index]
  if (!isRecord(item)) throw new Error(`${key}[${index}] is not a record`)
  return item
}
/** A dispatched task whose attempt carries a full agent snapshot — the shape the product writes. */
function dispatchedWithAgent() {
  const base = seed()
  const created = createTask(base.state, { runId: base.runId, spec: 'agented', title: null, deps: [], at: AT })
  const agent: AgentSnapshot = {
    kind: 'claude', name: 'corral-1', phase: 'launching', requestedModel: null, requestedEffort: null, requestedAdvisor: null,
    resolvedModel: null, resolvedAdvisor: null, argv: ['claude', '--session-id', 'x'], sessionId: 'x', sessionIdSource: 'client-minted', observedAt: AT,
  }
  const open = createDispatch(created.state, { task: created.task, target: target(), agent, agentAbsenceReason: null, at: AT })
  return { state: open.state, taskId: created.task.id, dispatchId: open.dispatch.id, runId: base.runId }
}

describe('LIFE-409 r1 — an open attempt pins the task to dispatched (R1 = G1 = C2)', () => {
  it('refuses dispatched → blocked while the attempt is open and allows it once reconcile closed it', () => {
    const { state, taskId, dispatchId } = dispatchedWithAgent()
    const refused = code(() => transition(state, { taskId, to: 'blocked', settledBy: 'task-update', at: LATER }))
    expect(refused).toBe('illegal_transition')
    try { transition(state, { taskId, to: 'blocked', settledBy: 'task-update', at: LATER }) } catch (error) {
      expect(error instanceof RuntimeError && error.resources).toMatchObject({ reason: 'dispatch_active', activeDispatchId: dispatchId, taskId, from: 'dispatched', to: 'blocked' })
      expect(error instanceof RuntimeError && isRecord(error.resources) && typeof error.resources.recovery === 'string').toBe(true)
    }
    // Settling the task is always available; blocking is what the open attempt refuses.
    expect(transition(state, { taskId, to: 'completed', settledBy: 'task-update', at: LATER }).task.status).toBe('completed')
    // The exit that does not touch the pane: reconcile observes it gone and closes the attempt.
    const closed = applyReconcile(state, findDispatch(state, dispatchId)!, { kind: 'pane_gone' }, LATER, 'i').state
    expect(transition(closed, { taskId, to: 'blocked', settledBy: 'task-update', at: LATER }).task.status).toBe('blocked')
  })

  it('reaches no state but dispatched while an attempt is open, over every legal path', () => {
    // Breadth-first over the product's own moves — every manual transition plus a new attempt —
    // from every starting status. The invariant is the one §4.3(2) assumes: an open attempt and a
    // task that is not `dispatched` cannot coexist, so no reachable state hides an orphan attempt.
    const seen = new Set<string>()
    const queue: OrchestrationState[] = []
    const shapes: TaskStatus[] = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']
    for (const from of shapes) queue.push(given(from).state)
    let visited = 0, withOpen = 0
    while (queue.length) {
      const current = queue.shift()!
      const key = JSON.stringify(current.tasks.map(task => [task.id, task.status, task.attempts])) + JSON.stringify(current.dispatches.map(d => [d.id, d.status]))
      if (seen.has(key)) continue
      seen.add(key)
      visited += 1
      for (const task of current.tasks) {
        const open = activeDispatch(current, task.id)
        if (open) { withOpen += 1; expect({ status: task.status, open: open.id }).toEqual({ status: 'dispatched', open: open.id }) }
        for (const to of shapes) {
          try { queue.push(transition(current, { taskId: task.id, to, settledBy: 'task-update', at: LATER }).state) } catch { /* refused paths are not states */ }
        }
        try { queue.push(createDispatch(current, { task, target: target(), agent: null, agentAbsenceReason: null, at: LATER }).state) } catch { /* not startable */ }
      }
      if (visited > 400) break
    }
    expect(visited).toBeGreaterThan(20)
    expect(withOpen).toBeGreaterThan(0)
  })
})

describe('LIFE-409 r1 — the store guard holds the union it narrows (R3 ⊃ G2 = C9)', () => {
  const damaged = (build: (doc: Record<string, unknown>) => void): boolean => {
    const doc = document(dispatchedWithAgent().state)
    build(doc)
    return isOrchestrationState(doc)
  }

  it('accepts what the product writes', () => {
    const { state, taskId } = dispatchedWithAgent()
    expect(isOrchestrationState(document(state))).toBe(true)
    expect(isOrchestrationState(document(transition(state, { taskId, to: 'failed', result: { why: 'x' }, settledBy: 'task-update', at: LATER }).state))).toBe(true)
    expect(isOrchestrationState(document(applyReconcile(state, state.dispatches[0]!, { kind: 'pane_gone' }, LATER, 'i').state))).toBe(true)
  })

  it('refuses a fractional attempt, a foreign settledBy and an impossible status pairing', () => {
    expect(damaged(doc => { entry(doc, 'dispatches', 0).attempt = 1.5 })).toBe(false)
    expect(damaged(doc => { entry(doc, 'dispatches', 0).attempt = 0 })).toBe(false)
    expect(damaged(doc => { const d = entry(doc, 'dispatches', 0); d.status = 'completed'; d.settledBy = 'whatever'; d.settledAt = AT })).toBe(false)
    expect(damaged(doc => { const d = entry(doc, 'dispatches', 0); d.status = 'completed'; d.settledBy = 'reconcile'; d.settledAt = AT })).toBe(false)
    expect(damaged(doc => { const d = entry(doc, 'dispatches', 0); d.status = 'unknown'; d.settledBy = 'task-update'; d.settledAt = AT })).toBe(false)
  })

  it('refuses a broken agent identity and a broken reconcile record', () => {
    expect(damaged(doc => { entry(doc, 'dispatches', 0).agent = { kind: 123, argv: 'not-an-array' } })).toBe(false)
    expect(damaged(doc => { entry(doc, 'dispatches', 0).agent = { kind: 'claude' } })).toBe(false)
    expect(damaged(doc => { entry(doc, 'dispatches', 0).reconcile = { observed: 'yes', reason: 'invented' } })).toBe(false)
    expect(damaged(doc => { entry(doc, 'dispatches', 0).reconcile = { at: AT, runtimeInstanceId: 'i', observed: true, reason: 'invented' } })).toBe(false)
  })

  it('refuses a settled task with no result key', () => {
    const { state, taskId } = dispatchedWithAgent()
    const settled = document(transition(state, { taskId, to: 'completed', result: null, settledBy: 'task-update', at: LATER }).state)
    const task = entry(settled, 'tasks', 1)
    expect(isOrchestrationState(settled)).toBe(true)
    delete task.result
    expect(isOrchestrationState(settled)).toBe(false)
  })

  it('refuses orphans, duplicates and references that point nowhere', () => {
    expect(damaged(doc => { doc.tasks = [] })).toBe(false)                                   // orphan dispatch
    expect(damaged(doc => { entry(doc, 'dispatches', 0).taskId = mintId('task') })).toBe(false)
    expect(damaged(doc => { entry(doc, 'dispatches', 0).runId = mintId('run') })).toBe(false)
    expect(damaged(doc => { entry(doc, 'tasks', 1).runId = mintId('run') })).toBe(false)
    expect(damaged(doc => { entry(doc, 'tasks', 1).currentDispatchId = mintId('ctx') })).toBe(false)
    expect(damaged(doc => { const list = doc.runs; if (Array.isArray(list)) list.push(list[0]) })).toBe(false)
    expect(damaged(doc => { const list = doc.tasks; if (Array.isArray(list)) list.push(list[0]) })).toBe(false)
    expect(damaged(doc => { const list = doc.dispatches; if (Array.isArray(list)) list.push(list[0]) })).toBe(false)
  })
})

describe('LIFE-409 r1 — smaller review findings (C4, C5)', () => {
  it('tells a pending task with nothing unmet apart from one that is actually waiting (C4)', () => {
    const base = seed()
    const waiting = createTask(base.state, { runId: base.runId, spec: 'waiting', title: null, deps: [base.dep.id], at: AT })
    expect(startability(waiting.state, waiting.task)).toMatchObject({ startable: false, reason: 'unmet_dependencies', unmetDependencies: [base.dep.id] })
    // The C4 trap: `blocked → pending` on a task whose dependencies are all met leaves it pending
    // with nothing to wait for. The refusal must not claim unmet dependencies it cannot name.
    const ready = createTask(base.state, { runId: base.runId, spec: 'no deps', title: null, deps: [], at: AT })
    let state = transition(ready.state, { taskId: ready.task.id, to: 'blocked', settledBy: 'task-update', at: AT }).state
    state = transition(state, { taskId: ready.task.id, to: 'pending', settledBy: 'task-update', at: AT }).state
    const stuck = startability(state, findTask(state, ready.task.id)!)
    expect(stuck).toMatchObject({ startable: false, reason: 'not_ready', unmetDependencies: [] })
    expect(stuck.startable === false && stuck.recovery.includes('task-update')).toBe(true)
  })

  it('refuses --result on a transition that does not settle the task (C5)', () => {
    const inv = (flags: Record<string, string | boolean>) => ({ command: 'orchestration task-update', flags, args: [], cwd: '/tmp' })
    const id = mintId('task')
    expect(code(() => validateOrchestration(inv({ id, status: 'blocked', result: '{"kept":true}' })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv({ id, status: 'ready', result: '1' })))).toBe('invalid_argument')
    expect(code(() => validateOrchestration(inv({ id, status: 'completed', result: '{"kept":true}' })))).toBe('no-error')
    expect(code(() => validateOrchestration(inv({ id, status: 'failed', result: 'null' })))).toBe('no-error')
    expect(code(() => validateOrchestration(inv({ id, status: 'blocked' })))).toBe('no-error')
  })
})

/**
 * r2. The second review found four documents the r1 guard still accepted (N1 = C14 = R9): a
 * pointer that does not point back, two live attempts on one Task, a settled Task still holding an
 * open attempt, and a dependency on a Task that is not there. Each is a shape the product cannot
 * write, and each would be carried forward and cemented by the next write.
 */
describe('LIFE-409 r2 — the store guard holds the invariants the product maintains (N1 = C14 = R9)', () => {
  const damaged = (build: (doc: Record<string, unknown>) => void): boolean => {
    const doc = document(dispatchedWithAgent().state)
    build(doc)
    return isOrchestrationState(doc)
  }

  it('refuses an open attempt the task does not point at', () => {
    expect(damaged(doc => { entry(doc, 'tasks', 1).currentDispatchId = null })).toBe(false)
    const { state, taskId } = dispatchedWithAgent()
    const second = createTask(state, { runId: state.runs[0]!.id, spec: 'other', title: null, deps: [], at: AT })
    const doc = document(second.state)
    // Pointing at another Task's attempt was already refused; pointing at nothing is the gap.
    expect(isOrchestrationState(doc)).toBe(true)
    entry(doc, 'tasks', 1).currentDispatchId = null
    expect(isOrchestrationState(doc)).toBe(false)
    expect(findTask(second.state, taskId)?.currentDispatchId).not.toBe(null)
  })

  it('refuses two open attempts on one task', () => {
    expect(damaged(doc => {
      const first = entry(doc, 'dispatches', 0)
      const clone: Record<string, unknown> = { ...first, id: `ctx_${'a'.repeat(12)}`, attempt: 2 }
      const list = doc.dispatches
      if (Array.isArray(list)) list.push(clone)
    })).toBe(false)
  })

  it('refuses a settled task that still holds an open attempt', () => {
    expect(damaged(doc => {
      const task = entry(doc, 'tasks', 1)
      task.status = 'completed'; task.settledAt = LATER; task.result = null
    })).toBe(false)
    expect(damaged(doc => {
      const task = entry(doc, 'tasks', 1)
      task.status = 'failed'; task.settledAt = LATER; task.result = null
    })).toBe(false)
  })

  it('refuses a dependency on a task that is not in the run', () => {
    expect(damaged(doc => { entry(doc, 'tasks', 1).deps = [mintId('task')] })).toBe(false)
    const base = seed()
    const first = createTask(base.state, { runId: base.runId, spec: 'first', title: null, deps: [], at: AT })
    const second = createTask(first.state, { runId: base.runId, spec: 'second', title: null, deps: [first.task.id], at: AT })
    expect(isOrchestrationState(document(second.state))).toBe(true)
    const doc = document(second.state)
    entry(doc, 'tasks', 1).deps = [entry(doc, 'tasks', 0).id]
    expect(isOrchestrationState(doc)).toBe(true)
  })
})

/**
 * r3. The third review found the parts of r2 that were right in the product and wrong in what it
 * *said* — or right for one outcome and copied onto another. These pin the three rules that were
 * only readable in the source until now, plus the document shape M11 left open.
 */
describe('LIFE-409 r3 — the rules r2 left unpinned (M11, M12 = C26, C27)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('refuses a task that depends on itself (M11 = C26)', () => {
    const base = seed()
    const first = createTask(base.state, { runId: base.runId, spec: 'first', title: null, deps: [], at: AT })
    const doc = document(first.state)
    const task = entry(doc, 'tasks', 1)
    // A Task depending on a sibling is legal and stays legal — the shape below is the only change.
    expect(isOrchestrationState(doc)).toBe(true)
    task.deps = [task.id]
    // `createTask` answers `dependency_cycle` for this input, so the document is one the product
    // cannot write; the r2 guard accepted it because a self-reference resolves against the very
    // list the Task belongs to.
    expect(isOrchestrationState(doc)).toBe(false)
    expect(code(() => createTask(first.state, { runId: base.runId, spec: 'self', title: null, deps: [first.task.id], at: AT }))).toBe('no-error')
  })

  it('never claims more of the caller timeout than is left, at the floor (M12 = C27)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T00:00:00.000Z'))
    const now = Date.now()
    const ctx = (remaining: number) => ({ signal: new AbortController().signal, deadlineAt: now + remaining })
    // The share is half of what is left: 500 ms is the first window worth looking in.
    expect(budgeted(ctx(499), 2000)).toBe(null)
    expect(budgeted(ctx(500), 2000)).not.toBe(null)
    expect(budgeted(ctx(501), 2000)).not.toBe(null)
    expect(budgeted(ctx(500), 2000)?.deadlineAt).toBe(now + 250)
    expect(budgeted(ctx(501), 2000)?.deadlineAt).toBe(now + 250)
    // Never more than half, and never more than the sweep budget, whichever is smaller.
    expect(budgeted(ctx(1000), 2000)?.deadlineAt).toBe(now + 500)
    expect(budgeted(ctx(60000), 2000)?.deadlineAt).toBe(now + 2000)
    // An expired deadline is not a negative window.
    expect(budgeted(ctx(0), 2000)).toBe(null)
    expect(budgeted(ctx(-5000), 2000)).toBe(null)
  })

  it('keeps an unknown outcome from being told to send a new request id (M1 = R14 = C20)', () => {
    // What `receipts.ts` raises itself: `requestId` and its own recovery, no `detail` key.
    const own = new RuntimeError('outcome_unknown', 'Recorded request may have taken effect; inspect terminal list/read before a new request',
      { requestId: 'r1.1758500000000.00000000-0000-0000-0000-000000000000', recovery: 'terminal list / terminal read' }, 'receipt', 'unknown')
    const flat = flattenReceiptError(own)
    expect(flat).toBeInstanceOf(RuntimeError)
    if (!(flat instanceof RuntimeError) || !isRecord(flat.resources)) throw new Error('unreachable')
    expect(flat.code).toBe('outcome_unknown')
    expect(flat.stage).toBe('receipt')
    expect(flat.outcome).toBe('unknown')
    expect(String(flat.resources.recovery)).toMatch(/orchestration run-show/)
    expect(String(flat.resources.recovery)).not.toMatch(/send a new --request-id/)

    // The body wrapper whose inner error was not a RuntimeError: `detail` is present but undefined,
    // and the outcome is still unknown, so it gets the same advice.
    const wrapped = new RuntimeError('outcome_unknown', 'boom',
      { requestId: 'r1.1758500000000.00000000-0000-0000-0000-000000000001', terminal: null, recovery: 'Retry the same request ID or inspect terminal list/read', detail: undefined }, 'backend', 'unknown')
    const flatWrapped = flattenReceiptError(wrapped)
    if (!(flatWrapped instanceof RuntimeError) || !isRecord(flatWrapped.resources)) throw new Error('unreachable')
    expect(String(flatWrapped.resources.recovery)).toMatch(/orchestration run-show/)
    expect(String(flatWrapped.resources.recovery)).not.toMatch(/Retry the same request ID/)

    // A rejection the body raised keeps its own recovery and its own resources, as in r1.
    const inner = new RuntimeError('task_not_startable', 'no', { reason: 'dispatch_active', recovery: 'corral orchestration dispatch-show --task <task>' }, 'preflight', 'not_started')
    const rejection = new RuntimeError(inner.code, inner.message,
      { requestId: 'r1.1758500000000.00000000-0000-0000-0000-000000000002', terminal: null, recovery: 'Retry the same request ID or inspect terminal list/read', detail: inner.resources }, 'preflight', 'not_started')
    const flatRejection = flattenReceiptError(rejection)
    if (!(flatRejection instanceof RuntimeError) || !isRecord(flatRejection.resources)) throw new Error('unreachable')
    expect(flatRejection.resources.reason).toBe('dispatch_active')
    expect(flatRejection.resources.recovery).toBe('corral orchestration dispatch-show --task <task>')

    // A `not_started` rejection with no recovery of its own is the one case that gets "spent".
    const bare = new RuntimeError('operation_failed', 'no',
      { requestId: 'r1.1758500000000.00000000-0000-0000-0000-000000000003', terminal: null, recovery: 'Retry the same request ID or inspect terminal list/read', detail: {} }, 'preflight', 'not_started')
    const flatBare = flattenReceiptError(bare)
    if (!(flatBare instanceof RuntimeError) || !isRecord(flatBare.resources)) throw new Error('unreachable')
    expect(String(flatBare.resources.recovery)).toMatch(/spent/)
    // An error that never went through the receipt store is returned untouched.
    const plain = new RuntimeError('run_required', 'no', { currentRun: null }, 'preflight', 'not_started')
    expect(flattenReceiptError(plain)).toBe(plain)
  })

  it('mirrors the three cases the receipt store answers itself (M2 = R15, M12)', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'l409-mirror-'))
    const startedAt = Date.parse('2026-09-23T00:00:00.000Z')
    const id = (ms: number, tail = '0'): string => `r1.${ms}.${tail.repeat(8)}-0000-0000-0000-${tail.repeat(12)}`
    const here = new Map<string, number>()
    const mirror = (candidate: string | undefined) => receiptsOwnTheAnswer(candidate, { startedAt, userData, here })

    const fresh = id(startedAt + 1000, '1')
    expect(mirror(fresh)).toBe(false)
    expect(mirror(undefined)).toBe(false)
    expect(mirror('not-a-request-id')).toBe(false)
    // (1) an id this runtime admitted — the branch M2 moved to the other side of admission.
    here.set(fresh, startedAt + 1000)
    expect(mirror(fresh)).toBe(true)
    // (2) an id older than this runtime: `Receipts` refuses to re-execute it, receipt or not.
    expect(mirror(id(startedAt - 1, '2'))).toBe(true)
    // (3) a receipt on disk, written by this runtime or a previous one.
    const onDisk = id(startedAt + 2000, '3')
    fs.mkdirSync(path.join(userData, 'runtime/terminal-receipts'), { recursive: true })
    expect(mirror(onDisk)).toBe(false)
    fs.writeFileSync(path.join(userData, 'runtime/terminal-receipts', `${onDisk}.json`), '{}')
    expect(mirror(onDisk)).toBe(true)
    fs.rmSync(userData, { recursive: true, force: true })
  })
})
