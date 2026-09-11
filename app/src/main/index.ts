// Electron main — 소켓을 소유하는 쪽.
//
// 렌더러가 소켓을 열 수 없는 것은 권장이 아니라 구조적 강제다: sandbox:true 인 렌더러/preload 의
// require 화이트리스트는 electron(일부)·events·timers·url 뿐이고 net 이 없다
// (electronjs.org/docs/latest/tutorial/sandbox). 그래서 herdr 소켓은 전부 여기서 다룬다.

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppState, CloseOutcome, SessionInfo, TerminalFrame } from '../shared/types.js'
import { startControlServer } from './control.js'
import { LAUNCH_KINDS, Lifecycle } from './herdr/lifecycle.js'
import { PaneTerminal } from './herdr/pane-terminal.js'
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
/** L8 — 접어 둔 workspace. 화면 취향이라 herdr 에 저장하지 않는다 (corral 로컬 상태). */
const collapsedWorkspaceIds = new Set<string>()
let emitScheduled = false
/**
 * 지금까지 목록에 **실제로 있었던** pane. "선택한 것이 사라졌다" 를 판정하는 기준이다 —
 * 아직 도착 안 한 것과 없어진 것을 가르는 유일한 방법이 이것이다 (currentState 주석).
 */
let knownPaneIds = new Set<string>()

/**
 * LIFE-345 — 선택한 pane 의 터미널. 링크 위에 얹은 얇은 층이다: 구독은 링크 것을 쓰고
 * (`onPanePush`), 스냅샷·입력만 자기 커넥션으로 오간다.
 */
const terminal = new PaneTerminal({
  // 창이 이미 닫힌 뒤에도 하트비트 타이머가 한 박자 더 돌 수 있다. 그때 send 하면
  // "Object has been destroyed" 로 main 이 튄다 — 실제로 계측 종료마다 났다.
  onFrame: (frame: TerminalFrame) => {
    if (window === null || window.isDestroyed()) return
    window.webContents.send('corral:terminalFrame', frame)
  },
  onChange: () => scheduleEmit(),
})

const link = new SessionLink({
  onChange: () => scheduleEmit(),
  onPanePush: (frame) => {
    terminal.onPush(frame)
    lifecycle.onPush(frame)
  },
  onLive: () => terminal.onLinkLive(),
})

/**
 * LIFE-346 — 행의 생성·종료. 목록(store)도 터미널도 건드리지 않는다: 만들면 herdr 가
 * `tab_created`·`pane_created` 를 보내고 목록은 **평소 경로로** 그걸 받는다. 이 층이 직접
 * 맵에 손대면 이벤트 경로와 두 갈래가 되고, 그건 N7 이 금지하는 "덮어 맞추기" 다.
 */
const lifecycle = new Lifecycle({
  onChange: () => scheduleEmit(),
  onPaneCreated: (paneId) => selectPane(paneId),
  describeTab: (tabId) => {
    for (const workspace of link.store.rows()) {
      const tab = workspace.tabs.find((item) => item.tabId === tabId)
      if (tab === undefined) continue
      return {
        workspaceId: workspace.workspaceId,
        agents: tab.panes.map((pane) => pane.agent).filter((agent) => agent !== null),
        paneIds: tab.panes.map((pane) => pane.paneId),
      }
    }
    return null
  },
})

/**
 * A4 — 새 행을 **어디서** 여나.
 *
 * 1순위는 그 workspace 가 열고 있는 checkout 경로다(`worktree.list` 가 준 것). 사용자가 보는
 * 단위가 worktree 라서 새 행도 그 worktree 에서 열려야 말이 맞고, 이 값은 pane 안에서 `cd` 를
 * 해도 안 흔들린다. 2순위는 그 workspace 의 pane 이 실제로 있는 곳. 둘 다 모르면 파라미터를
 * **생략한다** — 그러면 herdr 세션의 launch cwd 로 간다 (실측 §3). 모르는 경로를 지어내지 않는다.
 */
function launchCwd(workspaceId: string): string | null {
  const workspace = link.store.rows().find((row) => row.workspaceId === workspaceId) ?? null
  if (workspace === null) return null
  return workspace.checkoutPath ?? workspace.panes.find((pane) => pane.cwd !== null)?.cwd ?? null
}

/** 지금 선택한 pane 을 터미널 층에 물린다. 선택이 없거나 세션이 없으면 뗀다. */
function retarget(): void {
  const session = sessions.find((item) => item.name === selectedSession) ?? null
  if (selectedPaneId === null || session === null) {
    terminal.attach(null)
    return
  }
  terminal.attach({
    paneId: selectedPaneId,
    socketPath: session.socketPath,
    sessionName: session.name,
    isDefaultSession: session.isDefault,
  })
}

function selectPane(paneId: string | null): void {
  if (paneId === selectedPaneId) return
  selectedPaneId = paneId
  log('ui.selection.set', { paneId })
  retarget()
  scheduleEmit()
}

function currentState(): AppState {
  const rows = link.store.rows()
  const repos = link.store.repoGroups(rows)
  const paneIds = new Set(rows.flatMap((row) => row.panes.map((pane) => pane.paneId)))
  // 선택한 pane 이 사라지면 선택을 비운다 (L4) — 앱은 빈 상태로 떨어지고 깨지지 않는다.
  //
  // **한 번도 본 적 없는 pane 은 "사라진" 것이 아니다** (LIFE-346). 새 행을 만들면 그 pane 을
  // 곧바로 고르는데, 그 시점엔 `pane_created` 가 아직 저장소에 안 들어와 있다 — 예전 규칙은
  // 그걸 "대상이 사라짐" 으로 읽고 **갓 만든 터미널에 사망 표시를 씌웠다** (M4 1회차 샷 001).
  // 사라졌다고 말할 자격은 **있었던 것**에만 있다.
  if (selectedPaneId !== null && !paneIds.has(selectedPaneId) && knownPaneIds.has(selectedPaneId)) {
    log('ui.selection.cleared', { paneId: selectedPaneId, reason: '대상이 사라짐' })
    // 목록에서는 선택을 비우되(그 줄이 이미 없다) **터미널은 마지막 화면을 들고 죽는다** —
    // 지워 버리면 무엇이 죽었는지 화면에 남지 않는다 (R5).
    terminal.markGone('pane_closed — pane 이 목록에서 사라졌다')
    selectedPaneId = null
  }
  knownPaneIds = paneIds
  // 사라진 탭에 붙은 기동·종료 기록은 같이 턴다 — 없는 행에 붙은 표시는 그 자체가 유령이다.
  lifecycle.prune(new Set(rows.flatMap((row) => row.tabs.map((tab) => tab.tabId))))
  return {
    revision,
    sessions,
    sessionsError,
    selectedSession,
    link: link.linkState(),
    workspaces: rows,
    repos,
    selectedPaneId,
    collapsedWorkspaceIds: [...collapsedWorkspaceIds],
    terminal: terminal.state(),
    lifecycle: lifecycle.state(),
    launchKinds: [...LAUNCH_KINDS],
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
    if (window !== null && window.isDestroyed()) window = null
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

function toggleCollapse(workspaceId: string): void {
  if (collapsedWorkspaceIds.has(workspaceId)) collapsedWorkspaceIds.delete(workspaceId)
  else collapsedWorkspaceIds.add(workspaceId)
  log('ui.collapse.toggled', { workspaceId, collapsed: collapsedWorkspaceIds.has(workspaceId) })
  scheduleEmit()
}

function pickSession(name: string): void {
  const found = sessions.find((session) => session.name === name)
  if (!found) {
    log('session.select.missing', { name })
    return
  }
  selectedSession = name
  selectedPaneId = null
  terminal.attach(null)
  // 세션이 바뀌면 진행 중이던 기동 관측은 옛 세션의 일이다 — 세대를 올려 손을 떼게 한다.
  lifecycle.setSession(found)
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

function createRow(input: { workspaceId: string; kind: string; label: string | null }): Promise<{
  ok: boolean
  launchId: string
  error?: string
}> {
  return lifecycle.create({ ...input, cwd: launchCwd(input.workspaceId) })
}

function closeRow(input: { tabId: string; confirmed: boolean }): Promise<CloseOutcome> {
  return lifecycle.close(input)
}

/**
 * 스크린샷. `selector` 를 주면 **그 요소만** 잘라 찍는다.
 *
 * 왜 자르나: T3 은 "정지 화면이 정말 정지해 있나" 를 스크린샷으로 봐야 하는데, 창 전체를 찍으면
 * 헤더의 `rev` 카운터와 왼쪽 목록의 경과 초가 매초 바뀌어 **터미널과 무관하게** 그림이 달라진다.
 * 실제로 첫 측정에서 24장 중 18장이 서로 달랐고 원인이 그것이었다. 잘라 찍으면 비교 대상이
 * 터미널 표면 자체가 된다.
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

/** 계측용 창 크기 (CORRAL_WINDOW=1180x1400). 목록이 긴 화면을 한 장에 담기 위한 것뿐이다. */
function windowSize(): { width: number; height: number } {
  const raw = process.env.CORRAL_WINDOW ?? ''
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(raw)
  if (match === null) return { width: 1180, height: 760 }
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
  ipcMain.handle('corral:selectPane', (_event, paneId: string | null) => selectPane(paneId))
  ipcMain.handle('corral:paneText', (_event, text: string) => terminal.sendText(text))
  ipcMain.handle('corral:paneKeys', (_event, keys: string[]) => terminal.sendKeys(keys))
  ipcMain.handle('corral:toggleCollapse', (_event, workspaceId: string) => toggleCollapse(workspaceId))
  ipcMain.handle('corral:createRow', (_event, input: { workspaceId: string; kind: string; label: string | null }) =>
    createRow(input),
  )
  ipcMain.handle('corral:closeRow', (_event, input: { tabId: string; confirmed: boolean }) => closeRow(input))
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
    selectPane,
    terminal,
    window: () => window,
    toggleCollapse,
    state: () => currentState(),
    verify: () => link.verifyConvergence(),
    createRow,
    closeRow,
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  terminal.detach()
  link.close()
  log('app.quit', { logFile: logFile() })
  closeLog()
  app.quit()
})
