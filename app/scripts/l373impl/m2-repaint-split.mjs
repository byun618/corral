// §10-R10 미결 — "프레임당 바뀐 크롭 수"의 2~3배 배수가 어디서 오나.
//
// 코디네이터 가설: **한 번의 논리 리페인트가 서버 푸시 2~3틱에 나뉘어 실린다.** 그러면 그
// 서피스들은 서로 **진짜 다르고**, 바뀐 것으로 세는 게 맞다 (skip 판정은 해시가 한다 — R7).
// 반대 가설: 같은 내용이 여러 번 실려 온다 (그러면 해시가 걷어내므로 세면 안 된다).
//
// 판별 방법: 1pane 부하(10Hz)에서 연속 서피스의 **셀 단위 차이**를 뜬다.
//   · 변경 셀 0 인 서피스가 있나 → 있으면 "같은 내용 재전송"이 존재한다 (해시가 걷어낸다)
//   · 변경 셀 > 0 이면 그 영역이 화면의 **일부**인가 전부인가 → 일부면 쪼개 보낸 것이다
//   · 부하 주기(100ms)당 서피스 몇 장인가 — 2~3 이면 배수의 정체가 이것이다
//
// 사용: node scripts/l373impl/m2-repaint-split.mjs <label> <windowMs>
//   L373_TAB=w1:t2 로 잴 탭을 고정한다. pane 1개짜리 탭이어야 한다 (배수만 보는 실험).

import { clientSocketPath, layout, loadEndpointClient, paneList, pct, sleep, writeRaw, SESSION } from './lib.mjs'

const label = process.argv[2] ?? 'run'
const windowMs = Number(process.argv[3] ?? 12000)
const EndpointClient = await loadEndpointClient()

const panes = paneList()
const tabId = process.env.L373_TAB ?? panes[0].tab_id
const tabPanes = panes.filter((p) => p.tab_id === tabId)
if (tabPanes.length === 0) throw new Error(`탭 ${tabId} 에 pane 이 없다`)

/** 두 프레임의 **같은 좌표** 셀을 비교한다. 크기가 다르면 전면 변경으로 본다. */
function diffCells(previous, next, rect) {
  if (previous === null) return null
  if (previous.width !== next.width || previous.height !== next.height) return { resized: true }
  const w = Math.max(0, Math.min(rect.width, next.width - rect.x))
  const h = Math.max(0, Math.min(rect.height, next.height - rect.y))
  let changed = 0
  const rows = new Set()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (rect.y + y) * next.width + rect.x + x
      const a = previous.cells[i]
      const b = next.cells[i]
      const same =
        a !== undefined &&
        b !== undefined &&
        a.symbol === b.symbol &&
        a.fg === b.fg &&
        a.bg === b.bg &&
        a.modifier === b.modifier &&
        a.skip === b.skip
      if (!same) {
        changed += 1
        rows.add(y)
      }
    }
  }
  const cursorMoved =
    (previous.cursor?.x ?? null) !== (next.cursor?.x ?? null) || (previous.cursor?.y ?? null) !== (next.cursor?.y ?? null)
  return { resized: false, cells: changed, total: w * h, rows: rows.size, height: h, cursorMoved }
}

const client = new EndpointClient(clientSocketPath)
const records = []
let previousFrame = null
client.on('surface', (s) => {
  const pane = s.panes.find((p) => p.paneId === tabPanes[0].paneId) ?? s.panes[0]
  const rect = pane?.innerRect ?? { x: 0, y: 0, width: s.frame.width, height: s.frame.height }
  records.push({
    at: Date.now(),
    revision: s.surfaceRevision,
    full: s.full === true,
    carried: s.panes.map((p) => p.paneId),
    frame: { w: s.frame.width, h: s.frame.height },
    diff: diffCells(previousFrame, s.frame, rect),
  })
  previousFrame = s.frame
})
client.on('error', (e) => console.error('client error', e?.message ?? e))

await client.connect(200, 50)
client.assertMethod('pane.focus')
await client.callEndpoint('pane.focus', { pane_id: tabPanes[0].paneId ?? tabPanes[0].pane_id })
await sleep(1500)

const before = { at: Date.now(), layout: layout() }
records.length = 0
previousFrame = null
await sleep(windowMs)
const after = { at: Date.now(), layout: layout() }
client.close()

const measured = records.filter((r) => r.diff !== null && r.diff.resized === false)
const gaps = []
for (let i = 1; i < records.length; i++) gaps.push(records[i].at - records[i - 1].at)
const unchanged = measured.filter((r) => r.diff.cells === 0)
const partial = measured.filter((r) => r.diff.cells > 0 && r.diff.rows < r.diff.height)
const whole = measured.filter((r) => r.diff.cells > 0 && r.diff.rows >= r.diff.height)
const spanSec = records.length > 1 ? (records[records.length - 1].at - records[0].at) / 1000 : 0

const out = {
  label,
  session: SESSION,
  at: new Date().toISOString(),
  tabId,
  paneCount: tabPanes.length,
  windowMs,
  surfaces: records.length,
  surfacesPerSec: spanSec > 0 ? +(records.length / spanSec).toFixed(2) : 0,
  gapMs: { p50: pct(gaps, 50), p95: pct(gaps, 95), max: gaps.length ? Math.max(...gaps) : null },
  /** 이게 답이다 — 연속 서피스가 진짜 다른가, 같은 걸 다시 보내는가. */
  판정: {
    '변경 셀 0 (같은 내용 재전송)': unchanged.length,
    '일부 줄만 바뀜 (리페인트가 쪼개짐)': partial.length,
    '전 줄 바뀜': whole.length,
    측정대상: measured.length,
    '바뀐 셀 비율 p50': pct(
      measured.map((r) => +(r.diff.cells / Math.max(1, r.diff.total)).toFixed(4)),
      50,
    ),
    '바뀐 줄 수 p50': pct(
      measured.map((r) => r.diff.rows),
      50,
    ),
  },
  before,
  after,
  samples: records.slice(0, 60),
}
writeRaw(`m2-repaint-split-${label}.json`, out)
console.log(JSON.stringify(out.판정, null, 2))
console.log('서피스/s', out.surfacesPerSec, '· 간격 p50', out.gapMs.p50)
