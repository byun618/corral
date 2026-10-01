// K5ⓑ — 행 점 → 워크트리 상태 슬롯 대응표의 **모든 칸** (`specs/LIFE-468-sidebar-cards/raw/claude/k5-status-slot.md`).
import { describe, expect, it } from 'vitest'
import { AGENT_DOT_ORDER, type AgentDot } from './agent-dot.js'
import type { AgentRowNode, AgentRowSource } from './sidebar-agents.js'
import { WORKTREE_STATUS_LABEL, worktreeStatus, type WorktreeStatus } from './worktree-status.js'

function row({ dot, source = 'live', children = [] }: { dot: AgentDot; source?: AgentRowSource; children?: AgentRowNode[] }): AgentRowNode {
  return {
    key: `${source}:${dot}:${children.length}`,
    source,
    paneId: 'p1',
    tabId: source === 'live' ? 't1' : null,
    activationPaneId: 'p1',
    kind: 'claude',
    showIcon: true,
    dot,
    unseenDone: false,
    text: { leading: 'x', trailing: null, full: 'x' },
    model: null,
    timeAt: null,
    children,
  }
}

describe('worktreeStatus — 행 점 하나 → 슬롯 (열린 탭 있음)', () => {
  const expected: Record<AgentDot, WorktreeStatus> = {
    waiting: 'permission',
    blocked: 'permission',
    working: 'working',
    monitoring: 'monitoring',
    interrupted: 'interrupted',
    failed: 'interrupted',
    done: 'done',
    unverifiable: 'active',
    idle: 'active',
  }
  for (const dot of AGENT_DOT_ORDER) {
    it(`${dot} → ${expected[dot]}`, () => {
      expect(worktreeStatus({ rows: [row({ dot })], hasOpenTabs: true })).toBe(expected[dot])
    })
  }
})

describe('worktreeStatus — 우선순위 (Orca resolveWorktreeStatus)', () => {
  const order: Array<[AgentDot, AgentDot, WorktreeStatus]> = [
    ['working', 'waiting', 'permission'],
    ['done', 'blocked', 'permission'],
    ['monitoring', 'working', 'working'],
    ['interrupted', 'monitoring', 'monitoring'],
    ['done', 'failed', 'interrupted'],
    ['idle', 'done', 'done'],
  ]
  for (const [a, b, want] of order) {
    it(`${a} + ${b} → ${want}`, () => {
      expect(worktreeStatus({ rows: [row({ dot: a }), row({ dot: b })], hasOpenTabs: true })).toBe(want)
    })
  }
})

describe('worktreeStatus — 에이전트 없는 워크트리 = 조용한 상태', () => {
  it('열린 탭이 있으면 active (Orca: live PTY 탭 → active, 초록 점)', () => {
    expect(worktreeStatus({ rows: [], hasOpenTabs: true })).toBe('active')
  })
  it('열린 workspace 가 없으면 inactive (Orca: 회색 점)', () => {
    expect(worktreeStatus({ rows: [], hasOpenTabs: false })).toBe('inactive')
  })
})

describe('worktreeStatus — 출처', () => {
  it('보존 행은 점이 무엇이든 done 칸 (Orca hasRetainedDone)', () => {
    expect(worktreeStatus({ rows: [row({ dot: 'interrupted', source: 'retained' })], hasOpenTabs: false })).toBe('done')
  })
  it('자식 행(계보·서브에이전트)도 집계에 든다', () => {
    expect(worktreeStatus({ rows: [row({ dot: 'idle', children: [row({ dot: 'waiting', source: 'subagent' })] })], hasOpenTabs: true })).toBe('permission')
  })
})

it('모든 슬롯 값에 라벨이 있다', () => {
  for (const status of ['permission', 'working', 'monitoring', 'interrupted', 'done', 'active', 'inactive'] as const) {
    expect(WORKTREE_STATUS_LABEL[status].length).toBeGreaterThan(0)
  }
})
