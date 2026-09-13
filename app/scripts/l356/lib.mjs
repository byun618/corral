// LIFE-356 측정 하네스 공통 — 격리 세션(life356-claude)의 herdr 소켓 + corral 앱 제어.
//
// 판정 근거의 원칙 (01-criteria.md 필수 관문):
//   ① 실제 실행 + 재현 가능한 원자료 — 전부 raw/claude/ 로
//   ④ UI 통과선은 좌표 클릭 / elementFromPoint (control.ts 의 click 이 그렇게 한다)
//   ⑤ 제3 오라클 — herdr 쪽 대조는 이 파일의 herdrRequest (corral 과 **다른 커넥션**)
//
// l353 의 lib.mjs 를 본떴다. 옛 lib 를 파라미터화하지 않고 새로 둔 이유: l353 lib 의
// park()·세션 가드·RAW_DIR 가 전부 LIFE-353 경로에 묶여 있어, 재사용하면 판정이 인용한
// 앞 라운드 원자료 폴더를 이 라운드 실행이 건드린다.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION = process.env.LIFE356_SESSION ?? 'life356-claude'
export const APP_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const REPO_DIR = path.dirname(APP_DIR)
export const RAW_DIR = path.join(REPO_DIR, 'specs/LIFE-356-lifecycle-ui/raw/claude')
/** 수정 회차 원자료를 앞 회차와 분리하는 하위 폴더 (l353 의 RAW_SUBDIR 규칙 그대로). */
export const RAW_SUBDIR = process.env.L356_RAW_SUBDIR ?? ''

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 사용자의 default 세션을 코드 레벨에서 막는다 (킥오프 격리 규칙). */
export function sessionDir(session = SESSION) {
  if (!session.startsWith('life356-')) {
    throw new Error(`거부: 격리 세션이 아니다 (${session}). life356- 접두여야 한다`)
  }
  return path.join(os.homedir(), '.config', 'herdr', 'sessions', session)
}

export function controlSocketPath(session = SESSION) {
  return path.join(sessionDir(session), 'herdr.sock')
}

// --- herdr 제3 오라클 (control 소켓, 요청 1건 = 커넥션 1개) ----------------------

/**
 * 요청 하나를 보내고 **원문 응답 줄**까지 돌려준다.
 *
 * L9 가 요구하는 것이 "거절이 소켓 error payload 로 실제 왔는지 채널 원자료" 라서,
 * 파싱된 결과만이 아니라 소켓에서 읽은 줄 그대로(`rawLine`)를 싣는다. 에러 응답도
 * reject 하지 않고 {error, rawLine} 으로 돌려준다 — 거절 실물이 측정 대상이다.
 */
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
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l356', method, params }) + '\n'))
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

/** 성공을 전제하는 짧은 형 — 에러면 던진다 (준비 걸음용. 측정 대상 호출은 herdrCall 로). */
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

export function pct(values, p) {
  const sorted = [...values].filter((value) => typeof value === 'number').sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
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

/**
 * 임시 git 레포를 만든다. worktree open/create/close 실측은 전부 이 위에서 돈다 —
 * 사용자 레포·worktree 는 읽기로도 안 건드린다.
 */
export function makeScratchRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `l356-${name}-`))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '-b', 'main', root], { encoding: 'utf8' })
  fs.writeFileSync(path.join(root, 'README.md'), `l356 scratch ${name}\n`)
  git('add', 'README.md')
  git('-c', 'user.email=l356@test', '-c', 'user.name=l356', 'commit', '-m', 'init')
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

/** 앞 실행 폴더를 지우지 않고 _discarded 로 치운다 (버린 회차 실물 커밋 규칙). */
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
  const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l356-')), 'c.sock')
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
    click: (selector) => send({ cmd: 'click', selector }),
    query: (selector) => send({ cmd: 'query', selector }),
    type: (text) => send({ cmd: 'type', text }),
    key: (keyCode, modifiers = []) => send({ cmd: 'key', keyCode, modifiers }),
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
