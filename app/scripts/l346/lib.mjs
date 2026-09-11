// LIFE-346 측정 하네스 — 앱을 띄우고 **화면의 버튼을 눌러** 행을 만들고 죽인 뒤,
// herdr 와 OS 에 직접 물어 그 결과를 확인한다.
//
// LIFE-344/345 의 하네스를 고치지 않고 따로 둔다: 저쪽 가드(`life344-`·`life345-` 접두)가 그
// 일감의 안전장치라 느슨하게 만들면 안 된다. 여기는 `life346-` 접두를 강제한다.
//
// 판정 근거의 원칙 (01-criteria.md §0):
//   관문 ④ — 기동 여부는 **시간이 아니라 관측**이다. `pane.process_info` 의 포그라운드를 본다
//   관문 ⑤ — 프로세스 사멸은 **OS 로** 확인한다. herdr 의 `{type:'ok'}` 는 근거가 아니다
//   관문 ⑥ — 사용자 `default` 세션에 쓰기 0건. 이 파일의 `socketPath` 가 코드로 막는다

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION = process.env.LIFE346_SESSION ?? 'life346-claude'
export const APP_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const REPO_DIR = path.dirname(APP_DIR)
export const RAW_DIR = path.join(REPO_DIR, 'specs/LIFE-346-session-lifecycle/raw/claude')

/** 사용자의 `default` 세션을 코드 레벨에서 막는다 (관문 ⑥). */
export function socketPath(session = SESSION) {
  if (!session.startsWith('life346-')) {
    throw new Error(`거부: 격리 세션이 아니다 (${session}). life346- 접두여야 한다`)
  }
  const target = path.join(os.homedir(), '.config', 'herdr', 'sessions', session, 'herdr.sock')
  const bytes = Buffer.byteLength(target, 'utf8')
  if (bytes > 104) throw new Error(`유닉스 소켓 경로 ${bytes} bytes — 104 한계를 넘는다`)
  return target
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const now = () => Date.now()

/** 요청 1건 = 커넥션 1개. 서버가 응답 뒤 스스로 닫는다 (스파이크 제약 2). */
export function request(method, params = {}, { session = SESSION, timeoutMs = 20000 } = {}) {
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
      const message = JSON.parse(line)
      if (message.error) reject(new Error(`${method}: ${message.error.code} ${message.error.message}`))
      else resolve(message.result)
    })
  })
}

/** push 전용 구독 커넥션 — 여기로는 절대 요청을 보내지 않는다 (제약 1). */
export class Sub {
  constructor() {
    this.events = []
    this.buffer = ''
    this.acked = false
  }
  connect(types, { session = SESSION } = {}) {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(socketPath(session))
      this.socket.setEncoding('utf8')
      this.socket.on('error', reject)
      this.socket.on('connect', () =>
        this.socket.write(
          JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: types } }) + '\n',
        ),
      )
      this.socket.on('data', (chunk) => {
        this.buffer += chunk
        for (;;) {
          const index = this.buffer.indexOf('\n')
          if (index === -1) break
          const line = this.buffer.slice(0, index)
          this.buffer = this.buffer.slice(index + 1)
          if (!line.trim()) continue
          let message
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (!this.acked) {
            this.acked = true
            resolve(message)
            continue
          }
          this.events.push({ at: Date.now(), event: message.event ?? message.data?.type ?? '?', data: message.data })
        }
      })
      setTimeout(() => reject(new Error('subscribe ack 10s 무응답')), 10000)
    })
  }
  drain() {
    const out = this.events
    this.events = []
    return out
  }
  close() {
    this.socket?.destroy()
  }
}

/** corral 이 구독하는 것과 같은 타입 묶음 — 대조가 같은 창을 보게 한다. */
export const LIFECYCLE_SUBS = [
  { type: 'workspace.closed' },
  { type: 'tab.created' },
  { type: 'tab.closed' },
  { type: 'pane.created' },
  { type: 'pane.closed' },
  { type: 'pane.exited' },
  { type: 'pane.agent_detected' },
]

// --- OS 관측 (관문 ⑤) -------------------------------------------------------

/** **프로세스가 살아 있나 — OS 에게 묻는다.** herdr 의 응답은 이 질문의 근거가 아니다. */
export function alive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 살아 있는데 내 것이 아니다. 우리가 만든 pane 에서는 안 나오지만 구분은 해 둔다.
    return error.code === 'EPERM'
  }
}

/** pane 의 shell PID 와 포그라운드 프로세스들. 종료 전에 찍어 두고 종료 뒤에 `alive` 로 묻는다. */
export async function paneProcesses(paneId) {
  const result = await request('pane.process_info', { pane_id: paneId })
  const info = result.process_info ?? {}
  return {
    shellPid: info.shell_pid ?? null,
    foreground: (info.foreground_processes ?? []).map((item) => ({
      pid: item.pid,
      name: item.name,
      argv0: item.argv0,
      cmdline: item.cmdline,
    })),
  }
}

/** herdr 쪽 진실 — N7 의 대조 상대. corral 상태와 **같은 시각에** 찍는다. */
export async function herdrTruth() {
  const [tabs, panes, workspaces] = await Promise.all([
    request('tab.list', {}),
    request('pane.list', {}),
    request('workspace.list', {}),
  ])
  return {
    tabs: tabs.tabs.map((item) => item.tab_id).sort(),
    panes: panes.panes.map((item) => item.pane_id).sort(),
    workspaces: workspaces.workspaces.map((item) => item.workspace_id).sort(),
  }
}

// --- 원자료 ----------------------------------------------------------------

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
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

/**
 * **`default` 소켓으로 나간 쓰기를 센다** (N8).
 *
 * 앱 로그의 `req.conn.open` 은 메서드와 socketPath 를 함께 남긴다. 읽기 화이트리스트 밖의
 * 메서드가 default 소켓 경로로 나갔으면 그 실행은 무효다.
 */
const WRITE_METHODS = ['pane.send_text', 'pane.send_keys', 'tab.create', 'agent.start', 'tab.close']
export function defaultSessionWrites(entries) {
  const rows = entries.filter(
    (entry) =>
      entry.tag === 'req.conn.open' &&
      typeof entry.socketPath === 'string' &&
      !entry.socketPath.includes('/sessions/') &&
      WRITE_METHODS.includes(entry.method),
  )
  return { count: rows.length, rows }
}

// --- 앱 ---------------------------------------------------------------------

export async function startApp({
  name,
  env = {},
  waitFor = (entries) => entries.some((entry) => entry.tag === 'link.phase' && entry.phase === 'live'),
  timeoutMs = 40000,
}) {
  const dir = path.join(RAW_DIR, '_runs', name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'app.ndjson')
  // 소켓만 짧은 경로에 둔다 — worktree 아래는 sun_path 104 bytes 를 넘는다 (LIFE-344 실측).
  const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l346-')), 'c.sock')
  const shotDir = path.join(RAW_DIR, 'shots', name)
  fs.rmSync(shotDir, { recursive: true, force: true })
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
      // 목록이 긴 화면을 한 장에 담기 위한 것뿐이다 — 5행이 스크롤 밖으로 나가면
      // 기동 배지가 샷에 안 찍혀 N2 의 근거가 그림에서 사라진다.
      CORRAL_WINDOW: '1180x1400',
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
    if (waitFor(readLog(logPath))) {
      ready = true
      break
    }
    await sleep(120)
  }
  if (!ready) console.error('[harness] waitFor 조건이 안 왔다 —', name)

  let shotSeq = 0
  const send = (frame, timeoutMs = 30000) => control(controlSocket, frame, { timeoutMs })

  return {
    child,
    logPath,
    controlSocket,
    shotDir,
    dir,
    entries: () => readLog(logPath),
    send,
    state: async () => (await send({ cmd: 'state' })).state,
    /** 샷 이름에 **순번과 시각**을 박는다 — 연속성이 파일 이름만으로 보여야 한다 (원자료 규칙). */
    shot: async (label, selector) => {
      const seq = String(++shotSeq).padStart(3, '0')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const response = await send({ cmd: 'shot', name: `${seq}-${label}-${stamp}`, ...(selector ? { selector } : {}) })
      return { ...response, seq, at: Date.now(), label }
    },
    /** 화면의 진짜 버튼을 누른다 (N6·N10 이 요구하는 경로). */
    click: (selector) => send({ cmd: 'click', selector }),
    query: (selector) => send({ cmd: 'query', selector }),
    key: (keyCode, modifiers = []) => send({ cmd: 'key', keyCode, modifiers }),
    paste: (text) => send({ cmd: 'paste', text }),
    selectPane: (paneId) => send({ cmd: 'select-pane', paneId }),
    find: (needle) => send({ cmd: 'term-find', needle }),
    /** 준비·뒷정리 전용 지름길. 판정 회차에는 쓰지 않는다 */
    createRow: (workspaceId, kind, label = null) => send({ cmd: 'create-row', workspaceId, kind, label }),
    closeRow: (tabId, confirmed = true) => send({ cmd: 'close-row', tabId, confirmed }),
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

/**
 * **조건이 참이 될 때까지 본다.** 고정 대기로 판정하지 않기 위한 도구다 (관문 ④) —
 * 기다린 시간도 함께 돌려주므로 "얼마나 걸렸나" 는 결과로 남고 판정의 근거는 관측이다.
 */
export async function until(check, { timeoutMs = 40000, everyMs = 200, what = 'condition' } = {}) {
  const startedAt = Date.now()
  for (;;) {
    const value = await check()
    if (value) return { ok: true, value, ms: Date.now() - startedAt }
    if (Date.now() - startedAt > timeoutMs) return { ok: false, value: null, ms: Date.now() - startedAt, what }
    await sleep(everyMs)
  }
}

/**
 * 격리 세션을 **workspace 1개 · 탭 1개** 로 되돌린다. workspace 를 통째로 다시 세운다 —
 * 마지막 탭을 닫으면 workspace 까지 닫히고(실측 ⓗ) 측정이 그 경로를 일부러 밟기 때문에,
 * "있으면 쓴다" 로 두면 회차마다 서로 다른 상태에서 출발하게 된다.
 */
export async function tidySession() {
  const workspaces = (await request('workspace.list', {})).workspaces
  for (const workspace of workspaces) {
    await request('workspace.close', { workspace_id: workspace.workspace_id }).catch(() => {})
  }
  await sleep(400)
  // **cwd 를 준다.** 안 주면 $HOME 에 서고, 그러면 `worktree.list` 가 `not_git_worktree` 로
  // 떨어져 A4 의 checkoutPath 경로를 아예 재지 못한다 (M1 1회차에서 그렇게 됐다).
  await request('workspace.create', { label: 'l346', cwd: REPO_DIR })
  await sleep(700)
  return (await request('tab.list', {})).tabs
}

/** corral 상태에서 목록 층의 id 집합만 뽑는다 — herdr 쪽과 같은 모양으로 맞춘다 (N7). */
export function corralIds(state) {
  return {
    workspaces: state.workspaces.map((row) => row.workspaceId).sort(),
    tabs: state.workspaces.flatMap((row) => row.tabs.map((tab) => tab.tabId)).sort(),
    panes: state.workspaces.flatMap((row) => row.panes.map((pane) => pane.paneId)).sort(),
  }
}

export const firstWorkspaceId = async (app) => (await app.state()).workspaces[0]?.workspaceId ?? null

/**
 * 화면에 그 선택자가 **나타날 때까지** 본다. 고정 대기로 누르면 아직 안 그려진 버튼을
 * 누르고 "실패" 로 적게 된다 — 실제로 첫 스모크에서 200ms 가 모자라 그렇게 됐다.
 */
export async function clickWhenVisible(app, selector, { timeoutMs = 10000 } = {}) {
  const seen = await until(async () => (await app.query(selector)).found.length > 0, {
    timeoutMs,
    everyMs: 100,
    what: selector,
  })
  if (!seen.ok) throw new Error(`화면에 안 나타났다: ${selector}`)
  const response = await app.click(selector)
  if (!response.ok) throw new Error(`못 눌렀다: ${selector}`)
  return { ...response, waitedMs: seen.ms }
}

/** `+ 새 행` → kind 고르기. **화면의 버튼만** 쓴다 (N10 의 "corral UI 조작만"). */
export async function createRowByUi(app, workspaceId, kind) {
  await clickWhenVisible(app, `[data-new-row="${workspaceId}"]`)
  const at = Date.now()
  await clickWhenVisible(app, `[data-launch-kind="${workspaceId}:${kind}"]`)
  return { at }
}
