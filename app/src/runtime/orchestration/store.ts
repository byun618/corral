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
    && (settled ? isStamp(value.settledAt) : value.settledAt === null && value.result === null)
}
function isTarget(value: unknown): boolean {
  return isRecord(value) && isString(value.handle) && isString(value.runtimeId) && isString(value.epoch) && isString(value.ptyId) && isString(value.paneId)
}
function isDispatch(value: unknown): value is DispatchRecord {
  if (!isRecord(value)) return false
  const open = value.status === 'dispatched'
  return isId('ctx', value.id) && isId('run', value.runId) && isId('task', value.taskId)
    && typeof value.attempt === 'number' && value.attempt >= 1 && DISPATCH_STATUSES.some(status => status === value.status)
    && isTarget(value.target) && (value.agent === null || isRecord(value.agent)) && isNullOr(isString, value.agentAbsenceReason)
    && (value.reconcile === null || isRecord(value.reconcile))
    && isStamp(value.createdAt) && isStamp(value.updatedAt) && isVersion(value.version)
    && (open ? value.settledBy === null && value.settledAt === null : isString(value.settledBy) && isStamp(value.settledAt))
}
/**
 * A shape check, not a schema library. It exists so a truncated, foreign or hand-edited document
 * is refused loudly instead of being read as "a profile with no runs" — §4.5's "no partial
 * recovery, no silent reinitialization". A file that is merely absent is a new profile and is not
 * an error; `readFile` already separates those two cases by ENOENT.
 */
export function isOrchestrationState(value: unknown): value is OrchestrationState {
  return isRecord(value) && value.schemaVersion === 1
    && isNullOr(isRunId, value.currentRunId)
    && Array.isArray(value.runs) && value.runs.every(isRun)
    && Array.isArray(value.tasks) && value.tasks.every(isTask)
    && Array.isArray(value.dispatches) && value.dispatches.every(isDispatch)
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
