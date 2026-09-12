// Electron main — 소켓을 소유하는 쪽.
//
// 렌더러가 소켓을 열 수 없는 것은 권장이 아니라 구조적 강제다: sandbox:true 인 렌더러/preload 의
// require 화이트리스트에는 net 이 없다. 그래서 herdr 소켓은 전부 여기서 다룬다.
//
// 이 파일은 **어댑터의 공개 입구만** import 한다 (`./adapter/index.js`). internal 은 모른다.

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddRepoResult, AppState, BrowseReposResult, RemoveRepoResult, TerminalScroll } from '../shared/types.js'
import { SESSION_POLL_MS, SessionLink, TerminalStream, listSessions, type SessionHandle } from './adapter/index.js'
import { decideRoots } from './browse-repos.js'
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
  onTopologyChange: () => {
    scheduleTree()
    dropStreamIfPaneGone()
  },
})

/**
 * 터미널 스트림 (R2) — herdr-client.sock 의 endpoint 연결. control 링크와 **별개 소켓·별개
 * 연결**이라 순서 보장이 없다 (A3 관찰 대상). 살아 있는 연결은 한 번에 하나 (stream.ts 주석).
 */
const stream = new TerminalStream({
  onFrame: (frame) => {
    if (window !== null && !window.isDestroyed()) window.webContents.send('corral:termFrame', frame)
  },
  onState: () => scheduleEmit(),
  // OSC 52 — pane 안의 복사를 OS 클립보드로 (A1). 벤더가 base64 검증, stream 이 디코드까지.
  // Electron 44 의 clipboard 는 W3C 모양(Promise)이다 — 실패는 로그로만 남긴다.
  onClipboard: (text) => void clipboard.writeText(text).catch((error) => log('clipboard.write_failed', { error: String(error) })),
})

/**
 * 스트리밍 중인 pane 이 목록에서 사라졌으면 스트림을 닫는다.
 *
 * pane 이 닫히면 endpoint surface 에서 그 pane 이 빠져 프레임만 조용히 멎는다 — 벤더 세션은
 * 기다릴 뿐 오류를 내지 않는다. 사라짐을 아는 쪽은 control 링크(store)이므로 여기서 잇는다.
 * (pane 이 **다른 탭으로 이동**한 경우는 store 에 남아 있어 닫지 않는다 — 프레임이 멎고
 * 사용자가 다시 고르면 새 세션이 pane.focus 로 따라간다. 00-analysis §3-2)
 */
function dropStreamIfPaneGone(): void {
  const paneId = stream.terminalState().paneId
  if (paneId === null) return
  if (link.store.paneIds().includes(paneId)) return
  log('stream.pane_gone', { paneId })
  stream.close()
  scheduleEmit()
}

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
    terminal: stream.terminalState(),
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

/**
 * 레포 하나를 목록에서 뺀다 (게이트 ① 3번째 지시, 2026-09-12).
 *
 * `addRepo` 와 **같은 모양**이다 — 레지스트리를 고치고, 목록을 다시 세우고, 화면에 민다.
 * herdr 는 부르지 않는다: 뺀 뒤 `scheduleTree()` 가 도는 것은 남은 레포들의 worktree 를
 * 다시 읽기 위해서고, 뺀 레포에 대해서는 아무 요청도 안 나간다.
 */
function removeRepo(input: string): RemoveRepoResult {
  const result = registry?.remove(input) ?? { ok: false, error: '레지스트리 미초기화' }
  if (result.ok) scheduleTree()
  scheduleEmit()
  return result
}

/**
 * 네이티브 다이얼로그의 **결과만** 갈아끼우는 손잡이 (게이트 ① 2번째 지시 (5) — 계측용).
 *
 * macOS 폴더 선택기는 OS 가 그리는 창이라 하네스가 못 누른다. 그래서 그 한 줄만 스텁으로
 * 바꿀 수 있게 해 두고, **나머지 경로는 전부 진짜로** 지나가게 한다 — 버튼 클릭 → preload →
 * IPC → main → 판별 → `registry.add()` → 상태 반영. 스텁이 대신하는 것은 "사용자가 폴더를
 * 골랐다" 한 걸음뿐이고, 그 사실은 `browse.dialog` 로그의 `stub: true` 로 원자료에 남는다.
 *
 * 손잡이는 **제어 채널에만** 달려 있다. 제어 서버는 `CORRAL_CONTROL_SOCKET` 이 있을 때만 서므로
 * 평시 앱에는 이 값을 세울 길 자체가 없다.
 *
 * 값이 셋인 이유: `null` 은 "스텁 없음"(진짜 다이얼로그를 연다)이고, "사용자가 그냥 닫았다" 는
 * 그것과 **다른 상태**다. 둘을 한 값으로 묶었더니 취소 회차가 진짜 OS 창을 열어 측정이
 * 거기서 멈췄다 (수정 5회차 실측).
 */
let dialogStub: { canceled: true } | { path: string } | null = null

/** 다이얼로그가 떠 있는 동안 두 번째 클릭이 창을 하나 더 띄우지 않게. */
let browsing = false

async function browseForRepos(): Promise<BrowseReposResult> {
  const empty = { added: [], alreadyRegistered: [], failed: [] }
  if (browsing) {
    log('browse.busy', {})
    return { ok: false, canceled: true, selected: null, mode: null, ...empty, message: null }
  }
  browsing = true
  try {
    log('browse.opened', { stubbed: dialogStub !== null })
    let selected: string | null = null
    if (dialogStub !== null) {
      selected = 'path' in dialogStub ? dialogStub.path : null
    } else if (window !== null && !window.isDestroyed()) {
      const picked = await dialog.showOpenDialog(window, {
        title: '레포 추가',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '이 폴더 선택',
      })
      selected = picked.canceled ? null : (picked.filePaths[0] ?? null)
    }
    log('browse.dialog', { stub: dialogStub !== null, path: selected })
    if (selected === null) {
      return { ok: true, canceled: true, selected: null, mode: null, ...empty, message: null }
    }

    const decision = await decideRoots(selected)
    log('browse.decided', { mode: decision.mode, candidates: decision.candidates.length, scanned: decision.scanned })

    const added: string[] = []
    const alreadyRegistered: string[] = []
    const failed: Array<{ path: string; error: string }> = []
    // 중복은 **접힌 루트**로 가린다 — 주 체크아웃과 그 링크된 worktree 를 나란히 고르면
    // `add()` 가 둘 다 같은 루트로 접는다. 경로로 세면 "2개 등록" 이라 거짓말하게 된다.
    const before = new Set(registry?.list() ?? [])
    for (const candidate of decision.candidates) {
      const result = addRepo(candidate)
      if (!result.ok) {
        failed.push({ path: candidate, error: result.error ?? '알 수 없음' })
        continue
      }
      const root = result.root ?? candidate
      if (before.has(root)) {
        if (!alreadyRegistered.includes(root)) alreadyRegistered.push(root)
        continue
      }
      if (!added.includes(root)) added.push(root)
      before.add(root)
    }

    const message = browseMessage({ mode: decision.mode, added, alreadyRegistered, failed })
    log('browse.result', { mode: decision.mode, added: added.length, already: alreadyRegistered.length, failed: failed.length })
    return { ok: added.length > 0 || alreadyRegistered.length > 0, canceled: false, selected, mode: decision.mode, added, alreadyRegistered, failed, message }
  } finally {
    browsing = false
  }
}

/** 화면에 그대로 뜨는 한 줄. 0개일 때의 문안은 지시가 준 그대로다. */
function browseMessage(input: {
  mode: 'repo' | 'scan'
  added: string[]
  alreadyRegistered: string[]
  failed: Array<{ path: string; error: string }>
}): string {
  if (input.added.length === 0 && input.alreadyRegistered.length === 0) {
    if (input.mode === 'scan') return '이 폴더에서 git 레포를 찾지 못했다'
    return `등록하지 못했다: ${input.failed[0]?.error ?? '알 수 없음'}`
  }
  const parts: string[] = []
  if (input.added.length > 0) parts.push(`${input.added.length}개 등록`)
  if (input.alreadyRegistered.length > 0) parts.push(`${input.alreadyRegistered.length}개는 이미 있었다`)
  if (input.failed.length > 0) parts.push(`${input.failed.length}개 실패`)
  return parts.join(' · ')
}

function pickSession(name: string): void {
  const found = sessions.find((session) => session.name === name)
  if (found === undefined) {
    log('session.select.missing', { name })
    return
  }
  selectedSession = name
  // 세션이 바뀌면 이전 세션의 pane 스트림은 의미가 없다 — 같이 닫는다.
  stream.close()
  link.open(found)
  scheduleEmit()
}

/** endpoint 소켓은 control 소켓(herdr.sock)과 같은 폴더의 herdr-client.sock 이다. */
function currentClientSocketPath(): string | null {
  const socketPath = currentSocketPath()
  if (socketPath === null) return null
  return path.join(path.dirname(socketPath), 'herdr-client.sock')
}

/**
 * pane 하나를 골라 스트림을 연다 (R2 의 유일한 herdr-client.sock 접촉 트리거).
 *
 * paneId 는 **현재 링크의 목록에 있는 것만** 받는다 — 렌더러가 낡은 id 를 보내면 (pane 이
 * 방금 닫혔으면) 여기서 걸러 식별 가능한 로그로 남긴다. 검증의 진실은 store 다.
 */
function selectPane(input: { paneId: string | null; cols?: number; rows?: number }): void {
  if (input.paneId === null) {
    stream.close()
    scheduleEmit()
    return
  }
  const clientSocketPath = currentClientSocketPath()
  if (clientSocketPath === null) {
    log('stream.select.no_session', { paneId: input.paneId })
    return
  }
  if (!link.store.paneIds().includes(input.paneId)) {
    log('stream.select.unknown_pane', { paneId: input.paneId })
    return
  }
  stream.open({
    clientSocketPath,
    paneId: input.paneId,
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
  })
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
  /**
   * **새 프레임이 올라온 뒤에 찍는다** (수정 6회차 실측).
   *
   * `capturePage()` 는 컴포지터가 **마지막으로 올린 프레임**을 준다. React 가 방금 커밋한
   * DOM 은 아직 그려지기 전일 수 있어서, 그대로 찍으면 한 프레임 전 화면이 나온다 —
   * 6회차 첫 실행에서 `registered-two` 라고 이름 붙인 샷에 **빈 목록**이 찍혔고
   * `confirm-open` 에는 확인 창 대신 그 앞 화면이 찍혔다. DOM 질의는 맞는데 그림만 뒤처진
   * 것이라, 판정자가 원자료의 숫자와 그림을 대조하면 어긋난다.
   *
   * 두 겹으로 막는다:
   *   ① rAF 를 두 번 기다린다 — 첫 번째는 다음 프레임 직전, 두 번째는 그 프레임이 올라간 뒤다.
   *      **타이머로 반드시 빠져나온다**: 창이 가려지면 크로미움이 rAF 를 아예 안 부른다
   *      (이 회차 두 번째 실행에서 세 번째 샷이 거기서 30초 타임아웃으로 죽었다).
   *   ② 그러고도 한 번 버리고 찍는다 — 첫 `capturePage()` 가 프레임 생성을 밀어 주고,
   *      두 번째가 그 새 프레임을 받는다. rAF 가 throttle 돼도 이쪽이 남는다.
   */
  await target.webContents.executeJavaScript(
    `new Promise((resolve) => {
       const timer = setTimeout(() => resolve('timer'), 400)
       requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve('raf') }))
     })`,
    true,
  )
  const shoot = (): Promise<Electron.NativeImage> =>
    rect === undefined ? target.webContents.capturePage() : target.webContents.capturePage(rect)
  await shoot()
  const image = await shoot()
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
  // 렌더러 콘솔을 main 로그로 끌어온다 — 계측 실행에서만(진단 켜짐). 렌더러 예외가
  // 조용히 사라지지 않게 한다 (R2 하네스 디버깅에서 필요했다).
  if (!app.isPackaged || process.env.CORRAL_CONTROL_SOCKET !== undefined) {
    // Electron 44 는 이 이벤트를 (event, level, message, line, sourceId) 위치 인자로 준다.
    window.webContents.on(
      'console-message',
      (_event: Electron.Event, level: number, message: string, line: number, sourceId: string) => {
        if (level >= 2) log('renderer.console', { level, message: message.slice(0, 500), line, sourceId })
      },
    )
  }
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
  ipcMain.handle('corral:removeRepo', (event, root: string) =>
    fromOurWindow(event) ? removeRepo(root) : { ok: false, error: '허용되지 않은 발신자' },
  )
  ipcMain.handle('corral:browseForRepos', (event) =>
    fromOurWindow(event)
      ? browseForRepos()
      : { ok: false, canceled: true, selected: null, mode: null, added: [], alreadyRegistered: [], failed: [], message: null },
  )
  ipcMain.handle('corral:refreshSessions', (event) => (fromOurWindow(event) ? pollSessions() : undefined))
  ipcMain.on('corral:reportRendered', (event, rendered: number) => {
    if (fromOurWindow(event)) log('ui.rendered', { revision: rendered })
  })

  // --- 터미널 스트림 (R2) ---
  ipcMain.handle('corral:selectPane', (event, input: { paneId: string | null; cols?: number; rows?: number }) => {
    if (fromOurWindow(event)) selectPane(input)
  })
  // 입력·리사이즈·스크롤은 fire-and-forget — 왕복을 기다릴 값이 없고 레이턴시(S2)에 민감하다.
  ipcMain.on('corral:termInput', (event, data: string) => {
    if (fromOurWindow(event) && typeof data === 'string') stream.input(data)
  })
  ipcMain.on('corral:termResize', (event, size: { cols: number; rows: number }) => {
    if (!fromOurWindow(event)) return
    if (typeof size?.cols !== 'number' || typeof size?.rows !== 'number') return
    stream.resize({ cols: size.cols, rows: size.rows })
  })
  ipcMain.on('corral:termScroll', (event, scroll: TerminalScroll) => {
    if (fromOurWindow(event)) stream.scroll(scroll)
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
    setDialogStub: (value) => {
      dialogStub = value
      log('browse.stub_set', { stub: value === null ? '(뗌)' : 'path' in value ? value.path : '(취소)' })
    },
    // R2 계측 — S5 는 창 크기를 3단계로 바꾸고, A1 은 OS 클립보드에 실렸는지를 읽는다.
    resizeWindow: (size) => {
      if (window === null || window.isDestroyed()) throw new Error('창이 없다')
      window.setBounds({ width: size.width, height: size.height })
    },
    readClipboard: () => clipboard.readText(),
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stream.close()
  link.close()
  log('app.quit', { logFile: logFile() })
  closeLog()
  app.quit()
})
