// LIFE-578 최종 관문 — 격리에서 실제 서버로 만들 수 없는 실패 응답을 내는 **가짜 서버**(픽스처). 중계(relay.mjs) 대상만 이 포트로 바꿔 쓴다.
// 사용: node fixture.mjs <포트> <protocol_mismatch|pair_rejected|device_limit> <이벤트 ndjson>
// 응답 모양은 실제 서버(src/main/mobile/server.ts reject·protocol 불일치)와 같다 — 첫 메시지에 error 를 보내고 그 닫힘 코드로 닫는다.
import fs from 'node:fs'
import { WebSocketServer } from 'ws'

const [port, mode, events] = process.argv.slice(2)
const CLOSE = { protocol_mismatch: 4002, pair_rejected: 4005, device_limit: 4005 }
const log = (value) => fs.appendFileSync(events, `${JSON.stringify({ at: Date.now(), ...value })}\n`)
const server = new WebSocketServer({ host: '127.0.0.1', port: Number(port), path: '/ws' })
server.on('connection', (ws, request) => {
  log({ event: 'conn', origin: request.headers.origin ?? null })
  ws.on('message', (data) => {
    let type = null
    try { type = JSON.parse(String(data)).type ?? null } catch { /* JSON 아님 — type null */ }
    log({ event: 'message', type })
    const reply = mode === 'protocol_mismatch'
      ? { type: 'error', code: 'protocol_mismatch', message: 'fixture', supported: [2] }
      : { type: 'error', code: mode, message: 'fixture' }
    ws.send(JSON.stringify(reply))
    ws.close(CLOSE[mode], mode)
    log({ event: 'reply', code: reply.code, close: CLOSE[mode] })
  })
})
server.on('listening', () => log({ event: 'listening', port: Number(port), mode }))
