// LIFE-507 격리 하네스 — corral(`/tmp/l507i<N>`) + herdr(`XDG_CONFIG_HOME=/tmp/l507h<N>`, 세션 l507) 를 띄우고 끈다.
// 사용자 userData·`~/.config/herdr`·herdr default·life417-native 는 건드리지 않는다(킥오프 격리 4).
// 504 가드: 같은 격리 경로를 명령줄에 가진 프로세스가 있거나 폴더가 이미 있으면 띄우지 않고 throw.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { ensureFixtureRepo } from '../gui-diff/lib/fixture.mjs'

export const SESSION = 'l507'
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function until(check, label, timeoutMs = 30_000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = String(error)
    }
    await pause(stepMs)
  }
  throw new Error(`timeout: ${label} (last=${JSON.stringify(last)?.slice(0, 200)})`)
}

/** 명령줄에 경로가 든 프로세스 — 자기 자신과 조상(이 명령을 부른 셸 — 명령줄에 같은 경로가 있다)은 뺀다. */
export function processesWith(paths) {
  const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  const parent = new Map(ps.map((line) => { const [pid, ppid] = line.trim().split(/\s+/); return [Number(pid), Number(ppid)] }))
  const mine = new Set()
  for (let pid = process.pid; pid > 1 && !mine.has(pid); pid = parent.get(pid) ?? 1) mine.add(pid)
  return ps.filter((line) => paths.some((p) => line.includes(p) || line.includes(`/private${p}`)) && !mine.has(Number(line.trim().split(/\s+/)[0])) && !line.includes('ps -Ao'))
}

function guard(paths) {
  const hits = processesWith(paths)
  const existing = paths.filter((p) => fs.existsSync(p))
  return { pass: hits.length === 0 && existing.length === 0, hits, existing }
}

/** 격리 한 벌을 띄운다. `n` = 회차 번호(경로 접미). */
export async function isoUp({ app, n, log = console.log }) {
  const work = `/tmp/l507i${n}`
  const xdg = `/tmp/l507h${n}`
  const g = guard([work, xdg])
  log('guard', JSON.stringify(g))
  if (!g.pass) throw new Error(`504 가드 — 같은 격리 경로가 쓰이는 중이거나 이미 있다: ${JSON.stringify(g)}`)
  fs.mkdirSync(path.join(xdg, 'herdr'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(work, 'userdata'), { recursive: true, mode: 0o700 })
  const config = path.join(xdg, 'herdr', 'config.toml')
  fs.writeFileSync(config, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const fixture = ensureFixtureRepo(work, { name: 'fx' })
  const env = { ...process.env }
  for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE', 'CORRAL_ELECTRON']) delete env[key]
  env.CORRAL_USER_DATA = path.join(work, 'userdata')
  env.HERDR_CONFIG_PATH = config
  env.XDG_CONFIG_HOME = xdg
  env.CORRAL_CONTROL_SOCKET = path.join(work, 'ctl.sock')
  env.CORRAL_REGISTRY = path.join(work, 'userdata', 'repos.json')
  env.SHELL = '/bin/sh'
  const handle = { app, n, work, xdg, env, fixture, ctl: env.CORRAL_CONTROL_SOCKET, herdrPids: [], corralPid: null, log, openError: null }
  handle.backendSocket = path.join(xdg, 'herdr', 'sessions', SESSION, 'herdr.sock')
  try {
    await startHerdr(handle)
    env.CORRAL_BACKEND_SOCKET = handle.backendSocket
    env.CORRAL_SESSION = SESSION
    const opened = spawnSync(process.execPath, [path.join(app, 'cli/corral.mjs'), 'open', '--json'], { env, encoding: 'utf8', timeout: 120_000 })
    if (opened.status === 0) handle.corralPid = JSON.parse(opened.stdout).result?.runtime?.pid ?? null
    else {
      // R002 — `open` 이 outcome_unknown(런타임 소켓 권한 검사 경합)으로 돌아와도 Electron 은 떠 있을 수 있다. 오류를 남기고 그 Electron 을 찾는다.
      handle.openError = `${opened.status} ${opened.stdout.trim()} ${opened.stderr.trim()}`.slice(0, 600)
      log('corral open 실패 — 떠 있는 Electron 을 찾는다', handle.openError)
      const main = await until(() => electronMain(handle), 'Electron(user-data-dir) 프로세스', 30_000)
      handle.corralPid = main
    }
    log('corral pid', handle.corralPid)
    await until(() => fs.existsSync(handle.ctl), 'ctl socket', 60_000)
    await waitLive(handle)
    const added = await rpc(handle.ctl, { cmd: 'add-repo', root: fixture.root })
    log('add-repo', JSON.stringify(added))
    await until(async () => (await state(handle)).repos.some((repo) => repo.worktrees.length >= 2), 'fixture 2 worktrees', 30_000)
  } catch (error) {
    if (handle.corralPid === null) handle.corralPid = electronMain(handle)
    await isoDown(handle)
    throw error
  }
  return handle
}

/** `--user-data-dir=<work>/userdata` 를 가진 Electron 본체 pid (헬퍼 제외). 없으면 null. */
export function electronMain(handle) {
  const line = processesWith([`--user-data-dir=${handle.work}/userdata`]).find((row) => /Electron\.app\/Contents\/MacOS\/Electron /.test(row))
  return line === undefined ? null : Number(line.trim().split(/\s+/)[0])
}

/** corral 만 끈다(herdr 는 그대로) — 같은 userData 로 `startCorral` 이 다시 띄운다(K1ⓒ: corral 이 꺼진 동안의 변화). */
export async function stopCorral(handle) {
  const pid = handle.corralPid
  if (pid === null) return
  try { process.kill(pid, 'SIGTERM') } catch { /* 이미 없다 */ }
  await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, `corral pid ${pid} 종료`, 30_000)
  handle.corralPid = null
  await until(() => !fs.existsSync(handle.ctl), 'ctl socket 사라짐', 15_000).catch(() => fs.rmSync(handle.ctl, { force: true }))
}

export async function startCorral(handle) {
  const opened = spawnSync(process.execPath, [path.join(handle.app, 'cli/corral.mjs'), 'open', '--json'], { env: handle.env, encoding: 'utf8', timeout: 120_000 })
  if (opened.status === 0) handle.corralPid = JSON.parse(opened.stdout).result?.runtime?.pid ?? null
  else {
    handle.log('corral open 실패 — 떠 있는 Electron 을 찾는다', `${opened.status} ${opened.stdout.trim()}`.slice(0, 400))
    handle.corralPid = await until(() => electronMain(handle), 'Electron(user-data-dir) 프로세스', 30_000)
  }
  await until(() => fs.existsSync(handle.ctl), 'ctl socket', 60_000)
  await waitLive(handle)
  await until(async () => (await state(handle)).repos.some((repo) => repo.worktrees.length >= 2), 'fixture 2 worktrees', 30_000)
}

export async function startHerdr(handle) {
  const logFd = fs.openSync(path.join(handle.work, `herdr-${handle.herdrPids.length + 1}.log`), 'a')
  const server = spawn('herdr', ['--session', SESSION, 'server'], { env: handle.env, stdio: ['ignore', logFd, logFd], detached: false })
  fs.closeSync(logFd)
  handle.herdrPids.push(server.pid)
  handle.log('herdr server pid', server.pid)
  await until(() => fs.existsSync(handle.backendSocket) && herdr(handle, ['session', 'list']).stdout.includes(SESSION), 'herdr socket', 30_000)
  return server.pid
}

/** herdr 서버를 멈추고 다시 띄운다(corral 은 그대로). 멈춘 서버 프로세스가 사라졌는지 확인한다. */
export async function restartHerdr(handle) {
  const before = handle.herdrPids.at(-1)
  const stop = herdr(handle, ['server', 'stop'])
  handle.log('herdr server stop', stop.status, stop.stdout.trim(), stop.stderr.trim())
  await until(() => { try { process.kill(before, 0); return false } catch { return true } }, `herdr pid ${before} 종료`, 30_000)
  await pause(500)
  await startHerdr(handle)
  if (handle.corralPid !== null) await waitLive(handle)
}

export async function waitLive(handle, timeoutMs = 60_000) {
  return until(async () => (await state(handle)).link?.phase === 'live', 'corral link live', timeoutMs)
}

export function herdr(handle, args) {
  const result = spawnSync('herdr', ['--session', handle.session ?? SESSION, ...args], { env: handle.env, encoding: 'utf8', timeout: 30_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function herdrJson(handle, args) {
  const result = herdr(handle, args)
  if (result.status !== 0) throw new Error(`herdr ${args.join(' ')} → ${result.status} ${result.stderr}`)
  return JSON.parse(result.stdout)
}

export async function state(handle) {
  return (await rpc(handle.ctl, { cmd: 'state' })).state
}

export async function ev(handle, code) {
  const reply = await rpc(handle.ctl, { cmd: 'eval', code: `(async () => (${code}))()` })
  if (!reply.ok) throw new Error(`eval 실패: ${JSON.stringify(reply).slice(0, 300)}`)
  return reply.result
}

export async function click(handle, selector) {
  const reply = await rpc(handle.ctl, { cmd: 'click', selector })
  if (!reply.ok) throw new Error(`click 실패 ${selector}: ${JSON.stringify(reply).slice(0, 300)}`)
  return reply
}

export function uiPrefs(handle) {
  const file = path.join(handle.userData ?? path.join(handle.work, 'userdata'), 'ui-prefs.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

/** 격리 한 벌을 끈다 — 띄운 것만(corral pid · herdr 서버). 끈 뒤 남은 프로세스를 돌려준다. */
export async function isoDown(handle) {
  if (handle.corralPid !== null) {
    try { process.kill(handle.corralPid, 'SIGTERM') } catch { /* 이미 없다 */ }
  }
  await pause(1500)
  herdr(handle, ['server', 'stop'])
  for (const pid of handle.herdrPids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* 이미 없다 */ }
  }
  await pause(1500)
  const left = processesWith([handle.work, handle.xdg])
  // herdr 서버 명령줄에는 격리 경로가 없다(`herdr --session l507 server`) — 띄운 pid 로 따로 본다.
  for (const pid of handle.herdrPids) {
    try { process.kill(pid, 0); left.push(`herdr pid ${pid} 살아 있음`) } catch { /* 꺼졌다 */ }
  }
  handle.log('left', JSON.stringify(left))
  return left
}

/**
 * 네이티브 회차(K6)의 손잡이 — native-up.sh 가 띄운 corral(`<ROOT>/ctl.sock`·`app.pid`, 사용자 userData) + herdr `default`.
 * 드라이버(k2·k4)는 이 손잡이로 같은 걸음을 돈다. 끄기·원복은 native-down.sh 몫이라 여기엔 없다.
 * fixture 는 native.mjs setup 이 `<ROOT>/native-state.json` 에 적는다. herdr CLI 는 사용자 기본 설정(XDG·HERDR_CONFIG_PATH 없이)으로 부른다.
 */
export function nativeHandle({ root, log = console.log }) {
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'native-state.json'), 'utf8'))
  const env = { ...process.env }
  for (const key of ['XDG_CONFIG_HOME', 'HERDR_CONFIG_PATH', 'CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'CORRAL_USER_DATA', 'CORRAL_REGISTRY', 'CORRAL_CONTROL_SOCKET']) delete env[key]
  return {
    native: true, app: fs.readFileSync(path.join(root, 'app.dir'), 'utf8'), n: 'native', work: root, xdg: null, env, session: 'default',
    fixture: saved.fixture, ctl: path.join(root, 'ctl.sock'), herdrPids: [], corralPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim()),
    userData: path.join(process.env.HOME, 'Library/Application Support/corral'), log,
  }
}
