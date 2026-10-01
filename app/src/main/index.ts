import { RuntimeError } from '../runtime/contracts.js'
import { randomUUID } from 'node:crypto'
import type { TerminalDesktop } from '../runtime/terminal/index.js'
import type { WorkspaceDesktop } from '../runtime/workspace/model.js'
import { startRuntime, restoreBackend } from '../runtime/server.js'
import { KeybindingStore } from './keybindings.js'
import { withRetentionSuppressed } from './close-retention.js'
import { matchBinding } from '../shared/keybindings.js'
// Electron main — 소켓을 소유하는 쪽.
//
// 렌더러가 소켓을 열 수 없는 것은 권장이 아니라 구조적 강제다: sandbox:true 인 렌더러/preload 의
// require 화이트리스트에는 net 이 없다. 그래서 herdr 소켓은 전부 여기서 다룬다.
//
// 이 파일은 **어댑터의 공개 입구만** import 한다 (`./adapter/index.js`). internal 은 모른다.

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  AddRepoResult,
  AgentKind,
  AppState,
  BrowseReposResult,
  CloseRowResult,
  CreateRowResult,
  IntegrationRow,
  RemoveRepoResult,
  RenameRowResult,
  PaneActionResult,
  PaneNeighborResult,
  PaneSplitResult,
  PaneDirection,
  PaneSplitDirection,
  SessionDigest,
  TerminalGroupRequest,
  TerminalScroll,
  UiPrefs,
  WorktreeActionResult,
} from '../shared/types.js'
import {
  SESSION_POLL_MS,
  SessionLink,
  TerminalStreams,
  closePane,
  closeTab,
  closeWorkspace,
  createRow,
  createWorktree,
  listSessions,
  openWorkspace,
  openWorktree,
  probeForeground,
  neighborPane,
  readIntegrations,
  readOpenWorkspaces,
  renameTab,
  resizePane,
  splitPane,
  zoomPane,
  type SessionHandle,
} from './adapter/index.js'
import { decideRoots } from './browse-repos.js'
import { canonicalPath } from './canonical-path.js'
import { startControlServer } from './control.js'
import { closeLog, log, logFile, openLog } from './log.js'
import { pickSessionName } from './pick-session.js'
import { RepoRegistry } from './registry.js'
import { RegistryGeneration } from './registry-generation.js'
import { attachDigests, buildSkeleton, collectSessionRefs, joinTree, type RepoSkeleton } from './tree.js'
import { clearTranscriptCache, digestsEqual, readSessionDigests } from './transcript.js'
import { UiPrefsStore } from './ui-prefs.js'
import { LineageFeed } from './orchestration-lineage.js'
import { observePanes } from '../runtime/orchestration/index.js'
import { OrchestrationStore } from '../runtime/orchestration/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 측정 실행인가 — control 소켓이 붙었을 때만 참. A4 프레임 로그 같은 계측 잡음을 여기 가둔다. */
if (process.env.CORRAL_USER_DATA) app.setPath('userData', process.env.CORRAL_USER_DATA)
let stopRuntime: (() => Promise<void>) | null = null
let keybindings: KeybindingStore
let shortcutRecording = false
const measuring = (process.env.CORRAL_CONTROL_SOCKET ?? '').length > 0

let window: BrowserWindow | null = null
let revision = 0
/** 소켓 경로를 든 목록은 **여기까지만** 산다 (수정 1회차 L9) — 화면으로는 이름·running 만 간다. */
let sessions: SessionHandle[] = []
let sessionsError: string | null = null
let selectedSession: string | null = null
let sessionNote: string | null = null
let registry: RepoRegistry | null = null
let uiPrefs: UiPrefsStore | null = null
/** 비싼 쪽(git·herdr 왕복)만 캐시한다. 행은 내보낼 때마다 새로 붙인다 — tree.ts 의 주석 참고. */
let skeleton: RepoSkeleton[] = []
let emitScheduled = false
let treeScheduled = false
/**
 * 탭별 세션 지문 (LIFE-366). **내보내기와 읽기를 갈라 둔다** — 내보내기는 push 마다 일어나고,
 * 디스크 읽기는 그 박자로 돌면 안 된다 (기준 A7). 여기는 주기가 채우고 emit 은 붙이기만 한다.
 */
let digests = new Map<string, SessionDigest>()
let integrations: IntegrationRow[] = []
let digestTimer: NodeJS.Timeout | null = null

const link = new SessionLink({
  onChange: () => scheduleEmit(),
  // 목록 위상이 바뀌었으면 worktree 열림상태를 다시 읽는다 — 그게 N4ⓒ 의 진실 출처다.
  onTopologyChange: () => {
    scheduleTree()
    dropStreamIfPaneGone()
  },
  // 재동기 때 worktree→workspace 바인딩도 새로 대조한다 (버그 ①). 행 대조(reconcile)는 이걸 못 본다.
  onResync: (reason) => refreshBindings(reason),
})

/**
 * 터미널 스트림 (R2) — herdr-client.sock 의 endpoint 연결. control 링크와 **별개 소켓·별개
 * 연결**이라 순서 보장이 없다 (A3 관찰 대상). 살아 있는 연결은 한 번에 하나 (stream.ts 주석).
 */
const stream = new TerminalStreams({
  measuring,
  hooks: {
    onFrame: (frame) => {
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:termFrame', frame)
      // A4 프레임 로그는 이제 stream.ts 한 곳에서만 남긴다 (수정 1회차 C1) — 여기서 또 찍으면
      // A4 가 프레임을 두 번 세고, frame.data.length 는 BSU/ESU 래퍼(+16B)까지 포함해 부풀린다.
    },
    onState: () => scheduleEmit(),
    // OSC 52 — pane 안의 복사를 OS 클립보드로 (A1). 벤더가 base64 검증, stream 이 디코드까지.
    // Electron 44 의 clipboard 는 W3C 모양(Promise)이다 — 실패는 로그로만 남긴다.
    onClipboard: (text) => void clipboard.writeText(text).catch((error) => log('clipboard.write_failed', { error: String(error) })),
  },
})

/**
 * 목록에서 사라진 pane 을 **연결 명부에서 뺀다** (LIFE-373 §10-R16 축출).
 *
 * pane 이 닫히면 endpoint surface 에서 그 pane 이 빠져 프레임만 조용히 멎는다 — 세션은 기다릴 뿐
 * 오류를 내지 않는다. 게다가 **patch 서피스는 사라진 pane 을 알려주지 않으므로**(R7) 다음 전체
 * 서피스까지 누적 명부에 stale 로 남고, 그 사이 입력이 그 pane 으로 가면 S1 가드를 그냥 통과해
 * herdr 가 조용히 버린다. 사라짐을 제때 아는 쪽은 control 링크(store)라 여기서 잇는다.
 *
 * LIFE-353 과 달라진 것: 연결을 **닫지 않는다**. 연결의 단위가 pane 이 아니라 영역(탭)이라
 * pane 하나가 사라진다고 그 탭의 연결을 죽일 이유가 없다 — 명부에서만 뺀다.
 * (연결을 닫는 판단은 렌더러의 영역 선언(`syncTermGroups`)이 한다 — S4.)
 */
function dropStreamIfPaneGone(): void {
  const alive = new Set(link.store.paneIds())
  const gone = stream.heldPaneIds().filter((paneId) => !alive.has(paneId))
  if (gone.length === 0) return
  log('stream.pane_gone', { panes: gone.join(',') })
  stream.evictPanes(gone)
  scheduleEmit()
}

/**
 * **화면에 그려질 수 있는** pane id 들 — 렌더러 `TerminalPanel` 이 마운트 판정에 쓰는 것과
 * 같은 트리(joinTree 결과)를 걷는다 (수정 1회차 C2). 렌더러가 pane 을 살아 있다고 보는 조건은
 * "state.repos 트리 안에 그 paneId 가 있다" 이므로, 여기서도 같은 트리로 센다.
 */
function renderablePaneIds(): Set<string> {
  const ids = new Set<string>()
  for (const repo of joinTree(skeleton, link.store.rows()).repos) {
    for (const worktree of repo.worktrees) {
      if (worktree.workspace === null) continue
      for (const tab of worktree.workspace.tabs) {
        for (const pane of tab.panes) ids.add(pane.paneId)
      }
    }
  }
  return ids
}

/**
 * **더는 트리에 없는** pane(예: 그 레포가 목록에서 빠졌다)을 명부에서 뺀다 (수정 1회차 C2 — codex 중간2).
 *
 * `dropStreamIfPaneGone` 은 pane 이 **herdr 위상에서** 사라진 경우(store)를 잡지만, 레포 제거는
 * herdr pane 을 건드리지 않는다 — store 엔 그대로 있고 corral **트리에서만** 빠진다. 그러면
 * 렌더러는 `TerminalPane` 을 언마운트하는데(App.tsx TerminalPanel), main 스트림은 열린 채 남아
 * 프레임을 계속 받는다(누수). 그래서 렌더러와 **같은 트리 기준**으로 여기서 뺀다.
 *
 * 링크가 live 일 때만 판정한다: 재접속 중엔 `store.rows()` 가 일시적으로 비어 트리에 pane 이
 * 하나도 안 잡히는데, 그때 빼면 곧 되살아날 멀쩡한 pane 을 명부에서 지운다 (advisor 가드).
 */
function dropStreamIfPaneUnviewable(): void {
  if (link.linkState().phase !== 'live') return
  const renderable = renderablePaneIds()
  const gone = stream.heldPaneIds().filter((paneId) => !renderable.has(paneId))
  if (gone.length === 0) return
  log('stream.pane_unviewable', { panes: gone.join(',') })
  stream.evictPanes(gone)
  scheduleEmit()
}

function currentSocketPath(): string | null {
  return sessions.find((item) => item.name === selectedSession)?.socketPath ?? null
}

/**
 * 홈 디렉터리의 **실경로** (LIFE-366 C11ⓒ, 수정 라운드 8).
 *
 * herdr 가 주는 `foreground_cwd` 는 실경로인데 `HOME` 은 심링크일 수 있다 — 그러면 `~` 로 접히지
 * 않는다. r7 계측에서 실제로 밟았다(격리 HOME 이 `/tmp/l366h` 링크라 경로가 안 접혔다).
 * macOS 의 `/tmp` → `/private/tmp` 도 같은 모양이다. 못 풀면 원래 값을 쓴다.
 */
function homeDirReal(): string {
  const home = os.homedir()
  try {
    return fs.realpathSync(home)
  } catch {
    return home
  }
}

function currentState(): AppState {
  const tree = joinTree(skeleton, attachDigests(link.store.rows(), digests))
  // 등록 목록과 그 세대는 **같은 읽기**에서 낸다 — 렌더러가 둘을 한 순간의 값으로 믿는다(R3-01).
  const registryState = registry?.state() ?? { file: '', roots: [], lastError: '레지스트리 미초기화' }
  return {
    revision,
    // 소켓 경로를 떼고 내보낸다 — 경계의 약속이 화면 상태로 새지 않게 (L9).
    sessions: sessions.map(({ name, isDefault, running }) => ({ name, isDefault, running })),
    sessionsError,
    selectedSession,
    sessionNote,
    link: link.linkState(),
    registry: registryState,
    registryGeneration: registryGeneration.observe(registryState.roots),
    repos: tree.repos,
    terminal: stream.terminalState(),
    terminalGroups: stream.groupStates(),
    integrations,
    /**
     * 닫힌 뒤에도 남긴 **마지막 완료 기록** (LIFE-456 S15ⓓ). 산 pane 목록(`repos`)과 섞지
     * 않는다 — 섞으면 화면이 없는 pane 에 입력을 보내려 든다. 표시는 448·449 몫이고,
     * 여기서는 렌더러가 고를 수 있게 **공급만** 한다.
     */
    retainedAgents: link.store.retainedRows(),
    // 진단 표시는 개발·계측 실행에서만. 패키징된 앱의 평시 화면에는 안 나온다.
    diagnostics: !app.isPackaged || process.env.CORRAL_CONTROL_SOCKET !== undefined,
    // 셸 탭 폴백이 경로를 접는 데 쓴다 (C9·C11ⓒ). `os.homedir()` 은 `HOME` 을 따르므로 격리
    // 실행에서 격리 HOME 이 실린다 — 판독층이 트랜스크립트를 찾는 뿌리와 같은 값이다.
    home: homeDirReal(),
    orchestrationLineage: lineage.current(),
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
  // 트리가 새로 서면 스트리밍 pane 이 아직 트리 안에 있는지 확인한다 (C2) — 레포 제거로
  // 트리에서 빠졌으면 여기서 스트림을 닫는다. scheduleEmit 은 안에서 한 번 더 뭉쳐 부른다.
  dropStreamIfPaneUnviewable()
  refreshDigests() // 탭이 늘었으면 그 지문도 같이 (LIFE-366) — 주기를 기다리지 않는다
  scheduleEmit()
}

/**
 * **바인딩만** 다시 대조한다 (게이트 ① 버그 ① — 재동기가 부른다).
 *
 * `rebuildTree` 는 레포마다 `git worktree list`(비쌈)까지 도는데, 여기서 재려는 것은 worktree
 * 구조가 아니라 **열림상태**뿐이다. herdr `worktree.list` 만 왕복해(git 없음, 소켓 1회) 열림
 * 바인딩을 새로 읽고, 골격의 낡은 `openWorkspaceId` 와 대조해 어긋난 것만 제자리에서 갈아끼운다.
 *
 * 왜 재동기에 얹나: `store.reconcile` 은 workspace/tab/pane **행**만 본다. pane 이 cd 로 worktree
 * 경계를 넘나든 뒤 골격이 옛 바인딩을 든 채여도 행에는 드리프트가 없어 재동기가 '어긋난 것 없음'이라
 * 하고 자가 회복이 안 됐다. 이 갱신이 그 구멍을 메운다 — 그리고 무엇을 걷었는지 로그·note 로 남긴다.
 *
 * 세대 가드: 읽는 사이에 `rebuildTree` 가 끼면(더 새 골격) 패치를 버린다 (L6 와 같은 결).
 * 읽기 실패한 루트는 옛 바인딩을 그대로 둔다 — 일시적 실패로 트리를 비우지 않는다.
 */
async function refreshBindings(reason: string): Promise<{ changed: boolean; note: string | null }> {
  const socketPath = currentSocketPath()
  const roots = registry?.list() ?? []
  if (socketPath === null || roots.length === 0) return { changed: false, note: null }
  const generation = treeGeneration
  const byPathByRoot = new Map<string, Map<string, string>>()
  for (const root of roots) {
    const open = await readOpenWorkspaces(socketPath, root)
    if (open.error !== null) {
      log('binding.read_failed', { reason, root, error: open.error })
      continue // 이 루트는 옛 바인딩 유지
    }
    byPathByRoot.set(root, open.byPath)
  }
  if (generation !== treeGeneration) {
    log('binding.stale', { reason, generation, current: treeGeneration })
    return { changed: false, note: null }
  }
  const drift: Array<{ worktree: string; from: string | null; to: string | null }> = []
  const patched = skeleton.map((repo) => {
    const byPath = byPathByRoot.get(repo.root)
    if (byPath === undefined) return repo // 읽기 실패·미대상 루트는 건드리지 않는다
    return {
      ...repo,
      worktrees: repo.worktrees.map((worktree) => {
        const fresh = byPath.get(worktree.path) ?? null
        if (fresh === worktree.openWorkspaceId) return worktree
        drift.push({ worktree: worktree.path, from: worktree.openWorkspaceId, to: fresh })
        return { ...worktree, openWorkspaceId: fresh }
      }),
    }
  })
  if (drift.length === 0) return { changed: false, note: null }
  skeleton = patched
  log('tree.binding_drift', { reason, drift })
  dropStreamIfPaneUnviewable() // 바인딩이 걷히며 스트리밍 pane 이 트리 밖이 될 수 있다 (C2)
  scheduleEmit()
  return { changed: true, note: `바인딩 ${drift.length}건 갱신` }
}

/**
 * 레지스트리 세대 — 등록 목록이 바뀐 것을 관측할 때마다 오른다(LIFE-469 R2-01·R3-01, `AppState.registryGeneration`).
 * GUI·CLI(`workspaceModule`)·앱 밖 편집을 가리지 않는다 — 관측 지점은 `currentState` 와 `removeRepo`.
 */
const registryGeneration = new RegistryGeneration()

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
  if (!result.ok) {
    scheduleEmit()
    return result
  }
  // 제거를 지금 관측한다 — 응답의 세대가 「제거가 반영된 목록」의 세대다. 이 뒤 그 root 가 다시 보이면 세대가 더 크다.
  const generation = registryGeneration.observe(registry?.list() ?? [])
  scheduleTree()
  scheduleEmit()
  return { ...result, registryGeneration: generation }
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

// --- 라이프사이클 (R3 — LIFE-356) --------------------------------------------

type ParentResult =
  // `opened` — 이 호출이 부모를 **새로 열었나** (게이트 ① G4: linked 열기의 "함께 열림" 알림 근거).
  | { ok: true; workspaceId: string; opened: boolean }
  | { ok: false; rejection: WorktreeActionResult['rejection']; error: string | null }

/**
 * 부모(주 체크아웃) workspace 를 여는 **in-flight 약속**을 경로별로 공유한다 (수정 2회차 F-1).
 * 대상 경로 가드(`openingWorktrees`)는 "두 번째를 무시" 지만, 부모는 두 호출(예: primary·linked
 * 동시 열기, worktree 만들기)이 **같은 id 를 써야** 한다 — 그래서 무시가 아니라 **같은 약속을
 * 기다려 공유**한다. 이게 없으면 두 경로가 각자 `workspace.create` 를 불러 부모가 이중 생성된다.
 */
const parentOpenInFlight = new Map<string, Promise<ParentResult>>()

/**
 * worktree 열기·만들기의 공통 전제 — **parent(주 체크아웃) workspace 를 확보한다**.
 *
 * 실측(00-probe-findings): `worktree.open`/`create` 는 주 체크아웃 workspace 가 열려 있어야
 * 하고 그 id 를 받는다. 닫힌 채로는 여는 문이 없다 — 그래서 여기서 연다 (L8 빈 상태 복구의 문).
 *
 * **수정 2회차 F-1**: 대상 경로와 **같은 급의 방어**를 부모에도 건다.
 *   ① in-flight 공유 먼저 — 여는 중이면 같은 약속을 기다려 같은 id 를 쓴다 (이중 create 금지).
 *   ② 권위 재확인 — **스테일 skeleton 이 아니라** herdr `worktree.list` 로 primary 열림을 본다.
 *   ③ open.error(읽기 실패) 폴스루도 이 in-flight 안에서만 create 하므로 동시 호출은 안전하다.
 */
async function resolveParentWorkspace(repoRoot: string): Promise<ParentResult> {
  const socketPath = currentSocketPath()
  if (socketPath === null) return { ok: false, rejection: null, error: '세션이 없다' }
  const parentKey = canonicalPath(repoRoot)

  // ① in-flight 공유 — 여는 중이면 그 약속을 그대로 기다린다 (두 경로가 같은 부모 id 를 쓴다).
  const pending = parentOpenInFlight.get(parentKey)
  if (pending) {
    log('lifecycle.parent.in_flight_join', { repoRoot: parentKey })
    return pending
  }

  const promise = (async (): Promise<ParentResult> => {
    // ② 권위 재확인 (스테일 skeleton 아님) — 이미 열려 있으면 그 id (중복 부모 create 금지).
    const open = await readOpenWorkspaces(socketPath, repoRoot)
    if (open.error === null) {
      const primaryOpen = open.byPath.get(parentKey) ?? null
      if (primaryOpen !== null) {
        log('lifecycle.parent.already_open', { repoRoot: parentKey, workspaceId: primaryOpen })
        return { ok: true, workspaceId: primaryOpen, opened: false }
      }
    } else {
      // ③ 읽기 실패 폴스루 — 열림상태를 확정 못 하지만 in-flight 가 동시 호출을 이미 하나로 묶었다.
      log('lifecycle.parent.read_error_fallthrough', { repoRoot: parentKey, error: open.error })
    }
    const opened = await openWorkspace(socketPath, repoRoot)
    if (!opened.ok || opened.workspaceId === null) {
      return { ok: false, rejection: opened.rejection, error: opened.error ?? 'parent workspace 를 못 열었다' }
    }
    scheduleTree()
    return { ok: true, workspaceId: opened.workspaceId, opened: true }
  })()
  parentOpenInFlight.set(parentKey, promise)
  try {
    return await promise
  } finally {
    parentOpenInFlight.delete(parentKey)
  }
}

/** 열린 workspace 에 새 행을 만든다 (L1·L2). store 가 push 로 곧 반영한다. */
async function createRowInWorkspace(input: { workspaceId: string; kind: AgentKind }): Promise<CreateRowResult> {
  const socketPath = currentSocketPath()
  if (socketPath === null) return { ok: false, paneId: null, tabId: null, retries: 0, error: '세션이 없다' }
  const outcome = await createRow(socketPath, input)
  scheduleEmit()
  return outcome
}

/**
 * 종료 게이트 (L3·L4). 판별자는 herdr `pane.process_info` 다 (관문 ⑤) — 주어진 pane 들을
 * 종료 **직전에** 떠서 포그라운드 그룹이 셸 pid 와 같은지 본다. 하나라도 다르면(=산 프로세스)
 * 확인이 필요하다. probe 실패는 **묻는 쪽**으로 기운다 (LIFE-346).
 *
 * 왜 종료 직전 main 에서 떠서 판단하나: store 의 pane.agent 는 ~2.5초 늦게 와서, 그걸 믿으면
 * 도는 에이전트가 확인 없이 죽었다 (LIFE-346 M2 20/20).
 */
async function checkCloseGate(
  socketPath: string,
  paneIds: readonly string[],
  subject: Record<string, unknown>,
): Promise<{ clear: true } | { clear: false; foreground: string[] }> {
  const running: string[] = []
  for (const paneId of paneIds) {
    const probe = await probeForeground(socketPath, paneId)
    const clear = probe.ok && probe.shellPid !== null && probe.foregroundGroupId === probe.shellPid
    log('lifecycle.close_gate', {
      ...subject,
      paneId,
      shellPid: probe.shellPid,
      foregroundGroupId: probe.foregroundGroupId,
      clear,
      foreground: probe.foreground.map((item) => item.name),
      probeError: probe.error,
    })
    if (clear) continue
    if (probe.ok) for (const item of probe.foreground) running.push(item.cmdline ?? item.name)
    else running.push(`(프로세스 확인 실패: ${probe.error})`)
  }
  return running.length > 0 ? { clear: false, foreground: running } : { clear: true }
}

/** 행(탭)을 닫는다 (L3·L4·L9a). `confirmed:true` 면 게이트를 건너뛴다. */
async function closeRowByTab(input: { tabId: string; confirmed?: boolean }): Promise<CloseRowResult> {
  const socketPath = currentSocketPath()
  if (socketPath === null) return { outcome: 'error', error: '세션이 없다' }
  const paneIds: string[] = []
  for (const workspace of link.store.rows()) {
    for (const tab of workspace.tabs) {
      if (tab.tabId !== input.tabId) continue
      for (const pane of tab.panes) paneIds.push(pane.paneId)
    }
  }

  if (input.confirmed !== true) {
    const gate = await checkCloseGate(socketPath, paneIds, { close: 'tab', tabId: input.tabId })
    if (!gate.clear) return { outcome: 'needs-confirm', foreground: gate.foreground }
  }

  // S15ⓓ ② — 사용자가 **명시적으로** 닫는 탭이다. 그 닫힘은 완료 행으로 되살리지 않는다.
  const outcome = await withRetentionSuppressed({
    store: link.store,
    ids: [input.tabId],
    what: 'tab',
    run: hooks => closeTab(socketPath, input.tabId, hooks),
  })
  if (outcome.outcome === 'closed') {
    scheduleEmit()
    return { outcome: 'closed' }
  }
  if (outcome.outcome === 'rejected') return { outcome: 'rejected', rejection: outcome.rejection }
  return { outcome: 'error', error: outcome.error }
}

/**
 * 탭 이름을 바꾼다 (I-7). 종료 게이트가 없다 — 이름은 잃을 게 없는 조작이라 확인 걸음도 없다.
 * herdr 가 거절하면 **그대로** 돌려준다 (`closeRowByTab` 과 같은 기준, 승격 금지).
 */
async function renameRowByTab(input: { tabId: string; label: string }): Promise<RenameRowResult> {
  const socketPath = currentSocketPath()
  if (socketPath === null) return { outcome: 'error', error: '세션이 없다' }
  const outcome = await renameTab(socketPath, input.tabId, input.label)
  if (outcome.outcome === 'renamed') {
    // ⚠ 이 호출은 **새 이름을 화면에 싣지 않는다** (L-c 정정). `scheduleEmit` 은 지금 store 가
    // 들고 있는 스냅샷을 한 박자 뭉쳐 다시 밀 뿐이고, 이 시점 store 에는 옛 label 이 있다.
    // 화면이 바뀌는 건 herdr 의 `tab_renamed` 푸시가 store 를 갱신할 때이고, 그 경로는
    // `link.hooks.onChange → scheduleEmit`(`:70`) 이 이미 잡는다. 여기 남기는 이유는 하나 —
    // 푸시가 응답보다 **먼저** 와서 뭉침 창을 이미 소비했을 때 한 번 더 밀어 주는 안전망이다.
    scheduleEmit()
    return { outcome: 'renamed' }
  }
  return outcome
}

/**
 * worktree(=workspace)를 닫는다 (L9b). 열린 worktree 행의 「닫기」 가 부른다 — 「열기」의 짝이다.
 * linked 그룹이 열린 primary 를 닫으면 herdr 가 `workspace_group_close_required` 로 거절하고,
 * corral 은 그 거절을 **그대로 보이고 멈춘다** (close_group 승격 금지, 기준). 게이트는 그 workspace 의
 * 모든 pane 을 본다 — 하나라도 산 프로세스면 확인.
 */
async function closeWorktreeByWorkspace(input: { workspaceId: string; confirmed?: boolean }): Promise<CloseRowResult> {
  const socketPath = currentSocketPath()
  if (socketPath === null) return { outcome: 'error', error: '세션이 없다' }
  const paneIds: string[] = []
  for (const workspace of link.store.rows()) {
    if (workspace.workspaceId !== input.workspaceId) continue
    for (const tab of workspace.tabs) for (const pane of tab.panes) paneIds.push(pane.paneId)
  }

  if (input.confirmed !== true) {
    const gate = await checkCloseGate(socketPath, paneIds, { close: 'workspace', workspaceId: input.workspaceId })
    if (!gate.clear) return { outcome: 'needs-confirm', foreground: gate.foreground }
  }

  // S15ⓓ ② — 사용자가 **명시적으로** 접는 워크스페이스다. 완료 행으로 되살리지 않는다.
  const outcome = await withRetentionSuppressed({
    store: link.store,
    ids: [input.workspaceId],
    what: 'workspace',
    run: hooks => closeWorkspace(socketPath, input.workspaceId, hooks),
  })
  if (outcome.outcome === 'closed') {
    scheduleTree()
    scheduleEmit()
    return { outcome: 'closed' }
  }
  if (outcome.outcome === 'rejected') return { outcome: 'rejected', rejection: outcome.rejection }
  return { outcome: 'error', error: outcome.error }
}

/**
 * 열기 in-flight 가드 (수정 1회차 M5). herdr 는 **같은 cwd 에 workspace 중복 생성을 허용**한다
 * (리뷰 e2e: 열기 두 번 → w14·w15 공존, corral 행은 하나만 가리켜 나머지는 UI 불가시 고아 +
 * 산 PTY). 그래서 corral 이 문 앞에서 막는다 — 진행 중 같은 경로 재클릭은 무시한다.
 */
const openingWorktrees = new Set<string>()

/** 닫힌 worktree 행을 연다 (L6·L8). 주 체크아웃은 workspace.create, linked 는 worktree.open. */
async function openWorktreeRow(input: {
  repoRoot: string
  path: string
  isLinked: boolean
}): Promise<WorktreeActionResult> {
  const socketPath = currentSocketPath()
  if (socketPath === null) return { ok: false, workspaceId: null, rejection: null, error: '세션이 없다' }
  const key = canonicalPath(input.path)

  // ① in-flight 중복: 첫 열기가 끝나기 전 두 번째 클릭은 무시 (더블클릭 방어 — 두 번째가 새 workspace 를 안 만든다).
  //    F-2: 문자열 대신 `deduped` 필드로 알린다 — 렌더러가 문구 비교 없이 양성 중복을 가린다.
  if (openingWorktrees.has(key)) {
    log('lifecycle.open_worktree.in_flight', { path: key })
    return { ok: false, workspaceId: null, rejection: null, error: null, deduped: true }
  }
  openingWorktrees.add(key)
  try {
    // ② 권위 재확인: 이미 열려 있으면 그 workspace 를 그대로 (idempotent). 골격은 push 지연으로
    //    낡을 수 있어 herdr `worktree.list` 를 직접 읽는다 (관문 ⑤와 같은 권위). 중복 create 를 막는 핵심.
    const open = await readOpenWorkspaces(socketPath, input.repoRoot)
    const already = open.error === null ? (open.byPath.get(key) ?? null) : null
    if (already !== null) {
      log('lifecycle.open_worktree.already_open', { path: key, workspaceId: already })
      scheduleTree()
      return { ok: true, workspaceId: already, rejection: null, error: null }
    }

    if (!input.isLinked) {
      // primary 열기 = **부모 확보 그 자체**. F-1: linked 열기의 부모 확보와 같은 dedupe 를 타야
      // 두 경로가 동시에 와도 부모가 하나만 선다 — 그래서 직접 openWorkspace 하지 않고 여기로 모은다.
      const parent = await resolveParentWorkspace(input.repoRoot)
      if (!parent.ok) return { ok: false, workspaceId: null, rejection: parent.rejection, error: parent.error }
      return { ok: true, workspaceId: parent.workspaceId, rejection: null, error: null }
    }
    const parent = await resolveParentWorkspace(input.repoRoot)
    if (!parent.ok) return { ok: false, workspaceId: null, rejection: parent.rejection, error: parent.error }
    const result = await openWorktree(socketPath, { parentWorkspaceId: parent.workspaceId, path: input.path })
    if (result.ok) {
      scheduleTree()
      // G4: linked 를 열며 부모를 **이 호출이 함께 열었으면** 그 사실을 화면에 알린다 (탭 숨김 금지).
      return { ...result, parentOpened: parent.opened }
    }
    return result
  } finally {
    openingWorktrees.delete(key)
  }
}

/** CLI capabilities use the same tree and lifecycle as GUI actions. */
const workspaceDesktop: WorkspaceDesktop = {
  changed: rebuildTree,
  async observe() {
    const socket = currentSocketPath()
    if (!socket || link.linkState().phase !== 'live') throw new RuntimeError('backend_unavailable', 'Desktop backend is not connected')
    await link.resync('cli-process-observation')
    await rebuildTree()
    const activePane = stream.terminalState().paneId
    const rows = []
    for (const repo of currentState().repos) for (const worktree of repo.worktrees) {
      const panes = worktree.workspace?.tabs.flatMap(tab => tab.panes) ?? []
      let liveTerminalCount = 0
      for (const pane of panes) {
        const probe = await probeForeground(socket, pane.paneId)
        if (!probe.ok) throw new RuntimeError('backend_unavailable', probe.error ?? 'Cannot observe terminal')
        if (probe.shellPid !== null) liveTerminalCount++
      }
      rows.push({ path: worktree.path, liveTerminalCount, hasAttachedPty: liveTerminalCount > 0,
        isActive: panes.some(pane => pane.paneId === activePane), status: worktree.workspace ? 'open' : 'closed',
        agents: panes.filter(pane => pane.agent !== null).map(pane => ({ paneKey: pane.paneId, agentType: pane.agent!, state: pane.agentStatus })) })
    }
    return rows
  },
  async activate(repoRoot, target) {
    const result = await openWorktreeRow({ repoRoot, path: target, isLinked: target !== repoRoot })
    if (!result.ok) throw new RuntimeError('backend_unavailable', result.error ?? result.rejection?.message ?? 'Cannot open worktree')
    // Lifecycle responses can precede pane creation and the coalesced tree refresh.
    const findPane = () => currentState().repos.flatMap(repo => repo.worktrees).find(row => row.path === target)?.workspace?.tabs[0]?.panes[0]
    let pane = findPane()
    const deadline = Date.now() + 3000
    while (!pane && Date.now() < deadline) {
      await link.resync('cli-activate')
      await rebuildTree()
      pane = findPane()
      if (!pane) await delay(30)
    }
    if (!pane) throw new RuntimeError('backend_unavailable', 'Opened worktree has no terminal')
    window?.show()
    window?.focus()
    // The renderer owns tab/group selection. Deliver the request after its tree state.
    window?.webContents.send('corral:state', currentState())
    window?.webContents.send('corral:revealPane', pane.paneId)
    return { parentOpened: result.parentOpened ?? false }
  },
  async close(target) {
    const row = currentState().repos.flatMap(repo => repo.worktrees).find(row => row.path === target)
    if (!row?.workspace) return
    const result = await closeWorktreeByWorkspace({ workspaceId: row.workspace.workspaceId, confirmed: true })
    if (result.outcome !== 'closed') throw new RuntimeError('backend_unavailable', `Cannot close worktree: ${JSON.stringify(result)}`)
  },
}

const terminalDesktop: TerminalDesktop = {
  available: () => !!window && !window.isDestroyed() && !window.webContents.isLoadingMainFrame(),
  async changed() { await link.resync('terminal-cli'); await rebuildTree() },
  // F6 — CLI `terminal close` 도 **명시 종료**다. GUI 와 같은 표를 찍어야 사용자가 CLI 로
  // 닫은 pane 이 창에서 완료 행으로 되살아나지 않는다.
  retention: {
    suppress: (id) => { link.store.suppressRetention(id) },
    release: (id) => { link.store.releaseSuppression(id) },
    settle: (input) => {
      const settled = link.store.settleSuppression(input)
      log('retention.suppress.settled', { what: 'cli terminal close', ...settled, code: input.code ?? null, sent: input.sent })
      return { effect: settled.effect }
    },
  },
  async reveal(target, context) {
    const client = window
    if (!client || client.isDestroyed() || currentSocketPath() !== process.env.CORRAL_BACKEND_SOCKET) throw new RuntimeError('ui_unavailable', 'GUI no longer addresses this backend')
    await terminalDesktop.changed()
    context.signal.throwIfAborted()
    if (client.isDestroyed() || Date.now() >= context.deadlineAt) throw new RuntimeError('ui_unavailable', 'GUI closed before selection')
    const id = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        ipcMain.removeListener('corral:terminalFocused', ack)
        context.signal.removeEventListener('abort', cancelled)
        client.removeListener('closed', closed)
        if (error) reject(error); else resolve()
      }
      const ack = (event: Electron.IpcMainEvent, response: { id: string; paneId: string }) => {
        if (event.sender === client.webContents && response.id === id && response.paneId === target.paneId && stream.terminalState().paneId === target.paneId) finish()
      }
      const cancelled = () => finish(new RuntimeError('request_cancelled', 'GUI selection cancelled'))
      const closed = () => finish(new RuntimeError('ui_unavailable', 'GUI closed during selection'))
      const timer = setTimeout(() => finish(new RuntimeError('ui_unavailable', 'GUI did not confirm keyboard destination')), Math.max(1, context.deadlineAt - Date.now() - 10))
      ipcMain.on('corral:terminalFocused', ack)
      context.signal.addEventListener('abort', cancelled, { once: true })
      client.once('closed', closed)
      client.show(); client.focus()
      client.webContents.send('corral:state', currentState())
      client.webContents.send('corral:terminalFocus', { id, paneId: target.paneId, deadlineAt: context.deadlineAt })
    })
  },
}

/** 새 linked worktree 를 만든다 (L7). parent 를 확보한 뒤 부른다. */
async function createWorktreeForRepo(input: {
  repoRoot: string
  branch: string
  path: string
}): Promise<WorktreeActionResult> {
  const socketPath = currentSocketPath()
  if (socketPath === null) return { ok: false, workspaceId: null, rejection: null, error: '세션이 없다' }
  const parent = await resolveParentWorkspace(input.repoRoot)
  if (!parent.ok) return { ok: false, workspaceId: null, rejection: parent.rejection, error: parent.error }
  const result = await createWorktree(socketPath, {
    parentWorkspaceId: parent.workspaceId,
    branch: input.branch,
    path: input.path,
  })
  if (result.ok) scheduleTree()
  return result
}

function pickSession(name: string): void {
  const found = sessions.find((session) => session.name === name)
  if (found === undefined) {
    log('session.select.missing', { name })
    return
  }
  selectedSession = name
  // 세션이 바뀌면 이전 세션의 영역 연결은 의미가 없다 — 전부 닫는다.
  stream.closeAll()
  link.open(found)
  // 세션이 바뀌면 지문·통합 상태도 그 세션의 것이다 (LIFE-366). 주기를 기다리지 않고 바로 읽는다.
  digests = new Map()
  // 지문 캐시도 이전 세션의 것이다 — 같이 비운다 (수정 라운드 1, V10).
  clearTranscriptCache()
  void refreshIntegrations()
  scheduleEmit()
}

/** endpoint 소켓은 control 소켓(herdr.sock)과 같은 폴더의 herdr-client.sock 이다. */
function currentClientSocketPath(): string | null {
  const socketPath = currentSocketPath()
  if (socketPath === null) return null
  return path.join(path.dirname(socketPath), 'herdr-client.sock')
}

/**
 * 포커스 pane 을 고른다 (S2 — 클릭·MRU 확정·명시 단축키에서만 여기 온다).
 *
 * LIFE-353 에서는 이 호출이 곧 "연결을 연다"였다. LIFE-373 에서 연결의 단위가 **영역**으로
 * 올라가면서 여는 판단은 렌더러의 영역 선언(`syncTermGroups`)이 가져갔다 — 여기 남은 일은
 * ① `state.terminal` 파생의 기준점을 옮기고 ② 그 pane 을 쥔 연결에 `pane.focus` 를 쏘는 것뿐이다.
 *
 * paneId 는 **현재 링크의 목록에 있는 것만** 받는다 — 렌더러가 낡은 id 를 보내면 (pane 이
 * 방금 닫혔으면) 여기서 걸러 식별 가능한 로그로 남긴다. 검증의 진실은 store 다.
 */
function selectPane(input: { paneId: string | null; cols?: number; rows?: number }): void {
  if (input.paneId === null) {
    stream.focusPane(null)
    scheduleEmit()
    return
  }
  if (currentClientSocketPath() === null) {
    log('stream.select.no_session', { paneId: input.paneId })
    return
  }
  if (!link.store.paneIds().includes(input.paneId)) {
    log('stream.select.unknown_pane', { paneId: input.paneId })
    return
  }
  stream.focusPane(input.paneId)
  scheduleEmit()
}

/** 렌더러가 선언한 영역 구성을 스트림 층에 넘긴다 (LIFE-373 ① — 연결 수명의 유일한 입구). */
function syncTermGroups(groups: TerminalGroupRequest[]): void {
  const clientSocketPath = currentClientSocketPath()
  if (clientSocketPath === null) {
    if (groups.length > 0) log('stream.sync.no_session', { groups: groups.length })
    stream.closeAll()
    scheduleEmit()
    return
  }
  const alive = new Set(link.store.paneIds())
  const valid = groups.filter((group) => {
    if (alive.has(group.activePaneId)) return true
    log('stream.sync.unknown_pane', { groupId: group.groupId, paneId: group.activePaneId })
    return false
  })
  // 선언이 들어온 사실 자체를 남긴다 — 격자 요청(S3·R13-b)의 렌더러 쪽 끝점이다.
  log('stream.sync', { groups: valid.map((group) => `${group.groupId}:${group.tabId}:${group.cols}x${group.rows}`).join(' ') })
  stream.sync({ clientSocketPath, groups: valid })
}

/** herdr 거절을 화면 문구로 옮긴다 — 봉투는 어댑터 안에서 끝난다. */
function paneResult(outcome: { outcome: 'ok' } | { outcome: 'rejected'; rejection: { code: string; message: string } }): PaneActionResult {
  return outcome.outcome === 'ok' ? { ok: true } : { ok: false, error: outcome.rejection.message || outcome.rejection.code }
}

/**
 * 세션 지문 주기 갱신 (LIFE-366).
 *
 * 1.5초는 "사람이 행을 보고 있을 때 늦다고 느끼지 않는" 쪽에서 고른 값이고, 비용은 파일이
 * 안 변했을 때 `stat` 한 번이라(캐시) 유휴 상태에서는 거의 0 이다 (`transcript.ts`).
 * 바뀐 것이 없으면 **emit 도 안 한다** — 1.5초마다 화면 전체를 다시 그리면 그게 곧 A7 의 비용이다.
 */
const DIGEST_POLL_MS = 1500

function refreshDigests(): void {
  const refs = collectSessionRefs(link.store.rows())
  const read = readSessionDigests(refs)
  // 평시엔 **읽은 게 있을 때만** 남긴다(1.5초마다 빈 줄을 쌓지 않는다). 계측 실행에서는 매 주기 —
  // 기준 A7′ 이 세 구간 전부의 주기 수를 요구하는데, 참조 0인 구간은 읽을 파일이 없어서 그냥 두면
  // 로그가 한 줄도 안 남는다 (수정 라운드 1, V1).
  if (read.cost.files > 0 || measuring) log('transcript.read', read.cost)
  let changed = read.digests.size !== digests.size
  if (!changed) {
    for (const [tabId, digest] of read.digests) {
      const before = digests.get(tabId)
      if (before === undefined || !digestsEqual({ a: before, b: digest })) {
        changed = true
        break
      }
    }
  }
  digests = read.digests
  if (changed) scheduleEmit()
}

/**
 * orchestration 계보 (LIFE-459). 런타임 저장소에 변경 이벤트가 없어서 주기 조회로 안다 —
 * 비용과 지연은 `specs/LIFE-459-lineage/raw/claude/result.md` 에 실측이 있다.
 */
const LINEAGE_POLL_MS = 1000
const realSocket = (socket: string): string => {
  try {
    return fs.realpathSync(socket)
  } catch {
    return socket
  }
}
const lineage = new LineageFeed({
  source: {
    runtimeBackend: () => {
      const socket = process.env.CORRAL_BACKEND_SOCKET, session = process.env.CORRAL_SESSION
      return socket && session ? { socket, session } : null
    },
    guiSocket: () => currentSocketPath(),
    livePaneIds: () => new Set(link.store.paneIds()),
    stamp: () => {
      try {
        const stat = fs.statSync(path.join(app.getPath('userData'), 'runtime/orchestration/state.json'))
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
      } catch {
        return null
      }
    },
    read: () => new OrchestrationStore(app.getPath('userData')).read(),
    observe: () => observePanes({ signal: AbortSignal.timeout(2000), deadlineAt: Date.now() + 2000 }),
    sameSocket: ({ a, b }) => realSocket(a) === realSocket(b),
  },
  onChange: () => {
    const current = lineage.current()
    log('lineage.change', current.state === 'ready' ? { state: current.state, entries: current.entries.length } : current)
    scheduleEmit()
  },
})

/** 통합 설치 상태는 잘 안 바뀐다 — 세션을 고를 때와 주기 재조회에서만 읽는다 (A1). */
async function refreshIntegrations(): Promise<void> {
  const socketPath = currentSocketPath()
  if (socketPath === null) {
    if (integrations.length === 0) return
    integrations = []
    scheduleEmit()
    return
  }
  const scan = await readIntegrations(socketPath)
  const before = JSON.stringify(integrations)
  integrations = scan.rows
  if (JSON.stringify(integrations) !== before) scheduleEmit()
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
    // Electron 44 는 이 이벤트를 (event, level, message, line, sourceId) 위치 인자로 주고 level 은
    // 숫자다. 이 위치-인자 형태는 이후 버전에서 단일 Event 객체(details.level 문자열)로 대체되며
    // deprecated 다 (수정 1회차 L5) — Electron 을 올릴 때 이 핸들러 시그니처를 같이 고쳐야 한다.
    // 계측 실행에서만 켜지므로 평시 앱에는 영향이 없다.
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
   * `⌘W` 를 **메뉴에서 뺏어 온다** (F2-5a · R23).
   *
   * corral 은 `Menu.setApplicationMenu` 를 부르지 않으므로 Electron **재고 기본 메뉴**가 살아
   * 있고, 거기 `File ▸ Close Window` 가 `CommandOrControl+W` 를 쥐고 있다(실측). 터미널 관습에서
   * `⌘W` 는 탭·pane 닫기인데 corral 에서는 **창이 통째로 닫혀** UI 를 잃는다 — 그 함정을 남긴 채
   * pane 닫기를 더할 수 없다. 코디네이터 재정(R23): **`preventDefault()` 로만 가져온다.**
   * 메뉴를 다시 만들지 않는다 — 기본 메뉴를 재구성하면 Edit 의 복사·붙여넣기 role 까지 우리가
   * 책임지게 되고, 그건 pane 닫기 하나가 질 위험이 아니다. `⌘Q`·Edit role 은 그대로 산다.
   *
   * `before-input-event` 여야 한다: 메뉴 액셀러레이터는 **페이지 keydown 보다 먼저** 처리돼서
   * 렌더러의 `document.addEventListener('keydown')` 으로는 닿지 못한다. 여기서 `preventDefault()`
   * 하면 메뉴 단축키와 페이지 keydown **둘 다** 막히므로, 뜻은 채널로 렌더러에 넘긴다.
   *
   * `⌥` 가 끼면 손대지 않는다 — `⌘⌥W`(영역 닫기)는 메뉴가 안 쥔 키라 렌더러가 이미 받는다.
   * **`⌃W` 도 손대지 않는다**: 메뉴 액셀러레이터는 `CommandOrControl+W` 라 다른 OS 에서는
   * `⌃W` 지만, 터미널에서 `⌃W` 는 단어 지우기라 PTY 의 것이다. macOS 의 `⌘` 만 가져온다.
   */
  /**
   * 들어온 키를 **계측 실행에서만** 남긴다 (R5 — 판정을 가르는 자리다).
   *
   * 없으면 "안 먹었다"가 ⓐ 키가 안 왔다 ⓑ 핸들러가 안 돌았다 중 어느 것인지 영영 안 갈린다 —
   * `⌘W`(R24-1)에서 한 번 겪은 갈림이다. 평상시 앱에는 안 붙고, 붙는 회차에도 **keyUp 과
   * modifier 가 낀 keyDown 만** 센다(평범한 타건으로 로그가 부풀지 않게).
   */
  const instrumented = !app.isPackaged || process.env.CORRAL_CONTROL_SOCKET !== undefined
  /**
   * ⚠ **여기서 `preventDefault()` 를 하면 그 뒤 keyUp 이 전부 사라진다** (실측).
   *
   * Chromium 은 브라우저 쪽 델리게이트(= 이 이벤트)가 keyDown 을 처리했다고 답하면
   * **다음 keyDown 까지 모든 키 이벤트를 버린다**. 내부 식별자는 `suppress_events_until_keydown_`
   * 로 **추정**하지만 공개 트리에서 그 문자열을 확인하지 못했다 — **근거는 이름이 아니라 아래 실측**이다.
   * 실측: `⌘W` 를 삼킨 직후 보낸 `Shift` keyUp 3개가 main 에도 페이지에도 하나도 안 왔다
   * (`raw/claude/f3-keyup-suppression.json`). 그래서 ③ MRU 의 `⌃Tab` 홀드는 이 자리를 쓸 수
   * 없다 — 홀드를 여는 키를 삼키는 순간 확정 신호인 `Control` keyup 이 같이 사라진다.
   * MRU 는 **렌더러의 document 캡처 단계**가 잡는다(App.tsx) — 거기서 막으면 xterm 은 못 보고
   * 브라우저의 keyUp 억제도 안 걸린다. 여기 남는 것은 **메뉴가 쥔 키**(`⌘W`) 하나뿐이다.
   */
  window.webContents.on('did-start-loading', () => {
    shortcutRecording = false
    window?.webContents.setIgnoreMenuShortcuts(false)
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (instrumented && (input.type === 'keyUp' || input.control || input.meta || input.alt)) {
      log('input.raw', { type: input.type, key: input.key, control: input.control, meta: input.meta, alt: input.alt, shift: input.shift })
    }
    if (shortcutRecording) return
    if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'w') return
    if (!input.meta || input.alt || input.control || input.shift) return
    event.preventDefault()
    // 가로챘다는 사실은 **로그로만** 보인다 — 키를 삼켰으니 화면에는 아무 흔적이 없고,
    // "안 닫혔다"는 관측은 "안 눌렸다"와 구분되지 않는다.
    log('shortcut.intercepted', { key: 'w', meta: true })
    const match = matchBinding('Mod+W', keybindings.get())
    if (match && window !== null && !window.isDestroyed()) window.webContents.send('corral:shortcut', match)
  })
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

app.whenReady().then(async () => {
  restoreBackend(app.getPath('userData'))
  const file = openLog(app.getPath('userData'))
  keybindings = new KeybindingStore(app.getPath('userData'))
  keybindings.load()
  registry = new RepoRegistry(app.getPath('userData'))
  registry.load()
  uiPrefs = new UiPrefsStore(app.getPath('userData'))
  uiPrefs.load()
  log('app.ready', {
    logFile: file,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    registryFile: registry.state().file,
  })

  /**
   * IPC 는 **우리 창에서 온 것만** 받는다 — 보안 체크리스트 17 (수정 1회차 L12).
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
  ipcMain.handle('corral:getKeybindings', (event) => fromOurWindow(event) ? keybindings.get() : {})
  ipcMain.handle('corral:saveKeybindings', (event, overrides: unknown) => {
    if (!fromOurWindow(event)) return { ok: false, error: '다른 창의 요청' }
    try { return { ok: true, overrides: keybindings.save(overrides) } }
    catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle('corral:setShortcutRecording', (event, active: unknown) => {
    if (!fromOurWindow(event)) return
    shortcutRecording = active === true
    // Recording receives raw Cmd+W in Chromium; the stock menu must not close the window.
    event.sender.setIgnoreMenuShortcuts(shortcutRecording)
  })
  ipcMain.handle('corral:getUiPrefs', (event) =>
    fromOurWindow(event) ? (uiPrefs?.get() ?? { sidebarWidth: null, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: [], expandedAgentGroups: [], tabOrdinals: [], groupLayouts: [], manualRepoOrder: [], manualWorktreeOrder: {} }) : null,
  )
  ipcMain.on('corral:setUiPrefs', (event, patch: Partial<UiPrefs>) => {
    if (fromOurWindow(event)) uiPrefs?.update(patch)
  })

  // --- 라이프사이클 (R3) ---
  const denied = { ok: false as const, error: '허용되지 않은 발신자' }
  ipcMain.handle('corral:createRow', (event, input: { workspaceId: string; kind: AgentKind }) =>
    fromOurWindow(event) && typeof input?.workspaceId === 'string'
      ? createRowInWorkspace({ workspaceId: input.workspaceId, kind: input.kind })
      : { ...denied, paneId: null, tabId: null, retries: 0 },
  )
  ipcMain.handle('corral:closeRow', (event, input: { tabId: string; confirmed?: boolean }) =>
    fromOurWindow(event) && typeof input?.tabId === 'string'
      ? closeRowByTab({ tabId: input.tabId, confirmed: input.confirmed === true })
      : ({ outcome: 'error', error: '허용되지 않은 발신자' } satisfies CloseRowResult),
  )
  ipcMain.handle('corral:renameRow', (event, input: { tabId: string; label: string }) =>
    fromOurWindow(event) && typeof input?.tabId === 'string' && typeof input?.label === 'string'
      ? renameRowByTab({ tabId: input.tabId, label: input.label })
      : ({ outcome: 'error', error: '허용되지 않은 발신자' } satisfies RenameRowResult),
  )
  ipcMain.handle('corral:closeWorktree', (event, input: { workspaceId: string; confirmed?: boolean }) =>
    fromOurWindow(event) && typeof input?.workspaceId === 'string'
      ? closeWorktreeByWorkspace({ workspaceId: input.workspaceId, confirmed: input.confirmed === true })
      : ({ outcome: 'error', error: '허용되지 않은 발신자' } satisfies CloseRowResult),
  )
  ipcMain.handle('corral:openWorktree', (event, input: { repoRoot: string; path: string; isLinked: boolean }) =>
    fromOurWindow(event) && typeof input?.repoRoot === 'string' && typeof input?.path === 'string'
      ? openWorktreeRow({ repoRoot: input.repoRoot, path: input.path, isLinked: input.isLinked === true })
      : { ...denied, workspaceId: null, rejection: null },
  )
  ipcMain.handle('corral:createWorktree', (event, input: { repoRoot: string; branch: string; path: string }) =>
    fromOurWindow(event) && typeof input?.repoRoot === 'string' && typeof input?.branch === 'string' && typeof input?.path === 'string'
      ? createWorktreeForRepo({ repoRoot: input.repoRoot, branch: input.branch, path: input.path })
      : { ...denied, workspaceId: null, rejection: null },
  )
  ipcMain.on('corral:reportRendered', (event, rendered: number) => {
    if (fromOurWindow(event)) log('ui.rendered', { revision: rendered })
  })

  // --- 터미널 스트림 (R2) ---
  ipcMain.handle('corral:selectPane', (event, input: { paneId: string | null; cols?: number; rows?: number }) => {
    if (fromOurWindow(event)) selectPane(input)
  })
  // 새 xterm 이 붙었다 — 마지막 화면을 그 pane 에 다시 그린다 (S6). 서버 호출 없음.
  ipcMain.handle('corral:repaintPane', (event, input: { paneId: string }) => {
    if (fromOurWindow(event) && typeof input?.paneId === 'string') stream.repaint(input.paneId)
  })
  // 영역 선언 — 연결을 열고·닫고·탭을 옮기고·격자를 맞추는 유일한 입구 (LIFE-373).
  ipcMain.on('corral:syncTermGroups', (event, groups: TerminalGroupRequest[]) => {
    if (!fromOurWindow(event) || !Array.isArray(groups)) return
    const valid = groups.filter(
      (group) =>
        typeof group?.groupId === 'string' &&
        typeof group.tabId === 'string' &&
        typeof group.activePaneId === 'string' &&
        typeof group.cols === 'number' &&
        typeof group.rows === 'number',
    )
    // 하나라도 모양이 어긋나면 **통째로 버린다** — 걸러낸 나머지를 보내면 그 선언에서 빠진 영역이
    // "사라진 영역"으로 읽혀 멀쩡한 연결이 닫힌다. 렌더러는 상태가 바뀔 때마다 다시 선언하므로
    // 한 번 버리는 건 안전하고, 연결을 죽이는 건 안 안전하다.
    if (valid.length !== groups.length) {
      log('stream.sync_dropped', { declared: groups.length, valid: valid.length })
      return
    }
    syncTermGroups(valid)
  })
  // 입력·리사이즈·스크롤은 fire-and-forget — 왕복을 기다릴 값이 없고 레이턴시(S2)에 민감하다.
  ipcMain.on('corral:termInput', (event, input: { paneId: string; data: string }) => {
    if (!fromOurWindow(event)) return
    if (typeof input?.paneId !== 'string' || typeof input.data !== 'string') return
    stream.input(input)
  })
  ipcMain.on('corral:termScroll', (event, scroll: { paneId: string } & TerminalScroll) => {
    // termInput 과 같은 결로 모양을 검증한다 (수정 1회차 L8) — 렌더러가 신뢰 경계지만
    // 핸들러가 payload 를 안 보는 모양으로 굳으면 나중에 그대로 구멍이 된다.
    if (!fromOurWindow(event)) return
    if (typeof scroll?.paneId !== 'string') return
    if (scroll.direction !== 'up' && scroll.direction !== 'down') return
    if (typeof scroll.lines !== 'number') return
    if (scroll.column !== null && typeof scroll.column !== 'number') return
    if (scroll.row !== null && typeof scroll.row !== 'number') return
    stream.scroll(scroll)
  })
  /**
   * 줌은 두 곳에 남는다 (F2-3): **서버에는 플래그**(herdr TUI 도 같은 상태를 보게), **화면은
   * 클라이언트가** 격자 역산으로 그린다. 서버 rect 는 안 바뀌므로(A5·프리플라이트 ②) 플래그는
   * 정합용이지 그림의 근거가 아니다. 해제 대상 pane 은 스트림이 들고 있던 값을 쓴다.
   */
  ipcMain.on('corral:termZoom', (event, input: { groupId: string; paneId: string | null; cols: number; rows: number }) => {
    if (!fromOurWindow(event)) return
    if (typeof input?.groupId !== 'string' || typeof input.cols !== 'number' || typeof input.rows !== 'number') return
    if (input.paneId !== null && typeof input.paneId !== 'string') return
    const previous = stream.zoomedPaneOf(input.groupId)
    stream.zoom(input)
    const socketPath = currentSocketPath()
    if (socketPath === null) return
    const target = input.paneId ?? previous
    if (target === null) return
    void zoomPane({ socketPath, paneId: target, on: input.paneId !== null }).catch((error: unknown) =>
      log('stream.zoom_flag_failed', { paneId: target, error: error instanceof Error ? error.message : String(error) }),
    )
  })

  // --- pane 분할 (② — control 소켓) ---
  ipcMain.handle(
    'corral:splitPane',
    async (event, input: { paneId: string; direction: PaneSplitDirection; ratio?: number }): Promise<PaneSplitResult> => {
      if (!fromOurWindow(event)) return { ok: false, error: '허용되지 않은 창' }
      const socketPath = currentSocketPath()
      if (socketPath === null) return { ok: false, error: '세션이 없다' }
      const split = await splitPane({ socketPath, ...input })
      if (split.outcome === 'rejected') return { ok: false, error: split.rejection.message || split.rejection.code }
      // 이웃 이동과 같다 — main 은 선택을 옮기지 않고 **새 pane 의 id 만** 돌려준다 (F2-7).
      return { ok: true, paneId: split.paneId }
    },
  )
  ipcMain.handle(
    'corral:resizePane',
    async (event, input: { paneId: string; direction: PaneDirection; amount: number }): Promise<PaneActionResult> => {
      if (!fromOurWindow(event)) return { ok: false, error: '허용되지 않은 창' }
      const socketPath = currentSocketPath()
      if (socketPath === null) return { ok: false, error: '세션이 없다' }
      return paneResult(await resizePane({ socketPath, ...input }))
    },
  )
  ipcMain.handle('corral:closePane', async (event, input: { paneId: string }): Promise<PaneActionResult> => {
    if (!fromOurWindow(event)) return { ok: false, error: '허용되지 않은 창' }
    const socketPath = currentSocketPath()
    if (socketPath === null) return { ok: false, error: '세션이 없다' }
    // S15ⓓ ② — 명시적 pane 닫기도 같다.
    return paneResult(await withRetentionSuppressed({
      store: link.store,
      ids: [input.paneId],
      what: 'pane',
      run: hooks => closePane({ socketPath, paneId: input.paneId, onSent: hooks.onSent }),
    }))
  })
  // 인접 pane 은 **서버가 계산한다**(F2-4). corral 은 id 만 받아 자기 연결의 pane.focus 로 옮긴다.
  ipcMain.handle(
    'corral:focusPaneDirection',
    async (event, input: { paneId: string; direction: PaneDirection }): Promise<PaneNeighborResult> => {
      if (!fromOurWindow(event)) return { ok: false, error: '허용되지 않은 창' }
      const socketPath = currentSocketPath()
      if (socketPath === null) return { ok: false, error: '세션이 없다' }
      const found = await neighborPane({ socketPath, ...input })
      if (found.outcome === 'rejected') return { ok: false, error: found.rejection.message || found.rejection.code }
      // 여기서 포커스를 옮기지 않는다 — 선택 pane 의 주인은 렌더러다. main 이 앞질러 옮기면
      // herdr 포커스는 이웃, 화면 강조·영역 선언은 옛 pane 으로 갈린다. id 만 돌려준다.
      return { ok: true, paneId: found.paneId }
    },
  )

  const runtime = await startRuntime({
    userData: app.getPath('userData'), ui: () => window !== null && !window.isDestroyed() && window.isVisible() && !window.webContents.isLoadingMainFrame(),
    focus: () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus() },
    workspaceDesktop, terminalDesktop,
    appProcessRoles: () => new Map(app.getAppMetrics().map(metric => [metric.pid, metric.type === 'Tab' ? 'renderer' : 'other'])),
  })
  stopRuntime = runtime.close
  createWindow()
  void pollSessions()
  setInterval(() => void pollSessions(), SESSION_POLL_MS)
  // LIFE-366 — 세션 지문·통합 상태. 지문은 짧은 주기(캐시가 막는다), 통합은 세션 폴링에 얹는다.
  digestTimer = setInterval(() => refreshDigests(), DIGEST_POLL_MS)
  setInterval(() => void refreshIntegrations(), SESSION_POLL_MS * 4)
  setInterval(() => void lineage.refresh(), LINEAGE_POLL_MS)
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
    // S6 — 연결이 매 서피스마다 세고 있던 자기정합 위반 수를 밖으로 낸다 (읽기 전용).
    counters: () => stream.counters(),
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(error => { log('runtime.start_failed', { error: String(error) }); app.exit(1) })

app.on('before-quit', event => {
  if (!stopRuntime) return
  event.preventDefault()
  const close = stopRuntime; stopRuntime = null
  void close().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (digestTimer !== null) clearInterval(digestTimer)
  digestTimer = null
  stream.closeAll()
  link.close()
  log('app.quit', { logFile: logFile() })
  closeLog()
  app.quit()
})
