// @vitest-environment happy-dom
// LIFE-571 C2ⓓ·C4ⓐ — Shift+Enter 만 CSI-u 로 가로채고, 그 밖의 키(keyup·keypress·조합 중·다른 수정자 동반·Alt/Ctrl+Enter)는 xterm 에 맡긴다.
import { describe, expect, it, vi } from 'vitest'
import { SHIFT_ENTER_SEQUENCE, terminalKeyHandler, terminalKeySequence } from './terminal-keys.js'

const enter = (init: KeyboardEventInit & { type?: string; keyCode?: number } = {}): KeyboardEvent => {
  const { type = 'keydown', keyCode = 13, ...rest } = init
  const event = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...rest })
  // happy-dom·Chromium 모두 생성자 init 의 keyCode 를 반영하지 않는다 — 실제 키 이벤트처럼 값을 박는다.
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  return event
}

describe('terminalKeySequence', () => {
  it('Shift+Enter keydown → \\x1b[13;2u', () => {
    expect(SHIFT_ENTER_SEQUENCE).toBe('\x1b[13;2u')
    expect(terminalKeySequence(enter({ shiftKey: true }))).toBe('\x1b[13;2u')
  })

  it('keyup·keypress 는 가로채지 않는다', () => {
    expect(terminalKeySequence(enter({ type: 'keyup', shiftKey: true }))).toBeNull()
    expect(terminalKeySequence(enter({ type: 'keypress', shiftKey: true }))).toBeNull()
  })

  it('IME 조합 중(isComposing·keyCode 229)은 가로채지 않는다', () => {
    expect(terminalKeySequence(enter({ shiftKey: true, isComposing: true }))).toBeNull()
    expect(terminalKeySequence(enter({ shiftKey: true, keyCode: 229 }))).toBeNull()
    expect(terminalKeySequence(enter({ shiftKey: true, key: 'Process', keyCode: 229 }))).toBeNull()
  })

  it('다른 수정자가 함께 눌린 Shift+Enter 는 가로채지 않는다', () => {
    expect(terminalKeySequence(enter({ shiftKey: true, metaKey: true }))).toBeNull()
    expect(terminalKeySequence(enter({ shiftKey: true, ctrlKey: true }))).toBeNull()
    expect(terminalKeySequence(enter({ shiftKey: true, altKey: true }))).toBeNull()
  })

  it('Enter·Alt+Enter·Ctrl+Enter·⌘+Enter 는 지금처럼 xterm 에 맡긴다', () => {
    expect(terminalKeySequence(enter())).toBeNull()
    expect(terminalKeySequence(enter({ altKey: true }))).toBeNull()
    expect(terminalKeySequence(enter({ ctrlKey: true }))).toBeNull()
    expect(terminalKeySequence(enter({ metaKey: true }))).toBeNull()
  })

  it('Enter 가 아닌 Shift 키는 가로채지 않는다', () => {
    expect(terminalKeySequence(new KeyboardEvent('keydown', { key: 'A', shiftKey: true }))).toBeNull()
    expect(terminalKeySequence(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))).toBeNull()
  })
})

describe('terminalKeyHandler', () => {
  it('Shift+Enter → 시퀀스 1회 전송·기본 처리 막음·false', () => {
    const send = vi.fn()
    const event = enter({ shiftKey: true })
    const stop = vi.spyOn(event, 'stopPropagation')
    expect(terminalKeyHandler(send)(event)).toBe(false)
    expect(send.mock.calls).toEqual([['\x1b[13;2u']])
    expect(event.defaultPrevented).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('가로채지 않는 키 → 전송 0·기본 처리 그대로·true', () => {
    const send = vi.fn()
    const handler = terminalKeyHandler(send)
    for (const event of [enter(), enter({ altKey: true }), enter({ type: 'keyup', shiftKey: true }), enter({ shiftKey: true, isComposing: true }), enter({ shiftKey: true, keyCode: 229 })]) {
      expect(handler(event)).toBe(true)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })
})
