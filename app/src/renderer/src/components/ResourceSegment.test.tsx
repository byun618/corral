// @vitest-environment happy-dom
// LIFE-637 R3·R4·R5 — 세그먼트(상태바 자리)와 패널. IPC 는 가짜 `window.corral` 로 바꾼다 — 실제 창·herdr 회차는 최종 관문 몫.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceCloseResult, ResourceCloseRoute, ResourcePaneRow, ResourceSnapshot } from '../../../shared/resource.js'
import type { CloseTabsResult } from '../../../shared/types.js'
import { StatusBar } from './StatusBar.js'
import { ResourceSegment } from './ResourceSegment.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

// 수정 문서 확인은 기존 함수(`confirmDiscardOrSave`) 그대로다 — 여기서는 「불렸는가·무엇을 물었는가·취소면 닫지 않는가」 만 본다.
const docs = vi.hoisted(() => ({ confirm: vi.fn(async (): Promise<boolean> => true) }))
vi.mock('../file-save.js', () => ({ confirmDiscardOrSave: docs.confirm }))
// 설정은 가짜 저장소 — 핀 확인 설정(R5)·「다시 묻지 않기」 저장(R17)을 본다.
const settings = vi.hoisted(() => ({ value: { confirmClosePinnedTab: true }, update: vi.fn(async (patch: unknown): Promise<boolean> => patch !== null) }))
vi.mock('../settings-store.js', () => ({ getSettings: () => settings.value, updateSettings: settings.update }))
// 토스트는 가짜 — 패널이 닫힌 뒤의 알림(이동 실패, K5)을 본다.
const notices = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('sonner', () => ({ toast: notices.toast }))

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

const ROUTES: Record<string, ResourceCloseRoute> = {
  'p-small': { kind: 'pane' },
  'p-big': { kind: 'tab', tabId: 't2', worktreePath: '/wt/a', lastInWorktree: false },
  'p-gone': { kind: 'tab', tabId: 't3', worktreePath: '/wt/b', lastInWorktree: true },
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
  closeResourcePane: vi.fn(async (): Promise<ResourceCloseResult> => ({ outcome: 'closed', closed: ['p-small'] })),
  closeTabs: vi.fn(async (): Promise<CloseTabsResult> => ({ outcome: 'closed', closed: ['t2'] })),
  // 닫기 길 = main 의 지금 위상(H3). 기본은 SNAPSHOT 모양 그대로.
  getResourceCloseRoute: vi.fn(async (input: { paneId: string }): Promise<ResourceCloseRoute> => ROUTES[input.paneId] ?? { kind: 'missing' }),
  getUiPrefs: vi.fn(async (): Promise<{ tabMarks: unknown[] }> => ({ tabMarks: [] })),
  writeFile: vi.fn(),
  fileDialog: vi.fn(),
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
  docs.confirm.mockClear()
  notices.toast.mockClear()
  settings.value = { confirmClosePinnedTab: true }
  settings.update.mockClear()
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
    // 상태바 틀은 LIFE-636(main 통합) — 오른쪽 세그먼트 슬롯의 자식이 이 세그먼트 하나다. 사용량 슬롯은 빈 스냅샷.
    Reflect.set(window, 'corral', { ...corral, getUsage: async () => null, refreshUsage: async () => null, onUsage: () => () => {} })
    act(() => {
      root.render(createElement(StatusBar, {
        activeWorktreeLabel: 'wt', dirtyTotal: 0, aheadTotal: 0, behindTotal: 0, resourceSegment: createElement(ResourceSegment),
      }))
    })
    const segments = q('[data-statusbar-segments]')
    expect(segments?.children).toHaveLength(1)
    expect(segments?.firstElementChild?.hasAttribute('data-statusbar-resource')).toBe(true)
    expect(q('[data-statusbar]')?.textContent).toContain('corral / wt')
    expect(segment().textContent).toBe('CPU — · 메모리 —')
  })

  it('수집 전 — 가짜 숫자 대신 —, 첫 푸시로 값', () => {
    mount()
    expect(segment().textContent).toBe('CPU — · 메모리 —')
    act(() => push?.(SNAPSHOT))
    expect(segment().textContent).toBe('CPU 62% · 메모리 2.3 GB')
    expect(segment().title).toContain('RSS(공유 메모리 중복 포함)')
    // H7 — 툴팁 첫 줄 = 라벨 전문(말줄임이 나도 호버로 읽는다).
    expect(segment().title.split('\n')[0]).toBe('CPU 62% · 메모리 2.3 GB')
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
    // F9 — herdr 행은 서버 + 목록 밖 pane 이라고 밝힌다.
    expect(panel.querySelector('[data-statusbar-resource-herdr] .statusbar-resource-name')?.textContent).toBe('herdr (서버 + 목록 밖 pane)')
    expect(panel.querySelector<HTMLElement>('[data-statusbar-resource-herdr]')?.title).toContain('패널 목록에 없는 pane')
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

describe('Esc 순서 (H2) — 패널이 열려 있어도 다른 UI 의 Esc 를 가져가지 않는다', () => {
  function openWithOutside(): { textarea: HTMLTextAreaElement; documentEsc: ReturnType<typeof vi.fn>; textareaEsc: ReturnType<typeof vi.fn>; paletteEsc: ReturnType<typeof vi.fn>; palette: HTMLDivElement } {
    mount()
    act(() => push?.(SNAPSHOT))
    click(segment())
    // 팔레트(bubble onKeyDown 자리) · 문서 캡처(App 확인 창·MRU) · 터미널 textarea(xterm 이 키를 받는 자리) — Grok r2 esc-order 재현과 같은 셋.
    const palette = document.createElement('div')
    const textarea = document.createElement('textarea')
    palette.appendChild(textarea)
    document.body.appendChild(palette)
    const documentEsc = vi.fn()
    const textareaEsc = vi.fn()
    const paletteEsc = vi.fn()
    document.addEventListener('keydown', documentEsc, true)
    textarea.addEventListener('keydown', textareaEsc)
    palette.addEventListener('keydown', paletteEsc)
    return { textarea, documentEsc, textareaEsc, paletteEsc, palette }
  }

  it('포커스가 패널 밖(팔레트 안 textarea)이면 Esc 는 문서 캡처·textarea·팔레트에 닿고 패널은 그대로', () => {
    const h = openWithOutside()
    act(() => h.textarea.focus())
    key(h.textarea, 'Escape')
    document.removeEventListener('keydown', h.documentEsc, true)
    expect(h.documentEsc).toHaveBeenCalledTimes(1)
    expect(h.textareaEsc).toHaveBeenCalledTimes(1)
    expect(h.paletteEsc).toHaveBeenCalledTimes(1)
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
  })

  it('포커스가 패널 안이면 패널이 닫힌다(패널 onKeyDown)', () => {
    const h = openWithOutside()
    const row = q('[data-statusbar-resource-row]')
    if (row === null) throw new Error('행 없음')
    key(row, 'Escape')
    document.removeEventListener('keydown', h.documentEsc, true)
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
    expect(h.textareaEsc).not.toHaveBeenCalled()
  })

  it('포커스가 body 로 떨어졌으면 창 수준에서 패널이 닫힌다 (F4)', () => {
    const h = openWithOutside()
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    key(document.body, 'Escape')
    document.removeEventListener('keydown', h.documentEsc, true)
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
  function closeButton(paneId: string): Element {
    const found = q(`[data-statusbar-resource-close="${paneId}"]`)
    if (found === null) throw new Error('닫기 없음')
    return found
  }

  it('행 클릭 = 그 pane 으로 이동(revealResourcePane), 패널 닫힘', () => {
    const panel = openPanel()
    const row = panel.querySelector('[data-statusbar-resource-row="p-small"]')
    if (row === null) throw new Error('행 없음')
    click(row)
    expect(corral.revealResourcePane).toHaveBeenCalledWith({ paneId: 'p-small' })
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
  })

  it('split 탭의 pane 닫기 — pane 게이트, 확인 전에는 confirmed:false·빈 확인 목록', async () => {
    openPanel()
    click(closeButton('p-small'))
    await flush()
    expect(corral.closeResourcePane).toHaveBeenCalledWith({ paneId: 'p-small', confirmed: false, confirmedPaneIds: [] })
    expect(corral.closeTabs).not.toHaveBeenCalled()
    expect(q('[data-statusbar-resource-error]')).toBeNull()
  })

  it('실행 중이면 확인 창(pane 문구) — 취소 버튼에 포커스, 확인하면 confirmed + 확인한 pane 으로 다시 (F3)', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['grok'] }] })
    openPanel()
    click(closeButton('p-small'))
    await flush()
    const modal = q('[data-confirm-close-modal]')
    expect(modal?.getAttribute('data-confirm-close-kind')).toBe('agent')
    expect(modal?.textContent).toContain('이 pane 을 닫으면')
    expect(modal?.textContent).not.toContain('탭을 닫으면')
    expect(document.activeElement).toBe(q('[data-close-confirm-cancel]'))
    // 확인 창이 떠 있는 동안 바깥 클릭은 패널을 닫지 않는다.
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
    const ok = q('[data-close-confirm-ok]')
    if (ok === null) throw new Error('확인 없음')
    click(ok)
    await flush()
    await flush()
    expect(corral.closeResourcePane).toHaveBeenLastCalledWith({ paneId: 'p-small', confirmed: true, confirmedPaneIds: ['p-small'] })
    expect(q('[data-confirm-close-modal]')).toBeNull()
  })

  it('확인 창에서 Esc = 취소 — 패널은 남고 다시 부르지 않으며, 포커스는 그 행으로 (F3)', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    openPanel()
    click(closeButton('p-small'))
    await flush()
    key(document.activeElement ?? document.body, 'Escape')
    expect(q('[data-confirm-close-modal]')).toBeNull()
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(q('[data-statusbar-resource-row="p-small"]'))
  })

  it('확인 창에서 Enter(포커스된 취소 버튼) — 닫지도 이동하지도 않는다 (F3)', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    openPanel()
    click(closeButton('p-small'))
    await flush()
    const active = document.activeElement
    if (active === null) throw new Error('포커스 없음')
    click(active)
    expect(q('[data-confirm-close-modal]')).toBeNull()
    expect(corral.revealResourcePane).not.toHaveBeenCalled()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
  })

  it('탭의 마지막 pane 닫기 = 기존 탭 닫기(closeTabs), 핀이면 alwaysConfirm (F7)', async () => {
    corral.getUiPrefs.mockResolvedValueOnce({ tabMarks: [{ tabId: 't2', workspaceId: 'w1', pinned: true }] })
    corral.closeTabs.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [] })
    openPanel()
    click(closeButton('p-big'))
    await flush()
    await flush()
    expect(corral.closeResourcePane).not.toHaveBeenCalled()
    expect(corral.closeTabs).toHaveBeenCalledWith({ tabIds: ['t2'], confirmed: false, alwaysConfirm: true, confirmedPaneIds: [] })
    const modal = q('[data-confirm-close-modal]')
    expect(modal?.getAttribute('data-confirm-close-kind')).toBe('pinned')
    expect(modal?.textContent).toContain('고정된 탭의 마지막 pane')
    // worktree 의 탭이 2개라 수정 문서 확인은 묻지 않는다.
    expect(docs.confirm).not.toHaveBeenCalled()
  })

  it('핀이 아니면 alwaysConfirm:false — 빈 running 의 재확인은 핀 문구로 떨어지지 않는다 (F7)', async () => {
    corral.closeTabs.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [] })
    openPanel()
    click(closeButton('p-big'))
    await flush()
    await flush()
    expect(corral.closeTabs).toHaveBeenCalledWith({ tabIds: ['t2'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [] })
    const modal = q('[data-confirm-close-modal]')
    expect(modal?.textContent).not.toContain('고정')
    expect(modal?.textContent).toContain('이 pane 을 닫을까')
  })

  it('worktree 의 마지막 터미널 탭이면 수정 문서 확인을 먼저 — 취소면 닫지 않는다 (F7)', async () => {
    docs.confirm.mockResolvedValueOnce(false)
    openPanel()
    click(closeButton('p-gone'))
    await flush()
    await flush()
    expect(docs.confirm).toHaveBeenCalledTimes(1)
    expect(corral.closeTabs).not.toHaveBeenCalled()
    expect(corral.closeResourcePane).not.toHaveBeenCalled()
  })

  it('수정 문서 확인을 지나면 그 탭을 기존 탭 닫기로 (F7)', async () => {
    corral.closeTabs.mockResolvedValueOnce({ outcome: 'closed', closed: ['t3'] })
    openPanel()
    click(closeButton('p-gone'))
    await flush()
    await flush()
    expect(docs.confirm).toHaveBeenCalledTimes(1)
    expect(corral.closeTabs).toHaveBeenCalledWith({ tabIds: ['t3'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [] })
  })

  it('닫힌 목록에 대상이 없으면 성공으로 보이지 않는다 (F6)', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'closed', closed: [] })
    openPanel()
    click(closeButton('p-small'))
    await flush()
    expect(q('[data-statusbar-resource-error]')?.textContent).toContain('닫힌 것이 없다')
  })

  it('IPC 가 던지면 패널 오류 칸에 보인다 (F6)', async () => {
    corral.closeResourcePane.mockRejectedValueOnce(new Error('소켓 시간 초과'))
    openPanel()
    click(closeButton('p-small'))
    await flush()
    expect(q('[data-statusbar-resource-error]')?.textContent).toBe('닫지 못했다: 소켓 시간 초과')
  })

  it('거절은 패널에 그대로 보인다', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'rejected', closed: [], rejection: { code: 'pane_not_found', message: '' } })
    openPanel()
    click(closeButton('p-small'))
    await flush()
    expect(q('[data-statusbar-resource-error]')?.textContent).toBe('pane_not_found')
  })

  it('Delete·Backspace 한 키로는 닫지 않는다 (F8)', async () => {
    const panel = openPanel()
    const row = panel.querySelector('[data-statusbar-resource-row="p-small"]')
    if (row === null) throw new Error('행 없음')
    key(row, 'Delete')
    key(row, 'Backspace')
    await flush()
    expect(corral.closeResourcePane).not.toHaveBeenCalled()
    expect(corral.closeTabs).not.toHaveBeenCalled()
  })

  it('포커스된 행이 사라지면 이웃 행으로, 그 뒤 Esc 로 패널이 닫힌다 (F4)', async () => {
    const panel = openPanel()
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-statusbar-resource-row]')]
    act(() => rows[1]?.focus())
    expect(document.activeElement?.getAttribute('data-statusbar-resource-row')).toBe('p-small')
    act(() => push?.({ ...SNAPSHOT, panes: SNAPSHOT.panes.filter((pane) => pane.paneId !== 'p-small') }))
    expect(document.activeElement?.getAttribute('data-statusbar-resource-row')).toBe('p-gone')
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    expect(document.activeElement).toBe(document.body)
    key(document.body, 'Escape')
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
  })

  it('닫기 길은 클릭 순간의 main 위상 — 스냅샷에서 혼자였어도 지금 split 이면 pane 게이트 (H3)', async () => {
    corral.getResourceCloseRoute.mockResolvedValueOnce({ kind: 'pane' })
    openPanel()
    click(closeButton('p-big'))
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledWith({ paneId: 'p-big' })
    expect(corral.closeResourcePane).toHaveBeenCalledWith({ paneId: 'p-big', confirmed: false, confirmedPaneIds: [] })
    expect(corral.closeTabs).not.toHaveBeenCalled()
  })

  it('옆 pane 이 방금 사라졌으면(지금 혼자) 기존 탭 닫기 — 지금 위상의 tabId 로 (H3)', async () => {
    corral.getResourceCloseRoute.mockResolvedValueOnce({ kind: 'tab', tabId: 't1', worktreePath: '/wt/a', lastInWorktree: false })
    openPanel()
    click(closeButton('p-small'))
    await flush()
    await flush()
    expect(corral.closeResourcePane).not.toHaveBeenCalled()
    expect(corral.closeTabs).toHaveBeenCalledWith({ tabIds: ['t1'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [] })
  })

  it('방금 마지막 터미널 탭이 됐으면 수정 문서 확인을 먼저 — 그 worktree 문서로 (H3)', async () => {
    corral.getResourceCloseRoute.mockResolvedValueOnce({ kind: 'tab', tabId: 't2', worktreePath: '/wt/a', lastInWorktree: true })
    docs.confirm.mockResolvedValueOnce(false)
    openPanel()
    click(closeButton('p-big'))
    await flush()
    await flush()
    expect(docs.confirm).toHaveBeenCalledTimes(1)
    expect(corral.closeTabs).not.toHaveBeenCalled()
  })

  it('그 pane 이 이미 없으면 닫지 않고 오류 (H3)', async () => {
    corral.getResourceCloseRoute.mockResolvedValueOnce({ kind: 'missing' })
    openPanel()
    click(closeButton('p-small'))
    await flush()
    expect(corral.closeResourcePane).not.toHaveBeenCalled()
    expect(corral.closeTabs).not.toHaveBeenCalled()
    expect(q('[data-statusbar-resource-error]')?.textContent).toBe('그 pane 이 없다(이미 닫혔다)')
  })

  it('핀 읽기가 실패하면 핀으로 보고 묻는다 (H4ⓐ)', async () => {
    corral.getUiPrefs.mockRejectedValueOnce(new Error('prefs 없음'))
    openPanel()
    click(closeButton('p-big'))
    await flush()
    await flush()
    expect(corral.closeTabs).toHaveBeenCalledWith({ tabIds: ['t2'], confirmed: false, alwaysConfirm: true, confirmedPaneIds: [] })
  })

  it('설정 「고정된 탭을 닫기 전에 확인」 이 꺼져 있으면 핀이어도 핀 이유로 묻지 않는다 (R5)', async () => {
    settings.value = { confirmClosePinnedTab: false }
    corral.getUiPrefs.mockResolvedValueOnce({ tabMarks: [{ tabId: 't2', workspaceId: 'w1', pinned: true }] })
    openPanel()
    click(closeButton('p-big'))
    await flush()
    await flush()
    expect(corral.closeTabs).toHaveBeenCalledWith({ tabIds: ['t2'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [] })
  })

  it('「다시 묻지 않기」 체크 + 확인 = 그 설정을 저장, 체크 없이 확인 = 저장 안 함 (R17)', async () => {
    const running = [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }]
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running })
    openPanel()
    click(closeButton('p-small'))
    await flush()
    const box = q<HTMLInputElement>('[data-dont-ask-again-input]')
    if (box === null) throw new Error('체크박스 없음')
    act(() => box.click())
    const ok = q('[data-close-confirm-ok]')
    if (ok === null) throw new Error('확인 없음')
    click(ok)
    await flush()
    await flush()
    expect(settings.update).toHaveBeenCalledWith({ skipCloseTerminalWithRunningProcessConfirm: true })

    // 방금 닫은 pane 은 다음 스냅샷까지 무시한다(K6) — 스냅샷을 받은 뒤 다시.
    act(() => push?.({ ...SNAPSHOT, collectedAt: 2 }))
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running })
    click(closeButton('p-small'))
    await flush()
    const ok2 = q('[data-close-confirm-ok]')
    if (ok2 === null) throw new Error('확인 없음')
    click(ok2)
    await flush()
    expect(settings.update).toHaveBeenCalledTimes(1)
  })

  it('확인 창이 떠 있는 동안 행의 방향키는 포커스를 옮기지 않는다 (R15)', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    const panel = openPanel()
    click(closeButton('p-small'))
    await flush()
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-statusbar-resource-row]')]
    const cancel = q('[data-close-confirm-cancel]')
    // 확인 창이 떠 있는 동안 패널은 inert 다(K2) — 행에 포커스를 옮길 수도 없다.
    act(() => rows[0]?.focus())
    key(rows[0] ?? panel, 'ArrowDown')
    expect(document.activeElement).toBe(cancel)
  })

  it('확인 창의 Esc 는 문서 리스너로 새지 않는다 — App 의 다른 Esc 처리가 같이 돌지 않는다 (F3)', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    const documentEsc = vi.fn()
    document.addEventListener('keydown', documentEsc, true)
    openPanel()
    click(closeButton('p-small'))
    await flush()
    key(document.activeElement ?? document.body, 'Escape')
    document.removeEventListener('keydown', documentEsc, true)
    expect(q('[data-confirm-close-modal]')).toBeNull()
    expect(documentEsc).not.toHaveBeenCalled()
  })

  it('키보드로 연 패널은 닫으면 세그먼트로 돌아간다 — 앞서 마우스로 열 때의 자리가 남지 않는다 (R10)', () => {
    const before = document.createElement('textarea')
    document.body.appendChild(before)
    before.focus()
    mount()
    act(() => push?.(SNAPSHOT))
    click(segment())
    key(document.activeElement ?? document.body, 'Escape')
    expect(document.activeElement).toBe(before)
    act(() => segment().focus())
    key(segment(), 'Enter')
    act(() => {
      segment().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
    key(document.activeElement ?? document.body, 'Escape')
    expect(document.activeElement).toBe(segment())
  })

  it('언마운트하면 스냅샷 구독을 푼다', () => {
    mount()
    expect(push).not.toBeNull()
    act(() => root.unmount())
    expect(push).toBeNull()
    root = createRoot(host)
  })
})

// ── 수정 r3 (J1·J2·J3·J4·J6) ──
const ids = (selector: string, attr: string): string[] => [...document.querySelectorAll<HTMLElement>(selector)].map((element) => element.getAttribute(attr) ?? '')
const closeOrder = (): string[] => ids('[data-statusbar-resource-close]', 'data-statusbar-resource-close')
const rowEl = (paneId: string): HTMLElement => {
  const found = q<HTMLElement>(`[data-statusbar-resource-row="${paneId}"]`)
  if (found === null) throw new Error(`행 없음 ${paneId}`)
  return found
}
const withMemory = (input: { paneId: string; memory: number }): ResourceSnapshot => ({
  ...SNAPSHOT,
  panes: SNAPSHOT.panes.map((pane) => (pane.paneId === input.paneId ? { ...pane, measure: { state: 'measured', usage: { cpu: 1, memory: input.memory }, pids: [1] } } : pane)),
})
/** /wt/a 묶음에 새로 생긴 pane. */
const newPane = (memory: number): ResourcePaneRow => ({
  paneId: 'p-new', tabId: 't4', workspaceId: 'w1', groupKey: '/wt/a', groupLabel: 'feat-a', title: 'codex 1', agent: 'codex', measure: { state: 'measured', usage: { cpu: 1, memory }, pids: [9] },
})
function openR3(): void {
  mount()
  act(() => push?.(SNAPSHOT))
  click(segment())
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('행 순서는 열린 동안 얼린다 (J1)', () => {
  it('순위가 바뀌는 푸시를 받아도 ✕ 순서가 그대로이고 포커스는 같은 pane — 값은 갱신, 다시 열면 새 순서', () => {
    openR3()
    expect(closeOrder()).toEqual(['p-big', 'p-small', 'p-gone'])
    act(() => rowEl('p-small').focus())
    // 리뷰 r3 C3-1 재현: 순위가 뒤집히는 푸시.
    act(() => push?.(withMemory({ paneId: 'p-small', memory: 2 * GB })))
    expect(closeOrder()).toEqual(['p-big', 'p-small', 'p-gone'])
    expect(document.activeElement).toBe(rowEl('p-small'))
    expect(rowEl('p-small').querySelector('[data-statusbar-resource-memory]')?.textContent).toBe('2.0 GB')
    key(document.activeElement ?? document.body, 'Escape')
    click(segment())
    expect(closeOrder()).toEqual(['p-small', 'p-big', 'p-gone'])
  })
  it('새 pane 은 그 묶음 끝에, 사라진 pane 은 빠진다', () => {
    openR3()
    act(() => push?.({ ...SNAPSHOT, panes: [...SNAPSHOT.panes.filter((pane) => pane.paneId !== 'p-small'), newPane(9 * GB)] }))
    expect(closeOrder()).toEqual(['p-big', 'p-new', 'p-gone'])
  })
  it('정렬을 바꾸면 다시 매긴다', () => {
    openR3()
    act(() => push?.(withMemory({ paneId: 'p-small', memory: 2 * GB })))
    const cpuSort = q('[data-statusbar-resource-sort="cpu"]')
    const memorySort = q('[data-statusbar-resource-sort="memory"]')
    if (cpuSort === null || memorySort === null) throw new Error('정렬 버튼 없음')
    click(cpuSort)
    click(memorySort)
    expect(closeOrder()).toEqual(['p-small', 'p-big', 'p-gone'])
  })
  it('포커스 복구는 자리가 아니라 직전 pane — 앞에 행이 늘어도 같은 pane 으로', () => {
    openR3()
    act(() => rowEl('p-gone').focus())
    const grown = { ...SNAPSHOT, panes: [...SNAPSHOT.panes, newPane(1 * MB)] }
    act(() => push?.(grown))
    expect(closeOrder()).toEqual(['p-big', 'p-small', 'p-new', 'p-gone'])
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    act(() => push?.({ ...grown, collectedAt: 2 }))
    expect(document.activeElement).toBe(rowEl('p-gone'))
  })
})

describe('확인 뒤 길을 다시 묻는다 (J2)', () => {
  it('확인 창에 머무는 사이 옆 pane 이 끝나 탭의 마지막 pane 이 됐으면 — pane 게이트로 닫지 않고 탭 닫기를 처음부터(수정 문서 확인)', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    openR3()
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    expect(q('[data-confirm-close-modal]')).not.toBeNull()
    corral.getResourceCloseRoute.mockResolvedValueOnce({ kind: 'tab', tabId: 't1', worktreePath: '/wt/a', lastInWorktree: true })
    click(q('[data-close-confirm-ok]') ?? document.body)
    await flush()
    await flush()
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(2)
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
    expect(docs.confirm).toHaveBeenCalledTimes(1)
    expect(corral.closeTabs).toHaveBeenCalledWith({ tabIds: ['t1'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [] })
  })
  it('같은 탭이어도 그 사이 worktree 의 마지막 터미널 탭이 됐으면 수정 문서 확인부터 다시', async () => {
    corral.closeTabs.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't2', paneId: 'p-big', foreground: ['yes'] }] })
    openR3()
    click(q('[data-statusbar-resource-close="p-big"]') ?? document.body)
    await flush()
    await flush()
    expect(q('[data-confirm-close-modal]')).not.toBeNull()
    expect(docs.confirm).not.toHaveBeenCalled()
    corral.getResourceCloseRoute.mockResolvedValueOnce({ kind: 'tab', tabId: 't2', worktreePath: '/wt/a', lastInWorktree: true })
    click(q('[data-close-confirm-ok]') ?? document.body)
    await flush()
    await flush()
    await flush()
    expect(docs.confirm).toHaveBeenCalledTimes(1)
    expect(corral.closeTabs).toHaveBeenLastCalledWith({ tabIds: ['t2'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [] })
  })
  it('길이 같으면 확인한 대로 다시 부른다', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    openR3()
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    click(q('[data-close-confirm-ok]') ?? document.body)
    await flush()
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(2)
    expect(corral.closeResourcePane).toHaveBeenLastCalledWith({ paneId: 'p-small', confirmed: true, confirmedPaneIds: ['p-small'] })
  })
  it('main 이 route-changed 를 주면 지금 길로 처음부터', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'route-changed', closed: [] })
    corral.closeTabs.mockResolvedValueOnce({ outcome: 'closed', closed: ['t1'] })
    openR3()
    corral.getResourceCloseRoute.mockResolvedValueOnce({ kind: 'pane' }).mockResolvedValueOnce({ kind: 'tab', tabId: 't1', worktreePath: '/wt/a', lastInWorktree: false })
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    await flush()
    await flush()
    expect(corral.closeTabs).toHaveBeenCalledWith({ tabIds: ['t1'], confirmed: false, alwaysConfirm: false, confirmedPaneIds: [] })
    expect(q('[data-statusbar-resource-error]')?.textContent ?? null).toBeNull()
  })
})

describe('호스트가 inert 면 패널은 동작하지 않는다 (J4)', () => {
  it('열린 채 상태바에 inert 가 붙으면 ✕ 는 IPC 를 부르지 않고 패널은 닫힌다', async () => {
    openR3()
    const close = q('[data-statusbar-resource-close="p-small"]')
    if (close === null) throw new Error('닫기 없음')
    act(() => host.setAttribute('inert', ''))
    click(close)
    await flush()
    expect(corral.getResourceCloseRoute).not.toHaveBeenCalled()
    expect(corral.closeResourcePane).not.toHaveBeenCalled()
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
  })
  it('inert 가 붙은 그 순간(관찰 전)의 클릭도 무시한다 — 이동·닫기', async () => {
    openR3()
    act(() => {
      host.setAttribute('inert', '')
      rowEl('p-small').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      q('[data-statusbar-resource-close="p-big"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(corral.revealResourcePane).not.toHaveBeenCalled()
    expect(corral.getResourceCloseRoute).not.toHaveBeenCalled()
  })
  it('열 때 이미 inert 면 곧바로 닫는다 — 행 이동도 없다', async () => {
    mount()
    act(() => push?.(SNAPSHOT))
    act(() => host.setAttribute('inert', ''))
    click(segment())
    await flush()
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
    expect(corral.revealResourcePane).not.toHaveBeenCalled()
  })
})

describe('같은 행 닫기는 한 번에 하나 (J6)', () => {
  it('진행 중 두 번째 ✕ 는 IPC 0회', async () => {
    const route = deferred<ResourceCloseRoute>()
    corral.getResourceCloseRoute.mockReturnValueOnce(route.promise)
    openR3()
    const close = q('[data-statusbar-resource-close="p-small"]')
    if (close === null) throw new Error('닫기 없음')
    click(close)
    click(close)
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(1)
    route.resolve({ kind: 'pane' })
    await flush()
    await flush()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
    // 끝난 뒤에는 다시 닫을 수 있다 — 방금 닫은 pane 은 다음 스냅샷까지 무시하므로(K6) 스냅샷을 한 번 받은 뒤.
    act(() => push?.({ ...SNAPSHOT, collectedAt: 2 }))
    click(close)
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(2)
  })
})

describe('판별력 보강 (J3)', () => {
  it('첫 getResourceSnapshot 이 늦게 와도 먼저 온 푸시를 덮어쓰지 않는다 (Y9)', async () => {
    const first = deferred<ResourceSnapshot | null>()
    corral.getResourceSnapshot.mockReturnValueOnce(first.promise)
    mount()
    act(() => push?.(SNAPSHOT))
    first.resolve({ ...SNAPSHOT, total: { cpu: 1, memory: 1 * GB } })
    await flush()
    expect(segment().textContent).toBe('CPU 62% · 메모리 2.3 GB')
  })
  it('열린 패널은 세그먼트 버튼으로 닫힌다 — 버튼 누름이 바깥 클릭이 되어 다시 열리지 않는다 (Y11)', () => {
    openR3()
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
    // 브라우저처럼 mousedown 과 click 사이에 렌더가 끝난다(React 는 이산 이벤트를 곧바로 그린다) — 한 act 로 묶으면 그 사이 상태를 못 본다.
    act(() => {
      segment().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    act(() => {
      segment().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
  })
  it('aria-expanded 가 열림을 따른다 (Y12)', () => {
    mount()
    expect(segment().getAttribute('aria-expanded')).toBe('false')
    click(segment())
    expect(segment().getAttribute('aria-expanded')).toBe('true')
  })
  it('확인 창이 떠 있는 동안은 포커스를 행으로 끌어오지 않는다 (Y8)', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    openR3()
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    act(() => push?.({ ...SNAPSHOT, collectedAt: 2 }))
    expect(document.activeElement).toBe(document.body)
  })
  it('Home 은 첫 행으로 (Y2)', () => {
    openR3()
    act(() => rowEl('p-gone').focus())
    key(rowEl('p-gone'), 'Home')
    expect(document.activeElement).toBe(rowEl('p-big'))
  })
  it('IME 조합 중 Esc 는 패널을 닫지 않는다 — 패널 안(Y4)·body(Y5)', () => {
    openR3()
    act(() => {
      rowEl('p-big').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
    })
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
    })
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
  })
  it('이동이 실패하면 알린다 — 패널은 닫혔으므로 토스트로 (S1·K5)', async () => {
    corral.revealResourcePane.mockResolvedValueOnce(false)
    openR3()
    click(rowEl('p-small'))
    await flush()
    expect(notices.toast).toHaveBeenCalledWith('그 pane 을 찾지 못했다')
    click(segment())
    expect(q('[data-statusbar-resource-error]')).toBeNull()
  })
})

// ── 수정 r4 (K1–K6) ──
describe('길을 묻는 동안 취소하면 닫지 않는다 (K1)', () => {
  const RUNNING = { outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] } satisfies ResourceCloseResult
  async function confirmWithSlowRequery(): Promise<(route: ResourceCloseRoute) => void> {
    corral.closeResourcePane.mockResolvedValueOnce(RUNNING)
    openR3()
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    expect(q('[data-confirm-close-modal]')).not.toBeNull()
    const requery = deferred<ResourceCloseRoute>()
    corral.getResourceCloseRoute.mockReturnValueOnce(requery.promise)
    click(q('[data-close-confirm-ok]') ?? document.body)
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(2)
    return requery.resolve
  }
  it('확인 뒤 재조회 중 「취소」 — 같은 길로 풀려도, 탭 길로 바뀌어도 닫기 IPC 0 (Grok r4 재현 1·3)', async () => {
    const resolve = await confirmWithSlowRequery()
    click(q('[data-close-confirm-cancel]') ?? document.body)
    resolve({ kind: 'tab', tabId: 't1', worktreePath: '/wt/a', lastInWorktree: true })
    await flush()
    await flush()
    await flush()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
    expect(corral.closeTabs).not.toHaveBeenCalled()
    expect(docs.confirm).not.toHaveBeenCalled()
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
  })
  it('확인 뒤 재조회 중 Esc — 같은 길로 풀려도 confirmed 닫기를 보내지 않는다 (Grok r4 재현 2)', async () => {
    const resolve = await confirmWithSlowRequery()
    key(document.activeElement ?? document.body, 'Escape')
    expect(q('[data-confirm-close-modal]')).toBeNull()
    resolve({ kind: 'pane' })
    await flush()
    await flush()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
    expect(corral.closeTabs).not.toHaveBeenCalled()
  })
  it('첫 길 조회 중 패널 Esc — pane 길로 풀려도, 탭 길로 풀려도 닫기 IPC 0 (Grok r4 재현 4)', async () => {
    for (const route of [{ kind: 'pane' }, { kind: 'tab', tabId: 't2', worktreePath: '/wt/a', lastInWorktree: false }] satisfies ResourceCloseRoute[]) {
      const first = deferred<ResourceCloseRoute>()
      corral.getResourceCloseRoute.mockReturnValueOnce(first.promise)
      openR3()
      click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
      await flush()
      key(document.activeElement ?? document.body, 'Escape')
      expect(q('[data-statusbar-resource-panel]')).toBeNull()
      first.resolve(route)
      await flush()
      await flush()
      expect(corral.closeResourcePane).not.toHaveBeenCalled()
      expect(corral.closeTabs).not.toHaveBeenCalled()
    }
  })
  it('탭 길의 핀 조회 중 패널 Esc — closeTabs 0', async () => {
    const prefs = deferred<{ tabMarks: unknown[] }>()
    corral.getUiPrefs.mockReturnValueOnce(prefs.promise)
    openR3()
    click(q('[data-statusbar-resource-close="p-big"]') ?? document.body)
    await flush()
    await flush()
    expect(corral.getUiPrefs).toHaveBeenCalledTimes(1)
    key(document.activeElement ?? document.body, 'Escape')
    prefs.resolve({ tabMarks: [] })
    await flush()
    await flush()
    expect(corral.closeTabs).not.toHaveBeenCalled()
  })
  it('「다시 묻지 않기」 저장 중 취소 — 저장은 됐어도 confirmed 닫기는 보내지 않는다', async () => {
    const saving = deferred<boolean>()
    settings.update.mockReturnValueOnce(saving.promise)
    corral.closeResourcePane.mockResolvedValueOnce(RUNNING)
    openR3()
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    act(() => q<HTMLInputElement>('[data-dont-ask-again-input]')?.click())
    click(q('[data-close-confirm-ok]') ?? document.body)
    await flush()
    await flush()
    expect(settings.update).toHaveBeenCalledTimes(1)
    click(q('[data-close-confirm-cancel]') ?? document.body)
    saving.resolve(true)
    await flush()
    await flush()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
  })
  it('취소한 뒤 다시 ✕ 하면 정상으로 닫는다 — 세대는 그 닫기만 버린다', async () => {
    const resolve = await confirmWithSlowRequery()
    click(q('[data-close-confirm-cancel]') ?? document.body)
    resolve({ kind: 'pane' })
    await flush()
    await flush()
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    await flush()
    expect(corral.closeResourcePane).toHaveBeenLastCalledWith({ paneId: 'p-small', confirmed: false, confirmedPaneIds: [] })
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(2)
  })
})

describe('확인 창이 떠 있는 동안 다른 행 동작은 시작되지 않는다 (K2)', () => {
  it('다른 행 ✕·이동·정렬을 활성화해도 IPC 0, 패널은 inert', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 't1', paneId: 'p-small', foreground: ['yes'] }] })
    openR3()
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    expect(q('[data-confirm-close-modal]')).not.toBeNull()
    expect(q('[data-statusbar-resource-panel]')?.hasAttribute('inert')).toBe(true)
    const other = q<HTMLElement>('[data-statusbar-resource-close="p-big"]')
    if (other === null) throw new Error('닫기 없음')
    // Grok r4 재현 5 — 포인터 히트 테스트가 아니라 버튼 활성화.
    act(() => {
      other.focus()
      other.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      rowEl('p-gone').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      q('[data-statusbar-resource-sort="cpu"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(1)
    expect(corral.closeTabs).not.toHaveBeenCalled()
    expect(corral.revealResourcePane).not.toHaveBeenCalled()
    expect(q('[data-statusbar-resource-sort="memory"]')?.getAttribute('aria-pressed')).toBe('true')
    // 취소하면 패널은 다시 동작한다.
    click(q('[data-close-confirm-cancel]') ?? document.body)
    expect(q('[data-statusbar-resource-panel]')?.hasAttribute('inert')).toBe(false)
  })
})

describe('이미 눌린 정렬은 아무것도 바꾸지 않는다 (K3)', () => {
  it('같은 정렬을 다시 눌러도 다음 푸시에서 얼린 순서가 그대로 (Grok r4 재현 6)', () => {
    openR3()
    act(() => push?.(withMemory({ paneId: 'p-small', memory: 2 * GB })))
    expect(closeOrder()).toEqual(['p-big', 'p-small', 'p-gone'])
    click(q('[data-statusbar-resource-sort="memory"]') ?? document.body)
    expect(closeOrder()).toEqual(['p-big', 'p-small', 'p-gone'])
    act(() => push?.({ ...withMemory({ paneId: 'p-small', memory: 2 * GB }), collectedAt: 2 }))
    expect(closeOrder()).toEqual(['p-big', 'p-small', 'p-gone'])
  })
})

describe('✕ 에 포커스가 있던 pane 이 사라지면 이웃 행으로 (K4)', () => {
  it('마지막 행 ✕ 포커스 → 그 pane 소멸 → 이웃(p-small), 맨 위가 아니다 (Claude r4 C4-1 재현)', () => {
    openR3()
    expect(document.activeElement).toBe(rowEl('p-big'))
    act(() => q<HTMLElement>('[data-statusbar-resource-close="p-gone"]')?.focus())
    act(() => push?.({ ...SNAPSHOT, panes: SNAPSHOT.panes.filter((pane) => pane.paneId !== 'p-gone') }))
    expect(document.activeElement).toBe(rowEl('p-small'))
  })
  it('남아 있는 pane 의 ✕ 였으면 그 pane 으로', () => {
    openR3()
    act(() => q<HTMLElement>('[data-statusbar-resource-close="p-small"]')?.focus())
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    act(() => push?.({ ...SNAPSHOT, collectedAt: 2 }))
    expect(document.activeElement).toBe(rowEl('p-small'))
  })
})

describe('패널을 열 때 지난 오류를 비운다 (K5)', () => {
  it('패널이 닫힌 뒤에 도착한 닫기 오류는 다시 열 때 보이지 않는다 (Claude r4 C4-2 — 같은 모양의 늦은 오류)', async () => {
    const result = deferred<ResourceCloseResult>()
    corral.closeResourcePane.mockReturnValueOnce(result.promise)
    openR3()
    click(q('[data-statusbar-resource-close="p-small"]') ?? document.body)
    await flush()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
    key(document.activeElement ?? document.body, 'Escape')
    expect(q('[data-statusbar-resource-panel]')).toBeNull()
    result.resolve({ outcome: 'error', closed: [], error: '실패' })
    await flush()
    await flush()
    click(segment())
    expect(q('[data-statusbar-resource-panel]')).not.toBeNull()
    expect(q('[data-statusbar-resource-error]')).toBeNull()
  })
})

describe('방금 닫은 pane 의 ✕ 는 다음 스냅샷까지 무시한다 (K6)', () => {
  it('성공 직후 같은 ✕ 는 IPC 0·오류 없음, 다음 스냅샷 뒤에는 다시 묻는다 (Claude r4 C4-3 재현)', async () => {
    openR3()
    const close = q('[data-statusbar-resource-close="p-small"]')
    if (close === null) throw new Error('닫기 없음')
    click(close)
    await flush()
    await flush()
    expect(corral.closeResourcePane).toHaveBeenCalledTimes(1)
    corral.getResourceCloseRoute.mockResolvedValueOnce({ kind: 'missing' })
    click(close)
    await flush()
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(1)
    expect(q('[data-statusbar-resource-error]')).toBeNull()
    act(() => push?.({ ...SNAPSHOT, collectedAt: 2 }))
    click(close)
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(2)
  })
  it('닫힌 것이 없으면(F6) 무시하지 않는다', async () => {
    corral.closeResourcePane.mockResolvedValueOnce({ outcome: 'closed', closed: [] })
    openR3()
    const close = q('[data-statusbar-resource-close="p-small"]')
    if (close === null) throw new Error('닫기 없음')
    click(close)
    await flush()
    await flush()
    click(close)
    await flush()
    expect(corral.getResourceCloseRoute).toHaveBeenCalledTimes(2)
  })
})
