// provider 키 표 (LIFE-582 Z5·Z6·Z9ⓔ) — 실측표(z1-measure.md ⓑⓒⓔ)를 그대로 옮겼는지 · 제어 문자 정리 · 초안 판별(z1 화면 모양을 본뜬 합성 fixture).
import { describe, expect, it } from 'vitest'
import { answerLock, answerSteps, cleanAnswerText, cleanBody, draftState, KEY, stopAllowed, stopKey, stopNeedsEmptyInput } from './keys.js'
import type { MobileAgentKind } from './list.js'

const one = (options: number) => ({ options, multiSelect: false, preview: false })

describe('질문 답 키 순서 (Z1ⓑ)', () => {
  it('Claude 하나 = 숫자 하나(즉시 제출), 검토 화면 없음', () => {
    expect(answerSteps({ kind: 'claude', questions: [one(3)], answers: [{ choices: [1], other: null }] })).toEqual({ ok: true, steps: ['2'] })
  })
  it('Claude 직접 입력 = N+1 + 글 + Enter', () => {
    expect(answerSteps({ kind: 'claude', questions: [one(2)], answers: [{ choices: [], other: '다른 답' }] })).toEqual({ ok: true, steps: ['3', '다른 답', KEY.enter] })
  })
  it('Claude 여럿 = 숫자들 → ↓×(N+1) → Enter → 검토 1', () => {
    const plan = answerSteps({ kind: 'claude', questions: [{ options: 3, multiSelect: true, preview: false }], answers: [{ choices: [0, 2], other: null }] })
    expect(plan).toEqual({ ok: true, steps: ['1', '3', KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter, '1'] })
  })
  it('Claude 여럿 + 직접 입력 = 숫자들 + N+1 → ↓×N → 글 → Tab → Enter → 검토 1', () => {
    const plan = answerSteps({ kind: 'claude', questions: [{ options: 2, multiSelect: true, preview: false }], answers: [{ choices: [0], other: 'x' }] })
    expect(plan).toEqual({ ok: true, steps: ['1', '3', KEY.down, KEY.down, 'x', KEY.tab, KEY.enter, '1'] })
  })
  it('Claude 여러 문항 = 문항마다 숫자 → 검토 1', () => {
    const plan = answerSteps({ kind: 'claude', questions: [one(2), one(2)], answers: [{ choices: [0], other: null }, { choices: [1], other: null }] })
    expect(plan).toEqual({ ok: true, steps: ['1', '2', '1'] })
  })
  it('Claude preview = 숫자 + Enter, 직접 입력 잠금', () => {
    const preview = { options: 2, multiSelect: false, preview: true }
    expect(answerSteps({ kind: 'claude', questions: [preview], answers: [{ choices: [1], other: null }] })).toEqual({ ok: true, steps: ['2', KEY.enter] })
    expect(answerSteps({ kind: 'claude', questions: [preview], answers: [{ choices: [], other: 'x' }] })).toEqual({ ok: false, reason: 'other_locked' })
  })
  it('Codex = ⇧← 로 연 뒤 숫자 · 직접 입력 N+1 + 글 + Enter', () => {
    expect(answerSteps({ kind: 'codex', questions: [one(2)], answers: [{ choices: [0], other: null }] })).toEqual({ ok: true, steps: [KEY.shiftLeft, '1'] })
    expect(answerSteps({ kind: 'codex', questions: [one(2), one(3)], answers: [{ choices: [], other: 'o' }, { choices: [2], other: null }] }))
      .toEqual({ ok: true, steps: [KEY.shiftLeft, '3', 'o', KEY.enter, '3'] })
  })
  it('Grok = 숫자 · 직접 입력 z + 글 + Enter · multiSelect 잠금', () => {
    expect(answerSteps({ kind: 'grok', questions: [one(3)], answers: [{ choices: [2], other: null }] })).toEqual({ ok: true, steps: ['3'] })
    expect(answerSteps({ kind: 'grok', questions: [one(3)], answers: [{ choices: [], other: 'g' }] })).toEqual({ ok: true, steps: ['z', 'g', KEY.enter] })
    expect(answerLock({ kind: 'grok', questions: [{ options: 2, multiSelect: true, preview: false }] })).toBe('locked')
  })
  it('기록에 없는 선택지·N+2(Chat about this)는 만들지 않는다', () => {
    expect(answerSteps({ kind: 'claude', questions: [one(2)], answers: [{ choices: [2], other: null }] })).toEqual({ ok: false, reason: 'bad_answer' })
    expect(answerSteps({ kind: 'claude', questions: [one(2)], answers: [{ choices: [0, 1], other: null }] })).toEqual({ ok: false, reason: 'bad_answer' })
    expect(answerSteps({ kind: 'claude', questions: [one(2)], answers: [] })).toEqual({ ok: false, reason: 'bad_answer' })
  })
  it('선택지 + 1 이 한 자리를 넘거나 선택지가 없으면 잠금', () => {
    expect(answerLock({ kind: 'claude', questions: [one(9)] })).toBe('locked')
    expect(answerLock({ kind: 'claude', questions: [one(0)] })).toBe('locked')
    expect(answerLock({ kind: 'claude', questions: [one(8)] })).toBeNull()
  })
})

describe('중단 키 (Z1ⓒ)', () => {
  it('Claude·Codex Esc · Grok Ctrl+C', () => {
    expect(stopKey('claude')).toBe('\x1b')
    expect(stopKey('codex')).toBe('\x1b')
    expect(stopKey('grok')).toBe('\x03')
  })
  it('질문 대기의 Grok 은 숨긴다 · 권한 대기는 셋 다 · 로그인·기타는 숨긴다', () => {
    expect(stopAllowed({ kind: 'grok', waiting: 'question' })).toBe(false)
    expect(stopAllowed({ kind: 'claude', waiting: 'question' })).toBe(true)
    const kinds: MobileAgentKind[] = ['claude', 'codex', 'grok']
    for (const kind of kinds) expect(stopAllowed({ kind, waiting: 'approval' })).toBe(true)
    expect(stopAllowed({ kind: 'claude', waiting: 'login' })).toBe(false)
    expect(stopNeedsEmptyInput('grok')).toBe(true)
    expect(stopNeedsEmptyInput('claude')).toBe(false)
  })
})

describe('본문 제어 문자 (Z9ⓔ)', () => {
  it('ESC·Ctrl+C·DEL·C1 은 지우고 탭·줄바꿈·한글·이모지는 둔다', () => {
    expect(cleanBody('a\x1b[Bb\x03c\x7fd\u009be\tf\r\ng\rh 한글 🙂')).toBe('a[Bbcde\tf\ng\nh 한글 🙂')
  })
  it('직접 입력은 한 줄', () => {
    expect(cleanAnswerText('  a\nb\x1bc\t ')).toBe('a bc')
  })
})

const RULE = '─'.repeat(40)
const claudeScreen = (input: string): string => ['● 답', '', RULE, `❯\u00a0${input}`, RULE, '  ? for shortcuts'].join('\r\n')
const codexScreen = (input: string): string => ['• 답', '', input, '', '  gpt · ~/w'].join('\r\n')
const grokScreen = (input: string): string => ['╭────────╮', `│ ❯ ${input.padEnd(20)}│`, '╰────────╯'].join('\r\n')

describe('맥 입력창 초안 (Z1ⓔ — 화면 모양 합성)', () => {
  it('Claude — 상자 안 ❯ 뒤가 비면 empty, 글이 있으면 draft, 상자가 없으면 unknown', () => {
    expect(draftState({ kind: 'claude', screen: claudeScreen('') })).toBe('empty')
    expect(draftState({ kind: 'claude', screen: claudeScreen('draft zeta') })).toBe('draft')
    // 새 세션 첫 화면 — 흐린 자리표시(격리 빠른 확인 q06 에서 실측한 모양)는 빈 입력이다.
    expect(draftState({ kind: 'claude', screen: claudeScreen('\x1b[0m\x1b[2mTry "fix typecheck errors"\x1b[0m') })).toBe('empty')
    expect(draftState({ kind: 'claude', screen: '● 답\r\n❯ ' })).toBe('unknown')
  })
  it('Codex — 자리표시(흐림)는 empty, 진한 글은 draft, 줄이 없으면 unknown', () => {
    expect(draftState({ kind: 'codex', screen: codexScreen('\x1b[1m› \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m') })).toBe('empty')
    expect(draftState({ kind: 'codex', screen: codexScreen('\x1b[1m› \x1b[0mdraft codex') })).toBe('draft')
    expect(draftState({ kind: 'codex', screen: '• 답' })).toBe('unknown')
  })
  it('Grok — │ ❯ │ 가 비면 empty, 글이 있으면 draft', () => {
    expect(draftState({ kind: 'grok', screen: grokScreen('') })).toBe('empty')
    expect(draftState({ kind: 'grok', screen: grokScreen('draft grok') })).toBe('draft')
    expect(draftState({ kind: 'grok', screen: 'nothing' })).toBe('unknown')
  })
})
