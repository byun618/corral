// LIFE-373 3차 — T4: 연속 resize 가 세션 격자(area)를 몇 번 흔드나 + herdr 서버 비용. 연결 1개 vs 4개.
// 창 리사이즈 한 번이 수십 프레임의 resize 를 흘리는 상황을 흉내낸다 (20단계).
// 판별자: control 소켓 pane.layout 의 area (별도 커넥션). 비용: ps cputime 델타(관문 ⑤).

import { SESSION, clientSocketPath, ctl, layout, loadVendor, measureCpu, paneList, psSample, serverPid, sleep, tabList, writeRaw3 } from './lib3.mjs'

const { EndpointClient } = await loadVendor()
const NONCE = String(Date.now()).slice(-8)
const pid = serverPid()
if (pid === null) throw new Error('life373 herdr 서버 PID 를 찾지 못했다')

const created = { tabs: [] }
// 연결 4개가 서로 다른 탭을 보게 한다 (① 탭 그룹 분할 상황).
while (tabList().length < 4) {
  const t = ctl('tab', 'create', '--label', `l373s3t4-${NONCE}-${tabList().length}`)
  created.tabs.push(t.tab?.tab_id ?? t.tab_id)
  await sleep(900)
}
const tabs = tabList().map((t) => t.tab_id)
const paneOfTab = (tabId) => paneList().find((p) => p.tab_id === tabId)

const STEPS = 20
const STEP_MS = 60 // 창 드래그 리사이즈의 프레임 간격 정도

async function round(label, connCount) {
  const clients = []
  for (let i = 0; i < connCount; i++) {
    const pane = paneOfTab(tabs[i % tabs.length])
    const c = new EndpointClient(clientSocketPath)
    c.on('error', () => {})
    await c.connect(160, 44)
    await c.callEndpoint('pane.focus', { pane_id: pane.pane_id })
    clients.push({ c, paneId: pane.pane_id, tabId: pane.tab_id })
    await sleep(500)
  }
  await sleep(1200)

  // area 변화를 control 소켓으로 폴링한다 (연결 서피스를 판별자로 쓰지 않는다)
  const areaSeries = []
  let polling = true
  const poller = (async () => {
    let last = null
    while (polling) {
      const a = layout().area
      const key = JSON.stringify(a)
      if (key !== last) {
        areaSeries.push({ at: Date.now(), area: a })
        last = key
      }
      await sleep(25)
    }
  })()

  const t0 = Date.now()
  const cpu0 = psSample(pid)
  // 20단계 연속 resize — 모든 연결이 동시에 흘린다 (창 하나를 끄는 상황)
  for (let s = 0; s < STEPS; s++) {
    const cols = 120 + s * 4
    const rows = 30 + s
    for (const cl of clients) cl.c.resize(cols, rows)
    await sleep(STEP_MS)
  }
  await sleep(2000) // 밀린 처리 흡수
  const cpu1 = psSample(pid)
  polling = false
  await poller

  const surfaces = clients.map((cl, i) => {
    const s = cl.c.currentSurface
    return { index: i, tab: cl.tabId, pane: cl.paneId, frame: s === null ? null : `${s.frame.width}x${s.frame.height}`, revision: s?.surfaceRevision ?? null }
  })
  for (const cl of clients) cl.c.close()
  await sleep(1000)

  const spanSec = (cpu1.at - cpu0.at) / 1000
  const r = {
    label,
    connCount,
    steps: STEPS,
    stepMs: STEP_MS,
    요청resize횟수: STEPS * connCount,
    area변화횟수: Math.max(0, areaSeries.length - 1),
    areaSeries: areaSeries.map((a) => ({ dtMs: a.at - t0, area: a.area })),
    cpu: { spanSec: +spanSec.toFixed(2), cpuSec: +(cpu1.cpuSec - cpu0.cpuSec).toFixed(2), cpuPct: +(((cpu1.cpuSec - cpu0.cpuSec) / spanSec) * 100).toFixed(1), rssKbStart: cpu0.rssKb, rssKbEnd: cpu1.rssKb },
    surfaces,
  }
  console.log(`# ${label} conn=${connCount} 요청=${r.요청resize횟수} area변화=${r.area변화횟수} cpu=${r.cpu.cpuSec}s(${r.cpu.cpuPct}%) rss=${cpu0.rssKb}→${cpu1.rssKb}KB`)
  return r
}

// 유휴 기준선 — resize 없이 같은 길이만큼 재서 바닥 비용을 뺀다
const idle = await measureCpu(pid, 4000)
console.log(`# idle cpu=${idle.cpuSec}s(${idle.cpuPct}%)`)

const r1 = await round('conn1', 1)
await sleep(2000)
const r4 = await round('conn4', 4)

for (const t of created.tabs) {
  try { ctl('tab', 'close', t) } catch (e) { console.error('tab close 실패', t, e.message) }
  await sleep(500)
}
const cleanup = { closedTabs: created.tabs, tabsNow: tabList().map((t) => t.tab_id) }
console.log('# cleanup', JSON.stringify(cleanup))

writeRaw3('t4-resize-push.json', { step: 'T4', at: new Date().toISOString(), session: SESSION, nonce: NONCE, serverPid: pid, idle, rounds: [r1, r4], cleanup })
process.exit(0)
