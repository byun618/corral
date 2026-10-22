// @vitest-environment happy-dom
// LIFE-689 K2ⓑ·K3 — 파일 탭 같은 이름 구분(VS Code `labelFormat: default`)의 DOM 계약: 이름이 겹치는 파일 탭만 라벨 뒤에 설명 요소가 붙는다.
// 설명 계산 자체는 `file-tabs.label.test.ts`. 크기·흐림·잘림 순서는 CSS 라 최종 관문(격리 GUI 캡처)이 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAgentState } from '../../../shared/agent-state.js'
import { EMPTY_SESSION_DIGEST, type TabRow } from '../../../shared/types.js'
import { BindingLabels } from '../hooks/BindingLabels.js'
import { fileTabId } from '../file-tabs.js'
import { GroupHeader, type GroupTabItem } from './MainTabBar.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const terminal: TabRow = {
  tabId: 'w1:t1', workspaceId: 'w1', label: '', number: 1, order: 0, agentStatus: 'idle', focused: false, digest: EMPTY_SESSION_DIGEST,
  panes: [{ paneId: 'p1', tabId: 'w1:t1', workspaceId: 'w1', title: '', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: false, agentSession: null, digest: EMPTY_SESSION_DIGEST }],
}
const file = (rel: string, extra?: { preview?: boolean; deleted?: boolean; dirty?: boolean }): GroupTabItem => ({
  kind: 'file', tabId: fileTabId(rel), rel, preview: extra?.preview ?? false, deleted: extra?.deleted ?? false, dirty: extra?.dirty ?? false,
})

let host: HTMLDivElement
let root: Root
function mount(items: GroupTabItem[]): void {
  const noop = (): void => {}
  const tabs = items.flatMap((item) => (item.kind === 'terminal' ? [item.tab] : []))
  act(() => {
    root.render(createElement(BindingLabels.Provider, { value: {} }, createElement(GroupHeader, {
      groupId: 'g1', tabs, items, workspaceTabCount: tabs.length, home: '/home', selectedPane: null, activeTabId: null,
      activeGroup: true, unreadPanes: new Set<string>(), paneCount: 1, grid: null, zoomed: false,
      onActivate: noop, onSelectTab: noop, onCreateShell: noop, onCloseTab: noop, onRenameTab: noop, onClearTabName: noop,
      onSplitPane: noop, onSplitTab: noop, onMoveToGroup: noop, onZoom: noop,
      pinnedTabs: new Set<string>(), tabColorOf: () => null, renameRequest: null,
      onRequestRename: noop, onTogglePin: noop, onCloseScope: noop, onSetTabColor: noop, onClosePane: noop, onCloseGroup: null, otherGroups: [], onMoveToOtherGroup: noop, onTabDragStart: noop,
      tabDragActive: false,
      openTabEntries: [], onLaunchAgent: noop, onOpenAgentSettings: noop, onActivateOpenTab: noop,
    })))
  })
}
/** 파일 탭별 [라벨, 설명(없으면 null)] — 설명 요소가 없으면 null, 있으면 그 텍스트. */
function shownLabels(): [string, string | null][] {
  return [...host.querySelectorAll<HTMLElement>('[data-file-tab]')].map((tab) => [
    tab.querySelector('.main-tab-file-label')?.textContent ?? '',
    tab.querySelector('.main-tab-file-desc')?.textContent ?? null,
  ])
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('LIFE-689 K2ⓑ·K3 파일 탭 설명 요소', () => {
  it('ⓑ 같은 이름 두 탭에 부모 폴더 설명 — 다른 이름 탭·터미널 탭은 설명 없음', () => {
    mount([file('src/app/app.service.ts'), { kind: 'terminal', tab: terminal }, file('src/push/app.service.ts'), file('src/main.ts')])
    expect(shownLabels()).toEqual([['app.service.ts', '…/app'], ['app.service.ts', '…/push'], ['main.ts', null]])
    // 설명은 라벨 뒤 별도 요소, 같은 제목 칸 안
    const title = host.querySelector('[data-file-tab="src/app/app.service.ts"] .main-tab-title')
    expect([...(title?.children ?? [])].map((node) => node.className)).toEqual(['main-tab-label main-tab-file-label', 'main-tab-file-desc'])
  })

  it('이름이 안 겹치면 설명 요소 자체가 없다', () => {
    mount([file('src/a.ts'), file('src/b.ts')])
    expect(host.querySelectorAll('.main-tab-file-desc')).toHaveLength(0)
  })

  it('미리보기·삭제·수정 표시와 같이 선다 (무회귀)', () => {
    mount([file('README.md', { preview: true }), file('docs/README.md', { deleted: true, dirty: true })])
    expect(shownLabels()).toEqual([['README.md', './'], ['README.md', 'docs']])
    const preview = host.querySelector('[data-file-tab="README.md"]')
    const deleted = host.querySelector('[data-file-tab="docs/README.md"]')
    expect(preview?.classList.contains('is-preview')).toBe(true)
    expect(deleted?.classList.contains('is-deleted')).toBe(true)
    expect(deleted?.classList.contains('is-dirty')).toBe(true)
  })
})
