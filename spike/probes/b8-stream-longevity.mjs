// B8 후속 — observe 스트림이 얼마나 오래 살아 있는가.
//
// 갱신 지연 측정에서 20개 마커 중 13개까지만 스트림에 나타났고, 프레임이 약 5.5초에
// 뚝 끊겼다 (세 번 재현). 스트림이 죽은 것인지, pane 이 조용해진 것인지, 프로세스가
// 살아 있는데 프레임만 안 오는 것인지를 가른다.
//
// 방법: pane 이 500ms마다 번호를 찍게 해두고 30초 동안 observe 한다.
//       스트림에 나타난 번호 집합과 pane 화면에 실제로 있는 번호를 비교한다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b8-stream-longevity.mjs

import path from 'node:path'
import { spawn } from 'node:child_process'
import { Raw, sleep } from '../lib/raw.mjs'
import { socketPath } from '../lib/herdr.mjs'
import { makeApi, run, readText } from '../lib/pane.mjs'

const raw = new Raw('b8-stream-longevity')
const api = makeApi(raw)
const SPIKE = path.resolve(new URL('..', import.meta.url).pathname)
const SOCK = socketPath()

const P = (await api('pane.list', {})).panes[0].pane_id
await run(api, P, `cd ${SPIKE}`, { settleMs: 500 })

const stripAnsi = (t) =>
  t
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b./g, '')

// pane 이 500ms 마다 번호를 찍게 한다 (60회 = 30초)
await run(api, P, "printf '\\033[2J\\033[H'", { settleMs: 400 })
await api('pane.send_text', {
  pane_id: P,
  text: `for i in $(seq 1 60); do printf 'TICK%03d\\n' "$i"; sleep 0.5; done; sleep 20\n`,
})
await sleep(800)

const startedAt = Date.now()
const frames = []
let buf = ''
const proc = spawn('herdr', ['terminal', 'session', 'observe', P], {
  env: { ...process.env, HERDR_SOCKET_PATH: SOCK },
})
proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const ms = Date.now() - startedAt
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const bytes = msg.bytes ? Buffer.from(msg.bytes, 'base64').toString('utf8') : ''
    frames.push({ ms, type: msg.type, seq: msg.seq ?? null, full: msg.full ?? null, len: bytes.length, text: stripAnsi(bytes) })
    raw.log('frame', { ms, type: msg.type, seq: msg.seq ?? null, full: msg.full ?? null, len: bytes.length })
  }
})
const stderrBuf = []
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (d) => stderrBuf.push(d))
let exited = null
proc.on('exit', (code, signal) => {
  exited = { ms: Date.now() - startedAt, code, signal }
  raw.log('exit', exited)
})

// 25초 시점에 관찰자를 새로 하나 더 붙인다. 새 관찰자가 최신 화면을 받으면
// 조용해진 건 서버가 아니라 그 스트림 하나다.
await sleep(25000)
const lateFrames = []
let lateBuf = ''
const lateStartedAt = Date.now()
const late = spawn('herdr', ['terminal', 'session', 'observe', P], {
  env: { ...process.env, HERDR_SOCKET_PATH: SOCK },
})
late.stdout.setEncoding('utf8')
late.stdout.on('data', (chunk) => {
  lateBuf += chunk
  let nl
  while ((nl = lateBuf.indexOf('\n')) !== -1) {
    const line = lateBuf.slice(0, nl)
    lateBuf = lateBuf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const bytes = msg.bytes ? Buffer.from(msg.bytes, 'base64').toString('utf8') : ''
    lateFrames.push({ ms: Date.now() - lateStartedAt, seq: msg.seq ?? null, text: stripAnsi(bytes) })
    raw.log('late.frame', { ms: Date.now() - lateStartedAt, seq: msg.seq ?? null, len: bytes.length })
  }
})

await sleep(7000)
const alive = exited === null
proc.kill('SIGTERM')
late.kill('SIGTERM')
await sleep(300)

const lateTicks = new Set()
for (const f of lateFrames) for (const m of f.text.matchAll(/TICK(\d{3})/g)) lateTicks.add(Number(m[1]))

const streamTicks = new Set()
for (const f of frames) for (const m of f.text.matchAll(/TICK(\d{3})/g)) streamTicks.add(Number(m[1]))
const paneText = await readText(api, P, 'visible')
const paneTicks = new Set([...paneText.text.matchAll(/TICK(\d{3})/g)].map((m) => Number(m[1])))

const lastFrame = frames.length ? frames[frames.length - 1] : null
const R = {
  observedForMs: 32000,
  frames: frames.length,
  firstFrameMs: frames[0]?.ms ?? null,
  lastFrameMs: lastFrame?.ms ?? null,
  silenceAfterLastFrameMs: lastFrame ? 32000 - lastFrame.ms : null,
  processStillAliveAt32s: alive,
  exit: exited,
  stderr: stderrBuf.join('').slice(0, 500),
  frameTypes: [...new Set(frames.map((f) => f.type))],
  seqRange: frames.length ? [frames[0].seq, lastFrame.seq] : null,
  streamTicks: [...streamTicks].sort((a, b) => a - b),
  streamTickMax: streamTicks.size ? Math.max(...streamTicks) : null,
  paneTicksVisibleAtEnd: [...paneTicks].sort((a, b) => a - b).slice(-5),
  paneTickMax: paneTicks.size ? Math.max(...paneTicks) : null,
  lateObserver: {
    startedAtMs: 25000,
    frames: lateFrames.length,
    ticks: [...lateTicks].sort((a, b) => a - b),
    tickMax: lateTicks.size ? Math.max(...lateTicks) : null,
    note: '먼저 붙은 스트림이 조용해진 뒤 새로 붙인 관찰자',
  },
  verdict: null,
}
R.serverStillStreaming =
  R.lateObserver.tickMax !== null && R.lateObserver.tickMax > R.streamTickMax
R.verdict =
  R.streamTickMax === null
    ? '스트림이 아무 틱도 전달하지 못했다'
    : R.paneTickMax > R.streamTickMax
      ? `스트림이 TICK${String(R.streamTickMax).padStart(3, '0')} 이후로 조용해졌다 — pane 은 TICK${String(R.paneTickMax).padStart(3, '0')} 까지 찍었다`
      : '스트림이 끝까지 따라왔다'

console.log(JSON.stringify({ ...R, streamTicks: R.streamTicks.length + '개' }, null, 1))
await api('pane.send_text', { pane_id: P, text: '\x03' })
raw.close({ probe: 'b8-stream-longevity', at: new Date().toISOString(), results: R })
process.exit(0)
