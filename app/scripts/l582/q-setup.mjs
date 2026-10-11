#!/usr/bin/env node
// LIFE-582 빠른 확인 준비 — 격리 개발 Electron(`l577/g-up.sh` 가 /tmp/l582g-* 에 띄운 것)에 붙는다. 설치본·실제 tailscale·사용자 herdr 무접촉.
//   node scripts/l582/q-setup.mjs mobile  --root /tmp/l582g-q1 --fake /tmp/l582g-fq1   → 모바일 켜기 + 페어링(토큰 <ROOT>/sec/token 0600) + 서버 포트
//   node scripts/l582/q-setup.mjs pane    --root /tmp/l582g-q1 --name q1                → 격리 레포 + 그 레포의 pane id
//   node scripts/l582/q-setup.mjs launch  --root /tmp/l582g-q1 --pane <id>              → 그 pane 에서 `claude --model haiku`(이 시험이 만든 pane 에만)
//   node scripts/l582/q-setup.mjs start   --root /tmp/l582g-q1 --pane <id>             → 그 pane 에 herdr 관리 에이전트로 `claude --model haiku`(GUI 와 같은 `agent.start`)
//   node scripts/l582/q-setup.mjs keys    --root /tmp/l582g-q1 --pane <id> --text <글>  → 그 pane 에 글(첫 실행 신뢰 확인 등 — 이 시험이 만든 pane 에만)
//   node scripts/l582/q-setup.mjs info    --root /tmp/l582g-q1 --pane <id>              → herdr 의 에이전트 상태·세션 참조 유무
//   node scripts/l582/q-setup.mjs revoke  --root /tmp/l582g-q1                          → 시험 기기 해지
// 출력은 JSON 한 줄. 토큰·코드는 출력하지 않는다(G5).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { ctl, status, until } from '../l577/g-lib.mjs'
import { pairDevice, revokeAll, setMobile } from '../l580/lib.mjs'

const { positionals, values: args } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' }, fake: { type: 'string' }, name: { type: 'string' }, pane: { type: 'string' }, text: { type: 'string' } } })
const ROOT = args.root ?? ''
if (!/^\/tmp\/l582g-[^/f][^/]*$/.test(ROOT)) {
  console.error('ROOT 는 /tmp/l582g-*(f 로 시작하지 않는 꼬리)')
  process.exit(2)
}
const SESSION = `l577g-${path.basename(ROOT)}`

function herdr(method, params = {}, timeoutMs = 10_000) {
  if (!SESSION.startsWith('l577g-l582g-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
  const socketPath = path.join(os.homedir(), '.config/herdr-dev/sessions', SESSION, 'herdr.sock')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l582', method, params }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.destroy()
      const message = JSON.parse(buffer.slice(0, index))
      if (message.error) reject(new Error(`${method}: ${message.error.code} ${message.error.message}`))
      else resolve(message.result)
    })
  })
}

const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }
/** 이 시험이 만든 pane 인가 — 격리 ROOT 아래 레포의 pane 만. */
async function ownPane(paneId) {
  const pane = ((await herdr('pane.list')).panes ?? []).find((item) => item.pane_id === paneId)
  if (pane === undefined || typeof pane.cwd !== 'string' || !real(pane.cwd).startsWith(real(ROOT) + path.sep)) throw new Error(`거부: 이 시험이 만든 pane 이 아니다 (${paneId})`)
  return pane
}

const out = (value) => process.stdout.write(JSON.stringify(value) + '\n')

switch (positionals[0]) {
  case 'mobile': {
    if (!/^\/tmp\/l582g-f[^/]*$/.test(args.fake ?? '')) throw new Error('FAKE 는 /tmp/l582g-f*')
    await setMobile(ROOT, args.fake, true)
    const token = await pairDevice(ROOT, { name: 'l582-quick' })
    fs.mkdirSync(path.join(ROOT, 'sec'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(ROOT, 'sec/token'), token, { mode: 0o600, flag: 'wx' })
    const s = await status(ROOT)
    out({ ok: true, serverPort: s.serverPort, exposure: s.exposure.kind, devices: (s.devices ?? []).length, tokenFile: path.join(ROOT, 'sec/token') })
    break
  }
  case 'pane': {
    const repo = path.join(ROOT, args.name ?? 'repo')
    if (!fs.existsSync(path.join(repo, '.git'))) {
      fs.mkdirSync(repo, { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', repo])
      execFileSync('git', ['-C', repo, '-c', 'user.name=l582', '-c', 'user.email=l582@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
    }
    const added = await ctl(ROOT, { cmd: 'add-repo', root: repo })
    if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
    const existing = ((await herdr('pane.list')).panes ?? []).some((item) => typeof item.cwd === 'string' && real(item.cwd) === real(repo))
    if (!existing) await herdr('workspace.create', { cwd: repo, focus: false })
    const pane = await until(async () => ((await herdr('pane.list')).panes ?? []).find((item) => typeof item.cwd === 'string' && real(item.cwd) === real(repo))?.pane_id ?? null, { timeoutMs: 15_000, label: 'pane' })
    out({ ok: true, paneId: pane.value, repo })
    break
  }
  case 'start': {
    const paneId = args.pane ?? ''
    await ownPane(paneId)
    const started = await herdr('agent.start', { name: `l582q-${paneId.replace(/[^a-z0-9]/gi, '')}`, kind: 'claude', pane_id: paneId, args: ['--model', 'haiku'] }, 30_000)
    out({ ok: true, paneId, launchPending: started.agent?.launch_pending ?? null })
    break
  }
  case 'launch':
  case 'keys': {
    const paneId = args.pane ?? ''
    await ownPane(paneId)
    const text = positionals[0] === 'launch' ? 'claude --model haiku\r' : (args.text ?? '').replace(/\\r/g, '\r').replace(/\\e/g, '\x1b')
    await herdr('pane.send_text', { pane_id: paneId, text })
    out({ ok: true, paneId, bytes: Buffer.byteLength(text) })
    break
  }
  case 'info': {
    const pane = await ownPane(args.pane ?? '')
    const agent = await herdr('agent.get', { pane_id: pane.pane_id }).catch((error) => ({ error: String(error.message) }))
    out({ ok: true, paneId: pane.pane_id, agent: agent.agent?.agent ?? agent.agent ?? null, status: agent.agent?.status ?? agent.status ?? null, seq: agent.agent?.state_change_seq ?? null, session: Boolean(pane.agent_session ?? agent.agent?.agent_session), raw: Object.keys(agent) })
    break
  }
  case 'revoke':
    await revokeAll(ROOT)
    out({ ok: true, devices: ((await status(ROOT)).devices ?? []).length })
    break
  default:
    console.error('명령: mobile · pane · launch · keys · info · revoke')
    process.exit(2)
}
process.exit(0)
