// Electron main — 소켓을 소유하는 쪽.
//
// 렌더러가 소켓을 열 수 없는 것은 권장이 아니라 구조적 강제다: sandbox:true 인 렌더러/preload 의
// require 화이트리스트에는 net 이 없다. 그래서 herdr 소켓은 전부 여기서 다룬다.
//
// 이 파일은 **어댑터의 공개 입구만** import 한다 (`./adapter/index.js`). internal 은 모른다.

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddRepoResult, AppState } from '../shared/types.js'
import { SESSION_POLL_MS, SessionLink, listSessions, type SessionHandle } from './adapter/index.js'
import { startControlServer } from './control.js'
import { closeLog, log, logFile, openLog } from './log.js'
import { pickSessionName } from './pick-session.js'
import { RepoRegistry } from './registry.js'
import { buildSkeleton, joinTree, type RepoSkeleton } from './tree.js'

const here = path.dirname(fileURLToPath(import.meta.url))

let window: BrowserWindow | null = null
let revision = 0
/** 소켓 경로를 든 목록은 **여기까지만** 산다 (수정 1회차 L9) — 화면으로는 이름·running 만 간다. */
let sessions: SessionHandle[] = []
let sessionsError: string | null = null
let selectedSession: string | null = null
let sessionNote: string | null = null
let registry: RepoRegistry | null = null
/** 비싼 쪽(git·herdr 왕복)만 캐시한다. 행은 내보낼 때마다 새로 붙인다 — tree.ts 의 주석 참고. */
let skeleton: RepoSkeleton[] = []
let emitScheduled = false
let treeScheduled = false

const link = new SessionLink({
  onChange: () => scheduleEmit(),
  // 목록 위상이 바뀌었으면 worktree 열림상태를 다시 읽는다 — 그게 N4ⓒ 의 진실 출처다.
  onTopologyChange: () => scheduleTree(),
})

function currentSocketPath(): string | null {
  return sessions.find((item) => item.name === selectedSession)?.socketPath ?? null
}

function currentState(): AppState {
  const tree = joinTree(skeleton, link.store.rows())
  return {
    revision,
    // 소켓 경로를 떼고 내보낸다 — 경계의 약속이 화면 상태로 새지 않게 (L9).
    sessions: sessions.map(({ name, isDefault, running }) => ({ name, isDefault, running })),
    sessionsError,
    selectedSession,
    sessionNote,
    link: link.linkState(),
    registry: registry?.state() ?? { file: '', roots: [], lastError: '레지스트리 미초기화' },
    repos: tree.repos,
    // 진단 표시는 개발·계측 실행에서만. 패키징된 앱의 평시 화면에는 안 나온다.
    diagnostics: !app.isPackaged || process.env.CORRAL_CONTROL_SOCKET !== undefined,
  }
}

/** 상태 전송은 한 틱으로 뭉친다 — workspace_created 와 그 pane_created 가 같은 프레임에 실린다. */
function scheduleEmit(): void {
  if (emitScheduled) return
  emitScheduled = true
  setTimeout(() => {
    emitScheduled = false
    revision += 1
    if (window !== null && window.isDestroyed()) window = null
    const state = currentState()
    log('state.emit', {
      revision: state.revision,
      phase: state.link.phase,
      repos: skeleton.map((repo) => `${repo.name}:${repo.worktrees.length}`),
      ...link.store.ids(),
    })
    window?.webContents.send('corral:state', state)
  }, 0)
}

/** 골격 재조회는 git·herdr 왕복을 낀다 — 흔들릴 때 매번 돌지 않게 한 박자 뭉친다. */
function scheduleTree(): void {
  if (treeScheduled) return
  treeScheduled = true
  setTimeout(() => {
    treeScheduled = false
    void rebuildTree()
  }, 80)
}

/**
 * 골격 재조회는 레포마다 `git worktree list`(최대 5초) + herdr 왕복을 **직렬로** 돈다.
 * 그래서 A 가 도는 중 B 가 시작해 먼저 끝나면, 뒤늦게 끝난 A 의 **낡은 골격이 새것을 덮는다**
 * (수정 1회차 L6). 예약은 `scheduleTree` 가 뭉치지만 실행 자체는 안 막았다.
 * 세대 번호로 막는다 — 늦게 끝난 회차는 결과를 버린다.
 */
let treeGeneration = 0

async function rebuildTree(): Promise<void> {
  const startedAt = Date.now()
  const generation = ++treeGeneration
  const built = await buildSkeleton({ roots: registry?.list() ?? [], socketPath: currentSocketPath() })
  if (generation !== treeGeneration) {
    log('tree.stale', { generation, current: treeGeneration, ms: Date.now() - startedAt })
    return
  }
  skeleton = built
  log('tree.built', {
    ms: Date.now() - startedAt,
    repos: skeleton.length,
    worktrees: skeleton.reduce((sum, repo) => sum + repo.worktrees.length, 0),
    open: skeleton.reduce((sum, repo) => sum + repo.worktrees.filter((item) => item.openWorkspaceId !== null).length, 0),
  })
  scheduleEmit()
}

function addRepo(input: string): AddRepoResult {
  const result = registry?.add(input) ?? { ok: false, error: '레지스트리 미초기화' }
  if (result.ok) scheduleTree()
  scheduleEmit()
  return result
}

function pickSession(name: string): void {
  const found = sessions.find((session) => session.name === name)
  if (found === undefined) {
    log('session.select.missing', { name })
    return
  }
  selectedSession = name
  link.open(found)
  scheduleEmit()
}

async function pollSessions(): Promise<void> {
  const scan = await listSessions()
  sessions = scan.sessions
  sessionsError = scan.error
  if (selectedSession === null) {
    // 고르는 규칙은 순수 함수에 있다 (수정 1회차 M6) — 멈춘 세션을 실제로 만들지 않고 재생으로 잰다.
    const choice = pickSessionName({ sessions, wanted: process.env.CORRAL_SESSION })
    sessionNote = choice.note
    if (choice.note !== null) log('session.select.note', { note: choice.note })
    if (choice.name !== null) pickSession(choice.name)
  }
  scheduleEmit()
}

/**
 * 스크린샷. `selector` 를 주면 **그 요소만** 잘라 찍는다 — 헤더의 rev 카운터처럼 매 틱 바뀌는
 * 것이 비교를 흔들지 않게 하기 위해서다.
 */
async function capture(name: string, selector?: string): Promise<string> {
  const dir = process.env.CORRAL_SHOT_DIR ?? path.join(app.getPath('userData'), 'shots')
  fs.mkdirSync(dir, { recursive: true })
  const target = window
  if (target === null) throw new Error('창이 없다')
  let rect: Electron.Rectangle | undefined
  if (selector !== undefined) {
    const box = await target.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } })()`,
      true,
    )
    if (box !== null) rect = box
  }
  const image = rect === undefined ? await target.webContents.capturePage() : await target.webContents.capturePage(rect)
  const file = path.join(dir, `${name}.png`)
  fs.writeFileSync(file, image.toPNG())
  log('shot.captured', { name, file, revision, selector: selector ?? null })
  return file
}

/** 계측용 창 크기 (CORRAL_WINDOW=1180x1400) — 긴 목록을 한 장에 담기 위한 것뿐이다. */
function windowSize(): { width: number; height: number } {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(process.env.CORRAL_WINDOW ?? '')
  if (match === null || match[1] === undefined || match[2] === undefined) return { width: 1180, height: 800 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

function createWindow(): void {
  const size = windowSize()
  window = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    backgroundColor: '#12141a',
    title: 'corral',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      // 셋 다 명시한다. 현행 기본값이지만 보안 자세는 기본값에 기대지 않는다 (분석 §5 U2).
      // sandbox:true 라서 렌더러/preload 는 net 을 쓸 수 없다.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.on('ready-to-show', () => window?.show())
  // 사용자가 목록을 다시 읽는 순간이 포커스가 돌아오는 때다 — 그때 한 번 맞춘다 (A4).
  window.on('focus', () => void link.resync('window-focus'))
  /**
   * 새 창은 전부 거절한다. 외부로 넘기는 것은 **https 만** — 보안 체크리스트 17 (수정 1회차 L12).
   * R1 화면에 외부 링크는 없지만, `openExternal` 에 걸러지지 않은 URL 을 넘기는 모양이
   * 골격에 남아 있으면 나중에 그대로 구멍이 된다. `file:`·`javascript:` 는 여기서 끝난다.
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    else log('window.open.denied', { url: url.slice(0, 200) })
    return { action: 'deny' }
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer !== undefined) void window.loadURL(devServer)
  else void window.loadFile(path.join(here, '../renderer/index.html'))
}

// main 의 uncaught exception 은 Electron 기본 동작이 모달이다 — 사용자 화면을 막는다.
// 여기서 잡아 로그로 남기면 앱은 살아 있고 실패는 파일에 식별 가능하게 남는다.
process.on('uncaughtException', (error) => log('main.uncaught_exception', { error: String(error), stack: error.stack }))
process.on('unhandledRejection', (reason) => log('main.unhandled_rejection', { reason: String(reason) }))

app.whenReady().then(() => {
  const file = openLog(app.getPath('userData'))
  registry = new RepoRegistry(app.getPath('userData'))
  registry.load()
  log('app.ready', {
    logFile: file,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    registryFile: registry.state().file,
  })

  /**
   * IPC 는 **우리 창에서 온 것만** 받는다 — 보안 체크리스트 15 (수정 1회차 L12).
   * 지금 렌더러는 로컬·sandbox·isolation 이라 당장 잘못될 일은 없다. 그래도 핸들러가
   * sender 를 안 보는 모양으로 굳으면, 나중에 iframe·원격 콘텐츠가 들어오는 순간 그대로 구멍이다.
   */
  const fromOurWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => {
    const ok = window !== null && !window.isDestroyed() && event.senderFrame === window.webContents.mainFrame
    if (!ok) log('ipc.rejected', { url: event.senderFrame?.url.slice(0, 200) ?? null })
    return ok
  }

  ipcMain.handle('corral:getState', (event) => (fromOurWindow(event) ? currentState() : null))
  ipcMain.handle('corral:addRepo', (event, root: string) =>
    fromOurWindow(event) ? addRepo(root) : { ok: false, error: '허용되지 않은 발신자' },
  )
  ipcMain.handle('corral:refreshSessions', (event) => (fromOurWindow(event) ? pollSessions() : undefined))
  ipcMain.on('corral:reportRendered', (event, rendered: number) => {
    if (fromOurWindow(event)) log('ui.rendered', { revision: rendered })
  })

  createWindow()
  void pollSessions()
  setInterval(() => void pollSessions(), SESSION_POLL_MS)
  scheduleTree()

  startControlServer({
    capture,
    state: () => currentState(),
    window: () => window,
    resync: (reason) => link.resync(reason),
    setDroppingPush: (input) => link.setDroppingPush(input),
    addRepo,
    rebuildTree,
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  link.close()
  log('app.quit', { logFile: logFile() })
  closeLog()
  app.quit()
})
