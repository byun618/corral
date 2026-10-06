// LIFE-526 fix1 R1-01 대조 — **앱 없이** 가짜 제어 소켓을 띄우고 native-footer.mjs 를 그 소켓에 돌린다(네이티브 관문 아님).
// 가짜 소켓은 네이티브 run1 원자료(native/run1/native-footer.json)의 덤프·hover·메뉴 값을 그대로 되돌려 준다 — DOM/computed/click 관측은 정상.
// 캡처(`shot`)만 모드대로 응답한다:
//   fail   → { ok: false }                      (음성 대조 — 기대: 다른 check 통과 · K4a-shots 실패 · exit 1)
//   nofile → { ok: true, file: <없는 경로> }    (음성 대조 — 기대: 같음)
//   ok     → { ok: true, file: <run1 PNG 사본> } (양성 대조 — 가짜가 전부 실패로만 떨어지지 않음을 본다, 기대: 전부 통과 · exit 0)
// 앱·herdr·사용자 프로필·OS 입력 무접촉. ROOT 는 /tmp/l526n-fake-<모드>.
// 사용(저장소 루트): node app/scripts/l526/native-footer-fakectl.mjs --mode fail|nofile|ok --out <raw 폴더>
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { childExit } from './child-exit.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const mode = args.mode
if (!['fail', 'nofile', 'ok'].includes(mode)) throw new Error('--mode fail|nofile|ok')
const out = path.resolve(args.out)
const here = path.dirname(new URL(import.meta.url).pathname)
const repo = path.resolve(here, '../../..')
const run1 = path.join(repo, 'specs/LIFE-526-footer-icons/raw/claude/native/run1')
const source = JSON.parse(fs.readFileSync(path.join(run1, 'native-footer.json'), 'utf8'))
const root = `/tmp/l526n-fake-${mode}`
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(path.join(root, 'shots'), { recursive: true })
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(root, 'app.pid'), '0')

const base = source.steps.default.dump
const keyOfSelector = Object.fromEntries(Object.entries(base.units).map(([key, unit]) => [unit.selector, key]))
const state = { hovered: null, helpOpen: false, settingsOpen: false }
const log = []
const inside = ({ x, y, box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
const dumpNow = () => {
  const units = {}
  for (const [key, unit] of Object.entries(base.units)) units[key] = state.hovered === key ? source.steps.hover[key].before : { ...unit, hovered: false }
  return { ...base, units }
}
const snapNow = () => ({
  settingsOpen: state.settingsOpen,
  helpMenu: state.helpOpen ? source.steps.help.opened.helpMenu : null,
  helpButton: source.steps.help.opened.helpButton,
  helpExpanded: state.helpOpen ? 'true' : 'false',
})
const respond = (request) => {
  switch (request.cmd) {
    case 'rect': {
      const key = keyOfSelector[request.selector]
      if (!key) return { ok: false }
      const box = base.units[key].box
      return { ok: true, rect: { left: box.x, top: box.y, width: box.w, height: box.h } }
    }
    case 'raw-mouse': {
      state.hovered = ['settings', 'help', 'reveal', 'refresh'].find((key) => inside({ x: request.x, y: request.y, box: base.units[key].box })) ?? null
      return { ok: true }
    }
    case 'click': {
      if (request.selector === '[data-help-menu-toggle]') state.helpOpen = !state.helpOpen
      else if (request.selector === '[data-settings-open]') state.settingsOpen = true
      else if (request.selector === '[data-settings-back]') state.settingsOpen = false
      else return { ok: false, error: 'fake: 모르는 선택자' }
      return { ok: true, selector: request.selector, method: 'fake' }
    }
    case 'eval':
      return { ok: true, result: request.code.includes('function dumpPage') ? dumpNow() : snapNow() }
    case 'shot': {
      if (mode === 'fail') return { ok: false, error: 'fake: 캡처 실패' }
      if (mode === 'nofile') return { ok: true, file: path.join(root, 'shots', `${request.name}-missing.png`) }
      const file = path.join(root, 'shots', `${request.name}.png`)
      fs.copyFileSync(path.join(run1, `${request.name}.png`), file)
      return { ok: true, file }
    }
    default:
      return { ok: false, error: `fake: 모르는 cmd ${request.cmd}` }
  }
}
const server = net.createServer((socket) => {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    if (!buffer.includes('\n')) return
    const request = JSON.parse(buffer.split('\n')[0])
    const reply = respond(request)
    log.push({ cmd: request.cmd, selector: request.selector ?? null, name: request.name ?? null, ok: reply.ok })
    socket.end(`${JSON.stringify(reply)}\n`)
  })
})
await new Promise((resolve) => server.listen(path.join(root, 'ctl.sock'), resolve))
// spawnSync 는 이 이벤트 루프를 막아 가짜 소켓이 응답하지 못한다 — 비동기 spawn 으로 돌리고 끝을 기다린다.
const child = await new Promise((resolve) => {
  const proc = spawn(process.execPath, [path.join(here, 'native-footer.mjs'), root, out], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  proc.stdout.on('data', (chunk) => { stdout += chunk })
  proc.stderr.on('data', (chunk) => { stdout += chunk })
  const timer = setTimeout(() => proc.kill('SIGTERM'), 120_000)
  proc.on('error', (error) => { clearTimeout(timer); resolve({ status: null, signal: null, stdout, error }) })
  proc.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, error: null }) })
})
server.close()
const judged = childExit({ run: child })
fs.writeFileSync(path.join(out, 'stdout.log'), `${child.stdout}\n${judged.note}\n`)
fs.writeFileSync(path.join(out, 'fake-control-log.json'), `${JSON.stringify({ mode, root, requests: log }, null, 1)}\n`)
console.log(child.stdout)
console.log(`[fakectl ${mode}] ${judged.note}`)
process.exit(judged.code)
