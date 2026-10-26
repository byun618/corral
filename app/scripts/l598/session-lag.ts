// LIFE-598 최종 관문 f1b 원인 확인 — 읽기 + 그 pane 에 `/clear` 한 번: 목록(ctl `state`) agentSession 과 herdr agent_session 이 /clear 뒤 언제 같아지나.
//   npx tsx scripts/l598/session-lag.ts --root /tmp/l598-z6 --pane fl [--ms 20000]
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { TerminalBackend } from '../../src/main/adapter/index.js'
import { openLog } from '../../src/main/log.js'

const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? (process.argv[at + 1] ?? null) : null }
const ROOT = flag('root') ?? ''
if (!/^\/tmp\/l598-z[^/]*$/.test(ROOT)) { console.error('--root 는 /tmp/l598-z*'); process.exit(2) }
openLog(path.join(ROOT, 'driver-log'))
const SOCK = path.join(os.homedir(), '.config/herdr-dev/sessions', `l577g-${path.basename(ROOT)}`, 'herdr.sock')
const terminal = new TerminalBackend(SOCK)
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function ctl(cmd: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(ROOT, 'ctl/ctl.sock'))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(cmd)}\n`))
    socket.on('error', reject)
    socket.on('data', (chunk) => { buffer += chunk; const index = buffer.indexOf('\n'); if (index === -1) return; socket.end(); resolve(JSON.parse(buffer.slice(0, index))) })
  })
}
function find(value: unknown, paneId: string): unknown {
  if (Array.isArray(value)) { for (const item of value) { const hit = find(item, paneId); if (hit !== undefined) return hit } return undefined }
  if (!isRecord(value)) return undefined
  if (value.paneId === paneId && 'agentSession' in value) return value.agentSession
  for (const child of Object.values(value)) { const hit = find(child, paneId); if (hit !== undefined) return hit }
  return undefined
}
const panes: { name: string; paneId: string }[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'panes.json'), 'utf8'))
const pane = panes.find((entry) => entry.name === (flag('pane') ?? 'fl'))
if (pane === undefined || pane.name === 'cs' || pane.name === 'cm') { console.error('pane 은 fl·sw 같은 여분'); process.exit(2) }
const epoch = await terminal.epoch(ctx())
const identity = (await terminal.list(epoch, ctx())).find((entry) => entry.paneId === pane.paneId)!
const cut = (value: unknown) => (typeof value === 'string' ? value.slice(0, 8) : null)
const sample = async () => {
  const list = find(await ctl({ cmd: 'state' }), pane.paneId)
  const herdr = (await terminal.agentInfo(identity, ctx())).session
  return { at: Date.now(), list: isRecord(list) ? cut(list.kind === 'id' ? list.id : list.path) : null, herdr: cut(herdr?.value) }
}
const rows: { at: number; list: string | null; herdr: string | null }[] = []
for (let index = 0; index < 5; index += 1) { rows.push(await sample()); await new Promise((r) => setTimeout(r, 200)) }
const typeAt = Date.now()
await terminal.send(identity, '/clear', ctx())
await new Promise((r) => setTimeout(r, 500))
const enterAt = Date.now()
await terminal.send(identity, '\r', ctx())
const until = Date.now() + Number(flag('ms') ?? 20000)
while (Date.now() < until) { rows.push(await sample()); await new Promise((r) => setTimeout(r, 150)) }
console.log(JSON.stringify({ pane: pane.name, typeAt, enterAt }))
let last = ''
for (const row of rows) {
  const key = `${row.list}/${row.herdr}`
  if (key !== last) console.log(JSON.stringify({ ...row, sinceEnterMs: row.at - enterAt }))
  last = key
}
