// useSettledSections hook 수준 시험 (LIFE-470 수정 라운드 1 — 리뷰 r1 R1-04·R1-05 재현을 실제 hook 에).
// React 스케줄만 가짜다(fake-react.test-helper.mjs), 타이머는 vitest 가짜 타이머. 픽스처는 리뷰 `reproduce.mjs` 와 같은 모양.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => import('./fake-react.test-helper.mjs'))

const { HookHost } = await import('./fake-react.test-helper.mjs')
const { useSettledSections } = await import('./useSettledSections.js')
const { applyWorktreeMove } = await import('../manual-order.js')
const { buildSidebarSections } = await import('../sidebar-sections.js')
const { DEFAULT_SIDEBAR_VIEW } = await import('../../../shared/sidebar-view.js')

const wt = (path) => ({ path, branch: path === '/r' ? 'main' : path.split('/').at(-1), isLinked: path !== '/r', workspace: null, openWorkspaceId: null, gitStatus: null })
const repos = [{ root: '/r', name: 'r', error: null, worktrees: ['/r', '/r/a', '/r/b'].map(wt) }]
const order = { repos: ['/r'], worktrees: { '/r': ['/r/a', '/r/b', '/r'] }, all: [] }
const keys = (sections) => sections.flatMap((section) => section.items.map((item) => item.worktree.path))
const build = (view, manual) => buildSidebarSections({ repos, view, order: manual, now: 10_000 })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('R1-04 수동 조작은 활동 지연 모드에서도 바로', () => {
  it('manual-drag-recent-projects — Group Project · Sort Manual · Project order Recent 에서 카드 드롭은 즉시 반영(3초 기다리지 않는다)', () => {
    const view = { ...DEFAULT_SIDEBAR_VIEW, projectOrderBy: 'recent' }
    const host = new HookHost()
    host.render(() => useSettledSections({ sections: build(view, order), view, order }))
    const dragged = applyWorktreeMove({ order, repoRoot: '/r', worktrees: repos[0].worktrees, visiblePaths: order.worktrees['/r'], path: '/r/b', slot: 0 })
    const shown = host.render(() => useSettledSections({ sections: build(view, dragged), view, order: dragged }))
    expect(keys(shown)).toEqual(['/r/b', '/r/a', '/r'])
    expect(vi.getTimerCount()).toBe(0)
    host.unmount()
  })
})

describe('R1-05 순서가 같은 옵션 변경도 그린 배치의 옵션을 맞춘다', () => {
  it('same-order-mode-change-then-activity — Manual→Smart(화면 순서 같음) 뒤 첫 활동 변화는 3초 지연된다', () => {
    const manualRecent = { ...DEFAULT_SIDEBAR_VIEW, projectOrderBy: 'recent' }
    const smart = { ...manualRecent, sortBy: 'smart' }
    const same = build(manualRecent, order)
    const host = new HookHost()
    host.render(() => useSettledSections({ sections: same, view: manualRecent, order }))
    // 옵션만 바뀌고 화면 순서는 같다.
    expect(keys(host.render(() => useSettledSections({ sections: same, view: smart, order })))).toEqual(['/r/a', '/r/b', '/r'])
    // 활동으로 a·b 가 뒤바뀐다 — 옛 옵션(manual)과 비교해 「사용자 조작」 으로 오인하면 바로 바뀐다(수정 전 결함).
    const swapped = same.map((section) => ({ ...section, items: [section.items[1], section.items[0], section.items[2]] }))
    expect(keys(host.render(() => useSettledSections({ sections: swapped, view: smart, order })))).toEqual(['/r/a', '/r/b', '/r'])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(2999)
    expect(keys(host.render(() => useSettledSections({ sections: swapped, view: smart, order })))).toEqual(['/r/a', '/r/b', '/r'])
    vi.advanceTimersByTime(1)
    expect(keys(host.render(() => useSettledSections({ sections: swapped, view: smart, order })))).toEqual(['/r/b', '/r/a', '/r'])
    host.unmount()
  })

  it('양성 대조 — 처음부터 Smart 면 활동 변화는 3초 뒤, 언마운트하면 타이머가 정리된다', () => {
    const smart = { ...DEFAULT_SIDEBAR_VIEW, sortBy: 'smart' }
    const same = build(smart, order)
    const swapped = same.map((section) => ({ ...section, items: [section.items[1], section.items[0], section.items[2]] }))
    const host = new HookHost()
    const first = keys(host.render(() => useSettledSections({ sections: same, view: smart, order })))
    expect(keys(host.render(() => useSettledSections({ sections: swapped, view: smart, order })))).toEqual(first)
    expect(vi.getTimerCount()).toBe(1)
    host.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
