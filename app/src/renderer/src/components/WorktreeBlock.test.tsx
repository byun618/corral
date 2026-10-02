import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type OrchestrationLineage, type PaneRow, type RetainedAgentRow, type WorktreeRow } from '../../../shared/types.js'
import { NO_CARD_ACTIONS, WorktreeBlock, type CardActions } from './WorktreeBlock.js'
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
  /** LIFE-477 카드 표시 */
  layout?: 'detailed' | 'compact'
  showAgents?: boolean
  agentLayout?: 'compact' | 'full'
  dirty?: boolean
  linked?: boolean
  repoLabel?: string | null
  displayName?: string | null
  comment?: string | null
  parentPath?: string | null
  card?: Partial<CardActions>
  /** LIFE-471 확인 안 된 완료가 있는 pane */
  unread?: string[]
} = {}): string {
  const worktree: WorktreeRow = {
    path: '/repo', branch: 'main', isLinked: options.linked ?? false, openWorkspaceId: options.closed === true ? null : 'w1',
    gitStatus: { branch: 'main', upstream: null, ahead: null, behind: null, staged: 0,
      unstaged: options.dirty === true ? 2 : 0, untracked: 0, conflicted: 0, dirty: options.dirty === true, error: null },
    workspace: options.closed === true ? null : { workspaceId: 'w1', label: 'repo', number: 1, focused: true, agentStatus: 'idle',
      tabs: [{ tabId: 't1', workspaceId: 'w1', label: 'renamed tab', number: 1, order: 0,
        focused: true, agentStatus: 'blocked', panes,
        digest: { ...EMPTY_SESSION_DIGEST, providerTitle: 'wrong tab digest' } }] },
    displayName: options.displayName ?? null, comment: options.comment ?? null, parentPath: options.parentPath ?? null,
  }
  const noop = (): void => {}
  return renderToStaticMarkup(createElement(WorktreeBlock, {
    worktree, reordering: false, dragging: false, onCardMouseDown: noop, selected: true, selectedPane: 'p2', groupGlyph: null, integrations: [],
    home: '/home', now: 120000, retained: options.retained ?? [], lineage: options.lineage ?? READY_EMPTY,
    livePaneIds: new Set(options.livePaneIds ?? panes.map((row) => row.paneId)), unreadPanes: new Set(options.unread ?? []),
    groupExpanded: options.expanded ?? false, onToggleGroup: noop,
    onSelectBlock: noop, onSelectSession: options.onSelectSession ?? noop, onCloseSession: options.onCloseSession ?? noop, onCloseWorktree: noop,
    onCreateShell: noop, onCreateAgent: noop,
    layout: options.layout, showAgents: options.showAgents, agentLayout: options.agentLayout, repoLabel: options.repoLabel,
    card: { ...NO_CARD_ACTIONS, ...options.card },
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

  it('안 본 완료 행은 굵게 표시된다 (B1) — 출처는 corral 안 읽음 장부(LIFE-471), herdr done 이 아니다', () => {
    const html = render([pane('p1', 'claude', { agentStatus: 'idle' })], { unread: ['p1'] })
    expect(html).toContain('data-unseen-done="true"')
    expect(html).toContain('is-unseen-done')
    // K4ⓑ — herdr 가 아직 done 이어도 확인했으면(장부에 없음) 굵지 않고 완료 점도 아니다(#20940).
    const acked = render([pane('p1', 'claude', { agentStatus: 'done' })])
    expect(acked).not.toContain('is-unseen-done')
    expect(acked).not.toContain('data-worktree-status="done"')
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

describe('카드 표시 (LIFE-477 K2·K3·K4·K6)', () => {
  const two = (): PaneRow[] => [pane('p1', 'claude'), pane('p2', 'codex')]
  const fullRows = (html: string): number => html.match(/data-agent-full-row=""/g)?.length ?? 0

  it('기본(props 없음)은 지금 화면 — Detailed · 메타 줄 · 「기본」 칩 · compact 목록', () => {
    const html = render(two())
    expect(html).toContain('data-card-layout="detailed"')
    expect(html).toContain('data-worktree-card-meta-row')
    expect(html).toContain('data-worktree-primary-badge')
    expect(html).not.toContain('data-worktree-primary-star')
    expect(html).toContain('data-compact-agent-list="/repo"')
    expect(html).not.toContain('data-full-agent-list')
  })

  it('K2ⓐ Compact — 메타 줄 없음 · ★ · 「기본」 칩 없음 · 레포 칩(None 그룹) · git 마크는 제목 줄에 없다', () => {
    const html = render(two(), { layout: 'compact', showAgents: false, dirty: true, repoLabel: 'corral' })
    expect(html).toContain('data-card-layout="compact"')
    expect(html).toContain('is-compact')
    expect(html).not.toContain('data-worktree-card-meta-row')
    expect(html).not.toContain('data-worktree-meta-branch')
    expect(html).toContain('data-worktree-primary-star')
    expect(html).not.toContain('data-worktree-primary-badge')
    expect(html).toContain('data-worktree-repo-chip="" title="corral">corral</span>')
    expect(html).not.toContain('worktree-mark')
  })

  it('K2ⓑ Compact 카드는 에이전트 목록이 없고 상태 점은 남는다', () => {
    const html = render(two(), { layout: 'compact', showAgents: false })
    expect(rowsOf(html)).toBe(0)
    expect(html).not.toContain('data-agent-group=')
    expect(html).toContain('worktree-status-slot')
  })

  it('K3ⓐ Compact 제목 — git 마크가 있으면 hover 트리거(tabIndex 0, 네이티브 툴팁 없음), 없으면 트리거 아님', () => {
    const dirty = render([], { layout: 'compact', showAgents: false, dirty: true })
    expect(dirty).toContain('data-hover-card-trigger="/repo"')
    expect(dirty).toMatch(/data-hover-card-trigger="\/repo"[^>]*tabindex="0"|tabindex="0"[^>]*data-hover-card-trigger/)
    const clean = render([], { layout: 'compact', showAgents: false })
    expect(clean).not.toContain('data-hover-card-trigger')
    expect(clean).toContain('title="main\n/repo"')
  })

  it('K3ⓒ Detailed 는 제목 hover 트리거가 없고 git 마크는 메타 줄 그대로', () => {
    const html = render([], { dirty: true })
    expect(html).not.toContain('data-hover-card-trigger')
    expect(html).toContain('worktree-mark tone-dirty')
  })

  it('K4ⓐ 에이전트 활동 끔 — 목록(알약·행) 전부 없고 상태 점은 남는다', () => {
    const html = render(two(), { showAgents: false, expanded: true })
    expect(rowsOf(html)).toBe(0)
    expect(html).not.toContain('data-agent-group=')
    expect(html).not.toContain('data-compact-agent-list')
    expect(html).toContain('worktree-status-slot')
    expect(html).toContain('data-worktree-card-meta-row')
  })

  it('K6ⓐ Full list — 루트마다 3줄 행, 묶음 알약 없음(접힘 상태와 무관)', () => {
    const html = render(two(), { agentLayout: 'full', expanded: false })
    expect(html).not.toContain('data-agent-group=')
    expect(fullRows(html)).toBe(2)
    expect(html).toContain('data-full-agent-list="/repo"')
    expect(html).not.toContain('session-row')
    expect(html.match(/data-agent-row-message/g)?.length).toBe(2)
  })

  it('K6ⓔ Full list 자식은 기본 펼침 — 부모에 셰브론', () => {
    const lineage: OrchestrationLineage = { state: 'ready', entries: [{ paneId: 'p2', parentPaneId: 'p1', runId: 'r', taskId: 't', dispatchId: 'd', dispatchStatus: 'dispatched' }] }
    const html = render(two(), { agentLayout: 'full', lineage })
    expect(fullRows(html)).toBe(2)
    expect(html).toContain('data-agent-children="p1"')
    expect(html).toContain('data-agent-row-toggle="p1"')
    expect(html).toContain('aria-expanded="true"')
  })

  it('K6ⓖ 에이전트 레이아웃 Full list 여도 Compact 카드는 목록이 없다', () => {
    const html = render(two(), { layout: 'compact', showAgents: false, agentLayout: 'full' })
    expect(fullRows(html)).toBe(0)
  })
})

describe('WorktreeBlock 카드 메뉴 표시 (LIFE-478)', () => {
  it('K3ⓓ 제목 = 표시 이름, Detailed 메타 줄은 브랜치를 그대로 보인다(198 처럼 브랜치를 볼 수 있다)', () => {
    const html = render([], { displayName: '내 작업' })
    expect(html).toMatch(/data-worktree-title=""[^>]*>내 작업</)
    expect(html).toContain('data-worktree-meta-branch=""')
    expect(html).toMatch(/data-worktree-meta-branch="" title="main">main</)
  })
  it('K3ⓔ comment 가 있으면 노트 배지(hover 트리거), 없으면 없다', () => {
    expect(render([], { comment: '메모' })).toContain('data-worktree-note-badge=""')
    expect(render([], { comment: '메모' })).toContain('data-hover-card-trigger="/repo#note"')
    expect(render([])).not.toContain('data-worktree-note-badge')
  })
  it('K3ⓔ·K6ⓔ Compact 제목 hover 는 comment·상위가 있으면 열 이유가 된다', () => {
    expect(render([], { layout: 'compact' })).not.toContain('data-hover-card-trigger="/repo"')
    expect(render([], { layout: 'compact', comment: '메모' })).toContain('data-hover-card-trigger="/repo"')
    expect(render([], { layout: 'compact', card: { parentName: 'parent' } })).toContain('data-hover-card-trigger="/repo"')
  })
  it('K6ⓔ 상위 워크트리는 Detailed 메타 줄에 이름으로', () => {
    expect(render([], { parentPath: '/repo/p', card: { parentName: '부모' } })).toMatch(/data-worktree-parent="\/repo\/p"[^>]*>↳ 부모</)
  })
  it('K3ⓐ rename 중이면 제목 자리에 입력(단축키 양보 표지 data-inline-rename)', () => {
    const html = render([], { displayName: 'abc', card: { renaming: true } })
    expect(html).toContain('data-inline-rename="/repo"')
    expect(html).toContain('value="abc"')
    expect(html).not.toContain('data-worktree-title=""')
  })
  it('K7ⓕ 삭제 중 → 흐림 + 「삭제 중…」, ⋯·+ 단추 없음', () => {
    const html = render([], { linked: true, card: { deleting: true } })
    expect(html).toContain('data-worktree-deleting=""')
    expect(html).toContain('삭제 중…')
    expect(html).not.toContain('data-worktree-actions=')
  })
  it('K5ⓕ 고정 구획 카드(reorderable=false)는 끌기 표지가 없다', () => {
    expect(render([])).toContain('data-reorder-card="/repo"')
    const pinned = render([], { card: { reorderable: false, pinned: true } })
    expect(pinned).not.toContain('data-reorder-card=')
    expect(pinned).toContain('data-worktree-pinned=""')
  })
})
