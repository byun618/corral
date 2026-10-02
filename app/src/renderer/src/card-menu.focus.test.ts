// @vitest-environment happy-dom
// LIFE-478 K7ⓗ — ⌘⇧⌫ 를 무시할 포커스. 터미널(xterm 숨은 textarea)은 입력란이 아니다(198 `editable-target.ts`).
import { afterEach, describe, expect, it } from 'vitest'
import { isEditableFocus } from './card-menu.js'

afterEach(() => {
  document.body.innerHTML = ''
})

const make = (html: string): Element => {
  document.body.innerHTML = html
  const el = document.body.querySelector('[data-t]')
  if (el === null) throw new Error('없음')
  return el
}

describe('isEditableFocus', () => {
  it('터미널 helper textarea 는 입력란이 아니다 — 단축키가 듣는다', () => {
    expect(isEditableFocus(make('<div class="xterm"><textarea data-t class="xterm-helper-textarea"></textarea></div>'))).toBe(false)
  })
  it('input · textarea · select · contenteditable 은 입력란 — 무시', () => {
    expect(isEditableFocus(make('<input data-t />'))).toBe(true)
    expect(isEditableFocus(make('<textarea data-t></textarea>'))).toBe(true)
    expect(isEditableFocus(make('<select data-t></select>'))).toBe(true)
    expect(isEditableFocus(make('<div contenteditable="true"><span data-t>x</span></div>'))).toBe(true)
  })
  it('본문·단추·null 은 입력란이 아니다', () => {
    expect(isEditableFocus(make('<button data-t>b</button>'))).toBe(false)
    expect(isEditableFocus(document.body)).toBe(false)
    expect(isEditableFocus(null)).toBe(false)
  })
})
