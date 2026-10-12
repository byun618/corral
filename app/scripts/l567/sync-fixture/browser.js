// LIFE-567 fix1 R1-01 — 리뷰어 browser.js 와 같은 장면(80×24, 커서 20행, 꽉 찬 줄 23개, 80→79 열 축소, 반복 80회).
// mode r1   = r1 제품 순서: resizeToFrame() 바로 다음 문장에서 term.write(frame)
// mode fix1 = fix1 제품 함수: writeFrame() (동기 출력 모드 안에서 resize·복구·프레임)
// mode base = 기준 commit 0f4adb6bc 순서: term.resize() 바로 다음 문장에서 term.write(frame) (복구 없음 — 참고용)
// 관측: ① onRender 때 DOM 행(리뷰어와 같은 지점, 파싱 완료 전 것만) ② **매 프레임 페인트 직전 DOM 행**(사용자에게 그려지는 것).
//   페인트 직전 = 그 프레임의 rAF 콜백(xterm 렌더 포함)이 다 끝난 뒤 — ResizeObserver 콜백이 그 자리에서 돈다(rAF 마다 더미 폭을 토글).
//   (try2 는 rAF 시작에 재서 xterm 렌더 rAF 보다 먼저 읽었다 — 페인트되지 않는 DOM 을 셌다.)
//   parsed 로 거르지 않고 probe 구간(축소 시작 ~ 파싱 뒤 19ms) 전체를 센다 — 이 구간에 정상 화면은
//   old(축소 전 프레임) 아니면 new(새 프레임) 뿐이다. other(그 밖 = 중간 화면)·공백(nonempty ≤ 1) 이 하나라도 있으면 그 회차는 중간 화면이 보인 것.
//   판정: blankRender·otherRender·blankPaint·otherPaint 회차 모두 0.
(async () => {
const MODE = __MODE__; const APP = __APP__
const { Terminal } = require(APP + '/node_modules/@xterm/xterm/lib/xterm.js')
const { resizeToFrame, writeFrame } = require(APP + '/scripts/l567/sync-fixture/term-resize.cjs')
const term = new Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true }); term.open(document.querySelector('#term'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), w = (s) => new Promise((r) => term.write(s, r))
const frame = (cols, tag = 'X') => '\x1b[0m\x1b[H\x1b[2J\x1b[?7l' + Array.from({ length: 24 }, (_, y) => `\x1b[${y + 1};1H` + (y === 20 ? tag.repeat(10) : String.fromCharCode(65 + y).repeat(cols))).join('') + '\x1b[?7h\x1b[0m\x1b[21;3H\x1b[?25h'
const domRows = () => [...term.element.querySelector('.xterm-rows').children].map((e) => e.textContent)
const state = () => ({ base: term.buffer.active.baseY, view: term.buffer.active.viewportY, cy: term.buffer.active.cursorY, rows: domRows(), at: performance.now() })
const same = (a, b) => a.length === b.length && a.every((x, i) => x.trimEnd() === b[i].trimEnd())
const result = { mode: MODE, pid: process.pid, renders: [], paints: [], attempts: 0, repairs: 0 }
let phase = 'idle', parsed = false, iteration = -1, oldRows = null, newRows = null
const listener = term.onRender(() => { if (phase === 'probe') { const s = state(); result.renders.push({ iteration, parsed, nonempty: s.rows.filter((x) => x.trim()).length, ...s }) } })
const dummy = document.createElement('div'); dummy.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px'; document.body.appendChild(dummy)
const ro = new ResizeObserver(() => { if (phase === 'probe') { const s = state(); result.paints.push({ iteration, parsed, nonempty: s.rows.filter((x) => x.trim()).length, ...s }) } })
ro.observe(dummy)
let toggle = false
const paintLoop = () => { toggle = !toggle; dummy.style.width = toggle ? '2px' : '1px'; if (phase !== 'done') requestAnimationFrame(paintLoop) }
requestAnimationFrame(paintLoop)
// 복구 발동(양성 대조) — 두 모드 모두 probe 중 clear() 호출 수를 센다(관측용 감싸기, 동작은 그대로)
const origClear = term.clear.bind(term); term.clear = () => { if (phase === 'probe') result.repairs++; origClear() }
// 새 프레임 기대 화면(79열)을 한 번 만들어 둔다
term.resize(79, 24); await w(frame(79)); await sleep(40); newRows = domRows(); term.clear()
for (let i = 0; i < 80; i++) {
  phase = 'idle'; term.resize(80, 24); await w(frame(80)); await sleep(18 + (i % 17)); oldRows = domRows()
  iteration = i; parsed = false; phase = 'probe'; result.attempts++
  await new Promise((resolve) => {
    const done = () => { parsed = true; resolve() }
    if (MODE === 'r1') { resizeToFrame(term, { cols: 79, rows: 24 }); term.write(frame(79), done) }
    else if (MODE === 'base') { term.resize(79, 24); term.write(frame(79), done) }
    else writeFrame(term, { cols: 79, rows: 24, data: frame(79), alive: () => true, done })
  })
  await sleep(19)
  const s = state(); if (s.base !== 0 || s.view !== 0) result.notRepaired = (result.notRepaired ?? 0) + 1
  for (const p of result.paints.filter((p) => p.iteration === i)) p.kind = same(p.rows, oldRows) ? 'old' : same(p.rows, newRows) ? 'new' : 'other'
  for (const r of result.renders.filter((r) => r.iteration === i)) r.kind = same(r.rows, oldRows) ? 'old' : same(r.rows, newRows) ? 'new' : 'other'
}
phase = 'done'; listener.dispose(); ro.disconnect()
const before = (xs) => xs.filter((x) => !x.parsed)
const iters = (xs) => new Set(xs.map((x) => x.iteration)).size
const blankRender = before(result.renders).filter((r) => r.nonempty <= 1), blankPaint = result.paints.filter((p) => p.nonempty <= 1)
const otherRender = before(result.renders).filter((r) => r.kind === 'other'), otherPaint = result.paints.filter((p) => p.kind === 'other')
result.summary = {
  attempts: result.attempts, repairs: result.repairs, notRepairedAfter: result.notRepaired ?? 0,
  rendersBeforeParsed: before(result.renders).length, blankRenderIterations: iters(blankRender), otherRenderIterations: iters(otherRender),
  paintsInProbe: result.paints.length, blankPaintIterations: iters(blankPaint), otherPaintIterations: iters(otherPaint), finalNewIterations: iters(result.paints.filter((p) => p.parsed && p.kind === 'new')),
}
result.firstBlank = blankRender[0] ?? blankPaint[0] ?? null; result.firstOther = otherRender[0] ?? otherPaint[0] ?? null
result.renders = result.renders.map(({ rows, ...r }) => r); result.paints = result.paints.map(({ rows, ...p }) => p)
term.dispose(); return result
})()
