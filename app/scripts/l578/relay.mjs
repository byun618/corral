// LIFE-578 최종 관문 격리 회차 — 에뮬레이터(10.0.2.2:<고정 포트>)와 개발 Electron 모바일 서버(127.0.0.1:<바뀌는 포트>) 사이의 TCP 중계.
// 서버 재기동으로 포트가 바뀌어도 앱 쪽 개발 endpoint 를 고정하고, `frozen` 이면 열린 연결의 바이트를 버린다(close 없음 = half-open).
// 제어는 상태 파일 하나(200ms 마다 다시 읽는다): {"target": <서버 포트>, "frozen": false}. 서버 노출 규칙은 그대로 — 중계는 127.0.0.1 에만 묶는다.
// 사용: node relay.mjs <듣는 포트> <상태 파일> <이벤트 기록 ndjson>
import fs from 'node:fs'
import net from 'node:net'

const [listenPort, stateFile, logFile] = [Number(process.argv[2]), process.argv[3], process.argv[4]]
let state = { target: 0, frozen: false }
const log = (event, detail = {}) => fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), event, ...detail }) + '\n')
const readState = () => {
  try {
    const next = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (next.target !== state.target || next.frozen !== state.frozen) log('state', next)
    state = next
  } catch {
    // 쓰는 중 — 다음 회
  }
}
readState()
setInterval(readState, 200)
let seq = 0
const server = net.createServer((client) => {
  seq += 1
  const id = seq
  const upstream = net.connect(state.target, '127.0.0.1')
  log('conn', { id, target: state.target, frozen: state.frozen })
  client.on('data', (chunk) => { if (!state.frozen) upstream.write(chunk) })
  upstream.on('data', (chunk) => { if (!state.frozen) client.write(chunk) })
  const end = (side) => () => {
    if (state.frozen) return log('end_ignored_frozen', { id, side }) // 블랙홀: 끊김도 전달하지 않는다
    log('end', { id, side })
    client.destroy()
    upstream.destroy()
  }
  client.on('close', end('client'))
  upstream.on('close', end('upstream'))
  client.on('error', () => {})
  upstream.on('error', () => {})
})
server.listen(listenPort, '127.0.0.1', () => log('listen', { port: listenPort, pid: process.pid }))
