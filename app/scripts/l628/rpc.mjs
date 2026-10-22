// LIFE-628 최종 관문 — herdr 소켓에 요청 한 줄을 보내고 응답 한 줄을 받는다(격리 서버 전용).
//   node rpc.mjs <sock> <method> [params JSON]
import net from 'node:net'
const [sock, method, params = '{}'] = process.argv.slice(2)
const socket = net.createConnection(sock)
let buffer = ''
const timer = setTimeout(() => { console.log(JSON.stringify({ error: { code: 'timeout' } })); process.exit(3) }, 15000)
socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'l628', method, params: JSON.parse(params) })}\n`))
socket.on('data', (chunk) => {
  buffer += chunk.toString()
  const line = buffer.split('\n').find((item) => item.trim().length > 0 && item.includes('"l628"'))
  if (line === undefined) return
  clearTimeout(timer)
  console.log(line)
  socket.end()
  process.exit(JSON.parse(line).error ? 1 : 0)
})
socket.on('error', (error) => { console.log(JSON.stringify({ error: { code: 'socket', message: String(error) } })); process.exit(2) })
