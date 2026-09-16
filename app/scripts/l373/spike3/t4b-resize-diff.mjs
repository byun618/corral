// LIFE-373 3차 — T4 보강: T4 의 4연결 라운드는 **네 연결이 같은 크기**를 요청해서
// "서버가 합쳤는지" 와 "값이 같아서 변화가 1번인지" 를 가르지 못한다.
// 여기서는 연결마다 **다른 크기**를 흘려 실제 밀기(area 다툼) 횟수를 잰다.

import { SESSION, clientSocketPath, ctl, layout, loadVendor, measureCpu, paneList, psSample, serverPid, sleep, tabList, writeRaw3 } from './lib3.mjs'

const { EndpointClient } = await loadVendor()
const NONCE = String(Date.now()).slice(-8)
const pid = serverPid()
const created = []
while (tabList().length < 4) {
  const t = ctl('tab', 'create', '--label', `l373s3t4b-${NONCE}-${tabList().length}`)
  created.push(t.tab?.tab_id ?? t.tab_id)
  await sleep(900)
}
const tabs = tabList().map((t) => t.tab_id)
const STEPS = 20
const STEP_MS = 60

const clients = []
for (let i = 0; i < 4; i++) {
  const pane = paneList().find((p) => p.tab_id === tabs[i])
  const c = new EndpointClient(clientSocketPath)
  c.on('error', () => {})
  await c.connect(160, 44)
  await c.callEndpoint('pane.focus', { pane_id: pane.pane_id })
  clients.push({ c, paneId: pane.pane_id, tabId: pane.tab_id })
  await sleep(500)
}
await sleep(1200)

const areaSeries = []
let polling = true
const poller = (async () => {
  let last = null
  while (polling) {
    const a = layout().area
    const key = JSON.stringify(a)
    if (key !== last) { areaSeries.push({ at: Date.now(), area: a }); last = key }
    await sleep(20)
  }
})()

const t0 = Date.now()
const cpu0 = psSample(pid)
// 연결마다 다른 크기 — 창 4개를 동시에 끄는 최악 상황
for (let s = 0; s < STEPS; s++) {
  clients.forEach((cl, i) => cl.c.resize(100 + s * 4 + i * 9, 28 + s + i * 3))
  await sleep(STEP_MS)
}
await sleep(2500)
const cpu1 = psSample(pid)
polling = false
await poller

const spanSec = (cpu1.at - cpu0.at) / 1000
const result = {
  connCount: 4,
  steps: STEPS,
  stepMs: STEP_MS,
  요청resize횟수: STEPS * 4,
  area변화횟수: Math.max(0, areaSeries.length - 1),
  최종area: areaSeries[areaSeries.length - 1]?.area ?? null,
  areaSeries: areaSeries.map((a) => ({ dtMs: a.at - t0, area: a.area })),
  cpu: { spanSec: +spanSec.toFixed(2), cpuSec: +(cpu1.cpuSec - cpu0.cpuSec).toFixed(2), cpuPct: +(((cpu1.cpuSec - cpu0.cpuSec) / spanSec) * 100).toFixed(1), rssKbStart: cpu0.rssKb, rssKbEnd: cpu1.rssKb },
  surfaces: clients.map((cl, i) => {
    const s = cl.c.currentSurface
    return { index: i, tab: cl.tabId, 요청한최종크기: `${100 + (STEPS - 1) * 4 + i * 9}x${28 + (STEPS - 1) + i * 3}`, 받은frame: s === null ? null : `${s.frame.width}x${s.frame.height}` }
  }),
}
console.log(`# T4b conn=4(서로 다른 크기) 요청=${result.요청resize횟수} area변화=${result.area변화횟수} cpu=${result.cpu.cpuSec}s(${result.cpu.cpuPct}%)`)
for (const s of result.surfaces) console.log(`   conn${s.index} 요청=${s.요청한최종크기} 받음=${s.받은frame}`)

for (const cl of clients) cl.c.close()
await sleep(1000)
for (const t of created) { try { ctl('tab', 'close', t) } catch (e) { console.error('close 실패', t, e.message) } ; await sleep(400) }
const cleanup = { closedTabs: created, tabsNow: tabList().map((t) => t.tab_id) }
console.log('# cleanup', JSON.stringify(cleanup))
writeRaw3('t4b-resize-diff.json', { step: 'T4b', at: new Date().toISOString(), session: SESSION, nonce: NONCE, serverPid: pid, result, cleanup })
process.exit(0)
