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
import { RuntimeError, reject, stringFlag, type CommandContext, type CommandModule, type CommandSpec, type Invocation } from '../contracts.js'
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
  if (f.result !== undefined) parseResult(String(f.result))
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

async function observePanes(ctx: CommandContext): Promise<PaneSnapshot> {
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
  return new RuntimeError(error.code, error.message,
    { ...detail, requestId: wrapper.requestId, recovery: 'Retry with the same --request-id, or inspect orchestration run-show / task-list / dispatch-show' },
    error.stage, error.outcome)
}

const preflight = (code: string, message: string, resources?: unknown): never => {
  throw new RuntimeError(code, message, resources, 'preflight', 'not_started')
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
      const observe = async (): Promise<PaneSnapshot> => snapshot ??= await observePanes(ctx)

      /**
       * §4.5. Re-observe every open attempt before the command runs — a superset of the three
       * moments the freeze names (runtime start, backend reconnect, `dispatch-show`), because the
       * first command after any of them passes through here. With no open attempt the backend is
       * not contacted at all, so `run-list` on a profile with no dispatches needs no backend.
       * An unreachable backend writes nothing, so "could not look" never becomes a stored verdict.
       */
      const sweep = async (): Promise<OrchestrationState> => {
        let state = records.read()
        if (!state.dispatches.some(entry => entry.status === 'dispatched')) return state
        const seen = await observe()
        let changed = false
        for (const entry of state.dispatches) {
          if (entry.status !== 'dispatched') continue
          const outcome = applyReconcile(state, entry, observationFor(seen, entry.target), now(), ctx.instanceId)
          state = outcome.state
          changed ||= outcome.changed
        }
        // Not an `onEffect`: this is corral's own re-observation, not the effect the caller asked
        // for. The caller's outcome still describes the caller's command.
        if (changed) records.write(state)
        return state
      }

      const resolveRunId = (state: OrchestrationState): string => {
        const id = flag('run') ?? state.currentRunId
        if (id === null || id === undefined)
          return preflight('run_required', 'No Run is bound to this profile and --run was not given',
            { currentRun: null, recovery: 'corral orchestration run-create --objective <text>, or corral orchestration run-use --id <run>' })
        if (!findRun(state, id)) return preflight('run_not_found', `No run ${id}`, { runId: id, boundRun: state.currentRunId })
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

      const state = await sweep()

      switch (inv.command) {
        case 'orchestration run-create':
          return mutate(async () => {
            const created = createRun(records.read(), need('objective'), now())
            ctx.onEffect?.()
            records.write(created.state)
            return { run: created.run, currentRunId: created.state.currentRunId }
          })
        case 'orchestration run-use':
          return mutate(async () => {
            const fresh = records.read(), id = need('id')
            const run = findRun(fresh, id)
            if (!run) return preflight('run_not_found', `No run ${id}`, { runId: id, boundRun: fresh.currentRunId })
            ctx.onEffect?.()
            records.write({ ...fresh, currentRunId: run.id })
            return { run, currentRunId: run.id }
          })
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
        case 'orchestration task-create':
          return mutate(async () => {
            const fresh = records.read(), runId = resolveRunId(fresh)
            const created = createTask(fresh, { runId, spec: need('spec'), title: flag('title') ?? null, deps: parseDeps(flag('deps') ?? ''), at: now() })
            ctx.onEffect?.()
            records.write(created.state)
            return { run: findRun(created.state, runId) ?? null, task: created.task }
          })
        case 'orchestration task-list': {
          const runId = resolveRunId(state)
          const wanted: TaskStatus | undefined = f.ready ? 'ready' : isTaskStatus(f.status) ? f.status : undefined
          const tasks = state.tasks.filter(task => task.runId === runId && (wanted === undefined || task.status === wanted))
          return { run: findRun(state, runId) ?? null, tasks: tasks.slice(0, limit), totalCount: tasks.length, truncated: tasks.length > limit }
        }
        case 'orchestration task-update':
          return mutate(async () => {
            const fresh = records.read(), runId = resolveRunId(fresh)
            const task = taskInRun(fresh, runId, need('id'))
            const status = need('status')
            if (!isTaskStatus(status)) return preflight('invalid_argument', `--status must be one of ${TASK_STATUSES.join('|')}`)
            const moved = transition(fresh, {
              taskId: task.id, to: status, settledBy: 'task-update', at: now(),
              dispatchId: flag('dispatch'),
              result: f.result === undefined ? undefined : parseResult(need('result')),
              expectedVersion: f['expected-version'] === undefined ? undefined : Number(f['expected-version']),
            })
            ctx.onEffect?.()
            records.write(moved.state)
            return { run: findRun(moved.state, runId) ?? null, task: moved.task, dispatch: moved.dispatch, promoted: moved.promoted }
          })
        case 'orchestration dispatch':
          return mutate(async () => {
            const runId = resolveRunId(records.read())
            // §4.3(1): the terminal module's own three-layer check, borrowed as a read command.
            const resolved = await showTerminal(need('to'))
            const fresh = records.read()
            const task = taskInRun(fresh, runId, need('task'))
            const created = createDispatch(fresh, { task, target: resolved.target, agent: resolved.agent, agentAbsenceReason: resolved.agentAbsenceReason, at: now() })
            ctx.onEffect?.()
            records.write(created.state)
            return { run: findRun(created.state, runId) ?? null, task: created.task, dispatch: created.dispatch, terminal: resolved.terminal }
          })
        case 'orchestration dispatch-show': {
          const entry = f.id === undefined ? latestDispatch(state, need('task')) : findDispatch(state, need('id'))
          if (!entry) return preflight('dispatch_not_found', f.id === undefined ? `No dispatch for task ${need('task')}` : `No dispatch ${need('id')}`,
            { dispatchId: flag('id') ?? null, taskId: flag('task') ?? null })
          const observation = observationFor(await observe(), entry.target)
          const decision = reconcileDecision(observation)
          return {
            dispatch: entry, task: findTask(state, entry.taskId) ?? null,
            terminal: {
              live: decision.live, observed: decision.observed, reason: decision.reason,
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
