// LIFE-357 게이트 ① 수정 라운드 측정 하네스 공통 — 격리 세션(life357-fix)의 herdr 소켓 +
// corral 앱 제어.
//
// l357orca/lib.mjs 의 사본이다(같은 브랜치 계보의 공통 도구 — corral 자체 코드). 새로 두는
// 이유: RAW_DIR 이 raw/gate1-fix 여야 하고(09-gate1-fix.md "기존 raw/claude·raw/claude-orca 는
// 판정 기록이니 보존"), 격리 세션 접두도 갈라야 이전 라운드 herdr 세션과 안 섞인다.

import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION = process.env.LIFE357FIX_SESSION ?? 'life357-fix'
export const APP_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const REPO_DIR = path.dirname(APP_DIR)
export const RAW_DIR = path.join(REPO_DIR, 'specs/LIFE-357-layout-redesign/raw/gate1-fix')
export const RAW_SUBDIR = process.env.L357FIX_RAW_SUBDIR ?? ''

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 사용자의 default 세션을 코드 레벨에서 막는다 (킥오프 격리 규칙). */
export function sessionDir(session = SESSION) {
  if (!session.startsWith('life357-fix')) {
    throw new Error(`거부: 격리 세션이 아니다 (${session}). life357-fix 접두여야 한다`)
  }
  return path.join(os.homedir(), '.config', 'herdr', 'sessions', session)
}

export function controlSocketPath(session = SESSION) {
  return path.join(sessionDir(session), 'herdr.sock')
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
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l357fix', method, params }) + '\n'))
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `l357fix-${name}-`))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '-b', 'main', root], { encoding: 'utf8' })
  fs.writeFileSync(path.join(root, 'README.md'), `l357fix scratch ${name}\n`)
  git('add', 'README.md')
  git('-c', 'user.email=l357fix@test', '-c', 'user.name=l357fix', 'commit', '-m', 'init')
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
  const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l357fix-')), 'c.sock')
  const shotDir = path.join(dir, 'shots')
  fs.mkdirSync(shotDir, { recursive: true })

  const child = spawn(path.join(APP_DIR, 'node_modules/.bin/electron'), ['.'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
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
  for (let i = 0; i < agents; i++) {
    const click = await createTab(app, worktreePath, 'claude')
    const want = i + 1
    const ok = await until(async () => agentTabsOf(await tabsOf(app, worktreePath)).length >= want, {
      timeoutMs: 20000,
      everyMs: 200,
      what: `agent tab ${want}`,
    })
    log.push({ kind: 'claude', index: want, clickHit: click.hit, reached: ok.ok, ms: ok.ms })
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
