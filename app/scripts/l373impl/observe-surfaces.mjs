// 서피스 도착만 세는 **관측자 한 명** — `f-observer.mjs` 가 프로세스로 띄운다.
//
// 두 모드가 있고, 차이는 **관측자가 서피스 하나에 얼마나 일하느냐**뿐이다:
//   cheap  도착 시각만 찍는다 (셀을 안 읽는다)
//   heavy  `m1-frame-rate.mjs` 와 **같은** 크롭 해시를 판마다 돌린다 (셀을 전부 읽는다)
//
// 왜 프로세스를 나누나: 같은 이벤트 루프에서 둘을 돌리면 heavy 의 해시가 cheap 의 소켓 읽기까지
// 막아 실험이 무너진다. 비교하려는 것이 바로 그 "소비 속도"다.
//
// 사용: node scripts/l373impl/observe-surfaces.mjs <cheap|heavy> <paneId> <windowMs>
// 결과는 stdout 에 JSON 한 줄.

import crypto from 'node:crypto'
import { clientSocketPath, loadEndpointClient, pct, sleep } from './lib.mjs'

const mode = process.argv[2] ?? 'cheap'
const paneId = process.argv[3]
const windowMs = Number(process.argv[4] ?? 20000)
if (paneId === undefined) throw new Error('paneId 가 필요하다')

const EndpointClient = await loadEndpointClient()

/** m1-frame-rate.mjs 와 같은 크롭 지문 — heavy 관측자의 부담이 그때와 같아야 한다. */
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

const arrivals = []
/** 마지막으로 받은 **서피스 격자** — 리터럴을 적어 두면 관측치 자리에 상수가 실린다 (L5). */
let frameGrid = null
/** heavy 만: 직전 판과 크롭 해시가 달라진 pane 수 — P2-c 의 **독립 오라클**이다. */
const lastHash = new Map()
const changed = []
const client = new EndpointClient(clientSocketPath)
client.on('surface', (s) => {
  const at = Date.now()
  if (mode === 'heavy') {
    let n = 0
    for (const p of s.panes) {
      const hash = cropHash(s.frame, p.innerRect)
      if (lastHash.get(p.paneId) !== hash) n += 1
      lastHash.set(p.paneId, hash)
    }
    changed.push(n)
  }
  frameGrid = { cols: s.frame.width, rows: s.frame.height }
  arrivals.push({ at, panes: s.panes.length })
})
client.on('error', () => {})

await client.connect(200, 50)
client.assertMethod('pane.focus')
await client.callEndpoint('pane.focus', { pane_id: paneId })
await sleep(1500)

arrivals.length = 0
changed.length = 0
const t0 = Date.now()
await sleep(windowMs)
const t1 = Date.now()
client.close()

const gaps = []
for (let i = 1; i < arrivals.length; i++) gaps.push(arrivals[i].at - arrivals[i - 1].at)
const secs = (t1 - t0) / 1000
process.stdout.write(
  `${JSON.stringify({
    mode,
    paneId,
    windowMs,
    surfaces: arrivals.length,
    초당: +(arrivals.length / secs).toFixed(2),
    프레임당pane수: arrivals.length === 0 ? null : +(arrivals.reduce((a, b) => a + b.panes, 0) / arrivals.length).toFixed(3),
    // 첫 판은 전원이 "바뀜"이라 뺀다 (m1-frame-rate 와 같은 규칙).
    프레임당바뀐pane수: mode !== 'heavy' || changed.length < 2 ? null : +(changed.slice(1).reduce((a, b) => a + b, 0) / (changed.length - 1)).toFixed(3),
    // 받은 서피스의 **실제** 격자다. 예전에는 `{ cols: 200, rows: 50 }` 리터럴이 여기 실렸다 (L5).
    서피스격자: frameGrid,
    gapMs: { p50: pct(gaps, 50), p95: pct(gaps, 95), max: gaps.length === 0 ? null : Math.max(...gaps) },
  })}\n`,
)
