// LIFE-527 K9 — 네이티브 corral(CDP 없음) 제어 소켓 `eval` 로 식 하나를 평가해 JSON 으로 찍는다(관측 전용).
// 실행: node nev.mjs <ctl.sock> '<식>'   — os-eval.mjs 와 같은 꼴: `(async () => (<식>))()`
import { rpc } from '../gui-diff/lib/corral.mjs'
const [sock, expression] = process.argv.slice(2)
const reply = await rpc(sock, { cmd: 'eval', code: `(async () => (${expression}))()` })
if (!reply.ok) throw new Error(JSON.stringify(reply))
console.log(JSON.stringify(reply.result))
process.exit(0)
