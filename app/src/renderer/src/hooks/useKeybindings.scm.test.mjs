// @vitest-environment happy-dom
/* global setTimeout, KeyboardEvent, window, document */
// LIFE-683 F2-05 — ⌘⇧G(`scm.show`)는 파일 탭 편집기(`data-file-editor`)·diff 탭 편집기(`data-scm-diff-host`) 안에서도 소스 제어를 연다(S1 ·
// Orca `scope: 'global'`). fix r1 R1-03 의 편집기 양보를 되돌렸다 — Monaco ⇧⌘G 이전 찾기는 찾기 위젯 ⇧Enter 로 남는다(D1).
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
const inside = (attr) => {
  const box = document.createElement('div')
  box.setAttribute(attr, '')
  const input = document.createElement('textarea')
  box.append(input)
  document.body.append(box)
  nodes.push(box)
  return input
}
const G = { key: 'G', code: 'KeyG', metaKey: true, shiftKey: true }

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

describe('⌘⇧G 는 편집기 포커스에서도 소스 제어 (F2-05 — R1-03 되돌림)', () => {
  it('파일 탭·diff 탭 편집기 안에서도 ⌘⇧G = 소스 제어 보이기(키를 가져간다)', () => {
    expect(press(inside('data-file-editor'), G).defaultPrevented).toBe(true)
    expect(press(inside('data-scm-diff-host'), G).defaultPrevented).toBe(true)
    expect(ran).toEqual(['scm.show:0', 'scm.show:0'])
  })
  it('편집기 밖에서도 ⌘⇧G = 소스 제어 보이기', () => {
    const outside = inside('data-plain')
    expect(press(outside, G).defaultPrevented).toBe(true)
    expect(ran).toEqual(['scm.show:0'])
  })
})
