// @vitest-environment happy-dom
// LIFE-822 — 파일 탭 무음 실패 정리의 DOM 계약: 헤더 ▥▤ 흐림+사유(C2) · ⊞·빈 곳 우클릭이 파일 탭 메뉴(헤더 모드)를 띄움(C3) ·
// 파일 탭 「새 영역으로 옮기기」 흐림(C4) · 「왼쪽 탭 닫기」(C5) · 「모두 닫기」「저장된 탭 닫기」 두 메뉴 모두(C7).
// 섞인 닫기의 순서(C6)는 `tab-actions.test.ts` `closeMixedTabs`, ⌘D 안내(C1)는 `file-tabs.test.ts` `splitKeyRoute`.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAgentState } from '../../../shared/agent-state.js'
import { EMPTY_SESSION_DIGEST, type TabRow } from '../../../shared/types.js'
import { BindingLabels } from '../hooks/BindingLabels.js'
import { fileTabId } from '../file-tabs.js'
import { ONE_TAB_IN_GROUP } from '../group-tree.js'
import { GroupHeader, type GroupTabItem } from './MainTabBar.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const terminal: TabRow = {
  tabId: 'w1:t1', workspaceId: 'w1', label: '셸', number: 1, order: 0, agentStatus: 'idle', focused: false, digest: EMPTY_SESSION_DIGEST,
  panes: [{ paneId: 'p1', tabId: 'w1:t1', workspaceId: 'w1', title: '', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: false, agentSession: null, digest: EMPTY_SESSION_DIGEST }],
}
const file = (rel: string, extra?: { dirty?: boolean }): GroupTabItem => ({ kind: 'file', tabId: fileTabId(rel), rel, preview: false, deleted: false, dirty: extra?.dirty ?? false })

const spies = {
  splitPane: vi.fn<(direction: 'right' | 'down') => void>(),
  moveToGroup: vi.fn<(input: { tabId: string; direction: string }) => void>(),
  closeFileScope: vi.fn<(input: { tabId: string; scope: string }) => void>(),
  closeScope: vi.fn<(input: { tab: TabRow; scope: string }) => void>(),
  closeFileTab: vi.fn<(tabId: string) => void>(),
}

let host: HTMLDivElement
let root: Root
function mount(input: { items: GroupTabItem[]; activeTabId: string | null }): void {
  const noop = (): void => {}
  const tabs = input.items.flatMap((item) => (item.kind === 'terminal' ? [item.tab] : []))
  act(() => {
    root.render(
      createElement(
        BindingLabels.Provider,
        { value: {} },
        createElement(GroupHeader, {
          groupId: 'g1', tabs, items: input.items, workspaceTabCount: tabs.length, home: '/home', selectedPane: null, activeTabId: input.activeTabId,
          activeGroup: true, unreadPanes: new Set<string>(), paneCount: 1, grid: null, zoomed: false,
          onActivate: noop, onSelectTab: noop, onCreateShell: noop, onCloseTab: noop, onRenameTab: noop, onClearTabName: noop,
          onSplitPane: spies.splitPane, onSplitTab: noop, onMoveToGroup: spies.moveToGroup, onZoom: noop,
          pinnedTabs: new Set<string>(), tabColorOf: () => null, renameRequest: null,
          onRequestRename: noop, onTogglePin: noop, onCloseScope: spies.closeScope, onSetTabColor: noop, onClosePane: noop, onCloseGroup: null,
          otherGroups: [], onMoveToOtherGroup: noop, onTabDragStart: noop, tabDragActive: false,
          openTabEntries: [], onLaunchAgent: noop, onOpenAgentSettings: noop, onActivateOpenTab: noop,
          onCloseFileTab: spies.closeFileTab, onCloseFileScope: spies.closeFileScope,
        }),
      ),
    )
  })
}
const el = (selector: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(selector)
  if (node === null) throw new Error(`없음: ${selector}`)
  return node
}
const click = (node: HTMLElement): void => act(() => void node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
const contextMenu = (node: HTMLElement): void => act(() => void node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 10 })))
/** 메뉴 항목 — 파일 탭 메뉴는 `data-menu-action`, 터미널 탭 메뉴는 `data-tab-menu-*`. */
const fileItem = (action: string): HTMLElement => el(`[data-file-tab-menu] [data-menu-action="${action}"]`)
const labels = (selector: string): string[] => [...document.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent ?? '')

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Element.prototype.scrollIntoView = vi.fn()
  Reflect.set(window, 'corral', { activateWindow: () => {} })
  for (const spy of Object.values(spies)) spy.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('C2 헤더 ▥▤ — 파일 탭이 활성이면 흐림 + 사유', () => {
  it('파일 탭 활성 → 두 버튼 disabled · title 은 ⌘⌥D 로 새 영역 · 눌러도 분할 요청 없음', () => {
    mount({ items: [{ kind: 'terminal', tab: terminal }, file('src/a.ts')], activeTabId: fileTabId('src/a.ts') })
    for (const selector of ['[data-group-split-right="g1"]', '[data-group-split-down="g1"]']) {
      const button = el(selector)
      expect(button.hasAttribute('disabled')).toBe(true)
      expect(button.title).toBe('파일 탭은 pane 으로 나눌 수 없다 — ⌘⌥D 로 새 영역에 옮긴다')
      click(button)
    }
    expect(spies.splitPane).not.toHaveBeenCalled()
  })
  it('fix1 R1-5 영역에 탭이 하나뿐이면 title 이 거절될 ⌘⌥D 로 안내하지 않는다', () => {
    mount({ items: [file('src/a.ts')], activeTabId: fileTabId('src/a.ts') })
    const button = el('[data-group-split-right="g1"]')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.title).not.toContain('⌘⌥D')
    expect(button.title).toContain('탭이 하나뿐이라')
  })
  it('터미널 탭 활성 → 지금과 같다(켜짐·분할 title·누르면 분할)', () => {
    mount({ items: [{ kind: 'terminal', tab: terminal }, file('src/a.ts')], activeTabId: 'w1:t1' })
    const right = el('[data-group-split-right="g1"]')
    expect(right.hasAttribute('disabled')).toBe(false)
    expect(right.title).toBe('오른쪽으로 pane 분할 (⌘D)')
    click(right)
    click(el('[data-group-split-down="g1"]'))
    expect(spies.splitPane.mock.calls).toEqual([['right'], ['down']])
  })
})

describe('C3 ⊞·탭바 빈 곳 우클릭 — 파일 탭 활성이면 파일 탭 메뉴(헤더 모드)', () => {
  it('⊞ → 파일 탭 메뉴가 뜨고 머리줄이 대상 탭 이름 · 터미널 탭 메뉴는 안 뜬다', () => {
    mount({ items: [{ kind: 'terminal', tab: terminal }, file('src/a.ts')], activeTabId: fileTabId('src/a.ts') })
    click(el('[data-group-menu="g1"]'))
    expect(el('[data-file-tab-menu-header-mode]').getAttribute('data-file-tab-menu-header-mode')).toBe(fileTabId('src/a.ts'))
    expect(labels('[data-file-tab-menu] [data-menu-label]')).toEqual(['탭 · a.ts'])
    expect(document.querySelector('.tab-context-menu')).toBeNull()
    // 헤더 모드 항목도 그 탭을 겨눈다
    click(fileItem('close-others'))
    expect(spies.closeFileScope).toHaveBeenCalledWith({ tabId: fileTabId('src/a.ts'), scope: 'others' })
  })
  it('탭바 빈 곳 우클릭 → 같은 메뉴', () => {
    mount({ items: [file('src/a.ts')], activeTabId: fileTabId('src/a.ts') })
    contextMenu(el('[data-main-tabbar]'))
    expect(document.querySelector('[data-file-tab-menu-header-mode]')).not.toBeNull()
  })
  it('터미널 탭 활성 → 지금처럼 터미널 탭 메뉴(헤더 모드), 파일 탭 메뉴는 없다', () => {
    mount({ items: [{ kind: 'terminal', tab: terminal }, file('src/a.ts')], activeTabId: 'w1:t1' })
    click(el('[data-group-menu="g1"]'))
    expect(document.querySelector('[data-tab-menu-header-mode="w1:t1"]')).not.toBeNull()
    expect(document.querySelector('[data-file-tab-menu]')).toBeNull()
  })
})

describe('C4 파일 탭 「새 영역으로 옮기기」', () => {
  it('영역 탭 1개 → 흐림 + ONE_TAB_IN_GROUP title, 눌러도 안 옮긴다', () => {
    mount({ items: [file('src/a.ts')], activeTabId: fileTabId('src/a.ts') })
    contextMenu(el(`[data-main-tab="${fileTabId('src/a.ts')}"]`))
    for (const action of ['split-right', 'split-down']) {
      const item = fileItem(action)
      expect(item.getAttribute('aria-disabled')).toBe('true')
      expect(item.title).toBe(ONE_TAB_IN_GROUP)
      click(item)
    }
    expect(spies.moveToGroup).not.toHaveBeenCalled()
  })
  it('2개 이상 → 켜지고 옮긴다', () => {
    mount({ items: [file('src/a.ts'), file('src/b.ts')], activeTabId: fileTabId('src/a.ts') })
    contextMenu(el(`[data-main-tab="${fileTabId('src/a.ts')}"]`))
    expect(fileItem('split-right').getAttribute('aria-disabled')).toBeNull()
    click(fileItem('split-right'))
    expect(spies.moveToGroup).toHaveBeenCalledWith({ tabId: fileTabId('src/a.ts'), direction: 'right' })
  })
})

describe('C5 파일 탭 「왼쪽 탭 닫기」', () => {
  it('첫 탭이면 흐림, 왼쪽에 탭이 있으면 켜지고 left 범위로 닫는다', () => {
    mount({ items: [{ kind: 'terminal', tab: terminal }, file('src/a.ts'), file('src/b.ts')], activeTabId: fileTabId('src/b.ts') })
    contextMenu(el(`[data-main-tab="${fileTabId('src/b.ts')}"]`))
    expect(fileItem('close-left').textContent).toContain('왼쪽 탭 닫기')
    click(fileItem('close-left'))
    expect(spies.closeFileScope).toHaveBeenCalledWith({ tabId: fileTabId('src/b.ts'), scope: 'left' })
    mount({ items: [file('src/a.ts'), { kind: 'terminal', tab: terminal }], activeTabId: fileTabId('src/a.ts') })
    contextMenu(el(`[data-main-tab="${fileTabId('src/a.ts')}"]`))
    expect(fileItem('close-left').getAttribute('aria-disabled')).toBe('true')
  })
})

describe('C7 모두 닫기·저장된 탭 닫기 — 파일 탭 메뉴·터미널 탭 메뉴(헤더 모드 포함) 모두', () => {
  it('파일 탭 메뉴 — 범위 닫기 항목 이름·순서가 터미널 탭 메뉴와 같다', () => {
    mount({ items: [{ kind: 'terminal', tab: terminal }, file('src/a.ts')], activeTabId: fileTabId('src/a.ts') })
    contextMenu(el(`[data-main-tab="${fileTabId('src/a.ts')}"]`))
    const fileScopes = ['close-others', 'close-right', 'close-left', 'close-all', 'close-saved'].map((action) => fileItem(action).textContent)
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    contextMenu(el('[data-main-tab="w1:t1"]'))
    const terminalScopes = ['others', 'right', 'left', 'all', 'saved'].map((scope) => el(`[data-tab-menu-close-${scope}="w1:t1"]`).textContent)
    expect(fileScopes).toEqual(['다른 탭 닫기', '오른쪽 탭 닫기', '왼쪽 탭 닫기', '모두 닫기', '저장된 탭 닫기'])
    expect(terminalScopes).toEqual(fileScopes)
  })
  it('누르면 그 범위로 닫는다 — 파일 탭 메뉴는 onCloseFileScope, 터미널 탭 메뉴는 onCloseScope', () => {
    mount({ items: [{ kind: 'terminal', tab: terminal }, file('src/a.ts')], activeTabId: fileTabId('src/a.ts') })
    contextMenu(el(`[data-main-tab="${fileTabId('src/a.ts')}"]`))
    click(fileItem('close-all'))
    expect(spies.closeFileScope).toHaveBeenLastCalledWith({ tabId: fileTabId('src/a.ts'), scope: 'all' })
    contextMenu(el(`[data-main-tab="${fileTabId('src/a.ts')}"]`))
    click(fileItem('close-saved'))
    expect(spies.closeFileScope).toHaveBeenLastCalledWith({ tabId: fileTabId('src/a.ts'), scope: 'saved' })
    contextMenu(el('[data-main-tab="w1:t1"]'))
    click(el('[data-tab-menu-close-saved="w1:t1"]'))
    expect(spies.closeScope.mock.calls.at(-1)?.[0].scope).toBe('saved')
  })
  it('터미널 헤더 모드에도 두 항목 · 대상 0 이면 흐림(수정된 파일만 → 저장된 탭 닫기 흐림)', () => {
    mount({ items: [{ kind: 'terminal', tab: terminal }, file('src/a.ts', { dirty: true })], activeTabId: 'w1:t1' })
    click(el('[data-group-menu="g1"]'))
    expect(el('[data-tab-menu-close-all="w1:t1"]').getAttribute('data-disabled')).toBe('false')
    const saved = el('[data-tab-menu-close-saved="w1:t1"]')
    expect(saved.getAttribute('data-disabled')).toBe('true')
    expect(saved.title).toContain('저장된 파일 탭이 없다')
  })
  it('파일 탭 메뉴 — 수정된 파일만 있으면 저장된 탭 닫기 흐림, 저장된 파일이 있으면 켜짐', () => {
    mount({ items: [file('src/a.ts', { dirty: true })], activeTabId: fileTabId('src/a.ts') })
    contextMenu(el(`[data-main-tab="${fileTabId('src/a.ts')}"]`))
    expect(fileItem('close-saved').getAttribute('aria-disabled')).toBe('true')
    expect(fileItem('close-all').getAttribute('aria-disabled')).toBeNull()
    mount({ items: [file('src/a.ts', { dirty: true }), file('src/b.ts')], activeTabId: fileTabId('src/a.ts') })
    contextMenu(el(`[data-main-tab="${fileTabId('src/a.ts')}"]`))
    expect(fileItem('close-saved').getAttribute('aria-disabled')).toBeNull()
  })
})
