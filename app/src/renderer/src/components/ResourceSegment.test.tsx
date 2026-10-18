// @vitest-environment happy-dom
// LIFE-637 R3·R4·R5 — 세그먼트(상태바 자리)와 패널. IPC 는 가짜 `window.corral` 로 바꾼다 — 실제 창·herdr 회차는 최종 관문 몫.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceCloseResult, ResourceSnapshot } from '../../../shared/resource.js'
import { StatusBar } from './StatusBar.js'
import { ResourceSegment } from './ResourceSegment.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const GB = 1024 ** 3
const MB = 1024 ** 2
const SNAPSHOT: ResourceSnapshot = {
  collectedAt: 1,
  total: { cpu: 61.6, memory: 2.25 * GB },
  unavailableCount: 1,
  app: { state: 'measured', usage: { cpu: 4, memory: 700 * MB }, pids: [100] },
  herdr: { state: 'measured', usage: { cpu: 1, memory: 40 * MB }, pids: [200] },
  panes: [
    { paneId: 'p-small', tabId: 't1', workspaceId: 'w1', groupKey: '/wt/a', groupLabel: 'feat-a', title: 'grok 1', agent: 'grok', measure: { state: 'measured', usage: { cpu: 50, memory: 100 * MB }, pids: [300, 301] } },
    { paneId: 'p-big', tabId: 't2', workspaceId: 'w1', groupKey: '/wt/a', groupLabel: 'feat-a', title: 'claude 1', agent: 'claude', measure: { state: 'measured', usage: { cpu: 6, memory: 1.2 * GB }, pids: [400] } },
    { paneId: 'p-gone', tabId: 't3', workspaceId: 'w2', groupKey: '/wt/b', groupLabel: 'main', title: 'zsh', agent: null, measure: { state: 'unavailable', reason: '셸 프로세스(pid 9)가 없다' } },
  ],
  host: { totalMemory: 24 * GB, usedMemory: 20 * GB, cpuCoreCount: 12 },
  stats: { intervalMs: 2000, collections: 3, skippedHidden: 0, processInfoRequests: 3, recentDurationsMs: [120] },
}

let host: HTMLDivElement
let root: Root
let push: ((snapshot: ResourceSnapshot) => void) | null
const corral = {
  getResourceSnapshot: vi.fn(async (): Promise<ResourceSnapshot | null> => null),
  onResourceSnapshot: vi.fn((listener: (snapshot: ResourceSnapshot) => void) => {
    push = listener
    return () => {
      push = null
    }
  }),
  revealResourcePane: vi.fn(async () => true),
  closeResourcePane: vi.fn(async (): Promise<ResourceCloseResult> => ({ outcome: 'closed', closed: ['p-big'] })),
}

const q = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const segment = (): HTMLButtonElement => {
  const found = q<HTMLButtonElement>('[data-statusbar-resource]')
  if (found === null) throw new Error('세그먼트 없음')
  return found
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}
function key(target: Element, keyName: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }))
  })
}
function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  push = null
  Reflect.set(window, 'corral', corral)
  for (const fn of Object.values(corral)) fn.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function mount(): void {
  act(() => {
    root.render(createElement(ResourceSegment))
  })
}

describe('세그먼트 (R3)', () => {
  it('StatusBar 의 메모리 자리에 들어간다 — 다른 칸은 그대로', () => {
    act(() => {
      root.render(createElement(StatusBar, {
        activeWorktreeLabel: 'wt', dirtyTotal: 0, aheadTotal: 0, behindTotal: 0, groupCount: 1, paneCount: 2, zoomed: false, agentCount: 1,
        termSize: { cols: 80, rows: 24 }, resourceSegment: createElement(ResourceSegment),
      }))
    })
    const bar = q('[data-statusbar]')
    expect(bar?.lastElementChild?.hasAttribute('data-statusbar-resource')).toBe(true)
    expect(bar?.textContent).toContain('xterm 80×24')
    expect(segment().textContent).toBe('CPU — · 메모리 —')
  })

  it('수집 전 — 가짜 숫자 대신 —, 첫 푸시로 값', () => {
    mount()
    expect(segment().textContent).toBe('CPU — · 메모리 —')
    act(() => push?.(SNAPSHOT))
    expect(segment().textContent).toBe('CPU 62% · 메모리 2.3 GB')
    expect(segment().title).toContain('RSS(공유 메모리 중복 포함)')
    expect(segment().title).toContain('측정 불가 1칸')
  })

  it('getResourceSnapshot 의 처음 값을 쓴다', async () => {
    corral.getResourceSnapshot.mockResolvedValueOnce(SNAPSHOT)
    mount()
    await flush()
    expect(segment().textContent).toBe('CPU 62% · 메모리 2.3 GB')
  })

  it('전체가 측정 불가면 —', () => {
    mount()
    act(() => push?.({ ...SNAPSHOT, total: null }))
    expect(segment().textContent).toBe('CPU — · 메모리 —')
  })
})

describe('패널 (R4)', () => {
  function openPanel(): HTMLElement {
    mount()
    act(() => push?.(SNAPSHOT))
    click(segment())
    const panel = q('[data-statusbar-resource-panel]')
    if (panel === null) throw new Error('패널 없음')
    return panel
  }

  it('worktree 묶음 합계 + pane 행, 앱·herdr 행 따로, 메모리 내림차순', () => {
    const panel = openPanel()
    expect(panel.querySelector('[data-statusbar-resource-host]')?.textContent).toBe('시스템 메모리 20.0 GB / 24.0 GB · 코어 12개')
    expect(panel.querySelector('[data-statusbar-resource-app] [data-statusbar-resource-memory]')?.textContent).toBe('700 MB')
    expect(panel.querySelector('[data-statusbar-resource-herdr] [data-statusbar-resource-memory]')?.textContent).toBe('40 MB')
    const groups = [...panel.querySelectorAll<HTMLElement>('[data-statusbar-resource-group]')]
    expect(groups.map((group) => group.dataset.statusbarResourceGroup)).toEqual(['/wt/a', '/wt/b'])
    expect(groups[0]?.querySelector('.statusbar-resource-group-head [data-statusbar-resource-memory]')?.textContent).toBe('1.3 GB')
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-statusbar-resource-row]')]
    expect(rows.map((row) => row.dataset.statusbarResourceRow)).toEqual(['p-big', 'p-small', 'p-gone'])
    expect(rows[0]?.querySelector('[data-statusbar-resource-agent]')?.textContent).toBe('claude')
    expect(rows[2]?.querySelector('[data-statusbar-resource-cpu]')?.textContent).toBe('—')
    expect(rows[2]?.title).toContain('측정 불가')
  })

  it('열린 동안 푸시로 갱신된다', () => {
    const panel = openPanel()
    act(() => push?.({ ...SNAPSHOT, app: { state: 'measured', usage: { cpu: 4, memory: 800 * MB }, pids: [100] } }))
    expect(panel.querySelector('[data-statusbar-resource-app] [data-statusbar-resource-memory]')?.textContent).toBe('800 MB')
  })

  it('CPU 순으로 바꿀 수 있다', () => {
    const panel = openPanel()
    const cpu = panel.querySelector('[data-statusbar-resource-sort="cpu"]')
    if (cpu === null) throw new Error('정렬 버튼 없음')
    click(cpu)
    expect([...panel.querySelectorAll<HTMLElement>('[data-statusbar-resource-row]')].map((row) => row.dataset.statusbarResourceRow)).toEqual(['p-small', 'p-big', 'p-gone'])
  })

  it('↑↓·End 로 행 이동, 열면 첫 행에 포커스', () => {
    const panel = openPanel()
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-statusbar-resource-row]')]
    expect(document.activeElement).toBe(rows[0])
    key(rows[0] ?? panel, 'ArrowDown')
    expect(document.activeElement).toBe(rows[1])
    key(rows[1] ?? panel, 'End')
    expect(document.activeElement).toBe(rows[2])
    key(rows[2] ?? panel, 'ArrowDown')
    expect(document.activeElement).toBe(rows[2])
    key(rows[2] ?? panel, 'ArrowUp')
    expect(document.activeElement).toBe(rows[1])
  })

  it('Esc 로 닫히고 열기 전 포커스로 돌아간다', () => {
    const before = document.createElement('textarea')
    document.body.appendChild(before)
    before.focus()
    mount()
    act(() => push?.(SNAPSHOT))
    click(segment())
    const row = q('[data-statusbar-resource-row]')
    if (row === null) throw new Error('행 없음')
    key(row, 'Escape')
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
    expect(document.activeElement).toBe(before)
  })

  it('바깥 클릭으로 닫힌다', () => {
    openPanel()
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    click(outside)
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
  })
})

describe('행 동작 (R5)', () => {
  function openPanel(): HTMLElement {
    mount()
    act(() => push?.(SNAPSHOT))
    click(segment())
    const panel = q('[data-statusbar-resource-panel]')
    if (panel === null) throw new Error('패널 없음')
    return panel
  }

  it('행 클릭 = 그 pane 으로 이동(revealResourcePane), 패널 닫힘', () => {
    const panel = openPanel()
    const row = panel.querySelector('[data-statusbar-resource-row="p-small"]')
    if (row === null) throw new Error('행 없음')
    click(row)
    expect(corral.revealResourcePane).toHaveBeenCalledWith({ paneId: 'p-small' })
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
  })

  it('닫기 — 게이트가 실행 중이라 하면 기존 확인 창, 확인하면 confirmed + 확인한 pane 으로 다시', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't2', paneId: 'p-big', foreground: ['claude --resume'] }] })
    const panel = openPanel()
    const close = panel.querySelector('[data-statusbar-resource-close="p-big"]')
    if (close === null) throw new Error('닫기 없음')
    click(close)
    await flush()
    expect(corral.closeResourcePane).toHaveBeenLastCalledWith({ paneId: 'p-big', confirmed: false, confirmedPaneIds: [] })
    const modal = q('[data-confirm-close-modal]')
    expect(modal?.getAttribute('data-confirm-close-kind')).toBe('agent')
    expect(modal?.textContent).toContain('claude --resume')
    // 확인 창이 떠 있는 동안 바깥(창) 클릭은 패널을 닫지 않는다.
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
    const ok = q('[data-close-confirm-ok]')
    if (ok === null) throw new Error('확인 없음')
    click(ok)
    await flush()
    expect(corral.closeResourcePane).toHaveBeenLastCalledWith({ paneId: 'p-big', confirmed: true, confirmedPaneIds: ['p-big'] })
    expect(q('[data-confirm-close-modal]')).toBeNull()
  })

  it('닫기 취소 — 다시 부르지 않는다', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    const panel = openPanel()
    const close = panel.querySelector('[data-statusbar-resource-close="p-small"]')
    if (close === null) throw new Error('닫기 없음')
    click(close)
    await flush()
    const cancel = q('[data-close-confirm-cancel]')
    if (cancel === null) throw new Error('취소 없음')
    click(cancel)
    expect(q('[data-confirm-close-modal]')).toBeNull()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
  })

  it('Delete 키 = 닫기, 거절은 패널에 그대로 보인다', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'rejected', closed: [], rejection: { code: 'pane_not_found', message: '' } })
    const panel = openPanel()
    const row = panel.querySelector('[data-statusbar-resource-row="p-gone"]')
    if (row === null) throw new Error('행 없음')
    key(row, 'Delete')
    await flush()
    expect(q('[data-statusbar-resource-error]')?.textContent).toBe('pane_not_found')
  })
})
