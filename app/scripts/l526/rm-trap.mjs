// LIFE-526 fix5 대조용 사전 로드(node --import) — fs.rmSync 를 **기록만 하고 막는다**(실제로 지우지 않고 오류). mkdirSync 는 기록 뒤 그대로 한다.
// 기록은 L526_TRAP_LOG(JSON 줄). iso-smoke 를 실제로 띄워 인자 처리·가드·삭제 순서를 보되 /tmp/l526* 를 지우지 않게 한다.
import fs from 'node:fs'

const log = process.env.L526_TRAP_LOG
if (!log) throw new Error('L526_TRAP_LOG 필요')
const record = ({ op, target }) => fs.appendFileSync(log, `${JSON.stringify({ op, target: String(target) })}\n`)
const mkdirSync = fs.mkdirSync
fs.rmSync = (target) => {
  record({ op: 'rmSync', target })
  throw new Error(`rm-trap — 지우지 않음: ${target}`)
}
fs.mkdirSync = (target, options) => {
  record({ op: 'mkdirSync', target })
  return mkdirSync(target, options)
}
