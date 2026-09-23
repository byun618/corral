/**
 * LIFE-409 — Run/Task/Dispatch records, the transition table and the reconcile decision.
 *
 * Everything here is pure: no filesystem, no backend, no clock of its own. The caller supplies the
 * whole state document and the timestamp, and gets a new document back or a `RuntimeError`. That is
 * what makes "one mutation = one atomic write" structural rather than a convention — `index.ts`
 * reads once, calls one of these functions, and writes the returned document once (§4.8).
 *
 * `transition` is the single manual transition primitive. LIFE-410's `worker_done` reception reuses
 * it with `settledBy: 'worker_done'` instead of adding a second state machine (01-criteria 5).
 */
import { randomBytes } from 'node:crypto'
import { RuntimeError } from '../contracts.js'
import type { DeliveryRecord, MessageRecord } from './messages.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

// --- identity -----------------------------------------------------------------------------------

/** Orca's prefixes, so a harness document that says `ctx_…` keeps meaning the same thing. */
export type IdKind = 'run' | 'task' | 'ctx'
export const ID_PATTERNS: Readonly<Record<IdKind, RegExp>> = { run: /^run_[0-9a-f]{12}$/, task: /^task_[0-9a-f]{12}$/, ctx: /^ctx_[0-9a-f]{12}$/ }
export const isId = (kind: IdKind, value: unknown): value is string => typeof value === 'string' && ID_PATTERNS[kind].test(value)
export const mintId = (kind: IdKind): string => `${kind}_${randomBytes(6).toString('hex')}`

// --- statuses -----------------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']
export const isTaskStatus = (value: unknown): value is TaskStatus => TASK_STATUSES.some(status => status === value)
/** `unknown` is reconcile's alone: an attempt whose pane corral can no longer observe (§4.4). */
export type DispatchStatus = 'dispatched' | 'completed' | 'failed' | 'unknown'
export const DISPATCH_STATUSES: readonly DispatchStatus[] = ['dispatched', 'completed', 'failed', 'unknown']
export const isDispatchStatus = (value: unknown): value is DispatchStatus => DISPATCH_STATUSES.some(status => status === value)
export type SettledBy = 'task-update' | 'reconcile' | 'worker_done'

// --- records ------------------------------------------------------------------------------------

export interface RunRecord { id: string; objective: string; createdAt: string; updatedAt: string; version: number }

interface TaskBase {
  id: string
  runId: string
  spec: string
  title: string | null
  deps: string[]
  /** The most recent attempt, settled or not. "Active" is derived from *that* record's status. */
  currentDispatchId: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  version: number
}
/**
 * A terminal task carries a result and the moment it was settled; an open one carries neither. The
 * union is what makes `task.result` unreadable until the status has been narrowed, so no code path
 * can report a result for a task that never produced one.
 */
export type TaskRecord = TaskBase & (
  | { status: 'pending' | 'ready' | 'dispatched' | 'blocked'; result: null; settledAt: null }
  | { status: 'completed' | 'failed'; result: JsonValue; settledAt: string }
)

export interface DispatchTarget { handle: string; runtimeId: string; epoch: string; ptyId: string; paneId: string }
/**
 * The subset of `terminal show`'s agent block that describes *identity*, frozen at dispatch time.
 * The screen excerpt and the readiness evidence are deliberately not stored: they are observations
 * about a moment, they age instantly, and one of them carries terminal content.
 */
export interface AgentSnapshot {
  kind: string | null
  name: string | null
  phase: string | null
  requestedModel: string | null
  requestedEffort: string | null
  requestedAdvisor: string | null
  resolvedModel: string | null
  resolvedAdvisor: string | null
  argv: string[] | null
  sessionId: string | null
  sessionIdSource: string | null
  observedAt: string
}
export type ReconcileReason = 'pane_live' | 'pane_gone' | 'pty_replaced' | 'epoch_changed' | 'backend_unavailable' | 'observation_failed'
export interface ReconcileRecord { at: string; runtimeInstanceId: string; observed: boolean; reason: ReconcileReason }

/**
 * LIFE-410 §4.3 — what makes an attempt a *worker*: who owns its pane, whether it may still report,
 * and how it was recovered. It is optional so a LIFE-409 document loads unchanged: an attempt
 * created by `orchestration dispatch` has no worker block and accepts no worker report.
 */
export type WorkerLaunch = 'created' | 'reused'
export type WorkerOwnership = 'owned' | 'borrowed'
export type CapabilityRevokedReason = 'settled' | 'stopped' | 'abandoned' | 'released'
export type RetainReason = 'user_requested' | 'user_takeover'
export type ReleaseState = 'released' | 'retained' | 'unknown'
export interface WorkerRelease { state: ReleaseState; reason: string; at: string; processAction: 'closed' | 'none' }
export interface WorkerBlock {
  launch: WorkerLaunch
  /** Whether *this* attempt may close the pane. Reuse transfers it; a borrowed pane is never closed. */
  ownership: WorkerOwnership
  originDispatchId: string | null
  ownershipTransferredTo: string | null
  /** The backend session the pane lives in. Pane ids repeat across sessions, so both are compared. */
  paneSession: string | null
  preambleSha256: string | null
  /**
   * V22. The lead line is typed into the pane's input line as its own effect, before the body is
   * pasted, and the two are not one submission. Recording that it was typed — before it is typed —
   * is what keeps a resume from typing it again: a second lead would make the row the provider
   * records start with two of them, and the body identity this attempt was created against would
   * no longer match it.
   */
  lead: { requestId: string; at: string } | null
  promptRequestId: string | null
  lastHeartbeatAt: string | null
  /** Capability lifetime is not process lifetime (§4.5): a live pane may have lost the right to report. */
  capabilityRevokedAt: string | null
  capabilityRevokedReason: CapabilityRevokedReason | null
  retain: { reason: RetainReason; at: string } | null
  release: WorkerRelease | null
}

interface DispatchBase {
  id: string
  runId: string
  taskId: string
  attempt: number
  target: DispatchTarget
  agent: AgentSnapshot | null
  /** Why `agent` is null. A pane with no corral-managed agent is a legitimate dispatch target. */
  agentAbsenceReason: string | null
  /** The last observation corral actually made and recorded. Unobserved passes record nothing. */
  reconcile: ReconcileRecord | null
  /** LIFE-410. `null` for an attempt that was never started as a supervised worker. */
  worker: WorkerBlock | null
  createdAt: string
  updatedAt: string
  version: number
}
export type DispatchRecord = DispatchBase & (
  | { status: 'dispatched'; settledBy: null; settledAt: null }
  | { status: 'completed' | 'failed'; settledBy: 'task-update' | 'worker_done'; settledAt: string }
  | { status: 'unknown'; settledBy: 'reconcile'; settledAt: string }
)

export interface OrchestrationState {
  schemaVersion: 1
  /** Profile-wide binding (§4.7). `--run` overrides it for one call without rebinding. */
  currentRunId: string | null
  runs: RunRecord[]
  tasks: TaskRecord[]
  dispatches: DispatchRecord[]
  /**
   * LIFE-410 §4.8. The Run mailbox lives in the *same* document, which is what makes
   * "settle the attempt and store the report" one `rename(2)` rather than a two-file protocol.
   */
  messages: MessageRecord[]
  deliveries: DeliveryRecord[]
}
export const emptyState = (): OrchestrationState => ({ schemaVersion: 1, currentRunId: null, runs: [], tasks: [], dispatches: [], messages: [], deliveries: [] })

/** A switch that forgot a variant is a type error here, not a silent fallthrough at runtime. */
export function exhausted(value: never): never {
  throw new RuntimeError('operation_failed', `Unhandled orchestration variant: ${JSON.stringify(value)}`)
}
const fail = (code: string, message: string, resources?: unknown): never => {
  throw new RuntimeError(code, message, resources, 'preflight', 'not_started')
}

// --- lookups ------------------------------------------------------------------------------------

export const findRun = (state: OrchestrationState, id: string): RunRecord | undefined => state.runs.find(run => run.id === id)
export const findTask = (state: OrchestrationState, id: string): TaskRecord | undefined => state.tasks.find(task => task.id === id)
export const findDispatch = (state: OrchestrationState, id: string): DispatchRecord | undefined => state.dispatches.find(entry => entry.id === id)
/** Attempts are appended, so the last one for a task is the most recent by construction. */
export const latestDispatch = (state: OrchestrationState, taskId: string): DispatchRecord | undefined =>
  state.dispatches.filter(entry => entry.taskId === taskId).at(-1)
/** At most one attempt per task is open; `dispatch` refuses to create a second one (§4.3). */
export const activeDispatch = (state: OrchestrationState, taskId: string): DispatchRecord | undefined => {
  const latest = latestDispatch(state, taskId)
  return latest?.status === 'dispatched' ? latest : undefined
}
export const unmetDependencies = (state: OrchestrationState, deps: string[]): string[] =>
  deps.filter(id => findTask(state, id)?.status !== 'completed')

// --- record surgery -----------------------------------------------------------------------------

function taskBase(task: TaskRecord): TaskBase {
  const { id, runId, spec, title, deps, currentDispatchId, attempts, createdAt, updatedAt, version } = task
  return { id, runId, spec, title, deps, currentDispatchId, attempts, createdAt, updatedAt, version }
}
function openTask(task: TaskRecord, status: 'pending' | 'ready' | 'dispatched' | 'blocked', at: string, patch: Partial<TaskBase> = {}): TaskRecord {
  return { ...taskBase(task), ...patch, status, result: null, settledAt: null, updatedAt: at, version: task.version + 1 }
}
function settledTask(task: TaskRecord, status: 'completed' | 'failed', result: JsonValue, at: string): TaskRecord {
  return { ...taskBase(task), status, result, settledAt: at, updatedAt: at, version: task.version + 1 }
}
function dispatchBase(entry: DispatchRecord): DispatchBase {
  const { id, runId, taskId, attempt, target, agent, agentAbsenceReason, reconcile, worker, createdAt, updatedAt, version } = entry
  return { id, runId, taskId, attempt, target, agent, agentAbsenceReason, reconcile, worker, createdAt, updatedAt, version }
}
const replaceTask = (state: OrchestrationState, task: TaskRecord): TaskRecord[] => state.tasks.map(entry => entry.id === task.id ? task : entry)
const replaceDispatch = (state: OrchestrationState, entry: DispatchRecord): DispatchRecord[] => state.dispatches.map(row => row.id === entry.id ? entry : row)

// --- startability (§4.3) ------------------------------------------------------------------------

export type StartabilityReason = 'task_completed' | 'task_blocked' | 'unmet_dependencies' | 'not_ready' | 'dispatch_active'
export type Startability =
  | { startable: true; from: TaskStatus }
  | { startable: false; reason: StartabilityReason; unmetDependencies: string[]; activeDispatchId: string | null; recovery: string }

/** What a person can do about each refusal. §4.3 names the reason; this names the next command. */
const RECOVERY: Readonly<Record<StartabilityReason, string>> = {
  task_completed: 'A completed Task is terminal; create a new Task for further work',
  task_blocked: 'corral orchestration task-update --id <task> --status ready (or pending)',
  unmet_dependencies: 'Complete the dependencies listed in unmetDependencies, which promotes this Task to ready',
  // The C4 trap: `blocked → pending` on a Task whose dependencies are already met leaves it in
  // `pending` with nothing left to wait for, and there is no manual `pending → ready`. Saying
  // "unmet dependencies" and then naming none is what the review found misleading.
  not_ready: 'corral orchestration task-update --id <task> --status blocked, then --status ready',
  dispatch_active: 'corral orchestration dispatch-show --id <dispatch> to reconcile it, or settle the Task with task-update',
}
const refuse = (reason: StartabilityReason, unmetDependencies: string[], activeDispatchId: string | null): Startability =>
  ({ startable: false, reason, unmetDependencies, activeDispatchId, recovery: RECOVERY[reason] })

export function startability(state: OrchestrationState, task: TaskRecord): Startability {
  const status: TaskStatus = task.status, open = activeDispatch(state, task.id)
  switch (status) {
    // §4.3(2) is unconditional: an open attempt refuses a new one, whatever the Task's own status
    // says. Since r1 `transition` refuses `dispatched → blocked` while the attempt is open (R1), so
    // the detour that used to reach `ready` with a live attempt is closed one step earlier and this
    // is now the second net rather than the first — N5 = G7 corrects the r1 comment, which still
    // described that detour as legal. A Task becomes startable again once the open attempt has
    // *ended* — settled `failed` by a human who observed the failure, or `unknown` by reconcile
    // (M6 = R19: the r2 sentence named only reconcile, and `dispatched → failed` is the other
    // half of the same rule, see the `dispatched`/`failed` case below).
    case 'ready':
      if (open) return refuse('dispatch_active', [], open.id)
      return { startable: true, from: status }
    case 'completed':
      return refuse('task_completed', [], null)
    case 'blocked':
      return refuse('task_blocked', unmetDependencies(state, task.deps), open?.id ?? null)
    case 'pending': {
      if (open) return refuse('dispatch_active', unmetDependencies(state, task.deps), open.id)
      const unmet = unmetDependencies(state, task.deps)
      return refuse(unmet.length ? 'unmet_dependencies' : 'not_ready', unmet, null)
    }
    case 'dispatched':
    case 'failed': {
      // §4.3(3): a retry needs the previous attempt to have *ended* — observed failure or an
      // unknown a reconcile recorded. An attempt still open is refused, which is what keeps one
      // task from having two live workers.
      if (open) return refuse('dispatch_active', [], open.id)
      const latest = latestDispatch(state, task.id)
      if (latest && (latest.status === 'failed' || latest.status === 'unknown')) return { startable: true, from: status }
      return refuse('dispatch_active', [], latest?.id ?? null)
    }
    default:
      return exhausted(status)
  }
}

// --- reconcile (§4.5) ---------------------------------------------------------------------------

/** What one look at the backend said about the pane an attempt was bound to. */
export type PaneObservation =
  | { kind: 'live' }
  | { kind: 'pane_gone' }
  | { kind: 'pty_replaced'; observedPtyId: string }
  | { kind: 'epoch_changed'; observedEpoch: string }
  | { kind: 'unobserved'; reason: 'backend_unavailable' | 'observation_failed'; detail: string | null }

export interface ReconcileDecision {
  live: boolean | 'unknown'
  observed: boolean
  reason: ReconcileReason
  /** Whether this observation settles the attempt as `unknown`. Never `failed` — §4.4. */
  settle: boolean
}
export function reconcileDecision(observation: PaneObservation): ReconcileDecision {
  switch (observation.kind) {
    case 'live': return { live: true, observed: true, reason: 'pane_live', settle: false }
    case 'pane_gone': return { live: false, observed: true, reason: 'pane_gone', settle: true }
    case 'pty_replaced': return { live: false, observed: true, reason: 'pty_replaced', settle: true }
    case 'epoch_changed': return { live: false, observed: true, reason: 'epoch_changed', settle: true }
    // A backend corral cannot reach says nothing about the pane. The record is left exactly as it
    // is — not even a reconcile stamp — so "could not look" never reads as "looked and saw".
    case 'unobserved': return { live: 'unknown', observed: false, reason: observation.reason, settle: false }
    default: return exhausted(observation)
  }
}

export interface ReconcileOutcome { state: OrchestrationState; changed: boolean; dispatch: DispatchRecord }
/**
 * Apply one observation to one open attempt. Writes are deliberately stingy: an unobserved pass
 * changes nothing at all, and an observation that repeats what is already recorded changes nothing
 * either, so repeated `dispatch-show` calls leave the document byte-identical.
 */
export function applyReconcile(state: OrchestrationState, entry: DispatchRecord, observation: PaneObservation, at: string, runtimeInstanceId: string): ReconcileOutcome {
  const decision = reconcileDecision(observation)
  if (!decision.observed) return { state, changed: false, dispatch: entry }
  const record: ReconcileRecord = { at, runtimeInstanceId, observed: true, reason: decision.reason }
  if (decision.settle && entry.status === 'dispatched') {
    const settled: DispatchRecord = { ...dispatchBase(entry), reconcile: record, status: 'unknown', settledBy: 'reconcile', settledAt: at, updatedAt: at, version: entry.version + 1 }
    return { state: { ...state, dispatches: replaceDispatch(state, settled) }, changed: true, dispatch: settled }
  }
  if (entry.reconcile?.observed === true && entry.reconcile.reason === decision.reason) return { state, changed: false, dispatch: entry }
  const stamped: DispatchRecord = { ...entry, reconcile: record, updatedAt: at, version: entry.version + 1 }
  return { state: { ...state, dispatches: replaceDispatch(state, stamped) }, changed: true, dispatch: stamped }
}

// --- transitions (§4.4) -------------------------------------------------------------------------

/**
 * The manual table, exactly as frozen: `dispatched → completed|failed`, `* → blocked` except from
 * the terminal `completed`, and `blocked → ready|pending`. `ready → dispatched` is absent on
 * purpose — only the `dispatch` command creates an attempt, and only it may make that move.
 */
export const MANUAL_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['blocked'],
  ready: ['blocked'],
  dispatched: ['completed', 'failed', 'blocked'],
  completed: [],
  failed: ['blocked'],
  blocked: ['ready', 'pending'],
}

export interface TransitionInput {
  taskId: string
  to: TaskStatus
  /** Names the attempt this settlement belongs to. Omitted means "whichever one is open". */
  dispatchId?: string
  result?: JsonValue
  expectedVersion?: number
  settledBy: 'task-update' | 'worker_done'
  at: string
}
export interface TransitionResult {
  state: OrchestrationState
  task: TaskRecord
  dispatch: DispatchRecord | null
  /** Dependents this completion promoted, in the same atomic write (§4.4). */
  promoted: TaskRecord[]
}

/**
 * The one manual transition primitive. Checks run in a fixed order and every failure is effect-free:
 *
 *   version → task transition legality → attempt staleness → dependency guard.
 *
 * Task legality is asked *before* staleness on purpose. Settling an already-settled task is
 * `illegal_transition` even when the caller names the attempt that settled it (F6, second half),
 * while naming a superseded attempt on a task that is still open is `stale_dispatch` (F6, first
 * half). Only this order answers both.
 */
export function transition(state: OrchestrationState, input: TransitionInput): TransitionResult {
  const task = findTask(state, input.taskId)
  if (!task) return fail('task_not_found', `No task ${input.taskId}`,
    { taskId: input.taskId, recovery: 'corral orchestration task-list to see the Tasks this Run holds' })
  if (input.expectedVersion !== undefined && input.expectedVersion !== task.version)
    return fail('version_conflict', `Task ${task.id} is at version ${task.version}`,
      { taskId: task.id, currentVersion: task.version, expectedVersion: input.expectedVersion,
        recovery: 'Re-read the Task with corral orchestration task-list, then retry with its current --expected-version' })
  if (!MANUAL_TRANSITIONS[task.status].includes(input.to))
    return fail('illegal_transition', `${task.status} → ${input.to} is not a manual transition`,
      { taskId: task.id, from: task.status, to: input.to, allowed: MANUAL_TRANSITIONS[task.status],
        recovery: 'corral orchestration task-list shows the Task status this move starts from; only the listed transitions are manual' })

  const open = activeDispatch(state, task.id)
  // R1 (1차 판정 계약 해석 1). `* → blocked` stays in the table, but an open attempt refuses it:
  // moving the Task out of `dispatched` while its attempt is live would leave that attempt with no
  // manual exit at all (settling goes through `dispatched → completed|failed`), stranding a worker
  // that is still using the pane. Settle the attempt, or let reconcile close it when the pane is
  // gone — corral never kills a live pane to unstick a record.
  if (input.to === 'blocked' && open !== undefined)
    return fail('illegal_transition', `Task ${task.id} still has an open attempt ${open.id}`,
      { taskId: task.id, from: task.status, to: input.to, allowed: MANUAL_TRANSITIONS[task.status], reason: 'dispatch_active', activeDispatchId: open.id,
        recovery: 'Settle it with corral orchestration task-update --status completed|failed, or run dispatch-show --id <dispatch> once the pane is gone so reconcile closes it' })
  if (input.dispatchId !== undefined) {
    const named = findDispatch(state, input.dispatchId)
    if (!named) return fail('dispatch_not_found', `No dispatch ${input.dispatchId}`, { dispatchId: input.dispatchId, activeDispatchId: open?.id ?? null })
    if (named.id !== open?.id)
      return fail('stale_dispatch', `Dispatch ${named.id} is not the open attempt of ${task.id}`,
        { dispatchId: named.id, dispatchStatus: named.status, taskId: task.id, activeDispatchId: open?.id ?? null,
          recovery: 'corral orchestration dispatch-show --task <task> names the open attempt; omit --dispatch to settle whichever one is open' })
  }
  // Unblocking to `ready` keeps the invariant that `ready` means "every dependency completed".
  // `blocked → pending` is always available when the dependencies are not met yet.
  if (input.to === 'ready') {
    const unmet = unmetDependencies(state, task.deps)
    if (unmet.length) return fail('illegal_transition', `Task ${task.id} still has unmet dependencies`, { taskId: task.id, from: task.status, to: input.to, unmetDependencies: unmet })
  }

  const next = input.to === 'completed' || input.to === 'failed'
    ? settledTask(task, input.to, input.result ?? null, input.at)
    : openTask(task, input.to, input.at)
  let working: OrchestrationState = { ...state, tasks: replaceTask(state, next) }
  let settled: DispatchRecord | null = null
  if (open !== undefined && (input.to === 'completed' || input.to === 'failed')) {
    const entry: DispatchRecord = { ...dispatchBase(open), status: input.to, settledBy: input.settledBy, settledAt: input.at, updatedAt: input.at, version: open.version + 1 }
    settled = entry
    working = { ...working, dispatches: replaceDispatch(working, entry) }
  }
  const promoted: TaskRecord[] = []
  if (input.to === 'completed') {
    for (const candidate of working.tasks) {
      if (candidate.status !== 'pending' || !candidate.deps.includes(task.id)) continue
      if (unmetDependencies(working, candidate.deps).length) continue
      const ready = openTask(candidate, 'ready', input.at)
      promoted.push(ready)
      working = { ...working, tasks: replaceTask(working, ready) }
    }
  }
  return { state: working, task: next, dispatch: settled, promoted }
}

// --- creation -----------------------------------------------------------------------------------

export function createRun(state: OrchestrationState, objective: string, at: string): { state: OrchestrationState; run: RunRecord } {
  const run: RunRecord = { id: uniqueId(state, 'run'), objective, createdAt: at, updatedAt: at, version: 1 }
  return { state: { ...state, runs: [...state.runs, run], currentRunId: run.id }, run }
}

export function createTask(state: OrchestrationState, input: { runId: string; spec: string; title: string | null; deps: string[]; at: string }): { state: OrchestrationState; task: TaskRecord } {
  for (const dep of input.deps) {
    const found = findTask(state, dep)
    if (!found || found.runId !== input.runId) return fail('task_not_found', `No task ${dep} in run ${input.runId}`,
      { taskId: dep, runId: input.runId, recovery: 'corral orchestration task-list --run <run>: every --deps entry must be a Task of the same Run' })
  }
  const id = uniqueId(state, 'task')
  // Unreachable by construction — a new id cannot appear in a list of ids that already exist — but
  // the invariant is worth naming, and the check is what keeps it true if deps ever become editable.
  if (input.deps.includes(id)) return fail('dependency_cycle', `Task ${id} cannot depend on itself`, { taskId: id, deps: input.deps })
  const base: TaskBase = { id, runId: input.runId, spec: input.spec, title: input.title, deps: input.deps, currentDispatchId: null, attempts: 0, createdAt: input.at, updatedAt: input.at, version: 1 }
  const unmet = unmetDependencies(state, input.deps)
  const task: TaskRecord = { ...base, status: unmet.length ? 'pending' : 'ready', result: null, settledAt: null }
  return { state: { ...state, tasks: [...state.tasks, task] }, task }
}

export interface DispatchInput { task: TaskRecord; target: DispatchTarget; agent: AgentSnapshot | null; agentAbsenceReason: string | null; worker?: WorkerBlock | null; at: string }
export function createDispatch(state: OrchestrationState, input: DispatchInput): { state: OrchestrationState; task: TaskRecord; dispatch: DispatchRecord } {
  const start = startability(state, input.task)
  if (!start.startable)
    return fail('task_not_startable', `Task ${input.task.id} cannot take a new attempt (${start.reason})`,
      { taskId: input.task.id, status: input.task.status, reason: start.reason, unmetDependencies: start.unmetDependencies, activeDispatchId: start.activeDispatchId, recovery: start.recovery })
  const attempt = input.task.attempts + 1
  const entry: DispatchRecord = {
    id: uniqueId(state, 'ctx'), runId: input.task.runId, taskId: input.task.id, attempt,
    target: input.target, agent: input.agent, agentAbsenceReason: input.agentAbsenceReason, reconcile: null,
    worker: input.worker ?? null,
    createdAt: input.at, updatedAt: input.at, version: 1, status: 'dispatched', settledBy: null, settledAt: null,
  }
  const task = openTask(input.task, 'dispatched', input.at, { currentDispatchId: entry.id, attempts: attempt })
  return { state: { ...state, tasks: replaceTask(state, task), dispatches: [...state.dispatches, entry] }, task, dispatch: entry }
}

function uniqueId(state: OrchestrationState, kind: IdKind): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = mintId(kind)
    if (!findRun(state, id) && !findTask(state, id) && !findDispatch(state, id)) return id
  }
  throw new RuntimeError('operation_failed', `Could not mint a free ${kind} id`)
}

// --- reporting ----------------------------------------------------------------------------------

export function runCounts(state: OrchestrationState, runId: string) {
  const tasks = state.tasks.filter(task => task.runId === runId)
  const dispatches = state.dispatches.filter(entry => entry.runId === runId)
  const count = <T extends string>(names: readonly T[], rows: { status: T }[]) =>
    Object.fromEntries(names.map(name => [name, rows.filter(row => row.status === name).length]))
  return {
    tasks: { ...count(TASK_STATUSES, tasks), total: tasks.length },
    dispatches: { ...count(DISPATCH_STATUSES, dispatches), total: dispatches.length },
  }
}
