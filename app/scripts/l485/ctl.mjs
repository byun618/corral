// LIFE-485 — 격리 corral 제어 소켓 요청 한 번. 사용: node ctl.mjs <ctl.sock> '<json>'
import { rpc } from '../gui-diff/lib/corral.mjs'
const [sock, json] = process.argv.slice(2)
const reply = await rpc(sock, JSON.parse(json), 30_000)
console.log(JSON.stringify(reply))
process.exit(reply.ok === false ? 1 : 0)
