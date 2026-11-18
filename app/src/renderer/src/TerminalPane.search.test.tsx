// @vitest-environment happy-dom
// LIFE-812 C4 — 터미널 검색 막대: ⌘F 열기·포커스, 입력 → 검색·k/총, Enter/⇧Enter, 다시 ⌘F 전체 선택, Esc 닫기 → pane 포커스, 강조 0, 막대 하나.
// 막대 키가 PTY 로 가지 않는다(termInput 0)는 여기서는 약한 확인이다 — 실물 확인은 G1·N1(C6ⓐ).
import { act, createElement, useState } from 'react'
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
const termSearchCancel = vi.fn()

const range = (row: number, col: number, endCol: number) => ({ start: { row, col }, end: { row, col: endCol } })

beforeEach(() => {
  vi.useFakeTimers()
  frameListener = null
  searches = []
  nextResult = { kind: 'found', total: 2, index: 0, current: range(101, 1, 3), matches: [range(101, 1, 3), range(102, 4, 6)], attempts: 1, token: 3 }
  termInput.mockClear()
  termReveal.mockClear()
  termSearchCancel.mockClear()
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
    termSearchCancel,
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

function frame(input: { scrollTop: number | null; cols?: number }): void {
  act(() => frameListener?.({ paneId: 'p1', seq: 1, cols: input.cols ?? 10, rows: 4, mouseReporting: false, scrollTop: input.scrollTop, data: new Uint8Array() }))
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
    expect(termReveal).toHaveBeenCalledWith({ paneId: 'p1', row: 101, token: 3 })
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
    // 닫기는 main 에 그 pane 의 검색 취소를 보낸다 — 이미 보낸 이동도 낡는다(fix1 R1-4)
    expect(termSearchCancel).toHaveBeenCalledWith({ paneId: 'p1' })
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

  it('fix1 R1-6 — 셀 수가 같은 픽셀 크기 변화에도 강조 좌표를 다시 잰다(ResizeObserver)', async () => {
    const observers: Array<() => void> = []
    class FakeResizeObserver {
      private readonly callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
      }
      observe(): void {
        observers.push(this.callback)
      }
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    try {
      renderPanes(['p1'])
      let width = 100
      const screen = host.querySelector('.xterm-screen')
      if (screen === null) throw new Error('screen 없음')
      screen.getBoundingClientRect = () => new DOMRect(0, 0, width, 40)
      frame({ scrollTop: 100 })
      act(() => requestTerminalFind('p1'))
      type(input() ?? document.createElement('input'), 'ab')
      await settle()
      const left = (): string[] => [...host.querySelectorAll<HTMLElement>('[data-term-search-hit]')].map((element) => element.style.left)
      expect(left()).toEqual(['10px', '40px']) // 셀 폭 100/10 = 10px · 열 1·4
      expect(observers).toHaveLength(1)
      width = 200 // 셀 수(10×4)는 그대로, 픽셀만 두 배
      act(() => observers.forEach((notify) => notify()))
      expect(left()).toEqual(['20px', '80px'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

})

/** App 의 그룹 onMouseDown → activateGroup → selectPane → setFocusToken(+1) 을 흉내낸다(리뷰 r2 프로브 꼴). `bump` 로 바깥에서도 올린다(팔레트 닫힘). */
let bumpToken: () => void = () => {}
function GroupWrapper(): React.JSX.Element {
  const [token, setToken] = useState(1)
  bumpToken = () => setToken((value) => value + 1)
  return createElement('div', { 'data-box': 'p1', className: 'term-pane-inner', onMouseDown: () => setToken((value) => value + 1) },
    createElement(TerminalPane, { paneId: 'p1', diagnostics: false, focusable: true, focusToken: token, announceFocus: false }))
}

/** xterm 6.0.0 의 화면 mousedown(`preventDefault` + `focus()`)을 붙인다. */
function xtermBody(): HTMLElement {
  const screen = host.querySelector('.xterm-screen')
  const textarea = host.querySelector('.xterm-helper-textarea')
  if (!(screen instanceof HTMLElement) || !(textarea instanceof HTMLElement)) throw new Error('xterm 없음')
  screen.addEventListener('mousedown', (event) => {
    event.preventDefault()
    textarea.focus()
  })
  return screen
}

describe('fix2 R2-1 — 막대가 열린 채 터미널 본문을 누르면 포커스는 터미널에 남는다', () => {
  it('본문 클릭(xterm 포커스 → 그룹 핸들러 focusToken+1) 뒤 활성 요소 = 터미널, 막대는 열린 채', () => {
    act(() => root.render(createElement(GroupWrapper)))
    const body = xtermBody()
    act(() => requestTerminalFind('p1'))
    expect(document.activeElement).toBe(input())
    act(() => { body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })) })
    expect(document.activeElement?.className).toBe('xterm-helper-textarea')
    expect(bar()).not.toBeNull()
  })
  it('양성 대조 — 막대가 닫혀 있으면 같은 클릭 뒤 터미널', () => {
    act(() => root.render(createElement(GroupWrapper)))
    const body = xtermBody()
    act(() => { body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })) })
    expect(document.activeElement?.className).toBe('xterm-helper-textarea')
  })
  it('팔레트 경로 유지 — 포커스가 터미널 밖(팔레트가 닫혀 body)일 때 올라온 focusToken 은 막대로', () => {
    act(() => root.render(createElement(GroupWrapper)))
    act(() => requestTerminalFind('p1'))
    act(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    expect(document.activeElement).toBe(document.body)
    act(() => bumpToken())
    expect(document.activeElement).toBe(input())
  })
})

describe('fix2 R2-2 — 단추를 눌러도 Esc·⇧Enter 는 막대 키로 돈다', () => {
  /** Chromium 처럼 — mousedown 기본 동작이 막히지 않았으면 누른 단추가 포커스를 가진다. */
  const chromiumButtonFocus = (event: Event): void => {
    if (!event.defaultPrevented && event.target instanceof HTMLButtonElement) event.target.focus()
  }
  beforeEach(() => document.addEventListener('mousedown', chromiumButtonFocus))
  afterEach(() => document.removeEventListener('mousedown', chromiumButtonFocus))

  const press = (selector: string): void => {
    const button = host.querySelector(selector)
    if (!(button instanceof HTMLButtonElement)) throw new Error(`${selector} 없음`)
    act(() => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })
  }

  it('「다음」 단추 클릭 뒤 Esc → 막대가 닫힌다', async () => {
    renderPanes(['p1'])
    act(() => requestTerminalFind('p1'))
    type(input() ?? document.createElement('input'), 'ab')
    await settle()
    press('[data-term-search-next]')
    await settle()
    expect(document.activeElement).toBe(input())
    key(document.activeElement ?? document.body, { key: 'Escape' })
    expect(bar()).toBeNull()
  })

  it('「다음」 단추 클릭 뒤 ⇧Enter → 이전(backward)', async () => {
    renderPanes(['p1'])
    act(() => requestTerminalFind('p1'))
    type(input() ?? document.createElement('input'), 'ab')
    await settle()
    press('[data-term-search-next]')
    await settle()
    key(document.activeElement ?? document.body, { key: 'Enter', shiftKey: true })
    await settle()
    expect(searches.map((request) => request.direction)).toEqual(['backward', 'forward', 'backward'])
    expect(searches[2]?.from).not.toBe('viewport')
  })
})

describe('fix3 R3-1 — 막대 안을 눌러도 포커스·선택을 덮지 않는다', () => {
  /** Chromium 처럼 — 막히지 않은 mousedown 이 포커스 못 받는 요소에 떨어지면 포커스는 body 로 빠진다. */
  const chromiumBlur = (event: Event): void => {
    if (event.defaultPrevented || !(event.target instanceof HTMLElement)) return
    if (event.target.matches('input, textarea, button')) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }
  beforeEach(() => document.addEventListener('mousedown', chromiumBlur))
  afterEach(() => document.removeEventListener('mousedown', chromiumBlur))
  const mousedown = (target: Element): void => {
    act(() => { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })) })
  }

  it('입력칸이 포커스인 채 입력칸 가운데를 누르면 캐럿이 그 자리에 남는다(전체 선택으로 덮지 않음)', () => {
    act(() => root.render(createElement(GroupWrapper)))
    act(() => requestTerminalFind('p1'))
    const field = input() ?? document.createElement('input')
    type(field, 'needle-wrap-test')
    field.setSelectionRange(6, 6) // 브라우저가 클릭 자리에 놓은 캐럿
    mousedown(field) // 그룹 핸들러가 focusToken 을 올린다
    expect(document.activeElement).toBe(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([6, 6])
  })

  it('입력칸이 포커스인 채 상태 문구를 눌러도 입력칸 포커스가 남는다', () => {
    act(() => root.render(createElement(GroupWrapper)))
    act(() => requestTerminalFind('p1'))
    const status = host.querySelector('[data-term-search-status]')
    if (status === null) throw new Error('상태 문구 없음')
    mousedown(status)
    expect(document.activeElement).toBe(input())
  })

  it('터미널이 포커스인 채 상태 문구를 누르면 터미널이 그대로(body 로 빠지지 않음)', () => {
    act(() => root.render(createElement(GroupWrapper)))
    const body = xtermBody()
    act(() => requestTerminalFind('p1'))
    act(() => { body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })) })
    expect(document.activeElement?.className).toBe('xterm-helper-textarea')
    const status = host.querySelector('[data-term-search-status]')
    if (status === null) throw new Error('상태 문구 없음')
    mousedown(status)
    expect(document.activeElement?.className).toBe('xterm-helper-textarea')
  })

  it('양성 대조 — 팔레트 경로(포커스 body)에서 올라온 focusToken 은 여전히 막대로 전체 선택', () => {
    act(() => root.render(createElement(GroupWrapper)))
    act(() => requestTerminalFind('p1'))
    const field = input() ?? document.createElement('input')
    type(field, 'abc')
    field.blur()
    act(() => bumpToken())
    expect(document.activeElement).toBe(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 3])
  })
})

describe('fix3 R3-2 — 열 수가 바뀌면(reflow) 같은 질의를 다시 묻는다', () => {
  it('막대가 열린 채 프레임 cols 가 바뀌면 결과를 지우고 뷰포트 기준으로 다시 검색, 행 수·top 만 바뀌면 다시 묻지 않는다', async () => {
    renderPanes(['p1'])
    frame({ scrollTop: 100, cols: 10 })
    act(() => requestTerminalFind('p1'))
    type(input() ?? document.createElement('input'), 'ab')
    await settle()
    expect(searches).toHaveLength(1)
    frame({ scrollTop: 101, cols: 10 })
    await settle()
    expect(searches).toHaveLength(1)
    frame({ scrollTop: 300, cols: 6 })
    expect(hits()).toEqual([]) // 낡은 결과는 바로 지운다
    await settle()
    expect(searches).toEqual([
      { paneId: 'p1', query: 'ab', direction: 'backward', from: 'viewport' },
      { paneId: 'p1', query: 'ab', direction: 'backward', from: 'viewport' },
    ])
    expect(host.querySelector('[data-term-search-status]')?.textContent).toBe('1 / 2')
  })
})

