// @vitest-environment happy-dom
/* global setTimeout, KeyboardEvent, window, document */
// LIFE-602 수정 1 R1-F — 편집 칸(`data-editor-keys`: 본문 편집기·코멘트 입력)에 포커스가 있으면 앱 전역 단축키(document capture)가
// 편집기 단축키(⌘B·⌘⇧I·⌘E·⌘K·⌘↵)를 가로채지 않는다. 칸 밖에서는 그대로 전역 동작(⌘B 사이드바 · ⌘K 팔레트) — 무회귀 대조.
// 실제 Electron 키 입력 원자료는 LIFE-602 관문 `q-keys.mjs`. main 메뉴 키 길(`menuKeyShortcut`)은 ⌘W·⌘R 만 쥔다(shared/keybindings.test.ts).
// ShortcutHandlers 는 ActionId 전부를 요구해 `as` 없이 채우기 어렵다 — 선례(repeat·menu-scope)처럼 .mjs 로 둔다.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeybindings } from './useKeybindings.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host
let root
let editor
let plain
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

beforeEach(async () => {
  ran.length = 0
  Reflect.set(window, 'corral', { getKeybindings: async () => ({}), onShortcut: () => () => {} })
  editor = document.createElement('textarea')
  editor.setAttribute('data-editor-keys', '')
  plain = document.createElement('textarea')
  document.body.append(editor, plain)
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
  editor.remove()
  plain.remove()
})

describe('편집 칸 단축키 양보 (R1-F)', () => {
  it('편집 칸 안 ⌘B·⌘K·⌘⇧I·⌘E·⌘↵ = 전역 처리 0 · 기본 동작 막지 않음(편집기 처리기가 받는다)', () => {
    for (const init of [{ key: 'b', code: 'KeyB', metaKey: true }, { key: 'k', code: 'KeyK', metaKey: true }, { key: 'I', code: 'KeyI', metaKey: true, shiftKey: true }, { key: 'e', code: 'KeyE', metaKey: true }, { key: 'Enter', code: 'Enter', metaKey: true }]) {
      expect(press(editor, init).defaultPrevented).toBe(false)
    }
    expect(ran).toEqual([])
  })
  it('대조 — 편집 칸 밖에서는 ⌘B = 사이드바 · ⌘K = 팔레트(기존 바인딩 그대로)', () => {
    expect(press(plain, { key: 'b', code: 'KeyB', metaKey: true }).defaultPrevented).toBe(true)
    expect(press(document.body, { key: 'k', code: 'KeyK', metaKey: true }).defaultPrevented).toBe(true)
    expect(ran).toEqual(['sidebar.toggle:0', 'palette.open:0'])
  })
  it('편집 칸 안에서도 편집기 단축키가 아닌 전역 키(⌘I 작업 페이지)는 그대로 돈다', () => {
    press(editor, { key: 'i', code: 'KeyI', metaKey: true })
    expect(ran).toEqual(['tasks.toggle:0'])
  })
})
