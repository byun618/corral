// LIFE-566 — 개발 실행의 제어 소켓에 한 줄 명령을 보내고 응답 JSON 을 찍는다.
// 사용: node ctl.mjs <ctl.sock> '<json>'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, json] = process.argv.slice(2)
const res = await rpc(sock, JSON.parse(json), 30_000)
console.log(JSON.stringify(res, null, 1))
