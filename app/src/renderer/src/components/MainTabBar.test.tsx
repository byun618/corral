// @vitest-environment happy-dom
// LIFE-493 K1·K3 — 탭 모양의 DOM 계약(선두·활성 표시·닫기·중클릭·넘침 휠). 값(px·색)은 CSS 라 측정 도구·네이티브 캡처가 본다.
// LIFE-494 K1 — 넘침 표면(chevron·dock·썸·끝에 붙기)의 DOM 계약. 계산 자체는 `tab-strip-metrics.test.ts`·`tab-strip-geometry.test.ts`.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAgentState } from '../../../shared/agent-state.js'
import type { Keybindings } from '../../../shared/keybindings.js'
import { DEFAULT_SETTINGS, type DefaultAgent } from '../../../shared/terminal-settings.js'
import { EMPTY_SESSION_DIGEST, type AgentStatus, type PaneRow, type TabRow } from '../../../shared/types.js'
import { BindingLabels } from '../hooks/BindingLabels.js'
import { resetSettingsStoreForTest, updateSettings } from '../settings-store.js'
import { GroupHeader } from './MainTabBar.js'
import type { OpenTabSearchEntry } from '../tab-create-menu.js'

/** 조회 결과가 있음을 확인하고 좁힌다 — 비 null 단언 대신(LIFE-515 fix1 R1-03). 없으면 그 자리에서 실패한다. */
function found<T>({ value, what }: { value: T | null | undefined; what: string }): T {
  if (value === null || value === undefined) throw new Error(`${what} 없음`)
  return value
}

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
const spies = {
  close: vi.fn(), select: vi.fn(), createShell: vi.fn(), launch: vi.fn(), activateTab: vi.fn(), activate: vi.fn(),
  requestRename: vi.fn(), togglePin: vi.fn(), closeScope: vi.fn(), setColor: vi.fn(), openAgentSettings: vi.fn(), dragStart: vi.fn(),
}
function mount(input: {
  tabs: TabRow[]
  activeTabId: string | null
  unread?: string[]
  dragActive?: boolean
  entries?: OpenTabSearchEntry[]
  pinned?: string[]
  colors?: Record<string, string>
  renameRequest?: { tabId: string; token: number } | null
  overrides?: Keybindings
}): void {
  const noop = (): void => {}
  act(() => {
    root.render(createElement(BindingLabels.Provider, { value: input.overrides ?? {} }, createElement(GroupHeader, {
      groupId: 'g1', tabs: input.tabs, workspaceTabCount: input.tabs.length, home: '/home', selectedPane: null, activeTabId: input.activeTabId,
      activeGroup: true, unreadPanes: new Set(input.unread ?? []), paneCount: 1, grid: null, zoomed: false,
      onActivate: spies.activate, onSelectTab: spies.select, onCreateShell: spies.createShell, onCloseTab: spies.close, onRenameTab: noop, onClearTabName: noop,
      onSplitPane: noop, onSplitTab: noop, onMoveToGroup: noop, onZoom: noop,
      pinnedTabs: new Set(input.pinned ?? []), tabColorOf: (tabId: string) => input.colors?.[tabId] ?? null, renameRequest: input.renameRequest ?? null,
      onRequestRename: spies.requestRename, onTogglePin: spies.togglePin, onCloseScope: spies.closeScope, onSetTabColor: spies.setColor, onClosePane: noop, onCloseGroup: null, otherGroups: [], onMoveToOtherGroup: noop, onTabDragStart: spies.dragStart,
      tabDragActive: input.dragActive ?? false,
      openTabEntries: input.entries ?? [], onLaunchAgent: spies.launch, onOpenAgentSettings: spies.openAgentSettings, onActivateOpenTab: spies.activateTab,
    })))
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
  const key = ({ target, name }: { target: Element; name: string }): void => {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    })
  }
  const results = (): string[] => [...host.querySelectorAll<HTMLElement>('[data-tab-create-result]')].map((row) => row.dataset.tabCreateResult!)
  const selectedResult = (): string | undefined => host.querySelector<HTMLElement>('[data-tab-create-result][aria-selected="true"]')?.dataset.tabCreateResult
  const staticItems = (): string[] => [...host.querySelectorAll<HTMLElement>('[data-tab-create-item]')].map((row) => row.dataset.tabCreateItem!)
  const entry = ({ tabId, title, ...extra }: Partial<OpenTabSearchEntry> & { tabId: string; title: string }): OpenTabSearchEntry => ({
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

  it('빈 질의 = 입력창 · 새 터미널(⌘T 라벨) · 에이전트 카탈로그 순서 claude → codex → grok · Agent 설정…(LIFE-515)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    expect(input().placeholder).toBe('열린 탭, 에이전트 검색…')
    expect(staticItems()).toEqual(['new-terminal', 'agent:claude', 'agent:codex', 'agent:grok', 'agent-settings'])
    expect(host.querySelector('[data-tab-create-item="new-terminal"] .tab-create-shortcut')?.textContent).toMatch(/T/)
    expect(host.querySelectorAll('[data-tab-create-menu="g1"] [role="separator"]')).toHaveLength(2)
    expect(results()).toEqual([])
  })

  it('질의가 있으면 정적 메뉴를 숨기고 열린 탭 → 메뉴 매칭 → 에이전트 매칭 순으로 보인다', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0', entries: [entry({ tabId: 't0', title: 'claude', agent: 'claude' }), entry({ tabId: 't1', title: 'logs' })] })
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
    expect(host.querySelector('[data-tab-create-status]')?.textContent).toBe('열린 탭, 에이전트 검색…')
  })

  it('↑/↓ 는 결과 안에서 감기고 Enter 가 실행한다 — 다른 영역 탭을 고르면 그 영역으로', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0', entries: [entry({ tabId: 't0', title: 'build a' }), entry({ tabId: 't5', title: 'build b', groupId: 'g2', groupIndex: 1 })] })
    open()
    type('build')
    expect(selectedResult()).toBe('tab:t0')
    key({ target: input(), name: 'ArrowDown' })
    expect(selectedResult()).toBe('tab:t5')
    key({ target: input(), name: 'ArrowDown' })
    expect(selectedResult()).toBe('tab:t0')
    key({ target: input(), name: 'ArrowUp' })
    expect(selectedResult()).toBe('tab:t5')
    key({ target: input(), name: 'Enter' })
    expect(spies.activateTab).toHaveBeenCalledWith({ tabId: 't5', groupId: 'g2' })
    expect(menu()).toBeNull()
  })

  it('빈 질의 Enter = 새 터미널 (Orca onOpenDefaultTerminal)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    key({ target: input(), name: 'Enter' })
    expect(spies.createShell).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  it('결과가 없을 때 ↓ 는 정적 메뉴 첫 항목, ↑ 는 마지막 항목으로 — 첫 항목의 ↑ 는 입력창으로, 마지막에서는 멈춘다', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    key({ target: input(), name: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-tab-create-item')).toBe('new-terminal')
    // R1-02 — Orca `use-tab-entry-menu-return-focus.ts`: 첫 menuitem 의 ArrowUp 은 검색창으로 돌아간다(왕복).
    key({ target: document.activeElement!, name: 'ArrowUp' })
    expect(document.activeElement).toBe(input())
    expect(menu()).not.toBeNull()
    key({ target: input(), name: 'ArrowUp' })
    // LIFE-515 K5ⓒ — 마지막 정적 항목은 「Agent 설정…」 이다(순환에 포함).
    expect(document.activeElement?.getAttribute('data-tab-create-item')).toBe('agent-settings')
    key({ target: document.activeElement!, name: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-tab-create-item')).toBe('agent-settings')
    key({ target: found({ value: document.activeElement, what: '포커스 요소' }), name: 'ArrowUp' })
    expect(document.activeElement?.getAttribute('data-tab-create-item')).toBe('agent:grok')
  })

  it('메뉴가 열린 채 전역 단축키(⌘T)가 새 터미널로 포커스를 옮기면 메뉴가 닫힌다 — 포커스는 터미널에 남는다 (R1-01)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    // `useKeybindings` 와 같은 document **캡처** 단축키 — 메뉴의 버블 stopPropagation 보다 먼저 돈다.
    const terminal = document.createElement('textarea')
    document.body.append(terminal)
    const shortcut = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.key !== 't') return
      spies.createShell()
      terminal.focus()
    }
    document.addEventListener('keydown', shortcut, true)
    try {
      act(() => {
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true, cancelable: true }))
      })
      expect(spies.createShell).toHaveBeenCalledTimes(1)
      expect(menu()).toBeNull()
      expect(document.activeElement).toBe(terminal)
      expect(spies.activate).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', shortcut, true)
      terminal.remove()
    }
  })

  it('포커스가 메뉴 밖으로 나가면(Tab 등) 메뉴가 남지 않는다 · 메뉴 안 이동은 닫지 않는다 (R1-01)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    act(() => host.querySelector<HTMLButtonElement>('[data-tab-create-item="agent:claude"]')!.focus())
    expect(menu()).not.toBeNull()
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      act(() => outside.focus())
      expect(menu()).toBeNull()
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it('늦게 온 focusin(이미 지난 포커스가 대상) 은 닫지 않는다 — 판정은 지금 포커스로 한다 (fix1 격리 예행 r1)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    const stale = document.createElement('textarea')
    document.body.append(stale)
    try {
      act(() => {
        stale.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      })
      expect(menu()).not.toBeNull()
      expect(document.activeElement).toBe(input())
    } finally {
      stale.remove()
    }
  })

  it('IME 조합 중 Escape 는 메뉴를 닫지 않는다 — 조합 취소다 (R1-06, menu-bus useWindowEscape 와 같은 원칙)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    })
    expect(menu()).not.toBeNull()
    expect(spies.activate).not.toHaveBeenCalled()
    key({ target: input(), name: 'Escape' })
    expect(menu()).toBeNull()
  })

  it('열린 메뉴의 + 를 다시 누르면 닫힌다 — 실제 mousedown·mouseup·click, 헤더 활성화가 터미널로 포커스를 옮겨도 (R3-01)', () => {
    const terminal = document.createElement('textarea')
    document.body.append(terminal)
    // App 의 onActivate → activateGroup → selectPane → focusToken → TerminalPane 의 focus() 대역.
    spies.activate.mockImplementation(() => terminal.focus())
    const press = (): void => {
      for (const type of ['mousedown', 'mouseup', 'click'])
        act(() => {
          plus().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
        })
    }
    try {
      mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
      press()
      // 첫 누름은 그 영역을 활성으로 만든다(기존 동작) — 그리고 메뉴가 열린다.
      expect(spies.activate).toHaveBeenCalledTimes(1)
      expect(menu()).not.toBeNull()
      act(() => input().focus())
      press()
      expect(menu()).toBeNull()
      expect(plus().getAttribute('aria-expanded')).toBe('false')
    } finally {
      terminal.remove()
    }
  })

  it('열린 메뉴의 + 를 우클릭 → 헤더 메뉴 → Escape 뒤 키가 터미널에 간다 — 왼쪽 누름만 헤더 활성화를 건너뛴다 (R4-01)', () => {
    const terminal = document.createElement('textarea')
    document.body.append(terminal)
    const arrived: string[] = []
    terminal.addEventListener('keydown', (event) => arrived.push(event.key))
    spies.activate.mockImplementation(() => terminal.focus())
    const mouse = ({ type, button }: { type: string; button: number }): void => {
      act(() => {
        plus().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button }))
      })
    }
    try {
      mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
      for (const type of ['mousedown', 'mouseup', 'click']) mouse({ type, button: 0 })
      expect(menu()).not.toBeNull()
      act(() => input().focus())
      spies.activate.mockClear()
      for (const type of ['mousedown', 'mouseup', 'contextmenu']) mouse({ type, button: 2 })
      expect(spies.activate).toHaveBeenCalledTimes(1)
      expect(host.querySelector('[data-tab-menu]')).not.toBeNull()
      act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(host.querySelector('[data-tab-menu]')).toBeNull()
      act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
      })
      expect(document.activeElement).toBe(terminal)
      expect(arrived).toContain('a')
    } finally {
      terminal.remove()
    }
  })

  it('새 탭이 이 영역에서 활성이 되면(⌘T) focus 이벤트가 없어도 메뉴가 닫힌다 — 뒤 Escape 도 메뉴를 되살리지 않는다 (R3-02)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    const terminal = document.createElement('textarea')
    document.body.append(terminal)
    // terminal.new 대역 — 새 탭이 활성이 되고 activeElement 만 새 터미널로 바뀐다. focus·focusin 이벤트는 내지 않는다.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => terminal })
    try {
      mount({ tabs: [tab(0, [pane('p0', null, 'idle')]), tab(1, [pane('p1', null, 'idle')])], activeTabId: 't1' })
      expect(menu()).toBeNull()
      key({ target: terminal, name: 'Escape' })
      expect(menu()).toBeNull()
    } finally {
      Reflect.deleteProperty(document, 'activeElement')
      terminal.remove()
    }
  })

  it('대조: 활성 탭·선택 pane 이 그대로면 다시 그려도 메뉴는 남는다 (R3-02)', () => {
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    mount({ tabs: [tab(0, [pane('p0', 'claude', 'working')])], activeTabId: 't0' })
    expect(menu()).not.toBeNull()
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
    key({ target: input(), name: 'Escape' })
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
    key({ target: input(), name: 'a' })
    key({ target: input(), name: 'ArrowDown' })
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

describe('LIFE-495 탭 메뉴·핀·색 (K1·K2·K3·K4)', () => {
  const tabs3 = (): TabRow[] => [tab(0, [pane('a', null, 'idle')]), tab(1, [pane('b', null, 'idle')]), tab(2, [pane('c', null, 'idle')])]
  const openMenu = (tabId: string): HTMLElement => {
    act(() => {
      tabEl(tabId).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 10 }))
    })
    const menu = host.querySelector<HTMLElement>(`[data-tab-menu="${tabId}"]`)
    if (menu === null) throw new Error('menu not open')
    return menu
  }
  /** 메뉴 항목의 순서 — 각 항목의 첫 `data-tab-menu-*` 속성 이름(탭 id 값을 가진 것). */
  const itemOrder = (menu: HTMLElement): string[] =>
    [...menu.querySelectorAll<HTMLElement>('.repo-row-menu-item')].map((item) => [...item.attributes].map((attribute) => attribute.name).find((name) => name.startsWith('data-tab-menu-')) ?? '?')

  it('K1ⓐ 항목 순서 = 220: 영역으로 옮기기(우·좌·하·상) → pane 분할 → 핀 → 닫기·다른·오른쪽·왼쪽 → 제목 바꾸기·이름 지우기 → 탭 색', () => {
    mount({ tabs: tabs3(), activeTabId: 't0' })
    const menu = openMenu('t1')
    expect(itemOrder(menu)).toEqual([
      'data-tab-menu-move-right', 'data-tab-menu-move-left', 'data-tab-menu-move-down', 'data-tab-menu-move-up',
      'data-tab-menu-split-right', 'data-tab-menu-split-down',
      'data-tab-menu-pin',
      'data-tab-menu-close', 'data-tab-menu-close-others', 'data-tab-menu-close-right', 'data-tab-menu-close-left',
      'data-tab-menu-rename', 'data-tab-menu-clear',
    ])
    expect(menu.querySelectorAll('[data-tab-menu-color]')).toHaveLength(10)
    expect(menu.querySelector('[data-tab-menu-colors]')?.compareDocumentPosition(menu.querySelector('[data-tab-menu-clear]')!)).toBe(Node.DOCUMENT_POSITION_PRECEDING)
  })

  it('K2ⓑ 닫을 대상이 없으면 비활성 — 오른쪽에 핀 탭만 있으면 「오른쪽 탭 닫기」 비활성, 누르면 아무 일 없다', () => {
    mount({ tabs: tabs3(), activeTabId: 't0', pinned: ['t0', 't2'] })
    const menu = openMenu('t1')
    const right = menu.querySelector<HTMLElement>('[data-tab-menu-close-right]')!
    expect(right.dataset.disabled).toBe('true')
    act(() => right.click())
    expect(spies.closeScope).not.toHaveBeenCalled()
    expect(menu.querySelector<HTMLElement>('[data-tab-menu-close-others]')?.dataset.disabled).toBe('true')
  })

  it('터미널(xterm)에 포커스가 있어도 Esc 가 메뉴를 닫고, 그 Esc 는 터미널로 가지 않는다 (G4 r2 — xterm 이 전파를 끊는다)', () => {
    mount({ tabs: tabs3(), activeTabId: 't0' })
    openMenu('t1')
    const term = document.createElement('textarea')
    document.body.append(term)
    const reached = vi.fn()
    term.addEventListener('keydown', (event) => {
      reached()
      event.stopPropagation()
    })
    act(() => {
      term.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(host.querySelector('[data-tab-menu]')).toBeNull()
    expect(reached).not.toHaveBeenCalled()
    term.remove()
  })

  it('K2 bulk 항목은 기준 탭·범위를 넘긴다', () => {
    mount({ tabs: tabs3(), activeTabId: 't0' })
    const left = openMenu('t1').querySelector<HTMLElement>('[data-tab-menu-close-left]')!
    act(() => left.click())
    expect(spies.closeScope).toHaveBeenCalledWith(expect.objectContaining({ scope: 'left', tab: expect.objectContaining({ tabId: 't1' }) }))
  })

  it('K3ⓐⓑ 핀 탭 — 제목 앞 핀 아이콘, × 없음, 중클릭 무시, 메뉴 「닫기」 비활성·「탭 고정 해제」', () => {
    mount({ tabs: tabs3(), activeTabId: 't0', pinned: ['t0'] })
    const pinnedTab = tabEl('t0')
    expect(pinnedTab.dataset.tabPinned).toBe('true')
    expect(pinnedTab.querySelector('.main-tab-pin')).not.toBeNull()
    expect(pinnedTab.querySelector('[data-main-tab-close]')).toBeNull()
    expect(tabEl('t1').querySelector('[data-main-tab-close]')).not.toBeNull()
    act(() => {
      pinnedTab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    })
    expect(spies.close).not.toHaveBeenCalled()
    const menu = openMenu('t0')
    expect(menu.querySelector<HTMLElement>('[data-tab-menu-close]')?.dataset.disabled).toBe('true')
    const pin = menu.querySelector<HTMLElement>('[data-tab-menu-pin]')!
    expect(pin.textContent).toContain('탭 고정 해제')
    act(() => pin.click())
    expect(spies.togglePin).toHaveBeenCalledWith(expect.objectContaining({ tabId: 't0' }))
  })

  it('K4ⓑ 색 점 — 제목 뒤, 이름 편집 중엔 숨긴다 · swatch 선택 표시와 None 해제', () => {
    mount({ tabs: tabs3(), activeTabId: 't0', colors: { t1: '#22c55e' } })
    const dot = tabEl('t1').querySelector<HTMLElement>('[data-tab-color-dot]')
    expect(dot?.dataset.tabColorDot).toBe('#22c55e')
    expect(tabEl('t1').querySelector('.main-tab-label')?.nextElementSibling).toBe(dot)
    const menu = openMenu('t1')
    expect(menu.querySelector<HTMLElement>('[data-tab-menu-color="#22c55e"]')?.dataset.selected).toBe('true')
    act(() => menu.querySelector<HTMLElement>('[data-tab-menu-color="none"]')!.click())
    expect(spies.setColor).toHaveBeenCalledWith(expect.objectContaining({ color: null }))
    // 편집 중이면 점이 숨는다(이름 편집 요청 = ⌘R 과 같은 길).
    mount({ tabs: tabs3(), activeTabId: 't0', colors: { t1: '#22c55e' }, renameRequest: { tabId: 't1', token: 1 } })
    expect(tabEl('t1').dataset.tabEditing).toBe('true')
    expect(tabEl('t1').querySelector('[data-tab-color-dot]')).toBeNull()
  })

  it('「제목 바꾸기」는 편집 요청을 올린다 — 실제 편집은 renameRequest 로 연다(⌘R 과 같은 길)', () => {
    mount({ tabs: tabs3(), activeTabId: 't0' })
    const rename = openMenu('t2').querySelector<HTMLElement>('[data-tab-menu-rename]')!
    act(() => rename.click())
    expect(spies.requestRename).toHaveBeenCalledWith('t2')
    expect(tabEl('t2').dataset.tabEditing).toBe('false')
    mount({ tabs: tabs3(), activeTabId: 't0', renameRequest: { tabId: 't2', token: 1 } })
    expect(tabEl('t2').dataset.tabEditing).toBe('true')
    expect(document.activeElement).toBe(tabEl('t2').querySelector('[data-tab-rename]'))
  })

  it('fix1 R1-01 두 탭을 오가는 rename 요청 — 앞 탭의 요청 해제(0)는 그 탭 편집을 다시 열지 않는다', () => {
    mount({ tabs: tabs3(), activeTabId: 't1' })
    mount({ tabs: tabs3(), activeTabId: 't1', renameRequest: { tabId: 't1', token: 1 } })
    expect(document.activeElement).toBe(tabEl('t1').querySelector('[data-tab-rename]'))
    act(() => {
      tabEl('t1').querySelector<HTMLElement>('[data-tab-rename]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(tabEl('t1').dataset.tabEditing).toBe('false')
    mount({ tabs: tabs3(), activeTabId: 't0', renameRequest: { tabId: 't0', token: 2 } })
    expect(tabEl('t1').dataset.tabEditing).toBe('false')
    expect(tabEl('t0').dataset.tabEditing).toBe('true')
    expect(document.activeElement?.getAttribute('data-tab-rename')).toBe('t0')
  })

  it('K1ⓓ 헤더 모드(⊞) — 같은 항목, 대상은 활성 탭', () => {
    mount({ tabs: tabs3(), activeTabId: 't1' })
    act(() => host.querySelector<HTMLElement>('[data-group-menu]')!.click())
    const menu = host.querySelector<HTMLElement>('[data-tab-menu="t1"]')!
    expect(menu.querySelector('[data-tab-menu-header-mode]')).not.toBeNull()
    expect(itemOrder(menu)).toContain('data-tab-menu-close-others')
    expect(itemOrder(menu)).toContain('data-tab-menu-rename')
    act(() => menu.querySelector<HTMLElement>('[data-tab-menu-close-right]')!.click())
    expect(spies.closeScope).toHaveBeenCalledWith(expect.objectContaining({ scope: 'right', tab: expect.objectContaining({ tabId: 't1' }) }))
  })
})

// LIFE-515 K4·K5 — 기본 에이전트 순서·⌘⌥T 칩·「Agent 설정…」 (Orca 198 `QuickLaunchButton.tsx:46-59·205-250`).
describe('+ 메뉴 기본 에이전트 (LIFE-515)', () => {
  const plus = (): HTMLButtonElement => found({ value: host.querySelector<HTMLButtonElement>('[data-main-tabbar-add="g1"]'), what: '+ 버튼' })
  const input = (): HTMLInputElement => found({ value: host.querySelector<HTMLInputElement>('[data-tab-create-input="g1"]'), what: '메뉴 입력창' })
  const open = (): void => {
    act(() => plus().click())
  }
  const close = (): void => {
    if (host.querySelector('[data-tab-create-menu="g1"]') !== null) act(() => plus().click())
  }
  const staticItems = (): string[] => [...host.querySelectorAll<HTMLElement>('[data-tab-create-item]')].map((row) => found({ value: row.dataset.tabCreateItem, what: '항목 id' }))
  const chips = (): { item: string; text: string }[] =>
    [...host.querySelectorAll<HTMLElement>('[data-tab-create-default-agent-shortcut]')].map((chip) => ({ item: found({ value: found({ value: chip.closest<HTMLElement>('[data-tab-create-item]'), what: '칩의 항목' }).dataset.tabCreateItem, what: '항목 id' }), text: chip.textContent ?? '' }))
  const withDefault = (defaultAgent: DefaultAgent): void => resetSettingsStoreForTest({ ...DEFAULT_SETTINGS, defaultAgent })
  const key = ({ target, name }: { target: Element; name: string }): void => {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    })
  }
  afterEach(() => resetSettingsStoreForTest(null))

  it.each([
    ['auto', ['new-terminal', 'agent:claude', 'agent:codex', 'agent:grok', 'agent-settings'], []],
    ['blank', ['new-terminal', 'agent:claude', 'agent:codex', 'agent:grok', 'agent-settings'], []],
    ['claude', ['new-terminal', 'agent:claude', 'agent:codex', 'agent:grok', 'agent-settings'], [{ item: 'agent:claude', text: '⌘⌥T' }]],
    ['codex', ['new-terminal', 'agent:codex', 'agent:claude', 'agent:grok', 'agent-settings'], [{ item: 'agent:codex', text: '⌘⌥T' }]],
    ['grok', ['new-terminal', 'agent:grok', 'agent:claude', 'agent:codex', 'agent-settings'], [{ item: 'agent:grok', text: '⌘⌥T' }]],
  ] as const)('기본값 %s — 명시 에이전트만 맨 앞 + ⌘⌥T 칩, 자동·agent 없음은 카탈로그 순서·칩 없음 (K4ⓐⓑ)', (value, order, chip) => {
    withDefault(value)
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    expect(staticItems()).toEqual(order)
    expect(chips()).toEqual(chip)
  })

  it('칩 문자열은 레지스트리 라벨 — 재정의를 따르고, 「없음」 이면 칩이 없다 (K4ⓑ)', () => {
    withDefault('codex')
    mount({ tabs: [], activeTabId: null, overrides: { 'terminal.newAgent': ['Mod+Alt+Shift+T'] } })
    open()
    expect(chips()).toEqual([{ item: 'agent:codex', text: '⌘⌥⇧T' }])
    close()
    mount({ tabs: [], activeTabId: null, overrides: { 'terminal.newAgent': [null] } })
    open()
    expect(chips()).toEqual([])
    // 다른 액션이 ⌘⌥T 를 가져가 비켜 선 경우도 칩이 없다(YIELDING_DEFAULTS).
    close()
    mount({ tabs: [], activeTabId: null, overrides: { 'sidebar.toggle': ['Mod+Alt+T'] } })
    open()
    expect(chips()).toEqual([])
  })

  it('설정을 바꾸면 다음에 열 때 반영된다 · 열린 동안 바뀌어도 따라간다 (K4ⓒ)', async () => {
    withDefault('auto')
    mount({ tabs: [], activeTabId: null })
    open()
    expect(staticItems().slice(1, 4)).toEqual(['agent:claude', 'agent:codex', 'agent:grok'])
    await act(async () => { await updateSettings({ defaultAgent: 'grok' }) })
    expect(staticItems().slice(1, 4)).toEqual(['agent:grok', 'agent:claude', 'agent:codex'])
    close()
    open()
    expect(staticItems().slice(1, 4)).toEqual(['agent:grok', 'agent:claude', 'agent:codex'])
    expect(chips()).toEqual([{ item: 'agent:grok', text: '⌘⌥T' }])
  })

  it('검색 결과의 에이전트 순서는 바꾸지 않는다 — 점수·카탈로그 순서 (K4ⓓ)', () => {
    withDefault('grok')
    mount({ tabs: [], activeTabId: null })
    open()
    act(() => {
      const setter = found({ value: found({ value: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'), what: 'value 서술자' }).set, what: 'value setter' })
      setter.call(input(), 'co')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...host.querySelectorAll<HTMLElement>('[data-tab-create-result]')].map((row) => row.dataset.tabCreateResult)).toEqual(['agent:codex'])
    // 질의가 있으면 「Agent 설정…」 도 정적 메뉴와 함께 숨는다(K5ⓐ).
    expect(staticItems()).toEqual([])
  })

  it('키보드 ↓ 이동이 새 순서를 따르고 Enter(=클릭)가 그 에이전트를 실행한다 (K4ⓔ)', () => {
    withDefault('codex')
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    act(() => input().focus())
    key({ target: input(), name: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-tab-create-item')).toBe('new-terminal')
    key({ target: found({ value: document.activeElement, what: '포커스 요소' }), name: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-tab-create-item')).toBe('agent:codex')
    key({ target: found({ value: document.activeElement, what: '포커스 요소' }), name: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-tab-create-item')).toBe('agent:claude')
    // 버튼의 Enter 는 브라우저가 click 으로 바꾼다 — happy-dom 은 바꾸지 않으므로 click 으로 대신한다.
    act(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.click()
    })
    expect(spies.launch).toHaveBeenCalledWith('claude')
  })

  it('「Agent 설정…」 — 끝 행 · 설정 아이콘 · muted · 클릭 = 메뉴 닫힘 + onOpenAgentSettings (K5ⓐⓑ)', () => {
    withDefault('auto')
    mount({ tabs: [tab(0, [pane('p0', null, 'idle')])], activeTabId: 't0' })
    open()
    const item = found({ value: host.querySelector<HTMLButtonElement>('[data-tab-create-item="agent-settings"]'), what: '「Agent 설정…」 행' })
    expect(item.textContent).toBe('Agent 설정…')
    expect(item.getAttribute('role')).toBe('menuitem')
    expect(item.classList.contains('is-muted')).toBe(true)
    expect(item.querySelector('svg.tab-create-item-icon')).not.toBeNull()
    act(() => item.click())
    expect(host.querySelector('[data-tab-create-menu="g1"]')).toBeNull()
    expect(spies.openAgentSettings).toHaveBeenCalledTimes(1)
    expect(spies.launch).not.toHaveBeenCalled()
  })
})

describe('포털 메뉴 mousedown (LIFE-530)', () => {
  const mousedown = (node: Element): void => {
    act(() => {
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    })
  }
  it('탭 우클릭 메뉴의 빈 자리(섹션 제목·구분선·바탕)·항목 mousedown 은 탭 드래그를 무장하지 않는다 — 탭 자체 mousedown 은 무장한다', () => {
    mount({ tabs: [tab(0, [pane('p1', null, 'idle')]), tab(1, [pane('p2', null, 'idle')])], activeTabId: 't0' })
    act(() => {
      tabEl('t0').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 10 }))
    })
    const menu = found({ value: document.querySelector('[data-tab-menu="t0"]'), what: '탭 메뉴' })
    const section = found({ value: menu.querySelector('.tab-menu-section'), what: '섹션 제목' })
    const separator = found({ value: menu.querySelector('.repo-row-menu-sep'), what: '구분선' })
    const item = found({ value: menu.querySelector('[data-tab-menu-pin]'), what: '핀 항목' })
    for (const node of [section, separator, menu, item]) mousedown(node)
    expect(spies.dragStart).not.toHaveBeenCalled()
    expect(document.querySelector('[data-tab-menu="t0"]')).not.toBeNull()
    mousedown(tabEl('t1'))
    expect(spies.dragStart).toHaveBeenCalledTimes(1)
  })
  it('빈 자리 mousedown 은 기본 동작을 막고(터미널 포커스 유지) 탭바 활성(onActivate)으로도 새지 않는다', () => {
    mount({ tabs: [tab(0, [pane('p1', null, 'idle')])], activeTabId: 't0' })
    act(() => {
      tabEl('t0').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 10 }))
    })
    const section = found({ value: document.querySelector('[data-tab-menu="t0"] .tab-menu-section'), what: '섹션 제목' })
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    act(() => {
      section.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(spies.activate).not.toHaveBeenCalled()
  })
})
