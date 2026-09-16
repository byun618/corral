// 프리플라이트 — endpoint 서피스가 **무엇을 싣고 오는가**를 실물로 확인한다.
//
// 왜 필요한가: 설계가 "연결 1개가 탭 전체 격자를 받고 corral 이 pane 사각형으로 잘라 쓴다"에
// 걸려 있는데(01-criteria §0-1), 벤더 클라이언트의 `surface.panes` 는 full surface 와
// **patch** 에서 각각 다른 것을 실어 올 수 있다 (`endpoint-client.ts:465` vs `:513` — patch 는
// panes 배열을 **통째로 교체**한다). 그러면 "이번 프레임에 이 pane 이 없다"가 두 가지 뜻이 된다:
// ① 그 pane 이 이 탭에 없다 ② 이번엔 안 바뀌었다. 구현이 이 둘을 구분해야 한다.
//
// 같이 확인: zoom on/off 일 때 서피스가 어떻게 바뀌나 (A5 는 `pane.layout` 만 쟀다 — 서피스는 공백).
//
// 사용: node scripts/l373impl/m0-surface-shape.mjs

import { clientSocketPath, ctl, layout, loadEndpointClient, paneList, sleep, writeRaw, SESSION } from './lib.mjs'

const EndpointClient = await loadEndpointClient()
const panes = paneList()
const tabId = process.env.L373_TAB ?? panes[0].tab_id
const tabPanes = panes.filter((p) => p.tab_id === tabId)

const events = []
const client = new EndpointClient(clientSocketPath)
client.on('surface', (s) => {
  events.push({
    at: Date.now(),
    revision: s.surfaceRevision,
    frame: { w: s.frame.width, h: s.frame.height },
    paneIds: s.panes.map((p) => p.paneId),
    panes: s.panes.map((p) => ({ paneId: p.paneId, rect: p.rect, inner: p.innerRect, focused: p.focused })),
  })
})
client.on('error', (e) => console.error('client error', e?.message ?? e))

const mark = (label) => ({ label, at: Date.now(), eventIndex: events.length })
const steps = []

await client.connect(200, 50)
client.assertMethod('pane.focus')
steps.push(mark('connected'))
await sleep(800)
steps.push({ ...mark('before-focus'), controlLayout: layout() })

await client.callEndpoint('pane.focus', { pane_id: tabPanes[0].pane_id })
await sleep(1500)
steps.push({ ...mark('after-focus'), controlLayout: layout() })

// 강제 전체 서피스 — 같은 크기로 resize 해도 서버가 리페인트한다 (벤더 주석 :275 "same-size repaints").
client.resize(200, 50)
await sleep(1200)
steps.push(mark('after-resize-same'))

client.resize(180, 46)
await sleep(1500)
steps.push(mark('after-resize-smaller'))

// zoom — 서버 플래그가 서피스에 어떻게 비치나
ctl('pane', 'zoom', '--on')
await sleep(1500)
steps.push({ ...mark('after-zoom-on'), controlLayout: layout() })
client.resize(180, 46)
await sleep(1200)
steps.push(mark('zoom-on-after-repaint'))
ctl('pane', 'zoom', '--off')
await sleep(1500)
steps.push({ ...mark('after-zoom-off'), controlLayout: layout() })

client.close()

writeRaw('m0-surface-shape.json', {
  session: SESSION,
  at: new Date().toISOString(),
  tabId,
  tabPaneIds: tabPanes.map((p) => p.pane_id),
  steps,
  events,
})
for (const s of steps) console.log(s.label.padEnd(24), 'eventIdx', s.eventIndex)
console.log('--- events ---')
for (const [i, e] of events.entries()) console.log(String(i).padStart(3), e.frame.w + 'x' + e.frame.h, 'rev' + e.revision, e.paneIds.join(','))
