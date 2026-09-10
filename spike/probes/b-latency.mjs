// ⓑ B5 갱신 지연 · B6 주기 재생(플리커·가짜 히스토리 딜레마)
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b-latency.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Raw, sleep, pct } from '../lib/raw.mjs'
import { Conn, RAW_DIR } from '../lib/herdr.mjs'
import { makeApi, run, readAnsi, readPair } from '../lib/pane.mjs'
import { makeTerm, write, grid, compare, rowText } from '../lib/xterm.mjs'

const raw = new Raw('b-latency')
const api = makeApi(raw)
const SPIKE = path.resolve(new URL('..', import.meta.url).pathname)
const R = {}

const panes = await api('pane.list', {})
const P = panes.panes[0].pane_id
for (const p of panes.panes.slice(1)) await api('pane.close', { pane_id: p.pane_id })
await run(api, P, `cd ${SPIKE}`, { settleMs: 600 })
await run(api, P, "printf '\\033[2J\\033[H'; stty size", { settleMs: 800 })
const sz = await readPair(api, P, 'visible')
const [, ROWS, COLS] = sz.text.text.match(/(\d+)\s+(\d+)/).map(Number)
R.grid = { cols: COLS, rows: ROWS }
console.log('grid', COLS, 'x', ROWS)

// 로그형 픽스처를 띄워두고 잰다 (정지 화면).
await run(api, P, "printf '\\033[2J\\033[H'; sh fixtures/01-log.sh", { settleMs: 1200 })

// --- B5 왕복 지연 --------------------------------------------------------
// 요청 → 응답 → xterm 재생 완료(write 콜백)까지가 한 사이클이다.
// 서버가 응답 1건마다 커넥션을 닫으므로 매 사이클 연결 비용이 붙는다 — 그게 실제 비용이다.
{
  const N = 100
  const total = []
  const connect = []
  const rtt = []
  const replay = []
  let bytes = 0
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint()
    const c = new Conn({})
    await c.connect()
    const t1 = process.hrtime.bigint()
    const r = await c.request('pane.read', {
      pane_id: P,
      source: 'visible',
      format: 'ansi',
      strip_ansi: false,
    })
    const t2 = process.hrtime.bigint()
    c.end()
    const snap = r.result.read.text
    bytes += snap.length
    const T = makeTerm(COLS, ROWS)
    await write(T, snap)
    const t3 = process.hrtime.bigint()
    T.dispose()
    const ms = (a, b) => Number(b - a) / 1e6
    total.push(ms(t0, t3))
    connect.push(ms(t0, t1))
    rtt.push(ms(t1, t2))
    replay.push(ms(t2, t3))
    raw.log('B5.sample', { i, total: ms(t0, t3), connect: ms(t0, t1), rtt: ms(t1, t2), replay: ms(t2, t3) })
  }
  const stat = (xs) => ({
    p50: +pct(xs, 50).toFixed(1),
    p95: +pct(xs, 95).toFixed(1),
    max: +Math.max(...xs).toFixed(1),
    min: +Math.min(...xs).toFixed(1),
  })
  R.B5 = {
    samples: N,
    snapshotBytesAvg: Math.round(bytes / N),
    total: stat(total),
    breakdown: { connect: stat(connect), socketRtt: stat(rtt), xtermReplay: stat(replay) },
    pass: pct(total, 50) <= 150 && pct(total, 95) <= 400,
  }
  console.log('B5', R.B5.pass ? 'PASS' : 'FAIL', JSON.stringify(R.B5.total), JSON.stringify(R.B5.breakdown))
}

// --- B6 주기 재생 --------------------------------------------------------
// 헤드리스에는 화면이 없으니 "플리커"를 눈으로 볼 수 없다. 대신 플리커를 만드는 원인을
// 수치로 잰다: (1) 전체 재그림이 스크롤백에 가짜 히스토리를 쌓는가 (2) 실제로 바뀐 셀은 몇 개인가.
//
// 세 가지 재생 전략을 같은 스냅샷 열에 대고 비교한다.
//   naive : 스냅샷을 그냥 write — 이전 화면이 위로 밀린다
//   reset : RIS(\x1bc) 로 지우고 write — 모드·팔레트·알트스크린까지 날아간다
//   home  : 커서 홈 + 줄마다 erase-to-EOL + 끝에 erase-below — 화면만 덮어쓴다
{
  // 움직이는 화면이 있어야 churn 을 잴 수 있다. 하네스 전용 티커를 띄운다
  // (판정용 3종 픽스처와 별개다 — B6 는 수치 판정 항목이 아니다).
  fs.writeFileSync(
    path.join(SPIKE, 'fixtures', '90-ticker.sh'),
    // 하네스 전용: 알트스크린에서 카운터만 바꾸며 다시 그린다
    `i=0
printf '\\033[?1049h\\033[2J'
while [ $i -lt 400 ]; do
  printf '\\033[H\\033[2J틱 %03d\\n고정 줄 A\\n고정 줄 B\\n진행 %s\\n' "$i" "$(printf '#%.0s' $(seq 1 $((i % 20 + 1))))"
  i=$((i + 1))
  sleep 0.2
done
`,
  )
  await run(api, P, 'sh fixtures/90-ticker.sh', { settleMs: 1000 })

  const CYCLES = 24
  const strategies = {
    naive: { term: makeTerm(COLS, ROWS), apply: (t, s) => write(t, s) },
    reset: { term: makeTerm(COLS, ROWS), apply: (t, s) => write(t, '\x1bc' + s) },
    home: {
      term: makeTerm(COLS, ROWS),
      // 줄마다 \x1b[K 로 잔상을 지우고, 마지막에 \x1b[J 로 아래를 턴다.
      apply: (t, s) =>
        write(t, '\x1b[H' + s.split('\r\n').join('\x1b[K\r\n') + '\x1b[K\x1b[J'),
    },
  }
  const snapshots = []
  const churn = []
  let prevGrid = null
  for (let i = 0; i < CYCLES; i++) {
    const snap = (await readAnsi(api, P, 'visible')).text
    snapshots.push(snap)
    for (const [name, s] of Object.entries(strategies)) await s.apply(s.term, snap)

    // 실제로 바뀐 셀 수 vs 스냅샷이 다시 그리는 셀 수
    const fresh = makeTerm(COLS, ROWS)
    await write(fresh, snap)
    const g = grid(fresh)
    if (prevGrid) {
      const c = compare(prevGrid, g, { rows: ROWS })
      const changed = Math.round((1 - c.textMatch) * c.cells)
      const painted = g.reduce((n, row) => n + row.filter((x) => x && x.ch !== '').length, 0)
      churn.push({ i, cells: c.cells, changedCells: changed, repaintedCells: painted })
    }
    prevGrid = g
    fresh.dispose()
    await sleep(500)
  }

  // 각 전략이 남긴 버퍼 상태
  const state = {}
  for (const [name, s] of Object.entries(strategies)) {
    const buf = s.term.buffer.active
    const g = grid(s.term)
    state[name] = {
      bufferLength: buf.length, // 뷰포트 + 스크롤백 총 줄 수
      scrollbackRows: buf.length - s.term.rows,
      baseY: buf.baseY,
      viewportTop: rowText(g[0] ?? []),
      // 마지막 스냅샷과 화면이 일치하는가
      matchesLatest: null,
    }
  }
  // 마지막 스냅샷을 깨끗한 터미널에 그린 것과 각 전략의 화면을 비교
  const truth = makeTerm(COLS, ROWS)
  await write(truth, snapshots[snapshots.length - 1])
  const gTruth = grid(truth)
  for (const [name, s] of Object.entries(strategies)) {
    const c = compare(gTruth, grid(s.term), { rows: ROWS })
    state[name].matchesLatest = +(c.textMatch * 100).toFixed(2)
  }

  // reset 전략이 무엇을 잃는지 별도로 확인: 알트스크린·모드가 RIS 로 날아가는가
  const altProbe = makeTerm(COLS, ROWS)
  await write(altProbe, '\x1b[?1049h이건 알트 화면')
  const altBefore = altProbe.buffer.active.type
  await write(altProbe, '\x1bc')
  const altAfter = altProbe.buffer.active.type
  altProbe.dispose()

  // 그리고 RIS 는 진짜 히스토리도 지운다 — 스크롤백을 쌓아두고 RIS 를 때려본다
  const histProbe = makeTerm(COLS, ROWS)
  await write(histProbe, Array.from({ length: 120 }, (_, i) => `진짜 히스토리 ${i}`).join('\r\n'))
  const histBefore = histProbe.buffer.active.length
  await write(histProbe, '\x1bc')
  const histAfter = histProbe.buffer.active.length
  histProbe.dispose()

  // 정지 화면(로그형 8줄)을 리셋 없이 20회 반복 write — 가짜 히스토리를 또렷하게 잰다
  await api('pane.send_text', { pane_id: P, text: '\x03' })
  await sleep(600)
  await run(api, P, "printf '\\033[2J\\033[H'; sh fixtures/01-log.sh", { settleMs: 1200 })
  const staticSnap = (await readAnsi(api, P, 'visible')).text
  const acc = makeTerm(COLS, ROWS)
  const accGrowth = []
  for (let i = 0; i < 20; i++) {
    await write(acc, staticSnap)
    accGrowth.push(acc.buffer.active.length - ROWS)
  }
  const accFinal = {
    snapshotRows: staticSnap.split('\r\n').length,
    scrollbackRowsAfter20: acc.buffer.active.length - ROWS,
    growth: accGrowth,
    // 원본 pane 의 실제 스크롤백은 그대로인데 클라이언트에만 쌓인 줄 수다
    note: '이 줄들은 원본에 없다 — 같은 화면을 반복해 그려서 생긴 가짜 히스토리다',
  }
  acc.dispose()

  R.B6 = {
    cycles: CYCLES,
    intervalMs: 500,
    churn,
    churnSummary: {
      // 실제 변화분 대비 몇 배를 다시 그리는가 — 이 배수가 플리커의 원인이다
      changedCellsAvg: Math.round(churn.reduce((a, c) => a + c.changedCells, 0) / (churn.length || 1)),
      repaintedCellsAvg: Math.round(churn.reduce((a, c) => a + c.repaintedCells, 0) / (churn.length || 1)),
    },
    strategies: state,
    resetLosesAltScreen: { before: altBefore, after: altAfter, lost: altBefore !== altAfter },
    resetLosesRealHistory: { bufferBefore: histBefore, bufferAfter: histAfter, rowsLost: histBefore - histAfter },
    fakeHistory: accFinal,
    // 스냅샷은 delta 가 아니라 "현재 격자"다. 이게 이 항목의 뿌리다
    note: '스냅샷은 현재 격자다. 리셋 없이 반복 write 하면 이전 화면이 스크롤백으로 밀린다',
  }
  for (const [name, s] of Object.entries(strategies)) s.term.dispose()
  truth.dispose()
  console.log('B6 전략별:', JSON.stringify(state, null, 1))
  console.log('B6 churn 평균:', JSON.stringify(R.B6.churnSummary))

  await api('pane.send_text', { pane_id: P, text: '\x03' })
  await sleep(600)
}

fs.writeFileSync(path.join(RAW_DIR, 'b-latency-summary-note.txt'),
  'B5 표본 100회 원본은 b-latency.ndjson 의 kind=B5.sample 줄에 전부 있다.\n')
raw.close({ probe: 'b-latency', at: new Date().toISOString(), results: R })
process.exit(0)
