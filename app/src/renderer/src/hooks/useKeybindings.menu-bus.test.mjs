// @vitest-environment happy-dom
// LIFE-496 fix1 R1-01 — 전역 단축키가 실행되면 menu-bus 에 알려 열린 메뉴가 닫힌다(포커스 이벤트가 안 와도).
// ShortcutHandlers 는 ActionId 전부를 요구해 `as` 없이 채우기 어렵다 — 이 파일은 .mjs 로 둔다.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onMenuOpen } from '../menu-bus.js'
import { useKeybindings } from './useKeybindings.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host
let root
const ran = []
function Harness() {
  useKeybindings(new Proxy({}, { get: (_, action) => () => ran.push(action) }), false, () => false)
  return null
}

beforeEach(async () => {
  ran.length = 0
  Reflect.set(window, 'corral', { getKeybindings: async () => ({}), onShortcut: () => () => {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(Harness)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useKeybindings → menu-bus (R1-01)', () => {
  it('⌘T 를 실행하면 열린 메뉴에 닫힘 알림이 간다 — 실행보다 먼저', () => {
    const order = []
    const off = onMenuOpen('some-menu', () => order.push('menu-closed'))
    const input = document.createElement('input')
    document.body.append(input)
    try {
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', metaKey: true, bubbles: true, cancelable: true }))
      })
      order.push(...ran)
      expect(ran).toEqual(['terminal.new'])
      expect(order).toEqual(['menu-closed', 'terminal.new'])
    } finally {
      off()
      input.remove()
    }
  })

  it('단축키가 아닌 키는 메뉴를 닫지 않는다', () => {
    const closed = vi.fn()
    const off = onMenuOpen('some-menu', closed)
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }))
    })
    expect(closed).not.toHaveBeenCalled()
    off()
  })
})
