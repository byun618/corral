// LIFE-637 F5 — main 배선(리뷰 r1 C1-5·G1-7): 닫기 게이트 인자·LC_ALL=C 전달·reveal 검증·닫기 IPC 인자·창 다시 보임.
// Electron 은 가짜(ipcMain·app·창) — 실제 herdr·창 회차는 최종 관문 몫.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type AppState, type RunningPane } from '../shared/types.js'
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

// 실제 ps 대신 — 몇 번 불렸는지(수집 여부)와 넘긴 env 를 본다.
const ps = vi.hoisted((): { calls: { file: string; env: unknown }[] } => ({ calls: [] }))
vi.mock('node:child_process', () => ({
  execFile: (file: string, _args: string[], options: { env: unknown }, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    ps.calls.push({ file, env: options.env })
    callback(null, { stdout: '  1 0 0.0 10\n', stderr: '' })
  },
}))

const { closeResourcePane, closeRouteOf, paneSources, readPsWith, registerResourceIpc } = await import('./resource-ipc.js')
type Deps = Parameters<typeof closeResourcePane>[0]['deps']

const pane = (input: { paneId: string; tabId: string; title?: string; agent?: string | null }) => ({
  paneId: input.paneId, tabId: input.tabId, workspaceId: 'w1', title: input.title ?? input.paneId, agent: input.agent ?? null, agentStatus: 'idle' as const,
  agentState: emptyAgentState(0), cwd: null, focused: false, agentSession: null, digest: EMPTY_SESSION_DIGEST,
})
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
  const probed: string[][] = []
  return {
    window: () => null,
    fromOurWindow: () => true,
    state,
    socketPath: () => '/tmp/sock',
    paneIds: () => ['p1', 'p2', 'p3'],
    shellPidOf: async () => 300,
    probeRunning: async (input) => {
      probed.push(input.panes.map((item) => item.paneId))
      return input.panes.map((item): RunningPane => ({ ...item, foreground: ['yes'] }))
    },
    closePane: async (input) => {
      closed.push(input.paneId)
      return { outcome: 'ok' }
    },
    confirmRunning: () => true,
    appPids: () => [],
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

describe('readPsWith — R1ⓓ 가 실제 실행에 닿는다', () => {
  it('execFile 에 LC_ALL=C env 를 그대로 넘긴다', async () => {
    const exec = vi.fn(async () => ({ stdout: 'OUT' }))
    expect(await readPsWith({ exec, env: { PATH: '/bin', LC_ALL: 'de_DE.UTF-8' } })).toBe('OUT')
    expect(exec).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,pcpu=,rss='], { timeout: 5000, env: { PATH: '/bin', LC_ALL: 'C' } })
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
