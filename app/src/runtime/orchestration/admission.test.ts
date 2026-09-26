/**
 * LIFE-410 r3 — the admission rules, measured against the real module.
 *
 * `orchestration.test.ts` tests the pure functions this module is built from. The rules this file
 * is about are not in any one of them: they are about *when* a judgement is made relative to the
 * document lane, the receipt and the effect, and the only way to state them is to drive the module
 * itself with the terminal boundary replaced. The mock below is the one the r1 reviewers used to
 * find V21–V25 and V29, kept deliberately close to theirs so the same shapes are being measured —
 * their file asserts the defects are visible, this one asserts they are not.
 *
 * r3: the terminal boundary now runs the two mutating child calls through the *real* `Receipts`.
 * That is not decoration — V37 was a count read out of the wrong place that a wrapper-free mock
 * could never see, and V35's whole answer to "was this body already submitted?" is the receipt the
 * earlier run's request id names. A mock that skips receipts cannot measure either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RuntimeError } from '../contracts.js'
import { OrchestrationStore } from './store.js'
import { createRun, createTask, emptyState } from './model.js'
import { TerminalBackend, type TerminalIdentity } from '../../main/adapter/index.js'
import { PROMPT_LEAD, bodyIdentity, sameBody } from '../terminal/agent.js'
import { isRecord } from '../../shared/json.js'
import type { MessageRecord } from './messages.js'


interface MockTerminal {
  mode: 'unknown' | 'completed' | 'refuse'
  /** What `terminal send` does with the lead: deliver it, refuse before any effect, or take it and never answer. */
  sendMode: 'ok' | 'refused' | 'lost'
  bodies: string[]
  buffer: string
  calls: { command: string; flags: Record<string, string | boolean>; stdin?: string }[]
  rows: string[]
  live: boolean
  sweeps: number
  duplicateCount: number
  screen: string
  waitSatisfied: boolean
  promptDelayMs: number
  /** r4. The cursor moved under the count: one match, and `terminal prompt` still calls it unknown. */
  cursorInvalidated: boolean
  /** r4. The row is there; the record `confirmPrompt` read at its own deadline had not caught up. */
  recordLag: boolean
  /** LIFE-417 r6. How many times `terminal create` had to re-knock past `agent_pane_busy` (R5-2). */
  agentRetries: number
}
const mock = vi.hoisted((): MockTerminal => ({
  mode: 'unknown', sendMode: 'ok', bodies: [], buffer: '', calls: [], rows: [], live: true, sweeps: 0,
  duplicateCount: 1, screen: '', waitSatisfied: true, promptDelayMs: 0,
  cursorInvalidated: false, recordLag: false, agentRetries: 0,
}))
vi.mock('../terminal/index.js', async importOriginal => {
  const { Receipts } = await import('../terminal/receipts.js')
  const { classifyCount } = await import('../terminal/agent.js')
  const actual = await importOriginal<typeof import('../terminal/index.js')>()
  return {
    ...actual,
    terminalModule: (userData: string) => {
      // The real module wraps every mutating command in this, and the wrapper is load-bearing here:
      // it is what a resumed run reads instead of submitting again (V35), and it is what re-packs a
      // refusal so the duplicate count moves under `detail` (V37).
      const receipts = new Receipts(userData, 0)
      const effect = async (inv: { command: string; flags: Record<string, string | boolean>; stdin?: string }) => {
        if (inv.command === 'terminal send') {
          if (mock.sendMode === 'refused') throw new RuntimeError('agent_not_ready', 'refused before any effect', null, 'preflight', 'not_started')
          mock.buffer += String(inv.flags.text)
          mock.screen = mock.buffer
          // A backend that took the text and never answered: the effect happened, the outcome did not.
          if (mock.sendMode === 'lost') throw new RuntimeError('backend_unavailable', 'no answer from the backend', null, 'backend')
          return { outcome: 'completed' }
        }
        await new Promise(resolve => setTimeout(resolve, mock.promptDelayMs))
        const body = String(inv.stdin)
        if (mock.bodies.includes(body)) throw new RuntimeError('prompt_already_delivered', 'Already present', { matchCount: mock.duplicateCount }, 'preflight', 'not_started')
        if (mock.mode === 'refuse') throw new RuntimeError('agent_not_ready', 'gate changed', null, 'preflight', 'not_started')
        const row = `${mock.buffer}\n\n<pasted_content id="one">\n${body.trimEnd()}\n</pasted_content id="one">`
        mock.rows.push(row)
        mock.buffer = ''
        mock.screen = ''
        if (mock.mode === 'unknown') mock.bodies.push(body)
        const matches = sameBody(bodyIdentity(body), row)
        // The provider's own record, counted the way `terminal prompt` counts it: how many rows hold
        // this exact body. A row the lead never reached does not match, and that is what 0 means.
        const matchCount = mock.rows.filter(entry => sameBody(bodyIdentity(body), entry)).length
        // r4 (V45·V46). The number alone was never the answer: `terminal prompt` reports it beside
        // its own verdict, and the verdict is what the real `classifyCount` makes of it. `recordLag`
        // is the provider that has not written its record by the time the deadline runs out — the
        // row exists, the count taken at that instant is 0 — and `cursorInvalidated` is the count
        // that landed on one match the child cannot prove is *this* submission's.
        const counted = mock.recordLag ? 0 : matchCount
        const unavailableReason = classifyCount(
          { matchCount: counted, naiveCount: counted, cursorInvalidated: mock.cursorInvalidated, assistantAfter: false, hookBlocked: false, scanned: [] },
          counted === 0 && mock.recordLag ? 0 : 1)
        const satisfied = mock.mode !== 'unknown' && matches && unavailableReason === null
        return {
          outcome: satisfied ? 'completed' : 'unknown',
          wait: { requested: 'accepted', satisfied, reason: satisfied ? null : 'deadline' },
          record: { path: `${userData}/record.jsonl`, matchCount: counted, naiveCount: counted, assistantAfter: false,
            cursorInvalidated: mock.cursorInvalidated, unavailableReason },
        }
      }
      return {
        specs: [], validate: () => {}, execute: async (inv: { command: string; flags: Record<string, string | boolean>; stdin?: string }) => {
          mock.calls.push(inv)
          const terminal = { handle: 't1.review', epoch: 'epoch', ptyId: 'pty', paneId: 'pane' }
          if (inv.command === 'terminal create') return { terminal, agent: { kind: 'claude' }, stages: { agent: { status: 'completed', retries: mock.agentRetries } } }
          if (inv.command === 'terminal show') return { terminal, agent: { kind: 'claude' } }
          if (inv.command === 'terminal wait') return { satisfied: mock.waitSatisfied, agent: { phase: 'launching' } }
          if (inv.command === 'terminal read') return { text: mock.screen }
          if (inv.command === 'terminal close') { mock.live = false; return { outcome: 'completed' } }
          if (inv.command === 'terminal send' || inv.command === 'terminal prompt') return receipts.run({ ...inv, args: [], cwd: userData }, () => effect(inv))
          throw Error(inv.command)
        },
      }
    },
  }
})
const { orchestrationModule, withDocumentLane } = await import('./index.js')

interface Harness {
  dir: string
  mod: ReturnType<typeof orchestrationModule>
  store: OrchestrationStore
  ctx: () => Parameters<ReturnType<typeof orchestrationModule>['execute']>[1]
  call: (command: string, flags?: Record<string, string | boolean | undefined>, caller?: { paneId: string | null; session: string | null }) => Promise<unknown>
  start: (flags?: Record<string, string | boolean | undefined>) => Promise<Record<string, unknown>>
  task: string
  newTask: (spec: string) => string
  receiptDigest: () => string
}
const LIVE_PANE: TerminalIdentity = { epoch: 'epoch', ptyId: 'pty', paneId: 'pane', tabId: 'tab', workspaceId: 'w', path: '/tmp', repo: '/tmp', title: 'admission' }
/** The dispatch id out of a `worker-start` envelope, stated as the string it is. */
const idOf = (value: Record<string, unknown>): string => {
  if (typeof value.dispatchId !== 'string') throw Error(`no dispatchId: ${JSON.stringify(value)}`)
  return value.dispatchId
}
/** A Run's mailbox filled to its ceiling, in the shape the product writes. No assertion needed. */
const atCeiling = (runId: string, count: number): MessageRecord[] => Array.from({ length: count }, (_, index) => ({
  id: `msg_${index.toString(16).padStart(12, '0')}`, runId, taskId: null, dispatchId: null,
  type: 'status', subject: 'filler', body: '', payload: {}, sequence: index + 1,
  createdAt: new Date().toISOString(), from: { kind: 'coordinator', dispatchId: null, paneId: null },
  deliveredIn: null, acknowledgedAt: null, outcome: null, question: null, replyTo: null,
}))
const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw Error(`not a record: ${JSON.stringify(value)}`)
  return value
}
async function setup(): Promise<Harness> {
  mock.mode = 'unknown'; mock.sendMode = 'ok'; mock.buffer = ''; mock.bodies = []; mock.calls = []; mock.rows = []
  mock.live = true; mock.sweeps = 0; mock.duplicateCount = 1; mock.screen = ''; mock.waitSatisfied = true; mock.promptDelayMs = 0
  mock.cursorInvalidated = false; mock.recordLag = false; mock.agentRetries = 0
  process.env.CORRAL_BACKEND_SOCKET = '/tmp/mock'
  delete process.env.CORRAL_SESSION
  vi.spyOn(TerminalBackend.prototype, 'epoch').mockResolvedValue('epoch')
  vi.spyOn(TerminalBackend.prototype, 'list').mockImplementation(async () => {
    mock.sweeps++
    return mock.live ? [LIVE_PANE] : []
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l410-admission-'))
  const run = createRun(emptyState(), 'review', new Date().toISOString())
  const made = createTask(run.state, { runId: run.run.id, spec: 'task body', title: null, deps: [], at: new Date().toISOString() })
  const store = new OrchestrationStore(dir)
  store.write(made.state)
  const mod = orchestrationModule(dir)
  await new Promise(resolve => setTimeout(resolve, 5))
  const ctx = () => ({ runtimeId: 'runtime', instanceId: 'instance', userData: dir, signal: new AbortController().signal, deadlineAt: Date.now() + 20000, remote: false })
  const call = (command: string, flags: Record<string, string | boolean | undefined> = {}, caller?: { paneId: string | null; session: string | null }) =>
    mod.execute({ command: `orchestration ${command}`, flags: { ...flags, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: dir, caller }, ctx())
  const newTask = (spec: string): string => {
    const current = store.read()
    const next = createTask(current, { runId: current.currentRunId!, spec, title: null, deps: [], at: new Date().toISOString() })
    store.write(next.state)
    return next.task.id
  }
  const receipts = path.join(dir, 'runtime/terminal-receipts')
  const receiptDigest = (): string => (fs.existsSync(receipts) ? fs.readdirSync(receipts).sort() : []).join('|')
  return {
    dir, mod, store, ctx, call, task: made.task.id, newTask, receiptDigest,
    start: async (flags: Record<string, string | boolean | undefined> = {}) => asRecord(await call('worker-start', { task: made.task.id, agent: 'claude', worktree: dir, ...flags })),
  }
}
afterEach(() => { vi.restoreAllMocks(); delete process.env.CORRAL_BACKEND_SOCKET })
const REUSE = { agent: undefined, worktree: undefined, terminal: 't1.review' }
/** An attempt that submitted once and then lost the claim record, so the next run meets the pre-check. */
const forgetTheSubmission = (f: Harness): void => {
  const current = f.store.read()
  f.store.write({ ...current, dispatches: current.dispatches.map(entry =>
    entry.worker === null ? entry : { ...entry, worker: { ...entry.worker, prompt: null } }) })
}

describe('LIFE-417 R5-2 — a successful worker-start carries the create\'s agent stage', () => {
  // The failure branch already reported `agentStage`; the success one did not, so a coordinator
  // reading a receipt could not tell a launch that re-knocked past `agent_pane_busy` from one that
  // went through first time, and had to fall back to `corral.ndjson`.
  it('a launch reports the retry count the create stage carried', async () => {
    const f = await setup()
    mock.mode = 'completed'; mock.agentRetries = 2
    const started = await f.start()
    expect(started.state).toBe('ready')
    expect(started.launch).toBe('created')
    expect(asRecord(started.agentStage)).toEqual({ status: 'completed', retries: 2 })
  })

  it('a reused pane reports no agent stage — there is no create behind it', async () => {
    const f = await setup()
    mock.mode = 'completed'
    const first = await f.start()
    await f.call('send', { type: 'worker_done', subject: 'done', 'task-id': f.task, 'dispatch-id': idOf(first), outcome: 'succeeded' }, { paneId: 'pane', session: null })
    const reused = asRecord(await f.call('worker-start', { task: f.newTask('second'), ...REUSE }))
    expect(reused.state).toBe('ready')
    expect(reused.launch).toBe('reused')
    expect('agentStage' in reused).toBe(false)
  })
})

describe('V21 — the active check and the ownership decision are made in the lane that writes', () => {
  it('two Tasks racing for one pane leave one attempt, not two', async () => {
    const f = await setup()
    const other = f.newTask('second')
    const results = await Promise.all([f.start(REUSE), f.start({ ...REUSE, task: other })])
    expect(f.store.read().dispatches.filter(entry => entry.status === 'dispatched')).toHaveLength(1)
    // The loser is refused in the commit lane, which is past its receipt — a race is not something
    // preflight can foresee — so it comes back as a stage failure, not a thrown rejection. What
    // matters is that it created nothing: no attempt, and no claim on a pane it does not hold.
    const failed = results.filter(entry => entry.state === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.stage).toBe('dispatch')
    expect(asRecord(asRecord(failed[0]!.stages).dispatch).error).toBe('dispatch_active')
    expect(failed[0]!.dispatchId).toBeNull()
    expect(failed[0]!.residualResources).toEqual([])
  })

  it('two handovers racing for one settled pane leave one owner, so no stop can close another attempt\'s pane', async () => {
    const f = await setup()
    const original = await f.start()
    await f.call('send', { type: 'worker_done', subject: 'done', 'task-id': f.task, 'dispatch-id': idOf(original), outcome: 'succeeded' }, { paneId: 'pane', session: null })
    const one = f.newTask('A'), two = f.newTask('B')
    const started = await Promise.all([f.start({ ...REUSE, task: one }), f.start({ ...REUSE, task: two })])
    const active = f.store.read().dispatches.filter(entry => entry.status === 'dispatched')
    expect(active).toHaveLength(1)
    expect(active[0]!.worker?.ownership).toBe('owned')
    // The one that lost the race never became an attempt, so there is no second owner to strand —
    // and a `worker-stop` of the winner is therefore the only thing that can close this pane.
    expect(started.filter(entry => entry.state === 'failed')).toHaveLength(1)
    expect(f.store.read().dispatches.filter(entry => entry.worker?.ownership === 'owned' && entry.status === 'dispatched')).toHaveLength(1)
  })
})

describe('V22/V34/V35/V36 — one lead, one body, and a resume that reads receipts instead of repeating', () => {
  it('a resume recovers the earlier submission from its receipt rather than submitting again', async () => {
    const f = await setup()
    const first = await f.start()
    expect(first.state).toBe('incomplete')
    const second = await f.start()
    expect(second.dispatchId).toBe(first.dispatchId)
    expect(second.state).toBe('ready')
    // One lead and one body for the Dispatch — the second run made no call of its own at all.
    expect(mock.calls.filter(entry => entry.command === 'terminal send')).toHaveLength(1)
    expect(mock.calls.filter(entry => entry.command === 'terminal prompt')).toHaveLength(1)
    expect(mock.rows).toHaveLength(1)
    const stored = f.store.read().dispatches[0]!.worker
    expect(stored?.lead?.requestId).toEqual(expect.stringMatching(/^r1\./))
    // …and the delivery is recorded under the id that actually submitted it, not this run's.
    expect(stored?.promptRequestId).toBe(stored?.prompt?.requestId)
  })

  it('V34 — two resumes racing for an attempt whose lead was never typed type it once', async () => {
    const f = await setup()
    mock.waitSatisfied = false                       // the first run stops at the ready gate
    const first = await f.start()
    expect(first.state).toBe('incomplete')
    expect(f.store.read().dispatches[0]!.worker?.lead).toBeNull()
    mock.waitSatisfied = true
    mock.promptDelayMs = 20                          // hold the winner inside the body so both leads would land
    const both = await Promise.all([f.start(REUSE), f.start(REUSE)])
    expect(mock.calls.filter(entry => entry.command === 'terminal send')).toHaveLength(1)
    expect(mock.rows.filter(row => row.startsWith(PROMPT_LEAD + PROMPT_LEAD))).toHaveLength(0)
    expect(mock.calls.filter(entry => entry.command === 'terminal prompt').length).toBeLessThanOrEqual(1)
    // Whichever of the two took the claim, neither ends anywhere but the two honest places: the
    // one that made the submission reports it unconfirmed, the one that made no effect at all
    // reports that it could not prove the other's. Nothing reports a delivery it did not see.
    const stopped = both.filter(entry => entry.state !== 'ready')
    expect(stopped.length).toBeGreaterThan(0)
    for (const entry of stopped) expect(['dispatch_input_unprovable', 'dispatch_input_unconfirmed']).toContain(entry.stage)
    expect(mock.rows.length).toBeLessThanOrEqual(1)
  })

  it('V36 — a send that was taken and never answered keeps its record, and no resume types a second lead', async () => {
    const f = await setup()
    mock.sendMode = 'lost'
    const first = await f.start()
    expect(first.state).toBe('incomplete')
    expect(asRecord(asRecord(first.stages).input).error).toBe('backend_unavailable')
    // The text reached the pane; only the answer was lost. The record stays.
    expect(f.store.read().dispatches[0]!.worker?.lead).not.toBeNull()
    expect(mock.buffer).toBe(PROMPT_LEAD)
    mock.sendMode = 'ok'; mock.mode = 'completed'
    const second = await f.start(REUSE)
    expect(mock.calls.filter(entry => entry.command === 'terminal send')).toHaveLength(1)
    expect(second.state).toBe('incomplete')
    expect(second.stage).toBe('dispatch_input_unprovable')
    expect(asRecord(asRecord(second.stages).input).reason).toBe('lead_outcome_unknown')
  })

  it('V36 control — a send refused before any effect gives the claim back, and the retry types one lead', async () => {
    const f = await setup()
    mock.sendMode = 'refused'
    await f.start()
    expect(f.store.read().dispatches[0]!.worker?.lead).toBeNull()
    mock.sendMode = 'ok'; mock.mode = 'completed'
    const second = await f.start(REUSE)
    expect(mock.calls.filter(entry => entry.command === 'terminal send')).toHaveLength(2)
    expect(mock.rows[0]!.startsWith(PROMPT_LEAD)).toBe(true)
    expect(mock.rows[0]!.startsWith(PROMPT_LEAD + PROMPT_LEAD)).toBe(false)
    expect(second.state).toBe('ready')
  })

  it('V35·V46 — a body the provider record does not hold is not submitted again, and is not called a failure either', async () => {
    const f = await setup()
    mock.mode = 'refuse'                             // lead typed, body refused before any effect
    await f.start()
    expect(f.store.read().dispatches[0]!.worker?.lead).not.toBeNull()
    expect(f.store.read().dispatches[0]!.worker?.prompt).toBeNull()
    mock.mode = 'completed'
    mock.buffer = ''; mock.screen = ''               // a person pressed Ctrl-U, as corral itself advises
    const second = await f.start(REUSE)
    // corral cannot see an input line, so this run submits once — and the row it makes is not this
    // body, which is what the next run finds out from the receipt without submitting anything.
    expect(mock.rows).toHaveLength(1)
    expect(mock.rows[0]!.startsWith(PROMPT_LEAD)).toBe(false)
    expect(second.stage).toBe('dispatch_input_unconfirmed')
    const third = await f.start(REUSE)
    // r4. The count in that receipt is 0, and the same receipt says why the count is not proof
    // (`unavailableReason`). r3 read the 0 alone and ended the attempt at `dispatch_input_corrupted`
    // — a verdict corral cannot support, because the same 0 is what a provider that has not written
    // its record yet produces. The attempt stops where it can still be resumed from.
    expect(third.state).toBe('incomplete')
    expect(third.stage).toBe('dispatch_input_unprovable')
    const reported = asRecord(asRecord(third.stages).input)
    expect(reported.reason).toBe('submission_unconfirmed')
    expect(reported.matchCount).toBe(0)
    expect(reported.unavailableReason).toBe('ambiguous')
    expect(mock.rows).toHaveLength(1)                // …and nothing was submitted a second time
    expect(f.store.read().dispatches[0]!.worker?.promptRequestId).toBeNull()
    expect(third.residualResources).toEqual([expect.objectContaining({ kind: 'dispatch' })])
    const fourth = await f.start(REUSE)
    expect(fourth.stage).toBe('dispatch_input_unprovable')
    expect(mock.rows).toHaveLength(1)
  })

  it('V45 — a receipt that counted one match on an invalidated cursor is not a delivery', async () => {
    const f = await setup()
    mock.cursorInvalidated = true                    // the count is 1; the child still calls it unknown
    const first = await f.start()
    expect(first.state).toBe('incomplete')
    expect(first.stage).toBe('dispatch_input_unconfirmed')
    expect(mock.rows).toHaveLength(1)
    const intent = f.store.read().dispatches[0]!.worker!.prompt!
    const receipt = asRecord(JSON.parse(fs.readFileSync(path.join(f.dir, 'runtime/terminal-receipts', intent.requestId + '.json'), 'utf8')))
    const record = asRecord(asRecord(receipt.result).record)
    expect(record.matchCount).toBe(1)
    expect(record.cursorInvalidated).toBe(true)
    expect(record.unavailableReason).toBe('ambiguous')
    // The resume reads that receipt. r3 saw `matchCount >= 1` and reported `ready`; the child's own
    // verdict says the row it counted cannot be proved to be this submission's.
    const second = await f.start(REUSE)
    expect(second.state).toBe('incomplete')
    expect(second.stage).toBe('dispatch_input_unprovable')
    const reported = asRecord(asRecord(second.stages).input)
    expect(reported.reason).toBe('submission_unconfirmed')
    expect(reported.unavailableReason).toBe('ambiguous')
    expect(reported.cursorInvalidated).toBe(true)
    expect(reported.matchCount).toBe(1)
    expect(f.store.read().dispatches[0]!.worker?.promptRequestId).toBeNull()
    expect(mock.rows).toHaveLength(1)
    // …and the record the child proved is still the one thing that recovers a delivery: with the
    // cursor whole, the same world recovers the body through the duplicate pre-check.
    mock.cursorInvalidated = false
    forgetTheSubmission(f)
    mock.mode = 'completed'
    const third = await f.start(REUSE)
    expect(third.state).toBe('ready')
    expect(asRecord(asRecord(third.stages).input).delivery).toBe('already_present')
  })

  it('V46 — a record that catches up after the deadline leaves the attempt resumable, not failed', async () => {
    const f = await setup()
    mock.recordLag = true                            // the row is written; the count taken at the deadline is 0
    const first = await f.start()
    expect(first.stage).toBe('dispatch_input_unconfirmed')
    expect(mock.rows).toHaveLength(1)
    const intent = f.store.read().dispatches[0]!.worker!.prompt!
    const receipt = asRecord(JSON.parse(fs.readFileSync(path.join(f.dir, 'runtime/terminal-receipts', intent.requestId + '.json'), 'utf8')))
    const record = asRecord(asRecord(receipt.result).record)
    expect(record.matchCount).toBe(0)
    expect(record.unavailableReason).toBe('not_found')
    mock.recordLag = false                           // the provider has written it; nothing else changed
    const second = await f.start(REUSE)
    expect(second.state).toBe('incomplete')
    expect(second.stage).toBe('dispatch_input_unprovable')
    const third = await f.start(REUSE)
    expect(third.stage).toBe('dispatch_input_unprovable')
    expect(mock.rows).toHaveLength(1)                // no resume submits the body a second time
    // The limit this round keeps, said out loud: corral does not count again on a resume, so the
    // attempt stays here. What recovers it is the duplicate pre-check on a fresh claim — the same
    // world, the same row, the claim record taken away — and that path finds the body exactly once.
    forgetTheSubmission(f)
    const fourth = await f.start(REUSE)
    expect(fourth.state).toBe('ready')
    expect(asRecord(asRecord(fourth.stages).input).delivery).toBe('already_present')
    expect(asRecord(fourth.input).matchCount).toBe(1)
    expect(mock.rows).toHaveLength(1)
  })

  it('V47 — a receipt that cannot be read is reported in an envelope, not thrown', async () => {
    const f = await setup()
    const first = await f.start()
    expect(first.stage).toBe('dispatch_input_unconfirmed')
    const intent = f.store.read().dispatches[0]!.worker!.prompt!
    fs.writeFileSync(path.join(f.dir, 'runtime/terminal-receipts', intent.requestId + '.json'), '{"hash":"a","state":"comple')
    let thrown: unknown = null
    let envelope: Record<string, unknown> | null = null
    try { envelope = asRecord(await f.start(REUSE)) } catch (error) { thrown = error }
    expect(thrown).toBeNull()
    expect(envelope).not.toBeNull()
    expect(envelope!.state).toBe('incomplete')
    expect(envelope!.stage).toBe('dispatch_input_unprovable')
    const reported = asRecord(asRecord(envelope!.stages).input)
    expect(reported.reason).toBe('receipt_unreadable')
    expect(reported.receipt).toBe('storage_corrupt')
    expect(envelope!.residualResources).toEqual([expect.objectContaining({ kind: 'dispatch' })])
    expect(mock.rows).toHaveLength(1)                // the unreadable receipt costs no second submission
    expect(mock.calls.filter(entry => entry.command === 'terminal prompt')).toHaveLength(1)
  })

  it('V45 control — only a real null reads as proven, and a receipt corral did not write does not', async () => {
    const f = await setup()
    await f.start()
    const intent = f.store.read().dispatches[0]!.worker!.prompt!
    const file = path.join(f.dir, 'runtime/terminal-receipts', intent.requestId + '.json')
    const receipt = asRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
    const result = asRecord(receipt.result)
    // A receipt whose verdict is not a verdict: `null` is the only value that means proven, and
    // anything else is a file corral did not write.
    fs.writeFileSync(file, JSON.stringify({ ...receipt,
      result: { ...result, record: { ...asRecord(result.record), matchCount: 1, unavailableReason: 42 } } }))
    const second = await f.start(REUSE)
    expect(second.state).toBe('incomplete')
    expect(second.stage).toBe('dispatch_input_unprovable')
    expect(asRecord(asRecord(second.stages).input).reason).toBe('submission_unconfirmed')
    expect(mock.rows).toHaveLength(1)
  })

  it('V38 — the screen is a diagnostic: it never reports an input line as clear, and never drives a send', async () => {
    const f = await setup()
    await f.start()
    mock.screen = `> ${PROMPT_LEAD}\n──────────\n? for shortcuts`   // the lead, under a TUI footer
    const second = await f.start()
    expect(second.state).toBe('ready')
    expect(second.lead).toMatchObject({ checked: true, present: true })
    expect(second.residualResources).toEqual([expect.objectContaining({ kind: 'input_line' })])
    const g = await setup()
    await g.start()
    mock.screen = 'a screen with no lead on it at all'
    const other = await g.start()
    // Not `false`: corral cannot prove an input line is clear, and it does not act on the answer.
    expect(other.lead).toMatchObject({ checked: true, present: null, reason: 'screen_is_not_the_input_line' })
    expect(mock.calls.filter(entry => entry.command === 'terminal send')).toHaveLength(1)
  })
})

describe('V23/V37 — already_present is a delivery only when it matched exactly once, read through the real wrapper', () => {
  it('one match through the receipt wrapper is this attempt\'s delivery', async () => {
    const f = await setup()
    await f.start()
    forgetTheSubmission(f)
    const second = await f.start()
    expect(second.state).toBe('ready')
    expect(asRecord(asRecord(second.stages).input).delivery).toBe('already_present')
    // The count was read out of the shape `Receipts` actually produces: the child's own resources
    // sit under `detail`, which is exactly where r2 did not look.
    const input = asRecord(second.input)
    expect(input.matchCount).toBe(1)
    expect(asRecord(asRecord(input.detail).detail).matchCount).toBe(1)
  })

  it('two matches leave the attempt unconfirmed instead of ready', async () => {
    const f = await setup()
    await f.start()
    forgetTheSubmission(f)
    mock.duplicateCount = 2
    const second = await f.start()
    expect(second.state).toBe('incomplete')
    expect(second.stage).toBe('dispatch_input_unconfirmed')
    expect(asRecord(asRecord(second.stages).input).reason).toBe('duplicate_submissions')
    expect(f.store.read().dispatches[0]!.worker?.promptRequestId).toBeNull()
  })
})

describe('V24 — admission observes inside the lane, once', () => {
  it('one send costs one backend sweep', async () => {
    const f = await setup()
    const started = await f.start()
    const before = mock.sweeps
    await f.call('send', { type: 'heartbeat', subject: 'alive', 'task-id': f.task, 'dispatch-id': idOf(started) }, { paneId: 'pane', session: null })
    expect(mock.sweeps - before).toBe(1)
  })

  it('V40 — a pane that dies while ask waits for the lane is refused, and no proof was taken before the lane', async () => {
    // The check this replaces passed against r1 as well, which made it evidence of nothing (C20).
    // This one fails there: r1 observed the pane *before* taking the lane, so the sweep below
    // happens while the lane is held and a question is stored for a pane that is already gone.
    const f = await setup()
    const started = await f.start()
    const before = mock.sweeps
    let unlock!: () => void
    const held = withDocumentLane(async () => new Promise<void>(resolve => { unlock = resolve }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const asking = f.mod.execute({
      command: 'orchestration ask',
      flags: { question: 'late', 'task-id': f.task, 'dispatch-id': idOf(started), 'request-id': `r1.${Date.now()}.${randomUUID()}` },
      args: [], cwd: f.dir, caller: { paneId: 'pane', session: null },
    }, { ...f.ctx(), deadlineAt: Date.now() + 1500 })
    // Bounded: give a pre-lane observation every chance to happen, then stop waiting either way.
    const deadline = Date.now() + 400
    while (mock.sweeps === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    expect(mock.sweeps).toBe(before)
    mock.live = false
    unlock()
    await held
    await expect(asking).rejects.toMatchObject({ code: 'stale_dispatch' })
    expect(f.store.read().messages.filter(entry => entry.type === 'question')).toHaveLength(0)
  })
})

describe('V25 — a question that cannot be stored is refused before its receipt exists', () => {
  it('a full mailbox leaves the receipt directory exactly as it was', async () => {
    const f = await setup()
    const started = await f.start()
    // A Run at its ceiling, written directly: the shape matters, not how it got there.
    const current = f.store.read()
    f.store.write({ ...current, messages: [...atCeiling(current.currentRunId!, 10000), ...current.messages] })
    const before = f.receiptDigest()
    const id = `r1.${Date.now()}.${randomUUID()}`
    await expect(f.mod.execute({
      command: 'orchestration ask',
      flags: { question: 'no room', 'task-id': f.task, 'dispatch-id': idOf(started), 'request-id': id },
      args: [], cwd: f.dir, caller: { paneId: 'pane', session: null },
    }, { ...f.ctx(), deadlineAt: Date.now() + 800 })).rejects.toMatchObject({ code: 'message_capacity' })
    expect(f.receiptDigest()).toBe(before)
    expect(fs.existsSync(path.join(f.dir, 'runtime/terminal-receipts', `${id}.json`))).toBe(false)
  })

  it('a coordinator status is refused the same way, before its receipt exists', async () => {
    const f = await setup()
    const current = f.store.read()
    f.store.write({ ...current, messages: atCeiling(current.currentRunId!, 10000) })
    const before = f.receiptDigest()
    const id = `r1.${Date.now()}.${randomUUID()}`
    await expect(f.mod.execute({
      command: 'orchestration send',
      flags: { type: 'status', subject: 'note', body: 'x', 'request-id': id }, args: [], cwd: f.dir,
    }, f.ctx())).rejects.toMatchObject({ code: 'message_capacity' })
    expect(f.receiptDigest()).toBe(before)
    expect(fs.existsSync(path.join(f.dir, 'runtime/terminal-receipts', `${id}.json`))).toBe(false)
  })
})

describe('V29 — ask carries the sender proof it was admitted on', () => {
  it('the response and the receipt both say whether the backend session matched', async () => {
    const f = await setup()
    const started = await f.start()
    const id = `r1.${Date.now()}.${randomUUID()}`
    const result = asRecord(await f.mod.execute({
      command: 'orchestration ask',
      flags: { question: 'q', 'task-id': f.task, 'dispatch-id': idOf(started), 'request-id': id },
      args: [], cwd: f.dir, caller: { paneId: 'pane', session: 'foreign' },
    }, { ...f.ctx(), deadlineAt: Date.now() + 750 }))
    expect(result).toHaveProperty('sessionVerified')
    // This attempt was created with no recorded session, so the session half proves nothing — and
    // says so, rather than looking like the stronger proof.
    expect(result.sessionVerified).toBe(false)
    const receipt = asRecord(JSON.parse(fs.readFileSync(path.join(f.dir, 'runtime/terminal-receipts', `${id}.json`), 'utf8')))
    expect(asRecord(receipt.result)).toHaveProperty('sessionVerified')
  })

  it('V43 — a resume that collects an answer says it too, and says the same thing', async () => {
    process.env.CORRAL_SESSION = 'session-one'
    const f = await setup()
    process.env.CORRAL_SESSION = 'session-one'
    const started = await f.start()
    const pane = { paneId: 'pane', session: 'session-one' }
    const pending = asRecord(await f.mod.execute({
      command: 'orchestration ask',
      flags: { question: 'who is asking?', 'task-id': f.task, 'dispatch-id': idOf(started), 'request-id': `r1.${Date.now()}.${randomUUID()}` },
      args: [], cwd: f.dir, caller: pane,
    }, { ...f.ctx(), deadlineAt: Date.now() + 500 }))
    expect(pending.state).toBe('pending')
    expect(pending.sessionVerified).toBe(true)
    const messageId = String(pending.messageId)
    await f.call('reply', { id: messageId, body: 'the pane did' })
    // The answered exit of a resume is the one path V29 left unmeasured (C24): a worker acts on
    // this answer, so it has to carry the same proof the question was admitted on.
    const answered = asRecord(await f.mod.execute({
      command: 'orchestration ask',
      flags: { resume: messageId, 'task-id': f.task, 'dispatch-id': idOf(started), 'request-id': `r1.${Date.now()}.${randomUUID()}` },
      args: [], cwd: f.dir, caller: pane,
    }, { ...f.ctx(), deadlineAt: Date.now() + 2000 }))
    expect(answered.state).toBe('answered')
    expect(answered.sessionVerified).toBe(true)
    expect(asRecord(answered.reply).body).toBe('the pane did')
    delete process.env.CORRAL_SESSION
  })
})
