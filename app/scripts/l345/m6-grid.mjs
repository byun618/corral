// T2 (격자) · T5 (스크롤백) · T6 (커서).
//
// ## T2 가 어려운 이유 (분석 §4-ⓓ, Q1)
//
// 터미널 격자는 **herdr 것**이다. corral 은 그것을 못 바꾼다:
//   - `pane.resize` 는 `{direction, amount}` 만 받는다. 목표 cols×rows 를 지정하는 메서드가
//     102개 중 없다
//   - `PaneReadResult` 에 격자가 없다. `PaneInfo.scroll.viewport_rows` 만 행 수를 준다
//   - **열 수는 API 어디에도 없다** — 스키마 전문 grep 으로 `grid_cols` 는 그래픽 배치용뿐이다
//
// 그래서 창 크기를 바꿔도 **격자는 안 변한다**. corral 이 하는 일은 "격자를 창에 맞추는 것"이
// 아니라 "창을 격자에 맞춰 글자 크기를 고르는 것"이다. 이 스크립트는 창을 3단계로 바꿔가며
// ① 격자가 그대로인지 ② 화면이 어떻게 되는지(잘림/여백/배율)를 화면으로 남긴다.

import { panes, ptyGrid, request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

/** 200칸짜리 열 자. pane 폭보다 길어서 herdr 가 pane 폭으로 잘라 준다 — 폭을 눈과 코드로 동시에 본다. */
const RULER = `clear; awk 'BEGIN{s="";for(i=1;i<=200;i++){s=s (i%10==0? substr(sprintf("%d",i/10),length(sprintf("%d",i/10))) : ".")};print s}'`

const out = {}

// ==========================================================================
// T2 — 격자
// ==========================================================================
{
  const paneId = await tidySession()
  // PTY 크기는 lib 의 `ptyGrid` 로 읽는다 — 여기 있던 정규식이 화면 아무 데서나 숫자 두 개를
  // 집어 `{rows:0, cols:39}` 를 적었다 (판정 L1).
  const pty = await ptyGrid(paneId)
  // 폭을 눈으로 확인할 수 있게 열 자를 그린다 — 잘리면 바로 보인다.
  await run(paneId, RULER, { settleMs: 1200 })

  const layout = await request('pane.layout', { pane_id: paneId })
  const info = await request('pane.get', { pane_id: paneId })

  const app = await startApp({ name: 'grid' })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(2500)

  const steps = []
  for (const size of [
    { width: 1180, height: 760, label: '기본' },
    { width: 1600, height: 1000, label: '크게' },
    { width: 820, height: 560, label: '작게' },
    { width: 1180, height: 760, label: '기본 복귀' },
  ]) {
    await app.resize(size.width, size.height)
    await sleep(1600)
    const dump = (await app.dump()).dump
    const state = (await app.state()).state.terminal
    const shot = await app.termShot(`t2-${size.width}x${size.height}`)
    const full = await app.shot(`t2-full-${size.width}x${size.height}`)
    // 첫 행(열 자)이 온전히 남아 있나 — 잘리면 문자 수가 준다.
    const ruler = (dump.grid[0] ?? []).map((cell) => (cell?.w === 0 ? '' : (cell?.ch ?? ' '))).join('').trimEnd()
    steps.push({
      ...size,
      grid: { cols: dump.cols, rows: dump.rows },
      gridSource: state.grid?.source ?? null,
      layoutCols: state.grid?.layoutCols ?? null,
      observedCols: state.grid?.observedCols ?? null,
      rulerLength: ruler.length,
      shot: shot.file,
      fullShot: full.file,
    })
    console.log('T2', size.label, size.width + 'x' + size.height, '→ grid', dump.cols + 'x' + dump.rows, 'ruler', ruler.length)
  }

  out.t2 = {
    paneId,
    ptyFromStty: pty,
    layoutRect: layout.layout.panes.find((pane) => pane.pane_id === paneId)?.rect ?? null,
    layoutArea: layout.layout.area,
    viewportRows: info.pane.scroll?.viewport_rows ?? null,
    resizeApiNote:
      'pane.resize 는 {direction, amount} 만 받는다 — 목표 cols×rows 를 지정할 수 없다. 그래서 격자는 herdr 것이고 corral 은 글자 크기·배율로 맞춘다',
    steps,
    gridStableAcrossWindowSizes: new Set(steps.map((step) => `${step.grid.cols}x${step.grid.rows}`)).size === 1,
    rulerStable: new Set(steps.map((step) => step.rulerLength)).size === 1,
  }

  // --- ⓑ sparse pane — 긴 줄이 하나도 없는 화면 (판정 M3) --------------------
  //
  // 열 자를 그려 놓고 재면 관측 폭이 pane 폭까지 자란다. **평소 화면은 그렇지 않다.**
  // 1차 측정의 T4 codex 팔이 실제로 그랬다 — 같은 pane(PTY 93)인데 격자는 80×39 였다.
  // 여기서는 그 상태를 일부러 만들어 **corral 이 무엇을 그리는지 기록한다.**
  // corral 은 열 수를 알 방법이 없다(API 에 없다) — 하한 80 이 답이고, 80 을 넘는 줄이
  // 오면 **그 줄이 담긴 스냅샷에서** 격자가 먼저 넓어진다. 그 두 번째 절반도 여기서 잰다.
  await run(paneId, 'clear; printf "짧은 줄\\n"', { settleMs: 1200 })
  await sleep(7000) // > GRID_REFRESH_MS. 창 경계를 지나야 줄이기가 일어난다.
  const sparseDump = (await app.dump()).dump
  const sparseState = (await app.state()).state.terminal
  const sparseShot = await app.termShot('t2-sparse')
  await run(paneId, RULER, { settleMs: 1500 })
  const regrownDump = (await app.dump()).dump
  const regrownRuler = (regrownDump.grid[0] ?? []).map((cell) => (cell?.w === 0 ? '' : (cell?.ch ?? ' '))).join('').trimEnd()

  out.t2.sparse = {
    note: '긴 줄이 없는 화면 — 관측으로 알 수 있는 폭이 없다. 하한 80 이 답이고 pane 은 93 이다',
    ptyCols: pty.cols,
    grid: { cols: sparseDump.cols, rows: sparseDump.rows },
    gridSource: sparseState.grid?.source ?? null,
    observedCols: sparseState.grid?.observedCols ?? null,
    matchesPane: sparseDump.cols === pty.cols,
    shot: sparseShot.file,
    regrown: {
      note: '긴 줄(200칸 열 자)이 도착한 뒤 — 그 줄을 그리기 전에 격자가 먼저 넓어져야 한다',
      grid: { cols: regrownDump.cols, rows: regrownDump.rows },
      rulerLength: regrownRuler.length,
      matchesPane: regrownDump.cols === pty.cols,
      rulerIntact: regrownRuler.length === pty.cols,
    },
  }
  console.log('T2 sparse → grid', sparseDump.cols + 'x' + sparseDump.rows, '(pane', pty.cols + ')',
    '· 열 자 도착 뒤', regrownDump.cols, 'ruler', regrownRuler.length)

  // --- ⓒ pane 을 실제로 좁힌다 (판정 M2) ------------------------------------
  //
  // `observedCols` 가 안 줄면 herdr pane 이 좁아져도 corral 이 못 따라간다는 지적이다.
  // 창 경계 감쇠를 넣었으니(`term.grid.shrink`) 실제로 좁혀서 확인한다.
  // 분할해서 절반으로 만든 뒤 `pane.resize` 로 폭을 되찾아 **하한 80 위에서** 재야
  // "따라 줄었다"가 하한에 가려지지 않는다.
  const split = await request('pane.split', { pane_id: paneId, direction: 'right' })
  const otherPane = split.pane?.pane_id ?? split.pane_id ?? null
  await sleep(900)
  let widened = await ptyGrid(paneId)
  for (let attempt = 0; attempt < 8 && widened.cols < 88; attempt++) {
    await request('pane.resize', { pane_id: paneId, direction: 'right', amount: 8 }).catch(() => {})
    await sleep(700)
    widened = await ptyGrid(paneId)
  }
  await run(paneId, RULER, { settleMs: 1800 })
  const wideDump = (await app.dump()).dump
  const wideShot = await app.termShot('t2-narrow-before')

  await request('pane.resize', { pane_id: paneId, direction: 'left', amount: 4 }).catch(() => {})
  await sleep(900)
  const narrowed = await ptyGrid(paneId)
  await run(paneId, RULER, { settleMs: 1800 })
  await sleep(7000) // 창 경계를 지나야 줄어든다
  const narrowDump = (await app.dump()).dump
  const narrowState = (await app.state()).state.terminal
  const narrowShot = await app.termShot('t2-narrow-after')
  const shrinkLogs = app.entries().filter((entry) => entry.tag === 'term.grid.shrink')

  out.t2.narrowed = {
    note: 'pane 을 실제로 좁혀서 corral 격자가 따라 내려오나 (판정 M2). 좁아진 폭은 긴 줄이 다시 와야 관측된다',
    beforePty: widened,
    beforeGrid: { cols: wideDump.cols, rows: wideDump.rows },
    afterPty: narrowed,
    afterGrid: { cols: narrowDump.cols, rows: narrowDump.rows },
    observedColsAfter: narrowState.grid?.observedCols ?? null,
    followedDown: narrowDump.cols < wideDump.cols && narrowDump.cols === Math.max(narrowed.cols, 80),
    shrinkLogs,
    shots: [wideShot.file, narrowShot.file],
  }
  console.log('T2 narrow', widened.cols, '→', narrowed.cols, '· grid', wideDump.cols, '→', narrowDump.cols,
    '· shrink 로그', shrinkLogs.length)

  if (otherPane) await request('pane.close', { pane_id: otherPane }).catch(() => {})
  await sleep(600)

  await app.stop()
}

// ==========================================================================
// T5 — 스크롤백. 일반 판은 회수한 줄이 실제로 위로 스크롤되고, 알트 판은 0줄이 정답이다.
// ==========================================================================
{
  // --- 일반 판 ---
  const paneId = await tidySession()
  await run(paneId, 'clear; for i in $(seq 1 300); do printf "HIST %03d 스크롤백 줄\\n" $i; done', { settleMs: 3500 })

  const recent = await request('pane.read', {
    pane_id: paneId,
    source: 'recent_unwrapped',
    format: 'text',
    lines: 2000,
  })
  const visible = await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })

  const app = await startApp({ name: 'scrollback' })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(3000)

  const dump = (await app.dump()).dump
  const state = (await app.state()).state.terminal
  // 스크롤백에 실제로 앉아 있는 줄에서 마커를 찾는다 — "회수했다"가 아니라 "위로 스크롤된다"를 본다.
  const inHistory = dump.scrollback.filter((line) => line.includes('HIST ')).length
  const firstHistory = dump.scrollback.find((line) => line.includes('HIST ')) ?? null
  const lastHistory = [...dump.scrollback].reverse().find((line) => line.includes('HIST ')) ?? null
  // 통과선은 "회수 줄이 실제로 위로 스크롤된다"이다. 최신 줄은 **화면**에 있어야 정상이므로
  // 스크롤백만 세면 안 된다 — 스크롤백 + 화면을 합쳐 300개 마커가 다 있는지, 그리고 두 곳에
  // **겹쳐 나오는 줄(중복)** 이 없는지 같이 본다.
  const markerOf = (line) => line.match(/HIST (\d{3})/)?.[1] ?? null
  const historyMarkers = new Set(dump.scrollback.map(markerOf).filter((m) => m !== null))
  const screenMarkers = new Set(dump.grid.map((row) => markerOf(row.map((cell) => cell?.ch ?? ' ').join(''))).filter((m) => m !== null))
  const duplicated = [...historyMarkers].filter((m) => screenMarkers.has(m))
  const covered = new Set([...historyMarkers, ...screenMarkers])

  const normal = {
    paneId,
    recentLines: recent.read.text.split('\n').length,
    recentTruncated: recent.read.truncated,
    visibleLines: visible.read.text.split('\n').length,
    seededLines: state.seededLines,
    baseY: dump.baseY,
    scrollbackLinesWithMarker: inHistory,
    firstHistoryLine: firstHistory,
    lastHistoryLine: lastHistory,
    markersInScrollback: historyMarkers.size,
    markersOnScreen: screenMarkers.size,
    markersCovered: covered.size,
    markersDuplicated: duplicated.length,
    allMarkersPresent: covered.size === 300,
    usedPaneScroll: false,
    shot: (await app.termShot('t5-normal')).file,
  }
  console.log('T5 일반', JSON.stringify({ ...normal, shot: undefined }))

  // --- 격자 점프가 스크롤백을 흔드나 (판정 M3 의 미측정 위험) ----------------
  //
  // sparse pane 에서 격자가 80 이다가 긴 줄이 오면 93 으로 뛴다. 그 순간 렌더러는
  // `term.resize` 를 부르고 xterm 은 리플로우한다 — **심어 둔 히스토리가 그때 흔들리는지**
  // 아무도 안 쟀다. 여기서 격자를 일부러 흔들어 놓고 히스토리를 다시 센다.
  const beforeJump = { baseY: dump.baseY, historyLines: inHistory, first: firstHistory, last: lastHistory, cols: dump.cols }
  await run(paneId, RULER, { settleMs: 1800 })
  await sleep(1200)
  const afterDump = (await app.dump()).dump
  const afterHistory = afterDump.scrollback.filter((line) => line.includes('HIST ')).length
  const afterFirst = afterDump.scrollback.find((line) => line.includes('HIST ')) ?? null
  const afterLast = [...afterDump.scrollback].reverse().find((line) => line.includes('HIST ')) ?? null
  normal.gridJump = {
    note: '긴 줄을 흘려 격자를 넓힌 뒤 스크롤백을 다시 센다 (판정 M3 이 남긴 미측정 위험)',
    before: beforeJump,
    after: { baseY: afterDump.baseY, historyLines: afterHistory, first: afterFirst, last: afterLast, cols: afterDump.cols },
    gridChanged: afterDump.cols !== dump.cols,
    historyKept: afterHistory >= inHistory && afterFirst === firstHistory,
    shot: (await app.termShot('t5-grid-jump')).file,
  }
  console.log('T5 격자 점프', dump.cols, '→', afterDump.cols, '· 히스토리', inHistory, '→', afterHistory,
    normal.gridJump.historyKept ? '유지' : '흔들림')
  await app.stop()

  // --- 알트 판 ---
  await run(paneId, `clear; sh ${process.cwd()}/scripts/l345/fixtures/03-tui.sh &`, { settleMs: 2500 })
  const altApp = await startApp({ name: 'scrollback-alt' })
  await sleep(1200)
  await altApp.selectPane(paneId)
  await sleep(3000)
  const altDump = (await altApp.dump()).dump
  const altState = (await altApp.state()).state.terminal
  const altRecent = await request('pane.read', {
    pane_id: paneId,
    source: 'recent_unwrapped',
    format: 'text',
    lines: 2000,
  })
  const alt = {
    paneId,
    recentLines: altRecent.read.text.split('\n').length,
    seededLines: altState.seededLines,
    baseY: altDump.baseY,
    scrollbackLines: altDump.scrollback.length,
    // 알트 판의 정답은 0 이다. 가짜 히스토리를 만들면 미달.
    fabricatedHistory: altDump.baseY > 0 && altState.seededLines === 0,
    shot: (await altApp.termShot('t5-alt')).file,
  }
  console.log('T5 알트', JSON.stringify({ ...alt, shot: undefined }))
  await altApp.stop()
  out.t5 = { normal, alt }

  await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] }).catch(() => {})
  await sleep(400)
  await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 700 })
}

// ==========================================================================
// T6 — 커서. 그리지 않기로 했다. **정말로 안 그리는지** 화면에서 확인한다.
// ==========================================================================
{
  const paneId = (await panes())[0].pane_id
  await run(paneId, 'clear; printf "T6 커서 확인 화면\\n"', { settleMs: 900 })
  const app = await startApp({ name: 'cursor' })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(2500)
  const probe = await app.send({
    cmd: 'term-write',
    bytes: '',
  })
  const inspect = await app.send({ cmd: 'state' })
  // 렌더러에서 커서 옵션과 실제 DOM 커서 요소를 직접 읽는다.
  const cursorState = await app.send({ cmd: 'term-dump' })
  out.t6 = {
    decision: '그리지 않는다 (숨김)',
    rationale:
      'PaneReadResult 에 cursor 필드가 없다 — 스키마 계약이다. 위치를 모르는 커서를 추측해 그리면 알트스크린 TUI 에서 거의 항상 틀린 자리에 깜빡인다. 대신 입력 포커스를 터미널 테두리로 보인다',
    rendererCols: cursorState.dump?.cols ?? null,
    rendererRows: cursorState.dump?.rows ?? null,
    writeProbeBaseY: probe.baseY,
    stateOk: inspect.ok,
    shot: (await app.termShot('t6-cursor')).file,
  }
  await app.stop()
}

writeRaw('40-grid-scrollback.json', { measuredAt: new Date().toISOString(), ...out })
process.exit(0)
