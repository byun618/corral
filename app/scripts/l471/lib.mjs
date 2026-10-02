// LIFE-471 격리 실행 공용 — 격리 herdr + **세는 프록시** + 격리 corral(빌드 산출물) 기동·종료, CDP 입력 도우미.
//
// 격리: 작업 폴더(--work, /tmp/l471* 강제) 아래 userData·ui-prefs·레지스트리·herdr 세션·제어 소켓·fixture.
// 사용자 기본 userData·herdr 기본 세션·설치본 Orca 는 건드리지 않는다. 입력은 CDP Input(이 인스턴스 페이지에만 간다).
//
// 세는 프록시 (K11ⓓ · G8): corral 의 `CORRAL_BACKEND_SOCKET` 을 진짜 herdr 소켓이 아니라 이 프록시에 물린다. 프록시는 바이트를
// 그대로 넘기면서 **corral → herdr 방향**에서 메서드 이름 `pane.focus`·`tab.focus` 가 나온 횟수를 센다(JSON-RPC 줄과 endpoint
// bincode 프레임 둘 다 메서드 이름이 ASCII 그대로 실린다). `pane.focus_direction` 같은 긴 이름은 뒤 글자로 거른다.
// 하네스가 상태를 꽂는 RPC(`pane.report_agent` 등)는 진짜 소켓으로 직접 가므로 세지 않는다.
/* global document -- CDP evaluate 클로저 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { connect, pickTarget, until, setViewport, assertPortFree, pause } from '../gui-diff/lib/cdp.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

export { rpc, until, pause, setViewport }

export function parseArgs(argv) {
  return Object.fromEntries(
    argv.reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]?.startsWith('--') ? true : (all[index + 1] ?? true)]] : pairs), []),
  )
}

export function guardWork(dir) {
  const work = path.resolve(String(dir))
  if (!work.startsWith('/tmp/l471')) throw new Error(`--work 는 /tmp/l471* 아래여야 한다(격리 규칙 4): ${work}`)
  return work
}

// --- fixture ------------------------------------------------------------------------------------------------
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export function makeRepo({ reposDir, name, linked }) {
  const root = path.join(reposDir, name)
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n')
  git(root, 'add', '-A')
  git(root, '-c', 'user.email=l471@example.invalid', '-c', 'user.name=l471', 'commit', '-q', '-m', 'init')
  const worktrees = {}
  for (const wt of linked) {
    const target = path.join(reposDir, `${name}-wt`, wt)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    git(root, 'worktree', 'add', '-q', '-b', wt, target)
    worktrees[wt] = fs.realpathSync(target)
  }
  return { root: fs.realpathSync(root), worktrees }
}

// --- 세는 프록시 ---------------------------------------------------------------------------------------------
const METHODS = ['pane.focus', 'tab.focus']
/**
 * 한 방향 바이트 흐름에서 메서드 이름 등장 횟수를 센다 — **완결 메시지 단위**(r2 F-B). 끝나지 않은 메시지는 다음 청크까지 들고
 * 있다가 끝나면 센다. 메시지 = control 소켓은 JSON-RPC 한 줄(`\n`), endpoint 소켓은 길이 접두 프레임(u32 LE + 본문,
 * `vendor/bincode.ts encodeFrame`). 이름이 메시지 경계에 걸쳐 쪼개질 일이 없어 청크가 어디서 끊겨도 같은 수를 센다.
 * `state` = 연결 하나의 상태 — `newState('line' | 'frame')`. 연결이 끝날 때 남은 미완결 조각은 메시지가 아니라 세지 않는다(r3 L-3).
 */
export function makeCounter() {
  const counts = Object.fromEntries(METHODS.map((m) => [m, 0]))
  const events = []
  const countMessage = (text) => {
    for (const method of METHODS) {
      for (let at = text.indexOf(method); at >= 0; at = text.indexOf(method, at + method.length)) {
        const next = text[at + method.length]
        if (next !== undefined && /[A-Za-z0-9_.]/.test(next)) continue
        counts[method] += 1
        events.push({ method, at: Date.now() })
      }
    }
  }
  const newState = (mode) => ({ mode, buffer: Buffer.alloc(0) })
  const feed = (state, chunk) => {
    let buffer = Buffer.concat([state.buffer, chunk])
    if (state.mode === 'line') {
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        countMessage(buffer.subarray(0, end).toString('latin1'))
        buffer = buffer.subarray(end + 1)
      }
    } else {
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0)
        countMessage(buffer.subarray(4, 4 + length).toString('latin1'))
        buffer = buffer.subarray(4 + length)
      }
    }
    state.buffer = buffer
  }
  return { counts, events, newState, feed }
}

/** control(`herdr.sock`)과 endpoint(`herdr-client.sock`) 둘 다 같은 계수기로 프록시한다. */
export async function startProxies({ iso, counter }) {
  fs.mkdirSync(path.dirname(iso.proxySocket), { recursive: true })
  const realClient = path.join(path.dirname(iso.realSocket), 'herdr-client.sock')
  const servers = [
    await startProxy({ listenPath: iso.proxySocket, targetPath: iso.realSocket, counter, mode: 'line' }),
    await startProxy({ listenPath: path.join(path.dirname(iso.proxySocket), 'herdr-client.sock'), targetPath: realClient, counter, mode: 'frame' }),
  ]
  return { close: () => servers.forEach((server) => server.close()) }
}

export function startProxy({ listenPath, targetPath, counter, mode }) {
  fs.rmSync(listenPath, { force: true })
  const server = net.createServer((client) => {
    const upstream = net.createConnection(targetPath)
    const state = counter.newState(mode)
    client.on('data', (chunk) => {
      counter.feed(state, chunk)
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => client.write(chunk))
    const end = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('close', end)
    upstream.on('close', end)
    client.on('error', end)
    upstream.on('error', end)
  })
  return new Promise((resolve) => server.listen(listenPath, () => resolve(server)))
}

// --- 격리 인스턴스 ---------------------------------------------------------------------------------------------
export function isolation({ work, session }) {
  const userData = path.join(work, 'corral-userdata')
  const herdrHome = path.join(work, 'corral-herdr')
  const env = { ...process.env }
  for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE']) delete env[key]
  Object.assign(env, {
    CORRAL_USER_DATA: userData,
    CORRAL_UI_PREFS: path.join(work, 'ui-prefs.json'),
    HERDR_CONFIG_PATH: path.join(herdrHome, 'config.toml'),
    XDG_CONFIG_HOME: herdrHome,
    CORRAL_CONTROL_SOCKET: path.join(work, 'ctl.sock'),
    CORRAL_REGISTRY: path.join(userData, 'repos.json'),
    SHELL: '/bin/sh',
  })
  return {
    work,
    session,
    userData,
    herdrHome,
    env,
    prefsFile: env.CORRAL_UI_PREFS,
    control: env.CORRAL_CONTROL_SOCKET,
    realSocket: path.join(herdrHome, 'herdr/sessions', session, 'herdr.sock'),
    // endpoint 연결은 control 소켓 **옆의** `herdr-client.sock` 을 쓴다(main `currentClientSocketPath`) — 둘 다 프록시한다.
    proxySocket: path.join(work, 'px', 'herdr.sock'),
  }
}

export async function startBackend({ iso, logFile, spawned }) {
  fs.mkdirSync(iso.herdrHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(iso.herdrHome, 'config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const fd = fs.openSync(logFile, 'a')
  const backend = spawn('herdr', ['--session', iso.session, 'server'], { env: iso.env, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  spawned.push({ pid: backend.pid, label: 'herdr backend (isolated)' })
  await until(() => fs.existsSync(iso.realSocket), 'backend socket', 30_000)
  return backend
}

export async function stopPid(pid, label, timeout = 30_000) {
  if (pid === null || pid === undefined) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  await until(
    () => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    },
    `${label} exit`,
    timeout,
  )
}

/**
 * corral 기동 — `cli/corral.mjs open` + `CORRAL_ELECTRON` 래퍼로 디버깅 포트(gui-diff 와 같은 경로).
 * `socket` = corral 이 붙을 backend 소켓(프록시 또는 진짜). **포커스 에뮬레이션을 켜지 않는다** — 이 일감의 판정이
 * `document.hasFocus()` 를 본다(켜면 다른 앱이 앞이어도 늘 포커스로 보인다).
 */
export async function launchCorral({ iso, appRoot, port, socket, spawned, viewport = { width: 1200, height: 860 } }) {
  await assertPortFree(port, 'corral l471')
  const env = { ...iso.env, CORRAL_BACKEND_SOCKET: socket, CORRAL_SESSION: iso.session }
  const wrapper = path.join(iso.work, 'corral-electron')
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')}' --remote-debugging-port=${port} "$@"\n`, { mode: 0o755 })
  env.CORRAL_ELECTRON = wrapper
  const opened = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), 'open', '--json'], { env, encoding: 'utf8', timeout: 120_000 })
  if (opened.status !== 0) throw new Error(`open → ${opened.status}\n${opened.stdout}\n${opened.stderr}`)
  const pid = JSON.parse(opened.stdout).result?.runtime?.pid ?? null
  spawned.push({ pid, label: 'corral desktop (isolated)' })
  await until(() => fs.existsSync(iso.control), 'control socket', 60_000)
  await until(async () => (await rpc(iso.control, { cmd: 'state' })).state?.link?.phase === 'live', 'link live', 60_000)
  const { target } = await pickTarget(port, { label: 'corral', match: (entry) => /out\/renderer\/index\.html/.test(entry.url) })
  const cdp = await connect(target.webSocketDebuggerUrl)
  await setViewport(cdp, viewport)
  await until(() => cdp.evaluate(() => document.querySelector('[data-repo-list]') !== null), 'sidebar rendered', 30_000)
  return { pid, cdp }
}

export async function quitCorral({ iso, app }) {
  await app.cdp?.close().catch(() => {})
  await stopPid(app.pid, 'corral desktop')
  await until(() => !fs.existsSync(iso.control), 'control socket gone', 15_000).catch(() => fs.rmSync(iso.control, { force: true }))
  await pause(500)
}

export async function backendRpc(iso, method, params = {}) {
  const response = await rpc(iso.realSocket, { id: `l471-${Date.now()}-${Math.random()}`, method, params })
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`)
  return response.result
}

// --- CDP 입력 ---------------------------------------------------------------------------------------------
export function inputs(cdp) {
  const mouse = (type, p, extra = {}) => {
    const button = extra.button ?? (type === 'mouseMoved' ? 'none' : 'left')
    const pressed = button === 'right' ? 2 : 1
    return cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons: type === 'mouseReleased' || type === 'mouseMoved' ? 0 : pressed, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: 0 })
  }
  const pointOf = (selector) =>
    cdp.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, selector)
  const click = async (selector, extra = {}) => {
    const p = await pointOf(selector)
    if (p === null) throw new Error(`click: ${selector} 없음`)
    await mouse('mouseMoved', p)
    await mouse('mousePressed', p, extra)
    await mouse('mouseReleased', p, extra)
    await pause(250)
    return p
  }
  const hover = async (selector) => {
    const p = await pointOf(selector)
    if (p === null) throw new Error(`hover: ${selector} 없음`)
    await mouse('mouseMoved', p)
    await pause(200)
  }
  return { mouse, pointOf, click, rightClick: (selector) => click(selector, { button: 'right' }), hover }
}

export function loadSample() {
  return { yes: spawnSync('pgrep', ['-x', 'yes'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).length, uptime: spawnSync('uptime', [], { encoding: 'utf8' }).stdout.trim(), at: new Date().toISOString() }
}

/** 원장(runs.md) 한 행 덧붙이기 — 실행 id 는 마지막 행 다음 번호. */
export function appendRun({ ledger, criterion, command, expected, actual, raw, pass }) {
  const text = fs.readFileSync(ledger, 'utf8')
  const ids = [...text.matchAll(/^\| R(\d+) \|/gm)].map((m) => Number(m[1]))
  const id = `R${String((ids.length === 0 ? 0 : Math.max(...ids)) + 1).padStart(3, '0')}`
  fs.appendFileSync(ledger, `| ${id} | ${criterion} | \`${command}\` | ${expected} | ${actual} | ${raw} | ${pass ? '통과' : '실패'} |\n`)
  return id
}
