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
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import specs from './specs.json'
import { RuntimeError, reject, stringFlag, type CallerIdentity, type CommandModule, type CommandSpec, type Invocation } from '../contracts.js'
import { validateFoundation } from '../registry.js'
import { type Receipt, Receipts, REQUEST_ID, RECEIPT_TTL, readReceipt } from '../terminal/receipts.js'
import { MAX_INPUT, derivedRequestId, stageFailure, terminalModule, type Stage } from '../terminal/index.js'
import { PROMPT_LEAD } from '../terminal/agent.js'
import { socketPath } from '../transport.js'
import { TerminalBackend } from '../../main/adapter/index.js'
import { isRecord, readNumber, readRecord, readString } from '../../shared/json.js'
import { OrchestrationStore } from './store.js'
import {
  DISPATCH_STATUSES, TASK_STATUSES, activeDispatch, applyReconcile, createDispatch, createRun, createTask, findDispatch, findRun, findTask,
  isDispatchStatus, isId, isTaskStatus, latestDispatch, reconcileDecision, runCounts, startability, transition,
  type AgentSnapshot, type DispatchRecord, type DispatchTarget, type JsonValue, type OrchestrationState,
  type PaneObservation, type TaskRecord, type TaskStatus,
} from './model.js'
import {
  DELIVERABLE_TYPES, DELIVERY_ID, MAX_SUBJECT, MESSAGE_ID, MESSAGE_TYPES, acknowledgeDelivery, answerOf, answerQuestion,
  appendMessage, findMessage, isMessageType, isWorkerMessageType, openDelivery, outstandingDelivery, parseTypes, pendingBatch, runMessages,
  type MessageOrigin, type MessageRecord, type MessageType,
} from './messages.js'
import {
  activePaneDispatch, composeBody, emptyWorker, isRetainReason, paneOwner, preambleDigest, releaseDecision, replaceDispatchRecord,
  resumeDecision, senderError, stopDecision, submissionVerdict, verifySender, withWorker,
  type SenderClaim, type SubmissionVerdict,
} from './worker.js'

export const orchestrationSpecs: CommandSpec[] = specs
export { transition } from './model.js'

/** Same ceiling the terminal commands use for free text, so one limit governs the whole CLI. */
export const MAX_TEXT = 65536
export const MAX_DEPS = 64
const MUTATIONS = new Set([
  'orchestration run-create', 'orchestration run-use', 'orchestration task-create', 'orchestration task-update', 'orchestration dispatch',
  // LIFE-410. `check` is here because it opens and acknowledges Deliveries; `ask` because it stores
  // the question before it waits. Both are mutations that happen to block afterwards.
  'orchestration worker-start', 'orchestration send', 'orchestration ask', 'orchestration reply', 'orchestration check',
  'orchestration worker-retain', 'orchestration worker-release', 'orchestration worker-stop', 'orchestration worker-abandon',
])
const REQUIRED: Record<string, string[]> = {
  'orchestration run-create': ['objective'],
  'orchestration run-use': ['id'],
  'orchestration run-show': ['id'],
  'orchestration task-create': ['spec'],
  'orchestration task-update': ['id', 'status'],
  'orchestration dispatch': ['task', 'to'],
  'orchestration worker-start': ['task'],
  'orchestration send': ['type', 'subject'],
  'orchestration reply': ['id', 'body'],
  'orchestration request-show': ['id'],
  'orchestration worker-read': ['dispatch'],
  'orchestration worker-retain': ['dispatch'],
  'orchestration worker-release': ['dispatch'],
  'orchestration worker-stop': ['dispatch'],
  'orchestration worker-abandon': ['dispatch'],
}
const TEXT_LIMITS: Record<string, number> = {
  objective: MAX_TEXT, spec: MAX_TEXT, title: 1024, result: MAX_TEXT, to: 8192,
  subject: MAX_SUBJECT, body: MAX_TEXT, question: MAX_TEXT, payload: MAX_TEXT, options: MAX_TEXT,
  'files-modified': 8192, 'report-path': 4096, phase: 256,
}

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
type IdShape = 'run' | 'task' | 'ctx' | 'msg' | 'request'
function idKindFor(command: string): IdShape {
  if (command.startsWith('orchestration run-')) return 'run'
  if (command === 'orchestration task-update') return 'task'
  // LIFE-410: `reply --id` names a message and `request-show --id` names a receipt, so the shape
  // check has to ask the command rather than assume every `--id` is a Dispatch.
  if (command === 'orchestration reply') return 'msg'
  if (command === 'orchestration request-show') return 'request'
  return 'ctx'
}
function idShapeOk(shape: IdShape, value: string): boolean {
  switch (shape) {
    case 'msg': return MESSAGE_ID.test(value)
    case 'request': return REQUEST_ID.test(value)
    default: return isId(shape, value)
  }
}
const ID_SHAPE_TEXT: Readonly<Record<IdShape, string>> = {
  run: 'run id (run_<12 hex>)', task: 'task id (task_<12 hex>)', ctx: 'dispatch id (ctx_<12 hex>)',
  msg: 'message id (msg_<12 hex>)', request: 'request id (r1.<13-digit Unix milliseconds>.<UUID>)',
}

/**
 * POSIX single-quoting for one word of a command line. The preamble and the ask's resume line are
 * commands a worker copies into a shell, and every one of their three variable parts — the node
 * binary, the CLI entry, the socket — lives under a profile directory a user may well have put a
 * space in. Quoting the whole string once would not do: only the parts corral substitutes are
 * data, and the flags between them have to stay syntax.
 */
const shellQuote = (value: string): string => `'${value.split("'").join("'\\''")}'`

/**
 * LIFE-410's own argument rules. They are all shape and pairing — nothing here reads the document,
 * so every one of them is refused before a receipt exists and leaves the stored bytes untouched.
 */
function validateWorkerFlags(inv: Invocation): void {
  const f = inv.flags
  const command = inv.command
  if (f['task-id'] !== undefined && !isId('task', f['task-id'])) reject('--task-id must be a task id (task_<12 hex>)')
  if (f['dispatch-id'] !== undefined && !isId('ctx', f['dispatch-id'])) reject('--dispatch-id must be a dispatch id (ctx_<12 hex>)')
  if (f.resume !== undefined && !MESSAGE_ID.test(String(f.resume))) reject('--resume must be a message id (msg_<12 hex>)')
  if (f.ack !== undefined && !DELIVERY_ID.test(String(f.ack))) reject('--ack must be a delivery id (delivery_<12 hex>)')
  if (f.types !== undefined) parseTypes(String(f.types))
  if (f.payload !== undefined) {
    const parsed = parseResult(String(f.payload))
    if (!isRecord(parsed)) reject('--payload must be a JSON object')
  }
  if (command === 'orchestration send') {
    if (!isWorkerMessageType(f.type)) reject('--type must be worker_done, heartbeat, escalation or status')
    const worker = f.type !== 'status'
    if (worker && (f['task-id'] === undefined || f['dispatch-id'] === undefined))
      reject('--task-id and --dispatch-id are required for worker_done, heartbeat and escalation')
    if (!worker && (f['task-id'] === undefined) !== (f['dispatch-id'] === undefined))
      reject('--type status takes both --task-id and --dispatch-id, or neither')
    if (f.type === 'worker_done') {
      if (f.outcome !== 'succeeded' && f.outcome !== 'failed') reject('--outcome must be succeeded or failed for --type worker_done')
    } else if (f.outcome !== undefined) reject('--outcome belongs to --type worker_done')
  } else if (f.type !== undefined && command !== 'orchestration inbox') reject('--type belongs to send and inbox')
  if (command === 'orchestration inbox' && f.type !== undefined && !isMessageType(f.type))
    reject(`--type must be one of ${MESSAGE_TYPES.join('|')}`)
  if (command === 'orchestration ask') {
    if ((f.question === undefined) === (f.resume === undefined)) reject('ask requires exactly one of --question or --resume')
    if (f['task-id'] === undefined || f['dispatch-id'] === undefined) reject('--task-id and --dispatch-id are required for ask')
    if (f.options !== undefined && f.resume !== undefined) reject('--options belongs to a new question, not to --resume')
  }
  if (command === 'orchestration worker-start') {
    if ((f.terminal === undefined) === (f.agent === undefined)) reject('worker-start requires exactly one of --terminal or --agent')
    if (f.agent !== undefined) {
      if (!['claude', 'codex', 'grok'].includes(String(f.agent))) reject('--agent must be claude, codex or grok')
      if (f.worktree === undefined) reject('--agent requires --worktree')
      if (f.advisor !== undefined && f.agent !== 'claude') reject('--advisor applies to --agent claude only')
    } else for (const key of ['model', 'effort', 'advisor', 'worktree'])
      // §4.2: a reused pane already resolved its model. Accepting the flag would record a request
      // that never reached a provider, which is the confusion the agent snapshot exists to prevent.
      if (f[key] !== undefined) reject(`--${key} belongs to worker-start --agent; a reused terminal keeps the agent it was started with`)
  } else for (const key of ['agent', 'model', 'effort', 'advisor', 'spec-file', 'terminal', 'worktree'])
    if (f[key] !== undefined) reject(`--${key} applies to worker-start only`)
  if (command === 'orchestration worker-retain' && f.reason !== undefined && !isRetainReason(f.reason))
    reject('--reason must be user_requested or user_takeover')
  if (command !== 'orchestration worker-retain' && f.reason !== undefined) reject('--reason applies to worker-retain only')
  if (command === 'orchestration worker-show' && (f.dispatch === undefined) === (f.task === undefined))
    reject('worker-show requires exactly one of --dispatch or --task')
  if (f.screen && f.cursor !== undefined) reject('--screen and --cursor are mutually exclusive')
}

export function validateOrchestration(inv: Invocation): void {
  validateFoundation(inv)
  const f = inv.flags
  for (const key of REQUIRED[inv.command] ?? []) stringFlag(f, key, true)
  for (const key of ['objective', 'spec', 'title', 'deps', 'result', 'to', 'run', 'id', 'task', 'status', 'dispatch', 'expected-version', 'request-id', 'limit',
    'type', 'types', 'subject', 'body', 'payload', 'question', 'options', 'resume', 'ack', 'outcome', 'phase', 'files-modified', 'report-path',
    'task-id', 'dispatch-id', 'terminal', 'agent', 'model', 'effort', 'advisor', 'worktree', 'spec-file', 'reason', 'cursor'])
    if (f[key] !== undefined) stringFlag(f, key, true)
  for (const [key, max] of Object.entries(TEXT_LIMITS)) if (f[key] !== undefined) bytes(f[key], max, `--${key}`)
  if (f['request-id'] !== undefined && !REQUEST_ID.test(String(f['request-id']))) reject('--request-id must be r1.<13-digit Unix milliseconds>.<UUID>')
  if (f.run !== undefined && !isId('run', f.run)) reject('--run must be a run id (run_<12 hex>)')
  if (f.task !== undefined && !isId('task', f.task)) reject('--task must be a task id (task_<12 hex>)')
  if (f.dispatch !== undefined && !isId('ctx', f.dispatch)) reject('--dispatch must be a dispatch id (ctx_<12 hex>)')
  if (f.id !== undefined && !idShapeOk(idKindFor(inv.command), String(f.id))) reject(`--id must be a ${ID_SHAPE_TEXT[idKindFor(inv.command)]} for ${inv.command}`)
  validateWorkerFlags(inv)
  // `worker-list --status` filters Dispatch status, and the two vocabularies only look alike:
  // `ready`/`blocked` are Task words no attempt ever takes, and `dispatched`/`unknown` are attempt
  // words no Task carries. Judging both by the Task set accepted four words that can never match a
  // row — a silent empty list — and refused the two that can.
  if (f.status !== undefined) {
    if (inv.command === 'orchestration worker-list') { if (!isDispatchStatus(f.status)) reject(`--status must be one of ${DISPATCH_STATUSES.join('|')}`) }
    else if (!isTaskStatus(f.status)) reject(`--status must be one of ${TASK_STATUSES.join('|')}`)
  }
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
  // M3 = R16 = C24: only a command that is actually going to run may cut the startup sweep short.
  // In r2 this was the first line of the function, so a command rejected here — a typo in a flag —
  // still ended the one-shot pass, and the pane that died while corral was down stayed `dispatched`
  // until the next real command. The sweep is cut for the *lane*, and a rejected command never
  // reaches the lane.
  startupSweep?.abort()
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
/**
 * Below this a look is not worth taking: a backend that answers at all answers in single-digit
 * milliseconds, and a window this small can only end in "could not look" — after spending the time
 * the caller needed for an answer. N2 = R10: in r1 this was a *floor* on the share, so with less
 * than 250 ms left the observation claimed more time than the command had.
 */
const OBSERVATION_FLOOR_MS = 250
export interface ObservationBudget { signal: AbortSignal; deadlineAt: number }
export const budgeted = (ctx: ObservationBudget, ms: number): ObservationBudget | null => {
  // Never more than half of what the caller has left, and never at all below the floor: with
  // `--timeout-ms 1000` a full 2 s sweep would eat the deadline and the command would answer
  // `outcome_unknown` — the very failure this budget exists to prevent, just at a smaller scale.
  const share = Math.floor((ctx.deadlineAt - Date.now()) / 2)
  if (share < OBSERVATION_FLOOR_MS) return null
  return { signal: ctx.signal, deadlineAt: Date.now() + Math.min(ms, share) }
}

async function observePanes(ctx: ObservationBudget | null): Promise<PaneSnapshot> {
  if (ctx === null) return { observed: false, reason: 'observation_failed', detail: 'Not enough of the caller timeout left to observe the panes' }
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
/**
 * M1 = R14 = C20: what the caller must do next differs by outcome, and in r2 one sentence answered
 * for both. `not_started` really is spent-and-fix-the-input. `unknown` is the opposite instruction:
 * the mutation may already be on disk, so sending the same input again — under any id — is how a
 * duplicate Task gets made. The coordinator's probe followed the r2 advice literally and got two.
 */
const SPENT_RECOVERY = 'This --request-id is spent: fix the input and send a new --request-id, then inspect orchestration run-show / task-list / dispatch-show'
const UNKNOWN_RECOVERY = 'This request may already have taken effect: inspect corral orchestration run-show / task-list / dispatch-show first, and do not send the same input again — that is how a duplicate record is created'

export function flattenReceiptError(error: unknown): unknown {
  if (!(error instanceof RuntimeError) || !isRecord(error.resources) || !('requestId' in error.resources)) return error
  const wrapper = error.resources
  // M1: `requestId` alone does not mean "wrapped body failure" — `receipts.ts` puts it on the
  // errors it raises itself (`outcome_unknown`, `request_conflict`, `request_expired`) too, and
  // those carry their own `recovery` and no `detail` at all. Only the body wrapper sets `detail`
  // (to `undefined` when the inner error was not a RuntimeError), so that key is the discriminator.
  const wrapped = 'detail' in wrapper
  const detail = isRecord(wrapper.detail) ? wrapper.detail : {}
  // R7 = C1: the inner error's own recovery is the one that names what to do — `terminal list` for
  // a stale handle, `run-create` for a missing Run. Only an error that carries none gets generic
  // advice, and which generic advice depends on the outcome, never on the code.
  // N3 = C13: "retry with the same id" is only true for a request that may have taken effect. A
  // rejection that reaches this line was admitted and its receipt is spent, so retrying that id
  // answers `outcome_unknown` forever. Every rejection this module can foresee is raised before
  // the receipt exists (see `admitted` below); anything that still lands here says so plainly.
  const inner = typeof detail.recovery === 'string' ? detail.recovery : null
  const own = !wrapped && typeof wrapper.recovery === 'string' ? wrapper.recovery : null
  const recovery = error.outcome === 'unknown' ? UNKNOWN_RECOVERY : inner ?? own ?? SPENT_RECOVERY
  return new RuntimeError(error.code, error.message,
    { ...detail, requestId: wrapper.requestId, recovery }, error.stage, error.outcome)
}

/**
 * The startup sweep holds the orchestration lane while it looks (R5), and a command queued behind
 * it waits — which is how a short `--timeout-ms` read died at the client deadline without ever
 * running (N2 = R10). The command re-observes anyway, so as soon as one arrives the sweep stops
 * looking and releases the lane; `validateOrchestration` runs before the lane, which is what makes
 * this reachable at all.
 */
let startupSweep: AbortController | null = null

/**
 * LIFE-410 §4.6 — the orchestration lane, moved into the module.
 *
 * Until r0 of this task the runtime's own lane map serialized *every* orchestration command,
 * reads included, because reconcile writes from read paths. That is still the rule, but the unit
 * it applies to has to be smaller now: a coordinator blocked in `check --block` for ten minutes
 * would otherwise hold the lane the worker's `worker_done` needs, and the two would wait on each
 * other until the deadline. So the module declares no `serialKey` and takes this lane itself,
 * around each read-compute-write of the single document — including the ones a waiting command
 * makes between polls, and including the runtime-start sweep, which runs in the same process.
 *
 * Nothing external is awaited while it is held: `worker-start` drops it around `terminal create`
 * and `terminal prompt` and takes it again for each write, so a launch that takes a minute never
 * blocks a report. The cost is that its plan is re-checked when it comes back, which is why
 * `createDispatch` decides startability again inside the write step rather than trusting the plan.
 */
let documentLane: Promise<unknown> = Promise.resolve()
export function withDocumentLane<T>(body: () => Promise<T>): Promise<T> {
  const next = documentLane.catch(() => {}).then(body)
  documentLane = next.catch(() => {})
  return next
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
  // N2: the first command to arrive cuts this short — it will re-observe under its own deadline,
  // and holding the lane behind a backend that never answers is what made a short `--timeout-ms`
  // read fail before it ran.
  const yielded = new AbortController()
  const relay = () => yielded.abort()
  ctx.signal.addEventListener('abort', relay, { once: true })
  // K5: a listener added to an already-aborted signal never fires, so relay alone would let the
  // sweep run on after its caller gave up. No product path reaches this today (`server.ts` passes a
  // fresh controller) — it costs one line to stop that from depending on the caller.
  if (ctx.signal.aborted) yielded.abort()
  startupSweep = yielded
  try {
    return await withDocumentLane(async () => {
      // Re-read inside the lane: between the readability probe above and this point a command may
      // already have written, and sweeping a stale document would undo it.
      const current = store.read()
      const pass = await reconcilePass(current, { signal: yielded.signal, deadlineAt: Date.now() + SWEEP_BUDGET_MS }, ctx.instanceId)
      if (pass.changed) store.write(pass.state)
      return { swept: true, changed: pass.changed, reason: pass.snapshot?.observed === false ? pass.snapshot.reason : null }
    })
  } catch (error) { return { swept: false, changed: false, reason: error instanceof Error ? error.message : String(error) } }
  finally {
    ctx.signal.removeEventListener('abort', relay)
    if (startupSweep === yielded) startupSweep = null
  }
}

/**
 * The read-only half of N3 = C13: the three cases `Receipts` answers from its own record, asked
 * without touching it. A request it owns must reach it unjudged — re-checking an applied mutation
 * against the state it produced would refuse what `Receipts` is about to replay. M12 = C27 pins the
 * three branches as a unit; M2 = R15 is the rule about *when* the first of them may be written to.
 */
export function receiptsOwnTheAnswer(id: string | undefined, ctx: { startedAt: number; userData: string; here: ReadonlyMap<string, number> }): boolean {
  if (id === undefined) return false
  const match = REQUEST_ID.exec(id)
  if (!match) return false
  return ctx.here.has(id) || Number(match[1]) < ctx.startedAt
    || fs.existsSync(path.join(ctx.userData, 'runtime/terminal-receipts', `${id}.json`))
}

export function orchestrationModule(userData: string): CommandModule {
  const startedAt = Date.now()
  // Built on first use, never in the factory: `cli.ts` constructs every module for every
  // invocation, `--help` included, and none of those may touch the profile directory.
  let store: OrchestrationStore | undefined
  let receipts: Receipts | undefined
  /**
   * Built with this module, not on first use. A child `terminal create` carries a request id
   * *derived* from its parent's, which keeps the parent's timestamp — and `Receipts` refuses an id
   * older than the receipt store it is asked of. Building the terminal module lazily gave it a
   * `startedAt` later than the very request that was about to use it, so the first worker-start
   * after a runtime start failed its terminal stage with `outcome_unknown` every time. Both modules
   * are constructed together now, so they share one notion of when this runtime began. Neither
   * constructor touches the profile, which is what `cli.ts` building every module for `--help`
   * requires.
   */
  const terminalReads: CommandModule = terminalModule(userData)
  /**
   * N3 = C13. Every rejection this module can foresee is now raised *before* the receipt is
   * written, so a refused mutation leaves the id spendable. That must not cost idempotent replay:
   * a request `Receipts` will answer from its own record has to reach it unjudged, or a retry of
   * an applied mutation would be re-checked against the state it already produced and refused
   * instead of replayed. These are the three cases `Receipts` answers itself — same rule, read
   * only: an id this runtime admitted, an id with a receipt on disk, and an id older than this
   * runtime.
   */
  const admittedHere = new Map<string, number>()
  const admitted = (id: string | undefined): boolean => receiptsOwnTheAnswer(id, { startedAt, userData, here: admittedHere })
  /**
   * M4 = R17 = C25. `Receipts` drops its own admissions at the same 24 h the receipt files expire;
   * a mirror that only ever grew would keep ids alive past the window it is mirroring — and keep
   * them in memory for the life of the runtime. Same threshold, same trigger point as the original.
   */
  const forgetExpired = (): void => {
    const now = Date.now()
    for (const [id, createdAt] of admittedHere) if (now - createdAt > RECEIPT_TTL) admittedHere.delete(id)
  }
  return {
    specs: orchestrationSpecs,
    validate: validateOrchestration,
    tracksEffects: true,
    isMutation: inv => MUTATIONS.has(inv.command),
    /**
     * No runtime lane. Reads still have to be serialized against writes — reconcile writes from
     * read paths — but the serialization now lives in `withDocumentLane` above, which can be held
     * for a write and released across a wait. A runtime-wide lane cannot do the second thing, and
     * §4.6 needs it: `check --block` and `ask` must not hold anything while they wait.
     */
    serialKey: () => undefined,
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
        if (!task || task.runId !== runId) return preflight('task_not_found', `No task ${id} in run ${runId}`,
          { taskId: id, runId, recovery: 'corral orchestration task-list --run <run> to see the Tasks this Run holds' })
        return task
      }
      const showTerminal = async (handle: string) => {
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
        const id = String(f['request-id'])
        forgetExpired()
        // M2 = R15: remember the id where `Receipts` itself does — inside the body, which runs only
        // after the pending receipt is on disk. In r2 this line stood before `log.run`, so an id
        // `Receipts` refused *before* admission (a future timestamp, `request_expired`,
        // `receipt_capacity`) was still recorded as admitted; the next attempt with that id skipped
        // preflight, was judged inside the receipt instead, and left the pending receipt that makes
        // every later retry `outcome_unknown` — exactly the shape N3 closed.
        try { return await log.run(inv, async () => { admittedHere.set(id, Number(REQUEST_ID.exec(id)?.[1] ?? Date.now())); return body() }) }
        catch (error) { throw flattenReceiptError(error) }
      }
      /** True when `Receipts` owns the answer, so this call must not be judged again (N3). */
      const recorded = admitted(flag('request-id'))

      // === LIFE-410 ================================================================================
      const caller: CallerIdentity = original.caller ?? { paneId: null, session: null }
      /** Leave room for the response to travel before the request deadline destroys the socket. */
      const waitDeadline = ctx.deadlineAt - 250
      const rest = () => Math.max(1, waitDeadline - Date.now())
      /**
       * How a worker pane should spell `corral`. A pane inherits its environment from the backend,
       * not from corral (§2: corral cannot inject env into a pane), so the preamble has to carry
       * the socket explicitly or a worker would talk to whatever profile its PATH happens to find.
       */
      const corralCommand = (): string => {
        const entry = process.argv[1]
        const base = process.env.CORRAL_CLI ?? (entry !== undefined && entry.endsWith('corral.mjs') ? `${shellQuote(process.execPath)} ${shellQuote(entry)}` : 'corral')
        return `${base} --socket ${shellQuote(socketPath(userData))}`
      }
      const workerOrigin = (dispatch: DispatchRecord): MessageOrigin => ({ kind: 'worker', dispatchId: dispatch.id, paneId: dispatch.target.paneId })
      const coordinatorOrigin = (): MessageOrigin => ({ kind: 'coordinator', dispatchId: null, paneId: caller.paneId })
      const csv = (value: string): string[] => value.split(',').map(part => part.trim()).filter(part => part.length > 0)
      const messagePayload = (extra: Record<string, JsonValue>): JsonValue => {
        const custom = f.payload === undefined ? null : parseResult(String(f.payload))
        const merged: Record<string, JsonValue> = custom !== null && typeof custom === 'object' && !Array.isArray(custom) ? { ...custom } : {}
        for (const [key, value] of Object.entries(extra)) if (value !== null) merged[key] = value
        return merged
      }
      /**
       * The observation for an attempt there is nothing to observe. `verifySender` answers on the
       * dispatch id long before it reads this, so it is never the reason a caller is given.
       */
      const UNOBSERVABLE: PaneObservation = { kind: 'unobserved', reason: 'observation_failed', detail: null }
      /** A fresh look, not the one the reconcile pass memoized: §4.7 re-observes just before it acts. */
      const observeNow = async (target: DispatchTarget): Promise<PaneObservation> =>
        observationFor(await observePanes(budgeted(ctx, SWEEP_BUDGET_MS)), target)
      const dispatchInRun = (state: OrchestrationState, runId: string, id: string): DispatchRecord => {
        const entry = findDispatch(state, id)
        if (!entry || entry.runId !== runId) return preflight('dispatch_not_found', `No dispatch ${id} in run ${runId}`,
          { dispatchId: id, runId, recovery: 'corral orchestration worker-list --run <run> shows the attempts this Run holds' })
        return entry
      }
      /** One line of `worker-list`, and the ownership block `worker-show` repeats. */
      const workerRow = (entry: DispatchRecord) => {
        const worker = entry.worker
        const state = entry.status === 'dispatched' ? 'working'
          : entry.status === 'unknown' ? 'unknown'
            : entry.settledBy === 'worker_done' ? 'reported' : 'settled'
        return {
          dispatchId: entry.id, taskId: entry.taskId, runId: entry.runId, attempt: entry.attempt,
          dispatchStatus: entry.status, workerState: state, settledBy: entry.settledBy, settledAt: entry.settledAt,
          terminal: entry.target.handle, paneId: entry.target.paneId,
          agent: entry.agent === null ? null : { kind: entry.agent.kind, requestedModel: entry.agent.requestedModel, resolvedModel: entry.agent.resolvedModel },
          worker: worker === null ? null : {
            launch: worker.launch, ownership: worker.ownership, originDispatchId: worker.originDispatchId,
            ownershipTransferredTo: worker.ownershipTransferredTo, paneSession: worker.paneSession,
            lastHeartbeatAt: worker.lastHeartbeatAt, capabilityRevokedAt: worker.capabilityRevokedAt,
            capabilityRevokedReason: worker.capabilityRevokedReason, retain: worker.retain, release: worker.release,
            preambleSha256: worker.preambleSha256, promptRequestId: worker.promptRequestId,
          },
        }
      }
      const revoke = (state: OrchestrationState, entry: DispatchRecord, reason: 'settled' | 'stopped' | 'abandoned' | 'released', at: string): OrchestrationState => {
        const current = findDispatch(state, entry.id)
        if (!current || current.worker === null) return state
        // First revocation wins: a release after a settle must not rewrite when the right ended.
        if (current.worker.capabilityRevokedAt !== null) return state
        return replaceDispatchRecord(state, withWorker(current, { capabilityRevokedAt: at, capabilityRevokedReason: reason }, at))
      }
      const terminalChild = async (command: string, flags: Record<string, string | boolean>, options: { stdin?: string; deadlineAt?: number } = {}): Promise<unknown> => {
        const child: Invocation = { command, flags, args: [], cwd: inv.cwd, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) }
        terminalReads.validate(child)
        return terminalReads.execute(child, options.deadlineAt === undefined ? ctx : { ...ctx, deadlineAt: options.deadlineAt })
      }

      /**
       * §4.5, and R2. Every command re-observes the open attempts first, but the result is only
       * *computed* here. A read persists it (that is the `dispatch-show` moment the freeze names);
       * a mutation carries it into its own `atomicWrite`, so an accepted mutation still costs one
       * rename and a **rejected** one leaves the stored bytes byte-identical. Runtime start has its
       * own pass in `server.ts` (R5). With no open attempt the backend is not contacted at all.
       */
      const mutating = MUTATIONS.has(inv.command)
      /** One read-compute-write of the document, under the module lane (§4.6). */
      const session = async <T>(body: (state: OrchestrationState, before: OrchestrationState) => Promise<T>): Promise<T> => withDocumentLane(async () => {
        const before = records.read()
        const pass = await reconcilePass(before, ctx, ctx.instanceId)
        if (pass.snapshot) snapshot ??= pass.snapshot
        if (pass.changed && !mutating) records.write(pass.state)
        return body(pass.state, before)
      })

      // --- send (§4.4) -----------------------------------------------------------------------------
      type SendPlan =
        | { kind: 'coordinator'; runId: string }
        | { kind: 'worker'; runId: string; taskId: string; dispatchId: string; dispatch: DispatchRecord; sessionVerified: boolean }
      const sendCommand = async (state: OrchestrationState): Promise<unknown> => {
        const type = need('type'), subject = need('subject'), body = flag('body') ?? ''
        const payload = messagePayload({
          phase: flag('phase') ?? null,
          filesModified: f['files-modified'] === undefined ? null : csv(String(f['files-modified'])),
          reportPath: flag('report-path') ?? null,
        })
        const commonFor = (target: SendPlan, at: string) => {
          const worker = target.kind === 'worker' ? target.dispatch : null
          return {
            runId: target.runId, taskId: worker === null ? null : worker.taskId, dispatchId: worker === null ? null : worker.id,
            subject, body, payload, from: worker === null ? coordinatorOrigin() : workerOrigin(worker), at,
          }
        }
        /**
         * The whole of what a report does, as one pure value over one document. It is called twice
         * — once on the plan to see whether it can be done at all, once inside the write to do it —
         * and the two calls are the same call, so the judgement that refuses cannot drift from the
         * judgement that acts.
         */
        const settlement = (current: OrchestrationState, target: Extract<SendPlan, { kind: 'worker' }>, at: string) => {
          const outcome = need('outcome') === 'succeeded' ? 'succeeded' : 'failed'
          const appended = appendMessage(current, commonFor(target, at), { type: 'worker_done', outcome })
          const moved = transition(appended.state, {
            taskId: target.taskId, dispatchId: target.dispatchId,
            to: outcome === 'succeeded' ? 'completed' : 'failed', settledBy: 'worker_done',
            result: { outcome, subject, body, payload, messageId: appended.message.id }, at,
          })
          return { appended, moved }
        }
        const addressee = async (): Promise<SendPlan> => {
          // `status` is the one type either side sends: naming an attempt makes it that worker's
          // status, naming none makes it a note on the Run. Taking the ids and then ignoring them
          // would be the worst of the three, so the pairing is required or absent, never partial.
          if (type === 'status' && f['task-id'] === undefined) return { kind: 'coordinator', runId: resolveRunId(state) }
          const taskId = need('task-id'), dispatchId = need('dispatch-id')
          const found = findDispatch(state, dispatchId)
          // One look at the pane, and it is the look this lane already took: `send` runs inside
          // `session`, whose reconcile pass swept the backend before this line and memoized what it
          // saw. Sweeping again here was a second round trip under a held lane (V24) and bought
          // nothing — the memoized snapshot is from inside this lane, which is exactly the proof
          // admission needs (§4.5 / LIFE-393's three layers).
          const observation = found === undefined ? UNOBSERVABLE : observationFor(await observe(), found.target)
          // `worker_done` defers the settled question to `transition`, the only place that can tell
          // "you named a superseded attempt" (stale_dispatch) from "you already reported"
          // (illegal_transition). Every other worker message is refused once the attempt has ended.
          const verdict = verifySender(state, { taskId, dispatchId, caller, observation }, type === 'worker_done' ? 'defer' : 'reject')
          if (!verdict.ok) throw senderError(verdict)
          return { kind: 'worker', runId: verdict.dispatch.runId, taskId, dispatchId, dispatch: verdict.dispatch, sessionVerified: verdict.sessionVerified }
        }
        const plan = async (): Promise<SendPlan> => {
          const target = await addressee()
          // N3, extended to the whole command. The mailbox's own capacity and — for a report — the
          // transition are computed here, on this document, and the result is thrown away. Both are
          // pure, so the dry run costs one call and buys the rule the receipt directory depends on:
          // a `send` that is going to be refused is refused before its receipt exists, and the
          // stored receipt bytes after a refusal are the bytes from before it.
          //
          // V25. This ran on the worker paths only: a coordinator `status` returned above it and
          // reached `message_capacity` inside the receipt instead, leaving a pending receipt behind
          // an effect that never happened. Every message this command can create is dry-run here.
          if (type === 'worker_done' && target.kind === 'worker') settlement(state, target, now())
          else appendMessage(state, commonFor(target, now()), type === 'heartbeat' ? { type: 'heartbeat' } : { type: type === 'escalation' ? 'escalation' : 'status' })
          return target
        }
        const planned = recorded ? undefined : await plan()
        return mutate(async () => {
          const target = planned ?? await plan()
          const at = now()
          const worker = target.kind === 'worker' ? target.dispatch : null
          const sessionVerified = target.kind === 'worker' ? target.sessionVerified : null
          const common = commonFor(target, at)
          if (type === 'worker_done' && target.kind === 'worker') {
            // One value, one write: the report and the settlement it causes are two fields of the
            // same document, so there is no window in which one exists without the other (§4.4).
            const { appended, moved } = settlement(state, target, at)
            const settled = findDispatch(moved.state, target.dispatchId)
            const next = settled === undefined ? moved.state : revoke(moved.state, settled, 'settled', at)
            ctx.onEffect?.()
            records.write(next)
            return { message: appended.message, task: moved.task, dispatch: findDispatch(next, target.dispatchId) ?? null, promoted: moved.promoted, settledBy: 'worker_done', sessionVerified }
          }
          if (type === 'heartbeat' && target.kind === 'worker') {
            const appended = appendMessage(state, common, { type: 'heartbeat' })
            const current = findDispatch(appended.state, target.dispatchId)
            const next = current === undefined ? appended.state : replaceDispatchRecord(appended.state, withWorker(current, { lastHeartbeatAt: at }, at))
            ctx.onEffect?.()
            records.write(next)
            return { message: appended.message, dispatch: findDispatch(next, target.dispatchId) ?? null, sessionVerified }
          }
          const appended = appendMessage(state, common, { type: type === 'escalation' ? 'escalation' : 'status' })
          ctx.onEffect?.()
          records.write(appended.state)
          return { message: appended.message, dispatch: worker === null ? null : findDispatch(appended.state, worker.id) ?? null, sessionVerified }
        })
      }

      // --- recovery (§4.7) -------------------------------------------------------------------------
      /**
       * What one `terminal close` did, without letting a failure hide the settlement that follows
       * it. A pane that has already gone is not an error — it is the `pane_gone` answer — and a
       * close whose effect was not observed is `unknown`, never silently a success.
       */
      const closePane = async (dispatch: DispatchRecord): Promise<{ state: 'released' | 'retained' | 'unknown'; reason: string; processAction: 'closed' | 'none'; detail: unknown }> => {
        try {
          const detail = await terminalChild('terminal close', { terminal: dispatch.target.handle })
          return { state: 'released', reason: 'owned_generation_matches', processAction: 'closed', detail }
        } catch (error) {
          if (error instanceof RuntimeError && error.code === 'stale_terminal')
            return { state: 'retained', reason: 'pane_gone', processAction: 'none', detail: { code: error.code, message: error.message } }
          if (error instanceof RuntimeError) return { state: 'unknown', reason: 'close_outcome_unknown', processAction: 'closed', detail: { code: error.code, message: error.message } }
          throw error
        }
      }
      const recoveryCommand = async (state: OrchestrationState, kind: 'release' | 'stop' | 'abandon'): Promise<unknown> => {
        const runId = resolveRunId(state)
        /**
         * Everything that can refuse happens here, outside the receipt: the wrong lifecycle state,
         * a pane this attempt does not own, an identity the backend will not confirm. The
         * observation is taken here too and carried into the body, so the look that authorised the
         * close is the one the lane is still holding (LIFE-393 S2).
         */
        const prepare = async (): Promise<{ dispatch: DispatchRecord; observation: PaneObservation | null }> => {
          const dispatch = dispatchInRun(state, runId, need('dispatch'))
          if (dispatch.worker === null) return preflight('sender_mismatch', `Dispatch ${dispatch.id} was not started as a worker`,
            { dispatchId: dispatch.id, recovery: 'Only an attempt created by corral orchestration worker-start owns a pane' })
          if (kind === 'release' && dispatch.status === 'dispatched') return preflight('dispatch_active', `Dispatch ${dispatch.id} is still open`,
            { dispatchId: dispatch.id, dispatchStatus: dispatch.status, recovery: 'corral orchestration worker-stop --dispatch <ctx> cancels an attempt that is still running' })
          if (kind !== 'release' && dispatch.status !== 'dispatched') return preflight('dispatch_not_active', `Dispatch ${dispatch.id} is already ${dispatch.status}`,
            { dispatchId: dispatch.id, dispatchStatus: dispatch.status, recovery: 'corral orchestration worker-release --dispatch <ctx> recovers an attempt that has already ended' })
          // abandon is defined as taking no process action, so it asks the backend nothing at all.
          if (kind === 'abandon') return { dispatch, observation: null }
          const observation = await observeNow(dispatch.target)
          if (kind === 'stop') {
            const decision = stopDecision(dispatch, observation)
            if (decision.kind === 'refuse') return preflight(decision.code, `corral cannot prove the pane of ${dispatch.id} is the one it owns`,
              { dispatchId: dispatch.id, ownership: dispatch.worker.ownership, observation: observation.kind,
                recovery: 'corral orchestration worker-show --dispatch <ctx> reports what corral can see; worker-abandon gives the attempt up without touching any process' })
          }
          return { dispatch, observation }
        }
        const planned = recorded ? undefined : await prepare()
        return mutate(async () => {
          const { dispatch, observation } = planned ?? await prepare()
          const at = now()
          const settle = (reason: 'abandoned' | 'worker_stopped', release: { state: 'released' | 'retained' | 'unknown'; reason: string; processAction: 'closed' | 'none' }) => {
            const moved = transition(state, { taskId: dispatch.taskId, dispatchId: dispatch.id, to: 'failed', settledBy: 'task-update', result: { reason, at }, at })
            const current = findDispatch(moved.state, dispatch.id)
            const stamped = current === undefined ? moved.state : replaceDispatchRecord(moved.state, withWorker(current, { release: { ...release, at } }, at))
            const found = findDispatch(stamped, dispatch.id)
            const next = found === undefined ? stamped : revoke(stamped, found, reason === 'abandoned' ? 'abandoned' : 'stopped', at)
            ctx.onEffect?.()
            records.write(next)
            return { dispatchId: dispatch.id, ...release, task: moved.task, dispatch: findDispatch(next, dispatch.id) ?? null }
          }
          if (kind === 'abandon') return {
            ...settle('abandoned', { state: 'retained', reason: 'abandoned', processAction: 'none' }),
            note: 'No process was touched. corral stopped expecting reports from this attempt and left the pane exactly where it is',
          }
          if (kind === 'stop') {
            // The close happens before the write so the record states what actually happened. A
            // close corral could not confirm settles the attempt all the same, with release
            // `unknown` — `worker-show` is the recovery, never a second close.
            const closed = await closePane(dispatch)
            return { ...settle('worker_stopped', { state: closed.state === 'released' ? 'released' : closed.state, reason: closed.state === 'released' ? 'worker_stopped' : closed.reason, processAction: closed.processAction }), close: closed.detail,
              ...(closed.state === 'unknown' ? { recovery: 'corral orchestration worker-show --dispatch <ctx> re-observes the pane; do not issue a second close' } : {}) }
          }
          const decision = releaseDecision({ dispatch, observation: observation ?? { kind: 'unobserved', reason: 'observation_failed', detail: null } })
          switch (decision.kind) {
            case 'refuse': return preflight('dispatch_active', `Dispatch ${dispatch.id} is still open`, { dispatchId: dispatch.id })
            case 'settled': return { dispatchId: dispatch.id, ...(dispatch.worker?.release ?? {}), processAction: 'none', alreadyReleased: true,
              note: 'This attempt was already released; the stored release is the answer and nothing was written again' }
            case 'retain': {
              const stamped = replaceDispatchRecord(state, withWorker(dispatch, {
                release: { state: 'retained', reason: decision.reason, at, processAction: 'none' },
                ...(decision.clearsRetain ? { retain: null } : {}),
              }, at))
              const found = findDispatch(stamped, dispatch.id)
              const next = found === undefined ? stamped : revoke(stamped, found, 'released', at)
              ctx.onEffect?.()
              records.write(next)
              return { dispatchId: dispatch.id, state: 'retained', reason: decision.reason, processAction: 'none', dispatch: findDispatch(next, dispatch.id) ?? null,
                note: decision.clearsRetain ? 'The declared retain was honoured once and has been cleared; a further worker-release judges the pane on its own merits' : 'corral did not close this pane' }
            }
            case 'close': {
              // Re-observe inside the lane, immediately before acting: the decision above was made
              // on a look taken a moment ago, and this is the LIFE-393 S2 window being closed.
              const again = await observeNow(dispatch.target)
              if (again.kind !== 'live') {
                const reason = again.kind === 'pane_gone' ? 'pane_gone' : again.kind === 'unobserved' ? 'observation_failed' : 'identity_unproven'
                const stamped = replaceDispatchRecord(state, withWorker(dispatch, { release: { state: 'retained', reason, at, processAction: 'none' } }, at))
                const found = findDispatch(stamped, dispatch.id)
                ctx.onEffect?.()
                records.write(found === undefined ? stamped : revoke(stamped, found, 'released', at))
                return { dispatchId: dispatch.id, state: 'retained', reason, processAction: 'none', note: 'The pane changed between the decision and the close, so corral closed nothing' }
              }
              const closed = await closePane(dispatch)
              const stamped = replaceDispatchRecord(state, withWorker(dispatch, { release: { state: closed.state, reason: closed.reason, at, processAction: closed.processAction } }, at))
              const found = findDispatch(stamped, dispatch.id)
              const next = found === undefined ? stamped : revoke(stamped, found, 'released', at)
              ctx.onEffect?.()
              records.write(next)
              return { dispatchId: dispatch.id, state: closed.state, reason: closed.reason, processAction: closed.processAction, close: closed.detail,
                dispatch: findDispatch(next, dispatch.id) ?? null,
                ...(closed.state === 'unknown' ? { recovery: 'corral orchestration worker-show --dispatch <ctx> re-observes the pane; do not work around this with terminal close' } : {}) }
            }
          }
        })
      }

      // --- worker-start (§4.2) ---------------------------------------------------------------------
      /** A spec has to leave room for the preamble inside one `terminal prompt` body (65536 bytes). */
      const MAX_SPEC = MAX_INPUT - 16384
      const workerStart = async (): Promise<unknown> => {
        const taskId = need('task')
        const launching = f.agent !== undefined
        f['request-id'] ??= `r1.${Date.now()}.${randomUUID()}`
        const parentId = String(f['request-id'])
        // The handle check first, with no lane held: a pane with no corral-managed agent cannot be
        // prompted, so it is refused here, before anything is created or written.
        const reused = launching ? null : await showTerminal(need('terminal'))
        if (reused !== null && reused.agent === null) return preflight('agent_not_found',
          'This pane carries no corral-managed agent, so corral cannot deliver a preamble to it',
          { terminal: need('terminal'), recovery: 'Start the pane with corral orchestration worker-start --agent claude|codex|grok --worktree <path>' })
        const specFile = (): string => {
          const file = path.resolve(inv.cwd, need('spec-file'))
          try { return fs.readFileSync(file, 'utf8') } catch (error) { return preflight('invalid_argument', `Cannot read --spec-file: ${String(error)}`, { file }) }
        }
        const withinLimit = (spec: string): string => Buffer.byteLength(spec) <= MAX_SPEC ? spec
          : preflight('invalid_argument', `The TASK body must be at most ${MAX_SPEC} bytes so the preamble fits in one submission`,
            { bytes: Buffer.byteLength(spec), limit: MAX_SPEC, recovery: 'Put the detail in a file the worker can read and name it from the spec' })
        const notStartable = (task: TaskRecord, reason: string, activeDispatchId: string | null): never =>
          preflight('task_not_startable', `Task ${task.id} cannot take a new attempt (${reason})`,
            { taskId: task.id, status: task.status, reason, unmetDependencies: [], activeDispatchId,
              recovery: 'corral orchestration worker-show --dispatch <ctx> reports the open attempt; worker-stop or worker-abandon ends it' })
        const paneBusy = (paneId: string, active: DispatchRecord): never =>
          preflight('dispatch_active', `Pane ${paneId} still belongs to open attempt ${active.id}`,
            { dispatchId: active.id, paneId, recovery: 'Settle or stop that attempt before handing its pane to another Task' })
        interface StartPlan { runId: string; spec: string; resume: DispatchRecord | null; specFileUsed: boolean }
        const plan = async (): Promise<StartPlan> => session(async state => {
          const runId = resolveRunId(state)
          const task = taskInRun(state, runId, taskId)
          const open = activeDispatch(state, task.id)
          if (open !== undefined) {
            // §4.2. An attempt whose input stage never completed is resumed, not refused: the pane
            // and the record exist and no preamble was delivered, so finishing the submission is
            // still exactly once. An attempt that already received one is `dispatch_active`.
            if (open.worker !== null && open.worker.promptRequestId === null && (reused === null || reused.target.paneId === open.target.paneId)) {
              // V26 = V28. The resume question is answered before a file is touched, and the stored
              // digest — not the flags on this command line — says which body this attempt was made
              // against. An attempt made from the Task's own spec resumes from the Task, and a
              // `--spec-file` left on the line is *listed* as ignored without ever being opened, so
              // a path that has since gone away cannot refuse a resume it has nothing to do with.
              // Only when the Task no longer explains the digest is the named file read, and then
              // it is read to be compared: the same body resumes, a changed one is still refused
              // (V4). That is what makes an attempt created with `--spec-file` resumable at all.
              const digestOf = (spec: string): string =>
                preambleDigest(composeBody({ corral: corralCommand(), runId, taskId: task.id, dispatchId: open.id, handle: open.target.handle, spec }))
              const stored = open.worker.preambleSha256
              const fromTask = digestOf(task.spec)
              if (resumeDecision({ stored, rebuilt: fromTask }).kind === 'submit') return { runId, spec: task.spec, resume: open, specFileUsed: false }
              if (f['spec-file'] !== undefined) {
                const body = withinLimit(specFile())
                const decision = resumeDecision({ stored, rebuilt: digestOf(body) })
                if (decision.kind === 'submit') return { runId, spec: body, resume: open, specFileUsed: true }
                return preflight('preamble_mismatch', `The file named by --spec-file is not the body dispatch ${open.id} was created against`,
                  { dispatchId: open.id, taskId: task.id, expected: decision.expected, actual: decision.actual,
                    recovery: `Name the file the attempt was started with, or corral orchestration worker-stop --dispatch ${open.id} to end the attempt and start a new one for the changed body` })
              }
              return preflight('preamble_mismatch', `The body dispatch ${open.id} was created against is not the body this run builds`,
                { dispatchId: open.id, taskId: task.id, expected: stored, actual: fromTask,
                  recovery: `The attempt was created from a --spec-file: name the same file again with --spec-file to resume it, or corral orchestration worker-stop --dispatch ${open.id} to end it` })
            }
            return notStartable(task, 'dispatch_active', open.id)
          }
          const start = startability(state, task)
          if (!start.startable) return preflight('task_not_startable', `Task ${task.id} cannot take a new attempt (${start.reason})`,
            { taskId: task.id, status: task.status, reason: start.reason, unmetDependencies: start.unmetDependencies, activeDispatchId: start.activeDispatchId, recovery: start.recovery })
          const spec = withinLimit(f['spec-file'] === undefined ? task.spec : specFile())
          // Whether the pane is busy and who may close it are separate questions. A borrowed pane
          // has no owner at all and can still hold a worker mid-task, so the duplicate refusal is
          // asked of every open attempt on this pane rather than of the owner alone. Both answers
          // are taken again in the commit lane (V21) — this one only refuses early and cheaply.
          if (reused !== null) {
            const active = activePaneDispatch(state, reused.target)
            if (active !== undefined) return paneBusy(reused.target.paneId, active)
          }
          return { runId, spec, resume: null, specFileUsed: f['spec-file'] !== undefined }
        })
        const planned = recorded ? undefined : await plan()
        return mutate(async () => {
          const start = planned ?? await plan()
          const stamp = () => new Date().toISOString()
          const effects: Record<string, unknown>[] = []
          const residualResources: Record<string, unknown>[] = []
          const stages: Record<string, Stage> = { terminal: { status: 'not_started' }, dispatch: { status: 'not_started' }, input: { status: 'not_started' } }
          // §4.2. Three launches, not two: a resume neither created the pane nor took over someone
          // else's, it finished a submission its own earlier run left open, and reporting that as
          // `created` told a reader a pane had just been made for them. Options that name a pane or
          // a body cannot take effect on an attempt that already has both, so they are listed
          // rather than dropped in silence — a caller who passed `--model opus` to a resume has to
          // be able to see that the pane still runs whatever it was started with.
          const ignoredKeys = start.resume !== null
            ? [...(start.specFileUsed ? [] : ['spec-file']), 'worktree', 'agent', 'model', 'effort', 'advisor', 'title']
            : reused !== null ? ['worktree', 'agent', 'model', 'effort', 'advisor', 'title'] : []
          const ignoredOptions = ignoredKeys.filter(key => f[key] !== undefined).map(key => `--${key}`)
          const launch = start.resume !== null ? 'resumed' : launching ? 'created' : 'reused'
          const report = (state: 'ready' | 'failed' | 'incomplete', stage: string, extra: Record<string, unknown>) =>
            ({ runId: start.runId, taskId, launch, ignoredOptions, state, stage, stages, effects, residualResources, ...extra })

          // stage 1 — the pane
          let target: DispatchTarget, agent: AgentSnapshot | null, agentAbsenceReason: string | null, terminal: unknown
          if (start.resume !== null || reused !== null) {
            const source = start.resume ?? reused
            if (source === null) throw new RuntimeError('operation_failed', 'worker-start lost its terminal')
            target = source.target
            agent = source.agent
            agentAbsenceReason = source.agentAbsenceReason
            terminal = reused?.terminal ?? { handle: target.handle, epoch: target.epoch, ptyId: target.ptyId, paneId: target.paneId }
            stages.terminal = { status: 'completed', handle: target.handle, action: start.resume === null ? 'reused' : 'resumed' }
            effects.push({ kind: 'terminal', action: start.resume === null ? 'reused' : 'resumed', id: target.handle, state: 'ready' })
          } else {
            const flags: Record<string, string | boolean> = { worktree: need('worktree'), agent: need('agent'), 'request-id': derivedRequestId(parentId, 'terminal') }
            for (const key of ['model', 'effort', 'advisor', 'title']) if (f[key] !== undefined) flags[key] = need(key)
            let created: unknown
            try { created = await terminalChild('terminal create', flags) }
            catch (error) {
              stages.terminal = stageFailure(error)
              // A create that failed may still have left a pane behind if its outcome is unknown.
              if (stages.terminal.status === 'unknown') residualResources.push({ kind: 'terminal', id: null, action: 'corral terminal list --worktree <path> shows whether a pane was created; close it with corral terminal close' })
              return report('failed', 'terminal', { dispatchId: null, terminal: null })
            }
            const record = isRecord(created) ? created : {}
            const block = readRecord(record, 'terminal')
            const handle = block === null ? null : readString(block, 'handle')
            const epoch = block === null ? null : readString(block, 'epoch')
            const ptyId = block === null ? null : readString(block, 'ptyId')
            const paneId = block === null ? null : readString(block, 'paneId')
            if (block === null || handle === null || epoch === null || ptyId === null || paneId === null) {
              stages.terminal = { status: 'unknown', error: 'terminal_identity_missing' }
              residualResources.push({ kind: 'terminal', id: null, action: 'corral terminal list shows the panes this backend holds' })
              return report('failed', 'terminal', { dispatchId: null, terminal: block })
            }
            terminal = block
            target = { handle, runtimeId: ctx.runtimeId, epoch, ptyId, paneId }
            stages.terminal = { status: 'completed', handle, action: 'created' }
            effects.push({ kind: 'terminal', action: 'created', id: handle, state: 'created' })
            const agentStage = readRecord(readRecord(record, 'stages') ?? {}, 'agent')
            if (agentStage === null || readString(agentStage, 'status') !== 'completed') {
              stages.dispatch = { status: 'not_started', reason: 'agent_start_failed' }
              residualResources.push({ kind: 'terminal', id: handle, action: `corral terminal close --terminal ${handle} once you have read the pane` })
              return report('failed', 'agent', { dispatchId: null, terminal: block, agentStage, create: created })
            }
            const agentBlock = readRecord(record, 'agent')
            agent = agentBlock === null ? null : snapshotAgent(agentBlock)
            agentAbsenceReason = agentBlock === null ? 'no_managed_agent' : null
          }

          // stage 2 — the attempt. Created before the preamble is built, because the preamble names it.
          let dispatch: DispatchRecord
          if (start.resume !== null) {
            dispatch = start.resume
            stages.dispatch = { status: 'completed', dispatchId: dispatch.id, action: 'resumed' }
          } else {
            try {
              // `session` rather than the bare lane: the plan was made on a reconciled document,
              // and the write has to be made on one too, or an attempt reconcile just settled would
              // be judged from stale bytes and refuse a Task the plan had already accepted.
              dispatch = await session(async current => {
                const task = taskInRun(current, start.runId, taskId)
                // V21. `plan()` read a document under its own lane and let it go; between that read
                // and this write another `worker-start` can have taken the same Task or the same
                // pane. So both questions are asked again here, on the document this write is about
                // to be made on, and the answer this lane computes is the one that is written — the
                // plan's copies are a cheap early refusal and nothing more. A conflict found here is
                // past the receipt, which is inherent: a race is not foreseeable at preflight, and
                // the alternative (two dispatched attempts on one pane, either of which may close
                // it) is the failure the freeze's rule 8 exists to prevent.
                const openNow = activeDispatch(current, task.id)
                if (openNow !== undefined) return notStartable(task, 'dispatch_active', openNow.id)
                const activeNow = reused === null ? undefined : activePaneDispatch(current, reused.target)
                if (activeNow !== undefined && reused !== null) return paneBusy(reused.target.paneId, activeNow)
                const owner = reused === null ? null : paneOwner(current, reused.target) ?? null
                const worker = emptyWorker({
                  launch: launching ? 'created' : 'reused',
                  // Reusing a pane no settled attempt owns — one a person started with
                  // `terminal create --agent` — is borrowing, and a borrowed pane is never closed.
                  ownership: launching || owner !== null ? 'owned' : 'borrowed',
                  paneSession: process.env.CORRAL_SESSION ?? null,
                  originDispatchId: owner === null ? null : owner.worker?.originDispatchId ?? owner.id,
                })
                const made = createDispatch(current, { task, target, agent, agentAbsenceReason, worker, at: stamp() })
                let next = made.state
                const self = findDispatch(next, made.dispatch.id)
                // The digest of the body is recorded now, before anything is sent, because it is
                // what a resume compares against. Recording it only after a successful submission
                // left exactly the attempts that need the comparison — the unfinished ones — with
                // nothing to compare against.
                if (self !== undefined) next = replaceDispatchRecord(next, withWorker(self, {
                  preambleSha256: preambleDigest(composeBody({ corral: corralCommand(), runId: start.runId, taskId, dispatchId: self.id, handle: target.handle, spec: start.spec })),
                  ...(launching ? { originDispatchId: self.id } : {}),
                }, stamp()))
                const previous = owner === null ? undefined : findDispatch(next, owner.id)
                if (previous !== undefined) next = replaceDispatchRecord(next, withWorker(previous, { ownership: 'borrowed', ownershipTransferredTo: made.dispatch.id }, stamp()))
                ctx.onEffect?.()
                records.write(next)
                return findDispatch(next, made.dispatch.id) ?? made.dispatch
              })
            } catch (error) {
              stages.dispatch = stageFailure(error)
              if (launching) residualResources.push({ kind: 'terminal', id: target.handle, action: `corral terminal close --terminal ${target.handle}: the pane was created and no attempt records it` })
              return report('failed', 'dispatch', { dispatchId: null, terminal })
            }
            stages.dispatch = { status: 'completed', dispatchId: dispatch.id, attempt: dispatch.attempt }
            effects.push({ kind: 'dispatch', action: 'created', id: dispatch.id, state: 'dispatched' })
          }
          const unfinished = () => residualResources.push({ kind: 'dispatch', id: dispatch.id,
            action: `The attempt exists and holds the pane, with no preamble delivered. corral orchestration worker-start --task ${taskId} --terminal ${target.handle} submits it once the pane is ready; worker-stop --dispatch ${dispatch.id} ends the attempt and closes the pane` })

          // stage 3 — the one submission
          const input = composeBody({ corral: corralCommand(), runId: start.runId, taskId, dispatchId: dispatch.id, handle: target.handle, spec: start.spec })
          const sha256 = preambleDigest(input)
          // The readiness gate gets most of what is left, never all of it: a submission that has no
          // time to run would report a deadline it never had a chance at (LIFE-394 G1).
          const readyBy = Math.min(ctx.deadlineAt - 2000, Date.now() + Math.max(1000, Math.floor((ctx.deadlineAt - Date.now()) * 0.6)))
          let ready: unknown
          try { ready = await terminalChild('terminal wait', { terminal: target.handle, for: 'agent-ready' }, { deadlineAt: readyBy }) }
          catch (error) {
            stages.input = stageFailure(error)
            unfinished()
            return report('incomplete', 'agent_not_ready', { dispatchId: dispatch.id, terminal, dispatch })
          }
          if (!(isRecord(ready) && ready.satisfied === true)) {
            const block = isRecord(ready) ? readRecord(ready, 'agent') : null
            stages.input = { status: 'not_started', reason: block !== null && readString(block, 'phase') === 'blocked' ? 'agent_blocked' : 'agent_not_ready' }
            unfinished()
            return report('incomplete', 'agent_not_ready', { dispatchId: dispatch.id, terminal, dispatch, agent: block })
          }
          // A body delivered as a paste and nothing else reads as untrusted to a provider: claude
          // 2.1.280 refuses a message that is "entirely pasted content" as a possible injection, and
          // it is right to — nothing in it was typed by whoever is at the keyboard. So one line is
          // typed first. It carries no newline, so the Enter that submits is still the prompt's own:
          // one submission is one Enter and one `promptRequestId`, which is what F1 counts.
          //
          // V22/V34/V35. The lead is one effect and the body is another, and a run can die between
          // them. Each is recorded *before* it is made, and each record is a claim taken inside the
          // document lane rather than a value read out of the plan's snapshot — two runs resuming
          // the same attempt at once both read `null` in their own snapshots, so only the lane can
          // decide which of them makes the effect. The run that writes the key is the only run that
          // makes it. What a later run may do is then decided from those records and the receipts
          // they name: corral never reads the pane's screen to answer it (`agent.ts` §4.6), and it
          // never repeats an effect whose outcome it cannot read.
          interface Intent { requestId: string; at: string }
          const claim = async (key: 'lead' | 'prompt', requestId: string): Promise<{ mine: boolean; intent: Intent }> => withDocumentLane(async () => {
            const current = records.read()
            const entry = findDispatch(current, dispatch.id)
            const worker = entry?.worker ?? null
            const held = worker === null ? null : key === 'lead' ? worker.lead : worker.prompt
            if (held !== null) return { mine: false, intent: held }
            const intent: Intent = { requestId, at: stamp() }
            if (entry === undefined) return { mine: true, intent }
            const next = replaceDispatchRecord(current, withWorker(entry, key === 'lead' ? { lead: intent } : { prompt: intent }, stamp()))
            records.write(next)
            dispatch = findDispatch(next, dispatch.id) ?? entry
            return { mine: true, intent }
          })
          /**
           * V36. A claim is taken back for one case only: the child refused *before* any effect and
           * said so (`not_started`). A `failed` carries no outcome at all — that is the shape a
           * backend produces when it took the request and never answered, and the text may well be
           * on the input line — and an `unknown` says as much outright. Reading either as "nothing
           * happened" is what let a resume type a second lead into a pane that already had one.
           */
          const release = async (key: 'lead' | 'prompt', error: unknown): Promise<boolean> => {
            if (!(error instanceof RuntimeError && error.outcome === 'not_started')) return false
            await withDocumentLane(async () => {
              const current = records.read()
              const entry = findDispatch(current, dispatch.id)
              if (entry === undefined) return
              const next = replaceDispatchRecord(current, withWorker(entry, key === 'lead' ? { lead: null } : { prompt: null }, stamp()))
              records.write(next)
              dispatch = findDispatch(next, dispatch.id) ?? entry
            })
            return true
          }
          /**
           * V35. What an effect an *earlier* run made actually returned. A record of intent is not
           * proof that the text reached the pane, and the screen cannot be asked, so the evidence
           * this run acts on is the receipt that run's request id names: a completed receipt holds
           * the child's own result, and a pending or missing one says the effect may have happened
           * and was never seen. The honest answer to the second is to stop and say so.
           *
           * V47 (r4). Reading is itself an operation that can fail. `readFile` answers a missing
           * file with the fallback but rethrows anything else as `storage_corrupt`, and that throw
           * used to leave this command through the side door — no `stage`, no `stages`, no
           * `effects`, no dispatch id for the caller to resume with. A receipt that cannot be read
           * is one more thing corral does not know, so it is reported the way the others are, and
           * the file is left exactly as it is for a person to look at.
           */
          type ReceiptRead =
            | { kind: 'completed'; result: unknown }
            | { kind: 'absent' }
            | { kind: 'unreadable'; code: string; detail: string }
          const receiptOf = (intent: Intent): ReceiptRead => {
            let receipt: Receipt | null
            try { receipt = readReceipt(userData, intent.requestId) }
            catch (error) {
              return { kind: 'unreadable', code: error instanceof RuntimeError ? error.code : 'receipt_unreadable',
                detail: error instanceof Error ? error.message : String(error) }
            }
            return receipt !== null && receipt.state === 'completed' ? { kind: 'completed', result: receipt.result ?? null } : { kind: 'absent' }
          }
          /**
           * V37. `terminal prompt` runs inside `Receipts.run`, so a refusal that crosses it comes
           * back re-wrapped and the child's own resources sit under `detail`. The count is read from
           * either shape — the wrapper is what the real path produces, the bare one is what a direct
           * call produces — because reading it from the wrong place turned a delivery the provider
           * had already accepted exactly once into a permanent "count unknown".
           */
          const matchCountOf = (resources: unknown): number | null => {
            let level: unknown = resources
            for (let depth = 0; depth < 4; depth++) {
              if (!isRecord(level)) return null
              const here = readNumber(level, 'matchCount')
              if (here !== null) return here
              level = readRecord(level, 'detail')
            }
            return null
          }
          /**
           * V35. The two ways this stage ends without submitting anything. `unprovable` is the state
           * of an attempt whose earlier effect cannot be read: it may still converge — the run that
           * holds the claim may be mid-flight — so it stays resumable and names what to look at.
           * `corrupted` is the state of an attempt whose body was submitted and is *not* in the
           * provider's record: repeating the submission is what V35 exists to stop, so the attempt
           * ends here and a person decides. Neither path makes a child call.
           */
          const stopUnprovable = (reason: string, intent: Intent, what: string,
            more?: { evidence?: Record<string, unknown>; also?: string }) => {
            const evidence = more?.evidence ?? { receipt: 'pending_or_missing' }
            stages.input = { status: 'not_started', reason, requestId: intent.requestId, ...evidence }
            residualResources.push({ kind: 'dispatch', id: dispatch.id,
              action: `${what} corral cannot prove it from the pane, and it will not repeat the effect. corral orchestration worker-show --dispatch ${dispatch.id} reports the attempt; if another run holds request ${intent.requestId} let it finish, otherwise read the pane with corral terminal read --terminal ${target.handle} and end the attempt with corral orchestration worker-stop --dispatch ${dispatch.id}${more?.also ?? ''}` })
            return report('incomplete', 'dispatch_input_unprovable',
              { dispatchId: dispatch.id, terminal, dispatch, input: { requestId: intent.requestId, at: intent.at, ...evidence } })
          }
          /** V47. The same stop, for the one thing that is not a verdict about the pane at all. */
          const stopUnreadable = (intent: Intent, failure: { code: string; detail: string }, what: string) => {
            stages.input = { status: 'not_started', reason: 'receipt_unreadable', requestId: intent.requestId, receipt: failure.code }
            residualResources.push({ kind: 'dispatch', id: dispatch.id,
              action: `The receipt request ${intent.requestId} names cannot be read (${failure.code}), so corral cannot say what the earlier run that ${what} was told. corral will not repeat the effect and it will not rewrite the receipt: read the pane with corral terminal read --terminal ${target.handle} and end the attempt with corral orchestration worker-stop --dispatch ${dispatch.id}` })
            return report('incomplete', 'dispatch_input_unprovable',
              { dispatchId: dispatch.id, terminal, dispatch,
                input: { requestId: intent.requestId, at: intent.at, receipt: { unreadable: failure.code, detail: failure.detail } } })
          }
          const leadId = derivedRequestId(parentId, 'lead')
          const leadClaim = await claim('lead', leadId)
          if (leadClaim.mine) {
            try { await terminalChild('terminal send', { terminal: target.handle, text: PROMPT_LEAD, 'request-id': leadId }, {}) }
            catch (error) {
              const released = await release('lead', error)
              stages.input = { ...stageFailure(error), requestId: leadId, lead: released ? 'released' : 'kept' }
              unfinished()
              return report('incomplete', 'dispatch_input', { dispatchId: dispatch.id, terminal, dispatch })
            }
          } else {
            const held = receiptOf(leadClaim.intent)
            if (held.kind === 'unreadable') return stopUnreadable(leadClaim.intent, held, 'typed the lead line')
            if (held.kind === 'absent') {
              return stopUnprovable('lead_outcome_unknown', leadClaim.intent,
                `An earlier run of this attempt recorded the lead line it was about to type and its receipt does not say what came of it.`)
            }
          }
          /**
           * V38. A diagnostic, and nothing in this command branches on it. `terminal read --screen`
           * returns the provider's drawing: a TUI puts the input line in a box with hint rows under
           * it, so the end of the screen is not the end of the input line, and corral does not parse
           * provider screens to decide anything (`agent.ts` §4.6). So this says `true` only when the
           * lead's text is somewhere on the screen, and `null` — never `false` — otherwise. corral
           * cannot prove an input line is clear, and claiming it is would be the same mistake facing
           * the other way.
           */
          const strandedLead = async (): Promise<{ checked: boolean; present: boolean | null; reason: string | null }> => {
            if (leadClaim.mine) return { checked: false, present: null, reason: 'lead_typed_by_this_run' }
            try {
              const screen = await terminalChild('terminal read', { terminal: target.handle, screen: true })
              const text = isRecord(screen) ? readString(screen, 'text') : null
              if (text === null) return { checked: true, present: null, reason: 'no_screen_text' }
              return text.includes(PROMPT_LEAD)
                ? { checked: true, present: true, reason: 'screen_holds_the_lead_text' }
                : { checked: true, present: null, reason: 'screen_is_not_the_input_line' }
            } catch (error) { return { checked: false, present: null, reason: error instanceof RuntimeError ? error.code : 'read_failed' } }
          }
          const promptId = derivedRequestId(parentId, 'prompt')
          const promptClaim = await claim('prompt', promptId)
          const deliveredBy = promptClaim.mine ? promptId : promptClaim.intent.requestId
          let submitted: unknown
          let verdict: SubmissionVerdict
          if (promptClaim.mine) {
            try {
              submitted = await terminalChild('terminal prompt', { terminal: target.handle, stdin: true, wait: 'accepted', 'request-id': promptId }, { stdin: input })
              verdict = submissionVerdict(submitted)
            } catch (error) {
              // The duplicate pre-check found this exact body already in the provider's record. That
              // is this Dispatch's delivery — observed rather than made, which is the only kind of
              // proof a resumed attempt can have. The identity it matched is the identity of `input`,
              // so it is proof for this body and no other.
              if (error instanceof RuntimeError && error.code === 'prompt_already_delivered') {
                // V23. The pre-check says "this body is in the provider's record", not "exactly
                // once". Two copies mean the one-input rule is already broken for this pane, and
                // calling that an accepted delivery would bury it under a `ready`. Only a single
                // match is this Dispatch's delivery; anything else leaves the attempt unconfirmed,
                // with the count the pre-check reported. The refusal is effect-free, so the claim
                // this run took goes back (V36).
                const matchCount = matchCountOf(error.resources)
                await release('prompt', error)
                if (matchCount === 1) {
                  submitted = { outcome: 'already_present', stage: 'confirmed', detail: error.resources, matchCount }
                  verdict = { kind: 'delivered', confirmed: 'already_present' }
                } else {
                  submitted = { outcome: 'already_present', stage: 'ambiguous', detail: error.resources, matchCount }
                  verdict = { kind: 'unknown', reason: matchCount === null ? 'duplicate_count_unknown' : 'duplicate_submissions' }
                }
              } else {
                const released = await release('prompt', error)
                stages.input = { ...stageFailure(error), requestId: promptId, submission: released ? 'released' : 'kept' }
                unfinished()
                return report('incomplete', 'dispatch_input', { dispatchId: dispatch.id, terminal, dispatch })
              }
            }
          } else {
            // V35. An earlier run already submitted this body. Submitting it again under a new id is
            // exactly the repetition that left an attempt pasting the same body on every resume, so
            // this run makes no call at all: it reads that run's receipt and answers from it.
            //
            // V45·V46 (r4). *How* it answers from it is the whole of this branch. The receipt holds
            // the child's own verdict next to the number it counted — `record.unavailableReason` is
            // null exactly when `terminal prompt` proved one match in a file it proved it owned
            // (`agent.ts classifyCount`), and carries the reason otherwise: an invalidated cursor is
            // unknown even at one match, and a count of zero at the deadline is a snapshot of a
            // provider that may simply not have written its record yet. r3 read the number and threw
            // the verdict away, which promoted an ambiguous 1 to a delivery and froze a perfectly
            // good submission at 0 into a permanent failure. So the verdict is what this run
            // follows: delivered, or proven at the source, or — for every other shape, whatever the
            // number — unprovable, which is a state the attempt can still be resumed out of.
            const earlier = receiptOf(promptClaim.intent)
            if (earlier.kind === 'unreadable') return stopUnreadable(promptClaim.intent, earlier, 'submitted the body')
            if (earlier.kind === 'absent') {
              return stopUnprovable('submission_outcome_unknown', promptClaim.intent,
                `An earlier run of this attempt submitted the body and its receipt does not say what came of it.`)
            }
            const recovered = submissionVerdict(earlier.result)
            const record = isRecord(earlier.result) ? readRecord(earlier.result, 'record') : null
            const counted = matchCountOf(record)
            const cursorInvalidated = record !== null && record.cursorInvalidated === true
            const unavailable = record === null || !('unavailableReason' in record) ? 'no_record' : readString(record, 'unavailableReason')
            if (recovered.kind === 'delivered') { submitted = earlier.result; verdict = recovered }
            else if (unavailable === null) {
              // `stage: 'confirmed'` at the source: one match, in a file the child proved it owned,
              // on a cursor it had not lost. There is nothing left for this run to doubt.
              submitted = { outcome: 'already_present', stage: 'recovered', detail: earlier.result, matchCount: counted }
              verdict = { kind: 'delivered', confirmed: 'already_present' }
            } else {
              return stopUnprovable('submission_unconfirmed', promptClaim.intent,
                `An earlier run of this attempt submitted the body and the answer it got does not confirm the provider's record holds it (${unavailable}).`,
                { evidence: { receipt: 'completed', unavailableReason: unavailable, matchCount: counted, cursorInvalidated, detail: earlier.result },
                  also: `. corral does not count again on a resume — it asks the pane nothing — so this attempt stays here until a person looks: if the body is in front of the provider the work is already running, and starting a new Dispatch for this Task on the same pane puts the same body in a second time` })
            }
          }
          if (verdict.kind === 'unknown') {
            // Neither a failure nor a delivery: the submission was made and its arrival was never
            // seen. `promptRequestId` stays null, so the attempt stays resumable — and because the
            // submission itself is recorded, the run that resumes it reads this run's receipt
            // instead of submitting the body a second time.
            stages.input = { status: 'unknown', requestId: deliveredBy, reason: verdict.reason }
            unfinished()
            return report('incomplete', 'dispatch_input_unconfirmed', { dispatchId: dispatch.id, terminal, dispatch, input: submitted, lead: await strandedLead() })
          }
          stages.input = { status: 'completed', requestId: deliveredBy, delivery: verdict.confirmed }
          effects.push({ kind: 'dispatch_input', action: 'submitted', id: deliveredBy, state: 'accepted' })
          const stored = await withDocumentLane(async () => {
            const current = records.read()
            const entry = findDispatch(current, dispatch.id)
            if (entry === undefined) return dispatch
            const next = replaceDispatchRecord(current, withWorker(entry, { preambleSha256: sha256, promptRequestId: deliveredBy }, stamp()))
            records.write(next)
            return findDispatch(next, dispatch.id) ?? entry
          })
          // A delivery this run observed rather than made leaves the question of what the *earlier*
          // run left behind. If its lead is still sitting on the input line it will prefix whatever
          // is typed there next, and corral has no way to take it back. The record — not the screen
          // — is what says an earlier run typed one (V38).
          const lead = await strandedLead()
          if (!leadClaim.mine) residualResources.push({ kind: 'input_line', id: target.handle,
            action: `An earlier run of this attempt typed the lead line on ${target.handle}. corral cannot clear an input line — if the pane still shows it, press Ctrl-U there before typing anything else` })
          return report('ready', 'input_accepted', {
            dispatchId: dispatch.id, terminal, dispatch: stored, lead,
            preamble: { sha256, bytes: Buffer.byteLength(input), lines: input.split('\n').length },
            input: submitted,
          })
        })
      }

      // --- the two waiting commands (§4.6) --------------------------------------------------------
      // They never hold the lane while they wait, and they do not reconcile: a mailbox operation
      // observes no pane, and a backend that has stopped answering must not turn a ten-minute wait
      // into an `outcome_unknown`. Their own writes take the lane for the length of one write.

      if (inv.command === 'orchestration check') {
        const types: MessageType[] = f.types === undefined ? [...DELIVERABLE_TYPES] : parseTypes(String(f.types))
        const ackId = flag('ack'), peeking = f.peek === true, blocking = f.block === true
        interface Batch { runId: string; deliveryId: string | null; messages: MessageRecord[]; deliveryReplayed: boolean; acknowledged: string | null; peeked: boolean; timedOut: boolean }
        const render = (batch: Batch) => ({ ...batch, count: batch.messages.length })
        // N3's rule: a rejection this module can foresee is raised before the receipt exists, so a
        // stale `--ack` leaves the caller's --request-id unspent and the stored bytes untouched.
        if (!recorded) await withDocumentLane(async () => {
          const state = records.read()
          const runId = resolveRunId(state)
          if (ackId !== undefined) acknowledgeDelivery(state, runId, ackId, now())
        })
        // The acknowledgement is an effect, and an effect happens once. `collect` runs again on every
        // poll of a `--block`, so the id is handed to the first collect only: re-applying it made the
        // second poll refuse the delivery it had itself just closed, turning a wait into an error.
        const collect = async (ack: string | undefined): Promise<Batch> => withDocumentLane(async () => {
          const state = records.read()
          const runId = resolveRunId(state)
          let working = state, acknowledged: string | null = null
          if (ack !== undefined) {
            const acked = acknowledgeDelivery(working, runId, ack, now())
            working = acked.state
            acknowledged = acked.delivery.id
          }
          if (peeking) {
            if (acknowledged !== null) { ctx.onEffect?.(); records.write(working) }
            return { runId, deliveryId: null, messages: pendingBatch(working, runId, types), deliveryReplayed: false, acknowledged, peeked: true, timedOut: false }
          }
          const opened = openDelivery(working, runId, types, now())
          if (acknowledged !== null || (opened.plan.delivery !== null && !opened.plan.replayed)) { ctx.onEffect?.(); records.write(opened.state) }
          return { runId, deliveryId: opened.plan.delivery?.id ?? null, messages: opened.plan.messages, deliveryReplayed: opened.plan.replayed, acknowledged, peeked: false, timedOut: false }
        })
        return mutate(async () => {
          const first = await collect(ackId)
          if (first.messages.length > 0 || peeking || !blocking) return render(first)
          for (;;) {
            ctx.signal.throwIfAborted()
            if (Date.now() >= waitDeadline) return render({ ...first, timedOut: true })
            await delay(Math.min(150, rest()), undefined, { signal: ctx.signal })
            const again = await collect(undefined)
            if (again.messages.length > 0) return render({ ...again, acknowledged: first.acknowledged })
          }
        })
      }

      if (inv.command === 'orchestration ask') {
        const taskId = need('task-id'), dispatchId = need('dispatch-id'), resume = flag('resume')
        const opened = await withDocumentLane(async () => {
          const state = records.read()
          // V24. The look that proves the sender is taken *inside* the lane, not before it. Taken
          // outside, it was the pane as it stood before the wait for the lane began: a pane that
          // died during that wait still admitted a question on an attempt corral could no longer
          // reach. One sweep, under the lane that is about to write, and never again — the wait
          // that follows polls the mailbox, not the backend, so a backend that stops answering
          // cannot turn a ten-minute wait into an `outcome_unknown` (§4.6).
          const asking = findDispatch(state, dispatchId)
          const claim: SenderClaim = { taskId, dispatchId, caller, observation: asking === undefined ? UNOBSERVABLE : await observeNow(asking.target) }
          // A resume names a question that already exists, so the attempt may already have been
          // settled — `defer` lets a worker collect an answer it asked for before it reported.
          const verdict = verifySender(state, claim, resume === undefined ? 'reject' : 'defer')
          if (!verdict.ok) throw senderError(verdict)
          if (resume !== undefined) {
            const question = findMessage(state, resume)
            if (!question) return preflight('message_not_found', `No message ${resume}`, { messageId: resume, recovery: 'The pending answer of an earlier ask names its own messageId; corral orchestration inbox --type question lists them' })
            if (question.type !== 'question') return preflight('not_a_question', `Message ${resume} is a ${question.type}`, { messageId: resume, type: question.type })
            if (question.dispatchId !== dispatchId) return preflight('sender_mismatch', `Question ${resume} belongs to dispatch ${String(question.dispatchId)}`,
              { messageId: resume, dispatchId: question.dispatchId, claimedDispatchId: dispatchId, recovery: 'Resume only a question this Dispatch asked' })
            return { messageId: question.id, runId: question.runId, sessionVerified: verdict.sessionVerified }
          }
          const draft = (current: OrchestrationState) => appendMessage(current, {
            runId: verdict.dispatch.runId, taskId, dispatchId,
            subject: flag('subject') ?? 'question', body: need('question'),
            payload: messagePayload({ phase: flag('phase') ?? null }), from: workerOrigin(verdict.dispatch), at: now(),
          }, { type: 'question', options: f.options === undefined ? [] : csv(String(f.options)) })
          // V25. A question is a message, and a mailbox that is full refuses it. That refusal is
          // foreseeable on this document, so it is made here rather than inside the receipt — the
          // rule `send` follows, applied to the one message path that did not.
          if (!recorded) draft(state)
          return mutate(async () => {
            const appended = draft(records.read())
            ctx.onEffect?.()
            records.write(appended.state)
            // V29. The proof that admitted this question travels with it: `send` reports whether
            // the pane's backend session matched the recorded one, and an answer a worker collects
            // has exactly as much to say about who asked.
            return { messageId: appended.message.id, runId: verdict.dispatch.runId, sessionVerified: verdict.sessionVerified }
          })
        })
        const envelope = isRecord(opened) ? opened : {}
        const messageId = readString(envelope, 'messageId')
        const sessionVerified = envelope.sessionVerified === true
        if (messageId === null) throw new RuntimeError('operation_failed', 'ask did not record a question id')
        const resumeCommand = `${corralCommand()} orchestration ask --resume ${messageId} --task-id ${taskId} --dispatch-id ${dispatchId} --timeout-ms 600000 --json`
        for (;;) {
          const answered = await withDocumentLane(async () => {
            const state = records.read()
            const question = findMessage(state, messageId)
            if (question === undefined || question.type !== 'question') return null
            const reply = answerOf(state, question)
            return reply === null ? null : { question, reply }
          })
          if (answered !== null) return {
            state: 'answered', messageId, runId: readString(envelope, 'runId'), timedOut: false, sessionVerified,
            question: { id: answered.question.id, body: answered.question.body, options: answered.question.question.options, askedAt: answered.question.createdAt },
            reply: { id: answered.reply.id, body: answered.reply.body, subject: answered.reply.subject, answeredAt: answered.reply.createdAt },
          }
          if (Date.now() >= waitDeadline) return {
            state: 'pending', messageId, runId: readString(envelope, 'runId'), timedOut: true, sessionVerified, question: null, reply: null,
            resumeCommand, recovery: 'The question is stored. Run resumeCommand to keep waiting; asking again would create a second question',
          }
          ctx.signal.throwIfAborted()
          await delay(Math.min(150, rest()), undefined, { signal: ctx.signal })
        }
      }

      if (inv.command === 'orchestration request-show') {
        // Not a document command at all: it reads the shared receipt store the mutations write to.
        const id = need('id')
        const file = path.join(userData, 'runtime/terminal-receipts', `${id}.json`)
        const stored = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
        if (stored === null) return { requestId: id, state: 'absent', createdAt: null, result: null,
          interpretation: 'No receipt is stored for this request id. Absent is not proof that nothing happened: the id may never have been admitted, or its receipt may have expired (24 hours). Inspect worker-list / task-list / inbox before sending the same input again.' }
        const receipt: unknown = JSON.parse(stored)
        const record = isRecord(receipt) ? receipt : {}
        const state = readString(record, 'state')
        return {
          requestId: id, state: state === 'completed' ? 'completed' : 'pending',
          createdAt: readNumber(record, 'createdAt'), result: state === 'completed' ? record.result ?? null : null,
          interpretation: state === 'completed'
            ? 'This request completed and its result is stored. Re-sending the same id replays that result; sending the same input under a new id would create a second record.'
            : 'This request was admitted and its outcome was never recorded. It may have taken effect. corral never re-executes it: inspect worker-list / task-list / inbox, and do not send the same input under a new id until you know.',
        }
      }

      if (inv.command === 'orchestration worker-start') return workerStart()

      return session(async (state, before) => {
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
          const plan = () => createTask(state, { runId, spec: need('spec'), title: flag('title') ?? null, deps: parseDeps(flag('deps') ?? ''), at: now() })
          const planned = recorded ? undefined : plan()
          return mutate(async () => {
            const created = planned ?? plan()
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
          // R7 = C1, widened by N3 = C13: `task_not_found`, an illegal transition, a stale
          // `--dispatch` and a `--expected-version` mismatch are all decided on the document this
          // command already read, so none of them needs a receipt to exist first. `transition` is
          // pure — planning it here is the check, and the accepted plan is what the body writes.
          const plan = () => {
            const task = taskInRun(state, runId, need('id'))
            const status = need('status')
            if (!isTaskStatus(status)) return preflight('invalid_argument', `--status must be one of ${TASK_STATUSES.join('|')}`)
            return transition(state, {
              taskId: task.id, to: status, settledBy: 'task-update', at: now(),
              dispatchId: flag('dispatch'),
              result: f.result === undefined ? undefined : parseResult(need('result')),
              expectedVersion: f['expected-version'] === undefined ? undefined : Number(f['expected-version']),
            })
          }
          const planned = recorded ? undefined : plan()
          return mutate(async () => {
            const moved = planned ?? plan()
            ctx.onEffect?.()
            records.write(moved.state)
            return { run: findRun(moved.state, runId) ?? null, task: moved.task, dispatch: moved.dispatch, promoted: moved.promoted }
          })
        }
        case 'orchestration dispatch': {
          const runId = resolveRunId(state)
          // N3: `invalid_terminal`, `stale_terminal` and `task_not_startable` are decided before
          // anything is written, so they no longer spend the caller's `--request-id` either. The
          // handle check is a read of the terminal module (§4.3(1)) and sends nothing to the pane.
          const plan = async () => {
            const resolved = await showTerminal(need('to'))
            const task = taskInRun(state, runId, need('task'))
            return { resolved, created: createDispatch(state, { task, target: resolved.target, agent: resolved.agent, agentAbsenceReason: resolved.agentAbsenceReason, at: now() }) }
          }
          const planned = recorded ? undefined : await plan()
          return mutate(async () => {
            const { resolved, created } = planned ?? await plan()
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
        // --- LIFE-410 ---------------------------------------------------------------------------
        case 'orchestration send': return sendCommand(state)
        case 'orchestration reply': {
          const id = need('id')
          const plan = () => answerQuestion(state, id, { body: need('body'), subject: flag('subject') ?? 'reply', from: coordinatorOrigin(), at: now() })
          const planned = recorded ? undefined : plan()
          return mutate(async () => {
            const answered = planned ?? plan()
            ctx.onEffect?.()
            records.write(answered.state)
            return { question: answered.question, reply: answered.reply }
          })
        }
        case 'orchestration inbox': {
          const runId = resolveRunId(state)
          const wanted = flag('type')
          const rows = runMessages(state, runId)
            .filter(entry => (wanted === undefined || entry.type === wanted) && (!f.unread || entry.acknowledgedAt === null))
            .sort((left, right) => right.sequence - left.sequence)
          const open = outstandingDelivery(state, runId)
          return { run: findRun(state, runId) ?? null, messages: rows.slice(0, limit), totalCount: rows.length, truncated: rows.length > limit,
            outstandingDeliveryId: open?.id ?? null, consumed: false }
        }
        case 'orchestration worker-list': {
          const runId = resolveRunId(state)
          const wanted = flag('status')
          const rows = state.dispatches.filter(entry => entry.runId === runId && entry.worker !== null && (wanted === undefined || entry.status === wanted)).reverse()
          return { run: findRun(state, runId) ?? null, workers: rows.slice(0, limit).map(workerRow), totalCount: rows.length, truncated: rows.length > limit }
        }
        case 'orchestration worker-show': {
          const entry = f.dispatch === undefined ? latestDispatch(state, need('task')) : findDispatch(state, need('dispatch'))
          if (!entry) return preflight('dispatch_not_found', f.dispatch === undefined ? `No dispatch for task ${need('task')}` : `No dispatch ${need('dispatch')}`,
            { dispatchId: flag('dispatch') ?? null, taskId: flag('task') ?? null })
          const messages = state.messages.filter(message => message.dispatchId === entry.id)
          // A settled attempt still had a pane, and whether that pane is there *now* is the thing a
          // reader of the record needs: it is the difference between "the transcript is still open
          // in front of me" and "there is nothing left to read". Answering `live: null` because the
          // attempt is over reported the record's own age as if it were an observation. So the pane
          // is observed either way and the stored reconcile is carried beside the answer rather than
          // standing in for it. The observation is read-only: `worker-show` reconciles nothing,
          // settles nothing, and the Task it reports is the one the document already held.
          const decision = reconcileDecision(observationFor(await observe(), entry.target))
          const live = {
            live: decision.live, observed: decision.observed, source: 'observation', reason: decision.reason,
            observedAt: now(), runtimeInstanceId: ctx.instanceId,
            record: { reason: entry.reconcile?.reason ?? null, at: entry.reconcile?.at ?? null, runtimeInstanceId: entry.reconcile?.runtimeInstanceId ?? null },
          }
          // The live block is `observation`, not `terminal`: `terminal` already names the handle in
          // every worker row, and letting the observation take that key silently hid the handle.
          // `dispatch-show` keeps its own LIFE-409 shape, where `terminal` *is* the observation.
          return {
            dispatch: entry, task: findTask(state, entry.taskId) ?? null, ...workerRow(entry), observation: live,
            messageCounts: Object.fromEntries([...DELIVERABLE_TYPES, 'reply'].map(type => [type, messages.filter(message => message.type === type).length])),
            lastMessage: messages.at(-1) ?? null,
          }
        }
        case 'orchestration worker-read': {
          const runId = resolveRunId(state)
          const entry = dispatchInRun(state, runId, need('dispatch'))
          const flags: Record<string, string | boolean> = { terminal: entry.target.handle }
          if (f.screen) flags.screen = true
          if (f.cursor !== undefined) flags.cursor = need('cursor')
          if (f.limit !== undefined) flags.limit = need('limit')
          const output = await terminalChild('terminal read', flags)
          return { dispatchId: entry.id, terminal: entry.target.handle, source: 'terminal', output }
        }
        case 'orchestration worker-retain': {
          const runId = resolveRunId(state)
          const plan = () => {
            const entry = dispatchInRun(state, runId, need('dispatch'))
            if (entry.worker === null) return preflight('sender_mismatch', `Dispatch ${entry.id} was not started as a worker`, { dispatchId: entry.id })
            return entry
          }
          const planned = recorded ? undefined : plan()
          return mutate(async () => {
            const entry = planned ?? plan()
            const at = now()
            const reason = isRetainReason(f.reason) ? f.reason : 'user_requested'
            ctx.onEffect?.()
            records.write(replaceDispatchRecord(state, withWorker(entry, { retain: { reason, at } }, at)))
            return { dispatchId: entry.id, state: 'retained', reason, processAction: 'none',
              note: 'Intent only: the process is untouched. The next worker-release honours this retain once and then clears it' }
          })
        }
        case 'orchestration worker-release': return recoveryCommand(state, 'release')
        case 'orchestration worker-stop': return recoveryCommand(state, 'stop')
        case 'orchestration worker-abandon': return recoveryCommand(state, 'abandon')
        default:
          throw new RuntimeError('unsupported', `Unknown orchestration command ${inv.command}`)
      }
      })
    },
  }
}
