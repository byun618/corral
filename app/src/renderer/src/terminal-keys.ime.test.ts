// @vitest-environment happy-dom
// LIFE-690 — 한글 조합 확정과 Shift+Enter 의 순서. 실제 xterm `Terminal` 에 `attachTerminalKeys` 를 걸고 textarea 에 composition·keydown 을 합성한다.
// G4: macOS 한글 IME 는 조합 중 Enter 에서 compositionend 와 keydown(Enter, keyCode 13, isComposing=false)을 xterm 의 `setTimeout(0)`
// (조합 글자 전송)보다 먼저 보낸다 — 그래서 아래 `pressEnterWhileComposing` 은 둘을 **한 동기 실행 안에서** 일으킨다. 사이에 이벤트 루프를 돌리면 결함이 안 보인다.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachTerminalKeys } from './terminal-keys.js'

type Harness = { term: Terminal; textarea: HTMLTextAreaElement; data: string[]; detach: () => void }

let harness: Harness | null = null

function open(): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  term.open(container)
  const textarea = term.textarea
  if (textarea === undefined) throw new Error('xterm textarea 없음')
  const data: string[] = []
  term.onData((chunk) => data.push(chunk))
  const keys = attachTerminalKeys({ term })
  return {
    term,
    textarea,
    data,
    detach: () => {
      keys.dispose()
      term.dispose()
      container.remove()
    },
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
/** xterm 의 조합 전송·compositionupdate 의 `setTimeout(0)` 과 우리 지연 전송이 모두 돌 만큼. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await tick()
}

function keydown(input: { textarea: HTMLTextAreaElement; key: string; keyCode: number; shiftKey?: boolean; isComposing?: boolean }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: input.key,
    code: input.key === 'Enter' ? 'Enter' : '',
    shiftKey: input.shiftKey ?? false,
    isComposing: input.isComposing ?? false,
    bubbles: true,
    cancelable: true,
  })
  // happy-dom·Chromium 모두 생성자 init 의 keyCode 를 반영하지 않는다 — 실제 키 이벤트처럼 값을 박는다.
  Object.defineProperty(event, 'keyCode', { value: input.keyCode })
  input.textarea.dispatchEvent(event)
  return event
}

/** 조합을 시작해 `text` 까지 진행한다(IME 가 textarea 에 조합 글자를 넣는 것까지). 확정하지 않는다. */
function compose(input: { textarea: HTMLTextAreaElement; text: string }): void {
  const { textarea, text } = input
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
  textarea.value += text
  textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }))
  textarea.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertCompositionText', isComposing: true, bubbles: true }))
}

/** 조합 중 (Shift+)Enter — keydown(229) → compositionend → keydown(13, isComposing=false) 를 한 동기 실행 안에서(G4). */
function pressEnterWhileComposing(input: { textarea: HTMLTextAreaElement; text: string; shiftKey: boolean }): void {
  const { textarea, text, shiftKey } = input
  keydown({ textarea, key: 'Process', keyCode: 229, shiftKey, isComposing: true })
  textarea.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }))
  keydown({ textarea, key: 'Enter', keyCode: 13, shiftKey })
}

beforeEach(() => {
  harness = open()
})

afterEach(() => {
  harness?.detach()
  harness = null
})

describe('조합 확정 글자가 Shift+Enter 시퀀스보다 먼저 (C1ⓐ·C2ⓐ)', () => {
  it('사용자 재현 — `ㅁㄴ어미나언마ㅣ` 뒤 조합 `ㅇ` 에서 Shift+Enter: ㅇ → \\x1b[13;2u, \\r 0', async () => {
    const { textarea, data } = harness!
    compose({ textarea, text: 'ㅁㄴ어미나언마ㅣ' })
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'ㅁㄴ어미나언마ㅣ', bubbles: true }))
    await settle()
    compose({ textarea, text: 'ㅇ' })
    await settle()
    pressEnterWhileComposing({ textarea, text: 'ㅇ', shiftKey: true })
    await settle()
    expect(data).toEqual(['ㅁㄴ어미나언마ㅣ', 'ㅇ', '\x1b[13;2u'])
  })

  it('완성 음절 `한` 조합에서 Shift+Enter: 한 → \\x1b[13;2u', async () => {
    const { textarea, data } = harness!
    compose({ textarea, text: '한' })
    await settle()
    pressEnterWhileComposing({ textarea, text: '한', shiftKey: true })
    await settle()
    expect(data).toEqual(['한', '\x1b[13;2u'])
  })
})

describe('G4 대조 — 이벤트 루프를 한 번 돌린 순서(LIFE-571 C4ⓑ 의 순서)', () => {
  it('compositionend 뒤 틱을 넘기고 Shift+Enter: 한 → \\x1b[13;2u (수정 전에도 통과 — 이 순서로는 결함이 안 보인다)', async () => {
    const { textarea, data } = harness!
    compose({ textarea, text: '한' })
    await settle()
    keydown({ textarea, key: 'Process', keyCode: 229, shiftKey: true, isComposing: true })
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    await tick()
    keydown({ textarea, key: 'Enter', keyCode: 13, shiftKey: true })
    await settle()
    expect(data).toEqual(['한', '\x1b[13;2u'])
  })
})

describe('회귀 없음 (C3)', () => {
  it('ⓐ 비조합 Shift+Enter → \\x1b[13;2u 1회를 그 자리에서(동기), \\r 0', async () => {
    const { textarea, data } = harness!
    keydown({ textarea, key: 'Enter', keyCode: 13, shiftKey: true })
    expect(data).toEqual(['\x1b[13;2u'])
    await settle()
    expect(data).toEqual(['\x1b[13;2u'])
  })

  it('ⓐ 조합이 앞 틱에서 끝난 뒤의 Shift+Enter 도 동기 전송', async () => {
    const { textarea, data } = harness!
    compose({ textarea, text: '한' })
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    await settle()
    expect(data).toEqual(['한'])
    keydown({ textarea, key: 'Enter', keyCode: 13, shiftKey: true })
    expect(data).toEqual(['한', '\x1b[13;2u'])
  })

  it('ⓑ 조합 중 일반 Enter: ㅇ → \\r (xterm 기본 처리 그대로)', async () => {
    const { textarea, data } = harness!
    compose({ textarea, text: 'ㅇ' })
    await settle()
    pressEnterWhileComposing({ textarea, text: 'ㅇ', shiftKey: false })
    await settle()
    expect(data).toEqual(['ㅇ', '\r'])
  })

  it('ⓑ 비조합 일반 Enter → \\r', async () => {
    const { textarea, data } = harness!
    keydown({ textarea, key: 'Enter', keyCode: 13 })
    await settle()
    expect(data).toEqual(['\r'])
  })

  it('ⓔ 조합 중 Shift 쌍자음(ㅅ → Shift → ㅆ)은 줄바꿈 시퀀스를 내지 않는다', async () => {
    const { textarea, data } = harness!
    compose({ textarea, text: 'ㅅ' })
    await settle()
    for (const keyCode of [16, 229]) {
      keydown({ textarea, key: 'Shift', keyCode, shiftKey: true, isComposing: true })
    }
    keydown({ textarea, key: 'Process', keyCode: 229, shiftKey: true, isComposing: true })
    textarea.value = textarea.value.slice(0, -1) + 'ㅆ'
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅆ', bubbles: true }))
    await settle()
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'ㅆ', bubbles: true }))
    await settle()
    expect(data).toEqual(['ㅆ'])
  })
})
