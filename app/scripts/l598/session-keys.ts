// LIFE-598 — 읽기만: 격리 앱 목록(ctl `state`)의 pane `agentSession` 과 herdr `agent.get` 의 `agent_session` 이 같은 source·kind·값인가.
// 허브의 herdr 세션 대조가 키 형식 차이로 거짓 `target_changed` 를 내지 않는지 보는 사전 확인(쓰기 0).
//   npx tsx scripts/l598/session-keys.ts --root /tmp/l598-z1
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { TerminalBackend } from '../../src/main/adapter/index.js'
import { openLog } from '../../src/main/log.js'

const at = process.argv.indexOf('--root')
const ROOT = at >= 0 ? (process.argv[at + 1] ?? '') : ''
if (!/^\/tmp\/l598-z[^/]*$/.test(ROOT)) {
  console.error('--root 는 /tmp/l598-z*')
  process.exit(2)
}
openLog(path.join(ROOT, 'driver-log'))
const SOCK = path.join(os.homedir(), '.config/herdr-dev/sessions', `l577g-${path.basename(ROOT)}`, 'herdr.sock')
const terminal = new TerminalBackend(SOCK)
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function state(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(ROOT, 'ctl/ctl.sock'))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ cmd: 'state' })}\n`))
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      socket.end()
      resolve(JSON.parse(buffer.slice(0, index)))
    })
  })
}

/** state 안 어디든 paneId·agentSession 을 가진 객체를 모은다(모양에 덜 기대려고). */
function collect(value: unknown, into: Map<string, unknown>): void {
  if (Array.isArray(value)) return value.forEach((item) => collect(item, into))
  if (!isRecord(value)) return
  if (typeof value.paneId === 'string' && 'agentSession' in value) into.set(value.paneId, value.agentSession)
  for (const child of Object.values(value)) collect(child, into)
}

const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'panes.json'), 'utf8'))
const panes = (Array.isArray(parsed) ? parsed : []).flatMap((entry: unknown) => (isRecord(entry) && typeof entry.name === 'string' && typeof entry.paneId === 'string' ? [{ name: entry.name, paneId: entry.paneId }] : []))
const listed = new Map<string, unknown>()
collect(await state(), listed)
const epoch = await terminal.epoch(ctx())
const identities = await terminal.list(epoch, ctx())
let failures = 0
for (const pane of panes) {
  const identity = identities.find((entry) => entry.paneId === pane.paneId)
  const observed = identity === undefined ? null : (await terminal.agentInfo(identity, ctx())).session
  const list = listed.get(pane.paneId)
  const listKey = isRecord(list) ? { source: list.source, kind: list.kind, value: list.kind === 'id' ? list.id : list.path } : null
  const same = listKey !== null && observed !== null && listKey.source === observed.source && listKey.kind === observed.kind && listKey.value === observed.value
  if (!same) failures += 1
  // 세션 id 자체는 앞 8자만.
  const cut = (value: unknown) => (typeof value === 'string' ? value.slice(0, 8) : value)
  console.log(JSON.stringify({ name: pane.name, paneId: pane.paneId, list: listKey === null ? null : { ...listKey, value: cut(listKey.value), agent: isRecord(list) ? list.agent : null }, herdr: observed === null ? null : { ...observed, value: cut(observed.value) }, same }))
}
process.exit(failures === 0 ? 0 : 1)
