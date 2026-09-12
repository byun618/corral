// S4 — 스크롤. wheel 위로 N줄 → 과거 내용 표시, 다시 아래로 → 최신 복귀.
// 각 지점에서 S1 방식 셀 일치. mouseReporting pane(TUI)과 일반 pane 두 경로 모두.
//
// 오라클 (기준 S4): 스크롤 후 화면 vs pane.read(해당 오프셋 상태) 대조. 오프셋 자체는
//   surface 의 scroll 필드가 아니라 **화면 내용**(마커 줄 번호)으로 증명.
// wheel 은 진짜 WheelEvent 로 꽂아 렌더러 캡처 핸들러 → termScroll 한 길을 실증한다.

import { startApp, attachPane, firstPaneId, settleHerdr, settleXterm, diffScreen, herdrRequest, sleep, writeRaw } from './lib.mjs'
import { FIXTURES, resetPane, neutralizePrompt, assertAltScreen } from './fixtures.mjs'

/** 화면 줄들에서 "scroll-line-NNN" 마커의 최소·최대 번호. */
function markerSpan(lines) {
  const nums = []
  for (const line of lines) for (const m of line.matchAll(/scroll-line-(\d+)/g)) nums.push(Number(m[1]))
  return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : { min: null, max: null }
}

async function cellMatch(app, paneId) {
  const herdr = await settleHerdr(paneId)
  const xterm = await settleXterm(app)
  return { mismatches: diffScreen(herdr.lines, xterm.term.lines), herdrLines: herdr.lines, xtermLines: xterm.term.lines }
}

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 's4-scroll' })
  await attachPane(app, paneId)

  const report = { normalPane: {}, mousePane: {} }

  // --- 1) 일반 pane: 400줄 스크롤 로그 ---
  await FIXTURES.scroll.setup(paneId)
  const atBottom = await cellMatch(app, paneId)
  const bottomSpan = markerSpan(atBottom.xtermLines)
  // wheel 위로 (deltaY 음수) — 뷰포트만큼 여러 번
  await app.wheel(-1200)
  await sleep(700)
  const scrolledUp = await cellMatch(app, paneId)
  const upSpan = markerSpan(scrolledUp.xtermLines)
  // wheel 아래로 (양수) 크게 — 최신 복귀
  await app.wheel(3000)
  await sleep(700)
  const backDown = await cellMatch(app, paneId)
  const downSpan = markerSpan(backDown.xtermLines)

  report.normalPane = {
    bottomSpan,
    upSpan,
    downSpan,
    // 과거를 봤나 (위로 스크롤 시 min 번호가 줄었다) + 각 지점 셀 일치
    showedPast: upSpan.min !== null && bottomSpan.min !== null && upSpan.min < bottomSpan.min,
    returnedLatest: downSpan.max === bottomSpan.max,
    cellMatchBottom: atBottom.mismatches.length,
    cellMatchUp: scrolledUp.mismatches.length,
    cellMatchDown: backDown.mismatches.length,
    upMismatchSample: scrolledUp.mismatches.slice(0, 4),
  }
  console.log('  일반 pane: 바닥', bottomSpan, '위로', upSpan, '복귀', downSpan)
  console.log('    과거표시', report.normalPane.showedPast, '최신복귀', report.normalPane.returnedLatest,
    '· 셀일치(바닥/위/복귀)', report.normalPane.cellMatchBottom, report.normalPane.cellMatchUp, report.normalPane.cellMatchDown)

  // --- 2) mouseReporting pane: vim + mouse=a (wheel → 마우스 이벤트로 문서 스크롤) ---
  await resetPane(paneId)
  await neutralizePrompt(paneId)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: "seq 1 300 | awk '{printf \"vimline-%03d\\n\", $1}' > /tmp/l353-vim.txt\n" })
  await sleep(500)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: 'vim -u NONE /tmp/l353-vim.txt\n' })
  await sleep(1200)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: ':set mouse=a\rG' }) // 마우스 켜고 문서 끝으로
  await sleep(800)
  // 마커는 이 fixture 의 것(vimline-NNN)으로 본다 (수정 1회차 L3). `G` 로 문서 끝으로 갔으므로
  // 화면에 보이는 건 001 이 아니라 꼬리 줄들이라, 특정 번호가 아니라 vimline-\d{3} 패턴으로 확인한다.
  const alt = await assertAltScreen(paneId, { marker: /vimline-\d{3}/ })
  const beforeVim = await cellMatch(app, paneId)
  const beforeText = beforeVim.xtermLines.join('\n')
  // wheel 위로 — mouseReporting 이면 벤더가 마우스 스크롤 이벤트로 보낸다 (pane.scroll 아님)
  await app.wheel(-1200)
  await sleep(700)
  const afterVim = await cellMatch(app, paneId)
  const afterText = afterVim.xtermLines.join('\n')
  report.mousePane = {
    alt: alt.alt,
    mouseReporting: (await app.state()).terminal.mouseReporting,
    contentChanged: beforeText !== afterText,
    cellMatchBefore: beforeVim.mismatches.length,
    cellMatchAfter: afterVim.mismatches.length,
  }
  console.log('  mouse pane(vim): alt', alt.alt, 'mouseReporting', report.mousePane.mouseReporting,
    '내용변화', report.mousePane.contentChanged, '· 셀일치(전/후)', report.mousePane.cellMatchBefore, report.mousePane.cellMatchAfter)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x1b:qa!\r' })

  const np = report.normalPane
  const mp = report.mousePane
  const pass =
    np.showedPast && np.returnedLatest && np.cellMatchBottom === 0 && np.cellMatchUp === 0 && np.cellMatchDown === 0 &&
    mp.alt && mp.mouseReporting && mp.contentChanged && mp.cellMatchBefore === 0 && mp.cellMatchAfter === 0
  const result = { at: new Date().toISOString(), buildCheck: app.buildCheck, report, verdict: pass ? '통과' : '미달' }
  writeRaw('s4-scroll.json', result)
  console.log('\nS4 →', result.verdict)
  await app.stop()
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
