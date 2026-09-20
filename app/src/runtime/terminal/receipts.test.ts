import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Receipts, RECEIPT_TTL } from './receipts.js'
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
