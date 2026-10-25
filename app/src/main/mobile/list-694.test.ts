// LIFE-695 C4 · LIFE-696 C5ⓕ — 폰 목록·채널 해석이 데스크톱과 같은 보존 행 귀속(`retainedByWorktree`)과 같은 공급을 지난다.
import { describe, expect, it } from 'vitest'
import type { RetainedAgentRow } from '../../shared/types.js'
import { buildMobileList, chatChannel, type ListState } from './list.js'
import { FIXTURE_NOW, listFixture } from './list-fixture.js'

function retained(paneId: string, cwd: string): RetainedAgentRow {
  return {
    paneId, tabId: `t-${paneId}`, workspaceId: 'ws-gone', title: paneId, agent: 'claude', agentStatus: 'done',
    agentState: { blockedReason: null, observedAt: FIXTURE_NOW - 60_000, observedVia: 'event', enteredDoneAt: FIXTURE_NOW - 60_000, history: [] },
    cwd, retainedAt: FIXTURE_NOW - 60_000,
    agentSession: { kind: 'id', agent: 'claude', source: 'herdr:claude', id: `sess-${paneId}` },
  }
}

function stateWith(rows: RetainedAgentRow[]): ListState {
  const base = listFixture()
  return { ...base, retainedAgents: [...rows, ...base.retainedAgents] }
}

const channelIds = (state: ListState): string[] =>
  buildMobileList({ state, prefs: null, now: FIXTURE_NOW }).repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels.map((channel) => channel.id)))

describe('LIFE-695 — 모바일도 죽은 worktree 자리 행을 상위 worktree 에 붙이지 않는다', () => {
  // 고정 상태의 corral 레포: `/fx/corral`(main — 셸만 있어 폰에 안 보인다) + `/fx/corral/.wt/life-579`(열린 linked worktree, 폰에 보인다).
  // 폰에 보이는 상위 worktree 를 쓰려고 그 worktree 안의 죽은 자리로 시험한다 — 고치기 전에는 최장 접두로 life-579 에 붙었을 자리다.
  const parent = '/fx/corral/.wt/life-579'
  const dead = retained('dead', `${parent}/.claude/worktrees/LIFE-676`)
  const sub = retained('sub', `${parent}/app`)

  it('목록: 죽은 자리 행은 어느 묶음에도 없고, 그 worktree 의 일반 하위 폴더 행은 있다(양성 대조)', () => {
    const ids = channelIds(stateWith([dead, sub]))
    expect(ids).not.toContain('retained:dead')
    expect(ids).toContain('retained:sub')
  })
  it('채널 해석(`chatChannel`): 죽은 자리 행은 not_listed, 일반 하위 폴더 행은 그 worktree 로 풀린다', () => {
    const list = { state: stateWith([dead, sub]), prefs: null, now: FIXTURE_NOW }
    expect(chatChannel({ list, channelId: 'retained:dead' })).toEqual({ ok: false, reason: 'not_listed' })
    const got = chatChannel({ list, channelId: 'retained:sub' })
    expect(got.ok ? got.channel.place.worktree : got.reason).toBe(parent)
  })
})

describe('LIFE-696 C5ⓕ — 걷은 행은 폰 목록에서도 빠진다(같은 공급)', () => {
  it('공급에서 그 행이 빠지면 채널도 사라지고 다른 보존 행은 그대로다', () => {
    const extra = retained('keep', '/fx/corral/.wt/life-579/src')
    const before = stateWith([extra])
    const ids = channelIds(before)
    expect(ids).toContain('retained:r1')
    expect(ids).toContain('retained:keep')
    const after = channelIds({ ...before, retainedAgents: before.retainedAgents.filter((row) => row.paneId !== 'r1') })
    expect(after).not.toContain('retained:r1')
    expect(after).toContain('retained:keep')
  })
})
