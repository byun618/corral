// LIFE-511 fix1 R1-07 — pane 안에서 도는 **입력 경계 계측 + 안정 텍스트** 싱크. l497/byte-sink.mjs 를 넓혔다.
//   · 시작하면 안정 블록 `STABLE-<label>-NNN <토큰>` 을 `stable` 줄 찍는다(화면 행 수보다 많게 — 일부는 스크롤백으로 올라간다).
//     이 줄들은 끝까지 바뀌면 안 된다(전후 비교 대상).
//   · tick=1 이면 0.2초마다 `tick <label> N` 을 찍는다 — **출력 대역**(에이전트가 출력 중인 pane 대신, 킥오프 격리 3).
//   · stdin(raw)으로 온 바이트는 전부 out.ndjson 에 적는다 — 그 pane 의 PTY 가 실제로 받은 입력(입력 경계).
//     받으면 `got NB` 를 찍는다(검증 타이핑의 메아리).
//   · 0x18(Ctrl+X) 한 바이트 = 판별력 자기점검용 **텍스트 훼손**: 커서를 3줄 올려 그 줄을 지우고 `CORRUPTED` 를 쓴다.
//   · 0x1d(Ctrl+]) 한 바이트 = 끝.
// 사용: node pane-sink.mjs <out.ndjson> <label> <tick 0|1> [stable=60]
import fs from 'node:fs'
import crypto from 'node:crypto'

const [out, label, tickArg = '0', stableArg = '60'] = process.argv.slice(2)
const write = (row) => fs.appendFileSync(out, `${JSON.stringify({ at: Date.now(), label, ...row })}\n`)
if (!process.stdin.isTTY) throw new Error('stdin 이 TTY 가 아니다')
process.stdin.setRawMode(true)
const token = crypto.randomBytes(4).toString('hex')
const stable = Array.from({ length: Number(stableArg) }, (_, index) => `STABLE-${label}-${String(index + 1).padStart(3, '0')} ${token}`)
process.stdout.write(`${stable.join('\r\n')}\r\n`)
write({ event: 'start', pid: process.pid, token, stable: stable.length })
let tick = 0
const timer = tickArg === '1' ? setInterval(() => { tick += 1; process.stdout.write(`tick ${label} ${tick}\r\n`) }, 200) : null
process.stdin.on('data', (chunk) => {
  if (chunk.length === 1 && chunk[0] === 0x1d) {
    if (timer) clearInterval(timer)
    write({ event: 'end' })
    process.stdin.setRawMode(false)
    process.exit(0)
  }
  write({ event: 'data', hex: chunk.toString('hex'), text: chunk.toString('utf8') })
  if (chunk.length === 1 && chunk[0] === 0x18) {
    process.stdout.write('\x1b[3A\r\x1b[2KCORRUPTED\r\n\x1b[2B')
    return
  }
  process.stdout.write(`got ${chunk.length}B\r\n`)
})
