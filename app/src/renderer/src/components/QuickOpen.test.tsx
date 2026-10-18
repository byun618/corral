// @vitest-environment happy-dom
// ⌘P 빠른 열기 — 첫 포커스·Esc (LIFE-593 D1 · E1ⓒ · 리뷰 r5 R5-C-01~03)
//   · 열린 worktree 가 없어 안내만 보일 때도 포커스가 대화상자 안에 있고, Esc 로 닫힌다(onClose(true) = 연 자리로 복귀)
//   · 열린 동안 root 가 값 ↔ null 로 바뀌면 포커스를 다시 맞춘다(null → 대화상자, 값 → 입력칸). 토글에 둔 포커스는 그대로
//   · 포커스가 대화상자 밖에 있어도 Esc 로 닫히고, 그 Esc 는 밖의 리스너(터미널 자리)로 가지 않는다
//   · worktree 가 있으면 첫 포커스는 입력칸 그대로, Tab 은 입력 ↔ 토글
//   PTY 로 가는 글자 누수는 이 시험이 아니라 격리 실창(E1ⓐ)이 본다.
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
/** 터미널 자리 — ⌘P 를 누르기 전 포커스를 쥐고 있던 곳. 밖에서 출발한 Esc 가 여기 리스너에 닿는지 본다. */
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
  it('안내 상태: 포커스가 대화상자 안이고 Esc 로 닫힌다(복귀 요청)', () => {
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
  })
})

describe('빠른 열기 — 열린 동안 root 가 바뀜(R5-C-01·02)', () => {
  it('값 → null: 입력칸에 있던 포커스가 대화상자로 가고 Esc 로 닫힌다', () => {
    const onClose = vi.fn()
    render({ root: '/r-wt/a', onClose })
    expect(document.activeElement).toBe(document.querySelector('[data-quick-open-input]'))
    render({ root: null, onClose })
    expect(document.activeElement).toBe(dialog())
    keyFrom(document.activeElement ?? document.body, 'Escape')
    expect(onClose.mock.calls).toEqual([[true]])
  })
  it('null → 값: 대화상자에 있던 포커스가 입력칸으로 간다', () => {
    render({ root: null, onClose: () => {} })
    expect(document.activeElement).toBe(dialog())
    render({ root: '/r-wt/a', onClose: () => {} })
    expect(document.activeElement).toBe(document.querySelector('[data-quick-open-input]'))
  })
  it('값 → 다른 값: 토글에 둔 포커스는 빼앗지 않는다', () => {
    render({ root: '/r-wt/a', onClose: () => {} })
    keyFrom(document.activeElement ?? document.body, 'Tab')
    const toggle = document.querySelector('[data-quick-open-ignored]')
    expect(document.activeElement).toBe(toggle)
    render({ root: '/r-wt/b', onClose: () => {} })
    expect(document.activeElement).toBe(toggle)
  })
})

describe('빠른 열기 — 포커스가 대화상자 밖(R5-C-01·03)', () => {
  it('밖(터미널 자리)에서 출발한 Esc 도 닫고, 그 Esc 는 터미널 리스너에 닿지 않는다', () => {
    const onClose = vi.fn()
    render({ root: '/r-wt/a', onClose })
    terminal.focus()
    expect(dialog()?.contains(document.activeElement)).toBe(false)
    keyFrom(terminal, 'Escape')
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
  })
})
