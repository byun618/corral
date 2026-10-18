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

const { closeResourcePane, paneSources, readPsWith, registerResourceIpc } = await import('./resource-ipc.js')
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
  it('탭 pane 수·worktree 탭 수 (F7 닫기 길 판단)', () => {
    expect(paneSources(state()).map((row) => [row.paneId, row.tabPaneCount, row.worktreeTabCount])).toEqual([['p1', 2, 2], ['p2', 2, 2], ['p3', 1, 2]])
  })
})

describe('registerResourceIpc — IPC 입력 검증·배선', () => {
  let stop: (() => void) | null = null
  const sent: unknown[][] = []
  const windowEvents = new Map<string, () => void>()
  const fakeWindow = {
    isDestroyed: () => false,
    isVisible: () => false,
    isMinimized: () => false,
    on: (name: string, listener: () => void) => windowEvents.set(name, listener),
    webContents: { send: (...args: unknown[]) => sent.push(args) },
  }
  beforeEach(() => {
    electron.handlers.clear()
    electron.appOn.clear()
    sent.length = 0
    windowEvents.clear()
  })
  afterEach(() => {
    stop?.()
    stop = null
  })
  function register(patch: Partial<Deps> = {}): Deps & { closed: string[] } {
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
})
