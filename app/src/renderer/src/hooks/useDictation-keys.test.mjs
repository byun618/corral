// @vitest-environment happy-dom
/* global setTimeout, Event, KeyboardEvent, window, document */
// LIFE-834 fix4 F-1·r4 — 받아쓰기 키 길을 **진짜 `useKeybindings` + `useDictation`** 한 트리로 본다(r4 C-R4-6): 누름은 단축키 길(문서 캡처)이 `press` 로,
// 뗌·키 반복·창 포커스 잃음·뗌 뒤 반복 삼키기(r4 C-R4-2)는 `useDictation` 의 창 캡처가 받는다. keyup 이 어디서 오든(xterm·대화상자·IME 조합 중) 받는지,
// 뗌 뒤 남은 글쇠 반복이 xterm(=pane)·⌘M 으로 새지 않는지 본다. 시계는 `Date.now` 를 앞당긴다. main 은 가짜 `window.corral`.
// ShortcutHandlers 는 ActionId 전부를 요구해 `as` 없이 채우기 어렵다 — 선례(useKeybindings.repeat·menu-scope)처럼 .mjs 로 둔다.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DICTATION_HOLD_THRESHOLD_MS } from '../../../shared/dictation.js'
import { useDictation } from './useDictation.js'
import { useKeybindings } from './useKeybindings.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host
let root
let listener = null
let sessionId = ''
const calls = []
let realNow = Date.now
let clock = 0

/** App 과 같은 연결 — `dictation.toggle` 핸들러가 `press`, 나머지 액션은 아무것도 안 한다. */
function Probe() {
  const dictation = useDictation({ paneExists: () => true, notify: () => undefined })
  const handlers = new Proxy({}, { get: (_, action) => (action === 'dictation.toggle' ? () => dictation.press() : () => undefined) })
  useKeybindings(handlers, false, () => false)
  return null
}

/** xterm 모양 — `[data-term-pane]` 상자 안의 textarea. 그 textarea 까지 온 keydown 을 적는다(= pane 으로 가는 바이트). */
function terminal(paneId) {
  const box = document.createElement('div')
  box.setAttribute('data-term-pane', paneId)
  const textarea = document.createElement('textarea')
  box.append(textarea)
  document.body.append(box)
  const keys = []
  textarea.addEventListener('keydown', (event) => keys.push(`${event.metaKey ? '⌘' : ''}${event.key}${event.repeat ? '(repeat)' : ''}`))
  return { textarea, keys }
}

const emit = (event) => act(() => listener?.(event))
const key = (target, type, init) => {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}
/** ⌘⇧M keydown(첫 누름 또는 반복). */
const down = (target, repeat = false) => key(target, 'keydown', { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true, repeat })
/** 키 반복으로 `ms` 만큼 누르고 있기(반복 간격 50 ms). */
const holdFor = (target, ms) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    clock += 50
    down(target, true)
  }
}

beforeEach(async () => {
  calls.length = 0
  listener = null
  realNow = Date.now
  clock = realNow()
  Date.now = () => clock
  Reflect.set(window, 'corral', {
    getKeybindings: () => Promise.resolve({}),
    onShortcut: () => () => undefined,
    dictationStart: (input) => {
      sessionId = input.sessionId
      calls.push('start')
      return Promise.resolve({ ok: true })
    },
    dictationStop: () => calls.push('stop'),
    dictationCancel: () => calls.push('cancel'),
    dictationOpenPrivacy: () => Promise.resolve(),
    dictationInsert: () => Promise.resolve({ ok: true, via: 'paste' }),
    onDictationEvent: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  // 단축키 재정의 읽기(빈 재정의 = 기본값)가 끝나게 한 번 돈다
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
})
afterEach(() => {
  Date.now = realNow
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('useDictation × useKeybindings — 홀드·탭 키 길(fix4 F-1)', () => {
  it('xterm 에서 누른 채(키 반복) 300 ms 넘게 → ⌘ keyup 에 정지, 누름·반복은 xterm 에 가지 않는다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    const first = down(pane.textarea)
    expect(first.defaultPrevented).toBe(true)
    expect(calls).toEqual(['start'])
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, DICTATION_HOLD_THRESHOLD_MS + 100)
    expect(pane.keys).toEqual([])
    // ⌘ 아래 M 의 keyup 은 macOS 가 버린다 — ⌘ keyup 이 뗌
    key(pane.textarea, 'keyup', { key: 'Meta', code: 'MetaLeft', shiftKey: true })
    expect(calls).toEqual(['start', 'stop'])
  })
  it('짧게 탭 → 켜진 채, 다시 탭 → 정지', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    clock += 80
    key(pane.textarea, 'keyup', { key: 'Meta', code: 'MetaLeft', shiftKey: true })
    key(pane.textarea, 'keyup', { key: 'Shift', code: 'ShiftLeft' })
    expect(calls).toEqual(['start'])
    clock += 3000
    down(pane.textarea)
    expect(calls).toEqual(['start', 'stop'])
  })
  it('홀드 중 대화상자 입력칸으로 포커스가 가도 그 자리의 keyup(그 처리기가 전파를 막아도)을 받는다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, 500)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const field = document.createElement('input')
    field.addEventListener('keyup', (event) => event.stopPropagation())
    dialog.append(field)
    document.body.append(dialog)
    field.focus()
    key(field, 'keyup', { key: 'Meta', code: 'MetaLeft', shiftKey: true })
    expect(calls).toEqual(['start', 'stop'])
  })
  it('IME 조합 중에 온 keyup(isComposing)도 뗌으로 받는다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, 500)
    key(pane.textarea, 'keyup', { key: 'Shift', code: 'ShiftLeft', metaKey: true, isComposing: true })
    expect(calls).toEqual(['start', 'stop'])
  })
  it('홀드 중 창 포커스를 잃으면(keyup 을 못 받음) 뗌으로 본다 — 키 반복으로 잰 홀드면 정지', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, 500)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(calls).toEqual(['start', 'stop'])
  })
  it('r4 C-R4-5 — 홀드 중 창이 숨으면(visibilitychange → hidden) 뗌으로 본다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, 500)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
    expect(calls).toEqual(['start', 'stop'])
  })
  it('다른 글쇠의 keyup 은 뗌이 아니다(홀드 유지)', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    clock += 500
    key(pane.textarea, 'keyup', { key: 'a', code: 'KeyA', metaKey: true, shiftKey: true })
    expect(calls).toEqual(['start'])
  })
})

describe('r4 C-R4-2 — 뗌 뒤 아직 눌린 글쇠의 반복은 pane·메뉴로 가지 않는다', () => {
  it('⌘ 를 먼저 떼면(홀드 끝·정지) 이어지는 M(⇧) 반복 keydown 은 삼킨다 — xterm 0', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, 600)
    key(pane.textarea, 'keyup', { key: 'Meta', code: 'MetaLeft', shiftKey: true })
    expect(calls).toEqual(['start', 'stop'])
    const stray = [key(pane.textarea, 'keydown', { key: 'M', code: 'KeyM', shiftKey: true, repeat: true }), key(pane.textarea, 'keydown', { key: 'M', code: 'KeyM', shiftKey: true, repeat: true })]
    expect(stray.map((event) => event.defaultPrevented)).toEqual([true, true])
    expect(pane.keys).toEqual([])
    expect(calls).toEqual(['start', 'stop'])
  })
  it('⇧ 를 먼저 떼면 남은 ⌘M 반복도 삼킨다(기본 메뉴 Minimize 로 가지 않게)', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, 600)
    key(pane.textarea, 'keyup', { key: 'Shift', code: 'ShiftLeft', metaKey: true })
    expect(calls).toEqual(['start', 'stop'])
    const stray = key(pane.textarea, 'keydown', { key: 'm', code: 'KeyM', metaKey: true, repeat: true })
    expect(stray.defaultPrevented).toBe(true)
    expect(pane.keys).toEqual([])
  })
  it('그 글쇠의 keyup 뒤에는 삼키지 않는다 — M 을 다시 치면 xterm 으로, ⌘⇧M 새 누름은 새 세션', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, 600)
    key(pane.textarea, 'keyup', { key: 'Meta', code: 'MetaLeft', shiftKey: true })
    key(pane.textarea, 'keydown', { key: 'M', code: 'KeyM', shiftKey: true, repeat: true })
    key(pane.textarea, 'keyup', { key: 'M', code: 'KeyM', shiftKey: true })
    key(pane.textarea, 'keyup', { key: 'Shift', code: 'ShiftLeft' })
    const typed = key(pane.textarea, 'keydown', { key: 'm', code: 'KeyM' })
    const typedRepeat = key(pane.textarea, 'keydown', { key: 'm', code: 'KeyM', repeat: true })
    expect([typed.defaultPrevented, typedRepeat.defaultPrevented]).toEqual([false, false])
    expect(pane.keys).toEqual(['m', 'm(repeat)'])
    emit({ kind: 'ended', sessionId, end: { kind: 'done' } })
    down(pane.textarea)
    expect(calls).toEqual(['start', 'stop', 'start'])
  })
  it('새 누름(반복 아닌 keydown)이 오면 삼키기를 푼다 — keyup 을 못 받았어도 다음 타자가 막히지 않는다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    holdFor(pane.textarea, 600)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(calls).toEqual(['start', 'stop'])
    key(pane.textarea, 'keydown', { key: 'm', code: 'KeyM' })
    key(pane.textarea, 'keydown', { key: 'm', code: 'KeyM', repeat: true })
    expect(pane.keys).toEqual(['m', 'm(repeat)'])
  })
})
