// provider 키 표 (LIFE-582 Z5·Z6·Z9ⓔ) — 실측표(z1-measure.md ⓑⓒⓔ)를 그대로 옮겼는지 · 제어 문자 정리 · 초안 판별(z1 화면 모양을 본뜬 합성 fixture).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { activeQuestion, answerGroups, answerLock, answerSteps, cleanAnswerText, cleanBody, draftState, KEY, matchQuestion, questionKeys, screenPlain, stopAllowed, stopKey, stopNeedsEmptyInput } from './keys.js'

/** Z1 실측 화면(커밋된 원자료). */
const Z1 = path.resolve(__dirname, '../../../../specs/LIFE-582-mobile-input/raw/claude/z1')
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
  it('Grok 은 질문·권한 대기 모두 숨긴다 · 권한 대기는 Claude·Codex 만 · 로그인·기타는 숨긴다', () => {
    expect(stopAllowed({ kind: 'grok', waiting: 'question' })).toBe(false)
    expect(stopAllowed({ kind: 'claude', waiting: 'question' })).toBe(true)
    const kinds: MobileAgentKind[] = ['claude', 'codex']
    for (const kind of kinds) expect(stopAllowed({ kind, waiting: 'approval' })).toBe(true)
    // 최종 관문 Z5ⓔ s59 — Grok 권한 상자가 입력 줄을 덮어 초안 확인이 unknown → 멈추지 않는데 버튼만 남았다.
    expect(stopAllowed({ kind: 'grok', waiting: 'approval' })).toBe(false)
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

describe('R1-A9 SGR 확장 색의 2 는 흐림이 아니다', () => {
  it('truecolor·256색 초안은 draft — 진짜 흐림(2)만 자리표시로 본다', () => {
    const rgb = '\x1b[38;2;120;130;140m'
    expect(draftState({ kind: 'claude', screen: claudeScreen(`${rgb}draft rgb\x1b[0m`) })).toBe('draft')
    expect(draftState({ kind: 'claude', screen: claudeScreen('\x1b[38;5;2mdraft 256\x1b[0m') })).toBe('draft')
    expect(draftState({ kind: 'claude', screen: claudeScreen('\x1b[48;2;2;2;2mdraft bg\x1b[0m') })).toBe('draft')
    expect(draftState({ kind: 'codex', screen: codexScreen(`\x1b[1m› \x1b[0m${rgb}draft codex\x1b[0m`) })).toBe('draft')
    // 색 묶음 뒤의 2 는 흐림이다.
    expect(draftState({ kind: 'claude', screen: claudeScreen('\x1b[38;2;1;1;1;2mTry "x"\x1b[0m') })).toBe('empty')
  })
})

describe('R2-A1 활성 질문 영역 — Z1 실측 화면', () => {
  const z1 = (name: string): string => fs.readFileSync(path.join(Z1, name), 'utf8')
  /** perm-screens.txt 는 세 provider 의 권한 질문 화면을 `== w1:pN` 줄로 이어 붙인 것이다. */
  const permission = (pane: string): string => {
    const text = z1('perm-screens.txt')
    const start = text.indexOf(`== w1:${pane} `)
    const next = text.indexOf('== w1:', start + 1)
    return text.slice(text.indexOf('\n', start) + 1, next < 0 ? undefined : next)
  }
  it('Claude — 단일·문항 둘의 두 번째·여럿 고름·preview·검토 화면', () => {
    expect(activeQuestion({ kind: 'claude', screen: z1('a-q1-screen.txt') })).toMatchObject({ kind: 'question', title: 'Pick a color', options: ['Red', 'Green', 'Blue'], position: null, total: null })
    expect(activeQuestion({ kind: 'claude', screen: z1('a-q4-q2.txt') })).toMatchObject({ kind: 'question', title: 'Pick city', options: ['Seoul', 'Busan'] })
    expect(activeQuestion({ kind: 'claude', screen: z1('a-q2-screen.txt') })).toMatchObject({ kind: 'question', title: 'Pick fruits', options: ['Apple', 'Banana', 'Cherry'] })
    expect(activeQuestion({ kind: 'claude', screen: z1('a-q6-screen.txt') })).toMatchObject({ kind: 'question', title: 'Pick layout', options: ['A', 'B'] })
    expect(activeQuestion({ kind: 'claude', screen: z1('a-q4-review.txt') })).toEqual({ kind: 'review' })
  })
  it('Codex — 접힌 표시(문항 수) · 펼친 단일 · 둘 중 첫 번째(위치)', () => {
    expect(activeQuestion({ kind: 'codex', screen: z1('ca-q1-screen.txt') })).toEqual({ kind: 'collapsed', count: 1 })
    expect(activeQuestion({ kind: 'codex', screen: z1('ca-q1-open.txt') })).toMatchObject({ kind: 'question', title: 'Pick a color', options: ['Red', 'Green', 'Blue'], position: null, total: null })
    expect(activeQuestion({ kind: 'codex', screen: z1('ca-q3-open.txt') })).toMatchObject({ kind: 'question', title: 'Pick size', options: ['Small', 'Large'], position: 1, total: 2 })
  })
  it('Grok — 단일 · 둘 중 두 번째(위치) · 직접 입력 중', () => {
    expect(activeQuestion({ kind: 'grok', screen: z1('ga-q1-screen.txt') })).toMatchObject({ kind: 'question', title: 'Pick a color', options: ['Red', 'Green', 'Blue'], position: null, total: null })
    expect(activeQuestion({ kind: 'grok', screen: z1('ga-q3-after13.txt') })).toMatchObject({ kind: 'question', title: 'Pick city', options: ['Seoul', 'Busan'], position: 2, total: 2 })
    expect(activeQuestion({ kind: 'grok', screen: z1('ga-q2-typed.txt') })).toMatchObject({ kind: 'question', title: 'Pick a fruit', options: ['Apple', 'Pear'] })
  })
  it('세 provider 의 권한 질문 화면은 질문 상자가 아니다(none)', () => {
    expect(activeQuestion({ kind: 'claude', screen: permission('p7') })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'codex', screen: permission('p8') })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'grok', screen: permission('p9') })).toEqual({ kind: 'none' })
  })
  it('화면 위 과거 글의 질문은 보지 않는다 — 맨 아래 상자만', () => {
    const history = ['❯ Pick a color', '1. Red', '2. Green', '3. Blue'].join('\n')
    expect(activeQuestion({ kind: 'claude', screen: `${history}\n${permission('p7')}` })).toEqual({ kind: 'none' })
  })
  it('matchQuestion — 글 전체·선택지 전부·위치가 같아야 한다(앞부분 포함은 세지 않는다)', () => {
    const active = activeQuestion({ kind: 'codex', screen: z1('ca-q3-open.txt') })
    const size = { question: 'Pick size', options: ['Small', 'Large'], multiSelect: false, preview: false }
    expect(matchQuestion({ kind: 'codex', active, question: size, index: 0, total: 2 })).toEqual({ kind: 'same', checked: [] })
    expect(matchQuestion({ kind: 'codex', active, question: size, index: 1, total: 2 })).toEqual({ kind: 'other' })
    expect(matchQuestion({ kind: 'codex', active, question: { ...size, question: 'Pick size now' }, index: 0, total: 2 })).toEqual({ kind: 'other' })
    expect(matchQuestion({ kind: 'codex', active, question: { ...size, options: ['Small', 'Large', 'Huge'] }, index: 0, total: 2 })).toEqual({ kind: 'other' })
    expect(matchQuestion({ kind: 'codex', active, question: { ...size, question: 'Pick' }, index: 0, total: 2 })).toEqual({ kind: 'other' })
  })
  it('answerGroups — 묶음마다 화면 확인 지점(Codex 열기 · 문항 · 검토)', () => {
    const one = { options: 2, multiSelect: false, preview: false }
    expect(answerGroups({ kind: 'codex', questions: [one, one], answers: [{ choices: [0], other: null }, { choices: [], other: 'x' }] })).toEqual({ ok: true, groups: [
      { check: { kind: 'open' }, keys: [KEY.shiftLeft] },
      { check: { kind: 'question', index: 0 }, keys: ['1'] },
      { check: { kind: 'question', index: 1 }, keys: ['3', 'x', KEY.enter] },
    ] })
    expect(answerGroups({ kind: 'claude', questions: [one, one], answers: [{ choices: [0], other: null }, { choices: [1], other: null }] })).toMatchObject({ ok: true, groups: [{ keys: ['1'] }, { keys: ['2'] }, { check: { kind: 'review' }, keys: ['1'] }] })
  })
})

describe('LIFE-582 r3 — 활성 영역 아래 경계 · 선택 상태 · Codex 남은 위치 (Z1 실측 화면 합성)', () => {
  const z1 = (name: string): string => fs.readFileSync(path.join(Z1, name), 'utf8')
  const permission = (pane: string): string => {
    const text = z1('perm-screens.txt')
    const start = text.indexOf(`== w1:${pane} `)
    const next = text.indexOf('== w1:', start + 1)
    return text.slice(text.indexOf('\n', start) + 1, next < 0 ? undefined : next)
  }
  const pick = { question: 'Pick a color', options: ['Red', 'Green', 'Blue'], multiSelect: false, preview: false }
  /** 기록의 설명 — Z1 화면이 보이는 그대로(Claude `Pick <글>` · Grok 글과 같은 설명 · Codex 는 설명을 그리지 않는다). R4-A2 부터 설명 줄도 대조한다. */
  const described = <T extends { options: string[] }>(question: T, kind: 'claude' | 'grok'): T & { descriptions: string[] } => ({
    ...question,
    descriptions: question.options.map((label) => (kind === 'claude' ? `Pick ${label}` : label)),
  })

  it('R3-A2 — 끝난 질문 상자 아래 지금 권한 질문이 있으면 세 provider 모두 none', () => {
    expect(activeQuestion({ kind: 'claude', screen: `${z1('a-q1-screen.txt')}\n${permission('p7')}` })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'codex', screen: `${z1('ca-q1-open.txt')}\n${permission('p8')}` })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'grok', screen: `${z1('ga-q1-screen.txt')}\n${permission('p9')}` })).toEqual({ kind: 'none' })
    // 검토 화면도 같은 규칙 — Submit 행이 있어도 그 아래 다른 대화상자가 있으면 아니다.
    expect(activeQuestion({ kind: 'claude', screen: `${z1('a-q4-review.txt')}\n${permission('p7')}` })).toEqual({ kind: 'none' })
    // 양성 대조 — 같은 상자 홀로는 question/review 다.
    expect(activeQuestion({ kind: 'claude', screen: z1('a-q1-screen.txt') }).kind).toBe('question')
    expect(activeQuestion({ kind: 'codex', screen: z1('ca-q1-open.txt') }).kind).toBe('question')
    expect(activeQuestion({ kind: 'grok', screen: z1('ga-q1-screen.txt') }).kind).toBe('question')
    expect(activeQuestion({ kind: 'claude', screen: z1('a-q4-review.txt') })).toEqual({ kind: 'review' })
  })
  it('R3-A2 — 상자 아래 모르는 줄이 있으면 none', () => {
    expect(activeQuestion({ kind: 'claude', screen: `${z1('a-q1-screen.txt')}\nsomething else` })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'codex', screen: `${z1('ca-q1-open.txt')}\nsomething else` })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'grok', screen: `${z1('ga-q1-screen.txt')}\nsomething else` })).toEqual({ kind: 'none' })
  })
  it('D2 — Codex 접힌 표시는 맨 아래 입력창 바로 위일 때만(아래 권한 질문·다른 상자면 none)', () => {
    expect(activeQuestion({ kind: 'codex', screen: z1('ca-q1-screen.txt') })).toEqual({ kind: 'collapsed', count: 1 })
    expect(activeQuestion({ kind: 'codex', screen: `${z1('ca-q1-screen.txt')}\n${permission('p8')}` })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'codex', screen: `${z1('ca-q1-screen.txt')}\n${z1('ca-q1-open.txt')}\n${permission('p8')}` })).toEqual({ kind: 'none' })
    // 맥 초안이 입력창에 있어도 접힌 표시는 그대로다(실측 native-codex collapsed-draft).
    const draft = z1('ca-q1-screen.txt').replace('Ask Codex to do anything', 'r3draft')
    expect(draft).not.toBe(z1('ca-q1-screen.txt'))
    expect(activeQuestion({ kind: 'codex', screen: draft })).toEqual({ kind: 'collapsed', count: 1 })
  })
  it('R3-A1 — 갓 열린 빈 상태만 same(세 provider 양성 대조)', () => {
    expect(matchQuestion({ kind: 'claude', active: activeQuestion({ kind: 'claude', screen: z1('a-q1-screen.txt') }), question: described(pick, 'claude'), index: 0, total: 1 })).toEqual({ kind: 'same', checked: [] })
    expect(matchQuestion({ kind: 'codex', active: activeQuestion({ kind: 'codex', screen: z1('ca-q1-open.txt') }), question: pick, index: 0, total: 1 })).toEqual({ kind: 'same', checked: [] })
    expect(matchQuestion({ kind: 'grok', active: activeQuestion({ kind: 'grok', screen: z1('ga-q1-screen.txt') }), question: described(pick, 'grok'), index: 0, total: 1 })).toEqual({ kind: 'same', checked: [] })
    const fruits = { question: 'Pick fruits', options: ['Apple', 'Banana', 'Cherry'], multiSelect: true, preview: false }
    expect(matchQuestion({ kind: 'claude', active: activeQuestion({ kind: 'claude', screen: z1('a-q2-screen.txt') }), question: described(fruits, 'claude'), index: 0, total: 1 })).toEqual({ kind: 'same', checked: [] })
  })
  it('R3-A1 — Claude multiSelect 의 이미 체크된 칸을 읽는다(Z1 a-q2-after13 = 1·3 체크)', () => {
    // a-q2-after13 은 상자 아래쪽만 잡은 캡처라 위 가로줄이 없다 — 같은 너비의 가로줄만 앞에 붙인다(나머지 줄은 실물 그대로).
    const active = activeQuestion({ kind: 'claude', screen: `${'─'.repeat(119)}\n${z1('a-q2-after13.txt')}` })
    expect(active).toMatchObject({ kind: 'question', tabs: [true] })
    const fruits = { question: 'Pick fruits', options: ['Apple', 'Banana', 'Cherry'], multiSelect: true, preview: false }
    expect(matchQuestion({ kind: 'claude', active, question: described(fruits, 'claude'), index: 0, total: 1 })).toEqual({ kind: 'same', checked: [0, 2] })
  })
  it('R3-A1 — 맥에서 고르는 중(직접 입력 글 · 커서 이동 · Grok 선택)은 busy', () => {
    // a-other-typed 는 아래쪽만 잡은 캡처 — 그 실물 행(`❯ 4. 보라 violet`)을 a-q1 화면의 직접 입력 행 자리에 넣는다.
    const typedRow = z1('a-other-typed.txt').split('\n').find((line) => line.includes('4. '))!
    const typed = z1('a-q1-screen.txt').replace('❯ 1. Red', '  1. Red').replace(/^.*4\. Type something\..*$/m, typedRow)
    expect(typed).toContain('보라 violet')
    expect(matchQuestion({ kind: 'claude', active: activeQuestion({ kind: 'claude', screen: typed }), question: described(pick, 'claude'), index: 0, total: 1 })).toEqual({ kind: 'busy' })
    const fruit = { question: 'Pick a fruit', options: ['Apple', 'Pear'], multiSelect: false, preview: false }
    expect(matchQuestion({ kind: 'codex', active: activeQuestion({ kind: 'codex', screen: z1('ca-q2-typed.txt') }), question: fruit, index: 0, total: 1 })).toEqual({ kind: 'busy' })
    expect(matchQuestion({ kind: 'grok', active: activeQuestion({ kind: 'grok', screen: z1('ga-q2-typed.txt') }), question: described(fruit, 'grok'), index: 0, total: 1 })).toEqual({ kind: 'busy' })
    // Claude 커서를 2행으로 옮긴 화면.
    const moved = z1('a-q1-screen.txt').replace('❯ 1. Red', '  1. Red').replace('  2. Green', '❯ 2. Green')
    expect(moved).not.toBe(z1('a-q1-screen.txt'))
    expect(matchQuestion({ kind: 'claude', active: activeQuestion({ kind: 'claude', screen: moved }), question: described(pick, 'claude'), index: 0, total: 1 })).toEqual({ kind: 'busy' })
    // Claude 여러 문항 — 첫 문항 차례인데 머리 줄에 다른 문항이 이미 답함이면 busy.
    const pets = activeQuestion({ kind: 'claude', screen: z1('a-q4-q2.txt') })
    const city = { question: 'Pick city', options: ['Seoul', 'Busan'], multiSelect: false, preview: false }
    expect(matchQuestion({ kind: 'claude', active: pets, question: described(city, 'claude'), index: 1, total: 2 })).toEqual({ kind: 'same', checked: [] })
    if (pets.kind !== 'question') throw new Error('question')
    expect(matchQuestion({ kind: 'claude', active: { ...pets, tabs: [true, true] }, question: described(city, 'claude'), index: 1, total: 2 })).toEqual({ kind: 'busy' })
  })
  it('R3-A1 — 체크에서 폰 답으로 가는 키는 다른 칸만 뒤집는다', () => {
    const multi = { options: 3, multiSelect: true, preview: false }
    expect(questionKeys({ kind: 'claude', question: multi, answer: { choices: [0, 1], other: null }, checked: [0] })).toEqual(['2', KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter])
    expect(questionKeys({ kind: 'claude', question: multi, answer: { choices: [1], other: null }, checked: [0, 2] })).toEqual(['1', '2', '3', KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter])
    expect(questionKeys({ kind: 'claude', question: multi, answer: { choices: [0, 1], other: null }, checked: [] })).toEqual(['1', '2', KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter])
    // 하나 고름에 체크가 있으면 키를 만들지 않는다.
    expect(questionKeys({ kind: 'claude', question: { options: 3, multiSelect: false, preview: false }, answer: { choices: [0], other: null }, checked: [1] })).toEqual([''])
  })
  it('R3-A3 — Codex `k of n` 은 남은 문항 중 위치(3문항: 1 of 3 → 1 of 2 → 표시 없음)', () => {
    const screen = (counter: string | null, title: string): string =>
      ['• Queued follow-up inputs', '', ...(counter === null ? [] : [`  ${counter}`]), `  ${title}`, '', '  › 1. Tea', '    2. Coffee', '    3. Other', '', '  enter submit   ⌃] skip   ⇧→ main prompt'].join('\n')
    const q = (title: string) => ({ question: title, options: ['Tea', 'Coffee'], multiSelect: false, preview: false })
    const at = (counter: string | null, title: string, index: number) => matchQuestion({ kind: 'codex', active: activeQuestion({ kind: 'codex', screen: screen(counter, title) }), question: q(title), index, total: 3 })
    expect(at('1 of 3', 'Pick color', 0)).toEqual({ kind: 'same', checked: [] })
    expect(at('1 of 2', 'Pick drink', 1)).toEqual({ kind: 'same', checked: [] })
    expect(at(null, 'Pick size', 2)).toEqual({ kind: 'same', checked: [] })
    // 위치 비교는 지운 게 아니다 — 남은 수가 다르면 다른 질문.
    expect(at('1 of 3', 'Pick drink', 1)).toEqual({ kind: 'other' })
    expect(at('2 of 3', 'Pick color', 0)).toEqual({ kind: 'other' })
    expect(at(null, 'Pick color', 0)).toEqual({ kind: 'other' })
  })
})

describe('LIFE-582 r4 — 좁은 pane 줄 바꿈 복원 · Codex 접힌 표시 하단 허용 목록 (격리 실물 화면 r4/width)', () => {
  const W = path.resolve(__dirname, '../../../../specs/LIFE-582-mobile-input/raw/claude/r4/width')
  const screen = (name: string): string => fs.readFileSync(path.join(W, name), 'utf8')
  /** 같은 실물 회차의 기록 문항(판독자가 읽은 그대로 저장한 것). */
  const recorded = (kind: 'claude' | 'grok') => {
    const parsed: unknown = JSON.parse(screen(`${kind}-question.json`))
    if (!Array.isArray(parsed)) throw new Error('fixture')
    const first: unknown = parsed[0]
    if (typeof first !== 'object' || first === null || !('question' in first) || !('options' in first) || typeof first.question !== 'string' || !Array.isArray(first.options)) throw new Error('fixture')
    const options: { label: string; description: string | null }[] = first.options.map((option: unknown) => {
      if (typeof option !== 'object' || option === null || !('label' in option) || typeof option.label !== 'string') throw new Error('fixture')
      return { label: option.label, description: 'description' in option && typeof option.description === 'string' ? option.description : null }
    })
    return { question: first.question, options: options.map((option) => option.label), descriptions: options.map((option) => option.description), multiSelect: false, preview: false }
  }
  const match = (kind: 'claude' | 'grok', name: string) => matchQuestion({ kind, active: activeQuestion({ kind, screen: screen(name) }), question: recorded(kind), index: 0, total: 1 })

  it('R4-A2 Claude — 150·100·80·60·40열 모두 그 문항(번호 없는 이어진 줄 · 40열 두 줄 안내 줄 복원)', () => {
    for (const cols of [150, 100, 80, 60, 40]) expect([cols, match('claude', `claude-${cols}.txt`)]).toEqual([cols, { kind: 'same', checked: [] }])
  })
  it('R4-A2 Grok (R5-A1) — 150열은 그 문항(선택지 글 다 보임 · 설명만 `…`), 100·80·60열은 둘째 선택지 글이 `…` 로 잘려 truncated, 40열은 행이 스크롤로 빠져 truncated', () => {
    expect(match('grok', 'grok-150.txt')).toEqual({ kind: 'same', checked: [] })
    for (const cols of [100, 80, 60, 40]) expect([cols, match('grok', `grok-${cols}.txt`)]).toEqual([cols, { kind: 'truncated' }])
  })
  it('R5-A1 리뷰 prefix-alias — 숨은 선택지 뒷부분만 다른 기록도 같은 질문으로 받지 않는다(80열 truncated · 150열 대조 other)', () => {
    const question = recorded('grok')
    const altered = { ...question, options: [question.options[0]!, question.options[1]!.replace('tomorrow morning', 'next month')] }
    expect(matchQuestion({ kind: 'grok', active: activeQuestion({ kind: 'grok', screen: screen('grok-80.txt') }), question: altered, index: 0, total: 1 })).toEqual({ kind: 'truncated' })
    expect(matchQuestion({ kind: 'grok', active: activeQuestion({ kind: 'grok', screen: screen('grok-150.txt') }), question: altered, index: 0, total: 1 })).toEqual({ kind: 'other' })
  })
  it('R5-A4 리뷰 footer-probe — 완성된 안내 줄 뒤의 빈 줄 없는 다른 영역은 이어 읽지 않는다(none) · 꺾인 안내 줄은 실측 조각만 잇는다', () => {
    const rule = '─'.repeat(60)
    const box = (footer: string[]): string => [rule, ' ☐ Header', '', 'question', '', '❯ 1. a', '  2. b', '  3. Type something.', rule, '  4. Chat about this', '', ...footer].join('\n')
    const full = 'Enter to select · ↑/↓ to navigate · Esc to cancel'
    const permission = ['Permission required', '❯ 1. Allow', '  2. Deny', 'Esc to cancel']
    expect(activeQuestion({ kind: 'claude', screen: box([full]) }).kind).toBe('question')
    expect(activeQuestion({ kind: 'claude', screen: box([full, ...permission]) })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'claude', screen: box([full, 'UNKNOWN']) })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'claude', screen: box([full, '', ...permission]) })).toEqual({ kind: 'none' })
    // 덜 끝난 안내 줄 뒤에 다른 영역이 붙어 끝이 `Esc to cancel` 이어도 실측 안내 문구가 아니면 none.
    expect(activeQuestion({ kind: 'claude', screen: box(['Enter to select · ↑/↓ to navigate · Esc', ...permission]) })).toEqual({ kind: 'none' })
    // 양성 — 실측 40열 꺾임(`…Esc` / `to cancel`) · 다른 실측 조각의 꺾임.
    expect(activeQuestion({ kind: 'claude', screen: box(['Enter to select · ↑/↓ to navigate · Esc', 'to cancel']) }).kind).toBe('question')
    expect(activeQuestion({ kind: 'claude', screen: box(['Enter to select · ↑/↓ to navigate · n to', 'add notes · Esc to cancel']) }).kind).toBe('question')
    expect(match('claude', 'claude-40.txt')).toEqual({ kind: 'same', checked: [] })
    // 꺾인 안내 줄을 다 이은 뒤에도 그 아래는 빈 줄만.
    expect(activeQuestion({ kind: 'claude', screen: box(['Enter to select · ↑/↓ to navigate · Esc', 'to cancel', 'UNKNOWN']) })).toEqual({ kind: 'none' })
  })
  it('R4-A2 음성 — 복원한 글이 기록과 다르면 other(줄 바꿈 복원이 다른 질문을 받아들이지 않는다)', () => {
    const kinds: ('claude' | 'grok')[] = ['claude', 'grok']
    for (const kind of kinds) {
      const question = recorded(kind)
      const changed = { ...question, options: [question.options[0]!.replace('integration checks', 'integration tests'), question.options[1]!] }
      expect(matchQuestion({ kind, active: activeQuestion({ kind, screen: screen(`${kind}-80.txt`) }), question: changed, index: 0, total: 1 })).toEqual({ kind: 'other' })
      const described = { ...question, descriptions: question.descriptions.map((text) => `${text ?? ''} extra`) }
      expect(matchQuestion({ kind, active: activeQuestion({ kind, screen: screen(`${kind}-80.txt`) }), question: described, index: 0, total: 1 }).kind).toBe('other')
    }
  })
  it('R4-A2 — 좁은 화면 아래 권한 질문이 붙으면 여전히 none(R3-A2 경계 유지)', () => {
    const z1 = (name: string): string => fs.readFileSync(path.join(Z1, name), 'utf8')
    const permission = (pane: string): string => {
      const text = z1('perm-screens.txt')
      const start = text.indexOf(`== w1:${pane} `)
      const next = text.indexOf('== w1:', start + 1)
      return text.slice(text.indexOf('\n', start) + 1, next < 0 ? undefined : next)
    }
    expect(activeQuestion({ kind: 'claude', screen: `${screen('claude-40.txt')}\n${permission('p7')}` })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'grok', screen: `${screen('grok-80.txt')}\n${permission('p9')}` })).toEqual({ kind: 'none' })
  })
  it('R4-A3 — 접힌 표시 아래는 실측 입력창·상태 줄 모양만(양성: 실측 · 감긴 초안 / 음성: 모르는 줄 · 번호 없는 모달)', () => {
    expect(activeQuestion({ kind: 'codex', screen: screen('codex-collapsed-empty-150.txt') })).toEqual({ kind: 'collapsed', count: 1 })
    // 감긴 맥 초안 — 실측 `codex-collapsed-long-80` 의 입력창 두 줄을 같은 회차 접힌 화면의 입력창 자리에 넣는다.
    // 화면 사본은 색 코드·`\r\n` 을 품는다 — 판독과 같은 평문(`screenPlain`)에서 줄을 옮긴다.
    const plain = (name: string): string => screenPlain(screen(name).replace(/\r\n/g, '\n'))
    const long = plain('codex-collapsed-long-80.txt').split('\n')
    const at = long.findIndex((line) => line.startsWith('› r4 long draft'))
    const wrapped = plain('codex-collapsed-empty-150.txt').replace(/^› Ask Codex to do anything.*$/m, `${long[at]}\n${long[at + 1]}`)
    expect(wrapped).toContain('physical line')
    expect(activeQuestion({ kind: 'codex', screen: wrapped })).toEqual({ kind: 'collapsed', count: 1 })
    // 리뷰 r4 collapsed-suffix · D2-unrecognized-bottom.
    const collapsed = '? 1 question\n⇧← to answer\n\n› \n\n'
    expect(activeQuestion({ kind: 'codex', screen: `${collapsed}gpt-6.1-sol · ~/w` })).toEqual({ kind: 'collapsed', count: 1 })
    expect(activeQuestion({ kind: 'codex', screen: `${collapsed}UNKNOWN ACTIVE DIALOG` })).toEqual({ kind: 'none' })
    // 입력창 바로 아래(빈 줄 없이) 들여쓰지 않은 모르는 줄 — 초안 이어짐 모양(두 칸 들여쓰기)이 아니다.
    expect(activeQuestion({ kind: 'codex', screen: '? 1 question\n⇧← to answer\n\n› \nUNKNOWN ACTIVE DIALOG\n\n  gpt-6.1-sol · ~/w' })).toEqual({ kind: 'none' })
    expect(activeQuestion({ kind: 'codex', screen: `${collapsed}Permission required\nAllow access?\n[Y] yes  [N] no` })).toEqual({ kind: 'none' })
    // 상태 줄 사이에 모르는 줄 하나.
    const status = plain('codex-collapsed-empty-150.txt').replace(/^(\s*\? for shortcuts.*)$/m, '  Allow access?\n$1')
    expect(activeQuestion({ kind: 'codex', screen: status })).toEqual({ kind: 'none' })
  })
})

describe('LIFE-582 최종 관문 — Grok 입력칸 다음 문장 제안(ghost) (격리 실물 화면 final/z2-grok-ghost)', () => {
  // 실측: 제안은 `ESC[3m` 기울임 + rgb(88,88,88), 상자 아래 줄에 `Tab/→:accept suggestion` 힌트. 사람이 친 글은 기울임이 아니다.
  const GHOST = (text: string): string => `\x1b[0m\x1b[3m\x1b[38;2;88;88;88m\x1b[48;2;20;20;20m${text}\x1b[0m`
  const TYPED = (text: string): string => `\x1b[0m\x1b[38;2;225;225;225m\x1b[48;2;20;20;20m${text}\x1b[0m`
  const HINT = '  Tab/→:accept suggestion  │  Shift+Tab:mode  │  Ctrl+.:shortcuts'
  // 실측 모양: 상자 끝 `╰` 와 힌트 줄 사이에 빈 줄 하나(gap 1). gap 0 도 같은 판정.
  const box = (input: { line: string; hint: boolean; gap?: number }): string =>
    ['  ╭──────────────────────────────╮', `  \x1b[38;2;80;80;88m│\x1b[0m \x1b[38;2;200;200;200m❯ \x1b[0m${input.line}          \x1b[38;2;80;80;88m│\x1b[0m`, '  ╰──────────── Grok 4.7 (high) ─╯', ...Array.from({ length: input.gap ?? 1 }, () => '                    '), input.hint ? HINT : '  Shift+Tab:mode  │  Ctrl+.:shortcuts'].join('\r\n')

  it('제안만 있으면 빈 입력', () => {
    expect(draftState({ kind: 'grok', screen: box({ line: GHOST('l582f-z2d-2-gm reply with OK only'), hint: true }) })).toBe('empty')
    expect(draftState({ kind: 'grok', screen: box({ line: GHOST('l582f-z2d-2-gm reply with OK only'), hint: true, gap: 0 }) })).toBe('empty')
  })
  it('힌트가 빈 줄 둘 이상 아래면 보지 않는다 — 제안도 초안(fail-closed, R7-A1 좁게)', () => {
    expect(draftState({ kind: 'grok', screen: box({ line: GHOST('l582f-z2d-2-gm reply with OK only'), hint: true, gap: 2 }) })).toBe('draft')
  })
  it('격리 실물 화면(z2-grok-ghost-gm·gu) 그대로 — 제안만 → 빈 입력', () => {
    for (const name of ['gm', 'gu']) {
      const shot = fs.readFileSync(path.resolve(__dirname, `../../../../specs/LIFE-582-mobile-input/raw/claude/final/runs/z2-grok-ghost-${name}.ndjson`), 'utf8')
      const parsed: unknown = JSON.parse(shot.trim().split('\n').at(-1) ?? '{}')
      const text = typeof parsed === 'object' && parsed !== null && 'screen' in parsed && typeof parsed.screen === 'string' ? parsed.screen : ''
      expect(text).toContain('accept suggestion')
      expect(draftState({ kind: 'grok', screen: text })).toBe('empty')
    }
  })
  it('R7-A1 리뷰어 실물 ANSI(raw/claude/final/ghost-fixtures) — 제안만은 빈 입력, 사람 글·수락·붙여넣기·여러 줄은 초안', () => {
    const dir = path.resolve(__dirname, '../../../../specs/LIFE-582-mobile-input/raw/claude/final/ghost-fixtures')
    const want: Record<string, string> = {
      'count-done': 'empty', 'arrow-ghost': 'empty',
      'ghost-partial': 'draft', 'tab-accepted': 'draft', 'arrow-accepted': 'draft', 'multiline-negative': 'draft',
      'paste-markdown': 'draft', 'paste-unicode': 'draft', 'paste-multiline': 'draft', 'paste-leading-newline': 'draft', 'paste-sgr': 'draft',
    }
    for (const [name, expected] of Object.entries(want)) {
      expect({ name, state: draftState({ kind: 'grok', screen: fs.readFileSync(path.join(dir, `${name}.ansi`), 'utf8') }) }).toEqual({ name, state: expected })
    }
  })
  it('사람이 친 글(기울임 아님)은 초안', () => {
    expect(draftState({ kind: 'grok', screen: box({ line: TYPED('draft grok'), hint: true }) })).toBe('draft')
    expect(draftState({ kind: 'grok', screen: box({ line: TYPED('draft grok'), hint: false }) })).toBe('draft')
  })
  it('사람 글 뒤에 제안이 붙어도 초안', () => {
    expect(draftState({ kind: 'grok', screen: box({ line: `${TYPED('l582')}${GHOST('f-z2d-2-gm reply with OK only')}`, hint: true }) })).toBe('draft')
  })
  it('힌트 줄이 없으면 기울임 글도 초안(fail-closed — 기존 판정)', () => {
    expect(draftState({ kind: 'grok', screen: box({ line: GHOST('l582f-z2d-2-gm reply with OK only'), hint: false }) })).toBe('draft')
  })
  it('힌트 줄만 있고 기울임 run 이 없으면 기존 판정', () => {
    expect(draftState({ kind: 'grok', screen: box({ line: '', hint: true }) })).toBe('empty')
    expect(draftState({ kind: 'grok', screen: box({ line: 'plain draft', hint: true }) })).toBe('draft')
  })
  it('다른 provider 는 기울임을 보지 않는다(무변경)', () => {
    expect(draftState({ kind: 'claude', screen: `${claudeScreen(GHOST('ghost'))}\r\n${HINT}` })).toBe('draft')
    expect(draftState({ kind: 'codex', screen: codexScreen(`\x1b[1m› \x1b[0m${GHOST('ghost')}`) })).toBe('draft')
  })
})
