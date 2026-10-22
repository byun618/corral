import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type PaneRow, type WorkspaceRow } from '../shared/types.js'
import { emptyAgentState } from '../shared/agent-state.js'
vi.mock('./adapter/index.js', () => ({ readOpenWorkspaces: vi.fn() }))
import { attachDigests, cardlessGate, cardlessWorkspaces, collectSessionRefs, joinTree, readClaimedWorkspaceIds, type RepoSkeleton } from './tree.js'
import { readSessionDigests } from './transcript.js'

function pane(id: string, sessionId: string | null): PaneRow {
  return { paneId: id, tabId: 't1', workspaceId: 'w1', title: id, agent: sessionId && 'claude',
    agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: false, digest: EMPTY_SESSION_DIGEST,
    agentSession: sessionId ? { kind: 'id', agent: 'claude', source: 'herdr:claude', id: sessionId } : null }
}
function workspace(panes: PaneRow[]): WorkspaceRow {
  return { workspaceId: 'w1', label: 'repo', number: 1, focused: true, agentStatus: 'idle',
    tabs: [{ tabId: 't1', workspaceId: 'w1', label: '1', number: 1, order: 0, focused: true,
      agentStatus: 'idle', panes, digest: EMPTY_SESSION_DIGEST }] }
}

describe('pane digest attachment', () => {
  it('collects every pane reference and preserves first-session tab digest behavior', () => {
    const shell = pane('shell', null)
    const first = pane('p1', 'session-a')
    const second = pane('p2', 'session-b')
    const input = [workspace([shell, first, second])]
    expect([...collectSessionRefs(input)]).toEqual([
      ['shell', null], ['p1', first.agentSession], ['p2', second.agentSession],
    ])
    const a = { ...EMPTY_SESSION_DIGEST, providerTitle: 'A' }
    const b = { ...EMPTY_SESSION_DIGEST, providerTitle: 'B' }
    const result = attachDigests(input, new Map([['p1', a], ['p2', b]]))[0]!.tabs[0]!
    expect(result.digest).toBe(a)
    expect(result.panes.map((p) => p.digest)).toEqual([EMPTY_SESSION_DIGEST, a, b])
    expect(input[0]!.tabs[0]!.panes[1]!.digest).toBe(EMPTY_SESSION_DIGEST)
  })

  it('missing reads keep empty defaults; closing the first session promotes the next for the tab', () => {
    const remaining = pane('p2', 'session-b')
    const b = { ...EMPTY_SESSION_DIGEST, firstPrompt: 'B' }
    expect(attachDigests([workspace([remaining])], new Map([['p2', b]]))[0]!.tabs[0]!.digest).toBe(b)
    expect(attachDigests([workspace([remaining])], new Map())[0]!.tabs[0]!.panes[0]!.digest).toBe(EMPTY_SESSION_DIGEST)
  })
})

it('reads two different transcript files for two panes in one tab', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l387-pane-digests-'))
  try {
    const panes = ['a', 'b'].map((id, index) => {
      const file = path.join(dir, `${id}.jsonl`)
      const timestamp = new Date(100000 + index * 60000).toISOString()
      fs.writeFileSync(file, [
        { type: 'event_msg', timestamp, payload: { type: 'user_message', message: `prompt ${id}` } },
        { type: 'response_item', timestamp, payload: { role: 'assistant', content: [{ type: 'output_text', text: `answer ${id}` }] } },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n')
      const row = pane(id, null)
      row.agent = 'codex'
      row.agentSession = { kind: 'path', agent: 'codex', source: 'herdr:codex', path: file }
      return row
    })
    const input = [workspace(panes)]
    const reads = readSessionDigests(collectSessionRefs(input))
    const result = attachDigests(input, reads.digests)[0]!.tabs[0]!
    expect(result.panes.map((row) => row.digest.firstPrompt)).toEqual(['Prompt a', 'Prompt b'])
    expect(result.panes.map((row) => row.digest.activity)).toEqual([
      { state: 'text', text: 'answer a', at: 100000 },
      { state: 'text', text: 'answer b', at: 160000 },
    ])
    expect(result.panes.map((row) => row.digest.lastActivityAt)).toEqual([100000, 160000])
    expect(result.digest).toEqual(result.panes[0]!.digest)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('cardlessWorkspaces (LIFE-628 S1)', () => {
  const ws = (id: string): WorkspaceRow => ({ ...workspace([]), workspaceId: id })
  const status = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
  const wt = (path: string, open: string | null) => ({ path, branch: null, head: null, isLinked: true, openWorkspaceId: open, gitStatus: status })
  const skeleton: RepoSkeleton[] = [{ root: '/r', name: 'r', error: null, gitError: null, openError: null, worktrees: [wt('/r', 'w1'), wt('/r/a', 'w2'), wt('/r/a/b', 'w2'), wt('/r/c', null)] }]

  it('카드 귀속(골격의 openWorkspaceId — 이중 바인딩 포함)을 뺀 나머지 = joinTree 가 붙이지 않은 집합 (K1ⓔ)', () => {
    const rows = [ws('w1'), ws('w2'), ws('w3'), ws('w4')]
    const cardless = cardlessWorkspaces({ skeleton, workspaces: rows }).map((row) => row.workspaceId)
    expect(cardless).toEqual(['w3', 'w4'])
    const attached = joinTree(skeleton, rows).repos.flatMap((repo) => repo.worktrees).flatMap((worktree) => (worktree.workspace === null ? [] : [worktree.workspace.workspaceId]))
    expect(attached.filter((id) => cardless.includes(id))).toEqual([])
    expect(new Set([...attached, ...cardless])).toEqual(new Set(rows.map((row) => row.workspaceId)))
  })
  it('골격이 비면(레포 없음) 전부 카드 밖', () => {
    expect(cardlessWorkspaces({ skeleton: [], workspaces: [ws('w1')] }).map((row) => row.workspaceId)).toEqual(['w1'])
  })

  // fix r2 G2·G7 — 권위 재독(index.ts claimedWorkspaceIdsNow 의 본체).
  describe('readClaimedWorkspaceIds', () => {
    const map = (entries: [string, string][], prunable: string[] = [], error: string | null = null) => ({ byPath: new Map(entries), prunable: new Set(prunable), repoName: null, error })
    it('루트마다 읽어 합집합', async () => {
      const reads: Record<string, ReturnType<typeof map>> = { '/a': map([['/a', 'w1'], ['/a/x', 'w2']]), '/b': map([['/b', 'w3']]) }
      const claimed = await readClaimedWorkspaceIds({ roots: ['/a', '/b'], read: async (root) => reads[root] ?? map([]), log: () => {} })
      expect(claimed).toEqual(new Set(['w1', 'w2', 'w3']))
    })
    it('둘째 루트 읽기가 실패하면 null(첫째가 성공했어도)', async () => {
      const logs: string[] = []
      const claimed = await readClaimedWorkspaceIds({ roots: ['/a', '/b'], read: async (root) => (root === '/b' ? map([], [], 'timeout') : map([['/a', 'w1']])), log: (tag) => logs.push(tag) })
      expect(claimed).toBeNull()
      expect(logs).toEqual(['resource.claimed_read_failed'])
    })
    it('prunable 경로의 id 는 귀속으로 세지 않는다 — 같은 id 가 살아 있는 경로에도 붙어 있으면 센다', async () => {
      const claimed = await readClaimedWorkspaceIds({ roots: ['/a'], read: async () => map([['/a', 'w1'], ['/a/gone', 'w2'], ['/a/gone2', 'w3'], ['/a/live', 'w3']], ['/a/gone', '/a/gone2']), log: () => {} })
      expect(claimed).toEqual(new Set(['w1', 'w3']))
    })
    it('루트가 없으면 빈 집합', async () => {
      expect(await readClaimedWorkspaceIds({ roots: [], read: async () => map([]), log: () => {} })).toEqual(new Set())
    })
  })

  // fix r1 F1·F2·F6 — 카드 밖 판정 가드(예전 index.ts cardlessNow)를 순수 함수로. 가드 하나하나가 null(보류)을 만든다.
  describe('cardlessGate', () => {
    const rows = [ws('w1'), ws('w2'), ws('w3')]
    const seen = new Map([['w1', 10], ['w2', 10], ['w3', 10]])
    const ok = { socketPath: '/s', skeleton, skeletonSocket: '/s', skeletonStartedAt: 100, linkPhase: 'live' as const, ownSession: true, workspaces: rows, firstSeenAt: seen }
    const ids = (gate: ReturnType<typeof cardlessGate>): string[] | null => (gate === null ? null : gate.rows.map((row) => row.workspaceId))

    it('모든 가드를 지나면 카드 밖 = 골격이 귀속하지 않은 workspace', () => {
      expect(ids(cardlessGate(ok))).toEqual(['w3'])
    })
    it('세션 소켓이 없으면 보류', () => {
      expect(cardlessGate({ ...ok, socketPath: null })).toBeNull()
      // 골격도 소켓 없이 지어진 상태(둘 다 null)여도 보류 — 불일치 가드만으로는 못 막는다.
      expect(cardlessGate({ ...ok, socketPath: null, skeletonSocket: null })).toBeNull()
    })
    it('골격이 다른 소켓에서 지어졌으면 보류', () => {
      expect(cardlessGate({ ...ok, skeletonSocket: '/old' })).toBeNull()
    })
    it('골격이 아직 없으면(완성 시각 없음) 보류', () => {
      expect(cardlessGate({ ...ok, skeletonStartedAt: null })).toBeNull()
    })
    it('링크가 live 가 아니면 보류', () => {
      for (const linkPhase of ['idle', 'connecting', 'snapshotting', 'reconnecting', 'failed'] as const) expect(cardlessGate({ ...ok, linkPhase })).toBeNull()
    })
    it('남의 세션(소유 아님)이면 보류', () => {
      expect(cardlessGate({ ...ok, ownSession: false })).toBeNull()
    })
    it('F1 — 어느 레포든 git worktree list 가 실패한 골격이면 보류(그 레포 카드 workspace 가 카드 밖으로 새지 않는다)', () => {
      const broken: RepoSkeleton = { root: '/q', name: 'q', error: 'git: timeout', gitError: 'git: timeout', openError: null, worktrees: [] }
      expect(cardlessGate({ ...ok, skeleton: [...skeleton, broken] })).toBeNull()
    })
    it('F1 — 어느 레포든 herdr worktree.list 가 실패한 골격이면 보류', () => {
      const broken: RepoSkeleton = { ...skeleton[0]!, root: '/q', openError: 'herdr: timeout' }
      expect(cardlessGate({ ...ok, skeleton: [...skeleton, broken] })).toBeNull()
    })
    it('F2 — 골격을 짓기 시작한 뒤 처음 보인 workspace 는 다음 골격 전까지 목록에 올리지 않는다(fresh 로 센다)', () => {
      const late = new Map([...seen, ['w3', 101]])
      expect(cardlessGate({ ...ok, firstSeenAt: late })).toEqual({ rows: [], fresh: 1 })
      const unseen = new Map([['w1', 10], ['w2', 10]])
      expect(cardlessGate({ ...ok, firstSeenAt: unseen })).toEqual({ rows: [], fresh: 1 })
      // 다음 골격(시작 시각이 처음 본 시각 뒤)이면 올린다.
      expect(ids(cardlessGate({ ...ok, firstSeenAt: late, skeletonStartedAt: 200 }))).toEqual(['w3'])
      // 같은 시각(골격 시작 전에 기록)은 올린다.
      expect(ids(cardlessGate({ ...ok, firstSeenAt: new Map([...seen, ['w3', 100]]) }))).toEqual(['w3'])
    })
  })
})

