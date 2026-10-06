import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Receipts, RECEIPT_TTL, REQUEST_ID } from './receipts.js'
import { derivedPromptId, derivedRequestId, terminalModule } from './index.js'
import { Tokens } from './tokens.js'
import { WorktreeMetadata, type WorktreeRecord } from '../workspace/model.js'
import { TerminalBackend } from '../../main/adapter/index.js'
import { RuntimeError, type CommandContext, type CommandModule, type Flags, type Invocation } from '../contracts.js'

describe('terminal receipt admission survives result loss', () => {
  let root: string, now: number, receipts: Receipts
  const request = (command = 'terminal send'): Invocation => ({ command, flags: { 'request-id': `r1.${now}.${randomUUID()}`, text: 'ONCE' }, args: [], cwd: '/fixture' })
  const file = (inv: Invocation) => path.join(root, 'runtime/terminal-receipts', inv.flags['request-id'] + '.json')
  beforeEach(() => {
    root = fs.mkdtempSync('/tmp/l393-codex-receipts-')
    now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    receipts = new Receipts(root, now)
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

  it.each(['terminal send', 'terminal create'])('refuses %s after its completed result is removed', async command => {
    const inv = request(command), effect = vi.fn(async () => ({ bytes: 4 }))
    await receipts.run(inv, effect)
    fs.unlinkSync(file(inv))
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'outcome_unknown', stage: 'receipt', outcome: 'unknown' })
    await expect(receipts.run({ ...inv, flags: { ...inv.flags, text: 'DIFFERENT' } }, effect)).rejects.toMatchObject({ code: 'request_conflict' })
    expect(effect).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(file(inv))).toBe(false)
  })

  it('refuses concurrent requests even if the pending receipt is removed', async () => {
    const inv = request()
    let finish!: (value: unknown) => void
    const effect = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const first = receipts.run(inv, effect)
    fs.unlinkSync(file(inv))
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'outcome_unknown' })
    finish({ bytes: 4 }); await first
    await expect(receipts.run(inv, effect)).resolves.toMatchObject({ replayed: true })
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('replays after restart and rejects changed input without executing', async () => {
    const inv = request(), effect = vi.fn(async () => ({ bytes: 4 }))
    await receipts.run(inv, effect)
    receipts = new Receipts(root, ++now)
    await expect(receipts.run(inv, effect)).resolves.toEqual({ bytes: 4, requestId: inv.flags['request-id'], replayed: true })
    await expect(receipts.run({ ...inv, flags: { ...inv.flags, text: 'DIFFERENT' } }, effect)).rejects.toMatchObject({ code: 'request_conflict' })
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('refuses a missing old result after restart', async () => {
    const inv = request(), effect = vi.fn(async () => ({ bytes: 4 }))
    await receipts.run(inv, effect); fs.unlinkSync(file(inv))
    receipts = new Receipts(root, ++now)
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('keeps an uncertain effect pending across restart', async () => {
    const inv = request(), effect = vi.fn(async () => { throw Error('response lost after effect') })
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'outcome_unknown' })
    receipts = new Receipts(root, ++now)
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(effect).toHaveBeenCalledTimes(1)
  })

  // ~20,000 file operations (9,999 seeded here, then the expiry sweep unlinks them) — a 5s budget fails
  // when the whole suite runs in parallel under disk load (LIFE-517 K4: 5/5 under a concurrent npm ci).
  it('counts missing receipts toward capacity and releases space only after expiry', { timeout: 30_000 }, async () => {
    const inv = request(), effect = vi.fn(async () => ({ bytes: 4 }))
    await receipts.run(inv, effect); fs.unlinkSync(file(inv))
    const directory = path.dirname(file(inv))
    // Seed retained disk records, avoiding 9,999 artificial external effects.
    for (let i = 0; i < 9999; i++) fs.writeFileSync(file(request()), '{}')
    await expect(receipts.run(request(), effect)).rejects.toMatchObject({ code: 'receipt_capacity' })
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(effect).toHaveBeenCalledTimes(1)
    now += RECEIPT_TTL + 1
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'request_expired' })
    await expect(receipts.run(request(), effect)).resolves.toMatchObject({ replayed: false })
    expect(effect).toHaveBeenCalledTimes(2)
    expect(fs.readdirSync(directory)).toHaveLength(1)
  })

  it('fails closed when result storage is corrupt', async () => {
    const inv = request(), effect = vi.fn(async () => ({ bytes: 4 }))
    await receipts.run(inv, effect); fs.writeFileSync(file(inv), '{broken')
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'storage_corrupt' })
    expect(effect).toHaveBeenCalledTimes(1)
  })
})

describe('LIFE-394 create/prompt composition receipts', () => {
  let root: string, now: number, receipts: Receipts
  const createId = () => `r1.${now}.${randomUUID()}`
  const file = (id: string) => path.join(root, 'runtime/terminal-receipts', id + '.json')
  beforeEach(() => {
    root = fs.mkdtempSync('/tmp/l394-claude-receipts-')
    now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    receipts = new Receipts(root, now)
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

  const create = (id: string): Invocation => ({ command: 'terminal create', flags: { 'request-id': id, agent: 'claude', prompt: 'ONCE' }, args: [], cwd: '/fixture' })
  const child = (parent: string, body: string): Invocation =>
    ({ command: 'terminal prompt', flags: { 'request-id': derivedPromptId(parent), terminal: 't1.handle', stdin: true }, args: [], cwd: '/fixture', stdin: body })

  it('derives a prompt id that is deterministic, well formed and distinct per stage', () => {
    const parent = createId()
    expect(derivedPromptId(parent)).toBe(derivedPromptId(parent))
    expect(derivedPromptId(parent)).toBe(derivedRequestId(parent, 'prompt'))
    expect(derivedPromptId(parent)).not.toBe(derivedRequestId(parent, 'terminal'))
    expect(derivedPromptId(parent)).not.toBe(parent)
    // The derived id satisfies the existing pattern, which is why receipts.ts needs no change.
    const match = REQUEST_ID.exec(derivedPromptId(parent))
    expect(match?.[1]).toBe(REQUEST_ID.exec(parent)![1])
    expect(() => derivedPromptId('not-a-request-id')).toThrow(/request-id/)
  })

  it('files the create and its prompt stage separately and replays both without re-submitting', async () => {
    const parent = createId(), submit = vi.fn(async () => ({ stage: 'submitted', outcome: 'queued' }))
    const run = () => receipts.run(create(parent), async () => ({ terminal: { handle: 't1.handle' }, stage: 'agent_prompted',
      prompt: await receipts.run(child(parent, 'ONCE'), submit) }))
    const first = await run()
    expect(first).toMatchObject({ replayed: false, prompt: { outcome: 'queued', replayed: false, requestId: derivedPromptId(parent) } })
    expect(fs.existsSync(file(parent))).toBe(true)
    expect(fs.existsSync(file(derivedPromptId(parent)))).toBe(true)
    // F8(a): the same create id replays the stored result and never re-enters the prompt stage.
    expect(await run()).toMatchObject({ replayed: true, prompt: { outcome: 'queued' } })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('does not resume a half-finished composition and refuses the same id with a changed body', async () => {
    const parent = createId(), submit = vi.fn(async () => ({ stage: 'submitted', outcome: 'queued' }))
    // The create was interrupted while its effect was in flight: the receipt stays pending.
    await expect(receipts.run(create(parent), async () => { throw new Error('runtime stopped') })).rejects.toMatchObject({ code: 'outcome_unknown' })
    await expect(receipts.run(create(parent), async () => ({ ok: true }))).rejects.toMatchObject({ code: 'outcome_unknown', outcome: 'unknown' })
    expect(submit).not.toHaveBeenCalled()
    // §4.3: the hash covers the body, so the same id with different content conflicts instead of
    // replaying. A --prompt-file whose content changed under the same path lands here too.
    const other = createId()
    await receipts.run(child(other, 'ONCE'), submit)
    await expect(receipts.run(child(other, 'CHANGED'), submit)).rejects.toMatchObject({ code: 'request_conflict' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('leaves a submission whose confirmation never finished unknown, never re-submitted (F8 b)', async () => {
    const parent = createId(), id = derivedPromptId(parent)
    const submit = vi.fn(() => new Promise<unknown>(() => { /* confirmation stalls past the deadline */ }))
    void receipts.run(child(parent, 'ONCE'), submit)
    await new Promise(resolve => setImmediate(resolve))
    expect(JSON.parse(fs.readFileSync(file(id), 'utf8')).state).toBe('pending')
    await expect(receipts.run(child(parent, 'ONCE'), submit)).rejects.toMatchObject({ code: 'outcome_unknown', stage: 'receipt', outcome: 'unknown' })
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('LIFE-423 a refusal that never started leaves the request id unspent', () => {
  let root: string, now: number, receipts: Receipts
  const request = (text = 'ONCE'): Invocation => ({ command: 'terminal prompt', flags: { 'request-id': `r1.${now}.${randomUUID()}`, terminal: 't1.handle', text }, args: [], cwd: '/fixture' })
  const file = (inv: Invocation) => path.join(root, 'runtime/terminal-receipts', inv.flags['request-id'] + '.json')
  const refuse = (code: string, outcome?: 'not_started' | 'unknown', stage?: string) =>
    vi.fn(async (): Promise<unknown> => { throw new RuntimeError(code, code + ' refusal', { terminal: 't1.handle' }, stage, outcome) })
  beforeEach(() => {
    root = fs.mkdtempSync('/tmp/l423-claude-receipts-')
    now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    receipts = new Receipts(root, now)
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

  // The bug: the first attempt filed a pending receipt the refusal never cleared, so the retry the
  // refusal itself recommends answered `outcome_unknown` about an effect that provably never ran.
  it.each(['agent_not_ready', 'agent_blocked', 'prompt_already_delivered', 'detect_manifest_unverified', 'stale_terminal'])(
    'repeats %s for the same request id instead of outcome_unknown', async code => {
      const inv = request(), effect = refuse(code, 'not_started', 'preflight')
      await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code, outcome: 'not_started' })
      // r2: the id is released rather than forgotten, so what is left is a tombstone, never a
      // pending or completed receipt — the retry below is what proves the id is spendable again.
      expect(JSON.parse(fs.readFileSync(file(inv), 'utf8')).state).toBe('released')
      await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code, outcome: 'not_started' })
      expect(effect).toHaveBeenCalledTimes(2)
      expect(JSON.parse(fs.readFileSync(file(inv), 'utf8')).state).toBe('released')
    })

  // `stale_terminal` carries no stage of its own (app/cli/README.md §59); the outcome alone decides.
  it('discriminates on the outcome, not on the stage', async () => {
    const inv = request(), effect = refuse('stale_terminal', 'not_started')
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'stale_terminal', outcome: 'not_started' })
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'stale_terminal' })
    expect(effect).toHaveBeenCalledTimes(2)
  })

  // An unspent id is unspent for the memory record too: `admitted` still holding the hash would
  // answer `request_conflict` to a corrected body, which is the whole point of fixing the input.
  it('admits a corrected body under the same id after the refusal', async () => {
    const inv = request(), effect = refuse('agent_not_ready', 'not_started', 'preflight'), succeed = vi.fn(async () => ({ stage: 'submitted' }))
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'agent_not_ready' })
    const corrected = { ...inv, flags: { ...inv.flags, text: 'CORRECTED' } }
    await expect(receipts.run(corrected, succeed)).resolves.toMatchObject({ stage: 'submitted', replayed: false })
    expect(succeed).toHaveBeenCalledTimes(1)
  })

  it('files the retry that finally succeeds and replays it afterwards', async () => {
    const inv = request(), effect = refuse('agent_not_ready', 'not_started', 'preflight'), succeed = vi.fn(async () => ({ stage: 'submitted' }))
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'agent_not_ready' })
    await expect(receipts.run(inv, succeed)).resolves.toMatchObject({ replayed: false })
    expect(JSON.parse(fs.readFileSync(file(inv), 'utf8')).state).toBe('completed')
    await expect(receipts.run(inv, succeed)).resolves.toMatchObject({ replayed: true })
    expect(succeed).toHaveBeenCalledTimes(1)
  })

  // Negative control (C4). Only `not_started` frees the id: a refusal that cannot prove nothing ran
  // keeps its pending receipt, and the same id still answers `outcome_unknown`.
  it.each([
    ['a RuntimeError with no outcome', refuse('backend_timeout')],
    ['a RuntimeError that is explicitly unknown', refuse('outcome_unknown', 'unknown', 'backend')],
    ['a plain Error', vi.fn(async (): Promise<unknown> => { throw new Error('response lost after effect') })],
  ])('keeps %s pending and refuses the retry', async (_label, effect) => {
    const inv = request()
    await expect(receipts.run(inv, effect)).rejects.toBeInstanceOf(RuntimeError)
    expect(JSON.parse(fs.readFileSync(file(inv), 'utf8')).state).toBe('pending')
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'outcome_unknown', stage: 'receipt', outcome: 'unknown' })
    expect(effect).toHaveBeenCalledTimes(1)
  })

  // The freed id is freed in the capacity count too — a refusal must not retain a slot. r2 keeps the
  // property but moves its evidence: the tombstone stays on disk (that is how another instance learns
  // of the release) and is counted out at the cap instead, which the r2 capacity block exercises.
  it('leaves only a released tombstone, which holds no capacity', async () => {
    const inv = request(), effect = refuse('agent_not_ready', 'not_started', 'preflight')
    await expect(receipts.run(inv, effect)).rejects.toMatchObject({ code: 'agent_not_ready' })
    const directory = path.join(root, 'runtime/terminal-receipts')
    expect(fs.readdirSync(directory)).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(file(inv), 'utf8'))).toMatchObject({ state: 'released' })
  })
})

/**
 * LIFE-423 r2. The r1 fix released the id in the refusing instance's own memory, which is not where
 * the profile keeps its admissions: `server.ts` and orchestration each build a terminal module, so
 * two `Receipts` objects sit on one userData (codex R1). These run the real `terminalModule`, so the
 * refusal comes from the product's own `resolve()` rather than from a stubbed effect.
 */
describe('LIFE-423 r2 a release is shared by every Receipts instance on the profile', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { for (const undo of cleanups.reverse()) undo(); cleanups.length = 0; vi.restoreAllMocks() })

  /** Two real terminal modules over one userData, with herdr replaced at the adapter boundary. */
  const setup = () => {
    const dir = fs.mkdtempSync('/tmp/l423-r2-')
    const before = { registry: process.env.CORRAL_REGISTRY, socket: process.env.CORRAL_BACKEND_SOCKET }
    cleanups.push(() => {
      fs.rmSync(dir, { recursive: true, force: true })
      for (const [key, value] of [['CORRAL_REGISTRY', before.registry], ['CORRAL_BACKEND_SOCKET', before.socket]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value
    })
    const data = path.join(dir, 'data'), cwd = path.join(dir, 'repo')
    fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(cwd, { recursive: true })
    process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
    process.env.CORRAL_BACKEND_SOCKET = path.join(dir, 'never.sock')
    vi.spyOn(TerminalBackend.prototype, 'epoch').mockImplementation(async () => 'e')
    vi.spyOn(TerminalBackend.prototype, 'agentCapable').mockImplementation(() => true)
    const list = vi.spyOn(TerminalBackend.prototype, 'list').mockImplementation(async () => [])
    const send = vi.spyOn(TerminalBackend.prototype, 'send').mockImplementation(async () => undefined)
    const token = new Tokens(data).encode('t1', { runtimeId: 'test', epoch: 'e', ptyId: 'p', paneId: 'pane' })
    const ctx = (): CommandContext => ({ runtimeId: 'test', instanceId: 'test', userData: data,
      signal: new AbortController().signal, remote: false, deadlineAt: Date.now() + 4000 })
    // Two independently built modules — the shape server.ts and orchestration/index.ts produce.
    const moduleA = terminalModule(data), moduleB = terminalModule(data)
    const run = (module: CommandModule, command: string, flags: Flags) =>
      module.execute({ command, flags, args: [], cwd }, ctx())
    const receipt = (id: string) => path.join(data, 'runtime/terminal-receipts', id + '.json')
    const stored = (id: string) => fs.existsSync(receipt(id)) ? JSON.parse(fs.readFileSync(receipt(id), 'utf8')) : null
    const send1 = (module: CommandModule, id: string, text = 'hi') => run(module, 'terminal send', { terminal: token, text, 'request-id': id })
    return { data, moduleA, moduleB, run, receipt, stored, send, list, send1, token, cwd }
  }
  const caught = async (promise: Promise<unknown>): Promise<RuntimeError> => {
    try { await promise } catch (error) { if (error instanceof RuntimeError) return error; throw error }
    throw new Error('expected a rejection')
  }
  const newId = () => `r1.${Date.now()}.${randomUUID()}`
  /** The pending receipt is written after an `await`, so B must not start before it exists. */
  const settle = async (exists: () => boolean) => { for (let i = 0; i < 200 && !exists(); i++) await new Promise(resolve => setImmediate(resolve)) }

  // R1 itself: B copies the admission off the pending receipt, then A refuses with `not_started`.
  it('lets the other instance retry after a refusal it watched as pending', async () => {
    const f = setup()
    const id = newId()
    let release!: (panes: never[]) => void
    f.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = f.send1(f.moduleA, id)
    await settle(() => fs.existsSync(f.receipt(id)))
    // B looks while the effect is still in flight and must answer `outcome_unknown` — that is correct
    // at this instant, and it is also what copies the admission into B.
    expect((await caught(f.send1(f.moduleB, id))).code).toBe('outcome_unknown')
    release([])
    expect((await caught(first)).code).toBe('stale_terminal')
    // After the refusal the id is unspent everywhere, not only in A.
    expect((await caught(f.send1(f.moduleB, id))).code).toBe('stale_terminal')
    expect((await caught(f.send1(f.moduleA, id))).code).toBe('stale_terminal')
    // And a corrected body is a fresh admission in B too, not `request_conflict`.
    expect((await caught(f.send1(f.moduleB, id, 'corrected'))).code).toBe('stale_terminal')
    expect(f.send).toHaveBeenCalledTimes(0)
  })

  it('records the release in the receipt file rather than deleting it', async () => {
    const f = setup()
    const id = newId()
    expect((await caught(f.send1(f.moduleA, id))).code).toBe('stale_terminal')
    expect(f.stored(id)).toMatchObject({ state: 'released', createdAt: Number(REQUEST_ID.exec(id)![1]) })
    expect(typeof f.stored(id).hash).toBe('string')
    expect(f.stored(id).result).toBeUndefined()
  })

  // Contrast (i): a completed result that is lost is NOT a release — absence still fails closed.
  it('still refuses the other instance when a completed receipt is lost', async () => {
    const f = setup()
    const pane = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 't', workspaceId: 'w', path: f.cwd, repo: f.cwd, title: 'x' }
    f.list.mockImplementation(async () => [pane])
    const id = newId()
    await f.send1(f.moduleA, id)
    expect(await f.send1(f.moduleB, id)).toMatchObject({ replayed: true })
    fs.unlinkSync(f.receipt(id))
    expect((await caught(f.send1(f.moduleB, id))).code).toBe('outcome_unknown')
    expect((await caught(f.send1(f.moduleA, id))).code).toBe('outcome_unknown')
  })

  // Contrast (ii): an uncertain failure leaves pending, and losing that file changes nothing.
  it('still refuses the other instance when an uncertain effect loses its pending receipt', async () => {
    const f = setup()
    const pane = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 't', workspaceId: 'w', path: f.cwd, repo: f.cwd, title: 'x' }
    f.list.mockImplementation(async () => [pane])
    f.send.mockImplementation(async () => { throw new Error('response lost after the effect') })
    const id = newId()
    expect((await caught(f.send1(f.moduleA, id))).code).toBe('outcome_unknown')
    expect(f.stored(id)).toMatchObject({ state: 'pending' })
    expect((await caught(f.send1(f.moduleB, id))).code).toBe('outcome_unknown')
    fs.unlinkSync(f.receipt(id))
    expect((await caught(f.send1(f.moduleB, id))).code).toBe('outcome_unknown')
  })

  // L1: the `index.ts` resolve() refusal, locked in the repo rather than in a reviewer's probe.
  it('refuses a send whose pane is gone as stale_terminal, not_started, with no stage', async () => {
    const f = setup()
    const id = newId()
    const error = await caught(f.send1(f.moduleA, id))
    expect(error.code).toBe('stale_terminal')
    expect(error.outcome).toBe('not_started')
    expect(error.stage).toBeUndefined()
    expect(f.send).toHaveBeenCalledTimes(0)
  })

  // M1: effect-free refusals that r1 left spending the id.
  it('leaves the id unspent when --worktree names nothing in the registry', async () => {
    const f = setup()
    const id = newId()
    const flags = { worktree: 'path:/nowhere-l423', 'request-id': id }
    const first = await caught(f.run(f.moduleA, 'terminal create', flags))
    expect(first.code).toBe('not_found')
    expect(first.outcome).toBe('not_started')
    expect(await caught(f.run(f.moduleA, 'terminal create', flags))).toMatchObject({ code: 'not_found' })
  })

  it('leaves the id unspent when --stdin arrives without a body', async () => {
    const f = setup()
    const pane = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 't', workspaceId: 'w', path: f.cwd, repo: f.cwd, title: 'x' }
    f.list.mockImplementation(async () => [pane])
    const id = newId()
    const flags = { terminal: f.token, stdin: true, 'request-id': id }
    const first = await caught(f.run(f.moduleA, 'terminal send', flags))
    expect(first.code).toBe('invalid_argument')
    expect(first.outcome).toBe('not_started')
    expect(await caught(f.run(f.moduleA, 'terminal send', flags))).toMatchObject({ code: 'invalid_argument' })
    expect(f.send).toHaveBeenCalledTimes(0)
  })
})

describe('LIFE-423 r2 a released receipt holds no capacity', () => {
  let root: string, now: number, receipts: Receipts
  const request = (): Invocation => ({ command: 'terminal send', flags: { 'request-id': `r1.${now}.${randomUUID()}`, text: 'ONCE' }, args: [], cwd: '/fixture' })
  const file = (inv: Invocation) => path.join(root, 'runtime/terminal-receipts', inv.flags['request-id'] + '.json')
  beforeEach(() => {
    root = fs.mkdtempSync('/tmp/l423-r2-cap-')
    now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    receipts = new Receipts(root, now)
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

  // A tombstone is not a spent id, so it must not push the profile into `receipt_capacity`.
  it('admits a new request although released tombstones fill the directory', async () => {
    const effect = vi.fn(async () => ({ bytes: 4 }))
    const seed = request()
    await receipts.run(seed, effect)
    const directory = path.dirname(file(seed))
    for (let i = 0; i < 9999; i++)
      fs.writeFileSync(file(request()), JSON.stringify({ hash: 'x', state: 'released', createdAt: now }))
    expect(fs.readdirSync(directory)).toHaveLength(10000)
    await expect(receipts.run(request(), effect)).resolves.toMatchObject({ replayed: false })
    expect(effect).toHaveBeenCalledTimes(2)
  })

  // L-7: one of the occupants cannot be parsed. The cap loop keeps its slot rather than waving it
  // through — an unreadable file is not evidence that the id behind it was released.
  it('still refuses when the directory is full, one of them unreadable', async () => {
    const effect = vi.fn(async () => ({ bytes: 4 }))
    const seed = request()
    await receipts.run(seed, effect)
    for (let i = 0; i < 9998; i++) fs.writeFileSync(file(request()), '{}')
    fs.writeFileSync(file(request()), 'not json at all')
    await expect(receipts.run(request(), effect)).rejects.toMatchObject({ code: 'receipt_capacity' })
    expect(effect).toHaveBeenCalledTimes(1)
  })
})

/**
 * LIFE-423 r3. r2 made the release durable; these pin the order in which the durable record and the
 * in-memory copy are believed. The file is the profile's shared truth whenever one exists — the copy
 * only guards a receipt that has gone missing (codex R2-1).
 */
describe('LIFE-423 r3 the receipt file outranks a stale memory admission', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { for (const undo of cleanups.reverse()) undo(); cleanups.length = 0; vi.restoreAllMocks() })

  const setup = () => {
    const dir = fs.mkdtempSync('/tmp/l423-r3-')
    const before = { registry: process.env.CORRAL_REGISTRY, socket: process.env.CORRAL_BACKEND_SOCKET }
    cleanups.push(() => {
      fs.rmSync(dir, { recursive: true, force: true })
      for (const [key, value] of [['CORRAL_REGISTRY', before.registry], ['CORRAL_BACKEND_SOCKET', before.socket]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value
    })
    const data = path.join(dir, 'data'), cwd = path.join(dir, 'repo')
    fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(cwd, { recursive: true })
    process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
    process.env.CORRAL_BACKEND_SOCKET = path.join(dir, 'never.sock')
    const pane = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 't', workspaceId: 'w', path: cwd, repo: cwd, title: 'x' }
    vi.spyOn(TerminalBackend.prototype, 'epoch').mockImplementation(async () => 'e')
    vi.spyOn(TerminalBackend.prototype, 'agentCapable').mockImplementation(() => true)
    const list = vi.spyOn(TerminalBackend.prototype, 'list').mockImplementation(async () => [pane])
    const send = vi.spyOn(TerminalBackend.prototype, 'send').mockImplementation(async () => undefined)
    const token = new Tokens(data).encode('t1', { runtimeId: 'test', epoch: 'e', ptyId: 'p', paneId: 'pane' })
    const ctx = (): CommandContext => ({ runtimeId: 'test', instanceId: 'test', userData: data,
      signal: new AbortController().signal, remote: false, deadlineAt: Date.now() + 4000 })
    const moduleA = terminalModule(data), moduleB = terminalModule(data)
    const run = (module: CommandModule, command: string, flags: Flags) => module.execute({ command, flags, args: [], cwd }, ctx())
    const receipt = (id: string) => path.join(data, 'runtime/terminal-receipts', id + '.json')
    const stored = (id: string) => fs.existsSync(receipt(id)) ? JSON.parse(fs.readFileSync(receipt(id), 'utf8')) : null
    const send1 = (module: CommandModule, id: string, text: string) => run(module, 'terminal send', { terminal: token, text, 'request-id': id })
    return { data, cwd, moduleA, moduleB, run, receipt, stored, send, list, send1, token }
  }
  const caught = async (promise: Promise<unknown>): Promise<RuntimeError> => {
    try { await promise } catch (error) { if (error instanceof RuntimeError) return error; throw error }
    throw new Error('expected a rejection')
  }
  const newId = () => `r1.${Date.now()}.${randomUUID()}`
  const settle = async (ready: () => boolean) => { for (let i = 0; i < 200 && !ready(); i++) await new Promise(resolve => setImmediate(resolve)) }

  /**
   * codex R2-1, four steps. B never gets to read the release: A reuses the id with a corrected body
   * and succeeds first. B's copy is then older than the completed receipt, and the file must win.
   */
  it('replays a completed receipt to an instance whose copied admission predates it', async () => {
    const f = setup()
    const id = newId()
    let release!: (panes: never[]) => void
    f.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = f.send1(f.moduleA, id, 'original')
    await settle(() => fs.existsSync(f.receipt(id)))
    expect((await caught(f.send1(f.moduleB, id, 'original'))).code).toBe('outcome_unknown')
    release([])
    expect((await caught(first)).code).toBe('stale_terminal')
    expect(f.stored(id)).toMatchObject({ state: 'released' })
    // A corrects the body and succeeds. B has not looked since the pending receipt.
    expect(await f.send1(f.moduleA, id, 'corrected')).toMatchObject({ replayed: false })
    expect(f.stored(id)).toMatchObject({ state: 'completed' })
    expect(await f.send1(f.moduleB, id, 'corrected')).toMatchObject({ replayed: true })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  // The contrast codex asked for: while A's corrected run is still in flight the honest answer to B
  // is `outcome_unknown`, never `request_conflict` — the id is not being used with different input.
  it('answers outcome_unknown, not conflict, while the corrected run is still pending', async () => {
    const f = setup()
    const id = newId()
    let release!: (panes: never[]) => void
    f.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = f.send1(f.moduleA, id, 'original')
    await settle(() => fs.existsSync(f.receipt(id)))
    expect((await caught(f.send1(f.moduleB, id, 'original'))).code).toBe('outcome_unknown')
    release([])
    expect((await caught(first)).code).toBe('stale_terminal')
    let finish!: () => void
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined) }))
    const second = f.send1(f.moduleA, id, 'corrected')
    await settle(() => f.stored(id)?.state === 'pending')
    expect((await caught(f.send1(f.moduleB, id, 'corrected'))).code).toBe('outcome_unknown')
    finish(); await second
  })

  // L-2: the watching instance's *first* move after the release is the corrected body. r2's test
  // retried the original body first, which emptied the copy before the corrected body was judged.
  it('admits a corrected body as the watching instance first move after a release', async () => {
    const f = setup()
    const id = newId()
    let release!: (panes: never[]) => void
    f.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = f.send1(f.moduleA, id, 'original')
    await settle(() => fs.existsSync(f.receipt(id)))
    expect((await caught(f.send1(f.moduleB, id, 'original'))).code).toBe('outcome_unknown')
    release([])
    expect((await caught(first)).code).toBe('stale_terminal')
    expect(await f.send1(f.moduleB, id, 'corrected')).toMatchObject({ replayed: false })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  // G2-3: `ambiguous_target` carries the same outcome as `not_found`, and nothing locked it.
  it('leaves the id unspent when --worktree matches more than one worktree', async () => {
    const f = setup()
    const twin = (id: string): WorktreeRecord => ({ id, repoId: 'r', projectId: 'p', hostId: 'local', path: `/w/${id}`, branch: null,
      head: '', displayName: 'dup', isMainWorktree: false, parentWorktreeId: null, childWorktreeIds: [],
      linkedIssue: null, linkedLinearIssue: null, comment: null, workspaceStatus: null })
    vi.spyOn(WorktreeMetadata.prototype, 'list').mockImplementation(async () => [twin('one'), twin('two')])
    const id = newId()
    const flags = { worktree: 'name:dup', 'request-id': id }
    const error = await caught(f.run(f.moduleA, 'terminal create', flags))
    expect(error.code).toBe('ambiguous_target')
    expect(error.outcome).toBe('not_started')
    expect(f.stored(id)).toMatchObject({ state: 'released' })
    expect(await caught(f.run(f.moduleA, 'terminal create', flags))).toMatchObject({ code: 'ambiguous_target' })
  })

  // L-5: if the tombstone cannot be written the caller still learns why the request was refused —
  // the id stays spent (fail-closed), but the refusal is not replaced by a storage error.
  it('keeps the original refusal when the release cannot be written', async () => {
    const f = setup()
    const id = newId()
    f.list.mockImplementationOnce(async () => [])
    // `atomicWrite` opens a temp file beside the receipt. The first one files the pending receipt;
    // the second is the release, and that is the one the disk refuses here.
    const real = fs.openSync
    let opened = 0
    const write = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).includes(id) && ++opened === 2) throw new Error('ENOSPC: no space left on device')
      return real(...args)
    })
    const error = await caught(f.send1(f.moduleA, id, 'original'))
    write.mockRestore()
    expect(opened).toBe(2)
    expect(error.code).toBe('stale_terminal')
    expect(f.stored(id)).toMatchObject({ state: 'pending' })
    expect((await caught(f.send1(f.moduleA, id, 'original'))).code).toBe('outcome_unknown')
  })
})
