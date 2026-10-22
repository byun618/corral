// @vitest-environment happy-dom
// LIFE-689 K2ⓑ·K3 — 파일 탭 같은 이름 구분(VS Code `labelFormat: default`)의 DOM 계약: 이름이 겹치는 파일 탭만 라벨 뒤에 설명 요소가 붙는다.
// 설명 계산 자체는 `file-tabs.label.test.ts`. 크기·흐림·잘림 순서는 CSS 라 최종 관문(격리 GUI 캡처)이 본다.
import { act, createElement, type ReactElement } from 'react'
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
/** 영역 하나 = `GroupHeader` 하나. 여러 영역이면 App 처럼 한 트리에 나란히 그린다(L1 — 영역마다 그 영역 탭만 넘긴다). */
function header(input: { groupId: string; items: GroupTabItem[] }): ReactElement {
  const noop = (): void => {}
  const { groupId, items } = input
  const tabs = items.flatMap((item) => (item.kind === 'terminal' ? [item.tab] : []))
  return createElement(GroupHeader, {
    key: groupId, groupId, tabs, items, workspaceTabCount: tabs.length, home: '/home', selectedPane: null, activeTabId: null,
    activeGroup: true, unreadPanes: new Set<string>(), paneCount: 1, grid: null, zoomed: false,
    onActivate: noop, onSelectTab: noop, onCreateShell: noop, onCloseTab: noop, onRenameTab: noop, onClearTabName: noop,
    onSplitPane: noop, onSplitTab: noop, onMoveToGroup: noop, onZoom: noop,
    pinnedTabs: new Set<string>(), tabColorOf: () => null, renameRequest: null,
    onRequestRename: noop, onTogglePin: noop, onCloseScope: noop, onSetTabColor: noop, onClosePane: noop, onCloseGroup: null, otherGroups: [], onMoveToOtherGroup: noop, onTabDragStart: noop,
    tabDragActive: false,
    openTabEntries: [], onLaunchAgent: noop, onOpenAgentSettings: noop, onActivateOpenTab: noop,
  })
}
function mountGroups(groups: { groupId: string; items: GroupTabItem[] }[]): void {
  act(() => {
    root.render(createElement(BindingLabels.Provider, { value: {} }, ...groups.map(header)))
  })
}
function mount(items: GroupTabItem[]): void {
  mountGroups([{ groupId: 'g1', items }])
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
    // 게이트 ① 결정 1 — 설명이 붙은 탭만 `has-desc`(줄지 않는 폭, file-view.css). 설명 없는 탭은 기존 고정 폭 그대로
    expect(host.querySelector('[data-file-tab="src/app/app.service.ts"]')?.classList.contains('has-desc')).toBe(true)
    expect(host.querySelector('[data-file-tab="src/main.ts"]')?.classList.contains('has-desc')).toBe(false)
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

  it('F1 L1 영역 단위 — 같은 이름·다른 폴더가 영역마다 하나씩이면 어느 쪽도 설명 없음 (대조: 한 영역에 둘이면 생김)', () => {
    // 두 영역을 한 트리에 그리고 다시 그린다 — 영역 사이에 상태가 새는 호출부(합쳐 계산)는 두 번째 그리기에서도 드러난다
    const apart = [{ groupId: 'g1', items: [file('src/app/app.service.ts')] }, { groupId: 'g2', items: [file('src/push/app.service.ts')] }]
    mountGroups(apart)
    mountGroups(apart)
    expect(shownLabels()).toEqual([['app.service.ts', null], ['app.service.ts', null]])
    mountGroups([{ groupId: 'g1', items: [file('src/app/app.service.ts'), file('src/push/app.service.ts')] }, { groupId: 'g2', items: [file('lib/app.service.ts')] }])
    expect(shownLabels()).toEqual([['app.service.ts', '…/app'], ['app.service.ts', '…/push'], ['app.service.ts', null]])
  })
})
