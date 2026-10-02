// @vitest-environment happy-dom
// LIFE-471 K5 카드 벨 — 198 classic `showUnreadQuickAction`: 상태 칸 = 토글 버튼, 벨 켜짐이면 상태 표시를 대체하는 채운 벨,
// 꺼짐이면 상태 표시 + hover 흐린 벨. 클릭 = 토글, 카드 활성화·끌기 시작 없음(ⓒ).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type OrchestrationLineage, type PaneRow, type WorktreeRow } from '../../../shared/types.js'
import { emptyAgentState } from '../../../shared/agent-state.js'
import { NO_CARD_ACTIONS, WorktreeBlock } from './WorktreeBlock.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const READY_EMPTY: OrchestrationLineage = { state: 'ready', entries: [] }
const pane = (paneId: string, agentStatus: PaneRow['agentStatus']): PaneRow => ({
  paneId, tabId: 't1', workspaceId: 'w1', title: paneId, agent: 'claude', agentStatus, agentState: emptyAgentState(0), cwd: null, focused: false, agentSession: null,
  digest: EMPTY_SESSION_DIGEST,
})
function worktree(panes: PaneRow[]): WorktreeRow {
  return {
    path: '/repo/wt', branch: 'feat', isLinked: true, openWorkspaceId: 'w1',
    gitStatus: { branch: 'feat', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
    workspace: { workspaceId: 'w1', label: 'repo', number: 1, focused: true, agentStatus: 'idle', tabs: [{ tabId: 't1', workspaceId: 'w1', label: '', number: 1, order: 0, focused: true, agentStatus: 'idle', panes, digest: EMPTY_SESSION_DIGEST }] },
    displayName: null, comment: null, parentPath: null,
  }
}

let host: HTMLDivElement
let root: Root
const spies = { toggle: vi.fn(), select: vi.fn(), drag: vi.fn() }
function mount(input: { unread: boolean; panes?: PaneRow[]; unreadPanes?: string[]; deleting?: boolean }): void {
  const noop = (): void => {}
  act(() => {
    root.render(createElement(WorktreeBlock, {
      worktree: worktree(input.panes ?? []), reordering: false, dragging: false, onCardMouseDown: spies.drag, selected: false, selectedPane: null, groupGlyph: null,
      integrations: [], home: '/home', now: 0, retained: [], lineage: READY_EMPTY, livePaneIds: new Set<string>(), unreadPanes: new Set(input.unreadPanes ?? []),
      groupExpanded: true, onToggleGroup: noop, onSelectBlock: spies.select, onSelectSession: noop, onCloseSession: noop, onCloseWorktree: noop,
      onCreateShell: noop, onCreateAgent: noop,
      card: { ...NO_CARD_ACTIONS, unread: input.unread, deleting: input.deleting ?? false, onToggleUnread: spies.toggle },
    }))
  })
}
const toggle = (): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>('[data-worktree-unread-toggle]')
  if (button === null) throw new Error('벨 버튼 없음')
  return button
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  spies.toggle.mockReset()
  spies.select.mockReset()
  spies.drag.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('K5 카드 벨', () => {
  it('ⓐ 벨 켜짐 = 채운 벨이 상태 표시를 대체 · 툴팁/aria 「읽음으로 표시」', () => {
    mount({ unread: true, panes: [pane('p1', 'working')] })
    const button = toggle()
    expect(button.getAttribute('data-worktree-unread-toggle')).toBe('unread')
    expect(button.querySelector('[data-worktree-unread-bell]')).not.toBeNull()
    // ⓓ working 보다 앞 — 스피너 상태 표시가 없다(198 그대로).
    expect(button.querySelector('[data-worktree-status]')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('읽음으로 표시')
    expect(button.title).toBe('읽음으로 표시')
  })
  it('ⓐ 벨 꺼짐 = 기존 상태 표시 + hover 흐린 벨 · 툴팁 「<상태> · 안 읽음으로 표시」', () => {
    mount({ unread: false, panes: [pane('p1', 'working')] })
    const button = toggle()
    expect(button.querySelector('[data-worktree-status="working"]')).not.toBeNull()
    expect(button.querySelector('.worktree-unread-hint')).not.toBeNull()
    expect(button.querySelector('[data-worktree-unread-bell]')).toBeNull()
    expect(button.title).toBe('작업중 · 안 읽음으로 표시')
    expect(button.getAttribute('aria-label')).toBe('안 읽음으로 표시')
  })
  it('ⓑⓒ 클릭 = 토글 1회, 카드 활성화 없음 · mousedown 이 카드 끌기를 무장하지 않는다', () => {
    mount({ unread: false })
    const button = toggle()
    act(() => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    })
    expect(spies.toggle).toHaveBeenCalledTimes(1)
    expect(spies.select).not.toHaveBeenCalled()
    expect(spies.drag).not.toHaveBeenCalled()
  })
  it('삭제 중 카드 — 벨 모양은 남고 토글은 안 된다(198 삭제 중 클릭 삼킴)', () => {
    mount({ unread: true, deleting: true })
    act(() => toggle().dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })))
    expect(spies.toggle).not.toHaveBeenCalled()
    expect(toggle().querySelector('[data-worktree-unread-bell]')).not.toBeNull()
  })
  it('K4ⓐ 카드 상태 칸은 행과 같은 판정 — herdr done 이어도 확인했으면 done 이 아니고, idle 이어도 안 읽음이면 done', () => {
    mount({ unread: false, panes: [pane('p1', 'done')] })
    expect(document.querySelector('[data-worktree-status]')?.getAttribute('data-worktree-status')).toBe('active')
    mount({ unread: false, panes: [pane('p1', 'idle')], unreadPanes: ['p1'] })
    expect(document.querySelector('[data-worktree-status]')?.getAttribute('data-worktree-status')).toBe('done')
    expect(document.querySelector('[data-agent-row="p1"]')?.getAttribute('data-unseen-done')).toBe('true')
  })
})
