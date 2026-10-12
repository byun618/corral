// LIFE-594 K2 — 제어 소켓 한 번: node ev.mjs eval '<js>' | node ev.mjs shot <name> [selector] | node ev.mjs raw '<json>'
import { rpc } from '../gui-diff/lib/corral.mjs'
const SOCK = '/tmp/l594e/ctl.sock'
const [cmd, a, b] = process.argv.slice(2)
const req = cmd === 'eval' ? { cmd: 'eval', code: a } : cmd === 'shot' ? { cmd: 'shot', name: a, ...(b ? { selector: b } : {}) } : JSON.parse(a)
const res = await rpc(SOCK, req, 30_000)
console.log(JSON.stringify(res, null, 1))
process.exit(res.ok ? 0 : 1)
