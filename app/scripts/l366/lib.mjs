// LIFE-366 측정 하네스 공통 — 격리 세션(life366)의 herdr 소켓 + corral 앱 제어.
//
// l357fix/lib.mjs 의 사본이다(같은 계보의 corral 자체 도구). 새로 두는 이유는 앞 라운드와 같다:
// RAW_DIR 이 raw/claude 여야 하고(02-kickoff.md 정체 표), 격리 세션 접두(life366)도 갈라야
// 이전 라운드 herdr 세션과 안 섞인다 (기준 관문 ④).
//
// 이 라운드에서 더한 것: **격리 HOME 가드**(L366_HOME) — 통합 설치·에이전트 기동이 사용자
// ~/.claude·~/.codex·~/.grok 에 절대 닿지 않게 코드 레벨에서 막는다.

import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION = process.env.LIFE366_SESSION ?? 'life366'
export const APP_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const REPO_DIR = path.dirname(APP_DIR)
// 라운드마다 원자료 폴더가 바뀐다(1회차 raw/gate1-fix, 2회차 raw/gate1-fix2) — 스크립트는
// 그대로 두고 env 로 갈아끼운다. 기존 폴더는 회차 기록으로 보존한다.
export const RAW_DIR =
  process.env.L366_RAW_DIR ?? path.join(REPO_DIR, 'specs/LIFE-366-session-identity/raw/claude')
export const RAW_SUBDIR = process.env.L366_RAW_SUBDIR ?? ''

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 사용자의 default 세션을 코드 레벨에서 막는다 (킥오프 격리 규칙).
 *
 * **세션 디렉터리도 격리 HOME 안이다** — 앞 라운드(l356·l357fix)는 `os.homedir()` 아래
 * `~/.config/herdr/sessions/<이름>` 을 썼는데, 이번 라운드는 herdr 서버 자체를 격리 HOME 으로
 * 띄워야 한다: pane 이 상속하는 HOME 이 곧 에이전트가 훅·트랜스크립트를 찾는 자리이기 때문이다
 * (herdr 에 config 디렉터리 override 환경변수가 없다 — `HERDR_CONFIG_PATH` 는 config 파일 하나뿐).
 * 그래서 세션 소켓도 `.tmp/l366-home/.config/herdr/...` 로 간다. 사용자 herdr 설정과 완전히 분리된다.
 */
export function sessionDir(session = SESSION) {
  if (!session.startsWith('life366')) {
    throw new Error(`거부: 격리 세션이 아니다 (${session}). life366 접두여야 한다`)
  }
  return path.join(isolatedHome(), '.config', 'herdr', 'sessions', session)
}

export function controlSocketPath(session = SESSION) {
  return path.join(sessionDir(session), 'herdr.sock')
}

// --- 격리 HOME (02-kickoff.md 격리 규칙) ----------------------------------------
//
// `herdr integration install` 은 HOME 을 보고 파일을 쓴다. 맨 HOME 으로 한 번 돌리면
// 사용자 ~/.claude/settings.json 이 바뀌고 그건 관문 ④ 위반 = 전체 재실행이다.
// 그래서 경로를 **함수로만** 얻게 하고, 그 함수가 worktree 밖·홈 디렉터리 자체를 거부한다.

/** 실물이 사는 자리 — `<worktree>/.tmp/l366-home` (02-kickoff.md 정체 표, .gitignore 됨). */
export const L366_HOME_REAL = process.env.L366_HOME ?? path.join(REPO_DIR, '.tmp/l366-home')

/**
 * 그 자리를 가리키는 **짧은 링크** — herdr 세션 소켓이 `$HOME/.config/herdr/...` 로 가는데
 * 이 worktree 경로가 길어서 유닉스 소켓 `sun_path`(104) 를 넘는다 (실측:
 * `local socket name length exceeds capacity of sun_path of sockaddr_un`).
 * corral 자신도 같은 한계를 알고 있다 (`main/unix-socket-path.ts`).
 * 그래서 HOME 으로 쓰는 이름만 짧게 두고, **파일은 킥오프가 정한 자리에 그대로** 산다.
 */
export const L366_HOME = process.env.L366_HOME_LINK ?? '/tmp/l366h'

/** 격리 HOME 을 확인하고(없으면 만들고) 돌려준다. 맨 HOME 이거나 실물이 .tmp 밖이면 던진다. */
export function isolatedHome() {
  const real = path.resolve(L366_HOME_REAL)
  if (real === os.homedir() || !real.startsWith(path.join(REPO_DIR, '.tmp'))) {
    throw new Error(`거부: 격리 HOME 실물이 <worktree>/.tmp/ 밖이다 (${real})`)
  }
  for (const dir of ['.claude/hooks', '.codex', '.grok/hooks']) {
    fs.mkdirSync(path.join(real, dir), { recursive: true })
  }
  const link = path.resolve(L366_HOME)
  if (!fs.existsSync(link) || fs.realpathSync(link) !== fs.realpathSync(real)) {
    fs.rmSync(link, { force: true, recursive: false })
    fs.symlinkSync(real, link)
  }
  // 링크가 실물을 가리키는지 **매번** 확인한다 — 이 한 줄이 격리의 마지막 방벽이다.
  if (fs.realpathSync(link) !== fs.realpathSync(real)) {
    throw new Error(`거부: 격리 HOME 링크가 실물을 안 가리킨다 (${link})`)
  }
  return link
}

/** 자식 프로세스에 물릴 환경 — HOME 을 격리본으로 갈아끼운다. */
export function isolatedEnv(extra = {}) {
  const home = isolatedHome()
  return { ...process.env, HOME: home, ...extra }
}

/** 격리 HOME 에 통합을 설치한다. 반환값은 CLI 출력 그대로 (원자료). */
export function installIntegration(target) {
  const env = isolatedEnv()
  const out = execFileSync('herdr', ['integration', 'install', target], { env, encoding: 'utf8' })
  return out.trim()
}

/** 통합 상태 표 — 격리 HOME 기준. `{target: state}` 로 돌려준다. */
export function integrationStatus({ home = 'isolated' } = {}) {
  const env = home === 'isolated' ? isolatedEnv() : process.env
  const out = execFileSync('herdr', ['integration', 'status'], { env, encoding: 'utf8' })
  const rows = {}
  for (const line of out.split('\n')) {
    const match = /^([a-z-]+):\s+(.*)$/.exec(line.trim())
    if (match === null) continue
    rows[match[1]] = match[2]
  }
  return { rows, raw: out }
}

/**
 * 격리 세션을 **비우고 새로 띄운다** (실측 재현성).
 *
 * herdr 세션은 실행 사이에 살아남고, `agent_session` 참조는 pane 에 한 번 박히면 안 지워진다
 * (`raw/claude/ref-semantics.json`). 그래서 안 비우면 지난 실행의 workspace 들이 **낡은 참조를
 * 든 채** 남아, 다음 실행의 corral 이 그 참조들까지 해소하려 든다 — 3차 실행에서 참조 17개가
 * 잡혀 비용 표가 망가졌고, 낡은 참조가 남긴 재탐색 백오프 때문에 새 파일이 제때 안 읽혔다.
 */
export async function resetSession(session = SESSION) {
  const env = isolatedEnv()
  const quiet = (args) => {
    try {
      return execFileSync('herdr', args, { env, encoding: 'utf8' }).trim()
    } catch (error) {
      return `실패: ${String(error.stderr ?? error.message).trim().slice(0, 200)}`
    }
  }
  const stopped = quiet(['session', 'stop', session])
  const deleted = quiet(['session', 'delete', session])
  await sleep(400)
  const started = await ensureSession(session)
  return { stopped, deleted, started }
}

/**
 * 격리 herdr 세션이 살아 있게 한다 — 없으면 띄운다.
 *
 * `herdr --session <이름>` 은 TUI 라 TTY 를 요구한다. `script -q /dev/null` 로 가짜 TTY 를 물려
 * 백그라운드로 띄운다 (실측: 소켓이 ~200ms 만에 뜬다).
 */
export async function ensureSession(session = SESSION) {
  const socket = controlSocketPath(session)
  if (fs.existsSync(socket)) {
    try {
      await herdrRequest('session.snapshot', {}, { session, timeoutMs: 3000 })
      return { started: false, socket }
    } catch {
      /* 소켓 파일만 남고 서버가 죽은 경우 — 아래로 떨어져 다시 띄운다. */
    }
  }
  const child = spawn('script', ['-q', '/dev/null', 'herdr', '--session', session], {
    detached: true,
    stdio: 'ignore',
    // **HOME 이 격리본이다** — 이 서버가 띄우는 pane 이 그 HOME 을 상속하고, 그 안에 설치된
    // 통합 훅이 뜬다. 맨 HOME 으로 띄우면 에이전트가 사용자 ~/.claude 에 트랜스크립트를 쓴다.
    env: isolatedEnv(),
  })
  child.unref()
  for (let i = 0; i < 60; i += 1) {
    await sleep(200)
    if (!fs.existsSync(socket)) continue
    try {
      await herdrRequest('session.snapshot', {}, { session, timeoutMs: 3000 })
      return { started: true, socket }
    } catch {
      /* 아직 준비 전 */
    }
  }
  throw new Error(`격리 세션 ${session} 이 안 떴다`)
}

// --- herdr 제3 오라클 (control 소켓, 요청 1건 = 커넥션 1개) ----------------------

export function herdrCall(method, params = {}, { session = SESSION, timeoutMs = 20000 } = {}) {
  const target = controlSocketPath(session)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target)
    socket.setEncoding('utf8')
    let buffer = ''
    const sentAt = Date.now()
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timeout ${method}`))
    }, timeoutMs)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l366', method, params }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.end()
      socket.destroy()
      const rawLine = buffer.slice(0, index)
      const message = JSON.parse(rawLine)
      resolve({
        method,
        params,
        sentAt,
        receivedAt: Date.now(),
        ms: Date.now() - sentAt,
        result: message.result,
        error: message.error ?? null,
        rawLine,
      })
    })
  })
}

export async function herdrRequest(method, params = {}, options = {}) {
  const response = await herdrCall(method, params, options)
  if (response.error) throw new Error(`${method}: ${response.error.code} ${response.error.message}`)
  return response.result
}

// --- 원자료 -------------------------------------------------------------------

export function writeRaw(file, content) {
  const target = path.join(RAW_DIR, RAW_SUBDIR, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  console.log('wrote', path.relative(REPO_DIR, target))
  return target
}

export function readLog(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { tag: 'unparsed', line }
      }
    })
}

/**
 * 조건이 참이 될 때까지 기다린다.
 *
 * ⚠ **타임아웃에 거부하지 않는다** — `{ ok: false }` 로 **정상 resolve** 한다. 그래서
 * `await until(...).then(() => true).catch(() => false)` 는 실패를 전부 `true` 로 읽는다.
 * 반드시 `(await until(...)).ok` 를 봐라 (fix4 에서 프로브 세 개가 이 함정에 있었다).
 */
export async function until(check, { timeoutMs = 20000, everyMs = 40, what = 'condition' } = {}) {
  const startedAt = Date.now()
  for (;;) {
    const value = await check()
    if (value) return { ok: true, value, ms: Date.now() - startedAt }
    if (Date.now() - startedAt > timeoutMs) return { ok: false, value: null, ms: Date.now() - startedAt, what }
    await sleep(everyMs)
  }
}

// --- 스크래치 레포 (worktree 실측용 — 사용자 레포 불가침) -------------------------

export function makeScratchRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `l366-${name}-`))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '-b', 'main', root], { encoding: 'utf8' })
  fs.writeFileSync(path.join(root, 'README.md'), `l366 scratch ${name}\n`)
  git('add', 'README.md')
  git('-c', 'user.email=l366@test', '-c', 'user.name=l366', 'commit', '-m', 'init')
  return { root: fs.realpathSync(root), git }
}

// --- 앱 -----------------------------------------------------------------------

let ensured = false
export function ensureBuilt() {
  if (ensured) return { built: false, reason: '이 프로세스에서 이미 확인' }
  ensured = true
  const built = path.join(APP_DIR, 'out/main/index.js')
  const newest = (dir) => {
    let max = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      max = Math.max(max, entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs)
    }
    return max
  }
  const srcAt = newest(path.join(APP_DIR, 'src'))
  const outAt = fs.existsSync(built) ? fs.statSync(built).mtimeMs : 0
  if (outAt >= srcAt) return { built: false, reason: '빌드가 소스보다 새것', srcAt, outAt }
  console.log('[harness] 빌드가 낡았다 — electron-vite build 를 돌린다')
  execFileSync('npm', ['run', 'build'], { cwd: APP_DIR, stdio: 'inherit' })
  return { built: true, srcAt, outAt }
}

function park(dir) {
  if (!fs.existsSync(dir)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const parked = path.join(RAW_DIR, RAW_SUBDIR, '_discarded', stamp, path.basename(dir))
  fs.mkdirSync(path.dirname(parked), { recursive: true })
  fs.renameSync(dir, parked)
}

export async function startApp({ name, env = {}, timeoutMs = 40000, registryFile } = {}) {
  const buildCheck = ensureBuilt()
  const dir = path.join(RAW_DIR, RAW_SUBDIR, '_runs', name)
  park(dir)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'app.ndjson')
  const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l366-')), 'c.sock')
  const shotDir = path.join(dir, 'shots')
  fs.mkdirSync(shotDir, { recursive: true })

  const child = spawn(path.join(APP_DIR, 'node_modules/.bin/electron'), ['.'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      // **격리 HOME 으로 띄운다** (관문 ④). corral 이 트랜스크립트를 찾는 뿌리가 `os.homedir()`
      // 이고 herdr 세션 소켓도 `$HOME/.config/herdr/` 밑이라, 여기서 HOME 을 안 갈아끼우면
      // 실측 앱이 **사용자 실물 홈**을 읽게 된다.
      ...isolatedEnv(),
      CORRAL_LOG: logPath,
      CORRAL_SESSION: SESSION,
      CORRAL_CONTROL_SOCKET: controlSocket,
      CORRAL_SHOT_DIR: shotDir,
      CORRAL_REGISTRY: registryFile ?? path.join(dir, 'repos.json'),
      CORRAL_WINDOW: '1400x950',
      ...env,
    },
  })
  const stdout = fs.createWriteStream(path.join(dir, 'stdout.txt'))
  child.stdout.pipe(stdout)
  child.stderr.pipe(stdout)
  child.on('error', (error) => console.error('[harness] spawn error', error))

  const deadline = Date.now() + timeoutMs
  let ready = false
  while (Date.now() < deadline) {
    if (readLog(logPath).some((entry) => entry.tag === 'link.phase' && entry.phase === 'live')) {
      ready = true
      break
    }
    await sleep(120)
  }
  if (!ready) console.error('[harness] link live 가 안 왔다 —', name)

  const send = (frame, ms = 30000) => control(controlSocket, frame, { timeoutMs: ms })

  const clicks = []

  return {
    child,
    logPath,
    dir,
    shotDir,
    buildCheck,
    ready,
    entries: () => readLog(logPath),
    send,
    state: async () => (await send({ cmd: 'state' })).state,
    addRepo: (root) => send({ cmd: 'add-repo', root }),
    click: async (selector) => {
      const r = await send({ cmd: 'click', selector })
      clicks.push({
        selector,
        hit: r.hit ?? null,
        x: r.x ?? null,
        y: r.y ?? null,
        target: r.target ?? null,
        elementFromPoint: r.elementFromPoint ?? null,
        method: r.method ?? null,
        at: r.at ?? null,
      })
      return r
    },
    /** 더블클릭 — 인라인 리네임 진입(I-7). `click` 과 같은 좌표·가림 판정을 쓴다. */
    dblclick: async (selector) => {
      const r = await send({ cmd: 'dblclick', selector })
      clicks.push({ selector, hit: r.hit ?? null, x: r.x ?? null, y: r.y ?? null, target: r.target ?? null, method: 'dblclick', at: r.at ?? null })
      return r
    },
    clickLog: () => clicks,
    rawChain: () => {
      if (!fs.existsSync(logPath)) return { file: null, sha256: null, bytes: 0 }
      const buf = fs.readFileSync(logPath)
      return {
        file: path.relative(RAW_DIR, logPath),
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        bytes: buf.length,
      }
    },
    query: (selector) => send({ cmd: 'query', selector }),
    type: (text) => send({ cmd: 'type', text }),
    key: (keyCode, modifiers = []) => send({ cmd: 'key', keyCode, modifiers }),
    shot: async (label, selector) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const response = await send({ cmd: 'shot', name: `${label}-${stamp}`, ...(selector ? { selector } : {}) })
      const file = typeof response.file === 'string' ? path.relative(RAW_DIR, response.file) : response.file
      return { ...response, file, at: Date.now(), label }
    },
    resizeWindow: (width, height) => send({ cmd: 'resize-window', width, height }),
    flushStorage: () => send({ cmd: 'flush-storage' }),
    computedStyle: (selector, properties) => send({ cmd: 'computed-style', selector, properties }),
    rect: (selector) => send({ cmd: 'rect', selector }),
    stop: async () => {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      const won = await Promise.race([exited, sleep(2500).then(() => 'timeout')])
      if (won === 'timeout') {
        child.kill('SIGKILL')
        await Promise.race([exited, sleep(1500)])
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      stdout.end()
      await sleep(200)
    },
  }
}

export function control(socketFile, frame, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketFile)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`control timeout: ${JSON.stringify(frame).slice(0, 120)}`))
    }, timeoutMs)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => socket.write(JSON.stringify(frame) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      const line = buffer.slice(0, index)
      socket.end()
      socket.destroy()
      resolve(JSON.parse(line))
    })
  })
}

// --- fixture 도우미 (게이트 ① 수정 라운드) -------------------------------------
//
// 01-criteria.md 부록 "세션 용어 확정" 이후로 **사이드바 세션(에이전트 탭)과 탭바 세션(전체 탭)
// 이 다른 수**다. 그래서 fixture 는 두 종류를 섞어 만들어야 한다 — 같은 수가 나오는 fixture
// 로는 이 구분이 증명되지 않는다(부록 명시).

/** worktree 블록의 ⋯메뉴를 열어 탭 하나를 만든다. kind: 'shell' | 'claude' | 'codex' | 'grok'. */
export async function createTab(app, worktreePath, kind) {
  await app.click(`[data-worktree-menu-toggle="${worktreePath}"]`)
  const selector =
    kind === 'shell'
      ? `[data-worktree-create-shell="${worktreePath}"]`
      : `[data-worktree-create-agent="${worktreePath}"][data-kind="${kind}"]`
  return app.click(selector)
}

export async function workspaceOf(app, worktreePath) {
  const state = await app.state()
  return state.repos.flatMap((r) => r.worktrees).find((w) => w.path === worktreePath)?.workspace ?? null
}

export async function tabsOf(app, worktreePath) {
  return (await workspaceOf(app, worktreePath))?.tabs ?? []
}

/** 에이전트가 붙은 탭 — 렌더러 `session-title.ts` 의 `isAgentTab` 과 같은 판별식이다. */
export function agentTabsOf(tabs) {
  return tabs.filter((tab) => tab.panes.some((pane) => pane.agent !== null))
}

/**
 * 혼합 fixture — 에이전트 탭 `agents` 개 + 셸 탭 `shells` 개가 될 때까지 만든다.
 * worktree 를 열면 herdr 가 기본 셸 탭 1개를 이미 만들어 두므로 그 몫을 빼고 만든다.
 */
export async function buildMixedFixture(app, worktreePath, { agents, shells }) {
  const log = []
  // **목표치까지** 만든다 — "몇 개 더"가 아니라 "몇 개가 되게". 아래 셸 루프는 원래 목표치
  // 방식이었는데 에이전트 루프만 증분이라, 이미 에이전트가 있는 worktree 에 다시 부르면
  // 목표를 넘겨 버렸다(C9 규칙② 가 2→3 을 재려다 4개가 돼 실패했다).
  for (;;) {
    const before = agentTabsOf(await tabsOf(app, worktreePath)).length
    if (before >= agents) break
    const click = await createTab(app, worktreePath, 'claude')
    const ok = await until(async () => agentTabsOf(await tabsOf(app, worktreePath)).length > before, {
      timeoutMs: 20000,
      everyMs: 200,
      what: `agent tab ${before + 1}`,
    })
    log.push({ kind: 'claude', index: before + 1, clickHit: click.hit, reached: ok.ok, ms: ok.ms })
    if (!ok.ok) break
  }
  for (;;) {
    const tabs = await tabsOf(app, worktreePath)
    const shellCount = tabs.length - agentTabsOf(tabs).length
    if (shellCount >= shells) break
    const click = await createTab(app, worktreePath, 'shell')
    const want = shellCount + 1
    const ok = await until(
      async () => {
        const next = await tabsOf(app, worktreePath)
        return next.length - agentTabsOf(next).length >= want
      },
      { timeoutMs: 15000, everyMs: 200, what: `shell tab ${want}` },
    )
    log.push({ kind: 'shell', index: want, clickHit: click.hit, reached: ok.ok, ms: ok.ms })
    if (!ok.ok) break
  }
  const tabs = await tabsOf(app, worktreePath)
  return {
    log,
    tabCount: tabs.length,
    agentTabCount: agentTabsOf(tabs).length,
    shellTabCount: tabs.length - agentTabsOf(tabs).length,
    tabs: tabs.map((tab) => ({
      tabId: tab.tabId,
      number: tab.number,
      agents: tab.panes.map((pane) => pane.agent),
      isAgentTab: tab.panes.some((pane) => pane.agent !== null),
    })),
  }
}
