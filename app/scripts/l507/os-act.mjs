// LIFE-507 — l527/os-act.mjs 복사 + **사용자 유휴 가드**(킥오프 격리 5): 활성화 전 HIDIdleTime ≥ --idle(기본 20초)까지 최대 --idle-wait 초 기다리고,
//   cliclick 을 부를 때마다 「마지막 사용자 입력 뒤 지난 시간 ≥ 우리 마지막 입력 뒤 지난 시간」 을 다시 본다(사이에 사용자가 만졌으면 놓고 거절 exit 3).
//   cgwin 은 /tmp/l507-cgwin(l507/cgwin.swift). 아래는 원 주석.
// LIFE-527 K5·K1 — cliclick 동작을 안전 확인 뒤에만 보낸다(사용자 실제 마우스·키보드를 움직인다).
//   1) 창 목록(화면 밖 포함)만 읽어 대상 창의 소유 앱을 번들 경로로 판정(os-owner.mjs — 설치본 Orca·허용 밖 앱이면 activate 도 하기 전에 거절, fix2 H3)
//   2) 대상 pid 앞으로(activate) 3) CoreGraphics 창 목록에서 대상 창 번호·소유 pid 확인
//   4) 명령을 **명시적으로 파싱**한다(fix1 F2). 지원 형식 밖이면 cliclick 을 한 번도 부르지 않고 거절
//   5) 모든 포인터 점(창 기준 `@x,y` · 화면 `x,y` · 상대 `+dx,-dy` · 현재 `.`)을 화면 좌표로 계산해
//      대상 창 bounds 안 + 그 점의 맨 위 일반 창(layer 0)이 대상 창인지 **실행 전에 전부** 확인(창이 안 움직인다고 가정)
//   6) 명령을 하나씩 보내고, 포인터 명령마다 창 목록을 다시 읽어 같은 확인을 한 번 더 한다(창을 끄는 drag 는 실제 bounds 로)
//   확인이 하나라도 어긋나면 exit 3. 거절 전에 눌린 수식 키(`kd:`)·버튼을 모두 놓는다 — 버튼은 마지막으로 확인된 점에서(`du:`).
// 실행: node os-act.mjs --pid <pid> --window <번호> --log <jsonl> --label <이름> [--window-drag] [--expect-frame x,y] -- <cliclick 명령…>
//   --window-drag   버튼을 누른 채 움직이는 점이 실행 전 bounds 밖으로 나가도 된다 — 창이 커서를 따라온다는 뜻이다.
//                   그 점은 「창이 그만큼 따라온」 예측 bounds 안이어야 하고, 보낸 뒤 창 목록을 다시 읽어 **실제로 따라왔는지**
//                   (점이 실제 bounds 안인지) 확인한다. 안 따라왔으면 마지막으로 확인된 점에서 놓고 거절.
//   --expect-frame  실행 전 창 원점이 이 값이어야 한다 — 앞 drag 가 창을 옮겼다고 보고 되돌리는 회차에 쓴다.
//   예: `m:@100,10` `dd:@300,10 w:60 m:+20,+15 du:+0,+0` `dc:@400,18` `kd:cmd t:= ku:cmd` `c:900,300`
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { ownerVerdict } from './os-owner.mjs'

const POINTER = new Set(['m', 'c', 'dc', 'tc', 'rc', 'dd', 'du', 'dm'])
const KEY = new Set(['kd', 'ku', 'kp', 't'])
const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
const opts = argv.slice(0, sep)
const commands = argv.slice(sep + 1)
const opt = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : null }
const pid = Number(opt('--pid'))
const windowNumber = Number(opt('--window'))
const logPath = opt('--log')
const label = opt('--label') ?? ''
const windowDrag = opts.includes('--window-drag')
const expectFrame = opt('--expect-frame')
const cgwin = (...args) => execFileSync('/tmp/l507-cgwin', args, { encoding: 'utf8' })
const sleep = (ms) => execFileSync('/bin/sleep', [String(ms / 1000)])

const idleNeed = Number(opt('--idle') ?? 20)
const idleWait = Number(opt('--idle-wait') ?? 600)
const record = { at: new Date().toISOString(), label, pid, windowNumber, commands, windowDrag, expectFrame, cliclickCalls: 0, steps: [], idle: [] }
const idleSeconds = () => JSON.parse(cgwin('idle')).seconds
let lastOurInput = null
const state = { held: false, cursor: null, keys: new Set() }
const log = () => { if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`) }
const fail = (reason) => {
  record.refused = reason
  // 거절 전에 눌린 것을 모두 놓는다 — 버튼은 마지막으로 확인된 점(창 안)에서, 수식 키는 `ku:`.
  if (state.held && state.cursor !== null) {
    execFileSync('/opt/homebrew/bin/cliclick', [`du:${screenArg(state.cursor)}`])
    record.cliclickCalls += 1
    record.releasedAt = state.cursor
  }
  if (state.keys.size > 0) {
    execFileSync('/opt/homebrew/bin/cliclick', [`ku:${[...state.keys].join(',')}`])
    record.cliclickCalls += 1
    record.releasedKeys = [...state.keys]
  }
  log()
  console.error(`[os-act] 거절: ${reason}`)
  process.exit(3)
}

// ── 파싱 — 지원 형식만 받는다
const AXIS = /^(?:[+-]?\d+(?:\.\d+)?|=-?\d+(?:\.\d+)?)$/
function parse(command) {
  const at = command.indexOf(':')
  const name = at > 0 ? command.slice(0, at) : command
  const arg = at > 0 ? command.slice(at + 1) : ''
  if (name === 'w') {
    if (!/^\d+$/.test(arg)) fail(`검사할 수 없는 형식 ${command}`)
    return { kind: 'wait', command, ms: Number(arg) }
  }
  if (KEY.has(name)) {
    if (arg === '') fail(`검사할 수 없는 형식 ${command}`)
    return { kind: 'key', command }
  }
  if (!POINTER.has(name)) fail(`지원하지 않는 명령 ${command}`)
  if (arg === '.') return { kind: 'pointer', command, name, form: 'current' }
  if (arg.startsWith('@')) {
    const m = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(arg)
    if (!m) fail(`검사할 수 없는 형식 ${command}`)
    return { kind: 'pointer', command, name, form: 'window', x: Number(m[1]), y: Number(m[2]) }
  }
  const parts = arg.split(',')
  if (parts.length !== 2 || !parts.every((part) => AXIS.test(part))) fail(`검사할 수 없는 형식 ${command}`)
  // 축마다: `+N`·`-N` = 현재 커서 기준 상대, `N`·`=N` = 화면 절대(cliclick 규칙)
  const axis = (part) => (part.startsWith('+') || part.startsWith('-') ? { relative: Number(part) } : { absolute: Number(part.replace('=', '')) })
  return { kind: 'pointer', command, name, form: 'screen', x: axis(parts[0]), y: axis(parts[1]) }
}

const screenArg = (point) => `${point.x < 0 ? '=' : ''}${point.x},${point.y < 0 ? '=' : ''}${point.y}`
const inside = (point, b) => point.x >= b.x && point.x < b.x + b.w && point.y >= b.y && point.y < b.y + b.h

/** 포인터 명령 → 화면 좌표(정수). 상대·현재는 추적 중인 커서 기준. */
function resolve(step, bounds, cursor) {
  if (step.form === 'current') return cursor
  if (step.form === 'window') return { x: Math.round(bounds.x + step.x), y: Math.round(bounds.y + step.y) }
  const coord = (axis, base) => Math.round('relative' in axis ? base + axis.relative : axis.absolute)
  return { x: coord(step.x, cursor.x), y: coord(step.y, cursor.y) }
}

/** 점이 대상 창 안이고 그 점의 맨 위 일반 창이 대상인가. 실패 사유 또는 null. */
function check(point, windows) {
  const target = windows.find((w) => w.number === windowNumber)
  if (!target) return '대상 창 번호가 목록에 없다'
  if (target.pid !== pid) return `창 소유 pid 불일치 ${target.pid}`
  if (!inside(point, target.bounds)) return `창 밖 좌표 ${point.x},${point.y} — bounds ${JSON.stringify(target.bounds)}`
  const normal = windows.filter((w) => w.layer === 0)
  if (normal[0]?.number !== windowNumber) return `맨 앞 일반 창이 대상이 아니다 — ${normal[0]?.owner} #${normal[0]?.number}`
  const top = normal.find((w) => inside(point, w.bounds))
  if (top?.number !== windowNumber) return `점 ${point.x},${point.y} 의 맨 위 창이 대상이 아니다 — ${top?.owner}`
  // 그 점의 소유 창의 앱도 번들 경로로 다시 본다(fix2 H3).
  const owner = ownerVerdict(top)
  if (owner !== null) return `점 ${point.x},${point.y} — ${owner}`
  return null
}

/** 유휴 가드 — 우리 입력 사이에 사용자 입력이 끼었으면 거절. 처음이면 idleNeed 초 이상 유휴여야 한다. */
function idleGuard(at) {
  const idle = idleSeconds()
  const need = lastOurInput === null ? idleNeed : (Date.now() - lastOurInput) / 1000 - 0.25
  record.idle.push({ at, idle: Math.round(idle * 100) / 100, need: Math.round(need * 100) / 100 })
  if (idle < need) fail(`유휴 가드: ${at} — 사용자 입력 감지(유휴 ${idle.toFixed(2)}초 < ${need.toFixed(2)}초)`)
}
function cliclick(arg) {
  idleGuard(arg)
  execFileSync('/opt/homebrew/bin/cliclick', [arg])
  lastOurInput = Date.now()
  record.cliclickCalls += 1
}

const steps = commands.map(parse)
// 활성화 전 유휴 대기 — 사용자가 쓰는 중이면 기다린다. 넘기면 아무 입력 없이 거절.
{
  const deadline = Date.now() + idleWait * 1000
  let idle = idleSeconds()
  while (idle < idleNeed && Date.now() < deadline) { sleep(Math.min(5000, Math.max(500, (idleNeed - idle) * 1000))); idle = idleSeconds() }
  record.idleBeforeActivate = Math.round(idle * 100) / 100
  if (idle < idleNeed) fail(`유휴 가드: ${idleWait}초 안에 ${idleNeed}초 유휴가 오지 않았다(마지막 ${idle.toFixed(2)}초) — 입력하지 않는다`)
}
// 활성화(앞으로 가져오기)도 입력이다 — 화면 밖 창까지 읽어 소유자를 먼저 판정한다.
{
  const all = JSON.parse(cgwin('list-all'))
  const candidate = all.find((w) => w.number === windowNumber)
  if (!candidate) fail('대상 창 번호가 목록에 없다')
  if (candidate.pid !== pid) fail(`창 소유 pid 불일치 ${candidate.pid}`)
  const owner = ownerVerdict(candidate)
  if (owner !== null) fail(`소유자 가드: ${owner}`)
  record.ownerBundle = candidate.bundle
}
cgwin('activate', String(pid))
sleep(400)
let windows = JSON.parse(cgwin('list'))
const target = windows.find((w) => w.number === windowNumber)
if (!target) fail('대상 창 번호가 목록에 없다')
if (target.pid !== pid) fail(`창 소유 pid 불일치 ${target.pid}`)
record.bounds = target.bounds
const normal0 = windows.filter((w) => w.layer === 0)
const pointing = steps.some((step) => step.kind === 'pointer')
// 좌표 없는 키 입력은 맨 앞 앱이 대상 pid 면 된다(전체화면에선 같은 pid 의 위 막대 창이 맨 앞에 온다). 포인터가 있으면 창 번호까지.
if (pointing ? normal0[0]?.number !== windowNumber : normal0[0]?.pid !== pid) fail(`맨 앞 일반 창이 대상이 아니다 — ${normal0[0]?.owner} #${normal0[0]?.number}`)
if (expectFrame !== null) {
  const [ex, ey] = expectFrame.split(',').map(Number)
  if (target.bounds.x !== ex || target.bounds.y !== ey) fail(`창 원점 ${target.bounds.x},${target.bounds.y} ≠ 기대 ${ex},${ey} — 앞 drag 가 창을 옮기지 않았다`)
}

// ── 실행 전 정적 확인 — 창이 안 움직인다고 보고 모든 점을 계산·검사한다
{
  let cursor = JSON.parse(cgwin('mouse'))
  let held = false
  for (const step of steps) {
    if (step.kind !== 'pointer') continue
    const point = resolve(step, target.bounds, cursor)
    const reason = check(point, windows)
    // --window-drag 면 누른 채 움직이는 점은 정적 확인에서 bounds 밖이어도 된다(실행 때 실제 bounds 로 다시 본다).
    const draggingMove = held && (step.name === 'm' || step.name === 'dm' || step.name === 'du')
    if (reason !== null && !(windowDrag && draggingMove && reason.startsWith('창 밖'))) fail(`실행 전 확인: ${step.command} → ${reason}`)
    cursor = point
    if (step.name === 'dd') held = true
    if (step.name === 'du') held = false
  }
}

// ── 실행 — 하나씩, 포인터마다 창 목록을 다시 읽어 실제 bounds 로 확인
state.cursor = JSON.parse(cgwin('mouse'))
for (const step of steps) {
  if (step.kind === 'wait') { sleep(step.ms); continue }
  if (step.kind === 'key') {
    cliclick(step.command)
    const [name, arg] = [step.command.slice(0, 2), step.command.slice(3)]
    if (name === 'kd') for (const key of arg.split(',')) state.keys.add(key)
    if (name === 'ku') for (const key of arg.split(',')) state.keys.delete(key)
    record.steps.push({ command: step.command })
    sleep(60)
    continue
  }
  windows = JSON.parse(cgwin('list'))
  const bounds = windows.find((w) => w.number === windowNumber)?.bounds ?? null
  if (bounds === null) fail('대상 창 번호가 목록에 없다')
  const point = resolve(step, bounds, state.cursor)
  const draggingMove = windowDrag && state.held && (step.name === 'm' || step.name === 'dm' || step.name === 'du')
  if (draggingMove) {
    // 창이 커서를 따라온다면 창은 (점 − 지금 커서) 만큼 옮겨 간다 — 그 예측 bounds 안이어야 한다(창 안에서 잡은 자리를 벗어나지 않는다).
    const predicted = { ...bounds, x: bounds.x + point.x - state.cursor.x, y: bounds.y + point.y - state.cursor.y }
    if (!inside(point, predicted)) fail(`실행 중 확인: ${step.command} → 예측 bounds 밖 ${point.x},${point.y}`)
  } else {
    const reason = check(point, windows)
    if (reason !== null) fail(`실행 중 확인: ${step.command} → ${reason}`)
  }
  cliclick(`${step.name}:${screenArg(point)}`)
  const entry = { command: step.command, screen: point, bounds }
  record.steps.push(entry)
  if (draggingMove) {
    // 창 서버가 창을 옮기는 데 한 박자 걸린다 — 50ms 간격으로 최대 600ms 기다린다.
    let after = null
    for (let i = 0; i < 12; i += 1) {
      sleep(50)
      after = JSON.parse(cgwin('list')).find((w) => w.number === windowNumber)?.bounds ?? null
      if (after !== null && inside(point, after)) break
    }
    entry.boundsAfter = after
    if (after === null || !inside(point, after)) fail(`실행 뒤 확인: ${step.command} → 창이 커서를 따라오지 않았다 — bounds ${JSON.stringify(after)}`)
  }
  state.cursor = point
  if (step.name === 'dd') state.held = true
  if (step.name === 'du') state.held = false
  sleep(60)
}
record.screenCommands = record.steps.map((step) => (step.screen ? `${step.command.split(':')[0]}:${screenArg(step.screen)}` : step.command))
record.mouseAfter = JSON.parse(cgwin('mouse'))
record.boundsAfter = JSON.parse(cgwin('list')).find((w) => w.number === windowNumber)?.bounds ?? null
log()
console.log(JSON.stringify({ label, screenCommands: record.screenCommands, mouseAfter: record.mouseAfter, boundsBefore: record.bounds, boundsAfter: record.boundsAfter, cliclickCalls: record.cliclickCalls }))
