// LIFE-497 — pane 안에서 도는 **PTY 바이트 싱크**. 터미널을 raw 로 두고 stdin 으로 온 바이트를 그대로 적는다.
// pane 으로 실제로 간 바이트(= herdr PTY 가 받은 것)를 재는 유일한 관측점이다 — 렌더러·main 로그가 아니다.
// 사용: node byte-sink.mjs <out.ndjson> [bracketed=1|0]
//   bracketed=1 이면 `ESC[?2004h` 로 bracketed paste 모드를 켠다(에이전트 TUI 와 같은 조건), 0 이면 끈 채로 둔다.
//   0x1d(Ctrl+]) 한 바이트를 받으면 끝낸다. 시작·끝 줄을 기록한다.
import fs from 'node:fs'

const [out, bracketed = '1'] = process.argv.slice(2)
const write = (row) => fs.appendFileSync(out, `${JSON.stringify({ at: Date.now(), ...row })}\n`)
if (!process.stdin.isTTY) throw new Error('stdin 이 TTY 가 아니다')
process.stdin.setRawMode(true)
if (bracketed === '1') process.stdout.write('\x1b[?2004h')
process.stdout.write(`SINK READY pid=${process.pid} bracketed=${bracketed}\r\n`)
write({ event: 'start', pid: process.pid, bracketed: bracketed === '1' })
process.stdin.on('data', (chunk) => {
  if (chunk.length === 1 && chunk[0] === 0x1d) {
    write({ event: 'end' })
    if (bracketed === '1') process.stdout.write('\x1b[?2004l')
    process.stdin.setRawMode(false)
    process.exit(0)
  }
  write({ event: 'data', hex: chunk.toString('hex'), text: chunk.toString('utf8') })
  process.stdout.write(`got ${chunk.length}B\r\n`)
})
