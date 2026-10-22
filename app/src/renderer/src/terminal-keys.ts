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

/**
 * 터미널에 Shift+Enter 가로채기를 건다. `term.input` 은 onData 로 나가 입력 경로(진단 링·termInput)를 그대로 탄다.
 *
 * LIFE-690 — 한글 조합 중 Shift+Enter 는 compositionend 와 keydown(Enter, keyCode 13, isComposing=false)이 **같은 태스크**로 온다.
 * xterm 은 조합 글자를 compositionend 의 `setTimeout(0)` 뒤에 보내고, 그 사이 keydown 이 오면 자기 keydown 처리에서 먼저 확정하지만
 * 가로챈 키는 그 처리까지 가지 않는다. 그래서 compositionend 와 같은 태스크에서 가로챈 시퀀스는 `setTimeout(0)` 으로 미룬다 —
 * 같은 지연의 타이머는 등록 순서대로 돌므로(HTML 타이머 순서) xterm 의 조합 글자 전송 뒤에 나간다. 그 밖의 경우는 지금처럼 바로 보낸다.
 * 이 순서는 xterm 의 글자 전송이 우리 `setTimeout(0)` 보다 늦지 않다는 데 기댄다 — 마이크로태스크로 앞당겨지면 그대로 맞고,
 * 0 보다 긴 지연·rAF 로 늦춰지거나 xterm 의 compositionend 리스너가 이 리스너보다 늦게 등록되면 깨진다.
 *
 * `term.open()` 뒤에 부른다 — textarea 가 있어야 조합 확정을 추적한다(없으면 가로채기만 걸리고 수정 전처럼 바로 보낸다).
 */
export function attachTerminalKeys(input: { term: Terminal }): IDisposable {
  const { term } = input
  const textarea = term.textarea
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (run: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, 0)
    timers.add(timer)
  }
  /** compositionend 가 이 태스크에서 지나갔다 — xterm 의 조합 글자 전송이 아직 대기 중이다. */
  let commitPending = false
  const onCompositionEnd = (): void => {
    commitPending = true
    later(() => {
      commitPending = false
    })
  }
  textarea?.addEventListener('compositionend', onCompositionEnd)
  term.attachCustomKeyEventHandler(
    terminalKeyHandler((data) => {
      if (commitPending) later(() => term.input(data))
      else term.input(data)
    }),
  )
  return {
    dispose: () => {
      textarea?.removeEventListener('compositionend', onCompositionEnd)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}
