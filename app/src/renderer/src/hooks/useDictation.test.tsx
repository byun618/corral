// @vitest-environment happy-dom
// LIFE-834 — 창에 붙은 받아쓰기: 단축키 순간의 키보드 포커스로 대상 고정(C3 행 1·2·3), Esc 는 캡처 단계에서 삼켜 pane(xterm 입력칸)에 0바이트(C3 행 7),
// 녹음 중 표시 등장·partial·무음·사라짐(C1·C5), FINAL 은 termInput 으로 강제 bracketed paste(C2). main 은 가짜 `window.corral`.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DICTATION_HOLD_THRESHOLD_MS, DICTATION_NOT_TERMINAL_MESSAGE, type DictationEvent, type DictationInsertResult, type DictationStartResult } from '../../../shared/dictation.js'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, clipboardTextPayloads } from '../../../shared/terminal-paste.js'
import { registerSelectionClearer } from '../terminal-selection.js'
import { DictationIndicator, DICTATION_SILENT_TEXT } from '../components/DictationIndicator.js'
import type { DictationNotice } from '../dictation-controller.js'
import { useDictation } from './useDictation.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let press: () => void = () => undefined
let listener: ((event: DictationEvent) => void) | null = null
let sessionId = ''
const calls: string[] = []
const termInputs: Array<{ paneId: string; data: string }> = []
const notices: DictationNotice[] = []
const live = new Set(['p1', 'p2'])

function Probe(): React.JSX.Element {
  const dictation = useDictation({ paneExists: (paneId) => live.has(paneId), notify: (notice) => notices.push(notice) })
  press = dictation.press
  return createElement(DictationIndicator, { view: dictation.view, toggleLabel: '⌘⇧M' })
}

/** xterm 모양 — `[data-term-pane]` 상자 안의 textarea. 그 textarea 가 받은 키를 적는다. */
function terminal(paneId: string): { textarea: HTMLTextAreaElement; keys: string[] } {
  const box = document.createElement('div')
  box.setAttribute('data-term-pane', paneId)
  const textarea = document.createElement('textarea')
  box.append(textarea)
  document.body.append(box)
  const keys: string[] = []
  textarea.addEventListener('keydown', (event) => keys.push(event.key))
  return { textarea, keys }
}

const emit = (event: DictationEvent): void => act(() => listener?.(event))
const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
const indicator = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-dictation-indicator]')

beforeEach(() => {
  calls.length = 0
  termInputs.length = 0
  notices.length = 0
  listener = null
  Reflect.set(window, 'corral', {
    dictationStart: (input: { sessionId: string }): Promise<DictationStartResult> => {
      sessionId = input.sessionId
      calls.push('start')
      return Promise.resolve({ ok: true })
    },
    dictationStop: () => calls.push('stop'),
    dictationCancel: () => calls.push('cancel'),
    dictationOpenPrivacy: () => Promise.resolve(),
    // 가짜 main — 붙은 탭의 길(⌘V 와 같은 `clipboardTextPayloads`)을 흉내 낸다
    dictationInsert: (input: { sessionId: string; paneId: string; text: string }): Promise<DictationInsertResult> => {
      for (const data of clipboardTextPayloads(input.text)) termInputs.push({ paneId: input.paneId, data })
      return Promise.resolve({ ok: true, via: 'paste' })
    },
    onDictationEvent: (next: (event: DictationEvent) => void) => {
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
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('useDictation — 창 연결', () => {
  it('터미널 pane 에 포커스가 있을 때 토글 → 시작·표시 등장, 다른 pane 으로 포커스가 옮겨도 FINAL 은 처음 pane 에(Enter 없이), 다시 토글 → 정지, ended → 표시 사라짐', async () => {
    const first = terminal('p1')
    const second = terminal('p2')
    // fix1 G2 — 대상 xterm(p1)의 선택 풀기가 넣기 전에 불린다. p2 의 것은 불리지 않는다
    const cleared: string[] = []
    const offFirst = registerSelectionClearer({ paneId: 'p1', clear: () => cleared.push('p1') })
    const offSecond = registerSelectionClearer({ paneId: 'p2', clear: () => cleared.push('p2') })
    first.textarea.focus()
    act(() => press())
    expect(calls).toEqual(['start'])
    expect(indicator()?.dataset.dictationIndicator).toBe('starting')
    emit({ kind: 'ready', sessionId })
    expect(indicator()?.dataset.dictationIndicator).toBe('listening')
    expect(indicator()?.textContent).toContain('⌘⇧M 정지')
    emit({ kind: 'partial', sessionId, text: '워크트리' })
    expect(host.querySelector('[data-dictation-partial]')?.textContent).toBe('워크트리')
    second.textarea.focus()
    emit({ kind: 'final', sessionId, text: '워크트리 목록' })
    await flush()
    expect(termInputs).toEqual([{ paneId: 'p1', data: `${BRACKETED_PASTE_START}워크트리 목록${BRACKETED_PASTE_END}` }])
    expect(cleared).toEqual(['p1'])
    offFirst()
    offSecond()
    expect(host.querySelector('[data-dictation-partial]')).toBeNull()
    act(() => press())
    expect(calls).toEqual(['start', 'stop'])
    expect(indicator()?.dataset.dictationIndicator).toBe('stopping')
    emit({ kind: 'ended', sessionId, end: { kind: 'done' } })
    expect(indicator()).toBeNull()
  })
  it('포커스가 터미널이 아니면(입력칸) 시작하지 않고 알림, 표시 없음', () => {
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    act(() => press())
    expect(calls).toEqual([])
    expect(indicator()).toBeNull()
    expect(notices).toEqual([{ message: DICTATION_NOT_TERMINAL_MESSAGE, openPrivacy: false }])
  })
  it('받아쓰는 중 Esc → 취소, xterm 입력칸은 Esc 를 받지 않는다(pane 에 0바이트), 늦은 FINAL 은 버림', async () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    act(() => press())
    emit({ kind: 'ready', sessionId })
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      pane.textarea.dispatchEvent(esc)
    })
    expect(esc.defaultPrevented).toBe(true)
    expect(pane.keys).toEqual([])
    expect(calls).toEqual(['start', 'cancel'])
    expect(indicator()).toBeNull()
    emit({ kind: 'final', sessionId, text: '버릴 글' })
    await flush()
    expect(termInputs).toEqual([])
  })
  it('fix2 G6 — IME 조합 중 Esc 는 받아쓰기를 취소하지 않고 삼키지도 않는다(조합 취소로 간다)', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    act(() => press())
    emit({ kind: 'ready', sessionId })
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
    act(() => {
      pane.textarea.dispatchEvent(esc)
    })
    expect(esc.defaultPrevented).toBe(false)
    expect(pane.keys).toEqual(['Escape'])
    expect(calls).toEqual(['start'])
    expect(indicator()?.dataset.dictationIndicator).toBe('listening')
  })
  it('fix2 F6 — 대화상자가 열린 채 Esc: 받아쓰기 취소가 먼저(대화상자는 못 받는다), 다음 Esc 는 대화상자가 받는다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    act(() => press())
    emit({ kind: 'ready', sessionId })
    // 대화상자 — 문서에서 Esc 를 듣고 닫힌다(모달들의 흔한 모양). 포커스는 대화상자 입력칸
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const field = document.createElement('input')
    dialog.append(field)
    document.body.append(dialog)
    const closed: string[] = []
    const onDialogKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closed.push('dialog')
    }
    document.addEventListener('keydown', onDialogKey)
    field.focus()
    const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      field.dispatchEvent(first)
    })
    expect(calls).toEqual(['start', 'cancel'])
    expect(closed).toEqual([])
    expect(indicator()).toBeNull()
    const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      field.dispatchEvent(second)
    })
    expect(closed).toEqual(['dialog'])
    document.removeEventListener('keydown', onDialogKey)
  })
  it('받아쓰기가 아닐 때 Esc 는 그대로 pane 으로 간다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    pane.textarea.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(false)
    expect(pane.keys).toEqual(['Escape'])
  })
  it('무음이 이어지면 표시에 「마이크 입력이 없다」, 소리가 들어오면 사라진다', async () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    act(() => press())
    emit({ kind: 'ready', sessionId })
    emit({ kind: 'level', sessionId, rms: 0, stalled: false })
    // 실제 시계 — 무음 상한(3초)을 기다리지 않도록 시각만 앞당긴다
    const realNow = Date.now
    Date.now = () => realNow() + 10_000
    try {
      emit({ kind: 'level', sessionId, rms: 0, stalled: false })
    } finally {
      Date.now = realNow
    }
    expect(host.querySelector('[data-dictation-silent]')?.textContent).toBe(DICTATION_SILENT_TEXT)
    emit({ kind: 'level', sessionId, rms: 0.05, stalled: false })
    expect(host.querySelector('[data-dictation-silent]')).toBeNull()
  })
  it('권한 거부로 끝나면 표시가 사라지고 설정 열기 동작이 붙은 알림', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    act(() => press())
    emit({ kind: 'ended', sessionId, end: { kind: 'error', code: 'mic-denied', message: '' } })
    expect(indicator()).toBeNull()
    expect(notices[0]?.openPrivacy).toBe(true)
  })
  it('화면이 내려가면 진행 중 세션을 취소한다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    act(() => press())
    act(() => root.unmount())
    expect(calls).toEqual(['start', 'cancel'])
    root = createRoot(host)
  })
})

/**
 * fix4 F-1 — 창의 키 길: 누름은 단축키 길(문서 캡처, `useKeybindings` 처럼 삼킨다)이 `press` 로, 뗌·키 반복·창 포커스 잃음은 `useDictation` 의 창 캡처가 받는다.
 * keyup 이 어디서 오든(xterm 입력칸·대화상자 입력칸·IME 조합 중) 받는지 본다. 시계는 `Date.now` 를 앞당긴다.
 */
describe('useDictation — 홀드·탭 키 길', () => {
  let shortcut: ((event: KeyboardEvent) => void) | null = null
  let realNow: () => number = Date.now
  let clock = 0
  beforeEach(() => {
    realNow = Date.now
    clock = realNow()
    Date.now = () => clock
    // `useKeybindings` 모양 — 문서 캡처에서 ⌘⇧M 을 삼키고 반복은 버리고 첫 keydown 만 press
    shortcut = (event) => {
      if (!(event.metaKey && event.shiftKey && event.code === 'KeyM')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      press()
    }
    document.addEventListener('keydown', shortcut, true)
  })
  afterEach(() => {
    Date.now = realNow
    if (shortcut !== null) document.removeEventListener('keydown', shortcut, true)
  })
  const key = (target: EventTarget, type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    act(() => {
      target.dispatchEvent(event)
    })
    return event
  }
  const down = (target: EventTarget, repeat = false): KeyboardEvent => key(target, 'keydown', { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true, repeat })
  it('xterm 에서 누른 채(키 반복) 300 ms 넘게 → ⌘ keyup 에 정지, 단축키는 xterm 에 가지 않는다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    expect(calls).toEqual(['start'])
    emit({ kind: 'ready', sessionId })
    for (let elapsed = 0; elapsed < DICTATION_HOLD_THRESHOLD_MS + 100; elapsed += 50) {
      clock += 50
      down(pane.textarea, true)
    }
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
    expect(indicator()?.dataset.dictationIndicator).toBe('listening')
    clock += 3000
    down(pane.textarea)
    expect(calls).toEqual(['start', 'stop'])
  })
  it('홀드 중 대화상자 입력칸으로 포커스가 가도 그 자리의 keyup(그 처리기가 전파를 막아도)을 받는다', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    for (let elapsed = 0; elapsed < 500; elapsed += 50) {
      clock += 50
      down(pane.textarea, true)
    }
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
    for (let elapsed = 0; elapsed < 500; elapsed += 50) {
      clock += 50
      down(pane.textarea, true)
    }
    key(pane.textarea, 'keyup', { key: 'Shift', code: 'ShiftLeft', metaKey: true, isComposing: true })
    expect(calls).toEqual(['start', 'stop'])
  })
  it('홀드 중 창 포커스를 잃으면(keyup 을 못 받음) 뗌으로 본다 — 키 반복으로 잰 홀드면 정지', () => {
    const pane = terminal('p1')
    pane.textarea.focus()
    down(pane.textarea)
    emit({ kind: 'ready', sessionId })
    for (let elapsed = 0; elapsed < 500; elapsed += 50) {
      clock += 50
      down(pane.textarea, true)
    }
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
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
