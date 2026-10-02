// LIFE-445 격리 실행 도우미 — 격리 corral 기동·종료, fixture 레포, 외부 git, DOM 관측, 미끼 창.
//
// 격리 (02-kickoff 격리 규칙 3): userData·ui-prefs·레지스트리·제어 소켓·로그·herdr 홈·fixture 레포가 전부 `/tmp/l445w/<이름>` 아래.
// herdr 꺼짐 조건은 **없는 소켓**을 `CORRAL_BACKEND_SOCKET` 으로 준다 — `listSessions` 가 `herdr session list` 를 부르지 않고
// 그 세션을 「멈춤」으로 본다(기본 세션 무접촉). herdr 켜짐 조건은 격리 herdr 세션(`l445-iso`)을 이 폴더 아래 홈으로 띄운다.
// git 호출 수(K4ⓑ)는 corral 쪽 PATH 앞에 둔 계수 shim 으로 센다 — 하네스 자신의 git 은 shim 을 거치지 않는다.
// 입력은 CDP Input(이 인스턴스 디버깅 포트의 페이지에만 간다 — OS 입력이 아니다). 창 포커스 아님 조건은 미끼 창(l471 decoy.swift)으로 만든다.

/* global document, CSS */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, pickTarget, until, setViewport, assertPortFree } from '../gui-diff/lib/cdp.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const appRoot = path.resolve(here, '../..')
export const REAL_GIT = '/usr/bin/git'
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export { until, rpc }

export function makeLogger(t0 = Date.now()) {
  return (...parts) => console.log(`[l445 +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)
}

/** 하네스 쪽 git — shim 을 거치지 않는다(계수에 안 섞인다). 종료 시각을 같이 돌려준다. */
export function git(cwd, ...rest) {
  const startedAt = Date.now()
  const res = spawnSync(REAL_GIT, rest, { cwd, encoding: 'utf8' })
  const endedAt = Date.now()
  if (res.status !== 0) throw new Error(`git ${rest.join(' ')} → ${res.status}\n${res.stderr}`)
  return { stdout: res.stdout.trim(), startedAt, endedAt }
}

export function load() {
  return execFileSync('uptime', { encoding: 'utf8' }).trim()
}
export function yesCount() {
  const res = spawnSync('pgrep', ['-x', 'yes'], { encoding: 'utf8' })
  return res.stdout.trim().split('\n').filter(Boolean).length
}

export class Work {
  constructor(name, { fresh = true } = {}) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`work 이름: ${name}`)
    this.dir = path.join('/tmp/l445w', name)
    if (!this.dir.startsWith('/tmp/l445w/')) throw new Error('G8')
    if (fresh) fs.rmSync(this.dir, { recursive: true, force: true })
    fs.mkdirSync(this.dir, { recursive: true })
    this.repos = path.join(this.dir, 'repos')
    fs.mkdirSync(this.repos, { recursive: true })
    this.bin = path.join(this.dir, 'bin')
    fs.mkdirSync(this.bin, { recursive: true })
    this.gitLog = path.join(this.dir, 'git-calls.log')
    fs.writeFileSync(this.gitLog, '')
    // 계수 shim — 한 줄 = git 프로세스 하나(초 단위 시각 + 인자). 구간 계수는 줄 수 차이로 한다.
    fs.writeFileSync(path.join(this.bin, 'git'), `#!/bin/sh\nprintf '%s %s\\n' "$(date +%s)" "$*" >> '${this.gitLog}'\nexec ${REAL_GIT} "$@"\n`, { mode: 0o755 })
  }
  /** 이 실행이 만든 fixture 인가 (G8) — 지우기 전에 확인한다. */
  owns(target) {
    const real = fs.realpathSync(this.repos)
    return path.resolve(target).startsWith(real + path.sep) || path.resolve(target).startsWith(this.repos + path.sep)
  }
  makeRepo(name, linked = []) {
    const root = path.join(this.repos, name)
    fs.mkdirSync(root, { recursive: true })
    git(root, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n')
    git(root, 'add', '-A')
    git(root, '-c', 'user.email=l445@example.invalid', '-c', 'user.name=l445', 'commit', '-q', '-m', 'init')
    const real = fs.realpathSync(root)
    for (const one of linked) this.addWorktree(real, one)
    return real
  }
  worktreePath(root, name) {
    return path.join(this.repos, `${path.basename(root)}-wt`, name)
  }
  /** 외부 추가 — 끝난 시각(endedAt)이 반영 시간의 시작점이다. */
  addWorktree(root, name) {
    const target = this.worktreePath(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const res = git(root, 'worktree', 'add', '-q', '-b', name, target)
    return { path: fs.realpathSync(target), endedAt: res.endedAt }
  }
  removeWorktree(root, target, { force = false } = {}) {
    if (!this.owns(target)) throw new Error(`G8: 이 실행이 만든 worktree 가 아니다 — ${target}`)
    return git(root, 'worktree', 'remove', ...(force ? ['--force'] : []), target)
  }
  deleteBranch(root, branch) {
    return git(root, 'branch', '-D', branch)
  }
  /** 이 레포의 git 이 보는 worktree 집합(디렉터리 있는 것 — runtime 규칙). */
  gitSet(root) {
    const out = git(root, 'worktree', 'list', '--porcelain').stdout
    return out
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .filter((target) => fs.existsSync(target))
      .map((target) => fs.realpathSync(target))
      .sort()
  }
  gitCalls() {
    return fs.readFileSync(this.gitLog, 'utf8').split('\n').filter(Boolean)
  }
}

/** 미끼 창 — corral 창이 포커스 아님 조건. 글자 입력을 받지 않는 창이다(l471). */
export class Decoy {
  constructor(work) {
    this.binary = path.join(work.bin, 'decoy')
    if (!fs.existsSync(this.binary)) {
      execFileSync('swiftc', ['-O', '-o', this.binary, path.join(appRoot, 'scripts/l471/decoy.swift')], { stdio: 'pipe' })
    }
    this.proc = null
    this.pid = null
  }
  async start() {
    this.proc = spawn(this.binary, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    this.pid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('decoy pid 안 옴')), 15_000)
      this.proc.stdout.once('data', (chunk) => {
        clearTimeout(timer)
        resolve(Number(String(chunk).trim()))
      })
    })
    await pause(600)
    return this.pid
  }
  front() {
    process.kill(this.pid, 'SIGUSR1')
  }
  stop() {
    try {
      process.kill(this.pid, 'SIGTERM')
    } catch {
      // 이미 끝났다
    }
  }
}

/** 맨 앞 앱 pid (lsappinfo) — 포커스 아님 조건 원자료. */
export function frontPid() {
  const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim()
  const info = execFileSync('lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8' })
  const match = info.match(/"?pid"?\s*=\s*(\d+)/)
  return match ? Number(match[1]) : null
}

/** 격리 corral 인스턴스. herdr: true 면 격리 herdr 세션을 같이 띄운다. */
export class Corral {
  constructor(work, { herdr = false, port = 9445, extraEnv = {}, log = console.log } = {}) {
    this.work = work
    this.herdr = herdr
    this.port = port
    this.log = log
    this.userData = path.join(work.dir, 'ud')
    this.herdrHome = path.join(work.dir, 'hh')
    this.control = path.join(work.dir, 'ctl.sock')
    this.logFile = path.join(work.dir, 'corral.ndjson')
    this.registryFile = path.join(this.userData, 'repos.json')
    this.session = herdr ? 'l445-iso' : 'l445-off'
    const env = { ...process.env }
    for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE', 'HERDR_PANE_ID', 'HERDR_SESSION', 'HERDR_SOCKET_PATH']) delete env[key]
    Object.assign(env, {
      CORRAL_USER_DATA: this.userData,
      CORRAL_UI_PREFS: path.join(work.dir, 'ui-prefs.json'),
      CORRAL_LOG: this.logFile,
      HERDR_CONFIG_PATH: path.join(this.herdrHome, 'config.toml'),
      HERDR_CONFIG_DIR: path.join(this.herdrHome, 'herdr'),
      XDG_CONFIG_HOME: this.herdrHome,
      CORRAL_CONTROL_SOCKET: this.control,
      CORRAL_REGISTRY: this.registryFile,
      SHELL: '/bin/sh',
      PATH: `${work.bin}:${process.env.PATH}`,
      ...extraEnv,
    })
    if (!herdr) {
      env.CORRAL_BACKEND_SOCKET = path.join(work.dir, 'no-herdr.sock')
      env.CORRAL_SESSION = this.session
    }
    this.env = env
    this.backend = null
    this.desktopPid = null
    this.cdp = null
    this.spawned = []
  }
  async startBackend() {
    fs.mkdirSync(this.herdrHome, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(this.herdrHome, 'config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
    const fd = fs.openSync(path.join(this.work.dir, 'backend.log'), 'a')
    this.backend = spawn('herdr', ['--session', this.session, 'server'], { env: this.env, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    this.spawned.push({ pid: this.backend.pid, label: 'herdr l445-iso' })
    const socket = path.join(this.herdrHome, 'herdr/sessions', this.session, 'herdr.sock')
    await until(() => fs.existsSync(socket), 'backend socket', 30_000)
    this.env.CORRAL_BACKEND_SOCKET = socket
    this.env.CORRAL_SESSION = this.session
  }
  /** 레지스트리를 기동 전에 써 둔다 — 기동 뒤 add 는 `add-repo` 제어로. */
  seedRegistry(roots) {
    fs.mkdirSync(this.userData, { recursive: true })
    fs.writeFileSync(this.registryFile, JSON.stringify({ version: 2, repos: roots, setups: [], worktrees: {} }, null, 2))
  }
  async launch() {
    if (this.herdr && this.backend === null) await this.startBackend()
    await assertPortFree(this.port, 'corral l445')
    const wrapper = path.join(this.work.dir, 'corral-electron')
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')}' --remote-debugging-port=${this.port} "$@"\n`, { mode: 0o755 })
    this.env.CORRAL_ELECTRON = wrapper
    const opened = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), 'open', '--json'], { env: this.env, encoding: 'utf8', timeout: 120_000 })
    if (opened.status !== 0) throw new Error(`open → ${opened.status}\n${opened.stdout}\n${opened.stderr}`)
    this.desktopPid = JSON.parse(opened.stdout).result?.runtime?.pid ?? null
    this.spawned.push({ pid: this.desktopPid, label: 'corral desktop' })
    await until(() => fs.existsSync(this.control), 'control socket', 60_000)
    if (this.herdr) await until(async () => (await rpc(this.control, { cmd: 'state' })).state?.link?.phase === 'live', 'link live', 60_000)
    const { target } = await pickTarget(this.port, { label: 'corral', match: (entry) => /out\/renderer\/index\.html/.test(entry.url) })
    this.cdp = await connect(target.webSocketDebuggerUrl)
    await setViewport(this.cdp, { width: 1200, height: 900 })
    await until(() => this.cdp.evaluate(() => document.querySelector('[data-repo-list]') !== null), 'sidebar rendered', 30_000)
    this.log('launched pid', this.desktopPid, 'herdr', this.herdr)
  }
  async quit() {
    await this.cdp?.close().catch(() => {})
    this.cdp = null
    if (this.desktopPid !== null) {
      try {
        process.kill(this.desktopPid, 'SIGTERM')
      } catch {
        // 이미 끝났다
      }
      await until(() => !alive(this.desktopPid), 'desktop exit', 30_000)
    }
    await until(() => !fs.existsSync(this.control), 'control gone', 15_000).catch(() => fs.rmSync(this.control, { force: true }))
    this.desktopPid = null
    if (this.backend !== null) {
      const pid = this.backend.pid
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // 이미 끝났다
      }
      await until(() => !alive(pid), 'backend exit', 15_000)
      this.backend = null
    }
  }
  /** 사이드바에 보이는 worktree 경로들(`[data-worktree]`) — 모든 구획을 합친 집합. */
  async domSet() {
    const list = await this.cdp.evaluate(() => Array.from(document.querySelectorAll('[data-worktree]')).map((el) => el.getAttribute('data-worktree')))
    return [...new Set(list)].sort()
  }
  async domCount(target) {
    return this.cdp.evaluate((p) => document.querySelectorAll(`[data-worktree="${CSS.escape(p)}"]`).length, target)
  }
  async focused() {
    return rpc(this.control, { cmd: 'window-visibility', action: 'read' })
  }
  logLines() {
    if (!fs.existsSync(this.logFile)) return []
    return fs
      .readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
  count(tag, from, to = Infinity) {
    return this.logLines().filter((entry) => entry.tag === tag && entry.at >= from && entry.at < to).length
  }
  cli(cwd, ...rest) {
    const res = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), ...rest, '--json'], { env: this.env, cwd, encoding: 'utf8', timeout: 60_000 })
    try {
      return { status: res.status, ...JSON.parse(res.stdout) }
    } catch {
      return { status: res.status, ok: false, raw: res.stdout + res.stderr }
    }
  }
  /** CDP 마우스로 버튼을 누른다 — 이 인스턴스 페이지에만 간다(OS 입력 아님). 히트테스트를 먼저 본다. */
  async click(selector) {
    const point = await this.cdp.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const top = document.elementFromPoint(x, y)
      return { x, y, hit: top !== null && (top === el || el.contains(top)) }
    }, selector)
    if (point === null || !point.hit) throw new Error(`click ${selector}: ${JSON.stringify(point)}`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
    }
    return Date.now()
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 반영 대기 — 250ms 이하 주기(여기 100ms)로 DOM 을 읽어 술어가 처음 참이 된 시각을 돌려준다.
 * 시간 초과면 null — 회차 실패로 적는다(재실행으로 덮지 않는다).
 */
export async function waitReflect(corral, predicate, { from, timeoutMs = 15_000, stepMs = 100 } = {}) {
  const deadline = from + timeoutMs
  let polls = 0
  let maxGap = 0
  let last = Date.now()
  while (Date.now() < deadline) {
    const set = await corral.domSet()
    polls += 1
    const now = Date.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
    if (predicate(set)) return { ms: now - from, at: now, polls, maxGapMs: maxGap, set }
    await pause(stepMs)
  }
  return { ms: null, at: null, polls, maxGapMs: maxGap, set: await corral.domSet() }
}
