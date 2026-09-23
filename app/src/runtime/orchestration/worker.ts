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
import { isRecord } from '../../shared/json.js'
import {
  activeDispatch, exhausted, findDispatch,
  type DispatchRecord, type OrchestrationState, type PaneObservation, type RetainReason, type WorkerBlock,
} from './model.js'

/** What the CLI client observed about itself, carried on the invocation (see `contracts.ts`). */
export interface CallerClaim { paneId: string | null; session: string | null }

export type SenderRejectionCode = 'dispatch_not_found' | 'sender_mismatch' | 'stale_dispatch' | 'capability_revoked'
export type SenderVerdict =
  | { ok: true; dispatch: DispatchRecord; worker: WorkerBlock; sessionVerified: boolean }
  | { ok: false; code: SenderRejectionCode; message: string; resources: Record<string, unknown> }

/**
 * What one look at the pane says about the sender's claim.
 *
 * `HERDR_PANE_ID` is a string the caller's environment carries, and the stored record is a string
 * corral wrote down when the attempt began. Comparing the two compares a claim against a memory:
 * both still match after the pane they name has been closed and its id handed to a new PTY, which
 * is exactly when a report is most misleading. The epoch and the pty generation are what make the
 * comparison about the pane that exists *now* — the same three-layer check LIFE-393 uses before it
 * closes anything, asked here before anything is recorded.
 *
 * A pane that is gone means the attempt is over whatever the document still says, so the sender is
 * stale. A pane that answers with a different pty or epoch is a different pane wearing the same id,
 * and so is an unreadable answer: neither may take effect, and `worker_done` least of all — a
 * report corral cannot place is worse than no report, because it settles the Task.
 */
export function observedSender(observation: PaneObservation): { ok: true } | { ok: false; code: SenderRejectionCode; reason: string } {
  switch (observation.kind) {
    case 'live': return { ok: true }
    case 'pane_gone': return { ok: false, code: 'stale_dispatch', reason: 'pane_gone' }
    case 'pty_replaced': return { ok: false, code: 'sender_mismatch', reason: 'pty_replaced' }
    case 'epoch_changed': return { ok: false, code: 'sender_mismatch', reason: 'epoch_changed' }
    case 'unobserved': return { ok: false, code: 'sender_mismatch', reason: observation.reason }
    default: return exhausted(observation)
  }
}

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
export interface SenderClaim { taskId: string; dispatchId: string; caller: CallerClaim; observation: PaneObservation }

export function verifySender(state: OrchestrationState, claim: SenderClaim, settled: 'reject' | 'defer'): SenderVerdict {
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
  // Asked after the record's own answers, not before them: a stopped attempt is `capability_revoked`
  // whether or not its pane outlived the stop, and that says more about why the report is refused
  // than "the pane is gone" does. The observation settles the one question the record cannot.
  const seen = observedSender(claim.observation)
  if (!seen.ok) return {
    ok: false, code: seen.code, message: `corral cannot confirm that pane ${dispatch.target.paneId} is still the one dispatch ${dispatch.id} was bound to (${seen.reason})`,
    resources: { dispatchId: dispatch.id, paneId: dispatch.target.paneId, observation: claim.observation.kind, reason: seen.reason,
      expectedEpoch: dispatch.target.epoch, expectedPtyId: dispatch.target.ptyId,
      recovery: 'corral orchestration worker-show --dispatch <ctx> reports what corral can see of the pane right now' },
  }
  if (settled === 'reject' && dispatch.status !== 'dispatched') return {
    ok: false, code: 'stale_dispatch', message: `Dispatch ${dispatch.id} is ${dispatch.status}`,
    resources: { dispatchId: dispatch.id, dispatchStatus: dispatch.status, settledBy: dispatch.settledBy, settledAt: dispatch.settledAt,
      activeDispatchId: activeDispatch(state, dispatch.taskId)?.id ?? null,
      recovery: 'corral orchestration worker-show --dispatch <ctx> shows how this attempt ended' },
  }
  // The session half of the pane check is only as good as what was recorded: an attempt started
  // where `CORRAL_SESSION` was unset has nothing to compare a caller's session against, so the
  // pane id stands alone. That is a weaker proof than the one this command usually makes, and the
  // caller is told which of the two they got rather than left to assume the stronger one.
  return { ok: true, dispatch, worker, sessionVerified: worker.paneSession !== null }
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
  lead: null,
  prompt: null,
  promptRequestId: null,
  lastHeartbeatAt: null,
  capabilityRevokedAt: null,
  capabilityRevokedReason: null,
  retain: null,
  release: null,
})

const samePane = (entry: DispatchRecord, target: PaneIdentity): boolean =>
  entry.target.paneId === target.paneId && entry.target.epoch === target.epoch && entry.target.ptyId === target.ptyId

export interface PaneIdentity { paneId: string; epoch: string; ptyId: string }

/**
 * The settled attempt that currently owns this pane, if any. `worker-start --terminal` transfers
 * ownership from it to the new attempt, which is what makes F7(b) true: the old Dispatch's release
 * must not close a pane a newer worker is using.
 *
 * A retain is not a handover — `worker-retain` and a release that could not close the pane both
 * leave the attempt still owning a pane that is still there, and only a `released` release ends
 * ownership. Reading `release === null` as "still owns it" missed exactly those two, so a retained
 * pane handed to a second Task transferred nothing and the first attempt's later release closed a
 * pane the second was working in.
 */
export function paneOwner(state: OrchestrationState, target: PaneIdentity): DispatchRecord | undefined {
  return state.dispatches.filter(entry =>
    entry.worker?.ownership === 'owned'
    && entry.worker.release?.state !== 'released'
    && samePane(entry, target)).at(-1)
}

/**
 * The open attempt bound to this pane, whoever owns it. Ownership answers "may corral close this
 * pane"; this answers "is someone working in it", and the two are independent — a borrowed pane
 * has an owner of `undefined` and can still hold a worker mid-task.
 */
export function activePaneDispatch(state: OrchestrationState, target: PaneIdentity): DispatchRecord | undefined {
  return state.dispatches.filter(entry => entry.status === 'dispatched' && samePane(entry, target)).at(-1)
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

// --- the one submission (§4.3) -------------------------------------------------------------------

export type SubmissionVerdict =
  | { kind: 'delivered'; confirmed: 'wait_satisfied' | 'already_present' }
  | { kind: 'unknown'; reason: string }

/**
 * What `terminal prompt --wait accepted` actually said.
 *
 * The command answers with a record, and that record is allowed to report a submission whose
 * arrival was never seen: `outcome: 'unknown'` with `wait: { satisfied: false }` is a body that may
 * or may not be in front of the provider. Reading *no thrown error* as delivery promoted every one
 * of those to `state: 'ready'`, and `ready` is the one thing an attempt in that position may not
 * claim — a coordinator then waits out its own deadline on a worker that was never asked. `queued`
 * is the same hole wearing another name (LIFE-393 D9: queue acceptance is not delivery).
 *
 * Unknown is not failure. The attempt keeps its pane and its record, `promptRequestId` stays null,
 * and the next `worker-start` resumes it — where the duplicate pre-check either finds this exact
 * body already delivered or submits it for the first time. That pairing is what keeps "exactly
 * once" true across an answer corral could not read.
 */
export function submissionVerdict(result: unknown): SubmissionVerdict {
  if (!isRecord(result)) return { kind: 'unknown', reason: 'no_result' }
  if (result.outcome !== 'completed') return { kind: 'unknown', reason: typeof result.outcome === 'string' ? result.outcome : 'no_outcome' }
  const wait = isRecord(result.wait) ? result.wait : null
  if (wait === null || wait.satisfied !== true) return { kind: 'unknown', reason: typeof wait?.reason === 'string' ? wait.reason : 'wait_unsatisfied' }
  return { kind: 'delivered', confirmed: 'wait_satisfied' }
}

export type ResumeDecision = { kind: 'submit' } | { kind: 'refuse'; expected: string; actual: string }

/**
 * Whether a resumed attempt may submit the body this run just built.
 *
 * A Dispatch records the digest of its body when it is created, before anything is sent. A resume
 * rebuilds that body and has to arrive at the same digest, because the whole of "exactly once" is
 * about *one* body: rebuilding from whatever `--spec-file` names today would let the second half of
 * a submission carry text the first half never saw, and the record would still read as one
 * delivery. So the file is not re-read on a resume and the digest is compared instead of trusted.
 *
 * A stored digest of `null` is a document an earlier build wrote — it recorded the digest only
 * after a successful submission, so an unfinished attempt has none. There is nothing to compare it
 * against, and refusing would strand an attempt that is otherwise perfectly resumable.
 */
export function resumeDecision(input: { stored: string | null; rebuilt: string }): ResumeDecision {
  if (input.stored === null || input.stored === input.rebuilt) return { kind: 'submit' }
  return { kind: 'refuse', expected: input.stored, actual: input.rebuilt }
}

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

/**
 * The whole body one Dispatch delivers: preamble, separator, TASK. It lives beside `buildPreamble`
 * so the two places that need it — the digest recorded when the Dispatch is created, and the text
 * submitted to the pane — cannot drift apart. Two spellings of "the body" would make the digest
 * compare something other than what was sent, which is precisely what it exists to prevent.
 */
export const composeBody = (input: PreambleInput & { spec: string }): string =>
  `${buildPreamble(input)}\n\n=== TASK ===\n\n${input.spec}\n`

export const preambleDigest = (body: string): string => createHash('sha256').update(body).digest('hex')
