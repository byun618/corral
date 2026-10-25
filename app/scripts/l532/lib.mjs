// LIFE-532 최종 관문 공통 — 격리 corral(Electron) + 격리 herdr 루트. 사용자 userData·~/.config/herdr·설치본은 쓰지 않는다.
// 대기 헬퍼는 시간 초과면 **던진다** — 시간 초과를 통과로 읽는 경로가 없다. 판정은 check() 가 세고, 끝에 failures 로 종료코드를 낸다.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

export const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
export const HERE = path.join(APP, 'scripts/l532')
export const REAL_HERDR = '/opt/homebrew/bin/herdr'
const ELECTRON = path.join(APP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

let failures = 0
export function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} (실측 ${JSON.stringify(actual)}${ok ? '' : ` / 기대 ${JSON.stringify(expected)}`})`)
  return ok
}
export function fail(label) {
  failures += 1
  console.log(`FAIL ${label}`)
}
export function finish() {
  console.log(`failures=${failures}`)
  process.exit(failures === 0 ? 0 : 1)
}
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 조건이 참이 될 때까지 — 시간 초과면 던진다(성공으로 읽지 않는다). */
export async function until(label, fn, timeoutMs = 30_000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(stepMs)
  }
  throw new Error(`시간 초과(${timeoutMs}ms): ${label}`)
}

/** Claude 세션 변수를 뺀 최소 env — `env -i` 와 같은 꼴. */
export function cleanEnv(extra = {}) {
  return {
    HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, LANG: 'en_US.UTF-8', SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/tmp/l532t/',
    ...extra,
  }
}

export class Iso {
  constructor(root) {
    this.root = root
    this.xdg = path.join(root, 'xdg')
    this.ud = path.join(root, 'ud')
    this.log = path.join(root, 'corral.ndjson')
    this.ctl = path.join(root, 'ctl.sock')
    this.pids = []
  }

  /** 루트를 새로 만든다 — 지정 경로가 /tmp/l532 접두사가 아니면 거절(다른 곳을 지우지 않는다). */
  fresh() {
    if (!this.root.startsWith('/tmp/l532')) throw new Error(`격리 루트가 /tmp/l532* 가 아니다: ${this.root}`)
    if (fs.existsSync(this.root)) spawnSync('/bin/chmod', ['-R', 'u+rwx', this.root])
    fs.rmSync(this.root, { recursive: true, force: true })
    fs.mkdirSync(path.join(this.xdg, 'herdr'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.ud, { recursive: true })
    fs.chmodSync(this.root, 0o700)
    fs.copyFileSync(path.join(HERE, 'fake-herdr.sh'), path.join(this.root, 'herdr'))
    fs.chmodSync(path.join(this.root, 'herdr'), 0o755)
    this.knob('fake-list', 'pass')
  }

  knob(name, value) {
    const file = path.join(this.root, name)
    if (value === null) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, value)
    console.log(`## 손잡이 ${name} = ${value === null ? '(없음)' : value}`)
  }

  /** 격리 herdr default 서버 — 실제 XDG(짧은 경로)로. */
  async startServer(xdg = this.xdg) {
    const out = fs.openSync(path.join(this.root, 'herdr-server.out'), 'a')
    const child = spawn(REAL_HERDR, ['server'], { env: cleanEnv({ XDG_CONFIG_HOME: xdg }), detached: true, stdio: ['ignore', out, out] })
    child.unref()
    this.pids.push({ pid: child.pid, what: 'herdr server' })
    console.log(`## 격리 herdr server pid ${child.pid} (XDG ${xdg})`)
    await until('격리 서버 소켓', () => fs.existsSync(path.join(xdg, 'herdr', 'herdr.sock')), 20_000)
    await until('격리 서버 running', () => this.herdr(['session', 'list', '--json'], xdg).includes('"running":true'), 20_000)
    return child.pid
  }

  herdr(args, xdg = this.xdg) {
    const result = spawnSync(REAL_HERDR, args, { env: cleanEnv({ XDG_CONFIG_HOME: xdg }), encoding: 'utf8', timeout: 15_000 })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  }

  stopServer(xdg = this.xdg) {
    console.log(`## 격리 서버 stop: ${this.herdr(['server', 'stop'], xdg).trim().slice(0, 200)}`)
  }

  /** 격리 corral — 바인딩 env 는 extra 로. 앱 XDG 는 appXdg(기본 실제 경로). */
  async launch({ extra = {}, appXdg = this.xdg, label = 'app' } = {}) {
    const out = fs.openSync(path.join(this.root, `electron-${label}.log`), 'a')
    const env = cleanEnv({
      XDG_CONFIG_HOME: appXdg, CORRAL_USER_DATA: this.ud, CORRAL_RUNTIME_SOCKET: path.join(this.root, 'rt.sock'), CORRAL_CONTROL_SOCKET: this.ctl,
      CORRAL_LOG: this.log, CORRAL_SHOT_DIR: path.join(this.root, 'shots'), CORRAL_HERDR_BIN: path.join(this.root, 'herdr'), ...extra,
    })
    for (const key of Object.keys(env)) if (/^CLAUDE/.test(key)) throw new Error(`Claude 변수가 env 에 있다: ${key}`)
    const child = spawn(ELECTRON, [APP, `--user-data-dir=${this.ud}`], { env, detached: false, stdio: ['ignore', out, out] })
    this.app = child
    this.pids.push({ pid: child.pid, what: `electron ${label}` })
    console.log(`## 격리 corral pid ${child.pid} · env 키 ${Object.keys(env).sort().join(',')}`)
    await until('control 소켓', () => fs.existsSync(this.ctl), 30_000)
    await until('state 응답', async () => (await this.state().catch(() => null)) !== null, 30_000)
    return child.pid
  }

  async quit() {
    const child = this.app
    if (!child || child.exitCode !== null) return
    const done = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    await done
    clearTimeout(timer)
    fs.rmSync(this.ctl, { force: true })
    console.log(`## 격리 corral ${child.pid} 종료`)
  }

  /** 격리 git 레포를 만들어 둔다 — 사이드바 행·pane 을 보려면 등록된 레포와 그 cwd 의 workspace 가 있어야 한다. */
  makeRepo() {
    const repo = path.join(fs.realpathSync(this.root), 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const git = (args) => spawnSync('/usr/bin/git', args, { cwd: repo, env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null' }), encoding: 'utf8' })
    git(['init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(repo, 'README.md'), 'l532\n')
    git(['add', '.'])
    git(['-c', 'user.name=l532', '-c', 'user.email=l532@invalid', 'commit', '-q', '-m', 'init'])
    this.repo = repo
    return repo
  }

  async addRepo() {
    const reply = await rpc(this.ctl, { cmd: 'add-repo', root: this.repo }, 15_000)
    console.log(`## add-repo: ${JSON.stringify(reply).slice(0, 200)}`)
    return reply
  }

  async state() {
    const reply = await rpc(this.ctl, { cmd: 'state' }, 15_000)
    return reply.state
  }

  async evalJs(code) {
    const reply = await rpc(this.ctl, { cmd: 'eval', code }, 15_000)
    if (reply.ok === false) throw new Error(`eval 실패: ${JSON.stringify(reply).slice(0, 300)}`)
    return reply.result
  }

  async shot(name) {
    const reply = await rpc(this.ctl, { cmd: 'shot', name }, 30_000)
    console.log(`## shot ${name}: ${JSON.stringify(reply)}`)
    return reply.file
  }

  /** 카드·배너·사이드바·pane DOM 덤프 (G2 — 카드 판정은 DOM 으로만). */
  dom() {
    return this.evalJs(`(() => {
      const card = document.querySelector('[data-backend-card]')
      return {
        at: Date.now(),
        card: card ? {
          kind: card.getAttribute('data-backend-card'), cause: card.getAttribute('data-backend-cause'),
          title: card.querySelector('.backend-card-title')?.innerText ?? null,
          line: card.querySelector('.backend-card-line')?.innerText ?? null,
          error: card.querySelector('[data-backend-error]')?.innerText ?? null,
          buttons: Array.from(card.querySelectorAll('button')).map((b) => ({ text: b.innerText, retry: b.hasAttribute('data-backend-retry'), start: b.hasAttribute('data-backend-start') })),
        } : null,
        banner: document.querySelector('[data-backend-banner]')?.innerText ?? null,
        spaceRows: document.querySelectorAll('[data-space-row]').length,
        worktrees: document.querySelectorAll('[data-worktree]').length,
        tabs: document.querySelectorAll('[data-tab]').length,
        panes: document.querySelectorAll('[data-pane]').length,
        termPanes: document.querySelectorAll('[data-term-pane]').length,
        termEmpty: !!document.querySelector('[data-term-empty]'),
        termText: (document.querySelector('.xterm-rows')?.innerText ?? '').trim().slice(0, 120),
      }
    })()`)
  }

  /** 렌더러 이벤트로 「다시 시도」 클릭 — 요소가 정확히 하나여야 한다. */
  clickRetry() {
    return this.evalJs(`(() => { const all = document.querySelectorAll('[data-backend-retry]'); if (all.length !== 1) return { clicked: false, count: all.length }; all[0].click(); return { clicked: true, count: 1, at: Date.now() } })()`)
  }

  lines(tag) {
    if (!fs.existsSync(this.log)) return []
    return fs.readFileSync(this.log, 'utf8').split('\n').filter((line) => line.includes(`"tag":"${tag}"`)).map((line) => JSON.parse(line))
  }

  /** G7 — 그 인스턴스 로그의 input.raw 수 · 창 포커스 수(link.resync('window-focus') 흔적). 로그를 지우기 전에 부른다. */
  g7() {
    const text = fs.existsSync(this.log) ? fs.readFileSync(this.log, 'utf8') : ''
    const inputRaw = text.split('\n').filter((line) => line.includes('"tag":"input.raw"')).length
    const focus = text.split('\n').filter((line) => line.includes('window-focus')).length
    console.log(`## G7 ${this.root}: input.raw ${inputRaw} · window-focus 흔적 ${focus}`)
    return { inputRaw, focus }
  }
}

/** sessions.scan 의 streak 이 n 인 줄이 나올 때까지 — 그 줄을 돌려준다. */
export async function waitStreak(iso, n, timeoutMs = 20_000) {
  return until(`sessions.scan streak ${n}`, () => iso.lines('sessions.scan').find((line) => line.streak === n), timeoutMs, 100)
}
