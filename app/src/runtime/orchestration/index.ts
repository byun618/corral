/**
 * LIFE-409 — the ten local orchestration commands.
 *
 * This module owns state and identity, nothing else. It starts no process, sends nothing to any
 * pane and knows no wire protocol: the only things it borrows are the terminal module's read
 * commands (for the three-layer handle check) and the adapter's read calls (for re-observation).
 * Worker launch, messages and `worker_done` are LIFE-410, which reuses `transition` from
 * `model.ts` rather than growing a second state machine.
 *
 * Every mutation is: read the one document → call one pure function from `model.ts` → one
 * `atomicWrite`. Every rejection happens before that write, so `_meta.outcome` is `not_started`
 * and the stored bytes are untouched.
 */
import { randomUUID } from 'node:crypto'
import specs from './specs.json'
import { RuntimeError, reject, stringFlag, type CommandModule, type CommandSpec, type Invocation } from '../contracts.js'
import { validateFoundation } from '../registry.js'
import { Receipts, REQUEST_ID } from '../terminal/receipts.js'
import { terminalModule } from '../terminal/index.js'
import { TerminalBackend } from '../../main/adapter/index.js'
import { isRecord, readRecord, readString } from '../../shared/json.js'
import { OrchestrationStore } from './store.js'
import {
  TASK_STATUSES, applyReconcile, createDispatch, createRun, createTask, findDispatch, findRun, findTask,
  isId, isTaskStatus, latestDispatch, reconcileDecision, runCounts, transition,
  type AgentSnapshot, type DispatchTarget, type JsonValue, type OrchestrationState, type PaneObservation, type TaskStatus,
} from './model.js'

export const orchestrationSpecs: CommandSpec[] = specs
export { transition } from './model.js'

/** Same ceiling the terminal commands use for free text, so one limit governs the whole CLI. */
export const MAX_TEXT = 65536
export const MAX_DEPS = 64
const MUTATIONS = new Set(['orchestration run-create', 'orchestration run-use', 'orchestration task-create', 'orchestration task-update', 'orchestration dispatch'])
const REQUIRED: Record<string, string[]> = {
  'orchestration run-create': ['objective'],
  'orchestration run-use': ['id'],
  'orchestration run-show': ['id'],
  'orchestration task-create': ['spec'],
  'orchestration task-update': ['id', 'status'],
  'orchestration dispatch': ['task', 'to'],
}
const TEXT_LIMITS: Record<string, number> = { objective: MAX_TEXT, spec: MAX_TEXT, title: 1024, result: MAX_TEXT, to: 8192 }

function bytes(value: unknown, max: number, name: string): void {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > max) reject(`${name} must be NUL-free UTF-8, at most ${max} bytes`)
}
/** `--deps a,b`. A real array on disk — Orca stores a JSON string there, which is its accident. */
export function parseDeps(value: string): string[] {
  const parts = value.split(',').map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length > MAX_DEPS) reject(`--deps accepts at most ${MAX_DEPS} task ids`)
  for (const part of parts) if (!isId('task', part)) reject(`--deps entries must be task ids (task_<12 hex>): ${part}`)
  if (new Set(parts).size !== parts.length) reject('--deps must not repeat a task id')
  return parts
}
export function parseResult(value: string): JsonValue {
  try { return JSON.parse(value) } catch { return reject('--result must be a JSON document') }
}
/** `--id` means a different record per command; a mistyped kind is caught before any lookup. */
function idKindFor(command: string): 'run' | 'task' | 'ctx' {
  if (command.startsWith('orchestration run-')) return 'run'
  if (command === 'orchestration task-update') return 'task'
  return 'ctx'
}

export function validateOrchestration(inv: Invocation): void {
  validateFoundation(inv)
  const f = inv.flags
  for (const key of REQUIRED[inv.command] ?? []) stringFlag(f, key, true)
  for (const key of ['objective', 'spec', 'title', 'deps', 'result', 'to', 'run', 'id', 'task', 'status', 'dispatch', 'expected-version', 'request-id', 'limit'])
    if (f[key] !== undefined) stringFlag(f, key, true)
  for (const [key, max] of Object.entries(TEXT_LIMITS)) if (f[key] !== undefined) bytes(f[key], max, `--${key}`)
  if (f['request-id'] !== undefined && !REQUEST_ID.test(String(f['request-id']))) reject('--request-id must be r1.<13-digit Unix milliseconds>.<UUID>')
  if (f.run !== undefined && !isId('run', f.run)) reject('--run must be a run id (run_<12 hex>)')
  if (f.task !== undefined && !isId('task', f.task)) reject('--task must be a task id (task_<12 hex>)')
  if (f.dispatch !== undefined && !isId('ctx', f.dispatch)) reject('--dispatch must be a dispatch id (ctx_<12 hex>)')
  if (f.id !== undefined && !isId(idKindFor(inv.command), f.id)) reject(`--id must be a ${idKindFor(inv.command)} id for ${inv.command}`)
  if (f.status !== undefined && !isTaskStatus(f.status)) reject(`--status must be one of ${TASK_STATUSES.join('|')}`)
  if (f.ready && f.status !== undefined && f.status !== 'ready') reject('--ready and --status disagree')
  if (f.deps !== undefined) parseDeps(String(f.deps))
  if (f.result !== undefined) {
    parseResult(String(f.result))
    // C5: `--result` is stored only by `completed|failed`. Silently dropping it on any other
    // transition let a caller believe a record was kept, so it is refused before anything runs.
    if (inv.command !== 'orchestration task-update' || (f.status !== 'completed' && f.status !== 'failed'))
      reject('--result belongs to task-update --status completed|failed')
  }
  if (f['expected-version'] !== undefined && (!/^\d+$/.test(String(f['expected-version'])) || Number(f['expected-version']) < 1)) reject('--expected-version must be a positive integer')
  if (f.limit !== undefined && (!/^\d+$/.test(String(f.limit)) || Number(f.limit) < 1 || Number(f.limit) > 10000)) reject('--limit must be 1..10000')
  if (inv.command === 'orchestration dispatch-show' && (f.id === undefined) === (f.task === undefined)) reject('dispatch-show requires exactly one of --id or --task')
  if (inv.command === 'orchestration task-update' && f.status === 'dispatched') throw new RuntimeError('illegal_transition', 'Only orchestration dispatch may move a Task to dispatched', { to: 'dispatched', recovery: 'corral orchestration dispatch --task <task> --to <terminal>' }, 'preflight', 'not_started')
}

// --- observation --------------------------------------------------------------------------------

/**
 * One look at the backend, shared by the pre-command sweep and by `dispatch-show` in the same call.
 *
 * `terminal show` cannot be used here: it folds "pane gone", "PTY replaced" and "another backend
 * generation" into one `stale_terminal`, and §4.5 has to tell those three apart and to distinguish
 * all of them from "could not look". These are the same two read calls the terminal module's own
 * `resolve()` makes, and neither sends anything to a pane.
 */
export type PaneSnapshot =
  | { observed: true; epoch: string; panes: { paneId: string; ptyId: string }[] }
  | { observed: false; reason: 'backend_unavailable' | 'observation_failed'; detail: string | null }

/**
 * How long corral's own re-observation may take, whatever the caller's timeout is (C3). A sweep is
 * housekeeping the caller did not ask for: a backend that accepts the connection and then says
 * nothing must not turn `run-list` into a ten-second `outcome_unknown`. Exceeding it is an
 * unobserved pass — §4.5's "could not look", which writes nothing.
 */
export const SWEEP_BUDGET_MS = 2000
export interface ObservationBudget { signal: AbortSignal; deadlineAt: number }
const budgeted = (ctx: ObservationBudget, ms: number): ObservationBudget => {
  // Never more than half of what the caller has left: with `--timeout-ms 1000` a full 2 s sweep
  // would eat the deadline and the command would answer `outcome_unknown` — the very failure this
  // budget exists to prevent, just at a smaller scale.
  const share = Math.max(250, Math.floor((ctx.deadlineAt - Date.now()) / 2))
  return { signal: ctx.signal, deadlineAt: Date.now() + Math.min(ms, share) }
}

async function observePanes(ctx: ObservationBudget): Promise<PaneSnapshot> {
  const socket = process.env.CORRAL_BACKEND_SOCKET
  if (!socket) return { observed: false, reason: 'backend_unavailable', detail: 'Profile has no configured terminal backend' }
  try {
    const backend = new TerminalBackend(socket)
    const epoch = await backend.epoch(ctx)
    const panes = await backend.list(epoch, ctx)
    return { observed: true, epoch, panes: panes.map(pane => ({ paneId: pane.paneId, ptyId: pane.ptyId })) }
  } catch (error) {
    return { observed: false, reason: 'observation_failed', detail: error instanceof Error ? error.message : String(error) }
  }
}
export function observationFor(snapshot: PaneSnapshot, target: DispatchTarget): PaneObservation {
  if (!snapshot.observed) return { kind: 'unobserved', reason: snapshot.reason, detail: snapshot.detail }
  if (snapshot.epoch !== target.epoch) return { kind: 'epoch_changed', observedEpoch: snapshot.epoch }
  const pane = snapshot.panes.find(entry => entry.paneId === target.paneId)
  if (!pane) return { kind: 'pane_gone' }
  if (pane.ptyId !== target.ptyId) return { kind: 'pty_replaced', observedPtyId: pane.ptyId }
  return { kind: 'live' }
}

/** The identity half of `terminal show`'s agent block. Screen excerpts and evidence are not kept. */
function snapshotAgent(block: Record<string, unknown>): AgentSnapshot {
  const evidence = readRecord(block, 'evidence')
  const argv = Array.isArray(block.argv) ? block.argv.filter((entry): entry is string => typeof entry === 'string') : null
  return {
    kind: readString(block, 'kind'), name: readString(block, 'name'), phase: readString(block, 'phase'),
    requestedModel: readString(block, 'requestedModel'), requestedEffort: readString(block, 'requestedEffort'), requestedAdvisor: readString(block, 'requestedAdvisor'),
    resolvedModel: readString(block, 'resolvedModel'), resolvedAdvisor: readString(block, 'resolvedAdvisor'),
    argv, sessionId: readString(block, 'sessionId'), sessionIdSource: readString(block, 'sessionIdSource'),
    observedAt: (evidence === null ? null : readString(evidence, 'observedAt')) ?? new Date().toISOString(),
  }
}

/**
 * `Receipts` wraps a failure from the body as `{ requestId, terminal, recovery, detail }`, which is
 * right for the terminal commands that own it. Flatten it back so `task_not_startable` keeps
 * `unmetDependencies` at the top of `resources` and the recovery names orchestration commands. The
 * code, stage and outcome are carried through untouched — only the envelope is rewritten.
 */
function flattenReceiptError(error: unknown): unknown {
  if (!(error instanceof RuntimeError) || !isRecord(error.resources) || !('requestId' in error.resources)) return error
  const wrapper = error.resources
  const detail = isRecord(wrapper.detail) ? wrapper.detail : {}
  // R7 = C1: the inner error's own recovery is the one that names what to do — `terminal list` for
  // a stale handle, `run-create` for a missing Run. Only an error that carries none gets the
  // receipt's generic advice, and even then only because retrying really is the next step.
  const recovery = typeof detail.recovery === 'string' ? detail.recovery
    : 'Retry with the same --request-id, or inspect orchestration run-show / task-list / dispatch-show'
  return new RuntimeError(error.code, error.message,
    { ...detail, requestId: wrapper.requestId, recovery }, error.stage, error.outcome)
}

const preflight = (code: string, message: string, resources?: unknown): never => {
  throw new RuntimeError(code, message, resources, 'preflight', 'not_started')
}

/**
 * §4.5's re-observation, as a pure-ish pass: one look at the backend, applied to every open attempt.
 * The returned document is *not* written here — the caller decides when it is durable (R2), which
 * is what keeps a rejected command from leaving bytes behind.
 */
async function reconcilePass(state: OrchestrationState, ctx: ObservationBudget, instanceId: string, seen?: PaneSnapshot): Promise<{ state: OrchestrationState; changed: boolean; snapshot: PaneSnapshot | null }> {
  if (!state.dispatches.some(entry => entry.status === 'dispatched')) return { state, changed: false, snapshot: seen ?? null }
  const snapshot = seen ?? await observePanes(budgeted(ctx, SWEEP_BUDGET_MS))
  let next = state, changed = false
  const at = new Date().toISOString()
  for (const entry of state.dispatches) {
    if (entry.status !== 'dispatched') continue
    const outcome = applyReconcile(next, entry, observationFor(snapshot, entry.target), at, instanceId)
    next = outcome.state
    changed ||= outcome.changed
  }
  return { state: next, changed, snapshot }
}

/**
 * R5 (1차 판정 계약 해석 2). The reconcile the freeze asks for at runtime start, run once by
 * `server.ts` as the runtime becomes ready — so a pane that died while corral was not running is
 * `unknown` on disk without anyone having to issue a command first. A backend corral cannot reach
 * writes nothing, exactly as §4.5 says, and a document it cannot read is left alone: startup is not
 * the place to turn corruption into an exit code.
 *
 * There is no "backend reconnect" event to hook: this runtime holds no backend connection
 * (`ownership: external, lifecycle: independent`, one connection per call), so the first command
 * after a reconnect is where that moment is observed.
 */
export async function orchestrationStartupSweep(userData: string, ctx: { instanceId: string; signal: AbortSignal }): Promise<{ swept: boolean; changed: boolean; reason: string | null }> {
  const store = new OrchestrationStore(userData)
  let state: OrchestrationState
  try { state = store.read() } catch (error) { return { swept: false, changed: false, reason: error instanceof RuntimeError ? error.code : 'unreadable' } }
  if (!state.dispatches.some(entry => entry.status === 'dispatched')) return { swept: false, changed: false, reason: 'no_open_attempt' }
  try {
    const pass = await reconcilePass(state, { signal: ctx.signal, deadlineAt: Date.now() + SWEEP_BUDGET_MS }, ctx.instanceId)
    if (pass.changed) store.write(pass.state)
    return { swept: true, changed: pass.changed, reason: pass.snapshot?.observed === false ? pass.snapshot.reason : null }
  } catch (error) { return { swept: false, changed: false, reason: error instanceof Error ? error.message : String(error) } }
}

export function orchestrationModule(userData: string): CommandModule {
  const startedAt = Date.now()
  // Built on first use, never in the factory: `cli.ts` constructs every module for every
  // invocation, `--help` included, and none of those may touch the profile directory.
  let store: OrchestrationStore | undefined
  let receipts: Receipts | undefined
  let terminalReads: CommandModule | undefined
  return {
    specs: orchestrationSpecs,
    validate: validateOrchestration,
    tracksEffects: true,
    isMutation: inv => MUTATIONS.has(inv.command),
    /**
     * Reads take the lane too. Reconcile writes from read paths (`dispatch-show`, and the sweep
     * that runs before every command), so a read outside the lane could lose a concurrent
     * mutation's update to the single document.
     */
    serialKey: () => 'orchestration',
    async execute(original, ctx) {
      const inv: Invocation = { ...original, flags: { ...original.flags } }, f = inv.flags
      store ??= new OrchestrationStore(userData)
      receipts ??= new Receipts(userData, startedAt)
      const records = store, log = receipts
      const flag = (name: string) => stringFlag(f, name)
      const need = (name: string) => stringFlag(f, name, true)!
      const now = () => new Date().toISOString()
      const limit = Number(f.limit ?? 100)

      let snapshot: PaneSnapshot | undefined
      const observe = async (): Promise<PaneSnapshot> => snapshot ??= await observePanes(budgeted(ctx, SWEEP_BUDGET_MS))

      const resolveRunId = (state: OrchestrationState): string => {
        const id = flag('run') ?? state.currentRunId
        if (id === null || id === undefined)
          return preflight('run_required', 'No Run is bound to this profile and --run was not given',
            { currentRun: null, recovery: 'corral orchestration run-create --objective <text>, or corral orchestration run-use --id <run>' })
        if (!findRun(state, id)) return preflight('run_not_found', `No run ${id}`, { runId: id, boundRun: state.currentRunId, recovery: 'corral orchestration run-list, then run-use --id <run> or --run <run>' })
        return id
      }
      const taskInRun = (state: OrchestrationState, runId: string, id: string) => {
        const task = findTask(state, id)
        if (!task || task.runId !== runId) return preflight('task_not_found', `No task ${id} in run ${runId}`, { taskId: id, runId })
        return task
      }
      const showTerminal = async (handle: string) => {
        terminalReads ??= terminalModule(userData)
        const child: Invocation = { command: 'terminal show', flags: { terminal: handle }, args: [], cwd: inv.cwd }
        terminalReads.validate(child)
        const shown = await terminalReads.execute(child, ctx)
        const terminal = isRecord(shown) ? readRecord(shown, 'terminal') : null
        const epoch = terminal === null ? null : readString(terminal, 'epoch')
        const ptyId = terminal === null ? null : readString(terminal, 'ptyId')
        const paneId = terminal === null ? null : readString(terminal, 'paneId')
        if (terminal === null || epoch === null || ptyId === null || paneId === null)
          return preflight('operation_failed', 'terminal show did not report a target identity', { terminal: handle })
        const block = isRecord(shown) ? readRecord(shown, 'agent') : null
        return {
          target: { handle, runtimeId: ctx.runtimeId, epoch, ptyId, paneId },
          agent: block === null ? null : snapshotAgent(block),
          agentAbsenceReason: block === null ? 'no_managed_agent' : null,
          terminal,
        }
      }
      const mutate = async (body: () => Promise<Record<string, unknown>>): Promise<unknown> => {
        f['request-id'] ??= `r1.${Date.now()}.${randomUUID()}`
        try { return await log.run(inv, body) } catch (error) { throw flattenReceiptError(error) }
      }

      /**
       * §4.5, and R2. Every command re-observes the open attempts first, but the result is only
       * *computed* here. A read persists it (that is the `dispatch-show` moment the freeze names);
       * a mutation carries it into its own `atomicWrite`, so an accepted mutation still costs one
       * rename and a **rejected** one leaves the stored bytes byte-identical. Runtime start has its
       * own pass in `server.ts` (R5). With no open attempt the backend is not contacted at all.
       */
      const mutating = MUTATIONS.has(inv.command)
      const before = records.read()
      const pass = await reconcilePass(before, ctx, ctx.instanceId)
      if (pass.snapshot) snapshot ??= pass.snapshot
      const state = pass.state
      // Not an `onEffect`: corral's own re-observation is not the effect the caller asked for.
      if (pass.changed && !mutating) records.write(state)

      switch (inv.command) {
        case 'orchestration run-create':
          return mutate(async () => {
            const created = createRun(state, need('objective'), now())
            ctx.onEffect?.()
            records.write(created.state)
            return { run: created.run, currentRunId: created.state.currentRunId }
          })
        case 'orchestration run-use': {
          // R7: resolving the target happens outside the receipt, like the terminal module's own
          // preflight — a rejection that never reached the body must not leave a pending receipt.
          const id = need('id')
          if (!findRun(state, id)) return preflight('run_not_found', `No run ${id}`, { runId: id, boundRun: state.currentRunId, recovery: 'corral orchestration run-list, then run-use --id <run>' })
          return mutate(async () => {
            const run = findRun(state, id)
            if (!run) return preflight('run_not_found', `No run ${id}`, { runId: id, boundRun: state.currentRunId })
            ctx.onEffect?.()
            records.write({ ...state, currentRunId: run.id })
            return { run, currentRunId: run.id }
          })
        }
        case 'orchestration run-current':
          return { run: state.currentRunId === null ? null : findRun(state, state.currentRunId) ?? null }
        case 'orchestration run-list': {
          const runs = [...state.runs].reverse()
          return { runs: runs.slice(0, limit), totalCount: runs.length, truncated: runs.length > limit }
        }
        case 'orchestration run-show': {
          const id = need('id'), run = findRun(state, id)
          if (!run) return preflight('run_not_found', `No run ${id}`, { runId: id, boundRun: state.currentRunId })
          return { run, counts: runCounts(state, run.id) }
        }
        case 'orchestration task-create': {
          const runId = resolveRunId(state)
          return mutate(async () => {
            const created = createTask(state, { runId, spec: need('spec'), title: flag('title') ?? null, deps: parseDeps(flag('deps') ?? ''), at: now() })
            ctx.onEffect?.()
            records.write(created.state)
            return { run: findRun(created.state, runId) ?? null, task: created.task }
          })
        }
        case 'orchestration task-list': {
          const runId = resolveRunId(state)
          const wanted: TaskStatus | undefined = f.ready ? 'ready' : isTaskStatus(f.status) ? f.status : undefined
          const tasks = state.tasks.filter(task => task.runId === runId && (wanted === undefined || task.status === wanted))
          return { run: findRun(state, runId) ?? null, tasks: tasks.slice(0, limit), totalCount: tasks.length, truncated: tasks.length > limit }
        }
        case 'orchestration task-update': {
          const runId = resolveRunId(state)
          return mutate(async () => {
            const task = taskInRun(state, runId, need('id'))
            const status = need('status')
            if (!isTaskStatus(status)) return preflight('invalid_argument', `--status must be one of ${TASK_STATUSES.join('|')}`)
            const moved = transition(state, {
              taskId: task.id, to: status, settledBy: 'task-update', at: now(),
              dispatchId: flag('dispatch'),
              result: f.result === undefined ? undefined : parseResult(need('result')),
              expectedVersion: f['expected-version'] === undefined ? undefined : Number(f['expected-version']),
            })
            ctx.onEffect?.()
            records.write(moved.state)
            return { run: findRun(moved.state, runId) ?? null, task: moved.task, dispatch: moved.dispatch, promoted: moved.promoted }
          })
        }
        case 'orchestration dispatch': {
          const runId = resolveRunId(state)
          return mutate(async () => {
            // §4.3(1): the terminal module's own three-layer check, borrowed as a read command.
            const resolved = await showTerminal(need('to'))
            const task = taskInRun(state, runId, need('task'))
            const created = createDispatch(state, { task, target: resolved.target, agent: resolved.agent, agentAbsenceReason: resolved.agentAbsenceReason, at: now() })
            ctx.onEffect?.()
            records.write(created.state)
            return { run: findRun(created.state, runId) ?? null, task: created.task, dispatch: created.dispatch, terminal: resolved.terminal }
          })
        }
        case 'orchestration dispatch-show': {
          const entry = f.id === undefined ? latestDispatch(state, need('task')) : findDispatch(state, need('id'))
          if (!entry) return preflight('dispatch_not_found', f.id === undefined ? `No dispatch for task ${need('task')}` : `No dispatch ${need('id')}`,
            { dispatchId: flag('id') ?? null, taskId: flag('task') ?? null })
          const task = findTask(state, entry.taskId) ?? null
          // C11: an attempt that was *already* settled when this call started is history. Whether
          // its pane happens to be alive now says nothing about it, so the answer comes from the
          // stored reconcile and the backend is not contacted at all — `live: null` means "not
          // observed", never "observed and gone". An attempt that was still open is observed, and
          // that observation is reported even when it is the one that just settled it.
          if (findDispatch(before, entry.id)?.status !== 'dispatched') return {
            dispatch: entry, task,
            terminal: {
              live: null, observed: false, source: 'record', reason: entry.reconcile?.reason ?? null,
              observedAt: entry.reconcile?.at ?? null, runtimeInstanceId: entry.reconcile?.runtimeInstanceId ?? null, detail: null,
            },
          }
          const observation = observationFor(await observe(), entry.target)
          const decision = reconcileDecision(observation)
          return {
            dispatch: entry, task,
            terminal: {
              live: decision.live, observed: decision.observed, source: 'observation', reason: decision.reason,
              observedAt: now(), runtimeInstanceId: ctx.instanceId,
              detail: observation.kind === 'unobserved' ? observation.detail : null,
            },
          }
        }
        default:
          throw new RuntimeError('unsupported', `Unknown orchestration command ${inv.command}`)
      }
    },
  }
}
