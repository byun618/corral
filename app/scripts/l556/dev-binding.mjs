// LIFE-556 B6 빠른 관문 — 개발 경로 회귀. 명시 바인딩(`CORRAL_BACKEND_SOCKET`·`CORRAL_SESSION`)으로 띄운 개발 실행이
// 종전대로 그 backend 를 쓰는가. 동봉 바인딩(설치본 전용)이 개발 실행에 끼어들지 않는지 본다.
//
// 격리: 모든 것을 /tmp/l556-dev-* 하나에 둔다 — herdr 의 HOME·XDG, userData, 런타임·control 소켓. 사용자 HOME·brew herdr 무접촉.
// 띄운 프로세스(guard backend · headless 런타임 · 개발 GUI)는 이 스크립트가 PID 를 기록하고 끝에서 끈다.
// 인자: <debug guard herdr> <원자료 디렉터리>
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'

const [backend, rawDir] = process.argv.slice(2)
assert(backend && fs.existsSync(backend), 'debug guard herdr 경로가 필요하다')
assert(rawDir, '원자료 디렉터리가 필요하다')
const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const root = fs.realpathSync(fs.mkdtempSync('/tmp/l556-dev-')).replace(/^\/private\/tmp\//, '/tmp/')
const home = path.join(root, 'h'), repo = path.join(root, 'repo')
for (const dir of [home, repo]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const session = 'l556dev'
const socket = path.join(home, 'herdr-dev/sessions', session, 'herdr.sock')
const config = path.join(home, 'herdr.toml')
fs.writeFileSync(config, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
fs.mkdirSync(rawDir, { recursive: true })
const scrub = (text) => String(text).replaceAll(root, '<root>').replaceAll(process.env.HOME ?? '\0', '~')
const base = {
  PATH: process.env.PATH, HOME: home, TMPDIR: root, SHELL: '/bin/sh', LANG: 'en_US.UTF-8',
  XDG_CONFIG_HOME: home, HERDR_CONFIG_PATH: config, HERDR_SESSION: session, HERDR_SOCKET_PATH: socket,
  CORRAL_BACKEND_SOCKET: socket, CORRAL_SESSION: session, CORRAL_REGISTRY: path.join(root, 'repos.json'),
}
const children = []
const record = { root: '<root>', session, steps: [], processes: [] }
function start(name, exe, args, env) {
  const fd = fs.openSync(path.join(root, `${name}.log`), 'w')
  const child = spawn(exe, args, { env, stdio: ['ignore', fd, fd], detached: true })
  fs.closeSync(fd)
  children.push({ name, child })
  record.processes.push({ name, pid: child.pid })
  return child
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rpc = (file, body) => new Promise((resolve, reject) => {
  const s = net.createConnection(file); let buf = ''
  const timer = setTimeout(() => { s.destroy(); reject(Error('rpc timeout')) }, 5000)
  s.on('error', (e) => { clearTimeout(timer); reject(e) })
  s.on('connect', () => s.write(JSON.stringify(body) + '\n'))
  s.setEncoding('utf8'); s.on('data', (b) => { buf += b; if (buf.includes('\n')) { clearTimeout(timer); s.destroy(); resolve(JSON.parse(buf.split('\n')[0])) } })
})
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms; let last
  while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch (e) { last = e } await pause(150) }
  throw Error(`${label} timeout (${last ?? 'no error'})`)
}
function cli(env, args, expectOk = true) {
  const result = spawnSync(process.execPath, [path.join(app, 'cli/corral.mjs'), ...args, '--json'], { env, cwd: repo, encoding: 'utf8', timeout: 30000 })
  let body = null
  try { body = JSON.parse(result.stdout) } catch { /* 원문을 남긴다 */ }
  record.steps.push({ args, exit: result.status, body: body === null ? scrub(result.stdout + result.stderr) : JSON.parse(scrub(JSON.stringify(body))) })
  if (expectOk) assert.equal(result.status, 0, `${args.join(' ')} → ${scrub(result.stdout + result.stderr).slice(0, 400)}`)
  return body
}
let failed = null
try {
  spawnSync('git', ['init', '-q', repo]); spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: { ...base, GIT_AUTHOR_NAME: 'l556', GIT_AUTHOR_EMAIL: 'l556@example.invalid', GIT_COMMITTER_NAME: 'l556', GIT_COMMITTER_EMAIL: 'l556@example.invalid' } })
  start('backend', backend, ['--session', session, 'server'], base)
  await until(() => fs.existsSync(socket), 'guard backend socket')

  // ① headless 런타임 — 명시 바인딩 그대로.
  const headless = { ...base, CORRAL_USER_DATA: path.join(root, 'u-headless') }
  fs.mkdirSync(headless.CORRAL_USER_DATA, { mode: 0o700 })
  start('serve', process.execPath, [path.join(app, 'cli/corral.mjs'), 'serve', '--json'], headless)
  await until(() => fs.existsSync(path.join(headless.CORRAL_USER_DATA, 'runtime/rpc.sock')), 'headless runtime')
  const status = cli(headless, ['status'])
  assert.equal(status.result.backend.ownership, 'external')
  assert.equal(status.result.backend.session, session)
  cli(headless, ['repo', 'add', '--path', repo])
  const made = cli(headless, ['terminal', 'create', '--worktree', repo, '--title', 'l556-dev', '--command', 'sh'])
  const handle = made.result.terminal.handle
  cli(headless, ['terminal', 'send', '--terminal', handle, '--text', 'echo l556-dev-ok', '--enter'])
  await until(() => JSON.stringify(cli(headless, ['terminal', 'read', '--terminal', handle])).includes('l556-dev-ok'), 'read echo')
  cli(headless, ['orchestration', 'run-create', '--objective', 'LIFE-556 dev binding'])
  cli(headless, ['orchestration', 'task-create', '--spec', 'dev path regression'])
  cli(headless, ['orchestration', 'check'])
  cli(headless, ['terminal', 'close', '--terminal', handle])
  const profile = JSON.parse(fs.readFileSync(path.join(headless.CORRAL_USER_DATA, 'runtime/profile.json'), 'utf8'))
  assert.deepEqual(profile.backend, { socket, session })
  record.headlessProfileBackend = { socket: '<root>/h/herdr-dev/sessions/l556dev/herdr.sock', session }

  // ② 개발 GUI(unpackaged Electron) — 같은 명시 바인딩으로 같은 backend 에 붙는가. app.isPackaged 거짓이라 동봉 해소·바인딩이 없다.
  const guiEnv = { ...base, CORRAL_USER_DATA: path.join(root, 'u-gui'), CORRAL_CONTROL_SOCKET: path.join(root, 'gui.sock') }
  fs.mkdirSync(guiEnv.CORRAL_USER_DATA, { mode: 0o700 })
  start('gui', path.join(app, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [app, `--user-data-dir=${guiEnv.CORRAL_USER_DATA}`], guiEnv)
  const state = await until(async () => { const r = await rpc(guiEnv.CORRAL_CONTROL_SOCKET, { cmd: 'state' }); return r.state?.link.phase === 'live' ? r.state : null }, 'GUI live', 40000)
  record.gui = { linkPhase: state.link.phase, selected: state.selectedSession ?? state.session ?? null, backend: state.backend }
  const guiStatus = cli(guiEnv, ['status'])
  assert.equal(guiStatus.result.backend.ownership, 'external')
  assert.equal(guiStatus.result.backend.session, session)
  const guiMade = cli(guiEnv, ['terminal', 'create', '--worktree', repo, '--title', 'l556-gui', '--command', 'sh'])
  cli(guiEnv, ['terminal', 'close', '--terminal', guiMade.result.terminal.handle])
  const log = fs.readFileSync(path.join(guiEnv.CORRAL_USER_DATA, 'corral.ndjson'), 'utf8')
  record.guiResolve = log.split('\n').filter((line) => line.includes('"herdr.resolve"') || line.includes('install_cli')).map(scrub)
  assert(!record.guiResolve.some((line) => line.includes('install_cli')), '개발 실행에 Install CLI 메뉴가 붙었다')
} catch (error) {
  failed = scrub(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  for (const { name, child } of children.reverse()) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* 이미 없음 */ }
    const end = Date.now() + 5000
    while (Date.now() < end) { try { process.kill(child.pid, 0); await pause(100) } catch { break } }
    let alive = true
    try { process.kill(child.pid, 0) } catch { alive = false }
    if (alive) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* */ } }
    record.processes.find((p) => p.pid === child.pid).stopped = !alive ? 'SIGTERM' : 'SIGKILL'
    void name
  }
  const orphans = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.includes(root) || line.includes(root.replace(/^\/tmp\//, '/private/tmp/')))
  record.leftover = orphans.map(scrub)
  record.failed = failed
  for (const name of ['backend', 'serve', 'gui']) if (fs.existsSync(path.join(root, `${name}.log`))) fs.writeFileSync(path.join(rawDir, `${name}.log`), scrub(fs.readFileSync(path.join(root, `${name}.log`), 'utf8')).slice(-20000))
  fs.writeFileSync(path.join(rawDir, 'dev-binding.json'), JSON.stringify(record, null, 2) + '\n')
  fs.rmSync(root, { recursive: true, force: true })
  console.log(failed === null ? `dev-binding ok (leftover ${record.leftover.length})` : `dev-binding FAILED: ${failed.split('\n')[0]}`)
  process.exit(failed === null && record.leftover.length === 0 ? 0 : 1)
}
