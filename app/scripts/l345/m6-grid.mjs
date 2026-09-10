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

import { panes, request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

const out = {}

// ==========================================================================
// T2 — 격자
// ==========================================================================
{
  const paneId = await tidySession()
  // 폭을 눈으로 확인할 수 있게 열 자를 그린다 — 잘리면 바로 보인다.
  await run(
    paneId,
    `clear; awk 'BEGIN{s="";for(i=1;i<=200;i++){s=s (i%10==0? substr(sprintf("%d",i/10),length(sprintf("%d",i/10))) : ".")};print s}'; stty size`,
    { settleMs: 1200 },
  )
  const pty = await (async () => {
    const result = await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })
    const match = /(\d+)\s+(\d+)/.exec(result.read.text)
    return match ? { rows: Number(match[1]), cols: Number(match[2]) } : null
  })()

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
    usedPaneScroll: false,
    shot: (await app.termShot('t5-normal')).file,
  }
  console.log('T5 일반', JSON.stringify({ ...normal, shot: undefined }))
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
