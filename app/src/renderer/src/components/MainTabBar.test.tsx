// @vitest-environment happy-dom
// LIFE-493 K1·K3 — 탭 모양의 DOM 계약(선두·활성 표시·닫기·중클릭·넘침 휠). 값(px·색)은 CSS 라 측정 도구·네이티브 캡처가 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAgentState } from '../../../shared/agent-state.js'
import { EMPTY_SESSION_DIGEST, type AgentStatus, type PaneRow, type TabRow } from '../../../shared/types.js'
import { GroupHeader, wheelToHorizontal } from './MainTabBar.js'

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
const spies = { close: vi.fn(), select: vi.fn() }
function mount(input: { tabs: TabRow[]; activeTabId: string | null; unread?: string[] }): void {
  const noop = (): void => {}
  act(() => {
    root.render(createElement(GroupHeader, {
      groupId: 'g1', tabs: input.tabs, workspaceTabCount: input.tabs.length, home: '/home', selectedPane: null, activeTabId: input.activeTabId,
      activeGroup: true, unreadPanes: new Set(input.unread ?? []), paneCount: 1, grid: null, zoomed: false,
      onActivate: noop, onSelectTab: spies.select, onCreateShell: noop, onCloseTab: spies.close, onRenameTab: noop, onClearTabName: noop,
      onSplitPane: noop, onMoveToGroup: noop, onZoom: noop, onClosePane: noop, onCloseGroup: null, otherGroups: [], onMoveToOtherGroup: noop, onTabDragStart: noop,
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
  spies.close.mockReset()
  spies.select.mockReset()
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

describe('넘침 최소선 (K3ⓐ)', () => {
  it('탭은 스크롤 스트립 안에 있고 `+` 는 스트립 밖 바로 뒤다', () => {
    mount({ tabs: [tab(0, [pane('a', 'claude', 'idle')])], activeTabId: 't0' })
    const strip = host.querySelector('[data-main-tab-strip="g1"]')
    expect(strip?.querySelector('[data-main-tab="t0"]')).not.toBeNull()
    expect(strip?.nextElementSibling?.hasAttribute('data-main-tabbar-add')).toBe(true)
  })

  it('활성 탭이 바뀌면 그 탭을 보이는 자리로 끌어온다', () => {
    const tabs = Array.from({ length: 5 }, (_, index) => tab(index, [pane(`p${index}`, 'claude', 'idle')]))
    mount({ tabs, activeTabId: 't0' })
    const spy = vi.mocked(Element.prototype.scrollIntoView)
    spy.mockClear()
    mount({ tabs, activeTabId: 't4' })
    expect(spy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(spy.mock.contexts[0]).toBe(tabEl('t4'))
  })

  it('휠: 넘칠 때 세로가 크면 가로로 바꾼다, 아니면 손대지 않는다', () => {
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 40, overflows: true })).toBe(40)
    expect(wheelToHorizontal({ deltaX: 0, deltaY: -40, overflows: true })).toBe(-40)
    expect(wheelToHorizontal({ deltaX: 30, deltaY: 10, overflows: true })).toBeNull()
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 40, overflows: false })).toBeNull()
  })
})
