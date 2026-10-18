// Resource Manager 배선 (LIFE-637) — 수집기를 창·herdr·store 에 잇고 `corral:resource*` IPC 를 단다.
//
// 행 동작(R5, 게이트 ⓪ Q3):
//   · 이동 = 기존 `corral:revealPane` 푸시(CLI `worktree activate` 와 같은 길) — 렌더러가 worktree·탭 전환까지 한다.
//   · 닫기 = 기존 실행 중 확인 게이트 `closeTabsGated` 를 pane 하나 단위로 지난다(설정 `skipCloseTerminalWithRunningProcessConfirm` 존중).
//     닫는 동작은 기존 `pane.close` 경로(`closePane`) 그대로 — 새 프로세스 kill 경로는 없다.
import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { ipcMain, type BrowserWindow } from 'electron'
import type { CloseTabOutcome } from './close-tabs.js'
import { closeTabsGated } from './close-tabs.js'
import { psInvocation } from './resource-collector.js'
import { createResourceMonitor, RESOURCE_INTERVAL_MS, type ResourcePaneSource } from './resource-monitor.js'
import type { ResourceCloseResult, ResourceSnapshot } from '../shared/resource.js'
import type { AppState, RunningPane } from '../shared/types.js'
import { paneSessionTitle } from '../shared/session-title.js'
import { distinctWorktreeName } from '../shared/worktree-name.js'

const exec = promisify(execFile)

type PaneCloseOutcome = { outcome: 'ok' } | { outcome: 'rejected'; rejection: { code: string; message: string } }

export type ResourceIpcDeps = {
  window: () => BrowserWindow | null
  fromOurWindow: (event: Electron.IpcMainInvokeEvent) => boolean
  state: () => AppState
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

/** store 의 열린 pane → 패널 행의 표시 칸. worktree 에 매달린 workspace 만 상태 트리에 있다. */
export function paneSources(state: AppState): ResourcePaneSource[] {
  return state.repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => {
    const workspace = worktree.workspace
    if (workspace === null) return []
    const groupLabel = distinctWorktreeName(worktree)
    return workspace.tabs.flatMap((tab) => tab.panes).map((pane, index) => ({
      paneId: pane.paneId,
      tabId: pane.tabId,
      workspaceId: pane.workspaceId,
      groupKey: worktree.path,
      groupLabel,
      title: paneSessionTitle({ pane, ordinal: index + 1, home: state.home }),
      agent: pane.agent,
    }))
  })
}

export function registerResourceIpc(deps: ResourceIpcDeps): { stop: () => void } {
  const monitor = createResourceMonitor({
    intervalMs: RESOURCE_INTERVAL_MS,
    readPs: async () => {
      const ps = psInvocation(process.env)
      return (await exec(ps.file, ps.args, { timeout: 5000, env: ps.env })).stdout
    },
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
  ipcMain.handle('corral:resourceClosePane', (event, input: { paneId?: unknown; confirmed?: unknown; confirmedPaneIds?: unknown }): Promise<ResourceCloseResult> | ResourceCloseResult => {
    if (!deps.fromOurWindow(event) || typeof input?.paneId !== 'string') return { outcome: 'error', closed: [], error: '허용되지 않은 발신자' }
    return closeResourcePane({
      deps,
      paneId: input.paneId,
      confirmed: input.confirmed === true,
      confirmedPaneIds: Array.isArray(input.confirmedPaneIds) ? input.confirmedPaneIds.filter((paneId): paneId is string => typeof paneId === 'string') : [],
    })
  })

  monitor.start()
  return { stop: monitor.stop }
}

/** pane 하나를 기존 게이트로 닫는다 — 게이트 단위(「탭」 칸)에 pane id 를 넣는다. */
async function closeResourcePane(input: { deps: ResourceIpcDeps; paneId: string; confirmed: boolean; confirmedPaneIds: readonly string[] }): Promise<ResourceCloseResult> {
  const { deps, paneId } = input
  const socketPath = deps.socketPath()
  if (socketPath === null) return { outcome: 'error', closed: [], error: '세션이 없다' }
  const tabOf = (id: string): string => deps.state().repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => worktree.workspace?.tabs ?? [])
    .find((tab) => tab.panes.some((pane) => pane.paneId === id))?.tabId ?? ''
  const result = await closeTabsGated({
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
  deps.log('resource.close_pane', { paneId, confirmed: input.confirmed, outcome: result.outcome })
  return result
}
