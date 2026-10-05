// LIFE-495 K6ⓕ — 닫은 탭 기록의 순수 부분(스택·상한·시작 디렉터리).
import { describe, expect, it } from 'vitest'
import { addPlacement, popClosed, pushClosed, RECENTLY_CLOSED_LIMIT, snapshotCwd, type ClosedTabSnapshot, type RecentlyClosed, takeLivePlacements } from './recently-closed.js'

const snap = (index: number, worktreePath = '/repo'): ClosedTabSnapshot => ({ worktreePath, cwd: `/repo/d${index}`, label: `n${index}`, color: null, groupId: 'g1', index })

describe('pushClosed · popClosed', () => {
  it('가장 최근 것부터 꺼낸다 · 비면 null(아무것도 안 한다)', () => {
    let history: RecentlyClosed = {}
    history = pushClosed({ history, snapshot: snap(1) })
    history = pushClosed({ history, snapshot: snap(2) })
    const first = popClosed({ history, worktreePath: '/repo' })
    expect(first.snapshot?.label).toBe('n2')
    const second = popClosed({ history: first.history, worktreePath: '/repo' })
    expect(second.snapshot?.label).toBe('n1')
    expect(popClosed({ history: second.history, worktreePath: '/repo' }).snapshot).toBeNull()
  })
  it('worktree 별로 따로, 상한 10개(오래된 것을 버린다)', () => {
    let history: RecentlyClosed = {}
    for (let index = 0; index < 12; index++) history = pushClosed({ history, snapshot: snap(index) })
    history = pushClosed({ history, snapshot: snap(99, '/other') })
    expect(history['/repo']).toHaveLength(RECENTLY_CLOSED_LIMIT)
    expect(history['/repo']?.at(-1)?.label).toBe('n2')
    expect(popClosed({ history, worktreePath: '/other' }).snapshot?.label).toBe('n99')
    expect(popClosed({ history, worktreePath: '/none' }).snapshot).toBeNull()
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

describe('fix1 미확인 부기 — 연속 다시 열기의 자리·색은 탭마다 따로 (takeLivePlacements)', () => {
  const a = { tabId: 'tA', workspaceId: 'w', groupId: 'g1', index: 0, color: '#3b82f6' }
  const b = { tabId: 'tB', workspaceId: 'w', groupId: 'g2', index: 2, color: null }
  it('두 요청이 겹쳐도 각자 자기 자리·색으로 나온다 — 덮어쓰지 않는다', () => {
    let pending = addPlacement({ pending: new Map(), placement: a })
    pending = addPlacement({ pending, placement: b })
    const first = takeLivePlacements({ pending, liveTabIds: ['tB'] })
    expect(first.ready).toEqual([b])
    const second = takeLivePlacements({ pending: first.pending, liveTabIds: ['tA', 'tB'] })
    expect(second.ready).toEqual([a])
    expect(second.pending.size).toBe(0)
  })
  it('도착 안 한 탭은 남긴다', () => {
    const pending = addPlacement({ pending: new Map(), placement: a })
    const taken = takeLivePlacements({ pending, liveTabIds: [] })
    expect(taken.ready).toEqual([])
    expect(taken.pending.get('tA')).toEqual(a)
  })
})
