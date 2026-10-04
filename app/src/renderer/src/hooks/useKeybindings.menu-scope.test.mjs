// @vitest-environment happy-dom
// LIFE-496 fix2 R2-02 — 전역 단축키와 열린 메뉴. 실제 `useKeybindings` + 실제 `TabCreateMenu`·`ParentPicker` 합성.
// ⓐ 포커스를 옮기지 않는 단축키(⌘B 사이드바, 피커 안 ⌘⇧Backspace no-op)는 메뉴·피커를 닫지 않고 입력 포커스도 그대로다(기준 commit 동작).
// ⓑ 포커스를 실제로 새 터미널로 옮기는 ⌘T 는 `+` 메뉴를 닫는다(R1-01 유지) — 닫힘은 `+` 메뉴의 focus-out 이 한다.
// ShortcutHandlers 는 ActionId 전부를 요구해 `as` 없이 채우기 어렵다 — 이 파일은 .mjs 로 둔다.
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ParentPicker } from '../components/ParentPicker.js'
import { TabCreateMenu } from '../components/TabCreateMenu.js'
import { useKeybindings } from './useKeybindings.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host
let root
let terminal
const ran = []
const dismissed = []
/** 단축키 액션 — ⌘T(terminal.new)만 새 터미널로 포커스를 옮긴다(TerminalPane 마운트 포커스 대역). 나머지는 포커스를 건드리지 않는다. */
const handlers = new Proxy({}, {
  get: (_, action) => () => {
    ran.push(action)
    if (action === 'terminal.new') terminal.focus()
  },
})
function Harness({ kind }) {
  const [open, setOpen] = useState(true)
  useKeybindings(handlers, false, () => false)
  if (!open) return null
  if (kind === 'menu')
    return createElement(TabCreateMenu, {
      groupId: 'g1', anchor: { left: 10, bottom: 30 }, entries: [], newTerminalShortcut: '⌘T',
      onNewTerminal: () => {}, onLaunchAgent: () => {}, onActivateTab: () => {},
      onDismiss: (reason) => { dismissed.push(reason); setOpen(false) },
    })
  return createElement(ParentPicker, {
    child: { path: '/fx', name: 'fx', branch: 'main', label: null }, candidates: [], anchor: { left: 0, right: 200, top: 0 }, activePath: '/fx',
    onPick: () => {}, onClose: () => { dismissed.push('picker-close'); setOpen(false) },
  })
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function mount(kind) {
  await act(async () => {
    root.render(createElement(Harness, { kind }))
    await pause(40)
  })
  const input = host.querySelector(kind === 'menu' ? '[data-tab-create-input]' : '.parent-picker-input')
  act(() => input.focus())
  return input
}
const press = (target, init) => act(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
})

beforeEach(() => {
  ran.length = 0
  dismissed.length = 0
  Reflect.set(window, 'corral', { getKeybindings: async () => ({}), onShortcut: () => () => {} })
  terminal = document.createElement('textarea')
  document.body.append(terminal)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  terminal.remove()
})

describe('전역 단축키와 열린 메뉴 (R2-02)', () => {
  it('`+` 메뉴 입력 중 ⌘B — 사이드바만 토글, 메뉴와 입력 포커스는 그대로', async () => {
    const input = await mount('menu')
    press(input, { key: 'b', code: 'KeyB', metaKey: true })
    expect(ran).toEqual(['sidebar.toggle'])
    expect(host.querySelector('[data-tab-create-menu]')).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(dismissed).toEqual([])
  })

  it('상위 워크트리 피커 입력 중 ⌘⇧Backspace(no-op) — 피커와 입력 포커스는 그대로', async () => {
    const input = await mount('picker')
    press(input, { key: 'Backspace', code: 'Backspace', metaKey: true, shiftKey: true })
    expect(ran).toEqual(['workspace.delete'])
    expect(host.querySelector('.parent-picker-input')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(dismissed).toEqual([])
  })

  it('`+` 메뉴 입력 중 ⌘T — 새 탭 액션이 돌고, 포커스가 새 터미널로 가며 메뉴가 닫힌다 (R1-01 유지)', async () => {
    const input = await mount('menu')
    press(input, { key: 't', code: 'KeyT', metaKey: true })
    expect(ran).toEqual(['terminal.new'])
    expect(host.querySelector('[data-tab-create-menu]')).toBeNull()
    expect(document.activeElement).toBe(terminal)
    expect(dismissed).toEqual(['focus-out'])
  })
})
