// 프리플라이트 — **줌이 endpoint 서피스에 비치는가**.
//
// 00-analysis A5 는 `pane.layout` 만 쟀다("플래그만 바뀐다, rect 는 그대로"). 그런데 corral 이
// 실제로 그리는 것은 `pane.layout` 이 아니라 **endpoint 서피스**다 — 서피스가 줌을 반영하면
// F2-3 은 서버가 그려 주는 것을 받는 일이고, 반영하지 않으면 **클라이언트가 전부 그려야** 한다.
// 이 둘은 구현이 완전히 다르다. 기준 F2-3 이 "그리는 건 클라이언트"라고 이미 박았지만
// 근거가 `pane.layout` 실측뿐이라 서피스 쪽을 직접 확인한다.
//
// 절차: 줌 off 에서 전체 서피스 받기 → 줌 on → **크기를 바꿔** 강제 전체 리페인트 → 다시 받기.
// (같은 크기 resize 는 서피스를 안 만드는 것을 m0 에서 확인했으므로 크기를 바꾼다.)

import { clientSocketPath, ctl, layout, loadEndpointClient, paneList, sleep, writeRaw, SESSION } from './lib.mjs'

const EndpointClient = await loadEndpointClient()
const panes = paneList()
const tabId = process.env.L373_TAB ?? panes[0].tab_id
const tabPanes = panes.filter((p) => p.tab_id === tabId)
const zoomTarget = process.env.L373_ZOOM_PANE ?? tabPanes[0].pane_id

const events = []
const client = new EndpointClient(clientSocketPath)
client.on('surface', (s) => {
  events.push({
    at: Date.now(),
    revision: s.surfaceRevision,
    frame: { w: s.frame.width, h: s.frame.height },
    panes: s.panes.map((p) => ({ paneId: p.paneId, rect: p.rect, inner: p.innerRect, focused: p.focused })),
  })
})
client.on('error', (e) => console.error('client error', e?.message ?? e))

const steps = []
const snap = (label) => steps.push({ label, at: Date.now(), eventIndex: events.length, zoomed: layout().zoomed })

await client.connect(190, 48)
client.assertMethod('pane.focus')
await client.callEndpoint('pane.focus', { pane_id: tabPanes[0].pane_id })
await sleep(1500)
snap('attached')

client.resize(188, 47)
await sleep(1200)
snap('full-surface-zoom-off')

ctl('pane', 'zoom', '--on', '--pane', zoomTarget)
await sleep(1000)
snap('zoom-on')

client.resize(186, 46)
await sleep(1500)
snap('full-surface-zoom-on')

client.resize(184, 45)
await sleep(1500)
snap('full-surface-zoom-on-2')

ctl('pane', 'zoom', '--off', '--pane', zoomTarget)
await sleep(1000)
client.resize(182, 44)
await sleep(1500)
snap('full-surface-zoom-off-again')

client.close()

const fullEvents = events.filter((e) => e.panes.length === tabPanes.length)
writeRaw('m0b-zoom-surface.json', { session: SESSION, at: new Date().toISOString(), tabId, zoomTarget, tabPaneIds: tabPanes.map((p) => p.pane_id), steps, events })
for (const s of steps) console.log(s.label.padEnd(28), 'idx', s.eventIndex, 'control.zoomed', s.zoomed)
console.log('--- 전체 서피스(pane 전원) ---')
for (const e of fullEvents) {
  console.log(`rev${e.revision} ${e.frame.w}x${e.frame.h}`, e.panes.map((p) => `${p.paneId}@${p.rect.x},${p.rect.y} ${p.rect.width}x${p.rect.height}`).join(' | '))
}
