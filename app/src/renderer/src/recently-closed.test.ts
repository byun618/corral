// LIFE-495 K6ⓕ — 닫은 탭 기록의 순수 부분(스택·상한·시작 디렉터리).
import { describe, expect, it } from 'vitest'
import { popClosed, pushClosed, RECENTLY_CLOSED_LIMIT, snapshotCwd, type ClosedTabSnapshot, type RecentlyClosed } from './recently-closed.js'

const snap = (index: number, worktreePath = '/repo'): ClosedTabSnapshot => ({ worktreePath, cwd: `/repo/d${index}`, label: `n${index}`, color: null, groupId: 'g1', index })

describe('pushClosed · popClosed', () => {
  it('가장 최근 것부터 꺼낸다 · 비면 null(아무것도 안 한다)', () => {
    let history: RecentlyClosed = {}
    history = pushClosed(history, snap(1))
    history = pushClosed(history, snap(2))
    const first = popClosed(history, '/repo')
    expect(first.snapshot?.label).toBe('n2')
    const second = popClosed(first.history, '/repo')
    expect(second.snapshot?.label).toBe('n1')
    expect(popClosed(second.history, '/repo').snapshot).toBeNull()
  })
  it('worktree 별로 따로, 상한 10개(오래된 것을 버린다)', () => {
    let history: RecentlyClosed = {}
    for (let index = 0; index < 12; index++) history = pushClosed(history, snap(index))
    history = pushClosed(history, snap(99, '/other'))
    expect(history['/repo']).toHaveLength(RECENTLY_CLOSED_LIMIT)
    expect(history['/repo']?.at(-1)?.label).toBe('n2')
    expect(popClosed(history, '/other').snapshot?.label).toBe('n99')
    expect(popClosed(history, '/none').snapshot).toBeNull()
  })
})

describe('snapshotCwd (U3)', () => {
  it('보이던 pane 의 cwd, 없으면 cwd 가 있는 첫 pane, 다 없으면 null', () => {
    const panes = [{ paneId: 'p1', cwd: '/a' }, { paneId: 'p2', cwd: '/b' }]
    expect(snapshotCwd({ panes, shownPaneId: 'p2' })).toBe('/b')
    expect(snapshotCwd({ panes: [{ paneId: 'p1', cwd: null }, { paneId: 'p2', cwd: '/b' }], shownPaneId: 'p1' })).toBe('/b')
    expect(snapshotCwd({ panes: [{ paneId: 'p1', cwd: null }], shownPaneId: null })).toBeNull()
  })
})
