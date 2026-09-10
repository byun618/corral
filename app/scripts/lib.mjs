// 측정 하네스 공용 — 앱을 띄우고, 격리 세션을 흔들고, 앱의 로그를 되읽는다.
//
// 이 하네스는 herdr 를 **쓰는** 쪽이다 (workspace 생성·종료). 앱은 읽기만 한다
// (app/src/main/herdr/request.ts 의 ALLOWED_METHODS). 그래서 격리 가드가 여기 있다.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION = process.env.LIFE344_SESSION ?? 'life344-probe'
export const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const RAW_DIR = path.join(path.dirname(APP_DIR), 'specs/LIFE-344-bootstrap/raw/claude')

/** 사용자의 default 세션을 코드 레벨에서 막는다 (01-criteria.md §0.1). */
export function socketPath(session = SESSION) {
  if (!session.startsWith('life344-')) {
    throw new Error(`거부: 격리 세션이 아니다 (${session}). life344- 접두여야 한다`)
  }
  return path.join(os.homedir(), '.config', 'herdr', 'sessions', session, 'herdr.sock')
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 요청 1건 = 커넥션 1개. 하네스도 같은 규칙을 지킨다 (안 지키면 서버가 끊는다). */
export function request(method, params = {}, { session = SESSION, timeoutMs = 5000 } = {}) {
  const target = socketPath(session)
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
      const line = buffer.slice(0, index)
      socket.end()
      socket.destroy()
      resolve(JSON.parse(line))
    })
  })
}

/** 앱의 계측 제어 채널 (CORRAL_CONTROL_SOCKET). */
export function control(socketFile, frame, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketFile)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`control timeout: ${JSON.stringify(frame)}`))
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

export function readLog(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/** 앱을 띄우고 로그에 조건이 나타날 때까지 기다린다. */
export async function startApp({ name, env = {}, waitFor = (entries) => entries.some((e) => e.tag === 'link.phase' && e.phase === 'live'), timeoutMs = 30000 }) {
  const dir = path.join(RAW_DIR, '_runs', name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'app.ndjson')
  // 소켓만 짧은 경로에 둔다. worktree 아래(134 bytes)는 macOS 의 sun_path 104 bytes 를 넘어
  // Electron(Node 24)에서 bind 가 EINVAL 로 죽는다 — raw/claude/12-unix-socket-path-limit.json
  const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l344-')), 'c.sock')
  const shotDir = path.join(RAW_DIR, 'shots')
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
      ...env,
    },
  })
  const stdout = fs.createWriteStream(path.join(dir, 'stdout.txt'))
  child.stdout.pipe(stdout)
  child.stderr.pipe(stdout)
  child.on('error', (error) => console.error('[harness] spawn error', error))
  child.on('exit', (code, signal) => console.error('[harness] electron exit', code, signal))

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = readLog(logPath)
    if (waitFor(entries)) break
    await sleep(120)
  }
  return {
    child,
    logPath,
    controlSocket,
    shotDir,
    dir,
    entries: () => readLog(logPath),
    shot: (label) => control(controlSocket, { cmd: 'shot', name: label }),
    state: () => control(controlSocket, { cmd: 'state' }),
    verify: () => control(controlSocket, { cmd: 'verify' }),
    selectWorkspace: (workspaceId) => control(controlSocket, { cmd: 'select-workspace', workspaceId }),
    selectSession: (sessionName) => control(controlSocket, { cmd: 'select-session', name: sessionName }),
    stop: async () => {
      child.kill('SIGTERM')
      await sleep(500)
      if (!child.killed) child.kill('SIGKILL')
    },
  }
}

export function writeRaw(file, content) {
  const target = path.join(RAW_DIR, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  console.log('wrote', path.relative(process.cwd(), target))
  return target
}

/** 앱 로그에서 필요한 태그만 뽑아 원자료로 남긴다 (전문은 _runs/ 에 그대로 있다). */
export function sliceLog(entries, tags) {
  return entries.filter((entry) => tags.some((tag) => entry.tag === tag || entry.tag.startsWith(tag)))
}

/**
 * 격리 세션을 계속 흔든다 — 부트스트랩 창(구독 ack ~ 스냅샷 적용) 안에서 변화를 만들기 위한 것.
 * 스파이크 A4 가 본 "중복 create" 상황을 재현하는 자리이기도 하다.
 */
export function startChurn({ intervalMs = 150 } = {}) {
  let running = true
  const created = []
  const events = []
  const loop = (async () => {
    while (running) {
      try {
        const response = await request('workspace.create')
        const workspaceId = response.result?.workspace?.workspace_id
        if (workspaceId) {
          created.push(workspaceId)
          events.push({ kind: 'create', workspaceId, at: Date.now() })
        }
        await sleep(intervalMs)
        if (workspaceId) {
          await request('workspace.close', { workspace_id: workspaceId })
          events.push({ kind: 'close', workspaceId, at: Date.now() })
          created.splice(created.indexOf(workspaceId), 1)
        }
      } catch (error) {
        events.push({ kind: 'error', error: String(error), at: Date.now() })
      }
      await sleep(intervalMs)
    }
  })()
  return {
    events,
    stop: async () => {
      running = false
      await loop
      for (const workspaceId of [...created]) {
        await request('workspace.close', { workspace_id: workspaceId }).catch(() => {})
      }
    },
  }
}

/** 격리 세션에 남은 workspace 를 1개만 남기고 정리한다 (측정 사이 상태를 깨끗이). */
export async function tidySession() {
  const snapshot = await request('session.snapshot')
  const workspaces = snapshot.result?.snapshot?.workspaces ?? []
  for (const workspace of workspaces.slice(1)) {
    await request('workspace.close', { workspace_id: workspace.workspace_id }).catch(() => {})
  }
  return workspaces.length
}
