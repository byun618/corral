// 사이드바 행 나무 (LIFE-467 K3·K6·K7) — 행 글 폴백·계보·서브에이전트·보존·시간 기준.
import { describe, expect, it } from 'vitest'
import { EMPTY_SESSION_DIGEST, type OrchestrationLineage, type PaneRow, type RetainedAgentRow, type TabRow } from '../../shared/types.js'
import { emptyAgentState } from '../../shared/agent-state.js'
import { buildAgentRows, livePaneIdsOf, retainedByWorktree, SUMMARY_MIN_ROOTS } from './sidebar-agents.js'

function pane(id: string, agent: string | null, extra: Partial<PaneRow> = {}): PaneRow {
  return {
    paneId: id, tabId: `t-${id}`, workspaceId: 'w1', title: '', agent, agentStatus: 'idle', agentState: emptyAgentState(1000),
    cwd: null, focused: false, agentSession: null, digest: EMPTY_SESSION_DIGEST, ...extra,
  }
}
function tabs(panes: PaneRow[]): TabRow[] {
  return panes.map((row, index) => ({
    tabId: row.tabId, workspaceId: 'w1', label: '', number: index + 1, order: index, agentStatus: row.agentStatus, focused: false, panes: [row], digest: EMPTY_SESSION_DIGEST,
  }))
}
const lineageOf = (pairs: Array<[string, string | null]>): OrchestrationLineage => ({
  state: 'ready',
  entries: pairs.map(([paneId, parentPaneId]) => ({ paneId, parentPaneId, runId: 'r', taskId: 't', dispatchId: `d-${paneId}`, dispatchStatus: 'dispatched' })),
})
function build(panes: PaneRow[], options: { lineage?: OrchestrationLineage; retained?: RetainedAgentRow[]; live?: string[]; unread?: string[] } = {}) {
  return buildAgentRows({
    tabs: tabs(panes), retained: options.retained ?? [], lineage: options.lineage ?? { state: 'ready', entries: [] },
    livePaneIds: new Set(options.live ?? panes.map((row) => row.paneId)), integrations: [], home: '/home', unreadPanes: new Set(options.unread ?? []),
  })
}

describe('행 글 — codex·grok 은 providerTitle·tool 이 구조적으로 null 이다 (K3)', () => {
  it('codex: 제목도 뒤 글도 없으면 `codex 1` 한 칸 — 같은 말을 두 번 하지 않는다', () => {
    const [row] = build([pane('p1', 'codex')])
    expect(row?.text).toEqual({ leading: 'codex 1', trailing: null, full: 'codex 1' })
  })
  it('grok: 첫 발화가 제목이고 뒤 글이 없으면 종류 이름으로 채운다 (Orca 마지막 폴백)', () => {
    const [row] = build([pane('p1', 'grok', { digest: { ...EMPTY_SESSION_DIGEST, firstPrompt: 'fix the tests' } })])
    expect(row?.text.leading).toBe('fix the tests')
    expect(row?.text.trailing).toBe('grok')
  })
  it('codex: 마지막 발화가 있으면 그것이 뒤 글이다', () => {
    const [row] = build([pane('p1', 'codex', { digest: { ...EMPTY_SESSION_DIGEST, activity: { state: 'text', text: 'done editing', at: null } } })])
    expect(row?.text.full).toBe('codex 1 - done editing')
  })
  it('글이 비는 칸은 없다 — 세 provider 전부 앞 글이 있다', () => {
    for (const agent of ['claude', 'codex', 'grok']) expect(build([pane('p1', agent)])[0]?.text.leading.length).toBeGreaterThan(0)
  })
  it('claude: 작업 중 도구가 뒤 글이다', () => {
    const [row] = build([pane('p1', 'claude', { agentStatus: 'working', digest: { ...EMPTY_SESSION_DIGEST, providerTitle: 'Sleep 40 seconds', tool: { name: 'Bash', input: 'sleep 40' } } })])
    expect(row?.text.full).toBe('Sleep 40 seconds - Bash: sleep 40')
    expect(row?.dot).toBe('working')
  })
  it('monitoring 은 상태 이름을 앞에 두고 제목을 뒤로 민다 (Orca `:142-144`)', () => {
    const lifecycle = { state: 'known' as const, tasks: [{ id: 'b', kind: 'shell' as const, label: 'x', startedAt: 1 }], taskOverflow: 0, subagents: [], subagentOverflow: 0 }
    const [row] = build([pane('p1', 'claude', { digest: { ...EMPTY_SESSION_DIGEST, providerTitle: 'Build', lifecycle } })])
    expect(row?.dot).toBe('monitoring')
    expect(row?.text).toEqual({ leading: '백그라운드 작업 감시 중', trailing: 'Build', full: '백그라운드 작업 감시 중 - Build' })
  })
  it('중단된 턴은 「중단됨」이 뒤 글이다', () => {
    const [row] = build([pane('p1', 'claude', { digest: { ...EMPTY_SESSION_DIGEST, providerTitle: 'Refactor', turnOutcome: { outcome: 'interrupted', reason: null } } })])
    expect(row?.text.full).toBe('Refactor - 중단됨')
  })
})

describe('시간 기준 (K7 · D14)', () => {
  it('끝난 에이전트(idle·done)는 완료 시각(enteredDoneAt)', () => {
    const [row] = build([pane('p1', 'claude', { agentStatus: 'done', agentState: { ...emptyAgentState(5000), enteredDoneAt: 4000 } })])
    expect(row?.timeAt).toBe(4000)
  })
  it('이번 완료가 아닌 옛 done 시각은 안 쓴다 — done→idle(봄)→working→idle(보던 pane) 이면 지금 idle 관측 시각 (R3)', () => {
    const agentState = {
      ...emptyAgentState(660000), observedVia: 'event' as const, enteredDoneAt: 1000,
      history: [
        { status: 'working' as const, observedAt: 600000, observedVia: 'event' as const },
        { status: 'idle' as const, observedAt: 2000, observedVia: 'event' as const },
        { status: 'done' as const, observedAt: 1000, observedVia: 'event' as const },
      ],
    }
    expect(build([pane('p1', 'claude', { agentStatus: 'idle', agentState })])[0]?.timeAt).toBe(660000)
  })
  it('done→idle(봄) 직후는 그 done 시각을 지킨다 (R3)', () => {
    const agentState = {
      ...emptyAgentState(2000), observedVia: 'event' as const, enteredDoneAt: 1000,
      history: [
        { status: 'done' as const, observedAt: 1000, observedVia: 'event' as const },
        { status: 'working' as const, observedAt: 500, observedVia: 'event' as const },
      ],
    }
    expect(build([pane('p1', 'claude', { agentStatus: 'idle', agentState })])[0]?.timeAt).toBe(1000)
  })
  it('완료 기록이 없으면 지금 상태를 처음 본 시각(observedAt)', () => {
    expect(build([pane('p1', 'claude', { agentStatus: 'working', agentState: { ...emptyAgentState(7000), enteredDoneAt: 4000 } })])[0]?.timeAt).toBe(7000)
    expect(build([pane('p1', 'claude', { agentStatus: 'idle', agentState: emptyAgentState(7000) })])[0]?.timeAt).toBe(7000)
  })
})

describe('정렬 (K7 · D12) — 탭 목록 순서', () => {
  it('행은 탭 순서를 따른다', () => {
    expect(build([pane('b', 'claude'), pane('a', 'codex'), pane('c', 'grok')]).map((row) => row.paneId)).toEqual(['b', 'a', 'c'])
  })
})

describe('계보 (K6ⓑ)', () => {
  it('자식은 루트에서 빠지고 부모 children 에 선다', () => {
    const roots = build([pane('p1', 'claude'), pane('p2', 'codex'), pane('p3', 'grok')], { lineage: lineageOf([['p2', 'p1']]) })
    expect(roots.map((row) => row.paneId)).toEqual(['p1', 'p3'])
    expect(roots[0]?.children.map((row) => row.paneId)).toEqual(['p2'])
    expect(roots.length).toBeGreaterThanOrEqual(SUMMARY_MIN_ROOTS)
  })
  it('손자도 시각 깊이 1 — 루트 아래 깊이 우선으로 이어 붙는다', () => {
    const roots = build([pane('p1', 'claude'), pane('p2', 'codex'), pane('p3', 'grok')], { lineage: lineageOf([['p2', 'p1'], ['p3', 'p2']]) })
    expect(roots.map((row) => row.paneId)).toEqual(['p1'])
    expect(roots[0]?.children.map((row) => row.paneId)).toEqual(['p2', 'p3'])
    expect(roots[0]?.children.every((row) => row.children.length === 0)).toBe(true)
  })
  it('부모가 이 worktree 에 없으면 루트다', () => {
    expect(build([pane('p2', 'codex')], { lineage: lineageOf([['p2', 'elsewhere']]) }).map((row) => row.paneId)).toEqual(['p2'])
  })
  it('순환이 와도 행이 사라지지 않는다', () => {
    const roots = build([pane('p1', 'claude'), pane('p2', 'codex')], { lineage: lineageOf([['p1', 'p2'], ['p2', 'p1']]) })
    const all = roots.flatMap((row) => [row.paneId, ...row.children.map((child) => child.paneId)])
    expect(all.sort()).toEqual(['p1', 'p2'])
  })
  it('계보가 unavailable 이면 전부 루트다', () => {
    const roots = buildAgentRows({ tabs: tabs([pane('p1', 'claude'), pane('p2', 'codex')]), retained: [], lineage: { state: 'unavailable', reason: 'unobserved' }, livePaneIds: new Set(), integrations: [], home: '/', unreadPanes: new Set() })
    expect(roots).toHaveLength(2)
  })
})

describe('서브에이전트 자식 행 (K6ⓐ)', () => {
  const lifecycle = {
    state: 'known' as const, tasks: [], taskOverflow: 0, subagentOverflow: 0,
    subagents: [
      { id: 's1', name: null, description: 'Explore repo', agentType: 'Explore', background: false, startedAt: 3000, status: 'running' as const },
      { id: 's2', name: null, description: null, agentType: null, background: null, startedAt: null, status: 'running' as const },
    ],
  }
  it('부모 아래 아이콘 없는 행이고, 클릭은 부모 pane 이다', () => {
    const [root] = build([pane('p1', 'claude', { digest: { ...EMPTY_SESSION_DIGEST, lifecycle } })])
    expect(root?.children.map((row) => [row.source, row.showIcon, row.activationPaneId, row.text.full, row.timeAt])).toEqual([
      ['subagent', false, 'p1', 'Explore repo - Explore', 3000],
      ['subagent', false, 'p1', '서브에이전트', null],
    ])
    expect(root?.children[0]?.key).toBe('p1\u0000subagent:s1')
  })
  it('서브에이전트는 루트 수에 안 든다', () => {
    expect(build([pane('p1', 'claude', { digest: { ...EMPTY_SESSION_DIGEST, lifecycle } })])).toHaveLength(1)
  })
})

describe('보존 행 (K6ⓒ · B2)', () => {
  const kept = (paneId: string, workspaceId = 'w1'): RetainedAgentRow => ({
    paneId, tabId: 't', workspaceId, title: `job-${paneId}`, agent: 'grok', agentStatus: 'done', agentState: { ...emptyAgentState(0), enteredDoneAt: 900 }, cwd: null, retainedAt: 1000,
  })
  it('pane 이 없으면 무반응(activation null), 살아 있으면 그 pane', () => {
    const roots = build([pane('p1', 'claude')], { retained: [kept('dead'), kept('alive')], live: ['p1', 'alive'] })
    expect(roots.map((row) => [row.key, row.activationPaneId])).toEqual([['p1', 'p1'], ['retained:alive', 'alive'], ['retained:dead', null]])
  })
  it('완료 점 · 굵기 없음 · 시간은 완료 시각', () => {
    // LIFE-471 K4ⓓ — 보존 행도 확인 경계를 따른다: 확인 안 된 완료면 완료 점 + 굵게, 확인했으면 대기 점.
    const [, row] = build([pane('p1', 'claude')], { retained: [kept('dead')] })
    expect([row?.dot, row?.unseenDone, row?.timeAt, row?.text.full]).toEqual(['idle', false, 900, 'job-dead - 닫힌 탭'])
    const [, unread] = build([pane('p1', 'claude')], { retained: [kept('dead')], unread: ['dead'] })
    expect([unread?.dot, unread?.unseenDone]).toEqual(['done', true])
  })
  it('이미 산 행과 같은 pane 의 보존 행은 빠진다', () => {
    expect(build([pane('p1', 'claude')], { retained: [kept('p1')] }).map((row) => row.key)).toEqual(['p1'])
  })
  it('workspace 가 닫힌 worktree 도 보존 행을 그린다 — 마지막 pane 이 끝나고 workspace 가 사라진 경로 (R1)', () => {
    expect(buildAgentRows({ tabs: [], retained: [kept('a')], lineage: { state: 'ready', entries: [] }, livePaneIds: new Set(), integrations: [], home: '/', unreadPanes: new Set() }).map((row) => row.key)).toEqual(['retained:a'])
  })
})

describe('retainedByWorktree — 보존 행을 worktree 에 붙인다 (R1)', () => {
  const row = (paneId: string, workspaceId: string, cwd: string | null): RetainedAgentRow => ({
    paneId, tabId: 't', workspaceId, title: paneId, agent: 'grok', agentStatus: 'done', agentState: emptyAgentState(0), cwd, retainedAt: 1,
  })
  const repos = [{ worktrees: [
    { path: '/r', workspace: null },
    { path: '/r/.wt/feat', workspace: { workspaceId: 'w2' } },
    { path: '/other', workspace: { workspaceId: 'w9' } },
  ] }]
  it('workspace 가 사라져도 cwd 로 원래 worktree 를 찾는다 — 가장 구체적인 경로가 이긴다', () => {
    const got = retainedByWorktree({ repos, retained: [row('a', 'gone', '/r/src'), row('b', 'gone', '/r/.wt/feat/x')] })
    expect(got.get('/r')?.map((entry) => entry.paneId)).toEqual(['a'])
    expect(got.get('/r/.wt/feat')?.map((entry) => entry.paneId)).toEqual(['b'])
  })
  it('cwd 가 먼저다 — 재사용된 workspace id 가 다른 worktree 를 가리켜도 cwd 쪽에 붙는다', () => {
    expect(retainedByWorktree({ repos, retained: [row('a', 'w9', '/r')] }).get('/r')?.length).toBe(1)
  })
  it('cwd 가 없거나 밖이면 아직 열린 workspace 의 worktree 에 붙는다', () => {
    const got = retainedByWorktree({ repos, retained: [row('a', 'w2', null), row('b', 'w9', '/elsewhere')] })
    expect(got.get('/r/.wt/feat')?.map((entry) => entry.paneId)).toEqual(['a'])
    expect(got.get('/other')?.map((entry) => entry.paneId)).toEqual(['b'])
  })
  it('둘 다 안 되면 어디에도 안 붙는다 — 접두사만 같은 형제 경로(/r2)에 새지 않는다', () => {
    expect([...retainedByWorktree({ repos, retained: [row('a', 'gone', '/r2/x')] }).keys()]).toEqual([])
  })
})

it('livePaneIdsOf 는 앱 전체의 pane 을 모은다', () => {
  const repos = [{ worktrees: [{ workspace: { tabs: tabs([pane('a', 'claude'), pane('b', null)]) } }, { workspace: null }] }]
  expect([...livePaneIdsOf(repos)].sort()).toEqual(['a', 'b'])
})

describe('Full list 2·3줄 재료 (LIFE-477 K6ⓒⓓ) — 198 규칙 × provider', () => {
  const TOOL = { name: 'Bash', input: 'npm test' }
  const MSG = { state: 'text' as const, text: 'all green', at: null }
  const QUESTION = [{ header: null, question: 'proceed?', options: [], multiSelect: null }]
  const cases = [
    // [provider, 상태, 도구 있음] → 2줄
    { agent: 'claude', status: 'working', tool: true, want: 'tool' },
    { agent: 'claude', status: 'working', tool: false, want: 'placeholder' },
    { agent: 'claude', status: 'blocked', tool: true, waiting: true, want: 'tool' },
    { agent: 'claude', status: 'blocked', tool: false, waiting: true, want: 'none' },
    { agent: 'claude', status: 'idle', tool: true, want: 'none' },
    { agent: 'claude', status: 'done', tool: true, want: 'none' },
    { agent: 'codex', status: 'working', tool: false, want: 'placeholder' },
    { agent: 'codex', status: 'blocked', tool: false, waiting: true, want: 'none' },
    { agent: 'codex', status: 'idle', tool: false, want: 'none' },
    { agent: 'grok', status: 'working', tool: false, want: 'placeholder' },
    { agent: 'grok', status: 'blocked', tool: false, waiting: true, want: 'none' },
    { agent: 'grok', status: 'done', tool: false, want: 'none' },
  ] as const
  for (const item of cases) {
    it(`${item.agent} ${item.status}${'waiting' in item ? '(질문 대기)' : ''} 도구 ${item.tool ? '있음' : '없음'} → 2줄 ${item.want}`, () => {
      const [row] = build([
        pane('p1', item.agent, {
          agentStatus: item.status,
          digest: { ...EMPTY_SESSION_DIGEST, tool: item.tool ? TOOL : null, activity: MSG, pendingQuestions: 'waiting' in item ? QUESTION : null },
        }),
      ])
      expect(row?.full.tool.kind).toBe(item.want)
      if (item.want === 'tool') expect(row?.full.tool).toEqual({ kind: 'tool', name: 'Bash', input: 'npm test' })
      // 3줄은 도구와 따로 — 마지막 말이 그대로 남는다(compact 한 줄은 working 이면 도구가 말을 가린다).
      expect(row?.full.message).toBe('all green')
    })
  }

  it('monitoring 은 2줄이 없다(198 `!isMonitoring`) — 라벨은 앞뒤를 바꾸지 않은 제목 그대로', () => {
    const lifecycle = { state: 'known' as const, tasks: [{ id: 'b', kind: 'shell' as const, label: 'x', startedAt: 1 }], taskOverflow: 0, subagents: [], subagentOverflow: 0 }
    const [row] = build([pane('p1', 'claude', { digest: { ...EMPTY_SESSION_DIGEST, providerTitle: 'Build', lifecycle, tool: TOOL } })])
    expect(row?.dot).toBe('monitoring')
    expect(row?.full.tool.kind).toBe('none')
    expect(row?.full.label).toBe('Build')
  })

  it('중단된 턴 — 3줄 앞 「중단됨」 태그 + 마지막 말', () => {
    const [row] = build([pane('p1', 'codex', { digest: { ...EMPTY_SESSION_DIGEST, activity: MSG, turnOutcome: { outcome: 'interrupted', reason: null } } })])
    expect(row?.full.interrupted).toBe(true)
    expect(row?.full.message).toBe('all green')
  })

  it('말이 없으면 3줄 재료는 null(빈 자리) — 통지가 있으면 통지', () => {
    expect(build([pane('p1', 'grok')])[0]?.full.message).toBeNull()
    const [notice] = build([pane('p1', 'claude', { digest: { ...EMPTY_SESSION_DIGEST, activity: { state: 'unreadable', reason: 'EACCES' } } })])
    expect(notice?.full.message).toBe('기록을 읽지 못했다')
  })

  it('라벨 = compact 행 제목과 같은 출처(U1) — codex 는 첫 발화, 없으면 `codex 1`', () => {
    expect(build([pane('p1', 'codex', { digest: { ...EMPTY_SESSION_DIGEST, firstPrompt: 'fix lint' } })])[0]?.full.label).toBe('fix lint')
    expect(build([pane('p1', 'codex')])[0]?.full.label).toBe('codex 1')
  })

  it('보존 행 — 2줄 없음, 3줄 「닫힌 탭」', () => {
    const retained: RetainedAgentRow = {
      paneId: 'gone', tabId: 'tg', workspaceId: 'w1', agent: 'claude', agentStatus: 'done', title: 'old work', cwd: null, retainedAt: 5, agentState: emptyAgentState(1),
    }
    const rows = build([], { retained: [retained], live: [] })
    expect(rows[0]?.full).toEqual({ label: 'old work', tool: { kind: 'none' }, interrupted: false, message: '닫힌 탭' })
  })
})
