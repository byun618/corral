import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type PaneRow, type WorktreeRow } from '../../../shared/types.js'
import { WorktreeBlock } from './WorktreeBlock.js'
import { emptyAgentState } from '../../../shared/agent-state.js'

const captured = vi.hoisted(() => {
  const rows: Array<{ pane: PaneRow; onSelect: () => void; onClose: () => void }> = []
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

function pane(id: string, agent: string | null): PaneRow {
  return {
    paneId: id, tabId: 't1', workspaceId: 'w1', title: id, agent, agentStatus: 'idle', agentState: emptyAgentState(0),
    cwd: null, focused: false, agentSession: null,
    digest: { ...EMPTY_SESSION_DIGEST, providerTitle: `title-${id}`,
      activity: { state: 'text', text: `message-${id}`, at: null }, lastActivityAt: id === 'p1' ? 0 : 60000 },
  }
}

function render(panes: PaneRow[], collapsed = false, actions: {
  onSelectSession?: (pane: PaneRow) => void
  onCloseSession?: (paneId: string) => void
} = {}): string {
  const worktree: WorktreeRow = {
    path: '/repo', branch: 'main', isLinked: false, openWorkspaceId: 'w1',
    gitStatus: { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0,
      unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
    workspace: { workspaceId: 'w1', label: 'repo', number: 1, focused: true, agentStatus: 'idle',
      tabs: [{ tabId: 't1', workspaceId: 'w1', label: 'renamed tab', number: 1, order: 0,
        focused: true, agentStatus: 'blocked', panes,
        digest: { ...EMPTY_SESSION_DIGEST, providerTitle: 'wrong tab digest' } }] },
  }
  const noop = (): void => {}
  return renderToStaticMarkup(createElement(WorktreeBlock, {
    worktree, selected: true, selectedPane: 'p2', groupGlyph: null, integrations: [],
    home: '/home', now: 120000, groupCollapsed: collapsed, onToggleGroup: noop,
    onSelectBlock: noop, onSelectSession: noop, onCloseSession: noop, onCloseWorktree: noop,
    onCreateShell: noop, onCreateAgent: noop, ...actions,
  }))
}

describe('WorktreeBlock pane sessions', () => {
  it('one tab with two agents and a shell renders two independently titled rows', () => {
    const html = render([pane('p1', 'claude'), pane('p2', 'codex'), pane('p3', null)])
    expect(html.match(/class="session-row /g)).toHaveLength(2)
    expect(html).toContain('title-p1 - message-p1')
    expect(html).toContain('title-p2 - message-p2')
    expect(html).toContain('data-elapsed="2m"')
    expect(html).toContain('data-elapsed="1m"')
    expect(html).toContain('class="session-row is-active" data-tab="t1" data-pane="p2"')
    expect(html).toContain('data-close-pane="p2"')
    expect(html).not.toContain('wrong tab digest')
    expect(html).not.toContain('renamed tab')
    expect(html).not.toContain('data-pane="p3"')
    expect(html).not.toContain('agent-group-header')
  })

  it('three panes in one tab reach the group threshold and collapse to three sessions', () => {
    const panes = [pane('p1', 'claude'), pane('p2', 'codex'), pane('p3', 'claude')]
    const expanded = render(panes)
    expect(expanded).toContain('3 agents')
    expect(expanded.match(/class="session-row /g)).toHaveLength(3)
    const collapsed = render(panes, true)
    expect(collapsed).toContain('3 agents')
    expect(collapsed).toContain('data-summary-count="3"')
    expect(collapsed).not.toContain('class="session-row ')
  })

  it('shell-only tabs have no sidebar rows', () => {
    expect(render([pane('shell', null)])).not.toContain('class="session-row ')
  })
})

it('row callbacks select the exact pane and close only that pane', () => {
  captured.length = 0
  const first = pane('p1', 'claude')
  const second = pane('p2', 'codex')
  const onSelectSession = vi.fn()
  const onCloseSession = vi.fn()
  render([first, second], false, { onSelectSession, onCloseSession })
  const row = captured.find((props) => props.pane.paneId === 'p2')!
  row.onSelect()
  row.onClose()
  expect(onSelectSession).toHaveBeenCalledExactlyOnceWith(second)
  expect(onCloseSession).toHaveBeenCalledExactlyOnceWith('p2')
})
