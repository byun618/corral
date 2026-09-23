/**
 * LIFE-410 §4.3/§4.4 — the Run mailbox: messages, the one outstanding Delivery, and the pure
 * operations over both.
 *
 * Everything here is pure in the same sense `model.ts` is: the caller hands in the whole document
 * and the timestamp and gets a new document back. That is what lets `send --type worker_done`
 * settle the attempt *and* store the message in a single `atomicWrite` — the two changes are two
 * fields of one value, not two writes that have to be ordered (01-criteria 4).
 *
 * Message ids are `msg_<12 hex>` and Delivery ids `delivery_<12 hex>`, matching the Orca shapes the
 * harness already reads. `sequence` is monotone within a Run and is what FIFO means here: it is
 * assigned at store time and never reused, so a Delivery batch has a total order that survives a
 * restart.
 */
import { randomBytes } from 'node:crypto'
import { RuntimeError } from '../contracts.js'
import type { JsonValue } from './model.js'

export const MESSAGE_ID = /^msg_[0-9a-f]{12}$/
export const DELIVERY_ID = /^delivery_[0-9a-f]{12}$/
/** One `check` batch. Beyond this the oldest 50 are delivered and the rest wait for the next ACK. */
export const DELIVERY_BATCH = 50
/**
 * Per-Run ceilings. The mailbox lives in the same single document the records do, so an unbounded
 * Run would make every later write copy an unbounded file. A Run that reaches the ceiling is
 * refused with `message_capacity` rather than pruned: corral never deletes a report a worker made.
 */
export const MAX_MESSAGES_PER_RUN = 10000
export const MAX_SUBJECT = 1024

/** Types a worker may send, plus the two the runtime mints on its own (`question`, `reply`). */
export type WorkerMessageType = 'worker_done' | 'heartbeat' | 'escalation' | 'status'
export type MessageType = WorkerMessageType | 'question' | 'reply'
export const WORKER_MESSAGE_TYPES: readonly WorkerMessageType[] = ['worker_done', 'heartbeat', 'escalation', 'status']
/** What a `check` may hand to the coordinator. A `reply` belongs to the asker, never to the batch. */
export const DELIVERABLE_TYPES: readonly MessageType[] = ['worker_done', 'heartbeat', 'escalation', 'status', 'question']
export const MESSAGE_TYPES: readonly MessageType[] = [...WORKER_MESSAGE_TYPES, 'question', 'reply']
export const isMessageType = (value: unknown): value is MessageType => MESSAGE_TYPES.some(type => type === value)
export const isWorkerMessageType = (value: unknown): value is WorkerMessageType => WORKER_MESSAGE_TYPES.some(type => type === value)
export const isDeliverableType = (value: unknown): value is MessageType => DELIVERABLE_TYPES.some(type => type === value)

export type WorkerOutcome = 'succeeded' | 'failed'
/** Who made the call, as the runtime was able to judge it — never as the caller merely claimed. */
export interface MessageOrigin { kind: 'worker' | 'coordinator'; dispatchId: string | null; paneId: string | null }
export interface QuestionBlock { options: string[]; answeredBy: string | null; answeredAt: string | null }

interface MessageBase {
  id: string
  runId: string
  taskId: string | null
  dispatchId: string | null
  subject: string
  body: string
  payload: JsonValue
  sequence: number
  createdAt: string
  from: MessageOrigin
  /** The Delivery that carried it to the coordinator, once one did. */
  deliveredIn: string | null
  acknowledgedAt: string | null
}
/**
 * The variants carry exactly the fields their type earns. A `worker_done` always has an outcome; a
 * `question` always has its answer slot; a `reply` always names the question it answers. Reading
 * `outcome` off a heartbeat is a type error rather than an `undefined` that travels into a verdict.
 */
export type MessageRecord = MessageBase & (
  | { type: 'worker_done'; outcome: WorkerOutcome; question: null; replyTo: null }
  | { type: 'heartbeat' | 'escalation' | 'status'; outcome: null; question: null; replyTo: null }
  | { type: 'question'; outcome: null; question: QuestionBlock; replyTo: null }
  | { type: 'reply'; outcome: null; question: null; replyTo: string }
)
export interface DeliveryRecord {
  id: string
  runId: string
  messageIds: string[]
  createdAt: string
  acknowledgedAt: string | null
}

export interface MailboxState {
  messages: MessageRecord[]
  deliveries: DeliveryRecord[]
}

const fail = (code: string, message: string, resources?: unknown): never => {
  throw new RuntimeError(code, message, resources, 'preflight', 'not_started')
}

function mint(prefix: 'msg' | 'delivery', taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `${prefix}_${randomBytes(6).toString('hex')}`
    if (!taken.has(id)) return id
  }
  throw new RuntimeError('operation_failed', `Could not mint a free ${prefix} id`)
}

export const findMessage = (state: MailboxState, id: string): MessageRecord | undefined => state.messages.find(entry => entry.id === id)
export const findDelivery = (state: MailboxState, id: string): DeliveryRecord | undefined => state.deliveries.find(entry => entry.id === id)
/** At most one per Run by construction (§4.4): `check` refuses to open a second one. */
export const outstandingDelivery = (state: MailboxState, runId: string): DeliveryRecord | undefined =>
  state.deliveries.find(entry => entry.runId === runId && entry.acknowledgedAt === null)
export const runMessages = (state: MailboxState, runId: string): MessageRecord[] => state.messages.filter(entry => entry.runId === runId)
/** Monotone within the Run, taken from the high-water mark rather than from the count. */
export const nextSequence = (state: MailboxState, runId: string): number =>
  runMessages(state, runId).reduce((high, entry) => Math.max(high, entry.sequence), 0) + 1

export interface AppendInput {
  runId: string
  taskId: string | null
  dispatchId: string | null
  subject: string
  body: string
  payload: JsonValue
  from: MessageOrigin
  at: string
}
type AppendVariant =
  | { type: 'worker_done'; outcome: WorkerOutcome }
  | { type: 'heartbeat' | 'escalation' | 'status' }
  | { type: 'question'; options: string[] }
  | { type: 'reply'; replyTo: string }

/**
 * Add one message. The caller supplies the whole mailbox and receives a new one — nothing is
 * written here, so a command that is about to be refused for another reason leaves no trace.
 */
export function appendMessage<S extends MailboxState>(state: S, input: AppendInput, variant: AppendVariant): { state: S; message: MessageRecord } {
  if (runMessages(state, input.runId).length >= MAX_MESSAGES_PER_RUN)
    return fail('message_capacity', `Run ${input.runId} already holds ${MAX_MESSAGES_PER_RUN} messages`,
      { runId: input.runId, limit: MAX_MESSAGES_PER_RUN, recovery: 'Start a new Run; corral never deletes a stored message to make room' })
  const id = mint('msg', new Set(state.messages.map(entry => entry.id)))
  const base: MessageBase = {
    id, runId: input.runId, taskId: input.taskId, dispatchId: input.dispatchId,
    subject: input.subject, body: input.body, payload: input.payload,
    sequence: nextSequence(state, input.runId), createdAt: input.at, from: input.from,
    deliveredIn: null, acknowledgedAt: null,
  }
  const message: MessageRecord = variant.type === 'worker_done'
    ? { ...base, type: 'worker_done', outcome: variant.outcome, question: null, replyTo: null }
    : variant.type === 'question'
      ? { ...base, type: 'question', outcome: null, question: { options: variant.options, answeredBy: null, answeredAt: null }, replyTo: null }
      : variant.type === 'reply'
        ? { ...base, type: 'reply', outcome: null, question: null, replyTo: variant.replyTo }
        : { ...base, type: variant.type, outcome: null, question: null, replyTo: null }
  return { state: { ...state, messages: [...state.messages, message] }, message }
}

export interface DeliveryPlan {
  /** The batch to report. Empty means there was nothing to deliver. */
  messages: MessageRecord[]
  delivery: DeliveryRecord | null
  replayed: boolean
}
/** What a `check` would hand over, in FIFO order, without creating anything (`--peek` uses this). */
export function pendingBatch(state: MailboxState, runId: string, types: readonly MessageType[]): MessageRecord[] {
  return runMessages(state, runId)
    .filter(entry => entry.deliveredIn === null && types.includes(entry.type))
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, DELIVERY_BATCH)
}
/**
 * §4.4. With a Delivery still outstanding the caller gets *that* batch again — never a wider one.
 * Mixing a newly arrived message into an unacknowledged batch would make the same Delivery id mean
 * two different sets, which is exactly what the "latest ack id only" rule exists to prevent.
 */
export function openDelivery<S extends MailboxState>(state: S, runId: string, types: readonly MessageType[], at: string): { state: S; plan: DeliveryPlan } {
  const outstanding = outstandingDelivery(state, runId)
  if (outstanding) {
    const messages = outstanding.messageIds.flatMap(id => { const found = findMessage(state, id); return found ? [found] : [] })
    return { state, plan: { messages, delivery: outstanding, replayed: true } }
  }
  const batch = pendingBatch(state, runId, types)
  if (!batch.length) return { state, plan: { messages: [], delivery: null, replayed: false } }
  const delivery: DeliveryRecord = { id: mint('delivery', new Set(state.deliveries.map(entry => entry.id))), runId, messageIds: batch.map(entry => entry.id), createdAt: at, acknowledgedAt: null }
  const ids = new Set(delivery.messageIds)
  const messages = state.messages.map(entry => ids.has(entry.id) ? { ...entry, deliveredIn: delivery.id } : entry)
  return { state: { ...state, messages, deliveries: [...state.deliveries, delivery] }, plan: { messages: batch.map(entry => ({ ...entry, deliveredIn: delivery.id })), delivery, replayed: false } }
}

/**
 * Acknowledge the Delivery that is currently outstanding. Any other id — one already acknowledged,
 * one from a previous batch, one that never existed — is `delivery_stale` and changes nothing
 * (§4.4, Pub/Sub's "only the latest ack id is valid").
 */
export function acknowledgeDelivery<S extends MailboxState>(state: S, runId: string, deliveryId: string, at: string): { state: S; delivery: DeliveryRecord } {
  const outstanding = outstandingDelivery(state, runId)
  if (!outstanding || outstanding.id !== deliveryId) {
    const known = findDelivery(state, deliveryId)
    return fail('delivery_stale', `Delivery ${deliveryId} is not the outstanding batch of run ${runId}`,
      { deliveryId, runId, outstandingDeliveryId: outstanding?.id ?? null,
        deliveryState: known === undefined ? 'unknown' : known.acknowledgedAt === null ? 'other_run' : 'acknowledged',
        recovery: 'corral orchestration check --json reports the deliveryId to acknowledge; only that id is accepted' })
  }
  const acknowledged: DeliveryRecord = { ...outstanding, acknowledgedAt: at }
  const ids = new Set(acknowledged.messageIds)
  return {
    state: {
      ...state,
      messages: state.messages.map(entry => ids.has(entry.id) ? { ...entry, acknowledgedAt: at } : entry),
      deliveries: state.deliveries.map(entry => entry.id === acknowledged.id ? acknowledged : entry),
    },
    delivery: acknowledged,
  }
}

/**
 * Answer a question exactly once. `not_a_question` and `already_answered` are both effect-free: a
 * second `reply` must not overwrite the answer the worker may already have read.
 */
export function answerQuestion<S extends MailboxState>(state: S, questionId: string, input: { body: string; subject: string; from: MessageOrigin; at: string }): { state: S; question: MessageRecord; reply: MessageRecord } {
  const target = findMessage(state, questionId)
  if (!target) return fail('message_not_found', `No message ${questionId}`, { messageId: questionId, recovery: 'corral orchestration inbox --type question lists the questions this Run holds' })
  if (target.type !== 'question') return fail('not_a_question', `Message ${questionId} is a ${target.type}, not a question`,
    { messageId: questionId, type: target.type, recovery: 'corral orchestration inbox --type question lists the messages reply accepts' })
  if (target.question.answeredBy !== null) return fail('already_answered', `Question ${questionId} was answered at ${String(target.question.answeredAt)}`,
    { messageId: questionId, answeredBy: target.question.answeredBy, answeredAt: target.question.answeredAt, recovery: 'corral orchestration request-show or inbox shows the answer that already stands' })
  const appended = appendMessage(state, {
    runId: target.runId, taskId: target.taskId, dispatchId: target.dispatchId,
    subject: input.subject, body: input.body, payload: null, from: input.from, at: input.at,
  }, { type: 'reply', replyTo: target.id })
  const question: MessageRecord = { ...target, question: { ...target.question, answeredBy: appended.message.id, answeredAt: input.at } }
  return {
    state: { ...appended.state, messages: appended.state.messages.map(entry => entry.id === question.id ? question : entry) },
    question, reply: appended.message,
  }
}

/** The answer to a question, if one has been stored. Used by `ask` and by `ask --resume`. */
export function answerOf(state: MailboxState, question: MessageRecord): MessageRecord | null {
  if (question.type !== 'question' || question.question.answeredBy === null) return null
  return findMessage(state, question.question.answeredBy) ?? null
}

/** `--types worker_done,question`. An unknown name is refused rather than silently matching nothing. */
export function parseTypes(value: string): MessageType[] {
  const parts = value.split(',').map(part => part.trim()).filter(part => part.length > 0)
  if (!parts.length) throw new RuntimeError('invalid_argument', `--types must name at least one of ${DELIVERABLE_TYPES.join('|')}`)
  for (const part of parts) if (!isDeliverableType(part)) throw new RuntimeError('invalid_argument', `--types must be a comma-separated subset of ${DELIVERABLE_TYPES.join('|')}: ${part}`)
  return [...new Set(parts.filter(isDeliverableType))]
}
