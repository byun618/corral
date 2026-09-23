/**
 * LIFE-410 §4.5/§4.7 — who may report, and whose pane a recovery command may close.
 *
 * Both questions are answered by pure functions over the stored document plus one observation, so
 * the rules can be unit-tested and so the *decision* is separable from the effect it authorises.
 * `index.ts` makes the decision inside the orchestration lane and, when the decision is "close",
 * re-observes the pane immediately before closing it — the serialization plus the generation
 * comparison are together what closes the LIFE-393 S2 check-then-act window.
 *
 * Nothing here is authentication. `HERDR_PANE_ID` is an environment variable the pane's own shell
 * carries; a caller that can already write to the runtime's 0600 socket could state any value. It
 * is proof against *confusion* — a stale preamble, a second worker on the same Task, a report typed
 * into the coordinator's own shell — which is the failure this product actually has (§4.5).
 */
import { createHash } from 'node:crypto'
import { RuntimeError } from '../contracts.js'
import {
  activeDispatch, exhausted, findDispatch,
  type DispatchRecord, type OrchestrationState, type PaneObservation, type RetainReason, type WorkerBlock,
} from './model.js'

/** What the CLI client observed about itself, carried on the invocation (see `contracts.ts`). */
export interface CallerClaim { paneId: string | null; session: string | null }

export type SenderRejectionCode = 'dispatch_not_found' | 'sender_mismatch' | 'stale_dispatch' | 'capability_revoked'
export type SenderVerdict =
  | { ok: true; dispatch: DispatchRecord; worker: WorkerBlock }
  | { ok: false; code: SenderRejectionCode; message: string; resources: Record<string, unknown> }

/** Revocations that end the worker's right to report while the process may still be running. */
const HARD_REVOCATIONS = new Set(['stopped', 'abandoned', 'released'])

/**
 * §4.5, in the order F4 needs.
 *
 * Pairing and pane identity come first, so a report typed in the coordinator's shell is
 * `sender_mismatch` whatever the record says. A capability revoked by `worker-stop`,
 * `worker-abandon` or `worker-release` comes next — those are the cases where corral took the
 * worker's right away while its process lives on. Only then does staleness speak, because a
 * settlement's own revocation (`reason: 'settled'`) must *not* mask the difference between
 * "you named a superseded attempt" (`stale_dispatch`) and "you already reported" — the latter is
 * `transition`'s `illegal_transition` and is left to it, which is why `settled: 'defer'` exists.
 */
export function verifySender(state: OrchestrationState, claim: { taskId: string; dispatchId: string; caller: CallerClaim }, settled: 'reject' | 'defer'): SenderVerdict {
  const dispatch = findDispatch(state, claim.dispatchId)
  if (!dispatch) return {
    ok: false, code: 'dispatch_not_found', message: `No dispatch ${claim.dispatchId}`,
    resources: { dispatchId: claim.dispatchId, taskId: claim.taskId, recovery: 'The preamble names the Dispatch this worker reports under; corral orchestration worker-list shows the Run\'s attempts' },
  }
  const worker = dispatch.worker
  if (dispatch.taskId !== claim.taskId) return {
    ok: false, code: 'sender_mismatch', message: `Dispatch ${dispatch.id} belongs to task ${dispatch.taskId}, not ${claim.taskId}`,
    resources: { dispatchId: dispatch.id, claimedTaskId: claim.taskId, taskId: dispatch.taskId, recovery: 'Send --task-id and --dispatch-id exactly as the preamble spells them' },
  }
  if (worker === null) return {
    ok: false, code: 'sender_mismatch', message: `Dispatch ${dispatch.id} was not started as a worker`,
    resources: { dispatchId: dispatch.id, recovery: 'Only an attempt created by corral orchestration worker-start accepts worker reports' },
  }
  if (claim.caller.paneId === null) return {
    ok: false, code: 'sender_mismatch', message: 'This call did not come from a terminal pane',
    resources: { dispatchId: dispatch.id, expectedPaneId: dispatch.target.paneId, observedPaneId: null, recovery: 'Worker reports are accepted only from the pane the Dispatch was bound to' },
  }
  if (claim.caller.paneId !== dispatch.target.paneId || (worker.paneSession !== null && claim.caller.session !== worker.paneSession)) return {
    ok: false, code: 'sender_mismatch', message: `This pane is not the one dispatch ${dispatch.id} was bound to`,
    resources: { dispatchId: dispatch.id, expectedPaneId: dispatch.target.paneId, observedPaneId: claim.caller.paneId,
      expectedSession: worker.paneSession, observedSession: claim.caller.session,
      recovery: 'Run the report from the worker pane the preamble was delivered to' },
  }
  if (worker.capabilityRevokedReason !== null && HARD_REVOCATIONS.has(worker.capabilityRevokedReason)) return {
    ok: false, code: 'capability_revoked', message: `Reporting capability for ${dispatch.id} was revoked (${worker.capabilityRevokedReason})`,
    resources: { dispatchId: dispatch.id, capabilityRevokedAt: worker.capabilityRevokedAt, capabilityRevokedReason: worker.capabilityRevokedReason,
      recovery: 'This attempt was stopped, abandoned or released; a new attempt needs corral orchestration worker-start' },
  }
  if (settled === 'reject' && dispatch.status !== 'dispatched') return {
    ok: false, code: 'stale_dispatch', message: `Dispatch ${dispatch.id} is ${dispatch.status}`,
    resources: { dispatchId: dispatch.id, dispatchStatus: dispatch.status, settledBy: dispatch.settledBy, settledAt: dispatch.settledAt,
      activeDispatchId: activeDispatch(state, dispatch.taskId)?.id ?? null,
      recovery: 'corral orchestration worker-show --dispatch <ctx> shows how this attempt ended' },
  }
  return { ok: true, dispatch, worker }
}

export function senderError(verdict: Extract<SenderVerdict, { ok: false }>): RuntimeError {
  return new RuntimeError(verdict.code, verdict.message, verdict.resources, 'preflight', 'not_started')
}

// --- recovery (§4.7) -----------------------------------------------------------------------------

export type ReleaseOutcomeReason =
  | 'owned_generation_matches' | 'borrowed' | 'user_requested' | 'user_takeover'
  | 'pane_gone' | 'identity_unproven' | 'observation_failed' | 'abandoned' | 'close_outcome_unknown'

export type ReleaseDecision =
  /** The attempt is still open: recovery is `worker-stop`, not `worker-release` (§4.7). */
  | { kind: 'refuse'; code: 'dispatch_active' }
  /** Already released; the stored record is the answer and nothing is written again. */
  | { kind: 'settled'; }
  | { kind: 'retain'; reason: ReleaseOutcomeReason; clearsRetain: boolean }
  | { kind: 'close' }

export interface ReleaseInput {
  dispatch: DispatchRecord
  observation: PaneObservation
}
/**
 * The whole table, as one function. Read it as: an open attempt is refused; a declared retain wins
 * once and is then spent (F7(d)); a pane this Dispatch does not own is never closed; and an owned
 * pane is closed only when the observation says *this* generation is still there.
 */
export function releaseDecision(input: ReleaseInput): ReleaseDecision {
  const { dispatch, observation } = input
  if (dispatch.status === 'dispatched') return { kind: 'refuse', code: 'dispatch_active' }
  const worker = dispatch.worker
  if (worker === null) return { kind: 'retain', reason: 'borrowed', clearsRetain: false }
  if (worker.release?.state === 'released') return { kind: 'settled' }
  if (worker.retain !== null) return { kind: 'retain', reason: worker.retain.reason, clearsRetain: true }
  if (worker.ownership !== 'owned') return { kind: 'retain', reason: 'borrowed', clearsRetain: false }
  switch (observation.kind) {
    case 'live': return { kind: 'close' }
    case 'pane_gone': return { kind: 'retain', reason: 'pane_gone', clearsRetain: false }
    case 'pty_replaced':
    case 'epoch_changed': return { kind: 'retain', reason: 'identity_unproven', clearsRetain: false }
    case 'unobserved': return { kind: 'retain', reason: 'observation_failed', clearsRetain: false }
    default: return exhausted(observation)
  }
}

export type StopDecision =
  | { kind: 'refuse'; code: 'dispatch_not_active' }
  | { kind: 'refuse'; code: 'identity_unproven' }
  | { kind: 'close' }
/**
 * `worker-stop` cancels an attempt that is still open, and it is the only command that closes a
 * pane corral did not see end. It therefore demands the strongest proof: this Dispatch owns the
 * pane and the pane observed right now is the same generation. Anything weaker does nothing at all
 * — a stop that "might have" killed the wrong pane is worse than a stop that refused.
 */
export function stopDecision(dispatch: DispatchRecord, observation: PaneObservation): StopDecision {
  if (dispatch.status !== 'dispatched') return { kind: 'refuse', code: 'dispatch_not_active' }
  if (dispatch.worker?.ownership !== 'owned' || observation.kind !== 'live') return { kind: 'refuse', code: 'identity_unproven' }
  return { kind: 'close' }
}

// --- worker block helpers -------------------------------------------------------------------------

export const emptyWorker = (input: { launch: 'created' | 'reused'; ownership: 'owned' | 'borrowed'; paneSession: string | null; originDispatchId: string | null }): WorkerBlock => ({
  launch: input.launch,
  ownership: input.ownership,
  originDispatchId: input.originDispatchId,
  ownershipTransferredTo: null,
  paneSession: input.paneSession,
  preambleSha256: null,
  promptRequestId: null,
  lastHeartbeatAt: null,
  capabilityRevokedAt: null,
  capabilityRevokedReason: null,
  retain: null,
  release: null,
})

/**
 * The settled attempt that currently owns this pane, if any. `worker-start --terminal` transfers
 * ownership from it to the new attempt, which is what makes F7(b) true: the old Dispatch's release
 * must not close a pane a newer worker is using.
 */
export function paneOwner(state: OrchestrationState, target: { paneId: string; epoch: string; ptyId: string }): DispatchRecord | undefined {
  return state.dispatches.filter(entry =>
    entry.worker?.ownership === 'owned'
    && entry.worker.release === null
    && entry.target.paneId === target.paneId
    && entry.target.epoch === target.epoch
    && entry.target.ptyId === target.ptyId).at(-1)
}

export const withWorker = (dispatch: DispatchRecord, patch: Partial<WorkerBlock>, at: string): DispatchRecord => {
  const worker = dispatch.worker
  if (worker === null) return dispatch
  return { ...dispatch, worker: { ...worker, ...patch }, updatedAt: at, version: dispatch.version + 1 }
}
export const replaceDispatchRecord = (state: OrchestrationState, entry: DispatchRecord): OrchestrationState =>
  ({ ...state, dispatches: state.dispatches.map(row => row.id === entry.id ? entry : row) })

export const retainReasons: readonly RetainReason[] = ['user_requested', 'user_takeover']
export const isRetainReason = (value: unknown): value is RetainReason => retainReasons.some(reason => reason === value)

// --- the preamble (§4.2) --------------------------------------------------------------------------

export interface PreambleInput {
  corral: string
  runId: string
  taskId: string
  dispatchId: string
  handle: string
}
/**
 * The body a worker pane receives, once. It names the Dispatch it reports under and spells every
 * command with the exact socket this runtime listens on, because a worker pane has no corral
 * configuration of its own — corral cannot put environment variables into a pane (§2), so the only
 * channel the preamble has is its own text.
 *
 * `AskUserQuestion` is called out by name for the same reason Orca calls it out: a Claude Code
 * worker that opens a local prompt is waiting on a human nobody will send, and the coordinator sees
 * a session that is neither working nor done.
 */
export function buildPreamble(input: PreambleInput): string {
  const { corral, runId, taskId, dispatchId, handle } = input
  return [
    'You are a corral worker. A coordinator session started this pane and supervises it through the',
    'corral CLI. You talk to the coordinator only through the commands below — not through Slack,',
    'not through GitHub, not through a local prompt.',
    '',
    `Run: ${runId}`,
    `Task: ${taskId}`,
    `Dispatch: ${dispatchId}`,
    `Terminal: ${handle}`,
    '',
    '=== CLI COMMANDS ===',
    '',
    '```sh',
    '  # Report the outcome (REQUIRED exactly once).',
    '  #',
    '  # RULE: --body is a 3-sentence executive summary (what you did, what you found, what is',
    '  # left). Never send an empty body. If you produced a long artifact, pass --report-path so',
    '  # the coordinator can find it without searching.',
    '  #',
    '  # RULE: send worker_done exactly once, with --outcome succeeded when the requested work is',
    '  # done and --outcome failed when it is not. Never encode failure only in prose and never',
    '  # exit silently. Both --task-id and --dispatch-id are required: a report that names a',
    '  # superseded attempt is refused (stale_dispatch) and stores nothing.',
    `  ${corral} orchestration send \\`,
    '    --type worker_done --subject "<short status>" \\',
    '    --body "<3-sentence summary: what you did, what you found, what is left>" \\',
    `    --task-id ${taskId} --dispatch-id ${dispatchId} --outcome succeeded \\`,
    '    --files-modified "path/a,path/b" \\',
    '    --report-path "<optional: path to the full artifact>"',
    '',
    '  # BEHAVIOR RULE: send a heartbeat every 5 minutes while actively working. The coordinator',
    '  # uses it to tell "still thinking" from "hung". Skip heartbeats only while blocked inside',
    '  # `ask` or `check --block` — those calls are themselves liveness signals.',
    `  ${corral} orchestration send \\`,
    '    --type heartbeat --subject "alive" \\',
    `    --task-id ${taskId} --dispatch-id ${dispatchId} \\`,
    '    --phase "<short: investigating|implementing|reviewing|waiting>"',
    '',
    '  # Ask the coordinator a question and block until it answers.',
    '  #',
    '  # BEHAVIOR RULE (MUST NOT VIOLATE): NEVER use AskUserQuestion or any other local prompt.',
    '  # It opens a dialog the coordinator cannot see and cannot answer, and your session hangs',
    '  # forever. Every interactive question goes through `ask`.',
    '  #',
    '  # `ask` stores the question durably and then blocks. --timeout-ms is at most 600000. If it',
    '  # times out you get state "pending" and a resumeCommand: run that instead of asking again,',
    '  # or a duplicate question is created.',
    `  ${corral} orchestration ask \\`,
    '    --question "<your question>" \\',
    '    --options "<optional,comma,separated>" \\',
    `    --task-id ${taskId} --dispatch-id ${dispatchId} --timeout-ms 600000`,
    '',
    '  # Escalate a blocker before completion, when the coordinator must act before you continue:',
    `  ${corral} orchestration send \\`,
    '    --type escalation --subject "Blocked: <reason>" \\',
    '    --body "<details>" \\',
    `    --task-id ${taskId} --dispatch-id ${dispatchId}`,
    '```',
    '',
    '=== AFTER YOU SEND worker_done ===',
    '',
    'worker_done ends your turn for this Task. Stop, return to an idle prompt and take no further',
    'action: do not start unrelated work, do not poll in a loop, and do not exit the shell. Your',
    'pane stays available. If the coordinator has more for you it delivers a fresh preamble and',
    'TASK block into this same pane under a new Dispatch; treat that as new supervised work and',
    'ignore the settled ids.',
    '',
    'A direct instruction from the user takes precedence over this idle rule.',
  ].join('\n')
}

export const preambleDigest = (body: string): string => createHash('sha256').update(body).digest('hex')
