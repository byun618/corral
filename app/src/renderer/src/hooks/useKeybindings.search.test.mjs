// @vitest-environment happy-dom
/* global setTimeout, KeyboardEvent, window, document */
// LIFE-803 C7ⓐⓑⓒ — ⌘⇧F(`search.show`)는 전역: 터미널 pane·Monaco 편집기·탐색기 트리·아무 데도 아님 넷에서 가져가고(preventDefault+stopPropagation —
// 터미널이면 PTY 로 안 간다), 기존 ⌘F(터미널 찾기)·⌥⌘F(탐색기 이름 필터)·편집기 ⌘F 는 그대로. 하네스는 useKeybindings.terminal-find.test.mjs 와 같다.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeybindings } from './useKeybindings.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host
let root
const nodes = []
const ran = []
const handlers = new Proxy({}, { get: (_, action) => (variant) => ran.push(`${String(action)}:${variant}`) })
function Harness() {
  useKeybindings(handlers, false, () => false)
  return null
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const press = (target, init) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  let reached = false
  const below = () => { reached = true }
  target.addEventListener('keydown', below)
  act(() => { target.dispatchEvent(event) })
  target.removeEventListener('keydown', below)
  return { event, reached }
}
const inside = (attr, value = '', tag = 'textarea') => {
  const box = document.createElement('div')
  box.setAttribute(attr, value)
  const input = document.createElement(tag)
  box.append(input)
  document.body.append(box)
  nodes.push(box)
  return input
}
const SHIFT_F = { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true }
const F = { key: 'f', code: 'KeyF', metaKey: true }

beforeEach(async () => {
  ran.length = 0
  Reflect.set(window, 'corral', { getKeybindings: async () => ({}), onShortcut: () => () => {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(Harness))
    await pause(20)
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const node of nodes.splice(0)) node.remove()
})

describe('⌘⇧F 검색 보이기 (LIFE-803 C7ⓐⓑ)', () => {
  it('터미널 pane 포커스 — 가져가고 xterm 입력칸(PTY)까지 가지 않는다', () => {
    const { event, reached } = press(inside('data-term-pane', 'w1:p1'), SHIFT_F)
    expect(event.defaultPrevented).toBe(true)
    expect(reached).toBe(false)
    expect(ran).toEqual(['search.show:0'])
  })
  it('양성 대조 — 바인딩 없는 조합(⌘⇧Y)은 터미널 입력칸까지 간다', () => {
    const { event, reached } = press(inside('data-term-pane', 'w1:p1'), { key: 'Y', code: 'KeyY', metaKey: true, shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(reached).toBe(true)
    expect(ran).toEqual([])
  })
  it('Monaco 편집기 포커스 — 가져간다(편집기 양보 대상 아님)', () => {
    const { event, reached } = press(inside('data-file-editor', 'file:a.ts'), SHIFT_F)
    expect(event.defaultPrevented).toBe(true)
    expect(reached).toBe(false)
    expect(ran).toEqual(['search.show:0'])
  })
  it('탐색기 트리 포커스 — 가져간다', () => {
    const tree = document.createElement('div')
    tree.setAttribute('data-explorer-tree', '')
    tree.tabIndex = 0
    document.body.append(tree)
    nodes.push(tree)
    expect(press(tree, SHIFT_F).event.defaultPrevented).toBe(true)
    expect(ran).toEqual(['search.show:0'])
  })
  it('아무 데도 아님(body) — 가져간다', () => {
    expect(press(document.body, SHIFT_F).event.defaultPrevented).toBe(true)
    expect(ran).toEqual(['search.show:0'])
  })
  it('누르고 있어도 한 번', () => {
    press(document.body, SHIFT_F)
    press(document.body, { ...SHIFT_F, repeat: true })
    expect(ran).toEqual(['search.show:0'])
  })
})

describe('기존 키 그대로 (LIFE-803 C7ⓒ)', () => {
  it('터미널 ⌘F = 터미널 찾기', () => {
    press(inside('data-term-pane', 'w1:p1'), F)
    expect(ran).toEqual(['terminal.find:0'])
  })
  it('편집기 ⌘F 는 가져가지 않는다(Monaco 찾기 위젯)', () => {
    const { event, reached } = press(inside('data-file-editor', 'file:a.ts'), F)
    expect(event.defaultPrevented).toBe(false)
    expect(reached).toBe(true)
    expect(ran).toEqual([])
  })
  it('탐색기 트리 ⌥⌘F = 이름 필터', () => {
    const tree = document.createElement('div')
    tree.setAttribute('data-explorer-tree', '')
    document.body.append(tree)
    nodes.push(tree)
    press(tree, { key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true })
    expect(ran).toEqual(['explorer.filter:0'])
  })
})

describe('검색 입력칸 안 타자 (LIFE-803 C7ⓕ)', () => {
  it('⌘A·화살표·Backspace 는 전역 단축키로 가지 않고 입력칸이 받는다', () => {
    const input = inside('data-search-view', '', 'input')
    for (const init of [{ key: 'a', code: 'KeyA', metaKey: true }, { key: 'ArrowLeft', code: 'ArrowLeft' }, { key: 'Backspace', code: 'Backspace' }, { key: 'Backspace', code: 'Backspace', metaKey: true }]) {
      const { event, reached } = press(input, init)
      expect(event.defaultPrevented).toBe(false)
      expect(reached).toBe(true)
    }
    expect(ran).toEqual([])
  })
})
