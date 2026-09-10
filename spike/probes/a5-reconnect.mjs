// A5 끊김 복구 — 서버를 실제로 죽였다 살린다.
// 세션을 파괴하므로 a-socket.mjs 와 따로 돈다. 대상은 spike-claude 세션뿐이다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/a5-reconnect.mjs

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Conn, socketPath, SESSION_NAME } from '../lib/herdr.mjs'
import { Raw, sleep } from '../lib/raw.mjs'

const exec = promisify(execFile)
const raw = new Raw('a5-reconnect')
const SOCK = socketPath() // 여기서 격리 가드가 한 번 더 걸린다
const R = { socket: SOCK, session: SESSION_NAME }

const SUBS = [{ type: 'pane.created' }, { type: 'pane.closed' }]

/** 구독 커넥션 1개. 요청은 못 섞으므로 (A2-x2) 오로지 push 만 받는다. */
function subscribe(label, onPush, onDrop) {
  return new Promise((resolve, reject) => {
    const c = new Conn({
      onLine: ({ at, line }) => {
        raw.wire('rx', line, { label })
        const m = JSON.parse(line)
        if (m.id === 'sub') resolve({ conn: c, ackAt: at, ack: m })
        else onPush?.({ at, msg: m })
      },
      onClose: () => onDrop?.(Date.now()),
    })
    c.connect().then(() => {
      const t = JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: SUBS } }) + '\n'
      raw.wire('tx', t.trimEnd(), { label })
      c.sock.write(t)
    }, reject)
  })
}

/** 요청 1건 = 커넥션 1개 (서버가 응답 뒤 닫는다). */
function once(method, params = {}, { timeoutMs = 4000 } = {}) {
  const c = new Conn({ onLine: ({ line }) => raw.wire('rx', line, { method }) })
  return c.connect().then(() => c.request(method, params, { timeoutMs }).finally(() => c.end()))
}

// --- 1단계: 정상 상태에서 구독 + 스냅샷 ----------------------------------
const pushes = []
let dropAt = null
const s1 = await subscribe('before', (p) => pushes.push(p), (at) => (dropAt ??= at))
raw.log('A5.subscribed', {})
const snap1 = await once('session.snapshot')
R.before = {
  ack: s1.ack.result,
  snapshotPanes: panes(snap1.result),
}
console.log('before: panes', R.before.snapshotPanes)

// --- 2단계: 서버를 죽인다 ------------------------------------------------
raw.log('A5.kill.begin', { cmd: `herdr session stop ${SESSION_NAME}` })
const killT0 = Date.now()
try {
  const { stdout, stderr } = await exec('herdr', ['session', 'stop', SESSION_NAME])
  raw.log('A5.kill.done', { stdout: stdout.trim(), stderr: stderr.trim() })
} catch (err) {
  raw.log('A5.kill.error', { error: String(err) })
}

// --- 3단계: 클라이언트가 끊김을 어떻게 감지하나 --------------------------
const deadline = Date.now() + 10000
while (dropAt === null && Date.now() < deadline) await sleep(20)
R.disconnect = {
  detected: dropAt !== null,
  // EOF(close 이벤트)로 감지했는가 — 에러 프레임이 아니라
  detectedBy: dropAt !== null ? 'socket close (EOF)' : 'not detected within 10s',
  msAfterKillCommand: dropAt !== null ? dropAt - killT0 : null,
  pushesBeforeDrop: pushes.length,
}
console.log('disconnect:', JSON.stringify(R.disconnect))

// --- 4단계: 서버가 없는 동안 재연결 시도가 어떻게 실패하나 ---------------
const downAttempts = []
for (let i = 0; i < 3; i++) {
  const t = Date.now()
  try {
    const r = await once('ping', {}, { timeoutMs: 2000 })
    downAttempts.push({ i, ms: Date.now() - t, ok: true, response: r.result ?? r.error })
  } catch (err) {
    downAttempts.push({ i, ms: Date.now() - t, ok: false, code: err.code ?? null, error: String(err) })
  }
  await sleep(400)
}
R.whileDown = downAttempts
raw.log('A5.whileDown', { downAttempts })
console.log('whileDown:', downAttempts.map((a) => a.code ?? (a.ok ? 'ok' : 'err')).join(','))

// --- 5단계: 세션 재기동 --------------------------------------------------
// 헤드리스 자동 기동이 안 된다 (01-criteria.md §0 규약 1). Orca 탭으로 띄운다.
raw.log('A5.restart.begin', {})
const restartT0 = Date.now()
const { stdout: created } = await exec('orca', [
  'terminal',
  'create',
  '--title',
  `herdr: ${SESSION_NAME}`,
  '--command',
  `herdr session attach ${SESSION_NAME}`,
  '--json',
])
raw.log('A5.restart.spawned', { stdout: created.trim() })
console.log('restart tab:', created.trim().slice(0, 200))

// --- 6단계: 재연결 + 재구독 + 스냅샷 재획득 ------------------------------
const reconnectAttempts = []
let reconnected = null
const upDeadline = Date.now() + 60000
while (Date.now() < upDeadline) {
  const t = Date.now()
  try {
    const r = await once('ping', {}, { timeoutMs: 2000 })
    reconnectAttempts.push({ ms: Date.now() - t, ok: true })
    reconnected = Date.now()
    break
  } catch (err) {
    reconnectAttempts.push({ ms: Date.now() - t, ok: false, code: err.code ?? null })
  }
  await sleep(500)
}
raw.log('A5.reconnect', { attempts: reconnectAttempts.length, reconnected: !!reconnected })

if (!reconnected) {
  R.after = { reconnected: false, note: '60초 안에 서버가 다시 뜨지 않았다' }
} else {
  const pushes2 = []
  const s2 = await subscribe('after', (p) => pushes2.push(p))
  const snap2 = await once('session.snapshot')
  // 재구독이 실제로 사는지 — pane 을 하나 만들고 지워 push 를 확인한다.
  const sp = await once('pane.split', { direction: 'right' })
  const newPane = sp.result?.pane?.pane_id
  await sleep(500)
  if (newPane) await once('pane.close', { pane_id: newPane })
  await sleep(800)
  s2.conn.end()
  R.after = {
    reconnected: true,
    msFromRestartCommand: reconnected - restartT0,
    msFromKill: reconnected - killT0,
    reconnectAttempts: reconnectAttempts.length,
    resubscribeAck: s2.ack.result,
    snapshotPanes: panes(snap2.result),
    pushesAfterResubscribe: pushes2.map((p) => p.msg.event),
    livePushWorks: pushes2.some((p) => p.msg.event === 'pane_created'),
  }
}
console.log('after:', JSON.stringify(R.after))

R.verdict = {
  detectedDisconnect: R.disconnect.detected,
  reconnected: !!R.after.reconnected,
  resubscribed: !!R.after.resubscribeAck,
  snapshotReacquired: Array.isArray(R.after.snapshotPanes),
  livePushWorks: !!R.after.livePushWorks,
  // 통과선: 끊김 감지 + 재연결 + 재구독 + 스냅샷 재획득
  pass:
    R.disconnect.detected &&
    !!R.after.reconnected &&
    !!R.after.resubscribeAck &&
    Array.isArray(R.after.snapshotPanes) &&
    !!R.after.livePushWorks,
  // 자동 기동 여부는 별개 사실 — 서버는 스스로 뜨지 않는다
  serverAutoRestart: false,
}
console.log('A5', R.verdict.pass ? 'PASS' : 'FAIL')

raw.close({ probe: 'a5-reconnect', at: new Date().toISOString(), results: R })
process.exit(0)

function panes(result) {
  const out = []
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n && typeof n === 'object') {
      if (typeof n.pane_id === 'string') out.push(n.pane_id)
      Object.values(n).forEach(walk)
    }
  }
  walk(result)
  return [...new Set(out)].sort()
}
