import fs from 'node:fs'
import path from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { privateDirectory } from '../storage.js'
import { RuntimeError } from '../contracts.js'
export class Tokens {
  private readonly key: Buffer
  constructor(userData: string) {
    const directory = path.join(userData, 'runtime/terminal'); privateDirectory(directory)
    const file = path.join(directory, 'key')
    if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' })
    this.key = fs.readFileSync(file)
    if (this.key.length !== 32) throw new RuntimeError('storage_corrupt', 'Invalid terminal token key')
  }
  encode(kind: 't1' | 'c1', payload: unknown): string {
    const data = `${kind}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
    return `${data}.${createHmac('sha256', this.key).update(data).digest('base64url')}`
  }
  decode<T>(kind: 't1' | 'c1', token: string): T {
    try {
      const [prefix, payload, mac, extra] = token.split('.')
      if (prefix !== kind || !payload || !mac || extra || token.length > 8192) throw new Error('shape')
      const actual = Buffer.from(mac, 'base64url'), expected = createHmac('sha256', this.key).update(`${prefix}.${payload}`).digest()
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('signature')
      const decoded: T = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      return decoded
    } catch { throw new RuntimeError(kind === 't1' ? 'invalid_terminal' : 'invalid_cursor', 'Invalid token or token belongs to another profile') }
  }
}
