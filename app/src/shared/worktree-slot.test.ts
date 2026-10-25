import { describe, expect, it } from 'vitest'
import { emptyAgentState } from './agent-state.js'
import { retainedByWorktree } from './sidebar-agents.js'
import type { RetainedAgentRow } from './types.js'
import { isDeadWorktreeSlot } from './worktree-slot.js'

describe('isDeadWorktreeSlot — 죽은 worktree 자리 (LIFE-694·695·697)', () => {
  const worktreePaths = ['/r', '/r/.claude/worktrees/live']
  const dead = (path: string, paths: readonly string[] = worktreePaths): boolean => isDeadWorktreeSlot({ path, worktreePaths: paths })

  it('목록에 없는 자리와 그 하위는 죽은 자리다', () => {
    expect(dead('/r/.claude/worktrees/gone')).toBe(true)
    expect(dead('/r/.claude/worktrees/gone/apps/api/dist')).toBe(true)
    expect(dead('/r/.claude/worktrees/gone/')).toBe(true)
  })
  it('살아 있는 linked worktree 자리와 그 하위는 아니다', () => {
    expect(dead('/r/.claude/worktrees/live')).toBe(false)
    expect(dead('/r/.claude/worktrees/live/src')).toBe(false)
  })
  it('main 경로·main 의 일반 하위 폴더는 아니다', () => {
    expect(dead('/r')).toBe(false)
    expect(dead('/r/app')).toBe(false)
    expect(dead('/r/.claude')).toBe(false)
    expect(dead('/r/.claude/worktrees')).toBe(false)
  })
  it('등록 레포 밖·접두사만 같은 형제 경로는 아니다', () => {
    expect(dead('/elsewhere/.claude/worktrees/x')).toBe(false)
    expect(dead('/r2/.claude/worktrees/x')).toBe(false)
  })
  it('목록이 비었으면(git 읽기 실패) 죽은 자리로 올리지 않는다', () => {
    expect(dead('/r/.claude/worktrees/gone', [])).toBe(false)
  })
  it('linked worktree 안의 자리도 같은 규칙이다', () => {
    expect(dead('/r/.claude/worktrees/live/.claude/worktrees/nested')).toBe(true)
  })
})

describe('retainedByWorktree — 죽은 worktree 자리는 main 으로 올리지 않는다 (LIFE-695 C4)', () => {
  const row = (paneId: string, workspaceId: string, cwd: string | null): RetainedAgentRow => ({
    paneId, tabId: 't', workspaceId, title: paneId, agent: 'claude', agentStatus: 'done', agentState: emptyAgentState(0), cwd, retainedAt: 1,
  })
  const repos = [{ worktrees: [
    { path: '/r', workspace: { workspaceId: 'w-main' } },
    { path: '/r/.claude/worktrees/live', workspace: { workspaceId: 'w-live' } },
  ] }]
  const placed = (retained: RetainedAgentRow[]): Record<string, string[]> =>
    Object.fromEntries([...retainedByWorktree({ repos, retained })].map(([path, rows]) => [path, rows.map((entry) => entry.paneId)]))

  it('ⓐ 죽은 자리 cwd 는 main 에도, workspaceId 폴백으로도 붙지 않는다', () => {
    expect(placed([row('a', 'gone', '/r/.claude/worktrees/LIFE-676'), row('b', 'gone', '/r/.claude/worktrees/LIFE-676/app')])).toEqual({})
    // 재사용된 workspace id 가 열린 카드를 가리켜도 붙지 않는다.
    expect(placed([row('c', 'w-main', '/r/.claude/worktrees/LIFE-628'), row('d', 'w-live', '/r/.claude/worktrees/LIFE-628')])).toEqual({})
  })
  it('ⓑ 살아 있는 linked worktree 자리의 cwd 는 그 worktree 에', () => {
    expect(placed([row('a', 'gone', '/r/.claude/worktrees/live/src')])).toEqual({ '/r/.claude/worktrees/live': ['a'] })
  })
  it('ⓒ main 의 일반 하위 폴더 cwd 는 지금처럼 main 에', () => {
    expect(placed([row('a', 'gone', '/r/app'), row('b', 'gone', '/r')])).toEqual({ '/r': ['a', 'b'] })
  })
  it('ⓓ cwd 가 어느 worktree 밖(또는 없음)이면 지금처럼 workspaceId 폴백', () => {
    expect(placed([row('a', 'w-live', '/elsewhere'), row('b', 'w-main', null)])).toEqual({ '/r/.claude/worktrees/live': ['a'], '/r': ['b'] })
  })
})
