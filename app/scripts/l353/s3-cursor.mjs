// S3 — 커서. fixture 3종에서 커서 위치·가시성 어긋남 0 (숨김 화면에서 숨김 포함).
//
// 오라클 (기준 S3): herdr 서버 권위 좌표 = **독립 endpoint 연결**의 surface.frame.cursor
//   (앱의 스트림과 다른 연결) vs xterm 실커서(buffer.cursorX/Y + 가시성, 렌더러 프로브).
//   대조 시점은 정착 화면. 독립 연결이 벤더 readFrameData 를 공유하는 점은 advisor #6 로
//   완화됨(S1 이 셀 파싱을 독립 프로토콜 pane.read 로 이미 검증, cursor 는 wire 상 셀 바로 뒤).
//
// 좌표계: 독립 연결의 cursor 는 탭 절대좌표다 — 앱과 같은 crop(innerRect 차감)으로 pane
//   상대좌표로 옮겨 xterm 좌표와 맞춘다.

import * as os from 'node:os'
import * as path from 'node:path'
import { startApp, attachPane, firstPaneId, settleXterm, herdrRequest, sleep, writeRaw } from './lib.mjs'
import { FIXTURES, resetPane, neutralizePrompt, assertAltScreen } from './fixtures.mjs'
import { EndpointClient } from '../../src/main/adapter/internal/vendor/endpoint-client.ts'

function clientSocket() {
  return path.join(os.homedir(), '.config/herdr/sessions/life353-claude/herdr-client.sock')
}

/** 독립 endpoint 연결로 pane 의 서버 권위 커서(pane 상대) 를 읽는다. */
async function herdrCursor(paneId) {
  const client = new EndpointClient(clientSocket())
  client.on('error', () => {})
  await client.connect(120, 40)
  await client.callEndpoint('pane.focus', { pane_id: paneId })
  await sleep(600)
  const surface = client.currentSurface
  const pane = surface?.panes.find((p) => p.paneId === paneId)
  const cursor = surface?.frame.cursor ?? null
  client.close()
  if (!pane || !cursor) return null
  return {
    x: cursor.x - pane.innerRect.x,
    y: cursor.y - pane.innerRect.y,
    visible: cursor.visible,
  }
}

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 's3-cursor' })
  await attachPane(app, paneId)

  const cases = []
  // fixture 3종
  for (const fixture of Object.values(FIXTURES)) {
    await fixture.setup(paneId)
    if (fixture.key === 'tui') {
      const alt = await assertAltScreen(paneId)
      if (!alt.alt) console.error('  tui 알트 미확인', alt)
    }
    await settleXterm(app)
    await sleep(300)
    const herdr = await herdrCursor(paneId)
    const term = await app.termRead()
    cases.push(evaluate(fixture.key, herdr, term))
  }
  // 숨김 커서 — printf '\e[?25l' 로 커서를 숨긴 정적 화면 (기준: 숨김 화면에서 숨김 포함)
  await resetPane(paneId)
  await neutralizePrompt(paneId)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: "printf 'hidden-cursor-screen\\n\\033[?25l'\n" })
  await sleep(1000)
  await settleXterm(app)
  {
    const herdr = await herdrCursor(paneId)
    const term = await app.termRead()
    cases.push(evaluate('hidden', herdr, term))
  }
  // 다시 보이게 (뒷정리)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: "printf '\\033[?25h'\n" })

  const mismatches = cases.filter((c) => !c.match).length
  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    oracle: '독립 endpoint 연결 surface.frame.cursor(pane 상대) vs xterm buffer.cursorX/Y + cursorHidden',
    cases,
    mismatches,
    verdict: mismatches === 0 ? '통과' : '미달',
  }
  writeRaw('s3-cursor.json', result)
  for (const c of cases) {
    console.log(`  [${c.fixture}] herdr(${c.herdr?.x},${c.herdr?.y},vis=${c.herdr?.visible}) xterm(${c.xtermX},${c.xtermY},vis=${!c.xtermHidden}) → ${c.match ? '일치' : '어긋남'}`)
  }
  console.log('\nS3 어긋남:', mismatches, '→', result.verdict)
  await app.stop()
  process.exit(mismatches === 0 ? 0 : 1)
}

function evaluate(fixture, herdr, term) {
  const xtermVisible = !term.cursorHidden
  const posMatch = herdr !== null && herdr.x === term.cursorX && herdr.y === term.cursorY
  const visMatch = herdr !== null && herdr.visible === xtermVisible
  return {
    fixture,
    herdr,
    xtermX: term.cursorX,
    xtermY: term.cursorY,
    xtermHidden: term.cursorHidden,
    posMatch,
    visMatch,
    // 숨김일 때는 위치가 무의미 — 가시성만 본다 (양쪽 다 숨김이면 통과).
    match: herdr !== null && (herdr.visible === false && xtermVisible === false ? true : posMatch && visMatch),
  }
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
