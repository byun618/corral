// LIFE-834 — 도우미 출력 줄 해석·OS 판정·사용자 문구.
import { describe, expect, it } from 'vitest'
import { dictationErrorMessage, dictationOsSupported, dictationRepeatGuard, dictationTypedText, parseDictationPressKeys, parseHelperLine } from './dictation.js'

describe('parseHelperLine — 도우미 규약', () => {
  it.each([
    ['{"type":"ready"}', { type: 'ready' }],
    ['{"type":"done"}', { type: 'done' }],
    ['{"type":"partial","text":"워크"}', { type: 'partial', text: '워크' }],
    ['{"text":"워크트리 목록","type":"final"}', { type: 'final', text: '워크트리 목록' }],
    ['{"type":"level","rms":0}', { type: 'level', rms: 0, stalled: false }],
    // fix4 F-2 — 프레임 끊김 표지
    ['{"type":"level","rms":0,"stalled":true}', { type: 'level', rms: 0, stalled: true }],
    ['{"type":"error","code":"mic-denied","message":"거부"}', { type: 'error', code: 'mic-denied', message: '거부' }],
    ['{"type":"error","code":"x"}', { type: 'error', code: 'x', message: '' }],
  ])('%s', (line, expected) => {
    expect(parseHelperLine(line)).toEqual(expected)
  })
  it.each(['', 'not json', 'null', '"final"', '{"type":"final"}', '{"type":"final","text":3}', '{"type":"level","rms":"0"}', '{"type":"error"}', '{"type":"check"}', '{"type":"unknown"}'])(
    '모양이 다르면 null: %s',
    (line) => {
      expect(parseHelperLine(line)).toBeNull()
    },
  )
})

describe('dictationOsSupported — macOS 26(Darwin 25) 이상', () => {
  it.each([
    [{ platform: 'darwin', release: '25.4.0' }, true],
    [{ platform: 'darwin', release: '26.0.0' }, true],
    [{ platform: 'darwin', release: '24.6.0' }, false],
    [{ platform: 'darwin', release: '' }, false],
    [{ platform: 'linux', release: '25.0.0' }, false],
  ])('%o → %s', (input, expected) => {
    expect(dictationOsSupported(input)).toBe(expected)
  })
})

describe('dictationErrorMessage — 원인을 말한다', () => {
  it('모르는 코드도 코드·사유를 그대로 보인다', () => {
    expect(dictationErrorMessage({ code: 'weird', message: '이유' })).toBe('받아쓰기 오류 (weird): 이유')
  })
  it('권한 거부는 설정 위치를 말한다', () => {
    expect(dictationErrorMessage({ code: 'mic-denied', message: '' })).toContain('개인정보 보호 및 보안 › 마이크')
  })
})

describe('dictationTypedText — 날 바이트 길(pane.send_text)에서 Enter·키가 될 수 있는 것을 뺀다 (fix1 G1)', () => {
  it.each([
    ['워크트리 목록을 보여주고', '워크트리 목록을 보여주고'],
    ['한 줄\n두 줄', '한 줄 두 줄'],
    ['끝에 CR\r', '끝에 CR '],
    ['줄\r\n\r\n바꿈', '줄 바꿈'],
    ['탭\t사이', '탭 사이'],
    ['a\x1b[201~b', 'a[201~b'],
    ['\x03중단\x7f\x9b', '중단'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(dictationTypedText(input)).toBe(expected)
  })
})

describe('r5 C-R5-2 — dictationRepeatGuard: main 이 뗀 뒤 남은 글쇠 반복을 메뉴 가속키보다 먼저 막는다', () => {
  const held = { code: 'KeyM', meta: true, shift: true, control: false, alt: false }
  const keyDown = (input: { code?: string; isAutoRepeat: boolean; meta?: boolean; shift?: boolean }) => ({ code: input.code ?? 'KeyM', isAutoRepeat: input.isAutoRepeat, meta: input.meta ?? false, shift: input.shift ?? false, control: false, alt: false })
  it('⇧ 를 먼저 떼고 남은 ⌘M 반복 — 막는다(Window ▸ Minimize 로 가지 않게), 계속 막는다', () => {
    const first = dictationRepeatGuard({ held, keyDown: keyDown({ isAutoRepeat: true, meta: true }) })
    expect(first).toEqual({ held, swallow: true })
    expect(dictationRepeatGuard({ held: first.held, keyDown: keyDown({ isAutoRepeat: true, meta: true }) }).swallow).toBe(true)
  })
  it('⌘ 를 먼저 떼고 남은 ⇧M 반복 — 막는다', () => {
    expect(dictationRepeatGuard({ held, keyDown: keyDown({ isAutoRepeat: true, shift: true }) }).swallow).toBe(true)
  })
  it('누름 그대로(⌘⇧M)의 반복 — 홀드 중이라 막지 않는다(렌더러가 홀드 길이를 잰다)', () => {
    expect(dictationRepeatGuard({ held, keyDown: keyDown({ isAutoRepeat: true, meta: true, shift: true }) })).toEqual({ held, swallow: false })
  })
  it('받아쓰기가 아닐 때(알린 누름 없음) 평소 ⌘M — 첫 누름도 반복도 막지 않는다', () => {
    expect(dictationRepeatGuard({ held: null, keyDown: keyDown({ isAutoRepeat: false, meta: true }) })).toEqual({ held: null, swallow: false })
    expect(dictationRepeatGuard({ held: null, keyDown: keyDown({ isAutoRepeat: true, meta: true }) })).toEqual({ held: null, swallow: false })
  })
  it('그 글쇠의 새 누름(반복 아님)이 오면 풀린다 — 그 ⌘M 과 이어지는 반복은 평소대로', () => {
    const fresh = dictationRepeatGuard({ held, keyDown: keyDown({ isAutoRepeat: false, meta: true }) })
    expect(fresh).toEqual({ held: null, swallow: false })
    expect(dictationRepeatGuard({ held: fresh.held, keyDown: keyDown({ isAutoRepeat: true, meta: true }) }).swallow).toBe(false)
  })
  it('fix7 R6-2 — 수식 키를 더한 반복(⌥·⌃)은 막지 않는다, 하나 떼고 하나 더한 것도(부분 집합이 아님) 막지 않는다', () => {
    expect(dictationRepeatGuard({ held, keyDown: { ...keyDown({ isAutoRepeat: true, meta: true, shift: true }), alt: true } }).swallow).toBe(false)
    expect(dictationRepeatGuard({ held, keyDown: { ...keyDown({ isAutoRepeat: true, meta: true }), control: true } }).swallow).toBe(false)
  })
  it('다른 글쇠(Esc 등)의 누름·반복은 막지 않고 표지도 풀지 않는다', () => {
    expect(dictationRepeatGuard({ held, keyDown: keyDown({ code: 'Escape', isAutoRepeat: false, meta: true }) })).toEqual({ held, swallow: false })
    expect(dictationRepeatGuard({ held, keyDown: keyDown({ code: 'KeyA', isAutoRepeat: true, meta: true }) })).toEqual({ held, swallow: false })
  })
})

describe('parseDictationPressKeys — IPC 로 온 누름 키', () => {
  it('모양이 맞으면 그대로, 아니면 null', () => {
    expect(parseDictationPressKeys({ code: 'KeyM', meta: true, shift: true, control: false, alt: false, extra: 1 })).toEqual({ code: 'KeyM', meta: true, shift: true, control: false, alt: false })
    expect(parseDictationPressKeys({ code: '', meta: true, shift: true, control: false, alt: false })).toBeNull()
    expect(parseDictationPressKeys({ code: 'KeyM', meta: 'yes', shift: true, control: false, alt: false })).toBeNull()
    expect(parseDictationPressKeys(null)).toBeNull()
    expect(parseDictationPressKeys('KeyM')).toBeNull()
  })
})
