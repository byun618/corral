// 프리플라이트 — pane **장식(테두리) 셀**이 얼마나 먹는가, pane 수에 따라 달라지는가.
//
// 왜: 새 렌더 모델은 "격자 요청 → 서버 rect(셀) → DOM 상자"다. 그러면 pane 사이 간격·바깥 여백이
// **herdr 장식 셀**로 정해진다 — `--pad-pane`(8px 10px 4px)과 얼마나 벌어지는지 알아야 C5 편차를
// 정직하게 적을 수 있다. 단일 pane 일 때 장식이 0 인지도 확인한다(C2 단일 pane 회귀에 직결).
//
// 사용: node scripts/l373impl/m0c-decoration.mjs

import { clientSocketPath, ctl, loadEndpointClient, paneList, sleep, writeRaw, SESSION } from './lib.mjs'

const EndpointClient = await loadEndpointClient()

async function probe(tabPaneId, label, grid) {
  const client = new EndpointClient(clientSocketPath)
  const got = []
  client.on('surface', (s) => got.push(s))
  client.on('error', () => {})
  await client.connect(grid.cols, grid.rows)
  client.assertMethod('pane.focus')
  await client.callEndpoint('pane.focus', { pane_id: tabPaneId })
  await sleep(1500)
  client.resize(grid.cols - 2, grid.rows - 1)
  await sleep(1500)
  const full = got.filter((s) => s.panes.length > 1 || got.length === 1)
  const last = got[got.length - 1]
  const best = full[full.length - 1] ?? last
  client.close()
  return {
    label,
    grid,
    frame: best ? { w: best.frame.width, h: best.frame.height } : null,
    panes: (best?.panes ?? []).map((p) => ({
      paneId: p.paneId,
      rect: p.rect,
      inner: p.innerRect,
      decoX: p.rect.width - p.innerRect.width,
      decoY: p.rect.height - p.innerRect.height,
      offX: p.innerRect.x - p.rect.x,
      offY: p.innerRect.y - p.rect.y,
    })),
  }
}

const out = { session: SESSION, at: new Date().toISOString(), probes: [] }

// ① 새 탭(단일 pane)
const created = ctl('tab', 'create')
const newTabId = created.tab.tab_id
const newPaneId = created.root_pane.pane_id
await sleep(800)
out.probes.push(await probe(newPaneId, 'single-pane', { cols: 160, rows: 44 }))

// ② 같은 탭을 2분할
ctl('pane', 'split', '--direction', 'right', '--ratio', '0.5')
await sleep(800)
const after2 = paneList().filter((p) => p.tab_id === newTabId)
out.probes.push(await probe(newPaneId, `two-pane(${after2.length})`, { cols: 160, rows: 44 }))

// ③ 4분할
ctl('pane', 'split', '--direction', 'down', '--ratio', '0.5')
await sleep(800)
out.probes.push(await probe(newPaneId, 'three-pane', { cols: 160, rows: 44 }))

// 정리 — 만든 탭만 닫는다 (격리 복귀)
ctl('tab', 'close', newTabId)
await sleep(500)
out.finalTabs = ctl('tab', 'list').tabs.map((t) => t.tab_id)

writeRaw('m0c-decoration.json', out)
for (const p of out.probes) {
  console.log(`\n## ${p.label}  frame ${p.frame?.w}x${p.frame?.h}`)
  for (const q of p.panes) {
    console.log(`  ${q.paneId} rect ${q.rect.x},${q.rect.y} ${q.rect.width}x${q.rect.height}  inner ${q.inner.x},${q.inner.y} ${q.inner.width}x${q.inner.height}  장식 ${q.decoX}x${q.decoY} off ${q.offX},${q.offY}`)
  }
}
console.log('\nfinalTabs', out.finalTabs)
