import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWrite, readFile, privateDirectory } from '../storage.js'
import { isRecord } from '../../shared/json.js'
import { RuntimeError, type Invocation } from '../contracts.js'
export const RECEIPT_TTL = 24 * 60 * 60 * 1000
export const REQUEST_ID = /^r1\.(\d{13})\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/
interface Receipt { hash: string; state: 'pending' | 'completed'; createdAt: number; result?: unknown }
export class Receipts {
  constructor(private readonly userData: string, private readonly startedAt: number) {}
  async run(inv: Invocation, execute: () => Promise<unknown>): Promise<unknown> {
    const id = String(inv.flags['request-id']), match = REQUEST_ID.exec(id)
    if (!match) throw new RuntimeError('invalid_argument', '--request-id must be r1.<13 digit Unix ms>.<UUID>')
    const createdAt = Number(match[1]), directory = path.join(this.userData, 'runtime/terminal-receipts')
    const now = Date.now()
    if (createdAt > now) throw new RuntimeError('invalid_argument', 'Request ID timestamp is in the future')
    if (now - createdAt > RECEIPT_TTL) throw new RuntimeError('request_expired', 'Receipt retention is 24 hours; request will not be re-executed', { requestId: id })
    privateDirectory(directory)
    const flags = Object.fromEntries(Object.entries(inv.flags).filter(([key]) => !['request-id', 'json', 'timeout-ms', 'socket', 'instance'].includes(key)).sort(([a], [b]) => a.localeCompare(b)))
    const hash = createHash('sha256').update(JSON.stringify({ command: inv.command, flags, cwd: inv.cwd, stdin: inv.stdin })).digest('hex')
    const file = path.join(directory, id + '.json'), prior = readFile<Receipt | null>(file, () => null)
    if (prior) {
      if (prior.hash !== hash) throw new RuntimeError('request_conflict', 'Request ID was used with different input', { requestId: id })
      if (prior.state === 'completed' && isRecord(prior.result)) return { ...prior.result, replayed: true }
      throw new RuntimeError('outcome_unknown', 'Recorded request may have taken effect; inspect terminal list/read before a new request', { requestId: id, recovery: 'terminal list / terminal read' }, 'receipt', 'unknown')
    }
    if (createdAt < this.startedAt) throw new RuntimeError('outcome_unknown', 'Receipt missing for an ID predating this runtime instance; refusing re-execution', { requestId: id, recovery: 'terminal list / terminal read' }, 'receipt', 'unknown')
    const files = fs.readdirSync(directory)
    for (const name of files) if (Number(REQUEST_ID.exec(name.replace(/\.json$/, ''))?.[1] ?? now) < now - RECEIPT_TTL) fs.unlinkSync(path.join(directory, name))
    if (fs.readdirSync(directory).length >= 10000) throw new RuntimeError('receipt_capacity', '24-hour receipt capacity (10000) reached')
    atomicWrite(file, { hash, state: 'pending', createdAt } satisfies Receipt)
    let value: unknown
    try { value = await execute() } catch (error) {
      throw new RuntimeError(error instanceof RuntimeError ? error.code : 'outcome_unknown', error instanceof Error ? error.message : String(error),
        { requestId: id, terminal: inv.flags.terminal ?? null, recovery: 'Retry the same request ID or inspect terminal list/read', detail: error instanceof RuntimeError ? error.resources : undefined },
        error instanceof RuntimeError ? error.stage : 'backend', error instanceof RuntimeError ? error.outcome : 'unknown')
    }
    if (!isRecord(value)) throw new RuntimeError('outcome_unknown', 'Mutation returned an invalid receipt result', { requestId: id }, 'receipt', 'unknown')
    const result = { ...value, requestId: id, replayed: false }
    atomicWrite(file, { hash, state: 'completed', createdAt, result } satisfies Receipt)
    return result
  }
}
