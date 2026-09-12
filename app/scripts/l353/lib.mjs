// LIFE-353 측정 하네스 — 앱을 띄우고, 격리 세션의 pane 을 터미널로 붙이고, 두 오라클을
// 같은 시각에 떠서 맞춰 본다.
//
// 판정 근거의 원칙 (01-criteria.md §0):
//   ① 실제 실행 + 재현 가능한 원자료 — 전부 raw/claude/ 로
//   ④ 격리 — `life353-` 접두 세션만. PTY 는 `script(1)` 래퍼로 미리 띄운 세션을 쓴다
//   ⑤ 제3 오라클 — herdr 쪽 대조는 **control 소켓(herdr.sock)의 pane.read/pane.get**,
//      xterm 쪽은 렌더러 프로브(term-read). 벤더 코드 자신의 frame 은 판별자로 안 쓴다
//
// l351 의 lib.mjs 와 같은 뼈대(startApp·control·until·pct)를 쓰되, herdr 쪽 오라클이
// 목록(tab/pane id)이 아니라 **화면 내용**(pane.read visible)이라는 점이 다르다.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION = process.env.LIFE353_SESSION ?? 'life353-claude'
export const APP_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const REPO_DIR = path.dirname(APP_DIR)
export const RAW_DIR = path.join(REPO_DIR, 'specs/LIFE-353-terminal-streaming/raw/claude')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 사용자의 default 세션을 코드 레벨에서 막는다 (관문 ④). */
export function sessionDir(session = SESSION) {
  if (!session.startsWith('life353-')) {
    throw new Error(`거부: 격리 세션이 아니다 (${session}). life353- 접두여야 한다`)
  }
  return path.join(os.homedir(), '.config', 'herdr', 'sessions', session)
}

export function controlSocketPath(session = SESSION) {
  return path.join(sessionDir(session), 'herdr.sock')
}

// --- herdr 제3 오라클 (control 소켓, 요청 1건 = 커넥션 1개) ----------------------

export function herdrRequest(method, params = {}, { session = SESSION, timeoutMs = 20000 } = {}) {
  const target = controlSocketPath(session)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timeout ${method}`))
    }, timeoutMs)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'h1', method, params }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.end()
      socket.destroy()
      const message = JSON.parse(buffer.slice(0, index))
      if (message.error) reject(new Error(`${method}: ${message.error.code} ${message.error.message}`))
      else resolve(message.result)
    })
  })
}

/** control 소켓의 pane.read visible — S1·S3·S4 의 herdr 쪽 오라클. */
export async function herdrRead(paneId, source = 'visible') {
  const r = await herdrRequest('pane.read', { pane_id: paneId, source, format: 'text' })
  return r.read
}

/** control 소켓의 pane.get — 서버 권위 커서·스크롤·크기 (S3·S4·S5). */
export async function herdrPane(paneId) {
  const r = await herdrRequest('pane.get', { pane_id: paneId })
  return r.pane
}

export async function firstPaneId(session = SESSION) {
  const panes = (await herdrRequest('pane.list', {}, { session })).panes
  return panes[0]?.pane_id ?? null
}

// --- 원자료 -------------------------------------------------------------------

export function writeRaw(file, content) {
  const target = path.join(RAW_DIR, file)
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

export function pct(values, p) {
  const sorted = [...values].filter((value) => typeof value === 'number').sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

/** 조건이 참이 될 때까지 본다. 기다린 시간도 돌려준다 — 고정 대기로 판정하지 않기 위해서. */
export async function until(check, { timeoutMs = 20000, everyMs = 40, what = 'condition' } = {}) {
  const startedAt = Date.now()
  for (;;) {
    const value = await check()
    if (value) return { ok: true, value, ms: Date.now() - startedAt }
    if (Date.now() - startedAt > timeoutMs) return { ok: false, value: null, ms: Date.now() - startedAt, what }
    await sleep(everyMs)
  }
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

/** 앞 실행 폴더를 지우지 않고 _discarded 로 치운다 (L351 lib 와 같은 규칙). */
function park(dir) {
  if (!fs.existsSync(dir)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const parked = path.join(RAW_DIR, '_discarded', stamp, path.basename(dir))
  fs.mkdirSync(path.dirname(parked), { recursive: true })
  fs.renameSync(dir, parked)
}

export async function startApp({ name, env = {}, timeoutMs = 40000, registryFile } = {}) {
  const buildCheck = ensureBuilt()
  const dir = path.join(RAW_DIR, '_runs', name)
  park(dir)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'app.ndjson')
  const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l353-')), 'c.sock')
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
      CORRAL_WINDOW: '1400x900',
      ...env,
    },
  })
  const stdout = fs.createWriteStream(path.join(dir, 'stdout.txt'))
  child.stdout.pipe(stdout)
  child.stderr.pipe(stdout)
  child.on('error', (error) => console.error('[harness] spawn error', error))

  // link 이 live 가 될 때까지 (control 층이 목록을 받은 뒤라야 pane 선택이 먹는다)
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
    selectPane: (paneId) => send({ cmd: 'click', selector: `[data-pane="${paneId}"]` }),
    termRead: async () => (await send({ cmd: 'term-read' })).term,
    termCellWidth: async (text) => (await send({ cmd: 'term-cell-width', text })).width,
    wheel: (deltaY) => send({ cmd: 'wheel', deltaY }),
    resizeWindow: (width, height) => send({ cmd: 'resize-window', width, height }),
    readClipboard: async () => (await send({ cmd: 'read-clipboard' })).text,
    click: (selector) => send({ cmd: 'click', selector }),
    query: (selector) => send({ cmd: 'query', selector }),
    shot: async (label, selector) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const response = await send({ cmd: 'shot', name: `${label}-${stamp}`, ...(selector ? { selector } : {}) })
      const file = typeof response.file === 'string' ? path.relative(RAW_DIR, response.file) : response.file
      return { ...response, file, at: Date.now(), label }
    },
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

// --- 화면 대조 (S1) -----------------------------------------------------------

/**
 * pane 을 터미널로 붙일 수 있는 상태까지 앱을 데려간다.
 *
 * 레지스트리는 빈 채로 뜨므로(격리 경로) 먼저 REPO_DIR 을 등록해야 4단 목록에 그 pane 행이
 * 뜬다. 등록 → 목록에 paneId 등장 → **진짜 클릭** → streaming 까지 몰고 온다.
 */
export async function attachPane(app, paneId, { repoRoot = REPO_DIR } = {}) {
  await app.addRepo(repoRoot)
  const seen = await until(async () => (await app.query(`[data-pane="${paneId}"]`)).found.length > 0, {
    timeoutMs: 12000,
    what: 'pane row in DOM',
  })
  if (!seen.ok) throw new Error(`pane 행이 목록에 안 떴다: ${paneId}`)
  const clicked = await until(
    async () => {
      const r = await app.selectPane(paneId)
      return r.hit === true ? r : null
    },
    { timeoutMs: 8000, everyMs: 120, what: `${paneId} 클릭 히트` },
  )
  if (!clicked.ok) throw new Error(`pane 을 못 눌렀다(가려짐): ${paneId}`)
  const streaming = await until(async () => (await app.state()).terminal.phase === 'streaming', {
    timeoutMs: 12000,
    what: 'streaming',
  })
  if (!streaming.ok) throw new Error('streaming 이 안 왔다')
  return { clicked: clicked.value, rowMs: seen.ms, streamingMs: streaming.ms }
}

/** 후행 공백을 떼고 줄 배열을 정규화한다 — herdr·xterm 둘 다 같은 규칙으로 만든 뒤 비교. */
export function normalizeLines(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
}

/**
 * herdr 화면이 정지할 때까지 본다 (S1·S3·S4 의 "정착 화면").
 * pane.read visible 을 반복해 **연속 2회 같은** 내용이 나오면 정착으로 본다.
 */
export async function settleHerdr(paneId, { timeoutMs = 8000, everyMs = 100 } = {}) {
  const startedAt = Date.now()
  let previous = null
  let stable = 0
  for (;;) {
    const read = await herdrRead(paneId)
    const lines = normalizeLines(read.text)
    const key = lines.join('\n')
    if (key === previous) {
      stable += 1
      if (stable >= 2) return { lines, ms: Date.now() - startedAt }
    } else {
      stable = 0
      previous = key
    }
    if (Date.now() - startedAt > timeoutMs) return { lines, ms: Date.now() - startedAt, timedOut: true }
    await sleep(everyMs)
  }
}

/**
 * xterm 프레임이 멎을 때까지 본다 — lastSeq 가 연속 2회 안 바뀌면 정착.
 * S2 의 FIT_DEFER 간섭을 피하려면 크기도 안정돼야 한다 (cols·rows 불변 같이 확인).
 */
export async function settleXterm(app, { timeoutMs = 8000, everyMs = 100 } = {}) {
  const startedAt = Date.now()
  let previous = null
  let stable = 0
  for (;;) {
    const term = await app.termRead()
    const key = term === null ? '∅' : `${term.lastSeq}:${term.cols}x${term.rows}`
    if (key === previous && term !== null) {
      stable += 1
      if (stable >= 2) return { term, ms: Date.now() - startedAt }
    } else {
      stable = 0
      previous = key
    }
    if (Date.now() - startedAt > timeoutMs) return { term, ms: Date.now() - startedAt, timedOut: true }
    await sleep(everyMs)
  }
}

/** 두 화면(줄 배열)의 불일치 줄 목록. 빈 후행 줄은 양쪽에서 잘라 맞춘다. */
export function diffScreen(a, b) {
  const trim = (lines) => {
    const out = lines.map((line) => String(line).replace(/\s+$/g, ''))
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out
  }
  const aa = trim(a)
  const bb = trim(b)
  const mismatches = []
  const max = Math.max(aa.length, bb.length)
  for (let i = 0; i < max; i++) {
    if ((aa[i] ?? '') !== (bb[i] ?? '')) mismatches.push({ row: i, herdr: aa[i] ?? null, xterm: bb[i] ?? null })
  }
  return mismatches
}
