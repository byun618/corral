import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Receipts, RECEIPT_TTL, REQUEST_ID } from './receipts.js'
import { derivedPromptId, derivedRequestId } from './index.js'
import type { Invocation } from '../contracts.js'

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

  it('counts missing receipts toward capacity and releases space only after expiry', async () => {
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
