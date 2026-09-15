// S1 — endpoint 연결 수별 **herdr 서버** CPU·RSS.
//
// 관문 ⑤: CPU 는 순간 %cpu 가 아니라 cputime 델타 ÷ 구간 (ps, 앱 바깥 오라클).
// 관문 ②: 연결 수·pane 상태는 control CLI 로 확인한다.
//
// 측정 조건 두 가지:
//   idle — 아무 pane 도 출력하지 않음 (herdr#3822 의 "idle 클라도 SemanticFrame 을 받는다" 검증)
//   load — pane 하나가 초당 ~20줄을 찍는 중

import {
  clientSocketPath,
  ctl,
  layout,
  loadEndpointClient,
  measureCpu,
  paneList,
  serverPid,
  sleep,
  writeRaw,
} from './lib.mjs'

const EndpointClient = await loadEndpointClient()
const pid = serverPid()
if (pid === null) throw new Error('life373 herdr 서버 PID 를 못 찾았다')

const WINDOW_MS = Number(process.env.L373_WINDOW_MS ?? 8000)
const panes = paneList()
const byTab = new Map()
for (const p of panes) {
  if (!byTab.has(p.tab_id)) byTab.set(p.tab_id, [])
  byTab.get(p.tab_id).push(p)
}
const picked = []
for (const [, ps] of byTab) for (const p of ps.slice(0, 2)) picked.push(p)
if (picked.length < 4) throw new Error(`pane 4개가 필요하다 (현재 ${picked.length})`)

const LOAD_PANE = picked[0].pane_id
const results = []
const clients = []

async function ensureConnections(count) {
  while (clients.length < count) {
    const pane = picked[clients.length]
    const client = new EndpointClient(clientSocketPath)
    client.on('error', () => {})
    let frames = 0
    client.on('surface', () => {
      frames += 1
    })
    await client.connect(160, 44)
    await client.callEndpoint('pane.focus', { pane_id: pane.pane_id })
    clients.push({ paneId: pane.pane_id, client, framesAt: () => frames })
  }
  while (clients.length > count) {
    const c = clients.pop()
    c.client.close()
  }
  await sleep(1500)
}

async function run(mode, count) {
  await ensureConnections(count)
  const before = clients.map((c) => c.framesAt())
  const cpu = await measureCpu(pid, WINDOW_MS)
  const after = clients.map((c) => c.framesAt())
  const framesPerSec = after.map((v, i) => +((v - before[i]) / cpu.spanSec).toFixed(2))
  const row = {
    mode,
    connections: count,
    cpuPct: cpu.cpuPct,
    cpuSec: cpu.cpuSec,
    spanSec: cpu.spanSec,
    rssKbEnd: cpu.rssKbEnd,
    rssKbMax: cpu.rssKbMax,
    surfacesPerSecPerConnection: framesPerSec,
    surfacesPerSecTotal: +framesPerSec.reduce((a, b) => a + b, 0).toFixed(2),
    controlFocused: layout().focused_pane_id,
    samples: cpu.samples,
  }
  results.push(row)
  console.log(
    `${mode} conn=${count} → CPU ${row.cpuPct}% RSS ${Math.round(row.rssKbEnd / 1024)}MB ` +
      `surfaces/s=${JSON.stringify(framesPerSec)} (합 ${row.surfacesPerSecTotal})`,
  )
  return row
}

// --- idle ---------------------------------------------------------------------
for (const count of [0, 1, 2, 4]) await run('idle', count)

// --- load: pane 하나가 초당 ~20줄 -----------------------------------------------
await ensureConnections(0)
ctl('pane', 'run', LOAD_PANE, `while :; do printf 'L373-LOAD %s\\n' "$(date +%s)"; sleep 0.05; done`)
await sleep(2000)
for (const count of [0, 1, 2, 4]) await run('load', count)
await ensureConnections(0)
ctl('pane', 'send-keys', LOAD_PANE, 'C-c')
await sleep(800)

writeRaw('s1-cost.json', {
  step: 'S1',
  at: new Date().toISOString(),
  serverPid: pid,
  windowMs: WINDOW_MS,
  loadPane: LOAD_PANE,
  loadCommand: "while :; do printf 'L373-LOAD %s\\n' \"$(date +%s)\"; sleep 0.05; done",
  picked: picked.map((p) => ({ pane_id: p.pane_id, tab_id: p.tab_id })),
  results,
})
process.exit(0)
