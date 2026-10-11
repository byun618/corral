// LIFE-578 P7ⓐ — close 없는 비정상 단절 20회 뒤에도 새 연결이 인증되는가(상한 16 에 막히지 않음).
// 둘째 중계(relay.mjs, 자기 상태 파일)를 거쳐 hello 로 인증한 뒤 중계를 얼리고 클라이언트를 끊는다 — 서버는 close 도 FIN 도 못 본다(half-open).
// 20회 뒤 서버 포트로 직접 새 연결 → hello·pong. 토큰은 파일로만 받고 출력에는 찍지 않는다(macName 은 <mac>).
// 사용: node p7.mjs <중계 포트> <중계 상태 파일> <서버 포트> <토큰 파일> [회수=20]
import fs from 'node:fs'
import { WebSocket } from 'ws'

const [relayPort, relayState, serverPort, tokenFile, countArg] = process.argv.slice(2)
const count = Number(countArg ?? 20)
const token = fs.readFileSync(tokenFile, 'utf8').trim()
const out = (value) => console.log(JSON.stringify({ at: Date.now(), ...value }))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const setRelay = (frozen) => fs.writeFileSync(relayState, JSON.stringify({ target: Number(serverPort), frozen }))

function hello(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { handshakeTimeout: 5000 })
    const timer = setTimeout(() => resolve({ ws, ok: false, error: 'hello_timeout' }), 8000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, token, client: { name: 'p7', version: '1' } })))
    ws.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.type === 'hello') { clearTimeout(timer); resolve({ ws, ok: message.ok === true }) }
    })
    ws.on('error', (error) => { clearTimeout(timer); resolve({ ws, ok: false, error: String(error.message) }) })
  })
}

let failed = 0
for (let i = 1; i <= count; i += 1) {
  setRelay(false)
  await wait(300)
  const got = await hello(relayPort)
  setRelay(true)
  await wait(300)
  got.ws.terminate() // 클라이언트는 사라지고, 얼린 중계는 끊김을 서버로 전하지 않는다
  if (!got.ok) failed += 1
  out({ step: `abnormal-${i}`, pass: got.ok, error: got.error ?? null })
}
setRelay(false)
const fresh = await hello(serverPort)
fresh.ws.send(JSON.stringify({ type: 'ping', id: 'p7' }))
const pong = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 3000)
  fresh.ws.on('message', (data) => { const m = JSON.parse(String(data)); if (m.type === 'pong') { clearTimeout(timer); resolve(m) } })
})
const pass = fresh.ok && pong?.id === 'p7'
if (!pass) failed += 1
out({ step: 'fresh-after-abnormal', pass, hello: fresh.ok, pong: pong?.id ?? null })
fresh.ws.close()
await wait(300)
out({ summary: { abnormal: count, failed } })
process.exit(failed === 0 ? 0 : 1)
