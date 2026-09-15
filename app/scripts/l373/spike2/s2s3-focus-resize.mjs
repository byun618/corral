// S2 — 포커스 거동: endpoint 연결 N개가 각자 다른 pane/탭을 focus 할 때 서로 뺏는가.
// S3 — client.resize 교차 영향: 연결 A 의 크기 변경이 연결 B·세션 격자를 흔드는가.
//
// 관문 ②: 판별은 **control CLI**(별도 커넥션)의 pane.layout / tab.list 로 한다.
// 연결 자신의 서피스는 "그 연결이 무엇을 받고 있나"를 보는 용도로만 같이 기록한다.

import {
  clientSocketPath,
  ctl,
  layout,
  loadEndpointClient,
  paneList,
  sleep,
  tabList,
  writeRaw,
} from './lib.mjs'

const EndpointClient = await loadEndpointClient()
const steps = []
const record = (label, extra = {}) => {
  const l = layout()
  const entry = {
    label,
    at: new Date().toISOString(),
    // 제3 오라클 — 세션 전역 상태
    control: {
      focusedPaneId: l.focused_pane_id,
      area: l.area,
      panes: l.panes.map((p) => ({ id: p.pane_id, rect: p.rect, focused: p.focused })),
      tabs: tabList().map((t) => ({ id: t.tab_id, focused: t.focused, label: t.label ?? null })),
    },
    ...extra,
  }
  steps.push(entry)
  return entry
}

// --- 준비: 2개 탭 × 2 pane = pane 4개 (서로 다른 탭이 있어야 "탭 뺏김"을 볼 수 있다) ---
const created = { tabs: [], panes: [] }
let panes = paneList()
const tabsOf = () => {
  const m = new Map()
  for (const p of paneList()) {
    if (!m.has(p.tab_id)) m.set(p.tab_id, [])
    m.get(p.tab_id).push(p)
  }
  return m
}
let byTab = tabsOf()
if (byTab.size < 2) {
  const tab = ctl('tab', 'create', '--label', 'l373s2')
  created.tabs.push(tab.tab?.tab_id ?? tab.tab_id ?? null)
  await sleep(600)
  byTab = tabsOf()
}
// 각 탭이 pane 2개를 갖게 한다
for (const [tabId, ps] of tabsOf()) {
  if (ps.length < 2) {
    const target = ps[0]
    const r = ctl('pane', 'split', '--direction', 'right', '--ratio', '0.5', '--pane', target.pane_id)
    created.panes.push(r?.pane?.pane_id ?? null)
    await sleep(600)
  }
}
byTab = tabsOf()
panes = paneList()
record('setup', { created, tabCount: byTab.size, paneCount: panes.length })

// 연결이 붙을 pane 4개 — 탭을 번갈아 고른다
const tabIds = [...byTab.keys()]
const targets = []
for (const tabId of tabIds) for (const p of byTab.get(tabId).slice(0, 2)) targets.push(p)
const picked = targets.slice(0, 4)

// --- S2: 연결을 하나씩 늘리며 각자 다른 pane 을 focus ---------------------------
const clients = []
const surfaceOf = (client) => {
  const s = client.currentSurface
  if (s === null) return null
  return {
    revision: s.surfaceRevision,
    frame: { width: s.frame.width, height: s.frame.height },
    panes: s.panes.map((p) => ({ paneId: p.paneId, focused: p.focused, innerRect: p.innerRect })),
  }
}

for (let i = 0; i < picked.length; i++) {
  const pane = picked[i]
  const client = new EndpointClient(clientSocketPath)
  client.on('error', () => {})
  await client.connect(160, 44)
  await client.callEndpoint('pane.focus', { pane_id: pane.pane_id })
  clients.push({ index: i, paneId: pane.pane_id, tabId: pane.tab_id, client })
  await sleep(1200)
  record(`S2-connect-${i + 1}(focus ${pane.pane_id})`, {
    connections: clients.length,
    // 각 연결이 지금 무엇을 받고 있나 — 자기 pane 이 서피스에 있는가
    perConnection: clients.map((c) => {
      const s = surfaceOf(c.client)
      return {
        index: c.index,
        wantedPane: c.paneId,
        wantedTab: c.tabId,
        surfaceHasWantedPane: s === null ? null : s.panes.some((p) => p.paneId === c.paneId),
        surfacePaneIds: s === null ? null : s.panes.map((p) => p.paneId),
        surfaceFocusedPaneIds: s === null ? null : s.panes.filter((p) => p.focused).map((p) => p.paneId),
        frame: s?.frame ?? null,
      }
    }),
  })
}

// --- S3: 연결마다 다른 크기를 요청한다 -----------------------------------------
const resizePlan = [
  { index: 0, cols: 200, rows: 50 },
  { index: 1, cols: 80, rows: 24 },
  { index: 2, cols: 120, rows: 36 },
]
for (const plan of resizePlan) {
  clients[plan.index].client.resize(plan.cols, plan.rows)
  await sleep(1200)
  record(`S3-resize-conn${plan.index}(${plan.cols}x${plan.rows})`, {
    perConnection: clients.map((c) => {
      const s = surfaceOf(c.client)
      return {
        index: c.index,
        wantedPane: c.paneId,
        frame: s?.frame ?? null,
        surfacePaneIds: s === null ? null : s.panes.map((p) => p.paneId),
        innerRects: s === null ? null : s.panes.map((p) => `${p.paneId}=${p.innerRect.width}x${p.innerRect.height}`),
      }
    }),
  })
}

for (const c of clients) c.client.close()
await sleep(800)
record('after-close-all')

writeRaw('s2s3-focus-resize.json', {
  step: 'S2+S3',
  at: new Date().toISOString(),
  picked: picked.map((p) => ({ pane_id: p.pane_id, tab_id: p.tab_id })),
  created,
  steps,
})

console.log('--- S2 포커스 (control 오라클) ---')
for (const s of steps) {
  if (!s.label.startsWith('S2')) continue
  console.log(s.label, '| 세션 focused =', s.control.focusedPaneId)
  for (const c of s.perConnection ?? []) {
    console.log(`   conn${c.index} 원함=${c.wantedPane} 서피스에있음=${c.surfaceHasWantedPane} panes=${JSON.stringify(c.surfacePaneIds)} frame=${c.frame?.width}x${c.frame?.height}`)
  }
}
console.log('--- S3 리사이즈 ---')
for (const s of steps) {
  if (!s.label.startsWith('S3')) continue
  console.log(s.label, '| area =', JSON.stringify(s.control.area))
  for (const c of s.perConnection ?? []) {
    console.log(`   conn${c.index} frame=${c.frame?.width}x${c.frame?.height} inner=${JSON.stringify(c.innerRects)}`)
  }
}
process.exit(0)
