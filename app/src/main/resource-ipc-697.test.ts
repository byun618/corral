// LIFE-697 C6 — 카드 밖 줄: 폴더만 남은 죽은 worktree 자리 = 주인 없음. 판정 근거는 등록 레포의 git worktree 목록과 자리 모양뿐.
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type AppState, type WorkspaceRow } from '../shared/types.js'
import { emptyAgentState } from '../shared/agent-state.js'
import { TEST_GIT } from '../shared/test-rows.js'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { on: () => {}, once: () => {} } }))

const { closeOrphanWorkspaces, orphanSources, worktreePathsOf } = await import('./resource-ipc.js')
type Deps = Parameters<typeof closeOrphanWorkspaces>[0]['deps']

const ROOT = '/repo'
const LIVE = '/repo/.claude/worktrees/live'
const DEAD = '/repo/.claude/worktrees/LIFE-608'

function orphan(workspaceId: string, cwds: Array<string | null>): WorkspaceRow {
  const tabId = `${workspaceId}-t`
  return {
    workspaceId, label: workspaceId, number: 9, focused: false, agentStatus: 'idle',
    tabs: [{ tabId, workspaceId, label: '', number: 1, order: 0, agentStatus: 'idle', focused: false, digest: EMPTY_SESSION_DIGEST,
      panes: cwds.map((cwd, index) => ({ paneId: `${workspaceId}-p${index}`, tabId, workspaceId, title: 'x', agent: 'claude', agentStatus: 'idle', agentState: emptyAgentState(0), cwd, focused: false, agentSession: null, digest: EMPTY_SESSION_DIGEST })) }],
  }
}

/** 등록 레포 하나 — main(`/repo`) + 살아 있는 linked worktree 하나. 카드 workspace 는 없다(시험 대상은 카드 밖 줄). */
function state(worktrees: readonly string[] = [ROOT, LIVE]): Pick<AppState, 'repos' | 'home'> {
  return {
    repos: [{ root: ROOT, name: 'repo', error: null, worktrees: worktrees.map((path) => ({ path, branch: 'b', head: null, repoName: 'repo', isLinked: path !== ROOT, openWorkspaceId: null, workspace: null, gitStatus: TEST_GIT, displayName: null, comment: null, parentPath: null })) }],
    home: '/home',
  }
}

/** 디스크 — 넘긴 경로(와 그 하위)만 있다. */
const disk = (...present: string[]) => {
  const isDirectory = (path: string): boolean => present.some((root) => path === root || path.startsWith(`${root}/`))
  return { isDirectory, realPath: () => null, checked: () => true, settle: async (path: string) => isDirectory(path) }
}

const sources = (input: { workspaces: WorkspaceRow[]; present: string[]; worktrees?: readonly string[] }) =>
  orphanSources({ workspaces: input.workspaces, homes: ['/home'], paths: disk(...input.present), worktreePaths: worktreePathsOf(state(input.worktrees)) })

describe('orphanSources — 폴더만 남은 죽은 worktree 자리 (C6)', () => {
  // 툴팁 문구는 렌더러 시험(`renderer/src/resource-view-697.test.ts`)이 이 줄 모양으로 본다.
  it('ⓐ 디스크에 있는 죽은 자리면 주인 없음 · 그 경로에 사유(deadSlot)', () => {
    const [row] = sources({ workspaces: [orphan('w1', [`${DEAD}/apps/api`, DEAD])], present: [DEAD] })
    expect(row?.ownerless).toBe(true)
    expect(row?.paths).toEqual([{ path: `${DEAD}/apps/api`, exists: true, deadSlot: true }, { path: DEAD, exists: true, deadSlot: true }])
  })
  it('ⓒ main 일반 하위 폴더·살아 있는 worktree·등록 레포 밖 경로는 지금처럼 「경로 있음」', () => {
    const rows = sources({ workspaces: [orphan('w1', [`${ROOT}/app`]), orphan('w2', [`${LIVE}/src`]), orphan('w3', ['/elsewhere/.claude/worktrees/x'])], present: [ROOT, '/elsewhere'] })
    expect(rows.map((row) => row.ownerless)).toEqual([false, false, false])
    expect(rows.flatMap((row) => row.paths).some((item) => item.deadSlot === true)).toBe(false)
  })
  it('죽은 자리와 살아 있는 경로가 섞인 줄은 주인 없음이 아니다(모두여야 한다)', () => {
    const [row] = sources({ workspaces: [orphan('w1', [DEAD, `${ROOT}/app`])], present: [ROOT] })
    expect(row?.ownerless).toBe(false)
  })
  it('ⓓ git 목록을 못 읽어 worktree 목록이 비면 주인 없음으로 올리지 않는다', () => {
    const [row] = sources({ workspaces: [orphan('w1', [DEAD])], present: [DEAD], worktrees: [] })
    expect(row?.ownerless).toBe(false)
    expect(row?.paths).toEqual([{ path: DEAD, exists: true }])
  })
  it('ⓔ 기존 주인 없음(경로 사라짐·HOME) 판정과 툴팁은 그대로', () => {
    const rows = sources({ workspaces: [orphan('w1', ['/gone/wt']), orphan('w2', ['/home'])], present: ['/home'] })
    expect(rows.map((row) => row.ownerless)).toEqual([true, true])
    expect(rows.flatMap((row) => row.paths)).toEqual([{ path: '/gone/wt', exists: false }, { path: '/home', exists: true }])
    // 사라진 죽은 자리는 「디렉터리 없음」 이 이미 사유다 — deadSlot 을 달지 않는다.
    expect(sources({ workspaces: [orphan('w3', [DEAD])], present: [] })[0]?.paths).toEqual([{ path: DEAD, exists: false }])
  })
})

describe('closeOrphanWorkspaces — 「모두 닫기」 재확인도 같은 판정 (C6ⓑ)', () => {
  function deps(input: { cardless: WorkspaceRow[]; running?: boolean }): Deps & { closed: string[]; probed: number } {
    const closed: string[] = []
    let probed = 0
    return {
      window: () => null, fromOurWindow: () => true, state: () => state(), socketPath: () => '/tmp/sock', paneIds: () => [],
      shellPidOf: async () => ({ kind: 'unknown' }),
      probeRunning: async (probe) => {
        probed += 1
        return input.running === true ? probe.panes.map((item) => ({ ...item, foreground: ['claude'] })) : []
      },
      closePane: async () => ({ outcome: 'ok' }),
      cardlessWorkspaces: () => input.cardless.filter((row) => !closed.includes(row.workspaceId)),
      cardlessBlockedReason: () => null,
      claimedWorkspaceIds: async () => new Map(),
      closeWorkspace: async ({ workspaceId }) => {
        closed.push(workspaceId)
        return { outcome: 'closed' }
      },
      confirmRunning: () => true, appPids: () => [], footprintHelper: '/x', log: () => {},
      closed,
      get probed() { return probed },
    }
  }
  const cardless = [orphan('dead', [DEAD]), orphan('sub', [`${ROOT}/app`])]

  it('죽은 자리 줄은 대상에 들고 main 하위 폴더 줄은 not-ownerless 로 남는다 — 개수 확인(alwaysConfirm)을 거친 뒤 닫는다', async () => {
    const d = deps({ cardless })
    const paths = disk(DEAD, ROOT)
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['dead', 'sub'], bulk: true, paths, confirmed: false, confirmedPaneIds: [] }))
      .toEqual({ outcome: 'needs-confirm', closed: [], running: [], skipped: [{ workspaceId: 'sub', reason: 'not-ownerless' }] })
    expect(d.closed).toEqual([])
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['dead', 'sub'], bulk: true, paths, confirmed: true, confirmedPaneIds: [] }))
      .toEqual({ outcome: 'closed', closed: ['dead'], skipped: [{ workspaceId: 'sub', reason: 'not-ownerless' }] })
    expect(d.closed).toEqual(['dead'])
  })
  it('실행 중 확인 게이트(closeTabsGated)는 그대로 — 확인 안 한 실행 중 pane 이 있으면 닫지 않는다', async () => {
    const d = deps({ cardless, running: true })
    const result = await closeOrphanWorkspaces({ deps: d, workspaceIds: ['dead'], bulk: true, paths: disk(DEAD, ROOT), confirmed: true, confirmedPaneIds: [] })
    expect(result.outcome).toBe('needs-confirm')
    expect(d.closed).toEqual([])
    expect(d.probed).toBeGreaterThan(0)
  })
})
