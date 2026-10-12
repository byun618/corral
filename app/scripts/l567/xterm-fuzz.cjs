// LIFE-567 탐색 — xterm 6.0.0 버퍼만으로(DOM 없이) frame-to-ansi 모양 프레임 + 무작위 resize 를 돌려 baseY≠0 이 생기는 첫 순서를 찍는다. 사용: node xterm-fuzz.cjs <seed> (app/ 에서)
const { Terminal } = require(process.cwd() + '/node_modules/@xterm/xterm/lib/xterm.js')
function frame(cols, rows, cy) {
  let out = '\x1b[0m\x1b[H\x1b[2J\x1b[?7l'
  for (let y = 0; y < rows; y++) { if (y > 0) out += `\x1b[${y + 1};1H`; out += (y % 3 === 0 ? '─' : 'x').repeat(cols) }
  out += '\x1b[?7h' + `\x1b[0m\x1b[${cy + 1};3H\x1b[0 q\x1b[?25h`
  return out
}
const w = (t, d) => new Promise(r => t.write(d, r))
function st(t) { const b = t.buffer.active; return { baseY: b.baseY, viewportY: b.viewportY, cursorY: b.cursorY, length: b.length, rows: t.rows, cols: t.cols } }
let seed = Number(process.argv[2] || 1)
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
;(async () => {
  for (let trial = 0; trial < 300; trial++) {
    const t = new Terminal({ scrollback: 0, cols: 80, rows: 24, allowProposedApi: true })
    let cols = 80, rows = 24, ops = []
    await w(t, frame(cols, rows, rows - 4))
    for (let step = 0; step < 8; step++) {
      const nc = Math.max(20, cols + Math.round((rnd() - 0.5) * 40)), nr = Math.max(5, rows + Math.round((rnd() - 0.5) * 10))
      const mode = rnd() < 0.5 ? 'resize-then-frame' : 'frame-then-resize'
      ops.push(`${cols}x${rows}->${nc}x${nr}`)
      t.resize(nc, nr); cols = nc; rows = nr
      const s0 = st(t)
      await w(t, frame(cols, rows, rows - 4))
      const s = st(t)
      if (s.baseY !== s.viewportY || s.baseY !== 0 || s0.baseY !== 0) { console.log(JSON.stringify({ trial, ops, afterResize: s0, afterFrame: s })); process.exit(0) }
    }
  }
  console.log('none')
})()
