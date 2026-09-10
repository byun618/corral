// LIFE-345 측정 하네스 — 앱을 띄우고, 격리 pane 을 흔들고, **렌더러의 진짜 버퍼**를 뜬다.
//
// LIFE-344 의 `scripts/lib.mjs` 를 고치지 않고 따로 둔다: 저쪽 가드(`life344-` 접두)가 그 일감의
// 안전장치라 느슨하게 만들면 안 된다. 여기는 `life345-` 접두를 강제한다.
//
// 판정 근거의 원칙 (01-criteria.md §0 관문 ①·④):
//   - 모든 수치는 `raw/claude/` 의 실물 파일을 가리킨다
//   - T3·T7 은 **실제 렌더러**의 연속 스크린샷이 있어야 한다. 헤드리스 셀 카운트는 보조다

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION = process.env.LIFE345_SESSION ?? 'life345-claude'
export const APP_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const REPO_DIR = path.dirname(APP_DIR)
export const RAW_DIR = path.join(REPO_DIR, 'specs/LIFE-345-terminal-view/raw/claude')
export const FIXTURE_DIR = path.join(APP_DIR, 'scripts/l345/fixtures')

/** 사용자의 `default` 세션을 코드 레벨에서 막는다 (01-criteria.md §0.1). */
export function socketPath(session = SESSION) {
  if (!session.startsWith('life345-')) {
    throw new Error(`거부: 격리 세션이 아니다 (${session}). life345- 접두여야 한다`)
  }
  const target = path.join(os.homedir(), '.config', 'herdr', 'sessions', session, 'herdr.sock')
  const bytes = Buffer.byteLength(target, 'utf8')
  if (bytes > 104) throw new Error(`유닉스 소켓 경로 ${bytes} bytes — 104 한계를 넘는다`)
  return target
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 요청 1건 = 커넥션 1개. 서버가 응답 뒤 스스로 닫는다 (스파이크 제약 2). */
export function request(method, params = {}, { session = SESSION, timeoutMs = 15000 } = {}) {
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

/** 앱의 계측 제어 채널. */
export function control(socketFile, frame, { timeoutMs = 20000 } = {}) {
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

export function writeRaw(file, content) {
  const target = path.join(RAW_DIR, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  console.log('wrote', path.relative(REPO_DIR, target))
  return target
}

/** 앱을 띄우고 로그에 조건이 나타날 때까지 기다린다. */
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
  const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l345-')), 'c.sock')
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
    const entries = readLog(logPath)
    if (waitFor(entries)) {
      ready = true
      break
    }
    await sleep(120)
  }
  if (!ready) console.error('[harness] waitFor 조건이 안 왔다 —', name)

  const app = {
    child,
    logPath,
    controlSocket,
    shotDir,
    dir,
    entries: () => readLog(logPath),
    /**
     * **증분** 로그 읽기. 전문을 매번 다시 파싱하면 로그가 커질수록 폴링 자체가 느려져
     * 측정이 자기 발에 걸린다 — 1차 I1 에서 표본 60개 중 50개를 그렇게 놓쳤다.
     * 바이트 오프셋을 들고 다니며 새로 붙은 줄만 읽는다.
     */
    tail: (() => {
      let offset = 0
      return () => {
        if (!fs.existsSync(logPath)) return []
        const size = fs.statSync(logPath).size
        if (size <= offset) return []
        const handle = fs.openSync(logPath, 'r')
        const buffer = Buffer.alloc(size - offset)
        fs.readSync(handle, buffer, 0, buffer.length, offset)
        fs.closeSync(handle)
        const text = buffer.toString('utf8')
        const cut = text.lastIndexOf('\n')
        if (cut === -1) return []
        offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8')
        return text
          .slice(0, cut)
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
    })(),
    send: (frame) => control(controlSocket, frame),
    shot: (label, selector) => control(controlSocket, { cmd: 'shot', name: label, ...(selector ? { selector } : {}) }),
    /** 터미널 표면만 잘라 찍는다 — 헤더의 rev 카운터·경과 초가 비교에 섞이지 않게. */
    termShot: (label) => control(controlSocket, { cmd: 'shot', name: label, selector: '.term-box' }),
    state: () => control(controlSocket, { cmd: 'state' }),
    dump: () => control(controlSocket, { cmd: 'term-dump' }),
    policy: () => control(controlSocket, { cmd: 'term-policy' }),
    selectPane: (paneId) => control(controlSocket, { cmd: 'select-pane', paneId }),
    key: (keyCode, modifiers = []) => control(controlSocket, { cmd: 'key', keyCode, modifiers }),
    paste: (text) => control(controlSocket, { cmd: 'paste', text }),
    resize: (width, height) => control(controlSocket, { cmd: 'resize', width, height }),
    webgl: (on) => control(controlSocket, { cmd: 'term-webgl', on }),
    write: (bytes) => control(controlSocket, { cmd: 'term-write', bytes }),
    /** 실패를 조용히 넘기지 않는다 — 조용한 실패 때문에 표본을 통째로 놓친 적이 있다. */
    find: async (needle) => {
      const response = await control(controlSocket, { cmd: 'term-find', needle })
      if (!response.ok) throw new Error('term-find 실패: ' + JSON.stringify(response))
      return response
    },
    unicode: (mode) => control(controlSocket, { cmd: 'term-unicode', mode }),
    stop: async () => {
      // SIGTERM 만으로는 안 죽는 경우가 있다 (Electron 헬퍼 프로세스가 남는다).
      // exit 를 실제로 기다리고, 안 오면 SIGKILL 한 뒤 파이프를 끊는다 —
      // 파이프가 열려 있으면 하네스 노드가 영원히 안 끝난다.
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
  return app
}

// --- 격리 pane 조작 --------------------------------------------------------

/** 명령을 치고 엔터. `pane.send_text` 는 그대로 입력되므로 개행을 붙여 제출한다. */
export async function run(paneId, command, { settleMs = 800 } = {}) {
  await request('pane.send_text', { pane_id: paneId, text: command + '\n' })
  await sleep(settleMs)
}

export async function panes() {
  const result = await request('pane.list', {})
  return result.panes
}

/**
 * 격리 세션을 pane 1개짜리 기준 상태로 되돌린다.
 *
 * **살아남은 픽스처 프로세스를 먼저 죽인다.** 티커 픽스처는 `&` 로 띄우므로 C-c 가 닿지 않고,
 * 알트스크린을 계속 다시 칠한다 — R1 다음에 온 R2 가 셸이 아니라 티커 화면을 재고 있었다
 * (표본 6개 중 1개가 수렴 실패로 잡혔다). 패턴은 이 일감의 픽스처 경로로 좁힌다.
 */
export async function tidySession() {
  await killFixtures()
  const list = await panes()
  for (const pane of list.slice(1)) {
    await request('pane.close', { pane_id: pane.pane_id }).catch(() => {})
  }
  await sleep(400)
  const survivor = (await panes())[0]
  if (survivor) await reclaimShell(survivor.pane_id)
  return survivor?.pane_id ?? null
}

const SHELLS = ['zsh', 'bash', 'sh']

/**
 * 살아남은 픽스처 프로세스를 죽인다.
 *
 * 티커 픽스처는 `&` 로 띄우므로 C-c 가 닿지 않고, 알트스크린을 계속 다시 칠한다 —
 * R1 다음에 온 R2 가 셸이 아니라 티커 화면을 재고 있었고(표본 6개 중 1개 수렴 실패),
 * P1 의 두 팔이 서로 다른 부하를 쟀다(프레임 43 대 101). 패턴은 이 일감의 픽스처 경로로 좁힌다.
 */
export async function killFixtures() {
  await new Promise((resolve) => {
    execFile('pkill', ['-f', 'scripts/l345/fixtures/'], () => resolve())
  })
  await sleep(300)
}

/**
 * pane 을 **셸 프롬프트**로 되돌린다.
 *
 * C-c 로 안 나가는 것이 있다 — T4 가 띄운 `codex`·`claude` 는 전체화면 TUI 라 다음 측정이
 * 통째로 그 화면을 잰다 (실제로 `stty size` 대신 codex 업데이트 배너를 읽고 터졌다).
 * 그래서 **부드럽게 → 세게** 순서로 올라간다: C-c · q · C-d, 그래도 안 되면 foreground
 * 프로세스를 pid 로 죽인다. 죽이는 대상은 이 격리 pane 의 foreground 뿐이다.
 */
export async function reclaimShell(paneId) {
  const foreground = async () => {
    const info = await request('pane.process_info', { pane_id: paneId }).catch(() => null)
    return info?.process_info?.foreground_processes ?? []
  }
  const isShell = (list) => list.length === 1 && SHELLS.includes(list[0]?.name)

  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await foreground()
    if (isShell(current)) {
      // **`stty sane` 이 없으면 다음 측정이 통째로 어긋난다.** 위에서 raw 모드로 들어간
      // TUI(vim·codex)를 SIGKILL 로 죽이면 termios 를 되돌릴 기회가 없어 tty 가 raw 로 남는다.
      // ONLCR 이 꺼진 채라 LF 가 CR 을 안 끌고 와서 화면이 계단처럼 밀린다 — T1 이 그 상태로
      // 재서 로그형 일치율이 100% → 70% 로 떨어졌다.
      await run(paneId, "stty sane; printf '\\033[?1049l'; clear", { settleMs: 500 })
      return { ok: true, attempts: attempt, names: current.map((process) => process.name) }
    }
    if (attempt < 2) {
      await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] }).catch(() => {})
      await sleep(400)
      await request('pane.send_text', { pane_id: paneId, text: 'q' }).catch(() => {})
      await sleep(300)
      await request('pane.send_keys', { pane_id: paneId, keys: ['C-d'] }).catch(() => {})
      await sleep(600)
      continue
    }
    for (const process of current) {
      if (SHELLS.includes(process.name)) continue
      await new Promise((resolve) => {
        execFile('kill', [attempt >= 4 ? '-KILL' : '-TERM', String(process.pid)], () => resolve())
      })
    }
    await sleep(900)
  }
  const names = (await foreground()).map((process) => process.name)
  console.error('[reclaimShell] 셸로 못 돌렸다', names)
  return { ok: false, attempts: 5, names }
}

/** pane 의 진짜 PTY 격자. API 에는 cols 가 없어서 셸에게 묻는 것이 유일한 진실이다. */
export async function ptyGrid(paneId) {
  await run(paneId, 'clear; stty size', { settleMs: 900 })
  const result = await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })
  const match = /(\d+)\s+(\d+)/.exec(result.read.text)
  if (!match) throw new Error('stty size 를 못 읽었다: ' + JSON.stringify(result.read.text.slice(0, 200)))
  return { rows: Number(match[1]), cols: Number(match[2]) }
}

/** 픽스처를 pane 에서 실행한다. */
export async function playFixture(paneId, file, { settleMs = 1600 } = {}) {
  await run(paneId, `printf '\\033[2J\\033[H'; sh ${path.join(FIXTURE_DIR, file)}`, { settleMs })
}

// --- 셀 비교 ---------------------------------------------------------------

/**
 * 두 격자를 셀 단위로 비교한다.
 *
 * LIFE-342 지적 ⑫ 를 반영해 **분모를 둘 다 낸다**: 전체 칸과 "둘 중 한쪽에라도 글자가 있는 칸".
 * 213열짜리 화면에서 빈 칸을 분모에 넣으면 일치율이 실제보다 후하게 나온다.
 */
export function compareGrids(a, b, { rows, cols }) {
  const blank = (text) => (text === '' || text === ' ' ? '' : text)
  let cells = 0
  let inked = 0
  let textOk = 0
  let textOkInked = 0
  let styleOk = 0
  let styleOkInked = 0
  const textDiff = []
  const styleDiff = []
  for (let y = 0; y < rows; y++) {
    const ra = a[y] ?? []
    const rb = b[y] ?? []
    for (let x = 0; x < cols; x++) {
      const ca = ra[x] ?? null
      const cb = rb[x] ?? null
      const ta = blank(ca?.ch ?? '')
      const tb = blank(cb?.ch ?? '')
      const hasInk = ta !== '' || tb !== ''
      cells += 1
      if (hasInk) inked += 1
      if (ta === tb) {
        textOk += 1
        if (hasInk) textOkInked += 1
      } else if (textDiff.length < 60) {
        textDiff.push({ y, x, a: ca?.ch ?? '', b: cb?.ch ?? '' })
      }
      const sa = ca ? `${ca.fg}|${ca.bg}|${ca.bold ? 'B' : ''}${ca.inverse ? 'I' : ''}${ca.underline ? 'U' : ''}` : ''
      const sb = cb ? `${cb.fg}|${cb.bg}|${cb.bold ? 'B' : ''}${cb.inverse ? 'I' : ''}${cb.underline ? 'U' : ''}` : ''
      if (!hasInk) {
        styleOk += 1
        continue
      }
      if (sa === sb) {
        styleOk += 1
        styleOkInked += 1
      } else if (styleDiff.length < 60) {
        styleDiff.push({ y, x, ch: ta || tb, a: sa, b: sb })
      }
    }
  }
  return {
    cells,
    inkedCells: inked,
    textMatch: cells ? textOk / cells : 0,
    styleMatch: cells ? styleOk / cells : 0,
    textMatchInked: inked ? textOkInked / inked : 1,
    styleMatchInked: inked ? styleOkInked / inked : 1,
    textDiff,
    styleDiff,
  }
}

/** wide char 가 차지한 시작 열 — 행 밀림을 보려면 이걸 맞춰봐야 한다 (T7). */
export function wideStarts(cells, cols) {
  const out = []
  for (let x = 0; x < cols; x++) {
    const cell = cells?.[x]
    if (cell && cell.w === 2) out.push({ x, ch: cell.ch })
  }
  return out
}

export function rowText(cells, cols) {
  let out = ''
  for (let x = 0; x < cols; x++) {
    const cell = cells?.[x]
    if (!cell) out += ' '
    else if (cell.w === 0) continue
    else out += cell.ch || ' '
  }
  return out.replace(/\s+$/, '')
}

export function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}
