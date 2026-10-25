// Resource Manager 배선 (LIFE-637) — 수집기를 창·herdr·store 에 잇고 `corral:resource*` IPC 를 단다.
//
// 행 동작(R5, 게이트 ⓪ Q3):
//   · 이동 = 기존 `corral:revealPane` 푸시(CLI `worktree activate` 와 같은 길) — 렌더러가 worktree·탭 전환까지 한다.
//   · 닫기(split 탭의 pane) = 기존 실행 중 확인 게이트 `closeTabsGated` 를 pane 하나 단위로 지난다(설정 `skipCloseTerminalWithRunningProcessConfirm` 존중).
//     닫는 동작은 기존 `pane.close` 경로(`closePane`) 그대로 — 새 프로세스 kill 경로는 없다.
//     탭의 마지막 pane 은 렌더러가 기존 탭 닫기 IPC(`corral:closeTabs`)로 보낸다(핀·수정 문서 확인, F7) — 여기를 지나지 않는다.
//     렌더러가 길을 정한 뒤(확인 창 체류 중 등) 옆 pane 이 사라져 대상이 그 탭의 마지막 pane 이 됐으면 닫지 않고 `route-changed`(J2).
//   · 카드 밖 workspace 닫기(LIFE-628) = 같은 게이트 `closeTabsGated` 를 workspace 단위로 지난다(한 줄·「모두 닫기」 같은 길).
//     닫는 동작은 기존 `workspace.close` 경로(`closeWorkspace` — 카드 메뉴 닫기와 같다) 그대로 — 새 kill 경로는 없다.
//     닫기 직전에 그 workspace 가 지금도 카드 밖인지 다시 본다 — 그 사이 카드에 붙은 workspace 는 닫지 않고 건너뛴다.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, ipcMain } from 'electron'
import type { ClosePrepareOutcome, CloseTabOutcome, ForegroundRead } from './close-tabs.js'
import { closeTabsGated } from './close-tabs.js'
import { parseCompressedBytes, parseFootprintTable, parsePressureLevel, parseSwapUsage, psInvocation, type FootprintTable } from './resource-collector.js'
import { createResourceMonitor, RESOURCE_INTERVAL_MS, type ResourceOrphanSource, type ResourcePaneSource, type ShellProbe } from './resource-monitor.js'
import type { ResourceCloseResult, ResourceCloseRoute, ResourceHost, ResourceOrphanCloseResult, ResourceOrphanSkip, ResourceSnapshot } from '../shared/resource.js'
import type { AppState, CloseTabsResult, RunningPane, WorkspaceRow } from '../shared/types.js'
import { normalizeDecorativeTitle } from '../shared/decorative-title.js'
import { paneSessionTitle } from '../shared/session-title.js'
import { distinctWorktreeName } from '../shared/worktree-name.js'
import { deadSlotRoot } from '../shared/worktree-slot.js'
import { slotStateOf, type SlotState } from './retention.js'

type PaneCloseOutcome = { outcome: 'ok' } | { outcome: 'rejected'; rejection: { code: string; message: string } }

/** 이 배선이 창에서 쓰는 것만 — 시험이 가짜 창을 넣을 수 있게. */
export type ResourceWindow = {
  isDestroyed: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  on(event: 'show', listener: () => void): unknown
  on(event: 'restore', listener: () => void): unknown
  webContents: { send: (channel: string, ...args: unknown[]) => void }
}

export type ResourceIpcDeps = {
  window: () => ResourceWindow | null
  fromOurWindow: (event: Electron.IpcMainInvokeEvent) => boolean
  state: () => Pick<AppState, 'repos' | 'home'>
  socketPath: () => string | null
  paneIds: () => string[]
  /** herdr 가 준 그 pane 의 셸 pid(어댑터 `probeForeground`). */
  shellPidOf: (input: { socketPath: string; paneId: string }) => Promise<ShellProbe>
  /** 기존 게이트의 pane 판정(`probeRunningPanes`). */
  probeRunning: (input: { socketPath: string; panes: readonly { tabId: string; paneId: string }[]; subject: Record<string, unknown> }) => Promise<RunningPane[]>
  /** 기존 pane 닫기(완료 행 되살림 억제 포함). */
  closePane: (input: { socketPath: string; paneId: string }) => Promise<PaneCloseOutcome>
  /** 카드 밖 workspace(LIFE-628, `tree.ts cardlessWorkspaces`). null = 지금은 가릴 수 없다(링크·골격 미준비). */
  cardlessWorkspaces: () => WorkspaceRow[] | null
  /** 자리 뿌리를 **그 자리에서** 확인한다(LIFE-697 · r2 G1 · r3 H2 — 제품은 `slotStateOf`). 「모두 닫기」 범위 판정이 쓴다 — 필수라 배선 누락이 타입에서 막힌다. */
  checkSlot: (root: string) => Promise<SlotState>
  /** 카드 밖 판정이 재시도로 안 풀리는 원인으로 보류일 때 그 사유(LIFE-628 P1). */
  cardlessBlockedReason: () => string | null
  /**
   * 카드 귀속을 그 자리에서 다시 읽은 workspace id → 귀속시킨 경로들(LIFE-628 F2·P2 — 등록 레포마다 herdr `worktree.list`).
   * 한 레포라도 실패면 null.
   */
  claimedWorkspaceIds: (socketPath: string) => Promise<ReadonlyMap<string, readonly string[]> | null>
  /** 기존 workspace 닫기(`closeWorkspace` — 카드 메뉴 닫기와 같은 길, 완료 행 되살림 억제 포함). */
  closeWorkspace: (input: { socketPath: string; workspaceId: string }) => Promise<CloseTabOutcome>
  confirmRunning: () => boolean
  /** main 밖 Electron 역할 pid(renderer·GPU·utility) — `diagnostics memory` 와 같은 출처 `app.getAppMetrics`. */
  appPids: () => number[]
  /** 메모리 도우미 실행 파일 경로(`footprintHelperPath`). */
  footprintHelper: string
  log: (tag: string, data: Record<string, unknown>) => void
}

type ExecPs = (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>

/** `LC_ALL=C ps …` 를 실제로 부른다 — env 를 그대로 넘기는지가 R1ⓓ 의 실제 보장이다(F5). */
export async function readPsWith(input: { exec: ExecPs; env: NodeJS.ProcessEnv }): Promise<string> {
  const ps = psInvocation(input.env)
  return (await input.exec(ps.file, ps.args, { timeout: 5000, env: ps.env })).stdout
}

/**
 * 메모리 도우미 자리 (LIFE-676 R8) — 설치본은 `Contents/Resources/helper/corral-footprint`(electron-builder `extraResources`),
 * 개발 실행은 main 번들(`app/out/main`) 기준 `app/build/helper/corral-footprint` — `npm run dev`(predev)·`npm run build` 가
 * `scripts/build-footprint.mjs` 로 빌드한다. `app.getAppPath()` 가 아니라 번들 자리로 찾는 것은 `electron out/main/index.js` 로 띄운
 * 격리 실행도 같은 자리를 보게 하려는 것이다.
 */
export function footprintHelperPath(input: { packaged: boolean; resourcesPath: string; mainDir: string }): string {
  return input.packaged ? path.join(input.resourcesPath, 'helper', 'corral-footprint') : path.resolve(input.mainDir, '..', '..', 'build', 'helper', 'corral-footprint')
}

export const FOOTPRINT_TIMEOUT_MS = 2000

type ExecFile = (file: string, args: string[], options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>

/** execFile 오류 → 사람이 읽는 사유. 없음·시한 초과·비정상 종료를 가른다(R1ⓒ). */
function helperFailure(input: { error: unknown; helper: string }): string {
  const { error, helper } = input
  if (!(error instanceof Error)) return `footprint 도우미 실행 실패 (${String(error)})`
  const code = 'code' in error ? error.code : undefined
  const killed = 'killed' in error ? error.killed : undefined
  const signal = 'signal' in error ? error.signal : undefined
  if (code === 'ENOENT') return `footprint 도우미가 없다 (${helper})`
  if (code === 'EACCES') return `footprint 도우미를 실행할 수 없다 (${helper})`
  if (killed === true) return `footprint 도우미 시한 초과 (${FOOTPRINT_TIMEOUT_MS} ms)`
  if (typeof code === 'number') return `footprint 도우미 비정상 종료 (코드 ${code})`
  if (typeof signal === 'string') return `footprint 도우미 비정상 종료 (${signal})`
  return `footprint 도우미 실행 실패 (${error.message})`
}

/** 도우미를 부르고 표로 읽는다. 던지지 않는다 — 실패는 `unavailable`(사유). */
export async function readFootprintWith(input: { exec: ExecFile; helper: string }): Promise<FootprintTable> {
  try {
    const { stdout } = await input.exec(input.helper, [], { timeout: FOOTPRINT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
    return parseFootprintTable(stdout)
  } catch (error) {
    return { kind: 'unavailable', reason: helperFailure({ error, helper: input.helper }) }
  }
}

/**
 * 시스템 줄 지표(게이트 ⓪ Q4) — `sysctl`·`vm_stat` 를 나란히. 던지지 않는다 — 못 읽은 지표는 null.
 * `LC_ALL=C` — 로캘이 소수점을 콤마로 쓰면 `vm.swapusage` 가 `0,00M` 이 되어 못 읽는다(ps 와 같은 이유, 리뷰 r1 C1-2).
 */
export async function readHostWith(input: { exec: ExecFile; env: NodeJS.ProcessEnv; physicalMemory: number; cpuCoreCount: number }): Promise<ResourceHost> {
  const options = { timeout: 2000, maxBuffer: 1024 * 1024, env: { ...input.env, LC_ALL: 'C' } }
  const read = (file: string, args: string[]): Promise<string | null> => input.exec(file, args, options).then((out) => out.stdout, () => null)
  const [swap, pressure, vmStat] = await Promise.all([
    read('sysctl', ['vm.swapusage']),
    read('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    read('vm_stat', []),
  ])
  return {
    physicalMemory: input.physicalMemory,
    cpuCoreCount: input.cpuCoreCount,
    pressure: pressure === null ? null : parsePressureLevel(pressure),
    swap: swap === null ? null : parseSwapUsage(swap),
    compressed: vmStat === null ? null : parseCompressedBytes(vmStat),
  }
}

/**
 * store 의 열린 pane → 패널 행의 표시 칸. worktree 에 매달린 workspace 만 상태 트리에 있다.
 * 제목은 사이드바와 같은 스피너 정규화(`normalizeDecorativeTitle`)를 거친 뒤 `paneSessionTitle` 로 만든다(F2 — 2초마다 글리프가 바뀌지 않는다).
 * 폴백 제목의 ordinal 은 사이드바(`buildAgentRows`)와 같은 규칙(J5): 에이전트 pane 은 그 worktree 의 에이전트 pane 중 몇 번째, 셸 pane 은 셸 pane 중 몇 번째.
 */
export function paneSources(state: Pick<AppState, 'repos' | 'home'>): ResourcePaneSource[] {
  return state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => {
    const workspace = worktree.workspace
    if (workspace === null) return []
    const groupLabel = distinctWorktreeName(worktree)
    const panes = workspace.tabs.flatMap((tab) => tab.panes)
    const agentPanes = panes.filter((pane) => pane.agent !== null)
    const shellPanes = panes.filter((pane) => pane.agent === null)
    return panes.map((pane) => ({
      paneId: pane.paneId,
      tabId: pane.tabId,
      workspaceId: pane.workspaceId,
      groupKey: worktree.path,
      groupLabel,
      title: paneSessionTitle({
        pane: { ...pane, title: normalizeDecorativeTitle(pane.title) },
        ordinal: (pane.agent === null ? shellPanes : agentPanes).indexOf(pane) + 1,
        home: state.home,
      }),
      agent: pane.agent,
    }))
  })
}

/** herdr `pane.process_info` 판정 → 수집기의 셸 pid 결과(LIFE-628 F5) — `pane_not_found` 는 런타임 없음(`missing`). */
export function shellProbeOf(probe: Pick<ForegroundRead, 'shellPid' | 'missing'>): ShellProbe {
  if (probe.shellPid !== null) return { kind: 'pid', pid: probe.shellPid }
  return probe.missing ? { kind: 'missing' } : { kind: 'unknown' }
}

/** 경로 한 개를 확인한 값 — `exists: null` = 확인 불가(G1), `real` = 있으면 실경로(G6 — HOME 비교용). */
export type PathCheck = { exists: boolean | null; real: string | null }

/**
 * 경로 판정 창구 — 캐시만 읽는다(값 없으면 null). `checked` = 한 번이라도 확인을 마쳤는가(P3 — 첫 틱 구분).
 * `settle` = 확인 전이면 진행 중 확인을 기다려 존재 값을 준다(Y4 — 닫기 사유를 찬 캐시에서도 바로 정한다).
 */
export type PathOracle = {
  isDirectory: (path: string) => boolean | null
  realPath: (path: string) => string | null
  checked: (path: string) => boolean
  settle: (path: string) => Promise<boolean | null>
  /** 캐시를 건너뛰고 **그 자리에서** 다시 확인한다(결과로 캐시도 갱신). 확인 불가는 null(있음 쪽) — 「모두 닫기」 범위 판정(r3 H1). */
  fresh: (path: string) => Promise<boolean | null>
}

/**
 * 경로 존재 캐시 (LIFE-628 F7 — main 동기 stat 을 걷는다). 캐시만 읽고 낡았으면 비동기 확인을 건다.
 * 아직 모르면 null — 부르는 쪽이 「있다」 로 읽는다(모르면 주인 있음 쪽 — 「모두 닫기」 대상에 넣지 않는다). 확인 자체가 던지면 null(모름).
 */
export function createDirectoryCache(input: { ttlMs: number; now: () => number; check: (path: string) => Promise<PathCheck> }): PathOracle {
  type Entry = { value: PathCheck; checkedAt: number; inflight: Promise<void> | null }
  const entries = new Map<string, Entry>()
  const entryOf = (target: string): Entry => {
    const entry = entries.get(target) ?? { value: { exists: null, real: null }, checkedAt: -Infinity, inflight: null }
    entries.set(target, entry)
    if (entry.inflight === null && input.now() - entry.checkedAt >= input.ttlMs) {
      entry.inflight = input.check(target).catch((): PathCheck => ({ exists: null, real: null })).then((value) => {
        entry.value = value
        entry.checkedAt = input.now()
        entry.inflight = null
      })
    }
    return entry
  }
  return {
    isDirectory: (target) => entryOf(target).value.exists,
    realPath: (target) => entryOf(target).value.real,
    checked: (target) => entryOf(target).checkedAt !== -Infinity,
    settle: async (target) => {
      const entry = entryOf(target)
      if (entry.checkedAt === -Infinity && entry.inflight !== null) await entry.inflight
      return entry.value.exists
    },
    fresh: async (target) => {
      const value = await input.check(target).catch((): PathCheck => ({ exists: null, real: null }))
      const entry = entries.get(target) ?? { value, checkedAt: -Infinity, inflight: null }
      entry.value = value
      entry.checkedAt = input.now()
      entries.set(target, entry)
      return value.exists
    },
  }
}

/** 자리 뿌리 판정 창구(LIFE-697 · r1 리뷰 F1) — 캐시만 읽는다. 아직 확인 전이면 `pending`. `dead` 만 죽은 자리로 센다. */
export type SlotOracle = { state: (root: string) => SlotState | 'pending' }

/** 자리 뿌리 캐시 — 경로 캐시와 같은 결: 캐시만 읽고 낡았으면 비동기 확인을 건다. 확인이 던지면 `unknown`. */
export function createSlotCache(input: { ttlMs: number; now: () => number; check: (root: string) => Promise<SlotState> }): SlotOracle {
  type Entry = { value: SlotState | 'pending'; checkedAt: number; inflight: boolean }
  const entries = new Map<string, Entry>()
  return {
    state: (root) => {
      const entry = entries.get(root) ?? { value: 'pending', checkedAt: -Infinity, inflight: false }
      entries.set(root, entry)
      if (!entry.inflight && input.now() - entry.checkedAt >= input.ttlMs) {
        entry.inflight = true
        void input.check(root).catch((): SlotState => 'unknown').then((value) => {
          entry.value = value
          entry.checkedAt = input.now()
          entry.inflight = false
        })
      }
      return entry.value
    },
  }
}

/**
 * 경로 하나 확인 (LIFE-628 G1·G6). `ENOENT`·`ENOTDIR` 만 「없음」 — 그 밖의 stat 오류(EACCES·EPERM·EIO 등 TCC 보호 폴더·외장 볼륨)는
 * 「확인 불가」(null)다. 디렉터리가 아닌 파일은 「없음」. 있으면 실경로도 싣는다(실패면 null).
 */
export async function checkPath(input: { target: string; stat: (path: string) => Promise<{ isDirectory: () => boolean }>; realpath: (path: string) => Promise<string> }): Promise<PathCheck> {
  let directory: boolean
  try {
    directory = (await input.stat(input.target)).isDirectory()
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    return { exists: code === 'ENOENT' || code === 'ENOTDIR' ? false : null, real: null }
  }
  if (!directory) return { exists: false, real: null }
  return { exists: true, real: await input.realpath(input.target).catch(() => null) }
}

/** 등록 레포들의 git worktree 경로 전부 — 죽은 worktree 자리 판정의 근거(LIFE-697). */
export function worktreePathsOf(state: Pick<AppState, 'repos'>): string[] {
  return state.repos.flatMap((repo) => repo.worktrees.map((worktree) => worktree.path))
}

/** HOME 후보 (G6) — 실경로 HOME(`state.home = homeDirReal()`)과 논리 HOME(`$HOME` → `os.homedir()`). */
export function homesOf(home: string): string[] {
  return [...new Set([home, os.homedir()])]
}

/**
 * 카드 밖 workspace → 패널 줄의 표시 칸(LIFE-628). 경로는 pane cwd 를 중복 없이 처음 본 순서로, 지금 디렉터리가 있는지를
 * 같이 싣는다 — 셸에서 지운 worktree 는 herdr 가 원래 cwd 를 들고 있어 「없음」 으로 보인다(S3). 재기동이 HOME 으로 옮긴 것은 HOME 이 보인다.
 * 존재를 아직 모르는 경로(`null`)는 「있다」 로 싣는다.
 * `ownerless`(F3) = 경로가 하나 이상이고 **모두** 사라졌거나 HOME — 「모두 닫기」 대상. 경로가 살아 있는 줄(미등록 레포 세션·형제 pane 이
 * 살아 있는 workspace)은 아니다. `stoppedAgents`(F4) = 감지된 에이전트는 없고 세션 참조만 남은 pane 의 에이전트(재개 안 된 pane).
 * 폴더가 남아 있어도 **죽은 worktree 자리**면 주인 없는 쪽이다(LIFE-697) — 목록 판정(`deadSlotRoot` — `.claude/worktrees/<name>` 인데
 * git worktree 목록에 없음)에 더해 자리 뿌리의 파일시스템 확인(`slots` — 뿌리가 없거나 그 안에 `.git` 이 없음)이 `dead` 일 때만(r1 리뷰 F1).
 * 확인 전(pending)·확인 불가(unknown)면 올리지 않는다. 그 경로에 `deadSlot` 을 실어 툴팁이 사유를 보인다.
 * `worktreePaths` = 등록 레포들의 git worktree 목록(비면 이 판정을 하지 않는다). `slots` 가 없으면 이 판정을 하지 않는다.
 */
export function orphanSources(input: { workspaces: readonly WorkspaceRow[]; homes: readonly string[]; paths: PathOracle; worktreePaths?: readonly string[]; slots?: SlotOracle }): ResourceOrphanSource[] {
  const worktreePaths = input.worktreePaths ?? []
  const deadSlot = (cwd: string): boolean => {
    const root = deadSlotRoot({ path: cwd, worktreePaths })
    return root !== null && input.slots?.state(root) === 'dead'
  }
  // G6 — 경로는 있으면 실경로로도 비교한다(심링크 HOME·/tmp 류). 없으면 원문만.
  const isHome = (target: string): boolean => input.homes.includes(target) || input.homes.includes(input.paths.realPath(target) ?? target)
  return input.workspaces.map((workspace) => {
    const panes = workspace.tabs.flatMap((tab) => tab.panes)
    const cwds = [...new Set(panes.flatMap((pane) => (pane.cwd === null ? [] : [pane.cwd])))]
    const agents = [...new Set(panes.flatMap((pane) => (pane.agent === null ? [] : [pane.agent])))]
    const stoppedAgents = [...new Set(panes.flatMap((pane) => (pane.agent === null && pane.agentSession !== null ? [pane.agentSession.agent] : [])))].filter((agent) => !agents.includes(agent))
    const paths: ResourceOrphanSource['paths'] = cwds.map((cwd) => {
      const item = input.paths.checked(cwd) ? { path: cwd, exists: input.paths.isDirectory(cwd) } : { path: cwd, exists: input.paths.isDirectory(cwd), pending: true }
      // 남아 있는 폴더만 사유를 단다 — 사라진 자리는 「디렉터리 없음」 이 이미 사유다.
      return item.exists === true && deadSlot(cwd) ? { ...item, deadSlot: true } : item
    })
    return {
      workspaceId: workspace.workspaceId,
      label: workspace.label,
      paths,
      // 「없음」 은 exists === false 만 — 확인 불가(null)는 있음 쪽(G1).
      ownerless: paths.length > 0 && paths.every((item) => item.exists === false || isHome(item.path) || item.deadSlot === true),
      agents,
      stoppedAgents,
      paneIds: panes.map((pane) => pane.paneId),
    }
  })
}

/** 닫기 길을 지금 위상으로 정한다(H3). 파일 탭은 herdr 탭이 아니라 `workspace.tabs` 가 곧 터미널 탭이다(App `closeTabsByUser` 와 같은 수). */
export function closeRouteOf(input: { state: Pick<AppState, 'repos'>; paneId: string }): ResourceCloseRoute {
  for (const worktree of input.state.repos.flatMap((repo) => repo.worktrees)) {
    const workspace = worktree.workspace
    if (workspace === null) continue
    const tab = workspace.tabs.find((row) => row.panes.some((pane) => pane.paneId === input.paneId))
    if (tab === undefined) continue
    if (tab.panes.length > 1) return { kind: 'pane' }
    return { kind: 'tab', tabId: tab.tabId, worktreePath: worktree.path, lastInWorktree: workspace.tabs.length <= 1 }
  }
  return { kind: 'missing' }
}

export function registerResourceIpc(deps: ResourceIpcDeps): { stop: () => void } {
  const exec = promisify(execFile)
  const directories = createDirectoryCache({ ttlMs: 5000, now: () => Date.now(), check: (target) => checkPath({ target, stat: (item) => fs.promises.stat(item), realpath: (item) => fs.promises.realpath(item) }) })
  const slots = createSlotCache({ ttlMs: 5000, now: () => Date.now(), check: slotStateOf })
  const monitor = createResourceMonitor({
    intervalMs: RESOURCE_INTERVAL_MS,
    readPs: () => readPsWith({ exec, env: process.env }),
    readFootprint: () => readFootprintWith({ exec, helper: deps.footprintHelper }),
    panes: () => paneSources(deps.state()),
    orphans: () => {
      const workspaces = deps.cardlessWorkspaces()
      if (workspaces === null) return null
      // 상태는 틱마다 한 번만 만든다(r1 리뷰 F4) — HOME 과 worktree 경로가 같은 값에서 나온다.
      const state = deps.state()
      return orphanSources({ workspaces, homes: homesOf(state.home), paths: directories, worktreePaths: worktreePathsOf(state), slots })
    },
    orphansReason: deps.cardlessBlockedReason,
    probeShellPid: async (paneId): Promise<ShellProbe> => {
      const socketPath = deps.socketPath()
      return socketPath === null ? { kind: 'unknown' } : deps.shellPidOf({ socketPath, paneId })
    },
    appRoots: () => [...new Set([process.pid, ...deps.appPids()])],
    visible: () => {
      const window = deps.window()
      return window !== null && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
    },
    readHost: () => readHostWith({ exec, env: process.env, physicalMemory: os.totalmem(), cpuCoreCount: os.cpus().length }),
    emit: (snapshot) => {
      const window = deps.window()
      if (window !== null && !window.isDestroyed()) window.webContents.send('corral:resourceSnapshot', snapshot)
    },
    now: () => Date.now(),
    log: deps.log,
  })

  ipcMain.handle('corral:resourceSnapshot', (event): ResourceSnapshot | null => (deps.fromOurWindow(event) ? monitor.latest() : null))
  ipcMain.handle('corral:resourceReveal', (event, input: { paneId?: unknown }): boolean => {
    if (!deps.fromOurWindow(event) || typeof input?.paneId !== 'string' || !deps.paneIds().includes(input.paneId)) return false
    deps.window()?.webContents.send('corral:revealPane', input.paneId)
    return true
  })
  ipcMain.handle('corral:resourceCloseRoute', (event, input: { paneId?: unknown }): ResourceCloseRoute =>
    deps.fromOurWindow(event) && typeof input?.paneId === 'string' ? closeRouteOf({ state: deps.state(), paneId: input.paneId }) : { kind: 'missing' })
  ipcMain.handle('corral:resourceClosePane', (event, input: { paneId?: unknown; confirmed?: unknown; confirmedPaneIds?: unknown }): Promise<ResourceCloseResult> | ResourceCloseResult => {
    if (!deps.fromOurWindow(event) || typeof input?.paneId !== 'string') return { outcome: 'error', closed: [], error: '허용되지 않은 발신자' }
    return closeResourcePane({
      deps,
      paneId: input.paneId,
      confirmed: input.confirmed === true,
      confirmedPaneIds: Array.isArray(input.confirmedPaneIds) ? input.confirmedPaneIds.filter((paneId): paneId is string => typeof paneId === 'string') : [],
    })
  })

  ipcMain.handle('corral:resourceCloseOrphans', (event, input: { workspaceIds?: unknown; bulk?: unknown; confirmed?: unknown; confirmedPaneIds?: unknown }): Promise<ResourceOrphanCloseResult> | ResourceOrphanCloseResult => {
    if (!deps.fromOurWindow(event) || !Array.isArray(input?.workspaceIds)) return { outcome: 'error', closed: [], error: '허용되지 않은 발신자' }
    return closeOrphanWorkspaces({
      deps,
      workspaceIds: input.workspaceIds.filter((id): id is string => typeof id === 'string'),
      // 생략·true 아닌 값은 한 줄 닫기다 — 「모두 닫기」 의 넓은 범위는 명시해야만 열린다(그래도 주인 없는 줄만, 개수 확인은 늘).
      bulk: input.bulk === true,
      paths: directories,
      confirmed: input.confirmed === true,
      confirmedPaneIds: Array.isArray(input.confirmedPaneIds) ? input.confirmedPaneIds.filter((paneId): paneId is string => typeof paneId === 'string') : [],
    })
  })

  // F10 — 창이 다시 보이면 다음 타이머(≤2초)를 기다리지 않는다. 창은 다시 만들어질 수 있어(macOS activate) 생길 때마다 단다.
  const watch = (window: ResourceWindow): void => {
    window.on('show', monitor.wake)
    window.on('restore', monitor.wake)
  }
  const current = deps.window()
  if (current !== null) watch(current)
  app.on('browser-window-created', (_event, window) => watch(window))
  app.once('will-quit', monitor.stop)

  monitor.start()
  return { stop: monitor.stop }
}

/**
 * pane 하나를 기존 게이트로 닫는다 — 게이트 단위(「탭」 칸)에 pane id 를 넣는다.
 * 모르는 pane 은 닫지 않고 오류(F6 — 빈 `closed` 를 성공으로 돌려주지 않는다). 판정·닫기가 던지면 오류 결과로 돌려준다(F6).
 */
export async function closeResourcePane(input: { deps: ResourceIpcDeps; paneId: string; confirmed: boolean; confirmedPaneIds: readonly string[] }): Promise<ResourceCloseResult> {
  const { deps, paneId } = input
  const socketPath = deps.socketPath()
  if (socketPath === null) return { outcome: 'error', closed: [], error: '세션이 없다' }
  if (!deps.paneIds().includes(paneId)) return { outcome: 'error', closed: [], error: '그 pane 이 없다(이미 닫혔다)' }
  // J2 — pane 게이트는 split 탭의 pane 만. 지금 그 탭의 마지막 pane 이면 핀·수정 문서 확인을 지나는 탭 닫기 길로 돌려보낸다.
  if (closeRouteOf({ state: deps.state(), paneId }).kind !== 'pane') {
    deps.log('resource.close_pane', { paneId, confirmed: input.confirmed, outcome: 'route-changed' })
    return { outcome: 'route-changed', closed: [] }
  }
  const tabOf = (id: string): string => deps.state().repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => worktree.workspace?.tabs ?? [])
    .find((tab) => tab.panes.some((pane) => pane.paneId === id))?.tabId ?? ''
  let result: ResourceCloseResult
  try {
    result = await closeTabsGated({
      tabIds: [paneId],
      confirmed: input.confirmed,
      alwaysConfirm: false,
      confirmRunning: deps.confirmRunning(),
      confirmedPaneIds: input.confirmedPaneIds,
      panesOf: (id) => (deps.paneIds().includes(id) ? [id] : null),
      probe: (panes) => deps.probeRunning({ socketPath, panes: panes.map((pane) => ({ tabId: tabOf(pane.paneId), paneId: pane.paneId })), subject: { close: 'resource-pane', paneId } }),
      close: async (id): Promise<CloseTabOutcome> => {
        const outcome = await deps.closePane({ socketPath, paneId: id })
        switch (outcome.outcome) {
          case 'ok':
            return { outcome: 'closed' }
          case 'rejected':
            return { outcome: 'rejected', rejection: outcome.rejection }
        }
      },
    })
  } catch (error) {
    deps.log('resource.close_pane_failed', { paneId, error: String(error) })
    return { outcome: 'error', closed: [], error: `닫기 확인에 실패했다: ${error instanceof Error ? error.message : String(error)}` }
  }
  deps.log('resource.close_pane', { paneId, confirmed: input.confirmed, outcome: result.outcome })
  return result
}

/**
 * 카드 밖 workspace 를 기존 게이트로 닫는다(LIFE-628 S1) — 게이트 단위(「탭」 칸)에 workspace id 를 넣는다.
 * 대상은 세 겹으로 좁힌다:
 *   ① 메모리 판정(`cardlessWorkspaces`)이 지금 카드 밖이라고 하는 것 — 판정 보류(null)면 하나도 닫지 않는다
 *   ② 그 자리에서 다시 읽은 카드 귀속(`claimedWorkspaceIds` — herdr `worktree.list`, prunable 경로 제외 G2)에 없는 것(F2). 읽기 실패면 하나도 닫지 않는다.
 *      workspace 마다 **재독 → 프로세스 판정 → 닫기** 순서다(G3 `prepare`) — 재독에서 카드에 붙어 있으면 판정 없이 건너뛴다.
 *   ③ 「모두 닫기」(`bulk`)면 주인 없는 줄(`ownerless` — 원래 경로가 모두 사라졌거나 HOME 이거나 확인된 죽은 worktree 자리, LIFE-697)만(F3).
 *      판정 함수는 주기 수집과 같은 `orphanSources` 지만 입력은 **표시 캐시가 아니라 그 자리에서 새로 확인한 값**이다 — 경로 존재(`paths.fresh`)와
 *      자리 상태(`deps.checkSlot`) 둘 다(r2 G1 · r3 H1). 게이트 시작 때 한 번, workspace 마다 닫기 직전(`prepare`)에 한 번 더 본다.
 *      확인 불가는 있음 쪽이라 닫지 않는다. 경로가 살아 있는 줄은 줄 ✕ 로만 닫힌다.
 * 「모두 닫기」 는 실행 중 여부·설정과 무관하게 개수 확인을 한 번 거친다(`alwaysConfirm` — 확인 전 `needs-confirm`).
 * 닫지 않은 줄은 사유(`skipped` — claimed·gone·not-ownerless)로 돌려준다(G2).
 * 보장의 한계(원자적이지 않은 세 창): ⓐ 프로세스 판정 → `workspace.close` 사이(요청 한 번 — 기존 게이트와 같은 크기),
 * ⓑ 귀속 재독(등록 레포 전부를 차례로 읽는 시간 — 레포 수에 비례) → `workspace.close` 사이. ⓑ 동안 카드에 붙는 workspace 는 막지 못한다.
 * ⓒ 「모두 닫기」 의 닫기 직전 범위 재확인(`prepare` — 경로·자리 stat) → 프로세스 판정 → `workspace.close` 사이. 그 동안 그 자리에 생기는 worktree 는 막지 못한다.
 */
export async function closeOrphanWorkspaces(input: { deps: ResourceIpcDeps; workspaceIds: readonly string[]; bulk: boolean; paths: PathOracle; confirmed: boolean; confirmedPaneIds: readonly string[] }): Promise<ResourceOrphanCloseResult> {
  const { deps } = input
  const socketPath = deps.socketPath()
  if (socketPath === null) return { outcome: 'error', closed: [], error: '세션이 없다' }
  if (deps.cardlessWorkspaces() === null) return { outcome: 'error', closed: [], error: '지금은 카드 밖 workspace 를 가릴 수 없다 — 잠시 뒤 다시 시도' }
  const claimedAtStart = await deps.claimedWorkspaceIds(socketPath)
  if (claimedAtStart === null) return { outcome: 'error', closed: [], error: '카드 귀속을 다시 읽지 못해 닫지 않았다 — 잠시 뒤 다시 시도' }
  let claimed = claimedAtStart
  // 닫지 않은 사유(G2) — 판정할 때마다 마지막 사유로 덮는다. 끝에 닫힌 것은 뺀다.
  const skips = new Map<string, ResourceOrphanSkip['reason']>()
  // 귀속 사유(P2) — 귀속 경로가 모두 「없음」 으로 확인되면 잠김·정리 대기, 아니면 카드에 붙음. 닫지 않는 것은 둘 다 같다.
  const claimReason = (workspaceId: string): ResourceOrphanSkip['reason'] =>
    (claimed.get(workspaceId) ?? []).every((target) => input.paths.isDirectory(target) === false) ? 'stale-claim' : 'claimed'
  /**
   * 「모두 닫기」 범위 — 주인 없는 줄인가. 경로 존재와 자리 상태 모두 표시용 캐시(TTL)가 아니라 **그 자리에서 새로 확인한 값**으로 본다(r2 G1 · r3 H1):
   * 캐시가 「없음」 이나 `dead` 를 든 사이 그 자리에 worktree 가 다시 생기면 낡은 값으로 닫는다. 닫기는 되돌릴 수 없다.
   * 확인이 던지면 경로는 null(확인 불가 — 있음 쪽), 자리는 `unknown` — 둘 다 주인 없음에 안 든다.
   */
  const ownerlessNow = async (workspace: WorkspaceRow): Promise<boolean> => {
    const state = deps.state()
    const worktreePaths = worktreePathsOf(state)
    const cwds = [...new Set(workspace.tabs.flatMap((tab) => tab.panes).flatMap((pane) => (pane.cwd === null ? [] : [pane.cwd])))]
    const roots = [...new Set(cwds.flatMap((cwd) => {
      const root = deadSlotRoot({ path: cwd, worktreePaths })
      return root === null ? [] : [root]
    }))]
    const exists = new Map<string, boolean | null>(await Promise.all(cwds.map(async (cwd): Promise<[string, boolean | null]> => [cwd, await input.paths.fresh(cwd).catch(() => null)])))
    const slotStates = new Map<string, SlotState>(await Promise.all(roots.map(async (root): Promise<[string, SlotState]> => [root, await deps.checkSlot(root).catch((): SlotState => 'unknown')])))
    const paths: PathOracle = {
      isDirectory: (target) => exists.get(target) ?? null,
      realPath: input.paths.realPath,
      checked: () => true,
      settle: async (target) => exists.get(target) ?? null,
      fresh: input.paths.fresh,
    }
    const slots: SlotOracle = { state: (root) => slotStates.get(root) ?? 'unknown' }
    return orphanSources({ workspaces: [workspace], homes: homesOf(state.home), paths, worktreePaths, slots })[0]?.ownerless === true
  }
  // 게이트의 `panesOf` 는 동기라 범위는 게이트 시작 전에 새로 확인해 둔다(아래 `try` 안 — 던지면 구조화된 오류). 닫기 직전(`prepare`)에 한 번 더 새로 본다.
  const scope = new Map<string, boolean>()
  const inScope = (workspace: WorkspaceRow): boolean => !input.bulk || scope.get(workspace.workspaceId) === true
  const panesOf = (workspaceId: string): string[] | null => {
    if (claimed.has(workspaceId)) {
      skips.set(workspaceId, claimReason(workspaceId))
      return null
    }
    const workspace = deps.cardlessWorkspaces()?.find((row) => row.workspaceId === workspaceId)
    if (workspace === undefined) {
      skips.set(workspaceId, 'gone')
      return null
    }
    if (!inScope(workspace)) {
      skips.set(workspaceId, 'not-ownerless')
      return null
    }
    skips.delete(workspaceId)
    return workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.paneId))
  }
  let result: CloseTabsResult
  try {
    if (input.bulk) for (const workspace of deps.cardlessWorkspaces() ?? []) if (input.workspaceIds.includes(workspace.workspaceId)) scope.set(workspace.workspaceId, await ownerlessNow(workspace))
    result = await closeTabsGated({
      tabIds: input.workspaceIds,
      confirmed: input.confirmed,
      alwaysConfirm: input.bulk,
      confirmRunning: deps.confirmRunning(),
      confirmedPaneIds: input.confirmedPaneIds,
      panesOf,
      probe: (panes) => deps.probeRunning({ socketPath, panes, subject: { close: 'resource-orphans', workspaceIds: input.workspaceIds } }),
      // G3 — workspace 마다 권위 재독 → (게이트의) 프로세스 판정 → 닫기. 재독이 판정과 닫기 사이에 끼지 않는다.
      prepare: async (workspaceId): Promise<ClosePrepareOutcome> => {
        const fresh = await deps.claimedWorkspaceIds(socketPath)
        if (fresh === null) return { outcome: 'error', error: '카드 귀속을 다시 읽지 못해 멈췄다' }
        claimed = fresh
        if (claimed.has(workspaceId)) {
          const reason = claimReason(workspaceId)
          skips.set(workspaceId, reason)
          deps.log('resource.close_orphan_skipped', { workspaceId, reason })
          return { outcome: 'skipped' }
        }
        // G1 — 「모두 닫기」 는 닫기 직전에 주인 없음을 그 자리에서 다시 확인한다(판정 뒤 그 자리에 worktree 가 생겼을 수 있다).
        const workspace = deps.cardlessWorkspaces()?.find((row) => row.workspaceId === workspaceId)
        if (input.bulk && (workspace === undefined || !(await ownerlessNow(workspace)))) {
          skips.set(workspaceId, workspace === undefined ? 'gone' : 'not-ownerless')
          deps.log('resource.close_orphan_skipped', { workspaceId, reason: skips.get(workspaceId) })
          return { outcome: 'skipped' }
        }
        return { outcome: 'ready' }
      },
      close: (workspaceId) => deps.closeWorkspace({ socketPath, workspaceId }),
    })
  } catch (error) {
    deps.log('resource.close_orphans_failed', { workspaceIds: input.workspaceIds, error: String(error) })
    return { outcome: 'error', closed: [], error: `닫기 확인에 실패했다: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Y4 — 귀속 사유는 경로 확인이 끝난 값으로 다시 정한다(찬 캐시면 그 자리에서 stat 을 기다린다). 닫을지는 이미 끝났다 — 문자열만.
  for (const [workspaceId, reason] of skips) {
    if (reason !== 'claimed' && reason !== 'stale-claim') continue
    const exists = await Promise.all((claimed.get(workspaceId) ?? []).map((target) => input.paths.settle(target)))
    skips.set(workspaceId, exists.length > 0 && exists.every((value) => value === false) ? 'stale-claim' : 'claimed')
  }
  const skipped = input.workspaceIds.flatMap((workspaceId): ResourceOrphanSkip[] => {
    const reason = skips.get(workspaceId)
    return reason === undefined || result.closed.includes(workspaceId) ? [] : [{ workspaceId, reason }]
  })
  deps.log('resource.close_orphans', { requested: input.workspaceIds.length, confirmed: input.confirmed, outcome: result.outcome, closed: result.closed.length, skipped })
  return { ...result, skipped }
}
