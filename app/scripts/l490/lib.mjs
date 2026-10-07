// LIFE-490 격리 하네스 공용 — 격리 corral(herdr 서버 + Electron) 기동·정리, 렌더러 계측, 활성 판정.
//
// 본보기: `l478/activate-race.mjs` 의 env 묶음(격리 축 = CORRAL_USER_DATA · XDG_CONFIG_HOME/HERDR_CONFIG_PATH ·
// CORRAL_CONTROL_SOCKET · CORRAL_BACKEND_SOCKET + CORRAL_SESSION). 작업 폴더는 `/tmp/l490*` 만 받는다.
// 런타임 소켓은 격리 userData 아래 기본값(`<ud>/runtime/rpc.sock`)을 쓴다 — `CORRAL_RUNTIME_SOCKET` 을 주면
// `corral open` 이 「선택한 런타임에 못 닿음」 으로 데스크톱을 안 띄운다(`runtime/cli.ts:47`).
//
// 활성 판정(K1ⓒ)은 셋을 함께 본다 — ① 사이드바 선택 표식(`data-worktree-card-active="primary"`) ② 메인 탭바의 탭
// (`data-main-tab`)이 그 workspace 의 탭인가(control `state` 대조) ③ 렌더러 React 상태의 `activeWorkspaceId`
// (Sidebar props 를 fiber 로 읽는다 — 제품 코드 변경 없이 읽기만).

/* global document, window, MutationObserver */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { connect, pickTarget, until, setViewport, assertPortFree } from '../gui-diff/lib/cdp.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

export { until, rpc }
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function parseArgs(argv) {
  return Object.fromEntries(
    argv.reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]?.startsWith('--') ? true : (all[index + 1] ?? true)]] : pairs), []),
  )
}

export const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export const commit = (cwd, message) => git(cwd, '-c', 'user.email=l490@example.invalid', '-c', 'user.name=l490', 'commit', '-q', '--allow-empty', '-m', message)

const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])) : [])

/** 어느 번들로 돌았나 — git 이 없는 기준 사본(`/tmp/l490base/app`)도 번들 해시는 남긴다. */
export function buildIdentity(appRoot) {
  const outFiles = walk(path.join(appRoot, 'out')).sort()
  const hash = crypto.createHash('sha256')
  for (const file of outFiles) hash.update(path.relative(appRoot, file)).update('\0').update(fs.readFileSync(file)).update('\0')
  let head = null
  let dirty = null
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: appRoot, encoding: 'utf8' }).trim() !== ''
  } catch {
    const marker = path.join(appRoot, 'BASE_COMMIT')
    head = fs.existsSync(marker) ? `copy-of:${fs.readFileSync(marker, 'utf8').trim()}` : null
  }
  return { appRoot, head, dirtySrc: dirty, outFiles: outFiles.length, outSha256: hash.digest('hex') }
}

/** 같은 격리 경로를 쓰는 다른 corral·herdr 가 있으면 측정하지 않는다(504 가드). */
export function assertNoOtherInstance(work) {
  const ps = spawnSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' }).stdout
  // 셸·하네스 자신의 명령줄에도 경로가 들어 있다 — 앱·서버(herdr·Electron)만 본다.
  const hits = ps.split('\n').filter((line) => (line.includes(work) || /--session l490-/.test(line)) && /herdr|Electron|corral-electron/.test(line) && !/node .*l490\/|run\.sh|zsh -c/.test(line))
  if (hits.length > 0) throw new Error(`격리 경로 ${work} 를 쓰는 프로세스가 이미 있다 — 측정하지 않는다:\n${hits.join('\n')}`)
}

/**
 * 격리 corral 을 띄운다. 돌려주는 handle 의 `stop()` 이 띄운 것(herdr 서버·Electron)을 끈다.
 * `session` 은 herdr 세션 이름 — 회차마다 같은 work 를 지우고 다시 만든다.
 */
export async function launchIsolated({ appRoot, work, out, port, session }) {
  if (!work.startsWith('/tmp/l490')) throw new Error(`--work 는 /tmp/l490* 아래: ${work}`)
  assertNoOtherInstance(work)
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true, mode: 0o700 })
  const userData = path.join(work, 'ud')
  const herdrHome = path.join(work, 'hh')
  const control = path.join(work, 'ctl.sock')
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  const env = { ...process.env }
  for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE']) delete env[key]
  Object.assign(env, {
    CORRAL_USER_DATA: userData,
    CORRAL_UI_PREFS: path.join(work, 'ui-prefs.json'),
    HERDR_CONFIG_PATH: path.join(herdrHome, 'config.toml'),
    XDG_CONFIG_HOME: herdrHome,
    CORRAL_CONTROL_SOCKET: control,
    CORRAL_REGISTRY: path.join(userData, 'repos.json'),
    CORRAL_LOG: path.join(out, 'corral.ndjson'),
    SHELL: '/bin/sh',
  })
  const spawned = []
  fs.mkdirSync(herdrHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(herdrHome, 'config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const logFd = fs.openSync(path.join(out, 'backend.log'), 'a')
  const backend = spawn('herdr', ['--session', session, 'server'], { env, stdio: ['ignore', logFd, logFd] })
  fs.closeSync(logFd)
  spawned.push({ pid: backend.pid, label: 'herdr backend' })
  const socket = path.join(herdrHome, 'herdr/sessions', session, 'herdr.sock')
  const handle = { env, work, userData, control, socket, spawned, cdp: null, desktopPid: null }
  handle.stop = async () => {
    await handle.cdp?.close().catch(() => {})
    for (const row of [...handle.spawned].reverse()) {
      try {
        process.kill(row.pid, 'SIGTERM')
      } catch {
        // 이미 끝났다.
      }
    }
    await pause(1500)
    return handle.spawned.filter((row) => {
      try {
        process.kill(row.pid, 0)
        return true
      } catch {
        return false
      }
    })
  }
  try {
    await until(() => fs.existsSync(socket), 'backend socket', 30_000)
    env.CORRAL_BACKEND_SOCKET = socket
    env.CORRAL_SESSION = session
    await assertPortFree(port, 'corral l490')
    const wrapper = path.join(work, 'corral-electron')
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')}' --remote-debugging-port=${port} "$@"\n`, { mode: 0o755 })
    env.CORRAL_ELECTRON = wrapper
    await openDesktop(handle, { appRoot, port })
  } catch (error) {
    error.handle = handle
    throw error
  }
  return handle
}

/** `corral open` 으로 데스크톱을 띄우고 CDP 로 붙는다(재기동 회귀 K4ⓓ 가 다시 부른다). */
export async function openDesktop(handle, { appRoot, port }) {
  const opened = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), 'open', '--json'], { env: handle.env, encoding: 'utf8', timeout: 120_000 })
  if (opened.status !== 0) throw new Error(`open → ${opened.status}\n${opened.stdout}\n${opened.stderr}`)
  handle.desktopPid = JSON.parse(opened.stdout).result?.runtime?.pid ?? null
  handle.spawned.push({ pid: handle.desktopPid, label: 'corral desktop' })
  await until(() => fs.existsSync(handle.control), 'control socket', 60_000)
  await until(async () => (await rpc(handle.control, { cmd: 'state' })).state?.link?.phase === 'live', 'link live', 60_000)
  const { target } = await pickTarget(port, { label: 'corral', match: (entry) => /out\/renderer\/index\.html/.test(entry.url) })
  handle.cdp = await connect(target.webSocketDebuggerUrl)
  await handle.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await setViewport(handle.cdp, { width: 1200, height: 1100 })
  return handle
}

/** 데스크톱만 끈다(herdr 서버는 남긴다) — 재기동 회귀용. */
export async function closeDesktop(handle) {
  await handle.cdp?.close().catch(() => {})
  handle.cdp = null
  if (handle.desktopPid !== null) {
    try {
      process.kill(handle.desktopPid, 'SIGTERM')
    } catch {
      // 이미 끝났다.
    }
    await until(() => {
      try {
        process.kill(handle.desktopPid, 0)
        return false
      } catch {
        return true
      }
    }, 'desktop exit', 20_000)
  }
  handle.spawned = handle.spawned.filter((row) => row.pid !== handle.desktopPid)
  fs.rmSync(handle.control, { force: true })
}

/** herdr 백엔드 직접 RPC. */
export async function backend(handle, method, params = {}) {
  const response = await rpc(handle.socket, { id: `l490-${Date.now()}-${Math.random()}`, method, params })
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`)
  return response.result
}

export async function appState(handle) {
  return (await rpc(handle.control, { cmd: 'state' })).state
}

export const openWorkspaceOf = (state, wtPath) => state.repos.flatMap((repo) => repo.worktrees).find((row) => row.path === wtPath)?.openWorkspaceId ?? null

/**
 * 렌더러 계측을 심는다 — 페이지 시각(Date.now) 기준 사건 목록 `window.__l490.events`:
 *   `state`  : onState 도착(revision · 열린 workspace id)
 *   `mark`   : 사이드바 선택 표식이 가리키는 worktree 경로가 바뀜
 *   `active` : 렌더러 React 의 activeWorkspaceId 가 바뀜(표식 변화·state 도착 때 함께 읽는다)
 *   `ipc`    : openWorktree/createWorktree 요청·응답(감쌀 수 있을 때만 — `wrap` 결과를 함께 남긴다)
 * 제품 코드는 바꾸지 않는다. 다시 불러도 한 번만 심는다.
 */
export async function instrument(cdp) {
  return cdp.evaluate(() => {
    if (window.__l490) return { already: true, wrap: window.__l490.wrap }
    const probe = { events: [], wrap: {} }
    window.__l490 = probe
    const push = (event) => probe.events.push({ t: Date.now(), ...event })
    const readActive = () => {
      const el = document.querySelector('.sidebar [data-worktree], [data-worktree]')
      if (el === null) return { found: false }
      const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'))
      let fiber = key === undefined ? null : el[key]
      while (fiber) {
        const props = fiber.memoizedProps
        if (props !== null && typeof props === 'object' && Object.prototype.hasOwnProperty.call(props, 'activeWorkspaceId')) return { found: true, id: props.activeWorkspaceId }
        fiber = fiber.return
      }
      return { found: false }
    }
    probe.readActive = readActive
    const readMark = () => document.querySelector('[data-worktree-card-active="primary"]')?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null
    probe.readMark = readMark
    let lastMark = readMark()
    let lastActive = readActive().id ?? null
    const sample = (cause) => {
      const mark = readMark()
      if (mark !== lastMark) {
        lastMark = mark
        push({ kind: 'mark', mark, cause })
      }
      const active = readActive().id ?? null
      if (active !== lastActive) {
        lastActive = active
        push({ kind: 'active', active, cause })
      }
    }
    new MutationObserver(() => sample('dom')).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-worktree-card-active'] })
    window.corral.onState((state) => {
      const open = state.repos.flatMap((repo) => repo.worktrees).filter((row) => row.openWorkspaceId !== null).map((row) => row.openWorkspaceId)
      push({ kind: 'state', revision: state.revision, open })
      // React 커밋 뒤에 읽는다 — 같은 틱 안의 값은 아직 이전 렌더다.
      setTimeout(() => sample('state+0'), 0)
    })
    for (const name of ['openWorktree', 'createWorktree']) {
      try {
        const original = window.corral[name]
        window.corral[name] = async (...input) => {
          push({ kind: 'ipc', name, phase: 'request', input: input[0] })
          const result = await original(...input)
          push({ kind: 'ipc', name, phase: 'response', ok: result?.ok ?? null, workspaceId: result?.workspaceId ?? null })
          return result
        }
        probe.wrap[name] = window.corral[name] !== original
      } catch (error) {
        probe.wrap[name] = `error: ${String(error)}`
      }
    }
    return { already: false, wrap: probe.wrap }
  })
}

export async function drainEvents(cdp, since) {
  return cdp.evaluate((t0) => window.__l490.events.filter((event) => event.t >= t0), since)
}

export async function pageNow(cdp) {
  return cdp.evaluate(() => Date.now())
}

export async function readMark(cdp) {
  return cdp.evaluate(() => window.__l490.readMark())
}

/** K1ⓒ 세 축 — 표식 경로 · 탭바 탭 id · React activeWorkspaceId. */
export async function readTriple(cdp) {
  return cdp.evaluate(() => ({
    mark: window.__l490.readMark(),
    active: window.__l490.readActive(),
    tabs: [...document.querySelectorAll('[data-main-tab]')].map((el) => el.getAttribute('data-main-tab')),
  }))
}

/** 세 축이 모두 그 worktree 를 가리키나. */
export function tripleAgrees({ triple, state, wtPath }) {
  const ws = state.repos.flatMap((repo) => repo.worktrees).find((row) => row.path === wtPath)?.workspace ?? null
  const wsTabs = new Set((ws?.tabs ?? []).map((tab) => tab.tabId))
  const markOk = triple.mark === wtPath
  const activeOk = triple.active.found === true && ws !== null && triple.active.id === ws.workspaceId
  const tabsOk = ws !== null && triple.tabs.length > 0 && triple.tabs.every((id) => wsTabs.has(id))
  return { markOk, activeOk, tabsOk, all: markOk && activeOk && tabsOk, workspaceId: ws?.workspaceId ?? null }
}

/** 카드 제목을 실제 마우스 이벤트로 누른다(CDP Input). */
export async function clickTitle(cdp, wtPath) {
  const point = await cdp.evaluate((s) => {
    const el = document.querySelector(`[data-worktree="${s}"] [data-worktree-branch]`)
    el?.scrollIntoView({ block: 'center' })
    const r = el?.getBoundingClientRect()
    return r ? { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 } : null
  }, wtPath)
  if (point === null) throw new Error(`카드 없음: ${wtPath}`)
  await clickAt(cdp, point)
}

export async function clickAt(cdp, point) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
}

/**
 * 누른 뒤 판정 — 5초 안에 표식이 대상에 오는가, 온 뒤 5초 동안 떠나지 않는가(100ms 간격).
 * 돌려주는 `trace` 는 표식 관측 시각 목록(클릭 기준 ms).
 */
export async function judgeActivation(cdp, { wtPath, t0 }) {
  let reachedAt = null
  while (Date.now() - t0 < 5000) {
    if ((await readMark(cdp)) === wtPath) {
      reachedAt = Date.now() - t0
      break
    }
    await pause(100)
  }
  if (reachedAt === null) return { reachedAt, held: false, leftAt: null, leftTo: null }
  const holdStart = Date.now()
  while (Date.now() - holdStart < 5000) {
    const mark = await readMark(cdp)
    if (mark !== wtPath) return { reachedAt, held: false, leftAt: Date.now() - t0, leftTo: mark }
    await pause(100)
  }
  return { reachedAt, held: true, leftAt: null, leftTo: null }
}

/** 열린 workspace 를 전부 닫는다(링크 먼저, 주 체크아웃 나중 — herdr 부모 제약). */
export async function closeAllWorkspaces(handle) {
  const state = await appState(handle)
  const rows = state.repos.flatMap((repo) => repo.worktrees).filter((row) => row.openWorkspaceId !== null)
  const ordered = [...rows.filter((row) => row.isLinked), ...rows.filter((row) => !row.isLinked)]
  for (const row of ordered) await backend(handle, 'workspace.close', { workspace_id: row.openWorkspaceId })
  await until(async () => {
    await rpc(handle.control, { cmd: 'rebuild-tree' }, 30_000)
    const now = await appState(handle)
    return now.repos.flatMap((repo) => repo.worktrees).every((row) => row.openWorkspaceId === null) ? true : null
  }, 'all closed', 30_000, 300)
  return ordered.map((row) => ({ path: row.path, workspaceId: row.openWorkspaceId }))
}
