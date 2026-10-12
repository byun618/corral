// LIFE-567 fix2 R2-01 — 리뷰어 codex-r2-raw/resize-confirm.js·resize-large-v2.js·resize-matrix.js 이식(같은 장면·같은 관측).
// 장면: c.cols×c.rows, 커서 0-based rows−4 행은 짧고 나머지 행은 폭을 꽉 채움. group>0 이면 group 칸마다 SGR 256색을 바꿔 DOM span 을 늘린다(렌더 비용).
//   축소 전 프레임(태그 'O', 소문자 a…) → writeFrame 으로 cols−1 새 프레임(태그 'N', 대문자 A…). 회차 사이 원래 크기로 되돌리고 clear 후 다시 그림.
// 모드: fix1 = 77ce3cbd8 의 term-resize(reflow 켜짐) + Terminal 기본 옵션 / fix2 = 현재 term-resize + 제품 옵션(windowsPty: NO_REFLOW_WINDOWS_PTY)
// 관측(사용자 화면 대표): **페인트 직전 DOM 행** — rAF 마다 더미 폭을 토글하고 ResizeObserver 콜백(그 프레임 rAF 들이 끝난 뒤·페인트 전)에서 .xterm-rows 텍스트를 읽는다.
//   분류: old(축소 전 프레임 그대로) · old-clipped(축소 전 프레임이 새 폭에서 잘린 것 — resize 직접 렌더가 낸다) · new(새 프레임) · other(그 밖 = 중간 화면).
//   공백 = 비어 있지 않은 행 ≤ 1. 판정: other 회차 0 · 공백 회차 0. old-clipped 는 허용(축소 직전 화면이 한 칸 잘려 보이는 것 — 결함 상태가 아님)이며 수를 따로 적는다.
//   onRender 표본도 같이 센다(파싱 전 것). resize 소요는 공개 term.resize 를 감싸 performance.now() 로만 잰다(리뷰어와 같음).
(async () => {
const MODE = __MODE__; const APP = __APP__; const SET = __SET__
const SETS = {
  confirm: [{ cols: 300, rows: 150, group: 1, n: 20 }],
  large: [{ cols: 220, rows: 90, group: 1, n: 20 }, { cols: 300, rows: 150, group: 1, n: 20 }, { cols: 300, rows: 150, group: 0, n: 20 }, { cols: 400, rows: 150, group: 1, n: 10 }],
  matrix: [{ cols: 80, rows: 24, group: 0, n: 40 }, { cols: 102, rows: 43, group: 4, n: 30 }, { cols: 160, rows: 75, group: 0, n: 30 }, { cols: 160, rows: 75, group: 8, n: 30 }, { cols: 160, rows: 75, group: 1, n: 20 }, { cols: 220, rows: 90, group: 8, n: 20 }],
  small80: [{ cols: 80, rows: 24, group: 0, n: 80 }],
}
const { Terminal } = require(APP + '/node_modules/@xterm/xterm/lib/xterm.js')
const lib = require(APP + '/scripts/l567/sync-fixture/' + (MODE === 'fix1' ? 'term-resize-fix1.cjs' : 'term-resize.cjs'))
const extra = MODE === 'fix1' ? {} : { windowsPty: lib.NO_REFLOW_WINDOWS_PTY }
if (MODE !== 'fix1' && !lib.NO_REFLOW_WINDOWS_PTY) throw Error('fix2 빌드에 NO_REFLOW_WINDOWS_PTY 없음')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
for (const c of SETS[SET]) {
  const term = new Terminal({ cols: c.cols, rows: c.rows, scrollback: 0, allowProposedApi: true, fontSize: 12, ...extra }); term.open(document.querySelector('#term'))
  const w = (s) => new Promise((r) => term.write(s, r))
  const row = (cols, y, tag) => y === c.rows - 4 ? tag.repeat(10) : String.fromCharCode((tag === 'O' ? 97 : 65) + y % 26).repeat(cols)
  const frame = (cols, tag) => '\x1b[0m\x1b[H\x1b[2J\x1b[?7l' + Array.from({ length: c.rows }, (_, y) => {
    const text = row(cols, y, tag); let s = `\x1b[${y + 1};1H`
    for (let x = 0; x < text.length; x++) { if (c.group && x % c.group === 0) s += `\x1b[38;5;${16 + ((x / c.group + y) % 200 | 0)}m`; s += text[x] }
    return s
  }).join('') + `\x1b[?7h\x1b[0m\x1b[${c.rows - 3};3H\x1b[?25h`
  const dom = () => [...term.element.querySelector('.xterm-rows').children].map((e) => e.textContent.trimEnd())
  let active = false, iteration = -1, parsed = false, resizeMs = 0, clears = 0; const events = []; const timings = []
  const resize = term.resize.bind(term); term.resize = (cols, rows) => { const start = performance.now(); resize(cols, rows); resizeMs = performance.now() - start }
  const clear = term.clear.bind(term); term.clear = () => { if (active) clears++; clear() }
  const sample = (type) => {
    if (!active) return
    const rows = dom()
    const kind = rows.every((x, y) => x === row(c.cols, y, 'O')) ? 'old'
      : rows.every((x, y) => x === row(c.cols, y, 'O').slice(0, c.cols - 1)) ? 'old-clipped'
      : rows.every((x, y) => x === row(c.cols - 1, y, 'N')) ? 'new' : 'other'
    events.push({ iteration, type, parsed, kind, sync: term.modes.synchronizedOutputMode, nonempty: rows.filter(Boolean).length, at: performance.now(), ...(kind === 'other' ? { rows: rows.map((x) => x.slice(0, 12)) } : {}) })
  }
  const sub = term.onRender(() => sample('render'))
  const dummy = document.createElement('div'); dummy.style.cssText = 'position:absolute;top:0;left:0;height:1px;width:1px'; document.body.appendChild(dummy)
  const ro = new ResizeObserver(() => sample('paint')); ro.observe(dummy); let ended = false, toggle = false
  const loop = () => { toggle = !toggle; dummy.style.width = toggle ? '1px' : '2px'; if (!ended) requestAnimationFrame(loop) }; requestAnimationFrame(loop)
  for (let i = 0; i < c.n; i++) {
    active = false; term.resize(c.cols, c.rows); term.clear(); await w(frame(c.cols, 'O')); await sleep(18 + i % 17)
    for (let wait = 0; !dom().every((x, y) => x === row(c.cols, y, 'O')); wait++) { if (wait >= 100) throw Error('setup failed ' + JSON.stringify({ c, i })); await sleep(10) }
    iteration = i; parsed = false; active = true
    await new Promise((done) => lib.writeFrame(term, { cols: c.cols - 1, rows: c.rows, data: frame(c.cols - 1, 'N'), alive: () => true, done: () => { parsed = true; done() } }))
    timings.push({ iteration, resizeMs, baseYAfter: term.buffer.active.baseY }); await sleep(25)
  }
  active = false; ended = true; ro.disconnect(); sub.dispose(); dummy.remove(); term.dispose(); document.querySelector('#term').replaceChildren()
  const paints = events.filter((e) => e.type === 'paint'), renders = events.filter((e) => e.type === 'render' && !e.parsed)
  const iters = (xs) => new Set(xs.map((x) => x.iteration)).size
  results.push({ config: c, summary: {
    clears, otherPaintIterations: iters(paints.filter((e) => e.kind === 'other')), blankPaintIterations: iters(paints.filter((e) => e.nonempty <= 1)),
    oldClippedPaintIterations: iters(paints.filter((e) => e.kind === 'old-clipped')), paintedIterations: iters(paints), newPaintIterations: iters(paints.filter((e) => e.kind === 'new')),
    otherRenderBeforeParsed: iters(renders.filter((e) => e.kind === 'other')), maxResizeMs: Math.max(...timings.map((x) => x.resizeMs)), baseYAfterNonzero: timings.filter((x) => x.baseYAfter !== 0).length,
  }, timings, events })
}
return { mode: MODE, set: SET, summary: results.map((x) => ({ config: x.config, ...x.summary })), results }
})()
