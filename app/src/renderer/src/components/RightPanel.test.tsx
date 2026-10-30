// @vitest-environment happy-dom
// LIFE-682 A1·A2 — 오른쪽 패널 머리 = Orca top 모드 activity bar. 구조·클래스·aria 만 본다(치수·색은 격리 computed 수치표).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RightPanelView } from '../../../shared/types.js'
import { RightPanel } from './RightPanel.js'
import { RIGHT_PANEL_VIEWS } from './right-panel-views.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let selected: RightPanelView[] = []
let toggles = 0

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  selected = []
  toggles = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render({ view, open = true, explorerShortcut = '⌘⇧E' }: { view: RightPanelView; open?: boolean; explorerShortcut?: string | null }): void {
  act(() => root.render(createElement(RightPanel, {
    open, view,
    shortcutOf: (id) => (id === 'explorer' ? explorerShortcut : null),
    onSelectView: (id) => { selected.push(id) },
    panelRef: null, toggleShortcut: '⌘L', onToggle: () => { toggles += 1 }, onResizeStart: () => {},
    bodies: { explorer: createElement('div', { 'data-probe': 'explorer' }), scm: createElement('div', { 'data-probe': 'scm' }), detail: createElement('div', { 'data-probe': 'detail' }) },
  })))
}
const q = (selector: string): HTMLElement | null => host.querySelector<HTMLElement>(selector)
const buttons = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-right-panel-view-btn]')]

describe('activity bar (A1·A2)', () => {
  it('머리 = 보기 수만큼 아이콘 단추(목록 순서) + 오른쪽 끝 패널 토글, 제목 글자 없음', () => {
    render({ view: 'explorer' })
    const head = q('[data-right-panel-head]')
    expect(buttons().map((button) => button.dataset.rightPanelViewBtn)).toEqual(RIGHT_PANEL_VIEWS.map((entry) => entry.id))
    // LIFE-683 — 소스 제어 보기가 탐색기 다음에 더해졌다(3개).
    expect(buttons()).toHaveLength(3)
    expect(head?.lastElementChild?.getAttribute('data-right-panel-toggle')).toBe('head')
    expect(head?.lastElementChild?.classList.contains('right-panel-toggle')).toBe(true)
    expect(q('.right-panel-title')).toBeNull()
    expect(head?.textContent).toBe('')
    // LIFE-683 — 소스 제어 아이콘은 VS Code codicon 글리프(S1), 나머지는 svg.
    for (const button of buttons()) expect(button.querySelector('svg.right-panel-activity-icon, .codicon.right-panel-activity-icon')).not.toBeNull()
  })
  it('툴팁·aria-label = 「제목 (단축키)」, 단축키 없으면 제목만 — 설정에서 바꾸면 따라간다', () => {
    render({ view: 'explorer' })
    expect(q('[data-right-panel-view-btn="explorer"]')?.getAttribute('title')).toBe('탐색기 (⌘⇧E)')
    expect(q('[data-right-panel-view-btn="explorer"]')?.getAttribute('aria-label')).toBe('탐색기 (⌘⇧E)')
    expect(q('[data-right-panel-view-btn="detail"]')?.getAttribute('title')).toBe('작업 상세')
    expect(q('[data-right-panel-view-btn="detail"]')?.getAttribute('aria-label')).toBe('작업 상세')
    render({ view: 'explorer', explorerShortcut: '⌥⌘X' })
    expect(q('[data-right-panel-view-btn="explorer"]')?.getAttribute('title')).toBe('탐색기 (⌥⌘X)')
    render({ view: 'explorer', explorerShortcut: null })
    expect(q('[data-right-panel-view-btn="explorer"]')?.getAttribute('title')).toBe('탐색기')
  })
  it('활성 단추 하나만 aria-pressed true + is-active + 아래 막대', () => {
    render({ view: 'detail' })
    expect(buttons().filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.dataset.rightPanelViewBtn)).toEqual(['detail'])
    expect(q('[data-right-panel-view-btn="detail"]')?.classList.contains('is-active')).toBe(true)
    expect(q('[data-right-panel-view-btn="detail"] .right-panel-activity-bar')).not.toBeNull()
    expect(q('[data-right-panel-view-btn="explorer"] .right-panel-activity-bar')).toBeNull()
  })
  it('단추 클릭 = 그 보기 선택만(토글을 부르지 않는다) — 활성 단추를 다시 눌러도 닫지 않는다', () => {
    render({ view: 'explorer' })
    act(() => { q('[data-right-panel-view-btn="detail"]')?.click() })
    act(() => { q('[data-right-panel-view-btn="explorer"]')?.click() })
    expect(selected).toEqual(['detail', 'explorer'])
    expect(toggles).toBe(0)
  })
  it('보기 몸통은 둘 다 마운트를 유지하고 안 보이는 쪽은 hidden(A11 — 탐색기 상태 유지)', () => {
    render({ view: 'detail' })
    expect(q('[data-probe="explorer"]')).not.toBeNull()
    expect(q('[data-right-panel-body="explorer"]')?.hidden).toBe(true)
    expect(q('[data-right-panel-body="detail"]')?.hidden).toBe(false)
    render({ view: 'explorer', open: false })
    expect(q('[data-probe="detail"]')).not.toBeNull()
    expect(q('[data-right-panel]')?.getAttribute('data-right-panel')).toBe('closed')
  })
})
