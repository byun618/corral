// @vitest-environment happy-dom
// LIFE-812 C4 — 터미널 검색 막대: ⌘F 열기·포커스, 입력 → 검색·k/총, Enter/⇧Enter, 다시 ⌘F 전체 선택, Esc 닫기 → pane 포커스, 강조 0, 막대 하나.
// 막대 키가 PTY 로 가지 않는다(termInput 0)는 여기서는 약한 확인이다 — 실물 확인은 G1·N1(C6ⓐ).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalFrame } from '../../shared/types.js'
import type { TerminalSearchRequest, TerminalSearchResult } from '../../shared/terminal-search.js'

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 10
    rows = 4
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '' }
    buffer = { active: { cursorX: 0, cursorY: 0, getLine: () => undefined } }
    private textarea: HTMLTextAreaElement | null = null
    loadAddon(): void {}
    open(container: HTMLElement): void {
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      container.appendChild(screen)
      this.textarea = document.createElement('textarea')
      this.textarea.className = 'xterm-helper-textarea'
      container.appendChild(this.textarea)
    }
    focus(): void {
      this.textarea?.focus()
    }
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onSelectionChange(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    attachCustomKeyEventHandler(): void {}
    input(): void {}
    hasSelection(): boolean {
      return false
    }
    write(_data: string, done?: () => void): void {
      done?.()
    }
    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }
    dispose(): void {
      this.textarea?.remove()
    }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const { TerminalPane } = await import('./TerminalPane.js')
const { requestTerminalFind, SEARCH_DEBOUNCE_MS } = await import('./terminal-search-controller.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let frameListener: ((frame: TerminalFrame) => void) | null
let searches: TerminalSearchRequest[]
let nextResult: TerminalSearchResult
const termInput = vi.fn()
const termReveal = vi.fn(async () => ({ scrolled: false, top: 0 }))

const range = (row: number, col: number, endCol: number) => ({ start: { row, col }, end: { row, col: endCol } })

beforeEach(() => {
  vi.useFakeTimers()
  frameListener = null
  searches = []
  nextResult = { kind: 'found', total: 2, index: 0, current: range(101, 1, 3), matches: [range(101, 1, 3), range(102, 4, 6)], attempts: 1 }
  termInput.mockClear()
  termReveal.mockClear()
  Reflect.set(window, 'corral', {
    selectPane: vi.fn(async () => {}),
    repaintPane: vi.fn(async () => {}),
    onTermFrame: (listener: (frame: TerminalFrame) => void) => {
      frameListener = listener
      return () => { frameListener = null }
    },
    onFileDrop: () => () => {},
    termInput,
    termScroll: vi.fn(),
    termSearch: vi.fn(async (request: TerminalSearchRequest) => {
      searches.push(request)
      return nextResult
    }),
    termReveal,
    saveClipboardImage: vi.fn(),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function renderPanes(paneIds: string[]): void {
  act(() => {
    root.render(createElement('div', null, ...paneIds.map((paneId) => createElement('div', { key: paneId, className: 'term-pane-inner', 'data-box': paneId }, createElement(TerminalPane, { paneId, diagnostics: false, focusable: true, focusToken: 0, announceFocus: false })))))
  })
}

const bar = (paneId = 'p1'): Element | null => host.querySelector(`[data-box="${paneId}"] [data-term-search]`)
const input = (paneId = 'p1'): HTMLInputElement | null => host.querySelector(`[data-box="${paneId}"] [data-term-search-input]`)
const hits = (): string[] => [...host.querySelectorAll('[data-term-search-hit]')].map((element) => `${element.getAttribute('data-term-search-hit')}${element.classList.contains('is-current') ? '*' : ''}`)

function type(element: HTMLInputElement, value: string): void {
  act(() => {
    Reflect.get(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ?? {}, 'set')?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(element: Element, init: KeyboardEventInit): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

function frame(input: { scrollTop: number | null }): void {
  act(() => frameListener?.({ paneId: 'p1', seq: 1, cols: 10, rows: 4, mouseReporting: false, scrollTop: input.scrollTop, data: new Uint8Array() }))
}

describe('LIFE-812 C4 검색 막대', () => {
  it('ⓐ ⌘F → 막대 열림·입력칸 포커스 · ⓑ 입력하면 검색, k/총 · 결과로 이동 요청', async () => {
    renderPanes(['p1'])
    frame({ scrollTop: 100 })
    expect(bar()).toBeNull()
    act(() => requestTerminalFind('p1'))
    expect(bar()).not.toBeNull()
    expect(document.activeElement).toBe(input())
    type(input() ?? document.createElement('input'), 'ab')
    await settle()
    expect(searches).toEqual([{ paneId: 'p1', query: 'ab', direction: 'backward', from: 'viewport' }])
    expect(host.querySelector('[data-term-search-status]')?.textContent).toBe('1 / 2')
    expect(termReveal).toHaveBeenCalledWith({ paneId: 'p1', row: 101 })
    // 강조 — 프레임 top 100 기준 뷰포트 행 1·2, 현재 일치 구분(C3)
    expect(hits()).toEqual(['1,1,3*', '2,4,3'])
    // 휠 등으로 top 이 바뀐 프레임이 오면 강조가 글자를 따라간다(C3ⓓ)
    frame({ scrollTop: 101 })
    expect(hits()).toEqual(['0,1,3*', '1,4,3'])
  })

  it('ⓒ Enter 다음 · ⇧Enter 이전 — 현재 일치에서 이어 묻는다', async () => {
    renderPanes(['p1'])
    act(() => requestTerminalFind('p1'))
    type(input() ?? document.createElement('input'), 'ab')
    await settle()
    key(input() ?? document.body, { key: 'Enter' })
    await settle()
    key(input() ?? document.body, { key: 'Enter', shiftKey: true })
    await settle()
    expect(searches.slice(1).map((request) => [request.direction, request.from])).toEqual([
      ['forward', range(101, 1, 3)],
      ['backward', range(101, 1, 3)],
    ])
  })

  it('ⓔ 열린 막대에서 다시 ⌘F(막대 안·밖 모두) → 입력칸 전체 선택', async () => {
    renderPanes(['p1'])
    act(() => requestTerminalFind('p1'))
    type(input() ?? document.createElement('input'), 'hello')
    const field = input() ?? document.createElement('input')
    field.setSelectionRange(5, 5)
    key(field, { key: 'f', code: 'KeyF', metaKey: true })
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5])
    field.setSelectionRange(5, 5)
    act(() => requestTerminalFind('p1'))
    expect(document.activeElement).toBe(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5])
  })

  it('ⓓ Esc 닫기 → 강조 0, 포커스는 그 pane 의 터미널 · 막대 키는 PTY 로 가지 않는다', async () => {
    renderPanes(['p1'])
    frame({ scrollTop: 100 })
    act(() => requestTerminalFind('p1'))
    type(input() ?? document.createElement('input'), 'ab')
    await settle()
    expect(hits().length).toBeGreaterThan(0)
    key(input() ?? document.body, { key: 'Escape' })
    expect(bar()).toBeNull()
    expect(hits()).toEqual([])
    expect(document.activeElement?.className).toBe('xterm-helper-textarea')
    expect(document.activeElement?.closest('[data-term-pane]')?.getAttribute('data-term-pane')).toBe('p1')
    expect(termInput).not.toHaveBeenCalled()
  })

  it('ⓕ 빈 질의는 강조 0·요청 0 · ⓗ busy 면 상태 문구가 보인다', async () => {
    renderPanes(['p1'])
    act(() => requestTerminalFind('p1'))
    nextResult = { kind: 'busy', attempts: 4 }
    type(input() ?? document.createElement('input'), 'zz')
    await settle()
    expect(host.querySelector('[data-term-search-status]')?.textContent).toContain('출력이 계속 바뀌어')
    type(input() ?? document.createElement('input'), '')
    await settle()
    expect(searches).toHaveLength(1)
    expect(hits()).toEqual([])
  })

  it('막대는 한 번에 하나 — 다른 pane 에서 ⌘F 하면 앞 막대는 닫힌다', () => {
    renderPanes(['p1', 'p2'])
    act(() => requestTerminalFind('p1'))
    expect(bar('p1')).not.toBeNull()
    act(() => requestTerminalFind('p2'))
    expect(bar('p1')).toBeNull()
    expect(bar('p2')).not.toBeNull()
  })

  it('pane 이 바뀌면(같은 자리에 다른 pane) 막대는 닫힌 채로 시작한다', () => {
    renderPanes(['p1'])
    act(() => requestTerminalFind('p1'))
    act(() => {
      root.render(createElement('div', null, createElement('div', { key: 'p1', className: 'term-pane-inner', 'data-box': 'p1' }, createElement(TerminalPane, { paneId: 'p9', diagnostics: false, focusable: true, focusToken: 0, announceFocus: false }))))
    })
    expect(bar()).toBeNull()
  })
})
