// LIFE-502 K4 — l490/ctl.mjs 복사(l490→l502·L490→L502·worktree 이름만 sed 로 바꿈, 그 밖 변경은 아래 「L502 변경」 줄). 아래는 원 주석.
// LIFE-490 K8 — l485/ctl.mjs 복사(코드 줄의 l485→l502 만 바꿈, 주석 줄은 원문). 아래는 원 주석.
// LIFE-485 — 격리 corral 제어 소켓 요청 한 번. 사용: node ctl.mjs <ctl.sock> '<json>'
import { rpc } from '../gui-diff/lib/corral.mjs'
const [sock, json] = process.argv.slice(2)
const reply = await rpc(sock, JSON.parse(json), 30_000)
console.log(JSON.stringify(reply))
process.exit(reply.ok === false ? 1 : 0)
