// LIFE-527 K6ⓑⓒ — 떠 있는 격리 corral(os-up.mjs) 에서 오버레이 위치·터미널 크기를 잰다. before(작업 브랜치 빌드)·after(구현 빌드) 같은 절차.
// 판정 입력이 아니라 위치 측정이다 — 오버레이를 여는 데 CDP·제어 소켓을 쓴다(drag/no-drag 판정은 K5 OS 입력이 따로 했다).
//   ⓒ 상태바 `xterm C×R` ↔ herdr `session.snapshot` 의 pane width·height
//   ⓑ 팔레트(⌘K)·MRU(⌃Tab 홀드)·탭 드롭존(탭 끌어 터미널 위)·호버 카드(worktree 카드 hover)·대화상자(레포 추가) — 박스 + 탭 줄 박스 + 스크린샷
// 실행: node k6-probe.mjs --work /tmp/l527os --out <원자료 폴더> --label before|after
/* global fetch, document, innerWidth, innerHeight */
import fs from 'node:fs'
import path from 'node:path'
import { connect, pause, until } from '../gui-diff/lib/cdp.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const work = arg('--work', '/tmp/l527os')
const outDir = path.resolve(arg('--out', ''))
const label = arg('--label', 'after')
fs.mkdirSync(outDir, { recursive: true })
const state = JSON.parse(fs.readFileSync(path.join(work, 'os-state.json'), 'utf8'))
const list = await (await fetch(`http://127.0.0.1:${state.corralPort}/json/list`)).json()
const page = list.find((entry) => entry.type === 'page' && !entry.url.startsWith('devtools://'))
const cdp = await connect(page.webSocketDebuggerUrl)
const control = (request) => rpc(state.corralControl, request)
const result = { label, at: new Date().toISOString() }

const box = (selector) => cdp.evaluate((selector) => {
  const element = document.querySelector(selector)
  if (!element) return null
  const r = element.getBoundingClientRect()
  return { x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100, w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 }
}, selector)
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(outDir, `${label}-${name}.png`), Buffer.from(data, 'base64'))
}
const mouse = (type, point, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : (extra.buttons ?? 0), clickCount: extra.clickCount ?? 0 })
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const click = async (selector) => { const b = await box(selector); if (!b) throw new Error(`없음 ${selector}`); const p = center(b); await mouse('mouseMoved', p); await mouse('mousePressed', p, { buttons: 1, clickCount: 1 }); await mouse('mouseReleased', p, { clickCount: 1 }) }
const frame = async () => ({ tabbar: await box('[data-main-tabbar]'), terminalChrome: await box('.terminal-chrome'), pane: await box('[data-term-pane-box]'), inner: await cdp.evaluate(() => [innerWidth, innerHeight]) })

try {
  // 준비: worktree 열기(탭 1개) + 탭 하나 더(MRU 는 pane 2개 이상)
  if ((await box('[data-main-tab]')) === null) {
    await click('[data-worktree] [data-worktree-card-surface]')
    await until(async () => (await box('[data-main-tab]')) !== null, '탭', 15_000, 100)
  }
  if ((await cdp.evaluate(() => document.querySelectorAll('[data-main-tab]').length)) < 2) {
    await control({ cmd: 'key', keyCode: 'T', modifiers: ['meta'] })
    await until(async () => (await cdp.evaluate(() => document.querySelectorAll('[data-main-tab]').length)) >= 2, '둘째 탭', 15_000, 100)
  }
  await pause(1500)
  result.frame = await frame()

  // ⓒ 터미널 크기
  await click('[data-term-pane-box]')
  await pause(300)
  // xterm 쪽 = 상태바 + 렌더러 터미널 프로브(pane 하나), herdr 쪽 = session.snapshot 의 pane width·height
  const read = await control({ cmd: 'term-read' })
  const snapshot = await rpc(path.join(work, 'corral-herdr/herdr/sessions/l443-gui-diff/herdr.sock'), { id: `l527-k6-${Date.now()}`, method: 'session.snapshot', params: {} })
  result.terminal = {
    statusBar: await cdp.evaluate(() => [...document.querySelectorAll('[data-statusbar] span')].map((span) => span.textContent).find((t) => /^xterm /.test(t ?? '')) ?? null),
    xtermProbe: { paneId: read.term?.paneId ?? null, cols: read.term?.cols ?? null, rows: read.term?.rows ?? null },
    herdrFocused: snapshot.result?.snapshot?.focused_pane_id ?? null,
    herdrPanes: (snapshot.result?.snapshot?.layouts ?? []).flatMap((layout) => layout.panes.map((pane) => ({ tabId: layout.tab_id, paneId: pane.pane_id, width: pane.rect.width, height: pane.rect.height }))),
    herdrViewportRows: (snapshot.result?.snapshot?.panes ?? []).map((pane) => [pane.pane_id, pane.scroll?.viewport_rows ?? null]),
  }
  await shot('terminal')

  // ⓑ 팔레트
  await control({ cmd: 'key', keyCode: 'K', modifiers: ['meta'] })
  await until(async () => (await box('.palette-backdrop')) !== null, '팔레트', 5_000, 50)
  await pause(300)
  result.palette = { backdrop: await box('.palette-backdrop'), panel: await box('.palette-backdrop > *'), firstEntry: await box('.palette-entry') }
  await shot('palette')
  await control({ cmd: 'key', keyCode: 'Escape' })
  await pause(300)

  // ⓑ MRU — ⌃Tab 누름만 보내 홀드, 재고 Control 뗌으로 확정
  await click('[data-term-pane-box]')
  await control({ cmd: 'key', keyCode: 'Tab', modifiers: ['control'], type: 'keyDown' })
  await until(async () => (await box('.mru-switcher')) !== null, 'MRU', 5_000, 50).catch(() => null)
  await pause(200)
  result.mru = { switcher: await box('.mru-switcher') }
  await shot('mru')
  await control({ cmd: 'key', keyCode: 'Control', type: 'keyUp' })
  await pause(400)

  // ⓑ 탭 드롭존 — 탭을 눌러 터미널 가운데로 끌고(문턱 6px 넘김) 재고, 출발점으로 돌아와 놓는다(아무것도 안 바뀜)
  // 자기 영역 본문 가운데는 self-noop(강조 없음) — 그 영역 오른쪽 가장자리 띠(split)로 끈다
  const tab = await box('[data-main-tab]')
  const group = await cdp.evaluate(() => { const r = document.querySelector('[data-main-tab]').closest('.tab-group').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
  const pane = { x: group.x + group.w - 30, y: group.y + group.h / 2, w: 0, h: 0 }
  const start = { x: tab.x + 40, y: tab.y + tab.h / 2 }
  await mouse('mouseMoved', start)
  await mouse('mousePressed', start, { buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i += 1) { await mouse('mouseMoved', { x: start.x + ((pane.x - start.x) * i) / 10, y: start.y + ((pane.y - start.y) * i) / 10 }, { buttons: 1 }); await pause(30) }
  await pause(300)
  result.dropZone = { group, overlay: await box('[data-drop-zone-overlay]'), fill: await box('[data-dropzone-fill]'), ghost: await box('.tab-drag-ghost'), zones: await cdp.evaluate(() => [...document.querySelectorAll('[data-drop-zone-overlay] *')].slice(0, 6).map((e) => { const r = e.getBoundingClientRect(); return [e.className.toString().slice(0, 40), Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })) }
  await shot('dropzone')
  for (let i = 9; i >= 0; i -= 1) { await mouse('mouseMoved', { x: start.x + ((pane.x - start.x) * i) / 10, y: start.y + ((pane.y - start.y) * i) / 10 }, { buttons: 1 }); await pause(30) }
  await mouse('mouseReleased', start, { clickCount: 1 })
  await pause(400)

  // ⓑ 호버 카드 — worktree 카드 위에 머문다
  const card = await box('[data-worktree-title]')
  await mouse('mouseMoved', center(card))
  await until(async () => (await box('.hover-card')) !== null, '호버 카드', 5_000, 50).catch(() => null)
  await pause(300)
  result.hoverCard = { card, hover: await box('.hover-card') }
  await shot('hovercard')
  await mouse('mouseMoved', { x: 700, y: 500 })
  await pause(400)

  // ⓑ 대화상자 — 레포 추가
  await click('[data-add-repo]')
  await until(async () => (await box('[data-add-repo-modal]')) !== null, '레포 추가 모달', 5_000, 50)
  await pause(300)
  result.dialog = { scrim: await box('.modal-scrim'), modal: await box('[data-add-repo-modal]') }
  await shot('dialog')
  await control({ cmd: 'key', keyCode: 'Escape' })
  await pause(300)
  result.dialogClosed = (await box('[data-add-repo-modal]')) === null
  result.frameAfter = await frame()
} catch (error) {
  result.error = String(error?.stack ?? error)
}
fs.writeFileSync(path.join(outDir, `k6-${label}.json`), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result).slice(0, 3000))
process.exit(result.error ? 1 : 0)
