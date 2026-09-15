// S1b — 사용자 제안의 실제 모양: pane 마다 **별도 탭** → 연결마다 다른 탭, 탭마다 출력이 돈다.
// S3b — TUI 클라이언트가 붙어 있을 때 endpoint 의 client.resize 가 세션 격자를 흔드는가.
//
// 관문 ②: 판별은 control CLI. 관문 ③: life373- 세션 안에서만 탭을 만들고 지운다.

import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import {
  APP_DIR,
  clientSocketPath,
  ctl,
  layout,
  loadEndpointClient,
  measureCpu,
  paneList,
  serverPid,
  sleep,
  tabList,
  writeRaw,
} from './lib.mjs'

const EndpointClient = await loadEndpointClient()
const pid = serverPid()
const WINDOW_MS = Number(process.env.L373_WINDOW_MS ?? 8000)
const LOAD = `while :; do printf 'L373-LOAD %s\\n' "$(date +%s)"; sleep 0.05; done`

// --- 탭 4개 확보 (부족하면 만들고, 만든 것만 나중에 지운다) ----------------------
const createdTabs = []
while (tabList().length < 4) {
  ctl('tab', 'create', '--label', `l373s1b-${tabList().length}`)
  await sleep(700)
  const tabs = tabList()
  createdTabs.push(tabs[tabs.length - 1].tab_id)
}
const tabs = tabList()
const panes = paneList()
// 탭마다 대표 pane 하나 — 거기에 출력을 돌린다
const perTab = tabs.map((t) => panes.find((p) => p.tab_id === t.tab_id)).filter(Boolean).slice(0, 4)
for (const p of perTab) ctl('pane', 'run', p.pane_id, LOAD)
await sleep(2500)

const clients = []
async function connections(count) {
  while (clients.length < count) {
    const pane = perTab[clients.length]
    const client = new EndpointClient(clientSocketPath)
    client.on('error', () => {})
    let frames = 0
    client.on('surface', () => {
      frames += 1
    })
    await client.connect(160, 44)
    await client.callEndpoint('pane.focus', { pane_id: pane.pane_id })
    clients.push({ paneId: pane.pane_id, tabId: pane.tab_id, client, framesAt: () => frames })
  }
  while (clients.length > count) clients.pop().client.close()
  await sleep(1500)
}

const results = []
async function run(label, count) {
  await connections(count)
  const before = clients.map((c) => c.framesAt())
  const cpu = await measureCpu(pid, WINDOW_MS)
  const after = clients.map((c) => c.framesAt())
  const per = after.map((v, i) => +((v - before[i]) / cpu.spanSec).toFixed(2))
  const row = {
    label,
    connections: count,
    distinctTabs: new Set(clients.map((c) => c.tabId)).size,
    cpuPct: cpu.cpuPct,
    rssKbEnd: cpu.rssKbEnd,
    spanSec: cpu.spanSec,
    surfacesPerSecPerConnection: per,
    surfacesPerSecTotal: +per.reduce((a, b) => a + b, 0).toFixed(2),
    samples: cpu.samples,
  }
  results.push(row)
  console.log(
    `${label} conn=${count}(탭 ${row.distinctTabs}개) → CPU ${row.cpuPct}% RSS ${Math.round(row.rssKbEnd / 1024)}MB surfaces/s=${JSON.stringify(per)} 합=${row.surfacesPerSecTotal}`,
  )
}

for (const count of [0, 1, 2, 4]) await run('load-per-tab', count)
await connections(0)

// --- S3b: TUI 클라이언트를 붙이고 endpoint resize 의 교차 영향을 본다 -------------
const tuiScript = path.join(APP_DIR, 'scripts/l373/spike2/tui.py')
const s3b = { areaBeforeTui: layout().area }
const tui = spawn('python3', [tuiScript, '100', '30'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, L373_SESSION: process.env.L373_SESSION ?? 'life373-claude' },
})
const tuiLog = []
tui.stdout.on('data', (c) => tuiLog.push(String(c)))
tui.stderr.on('data', (c) => tuiLog.push('[err] ' + String(c)))
await sleep(4000)
s3b.areaWithTui = layout().area
s3b.tuiAlive = tui.exitCode === null

if (s3b.tuiAlive) {
  await connections(1)
  await sleep(1500)
  s3b.areaWithTuiAndEndpoint160 = layout().area
  clients[0].client.resize(200, 50)
  await sleep(2000)
  s3b.areaAfterEndpointResize200x50 = layout().area
  clients[0].client.resize(80, 24)
  await sleep(2000)
  s3b.areaAfterEndpointResize80x24 = layout().area
  await connections(0)
  await sleep(1500)
  s3b.areaAfterEndpointClose = layout().area
}
tui.kill('SIGTERM')
await sleep(800)
s3b.areaAfterTuiClose = layout().area
s3b.tuiLogTail = tuiLog.join('').slice(-400)

// --- 정리: 만든 탭만 닫는다 (관문 ③) --------------------------------------------
for (const p of perTab) {
  try {
    ctl('pane', 'send-keys', p.pane_id, 'C-c')
  } catch {
    /* 이미 닫힌 pane */
  }
}
await sleep(600)
const closed = []
for (const tabId of createdTabs) {
  try {
    ctl('tab', 'close', tabId)
    closed.push(tabId)
  } catch (error) {
    closed.push(`${tabId}: 실패 ${String(error).slice(0, 80)}`)
  }
}

writeRaw('s1b-tabs-tui.json', {
  step: 'S1b+S3b',
  at: new Date().toISOString(),
  serverPid: pid,
  windowMs: WINDOW_MS,
  loadCommand: LOAD,
  tabsUsed: perTab.map((p) => ({ pane_id: p.pane_id, tab_id: p.tab_id })),
  createdTabs,
  closedTabs: closed,
  results,
  s3b,
  finalTabs: tabList(),
})
console.log('S3b area 추이:', JSON.stringify(s3b, null, 1).slice(0, 900))
process.exit(0)
