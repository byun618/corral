// §7-1 herdr 탭 프레임률 F · §7-2 탭 프레임 하나에서 실제로 바뀌는 pane 크롭 수.
//
// 재는 대상을 판별자로 쓰지 않는다 (관문 ④): pane 구성·부하 성립 여부는 **control 소켓**
// (`herdr --session … pane list/layout`)으로 확인하고, 프레임률은 벤더 endpoint 클라이언트가
// 실제로 받은 surface 이벤트의 **도착 시각**으로 센다(서버가 신고한 수가 아니다).
//
// 크롭 해시는 corral 이 실제로 쓰는 기준과 같다: pane.innerRect 안의 셀
// (symbol·fg·bg·modifier) + 그 안에 들어온 커서. `cropFrame`(endpoint-terminal-session.ts:518)
// 이 xterm 에 실어 보내는 것과 같은 값이다 — 이게 안 바뀌면 xterm 에 쓸 이유가 없다.
//
// 사용: node scripts/l373impl/m1-frame-rate.mjs <label> <windowMs>
//   L373_TAB=w1:t1  — 잴 탭을 고정한다 (기본: pane list 의 첫 탭).

import crypto from 'node:crypto'
import { clientSocketPath, layout, loadEndpointClient, paneList, pct, sleep, writeRaw, SESSION } from './lib.mjs'

const label = process.argv[2] ?? 'run'
const windowMs = Number(process.argv[3] ?? 12000)
const EndpointClient = await loadEndpointClient()

const panes = paneList()
const tabId = process.env.L373_TAB ?? panes[0].tab_id
const tabPanes = panes.filter((p) => p.tab_id === tabId)
if (tabPanes.length === 0) throw new Error(`탭 ${tabId} 에 pane 이 없다`)

/** pane 하나의 크롭 지문 — cropFrame 이 xterm 에 싣는 것과 같은 내용. */
function cropHash(frame, rect) {
  const h = crypto.createHash('sha1')
  const w = Math.max(0, Math.min(rect.width, frame.width - rect.x))
  const ht = Math.max(0, Math.min(rect.height, frame.height - rect.y))
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      const c = frame.cells[(rect.y + y) * frame.width + rect.x + x]
      h.update(c ? `${c.symbol}|${c.fg}|${c.bg}|${c.modifier}|${c.skip ? 1 : 0} ` : '')
    }
  }
  const cur = frame.cursor
  if (cur) {
    const cx = cur.x - rect.x
    const cy = cur.y - rect.y
    h.update(cx >= 0 && cx < w && cy >= 0 && cy < ht ? `@${cx},${cy},${cur.visible ? 1 : 0},${cur.shape}` : '@none')
  } else h.update('@null')
  return h.digest('hex').slice(0, 12)
}

const client = new EndpointClient(clientSocketPath)
const surfaces = []
client.on('surface', (s) => {
  surfaces.push({
    at: Date.now(),
    revision: s.surfaceRevision,
    frame: { w: s.frame.width, h: s.frame.height },
    panes: s.panes.map((p) => ({
      paneId: p.paneId,
      rect: p.rect,
      inner: p.innerRect,
      focused: p.focused,
      hash: cropHash(s.frame, p.innerRect),
    })),
  })
})
client.on('error', (e) => console.error('client error', e?.message ?? e))

await client.connect(200, 50)
client.assertMethod('pane.focus')
// attach — 이 연결의 서피스를 이 탭으로 좁힌다 (3차 T3b: 서피스 = 쓸 수 있는 경계).
await client.callEndpoint('pane.focus', { pane_id: tabPanes[0].pane_id })
await sleep(1500)

const before = { at: Date.now(), layout: layout() }
surfaces.length = 0
await sleep(windowMs)
const after = { at: Date.now(), layout: layout() }
client.close()

// --- 집계 -------------------------------------------------------------------
const spanSec = surfaces.length > 1 ? (surfaces[surfaces.length - 1].at - surfaces[0].at) / 1000 : 0
const gaps = []
for (let i = 1; i < surfaces.length; i++) gaps.push(surfaces[i].at - surfaces[i - 1].at)

// §7-2 — 프레임마다 직전 프레임 대비 크롭 해시가 바뀐 pane 수.
//
// ⚠ 서피스의 `panes` 배열은 **전체 서피스에서만 전원**이고 patch 에서는 **바뀐 pane 만** 싣는다
// (m0-surface-shape.json 으로 확인). 그래서 목록에 없는 pane 은 "없다"가 아니라 "안 바뀌었다"다 —
// 마지막으로 본 해시를 누적 맵에 들고 비교한다. 구현도 같은 규칙을 따라야 한다.
const changed = []
const perPaneChanges = new Map()
const lastHash = new Map()
for (const [i, s] of surfaces.entries()) {
  let n = 0
  for (const p of s.panes) {
    if (lastHash.get(p.paneId) !== p.hash) {
      n += 1
      perPaneChanges.set(p.paneId, (perPaneChanges.get(p.paneId) ?? 0) + 1)
    }
    lastHash.set(p.paneId, p.hash)
  }
  if (i > 0) changed.push(n) // 첫 프레임은 전원이 "바뀜"이라 분포를 왜곡한다
}
const hist = {}
for (const n of changed) hist[n] = (hist[n] ?? 0) + 1
// pane 수의 진실은 control 소켓이다 (관문 ④) — 서피스 patch 의 목록 길이가 아니다.
const paneCount = tabPanes.length
const changedTotal = changed.reduce((a, b) => a + b, 0)

const out = {
  label,
  session: SESSION,
  at: new Date().toISOString(),
  tabId,
  windowMs,
  paneCount,
  surfaces: surfaces.length,
  /** §7-1 — 이 탭이 초당 몇 장의 서피스를 보냈나. */
  framesPerSec: spanSec > 0 ? +(surfaces.length / spanSec).toFixed(2) : 0,
  spanSec: +spanSec.toFixed(2),
  gapMs: { p50: pct(gaps, 50), p95: pct(gaps, 95), max: gaps.length ? Math.max(...gaps) : null },
  /** §7-2 — 프레임당 바뀐 크롭 수. */
  changedCrops: {
    mean: changed.length ? +(changedTotal / changed.length).toFixed(3) : null,
    p50: pct(changed, 50),
    p95: pct(changed, 95),
    max: changed.length ? Math.max(...changed) : null,
    histogram: hist,
    /** 크롭 skip 이 걷어내는 몫 — 전체 (pane × 프레임) 쌍 중 안 바뀐 비율. */
    skipRatio: changed.length && paneCount ? +(1 - changedTotal / (changed.length * paneCount)).toFixed(4) : null,
    perPane: Object.fromEntries(perPaneChanges),
  },
  before,
  after,
  samples: surfaces.slice(0, 40).map((s) => ({
    at: s.at,
    revision: s.revision,
    frame: s.frame,
    panes: s.panes.map((p) => ({ paneId: p.paneId, inner: p.inner, hash: p.hash })),
  })),
}
writeRaw(`m1-frame-rate-${label}.json`, out)
console.log(
  JSON.stringify(
    { label, paneCount, surfaces: out.surfaces, F: out.framesPerSec, changedMean: out.changedCrops.mean, skipRatio: out.changedCrops.skipRatio },
    null,
    2,
  ),
)
