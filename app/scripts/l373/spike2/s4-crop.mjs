// S4 — 크롭-N 전제 확인: endpoint 연결 **1개**의 서피스 한 장에 탭 안 pane **둘 다**의 내용이 들어 있나.
// 지금까지는 코드 독해뿐이었다 (`cropFrame(surface.frame, pane.innerRect)`). 실물로 본다.
//
// 판별: 두 pane 에 서로 다른 식별 문자열을 찍고, 한 서피스의 셀 격자에서 둘 다 보이는지.
// 서피스는 endpoint 연결이 준 것이지만, **어느 pane 이 어디인지**(rect)와 pane 목록은
// control CLI(제3 오라클)로도 대조한다.

import {
  clientSocketPath,
  ctl,
  cropText,
  frameToText,
  layout,
  loadEndpointClient,
  paneList,
  sleep,
  writeRaw,
} from './lib.mjs'

const EndpointClient = await loadEndpointClient()
const marker = (n) => `L373S4-MARKER-${n}-${Date.now() % 100000}`

const panes = paneList()
const tabs = new Map()
for (const p of panes) {
  if (!tabs.has(p.tab_id)) tabs.set(p.tab_id, [])
  tabs.get(p.tab_id).push(p)
}
const target = [...tabs.entries()].find(([, ps]) => ps.length >= 2)
if (target === undefined) throw new Error('pane 2개 이상인 탭이 없다 — 준비 단계에서 split 하라')
const [tabId, tabPanes] = target
const [paneA, paneB] = tabPanes

const markers = { [paneA.pane_id]: marker('A'), [paneB.pane_id]: marker('B') }
for (const pane of [paneA, paneB]) {
  ctl('pane', 'run', pane.pane_id, `echo ${markers[pane.pane_id]}`)
}
await sleep(1500)

const before = {
  layout: layout(),
  panes: paneList().map((p) => ({ pane_id: p.pane_id, tab_id: p.tab_id, focused: p.focused })),
}

const client = new EndpointClient(clientSocketPath)
const surfaces = []
client.on('surface', (s) => surfaces.push(s))
await client.connect(200, 50)
// 벤더 세션이 하는 것과 같게 — pane A 로 포커스를 맞춰 그 탭의 서피스를 받는다
await client.callEndpoint('pane.focus', { pane_id: paneA.pane_id })
await sleep(1500)

const surface = client.currentSurface
if (surface === null) throw new Error('서피스를 못 받았다')

const fullText = frameToText(surface.frame)
const joined = fullText.join('\n')
const paneMeta = surface.panes.map((p) => ({
  paneId: p.paneId,
  rect: p.rect,
  innerRect: p.innerRect,
  focused: p.focused,
  cropHasOwnMarker: cropText(surface.frame, p.innerRect).join('\n').includes(markers[p.paneId] ?? 'NO-MARKER'),
}))

const result = {
  step: 'S4',
  at: new Date().toISOString(),
  tabId,
  paneA: paneA.pane_id,
  paneB: paneB.pane_id,
  markers,
  surface: {
    revision: surface.surfaceRevision,
    frame: { width: surface.frame.width, height: surface.frame.height },
    paneCount: surface.panes.length,
    panes: paneMeta,
  },
  found: {
    markerA_inFullSurface: joined.includes(markers[paneA.pane_id]),
    markerB_inFullSurface: joined.includes(markers[paneB.pane_id]),
  },
  surfacesReceived: surfaces.length,
  controlOracle: before,
  fullSurfaceText: fullText,
}
client.close()
writeRaw('s4-crop.json', result)
console.log(
  'S4 연결 1개 · 서피스 pane 수:',
  surface.panes.length,
  '| A 마커:',
  result.found.markerA_inFullSurface,
  '| B 마커:',
  result.found.markerB_inFullSurface,
)
console.log('pane별 크롭에 자기 마커:', paneMeta.map((p) => `${p.paneId}=${p.cropHasOwnMarker}`).join(' '))
process.exit(0)
