// @vitest-environment happy-dom
// LIFE-493 K1·K3 — 탭 모양의 DOM 계약(선두·활성 표시·닫기·중클릭·넘침 휠). 값(px·색)은 CSS 라 측정 도구·네이티브 캡처가 본다.
// LIFE-494 K1 — 넘침 표면(chevron·dock·썸·끝에 붙기)의 DOM 계약. 계산 자체는 `tab-strip-metrics.test.ts`·`tab-strip-geometry.test.ts`.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAgentState } from '../../../shared/agent-state.js'
import { EMPTY_SESSION_DIGEST, type AgentStatus, type PaneRow, type TabRow } from '../../../shared/types.js'
import { GroupHeader } from './MainTabBar.js'
import type { OpenTabSearchEntry } from '../tab-create-menu.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const pane = (paneId: string, agent: string | null, agentStatus: AgentStatus): PaneRow => ({
  paneId, tabId: `t-${paneId}`, workspaceId: 'w1', title: '', agent, agentStatus, agentState: emptyAgentState(0), cwd: null, focused: false, agentSession: null,
  digest: EMPTY_SESSION_DIGEST,
})
const tab = (index: number, panes: PaneRow[]): TabRow => ({
  tabId: `t${index}`, workspaceId: 'w1', label: '', number: index + 1, order: index, agentStatus: 'idle', focused: false, panes, digest: EMPTY_SESSION_DIGEST,
})

let host: HTMLDivElement
let root: Root
const spies = { close: vi.fn(), select: vi.fn(), createShell: vi.fn(), launch: vi.fn(), activateTab: vi.fn(), activate: vi.fn() }
function mount(input: { tabs: TabRow[]; activeTabId: string | null; unread?: string[]; dragActive?: boolean; entries?: OpenTabSearchEntry[] }): void {
  const noop = (): void => {}
  act(() => {
    root.render(createElement(GroupHeader, {
      groupId: 'g1', tabs: input.tabs, workspaceTabCount: input.tabs.length, home: '/home', selectedPane: null, activeTabId: input.activeTabId,
      activeGroup: true, unreadPanes: new Set(input.unread ?? []), paneCount: 1, grid: null, zoomed: false,
      onActivate: spies.activate, onSelectTab: spies.select, onCreateShell: spies.createShell, onCloseTab: spies.close, onRenameTab: noop, onClearTabName: noop,
      onSplitPane: noop, onMoveToGroup: noop, onZoom: noop, onClosePane: noop, onCloseGroup: null, otherGroups: [], onMoveToOtherGroup: noop, onTabDragStart: noop,
      tabDragActive: input.dragActive ?? false,
      openTabEntries: input.entries ?? [], onLaunchAgent: spies.launch, onActivateOpenTab: spies.activateTab,
    }))
  })
}
const tabEl = (tabId: string): HTMLElement => {
  const node = host.querySelector<HTMLElement>(`[data-main-tab="${tabId}"]`)
  if (node === null) throw new Error(`no tab ${tabId}`)
  return node
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // happy-dom 에는 레이아웃이 없다 — 활성 탭 끌어오기는 호출만 확인한다.
  Element.prototype.scrollIntoView = vi.fn()
  for (const spy of Object.values(spies)) spy.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('탭 모양 (K1)', () => {
  it('compact 가 없다 — 탭이 많아도 접힘 표식을 달지 않는다', () => {
    mount({ tabs: Array.from({ length: 12 }, (_, index) => tab(index, [pane(`p${index}`, 'claude', 'idle')])), activeTabId: 't11' })
    expect(host.querySelectorAll('[data-main-tab]')).toHaveLength(12)
    expect(host.querySelector('.is-compact, [data-tab-compact]')).toBeNull()
    expect(host.querySelector('.main-tab-dot')).toBeNull()
  })

  it('활성 탭만 하단 표시를 갖고 data-active 가 선다', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')]), tab(1, [pane('b', 'codex', 'idle')])], activeTabId: 't1' })
    expect(tabEl('t1').dataset.active).toBe('true')
    expect(tabEl('t0').dataset.active).toBe('false')
    expect(tabEl('t1').querySelector('.main-tab-indicator')).not.toBeNull()
    expect(tabEl('t0').querySelector('.main-tab-indicator')).toBeNull()
  })

  it('오른쪽 경계는 마지막 탭에 없다', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')]), tab(1, [pane('b', 'codex', 'idle')])], activeTabId: 't0' })
    expect(tabEl('t0').classList.contains('has-right')).toBe(true)
    expect(tabEl('t1').classList.contains('has-right')).toBe(false)
  })

  it('선두: idle 에이전트 탭 = 로고만, 셸 탭 = 셸 아이콘, 작업 중 = 상태 묶음(점 + 로고)', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')]), tab(1, [pane('b', null, 'unknown')]), tab(2, [pane('c', 'grok', 'working')])], activeTabId: 't0' })
    expect(tabEl('t0').querySelector('[data-tab-activity]')).toBeNull()
    expect(tabEl('t0').querySelector('[data-agent-kind="claude"]')).not.toBeNull()
    expect(tabEl('t1').querySelector('[data-shell-icon="generic"]')).not.toBeNull()
    expect(tabEl('t1').querySelector('[data-agent-kind]')).toBeNull()
    const activity = tabEl('t2').querySelector<HTMLElement>('[data-tab-activity]')
    expect(activity?.dataset.tabActivity).toBe('working')
    expect(activity?.firstElementChild?.getAttribute('data-agent-dot')).toBe('working')
    expect(activity?.querySelector('[data-agent-kind="grok"]')).not.toBeNull()
  })

  it('안 읽음 → 벨 + 워시, 확인 뒤엔 둘 다 없다', () => {
    const tabs = [tab(0, [pane('a', 'claude', 'done')]), tab(1, [pane('b', 'claude', 'idle')])]
    mount({ tabs, activeTabId: 't1', unread: ['a'] })
    expect(tabEl('t0').querySelector('[data-tab-unread-bell]')).not.toBeNull()
    expect(tabEl('t0').querySelector('.main-tab-unread-wash')).not.toBeNull()
    mount({ tabs, activeTabId: 't1', unread: [] })
    expect(tabEl('t0').querySelector('[data-tab-unread-bell]')).toBeNull()
    expect(tabEl('t0').querySelector('.main-tab-unread-wash')).toBeNull()
  })
})

describe('닫기 (K1 D13·D14)', () => {
  it('닫기 버튼은 모든 탭 DOM 에 있다(노출은 CSS — 활성 상시·비활성 hover)', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')]), tab(1, [pane('b', 'claude', 'idle')])], activeTabId: 't0' })
    expect(host.querySelectorAll('[data-tab-close-button="true"]')).toHaveLength(2)
    expect(host.querySelector('[data-main-tab-close="t1"]')).not.toBeNull()
  })

  it('× 클릭 → 그 탭 닫기, 선택은 안 바뀐다', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')]), tab(1, [pane('b', 'claude', 'idle')])], activeTabId: 't0' })
    act(() => host.querySelector<HTMLElement>('[data-main-tab-close="t1"]')?.click())
    expect(spies.close).toHaveBeenCalledTimes(1)
    expect(spies.close.mock.calls[0]?.[0]?.tabId).toBe('t1')
    expect(spies.select).not.toHaveBeenCalled()
  })

  it('중클릭(auxclick button 1) → 닫기, 왼쪽 클릭은 선택', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')]), tab(1, [pane('b', 'claude', 'idle')])], activeTabId: 't0' })
    act(() => {
      tabEl('t1').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    })
    expect(spies.close).toHaveBeenCalledTimes(1)
    expect(spies.close.mock.calls[0]?.[0]?.tabId).toBe('t1')
    act(() => tabEl('t1').click())
    expect(spies.select).toHaveBeenCalledTimes(1)
    expect(spies.close).toHaveBeenCalledTimes(1)
  })

  it('auxclick 오른쪽 버튼(2)은 닫지 않는다', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')])], activeTabId: 't0' })
    act(() => {
      tabEl('t0').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 2 }))
    })
    expect(spies.close).not.toHaveBeenCalled()
  })
})

/** happy-dom 에는 레이아웃이 없다 — 스트립 크기만 꾸며 넘침 상태를 만든다(탭 개별 위치는 `tab-strip-geometry.test.ts`). */
const stripBox = { clientWidth: 0, scrollWidth: 0 }
const stripEl = (): HTMLElement => {
  const node = host.querySelector<HTMLElement>('[data-main-tab-strip="g1"]')
  if (node === null) throw new Error('no strip')
  return node
}
function setStripBox(input: { clientWidth: number; scrollWidth: number; scrollLeft: number }): void {
  stripBox.clientWidth = input.clientWidth
  stripBox.scrollWidth = input.scrollWidth
  const strip = stripEl()
  strip.scrollLeft = input.scrollLeft
  act(() => {
    strip.dispatchEvent(new Event('scroll'))
  })
}

describe('넘침 (LIFE-494 K1·K2ⓐ)', () => {
  beforeEach(() => {
    stripBox.clientWidth = 0
    stripBox.scrollWidth = 0
    const isStrip = (node: Element): boolean => node.hasAttribute('data-main-tab-strip')
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return isStrip(this) ? stripBox.clientWidth : 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return isStrip(this) ? stripBox.scrollWidth : 0 })
    HTMLElement.prototype.scrollBy = vi.fn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const many = Array.from({ length: 8 }, (_, index) => tab(index, [pane(`p${index}`, null, 'unknown')]))

  it('탭은 스크롤 스트립 안, 스트립은 썸과 한 상자, `+` 는 그 상자 바로 뒤다(넘치지 않을 때)', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')])], activeTabId: 't0' })
    const strip = stripEl()
    expect(strip.querySelector('[data-main-tab="t0"]')).not.toBeNull()
    expect(strip.parentElement?.hasAttribute('data-main-tab-strip-wrap')).toBe(true)
    expect(strip.parentElement?.nextElementSibling?.hasAttribute('data-main-tabbar-add')).toBe(true)
  })

  it('넘치지 않으면 chevron·썸·페이드가 없다', () => {
    mount({ tabs: many, activeTabId: 't0' })
    setStripBox({ clientWidth: 2000, scrollWidth: 2000, scrollLeft: 0 })
    expect(host.querySelector('[data-tab-strip-chevron]')).toBeNull()
    expect(host.querySelector('[data-tab-strip-scroll-indicator]')).toBeNull()
    expect(stripEl().className).not.toMatch(/is-fade/)
  })

  it('맨 앞: chevron 둘(‹ 비활성), 뒤 페이드, 썸 있음 — 순서 ‹ · 스트립 · › · +', () => {
    mount({ tabs: many, activeTabId: 't0' })
    setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 0 })
    const start = host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="start"]')
    const end = host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="end"]')
    expect(start?.disabled).toBe(true)
    expect(start?.getAttribute('aria-disabled')).toBe('true')
    expect(end?.disabled).toBe(false)
    expect(stripEl().classList.contains('is-fade-end')).toBe(true)
    expect(stripEl().classList.contains('is-fade-start')).toBe(false)
    expect(host.querySelector('[data-tab-strip-scroll-indicator] [data-tab-strip-scroll-thumb]')).not.toBeNull()
    const wrap = stripEl().parentElement
    expect(wrap?.previousElementSibling).toBe(start)
    expect(wrap?.nextElementSibling).toBe(end)
    expect(end?.nextElementSibling?.hasAttribute('data-main-tabbar-add')).toBe(true)
  })

  it('가운데: 양쪽 활성·양쪽 페이드 / 끝: › 비활성·앞 페이드', () => {
    mount({ tabs: many, activeTabId: null })
    setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 500 })
    expect(host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="start"]')?.disabled).toBe(false)
    expect(host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="end"]')?.disabled).toBe(false)
    expect(stripEl().classList.contains('is-fade-start') && stripEl().classList.contains('is-fade-end')).toBe(true)
    setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 1040 })
    expect(host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="end"]')?.disabled).toBe(true)
    expect(stripEl().classList.contains('is-fade-start')).toBe(true)
    expect(stripEl().classList.contains('is-fade-end')).toBe(false)
  })

  it('활성 탭이 앞으로 지나가면 앞에 붙고(data-active-tab-docked=start) 그쪽 페이드는 꺼진다', () => {
    mount({ tabs: many, activeTabId: 't0' })
    setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 500 })
    expect(stripEl().dataset.activeTabDocked).toBe('start')
    expect(stripEl().classList.contains('is-fade-start')).toBe(false)
    expect(stripEl().classList.contains('is-fade-end')).toBe(true)
  })

  it('chevron 클릭 = 폭의 75% 스텝(최소 120)', () => {
    mount({ tabs: many, activeTabId: 't0' })
    setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 500 })
    act(() => host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="end"]')?.click())
    expect(HTMLElement.prototype.scrollBy).toHaveBeenLastCalledWith({ left: 300, behavior: 'smooth' })
    act(() => host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="start"]')?.click())
    expect(HTMLElement.prototype.scrollBy).toHaveBeenLastCalledWith({ left: -300, behavior: 'smooth' })
  })

  it('활성 탭만 dock 표식, 탭 드래그 중엔 없다(드롭 자리 계산과 겹치지 않게)', () => {
    mount({ tabs: many, activeTabId: 't3' })
    expect(host.querySelectorAll('[data-active-tab-dock]')).toHaveLength(1)
    expect(tabEl('t3').hasAttribute('data-active-tab-dock')).toBe(true)
    mount({ tabs: many, activeTabId: 't3', dragActive: true })
    expect(host.querySelector('[data-active-tab-dock]')).toBeNull()
  })

  it('탭 드래그 중엔 끝이어도 chevron 이 비활성이 아니고(hover 를 받아야 한다), 썸은 비킨다', () => {
    mount({ tabs: many, activeTabId: 't0' })
    setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 0 })
    mount({ tabs: many, activeTabId: 't0', dragActive: true })
    const start = host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="start"]')
    expect(start?.disabled).toBe(false)
    expect(start?.getAttribute('aria-disabled')).toBe('true')
    expect(host.querySelector('[data-tab-strip-scroll-indicator]')?.classList.contains('is-disabled')).toBe(true)
  })

  it('드래그 중 chevron hover → 즉시 한 스텝 + 180ms 마다, 떠나거나 드래그가 끝나면 멈춘다', () => {
    vi.useFakeTimers()
    try {
      mount({ tabs: many, activeTabId: 't0' })
      setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 500 })
      mount({ tabs: many, activeTabId: 't0', dragActive: true })
      const scrollBy = vi.mocked(HTMLElement.prototype.scrollBy)
      scrollBy.mockClear()
      const end = host.querySelector<HTMLButtonElement>('[data-tab-strip-chevron="end"]')
      act(() => {
        end?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
        end?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
      })
      expect(scrollBy).toHaveBeenCalledTimes(1)
      expect(scrollBy).toHaveBeenLastCalledWith({ left: 300, behavior: 'auto' })
      act(() => vi.advanceTimersByTime(360))
      expect(scrollBy).toHaveBeenCalledTimes(3)
      mount({ tabs: many, activeTabId: 't0', dragActive: false })
      act(() => vi.advanceTimersByTime(720))
      expect(scrollBy).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('드래그 중이 아니면 chevron hover 는 스크롤하지 않는다', () => {
    mount({ tabs: many, activeTabId: 't0' })
    setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 500 })
    const scrollBy = vi.mocked(HTMLElement.prototype.scrollBy)
    scrollBy.mockClear()
    act(() => {
      host.querySelector('[data-tab-strip-chevron="end"]')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
    })
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('탭 우클릭 메뉴는 스트립 밖(탭바 줄)에 그린다 — 스트립의 페이드 마스크가 메뉴를 자르지 않게, 메뉴 동작은 그대로', () => {
    mount({ tabs: many, activeTabId: 't0' })
    setStripBox({ clientWidth: 400, scrollWidth: 1440, scrollLeft: 500 })
    act(() => {
      tabEl('t2').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 10 }))
    })
    const menu = host.querySelector<HTMLElement>('[data-tab-menu="t2"]')
    expect(menu).not.toBeNull()
    expect(menu?.closest('[data-main-tab-strip]')).toBeNull()
    expect(menu?.parentElement?.hasAttribute('data-main-tabbar')).toBe(true)
    act(() => host.querySelector<HTMLElement>('[data-tab-menu-close="t2"]')?.click())
    expect(spies.close).toHaveBeenCalledTimes(1)
    expect(spies.close.mock.calls[0]?.[0]?.tabId).toBe('t2')
    expect(spies.select).not.toHaveBeenCalled()
  })

  it('끝에 붙어 있을 때 끝에 탭이 생기며 활성이 되면 다시 끝으로(stick-to-end)', () => {
    mount({ tabs: many.slice(0, 7), activeTabId: 't6' })
    setStripBox({ clientWidth: 400, scrollWidth: 1260, scrollLeft: 860 })
    stripBox.scrollWidth = 1440
    mount({ tabs: many, activeTabId: 't7' })
    expect(stripEl().scrollLeft).toBe(1040)
  })

  it('끝이 아닌 자리에서 둘러보던 중 탭 목록이 바뀌어도(활성 그대로) 끝으로 튀지 않는다', () => {
    mount({ tabs: many.slice(0, 7), activeTabId: 't0' })
    setStripBox({ clientWidth: 400, scrollWidth: 1260, scrollLeft: 300 })
    mount({ tabs: many.slice(0, 6), activeTabId: 't0' })
    expect(stripEl().scrollLeft).toBe(300)
  })

  // r1 R1-08 — 탭 개별 위치가 필요한 경로. 탭 100px 가 스트립 x 0 부터 늘어서고 dock 탭은 sticky 처럼 잘려 그려지는 가짜 레이아웃.
  describe('탭 위치가 필요한 경로 (가짜 레이아웃)', () => {
    const hover = { on: false }
    beforeEach(() => {
      hover.on = false
      const isStrip = (node: Element): boolean => node.hasAttribute('data-main-tab-strip')
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (isStrip(this)) return DOMRect.fromRect({ x: 0, y: 0, width: stripBox.clientWidth, height: 32 })
        const strip = this.parentElement
        if (!this.hasAttribute('data-main-tab') || strip === null || !isStrip(strip)) return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
        const index = [...strip.querySelectorAll(':scope > [data-main-tab]')].indexOf(this)
        const natural = index * 100 - strip.scrollLeft
        const left = this.hasAttribute('data-active-tab-dock') ? Math.min(Math.max(natural, 0), stripBox.clientWidth - 100) : natural
        return DOMRect.fromRect({ x: left, y: 0, width: 100, height: 32 })
      })
      const matches = Element.prototype.matches
      vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        if (selector === ':hover' && this.hasAttribute('data-main-tab-strip')) return hover.on
        return matches.call(this, selector)
      })
    })

    it('배경에서 화면 밖에 열린 탭은 보이게 스크롤한다 — 활성 탭은 그대로, 붙을 자리는 남긴다', () => {
      mount({ tabs: many.slice(0, 7), activeTabId: 't0' })
      setStripBox({ clientWidth: 400, scrollWidth: 700, scrollLeft: 0 })
      stripBox.scrollWidth = 800
      mount({ tabs: many, activeTabId: 't0' })
      // t7 제자리 700..800, 앞 가장자리에 붙을 t0 100px → 400 스크롤이면 t7 = 300..400
      expect(stripEl().scrollLeft).toBe(400)
      expect(tabEl('t0').hasAttribute('data-active-tab-dock')).toBe(true)
    })

    it('포인터가 스트립 위면 그 reveal 을 미뤘다가 나갈 때 한다 — 누르려던 탭이 밀려나지 않게', () => {
      mount({ tabs: many.slice(0, 7), activeTabId: 't0' })
      setStripBox({ clientWidth: 400, scrollWidth: 700, scrollLeft: 0 })
      stripBox.scrollWidth = 800
      hover.on = true
      mount({ tabs: many, activeTabId: 't0' })
      expect(stripEl().scrollLeft).toBe(0)
      hover.on = false
      act(() => {
        stripEl().dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
      })
      expect(stripEl().scrollLeft).toBe(400)
    })

    it('활성 탭을 닫아 멀리 있는 탭이 활성이 돼도 그 커밋엔 스트립이 튀지 않는다(hold)', () => {
      mount({ tabs: many, activeTabId: 't1' })
      setStripBox({ clientWidth: 400, scrollWidth: 800, scrollLeft: 0 })
      stripBox.scrollWidth = 700
      mount({ tabs: many.filter((row) => row.tabId !== 't1'), activeTabId: 't7' })
      expect(stripEl().scrollLeft).toBe(0)
      // 대조: 닫기 없이 같은 탭으로 활성만 옮기면 보이게 스크롤한다(t7 = 자리 600..700 → 300).
      mount({ tabs: many.filter((row) => row.tabId !== 't1'), activeTabId: 't6' })
      mount({ tabs: many.filter((row) => row.tabId !== 't1'), activeTabId: 't7' })
      expect(stripEl().scrollLeft).toBe(300)
    })
  })
})

// LIFE-496 K1·K2ⓐ — `+` 드롭다운의 DOM 계약 (Orca v1.4.219 `tab-bar-surface.tsx:201-286` · `TabBarCreateEntry.tsx`). 값(px·색)은 측정 도구·네이티브 캡처가 본다.
describe('+ 드롭다운 (LIFE-496)', () => {
  const plus = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[data-main-tabbar-add="g1"]')!
  const menu = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-tab-create-menu="g1"]')
  const input = (): HTMLInputElement => host.querySelector<HTMLInputElement>('[data-tab-create-input="g1"]')!
  const open = (): void => {
    act(() => plus().click())
  }
  const type = (value: string): void => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const key = (target: Element, keyName: string): void => {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }))
    })
  }
  const results = (): string[] => [...host.querySelectorAll<HTMLElement>('[data-tab-create-result]')].map((row) => row.dataset.tabCreateResult!)
  const selectedResult = (): string | undefined => host.querySelector<HTMLElement>('[data-tab-create-result][aria-selected="true"]')?.dataset.tabCreateResult
  const staticItems = (): string[] => [...host.querySelectorAll<HTMLElement>('[data-tab-create-item]')].map((row) => row.dataset.tabCreateItem!)
  const entry = (tabId: string, title: string, extra: Partial<OpenTabSearchEntry> = {}): OpenTabSearchEntry => ({
    tabId, groupId: 'g1', title, branch: 'main', agent: null, groupIndex: 0, tabIndex: 0, isCurrent: false, ...extra,
  })

  it('+ 클릭 = 메뉴가 열린다(빈 탭을 바로 만들지 않는다) · 다시 누르면 닫힌다 (Q3 ⓐ)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    expect(plus().getAttribute('aria-haspopup')).toBe('menu')
    open()
    expect(menu()).not.toBeNull()
    expect(plus().getAttribute('aria-expanded')).toBe('true')
    expect(spies.createShell).not.toHaveBeenCalled()
    open()
    expect(menu()).toBeNull()
  })

  it('빈 질의 = 입력창 · 새 터미널(⌘T 라벨) · 에이전트 카탈로그 순서 claude → codex → grok', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    expect(input().placeholder).toBe('열린 탭·에이전트 검색…')
    expect(staticItems()).toEqual(['new-terminal', 'agent:claude', 'agent:codex', 'agent:grok'])
    expect(host.querySelector('[data-tab-create-item="new-terminal"] .tab-create-shortcut')?.textContent).toMatch(/T/)
    expect(host.querySelectorAll('[data-tab-create-menu="g1"] [role="separator"]')).toHaveLength(2)
    expect(results()).toEqual([])
  })

  it('질의가 있으면 정적 메뉴를 숨기고 열린 탭 → 메뉴 매칭 → 에이전트 매칭 순으로 보인다', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0', entries: [entry('t0', 'claude', { agent: 'claude' }), entry('t1', 'logs')] })
    open()
    type('terminal')
    expect(staticItems()).toEqual([])
    expect(results()).toEqual(['tab:t0', 'tab:t1', 'menu:new-terminal'])
    type('claude')
    expect(results()).toEqual(['tab:t0', 'agent:claude'])
    expect(selectedResult()).toBe('tab:t0')
  })

  it('결과가 없으면 안내 상태 행', () => {
    mount({ tabs: [], activeTabId: null })
    open()
    type('zzz')
    expect(results()).toEqual([])
    expect(host.querySelector('[data-tab-create-status]')?.textContent).toBe('열린 탭·에이전트 검색…')
  })

  it('↑/↓ 는 결과 안에서 감기고 Enter 가 실행한다 — 다른 영역 탭을 고르면 그 영역으로', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0', entries: [entry('t0', 'build a'), entry('t5', 'build b', { groupId: 'g2', groupIndex: 1 })] })
    open()
    type('build')
    expect(selectedResult()).toBe('tab:t0')
    key(input(), 'ArrowDown')
    expect(selectedResult()).toBe('tab:t5')
    key(input(), 'ArrowDown')
    expect(selectedResult()).toBe('tab:t0')
    key(input(), 'ArrowUp')
    expect(selectedResult()).toBe('tab:t5')
    key(input(), 'Enter')
    expect(spies.activateTab).toHaveBeenCalledWith({ tabId: 't5', groupId: 'g2' })
    expect(menu()).toBeNull()
  })

  it('빈 질의 Enter = 새 터미널 (Orca onOpenDefaultTerminal)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    key(input(), 'Enter')
    expect(spies.createShell).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  it('결과가 없을 때 ↓ 는 정적 메뉴 첫 항목, ↑ 는 마지막 항목으로 — 메뉴 안에서는 끝에서 멈춘다', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    key(input(), 'ArrowDown')
    expect((document.activeElement as HTMLElement | null)?.dataset.tabCreateItem).toBe('new-terminal')
    key(document.activeElement!, 'ArrowUp')
    expect((document.activeElement as HTMLElement | null)?.dataset.tabCreateItem).toBe('new-terminal')
    act(() => input().focus())
    key(input(), 'ArrowUp')
    expect((document.activeElement as HTMLElement | null)?.dataset.tabCreateItem).toBe('agent:grok')
    key(document.activeElement!, 'ArrowDown')
    expect((document.activeElement as HTMLElement | null)?.dataset.tabCreateItem).toBe('agent:grok')
  })

  it('Quick-launch 클릭 = 그 에이전트 · 새 터미널 클릭 = 빈 탭', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => host.querySelector<HTMLButtonElement>('[data-tab-create-item="agent:codex"]')!.click())
    expect(spies.launch).toHaveBeenCalledWith('codex')
    expect(menu()).toBeNull()
    open()
    act(() => host.querySelector<HTMLButtonElement>('[data-tab-create-item="new-terminal"]')!.click())
    expect(spies.createShell).toHaveBeenCalledTimes(1)
  })

  it('Escape = 닫고 이 영역 터미널로 포커스(onActivate) · `+` 로 포커스를 돌려주지 않는다', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    key(input(), 'Escape')
    expect(menu()).toBeNull()
    expect(spies.activate).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(plus())
  })

  it('바깥 mousedown = 닫힘(포커스는 누른 곳 몫 — onActivate 없음)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menu()).toBeNull()
    expect(spies.activate).not.toHaveBeenCalled()
  })

  it('메뉴 안 키는 위로 새지 않는다 (K2ⓒ — window 리스너가 못 본다)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    open()
    key(input(), 'a')
    key(input(), 'ArrowDown')
    window.removeEventListener('keydown', seen)
    expect(seen).not.toHaveBeenCalled()
  })

  it('메뉴 안 mousedown 은 헤더(영역 활성 → 터미널 포커스)로 새지 않는다', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    spies.activate.mockReset()
    act(() => {
      menu()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(spies.activate).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
  })

  it('탭 0개 영역의 + 도 메뉴를 연다 (K2ⓐ · Orca #18024 류 무반응 없음)', () => {
    mount({ tabs: [], activeTabId: null })
    open()
    expect(menu()).not.toBeNull()
    expect(staticItems()[0]).toBe('new-terminal')
  })
})
