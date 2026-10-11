// LIFE-567 탐색 — 열 1칸 축소 한 번으로 baseY 가 0→1 이 되는 조건(꽉 찬 줄 수 vs 커서 아래 행 수)을 고정 장면으로 확인한다. 사용: node xterm-min.cjs (app/ 에서)
const { Terminal } = require(process.cwd() + '/node_modules/@xterm/xterm/lib/xterm.js')
function frame(cols, rows, cy, fullRows) {
  let out = '\x1b[0m\x1b[H\x1b[2J\x1b[?7l'
  for (let y = 0; y < rows; y++) { if (y > 0) out += `\x1b[${y + 1};1H`; out += (fullRows.includes(y) ? '─'.repeat(cols) : 'ab') }
  return out + '\x1b[?7h' + `\x1b[0m\x1b[${cy + 1};3H\x1b[?25h`
}
const w = (t, d) => new Promise(r => t.write(d, r))
const st = (t) => { const b = t.buffer.active; return `baseY=${b.baseY} viewportY=${b.viewportY} cursorY=${b.cursorY} len=${b.length} ${t.cols}x${t.rows}` }
;(async () => {
  for (const [label, full, cy, nc, nr] of [
    ['cols-1 one full row, cursor mid', [10], 15, 79, 24],
    ['cols-1 full rows 0..23, cursor 20', [...Array(24).keys()], 20, 79, 24],
    ['cols-1 full last 4 rows, cursor 20', [20,21,22,23], 20, 79, 24],
    ['cols-1 full row 23 only, cursor 20', [23], 20, 79, 24],
    ['cols-1 full rows 20,21 cursor 22', [20,21], 22, 79, 24],
    ['cols-1 full row 22 cursor 23', [22], 23, 79, 24],
  ]) {
    const t = new Terminal({ scrollback: 0, cols: 80, rows: 24, allowProposedApi: true })
    await w(t, frame(80, 24, cy, full))
    t.resize(nc, nr)
    const a = st(t)
    await w(t, frame(nc, nr, cy, full))
    console.log(label, '| after resize:', a, '| after frame:', st(t))
  }
})()
