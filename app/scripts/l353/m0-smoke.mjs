// 스모크 — 파이프라인이 실제로 흐르나. 판정 항목 아님, 하네스 배선 확인용.
// 앱 기동 → pane 선택(진짜 클릭) → echo 명령 → xterm 버퍼에 그 글자가 뜨나 + herdr 대조.

import { startApp, attachPane, firstPaneId, herdrRequest, herdrRead, normalizeLines, diffScreen, sleep, writeRaw } from './lib.mjs'

async function main() {
  const paneId = await firstPaneId()
  console.log('pane:', paneId)
  const app = await startApp({ name: 'm0-smoke' })
  console.log('app ready:', app.ready)

  const attach = await attachPane(app, paneId)
  console.log('attached:', attach.clicked.hit, 'streaming in', attach.streamingMs, 'ms')
  const clicked = { ok: true, value: attach.clicked }
  const streaming = { ok: true, ms: attach.streamingMs }

  // pane 에 유일 마커를 찍는다
  const marker = `SMOKE_${Date.now()}`
  await herdrRequest('pane.send_text', { pane_id: paneId, text: `printf '${marker}\\n'\n` })
  await sleep(1500)

  const term = await app.termRead()
  const xtermHasMarker = term.lines.some((line) => line.includes(marker))
  const herdr = await herdrRead(paneId)
  const mismatches = diffScreen(normalizeLines(herdr.text), term.lines)

  const result = {
    paneId,
    clickHit: clicked.value?.hit ?? false,
    streamingMs: streaming.ms,
    xtermSize: `${term.cols}x${term.rows}`,
    cursor: { x: term.cursorX, y: term.cursorY, hidden: term.cursorHidden },
    xtermHasMarker,
    mismatchRows: mismatches.length,
    mismatchesSample: mismatches.slice(0, 5),
  }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('m0-smoke.json', { at: new Date().toISOString(), buildCheck: app.buildCheck, result })
  await app.stop()
  process.exit(xtermHasMarker && clicked.value?.hit ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
