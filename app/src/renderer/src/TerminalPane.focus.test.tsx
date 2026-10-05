// @vitest-environment happy-dom
// LIFE-501 K8ⓑ — 결정적 재현: 이름 편집 입력칸이 포커스를 쥔 채 터미널이 마운트되거나 포커스 토큰이 올라오면
// 터미널이 그 포커스를 빼앗지 않는다. 네이티브에서는 수 ms 경합이라 1/10 수준으로만 나오던 실패를, 순서를 고정해
// 매번 재현한다(입력칸 포커스 → 터미널 마운트). base 에서는 마운트 effect 의 `term.focus()` 가 입력칸을 이긴다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// xterm 은 happy-dom 에서 그리지 못한다 — 포커스 계약만 보면 되므로 보조 textarea 하나를 갖는 가짜로 바꾼다.
// 진짜 xterm 처럼 `open()` 이 컨테이너 안에 `.xterm-helper-textarea` 를 만들고 `focus()` 가 그것을 포커스한다.
vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    buffer = { active: { cursorX: 0, cursorY: 0, getLine: () => undefined } }
    private textarea: HTMLTextAreaElement | null = null
    loadAddon(): void {}
    open(container: HTMLElement): void {
      this.textarea = document.createElement('textarea')
      this.textarea.className = 'xterm-helper-textarea'
      container.appendChild(this.textarea)
    }
    focus(): void {
      this.textarea?.focus()
    }
    onSelectionChange(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    hasSelection(): boolean {
      return false
    }
    write(_data: string, done?: () => void): void {
      done?.()
    }
    resize(): void {}
    dispose(): void {
      this.textarea?.remove()
    }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const { TerminalPane } = await import('./TerminalPane.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  const unsubscribe = (): (() => void) => () => {}
  Reflect.set(window, 'corral', {
    selectPane: vi.fn(async () => {}),
    repaintPane: vi.fn(async () => {}),
    onTermFrame: unsubscribe,
    onFileDrop: unsubscribe,
    termInput: vi.fn(),
    termScroll: vi.fn(),
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
})

/** 탭 이름 입력칸 — `MainTabBar` 의 편집 중 모양(`.main-tab-rename.is-editing`)과 같다. */
function editingInput(input: { className?: string; attribute?: string } = {}): HTMLInputElement {
  const element = document.createElement('input')
  element.className = input.className ?? 'main-tab-rename is-editing'
  if (input.attribute !== undefined) element.setAttribute(input.attribute, '')
  document.body.appendChild(element)
  element.focus()
  expect(document.activeElement).toBe(element)
  return element
}

function renderPane(input: { paneId: string; focusToken: number }): void {
  act(() => {
    root.render(createElement(TerminalPane, { paneId: input.paneId, diagnostics: false, focusable: true, focusToken: input.focusToken, announceFocus: true }))
  })
}

const terminalTextarea = (): Element | null => host.querySelector('.xterm-helper-textarea')

describe('LIFE-501 — 편집 중인 입력칸은 터미널 포커스에 지지 않는다', () => {
  it('입력칸이 포커스를 쥔 채 터미널이 마운트되면 입력칸이 포커스를 지킨다', () => {
    const input = editingInput()
    renderPane({ paneId: 'p1', focusToken: 0 })
    expect(terminalTextarea()).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('입력칸이 포커스를 쥔 채 포커스 토큰이 올라와도 입력칸이 포커스를 지킨다', () => {
    renderPane({ paneId: 'p1', focusToken: 0 })
    const input = editingInput()
    renderPane({ paneId: 'p1', focusToken: 1 })
    expect(document.activeElement).toBe(input)
  })

  it('카드 인라인 이름 입력칸(`data-inline-rename`)도 같다', () => {
    const input = editingInput({ className: '', attribute: 'data-inline-rename' })
    renderPane({ paneId: 'p1', focusToken: 0 })
    expect(document.activeElement).toBe(input)
  })

  it('편집 중이 아니면 마운트가 터미널에 포커스를 준다(기존 계약)', () => {
    renderPane({ paneId: 'p1', focusToken: 0 })
    expect(document.activeElement).toBe(terminalTextarea())
  })

  it('평소 상태의 탭 이름 입력칸(편집 아님)에 포커스가 남아 있으면 터미널이 가져간다', () => {
    editingInput({ className: 'main-tab-rename' })
    renderPane({ paneId: 'p1', focusToken: 0 })
    expect(document.activeElement).toBe(terminalTextarea())
  })

  it('편집 입력칸이 아닌 입력칸(사이드바 검색 등)은 포커스 토큰에 양보한다 — 탭 클릭이 터미널로 돌려준다', () => {
    renderPane({ paneId: 'p1', focusToken: 0 })
    editingInput({ className: 'sidebar-search-input' })
    renderPane({ paneId: 'p1', focusToken: 1 })
    expect(document.activeElement).toBe(terminalTextarea())
  })
})
