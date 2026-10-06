// LIFE-527 K5·K1 — cliclick 한 동작을 안전 확인 뒤에만 보낸다(사용자 실제 마우스·키보드를 움직인다).
//   1) 대상 pid 앞으로(activate) 2) CoreGraphics 창 목록에서 대상 창 번호·소유 pid 확인
//   3) 모든 좌표가 대상 창 bounds 안 + 그 점의 맨 위 일반 창(layer 0)이 대상 창 4) 설치본 Orca pid 면 거절
//   좌표는 창 기준(hiddenInset 이라 창 위 = 콘텐츠 위). 확인이 하나라도 어긋나면 보내지 않고 exit 3.
// 실행: node os-act.mjs --pid <pid> --window <번호> --log <jsonl> --label <이름> -- <cliclick 명령…>
//   cliclick 명령 안의 좌표는 `@x,y`(창 기준)로 쓰면 화면 좌표로 바꾼다. 예: `m:@100,10` `dd:@300,10` `du:@500,10` `dc:@400,18` `kd:cmd t:= ku:cmd`
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const FORBIDDEN_PIDS = new Set([25085]) // 설치본 Orca — 입력 금지
const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
const opts = argv.slice(0, sep)
const commands = argv.slice(sep + 1)
const opt = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : null }
const pid = Number(opt('--pid'))
const windowNumber = Number(opt('--window'))
const logPath = opt('--log')
const label = opt('--label') ?? ''
const cgwin = (...args) => execFileSync('/tmp/l527-cgwin', args, { encoding: 'utf8' })

const record = { at: new Date().toISOString(), label, pid, windowNumber, commands }
const fail = (reason) => {
  record.refused = reason
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`)
  console.error(`[os-act] 거절: ${reason}`)
  process.exit(3)
}
if (FORBIDDEN_PIDS.has(pid)) fail('설치본 Orca pid')
cgwin('activate', String(pid))
execFileSync('/bin/sleep', ['0.4'])
const windows = JSON.parse(cgwin('list'))
const target = windows.find((w) => w.number === windowNumber)
if (!target) fail('대상 창 번호가 목록에 없다')
if (target.pid !== pid) fail(`창 소유 pid 불일치 ${target.pid}`)
if (FORBIDDEN_PIDS.has(target.pid)) fail('설치본 Orca 창')
const normal = windows.filter((w) => w.layer === 0)
// 좌표 없는 키 입력은 맨 앞 앱이 대상 pid 면 된다(전체화면에선 같은 pid 의 위 막대 창이 맨 앞에 온다). 좌표가 있으면 창 번호까지.
const pointing = commands.some((command) => command.includes('@'))
if (pointing ? normal[0]?.number !== windowNumber : normal[0]?.pid !== pid) fail(`맨 앞 일반 창이 대상이 아니다 — ${normal[0]?.owner} #${normal[0]?.number}`)
const b = target.bounds
record.bounds = b
const toScreen = (text) => text.replace(/@(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => {
  const sx = Math.round(b.x + Number(x)), sy = Math.round(b.y + Number(y))
  if (!(Number(x) >= 0 && Number(x) < b.w && Number(y) >= 0 && Number(y) < b.h)) fail(`창 밖 좌표 ${x},${y}`)
  const top = normal.find((w) => sx >= w.bounds.x && sx < w.bounds.x + w.bounds.w && sy >= w.bounds.y && sy < w.bounds.y + w.bounds.h)
  if (top?.number !== windowNumber) fail(`점 ${sx},${sy} 의 맨 위 창이 대상이 아니다 — ${top?.owner}`)
  return `${sx},${sy}`
})
const screenCommands = commands.map(toScreen)
record.screenCommands = screenCommands
execFileSync('/opt/homebrew/bin/cliclick', ['-w', '60', ...screenCommands])
record.mouseAfter = JSON.parse(cgwin('mouse'))
record.boundsAfter = JSON.parse(cgwin('list')).find((w) => w.number === windowNumber)?.bounds ?? null
if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`)
console.log(JSON.stringify({ label, screenCommands, mouseAfter: record.mouseAfter, boundsBefore: b, boundsAfter: record.boundsAfter }))
