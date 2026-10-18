// Resource Manager 배선 (LIFE-637) — 수집기를 창·herdr·store 에 잇고 `corral:resource*` IPC 를 단다.
//
// 행 동작(R5, 게이트 ⓪ Q3):
//   · 이동 = 기존 `corral:revealPane` 푸시(CLI `worktree activate` 와 같은 길) — 렌더러가 worktree·탭 전환까지 한다.
//   · 닫기(split 탭의 pane) = 기존 실행 중 확인 게이트 `closeTabsGated` 를 pane 하나 단위로 지난다(설정 `skipCloseTerminalWithRunningProcessConfirm` 존중).
//     닫는 동작은 기존 `pane.close` 경로(`closePane`) 그대로 — 새 프로세스 kill 경로는 없다.
//     탭의 마지막 pane 은 렌더러가 기존 탭 닫기 IPC(`corral:closeTabs`)로 보낸다(핀·수정 문서 확인, F7) — 여기를 지나지 않는다.
//     렌더러가 길을 정한 뒤(확인 창 체류 중 등) 옆 pane 이 사라져 대상이 그 탭의 마지막 pane 이 됐으면 닫지 않고 `route-changed`(J2).
import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { app, ipcMain } from 'electron'
import type { CloseTabOutcome } from './close-tabs.js'
import { closeTabsGated } from './close-tabs.js'
import { psInvocation } from './resource-collector.js'
import { createResourceMonitor, RESOURCE_INTERVAL_MS, type ResourcePaneSource } from './resource-monitor.js'
import type { ResourceCloseResult, ResourceCloseRoute, ResourceSnapshot } from '../shared/resource.js'
import type { AppState, RunningPane } from '../shared/types.js'
import { normalizeDecorativeTitle } from '../shared/decorative-title.js'
import { paneSessionTitle } from '../shared/session-title.js'
import { distinctWorktreeName } from '../shared/worktree-name.js'

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
  shellPidOf: (input: { socketPath: string; paneId: string }) => Promise<number | null>
  /** 기존 게이트의 pane 판정(`probeRunningPanes`). */
  probeRunning: (input: { socketPath: string; panes: readonly { tabId: string; paneId: string }[]; subject: Record<string, unknown> }) => Promise<RunningPane[]>
  /** 기존 pane 닫기(완료 행 되살림 억제 포함). */
  closePane: (input: { socketPath: string; paneId: string }) => Promise<PaneCloseOutcome>
  confirmRunning: () => boolean
  /** main 밖 Electron 역할 pid(renderer·GPU·utility) — `diagnostics memory` 와 같은 출처 `app.getAppMetrics`. */
  appPids: () => number[]
  log: (tag: string, data: Record<string, unknown>) => void
}

type ExecPs = (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>

/** `LC_ALL=C ps …` 를 실제로 부른다 — env 를 그대로 넘기는지가 R1ⓓ 의 실제 보장이다(F5). */
export async function readPsWith(input: { exec: ExecPs; env: NodeJS.ProcessEnv }): Promise<string> {
  const ps = psInvocation(input.env)
  return (await input.exec(ps.file, ps.args, { timeout: 5000, env: ps.env })).stdout
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
  const monitor = createResourceMonitor({
    intervalMs: RESOURCE_INTERVAL_MS,
    readPs: () => readPsWith({ exec, env: process.env }),
    panes: () => paneSources(deps.state()),
    probeShellPid: async (paneId) => {
      const socketPath = deps.socketPath()
      return socketPath === null ? null : deps.shellPidOf({ socketPath, paneId })
    },
    appRoots: () => [...new Set([process.pid, ...deps.appPids()])],
    visible: () => {
      const window = deps.window()
      return window !== null && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
    },
    host: () => ({ totalMemory: os.totalmem(), usedMemory: os.totalmem() - os.freemem(), cpuCoreCount: os.cpus().length }),
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
