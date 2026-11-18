// @vitest-environment happy-dom
/* global setTimeout, KeyboardEvent, window, document */
// LIFE-812 — ⌘F(`terminal.find`)는 터미널 pane(`data-term-pane`) 안에서만 가져간다. 파일 탭 Monaco·설정 검색칸·일반 입력칸의 ⌘F 는
// 그 자리로 그대로 간다(C6ⓑ — 키를 막지 않는다). 하네스는 useKeybindings.scm.test.mjs 와 같다.
// ShortcutHandlers 는 ActionId 전부를 요구해 `as` 없이 채우기 어렵다 — 선례(editor·repeat)처럼 .mjs 로 둔다.
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
  act(() => { target.dispatchEvent(event) })
  return event
}
const inside = (attr, value = '') => {
  const box = document.createElement('div')
  box.setAttribute(attr, value)
  const input = document.createElement('textarea')
  box.append(input)
  document.body.append(box)
  nodes.push(box)
  return input
}
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

describe('⌘F 는 터미널 포커스에서만 (LIFE-812)', () => {
  it('터미널 pane 안 ⌘F = 터미널에서 찾기(키를 가져간다 — PTY 로 안 간다)', () => {
    expect(press(inside('data-term-pane', 'w1:p1'), F).defaultPrevented).toBe(true)
    expect(ran).toEqual(['terminal.find:0'])
  })
  it('파일 탭 편집기·설정 검색칸·일반 입력칸의 ⌘F 는 가져가지 않는다(그 자리의 찾기 그대로)', () => {
    expect(press(inside('data-file-editor'), F).defaultPrevented).toBe(false)
    expect(press(inside('data-settings-search'), F).defaultPrevented).toBe(false)
    expect(press(inside('data-plain'), F).defaultPrevented).toBe(false)
    expect(ran).toEqual([])
  })
  it('⌥⌘F 는 터미널 안에서도 탐색기 이름 필터가 아니다(트리 범위 — base 그대로)', () => {
    expect(press(inside('data-term-pane', 'w1:p1'), { key: 'f', code: 'KeyF', metaKey: true, altKey: true }).defaultPrevented).toBe(false)
    expect(ran).toEqual([])
  })
  it('터미널 안에서도 전역 단축키는 그대로(⌘K 팔레트)', () => {
    expect(press(inside('data-term-pane', 'w1:p1'), { key: 'k', code: 'KeyK', metaKey: true }).defaultPrevented).toBe(true)
    expect(ran).toEqual(['palette.open:0'])
  })
})
