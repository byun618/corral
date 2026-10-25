// LIFE-697 C6 — 카드 밖 줄: 폴더만 남은 죽은 worktree 자리 = 주인 없음. 판정 근거는 등록 레포의 git worktree 목록·자리 모양과
// 자리 뿌리의 파일시스템 확인(표시 `slots` 캐시 · 「모두 닫기」 재확인은 그 자리에서 `checkSlot` — r1 F1 · r2 G1). 실제 확인 함수(`slotStateOf`)는 `adapter/internal/retention-policy.test.ts` 가 실제 디스크로 본다.
import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type AppState, type WorkspaceRow } from '../shared/types.js'
import { emptyAgentState } from '../shared/agent-state.js'
import { TEST_GIT } from '../shared/test-rows.js'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { on: () => {}, once: () => {} } }))

const { closeOrphanWorkspaces, createSlotCache, orphanSources, worktreePathsOf } = await import('./resource-ipc.js')
const { slotStateOf } = await import('./retention.js')
type SlotOracle = NonNullable<Parameters<typeof orphanSources>[0]['slots']>
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

/** 자리 뿌리 확인 — 기본은 DEAD 뿌리만 확인된 죽은 자리, 나머지는 확인 전. */
const slotsOf = (states: Record<string, ReturnType<SlotOracle['state']>> = { [DEAD]: 'dead' }): SlotOracle => ({ state: (root) => states[root] ?? 'pending' })

const sources = (input: { workspaces: WorkspaceRow[]; present: string[]; worktrees?: readonly string[]; slots?: SlotOracle }) =>
  orphanSources({ workspaces: input.workspaces, homes: ['/home'], paths: disk(...input.present), worktreePaths: worktreePathsOf(state(input.worktrees)), slots: input.slots ?? slotsOf() })

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

describe('F1 — 자리 뿌리 파일시스템 확인이 dead 일 때만', () => {
  it('확인 전(pending)·확인 불가(unknown)·살아 있음(alive — 골격이 모르는 새 worktree·접근 거부·심링크)이면 주인 없음으로 올리지 않는다', () => {
    for (const value of ['pending', 'unknown', 'alive'] as const) {
      const [row] = sources({ workspaces: [orphan('w1', [DEAD])], present: [DEAD], slots: slotsOf({ [DEAD]: value }) })
      expect(row?.ownerless, value).toBe(false)
      expect(row?.paths, value).toEqual([{ path: DEAD, exists: true }])
    }
  })
  it('뿌리 확인은 자리 뿌리 하나로 묻는다 — 하위 경로 cwd 도 같은 뿌리', () => {
    const asked: string[] = []
    sources({ workspaces: [orphan('w1', [`${DEAD}/apps/api`])], present: [DEAD], slots: { state: (root) => { asked.push(root); return 'dead' } } })
    expect(asked).toEqual([DEAD])
  })
  it('createSlotCache — 첫 읽기는 pending, 확인이 끝나면 값, 확인이 던지면 unknown', async () => {
    const values = new Map<string, Promise<'dead'>>([[DEAD, Promise.resolve('dead')]])
    const cache = createSlotCache({ ttlMs: 5000, now: () => 0, check: (root) => values.get(root) ?? Promise.reject(new Error('EIO')) })
    expect(cache.state(DEAD)).toBe('pending')
    expect(cache.state('/other')).toBe('pending')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cache.state(DEAD)).toBe('dead')
    expect(cache.state('/other')).toBe('unknown')
  })
})

describe('closeOrphanWorkspaces — 「모두 닫기」 재확인도 같은 판정 (C6ⓑ)', () => {
  function deps(input: { cardless: WorkspaceRow[]; running?: boolean; worktrees?: readonly string[] }): Deps & { closed: string[]; probed: number } {
    const closed: string[] = []
    let probed = 0
    return {
      window: () => null, fromOurWindow: () => true, state: () => state(input.worktrees), socketPath: () => '/tmp/sock', paneIds: () => [],
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
  /** 닫기 재확인용 자리 확인 — 그 자리에서 새로 묻는 함수(G1). 기본은 DEAD 뿌리만 dead. */
  const checkOf = (states: Record<string, 'dead' | 'alive' | 'unknown'> = { [DEAD]: 'dead' }) => async (root: string) => states[root] ?? 'unknown'

  it('죽은 자리 줄은 대상에 들고 main 하위 폴더 줄은 not-ownerless 로 남는다 — 개수 확인(alwaysConfirm)을 거친 뒤 닫는다', async () => {
    const d = deps({ cardless })
    const paths = disk(DEAD, ROOT)
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['dead', 'sub'], bulk: true, paths, checkSlot: checkOf(), confirmed: false, confirmedPaneIds: [] }))
      .toEqual({ outcome: 'needs-confirm', closed: [], running: [], skipped: [{ workspaceId: 'sub', reason: 'not-ownerless' }] })
    expect(d.closed).toEqual([])
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['dead', 'sub'], bulk: true, paths, checkSlot: checkOf(), confirmed: true, confirmedPaneIds: [] }))
      .toEqual({ outcome: 'closed', closed: ['dead'], skipped: [{ workspaceId: 'sub', reason: 'not-ownerless' }] })
    expect(d.closed).toEqual(['dead'])
  })
  it('실행 중 확인 게이트(closeTabsGated)는 그대로 — 확인 안 한 실행 중 pane 이 있으면 닫지 않는다', async () => {
    const d = deps({ cardless, running: true })
    const result = await closeOrphanWorkspaces({ deps: d, workspaceIds: ['dead'], bulk: true, paths: disk(DEAD, ROOT), checkSlot: checkOf(), confirmed: true, confirmedPaneIds: [] })
    expect(result.outcome).toBe('needs-confirm')
    expect(d.closed).toEqual([])
    expect(d.probed).toBeGreaterThan(0)
  })
  it('F1 — 재확인 시점에 자리 확인이 dead 가 아니면(확인 전 포함) not-ownerless 로 닫지 않는다', async () => {
    const d = deps({ cardless })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['dead'], bulk: true, paths: disk(DEAD, ROOT), checkSlot: checkOf({}), confirmed: true, confirmedPaneIds: [] }))
      .toEqual({ outcome: 'closed', closed: [], skipped: [{ workspaceId: 'dead', reason: 'not-ownerless' }] })
    expect(d.closed).toEqual([])
  })
  it('G1 — 표시용 캐시가 낡은 `dead` 를 들고 있어도, 그 자리에 `.git` 이 생겼으면 「모두 닫기」 는 닫지 않는다(실제 디스크)', async () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'l694g1-'))
    try {
      const root = nodePath.join(tmp, 'r')
      const slot = nodePath.join(root, '.claude/worktrees/w-cache')
      fs.mkdirSync(nodePath.join(slot, 'apps'), { recursive: true })
      // 표시 쪽 캐시 — 시계를 멈춰 TTL 안에 둔다. 처음 확인은 dead(.git 없음).
      const cache = createSlotCache({ ttlMs: 5000, now: () => 0, check: slotStateOf })
      cache.state(slot)
      await vi.waitFor(() => expect(cache.state(slot)).toBe('dead'))
      // 그 사이 같은 자리에 worktree 가 생긴다.
      fs.writeFileSync(nodePath.join(slot, '.git'), 'gitdir: x\n')
      expect(cache.state(slot)).toBe('dead') // 캐시는 여전히 낡은 값 — 시험이 공허하지 않다
      const row = orphan('w-cache', [slot])
      const isDirectory = (target: string): boolean => fs.existsSync(target)
      const paths = { isDirectory, realPath: () => null, checked: () => true, settle: async (target: string) => isDirectory(target) }
      // 표시(주기 수집)는 캐시 그대로 — 아직 주인 없음으로 보인다.
      expect(orphanSources({ workspaces: [row], homes: ['/home'], paths, worktreePaths: [root], slots: cache })[0]?.ownerless).toBe(true)
      const d = deps({ cardless: [row], worktrees: [root] })
      expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['w-cache'], bulk: true, paths, checkSlot: slotStateOf, confirmed: true, confirmedPaneIds: [] }))
        .toEqual({ outcome: 'closed', closed: [], skipped: [{ workspaceId: 'w-cache', reason: 'not-ownerless' }] })
      expect(d.closed).toEqual([])
      // 양성 대조 — `.git` 이 없으면 같은 길로 닫힌다.
      fs.rmSync(nodePath.join(slot, '.git'))
      const d2 = deps({ cardless: [row], worktrees: [root] })
      expect((await closeOrphanWorkspaces({ deps: d2, workspaceIds: ['w-cache'], bulk: true, paths, checkSlot: slotStateOf, confirmed: true, confirmedPaneIds: [] })).closed).toEqual(['w-cache'])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
  it('G1 — 범위 판정 뒤 닫기 직전에 자리가 살아나면(prepare 재확인) 닫지 않고 not-ownerless', async () => {
    let calls = 0
    const flipping = async (): Promise<'dead' | 'alive'> => (++calls === 1 ? 'dead' : 'alive')
    const d = deps({ cardless: [orphan('dead', [DEAD])] })
    expect(await closeOrphanWorkspaces({ deps: d, workspaceIds: ['dead'], bulk: true, paths: disk(DEAD, ROOT), checkSlot: flipping, confirmed: true, confirmedPaneIds: [] }))
      .toEqual({ outcome: 'closed', closed: [], skipped: [{ workspaceId: 'dead', reason: 'not-ownerless' }] })
    expect(d.closed).toEqual([])
    expect(calls).toBe(2)
  })
})
