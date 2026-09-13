// A 계열 — 보조 지표 (01-criteria §A). 미달이 채택을 막지 않는다. 재고, 기록만 한다.
//   A1 OSC 52 복사 → Electron 클립보드   A2 정적 화면 깜빡임   A3 칩·스트림 순서 창 관찰
//   A4 스트림 비용(프레임/s·KB/s·CPU)     A5 마우스 클릭 전달(mouseReporting TUI)
//
// 한 앱 인스턴스에서 순차로 잰다 (각 소항목 사이 pane 을 되돌린다). 원자료는 a-series.json.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startApp, attachPane, firstPaneId, herdrRequest, herdrRead, herdrPane, until, sleep, writeRaw, RAW_DIR } from './lib.mjs'
import { neutralizePrompt, resetPane, FIXTURES, assertAltScreen } from './fixtures.mjs'

// --- A1: OSC 52 복사가 Electron(=OS) 클립보드에 실리나 ---------------------------
async function a1Clipboard(app, paneId) {
  await resetPane(paneId)
  await neutralizePrompt(paneId)
  const marker = `clip-a1-${Date.now() % 1000000}`
  const b64 = Buffer.from(marker).toString('base64')
  // pane 안 프로그램이 OSC 52 를 낸다: ESC ] 52 ; c ; <base64> BEL. 셸에서 printf 로.
  await herdrRequest('pane.send_text', { pane_id: paneId, text: `printf '\\033]52;c;${b64}\\a'\n` })
  const got = await until(
    async () => {
      const text = await app.readClipboard()
      return text === marker ? text : null
    },
    { timeoutMs: 4000, everyMs: 100, what: 'osc52 → clipboard' },
  )
  return {
    marker,
    base64: b64,
    delivered: got.ok,
    clipboard: got.ok ? got.value : await app.readClipboard(),
    note: 'pane→herdr endpoint clipboard 이벤트→stream.onClipboard→Electron clipboard.writeText. corral 쪽 read-clipboard 로 확인.',
  }
}

// --- A2: 정적 화면 깜빡임 (스크린샷 ≥10장 해시 종류) ------------------------------
async function a2Flicker(app, paneId) {
  await resetPane(paneId)
  await neutralizePrompt(paneId)
  await sleep(800) // 화면 정착
  const hashes = []
  for (let i = 0; i < 12; i++) {
    const shot = await app.shot(`a2-flicker-${i}`, '.term-host')
    const abs = path.isAbsolute(shot.file) ? shot.file : path.join(RAW_DIR, shot.file)
    const buf = fs.readFileSync(abs)
    hashes.push(crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16))
    await sleep(800)
  }
  const unique = [...new Set(hashes)]
  return {
    shots: hashes.length,
    uniqueHashes: unique.length,
    hashes,
    stable: unique.length === 1,
    dec2026: '프레임을 BSU(?2026h)/ESU(?2026l)로 감싸 원자 표시 (stream.ts). scrollback 0 이라 ED2 뷰포트 리셋도 무해화 — 정적 화면은 재그리기가 나도 픽셀 동일해야 한다.',
  }
}

// --- A4: 스트림 비용 (티커 1개, 프레임/s·KB/s·CPU) --------------------------------
async function a4StreamCost(app, paneId) {
  await resetPane(paneId)
  await neutralizePrompt(paneId)
  // ~10줄/s 티커. 측정 실행이라 stream 층이 stream.frame{seq,bytes} 를 남긴다 (stream.ts, measuring 게이트).
  await herdrRequest('pane.send_text', { pane_id: paneId, text: 'while true; do date +%s.%N; sleep 0.1; done\n' })
  const windowMs = 5000
  const since = Date.now()
  await sleep(300) // 티커가 돌기 시작할 여유
  const t0 = Date.now()
  // CPU: 측정 창 동안 electron 메인 프로세스 CPU 시간 델타 (best-effort, ps).
  const cpuBefore = readCpuTime(app.child.pid)
  await sleep(windowMs)
  const cpuAfter = readCpuTime(app.child.pid)
  const t1 = Date.now()
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x03' }) // 티커 정지
  await sleep(300)
  const frames = app.entries().filter((e) => e.tag === 'stream.frame' && e.at >= t0 && e.at <= t1)
  const totalBytes = frames.reduce((sum, f) => sum + (typeof f.bytes === 'number' ? f.bytes : 0), 0)
  const secs = (t1 - t0) / 1000
  return {
    windowSec: Number(secs.toFixed(2)),
    frames: frames.length,
    framesPerSec: Number((frames.length / secs).toFixed(1)),
    kbPerSec: Number((totalBytes / 1024 / secs).toFixed(2)),
    avgFrameBytes: frames.length ? Math.round(totalBytes / frames.length) : 0,
    cpuSecondsDelta: cpuBefore !== null && cpuAfter !== null ? Number((cpuAfter - cpuBefore).toFixed(2)) : null,
    cpuNote: 'electron 메인 프로세스만. 렌더러/GPU 프로세스는 별도 pid 라 미포함 — best-effort.',
    note: '측정 실행에서만 켜지는 stream.frame 로그(stream.ts, control 소켓 게이트로 measuring) 기반. r1 은 index.ts 에도 중복 로그가 있어 2배 계수였다 — C1 에서 index.ts 로그 제거.',
  }
}

function readCpuTime(pid) {
  try {
    // ps -o time= : 누적 CPU 시간 [[dd-]hh:]mm:ss
    const out = execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString().trim()
    const parts = out.split(/[:-]/).map(Number)
    let s = 0
    for (const p of parts) s = s * 60 + p
    return s
  } catch {
    return null
  }
}

// --- A5: 마우스 클릭 전달 (mouseReporting TUI) ------------------------------------
async function a5Mouse(app, paneId) {
  await FIXTURES.tui.setup(paneId) // vim -u NONE, 60줄 버퍼
  const alt = await assertAltScreen(paneId)
  // vim 에서 마우스 리포팅 켜기.
  await herdrRequest('pane.send_text', { pane_id: paneId, text: ':set mouse=a\r' })
  await sleep(400)
  // gg 로 커서를 1행으로 확정.
  await herdrRequest('pane.send_text', { pane_id: paneId, text: 'gg' })
  await sleep(400)
  const before = await app.termRead()
  const beforeY = before?.cursorY ?? null
  // 화면 아래쪽(60% 지점)을 진짜 클릭 — mouseReporting 이 살아 있으면 vim 커서가 그리로 간다.
  const clicked = await app.termClick(0.5, 0.6)
  const moved = await until(
    async () => {
      const term = await app.termRead()
      return term && term.cursorY !== beforeY ? term : null
    },
    { timeoutMs: 3000, everyMs: 40, what: 'vim cursor move on click' },
  )
  await resetPane(paneId)
  return {
    altScreen: alt.alt,
    clickDispatched: clicked.ok,
    clickCoord: clicked.dispatched ?? null,
    beforeCursorY: beforeY,
    afterCursorY: moved.ok ? moved.value.cursorY : (await app.termRead())?.cursorY ?? null,
    delivered: moved.ok,
    note: '진짜 MouseEvent → xterm SGR 마우스 인코딩 → onData → herdr → vim 커서 이동 → 프레임 → xterm 커서 이동. 커서 행 변화로 왕복 확인.',
  }
}

// --- A3: 칩·스트림 순서 창 관찰 (행 전환 직후) -----------------------------------
// 별개 소켓(control 링크 vs endpoint 스트림)이라 순서 보장이 없다. **진짜 A→B 전환**(다른 pane
// 클릭) 직후 상태 반영(state.emit)과 첫 stream.frame 이 어느 순서로 오는지 창을 관찰만 한다.
async function a3OrderWindow(app, paneA, paneB) {
  if (!paneB) return { observed: null, note: 'pane 2개를 못 확보해 관찰창을 못 잡음 (공백).' }
  await resetPane(paneB)
  await neutralizePrompt(paneB)
  await herdrRequest('pane.send_text', { pane_id: paneB, text: "printf 'A3-PANE-B\\n'\n" })
  await sleep(600)
  const t = Date.now()
  const clicked = await app.click(`[data-pane="${paneB}"]`) // A→B 진짜 전환
  await sleep(1800)
  const tags = new Set(['stream.frame', 'stream.select', 'stream.select.no_session', 'stream.select.unknown_pane', 'stream.pane_gone', 'app.emit', 'state.emit', 'link.phase'])
  const events = app
    .entries()
    .filter((e) => e.at >= t && (tags.has(e.tag) || String(e.tag).startsWith('stream.')))
    .slice(0, 16)
    .map((e) => ({ dtMs: e.at - t, tag: e.tag, ...(typeof e.seq === 'number' ? { seq: e.seq } : {}) }))
  const firstFrame = events.find((e) => e.tag === 'stream.frame')
  return {
    switchedTo: paneB,
    clickHit: clicked.hit === true,
    firstFrameDtMs: firstFrame ? firstFrame.dtMs : null,
    observed: events,
    note: '두 소켓 비동기. 전환 후 첫 stream.frame 과 상태 갱신의 상대 순서는 실행마다 다를 수 있다 — 설계상 살아 있는 endpoint 연결은 하나뿐이고 재선택 시 pane.focus 로 따라간다 (00-analysis §3-2). 칩(control 상태)이 먼저 그려지고 프레임이 뒤따르는 짧은 창이 정상.',
  }
}

/** A3 용으로 pane 2개를 확보한다 (없으면 탭을 하나 더 만든다). */
async function ensureTwoPanes() {
  let panes = (await herdrRequest('pane.list', {})).panes
  if (panes.length < 2) {
    const ws = (await herdrRequest('workspace.list', {})).workspaces[0]
    await herdrRequest('tab.create', { workspace_id: ws.workspace_id })
    await sleep(800)
    panes = (await herdrRequest('pane.list', {})).panes
  }
  return panes.map((p) => p.pane_id)
}

async function main() {
  const paneIds = await ensureTwoPanes()
  const [paneId, paneB] = paneIds
  const app = await startApp({ name: 'a-series' })
  await attachPane(app, paneId)

  const results = {}
  const run = async (key, fn) => {
    try {
      results[key] = await fn()
      console.log(`  ${key} ✓`)
    } catch (e) {
      results[key] = { error: String(e) }
      console.log(`  ${key} ✗ ${e}`)
    }
  }

  await run('A1_clipboard', () => a1Clipboard(app, paneId))
  await run('A2_flicker', () => a2Flicker(app, paneId))
  await run('A4_streamCost', () => a4StreamCost(app, paneId))
  await run('A5_mouse', () => a5Mouse(app, paneId))
  await run('A3_orderWindow', () => a3OrderWindow(app, paneId, paneB))

  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    kind: '보조 지표 (미달이 채택을 막지 않음)',
    A1: results.A1_clipboard,
    A2: results.A2_flicker,
    A3: results.A3_orderWindow,
    A4: results.A4_streamCost,
    A5: results.A5_mouse,
  }
  writeRaw('a-series.json', result)
  console.log('\nA 계열:',
    `A1 ${results.A1_clipboard?.delivered ? '전달' : '미전달'} ·`,
    `A2 ${results.A2_flicker?.uniqueHashes}종 해시 ·`,
    `A4 ${results.A4_streamCost?.framesPerSec}f/s ${results.A4_streamCost?.kbPerSec}KB/s ·`,
    `A5 ${results.A5_mouse?.delivered ? '전달' : '미전달'}`)
  await app.stop()
  process.exit(0) // 보조 — 미달이어도 0 으로 끝낸다
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
