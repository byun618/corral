import { RuntimeError, type Invocation, type RpcResponse } from '../runtime/contracts.js'
import { copyPath, deleteWorktree, openInEditor, previewWorktreeDelete, revealInFinder, setWorktreeMeta, type CardActionDeps } from './card-actions.js'
import { parentPathOf } from './tree.js'
import type { WorktreeMetadataRecord } from './registry.js'
import { randomUUID } from 'node:crypto'
import type { TerminalDesktop } from '../runtime/terminal/index.js'
import type { WorkspaceDesktop } from '../runtime/workspace/model.js'
import { startRuntime, restoreBackend } from '../runtime/server.js'
import { backendBinding } from '../runtime/backend.js'
import { cliTarget } from './install-cli.js'
import { addInstallCliMenu } from './install-cli-menu.js'
import { KeybindingStore } from './keybindings.js'
import { withRetentionSuppressed } from './close-retention.js'
import { explorerKeyShortcut, menuKeyShortcut } from '../shared/keybindings.js'
import { parsePaneTarget, parseRevealRequest, parseSearchRequest, type TerminalRevealResult, type TerminalSearchResult } from '../shared/terminal-search.js'
import { closeTabsGated, runningForeground } from './close-tabs.js'
import { footprintHelperPath, homesOf, registerResourceIpc, shellProbeOf } from './resource-ipc.js'
import { confirmedDeadSlot, directoryNow, keepRetention, prunableRetained, slotStateNow, slotStateOf } from './retention.js'
// Electron main — 소켓을 소유하는 쪽.
//
// 렌더러가 소켓을 열 수 없는 것은 권장이 아니라 구조적 강제다: sandbox:true 인 렌더러/preload 의
// require 화이트리스트에는 net 이 없다. 그래서 herdr 소켓은 전부 여기서 다룬다.
//
// 이 파일은 **어댑터의 공개 입구만** import 한다 (`./adapter/index.js`). internal 은 모른다.

import { app, BrowserWindow, type BrowserWindowConstructorOptions, clipboard, dialog, ipcMain, nativeImage, safeStorage, shell, utilityProcess } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  AddRepoResult,
  AgentKind,
  AppState,
  BrowseReposResult,
  CardActionError,
  CloseRowResult,
  CloseTabsResult,
  RunningPane,
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
  WorkspaceRow,
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
  isExecutableFile,
  readLogTail,
  readRestoreTargets,
  resolveHerdrBinary,
  rewriteRestoreRefs,
  spawnServer,
  bundledHerdrPath,
  herdrAppDirFor,
  onRepoGuard,
  devGuardBase,
  findDevGuard,
  type DevGuardLookup,
  stopProcessGroup,
  inspectServerProcess,
  SERVER_READY_POLL_MS,
  SERVER_READY_TIMEOUT_MS,
  type HerdrResolution,
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
import { electronClipboardPng, PASTE_FILE_MAX_AGE_MS, saveClipboardImage, sweepPasteFiles } from './clipboard-image.js'
import { startControlServer } from './control.js'
import { closeLog, log, logFile, openLog } from './log.js'
import { AgentDetector, realAgentDetectorDeps, registerAgentDetectionIpc } from './agent-detection.js'
import { AGENT_DETECTION_CHANNEL } from '../shared/agent-detection.js'
import { externalOpenLogUrl, isExternalOpenAllowed } from './external-url.js'
import { pickSessionName, pinnedSessions } from './pick-session.js'
import { BackendRetry, BackendStarter, boundSessionName, decideBackend, makeBeforeSpawn, DEFAULT_SESSION, isOwnSession, needsRestoreCount, nextScanErrorStreak, type BackendInput } from './backend-start.js'
import { RepoRegistry } from './registry.js'
import { RegistryGeneration, removeObserved } from './registry-generation.js'
import { attachDigests, buildSkeleton, cardlessGate, collectSessionRefs, joinTree, readClaimedWorkspaceIds, type RepoSkeleton } from './tree.js'
import { createRebuildScheduler, skeletonHealth } from './rebuild-retry.js'
import { clearTranscriptCache, digestsEqual, readSessionDigests } from './transcript.js'
import { SessionHistory, defaultHistoryRoots, resumeSession, revealSession } from './session-history.js'
import { UiPrefsStore } from './ui-prefs.js'
import { SettingsStore } from './settings.js'
import { UsageService } from './usage/service.js'
import { USAGE_COLLECTORS } from './usage/registry.js'
import { realCollectorDeps } from './usage/deps.js'
import { EMPTY_USAGE_SNAPSHOT, usageEnabled } from '../shared/usage.js'
import { previewGhosttyImport } from './ghostty/index.js'
import { DEFAULT_SETTINGS, type SettingsWriteResult } from '../shared/terminal-settings.js'
import { WorktreePoller, parsePollMs } from './worktree-watch.js'
import { LineageFeed } from './orchestration-lineage.js'
import { trafficLightPosition } from '../shared/window-chrome.js'
import { bindStartupZoomSync, pushWindowChrome as pushChrome, syncWindowZoom, windowChromeOf } from './window-zoom.js'
import { observePanes } from '../runtime/orchestration/index.js'
import { OrchestrationStore } from '../runtime/orchestration/store.js'
import { MobileService } from './mobile/service.js'
import { readMacName } from './mobile/mac-name.js'
import { persistedMachine } from './work/machine.js'
import { KNOWN_TAILSCALE_LOCATIONS, locateTailscale, loginShellTailscale, runTailscale } from './mobile/tailscale.js'
import { LA_DEFAULT_MCP_URL, laSourceEntry } from './work/la-source.js'
import { mockSourceEntry, seedMockDemoState } from './work/mock-source.js'
import { jiraFixtureBaseFromEnv, jiraSourceEntry } from './work/jira-source.js'
import { WorkService } from './work/service.js'
import { isRecord } from '../shared/json.js'
import { WorkLinks, linkOf } from './work/links.js'
import { StartService } from './work/start.js'
import { PendingStartStore } from './work/start-pending.js'
import { WorkActivityStore } from './work/activity-store.js'
import { WorkSourceRegistry } from './work/source.js'
import { WorkConnectionStore } from './work/store.js'
import { CredentialVault, electronCipher, measurementCipher } from './work/vault.js'
import type { WorkActionResult, WorkError } from '../shared/work.js'
import { listDir } from './explorer-fs.js'
import { ExplorerHub } from './explorer-hub.js'
import { FileLister, resolveGit } from './file-list.js'
import { ContentSearcher } from './content-search.js'
import { explorerAction } from './explorer-actions.js'
import { FILE_DROP_MAX_PATHS } from '../shared/terminal-paste.js'
import { DropStore, loadOpHooks, runExplorerOp, SnapshotStore } from './explorer-ops.js'
import { readFileContent, readImageContent } from './file-read.js'
import { readScmContent } from './scm-read.js'
import { loginShellPath, rootTag, ScmWriter } from './scm-write.js'
import { ScmRemote } from './scm-remote.js'
import { getGitStatus, invalidateGitStatus, isLaterSnapshot } from './git-status.js'
import { patchWorktreeStatus, WorktreeStatusRefresh } from './worktree-status-refresh.js'
import { gitRunner, resolveScmBase, scmBaseInputsOf, type ScmBaseInputs } from './scm-base.js'
import { PrStatus } from './pr-status.js'
import { createFileWatch, type FileWatch } from './file-watch.js'
import { loadTestHooks, writeFileContent } from './file-write.js'
import { fileDialogSpec, parseFileDialogRequest, reloadDialogSpec, unresponsiveDialogSpec } from './file-dialogs.js'
import { createQuitGate, parseDirtyFiles } from './quit-gate.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 측정 실행인가 — control 소켓이 붙었을 때만 참. A4 프레임 로그 같은 계측 잡음을 여기 가둔다. */
if (process.env.CORRAL_USER_DATA) app.setPath('userData', process.env.CORRAL_USER_DATA)
let stopRuntime: (() => Promise<void>) | null = null
/** LIFE-831 수정 r1 C3 — 종료 때 진행 중 원격 git 그룹을 끝내려고 `before-quit` 이 쥔다. */
let scmRemoteForQuit: ScmRemote | null = null
/** 종료 정리 진행 중이면 그 Promise(재진입 종료가 같이 기다린다 — LIFE-591 수정 r2 R2-C) · 끝났으면 `runtimeStopped`. */
let runtimeStopping: Promise<void> | null = null
let runtimeStopped = false
/** 설정 › Mobile (LIFE-577) — 기본 꺼짐. 종료 정리는 `stopRuntime` 체인에 합쳐 기존 `before-quit` 하나가 기다린다. */
let mobile: MobileService | null = null
/** 마지막으로 렌더러에 낸 상태 — 폰 목록이 같은 스냅샷을 읽는다(LIFE-580 F1). 아직 없으면 null. */
let lastEmittedState: AppState | null = null
/** 종료 때 serve 항목 제거에 주는 시간 — 넘기면 tailscale 자식을 죽이고 끝낸다(A6ⓕ 10초 안). 남은 항목은 다음 기동 reconcile 이 지운다. */
const MOBILE_SHUTDOWN_DEADLINE_MS = 6_000
/** 런타임 디스패처 (LIFE-478) — GUI 카드 메뉴가 CLI 와 같은 `worktree set`/`worktree rm` 을 이 손으로 돈다. */
let runtimeInvoke: ((invocation: Invocation, timeoutMs?: number) => Promise<RpcResponse>) | null = null
let keybindings: KeybindingStore
let shortcutRecording = false
/**
 * LIFE-592 — 탐색기 트리가 활성 요소인가(렌더러가 트리 focus/blur 때 민다). 켜져 있을 때만 main 이 ⌘Z·⌘⇧Z(메뉴 Edit role 이 쥔 키)를
 * 탐색기 실행 취소·다시 실행으로 가져온다 — 꺼져 있으면 손대지 않아 편집기·입력칸·터미널의 ⌘Z 와 메뉴 role 이 그대로다(`raw/claude/undo-routing.md`).
 */
let explorerFocused = false
/**
 * 탐색기 드롭 원본·가져오기 재생 근거(LIFE-592 E7ⓓ·수정 r2 R2-E). 재생 근거는 렌더러 실행 취소 기록이 가리키는 동안만 쓸모가 있다 —
 * 렌더러가 새로 뜨면(다시 읽기·프로세스 재생성) 그 기록은 사라지므로 붙잡던 근거를 전부 놓는다(수정 r3).
 */
const explorerDrops = new DropStore()
const measuring = (process.env.CORRAL_CONTROL_SOCKET ?? '').length > 0

let window: BrowserWindow | null = null
/**
 * LIFE-591 E3ⓒ — 수정된 파일 탭이 있으면 종료·창 닫기를 런타임 정리보다 먼저 막고 렌더러에 확인을 맡긴다(`quit-gate.ts`).
 * 렌더러가 없으면(창이 없거나 부서졌으면) 막지 않는다 — 그때는 확인할 내용도 없다.
 * 수정 r1 R1-I — 렌더러가 요청을 3 s 안에 받았다고(`corral:quitAck`) 답하지 않으면(멈춤) main 이 직접 묻는다(`confirmUnresponsiveQuit`).
 * 수정 r4 R4-A — 밀린 수정 목록이 비어도 렌더러에 묻는다(왕복 — 렌더러가 그 순간 문서로 판정).
 * 수정 r5 R5-A — 페이지를 싣는 중(다시 불러오기 등)이면 옛 문서가 아직 살아 있을 수 있다 — 왕복 대신 밀린 목록으로 판정한다(`loading`, 판정은 `quit-gate.ts`).
 * 수정 r5 R5-B — 요청마다 세대(`gen`)를 실어 보낸다. 렌더러 응답은 그 세대를 돌려주고, 무응답 취소로 무효가 된 세대의 응답은 버린다.
 */
const quitGate = createQuitGate({
  requestConfirm: (gen) => {
    if (window === null || window.isDestroyed() || window.webContents.isCrashed()) return false
    window.webContents.send('corral:quitRequested', gen)
    return true
  },
  loading: () => window !== null && !window.isDestroyed() && window.webContents.isLoadingMainFrame(),
  onUnresponsive: () => void confirmUnresponsiveQuit(),
  trustPushedList: measuring && !app.isPackaged && process.env.CORRAL_TEST_QUIT_TRUST_PUSHED === '1',
  ackTimeoutMs: 3000,
  log: (tag, data) => log(tag, data),
})
/**
 * 방어선(수정 r4 R4-A ⓒ) — 런타임 정리를 시작해 창을 숨긴 뒤에 종료 확인을 다시 묻게 됐으면(정리 뒤 재진입 종료가 새 수정을 본 경우 등) 창을 다시 보인다.
 * 숨은 창에 붙은 확인 대화상자는 보이지 않고, 취소하면 창이 숨은 채 남는다. 포커스는 가져가지 않는다(`showInactive`).
 */
function reshowForConfirm(via: string): void {
  if (runtimeStopping === null || window === null || window.isDestroyed() || window.isVisible()) return
  log('quit.reshow', { via, runtimeStopped })
  window.showInactive()
}
let unresponsivePrompt = false
/**
 * 무응답 렌더러 종료 확인(R1-I) — 「저장하지 않고 종료」 면 확인을 지난 것으로 치고 창을 바로 부순 뒤(멈춘 렌더러는 `beforeunload` 에 답하지 못한다 —
 * `destroy` 는 unload 처리를 건너뛴다) 기존 종료 순서로 끝낸다(`before-quit` → 런타임 정리). 「취소」 면 아무것도 안 한다(앱·런타임 그대로).
 * 계측 실행은 `file-dialog-stub` 답(`discard` = 종료, 그 밖 = 취소)을 쓴다.
 */
async function confirmUnresponsiveQuit(): Promise<void> {
  if (unresponsivePrompt) return
  unresponsivePrompt = true
  try {
    const files = quitGate.dirty().map((file) => file.rel)
    const target = window
    const stubbed = measuring ? fileDialogAnswers.shift() : undefined
    if (stubbed !== undefined) fileDialogAsked.push('unresponsive')
    const spec = unresponsiveDialogSpec(files)
    const live = target !== null && !target.isDestroyed() ? target : null
    const quit = stubbed !== undefined ? stubbed === 'discard' : (live === null ? await dialog.showMessageBox(spec) : await dialog.showMessageBox(live, spec)).response === 0
    log('quit.unresponsive_choice', { files: files.length, quit, stubbed: stubbed !== undefined })
    if (!quit) {
      // 취소 — 이미 보낸 요청을 무효로 한다. 렌더러가 회복해 그 요청에 늦게 승인해도 종료하지 않는다(수정 r5 R5-B).
      quitGate.invalidate()
      return
    }
    quitGate.allow()
    if (live !== null && !live.isDestroyed()) live.destroy()
    app.quit()
  } finally {
    unresponsivePrompt = false
  }
}
let revision = 0
/** 소켓 경로를 든 목록은 **여기까지만** 산다 (수정 1회차 L9) — 화면으로는 이름·running 만 간다. */
let sessions: SessionHandle[] = []
let sessionsError: string | null = null
let selectedSession: string | null = null
let sessionNote: string | null = null
/** herdr 실행 파일 해소 결과 (LIFE-485 D5). null = 아직 해소 중. */
let herdr: HerdrResolution | null = null
/**
 * 설치본이면 동봉 herdr 자리 (LIFE-556) — 그 바이너리만 쓰고, 세션 폴백도 동봉 폴더(`corral-herdr`)만 본다.
 * 개발 실행(`app.isPackaged` 거짓)은 null — 바인딩이 없으면 레포 guard(LIFE-561), 없으면 종전대로 로그인 셸·알려진 위치의 herdr 에 붙는다.
 */
const bundledHerdr = app.isPackaged ? bundledHerdrPath(process.resourcesPath) : null

/** 레포 guard 로 가는 실행인가 (LIFE-561) — 개발 실행이고 바인딩(`CORRAL_SESSION`·`CORRAL_BACKEND_SOCKET`, 프로필 바인딩 포함)이 없다. */
function usesDevGuard(): boolean {
  return bundledHerdr === null && boundSessionName(process.env) === null && (process.env.CORRAL_BACKEND_SOCKET ?? '').length === 0
}

/** 세션 폴백 폴더 (LIFE-561 F1) — 해소한 바이너리를 따라간다. */
function herdrAppDir(): string {
  return herdrAppDirFor({ bundled: bundledHerdr !== null, resolution: herdr })
}
let herdrResolvedAt = 0
/** 실패한 해소를 다시 시도하는 간격 — 그 사이에 사용자가 herdr 를 설치했을 수 있다. */
const HERDR_RERESOLVE_MS = 60_000
/** default 의 재개 대상 — 돌고 있는 세션이 없을 때만 센다 (D2). */
let restore: BackendInput['restore'] = null
let lastBackendLog = ''
/** 세션 조회 상태 (r2 R2-02) — 첫 조회 전 `pending`, CLI 조회가 실패해 폴백했으면 `error`. */
let scanState: BackendInput['scan'] = 'pending'
/** 연속 조회 오류 수 (LIFE-532 D1) — `runPoll` 이 실제 조회 결과로 갱신한다. */
let scanErrorStreak = 0
let registry: RepoRegistry | null = null
let uiPrefs: UiPrefsStore | null = null
/** 탐색기 감시·git 허브 (LIFE-589) — 감시는 utility process 안에서 돈다. */
let explorerHub: ExplorerHub | null = null
/** LIFE-593 — ⌘P·탐색기 이름 필터의 전체 파일 목록(git). 종료 때 진행 중 자식을 끝낸다. */
let fileLister: FileLister | null = null
let contentSearcher: ContentSearcher | null = null
let fileWatch: FileWatch | null = null
/** 사용자 설정 (LIFE-512 S11) — 외관. ui-prefs(화면 상태)와 다른 파일·다른 칸이다(U8). */
let settings: SettingsStore | null = null
/** 상태바 provider 사용량 (LIFE-636) — 기동 때 만들고 `window-all-closed` 에서 정리한다. 토큰은 이 안(main)에서만 산다. */
let usage: UsageService | null = null
/** 에이전트 감지 (LIFE-520) — 기동 때 백그라운드로 한 번. 창·런타임 기동은 이것을 기다리지 않는다(K2ⓑ). */
let agentDetector: AgentDetector | null = null
/** 설정 › 작업 연결 (LIFE-600) — 기동 때는 저장 파일만 읽는다. 자격(키체인)은 그 연결이 처음 쓰일 때 푼다(C6). */
let work: WorkService | null = null
/** LIFE-603 — 작업 링크(해석·쓰기·사건)와 「작업에서 시작」. 작업 서비스와 같이 선다. */
let workLinks: WorkLinks | null = null
let workStarts: StartService | null = null
/** LIFE-808 R7 — 상태를 발행할 때마다 진행 중 재개 표지에 지금 pane 을 먹인다(요청 없이 끝난 에이전트도 표지가 안다). 세션 히스토리와 같이 선다. */
let observeResumes: ((state: AppState) => void) | null = null
/** C7 대조용 — 계측 실행(제어 소켓)에서 `CORRAL_WORK_IPC_TRACE` 가 있을 때만 작업 IPC 응답·push 를 NDJSON 으로 남긴다. */
function traceWork({ channel, value }: { channel: string; value: unknown }): void {
  const file = process.env.CORRAL_WORK_IPC_TRACE
  if (!measuring || file === undefined || file.length === 0) return
  try {
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), channel, value }) + '\n', { mode: 0o600 })
  } catch (error) {
    log('work.ipc_trace_failed', { error: String(error) })
  }
}
/** 비싼 쪽(git·herdr 왕복)만 캐시한다. 행은 내보낼 때마다 새로 붙인다 — tree.ts 의 주석 참고. */
let skeleton: RepoSkeleton[] = []
/** 지금 골격을 만든 세션 소켓 (LIFE-628) — 카드 밖 판정은 지금 붙은 소켓으로 만든 골격에서만 한다. */
let skeletonSocket: string | null = null
/** 지금 골격을 만든 빌드가 **시작한** 시각 (LIFE-628 F2) — 그 뒤에 처음 보인 workspace 는 골격이 모른다(`cardlessGate`). */
let skeletonStartedAt: number | null = null
/** store 에 workspace 가 처음 보인 시각 (LIFE-628 F2). 내보낼 때마다(`scheduleEmit`) 갱신하고, 사라진 id 는 지운다. */
const workspaceFirstSeen = new Map<string, number>()
/** 골격 재구성 재시도 스케줄 (LIFE-628 P1) — 진행 중이면 걸지 않고, 끝난 때부터 간격·백오프. 모든 `rebuildTree` 가 시작·끝을 알린다. */
const rebuildRetry = createRebuildScheduler({ now: () => Date.now() })
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
  // `claude attach` pane 의 세션 해소(LIFE-769) — argv 가 `claude` 뿐이면 감지한 claude 경로로 `claude agents --json --all` 을 띄운다.
  claudeExecutable: () => {
    const snapshot = agentDetector?.current()
    return snapshot?.kind === 'detected' ? (snapshot.agents.find((item) => item.agent === 'claude')?.path ?? null) : null
  },
})

/**
 * herdr 서버를 띄우는 손 (LIFE-485). 자동 기동·버튼·다시 시도가 이 하나로 모인다 — 진행 중이면 합친다.
 * 띄운 서버는 앱 종료 때 끄지 않는다(D4).
 */
const backendStarter = new BackendStarter({
  isRunning: async () => {
    const scan = await listSessions({ binary: herdrPath(), appDir: herdrAppDir() })
    if (scan.error !== null) return { kind: 'unknown', error: scan.error }
    return scan.sessions.some((session) => session.isDefault && session.running) ? { kind: 'running' } : { kind: 'stopped' }
  },
  spawn: (onExit) => {
    const binary = herdrPath()
    if (binary === null) return { ok: false, error: 'herdr 실행 파일을 해소하지 못했다', logPath: null }
    return spawnServer({
      binary,
      logPath: path.join(app.getPath('userData'), 'herdr-server.log'),
      onExit: (code, signal) => onExit(`code ${String(code)} signal ${String(signal)}`),
      bundled: herdr?.kind === 'found' && herdr.binary.source === 'bundled',
    })
  },
  logTail: (file) => readLogTail(file),
  stopChild: (pid) => stopProcessGroup(pid),
  refresh: () => pollSessions(),
  ownsChild: (pid) => inspectServerProcess(pid, herdrPath()),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  readyTimeoutMs: SERVER_READY_TIMEOUT_MS,
  pollMs: SERVER_READY_POLL_MS,
  onChange: () => scheduleEmit(),
  log,
  // LIFE-772 — 멈춘 default 의 claude 재개 참조를 백그라운드 전환 끝 id 로(재시작 재개가 멈춘 사본을 열지 않게).
  beforeSpawn: makeBeforeSpawn({ env: process.env, sessions: () => sessions, rewrite: rewriteRestoreRefs, log }),
})

function herdrPath(): string | null {
  return herdr?.kind === 'found' ? herdr.binary.path : null
}

function backendInput(): BackendInput {
  return {
    bound: boundSessionName(process.env),
    binary: backendBinary(),
    sessions,
    selected: selectedSession,
    link: { phase: link.linkState().phase, attempt: link.linkState().attempt },
    linkError: link.linkState().lastError,
    restore,
    starter: backendStarter.phase(),
    autoStartUsed: backendStarter.autoStartUsed(),
    scan: scanState,
    scanErrorStreak,
    scanError: sessionsError,
  }
}

function backendBinary(): BackendInput['binary'] {
  if (herdr === null) return { kind: 'resolving' }
  switch (herdr.kind) {
    case 'found':
      return { kind: 'found' }
    case 'missing':
      return { kind: 'missing', searched: herdr.searched, bundled: herdr.bundled }
    case 'stale':
      return { kind: 'stale', path: herdr.path, reason: herdr.reason }
  }
}

let resolving: Promise<void> | null = null

/**
 * 해소는 한 번에 하나만 돈다(r1 R1-04) — 로그인 셸 조회(최대 10초)가 느려도 다음 poll 이 셸을 또 띄우지 않는다.
 * 해소한 경로가 사라졌거나 실행할 수 없게 됐으면(herdr 를 옮기거나 지움) 다시 해소한다 — 낡은 경로를 붙들지 않는다.
 */
function ensureHerdrResolved(): Promise<void> {
  if (herdr?.kind === 'found') {
    if (isExecutableFile(herdr.binary.path)) return Promise.resolve()
    log('herdr.resolve.stale', { path: herdr.binary.path })
    herdr = null
  } else if (herdr !== null && Date.now() - herdrResolvedAt < HERDR_RERESOLVE_MS) {
    return Promise.resolve()
  }
  if (resolving === null) {
    // 개발 실행의 레포 자리 — `app.getAppPath()` 는 개발 실행에서 체크아웃의 `app/` 다.
    const appDir = app.getAppPath()
    const devGuard = usesDevGuard()
      ? async (): Promise<DevGuardLookup> => {
          const base = await devGuardBase(path.dirname(appDir))
          if (base === null) return { kind: 'absent', place: '(git 공용 폴더를 찾지 못했다)' }
          return findDevGuard({ base, backendDir: path.join(appDir, 'backend'), isExecutable: isExecutableFile })
        }
      : null
    resolving = resolveHerdrBinary({ bundled: bundledHerdr, devGuard })
      .then((result) => {
        herdr = result
        herdrResolvedAt = Date.now()
      })
      .finally(() => {
        resolving = null
      })
  }
  return resolving
}

/** 「서버 시작」·「다시 시도」 — 지금 상태가 확인·실패일 때만 띄운다. 지정 세션·돌고 있는 세션이면 아무것도 안 한다(K3①⑩). */
async function startBackendFromUi(): Promise<void> {
  const status = decideBackend(backendInput()).status
  if (status.kind !== 'confirm' && status.kind !== 'failed' && status.kind !== 'starting') {
    log('backend.start.ignored', { status: status.kind })
    return
  }
  await backendStarter.start('button')
  await pollSessions()
}

/**
 * 연결 실패 카드의 「다시 시도」 (LIFE-532 D3). 원인 `link` 는 **같은 세션**의 링크만 다시 연다 — `pickSession` 의 정리(스트림 닫기·지문·
 * 통합 상태 비우기)는 세션이 바뀔 때의 것이라 하지 않는다. 영역 스트림은 링크와 별개 소켓이고 같은 세션의 것이다.
 */
const backendRetry = new BackendRetry({
  status: () => decideBackend(backendInput()).status,
  reopenLink: (name) => {
    const found = sessions.find((session) => session.name === name)
    if (found === undefined) return false
    link.open(found)
    scheduleEmit()
    return true
  },
  poll: () => pollSessions(),
  log,
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

/** base 대비 재료 (LIFE-830) — 트리·레지스트리에서 읽어 `scmBaseInputsOf`(같은 레포 부모만, 시험 고정)에 넘긴다. */
function scmBaseInputs(root: string): ScmBaseInputs {
  return scmBaseInputsOf({
    repos: currentState().repos,
    root,
    baseRefOf: (repoRoot) => {
      try {
        return registry?.records().find((record) => record.path === repoRoot)?.baseRef ?? null
      } catch {
        return null
      }
    },
  })
}

/** 레지스트리 워크트리 메타 (LIFE-478) — 못 읽으면 빈 값(레지스트리 오류는 `registry.lastError` 가 따로 보인다). */
function registryMetadata(): Record<string, WorktreeMetadataRecord> {
  try {
    return registry?.metadata() ?? {}
  } catch {
    return {}
  }
}

function currentState(): AppState {
  const joined = joinTree(skeleton, attachDigests(link.store.rows(), digests), registryMetadata())
  // LIFE-603 — 작업 링크를 싣는다(명시 · 자동 · 예외의 해석은 `shared/work-link.ts` 한 곳).
  const tree = workLinks === null ? joined : { ...joined, repos: workLinks.annotate(joined.repos) }
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
    backend: decideBackend(backendInput()).status,
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
    // LIFE-507 — live 일 때의 store 는 스냅샷 + 이후 이벤트라 herdr 세션 전체다. 재접속 중엔 비어 있을 수 있어 null(모른다)로 낸다.
    // 폴백으로 남의 세션에 붙었을 때도 null — 그 목록으로 제 세션의 핀·색·번호·배치를 지우지 않는다(fix1 R1-M1).
    herdrTabIds: link.linkState().phase === 'live' && isOwnSession({ selected: selectedSession, env: process.env }) ? link.store.rows().flatMap((workspace) => workspace.tabs.map((tab) => tab.tabId)) : null,
  }
}

/**
 * 카드 밖 workspace (LIFE-628 S1) — Resource Manager 가 2초마다 부른다. 가릴 수 없으면 null(빈 목록과 다르다):
 * 링크가 live 가 아니다(재접속 중 store 가 비어 있을 수 있다) · 제 세션이 아니다(폴백으로 남의 세션에 붙음 — `herdrTabIds` 와 같은 가드) ·
 * 골격이 지금 소켓으로 만든 것이 아니다(세션 전환 직후·첫 골격 전 — 바인딩이 비어 전부 카드 밖으로 보인다) ·
 * 어느 레포의 열림상태 읽기가 실패했다(그 레포 workspace 가 카드 밖으로 잘못 보인다).
 */
function cardlessNow(): WorkspaceRow[] | null {
  noteWorkspaces()
  const gate = cardlessGateNow()
  if (gate === null) {
    // 골격 오류로 보류면 스스로 회복하게 골격을 다시 세운다(G5) — 진행 중이 없고 끝난 때부터 백오프 간격이 지났을 때만(P1).
    if (skeletonHealth(skeleton).kind !== 'ok' && !treeScheduled && rebuildRetry.due('error')) {
      log('resource.cardless_retry', { reason: 'skeleton-error', waitMs: rebuildRetry.waitMs('error'), permanent: rebuildRetry.permanentReason() })
      scheduleTree()
    }
    return null
  }
  // 골격보다 새 workspace 가 있으면 골격을 한 번 다시 세운다 — 진짜 카드 밖이면 그 뒤에 목록에 나온다(F2). 같은 in-flight 규칙(P1).
  if (gate.fresh > 0 && !treeScheduled && rebuildRetry.due('fresh')) scheduleTree()
  return gate.rows
}

/** 카드 밖 판정의 문을 지금 값으로 연다 — 부수 효과 없음(재시도 예약·처음 본 시각 기록은 부르는 쪽 몫). */
function cardlessGateNow(): ReturnType<typeof cardlessGate> {
  return cardlessGate({
    socketPath: currentSocketPath(),
    skeleton,
    skeletonSocket,
    skeletonStartedAt,
    linkPhase: link.linkState().phase,
    ownSession: isOwnSession({ selected: selectedSession, env: process.env }),
    workspaces: link.store.rows(),
    firstSeenAt: workspaceFirstSeen,
  })
}

/**
 * corral 밖에서 닫힌 pane 을 보존할지 (LIFE-694 ①) — store 가 그 pane 을 보존하려는 순간에만 묻는다(r1 리뷰 F2). 판정은 `retention.ts`.
 * 처음 본 시각은 여기서 적지 않는다 — 모르는 workspace 는 신선한 것으로 보아 카드 밖 목록에 안 들고, 그래서 보존된다(모르면 남기는 쪽).
 */
link.store.setRetentionPolicy(({ workspaceId, cwd }) => {
  const keep = keepRetention({
    workspaceId,
    cwd,
    cardless: cardlessGateNow()?.rows ?? null,
    homes: homesOf(homeDirReal()),
    isDirectory: directoryNow,
    isDeadSlot: deadSlotNow,
  })
  // 정책은 실제로 보존될 pane 에만 불리므로 false 는 곧 「보존하지 않았다」 다.
  if (!keep) log('retained.skip_ownerless', { workspaceId, cwd })
  return keep
})

/** 확인된 죽은 worktree 자리 — 골격 목록 판정 + 자리 뿌리의 파일시스템 확인(F1). */
function deadSlotNow(target: string): boolean {
  return confirmedDeadSlot({ path: target, worktreePaths: skeleton.flatMap((repo) => repo.worktrees.map((worktree) => worktree.path)), slotState: slotStateNow })
}

/** 붙을 카드가 없어진 보존 행을 걷는다 (LIFE-694 ② · C3) — 내보내기 직전에. 판정 불가면 걷지 않는다. */
function pruneRetained(): void {
  // 걷을 것이 없으면 판정(카드 밖 문 · store 행 조립)도 하지 않는다 — emit 마다 불린다(r2 리뷰 G3).
  const retained = link.store.retainedRows()
  if (retained.length === 0) return
  const paneIds = prunableRetained({
    retained,
    determinable: cardlessGateNow() !== null,
    isDeadSlot: deadSlotNow,
  })
  const dropped = link.store.dropRetained(paneIds)
  if (dropped.length > 0) log('retained.pruned_dead_slot', { panes: dropped.join(',') })
}

/** store 의 workspace 가 처음 보인 시각을 적는다(F2). 사라진 id 는 지운다 — 같은 id 가 다시 오면 새로 본 것이다. */
function noteWorkspaces(): void {
  const now = Date.now()
  const live = new Set<string>()
  for (const workspace of link.store.rows()) {
    live.add(workspace.workspaceId)
    if (!workspaceFirstSeen.has(workspace.workspaceId)) workspaceFirstSeen.set(workspace.workspaceId, now)
  }
  for (const id of [...workspaceFirstSeen.keys()]) if (!live.has(id)) workspaceFirstSeen.delete(id)
}

/**
 * 카드 귀속을 **그 자리에서** 다시 읽는다 (LIFE-628 F2 — 닫기 직전 권위 재확인). 메모리 골격이 아니라 등록 레포마다 herdr `worktree.list`
 * (`openWorktreeRow` 가 중복 생성을 막을 때 읽는 것과 같은 권위)의 열린 workspace 전부. 한 레포라도 읽기에 실패하면 null — 닫지 않는다.
 */
function claimedWorkspaceIdsNow(socketPath: string): Promise<Map<string, string[]> | null> {
  return readClaimedWorkspaceIds({ roots: registry?.list() ?? [], read: (root) => readOpenWorkspaces(socketPath, root), log })
}

/** 상태 전송은 한 틱으로 뭉친다 — workspace_created 와 그 pane_created 가 같은 프레임에 실린다. */
function scheduleEmit(): void {
  if (emitScheduled) return
  emitScheduled = true
  setTimeout(() => {
    emitScheduled = false
    noteWorkspaces()
    pruneRetained()
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
    // LIFE-603 — 링크된 worktree 의 사건(자동 연결 · 질문 · 턴 결과)을 활동에 남긴다. 화면이 닫혀 있어도 여기서 남는다.
    workLinks?.observe(state.repos)
    observeResumes?.(state)
    // 응답 전에 끝났거나 결과가 미확정이던 시작을 트리와 맞춰 링크한다(R1-C·R1-B).
    void workStarts?.recover(state.repos).catch((error: unknown) => log('work.start_recover_failed', { error: String(error) }))
    // 폰 목록(LIFE-580) — 방금 만든 상태를 그대로 쓴다(두 번 만들지 않는다). 구독자가 없으면 아무 일도 안 한다.
    lastEmittedState = state
    mobile?.listChanged()
    // LIFE-589 — 닫힌 worktree 의 탐색기 감시를 푼다(감시 자원은 열린 worktree 만).
    explorerHub?.prune()
  }, 0)
}

/** 카드·상태바 git 상태를 **그 경로만** 다시 읽는다 (LIFE-831 K7 — 원격 동작·커밋·amend 뒤). patch·재빌드 overlay·캐시 모두 「나중 스냅샷만 이긴다」(`isLaterSnapshot`). */
const worktreeStatus = new WorktreeStatusRefresh({ read: getGitStatus, invalidate: invalidateGitStatus, isLater: isLaterSnapshot })
async function refreshWorktreeStatus(input: { path: string; reason: string }): Promise<void> {
  const startedAt = Date.now()
  const value = await worktreeStatus.refresh(input.path)
  if (value === null) return
  const patched = patchWorktreeStatus({ skeleton, path: input.path, value, isLater: isLaterSnapshot })
  skeleton = patched.skeleton
  log('scm.status.refresh', { reason: input.reason, root: rootTag(input.path), found: patched.found, changed: patched.changed, ms: Date.now() - startedAt, ahead: value.ahead, behind: value.behind })
  if (patched.changed) scheduleEmit()
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
  // 지금 store 의 workspace 는 이 빌드가 읽을 herdr 상태 안에 있다 — 시작 시각 전에 적어 둔다(F2).
  noteWorkspaces()
  const startedAt = Date.now()
  const generation = ++treeGeneration
  const socketPath = currentSocketPath()
  rebuildRetry.started()
  let built: RepoSkeleton[]
  try {
    built = await buildSkeleton({ roots: registry?.list() ?? [], socketPath })
  } catch (error) {
    rebuildRetry.finished(null)
    throw error
  }
  if (generation !== treeGeneration) {
    rebuildRetry.finished(null)
    log('tree.stale', { generation, current: treeGeneration, ms: Date.now() - startedAt })
    return
  }
  rebuildRetry.finished(skeletonHealth(built))
  skeleton = worktreeStatus.overlay({ built })
  skeletonSocket = socketPath
  skeletonStartedAt = startedAt
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
      // LIFE-628 F7 — 이 루트의 열림상태를 방금 읽었다. 빌드 때의 herdr 읽기 실패는 더 이상 사실이 아니다.
      openError: null,
      worktrees: repo.worktrees.map((worktree) => {
        const fresh = byPath.get(worktree.path) ?? null
        if (fresh === worktree.openWorkspaceId) return worktree
        drift.push({ worktree: worktree.path, from: worktree.openWorkspaceId, to: fresh })
        return { ...worktree, openWorkspaceId: fresh }
      }),
    }
  })
  // G5 — 드리프트가 없어도 이번에 읽기에 성공한 루트의 openError 는 걷는다(그것만 바뀌었으면 note 없이 내보낸다).
  const cleared = patched.some((repo, index) => repo.openError !== skeleton[index]?.openError)
  if (drift.length === 0) {
    if (cleared) {
      skeleton = patched
      log('tree.open_error_cleared', { reason })
      scheduleEmit()
    }
    return { changed: false, note: null }
  }
  skeleton = patched
  log('tree.binding_drift', { reason, drift })
  dropStreamIfPaneUnviewable() // 바인딩이 걷히며 스트리밍 pane 이 트리 밖이 될 수 있다 (C2)
  scheduleEmit()
  return { changed: true, note: `바인딩 ${drift.length}건 갱신` }
}

/**
 * 외부 git worktree 변경 감지 (LIFE-445) — 셸 `git worktree add/remove/prune` 이 사이드바에 닿는 유일한 길.
 * herdr 링크와 무관하게 돈다(재동기·창 포커스는 링크 live 일 때만 돈다 — 00-analysis P5). 지문이 바뀐 틱에만
 * `scheduleTree` 를 부르므로 재빌드는 기존 뭉침·세대 가드(L6)·refreshBindings 경합 규칙을 그대로 탄다.
 */
const worktreePoller = new WorktreePoller({
  roots: () => registry?.list() ?? [],
  onChange: (changed) => {
    log('worktree.changed', { roots: changed })
    scheduleTree()
  },
  onRoots: (count) => log('worktree.poll_roots', { count }),
})

/**
 * 레지스트리 세대 — 관측한 등록 목록이 직전과 다를 때 오른다(LIFE-469 R2-01·R3-01·R4-01, `AppState.registryGeneration`).
 * GUI·CLI(`workspaceModule`)·앱 밖 편집을 가리지 않는다 — 관측 지점은 `currentState` 와 `removeRepo`(제거 트랜잭션 안의 목록).
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
  // 제거와 관측을 한 트랜잭션의 목록으로 묶는다(R4-01) — 응답 세대 = 그 root 가 없는 목록의 세대.
  const result = registry === null ? { ok: false, error: '레지스트리 미초기화' } : removeObserved({ registry, generation: registryGeneration, root: input })
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
/** LIFE-591 — 파일 탭 확인 대화상자 답 스텁(계측 실행만, 제어 소켓 `file-dialog-stub`). 비면 진짜 창. `fileDialogAsked` = 스텁이 받은 갈래 기록. */
let fileDialogAnswers: string[] = []
const fileDialogAsked: string[] = []

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
async function createRowInWorkspace(input: { workspaceId: string; kind: AgentKind; cwd?: string; label?: string; args?: string[] }): Promise<CreateRowResult> {
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
  const running = await probeRunningPanes({ socketPath, panes: paneIds.map((paneId) => ({ tabId: '', paneId })), subject })
  const foreground = running.flatMap((pane) => pane.foreground)
  return foreground.length > 0 ? { clear: false, foreground } : { clear: true }
}

/** 게이트의 pane 단위 판정 — 실행 중(셸 아닌 포그라운드 또는 probe 실패)인 pane 만 돌려준다. 탭 여럿 닫기(LIFE-495)가 pane·탭별로 쓴다. */
async function probeRunningPanes(input: {
  socketPath: string
  panes: readonly { tabId: string; paneId: string }[]
  subject: Record<string, unknown>
}): Promise<RunningPane[]> {
  const { socketPath, subject } = input
  const running: RunningPane[] = []
  for (const { tabId, paneId } of input.panes) {
    const probe = await probeForeground(socketPath, paneId)
    // 판정 규칙은 `close-tabs.ts runningForeground` 한 곳(LIFE-628 F4 — 런타임 없는 pane 은 프로세스 없음).
    const foreground = runningForeground(probe)
    log('lifecycle.close_gate', {
      ...subject,
      paneId,
      shellPid: probe.shellPid,
      foregroundGroupId: probe.foregroundGroupId,
      clear: foreground === null,
      missing: probe.missing,
      foreground: probe.foreground.map((item) => item.name),
      probeError: probe.error,
    })
    if (foreground === null) continue
    running.push({ tabId, paneId, foreground })
  }
  return running
}

/**
 * 탭 여럿을 닫는다 (LIFE-495 K2ⓒ·K3ⓒ) — 「다른/오른쪽/왼쪽 탭 닫기」와 단건 닫기가 같은 길이다. 게이트 규칙은 `close-tabs.ts`
 * (확인 전 한 번 묻기 · 탭마다 닫기 직전 재판정 · 확인 밖 실행 중이면 멈추고 다시 묻기 — fix1 R1-05). 여기는 herdr·store 를 잇는다.
 */
async function closeTabsByIds(input: { tabIds: readonly string[]; confirmed: boolean; alwaysConfirm: boolean; confirmedPaneIds: readonly string[] }): Promise<CloseTabsResult> {
  const socketPath = currentSocketPath()
  if (socketPath === null) return { outcome: 'error', closed: [], error: '세션이 없다' }
  const panesOf = (tabId: string): string[] | null => {
    for (const workspace of link.store.rows()) {
      const tab = workspace.tabs.find((row) => row.tabId === tabId)
      if (tab !== undefined) return tab.panes.map((pane) => pane.paneId)
    }
    return null
  }
  const result = await closeTabsGated({
    tabIds: input.tabIds,
    confirmed: input.confirmed,
    alwaysConfirm: input.alwaysConfirm,
    // LIFE-516 K4ⓑ — 닫기마다 저장소에서 읽는다(설정 화면·대화상자 체크박스가 바꾼 값이 다음 닫기부터). 저장소가 없으면 묻는다.
    confirmRunning: settings === null || !settings.get().skipCloseTerminalWithRunningProcessConfirm,
    confirmedPaneIds: input.confirmedPaneIds,
    panesOf,
    probe: (panes) => probeRunningPanes({ socketPath, panes, subject: { close: 'tabs', tabIds: input.tabIds } }),
    // S15ⓓ ② — 사용자가 **명시적으로** 닫는 탭이다. 그 닫힘은 완료 행으로 되살리지 않는다.
    close: (tabId) => withRetentionSuppressed({ store: link.store, ids: [tabId], what: 'tab', run: hooks => closeTab(socketPath, tabId, hooks) }),
  })
  if (result.outcome !== 'needs-confirm' || result.closed.length > 0) scheduleEmit()
  log('lifecycle.close_tabs', { requested: input.tabIds.length, outcome: result.outcome, closed: result.closed.length })
  return result
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
    if (!client || client.isDestroyed() || currentSocketPath() !== backendBinding()?.socket) throw new RuntimeError('ui_unavailable', 'GUI no longer addresses this backend')
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
      const binding = backendBinding()
      return binding === null || binding.session === null ? null : { socket: binding.socket, session: binding.session }
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

let pollInFlight: Promise<void> | null = null
let pollQueued: Promise<void> | null = null

/**
 * 세션 조회는 겹쳐 돌지 않는다(r1 R1-04). 도는 중에 또 부르면 끝난 뒤 **한 번 더** 돈다 — 서버를 띄운 직후의
 * 호출이 띄우기 전에 시작한 조회 결과를 받지 않게 하려는 것이다. 대기 중인 재조회는 하나로 합친다.
 */
function pollSessions(): Promise<void> {
  if (pollInFlight === null) {
    pollInFlight = runPoll().finally(() => {
      pollInFlight = null
    })
    return pollInFlight
  }
  if (pollQueued === null) {
    pollQueued = pollInFlight.then(() => {
      pollQueued = null
      return pollSessions()
    })
  }
  return pollQueued
}

async function runPoll(): Promise<void> {
  await ensureHerdrResolved()
  // 레포 guard 낡음(LIFE-561 G3) — 세션을 조회하지 않는다. 낡은 바이너리 쪽 폴더의 서버에 붙지 않고 카드로 멈춘다.
  const scan = herdr?.kind === 'stale' ? { sessions: [], error: null } : await listSessions({ binary: herdrPath(), appDir: herdrAppDir() })
  // 설치본은 default 하나만 본다(LIFE-556 fix2 M2) — 다른 세션은 고르기·기동 결정·동봉 바인딩 어디에도 오르지 않는다.
  // 레포 guard 로 풀린 개발 실행도 같다(LIFE-561 G2) — herdr-dev 의 다른 이름 세션에 붙지 않는다.
  sessions = pinnedSessions({ sessions: scan.sessions, pinDefault: bundledHerdr !== null || onRepoGuard(herdr), bound: boundSessionName(process.env) })
  sessionsError = scan.error
  scanState = scan.error === null ? 'ok' : 'error'
  const previousStreak = scanErrorStreak
  scanErrorStreak = nextScanErrorStreak({ streak: scanErrorStreak, scan: scanState })
  // 연속 계수를 남긴다(fix1 R1-02) — `backend.status` 는 종류가 바뀔 때만 찍혀 「1·2회엔 카드 없음」 을 로그로 대조할 수 없다.
  // 오류가 이어지는 동안과 0 으로 돌아온 한 번만(fix2 N-03) — 성공이 이어지는 평시엔 0줄이다(3초마다 한 줄은 하루 수 MB).
  if (scanErrorStreak > 0 || scanErrorStreak !== previousStreak) log('sessions.scan', { scan: scanState, streak: scanErrorStreak })
  // default 가 돌고 있으면 남은 실패를 걷는다(r2 R2-01) — 그 뒤 멈추면 확인(exited)과 재개 요약이 나와야 한다.
  if (scanState === 'ok' && sessions.some((session) => session.isDefault && session.running)) backendStarter.observeRunning()
  // 조회 오류 중이어도 default 에 live 로 붙어 있으면 서버가 돈다 — 낡은 실패를 걷는다(r5 R5-02).
  else if (selectedSession === DEFAULT_SESSION && link.linkState().phase === 'live') backendStarter.observeRunning()
  if (selectedSession === null) {
    // 고르는 규칙은 순수 함수에 있다 (수정 1회차 M6) — 멈춘 세션을 실제로 만들지 않고 재생으로 잰다.
    const choice = pickSessionName({ sessions, wanted: process.env.CORRAL_SESSION })
    sessionNote = choice.note
    if (choice.note !== null) log('session.select.note', { note: choice.note })
    if (choice.name !== null) pickSession(choice.name)
  }
  evaluateBackend()
  scheduleEmit()
}

/** 연결 상태를 다시 정하고, 자동 기동 조건이면 띄운다 (LIFE-485 D1). 결정 자체는 `decideBackend` 순수 함수다. */
function evaluateBackend(): void {
  // 계수는 결정이 그 값을 쓸 때만 — default 가 멈춰 확인·자동 기동 후보일 때(r1 R1-05). 붙어 live 인 평시에는 읽지 않는다.
  const needsCount = needsRestoreCount({ bound: boundSessionName(process.env), sessions, selected: selectedSession })
  restore = needsCount ? readRestoreTargets(sessions.find((session) => session.isDefault)?.sessionDir ?? null) : null
  const decision = decideBackend(backendInput())
  // 연결 실패는 원인까지 — 원인 `scan` → `link` 전이도 로그에 남는다(LIFE-532).
  const summary = JSON.stringify({ status: decision.status.kind, cause: decision.status.kind === 'unreachable' ? decision.status.cause : null, restore })
  if (summary !== lastBackendLog) {
    lastBackendLog = summary
    log('backend.status', { status: decision.status, restore })
  }
  if (decision.autostart) {
    void backendStarter
      .start('auto')
      .then(() => pollSessions())
      .catch((error: unknown) => log('backend.start.unhandled', { error: String(error) })) // r2 R2-03
  }
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

/** 붙여넣기 PNG 폴더 — OS 임시 폴더 아래 corral 전용. macOS `$TMPDIR`(`/var/folders/…/T/`)는 공백이 없다 (K1ⓑ). */
function pasteDir(): string {
  return path.join(app.getPath('temp'), 'corral-paste')
}

/** LIFE-527 — 창 크롬 동기화 입력(`window-zoom.ts`). darwin 만 hiddenInset 신호등이 있다. */
function chromeTarget(target: BrowserWindow) {
  return { target, mac: process.platform === 'darwin' }
}

function pushWindowChrome(): void {
  if (window !== null) pushChrome(chromeTarget(window))
}

function createWindow(): void {
  const size = windowSize()
  // LIFE-527 D1 — macOS 는 Orca 198 `createMainWindow.ts:112-128` 그대로: 기본 타이틀바를 걷고(hiddenInset) 신호등을
  // 사이드바 머리 36px 띠의 세로 중심에 둔다. 다른 플랫폼은 지금 그대로(기본 타이틀바).
  const macChrome: BrowserWindowConstructorOptions =
    process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: trafficLightPosition(1) } : {}
  window = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    backgroundColor: '#12141a',
    title: 'corral',
    ...macChrome,
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
  // LIFE-591 E3ⓒ — 빨간 닫기 단추(창 `close`)도 ⌘Q 와 같은 확인을 거친다. 창이 닫히면 `window-all-closed` → 정리 → 종료이므로 여기서 막아야 렌더러의 수정 내용이 산다.
  window.on('close', (event) => {
    if (quitGate.intercept('window-close')) {
      event.preventDefault()
      reshowForConfirm('window-close')
    }
  })
  window.on('closed', () => quitGate.setDirty([]))
  window.webContents.on('render-process-gone', () => {
    quitGate.setDirty([])
    // LIFE-830 수정 r1 A5 — 죽은 렌더러가 켜 둔 base 대비를 남기지 않는다(새 렌더러가 필요하면 다시 켠다).
    explorerHub?.clearBaseModes()
  })
  /**
   * LIFE-591 E3ⓕ — 렌더러 다시 불러오기(기본 메뉴 View ▸ Force Reload ⌘⇧R 등 — ⌘R 은 위 `before-input-event` 가 가져간다). 렌더러는 수정 파일이 있으면
   * `beforeunload` 를 막는다 → 여기서 묻고, 「다시 불러오기」 면 막음을 무시한다(`preventDefault` = 그래도 내린다 — Electron 문서 패턴). 종료 확인을 이미 지났으면 묻지 않는다.
   */
  window.webContents.on('will-prevent-unload', (event) => {
    if (quitGate.allowed()) {
      event.preventDefault()
      return
    }
    const target = window
    const files = quitGate.dirty().map((file) => file.rel)
    const options = reloadDialogSpec(files.length > 0 ? files : ['(수정된 파일)'])
    // 계측 스텁(`file-dialog-stub` 의 `reload` = 다시 불러오기, 그 밖 = 취소).
    const stubbed = measuring ? fileDialogAnswers.shift() : undefined
    if (stubbed !== undefined) fileDialogAsked.push('reload')
    const choice = stubbed !== undefined ? (stubbed === 'reload' ? 0 : 1) : target === null || target.isDestroyed() ? 1 : dialog.showMessageBoxSync(target, options)
    log('file.reload_confirm', { files: files.length, reload: choice === 0 })
    if (choice === 0) event.preventDefault()
  })
  // LIFE-527 D3 — 전체화면이면 신호등이 창 위에 없다. 렌더러가 신호등 여백을 걷도록 상태를 민다.
  window.on('enter-full-screen', pushWindowChrome)
  window.on('leave-full-screen', pushWindowChrome)
  bindStartupZoomSync(chromeTarget(window))
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
  // 사용량 — 포커스 복귀 때 5분 넘게 묵었으면 즉시 1회(LIFE-636 E7ⓑ).
  window.on('focus', () => usage?.onFocus())
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
    // LIFE-830 수정 r1 A5 — 다시 불러오기 전 문서가 켠 base 대비는 그 문서와 함께 끝난다(새 문서의 useScm 이 다시 켠다).
    explorerHub?.clearBaseModes()
    explorerFocused = false
    window?.webContents.setIgnoreMenuShortcuts(false)
  })
  // 메인 프레임이 새 문서를 실었다(다시 읽기·렌더러 재생성) — 실행 취소 기록이 사라졌으니 가져오기 재생 근거를 놓는다(LIFE-592 수정 r3).
  window.webContents.on('did-navigate', () => explorerDrops.releaseAll())
  window.webContents.on('before-input-event', (event, input) => {
    if (instrumented && (input.type === 'keyUp' || input.control || input.meta || input.alt)) {
      log('input.raw', { type: input.type, key: input.key, control: input.control, meta: input.meta, alt: input.alt, shift: input.shift })
    }
    if (shortcutRecording) return
    if (input.type !== 'keyDown') return
    // LIFE-592 — 탐색기 트리 포커스의 ⌘Z·⌘⇧Z. 메뉴 role 과 페이지 keydown 의 순서에 기대지 않으려고 여기서(둘보다 먼저) 가져온다. ⌘W 와 같은 수(R23 — 메뉴 재구성 없음).
    const explorerMatch = explorerKeyShortcut({ ...input, overrides: keybindings.get(), explorerFocused })
    if (explorerMatch !== null) {
      event.preventDefault()
      log('shortcut.intercepted', { key: input.key.toLowerCase(), meta: true, shift: input.shift, repeat: input.isAutoRepeat, explorer: explorerMatch.id })
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:shortcut', explorerMatch)
      return
    }
    // 메뉴가 쥔 키 중 corral 이 가져오는 것 — `⌘W`(File ▸ Close Window)와 **`⌘R`**(View ▸ Reload, LIFE-495 F9·U2).
    // `⌘R` 을 두면 탭 이름 바꾸기 대신 **창이 새로고침**된다(화면 상태가 날아간다). Orca 는 Reload 항목에서 가속키를 빼서 피했다
    // (`register-app-menu.ts:280-290`). corral 은 ⌘W 와 같은 수(R23 — 메뉴를 다시 만들지 않는다)로 가져온다. `⌘⇧R`(Force Reload)는
    // 손대지 않는다 — shift 가 끼면 빠진다. keyUp 억제 주의(아래 주석)는 ⌘W 와 같다 — 홀드 키가 아니라 문제없다.
    // 판정은 `menuKeyShortcut`(shared, 순수) — 반복 억제는 매칭된 액션 기준(fix1 R1-06).
    const { claimed, dispatch } = menuKeyShortcut({ ...input, overrides: keybindings.get() })
    if (claimed === null) return
    event.preventDefault()
    // 가로챘다는 사실은 **로그로만** 보인다 — 키를 삼켰으니 화면에는 아무 흔적이 없고,
    // "안 닫혔다"는 관측은 "안 눌렸다"와 구분되지 않는다.
    log('shortcut.intercepted', { key: claimed.toLowerCase(), meta: true, repeat: input.isAutoRepeat, dispatched: dispatch !== null })
    if (dispatch && window !== null && !window.isDestroyed()) window.webContents.send('corral:shortcut', dispatch)
  })
  /**
   * 새 창은 전부 거절한다. 외부로 넘기는 것은 **http·https 만**(`isExternalOpenAllowed`, LIFE-565 D2 — 원래 https 만) — 보안 체크리스트 17 (수정 1회차 L12).
   * R1 화면에 외부 링크는 없지만, `openExternal` 에 걸러지지 않은 URL 을 넘기는 모양이
   * 골격에 남아 있으면 나중에 그대로 구멍이 된다. `file:`·`javascript:` 는 여기서 끝난다.
   * 허용·거절 로그 모두 쿼리·조각·userinfo 를 뺀 모양만 남긴다(`externalOpenLogUrl`) — 토큰·비밀번호를 로그 파일에 쓰지 않는다.
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenAllowed(url)) {
      log('window.open.external', { url: externalOpenLogUrl(url) })
      void shell.openExternal(url)
    } else log('window.open.denied', { url: externalOpenLogUrl(url) })
    return { action: 'deny' }
  })

  /**
   * 메인 창은 앱 화면 하나다 — 다른 곳으로 이동하지 않는다(LIFE-602 F12 · 보안 체크리스트 13). 본문 markdown 의 `<a href>` 를 그냥 눌러도
   * 창이 그 주소로 가지 않게 막는다. 외부 링크는 렌더러가 `window.open` 으로 위 새 창 거절 경로(http·https 허용 목록)에 보낸다.
   * 다시 불러오기(같은 주소)는 이 이벤트를 내지 않는다.
   */
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    log('window.navigate.denied', { url: externalOpenLogUrl(url) })
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
  settings = new SettingsStore(app.getPath('userData'))
  settings.load()
  mobile = new MobileService({
    userData: app.getPath('userData'),
    appVersion: app.getVersion(),
    log,
    // 대화방 목록(LIFE-580) — 렌더러에 낸 마지막 상태 + 사이드바 정렬 설정. 상태를 아직 못 냈으면 null(폰은 「아직 못 읽음」 으로 기다린다).
    listSource: () => (lastEmittedState === null ? null : { state: lastEmittedState, prefs: uiPrefs?.get() ?? null }),
    // 폰 쓰기(LIFE-582) — 목록의 세션이 guard 바인딩일 때만(CLI·GUI 넣기와 같은 봉투). 아니면 쓰기는 실패로 끝난다.
    inputSocket: () => {
      const socket = currentSocketPath()
      return socket !== null && socket === backendBinding()?.socket ? socket : null
    },
    onStatus: (status) => {
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:mobile', status)
    },
    // `CORRAL_TAILSCALE_BIN` — 격리 실행이 가짜 CLI 를 꽂을 때만(있으면 그것만 본다). 평시는 알려진 위치 → 로그인 셸.
    locate: () => locateTailscale({
      override: process.env.CORRAL_TAILSCALE_BIN,
      candidates: KNOWN_TAILSCALE_LOCATIONS,
      isExecutable: isExecutableFile,
      loginShellLookup: loginShellTailscale,
    }),
    run: runTailscale,
  })
  const workStore = new WorkConnectionStore(app.getPath('userData'))
  workStore.load()
  // LIFE-602 — corral 활동 저장소(성공한 작업 쓰기). 경로 오버라이드 `CORRAL_WORK_ACTIVITY`(격리 실행).
  const workActivity = new WorkActivityStore(app.getPath('userData'))
  workActivity.load()
  // `CORRAL_LA_MCP_URL` — 격리 실행이 모의 LA MCP 서버를 꽂을 때만. 평시는 실제 LA.
  const laUrl = process.env.CORRAL_LA_MCP_URL !== undefined && process.env.CORRAL_LA_MCP_URL.length > 0 ? process.env.CORRAL_LA_MCP_URL : LA_DEFAULT_MCP_URL
  if (laUrl !== LA_DEFAULT_MCP_URL) log('work.la_endpoint_override', { url: laUrl.slice(0, 200) })
  const testCipher = measuring && process.env.CORRAL_WORK_TEST_CIPHER === '1'
  if (testCipher) log('work.test_cipher', { reason: 'CORRAL_CONTROL_SOCKET + CORRAL_WORK_TEST_CIPHER — 키체인 무접촉 격리 실행' })
  // LIFE-601 — 격리 실행(측정 모드)에서만 모의 Jira 형 출처를 레지스트리에 더한다. 평시 앱에는 없다.
  const mockSource = measuring && process.env.CORRAL_WORK_MOCK === '1'
  if (mockSource) log('work.mock_source', { reason: 'CORRAL_CONTROL_SOCKET + CORRAL_WORK_MOCK — 작업 페이지 격리 실행' })
  const jiraFixture = jiraFixtureBaseFromEnv(process.env)
  if (jiraFixture !== null) log('work.jira_fixture', { url: jiraFixture, reason: 'CORRAL_CONTROL_SOCKET + CORRAL_JIRA_FIXTURE_URL — Jira fixture 격리 실행' })
  work = new WorkService({
    store: workStore,
    vault: new CredentialVault(testCipher ? measurementCipher() : electronCipher(safeStorage)),
    activity: workActivity,
    sources: new WorkSourceRegistry([
      laSourceEntry({ url: laUrl, clientVersion: app.getVersion() }),
      // LIFE-605 — Jira Cloud. fixture 주소는 측정 모드(제어 소켓) + 127.0.0.1 일 때만 열린다(평시 앱은 검증한 *.atlassian.net 만).
      jiraSourceEntry(jiraFixture === null ? {} : { baseUrlOf: () => jiraFixture }),
      ...(mockSource ? [mockSourceEntry({ state: seedMockDemoState() })] : []),
    ]),
    repos: () => {
      try {
        return registry?.records().map((repo) => ({ id: repo.id, root: repo.path, name: repo.name })) ?? []
      } catch {
        return []
      }
    },
    onChange: (state) => {
      traceWork({ channel: 'corral:workSettings', value: state })
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:workSettings', state)
    },
    // LIFE-635 — 출처 링크의 machine = 이 Mac 의 컴퓨터 이름(모바일 `macName` 과 같은 원천).
    // 처음 정한 값을 userData `work-machine.json` 에 두고 재기동에도 그 값(X1-3 — 조회 일시 실패가 판별 키를 바꾸지 않게).
    machine: persistedMachine({ dir: app.getPath('userData'), read: () => readMacName(), log }),
  })
  // 화면이 원격 링크를 가르려면 이 Mac 의 이름이 필요하다 — 기동 때 미리 읽는다(scutil 하나, 금고·네트워크 무접촉).
  void work.machine()
  workLinks = new WorkLinks({ registry: () => registry, work: () => work, log })
  workStarts = new StartService({
    invoke: () => runtimeInvoke,
    repos: () => currentState().repos,
    links: () => workLinks,
    work: () => work,
    log,
    cwd: os.homedir(),
    pending: new PendingStartStore(app.getPath('userData')),
    // git worktree 는 그 자리에 `.git` 파일을 둔다 — 트리에 아직 안 올라온 경로도 찾는다(R1-B).
    worktreeExists: (target) => fs.existsSync(path.join(target, '.git')),
  })
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
  ipcMain.handle('corral:getWindowChrome', (event) => (fromOurWindow(event) && window !== null ? windowChromeOf(chromeTarget(window)) : null))
  ipcMain.on('corral:syncWindowZoom', (event) => {
    if (fromOurWindow(event) && window !== null) syncWindowZoom(chromeTarget(window))
  })
  // 새로고침 버튼 (LIFE-445 S4) — 캐시가 아니라 git 을 **다시 읽은** 골격을 돌려준다. 이 회차가 더 새 회차에 밀려(tree.stale)
  // 버려져도 currentState 는 그 시점 가장 새 골격이고, 더 새 회차는 끝날 때 따로 민다.
  ipcMain.handle('corral:refreshTree', async (event) => {
    if (!fromOurWindow(event)) return null
    await rebuildTree()
    return currentState()
  })
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
  ipcMain.handle('corral:startBackend', (event) => (fromOurWindow(event) ? startBackendFromUi() : undefined))
  ipcMain.handle('corral:retryBackend', (event) => (fromOurWindow(event) ? backendRetry.retry() : undefined))
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
    // 정렬 모드·수동 순서가 바뀌면 폰 목록 순서도 바뀐다(J4).
    mobile?.listChanged()
  })
  // 사용자 설정 (LIFE-512 K1ⓑ). 첫 값은 **동기**로 준다 — 렌더러가 첫 셀 측정·첫 격자 요청부터 저장값을 써야
  // 시작 시 「기본값 셀로 한 번 → 저장값 셀로 또 한 번」 의 2단 resize 가 생기지 않는다(K2ⓔ). 렌더러는 이것을 부팅 때 한 번만 부른다.
  ipcMain.on('corral:getSettingsSync', (event) => {
    event.returnValue = fromOurWindow(event) ? (settings?.get() ?? { ...DEFAULT_SETTINGS }) : { ...DEFAULT_SETTINGS }
  })
  // 반환형을 명시해 switch 가 빠짐없이 돌려주는지 컴파일러가 본다(상태가 늘면 「끝 return 없음」 오류 — r2 R2-03).
  ipcMain.handle('corral:setSettings', (event, patch: unknown): SettingsWriteResult | null => {
    if (!fromOurWindow(event) || settings === null) return null
    const result = settings.update(patch)
    switch (result.status) {
      case 'saved':
        // 변경 푸시 — 렌더러는 이 값만 진실로 쓴다(검증·저장을 통과한 값). 단일 창이라 브로드캐스트는 그 창 하나다(510 S11).
        log('settings.changed', { keys: Object.keys(typeof patch === 'object' && patch !== null ? patch : {}) })
        window?.webContents.send('corral:settings', result.settings)
        // 모바일 스위치가 바뀐 경우만 넘긴다 — 다른 칸 저장마다 tailscale 을 다시 읽지 않게.
        if (mobile !== null && mobile.status().enabled !== result.settings.mobileEnabled) void mobile.setEnabled(result.settings.mobileEnabled)
        // 사용량 on/off(LIFE-636 E9ⓒ) — 끈 provider 는 즉시 비우고 조회를 멈춘다, 켠 provider 는 즉시 1회.
        usage?.settingsChanged()
        return result
      case 'unchanged':
        return result
      case 'failed':
        // 푸시하지 않는다 — 돌려준 저장값으로 렌더러가 되돌린다(r1 R1-03). 실패 로그는 저장소가 남겼다.
        return result
    }
  })

  // Ghostty 설정 가져오기 미리보기 (LIFE-513 K4ⓐ) — **인자를 받지 않는다**: 렌더러가 읽을 경로를 고를 수 없다(Orca 198 `settings:previewGhosttyImport`).
  // 아무것도 쓰지 않는다. 적용은 렌더러가 위 `corral:setSettings` 로 한 번 쓴다(K5ⓐ).
  ipcMain.handle('corral:previewGhosttyImport', (event) => {
    if (!fromOurWindow(event)) return null
    return previewGhosttyImport({
      env: { home: os.homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME, ghosttyResourcesDir: process.env.GHOSTTY_RESOURCES_DIR },
      current: settings?.get() ?? { ...DEFAULT_SETTINGS },
    })
  })

  // 에이전트 감지 (LIFE-520) — 만들자마자 백그라운드로 돌린다(await 하지 않는다 — 런타임·창 기동과 나란히). 결과는 푸시와 get 으로.
  agentDetector = new AgentDetector(realAgentDetectorDeps({
    env: process.env,
    onChange: (snapshot) => {
      if (window !== null && !window.isDestroyed()) window.webContents.send(AGENT_DETECTION_CHANNEL.push, snapshot)
    },
    log,
  }))
  void agentDetector.ensure()
  registerAgentDetectionIpc({ handle: (channel, listener) => ipcMain.handle(channel, listener), allowed: fromOurWindow, detector: () => agentDetector })

  // 상태바 사용량 (LIFE-636) — 스냅숏은 창별 사용률·초기화 시각·상태 문구뿐이다(토큰·계정 값 없음, E6ⓒ).
  ipcMain.handle('corral:usageGet', (event) => (fromOurWindow(event) ? (usage?.snapshot() ?? EMPTY_USAGE_SNAPSHOT) : null))
  ipcMain.handle('corral:usageRefresh', async (event, input: unknown) => {
    if (!fromOurWindow(event) || usage === null) return null
    const id = typeof input === 'object' && input !== null && 'id' in input && typeof input.id === 'string' ? input.id : null
    return usage.refresh(id)
  })

  // 설정 › Mobile (LIFE-577) — 상태에는 토큰·코드가 없다. 코드는 createMobilePairing 응답에만 실린다(로그에도 안 남긴다).
  ipcMain.handle('corral:getMobileStatus', (event) => (fromOurWindow(event) && mobile !== null ? mobile.status() : null))
  ipcMain.handle('corral:createMobilePairing', (event) =>
    fromOurWindow(event) && mobile !== null ? mobile.createPairing() : { ok: false, error: '허용되지 않은 발신자' },
  )
  ipcMain.handle('corral:revokeMobileDevice', (event, input: unknown) => {
    if (!fromOurWindow(event) || mobile === null) return { ok: false }
    const id = typeof input === 'object' && input !== null && 'id' in input && typeof input.id === 'string' ? input.id : ''
    return { ok: mobile.revoke(id) }
  })
  ipcMain.handle('corral:recheckMobile', async (event) => {
    if (!fromOurWindow(event) || mobile === null) return null
    await mobile.recheckNow()
    return mobile.status()
  })

  // 설정 › 작업 연결 (LIFE-600) — 입력은 unknown 으로 받아 WorkService 가 손검증한다. 응답·push 에 토큰은 없다(끝 4자만).
  const workDeniedError: WorkError = { kind: 'invalid_request', message: '허용되지 않은 발신자', status: null }
  const workDenied: WorkActionResult = { ok: false, error: workDeniedError }
  // 응답은 계측 실행이면 `CORRAL_WORK_IPC_TRACE` 에 그대로 남긴다(C7 평문 부재 대조 — 입력은 토큰이 실리므로 남기지 않는다).
  const workHandle = (channel: string, run: (input: unknown) => unknown): void => {
    ipcMain.handle(channel, async (event, input: unknown) => {
      const value = fromOurWindow(event) && work !== null ? await run(input) : channel === 'corral:workRequest' ? { requestId: '', connectionId: '', ok: false, error: workDeniedError } : workDenied
      traceWork({ channel, value })
      return value
    })
  }
  workHandle('corral:getWorkSettings', () => work?.settings() ?? null)
  workHandle('corral:addWorkConnection', (input) => work?.addConnection(input))
  workHandle('corral:testWorkConnection', (input) => work?.testConnection(input))
  workHandle('corral:removeWorkConnection', (input) => work?.removeConnection(input))
  workHandle('corral:setWorkSpaceHidden', (input) => work?.setSpaceHidden(input))
  workHandle('corral:setRepoDefaultSpace', (input) => work?.setRepoDefault(input))
  workHandle('corral:workRequest', (input) => work?.request(input))
  workHandle('corral:workActivity', (input) => work?.activity(input))
  // LIFE-603 — 작업에서 시작 · 이어 받기 · 작업 떼기. 런타임 호출은 main 에서만(렌더러에 범용 런타임 다리 없음).
  ipcMain.handle('corral:startWork', async (event, input: unknown) => (fromOurWindow(event) && workStarts !== null ? workStarts.start(input) : null))
  ipcMain.handle('corral:relaunchWorkAgent', async (event, input: unknown) => (fromOurWindow(event) && workStarts !== null ? workStarts.relaunch(input) : null))
  ipcMain.handle('corral:startWorkStatus', (event, input: unknown) => (fromOurWindow(event) && workStarts !== null ? workStarts.status(input) : null))
  ipcMain.handle('corral:detachWorkLink', async (event, input: unknown) => {
    if (!fromOurWindow(event) || workLinks === null) return { ok: false, error: '허용되지 않은 발신자' }
    const target = isRecord(input) && typeof input.path === 'string' ? linkOf({ repos: currentState().repos, path: input.path }) : null
    if (target === null) return { ok: false, error: '등록된 워크트리가 아니다' }
    const result = await workLinks.detach({ worktree: target.worktree, repoRoot: target.repoRoot })
    scheduleEmit()
    return result
  })
  // LIFE-624 — PR 상태(gh). 경로는 지금 트리의 worktree 만, URL 은 GitHub PR 꼴만(`pr-status.ts`). 렌더러가 보일 때만 부른다 — 상시 폴링 없음.
  const prStatus = new PrStatus({ repos: () => currentState().repos, work: () => work, log })
  ipcMain.handle('corral:prBranches', async (event, input: unknown) => (fromOurWindow(event) ? prStatus.branches(input) : { lookups: {}, recorded: 0 }))
  ipcMain.handle('corral:prRefreshItem', async (event, input: unknown) => (fromOurWindow(event) ? prStatus.refreshItem(input) : { ok: false, reason: '허용되지 않은 발신자' }))
  ipcMain.handle('corral:prComments', async (event, input: unknown) => (fromOurWindow(event) ? prStatus.comments(input) : { kind: 'rejected', reason: '허용되지 않은 발신자' }))
  // LIFE-808 — 세션 히스토리: 목록·상세·재개·Finder. 렌더러는 식별자만 준다(경로·argv 는 main 이 스캔 결과에서).
  // Codex 도 원래 cwd 가 없으면 대체 cwd 에서 재개한다 — C12 ⓑ 실측(corral-specs LIFE-808 raw/claude/c12f/c12-b2-codex-cwd-removed.txt):
  // `codex resume <id>` 는 원래 폴더 없이도 된다. 단 Codex 가 「Working directory · resume」 를 묻고 기본이 지운 폴더라, 화면이 「현재 폴더」 안내를 보인다.
  const sessionHistory = new SessionHistory({ roots: defaultHistoryRoots, codexResumesWithoutCwd: true })
  // R3-5 — IPC 한 번에 상태 조립(`currentState`)은 한 번: 재개는 문맥·pane 을 같은 읽기에서 뽑는다.
  const historyContext = (state = currentState()) => ({ repos: state.repos.map((repo) => ({ root: repo.root, worktrees: repo.worktrees.map((worktree) => worktree.path) })), home: os.homedir() })
  const historyPanes = (state = currentState()) => state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => worktree.workspace?.tabs ?? []).flatMap((tab) => tab.panes).map((pane) => ({ paneId: pane.paneId, agent: pane.agent, sessionId: pane.agentSession?.kind === 'id' ? pane.agentSession.id : null }))
  observeResumes = (state) => sessionHistory.observeResumes(historyPanes(state))
  const resumeWithState = (input: unknown) => {
    const state = currentState()
    return resumeSession(input, { history: sessionHistory, context: () => historyContext(state), openPanes: () => historyPanes(state), createRow: createRowInWorkspace })
  }
  ipcMain.handle('corral:sessionHistoryList', async (event, input: unknown) => (fromOurWindow(event) ? sessionHistory.list(input, historyContext()) : { kind: 'error', message: '허용되지 않은 발신자' }))
  ipcMain.handle('corral:sessionHistoryDetail', async (event, input: unknown) => (fromOurWindow(event) ? sessionHistory.detail(input, historyContext()) : { kind: 'error', message: '허용되지 않은 발신자' }))
  ipcMain.handle('corral:sessionHistoryResume', async (event, input: unknown) => (fromOurWindow(event) ? resumeWithState(input) : { kind: 'rejected', reason: '허용되지 않은 발신자' }))
  ipcMain.handle('corral:sessionHistoryReveal', async (event, input: unknown) => (fromOurWindow(event) ? revealSession(input, { history: sessionHistory, show: (file) => shell.showItemInFolder(file) }) : { kind: 'rejected', reason: '허용되지 않은 발신자' }))

  // --- 라이프사이클 (R3) ---
  const denied = { ok: false as const, error: '허용되지 않은 발신자' }
  ipcMain.handle('corral:createRow', (event, input: { workspaceId: string; kind: AgentKind; cwd?: unknown; label?: unknown }) =>
    fromOurWindow(event) && typeof input?.workspaceId === 'string'
      ? createRowInWorkspace({
          workspaceId: input.workspaceId,
          kind: input.kind,
          // LIFE-495 K6 다시 열기 — 셸 탭에만 싣는다(에이전트 탭은 기존 경로 그대로).
          ...(input.kind === 'shell' && typeof input.cwd === 'string' && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
          ...(input.kind === 'shell' && typeof input.label === 'string' && input.label.length > 0 ? { label: input.label } : {}),
        })
      : { ...denied, paneId: null, tabId: null, retries: 0 },
  )
  ipcMain.handle('corral:closeTabs', (event, input: { tabIds: unknown; confirmed?: boolean; alwaysConfirm?: boolean; confirmedPaneIds?: unknown }) =>
    fromOurWindow(event) && Array.isArray(input?.tabIds) && input.tabIds.every((tabId) => typeof tabId === 'string')
      ? closeTabsByIds({
          tabIds: input.tabIds.filter((tabId): tabId is string => typeof tabId === 'string'),
          confirmed: input.confirmed === true,
          alwaysConfirm: input.alwaysConfirm === true,
          confirmedPaneIds: Array.isArray(input.confirmedPaneIds) ? input.confirmedPaneIds.filter((paneId): paneId is string => typeof paneId === 'string') : [],
        })
      : ({ outcome: 'error', closed: [], error: '허용되지 않은 발신자' } satisfies CloseTabsResult),
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
  // --- 카드 메뉴 (LIFE-478) — 쓰기·삭제는 런타임 디스패처(CLI 와 같은 명령), 경로는 등록된 것만 ---
  const cardDeps: CardActionDeps = {
    invoke: () => runtimeInvoke,
    // LIFE-603 F3 — 시작이 workspace 줄을 잡고 에이전트를 기다리는 동안 카드 메뉴 쓰기는 줄 서지 않고 바로 이유를 돌려준다.
    startBusy: () => workStarts?.busy() ?? false,
    worktrees: () => currentState().repos.flatMap((repo) => repo.worktrees.map((row) => ({ repoRoot: repo.root, path: row.path, branch: row.branch, isLinked: row.isLinked }))),
    repoRoots: () => registry?.list() ?? [],
    parentPaths: () => new Map(Object.entries(registryMetadata()).map(([target, meta]) => [target, parentPathOf(meta.parentWorktreeId)])),
    observe: () => workspaceDesktop.observe(),
    showItemInFolder: (target) => shell.showItemInFolder(target),
    writeClipboard: (text) => clipboard.writeText(text),
    // 198 기본 편집기 = VS Code(`code`). Finder 로 띄운 앱엔 셸 PATH 가 없어(U5) macOS 는 번들 id 로 연다.
    launchEditor: (target) =>
      new Promise((resolve) => {
        const [command, args] = process.platform === 'darwin' ? ['open', ['-b', 'com.microsoft.VSCode', '--', target]] : ['code', ['--', target]]
        execFile(command, args, { timeout: 10000 }, (error, _stdout, stderr) => resolve(error === null ? null : (String(stderr).trim() || String(error))))
      }),
    cwd: os.homedir(),
  }
  const cardDenied: CardActionError = { ok: false, code: 'denied', error: '허용되지 않은 발신자' }
  ipcMain.handle('corral:setWorktreeMeta', (event, input) => (fromOurWindow(event) ? setWorktreeMeta(cardDeps, input) : cardDenied))
  ipcMain.handle('corral:previewWorktreeDelete', (event, input) => (fromOurWindow(event) ? previewWorktreeDelete(cardDeps, input) : cardDenied))
  ipcMain.handle('corral:deleteWorktree', (event, input) => (fromOurWindow(event) ? deleteWorktree(cardDeps, input) : cardDenied))
  ipcMain.handle('corral:revealInFinder', (event, input) => (fromOurWindow(event) ? revealInFinder(cardDeps, input) : cardDenied))
  ipcMain.handle('corral:openInEditor', (event, input) => (fromOurWindow(event) ? openInEditor(cardDeps, input) : cardDenied))
  ipcMain.handle('corral:copyPath', (event, input) => (fromOurWindow(event) ? copyPath(cardDeps, input) : cardDenied))
  // --- 탐색기 (LIFE-589 F1) — 읽기 전용, 루트는 **지금 열린** worktree 만(`explorer-fs.ts` 가둠). 호출마다 로그 한 줄(E1ⓓ·E2ⓐ 계수) ---
  const explorerRoots = (): string[] => currentState().repos.flatMap((repo) => repo.worktrees.filter((row) => row.openWorkspaceId !== null).map((row) => row.path))
  ipcMain.handle('corral:explorerList', async (event, input: unknown) => {
    const root = typeof input === 'object' && input !== null && 'root' in input ? input.root : undefined
    const rel = typeof input === 'object' && input !== null && 'rel' in input ? input.rel : undefined
    if (!fromOurWindow(event)) return { ok: false, dir: '', code: 'not_worktree', error: '허용되지 않은 발신자' }
    const startedAt = performance.now()
    // 허브를 거쳐 읽는다 — 허브가 준 목록의 도장을 적어 두었다가 감시 시작 때 그 사이 바뀐 폴더만 가린다(상태 모델 fix-r3).
    const result = explorerHub === null ? await listDir({ roots: explorerRoots(), root, rel }) : await explorerHub.list({ roots: explorerRoots(), root, rel })
    log('explorer.list', { rel: typeof rel === 'string' ? rel : null, ok: result.ok, code: result.ok ? null : result.code, count: result.ok ? result.entries.length : 0, ms: Math.round((performance.now() - startedAt) * 10) / 10 })
    return result
  })
  explorerHub = new ExplorerHub({
    // 감시 프로세스 — 같은 번들 폴더의 `explorer-watcher.js`(electron.vite.config 의 main 입력 둘째). asar 안에서도 utilityProcess 가 읽는다.
    fork: () => {
      const child = utilityProcess.fork(path.join(here, 'explorer-watcher.js'), [], { serviceName: 'corral-explorer-watcher', stdio: 'ignore' })
      return {
        get pid() {
          return child.pid
        },
        postMessage: (message) => child.postMessage(message),
        on: (event, listener) => {
          if (event === 'message') child.on('message', listener)
          else child.on('exit', listener)
        },
        kill: () => child.kill(),
      }
    },
    push: (event) => {
      log('explorer.push', { kind: event.kind, root: event.root, dirs: event.kind === 'changed' ? event.dirs.length : null })
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:explorerEvent', event)
    },
    roots: explorerRoots,
    log,
    baseInputs: scmBaseInputs,
  })
  // --- 전체 파일 목록 (LIFE-593 F5) — 읽기 전용, 루트는 탐색기와 같은 「지금 열린 worktree」 만(`file-list.ts` — confine 루트 대조 · 셸 없는 git · 취소) ---
  // git 절대 경로는 부를 때마다 그때 열린 루트로 고른다(PATH 의 절대 항목만, 열린 worktree 아래는 건너뜀 — `resolveGit` · 수정 r1 R1-C-04). 바뀔 때만 적는다.
  let listGit: string | null = null
  fileLister = new FileLister({
    roots: explorerRoots,
    git: (roots) => {
      const picked = resolveGit({ pathEnv: process.env.PATH, roots })
      if (picked !== listGit) {
        listGit = picked
        log('file.list_git', { git: picked })
      }
      return picked
    },
    log,
  })
  ipcMain.handle('corral:fileList', async (event, input: unknown) => {
    if (!fromOurWindow(event) || fileLister === null) return { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }
    return fileLister.list(input)
  })
  ipcMain.on('corral:fileListCancel', (event, requestId: unknown) => {
    if (fromOurWindow(event)) fileLister?.cancel(requestId)
  })
  // --- 내용 전체 검색 (LIFE-803) — 읽기 전용 `git grep`, 루트·git 고르기는 전체 파일 목록과 같다(`content-search.ts` — confine · 셸 없는 git · 상한 · 취소) ---
  contentSearcher = new ContentSearcher({
    roots: explorerRoots,
    git: (roots) => resolveGit({ pathEnv: process.env.PATH, roots }),
    log,
  })
  ipcMain.handle('corral:contentSearch', async (event, input: unknown) => {
    if (!fromOurWindow(event) || contentSearcher === null) return { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }
    return contentSearcher.search(input)
  })
  ipcMain.on('corral:contentSearchCancel', (event, requestId: unknown) => {
    if (fromOurWindow(event)) contentSearcher?.cancel(requestId)
  })
  // --- 파일 탭 (LIFE-590 F2) — 내용 읽기 전용. 루트는 탐색기와 같은 「지금 열린 worktree」 만, 가둠은 F1 `confine`(읽기). 쓰기 핸들러는 없다(F3) ---
  ipcMain.handle('corral:fileRead', async (event, input: unknown) => {
    if (!fromOurWindow(event)) return { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }
    const root = typeof input === 'object' && input !== null && 'root' in input ? input.root : undefined
    const rel = typeof input === 'object' && input !== null && 'rel' in input ? input.rel : undefined
    const startedAt = performance.now()
    const result = await readFileContent({ roots: explorerRoots(), root, rel })
    // 읽은 바이트를 남긴다(E4ⓕ 「상한 넘게 읽지 않음」 계측) — 경로는 남기지 않는다(상대 경로 길이만).
    log('file.read', { ok: result.ok, kind: result.ok ? result.kind : null, code: result.ok ? null : result.code, size: result.ok ? result.size : null, bytesRead: result.ok ? result.bytesRead : null, ms: Math.round((performance.now() - startedAt) * 10) / 10 })
    return result
  })
  // LIFE-683 S7 — 소스 제어 diff 의 HEAD·인덱스 내용. 가둠·argv 고정·상한·바이너리는 `readScmContent`. 경로는 남기지 않는다(쓰기 0 계측은 `scm.read` 수).
  // LIFE-830 — side `base` 는 main 이 그 루트의 base·merge-base 를 레지스트리 재료로 푼다(렌더러는 ref 를 보내지 않는다).
  ipcMain.handle('corral:scmRead', async (event, input: unknown) => {
    if (!fromOurWindow(event)) return { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }
    const field = (name: string): unknown => (typeof input === 'object' && input !== null && name in input ? Reflect.get(input, name) : undefined)
    const startedAt = performance.now()
    const result = await readScmContent({
      roots: explorerRoots(),
      root: field('root'),
      rel: field('rel'),
      side: field('side'),
      resolveBase: ({ root, realRoot }) => resolveScmBase({ run: gitRunner(realRoot), ...scmBaseInputs(root) }),
    })
    const side = field('side')
    log('scm.read', { ok: result.ok, side: side === 'head' || side === 'base' ? side : 'index', kind: result.ok ? result.kind : null, code: result.ok ? null : result.code, size: result.ok && 'size' in result ? result.size : null, ms: Math.round((performance.now() - startedAt) * 10) / 10 })
    return result
  })
  // LIFE-829 — 소스 제어 로컬 쓰기(stage·unstage·discard·커밋·amend). 가둠·고정 argv·lock 재시도·루트 직렬·로그인 셸 PATH(쓰기 git 전부 — 시작 뒤 미리 조회)·휴지통은 `ScmWriter`.
  // 확인 대화상자 문구는 main(`scmConfirmSpec`), 답은 파일 탭 대화상자와 같은 계측 스텁 큐를 쓴다. 로그는 동작·결과·루트 해시만(경로·메시지 없음).
  const scmWriter = new ScmWriter({
    roots: explorerRoots,
    git: (roots) => resolveGit({ pathEnv: process.env.PATH, roots }),
    confirm: async (spec) => {
      const stubbed = measuring ? fileDialogAnswers.shift() : undefined
      if (stubbed !== undefined) {
        fileDialogAsked.push(`scm:${spec.kind}`)
        return spec.choices.find((item) => item === stubbed) ?? 'cancel'
      }
      if (window === null || window.isDestroyed()) return 'cancel'
      return spec.choices[(await dialog.showMessageBox(window, spec.options)).response] ?? 'cancel'
    },
    trashItem: (abs) => shell.trashItem(abs),
    loginPath: () => loginShellPath(),
    refresh: (root) => explorerHub?.refreshGit(root),
    statusChanged: (root) => void refreshWorktreeStatus({ path: root, reason: 'commit' }),
    log,
  })
  // LIFE-831 — 소스 제어 원격(가져오기·끌어오기·밀어넣기·브랜치 게시). 같은 루트 직렬 큐(`scmWriter.enqueue`)·로그인 셸 PATH·새 세션·그룹 종료·상한은 `ScmRemote`.
  // 게시 원격 고르기는 main 대화상자(목록 = `git remote`) — 계측 중에는 파일 탭 대화상자 스텁 큐의 값이 원격 이름이면 그것을 고른다.
  const scmRemote = new ScmRemote({
    writer: scmWriter,
    roots: explorerRoots,
    git: (roots) => resolveGit({ pathEnv: process.env.PATH, roots }),
    pickRemote: async ({ remotes, branch }) => {
      const stubbed = measuring ? fileDialogAnswers.shift() : undefined
      if (stubbed !== undefined) {
        fileDialogAsked.push('scm:pickRemote')
        return remotes.find((remote) => remote === stubbed) ?? null
      }
      if (window === null || window.isDestroyed()) return null
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        message: `'${branch}' 브랜치를 게시할 원격을 고르세요.`,
        buttons: [...remotes, '취소'],
        defaultId: 0,
        cancelId: remotes.length,
      })
      return remotes[response] ?? null
    },
    refresh: (root) => explorerHub?.refreshGit(root),
    statusChanged: (root) => void refreshWorktreeStatus({ path: root, reason: 'remote' }),
    // 수정 r1 C6 — 진행 시작·끝을 렌더러에 민다(렌더러가 다시 그려져도 진행 표시·취소를 되살린다).
    onState: (state) => {
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:scmRemoteEvent', state)
    },
    log,
  })
  scmRemoteForQuit = scmRemote
  ipcMain.handle('corral:scmRemoteState', async (event, input: unknown) => (fromOurWindow(event) ? scmRemote.state(input) : { action: null }))
  ipcMain.handle('corral:scmRemote', async (event, input: unknown) => (fromOurWindow(event) ? scmRemote.run(input) : { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }))
  ipcMain.handle('corral:scmRemoteCancel', async (event, input: unknown) => (fromOurWindow(event) ? scmRemote.cancel(input) : { ok: false }))
  ipcMain.handle('corral:scmWrite', async (event, input: unknown) => (fromOurWindow(event) ? scmWriter.write(input) : { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }))
  // 첫 쓰기가 로그인 셸 조회(최대 5 초)를 기다리지 않게 지금 백그라운드로 푼다 — 실패는 두지 않고 다음 쓰기에 다시 묻는다.
  void scmWriter.prefetchLoginPath()
  // 이미지 바이트(E4ⓔ) — 확장자 목록·가둠·상한은 `readImageContent`. 경로는 남기지 않는다.
  ipcMain.handle('corral:fileReadImage', async (event, input: unknown) => {
    if (!fromOurWindow(event)) return { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }
    const root = typeof input === 'object' && input !== null && 'root' in input ? input.root : undefined
    const rel = typeof input === 'object' && input !== null && 'rel' in input ? input.rel : undefined
    const startedAt = performance.now()
    const result = await readImageContent({ roots: explorerRoots(), root, rel })
    log('file.read_image', { ok: result.ok, kind: result.ok ? result.kind : null, code: result.ok ? null : result.code, size: result.ok ? result.size : null, bytesRead: result.ok ? result.bytesRead : null, ms: Math.round((performance.now() - startedAt) * 10) / 10 })
    return result
  })
  // --- 파일 탭 편집 (LIFE-591 F3) — 쓰기는 `file-write.ts`(fd 기반 쓰기 경계 — 등록 루트·이미 있는 일반 파일·`O_NOFOLLOW_ANY`). 내용 상한도 거기서 다시 잰다 ---
  // 시험 전용 주입은 패키지 앱이면 늘 꺼진다(`loadTestHooks`) — 개발 실행에서도 `CORRAL_TEST_WRITE_HOOK_FILE` 이 있을 때만.
  ipcMain.handle('corral:fileWrite', async (event, input: unknown) => {
    if (!fromOurWindow(event)) return { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }
    const field = (name: string): unknown => (typeof input === 'object' && input !== null && name in input ? Reflect.get(input, name) : undefined)
    const startedAt = performance.now()
    const hooks = await loadTestHooks({ packaged: app.isPackaged, file: process.env.CORRAL_TEST_WRITE_HOOK_FILE })
    const result = await writeFileContent({
      roots: explorerRoots(),
      root: field('root'),
      rel: field('rel'),
      text: field('text'),
      bom: field('bom'),
      baseStamp: field('baseStamp'),
      baseHash: field('baseHash'),
      overwrite: field('overwrite'),
      create: field('create'),
      hooks,
    })
    // 경로·내용은 남기지 않는다 — 결과 코드·크기·걸린 시간만(읽기 로그와 같은 결).
    log('file.write', { ok: result.ok, code: result.ok ? null : result.code, size: result.ok ? result.size : null, ms: Math.round((performance.now() - startedAt) * 10) / 10, hooks: Object.keys(hooks).length > 0 })
    return result
  })
  // 확인 대화상자(E3ⓑ·E4ⓒⓓ·E3ⓓ) — 문구·단추는 main(`file-dialogs.ts`), 렌더러는 갈래와 파일 이름만 준다. 고른 답을 돌려준다(모르는 요청 = 취소).
  ipcMain.handle('corral:fileDialog', async (event, input: unknown) => {
    if (!fromOurWindow(event) || window === null || window.isDestroyed()) return 'cancel'
    const request = parseFileDialogRequest(input)
    if (request === null) return 'cancel'
    const spec = fileDialogSpec(request)
    // 계측 스텁 — 답이 이 갈래에 있는 것이면 쓴다(없는 답이면 취소로 — 스텁이 다른 갈래를 조용히 고르지 않게).
    const stubbed = measuring ? fileDialogAnswers.shift() : undefined
    if (stubbed !== undefined) fileDialogAsked.push(request.kind)
    const choice = stubbed !== undefined ? (spec.choices.find((item) => item === stubbed) ?? 'cancel') : (spec.choices[(await dialog.showMessageBox(window, spec.options)).response] ?? 'cancel')
    log('file.dialog', { kind: request.kind, choice, stubbed: stubbed !== undefined, files: request.kind === 'close' || request.kind === 'discard' ? request.files.length : 1, ...(request.kind === 'trash' ? { isDir: request.isDir, undoable: request.undoable, dirty: request.dirty.length } : {}) })
    return choice
  })
  // 수정 파일 목록(E3ⓒ) — 바뀔 때마다 렌더러가 민다. 종료 확인 관문이 이것으로 동기 판정한다.
  ipcMain.on('corral:dirtyFiles', (event, input: unknown) => {
    if (!fromOurWindow(event)) return
    const files = parseDirtyFiles(input)
    if (files !== null) quitGate.setDirty(files)
  })
  // 렌더러가 종료 확인을 마쳤다(저장했거나 저장 안 함) — 이제 막지 않고 다시 종료한다. 취소면 이 요청이 오지 않는다(앱·런타임 그대로).
  // 렌더러가 종료 확인 요청을 받았다(R1-I 무응답 시계를 멈춘다).
  // 응답의 세대가 지금 요청의 것이 아니면(무응답 취소로 무효) 버리고 남긴다(수정 r5 R5-B).
  const replyGen = (input: unknown): number => (typeof input === 'number' && Number.isInteger(input) ? input : -1)
  ipcMain.on('corral:quitAck', (event, gen: unknown) => {
    if (!fromOurWindow(event)) return
    if (!quitGate.ack(replyGen(gen))) log('quit.stale_reply', { kind: 'ack', gen: replyGen(gen) })
  })
  // 렌더러의 종료 확인이 취소로 끝났다 — 보통은 할 일이 없다(정리 전이라 앱·런타임 그대로). 방어선(R4-A ⓒ): 정리를 이미 시작했으면 창을 다시 보이고,
  // 런타임을 닫았는지 돌려준다 — 렌더러가 편집 동결을 풀고 사용자에게 안내한다.
  ipcMain.handle('corral:quitCancelled', (event, gen: unknown) => {
    if (!fromOurWindow(event)) return { runtimeClosed: false }
    if (!quitGate.isCurrent(replyGen(gen))) {
      log('quit.stale_reply', { kind: 'cancelled', gen: replyGen(gen) })
      return { runtimeClosed: false }
    }
    reshowForConfirm('cancelled')
    const runtimeClosed = runtimeStopping !== null
    log('quit.cancelled', { runtimeClosed, runtimeStopped })
    return { runtimeClosed }
  })
  // 승인 — 무효가 된 세대면 받지 않고 false(렌더러가 편집 동결을 푼다, R5-B).
  ipcMain.handle('corral:confirmQuit', (event, gen: unknown) => {
    if (!fromOurWindow(event)) return false
    if (!quitGate.isCurrent(replyGen(gen))) {
      log('quit.stale_reply', { kind: 'confirm', gen: replyGen(gen) })
      return false
    }
    log('quit.confirmed', { files: quitGate.dirty().length })
    quitGate.allow()
    app.quit()
    return true
  })
  // 열린 파일 탭 감시(E5) — 렌더러가 활성 worktree 의 열린 파일 탭 집합을 통째로 준다. 패널 열림과 무관하다(탐색기 감시와 별개).
  fileWatch = createFileWatch({
    roots: explorerRoots,
    push: (push) => {
      log('file.changed', { exists: push.exists })
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:fileEvent', push)
    },
    log,
    // 확인·push 기록은 계측 실행(제어 소켓 opt-in)에서만 쌓는다(수정 r3 R3-B).
    trace: measuring,
  })
  ipcMain.handle('corral:fileWatch', async (event, input: unknown) => {
    if (!fromOurWindow(event) || fileWatch === null) return { ok: false, count: 0 }
    const root = typeof input === 'object' && input !== null && 'root' in input ? input.root : undefined
    const rels = typeof input === 'object' && input !== null && 'rels' in input ? input.rels : undefined
    return fileWatch.set({ root, rels })
  })
  ipcMain.handle('corral:explorerWatch', async (event, input: unknown) => {
    if (!fromOurWindow(event) || explorerHub === null) return { ok: false, code: 'not_worktree' }
    const root = typeof input === 'object' && input !== null && 'root' in input ? input.root : undefined
    const on = typeof input === 'object' && input !== null && 'on' in input && input.on === true
    if (!on) {
      explorerHub.unsubscribe(root)
      return { ok: true }
    }
    return explorerHub.subscribe(root)
  })
  ipcMain.on('corral:explorerRefreshGit', (event, root: unknown) => {
    if (fromOurWindow(event)) explorerHub?.refreshGit(root)
  })
  // LIFE-830 — 소스 제어 base 대비 켜기·끄기(루트별). 값은 루트와 켜짐 여부뿐 — base 는 main 이 푼다.
  ipcMain.on('corral:scmBaseMode', (event, input: unknown) => {
    if (!fromOurWindow(event)) return
    const root = typeof input === 'object' && input !== null && 'root' in input ? input.root : undefined
    const on = typeof input === 'object' && input !== null && 'on' in input && input.on === true
    explorerHub?.setBaseMode({ root, on })
  })
  ipcMain.handle('corral:explorerAction', (event, input: unknown) =>
    fromOurWindow(event)
      ? explorerAction(
          {
            roots: explorerRoots,
            writeClipboard: (text) => clipboard.writeText(text),
            showItemInFolder: (target) => shell.showItemInFolder(target),
            openShell: async ({ root, cwd }) => {
              const workspaceId = currentState().repos.flatMap((repo) => repo.worktrees).find((row) => row.path === root)?.openWorkspaceId ?? null
              if (workspaceId === null) return '열린 workspace 가 없다'
              const created = await createRowInWorkspace({ workspaceId, kind: 'shell', cwd })
              log('explorer.open_terminal', { root, cwd, ok: created.ok, paneId: created.paneId })
              return created.ok ? null : (created.error ?? '탭을 못 만들었다')
            },
          },
          input,
        )
      : { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' },
  )
  // --- 탐색기 파일 조작 (LIFE-592 F4) — 쓰기 경계는 `explorer-ops.ts`(원본·대상 가둠 · fd/경로 연산 구분 · 덮어쓰기 0 · 휴지통만). 호출마다 로그 한 줄(경로 없음) ---
  // 시험 전용 경쟁 주입은 패키지 앱이면 늘 꺼진다(`loadOpHooks`) — 개발 실행에서도 `CORRAL_TEST_OP_HOOK_FILE` 이 있을 때만.
  const explorerSnapshots = new SnapshotStore()
  ipcMain.handle('corral:explorerOp', async (event, input: unknown) => {
    if (!fromOurWindow(event)) return { ok: false, code: 'not_worktree', error: '허용되지 않은 발신자' }
    const startedAt = performance.now()
    const hooks = await loadOpHooks({ packaged: app.isPackaged, file: process.env.CORRAL_TEST_OP_HOOK_FILE })
    const op = typeof input === 'object' && input !== null && 'op' in input && typeof input.op === 'string' ? input.op : null
    const result = await runExplorerOp({ roots: explorerRoots, trashItem: (abs) => shell.trashItem(abs), snapshots: explorerSnapshots, drops: explorerDrops, hooks }, input)
    log('explorer.op', { op, ok: result.ok, code: result.ok ? null : result.code, done: !result.ok && result.done === true, ms: Math.round((performance.now() - startedAt) * 10) / 10, hooks: Object.keys(hooks).length > 0, snapshots: explorerSnapshots.size })
    return result
  })
  // OS 드롭 원본(E7ⓓ) — **preload 만** 부른다(렌더러 `CorralApi` 에 없다). 실제 드롭 이벤트의 `webUtils.getPathForFile` 경로를 맡기고 표지를 돌려준다.
  ipcMain.handle('corral:explorerDropPaths', (event, input: unknown) => {
    if (!fromOurWindow(event)) return { ok: false, error: '허용되지 않은 발신자' }
    const paths = Array.isArray(input) && input.length > 0 && input.length <= FILE_DROP_MAX_PATHS && input.every((item) => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0')) ? input.filter((item) => typeof item === 'string') : null
    if (paths === null) return { ok: false, error: '드롭 경로 형 위반' }
    log('explorer.drop', { count: paths.length })
    return { ok: true, token: explorerDrops.register(paths), names: paths.map((item) => path.basename(item)) }
  })
  ipcMain.on('corral:explorerFocus', (event, focused: unknown) => {
    if (fromOurWindow(event)) explorerFocused = focused === true
  })
  // Orca #14545 를 따라 하지 않기 — macOS 는 배경 앱 우클릭에 앱을 활성화하지 않아 메뉴가 키보드·포커스를 못 받는다.
  // 우클릭 순간 창을 앞으로 가져온다(198 뒤 수정 PR #14546 과 같은 방향).
  ipcMain.on('corral:activateWindow', (event) => {
    if (!fromOurWindow(event) || window === null || window.isDestroyed()) return
    if (window.isFocused()) return
    app.focus({ steal: true })
    window.focus()
  })

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
  /**
   * ⌘V 이미지 붙여넣기 (LIFE-497 · D41) — 렌더러가 **클립보드에 텍스트가 없을 때만** 부른다.
   * PNG 를 임시 폴더에 쓰고 경로만 돌려준다. PTY 로 쓰는 것은 렌더러가 ⌘V 를 받은 pane 에 termInput 으로 한다 —
   * 입력이 들어가는 길을 하나(termInput)로 둔다. 실패·빈 클립보드는 여기 로그에 남는다 (K1ⓓ).
   */
  ipcMain.handle('corral:saveClipboardImage', async (event) => {
    if (!fromOurWindow(event)) return { status: 'failed', error: '허용되지 않은 창' }
    // 타입 목록(내용 아님)을 같이 남긴다 — "왜 빈 결과인가" 가 로그에서 갈리게.
    let types: string[][] | null = null
    const result = await saveClipboardImage({
      readPng: electronClipboardPng({
        read: async () => {
          const items = await clipboard.read()
          types = items.map((item) => [...item.types])
          return items
        },
        toPng: (bytes) => nativeImage.createFromBuffer(bytes).toPNG(),
      }),
      dir: pasteDir(),
    })
    log('paste.clipboard_image', { ...result, types })
    return result
  })
  // LIFE-812 — 터미널 화면 내 검색. 검색·이동은 어댑터가 herdr 서버에 묻는다(렌더러 xterm 은 뷰포트뿐이다).
  ipcMain.handle('corral:termSearch', async (event, input: unknown): Promise<TerminalSearchResult> => {
    if (!fromOurWindow(event)) return { kind: 'error', message: '허용되지 않은 창' }
    const request = parseSearchRequest(input)
    if (request === null) return { kind: 'error', message: '잘못된 검색 요청' }
    return stream.search(request)
  })
  ipcMain.handle('corral:termReveal', async (event, input: unknown): Promise<TerminalRevealResult> => {
    const request = fromOurWindow(event) ? parseRevealRequest(input) : null
    if (request === null) return { scrolled: false, top: null }
    return stream.reveal(request)
  })
  ipcMain.on('corral:termSearchCancel', (event, input: unknown) => {
    const target = fromOurWindow(event) ? parsePaneTarget(input) : null
    if (target !== null) stream.cancelSearch(target.paneId)
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
  // LIFE-696 — 「닫힌 탭」 행 하나를 걷는다. 확인 대화 없음(Orca 198). 모르는 id·잘못된 인자는 무동작 false.
  ipcMain.handle('corral:dismissRetained', (event, input: { paneId?: unknown }): boolean => {
    if (!fromOurWindow(event) || typeof input?.paneId !== 'string') return false
    const dropped = link.store.dropRetained([input.paneId])
    if (dropped.length === 0) return false
    log('retained.dismissed', { paneId: input.paneId })
    scheduleEmit()
    return true
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
    // 설치본 — CLI 의 terminal·orchestration 이 GUI 가 지금 붙은 동봉 서버를 쓴다(LIFE-556). 명시 바인딩이 있으면 런타임이 무시한다.
    bundledBackend: bundledHerdr === null ? undefined : () => {
      // default 고정(fix2 M2) — 세션 목록이 이미 default 뿐이지만, 공급자도 다른 이름을 내보내지 않는다.
      const socket = currentSocketPath()
      return socket === null || selectedSession !== DEFAULT_SESSION ? null : { socket, session: DEFAULT_SESSION }
    },
  })
  // 종료 체인 하나 — 런타임 정리와 모바일 정리(serve 항목 제거, 마감 있음)를 같이 기다린다. 한쪽이 실패해도 다른 쪽을 끝까지 기다린다.
  const mobileService = mobile
  stopRuntime = () => Promise.allSettled([mobileService.shutdown(MOBILE_SHUTDOWN_DEADLINE_MS), runtime.close()]).then(() => undefined)
  runtimeInvoke = runtime.invoke
  createWindow()
  // LIFE-637 상태바 Resource Manager — pane 별 CPU·메모리 수집과 `corral:resource*` IPC.
  registerResourceIpc({
    window: () => window,
    fromOurWindow,
    state: currentState,
    socketPath: currentSocketPath,
    paneIds: () => link.store.paneIds(),
    shellPidOf: async ({ socketPath, paneId }) => shellProbeOf(await probeForeground(socketPath, paneId)),
    probeRunning: probeRunningPanes,
    closePane: ({ socketPath, paneId }) =>
      withRetentionSuppressed({ store: link.store, ids: [paneId], what: 'pane', run: hooks => closePane({ socketPath, paneId, onSent: hooks.onSent }) }),
    cardlessWorkspaces: cardlessNow,
    claimedWorkspaceIds: claimedWorkspaceIdsNow,
    cardlessBlockedReason: () => rebuildRetry.permanentReason(),
    checkSlot: slotStateOf,
    // LIFE-628 — 카드 밖 workspace 닫기. 카드 메뉴 닫기(`closeWorktreeByWorkspace`)와 같은 `workspace.close` 길·완료 행 억제.
    closeWorkspace: async ({ socketPath, workspaceId }) => {
      const outcome = await withRetentionSuppressed({ store: link.store, ids: [workspaceId], what: 'workspace', run: hooks => closeWorkspace(socketPath, workspaceId, hooks) })
      if (outcome.outcome === 'closed') {
        scheduleTree()
        scheduleEmit()
      }
      return outcome
    },
    confirmRunning: () => settings === null || !settings.get().skipCloseTerminalWithRunningProcessConfirm,
    appPids: () => app.getAppMetrics().map(metric => metric.pid),
    footprintHelper: footprintHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDir: here }),
    log,
  })
  // 사용량 (LIFE-636) — 배경 틱은 창이 보이고 포커스일 때만. User-Agent 는 corral 자기 이름(D10).
  const settingsStore = settings
  usage = new UsageService({
    collectors: USAGE_COLLECTORS,
    isEnabled: (id) => usageEnabled({ settings: settingsStore.get(), id }),
    isActive: () => window !== null && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused(),
    deps: (signal) => realCollectorDeps({ signal, userAgent: `corral/${app.getVersion()}` }),
    onChange: (snapshot) => {
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:usage', snapshot)
    },
    log,
  })
  usage.start()
  // 저장된 스위치 값으로 — 꺼져 있으면 아무것도 열지 않는다(A1). 켜 둔 상태면 서버를 열고 serve 항목을 다시 올린다(A8ⓐ).
  void mobileService.start(settings.get().mobileEnabled)
  // 「Install CLI」 (LIFE-556 B14) — 설치본만. 개발 실행에는 번들 shim 이 없다.
  if (app.isPackaged) addInstallCliMenu({ shim: path.join(process.resourcesPath, 'bin', 'corral'), target: cliTarget(os.homedir()), window: () => window })
  void pollSessions()
  setInterval(() => void pollSessions(), SESSION_POLL_MS)
  // LIFE-366 — 세션 지문·통합 상태. 지문은 짧은 주기(캐시가 막는다), 통합은 세션 폴링에 얹는다.
  digestTimer = setInterval(() => refreshDigests(), DIGEST_POLL_MS)
  setInterval(() => void refreshIntegrations(), SESSION_POLL_MS * 4)
  setInterval(() => void lineage.refresh(), LINEAGE_POLL_MS)
  // 붙여넣기 PNG 정리 (D44) — 기동 뒤 한 번, 그 뒤 1시간마다. 나이(7일)로만 지운다 — 사유는 sweepPasteFiles 주석.
  const sweep = (): void =>
    void sweepPasteFiles({ dir: pasteDir(), now: Date.now(), maxAgeMs: PASTE_FILE_MAX_AGE_MS }).then((result) => {
      if (result.skipped !== null) log('paste.sweep_skipped', { reason: result.skipped })
      if (result.removed.length > 0) log('paste.sweep', { removed: result.removed.length, kept: result.kept })
    })
  setTimeout(sweep, 30_000)
  setInterval(sweep, 60 * 60 * 1000)
  scheduleTree()
  // `CORRAL_WORKTREE_POLL_MS` — 계측이 자동 경로를 끌 때(0) 쓴다.
  worktreePoller.start(parsePollMs(process.env.CORRAL_WORKTREE_POLL_MS))

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
    mobile: {
      status: () => mobileService.status(),
      createPairing: () => mobileService.createPairing(),
      revoke: (id) => mobileService.revoke(id),
    },
    // LIFE-589 E4ⓓⓕⓖ — 감시 프로세스 pid·구독·계수(읽기) · 장애 주입(감시 프로세스만 끝낸다).
    explorer: {
      status: () => explorerHub?.status() ?? null,
      crash: () => explorerHub?.injectCrash() ?? false,
    },
    fileWatch: {
      status: () => (fileWatch === null ? null : { ...fileWatch.stats(), recent: fileWatch.recentChecks(), pushes: fileWatch.recentPushes() }),
      drop: () => fileWatch?.dropWatchers(),
    },
    quitEntry: (via) => {
      if (via === 'quit') app.quit()
      else window?.close()
    },
    setFileDialogStub: (answers) => {
      fileDialogAnswers = answers
      log('file.dialog_stub', { answers })
      return { asked: [...fileDialogAsked] }
    },
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(error => { log('runtime.start_failed', { error: String(error) }); app.exit(1) })

app.on('before-quit', event => {
  // LIFE-591 E3ⓒ — 수정된 파일 탭이 있으면 런타임 정리보다 **먼저** 막는다(취소하면 런타임·터미널이 그대로여야 한다). 확인은 렌더러가 하고 `corral:confirmQuit` 로 다시 온다.
  if (quitGate.intercept('before-quit')) {
    event.preventDefault()
    reshowForConfirm('before-quit')
    return
  }
  // LIFE-593 수정 r2 R2-C-01 — 가로챔을 지난 종료(⌘Q·창 닫힘)에서는 `window-all-closed` 가 오지 않는다. 진행 중 목록 git 그룹을 여기서 동기로 끝낸다(타이머 없이 SIGKILL).
  fileLister?.killAll()
  contentSearcher?.killAll()
  // LIFE-520 fix1 R1-06 — 진행 중 감지 셸(새 프로세스 그룹)을 끝낸다. 앱 타이머가 멈추면 시한 kill 이 오지 않는다.
  agentDetector?.killAll()
  // 런타임 정리(Mobile serve 제거 + 런타임 닫기)는 **한 번만** 돌리고, 정리 중 다시 온 종료 요청(창 파기 → `window-all-closed` 의 `app.quit()` 등)도
  // 같은 정리 Promise 를 기다리게 한다(수정 r2 R2-C — 옛 코드는 첫 요청에서 `stopRuntime` 을 비워, 재진입 종료가 정리를 기다리지 않고 끝났다).
  if (runtimeStopped) return
  event.preventDefault()
  if (runtimeStopping === null) {
    // 정리(Mobile serve 제거는 최대 수 초)를 기다리는 동안 창이 남아 있으면 그 사이 친 글자가 저장도 확인도 없이 사라진다 — 정리를 시작하는 순간 창을 숨긴다
    // (수정 r3 R3-C. 수정 파일이 있던 종료는 렌더러가 승인 순간 편집기를 읽기 전용으로 이미 묶었다 — 이 숨김은 수정 파일 없이 바로 종료하는 경로까지 덮는다).
    if (window !== null && !window.isDestroyed()) window.hide()
    const close = stopRuntime
    stopRuntime = null
    // LIFE-831 수정 r1 C3 — 진행 중 원격 git(새 세션이라 앱과 같이 죽지 않는다)도 같은 정리에서 끝낸다(상한 `SCM_REMOTE_SHUTDOWN_MS` — 무기한 기다리지 않는다).
    runtimeStopping = Promise.allSettled([close === null ? Promise.resolve() : close(), scmRemoteForQuit?.shutdown() ?? Promise.resolve()]).then(() => undefined).finally(() => {
      runtimeStopped = true
    })
  }
  void runtimeStopping.finally(() => app.quit())
})

app.on('window-all-closed', () => {
  agentDetector?.killAll()
  usage?.dispose()
  usage = null
  explorerHub?.dispose()
  fileLister?.killAll()
  contentSearcher?.killAll()
  fileWatch?.dispose()
  if (digestTimer !== null) clearInterval(digestTimer)
  digestTimer = null
  worktreePoller.stop()
  stream.closeAll()
  link.close()
  log('app.quit', { logFile: logFile() })
  closeLog()
  app.quit()
})
