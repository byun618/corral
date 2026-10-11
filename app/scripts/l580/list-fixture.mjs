// LIFE-580 최종 관문 L5ⓗ — 실제 서버로는 만들 수 없는 「목록을 아직 못 받음」 을 내는 **가짜 서버**(픽스처). 중계(l578 relay.mjs) 대상만 이 포트로 바꿔 쓴다.
// hello 는 실제 서버와 같은 모양으로 받아 주고(토큰 검사 없음), list.subscribe 에는 모드대로 답한다:
//   silent  — 아무것도 보내지 않는다(앱의 구독 마감 → timeout 실패)
//   reject  — 옛 서버처럼 `unknown_type` 오류를 보낸다(앱 → 구독 거부)
// 사용: node list-fixture.mjs <포트> <silent|reject> <이벤트 ndjson>
import fs from 'node:fs'
import { WebSocketServer } from 'ws'

const [port, mode, events] = process.argv.slice(2)
if (!['silent', 'reject'].includes(mode) || !events) {
  console.error('사용: node list-fixture.mjs <포트> <silent|reject> <이벤트 ndjson>')
  process.exit(2)
}
const log = (value) => fs.appendFileSync(events, `${JSON.stringify({ at: Date.now(), ...value })}\n`)
const server = new WebSocketServer({ host: '127.0.0.1', port: Number(port), path: '/ws' })
server.on('connection', (ws, request) => {
  log({ event: 'conn', origin: request.headers.origin ?? null })
  ws.on('message', (data) => {
    let message = null
    try { message = JSON.parse(String(data)) } catch { /* JSON 아님 */ }
    const type = message?.type ?? null
    log({ event: 'message', type })
    if (type === 'hello') {
      ws.send(JSON.stringify({ type: 'hello', ok: true, protocol: 1, server: { app: 'corral', version: '0.1.2', macName: 'fixture-mac' }, device: { id: 'fixture-device', name: message?.client?.name ?? 'fixture' } }))
    } else if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', id: message.id, at: Date.now() }))
    } else if (type === 'list.subscribe' && mode === 'reject') {
      ws.send(JSON.stringify({ type: 'error', code: 'unknown_type', message: 'fixture' }))
      log({ event: 'reply', code: 'unknown_type' })
    }
  })
})
server.on('listening', () => log({ event: 'listening', port: Number(port), mode }))
