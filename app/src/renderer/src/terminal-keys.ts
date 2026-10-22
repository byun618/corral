// LIFE-571 — Shift+Enter 를 Enter 와 구분해 pane 으로 보낸다.
//
// xterm.js 6.0.0 은 Shift·Ctrl+Enter 를 Enter 와 같은 `\r` 로 보낸다(Alt 만 `\x1b\r`). 그러면 herdr → Claude Code·codex 가
// 줄바꿈과 제출을 구분하지 못한다. 그래서 Shift+Enter 만 CSI-u `\x1b[13;2u` 로 바꿔 보낸다 — main 의 분류기
// (vt-input-classifier)가 그걸 Shift 붙은 Enter 키 이벤트로 읽고, herdr 가 pane 앱의 키보드 모드에 맞춰 다시 인코딩한다
// (kitty 모드 앱 → `\x1b[13;2u`). 셸 같은 레거시 앱이 `\r` 를 받는 것은 herdr 패치 `app/backend/herdr-shift-enter.patch` 덕이다 —
// 패치 없는 herdr 의 Ghostty 인코더는 레거시 pane 에 `ESC[27;2;13~` 를 보낸다(00-analysis §9).
// Alt·Ctrl+Enter 와 다른 수정자가 함께 눌린 Shift+Enter 는 건드리지 않는다(범위 밖 — 00-analysis §6).

import type { IDisposable, Terminal } from '@xterm/xterm'

/** Shift+Enter 의 CSI-u 시퀀스 (수정자 2 = Shift). */
export const SHIFT_ENTER_SEQUENCE = '\x1b[13;2u'

/** 판정에 쓰는 KeyboardEvent 필드만. */
export type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'keyCode' | 'isComposing' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'
>

/**
 * 이 키를 가로채 보낼 시퀀스. 가로채지 않으면 null — xterm 기본 처리에 맡긴다.
 * keydown 만 본다(keyup·keypress 는 null). IME 조합 중(`isComposing`·`keyCode 229`)이면 확정 Enter 일 수 있어 건너뛴다.
 */
export function terminalKeySequence(event: TerminalKeyEvent): string | null {
  if (event.type !== 'keydown') return null
  if (event.isComposing || event.keyCode === 229) return null
  if (event.key !== 'Enter') return null
  if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null
  return SHIFT_ENTER_SEQUENCE
}

/**
 * xterm `attachCustomKeyEventHandler` 에 거는 핸들러. 가로챈 키는 `send` 로 시퀀스를 보내고 기본 처리를 막는다 —
 * `false` 로 xterm 의 keydown 처리를, `preventDefault` 로 뒤따르는 keypress·textarea 줄바꿈 입력을 막아 `\r` 가 겹치지 않게 한다.
 */
export function terminalKeyHandler(send: (data: string) => void): (event: KeyboardEvent) => boolean {
  return (event) => {
    const sequence = terminalKeySequence(event)
    if (sequence === null) return true
    event.preventDefault()
    event.stopPropagation()
    send(sequence)
    return false
  }
}

/** 터미널에 Shift+Enter 가로채기를 건다. `term.input` 은 onData 로 나가 입력 경로(진단 링·termInput)를 그대로 탄다. */
export function attachTerminalKeys(input: { term: Terminal }): IDisposable {
  const { term } = input
  term.attachCustomKeyEventHandler(terminalKeyHandler((data) => term.input(data)))
  return { dispose: () => undefined }
}
