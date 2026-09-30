import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type OrchestrationLineage, type PaneRow, type RetainedAgentRow, type WorktreeRow } from '../../../shared/types.js'
import { WorktreeBlock } from './WorktreeBlock.js'
import { emptyAgentState } from '../../../shared/agent-state.js'

const captured = vi.hoisted(() => {
  const rows: Array<{ node: { key: string; activationPaneId: string | null; paneId: string }; onActivate: (paneId: string) => void; onClose: (paneId: string) => void }> = []
  return rows
})
vi.mock('./SessionRow.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./SessionRow.js')>()
  return {
    SessionRow: (props: ComponentProps<typeof original.SessionRow>) => {
      captured.push(props)
      return createElement(original.SessionRow, props)
    },
  }
})

function pane(id: string, agent: string | null, extra: Partial<PaneRow> = {}): PaneRow {
  return {
    paneId: id, tabId: 't1', workspaceId: 'w1', title: id, agent, agentStatus: 'idle', agentState: { ...emptyAgentState(0), observedAt: id === 'p1' ? 0 : 60000 },
    cwd: null, focused: false, agentSession: null,
    digest: { ...EMPTY_SESSION_DIGEST, providerTitle: `title-${id}`,
      activity: { state: 'text', text: `message-${id}`, at: null }, lastActivityAt: null },
    ...extra,
  }
}

const READY_EMPTY: OrchestrationLineage = { state: 'ready', entries: [] }

function render(panes: PaneRow[], options: {
  expanded?: boolean
  /** workspace 가 사라진 worktree (R1) */
  closed?: boolean
  retained?: RetainedAgentRow[]
  lineage?: OrchestrationLineage
  livePaneIds?: string[]
  onSelectSession?: (paneId: string) => void
  onCloseSession?: (paneId: string) => void
} = {}): string {
  const worktree: WorktreeRow = {
    path: '/repo', branch: 'main', isLinked: false, openWorkspaceId: options.closed === true ? null : 'w1',
    gitStatus: { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0,
      unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
    workspace: options.closed === true ? null : { workspaceId: 'w1', label: 'repo', number: 1, focused: true, agentStatus: 'idle',
      tabs: [{ tabId: 't1', workspaceId: 'w1', label: 'renamed tab', number: 1, order: 0,
        focused: true, agentStatus: 'blocked', panes,
        digest: { ...EMPTY_SESSION_DIGEST, providerTitle: 'wrong tab digest' } }] },
  }
  const noop = (): void => {}
  return renderToStaticMarkup(createElement(WorktreeBlock, {
    worktree, selected: true, selectedPane: 'p2', groupGlyph: null, integrations: [],
    home: '/home', now: 120000, retained: options.retained ?? [], lineage: options.lineage ?? READY_EMPTY,
    livePaneIds: new Set(options.livePaneIds ?? panes.map((row) => row.paneId)),
    groupExpanded: options.expanded ?? false, onToggleGroup: noop,
    onSelectBlock: noop, onSelectSession: options.onSelectSession ?? noop, onCloseSession: options.onCloseSession ?? noop, onCloseWorktree: noop,
    onCreateShell: noop, onCreateAgent: noop,
  }))
}

const rowsOf = (html: string): number => html.match(/data-agent-row="/g)?.length ?? 0

describe('WorktreeBlock 에이전트 목록 (LIFE-467 K2·K3)', () => {
  it('루트 1개면 알약 없이 단일 행이다', () => {
    const html = render([pane('p1', 'claude'), pane('p3', null)])
    expect(html).not.toContain('data-agent-group=')
    expect(rowsOf(html)).toBe(1)
    expect(html).toContain('title-p1 - message-p1')
    expect(html).not.toContain('data-pane="p3"') // 셸은 사이드바에 없다
    expect(html).not.toContain('wrong tab digest')
    expect(html).not.toContain('renamed tab')
  })

  it('루트 2개부터 알약이다 — 기본 접힘이고 행은 DOM 에 없다 (C3ⓑ)', () => {
    const html = render([pane('p1', 'claude'), pane('p2', 'codex')])
    expect(html).toContain('data-agent-group="/repo"')
    expect(html).toContain('data-agent-group-expanded="false"')
    expect(html).toContain('data-summary-cluster="idle"')
    expect(html).toContain('data-summary-count="2"')
    expect(rowsOf(html)).toBe(0)
    expect(html).not.toContain('data-tab=')
  })

  it('펼치면 알약이 「N agents」 머리줄이 되고 행이 선다', () => {
    const html = render([pane('p1', 'claude'), pane('p2', 'codex'), pane('p3', 'claude')], { expanded: true })
    expect(html).toContain('3 agents')
    expect(html).toContain('data-agent-group-expanded="true"')
    expect(rowsOf(html)).toBe(3)
    expect(html).toContain('data-pane="p2"')
    expect(html).toContain('data-focused-agent-pane="true"')
    expect(html).toContain('data-close-pane="p2"')
    // 시간 — observedAt 기준 (p1 0 → 2m, p2 60000 → 1m)
    expect(html).toContain('data-elapsed="2m"')
    expect(html).toContain('data-elapsed="1m"')
  })

  it('shell-only 탭에는 행이 없다', () => {
    const html = render([pane('shell', null)])
    expect(rowsOf(html)).toBe(0)
    expect(html).not.toContain('data-compact-agent-list')
  })

  it('안 본 완료(done) 행은 굵게 표시된다 (B1) — idle 은 아니다', () => {
    const html = render([pane('p1', 'claude', { agentStatus: 'done' })])
    expect(html).toContain('data-unseen-done="true"')
    expect(html).toContain('is-unseen-done')
    expect(render([pane('p1', 'claude')])).not.toContain('is-unseen-done')
  })

  it('모델이 있으면 mono 칸으로 그린다', () => {
    const html = render([pane('p1', 'claude', { digest: { ...EMPTY_SESSION_DIGEST, model: 'claude-opus-5-5' } })])
    expect(html).toContain('class="agent-row-model" title="claude-opus-5-5">claude-opus-5-5<')
  })

  it('계보 자식은 부모 아래 들여 쓰이고 루트 수에서 빠진다 — 루트가 1개면 알약이 없다', () => {
    const lineage: OrchestrationLineage = { state: 'ready', entries: [{ paneId: 'p2', runId: 'r', taskId: 't', dispatchId: 'd', dispatchStatus: 'dispatched', parentPaneId: 'p1' }] }
    const html = render([pane('p1', 'claude'), pane('p2', 'codex')], { lineage })
    expect(html).not.toContain('data-agent-group=')
    expect(html).toContain('data-agent-children="p1"')
    expect(html).toContain('data-agent-row-toggle="p1"')
    expect(html).toContain('data-agent-row="p2" data-agent-row-source="live" data-agent-row-depth="1"')
  })

  it('서브에이전트 자식 행은 아이콘이 없고 부모 아래에 선다', () => {
    const parent = pane('p1', 'claude', {
      digest: {
        ...EMPTY_SESSION_DIGEST,
        lifecycle: { state: 'known', tasks: [], taskOverflow: 0, subagentOverflow: 0,
          subagents: [{ id: 's1', name: 'reviewer', description: 'check the diff', agentType: 'general-purpose', background: false, startedAt: 60000, status: 'running' }] },
      },
    })
    const html = render([parent])
    expect(html).toContain('data-agent-row-source="subagent"')
    expect(html).toContain('reviewer - check the diff')
    const subRow = html.slice(html.indexOf('data-agent-row-source="subagent"'))
    expect(subRow.slice(0, subRow.indexOf('</div>'))).not.toContain('data-agent-kind=')
  })

  const gone: RetainedAgentRow = { paneId: 'gone', tabId: 't9', workspaceId: 'w1', title: 'finished job', agent: 'grok', agentStatus: 'done', agentState: { ...emptyAgentState(0), enteredDoneAt: 60000 }, cwd: '/repo', retainedAt: 90000 }
  it('보존 행(retained)은 살아 있는 행 뒤에 선다 (worktree 로 가르는 일은 Sidebar 의 retainedByWorktree)', () => {
    const html = render([pane('p1', 'claude')], { retained: [gone], expanded: true })
    expect(html).toContain('finished job - 닫힌 탭')
    expect(html.indexOf('data-agent-row="p1"')).toBeLessThan(html.indexOf('data-agent-row="retained:gone"'))
    expect(html).toContain('is-inert') // pane 이 없다 — 무반응
  })

  it('workspace 가 사라진 worktree 에도 보존 행이 선다 (R1)', () => {
    const html = render([], { closed: true, retained: [gone] })
    expect(html).toContain('data-compact-agent-list="/repo"')
    expect(html).toContain('data-agent-row="retained:gone"')
  })
})

it('행 콜백은 그 pane 을 고르고 그 pane 만 닫는다 — 죽은 보존 행은 무반응, 산 보존 행은 그 pane (B2)', () => {
  captured.length = 0
  const onSelectSession = vi.fn()
  const onCloseSession = vi.fn()
  const retained: RetainedAgentRow[] = [
    { paneId: 'dead', tabId: 't9', workspaceId: 'w1', title: 'a', agent: 'grok', agentStatus: 'done', agentState: emptyAgentState(0), cwd: null, retainedAt: 1 },
    { paneId: 'movedAway', tabId: 't8', workspaceId: 'w1', title: 'b', agent: 'grok', agentStatus: 'done', agentState: emptyAgentState(0), cwd: null, retainedAt: 1 },
  ]
  render([pane('p1', 'claude'), pane('p2', 'codex')], { expanded: true, retained, livePaneIds: ['p1', 'p2', 'movedAway'], onSelectSession, onCloseSession })
  const row = captured.find((props) => props.node.key === 'p2')!
  row.onActivate(row.node.activationPaneId!)
  row.onClose(row.node.paneId)
  expect(onSelectSession).toHaveBeenCalledExactlyOnceWith('p2')
  expect(onCloseSession).toHaveBeenCalledExactlyOnceWith('p2')
  expect(captured.find((props) => props.node.key === 'retained:dead')?.node.activationPaneId).toBeNull()
  expect(captured.find((props) => props.node.key === 'retained:movedAway')?.node.activationPaneId).toBe('movedAway')
})
