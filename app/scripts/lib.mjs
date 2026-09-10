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
    selectPane: (paneId) => control(controlSocket, { cmd: 'select-pane', paneId }),
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
 *
 * `keep` 은 **닫지 않고 남길 workspace 수**다 (판정문 H1). 만든 것을 전부 닫아 버리면 흔들기가
 * 끝난 뒤 비교 대상이 `w1` 하나만 남아, "수렴 집합 == 실제 상태" 가 원소 1개짜리 비교가 된다.
 * A4 는 pane 7개(그중 churn 생존분 2개)를 비교했다 — 같은 강도가 되려면 생존분이 있어야 한다.
 * `keepAfterMs` 는 churn 시작으로부터 이만큼 지난 뒤에 만든 것부터 남긴다는 뜻이다
 * (남는 것이 전부 부트스트랩 이전 생성분이 되지 않게 시각을 흩는다).
 *
 * 남긴 것은 `stop()` 이 닫지 않는다 — 측정이 끝난 뒤 `tidySession()` 이 턴다.
 */
export function startChurn({ intervalMs = 150, keep = 0, keepAfterMs = 0 } = {}) {
  let running = true
  const startedAt = Date.now()
  const created = []
  const kept = []
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
          const survives = kept.length < keep && Date.now() - startedAt >= keepAfterMs
          created.splice(created.indexOf(workspaceId), 1)
          if (survives) {
            kept.push(workspaceId)
            events.push({ kind: 'keep', workspaceId, at: Date.now() })
          } else {
            await request('workspace.close', { workspace_id: workspaceId })
            events.push({ kind: 'close', workspaceId, at: Date.now() })
          }
        }
      } catch (error) {
        events.push({ kind: 'error', error: String(error), at: Date.now() })
      }
      await sleep(intervalMs)
    }
  })()
  return {
    events,
    kept,
    stop: async () => {
      running = false
      await loop
      for (const workspaceId of [...created]) {
        await request('workspace.close', { workspace_id: workspaceId }).catch(() => {})
      }
      return { kept: [...kept] }
    },
  }
}

/**
 * 격리 세션을 측정 사이의 기준 상태로 되돌린다 — **workspace 1개 · 탭 1개 · pane 1개.**
 *
 * workspace 만 정리하면 부족하다. `m-l2` 가 탭을 만들고 pane 을 스플릿하므로, 그걸 안 털면
 * 다음 측정이 "탭 2 · pane 3" 에서 시작한다 (실제로 K4 원자료에 그렇게 찍혔다).
 */
export async function tidySession() {
  const snapshot = await request('session.snapshot')
  const workspaces = snapshot.result?.snapshot?.workspaces ?? []
  for (const workspace of workspaces.slice(1)) {
    await request('workspace.close', { workspace_id: workspace.workspace_id }).catch(() => {})
  }
  const survivor = workspaces[0]
  if (survivor) {
    const after = await request('session.snapshot')
    const inner = after.result?.snapshot ?? {}
    const tabs = (inner.tabs ?? []).filter((tab) => tab.workspace_id === survivor.workspace_id)
    for (const tab of tabs.slice(1)) {
      await request('tab.close', { tab_id: tab.tab_id }).catch(() => {})
    }
    const firstTab = tabs[0]
    if (firstTab) {
      const panes = (inner.panes ?? []).filter((pane) => pane.tab_id === firstTab.tab_id)
      for (const pane of panes.slice(1)) {
        await request('pane.close', { pane_id: pane.pane_id }).catch(() => {})
      }
    }
  }
  return workspaces.length
}
