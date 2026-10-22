// LIFE-637 F5 — main 배선(리뷰 r1 C1-5·G1-7): 닫기 게이트 인자·LC_ALL=C 전달·reveal 검증·닫기 IPC 인자·창 다시 보임.
// Electron 은 가짜(ipcMain·app·창) — 실제 herdr·창 회차는 최종 관문 몫.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type AgentSessionRef, type AppState, type RunningPane, type WorkspaceRow } from '../shared/types.js'
import { emptyAgentState } from '../shared/agent-state.js'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  appOn: new Map<string, (...args: unknown[]) => void>(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, input: unknown) => unknown) => electron.handlers.set(channel, handler) },
  app: {
    on: (name: string, listener: (...args: unknown[]) => void) => electron.appOn.set(name, listener),
    once: (name: string, listener: (...args: unknown[]) => void) => electron.appOn.set(name, listener),
  },
}))

// 실제 ps 대신 — 몇 번 불렸는지(수집 여부)와 넘긴 env 를 본다. `calls` = ps 만, `all` = 한 주기의 실행 전부(LIFE-676: 도우미·sysctl·vm_stat).
const ps = vi.hoisted((): { calls: { file: string; env: unknown }[]; all: { file: string; args: string[]; env: unknown }[] } => ({ calls: [], all: [] }))
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], options: { env: unknown }, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    ps.all.push({ file, args, env: options.env })
    if (file === 'ps') ps.calls.push({ file, env: options.env })
    callback(null, { stdout: file === 'ps' ? '  1 0 0.0\n' : file === '/x/corral-footprint' ? '1 10\n' : '', stderr: '' })
  },
}))

const { closeOrphanWorkspaces, closeResourcePane, closeRouteOf, createDirectoryCache, footprintHelperPath, orphanSources, shellProbeOf, paneSources, readFootprintWith, readHostWith, readPsWith, registerResourceIpc } = await import('./resource-ipc.js')
const { buildAgentRows } = await import('../shared/sidebar-agents.js')
type Deps = Parameters<typeof closeResourcePane>[0]['deps']

const pane = (input: { paneId: string; tabId: string; title?: string; agent?: string | null; workspaceId?: string; cwd?: string | null; agentSession?: AgentSessionRef | null }) => ({
  paneId: input.paneId, tabId: input.tabId, workspaceId: input.workspaceId ?? 'w1', title: input.title ?? input.paneId, agent: input.agent ?? null, agentStatus: 'idle' as const,
  agentState: emptyAgentState(0), cwd: input.cwd ?? null, focused: false, agentSession: input.agentSession ?? null, digest: EMPTY_SESSION_DIGEST,
})
/** 카드 밖 workspace(LIFE-628) — 셸에서 지운 worktree 에 남은 에이전트 pane 과 셸 pane. */
function orphan(input: { workspaceId: string; panes: { paneId: string; agent?: string | null; cwd?: string | null; agentSession?: AgentSessionRef | null }[] }): WorkspaceRow {
  return {
    workspaceId: input.workspaceId, label: input.workspaceId, number: 9, focused: false, agentStatus: 'idle',
    tabs: [{ tabId: `${input.workspaceId}-t`, workspaceId: input.workspaceId, label: '', number: 1, order: 0, agentStatus: 'idle', focused: false, digest: EMPTY_SESSION_DIGEST,
      panes: input.panes.map((item) => pane({ ...item, tabId: `${input.workspaceId}-t`, workspaceId: input.workspaceId })) }],
  }
}
function state(): Pick<AppState, 'repos' | 'home'> {
  const tabs = [
    { tabId: 't1', workspaceId: 'w1', label: '', number: 1, order: 0, agentStatus: 'idle' as const, focused: true, digest: EMPTY_SESSION_DIGEST, panes: [pane({ paneId: 'p1', tabId: 't1', title: '⠋ Fix login bug', agent: 'codex' }), pane({ paneId: 'p2', tabId: 't1' })] },
    { tabId: 't2', workspaceId: 'w1', label: '', number: 2, order: 1, agentStatus: 'idle' as const, focused: false, digest: EMPTY_SESSION_DIGEST, panes: [pane({ paneId: 'p3', tabId: 't2' })] },
  ]
  const worktree = {
    path: '/repo/wt', branch: 'feat', isLinked: true, head: null, repoName: 'repo', openWorkspaceId: 'w1',
    gitStatus: { branch: 'feat', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
    workspace: { workspaceId: 'w1', label: 'repo', number: 1, focused: true, agentStatus: 'idle' as const, tabs },
    displayName: null, comment: null, parentPath: null,
  }
  return { repos: [{ root: '/repo', name: 'repo', error: null, worktrees: [worktree] }], home: '/home' }
}

function deps(patch: Partial<Deps> = {}): Deps & { closed: string[]; probed: string[][] } {
  const closed: string[] = []
  const cardless = [orphan({ workspaceId: 'w8', panes: [{ paneId: 'p8', agent: 'claude', cwd: '/gone/wt' }] }), orphan({ workspaceId: 'w9', panes: [{ paneId: 'p9', cwd: '/home' }] })]
  const probed: string[][] = []
  return {
    window: () => null,
    fromOurWindow: () => true,
    state,
    socketPath: () => '/tmp/sock',
    paneIds: () => ['p1', 'p2', 'p3'],
    shellPidOf: async () => ({ kind: 'pid', pid: 300 }),
    probeRunning: async (input) => {
      probed.push(input.panes.map((item) => item.paneId))
      return input.panes.map((item): RunningPane => ({ ...item, foreground: ['yes'] }))
    },
    closePane: async (input) => {
      closed.push(input.paneId)
      return { outcome: 'ok' }
    },
    cardlessWorkspaces: () => cardless.filter((row) => !closed.includes(row.workspaceId)),
    claimedWorkspaceIds: async () => new Set(['w1']),
    closeWorkspace: async (input) => {
      closed.push(input.workspaceId)
      return { outcome: 'closed' }
    },
    confirmRunning: () => true,
    appPids: () => [],
    footprintHelper: '/x/corral-footprint',
    log: () => {},
    ...patch,
    closed,
    probed,
  }
}

describe('closeResourcePane — 기존 실행 중 확인 게이트', () => {
  it('실행 중이면 닫지 않고 needs-confirm (그 pane 과 그 탭 id 로 판정)', async () => {
    const d = deps()
    const result = await closeResourcePane({ deps: d, paneId: 'p2', confirmed: false, confirmedPaneIds: [] })
    expect(result).toEqual({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p2', foreground: ['yes'] }] })
    expect(d.closed).toEqual([])
    expect(d.probed).toEqual([['p2']])
  })
  it('확인 뒤(confirmed + 확인한 pane)에는 그 pane 만 닫는다', async () => {
    const d = deps()
    const result = await closeResourcePane({ deps: d, paneId: 'p2', confirmed: true, confirmedPaneIds: ['p2'] })
    expect(result).toEqual({ outcome: 'closed', closed: ['p2'] })
    expect(d.closed).toEqual(['p2'])
  })
  it('확인 뒤에도 확인 밖 실행 중이 나오면 다시 묻는다(confirmedPaneIds 가 빈 경우)', async () => {
    const d = deps()
    const result = await closeResourcePane({ deps: d, paneId: 'p2', confirmed: true, confirmedPaneIds: [] })
    expect(result.outcome).toBe('needs-confirm')
    expect(d.closed).toEqual([])
  })
  it('설정 skipCloseTerminalWithRunningProcessConfirm(confirmRunning:false)이면 판정 없이 닫는다', async () => {
    const d = deps({ confirmRunning: () => false })
    const result = await closeResourcePane({ deps: d, paneId: 'p2', confirmed: false, confirmedPaneIds: [] })
    expect(result).toEqual({ outcome: 'closed', closed: ['p2'] })
    expect(d.probed).toEqual([])
  })
  it('모르는 pane id 는 닫지 않고 오류 (F6)', async () => {
    const d = deps()
    const result = await closeResourcePane({ deps: d, paneId: 'nope', confirmed: true, confirmedPaneIds: ['nope'] })
    expect(result).toEqual({ outcome: 'error', closed: [], error: '그 pane 이 없다(이미 닫혔다)' })
    expect(d.closed).toEqual([])
  })
  it('판정(probe)이 던지면 닫지 않고 오류 결과 (F6)', async () => {
    const d = deps({ probeRunning: async () => { throw new Error('herdr 응답 시간 초과') } })
    const result = await closeResourcePane({ deps: d, paneId: 'p2', confirmed: false, confirmedPaneIds: [] })
    expect(result).toEqual({ outcome: 'error', closed: [], error: '닫기 확인에 실패했다: herdr 응답 시간 초과' })
    expect(d.closed).toEqual([])
  })
  it('herdr 거절은 그대로', async () => {
    const d = deps({ confirmRunning: () => false, closePane: async () => ({ outcome: 'rejected', rejection: { code: 'pane_not_found', message: 'gone' } }) })
    expect(await closeResourcePane({ deps: d, paneId: 'p2', confirmed: false, confirmedPaneIds: [] })).toEqual({ outcome: 'rejected', closed: [], rejection: { code: 'pane_not_found', message: 'gone' } })
  })
  it('세션이 없으면 오류', async () => {
    expect((await closeResourcePane({ deps: deps({ socketPath: () => null }), paneId: 'p2', confirmed: false, confirmedPaneIds: [] })).outcome).toBe('error')
  })
})

describe('closeResourcePane — 길이 바뀌면 닫지 않는다 (J2)', () => {
  // 리뷰 r3 C3-2 재현(probe-results.log): 길을 물을 때는 split(p1·p2), 확인 창에 머무는 사이 p2 가 끝났다.
  const afterSiblingGone = (): Pick<AppState, 'repos' | 'home'> => {
    const now = state()
    const tab = now.repos[0]?.worktrees[0]?.workspace?.tabs[0]
    if (tab === undefined) throw new Error('모양')
    tab.panes = tab.panes.filter((row) => row.paneId === 'p1')
    return now
  }
  it('확인을 마치고 다시 불러도 대상이 지금 그 탭의 마지막 pane 이면 pane.close 하지 않고 route-changed', async () => {
    expect(closeRouteOf({ state: state(), paneId: 'p1' })).toEqual({ kind: 'pane' })
    const d = deps({ state: afterSiblingGone, paneIds: () => ['p1', 'p3'] })
    const result = await closeResourcePane({ deps: d, paneId: 'p1', confirmed: true, confirmedPaneIds: ['p1'] })
    expect(result).toEqual({ outcome: 'route-changed', closed: [] })
    expect(d.closed).toEqual([])
    expect(d.probed).toEqual([])
  })
  it('닫으면 결과를 로그로 남긴다 (P4)', async () => {
    const logs: [string, Record<string, unknown>][] = []
    const d = deps({ log: (tag, data) => logs.push([tag, data]) })
    await closeResourcePane({ deps: d, paneId: 'p2', confirmed: true, confirmedPaneIds: ['p2'] })
    expect(logs).toContainEqual(['resource.close_pane', { paneId: 'p2', confirmed: true, outcome: 'closed' }])
  })
})

describe('readPsWith — R1ⓓ 가 실제 실행에 닿는다', () => {
  it('execFile 에 LC_ALL=C env 를 그대로 넘긴다', async () => {
    const exec = vi.fn(async () => ({ stdout: 'OUT' }))
    expect(await readPsWith({ exec, env: { PATH: '/bin', LC_ALL: 'de_DE.UTF-8' } })).toBe('OUT')
    expect(exec).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,pcpu='], { timeout: 5000, env: { PATH: '/bin', LC_ALL: 'C' } })
  })
})

describe('footprintHelperPath — LIFE-676 R8ⓑ 설치본·개발 실행 둘 다', () => {
  it('설치본 = Resources/helper, 개발 실행 = app/build/helper', () => {
    expect(footprintHelperPath({ packaged: true, resourcesPath: '/A/corral.app/Contents/Resources', mainDir: '/ignored' })).toBe('/A/corral.app/Contents/Resources/helper/corral-footprint')
    expect(footprintHelperPath({ packaged: false, resourcesPath: '/electron/Resources', mainDir: '/repo/app/out/main' })).toBe('/repo/app/build/helper/corral-footprint')
  })
})

describe('readFootprintWith — LIFE-676 R1ⓒ 도우미 실패는 사유 있는 측정 불가 (던지지 않는다)', () => {
  const failing = (error: unknown) => vi.fn(async (): Promise<{ stdout: string }> => {
    throw error
  })
  const withProps = (message: string, props: Record<string, unknown>): Error => Object.assign(new Error(message), props)
  it('정상 — 표', async () => {
    const exec = vi.fn(async () => ({ stdout: '10 2048\n11 ERR 1\n' }))
    expect(await readFootprintWith({ exec, helper: '/h' })).toEqual({ kind: 'ok', bytes: new Map([[10, 2048]]), errors: new Map([[11, 1]]) })
    expect(exec).toHaveBeenCalledWith('/h', [], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 })
  })
  it('없음 · 실행 권한 없음 · 시한 초과 · 비정상 종료 · 신호 · 그 밖', async () => {
    const cases: [unknown, string][] = [
      [withProps('spawn /h ENOENT', { code: 'ENOENT' }), 'footprint 도우미가 없다 (/h)'],
      [withProps('spawn /h EACCES', { code: 'EACCES' }), 'footprint 도우미를 실행할 수 없다 (/h)'],
      [withProps('Command failed', { killed: true, signal: 'SIGTERM' }), 'footprint 도우미 시한 초과 (2000 ms)'],
      [withProps('Command failed', { code: 2, killed: false }), 'footprint 도우미 비정상 종료 (코드 2)'],
      [withProps('Command failed', { killed: false, signal: 'SIGSEGV' }), 'footprint 도우미 비정상 종료 (SIGSEGV)'],
      [new Error('boom'), 'footprint 도우미 실행 실패 (boom)'],
      ['weird', 'footprint 도우미 실행 실패 (weird)'],
    ]
    for (const [error, reason] of cases) expect(await readFootprintWith({ exec: failing(error), helper: '/h' })).toEqual({ kind: 'unavailable', reason })
  })
  it('출력 이상·빈 출력도 측정 불가', async () => {
    expect(await readFootprintWith({ exec: vi.fn(async () => ({ stdout: '' })), helper: '/h' })).toEqual({ kind: 'unavailable', reason: 'footprint 표가 비었다' })
    expect(await readFootprintWith({ exec: vi.fn(async () => ({ stdout: 'x y\n' })), helper: '/h' })).toEqual({ kind: 'unavailable', reason: 'footprint 표 이상 (1줄)' })
  })
})

describe('readHostWith — LIFE-676 R5ⓑⓓ sysctl·vm_stat, 못 읽은 지표만 null', () => {
  const outputs: Record<string, string> = {
    'sysctl vm.swapusage': 'vm.swapusage: total = 24576.00M  used = 23332.38M  free = 1243.62M  (encrypted)\n',
    'sysctl -n kern.memorystatus_vm_pressure_level': '2\n',
    vm_stat: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor:            515164.\n',
  }
  it('세 출처를 읽는다 — LC_ALL=C env 를 넘긴다 (C1-2)', async () => {
    const exec = vi.fn<(file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>>(async (file, args) => ({ stdout: outputs[[file, ...args].join(' ')] ?? '' }))
    const host = await readHostWith({ exec, env: { PATH: '/bin', LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' }, physicalMemory: 24 * 1024 ** 3, cpuCoreCount: 18 })
    expect(exec).toHaveBeenCalledTimes(3)
    // C3-4 — 시한·버퍼·env 를 통째로 고정한다.
    const options = { timeout: 2000, maxBuffer: 1024 * 1024, env: { PATH: '/bin', LC_ALL: 'C', LANG: 'de_DE.UTF-8' } }
    expect(exec).toHaveBeenCalledWith('sysctl', ['vm.swapusage'], options)
    expect(exec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], options)
    expect(exec).toHaveBeenCalledWith('vm_stat', [], options)
    expect(host).toEqual({
      physicalMemory: 24 * 1024 ** 3, cpuCoreCount: 18, pressure: 'warning', swap: { total: 24576 * 1024 ** 2, used: 23332.38 * 1024 ** 2 }, compressed: 515164 * 16384,
    })
  })
  it('하나가 실패하면 그 지표만 null', async () => {
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === 'vm_stat') throw new Error('없음')
      return { stdout: outputs[[file, ...args].join(' ')] ?? '' }
    })
    const host = await readHostWith({ exec, env: {}, physicalMemory: 1, cpuCoreCount: 2 })
    expect(host.compressed).toBeNull()
    expect(host.pressure).toBe('warning')
    expect(host.swap).not.toBeNull()
  })
  it('전부 실패해도 던지지 않는다', async () => {
    const exec = vi.fn(async (): Promise<{ stdout: string }> => {
      throw new Error('없음')
    })
    expect(await readHostWith({ exec, env: {}, physicalMemory: 1, cpuCoreCount: 2 })).toEqual({ physicalMemory: 1, cpuCoreCount: 2, pressure: null, swap: null, compressed: null })
  })
})

describe('paneSources', () => {
  it('제목은 스피너 글리프를 벗긴다 — 프레임이 바뀌어도 같은 제목 (F2)', () => {
    const rows = paneSources(state())
    expect(rows[0]?.title).toBe('Fix login bug')
    const next = state()
    const tab = next.repos[0]?.worktrees[0]?.workspace?.tabs[0]
    const first = tab?.panes[0]
    if (tab === undefined || first === undefined) throw new Error('모양')
    tab.panes[0] = { ...first, title: '⠙ Fix login bug' }
    expect(paneSources(next)[0]?.title).toBe('Fix login bug')
  })
  it('제목이 없을 때의 ordinal 은 사이드바와 같다 — 셸 pane 이 앞에 있어도 둘 다 claude 1 (J5)', () => {
    const now = state()
    const workspace = now.repos[0]?.worktrees[0]?.workspace
    if (workspace === undefined || workspace === null) throw new Error('모양')
    const tab = workspace.tabs[0]
    if (tab === undefined) throw new Error('모양')
    tab.panes = [pane({ paneId: 'sh', tabId: 't1', title: '' }), pane({ paneId: 'cl', tabId: 't1', title: '', agent: 'claude' })]
    workspace.tabs = [tab]
    const rows = paneSources(now)
    expect(rows.map((row) => row.title)).toEqual(['terminal 1', 'claude 1'])
    const sidebar = buildAgentRows({ tabs: workspace.tabs, retained: [], lineage: { state: 'ready', entries: [] }, livePaneIds: new Set(['sh', 'cl']), integrations: [], home: '/home', unreadPanes: new Set() })
    expect(sidebar.map((node) => node.full.label)).toEqual(['claude 1'])
  })
})

describe('closeRouteOf — 닫기 길은 지금 위상으로 (H3)', () => {
  it('split 직후 — 스냅샷에서 혼자였던 pane 도 지금 옆 pane 이 있으면 pane 게이트', () => {
    const now = state()
    const tab = now.repos[0]?.worktrees[0]?.workspace?.tabs[1]
    if (tab === undefined) throw new Error('모양')
    tab.panes = [...tab.panes, pane({ paneId: 'p4', tabId: 't2' })]
    expect(closeRouteOf({ state: now, paneId: 'p3' })).toEqual({ kind: 'pane' })
  })
  it('옆 pane 소멸 직후 — 지금 혼자면 기존 탭 닫기', () => {
    const now = state()
    const tab = now.repos[0]?.worktrees[0]?.workspace?.tabs[0]
    if (tab === undefined) throw new Error('모양')
    tab.panes = tab.panes.filter((row) => row.paneId === 'p1')
    expect(closeRouteOf({ state: now, paneId: 'p1' })).toEqual({ kind: 'tab', tabId: 't1', worktreePath: '/repo/wt', lastInWorktree: false })
  })
  it('마지막 터미널 탭 — lastInWorktree (수정 문서 확인)', () => {
    const now = state()
    const workspace = now.repos[0]?.worktrees[0]?.workspace
    if (workspace === undefined || workspace === null) throw new Error('모양')
    workspace.tabs = workspace.tabs.filter((tab) => tab.tabId === 't2')
    expect(closeRouteOf({ state: now, paneId: 'p3' })).toEqual({ kind: 'tab', tabId: 't2', worktreePath: '/repo/wt', lastInWorktree: true })
  })
  it('없는 pane — missing', () => {
    expect(closeRouteOf({ state: state(), paneId: 'nope' })).toEqual({ kind: 'missing' })
  })
})

describe('registerResourceIpc — IPC 입력 검증·배선', () => {
  let stop: (() => void) | null = null
  const sent: unknown[][] = []
  const windowEvents = new Map<string, () => void>()
  const win = { destroyed: false, visible: false, minimized: false }
  const fakeWindow = {
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    on: (name: string, listener: () => void) => windowEvents.set(name, listener),
    webContents: { send: (...args: unknown[]) => sent.push(args) },
  }
  beforeEach(() => {
    electron.handlers.clear()
    electron.appOn.clear()
    sent.length = 0
    windowEvents.clear()
    ps.calls.length = 0
    ps.all.length = 0
    Object.assign(win, { destroyed: false, visible: false, minimized: false })
  })
  afterEach(() => {
    stop?.()
    stop = null
  })
  function register(patch: Partial<Deps> = {}): Deps & { closed: string[]; probed: string[][] } {
    const d = deps({ window: () => fakeWindow, ...patch })
    stop = registerResourceIpc(d).stop
    return d
  }
  const handler = (channel: string): ((event: unknown, input: unknown) => unknown) => {
    const found = electron.handlers.get(channel)
    if (found === undefined) throw new Error(`${channel} 없음`)
    return found
  }

  it('reveal — 목록에 있는 pane 만 revealPane 으로 보낸다', () => {
    register()
    expect(handler('corral:resourceReveal')({}, { paneId: 'nope' })).toBe(false)
    expect(sent).toEqual([])
    expect(handler('corral:resourceReveal')({}, { paneId: 'p2' })).toBe(true)
    expect(sent).toEqual([['corral:revealPane', 'p2']])
  })
  it('reveal — 남의 창이면 거절', () => {
    register({ fromOurWindow: () => false })
    expect(handler('corral:resourceReveal')({}, { paneId: 'p2' })).toBe(false)
    expect(sent).toEqual([])
  })
  it('닫기 IPC — 렌더러 인자를 그대로 게이트에 넘긴다(confirmed 기본 false)', async () => {
    const d = register()
    expect(await handler('corral:resourceClosePane')({}, { paneId: 'p2' })).toMatchObject({ outcome: 'needs-confirm' })
    expect(d.closed).toEqual([])
    expect(await handler('corral:resourceClosePane')({}, { paneId: 'p2', confirmed: true, confirmedPaneIds: ['p2'] })).toEqual({ outcome: 'closed', closed: ['p2'] })
    expect(d.closed).toEqual(['p2'])
  })
  it('창 show·restore 에 즉시 수집, 종료 때 stop 이 걸린다 (F10)', () => {
    register()
    expect([...windowEvents.keys()].sort()).toEqual(['restore', 'show'])
    expect(electron.appOn.has('browser-window-created')).toBe(true)
    expect(electron.appOn.has('will-quit')).toBe(true)
  })

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  it('보이는 창이면 수집한다 — 실제 ps 호출에 LC_ALL=C (R6ⓒ·R1ⓓ 배선)', async () => {
    win.visible = true
    register()
    await settle()
    expect(ps.calls).toHaveLength(1)
    expect(ps.calls[0]).toMatchObject({ file: 'ps', env: { LC_ALL: 'C' } })
    // LIFE-676 — 한 주기 = ps · 도우미 · sysctl 둘 · vm_stat.
    expect(ps.all.map((call) => [call.file, ...call.args].join(' ')).sort()).toEqual(
      ['/x/corral-footprint', 'ps -axo pid=,ppid=,pcpu=', 'sysctl -n kern.memorystatus_vm_pressure_level', 'sysctl vm.swapusage', 'vm_stat'].sort(),
    )
    // C1-2 — 시스템 지표도 LC_ALL=C 로 부른다(실제 배선).
    for (const call of ps.all.filter((item) => item.file === 'sysctl' || item.file === 'vm_stat')) expect(call.env).toMatchObject({ LC_ALL: 'C' })
  })
  it.each([
    ['숨김', { visible: false }],
    ['최소화', { visible: true, minimized: true }],
    ['파괴됨', { visible: true, destroyed: true }],
  ])('창이 %s 이면 ps 를 부르지 않는다 (R6ⓒ 배선)', async (_name, state) => {
    Object.assign(win, state)
    register()
    await settle()
    expect(ps.calls).toHaveLength(0)
    // C1-5 — 도우미·sysctl·vm_stat 도 0회(외부 실행 전부).
    expect(ps.all).toHaveLength(0)
  })
  it.each(['show', 'restore'])('창 %s 이벤트 = 곧바로 한 번 더 수집 (F10 배선)', async (name) => {
    win.visible = true
    register()
    await settle()
    expect(ps.calls).toHaveLength(1)
    windowEvents.get(name)?.()
    await settle()
    expect(ps.calls).toHaveLength(2)
  })
  it('수집이 끝날 때 창이 파괴됐으면 그 창에 보내지 않는다 (P3)', async () => {
    win.visible = true
    const goneSent: unknown[][] = []
    const gone = { ...fakeWindow, isDestroyed: () => true, webContents: { send: (...args: unknown[]) => goneSent.push(args) } }
    // ps 를 부르기 전(보임 판정)에는 살아 있는 창, 부른 뒤(보낼 때)에는 파괴된 창.
    register({ window: () => (ps.calls.length === 0 ? fakeWindow : gone) })
    await settle()
    expect(ps.calls).toHaveLength(1)
    expect(goneSent).toEqual([])
    expect(sent).toEqual([])
  })
  it('닫기 IPC — 남의 창이면 판정도 닫기도 하지 않는다', async () => {
    const d = register({ fromOurWindow: () => false })
    expect(await handler('corral:resourceClosePane')({}, { paneId: 'p2', confirmed: true, confirmedPaneIds: ['p2'] })).toEqual({ outcome: 'error', closed: [], error: '허용되지 않은 발신자' })
    expect(d.closed).toEqual([])
    expect(d.probed).toEqual([])
  })
  it('스냅샷 IPC — 남의 창이면 null, 우리 창이면 최신 값', async () => {
    win.visible = true
    let ours = true
    register({ fromOurWindow: () => ours })
    await settle()
    expect(handler('corral:resourceSnapshot')({}, undefined)).toMatchObject({ stats: { collections: 1 } })
    ours = false
    expect(handler('corral:resourceSnapshot')({}, undefined)).toBeNull()
  })
  it('닫기 길 IPC — 지금 위상을 돌려주고, 남의 창이면 missing', () => {
    let ours = true
    register({ fromOurWindow: () => ours })
    expect(handler('corral:resourceCloseRoute')({}, { paneId: 'p3' })).toEqual({ kind: 'tab', tabId: 't2', worktreePath: '/repo/wt', lastInWorktree: false })
    expect(handler('corral:resourceCloseRoute')({}, { paneId: 'p1' })).toEqual({ kind: 'pane' })
    ours = false
    expect(handler('corral:resourceCloseRoute')({}, { paneId: 'p1' })).toEqual({ kind: 'missing' })
  })
})

describe('카드 밖 workspace (LIFE-628 S1)', () => {
  it('orphanSources — 경로는 중복 없이·있는지 함께, 에이전트는 중복 없이, pane id 전부', () => {
    const rows = orphanSources({
      workspaces: [orphan({ workspaceId: 'w8', panes: [{ paneId: 'a', agent: 'claude', cwd: '/gone/wt' }, { paneId: 'b', cwd: '/gone/wt' }, { paneId: 'c', agent: 'claude', cwd: null }] })],
      home: '/home',
      isDirectory: (path) => path !== '/gone/wt',
    })
    expect(rows).toEqual([{ workspaceId: 'w8', label: 'w8', paths: [{ path: '/gone/wt', exists: false }], ownerless: true, agents: ['claude'], stoppedAgents: [], paneIds: ['a', 'b', 'c'] }])
  })
  it('실행 중이면 닫지 않고 needs-confirm — 판정 단위는 그 workspace 의 pane 들', async () => {
    const d = deps()
    const result = await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8'], bulk: false, isDirectory: () => false, confirmed: false, confirmedPaneIds: [] })
    expect(result).toEqual({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 'w8', paneId: 'p8', foreground: ['yes'] }] })
    expect(d.closed).toEqual([])
  })
  it('확인 뒤 「모두 닫기」 — 목록에 있던 것만 닫고, 카드 pane(p1·p2·p3)은 건드리지 않는다', async () => {
    const d = deps()
    const result = await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: true, isDirectory: () => false, confirmed: true, confirmedPaneIds: ['p8', 'p9'] })
    expect(result).toEqual({ outcome: 'closed', closed: ['w8', 'w9'] })
    expect(d.closed).toEqual(['w8', 'w9'])
  })
  it('설정 skipCloseTerminalWithRunningProcessConfirm 이면 판정 없이 닫는다', async () => {
    const d = deps({ confirmRunning: () => false })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w9'], bulk: false, isDirectory: () => false, confirmed: false, confirmedPaneIds: [] })).toEqual({ outcome: 'closed', closed: ['w9'] })
    expect(d.probed).toEqual([])
  })
  it('지금 카드 밖이 아닌 workspace(카드 귀속 w1·모르는 id)는 닫지 않는다', async () => {
    const d = deps({ confirmRunning: () => false })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w1', 'nope'], bulk: false, isDirectory: () => false, confirmed: true, confirmedPaneIds: [] })).toEqual({ outcome: 'closed', closed: [] })
    expect(d.closed).toEqual([])
  })
  it('카드 밖을 가릴 수 없으면(null) 하나도 닫지 않는다', async () => {
    const d = deps({ confirmRunning: () => false, cardlessWorkspaces: () => null })
    const result = await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w9'], bulk: false, isDirectory: () => false, confirmed: true, confirmedPaneIds: [] })
    expect(result.outcome).toBe('error')
    expect(d.closed).toEqual([])
  })
  it('herdr 거절은 그대로 — 그때까지 닫은 것만 closed', async () => {
    const d = deps({ confirmRunning: () => false, closeWorkspace: async (input) => (input.workspaceId === 'w9' ? { outcome: 'rejected', rejection: { code: 'workspace_group_close_required', message: 'group' } } : { outcome: 'closed' }) })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: false, isDirectory: () => false, confirmed: true, confirmedPaneIds: [] })).toEqual({ outcome: 'rejected', closed: ['w8'], rejection: { code: 'workspace_group_close_required', message: 'group' } })
  })
  it('IPC — 다른 창 발신·배열 아닌 입력은 닫지 않는다', async () => {
    electron.handlers.clear()
    const d = deps({ confirmRunning: () => false })
    let ours = false
    const stop = registerResourceIpc({ ...d, fromOurWindow: () => ours })
    const handler = electron.handlers.get('corral:resourceCloseOrphans')
    expect(await handler?.({}, { workspaceIds: ['w9'] })).toEqual({ outcome: 'error', closed: [], error: '허용되지 않은 발신자' })
    ours = true
    expect(await handler?.({}, { workspaceIds: 'w9' })).toEqual({ outcome: 'error', closed: [], error: '허용되지 않은 발신자' })
    expect(await handler?.({}, { workspaceIds: ['w9'], confirmed: true })).toEqual({ outcome: 'closed', closed: ['w9'] })
    stop.stop()
  })

  // ── fix r1 (리뷰 r1 F2·F3·F4·F6) ──
  it('F6 IPC — confirmed 를 생략하면 확인 전으로 읽어 실행 중이면 needs-confirm, 닫지 않는다', async () => {
    electron.handlers.clear()
    const d = deps()
    const stop = registerResourceIpc(d)
    const handler = electron.handlers.get('corral:resourceCloseOrphans')
    expect(await handler?.({}, { workspaceIds: ['w8'] })).toEqual({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 'w8', paneId: 'p8', foreground: ['yes'] }] })
    expect(await handler?.({}, { workspaceIds: ['w8'], confirmed: 'yes', confirmedPaneIds: ['p8'] })).toMatchObject({ outcome: 'needs-confirm' })
    expect(d.closed).toEqual([])
    stop.stop()
  })
  it('F6 IPC — bulk 는 true 일 때만 「모두 닫기」(개수 확인), 다른 값은 한 줄 닫기', async () => {
    electron.handlers.clear()
    const d = deps({ confirmRunning: () => false })
    const stop = registerResourceIpc(d)
    const handler = electron.handlers.get('corral:resourceCloseOrphans')
    expect(await handler?.({}, { workspaceIds: ['w9'], bulk: true })).toEqual({ outcome: 'needs-confirm', closed: [], running: [] })
    expect(d.closed).toEqual([])
    expect(await handler?.({}, { workspaceIds: ['w9'], bulk: 'true' })).toEqual({ outcome: 'closed', closed: ['w9'] })
    stop.stop()
  })
  it('F2 — 다시 읽은 카드 귀속에 있으면(메모리 판정은 카드 밖이어도) 닫지 않는다', async () => {
    const d = deps({ confirmRunning: () => false, claimedWorkspaceIds: async () => new Set(['w1', 'w9']) })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: false, isDirectory: () => false, confirmed: true, confirmedPaneIds: [] })).toEqual({ outcome: 'closed', closed: ['w8'] })
    expect(d.closed).toEqual(['w8'])
  })
  it('F2 — 카드 귀속 읽기가 실패하면 하나도 닫지 않는다(판정도 하지 않는다)', async () => {
    const d = deps({ confirmRunning: () => false, claimedWorkspaceIds: async () => null })
    const result = await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: false, isDirectory: () => false, confirmed: true, confirmedPaneIds: [] })
    expect(result.outcome).toBe('error')
    expect(d.closed).toEqual([])
    expect(d.probed).toEqual([])
  })
  it('F2 — 확인 전 판정에도 다시 읽은 귀속을 쓴다: 카드에 붙은 workspace 의 pane 은 판정·확인 창에 넣지 않는다', async () => {
    const d = deps({ claimedWorkspaceIds: async () => new Set(['w1', 'w9']) })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: false, isDirectory: () => false, confirmed: false, confirmedPaneIds: [] })).toEqual({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 'w8', paneId: 'p8', foreground: ['yes'] }] })
    expect(d.probed).toEqual([['p8']])
  })
  it('F2 — 귀속 읽기가 실패하면 확인 전 판정(pane 질의)도 하지 않는다', async () => {
    const d = deps({ claimedWorkspaceIds: async () => null })
    expect((await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8'], bulk: false, isDirectory: () => false, confirmed: false, confirmedPaneIds: [] })).outcome).toBe('error')
    expect(d.probed).toEqual([])
  })
  it('F2 — 닫기 직전마다 다시 읽는다: 첫 workspace 를 닫은 뒤 둘째가 카드에 붙으면 건너뛴다', async () => {
    let reads = 0
    const logs: string[] = []
    const d = deps({ confirmRunning: () => false, log: (tag) => logs.push(tag), claimedWorkspaceIds: async () => (++reads >= 3 ? new Set(['w1', 'w9']) : new Set(['w1'])) })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: false, isDirectory: () => false, confirmed: true, confirmedPaneIds: [] })).toEqual({ outcome: 'closed', closed: ['w8'] })
    expect(d.closed).toEqual(['w8'])
    expect(logs).toContain('resource.close_orphan_skipped')
  })
  it('F2 — 닫기 직전 다시 읽기가 실패하면 거기서 멈춘다(그때까지 닫은 것만)', async () => {
    let reads = 0
    const d = deps({ confirmRunning: () => false, claimedWorkspaceIds: async () => (++reads >= 3 ? null : new Set(['w1'])) })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: false, isDirectory: () => false, confirmed: true, confirmedPaneIds: [] })).toEqual({ outcome: 'error', closed: ['w8'], error: '카드 귀속을 다시 읽지 못해 멈췄다' })
    expect(d.closed).toEqual(['w8'])
  })
  it('F3 — 「모두 닫기」 는 주인 없는 줄(경로가 모두 없거나 HOME)만 닫는다. 경로가 살아 있는 줄은 남는다', async () => {
    const d = deps({ confirmRunning: () => false })
    // w8 의 /gone/wt 가 지금 있다(미등록 레포 세션 등) → 주인 있음. w9 는 HOME → 주인 없음.
    const isDirectory = (path: string): boolean => path === '/gone/wt' || path === '/home'
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: true, isDirectory, confirmed: true, confirmedPaneIds: [] })).toEqual({ outcome: 'closed', closed: ['w9'] })
    expect(d.closed).toEqual(['w9'])
    // 경로 존재를 아직 모르면(null) 「있다」 로 — 대상이 아니다.
    const d2 = deps({ confirmRunning: () => false })
    expect(await closeOrphanWorkspaces({ deps: d2, workspaceIds: ['w8'], bulk: true, isDirectory: () => null, confirmed: true, confirmedPaneIds: [] })).toEqual({ outcome: 'closed', closed: [] })
    // 한 줄 닫기(✕)는 경로가 살아 있어도 닫는다.
    const d3 = deps({ confirmRunning: () => false })
    expect(await closeOrphanWorkspaces({ deps: d3, workspaceIds: ['w8'], bulk: false, isDirectory, confirmed: true, confirmedPaneIds: [] })).toEqual({ outcome: 'closed', closed: ['w8'] })
  })
  it('F3 — 「모두 닫기」 는 실행 중이 없어도·설정이 확인을 껐어도 확인 전엔 needs-confirm(개수 확인) — 하나도 닫지 않는다', async () => {
    const d = deps({ confirmRunning: () => false })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w8', 'w9'], bulk: true, isDirectory: () => false, confirmed: false, confirmedPaneIds: [] })).toEqual({ outcome: 'needs-confirm', closed: [], running: [] })
    expect(d.closed).toEqual([])
    const idle = deps({ probeRunning: async () => [] })
    expect(await closeOrphanWorkspaces({ deps: idle, workspaceIds: ['w8', 'w9'], bulk: true, isDirectory: () => false, confirmed: false, confirmedPaneIds: [] })).toEqual({ outcome: 'needs-confirm', closed: [], running: [] })
    expect(idle.closed).toEqual([])
  })
  it('F3·F4 orphanSources — 주인 없음 판정(경로 없음·HOME·섞임·경로 없음 pane), 세션 참조만 남은 에이전트는 stoppedAgents', () => {
    const session = (agent: string): AgentSessionRef => ({ kind: 'id', agent, source: 'claude', id: 's1' })
    const rows = orphanSources({
      workspaces: [
        orphan({ workspaceId: 'a', panes: [{ paneId: 'a1', cwd: '/gone' }, { paneId: 'a2', cwd: '/home' }] }),
        orphan({ workspaceId: 'b', panes: [{ paneId: 'b1', cwd: '/gone' }, { paneId: 'b2', cwd: '/live' }] }),
        orphan({ workspaceId: 'c', panes: [{ paneId: 'c1', cwd: null }] }),
        orphan({ workspaceId: 'd', panes: [{ paneId: 'd1', cwd: '/gone', agentSession: session('claude') }, { paneId: 'd2', cwd: '/gone', agent: 'codex', agentSession: session('codex') }] }),
      ],
      home: '/home',
      isDirectory: (path) => path === '/live' || path === '/home',
    })
    expect(rows.map((row) => [row.workspaceId, row.ownerless])).toEqual([['a', true], ['b', false], ['c', false], ['d', true]])
    expect(rows.find((row) => row.workspaceId === 'd')).toMatchObject({ agents: ['codex'], stoppedAgents: ['claude'] })
  })
  it('F4 shellProbeOf — pane_not_found 는 missing, 다른 실패는 unknown, pid 는 pid', () => {
    expect(shellProbeOf({ shellPid: 300, missing: false })).toEqual({ kind: 'pid', pid: 300 })
    expect(shellProbeOf({ shellPid: null, missing: true })).toEqual({ kind: 'missing' })
    expect(shellProbeOf({ shellPid: null, missing: false })).toEqual({ kind: 'unknown' })
  })
  it('F7 createDirectoryCache — 처음엔 모름(null)·비동기 stat 뒤 값·TTL 안에서는 다시 stat 하지 않는다', async () => {
    let now = 0
    const calls: string[] = []
    const cache = createDirectoryCache({ ttlMs: 5000, now: () => now, stat: async (path) => { calls.push(path); if (path === '/err') throw new Error('x'); return path === '/yes' } })
    expect(cache.isDirectory('/yes')).toBeNull()
    expect(cache.isDirectory('/err')).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cache.isDirectory('/yes')).toBe(true)
    expect(cache.isDirectory('/err')).toBe(false)
    expect(calls).toEqual(['/yes', '/err'])
    now = 5000
    cache.isDirectory('/yes')
    expect(calls).toEqual(['/yes', '/err', '/yes'])
  })
})
