/**
 * LIFE-410 r2 — the admission rules, measured against the real module.
 *
 * `orchestration.test.ts` tests the pure functions this module is built from. The rules this file
 * is about are not in any one of them: they are about *when* a judgement is made relative to the
 * document lane, the receipt and the effect, and the only way to state them is to drive the module
 * itself with the terminal boundary replaced. The mock below is the one the r1 reviewers used to
 * find V21–V25 and V29, kept deliberately close to theirs so the same shapes are being measured —
 * their file asserts the defects are visible, this one asserts they are not.
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
  bodies: string[]
  buffer: string
  calls: { command: string; flags: Record<string, unknown>; stdin?: string }[]
  rows: string[]
  live: boolean
  sweeps: number
  duplicateCount: number
  screen: string
}
const mock = vi.hoisted((): MockTerminal => ({
  mode: 'unknown', bodies: [], buffer: '', calls: [], rows: [], live: true, sweeps: 0, duplicateCount: 1, screen: '',
}))
vi.mock('../terminal/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../terminal/index.js')>()
  return {
    ...actual,
    terminalModule: () => ({
      specs: [], validate: () => {}, execute: async (inv: { command: string; flags: Record<string, unknown>; stdin?: string }) => {
        mock.calls.push(inv)
        const terminal = { handle: 't1.review', epoch: 'epoch', ptyId: 'pty', paneId: 'pane' }
        if (inv.command === 'terminal create') return { terminal, agent: { kind: 'claude' }, stages: { agent: { status: 'completed' } } }
        if (inv.command === 'terminal show') return { terminal, agent: { kind: 'claude' } }
        if (inv.command === 'terminal wait') return { satisfied: true }
        if (inv.command === 'terminal read') return { text: mock.screen }
        if (inv.command === 'terminal close') { mock.live = false; return { outcome: 'completed' } }
        if (inv.command === 'terminal send') { mock.buffer += String(inv.flags.text); mock.screen = mock.buffer; return { outcome: 'completed' } }
        if (inv.command === 'terminal prompt') {
          const body = String(inv.stdin)
          if (mock.bodies.includes(body)) throw new RuntimeError('prompt_already_delivered', 'Already present', { matchCount: mock.duplicateCount }, 'preflight', 'not_started')
          if (mock.mode === 'refuse') throw new RuntimeError('agent_not_ready', 'gate changed', null, 'preflight', 'not_started')
          const row = `${mock.buffer}\n\n<pasted_content id="one">\n${body.trimEnd()}\n</pasted_content id="one">`
          mock.rows.push(row)
          mock.buffer = ''
          mock.screen = ''
          if (mock.mode === 'unknown') mock.bodies.push(body)
          const matches = sameBody(bodyIdentity(body), row)
          return {
            outcome: mock.mode === 'unknown' || !matches ? 'unknown' : 'completed',
            wait: { requested: 'accepted', satisfied: mock.mode !== 'unknown' && matches, reason: mock.mode === 'unknown' ? 'deadline' : null },
          }
        }
        throw Error(inv.command)
      },
    }),
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
  mock.mode = 'unknown'; mock.buffer = ''; mock.bodies = []; mock.calls = []; mock.rows = []
  mock.live = true; mock.sweeps = 0; mock.duplicateCount = 1; mock.screen = ''
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

describe('V22 — the lead is recorded before it is typed, so a resume never types a second one', () => {
  it('an unconfirmed submission that resumes into already_present types the lead once', async () => {
    const f = await setup()
    const first = await f.start()
    const second = await f.start()
    expect(second.dispatchId).toBe(first.dispatchId)
    expect(second.state).toBe('ready')
    const sends = mock.calls.filter(entry => entry.command === 'terminal send')
    expect(sends).toHaveLength(1)
    const stored = f.store.read().dispatches[0]!.worker
    expect(stored?.lead?.requestId).toEqual(expect.stringMatching(/^r1\./))
  })

  it('a preflight failure after the lead does not make the retry submit a doubled lead', async () => {
    const f = await setup()
    mock.mode = 'refuse'
    await f.start()
    mock.mode = 'completed'
    const second = await f.start()
    expect(mock.calls.filter(entry => entry.command === 'terminal send')).toHaveLength(1)
    expect(mock.rows[0]!.startsWith(PROMPT_LEAD + PROMPT_LEAD)).toBe(false)
    expect(mock.rows[0]!.startsWith(PROMPT_LEAD)).toBe(true)
    // …and because the row carries one lead, `sameBody` recognises it and the body is delivered.
    expect(second.state).toBe('ready')
    expect(second.stage).toBe('input_accepted')
  })

  it('reports whether the earlier run left its lead on the input line', async () => {
    const f = await setup()
    await f.start()
    mock.screen = PROMPT_LEAD
    const second = await f.start()
    expect(second.lead).toMatchObject({ checked: true, present: true })
    expect(second.residualResources).toEqual([expect.objectContaining({ kind: 'input_line' })])
  })
})

describe('V23 — already_present is a delivery only when it matched exactly once', () => {
  it('two matching submissions leave the attempt unconfirmed instead of ready', async () => {
    const f = await setup()
    await f.start()
    mock.duplicateCount = 2
    const second = await f.start()
    expect(second.state).toBe('incomplete')
    expect(second.stage).toBe('dispatch_input_unconfirmed')
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

  it('a pane that dies while ask waits for the lane does not get a question stored', async () => {
    const f = await setup()
    const started = await f.start()
    let unlock!: () => void
    const held = withDocumentLane(async () => new Promise<void>(resolve => { unlock = resolve }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const asking = f.mod.execute({
      command: 'orchestration ask',
      flags: { question: 'late', 'task-id': f.task, 'dispatch-id': idOf(started), 'request-id': `r1.${Date.now()}.${randomUUID()}` },
      args: [], cwd: f.dir, caller: { paneId: 'pane', session: null },
    }, { ...f.ctx(), deadlineAt: Date.now() + 800 })
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
})
