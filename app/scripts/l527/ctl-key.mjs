// LIFE-527 — 격리 corral 제어 소켓으로 키 하나(판정 입력 아님 — 상태 정리용: cliclick `kp:` 특수키가 앱에 닿지 않아서).
// 실행: node ctl-key.mjs <work> <keyCode> [modifier…]
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'
const [work, keyCode, ...modifiers] = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(path.join(work, 'os-state.json'), 'utf8'))
console.log(JSON.stringify(await rpc(state.corralControl, { cmd: 'key', keyCode, modifiers })))
process.exit(0)
