// Electron main — 소켓을 소유하는 쪽.
//
// 렌더러가 소켓을 열 수 없는 것은 권장이 아니라 구조적 강제다: sandbox:true 인 렌더러/preload 의
// require 화이트리스트는 electron(일부)·events·timers·url 뿐이고 net 이 없다
// (electronjs.org/docs/latest/tutorial/sandbox). 그래서 herdr 소켓은 전부 여기서 다룬다.

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppState, SessionInfo } from '../shared/types.js'
import { startControlServer } from './control.js'
import { SessionLink } from './herdr/session-link.js'
import { closeLog, log, logFile, openLog } from './log.js'
import { SESSION_POLL_MS, listSessions } from './sessions.js'

const here = path.dirname(fileURLToPath(import.meta.url))

let window: BrowserWindow | null = null
let revision = 0
let sessions: SessionInfo[] = []
let sessionsError: string | null = null
let selectedSession: string | null = null
let selectedPaneId: string | null = null
let emitScheduled = false

const link = new SessionLink({ onChange: () => scheduleEmit() })

function currentState(): AppState {
  const rows = link.store.rows()
  // 선택한 pane 이 사라지면 선택을 비운다 (L4) — 앱은 빈 상태로 떨어지고 깨지지 않는다.
  if (selectedPaneId !== null && !rows.some((row) => row.panes.some((pane) => pane.paneId === selectedPaneId))) {
    log('ui.selection.cleared', { paneId: selectedPaneId, reason: '대상이 사라짐' })
    selectedPaneId = null
  }
  return {
    revision,
    sessions,
    sessionsError,
    selectedSession,
    link: link.linkState(),
    workspaces: rows,
    selectedPaneId,
    // S3 프로브는 개발·계측 실행에서만 띄운다. 패키징된 앱의 평시 화면에는 나오지 않는다.
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
    const state = currentState()
    log('state.emit', {
      revision: state.revision,
      phase: state.link.phase,
      workspaces: state.workspaces.map((row) => `${row.workspaceId}:${row.label}:${row.paneCount}`),
      panes: state.workspaces.flatMap((row) => row.panes.map((pane) => pane.paneId)),
    })
    window?.webContents.send('corral:state', state)
  }, 0)
}

function pickSession(name: string): void {
  const found = sessions.find((session) => session.name === name)
  if (!found) {
    log('session.select.missing', { name })
    return
  }
  selectedSession = name
  selectedPaneId = null
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
      (wanted ? sessions.find((session) => session.name === wanted) : undefined) ??
      sessions.find((session) => session.isDefault) ??
      sessions[0]
    if (target) pickSession(target.name)
  }
  scheduleEmit()
}

async function capture(name: string): Promise<string> {
  const dir = process.env.CORRAL_SHOT_DIR ?? path.join(app.getPath('userData'), 'shots')
  fs.mkdirSync(dir, { recursive: true })
  const target = window
  if (target === null) throw new Error('창이 없다')
  const image = await target.webContents.capturePage()
  const file = path.join(dir, `${name}.png`)
  fs.writeFileSync(file, image.toPNG())
  log('shot.captured', { name, file, revision })
  return file
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    backgroundColor: '#12141a',
    title: 'corral',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      // S3 — 셋 다 켠다. sandbox:true 라서 렌더러/preload 는 net 을 쓸 수 없다.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.on('ready-to-show', () => window?.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) void window.loadURL(devServer)
  else void window.loadFile(path.join(here, '../renderer/index.html'))
}

// main 의 uncaught exception 은 Electron 기본 동작이 모달이다 — 사용자 화면을 막는다.
// 여기서 잡아 로그로 남기면 앱은 살아 있고 실패는 파일에 식별 가능하게 남는다.
process.on('uncaughtException', (error) => log('main.uncaught_exception', { error: String(error), stack: error.stack }))
process.on('unhandledRejection', (reason) => log('main.unhandled_rejection', { reason: String(reason) }))

app.whenReady().then(() => {
  const file = openLog(app.getPath('userData'))
  log('app.ready', { logFile: file, electron: process.versions.electron, node: process.versions.node })

  ipcMain.handle('corral:getState', () => currentState())
  ipcMain.handle('corral:selectSession', (_event, name: string) => pickSession(name))
  ipcMain.handle('corral:selectPane', (_event, paneId: string | null) => {
    selectedPaneId = paneId
    log('ui.selection.set', { paneId })
    scheduleEmit()
  })
  ipcMain.handle('corral:refreshSessions', () => pollSessions())
  ipcMain.on('corral:reportRendered', (_event, rendered: number) => {
    log('ui.rendered', { revision: rendered })
  })
  ipcMain.on('corral:reportProbe', (_event, name: string, detail: Record<string, string>) => {
    log('renderer.probe', { name, ...detail })
  })

  createWindow()
  void pollSessions()
  setInterval(() => void pollSessions(), SESSION_POLL_MS)

  startControlServer({
    capture,
    selectSession: pickSession,
    selectPane: (paneId) => {
      selectedPaneId = paneId
      log('ui.selection.set', { paneId })
      scheduleEmit()
    },
    state: () => currentState(),
    verify: () => link.verifyConvergence(),
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
