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
import type { AddRepoResult, AppState, SessionInfo } from '../shared/types.js'
import { SESSION_POLL_MS, SessionLink, listSessions } from './adapter/index.js'
import { startControlServer } from './control.js'
import { closeLog, log, logFile, openLog } from './log.js'
import { RepoRegistry } from './registry.js'
import { buildSkeleton, joinTree, type RepoSkeleton } from './tree.js'

const here = path.dirname(fileURLToPath(import.meta.url))

let window: BrowserWindow | null = null
let revision = 0
let sessions: SessionInfo[] = []
let sessionsError: string | null = null
let selectedSession: string | null = null
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
    sessions,
    sessionsError,
    selectedSession,
    link: link.linkState(),
    registry: registry?.state() ?? { file: '', roots: [], lastError: '레지스트리 미초기화' },
    repos: tree.repos,
    unregistered: tree.unregistered,
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

async function rebuildTree(): Promise<void> {
  const startedAt = Date.now()
  skeleton = await buildSkeleton({ roots: registry?.list() ?? [], socketPath: currentSocketPath() })
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
    const wanted = process.env.CORRAL_SESSION
    const target =
      (wanted !== undefined ? sessions.find((session) => session.name === wanted) : undefined) ??
      sessions.find((session) => session.isDefault) ??
      sessions[0]
    if (target !== undefined) pickSession(target.name)
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
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

  ipcMain.handle('corral:getState', () => currentState())
  ipcMain.handle('corral:addRepo', (_event, root: string) => addRepo(root))
  ipcMain.handle('corral:refreshSessions', () => pollSessions())
  ipcMain.on('corral:reportRendered', (_event, rendered: number) => log('ui.rendered', { revision: rendered }))

  createWindow()
  void pollSessions()
  setInterval(() => void pollSessions(), SESSION_POLL_MS)
  scheduleTree()

  startControlServer({
    capture,
    state: () => currentState(),
    window: () => window,
    resync: (reason) => link.resync(reason),
    setDroppingPush: (dropping) => link.setDroppingPush(dropping),
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
