// @vitest-environment happy-dom
/* global setTimeout, KeyboardEvent, window, document */
// LIFE-629 — ⇧⌘V(Markdown 미리보기 전환)는 포커스가 Markdown 보기(`data-markdown-view` — FileView 의 원문 편집기·미리보기) 안일 때만 가져간다.
// 터미널·다른 파일 탭(편집기)·입력칸·대화상자 입력칸에서는 `defaultPrevented` false 이고 처리기도 돌지 않는다(그 자리의 붙여넣기 등으로 그대로).
// 실제 Electron 키 입력 원자료는 최종 관문(K3)에서 — 여기는 렌더러 캡처 단계 판정만 본다.
// ShortcutHandlers 는 ActionId 전부를 요구해 `as` 없이 채우기 어렵다 — 선례(repeat·menu-scope·editor)처럼 .mjs 로 둔다.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeybindings } from './useKeybindings.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host
let root
let blocked = false
const nodes = {}
const ran = []
const handlers = new Proxy({}, { get: (_, action) => (variant) => ran.push(`${String(action)}:${variant}`) })
function Harness() {
  useKeybindings(handlers, blocked, () => false)
  return null
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SHIFT_CMD_V = { key: 'V', code: 'KeyV', metaKey: true, shiftKey: true }
const press = (target, init = SHIFT_CMD_V) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}
/** FileView 모양 — `.file-group[data-file-view]` 안에 편집기 호스트(`data-file-editor`) 와 그 안 입력 요소. */
const fileView = (input) => {
  const group = document.createElement('div')
  group.className = 'file-group'
  group.tabIndex = -1
  group.setAttribute('data-file-view', input.rel)
  if (input.markdown !== undefined) group.setAttribute('data-markdown-view', input.markdown)
  const editor = document.createElement('div')
  editor.setAttribute('data-file-editor', `file:${input.rel}`)
  const edit = document.createElement('div')
  edit.className = 'native-edit-context'
  editor.append(edit)
  group.append(editor)
  document.body.append(group)
  return { group, edit }
}

const mount = async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(Harness))
    await pause(20)
  })
}
beforeEach(async () => {
  ran.length = 0
  blocked = false
  Reflect.set(window, 'corral', { getKeybindings: async () => ({}), onShortcut: () => () => {} })
  const md = fileView({ rel: 'README.md', markdown: 'source' })
  const preview = fileView({ rel: 'NOTES.md', markdown: 'preview' })
  const ts = fileView({ rel: 'main.ts' })
  nodes.mdEdit = md.edit
  nodes.previewGroup = preview.group
  nodes.tsEdit = ts.edit
  nodes.terminal = document.createElement('textarea')
  nodes.terminal.className = 'xterm-helper-textarea'
  nodes.input = document.createElement('input')
  document.body.append(nodes.terminal, nodes.input)
  nodes.all = [md.group, preview.group, ts.group, nodes.terminal, nodes.input]
  await mount()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const node of nodes.all) node.remove()
})

describe('⇧⌘V Markdown 보기 안에서만 (LIFE-629 K3)', () => {
  it('ⓐ Markdown 원문 편집기 포커스 → 처리기 1회 · 삼킴', () => {
    expect(press(nodes.mdEdit).defaultPrevented).toBe(true)
    expect(ran).toEqual(['markdown.togglePreview:0'])
  })
  it('ⓑ 미리보기(편집기 없음 — 보기 자리 포커스) → 처리기 1회 · 삼킴', () => {
    expect(press(nodes.previewGroup).defaultPrevented).toBe(true)
    expect(ran).toEqual(['markdown.togglePreview:0'])
  })
  it('ⓓ 터미널 · .ts 파일 탭 편집기 · 입력칸 · 문서 본문 → 삼키지 않음 · 처리 0', () => {
    for (const target of [nodes.terminal, nodes.tsEdit, nodes.input, document.body]) expect(press(target).defaultPrevented).toBe(false)
    expect(ran).toEqual([])
  })
  it('ⓓ 대화상자가 열린 동안(blocked) 입력칸의 ⇧⌘V 도 삼키지 않는다 — 다른 앱 조합(⌘K)은 지금처럼 삼킨다', async () => {
    act(() => root.unmount())
    host.remove()
    blocked = true
    await mount()
    expect(press(nodes.input).defaultPrevented).toBe(false)
    expect(press(nodes.input, { key: 'k', code: 'KeyK', metaKey: true }).defaultPrevented).toBe(true)
    expect(ran).toEqual([])
  })
  it('누르고 있어도 한 번(반복은 삼키기만)', () => {
    for (const repeat of [false, true, true]) press(nodes.mdEdit, { ...SHIFT_CMD_V, repeat })
    expect(ran).toEqual(['markdown.togglePreview:0'])
  })
  it('대조 — 같은 Markdown 편집기 안에서도 다른 앱 단축키(⌘P 빠른 열기)는 그대로 앱 동작', () => {
    expect(press(nodes.mdEdit, { key: 'p', code: 'KeyP', metaKey: true }).defaultPrevented).toBe(true)
    expect(ran).toEqual(['quickOpen.open:0'])
  })
})
