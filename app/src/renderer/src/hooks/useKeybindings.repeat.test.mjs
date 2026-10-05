// @vitest-environment happy-dom
// LIFE-495 fix1 R1-06 — 누르고 있어도 한 번만 도는 액션(K6ⓔ). 실제 `useKeybindings` 에 keydown 최초 1회 + repeat 2회를 넣는다(렌더러 길).
// main 메뉴 키 길(⌘W·⌘R)은 `menuKeyShortcut`(shared/keybindings.test.ts) 가 같은 목록으로 본다.
// ShortcutHandlers 는 ActionId 전부를 요구해 `as` 없이 채우기 어렵다 — 이 파일은 .mjs 로 둔다(menu-scope 테스트와 같다).
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeybindings } from './useKeybindings.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host
let root
let terminal
const ran = []
const handlers = new Proxy({}, { get: (_, action) => (variant) => ran.push(`${String(action)}:${variant}`) })
let shortcutListener = null
function Harness() {
  useKeybindings(handlers, false, () => false)
  return null
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hold = (init) => act(() => {
  for (const repeat of [false, true, true]) terminal.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, repeat, ...init }))
})

beforeEach(async () => {
  ran.length = 0
  Reflect.set(window, 'corral', { getKeybindings: async () => ({}), onShortcut: (listener) => { shortcutListener = listener; return () => { shortcutListener = null } } })
  terminal = document.createElement('textarea')
  document.body.append(terminal)
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
  terminal.remove()
})

describe('렌더러 keydown 의 반복 억제 (fix1 R1-06 · K6ⓔ)', () => {
  it('⌘⇧T(다시 열기)를 누르고 있어도 한 번', () => {
    hold({ key: 'T', code: 'KeyT', metaKey: true, shiftKey: true })
    expect(ran).toEqual(['tab.reopenClosed:0'])
  })
  it('반복 억제 목록 밖 액션(⌘⇧] 탭 순환)은 반복마다 돈다 — 지금 동작', () => {
    hold({ key: ']', code: 'BracketRight', metaKey: true, shiftKey: true })
    expect(ran).toEqual(['tab.cycle:0', 'tab.cycle:0', 'tab.cycle:0'])
  })
  it('main 이 보낸 매칭(IPC)은 main 이 이미 거른 것이라 그대로 돈다', () => {
    act(() => shortcutListener({ id: 'tab.reopenClosed', variant: 0 }))
    expect(ran).toEqual(['tab.reopenClosed:0'])
  })
})
