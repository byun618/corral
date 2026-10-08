// LIFE-556 격리 설치본 회차 — 빌드한 corral.app 을 **격리 HOME·userData** 로 직접 띄워 동봉 경로를 미리 본다.
// 네이티브 관문이 아니다(설치본·사용자 userData·PATH 의 corral 이 아님) — B5~B7 의 기계 장치가 도는지의 회귀·격리 근거로만 쓴다.
//
// 보는 것: ⓐ GUI 가 동봉 herdr 를 해소하고(`herdr.resolve` source bundled) 동봉 서버를 스스로 띄워 붙는다
// ⓑ 동봉 서버 실행 파일이 .app 안이고 env 에 corral 이 넣은 XDG_* 가 없다 ⓒ 서버 폴더가 `corral-herdr` 이고 `herdr`·`herdr-dev` 가 없다
// ⓓ shim CLI 가 env·profile 없이 status(ownership bundled)·terminal create/read/close·orchestration run-create/task-create/check 를 exit 0
// ⓔ CLI 로 만든 터미널의 탭이 GUI 상태에 나타나고 닫으면 사라진다 ⓕ 프로필에 backend 가 저장되지 않는다.
// 격리: HOME·userData·control 소켓 모두 /tmp/l556-app-* 아래. PATH 는 /usr/bin:/bin(brew 없음). 끝에 앱·동봉 서버를 끄고 고아를 본다.
// ⓖ (fix1 M1) B8 왕복 — `b8-roundtrip.mjs`. ⓗ (fix1 L2) pane 의 XDG_CONFIG_HOME 이 앱 env 와 같다(둘 다 없음).
// 판정은 종료코드다. 판정기 양성 대조: `L556_NEGATIVE=b8-cli` 는 기대 CLI 경로를, `L556_NEGATIVE=xdg` 는 기대 XDG 를, `L556_NEGATIVE=pin` 은 기대 세션을,
// `L556_NEGATIVE=sender` 는 B8 음성의 「다른 서버 소켓」 을 이 backend 소켓으로, `L556_NEGATIVE=status` 는 음성 뒤 기대 상태를 바꿔 줘서 exit 1 이 나와야 한다.
// 인자: <corral.app> <원자료 디렉터리> <fixture claude 바이너리(fixture/claude.c 를 cc 로 빌드한 것)>
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'
import { b8RoundTrip } from './b8-roundtrip.mjs'

const [bundle, rawDir, fixtureBin] = process.argv.slice(2)
assert(fixtureBin && fs.existsSync(fixtureBin), 'fixture claude 바이너리가 필요하다')
const negative = process.env.L556_NEGATIVE ?? null
assert(bundle && fs.existsSync(path.join(bundle, 'Contents/MacOS/corral')), 'corral.app 경로가 필요하다')
assert(rawDir, '원자료 디렉터리가 필요하다')
const appPath = fs.realpathSync(bundle)
const root = fs.realpathSync(fs.mkdtempSync('/tmp/l556-app-'))
const home = path.join(root, 'h'), repo = path.join(root, 'repo'), userData = path.join(root, 'u')
for (const dir of [home, repo, userData]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
fs.mkdirSync(rawDir, { recursive: true })
const userHome = process.env.HOME ?? '\0'
const scrub = (text) => String(text).replaceAll(root, '<root>').replaceAll(root.replace(/^\/private/, ''), '<root>').replaceAll(appPath, '<app>').replaceAll(userHome, '~')
const fakebin = path.join(root, 'fakebin')
fs.mkdirSync(fakebin, { mode: 0o700 })
fs.copyFileSync(fixtureBin, path.join(fakebin, 'claude'))
fs.chmodSync(path.join(fakebin, 'claude'), 0o755)
const fixtureOut = path.join(root, 'fixture-body.txt')
const env = {
  HOME: home, PATH: `${fakebin}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: root, CORRAL_USER_DATA: userData, CORRAL_CONTROL_SOCKET: path.join(root, 'c.sock'),
  L556_FIXTURE_OUT: fixtureOut, L556_FIXTURE_REPORT_DELAY: '12', L556_FIXTURE_REPORT: path.join(path.dirname(new URL(import.meta.url).pathname), 'fixture/report.py'),
}
const shim = path.join(appPath, 'Contents/Resources/bin/corral')
const bundled = path.join(appPath, 'Contents/Resources/backend/herdr')
const record = { app: '<app>', root: '<root>', checks: {}, steps: [], processes: [] }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rpc = (file, body) => new Promise((resolve, reject) => {
  const s = net.createConnection(file); let buf = ''
  const timer = setTimeout(() => { s.destroy(); reject(Error('rpc timeout')) }, 5000)
  s.on('error', (e) => { clearTimeout(timer); reject(e) })
  s.on('connect', () => s.write(JSON.stringify(body) + '\n'))
  s.setEncoding('utf8'); s.on('data', (b) => { buf += b; if (buf.includes('\n')) { clearTimeout(timer); s.destroy(); resolve(JSON.parse(buf.split('\n')[0])) } })
})
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms; let last
  while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch (e) { last = e } await pause(200) }
  throw Error(`${label} timeout (${last ?? 'no value'})`)
}
function cli(args, options = {}) {
  const result = spawnSync(shim, [...args, '--json'], { env, cwd: repo, encoding: 'utf8', timeout: options.timeout ?? 30000 })
  let body = null
  try { body = JSON.parse(result.stdout) } catch { /* 원문을 남긴다 */ }
  record.steps.push({ args, exit: result.status, body: body === null ? scrub(result.stdout + result.stderr) : JSON.parse(scrub(JSON.stringify(body))) })
  assert.equal(result.status, 0, `${args.join(' ')} → ${scrub(result.stdout + result.stderr).slice(0, 400)}`)
  return body
}
const state = async () => (await rpc(env.CORRAL_CONTROL_SOCKET, { cmd: 'state' })).state
const serverPids = () => spawnSync('/usr/bin/pgrep', ['-f', `${bundled} server`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number)
// fix2 M2·M1 — 같은 동봉 바이너리의 두 번째 서버(이름 세션 `other`). 앱보다 먼저 띄운다: 종전 규칙이면 GUI 가 default 를 띄우지 않고 이쪽에 붙는다.
const OTHER = 'other'
const otherSocket = path.join(home, '.config/corral-herdr/sessions', OTHER, 'herdr.sock')
const otherPids = () => spawnSync('/usr/bin/pgrep', ['-f', `${bundled} --session ${OTHER} server`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number)
/** 판정 없이 부른다 — 거절이 기대값인 호출(B8 음성)용. 호출자 pane 의 env 를 덧붙인다. */
function cliRaw(args, extraEnv) {
  const result = spawnSync(shim, [...args, '--json'], { env: { ...env, ...extraEnv }, cwd: repo, encoding: 'utf8', timeout: 30000 })
  let body = null
  try { body = JSON.parse(result.stdout) } catch { /* 원문을 남긴다 */ }
  record.steps.push({ args, extraEnv: JSON.parse(scrub(JSON.stringify(extraEnv))), exit: result.status, body: body === null ? scrub(result.stdout + result.stderr) : JSON.parse(scrub(JSON.stringify(body))) })
  return { exit: result.status, body }
}
let gui = null
let failed = null
try {
  spawnSync('git', ['init', '-q', repo])
  spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: { ...env, GIT_AUTHOR_NAME: 'l556', GIT_AUTHOR_EMAIL: 'l556@example.invalid', GIT_COMMITTER_NAME: 'l556', GIT_COMMITTER_EMAIL: 'l556@example.invalid' } })
  const otherLog = fs.openSync(path.join(root, 'other-server.log'), 'w')
  const other = spawn(bundled, ['--session', OTHER, 'server'], { env, stdio: ['ignore', otherLog, otherLog], detached: true })
  fs.closeSync(otherLog)
  record.processes.push({ name: 'other-session-server', pid: other.pid })
  await until(() => fs.existsSync(otherSocket), 'other session socket', 15000)
  const fd = fs.openSync(path.join(root, 'app.log'), 'w')
  gui = spawn(path.join(appPath, 'Contents/MacOS/corral'), [], { env, stdio: ['ignore', fd, fd], detached: true })
  fs.closeSync(fd)
  record.processes.push({ name: 'app', pid: gui.pid })
  // ⓐ 동봉 서버를 스스로 띄우고 붙는다.
  const live = await until(async () => { const s = await state(); return s.link.phase === 'live' ? s : null }, 'GUI live (bundled autostart)', 45000)
  record.checks.a_gui = { selectedSession: live.selectedSession, sessions: live.sessions, backend: live.backend }
  // fix2 M2 — 다른 세션이 먼저 돌고 있어도 설치본은 default 를 띄워 그쪽에 붙고, 세션 목록에 다른 세션을 올리지 않는다.
  const pinned = negative === 'pin' ? OTHER : 'default'
  assert.equal(live.selectedSession, pinned, 'GUI 가 default 에 고정되지 않았다')
  assert.deepEqual(live.sessions.map((session) => session.name), ['default'], 'GUI 세션 목록에 default 밖의 세션이 있다')
  assert.deepEqual(otherPids().length, 1, 'other 세션 서버가 돌고 있지 않다')
  const log = fs.readFileSync(path.join(userData, 'corral.ndjson'), 'utf8').split('\n')
  record.checks.a_log = log.filter((line) => /"herdr\.resolve"|"herdr\.server\.spawn"|"backend\.start\.ready"|install_cli/.test(line)).map(scrub)
  assert(record.checks.a_log.some((line) => line.includes('"herdr.resolve"') && line.includes('"source":"bundled"')), 'herdr.resolve 가 bundled 가 아니다')
  // ⓑ 동봉 서버 프로세스 — 실행 파일·env.
  const pids = serverPids()
  assert.equal(pids.length, 1, `동봉 서버 프로세스 ${pids.length}개`)
  record.processes.push({ name: 'bundled-server', pid: pids[0] })
  const eww = spawnSync('/bin/ps', ['eww', '-o', 'command=', '-p', String(pids[0])], { encoding: 'utf8' }).stdout
  const words = eww.split(/\s+/)
  record.checks.b_server = {
    executableUnderApp: eww.startsWith(`${bundled} server`),
    envXdg: words.filter((word) => /^XDG_[A-Z_]+=/.test(word)).map(scrub),
    envHerdr: words.filter((word) => /^HERDR_[A-Z_]+=/.test(word)).map(scrub),
    envCorral: words.filter((word) => /^CORRAL_[A-Z_]+=/.test(word)).map(scrub),
  }
  assert(record.checks.b_server.executableUnderApp)
  assert.deepEqual(record.checks.b_server.envXdg, [])
  // ⓒ 폴더.
  record.checks.c_dirs = Object.fromEntries(['.config/corral-herdr', '.config/herdr', '.config/herdr-dev', '.local/state/herdr', '.local/state/herdr-dev'].map((dir) => [dir, fs.existsSync(path.join(home, dir))]))
  assert.equal(record.checks.c_dirs['.config/corral-herdr'], true)
  for (const dir of ['.config/herdr', '.config/herdr-dev', '.local/state/herdr', '.local/state/herdr-dev']) assert.equal(record.checks.c_dirs[dir], false, dir)
  // ⓓ shim CLI — env·profile 없이.
  const status = cli(['status'])
  assert.equal(status.result.backend.ownership, 'bundled')
  assert.equal(status.result.backend.session, 'default')
  cli(['repo', 'add', '--path', repo])
  // 먼저 탭 하나를 깔아 둔다 — 워크스페이스의 마지막 탭을 닫는 경우(워크스페이스째 남거나 사라짐)와 섞지 않는다.
  const keeper = cli(['terminal', 'create', '--worktree', repo, '--title', 'l556-keeper', '--command', 'sh'])
  await until(async () => ((await state()).herdrTabIds ?? []).length === 1, 'keeper tab')
  const tabsBefore = (await state()).herdrTabIds
  const made = cli(['terminal', 'create', '--worktree', repo, '--title', 'l556-app', '--command', 'sh'])
  const handle = made.result.terminal.handle
  cli(['terminal', 'send', '--terminal', handle, '--text', 'echo l556-app-ok; command -v herdr; echo "xdg=${XDG_CONFIG_HOME:-unset}"', '--enter'])
  const read = await until(() => { const r = cli(['terminal', 'read', '--terminal', handle]); return JSON.stringify(r).includes('l556-app-ok') ? r : null }, 'read echo')
  record.checks.d_paneText = scrub(read.result.text ?? '').slice(-400)
  // ⓗ pane 셸의 XDG_CONFIG_HOME 이 앱 기동 env 와 같다 — 이 회차의 앱 env 에는 없다.
  const expectedXdg = negative === 'xdg' ? 'xdg=/wrong' : 'xdg=unset'
  record.checks.h_paneXdg = { expected: expectedXdg, observed: /^xdg=[^\s]+?(?=\r?$)/m.exec(read.result.text ?? '')?.[0] ?? null }
  assert.equal(record.checks.h_paneXdg.observed, expectedXdg, 'pane XDG_CONFIG_HOME differs from the app env')
  // ⓔ GUI 에 탭이 생긴다.
  const tabsAfter = await until(async () => { const ids = (await state()).herdrTabIds; return ids !== null && ids.length > (tabsBefore?.length ?? 0) ? ids : null }, 'GUI tab appears')
  record.checks.e_tabs = { before: tabsBefore, afterCreate: tabsAfter }
  cli(['orchestration', 'run-create', '--objective', 'LIFE-556 isolated app'])
  cli(['orchestration', 'task-create', '--spec', 'bundled binding'])
  cli(['orchestration', 'check'])
  // ⓖ B8 왕복.
  await b8RoundTrip({ cli, cliRaw, state, repo, fixtureOut, foreignSocket: negative === 'sender' ? path.join(home, '.config/corral-herdr/herdr.sock') : otherSocket, expectStatusAfter: negative === 'status' ? 'completed' : 'dispatched', expectCli: negative === 'b8-cli' ? '/wrong/corral' : shim, until, scrub, record: record.checks })
  cli(['terminal', 'close', '--terminal', handle])
  const closedTab = made.result.terminal.tabId
  const tabsClosed = await until(async () => { const ids = (await state()).herdrTabIds; return ids !== null && !ids.includes(closedTab) ? ids : null }, 'GUI tab gone')
    .catch(async (error) => { record.checks.e_tabs.afterCloseObserved = (await state()).herdrTabIds; throw error })
  record.checks.e_tabs.afterClose = tabsClosed
  // 관측(단언 아님): 워크스페이스의 마지막 탭을 닫았을 때 GUI 목록과 서버 목록 — 1회차(r1 iso-app)에서 30초 동안 탭이 남았다.
  cli(['terminal', 'close', '--terminal', keeper.result.terminal.handle])
  await pause(3000)
  const lastTab = spawnSync(bundled, ['workspace', 'list'], { env, encoding: 'utf8', timeout: 10000 })
  record.checks.g_lastTabClose = { guiTabIds: (await state()).herdrTabIds, serverWorkspaceList: scrub(lastTab.stdout + lastTab.stderr).slice(0, 800), exit: lastTab.status }
  // ⓕ 프로필.
  record.checks.f_profileKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(userData, 'runtime/profile.json'), 'utf8')))
  assert(!record.checks.f_profileKeys.includes('backend'), 'profile 에 backend 가 저장됐다')
  record.checks.menu = (await rpc(env.CORRAL_CONTROL_SOCKET, { cmd: 'menu-dump' })).menu?.[0]?.items?.map((item) => item.label) ?? null
} catch (error) {
  failed = scrub(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  if (gui !== null) {
    try { process.kill(gui.pid, 'SIGTERM') } catch { /* 이미 없음 */ }
    const end = Date.now() + 8000
    while (Date.now() < end) { try { process.kill(gui.pid, 0); await pause(100) } catch { break } }
    try { process.kill(gui.pid, 0); process.kill(-gui.pid, 'SIGKILL'); record.processes[0].stopped = 'SIGKILL' } catch { record.processes[0].stopped = 'SIGTERM' }
  }
  // 동봉 서버는 앱 종료 뒤에도 남는다(설계) — 격리 서버라 여기서 끈다.
  const stop = spawnSync(bundled, ['server', 'stop'], { env, encoding: 'utf8', timeout: 10000 })
  const stopOther = spawnSync(bundled, ['--session', OTHER, 'server', 'stop'], { env, encoding: 'utf8', timeout: 10000 })
  record.serverStop = { exit: stop.status, out: scrub(stop.stdout + stop.stderr).slice(0, 300), otherExit: stopOther.status, otherOut: scrub(stopOther.stdout + stopOther.stderr).slice(0, 300) }
  await pause(500)
  record.serverLeft = [...serverPids(), ...otherPids()]
  for (const pid of record.serverLeft) { try { process.kill(pid, 'SIGKILL') } catch { /* */ } }
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout.split('\n')
  record.leftover = ps.filter((line) => line.includes(root) || line.includes(root.replace(/^\/private/, '')) || line.includes(`${appPath}/`)).map(scrub)
  record.failed = failed
  for (const name of ['fixture-body.txt', 'fixture-body.txt.report']) if (fs.existsSync(path.join(root, name))) fs.writeFileSync(path.join(rawDir, name), scrub(fs.readFileSync(path.join(root, name), 'utf8')).slice(-30000))
  for (const name of ['app.log', 'other-server.log']) if (fs.existsSync(path.join(root, name))) fs.writeFileSync(path.join(rawDir, name), scrub(fs.readFileSync(path.join(root, name), 'utf8')).slice(-20000))
  if (fs.existsSync(path.join(userData, 'corral.ndjson'))) fs.writeFileSync(path.join(rawDir, 'corral.ndjson'), fs.readFileSync(path.join(userData, 'corral.ndjson'), 'utf8').split('\n').filter((line) => /herdr\.|backend\.|install_cli|session\.select|runtime\./.test(line)).map(scrub).join('\n') + '\n')
  fs.writeFileSync(path.join(rawDir, 'isolated-app.json'), JSON.stringify(record, null, 2) + '\n')
  fs.rmSync(root, { recursive: true, force: true })
  console.log(failed === null ? `isolated-app ok (leftover ${record.leftover.length}, serverLeft ${record.serverLeft.length})` : `isolated-app FAILED: ${failed.split('\n')[0]}`)
  process.exit(failed === null && record.leftover.length === 0 && record.serverLeft.length === 0 ? 0 : 1)
}
