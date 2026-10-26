// LIFE-598 최종 관문 4c·4d 양성 대조 — 포커스 전환(endpoint `pane.focus`, corral GUI 와 같은 클라이언트)이 1004(포커스 보고)를 켠 pane 의 입력 revision 을 올리는가.
// 여분 셸 pane(fp, 이 시험이 만든 것)에서 `printf '\e[?1004h'` 뒤 cat 으로 붙잡고 포커스를 옮겨 revision 차이를 본다. 1004 끔(`\e[?1004l`)은 음성 대조.
//   npx tsx scripts/l598/focus-probe.ts --root /tmp/l598-z6
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import { TerminalBackend } from '../../src/main/adapter/index.js'
import { EndpointClient } from '../../src/main/adapter/internal/vendor/endpoint-client.js'
import { openLog } from '../../src/main/log.js'

const at = process.argv.indexOf('--root')
const ROOT = at >= 0 ? (process.argv[at + 1] ?? '') : ''
if (!/^\/tmp\/l598-z[^/]*$/.test(ROOT)) { console.error('--root 는 /tmp/l598-z*'); process.exit(2) }
const APP = process.cwd()
const SESSION = `l577g-${path.basename(ROOT)}`
const GUARD = execFileSync('sh', ['-c', `ps -axo command= | grep -- '--session ${SESSION} server' | grep -v grep | head -1 | cut -d' ' -f1`], { encoding: 'utf8' }).trim()
const herdr = (...args: string[]) => execFileSync(GUARD, ['--session', SESSION, ...args], { encoding: 'utf8' })
// 입력 revision = guard 봉투 agent.get 의 corral_input_revision(`pane get` 의 revision 은 다른 값 — f4e 첫 실행이 그것을 읽어 무효).
openLog(path.join(ROOT, 'driver-log'))
const SOCK = path.join(os.homedir(), '.config/herdr-dev/sessions', SESSION, 'herdr.sock')
const terminal = new TerminalBackend(SOCK)
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })
const revision = async (paneId: string): Promise<number | null> => {
  const epoch = await terminal.epoch(ctx())
  const pane = (await terminal.list(epoch, ctx())).find((entry) => entry.paneId === paneId)
  if (pane === undefined) return null
  const reply: { result?: { agent?: { corral_input_revision?: number } } } = await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'l598fp', method: 'corral.terminal', params: { epoch: pane.epoch, deadline_ms: Date.now() + 10_000, pane_id: pane.paneId, terminal_id: pane.ptyId, operation: { method: 'agent.get', params: { target: paneId } } } })}\n`))
    socket.on('data', (chunk) => { buffer += chunk; const index = buffer.indexOf('\n'); if (index === -1) return; socket.end(); resolve(JSON.parse(buffer.slice(0, index))) })
  })
  return reply.result?.agent?.corral_input_revision ?? null
}
const qsetup = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [path.join(APP, 'scripts/l598/q-setup.mjs'), ...args, '--root', ROOT], { encoding: 'utf8' }).trim().split('\n').at(-1) ?? '{}')
const out = (step: string, data: Record<string, unknown>) => console.log(JSON.stringify({ step, at: new Date().toISOString(), ...data }))

const made = qsetup('pane', '--name', 'fp')
const fp: string = made.paneId
// 셸 pane 에 에이전트를 붙여야 agent.get(입력 revision)이 답한다 — provider 없이 report-agent(설정 무접촉).
herdr('pane', 'report-agent', '--source', 'l598probe', '--agent', 'claude', '--state', 'idle', fp)
await delay(800)
const sendBefore = await revision(fp)
herdr('pane', 'send-text', fp, 'x')
await delay(500)
out('revision-control', { fp, before: sendBefore, afterOneKey: await revision(fp) })
herdr('pane', 'send-text', fp, '\x15')
await delay(500)
const other = 'w1:p1'
const client = new EndpointClient(path.join(os.homedir(), '.config/herdr-dev/sessions', SESSION, 'herdr-client.sock'))
client.on('error', () => {})
await client.connect(120, 40)
await delay(1500)
const round = async (label: string, mode: 'h' | 'l') => {
  herdr('pane', 'send-text', fp, `printf '\\033[?1004${mode}'; cat\r`)
  await delay(1500)
  await client.callEndpoint('pane.focus', { pane_id: fp })
  await delay(800)
  const before = { fp: await revision(fp), other: await revision(other) }
  await client.callEndpoint('pane.focus', { pane_id: other })
  await delay(700)
  await client.callEndpoint('pane.focus', { pane_id: fp })
  await delay(800)
  const after = { fp: await revision(fp), other: await revision(other) }
  out(label, { fp, mode: `1004${mode}`, before, after, fpDelta: after.fp === null || before.fp === null ? null : after.fp - before.fp, otherDelta: after.other === null || before.other === null ? null : after.other - before.other })
  herdr('pane', 'send-text', fp, '\x03')
  await delay(800)
}
await round('focus-probe-on', 'h')
await round('focus-probe-off', 'l')
client.close()
herdr('pane', 'close', fp)
out('closed', { fp })
