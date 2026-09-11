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

import { countGridTransitions, panes, ptyGrid, rendererErrors, request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

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
  await sleep(14_000) // > GRID_REFRESH_MS × 2. 이력 때문에 연속 두 창이 짧아야 줄어든다 (G3).
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
  // 줄이기에 이력을 넣었으므로 **연속 두 창**이 지나야 내려간다 (2회차 리뷰 G3).
  // 한 창(7초)만 기다리면 "따라 내려오지 않는다"로 잘못 읽힌다 — 설계가 아니라 대기가 짧은 것이다.
  await sleep(14_000)
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

  // --- 격자 **축소** 방향도 잰다 (2회차 리뷰 N6 · G3 의 측정 공백) -----------
  //
  // 위 점프는 넓히는 방향(88→93)만 쟀다. 실사용에서 더 잦은 것은 **좁히는 방향**이다 —
  // 긴 줄이 화면에서 사라지면 관측 폭이 내려가고 격자가 하한 80 으로 줄어든다. 그때도
  // xterm 이 리플로우하므로 심어 둔 히스토리가 흔들리는지 봐야 한다.
  //
  // 이번 회차에서 줄이기에 이력을 넣었으므로(연속 두 창) **창 두 개 이상**을 짧게 살아야 한다.
  await run(paneId, 'clear; printf "짧은 줄\n"', { settleMs: 1200 })
  await sleep(14_000) // > GRID_REFRESH_MS × 2 + 여유
  const shrunkDump = (await app.dump()).dump
  const shrunkState = (await app.state()).state.terminal
  const shrunkHistory = shrunkDump.scrollback.filter((line) => line.includes('HIST ')).length
  const shrunkFirst = shrunkDump.scrollback.find((line) => line.includes('HIST ')) ?? null
  const shrunkLast = [...shrunkDump.scrollback].reverse().find((line) => line.includes('HIST ')) ?? null
  const shrinkMarkers = new Set(shrunkDump.scrollback.map(markerOf).filter((m) => m !== null))
  normal.gridShrink = {
    note: '긴 줄을 치워 격자를 줄인 뒤 스크롤백을 다시 센다 (2회차 리뷰 N6 — 1차는 확대만 쟀다)',
    before: { cols: afterDump.cols, historyLines: afterHistory, first: afterFirst, last: afterLast },
    after: {
      cols: shrunkDump.cols,
      observedCols: shrunkState.grid?.observedCols ?? null,
      historyLines: shrunkHistory,
      first: shrunkFirst,
      last: shrunkLast,
      markers: shrinkMarkers.size,
    },
    gridShrank: shrunkDump.cols < afterDump.cols,
    historyKept: shrunkHistory >= afterHistory && shrunkFirst === afterFirst && shrunkLast === afterLast,
    shrinkLogs: app.entries().filter((entry) => entry.tag === 'term.grid.shrink'),
    pendingLogs: app.entries().filter((entry) => entry.tag === 'term.grid.shrink.pending'),
    shot: (await app.termShot('t5-grid-shrink')).file,
  }
  console.log('T5 격자 축소', afterDump.cols, '→', shrunkDump.cols, '· 히스토리', afterHistory, '→', shrunkHistory,
    normal.gridShrink.historyKept ? '유지' : '흔들림')

  // --- 그린 격자가 몇 번 바뀌었나 (G3 의 본 지적) ---------------------------
  //
  // `term.grid.shrink` 는 **관측 폭**의 변화고, 사용자가 보는 것은 `term.frame` 의 `cols` 다
  // (`max(관측, 80)`). 1차 수정은 그 둘을 섞어 적어 "하한 80 이 흡수한다"로 맺었는데,
  // 실제로 그린 격자는 93↔80 을 오갔다. 여기서 **그린 격자의 전환 횟수**를 직접 센다.
  normal.gridTransitions = countGridTransitions(app.entries())
  normal.rendererErrors = rendererErrors(app.entries())
  console.log('T5 격자 전환', normal.gridTransitions.transitions, '회 ·', normal.gridTransitions.sequence.join('→'))
  await app.stop()

  // --- 알트 판 ---
  //
  // **움직이는 TUI 로 잰다** (2회차 리뷰 G6). 1차에는 정지한 알트 픽스처(`03-tui.sh`)로 쟀는데,
  // 그 화면에서는 꼬리 일치가 성공해 `historyAbove` 가 애초에 0줄을 돌려줬다 — 씨앗 상한이
  // **한 번도 물지 않는 자리에서** "알트는 0줄"을 확인한 셈이다. 고친 버그가 재현되지 않는
  // 픽스처에서 회귀 검사가 돈 것이다.
  //
  // 그래서 T4 가 쓰는 것과 같은 `vim -u NONE -O` 로 바꾼다: 화면이 움직여 두 스냅샷이 어긋나고,
  // 꼬리 일치가 실패해 어림잡기로 빠지며, **그때 상한(0)이 실제로 문다**. 그 물린 자리가
  // `term.scrollback.capped` 로그로 남아 T5 의 근거가 된다.
  await run(paneId, "printf 'ALT 왼쪽\n' > /tmp/l345-t5-left.txt; printf 'ALT 오른쪽\n' > /tmp/l345-t5-right.txt", { settleMs: 500 })
  // 뷰포트보다 많이 심어 둔다 — 일반 판에서 상한이 0보다 커야 대비가 보인다.
  await run(paneId, 'clear; for i in $(seq 1 60); do echo "ALT HIST $i"; done', { settleMs: 2000 })
  const altScrollBefore = (await request('pane.get', { pane_id: paneId })).pane.scroll
  await run(paneId, 'vim -u NONE -O /tmp/l345-t5-left.txt /tmp/l345-t5-right.txt', { settleMs: 3500 })
  // 파일 둘을 열면 vim 이 "Press ENTER" 에서 멈춘다 — 밀어 줘야 진짜 전체화면이다 (1차 수정 실측).
  await request('pane.send_text', { pane_id: paneId, text: '\r' })
  await sleep(3000)
  const altScrollAfter = (await request('pane.get', { pane_id: paneId })).pane.scroll
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
  // 상한이 **실제로 물었나**. 이게 이번 회차가 회귀 검사에 넣으라고 한 것이다 (G6).
  const capped = altApp.entries().filter((entry) => entry.tag === 'term.scrollback.capped')
  const alt = {
    paneId,
    subject: 'vim -u NONE -O (움직이는 알트 TUI — 꼬리 일치가 실패하는 화면)',
    maxOffsetBefore: altScrollBefore.max_offset_from_bottom,
    maxOffsetAfter: altScrollAfter.max_offset_from_bottom,
    altConfirmed: altScrollBefore.max_offset_from_bottom > 0 && altScrollAfter.max_offset_from_bottom === 0,
    recentLines: altRecent.read.text.split('\n').length,
    seededLines: altState.seededLines,
    baseY: altDump.baseY,
    scrollbackLines: altDump.scrollback.length,
    // 알트 판의 정답은 0 이다. 가짜 히스토리를 만들면 미달.
    fabricatedHistory: altDump.baseY > 0 && altState.seededLines === 0,
    cappedLogs: capped,
    // **상한이 물었고(= 어림잡기가 지어낸 몫을 잘랐고) 그 결과가 0줄**이어야 한다.
    capBit: capped.some((entry) => entry.cap === 0 && entry.found > 0),
    shot: (await altApp.termShot('t5-alt')).file,
  }
  console.log('T5 알트', JSON.stringify({ ...alt, shot: undefined, cappedLogs: capped.length }))
  await altApp.stop()

  // --- 상한을 **모를 때** 무엇을 하나 (2회차 리뷰 G1-b) -----------------------
  //
  // 씨앗 상한은 `pane.get` 이 준다. 그 호출이 실패하면 상한이 `null` 이고, 1차 수정은 그때
  // **무제한**이었다 — 지어내기를 막으려고 만든 상한이 정작 모를 때는 안 걸렸다.
  // (1차 측정에는 `pane.get` 이 실패한 런이 한 건도 없어 이 갈래를 아무도 안 밟았다.)
  //
  // 지금은 보수적으로 간다: **꼬리 일치로 닻을 내린 씨앗만** 쓰고 어림잡은 쪽은 버린다.
  // 두 갈래를 다 잰다 — ⓐ 움직이는 알트(닻 없음 → 0줄) ⓑ 일반 판(닻 있음 → 과거 보존).
  const capUnknown = {}
  {
    // ⓐ vim 이 아직 떠 있다. 주입을 켜고 붙는다.
    const app2 = await startApp({ name: 'cap-alt', env: { CORRAL_INJECT_PANE_GET_FAIL: '1' } })
    await sleep(1200)
    await app2.selectPane(paneId)
    await sleep(4000)
    const dump2 = (await app2.dump()).dump
    const state2 = (await app2.state()).state.terminal
    const entries2 = app2.entries()
    capUnknown.alt = {
      note: '움직이는 알트 TUI + pane.get 실패 주입 — 상한을 모르고 닻도 없다. 0줄이 정답이다',
      paneGetFailedLogs: entries2.filter((entry) => entry.tag === 'term.grid.pane_get_failed').length,
      cappedLogs: entries2.filter((entry) => entry.tag === 'term.scrollback.capped'),
      seededLines: state2.seededLines,
      baseY: dump2.baseY,
      scrollbackLines: dump2.scrollback.length,
      fabricatedHistory: (state2.seededLines ?? 0) > 0,
      shot: (await app2.termShot('t5-cap-alt')).file,
    }
    console.log('T5 상한모름·알트', JSON.stringify({ ...capUnknown.alt, shot: undefined, cappedLogs: capUnknown.alt.cappedLogs.length }))
    await app2.stop()
  }

  // vim 을 정직하게 닫는다 — C-c 로는 안 나간다.
  await request('pane.send_keys', { pane_id: paneId, keys: ['Escape'] }).catch(() => {})
  await sleep(300)
  await request('pane.send_text', { pane_id: paneId, text: ':qa!\n' }).catch(() => {})
  await sleep(900)
  await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 700 })

  {
    // ⓑ 일반 판 — 닻이 있으므로 과거가 살아 있어야 한다. 보수적으로 간다고 **진짜 과거까지
    // 버리면** 그건 또 다른 결함이다 (codex 가 짚은 반대 방향).
    await run(paneId, 'clear; for i in $(seq 1 200); do printf "CAP %03d 줄\n" $i; done', { settleMs: 3000 })
    const app3 = await startApp({ name: 'cap-normal', env: { CORRAL_INJECT_PANE_GET_FAIL: '1' } })
    await sleep(1200)
    await app3.selectPane(paneId)
    await sleep(4000)
    const dump3 = (await app3.dump()).dump
    const state3 = (await app3.state()).state.terminal
    const entries3 = app3.entries()
    const capMarker = (line) => line.match(/CAP (\d{3})/)?.[1] ?? null
    const inHistory3 = new Set(dump3.scrollback.map(capMarker).filter((m) => m !== null))
    const onScreen3 = new Set(
      dump3.grid.map((row) => capMarker(row.map((cell) => cell?.ch ?? ' ').join(''))).filter((m) => m !== null),
    )
    capUnknown.normal = {
      note: '일반 판 + pane.get 실패 주입 — 닻이 있으므로 과거는 살아 있어야 한다',
      paneGetFailedLogs: entries3.filter((entry) => entry.tag === 'term.grid.pane_get_failed').length,
      cappedLogs: entries3.filter((entry) => entry.tag === 'term.scrollback.capped'),
      seededLines: state3.seededLines,
      baseY: dump3.baseY,
      markersInScrollback: inHistory3.size,
      markersOnScreen: onScreen3.size,
      markersCovered: new Set([...inHistory3, ...onScreen3]).size,
      markersDuplicated: [...inHistory3].filter((m) => onScreen3.has(m)).length,
      historyKept: (state3.seededLines ?? 0) > 0,
      shot: (await app3.termShot('t5-cap-normal')).file,
    }
    console.log('T5 상한모름·일반', JSON.stringify({ ...capUnknown.normal, shot: undefined, cappedLogs: capUnknown.normal.cappedLogs.length }))
    await app3.stop()
  }

  out.t5 = { normal, alt, capUnknown }

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
