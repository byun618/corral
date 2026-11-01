// @vitest-environment happy-dom
// LIFE-682 A1·A2 — 오른쪽 패널 머리 = Orca top 모드 activity bar. 구조·클래스·aria 만 본다(치수·색은 격리 computed 수치표).
// LIFE-755 C1·C3·C4 — 머리 단추 이름은 native `title` 이 아니라 DOM 툴팁(`Tooltip`). 자리(C2)·캡처는 네이티브 CDP 관문이 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RightPanelView } from '../../../shared/types.js'
import fs from 'node:fs'
import path from 'node:path'
import { RightPanel, RightPanelToggle } from './RightPanel.js'
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
const tips = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-tooltip]')]
const enter = (target: Element | null): void => act(() => void target?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
const leave = (target: Element | null): void => act(() => void target?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
/** 단추에 들어가 뜬 툴팁 글자를 읽고 나온다 — 단추당 툴팁 하나. */
function tipOf(selector: string): string | null {
  const button = q(selector)
  enter(button)
  const text = tips().length === 1 ? (tips()[0]?.textContent ?? null) : null
  leave(button)
  return text
}

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
    expect(tipOf('[data-right-panel-view-btn="explorer"]')).toBe('탐색기 (⌘⇧E)')
    expect(q('[data-right-panel-view-btn="explorer"]')?.getAttribute('aria-label')).toBe('탐색기 (⌘⇧E)')
    expect(tipOf('[data-right-panel-view-btn="detail"]')).toBe('작업 상세')
    expect(q('[data-right-panel-view-btn="detail"]')?.getAttribute('aria-label')).toBe('작업 상세')
    render({ view: 'explorer', explorerShortcut: '⌥⌘X' })
    expect(tipOf('[data-right-panel-view-btn="explorer"]')).toBe('탐색기 (⌥⌘X)')
    render({ view: 'explorer', explorerShortcut: null })
    expect(tipOf('[data-right-panel-view-btn="explorer"]')).toBe('탐색기')
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

describe('LIFE-755 머리 단추 DOM 툴팁 (C1·C3·C4)', () => {
  const ALL = ['[data-right-panel-view-btn="explorer"]', '[data-right-panel-view-btn="scm"]', '[data-right-panel-view-btn="detail"]', '[data-right-panel-toggle="head"]']
  it('C1 네 단추 각각 — 들어가면 바로 툴팁 하나(글자 = 이름(단축키)), 떠나면 바로 사라진다 · 패널 밖(body)으로 portal', () => {
    render({ view: 'explorer' })
    const expected = ['탐색기 (⌘⇧E)', '소스 제어', '작업 상세', '오른쪽 패널 닫기 (⌘L)']
    ALL.forEach((selector, index) => {
      const button = q(selector)
      enter(button)
      expect(tips()).toHaveLength(1)
      const tip = tips()[0]
      expect(tip?.textContent).toBe(expected[index])
      expect(tip?.getAttribute('role')).toBe('tooltip')
      // 보인다(r1 D) — 자리를 잡은 뒤 inline visibility 가 hidden 이 아니고 display none 도 아니다.
      expect(tip?.style.visibility).not.toBe('hidden')
      expect(tip?.style.display).not.toBe('none')
      expect(tip?.hidden).toBe(false)
      expect(button?.getAttribute('aria-describedby')).toBe(tip?.id)
      expect(host.contains(tip ?? null)).toBe(false)
      expect(tip?.parentElement).toBe(document.body)
      leave(button)
      expect(tips()).toHaveLength(0)
      expect(button?.getAttribute('aria-describedby')).toBeNull()
    })
  })
  it('C1 한 번에 하나 — 떠남 없이 다른 단추로 들어가도 툴팁은 하나', () => {
    render({ view: 'explorer' })
    enter(q(ALL[0] ?? ''))
    enter(q(ALL[2] ?? ''))
    expect(tips().map((tip) => tip.textContent)).toEqual(['작업 상세'])
  })
  it('C3 누르면 닫히고 클릭은 그대로 동작한다 — 보기 전환·패널 닫기 뒤 남은 툴팁 0', () => {
    render({ view: 'explorer' })
    const detail = q('[data-right-panel-view-btn="detail"]')
    enter(detail)
    act(() => { detail?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); detail?.click() })
    expect(selected).toEqual(['detail'])
    expect(tips()).toHaveLength(0)
    const toggle = q('[data-right-panel-toggle="head"]')
    enter(toggle)
    act(() => { toggle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); toggle?.click() })
    expect(toggles).toBe(1)
    expect(tips()).toHaveLength(0)
  })
  it('C3 창 blur·키 입력(⌘L 로 패널이 닫혀 mouseleave 가 안 오는 경우)·스크롤에 닫힌다', () => {
    render({ view: 'explorer' })
    for (const fire of [() => window.dispatchEvent(new Event('blur')), () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true })), () => document.dispatchEvent(new Event('scroll'))]) {
      enter(q(ALL[1] ?? ''))
      expect(tips()).toHaveLength(1)
      act(() => fire())
      expect(tips()).toHaveLength(0)
      leave(q(ALL[1] ?? ''))
    }
  })
  it('C3 (r1 C) 단추를 담지 않은 요소의 스크롤에는 닫히지 않고, 담은 조상의 스크롤에는 닫힌다', () => {
    render({ view: 'explorer' })
    const other = document.createElement('div')
    document.body.append(other)
    enter(q(ALL[1] ?? ''))
    act(() => { other.dispatchEvent(new Event('scroll')) })
    expect(tips()).toHaveLength(1)
    act(() => { q('[data-right-panel-head]')?.dispatchEvent(new Event('scroll')) })
    expect(tips()).toHaveLength(0)
    other.remove()
  })
  it('C3 (r1 G) 수식키 단독 keydown 에는 닫히지 않고, 그 밖 키(⌘L)에는 닫힌다', () => {
    render({ view: 'explorer' })
    enter(q(ALL[1] ?? ''))
    for (const key of ['Shift', 'Meta', 'Alt', 'Control']) {
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key })) })
      expect(tips()).toHaveLength(1)
    }
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true })) })
    expect(tips()).toHaveLength(0)
  })
  it('C3 툴팁은 포인터를 받지 않는다 — 렌더된 툴팁이 `.tooltip` 이고 그 규칙이 `pointer-events: none`', () => {
    render({ view: 'explorer' })
    enter(q(ALL[0] ?? ''))
    // 렌더 노드가 그 규칙의 class 를 갖는다(r1 J) — class 를 바꾸면 규칙이 안 걸린다.
    expect(tips()[0]?.classList.contains('tooltip')).toBe(true)
    const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8')
    const rule = /\.tooltip \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/pointer-events:\s*none/)
    expect(rule).toMatch(/position:\s*fixed/)
  })
  it('C3 언마운트(단추가 사라짐) 뒤 고아 툴팁 0', () => {
    render({ view: 'explorer' })
    enter(q(ALL[0] ?? ''))
    expect(tips()).toHaveLength(1)
    act(() => root.unmount())
    expect(tips()).toHaveLength(0)
    root = createRoot(host)
  })
  it('C4 바꾼 단추에 title 이 없고 aria-label 은 base 값 그대로', () => {
    render({ view: 'explorer' })
    for (const selector of ALL) expect(q(selector)?.hasAttribute('title')).toBe(false)
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual(['탐색기 (⌘⇧E)', '소스 제어', '작업 상세'])
    expect(q('[data-right-panel-toggle="head"]')?.getAttribute('aria-label')).toBe('오른쪽 패널 닫기')
  })
  it('C4 RightPanelToggle 세 자리(머리·탭 줄·작업 페이지 머리) 모두 같은 툴팁 — title 없음, 단축키 없으면 이름만', () => {
    for (const placement of ['head', 'tabbar', 'tasks'] as const) {
      for (const shortcut of ['⌘L', null]) {
        act(() => root.render(createElement(RightPanelToggle, { label: '오른쪽 패널 열기', shortcut, onToggle: () => {}, placement })))
        const button = q(`[data-right-panel-toggle="${placement}"]`)
        expect(button?.hasAttribute('title')).toBe(false)
        expect(button?.getAttribute('aria-label')).toBe('오른쪽 패널 열기')
        expect(tipOf(`[data-right-panel-toggle="${placement}"]`)).toBe(shortcut === null ? '오른쪽 패널 열기' : '오른쪽 패널 열기 (⌘L)')
      }
    }
  })
})

describe('LIFE-755 r1 F 툴팁 자리 — 단추 아래 6px 가운데 · 창 안으로 밀기 · 아래 자리가 없으면 위', () => {
  const TIP = { width: 120, height: 28 }
  let restore: (() => void)[] = []
  const define = (target: object, key: string, value: PropertyDescriptor): void => {
    const before = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, ...value })
    restore.push(() => { if (before === undefined) Reflect.deleteProperty(target, key); else Object.defineProperty(target, key, before) })
  }
  beforeEach(() => {
    restore = []
    define(window, 'innerWidth', { value: 1000 })
    define(window, 'innerHeight', { value: 700 })
    // 툴팁 크기는 offset 값으로 잰다(r1 E) — 툴팁만 크기를 준다.
    define(HTMLElement.prototype, 'offsetWidth', { get(this: HTMLElement) { return this.hasAttribute('data-tooltip') ? TIP.width : 0 } })
    define(HTMLElement.prototype, 'offsetHeight', { get(this: HTMLElement) { return this.hasAttribute('data-tooltip') ? TIP.height : 0 } })
  })
  afterEach(() => { for (const undo of restore.reverse()) undo() })
  function placeAt(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
    render({ view: 'explorer' })
    const button = q('[data-right-panel-view-btn="scm"]')
    if (button === null) throw new Error('단추 없음')
    button.getBoundingClientRect = () => DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    enter(button)
    const tip = tips()[0]
    if (tip === undefined) throw new Error('툴팁 없음')
    return tip
  }
  const px = (value: string): number => Number.parseFloat(value)
  it('가운데 아래 — top = 단추 bottom + 6, 가운데 정렬', () => {
    const tip = placeAt({ left: 400, top: 0, width: 36, height: 36 })
    expect(tip.dataset.side).toBe('bottom')
    expect(px(tip.style.top)).toBe(36 + 6)
    expect(px(tip.style.left)).toBe(400 + 18 - TIP.width / 2)
  })
  it('창 오른쪽 끝 단추 — 오른쪽 가장자리가 창 안(innerWidth - 8)', () => {
    const tip = placeAt({ left: 964, top: 0, width: 36, height: 36 })
    expect(px(tip.style.left) + TIP.width).toBeLessThanOrEqual(1000)
    expect(px(tip.style.left)).toBe(1000 - TIP.width - 8)
  })
  it('창 왼쪽 끝 단추 — 왼쪽 가장자리가 창 안(8)', () => {
    const tip = placeAt({ left: 0, top: 0, width: 36, height: 36 })
    expect(px(tip.style.left)).toBe(8)
  })
  it('아래 자리가 없으면 위로 — bottom = 단추 top - 6', () => {
    const tip = placeAt({ left: 400, top: 660, width: 36, height: 36 })
    expect(tip.dataset.side).toBe('top')
    expect(px(tip.style.top)).toBe(660 - 6 - TIP.height)
  })
})
