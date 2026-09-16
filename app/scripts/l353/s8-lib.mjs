// LIFE-351 측정 하네스 — 앱을 띄우고, 밖에서 herdr 를 흔들고, 두 쪽을 같은 시각에 떠서 맞춰 본다.
//
// 판정 근거의 원칙 (01-criteria.md §0):
//   관문 ① 실제 실행 + 재현 가능한 원자료 — 결과는 전부 raw/claude/ 로 간다
//   관문 ④ 격리 — `life351-` 접두 세션만. 앱의 레지스트리도 격리 경로를 쓴다
//   관문 ⑤ UI 주장은 좌표 클릭 또는 elementFromPoint 로 증명한다
//
// **하네스는 herdr 에 쓴다** (탭 생성·닫기·상태 주입). 그게 "밖에서 일으킨 변화" 다 (기준 N5).
// 앱 자신은 읽기만 한다 — 그쪽 화이트리스트가 코드로 막는다 (adapter/internal/request.ts).

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SESSION = process.env.LIFE353_SESSION ?? 'life353-claude'
export const APP_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const REPO_DIR = path.dirname(APP_DIR)
/**
 * 이 회차의 원자료가 떨어지는 곳.
 *
 * 수정 라운드는 **앞 회차 원자료를 덮지 않는다** — 1회차 결과는 그대로 두고 `fix1/` 에 새로 쌓는다
 * (지시 10). `L351_ROUND` 로 회차를 바꾼다.
 */
export const ROUND = process.env.L353_ROUND ?? 's8'
/**
 * LIFE-373 재실행분은 `L353_RAW_SUBDIR` 로 한 층 더 내려간다 — lib.mjs 와 같은 규칙이다.
 * 이게 없으면 다른 작업(LIFE-373)의 재실행이 **얼어 있는 LIFE-353 원자료를 덮는다**. 실제로
 * 덮었다 (`s8/n5-list-consistency.json`, `_discarded/.../m0-smoke/app.ndjson` — 복원함).
 */
export const RAW_SUBDIR = process.env.L353_RAW_SUBDIR ?? ''
/** 베이스는 `lib.mjs` 와 **같은 규칙**이다 — 세션이 `life373-` 이면 그쪽 트리로 간다 (§10-R32-2). */
const RAW_BASE =
  process.env.L353_RAW_DIR ??
  (SESSION.startsWith('life373-')
    ? path.join(REPO_DIR, 'specs/LIFE-373-mru-pane-split/raw/claude/l353harness')
    : path.join(REPO_DIR, 'specs/LIFE-353-terminal-streaming/raw/claude'))
export const RAW_DIR = path.join(RAW_BASE, RAW_SUBDIR, ROUND)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 사용자의 `default` 세션을 **코드 레벨에서** 막는다 (관문 ④). */
export function socketPath(session = SESSION) {
  if (!session.startsWith('life353-')) {
    throw new Error(`거부: 격리 세션이 아니다 (${session}). life353- 접두여야 한다`)
  }
  const target = path.join(os.homedir(), '.config', 'herdr', 'sessions', session, 'herdr.sock')
  const bytes = Buffer.byteLength(target, 'utf8')
  if (bytes > 104) throw new Error(`유닉스 소켓 경로 ${bytes} bytes — 104 한계를 넘는다`)
  return target
}

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

/** herdr 쪽 진실 — corral 상태와 **같은 시각에** 찍는다 (기준 N5). */
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

/**
 * **조건이 참이 될 때까지 본다.** 고정 대기로 판정하지 않기 위한 도구다 —
 * 기다린 시간도 함께 돌려주므로 "얼마나 걸렸나" 는 결과로 남고 판정의 근거는 관측이다.
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

// --- 앱 -----------------------------------------------------------------------

/**
 * **소스보다 낡은 빌드로 재지 않는다.**
 *
 * `electron .` 은 package.json 의 `main`(=`out/main/index.js`)을 띄운다 — 소스가 아니다.
 * 그래서 고친 뒤 빌드를 안 하면 하네스가 **옛 앱을 재고** 그 숫자를 새 앱의 근거로 적게 된다
 * (실제로 N8 1회차에서 그렇게 됐다). 손으로 기억하는 대신 여기서 강제한다:
 * src/ 에 out/ 보다 새 파일이 하나라도 있으면 빌드하고, 그 사실을 로그에 남긴다.
 */
let ensured = false
export function ensureBuilt() {
  if (ensured) return { built: false, reason: '이 프로세스에서 이미 확인' }
  ensured = true
  const built = path.join(APP_DIR, 'out/main/index.js')
  const newest = (dir) => {
    let max = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

/**
 * 앞 실행의 폴더를 **지우지 않고 치운다** (수정 3회차 F3-L2).
 *
 * 2회차의 L-3 은 "회차마다 비운다" 로 고쳤는데, 그 비우기가 **버린 회차의 실물까지** 지웠다.
 * G6-3 이 관문 ③ 으로 정직하게 적은 회차(`pyenv-rehash` 가 셸을 붙들어 `exit` 가 실행조차
 * 안 된 5/5)의 근거가 브랜치에 안 남은 원인이 이것이다. 조정을 적는 값은 **검증 가능성**에서
 * 오므로, 앞 실행은 `_discarded/<타임스탬프>/` 로 옮긴다 — 최종 원자료와 섞이지 않으면서
 * 남는다. (L-3 이 막으려던 것은 "아무도 안 가리키는 샷이 원자료에 섞이는 것" 이고,
 * `_discarded/` 는 이름 자체가 "이건 근거가 아니다" 를 말한다.)
 */
function 치운다(dir) {
  if (!fs.existsSync(dir)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const parked = path.join(RAW_DIR, '_discarded', stamp, path.basename(path.dirname(dir)), path.basename(dir))
  fs.mkdirSync(path.dirname(parked), { recursive: true })
  fs.renameSync(dir, parked)
}

export async function startApp({
  name,
  env = {},
  waitFor = (entries) => entries.some((entry) => entry.tag === 'link.phase' && entry.phase === 'live'),
  timeoutMs = 40000,
  /** 재기동 회차(N3)는 같은 레지스트리 파일을 다시 써야 한다 — 그때 경로를 넘긴다. */
  registryFile,
} = {}) {
  const buildCheck = ensureBuilt()
  const dir = path.join(RAW_DIR, '_runs', name)
  치운다(dir)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'app.ndjson')
  // 소켓만 짧은 경로에 둔다 — worktree 아래는 sun_path 104 bytes 를 넘는다 (실측).
  const controlSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l353s8-')), 'c.sock')
  /**
   * **샷 폴더도 회차마다 비운다** (수정 2회차 L-3).
   *
   * `_runs/<name>` 은 비우는데 샷은 안 비웠다. 그래서 같은 측정을 두 번 돌리면 앞 회차 샷이
   * 남고, JSON 은 마지막 회차만 가리킨다 — 커밋된 원자료에 **아무도 안 가리키는 샷**이 섞여
   * 판정자가 "근거" 칸을 따라갈 때 어느 회차가 근거인지 파일 목록만으로는 안 갈린다
   * (fix1/shots/n8-chips 에 실제로 6장 남았다). 비우면 그 상태가 원천적으로 안 생긴다.
   */
  const shotDir = path.join(RAW_DIR, 'shots', name)
  치운다(shotDir)
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
      // 관문 ④ — 앱의 영속 상태도 격리 경로로. 사용자의 실제 userData 를 더럽히지 않는다.
      CORRAL_REGISTRY: registryFile ?? path.join(dir, 'repos.json'),
      CORRAL_WINDOW: '1180x1200',
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
  const send = (frame, ms = 30000) => control(controlSocket, frame, { timeoutMs: ms })

  return {
    child,
    logPath,
    shotDir,
    dir,
    registryFile: registryFile ?? path.join(dir, 'repos.json'),
    buildCheck,
    ready,
    entries: () => readLog(logPath),
    send,
    state: async () => (await send({ cmd: 'state' })).state,
    resync: (reason) => send({ cmd: 'resync', reason }),
    /** `only` 를 주면 **그 이벤트만** 버린다 — corral 이 일부만 모르게 만드는 손잡이 (H-1 재측정). */
    dropPush: (dropping, only = null) => send({ cmd: 'drop-push', dropping, ...(only ? { only } : {}) }),
    rebuildTree: () => send({ cmd: 'rebuild-tree' }),
    addRepo: (root) => send({ cmd: 'add-repo', root }),
    /**
     * 다음 「폴더 찾아보기」가 무엇으로 끝날지 세운다 (수정 5회차).
     * 경로를 주면 그 폴더를 고른 것, `'취소'` 면 그냥 닫은 것. 안 세우면 **진짜 OS 창이 뜬다** —
     * 측정이 거기서 멈추므로 하네스는 언제나 둘 중 하나를 세우고 누른다.
     */
    browseStub: (target) =>
      target === '취소' ? send({ cmd: 'browse-stub', canceled: true }) : send({ cmd: 'browse-stub', path: target }),
    click: (selector) => send({ cmd: 'click', selector }),
    type: (text) => send({ cmd: 'type', text }),
    key: (keyCode, modifiers = []) => send({ cmd: 'key', keyCode, modifiers }),
    query: (selector) => send({ cmd: 'query', selector }),
    /**
     * 샷 이름에 **순번과 시각**을 박는다 — 연속성이 파일 이름만으로 보여야 한다.
     * 경로는 **원자료 기준 상대경로**로 돌려준다 (수정 1회차 L4): 1회차는 구현 worktree 의
     * 절대경로를 JSON 에 박았는데, worktree 는 출고 후 정리되므로 그 경로는 곧 없어진다.
     */
    shot: async (label, selector) => {
      const seq = String(++shotSeq).padStart(3, '0')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const response = await send({ cmd: 'shot', name: `${seq}-${label}-${stamp}`, ...(selector ? { selector } : {}) })
      const file = typeof response.file === 'string' ? path.relative(RAW_DIR, response.file) : response.file
      return { ...response, file, seq, at: Date.now(), label }
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

// --- 클릭 증거 (관문 ⑤) ---------------------------------------------------------

const clicks = []
export function clickLog() {
  return clicks
}

/**
 * 화면의 **진짜 버튼**을 누른다 — DOM 에 있는 것과 사람이 닿는 것은 다르다.
 * 보일 때까지 + **눌리는 자리에 실제로 있을 때까지** 본 뒤 좌표로 마우스를 보낸다.
 */
export async function clickWhenVisible(app, selector, { timeoutMs = 10000 } = {}) {
  const seen = await until(async () => (await app.query(selector)).found.length > 0, {
    timeoutMs,
    everyMs: 100,
    what: selector,
  })
  if (!seen.ok) throw new Error(`화면에 안 나타났다: ${selector}`)
  const reachable = await until(
    async () => {
      const response = await app.click(selector)
      return response.hit === true ? response : null
    },
    { timeoutMs, everyMs: 120, what: `${selector} 히트테스트` },
  )
  if (!reachable.ok) {
    const last = await app.click(selector)
    throw new Error(`가려져 있다 — 못 눌렀다: ${selector} (위에 있는 것: ${last.blockedBy ?? '?'})`)
  }
  const record = {
    at: Date.now(),
    selector,
    hit: reachable.value.hit === true,
    x: reachable.value.x ?? null,
    y: reachable.value.y ?? null,
    elementFromPoint: reachable.value.elementFromPoint ?? null,
    target: reachable.value.target ?? null,
    method: reachable.value.method ?? null,
    보일때까지ms: seen.ms,
    닿을때까지ms: reachable.ms,
  }
  clicks.push(record)
  return { ...reachable.value, record }
}

// --- 격리 세션 준비 ------------------------------------------------------------

/**
 * 격리 세션을 **workspace 1개 · 탭 1개** 로 되돌린다. workspace 를 통째로 다시 세운다 —
 * 마지막 탭을 닫으면 workspace 까지 닫히는 경로를 측정이 일부러 밟기 때문에, "있으면 쓴다" 로
 * 두면 회차마다 서로 다른 상태에서 출발하게 된다.
 *
 * **cwd 를 준다.** 안 주면 $HOME 에 서고, 그러면 그 workspace 가 어느 worktree 의 것인지
 * herdr 가 모른다 — 4단 목록이 그 워크스페이스를 레포 밑에 못 건다.
 */
export async function tidySession(cwd = REPO_DIR) {
  // **LIFE-373 하네스 수정 ②** (기준 §10-R5: 수정하면 diff 전량을 결과 문서에).
  //
  // 옛 순서는 `전부 닫기 → 하나 만들기 → workspace.list[0] 을 쓴다` 였다. herdr 0.9.0 은
  // **workspace 가 하나도 없으면 $HOME 에 하나를 자동으로 만든다** — 그래서 다 닫는 순간
  // 유령 workspace 가 서고, `[0]` 이 그 유령을 집는다. 그러면 측정은 등록 레포 **밖**에 탭을
  // 만들게 되고(corral 은 등록 레포 밑만 그린다) corral↔herdr 대조가 영원히 어긋난다.
  //
  // 고친 것은 **순서와 선택**뿐이다: 먼저 만들고(한 번도 0 개가 되지 않는다) 나머지를 닫고,
  // 만든 id 를 그대로 쓴다. 측정 의미는 그대로다 — 회차마다 workspace 1개·탭 1개에서 출발한다.
  const created = await request('workspace.create', { label: 'l351', cwd })
  const createdId = created?.workspace?.workspace_id ?? created?.workspace_id ?? null
  // **id 를 못 읽으면 여기서 멈춘다** (L7). 그대로 내려가면 `continue` 가 한 번도 안 맞아
  // **방금 만든 것까지 전부 닫고** `workspaces[0]` 으로 떨어진다 — 위 주석이 고쳤다고 적은
  // 유령 경로로 정확히 되돌아가는 자리다. 조용히 되돌아가느니 회차를 세우지 않는다.
  if (createdId === null) throw new Error(`workspace.create 가 id 를 안 줬다 — ${JSON.stringify(created)}`)
  await sleep(400)
  const workspaces = (await request('workspace.list', {})).workspaces
  for (const workspace of workspaces) {
    if (workspace.workspace_id === createdId) continue
    await request('workspace.close', { workspace_id: workspace.workspace_id }).catch(() => {})
  }
  await sleep(700)
  return createdId
}

/** corral 상태에서 목록 층의 id 집합만 뽑는다 — herdr 쪽과 같은 모양으로 맞춘다. */
export function sameSet(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function diffSets(mine, truth) {
  return {
    탭_corral만: mine.tabs.filter((id) => !truth.tabs.includes(id)),
    탭_herdr만: truth.tabs.filter((id) => !mine.tabs.includes(id)),
    pane_corral만: mine.panes.filter((id) => !truth.panes.includes(id)),
    pane_herdr만: truth.panes.filter((id) => !mine.panes.includes(id)),
    ws_corral만: mine.workspaces.filter((id) => !truth.workspaces.includes(id)),
    ws_herdr만: truth.workspaces.filter((id) => !mine.workspaces.includes(id)),
  }
}

/**
 * **화면이 들고 있는 id 집합**을 AppState 에서 뽑는다.
 *
 * store 내부가 아니라 렌더러가 받는 그 상태에서 뽑는 이유: 재는 것은 "저장소가 맞나" 가 아니라
 * "목록이 맞나" 다. 4단 조립에서 어느 workspace 가 빠지면 여기서 드러난다.
 */
export function corralIdsFromState(state) {
  // 수정 4회차부터 **등록 레포 밑에 있는 것만** 화면에 실린다 (게이트 ① 지시 — `AppState` 에
  // `unregistered` 필드 자체가 없다). 격리 세션에서 workspace 는 전부 등록된 REPO_DIR 밑에
  // 열리므로 이 집합은 여전히 herdr 전체와 같다 — 안 같아지면 그게 볼 거리다.
  const workspaces = state.repos.flatMap((repo) =>
    repo.worktrees.map((worktree) => worktree.workspace).filter((item) => item !== null),
  )
  const tabs = workspaces.flatMap((workspace) => workspace.tabs)
  return {
    workspaces: workspaces.map((item) => item.workspaceId).sort(),
    tabs: tabs.map((item) => item.tabId).sort(),
    panes: tabs.flatMap((tab) => tab.panes.map((pane) => pane.paneId)).sort(),
  }
}

/**
 * corral 과 herdr 를 **같은 폴에서** 뜬다.
 * corral 쪽은 제어 채널(앱 상태), herdr 쪽은 **하네스 자기 커넥션** — 판별자가 재는 대상의
 * 출력이 아니게 하려면 상대편은 제3자여야 한다 (관문 ⑤).
 */
/**
 * corral 이 **연 적 없는** workspace 를 대조에서 뺀다 (LIFE-373 하네스 수정 ③, §10-R18-3 으로 조임).
 *
 * herdr 0.9.0 은 workspace 수가 0 이 되면 `$HOME` 에 하나를 **스스로** 만든다 (제3 오라클 실측:
 * 마지막 workspace 를 닫으면 곧바로 label `~` 의 새 workspace 가 선다). corral 은 자기가 연
 * workspace 만 그리므로 그 유령은 영원히 corral 쪽에 안 뜬다 — ⓓ(마지막 탭 닫기)가 5/5
 * 어긋나는 원인이 이것이고, corral 회귀가 아니다.
 *
 * 제외 조건은 **둘 다** 만족해야 한다 (R18-3 — "닫기 직후 생겼다" 하나로는 너무 넓다:
 * corral 이 열지 말았어야 할 workspace 를 연 경우도 같은 조건에 걸려 조용히 가려진다):
 *   ⓐ 닫기 직전 herdr 목록에 **없었다**
 *   ⓑ corral 이 **열 수 없는 자리**에 있다 — 그 workspace 의 pane cwd 가 등록 레포 밖이다
 *      (corral 은 등록 레포의 worktree 에만 workspace 를 연다)
 * 뺀 id·label·cwd 는 원자료에 남긴다.
 */
export async function ghostWorkspaces({ before, repoDir }) {
  const workspaces = (await request('workspace.list', {})).workspaces
  const panes = (await request('pane.list', {})).panes
  const rows = []
  for (const workspace of workspaces) {
    if (before.includes(workspace.workspace_id)) continue // ⓐ 미충족
    const mine = panes.filter((pane) => pane.workspace_id === workspace.workspace_id)
    const cwds = [...new Set(mine.map((pane) => pane.cwd))]
    // **cwd 를 하나도 못 읽었으면 가리지 않는다** (L8). `some()` 은 빈 배열에 false 라, pane 이 아직
    // 안 뜬 workspace 가 "유령"으로 분류돼 대조에서 통째로 빠진다 — §10-R18-3 이 "너무 넓다"고
    // 조인 자리에 같은 구멍이 남아 있었다. 모르면 **빼지 않는 쪽**이 안전하다.
    const corral이열수있나 = cwds.length === 0 || cwds.some((cwd) => typeof cwd === 'string' && cwd.startsWith(repoDir))
    if (corral이열수있나) continue // ⓑ 미충족 — 등록 레포 안이거나 알 수 없으면 가리지 않는다
    rows.push({ workspaceId: workspace.workspace_id, label: workspace.label ?? null, cwds })
  }
  return rows
}

export function ignoreWorkspacesIn(truth, ignore) {
  if (ignore.length === 0) return truth
  const 유령인가 = (id) => ignore.some((ws) => id === ws || id.startsWith(`${ws}:`))
  return {
    workspaces: truth.workspaces.filter((id) => !유령인가(id)),
    tabs: truth.tabs.filter((id) => !유령인가(id)),
    panes: truth.panes.filter((id) => !유령인가(id)),
  }
}

export async function look(app, ignoreWorkspaces = []) {
  const [state, raw] = await Promise.all([app.state(), herdrTruth()])
  const truth = ignoreWorkspacesIn(raw, ignoreWorkspaces)
  const corral = corralIdsFromState(state)
  // `at` 은 벽시계(원자료를 로그와 짝짓는 용), `mono` 는 **단조 시계**다 (수정 2회차 L-9).
  // 두 관측 사이가 1ms 도 안 걸리는 구간이 실제로 있어서 ms 정수로는 0 이 나온다 —
  // 그러면 "처음엔 안 맞았는데 수렴까지 0ms" 라는 모순된 줄이 남는다.
  const result = { at: Date.now(), mono: performance.now(), corral, herdr: truth, herdr원본: raw }
  return { ...result, 일치: agreed(result), 차이: diffSets(corral, truth) }
}

export function agreed(look) {
  return (
    sameSet(look.corral.tabs, look.herdr.tabs) &&
    sameSet(look.corral.panes, look.herdr.panes) &&
    sameSet(look.corral.workspaces, look.herdr.workspaces)
  )
}
