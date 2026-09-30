// 사이드바 행 나무 (LIFE-467 K3·K6·K7) — 행 글 폴백·계보·서브에이전트·보존·시간 기준.
import { describe, expect, it } from 'vitest'
import { EMPTY_SESSION_DIGEST, type OrchestrationLineage, type PaneRow, type RetainedAgentRow, type TabRow } from '../../shared/types.js'
import { emptyAgentState } from '../../shared/agent-state.js'
import { buildAgentRows, livePaneIdsOf, SUMMARY_MIN_ROOTS } from './sidebar-agents.js'

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
function build(panes: PaneRow[], options: { lineage?: OrchestrationLineage; retained?: RetainedAgentRow[]; live?: string[] } = {}) {
  return buildAgentRows({
    tabs: tabs(panes), workspaceId: 'w1', retained: options.retained ?? [], lineage: options.lineage ?? { state: 'ready', entries: [] },
    livePaneIds: new Set(options.live ?? panes.map((row) => row.paneId)), integrations: [], home: '/home',
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
    const roots = buildAgentRows({ tabs: tabs([pane('p1', 'claude'), pane('p2', 'codex')]), workspaceId: 'w1', retained: [], lineage: { state: 'unavailable', reason: 'unobserved' }, livePaneIds: new Set(), integrations: [], home: '/' })
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
    paneId, tabId: 't', workspaceId, title: `job-${paneId}`, agent: 'grok', agentStatus: 'done', agentState: { ...emptyAgentState(0), enteredDoneAt: 900 }, retainedAt: 1000,
  })
  it('pane 이 없으면 무반응(activation null), 살아 있으면 그 pane', () => {
    const roots = build([pane('p1', 'claude')], { retained: [kept('dead'), kept('alive')], live: ['p1', 'alive'] })
    expect(roots.map((row) => [row.key, row.activationPaneId])).toEqual([['p1', 'p1'], ['retained:alive', 'alive'], ['retained:dead', null]])
  })
  it('완료 점 · 굵기 없음 · 시간은 완료 시각', () => {
    const [, row] = build([pane('p1', 'claude')], { retained: [kept('dead')] })
    expect([row?.dot, row?.unseenDone, row?.timeAt, row?.text.full]).toEqual(['done', false, 900, 'job-dead - 닫힌 탭'])
  })
  it('다른 workspace 의 보존 행과 이미 산 행과 같은 pane 은 빠진다', () => {
    expect(build([pane('p1', 'claude')], { retained: [kept('x', 'w2'), kept('p1')] }).map((row) => row.key)).toEqual(['p1'])
  })
  it('workspace 가 닫힌 worktree 는 보존 행을 안 그린다', () => {
    expect(buildAgentRows({ tabs: [], workspaceId: null, retained: [kept('a')], lineage: { state: 'ready', entries: [] }, livePaneIds: new Set(), integrations: [], home: '/' })).toEqual([])
  })
})

it('livePaneIdsOf 는 앱 전체의 pane 을 모은다', () => {
  const repos = [{ worktrees: [{ workspace: { tabs: tabs([pane('a', 'claude'), pane('b', null)]) } }, { workspace: null }] }]
  expect([...livePaneIdsOf(repos)].sort()).toEqual(['a', 'b'])
})
