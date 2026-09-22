/**
 * LIFE-409 §4.8 — the whole orchestration state is one JSON document rewritten atomically.
 *
 * A mutation that touches a task, its attempt and two promoted dependents is still one
 * `rename(2)`, so multi-record atomicity is a property of the layout rather than of a protocol.
 * The durability promise is the one the rest of the profile already makes: `atomicWrite` does
 * `open(O_EXCL) → write → fsync → rename`, without a directory fsync and without `F_FULLFSYNC`, so
 * it survives a process crash and does not claim to survive power loss.
 *
 * Nothing here creates a directory at construction time — `cli.ts` builds every module on every
 * invocation, `--help` included, and a metadata-only command must not touch the profile.
 */
import path from 'node:path'
import { RuntimeError } from '../contracts.js'
import { atomicWrite, readFile } from '../storage.js'
import { isRecord } from '../../shared/json.js'
import {
  DISPATCH_STATUSES, TASK_STATUSES, emptyState, isId,
  type DispatchRecord, type OrchestrationState, type RunRecord, type TaskRecord,
} from './model.js'

const isString = (value: unknown): value is string => typeof value === 'string'
const isCtxId = (value: unknown): value is string => isId('ctx', value)
const isRunId = (value: unknown): value is string => isId('run', value)
const isNullOr = <T>(guard: (value: unknown) => value is T, value: unknown): value is T | null => value === null || guard(value)
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isStamp = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value))
const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => isId('task', entry))
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)
const oneOf = (allowed: readonly string[], value: unknown): boolean => isString(value) && allowed.includes(value)
const unique = (ids: string[]): boolean => new Set(ids).size === ids.length

/**
 * The fields that make an agent snapshot an *identity* (§4.2). A pane with no managed agent stores
 * `null`; anything else must carry every field, because a half-written snapshot read back as a
 * verdict about which provider ran is exactly the confusion the record exists to prevent.
 */
const AGENT_STRINGS = ['kind', 'name', 'phase', 'requestedModel', 'requestedEffort', 'requestedAdvisor', 'resolvedModel', 'resolvedAdvisor', 'sessionId', 'sessionIdSource']
function isAgent(value: unknown): boolean {
  if (!isRecord(value)) return false
  return AGENT_STRINGS.every(key => key in value && isNullOr(isString, value[key]))
    && (value.argv === null || isStringList(value.argv)) && isStamp(value.observedAt)
}
const RECONCILE_REASONS = ['pane_live', 'pane_gone', 'pty_replaced', 'epoch_changed', 'backend_unavailable', 'observation_failed']
function isReconcile(value: unknown): boolean {
  return isRecord(value) && isStamp(value.at) && isString(value.runtimeInstanceId)
    && typeof value.observed === 'boolean' && oneOf(RECONCILE_REASONS, value.reason)
}
/** Which `settledBy` each status may carry — the union `DispatchRecord` declares, enforced. */
const SETTLED_BY: Readonly<Record<string, readonly string[]>> = {
  dispatched: [], completed: ['task-update', 'worker_done'], failed: ['task-update', 'worker_done'], unknown: ['reconcile'],
}

function isRun(value: unknown): value is RunRecord {
  return isRecord(value) && isId('run', value.id) && isString(value.objective)
    && isStamp(value.createdAt) && isStamp(value.updatedAt) && isVersion(value.version)
}
function isTask(value: unknown): value is TaskRecord {
  if (!isRecord(value)) return false
  const settled = value.status === 'completed' || value.status === 'failed'
  return isId('task', value.id) && isId('run', value.runId) && isString(value.spec) && isNullOr(isString, value.title)
    && isIdList(value.deps) && TASK_STATUSES.some(status => status === value.status)
    && isNullOr(isCtxId, value.currentDispatchId)
    && typeof value.attempts === 'number' && Number.isSafeInteger(value.attempts) && value.attempts >= 0
    && isStamp(value.createdAt) && isStamp(value.updatedAt) && isVersion(value.version)
    // A settled Task carries a result *key* — `null` is a result, a missing key is a broken record.
    && (settled ? isStamp(value.settledAt) && 'result' in value : value.settledAt === null && value.result === null)
}
function isTarget(value: unknown): boolean {
  return isRecord(value) && isString(value.handle) && isString(value.runtimeId) && isString(value.epoch) && isString(value.ptyId) && isString(value.paneId)
}
function isDispatch(value: unknown): value is DispatchRecord {
  if (!isRecord(value)) return false
  const open = value.status === 'dispatched'
  if (!isString(value.status) || !DISPATCH_STATUSES.some(status => status === value.status)) return false
  return isId('ctx', value.id) && isId('run', value.runId) && isId('task', value.taskId)
    && typeof value.attempt === 'number' && Number.isSafeInteger(value.attempt) && value.attempt >= 1
    && isTarget(value.target) && (value.agent === null || isAgent(value.agent)) && isNullOr(isString, value.agentAbsenceReason)
    && (value.reconcile === null || isReconcile(value.reconcile))
    && isStamp(value.createdAt) && isStamp(value.updatedAt) && isVersion(value.version)
    && (open ? value.settledBy === null && value.settledAt === null
             : oneOf(SETTLED_BY[value.status] ?? [], value.settledBy) && isStamp(value.settledAt))
}
/**
 * A shape check, not a schema library. It exists so a truncated, foreign or hand-edited document
 * is refused loudly instead of being read as "a profile with no runs" — §4.5's "no partial
 * recovery, no silent reinitialization". A file that is merely absent is a new profile and is not
 * an error; `readFile` already separates those two cases by ENOENT.
 */
export function isOrchestrationState(value: unknown): value is OrchestrationState {
  if (!(isRecord(value) && value.schemaVersion === 1 && isNullOr(isRunId, value.currentRunId)
    && Array.isArray(value.runs) && value.runs.every(isRun)
    && Array.isArray(value.tasks) && value.tasks.every(isTask)
    && Array.isArray(value.dispatches) && value.dispatches.every(isDispatch))) return false
  return isConsistent(value.runs, value.tasks, value.dispatches)
}

/**
 * Shape is not enough: a document whose records do not agree with each other is corruption too. An
 * orphan attempt read back as `task: null`, a duplicate id that makes `find` ambiguous, a
 * `currentDispatchId` pointing at another Task's attempt, two live attempts on one Task, a settled
 * Task still holding one, or a dependency on a Task that is not there would all be carried forward
 * into the next write and quietly cemented. §4.5 says no partial recovery — so these are refused at the door.
 */
function isConsistent(runs: RunRecord[], tasks: TaskRecord[], dispatches: DispatchRecord[]): boolean {
  if (!unique(runs.map(run => run.id)) || !unique(tasks.map(task => task.id)) || !unique(dispatches.map(entry => entry.id))) return false
  const runIds = new Set(runs.map(run => run.id))
  if (!tasks.every(task => runIds.has(task.runId))) return false
  for (const entry of dispatches) {
    const task = tasks.find(candidate => candidate.id === entry.taskId)
    if (!task || entry.runId !== task.runId) return false
  }
  // N1 = C14 = R9. The r1 guard only followed the pointer that existed: a Task with
  // `currentDispatchId: null` was accepted however many open attempts pointed back at it, a
  // settled Task could still own a live one, and `deps` were never resolved at all. Each of those
  // is a document the product cannot write and every one of them survives into the next write.
  for (const task of tasks) {
    const open = dispatches.filter(entry => entry.taskId === task.id && entry.status === 'dispatched')
    if (open.length > 1) return false
    const attempt = open[0]
    if (attempt !== undefined) {
      if (task.currentDispatchId !== attempt.id) return false
      if (task.status === 'completed' || task.status === 'failed') return false
    }
    if (!task.deps.every(id => tasks.some(other => other.id === id && other.runId === task.runId))) return false
  }
  return tasks.every(task => {
    if (task.currentDispatchId === null) return true
    const entry = dispatches.find(candidate => candidate.id === task.currentDispatchId)
    return entry !== undefined && entry.taskId === task.id
  })
}

export class OrchestrationStore {
  readonly file: string
  constructor(userData: string) { this.file = path.join(userData, 'runtime/orchestration/state.json') }
  read(): OrchestrationState {
    const loaded = readFile<unknown>(this.file, emptyState)
    if (!isOrchestrationState(loaded)) throw new RuntimeError('storage_corrupt', `Orchestration state is not readable: ${this.file}`, { file: this.file, recovery: 'Inspect the file; corral never rewrites or truncates it on its own' })
    // A binding that points at a run this document does not contain would make every later run
    // resolution answer `run_not_found` for a run the caller never chose. Refuse it as corruption.
    if (loaded.currentRunId !== null && !loaded.runs.some(run => run.id === loaded.currentRunId))
      throw new RuntimeError('storage_corrupt', `Current run ${loaded.currentRunId} is missing from ${this.file}`, { file: this.file })
    return loaded
  }
  write(state: OrchestrationState): void { atomicWrite(this.file, state) }
}
