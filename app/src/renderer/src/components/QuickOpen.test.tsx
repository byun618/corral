// @vitest-environment happy-dom
// ⌘P 빠른 열기 — 첫 포커스·Esc (LIFE-593 D1 · E1ⓒ)
//   · 열린 worktree 가 없어 안내만 보일 때도 포커스가 대화상자 안에 있고, Esc 로 닫힌다(onClose(true) = 연 자리로 복귀)
//   · 그 Esc·글자는 대화상자 밖(터미널 자리)으로 가지 않는다
//   · worktree 가 있으면 첫 포커스는 입력칸 그대로, Tab 은 입력 ↔ 토글
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickOpen } from './QuickOpen.js'

vi.mock('../file-list-client.js', () => ({
  cachedFileList: () => null,
  requestFileList: () => ({ result: new Promise(() => {}), cancel: () => {} }),
}))

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
/** 터미널 자리 — ⌘P 를 누르기 전 포커스를 쥐고 있던 곳. */
let terminal: HTMLTextAreaElement
let terminalKeys: string[]

const keyFrom = (target: EventTarget, key: string): void =>
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
const dialog = (): Element | null => document.querySelector('[data-quick-open]')
const render = (input: { root: string | null; onClose: (restore: boolean) => void }): void =>
  act(() => root.render(createElement(QuickOpen, {
    root: input.root, recent: [], includeIgnored: false, onIncludeIgnored: () => {}, onOpen: () => {}, onClose: input.onClose,
  })))

beforeEach(() => {
  host = document.createElement('div')
  terminal = document.createElement('textarea')
  terminalKeys = []
  terminal.addEventListener('keydown', (event) => terminalKeys.push(event.key))
  document.body.append(terminal, host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  terminal.remove()
})

describe('빠른 열기 — 활성 worktree 없음(D1)', () => {
  it('안내 상태: 포커스가 대화상자 안이고 Esc 로 닫힌다(복귀 요청) · 키가 터미널로 가지 않는다', () => {
    const onClose = vi.fn()
    terminal.focus()
    render({ root: null, onClose })
    expect(dialog()?.getAttribute('data-quick-open-state')).toBe('no-root')
    expect(dialog()?.contains(document.activeElement)).toBe(true)
    keyFrom(document.activeElement ?? document.body, 'p')
    keyFrom(document.activeElement ?? document.body, 'Tab')
    expect(dialog()?.contains(document.activeElement)).toBe(true)
    keyFrom(document.activeElement ?? document.body, 'Escape')
    expect(onClose.mock.calls).toEqual([[true]])
    expect(terminalKeys).toEqual([])
  })
})

describe('빠른 열기 — 활성 worktree 있음(무회귀)', () => {
  it('첫 포커스 = 입력칸 · Tab = 입력 ↔ 토글 · Esc 로 닫힌다', () => {
    const onClose = vi.fn()
    terminal.focus()
    render({ root: '/r-wt/a', onClose })
    const input = document.querySelector('[data-quick-open-input]')
    const toggle = document.querySelector('[data-quick-open-ignored]')
    expect(document.activeElement).toBe(input)
    keyFrom(document.activeElement ?? document.body, 'Tab')
    expect(document.activeElement).toBe(toggle)
    keyFrom(document.activeElement ?? document.body, 'Tab')
    expect(document.activeElement).toBe(input)
    keyFrom(document.activeElement ?? document.body, 'Escape')
    expect(onClose.mock.calls).toEqual([[true]])
    expect(terminalKeys).toEqual([])
  })
})
