// provider 별 키 표 (LIFE-582 P4·P5·P8·P9) — 폰은 키를 보내지 않는다. 질문 답·중단의 바이트는 전부 여기서 서버가 만든다.
// 표의 근거는 실측 원자료 `specs/LIFE-582-mobile-input/raw/claude/z1-measure.md`(Claude 2.1.296 · Codex 0.162.1 · Grok 1.0.50).
// 순수 함수만 둔다 — 시험이 provider 없이 돈다.
import type { MobileAgentKind } from './list.js'

export const KEY = {
  esc: '\x1b',
  ctrlC: '\x03',
  enter: '\r',
  tab: '\t',
  down: '\x1b[B',
  /** Codex 의 비동기 질문 열기(⇧←). */
  shiftLeft: '\x1b[1;2D',
} as const

/** 중단 키 1회 — Claude·Codex `Esc`, Grok `Ctrl+C`(Grok 의 Esc 는 턴을 멈추지 않는다, Claude·Codex 의 Ctrl+C 는 한가에서 종료로 갈 수 있다). */
export function stopKey(kind: MobileAgentKind): string {
  switch (kind) {
    case 'claude':
    case 'codex':
      return KEY.esc
    case 'grok':
      return KEY.ctrlC
  }
}

/**
 * 그 provider 가 이 대기에서 중단을 받는가(P5ⓔ · Z1ⓒ). 질문 대기의 Grok Ctrl+C 는 질문만 거절하고 턴을 계속한다 — 숨긴다.
 * `other`(로그인 등)는 실측이 없어 받지 않는다.
 */
export function stopAllowed(input: { kind: MobileAgentKind; waiting: 'question' | 'approval' | 'login' | 'other' | null }): boolean {
  switch (input.waiting) {
    case null:
    case 'approval':
      return true
    case 'question':
      return input.kind !== 'grok'
    case 'login':
    case 'other':
      return false
  }
}

/** Grok 은 입력창에 글이 있으면 Ctrl+C 가 그 글만 지우고 턴을 계속한다(Z1ⓒ) — 중단 전에 입력창이 비었는지 본다. */
export const stopNeedsEmptyInput = (kind: MobileAgentKind): boolean => kind === 'grok'

// --- 본문 정리 ------------------------------------------------------------------------------------

/** 지시 본문 상한(UTF-8 바이트) — `terminal prompt` 의 `MAX_INPUT` 과 같다(P7). */
export const MAX_INPUT_BYTES = 65536
/** 질문 직접 입력 상한(글자). */
export const MAX_ANSWER_TEXT = 2000

/**
 * 지시 본문 정리(P8 Z9ⓔ) — 본문은 herdr 가 붙여 넣기(bracketed paste)로 넣는다. 본문 안 제어 문자가 키로 작동하지 않게
 * **탭·줄바꿈 말고는 지운다**: C0(ESC `\x1b`·`\x03` 등)·DEL·C1(0x80–0x9f). `\r\n`·`\r` 은 `\n` 으로. 나머지 글자(한글·이모지·앞뒤 공백)는 그대로 —
 * 앞뒤 공백은 기록 대조가 쓰는 `normalizeBody` 가 잘라서 비교한다.
 */
export function cleanBody(text: string): string {
  return dropControls({ text: text.replace(/\r\n?/g, '\n'), keep: KEEP_IN_BODY })
}

const KEEP_IN_BODY: ReadonlySet<number> = new Set([0x09, 0x0a])

/** C0(0x00–0x1f)·DEL·C1(0x7f–0x9f) 중 `keep` 밖을 지운다. */
function dropControls(input: { text: string; keep: ReadonlySet<number> }): string {
  let out = ''
  for (const char of input.text) {
    const code = char.codePointAt(0) ?? 0
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    if (!control || input.keep.has(code)) out += char
  }
  return out
}

/** 질문 직접 입력 정리 — 한 줄 글이어야 한다(Enter 가 제출이다). 줄바꿈·탭은 공백, 제어 문자는 지우고 앞뒤 공백을 자른다. */
export function cleanAnswerText(text: string): string {
  return dropControls({ text: text.replace(/[\r\n\t]+/g, ' '), keep: new Set() }).trim()
}

// --- 질문 답 ----------------------------------------------------------------------------------------

/** 키를 만들 때 보는 문항 모양 — 기록의 `AskUserQuestion`·`request_user_input`·`ask_user_question` 입력에서 온다. */
export type AnswerQuestion = { options: number; multiSelect: boolean | null; preview: boolean }
/** 문항 하나의 답 — 고른 선택지 번호(0부터) · 직접 입력 글. */
export type QuestionAnswer = { choices: number[]; other: string | null }

export type AnswerPlan =
  | { ok: true; steps: string[] }
  | { ok: false; reason: 'locked' | 'other_locked' | 'bad_answer' }

/** 숫자 키 하나 — 1~9 만. 기록의 선택지 수로만 만든다(N+2 는 Claude 의 「Chat about this」 라 질문이 거절된다 — Z1ⓑ). */
const digit = (n: number): string | null => (Number.isInteger(n) && n >= 1 && n <= 9 ? String(n) : null)

/** 이 질문을 폰에서 답할 수 있나(P4ⓒ) — 아니면 카드의 선택지를 잠근다. */
export function answerLock(input: { kind: MobileAgentKind; questions: AnswerQuestion[] }): 'locked' | null {
  if (input.questions.length === 0) return 'locked'
  for (const question of input.questions) {
    // 선택지 번호(최대 +1 직접 입력)가 한 자리 숫자를 넘으면 키로 고를 수 없다.
    if (question.options < 1 || question.options + 1 > 9) return 'locked'
    // Grok multiSelect — 숫자가 토글하며 다음 문항으로 넘어간다(불안정, Z1ⓑ). Codex 는 multiSelect 칸이 없다.
    if (question.multiSelect === true && input.kind !== 'claude') return 'locked'
  }
  return null
}

/** 직접 입력을 받는가(R2) — Claude 는 preview 레이아웃이면 「Type something」 이 없다. Codex `Other` · Grok `z` 는 실측으로 있다. */
export const otherAllowed = (input: { kind: MobileAgentKind; question: AnswerQuestion }): boolean =>
  !(input.kind === 'claude' && input.question.preview)

function validAnswer(input: { question: AnswerQuestion; answer: QuestionAnswer }): boolean {
  const { question, answer } = input
  const choices = answer.choices
  if (choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= question.options)) return false
  if (new Set(choices).size !== choices.length) return false
  if (answer.other !== null && answer.other.length === 0) return false
  if (question.multiSelect === true) return choices.length + (answer.other === null ? 0 : 1) >= 1
  return (choices.length === 1 && answer.other === null) || (choices.length === 0 && answer.other !== null)
}

/**
 * 질문 답 키 순서(P4ⓐ — Z1ⓑ 실측표 그대로). 단계마다 따로 넣는다(사이 간격은 넣는 쪽 몫). 문항 순서대로 답이 하나씩 있어야 한다.
 * - Claude: 하나 = 숫자(즉시 제출) · preview = 숫자 + Enter · 직접 입력 = `N+1` + 글 + Enter · 여럿 = 숫자들 → ↓×(N+1)(Next/Submit 행) → Enter,
 *   여럿 + 직접 입력 = 숫자들 + `N+1` 토글 → ↓×N(그 행) → 글 → Tab(Next 행) → Enter. 문항이 둘 이상이거나 여럿이면 끝에 검토 화면 `1`.
 * - Codex: ⇧← 로 열고 문항마다 숫자(즉시) 또는 `N+1` + 글 + Enter.
 * - Grok: 문항마다 숫자 또는 `z` + 글 + Enter.
 */
export function answerSteps(input: { kind: MobileAgentKind; questions: AnswerQuestion[]; answers: QuestionAnswer[] }): AnswerPlan {
  const { kind, questions, answers } = input
  if (answerLock({ kind, questions }) !== null) return { ok: false, reason: 'locked' }
  if (answers.length !== questions.length) return { ok: false, reason: 'bad_answer' }
  const steps: string[] = []
  if (kind === 'codex') steps.push(KEY.shiftLeft)
  let review = false
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!
    const answer = answers[index]!
    if (!validAnswer({ question, answer })) return { ok: false, reason: 'bad_answer' }
    if (answer.other !== null && !otherAllowed({ kind, question })) return { ok: false, reason: 'other_locked' }
    const keyOf = (n: number): string => digit(n) ?? ''
    const otherKey = kind === 'grok' ? 'z' : keyOf(question.options + 1)
    if (question.multiSelect === true) {
      // Claude 만 온다(answerLock).
      review = true
      for (const choice of answer.choices) steps.push(keyOf(choice + 1))
      if (answer.other !== null) {
        steps.push(otherKey)
        for (let row = 0; row < question.options; row += 1) steps.push(KEY.down)
        steps.push(answer.other, KEY.tab, KEY.enter)
      } else {
        for (let row = 0; row <= question.options; row += 1) steps.push(KEY.down)
        steps.push(KEY.enter)
      }
      continue
    }
    if (answer.other !== null) {
      steps.push(otherKey, answer.other, KEY.enter)
      continue
    }
    steps.push(keyOf(answer.choices[0]! + 1))
    if (kind === 'claude' && question.preview) steps.push(KEY.enter)
  }
  if (kind === 'claude' && (questions.length > 1 || review)) steps.push('1')
  if (steps.some((step) => step.length === 0)) return { ok: false, reason: 'locked' }
  return { ok: true, steps }
}

// --- 맥 입력창 초안 (P9) -----------------------------------------------------------------------------

export type DraftState = 'empty' | 'draft' | 'unknown'

type Run = { text: string; dim: boolean }

/** ANSI 한 줄 → 글자 덩어리(흐림 여부). SGR 의 `2`(흐림)·`22`·`0`/빈 값(해제)만 본다. 다른 제어 열은 버린다. */
function runsOf(line: string): Run[] {
  const runs: Run[] = []
  let dim = false
  let index = 0
  let text = ''
  const flush = (): void => {
    if (text.length > 0) runs.push({ text, dim })
    text = ''
  }
  while (index < line.length) {
    const char = line[index]!
    if (char === '\x1b') {
      // CSI(ESC `[` … 끝 글자) — 그 밖의 ESC 열은 ESC 만 버린다.
      const match = /^\[([0-9;?]*)([A-Za-z])/.exec(line.slice(index + 1))
      if (match === null) {
        index += 1
        continue
      }
      if (match[2] === 'm') {
        flush()
        const params = match[1] === '' ? ['0'] : match[1]!.split(';')
        for (const param of params) {
          if (param === '0' || param === '') dim = false
          else if (param === '2') dim = true
          else if (param === '22') dim = false
        }
      }
      index += match[0].length + 1
      continue
    }
    text += char
    index += 1
  }
  flush()
  return runs
}

const plainOf = (runs: Run[]): string => runs.map((run) => run.text).join('')
const RULE = /^\s*─{20,}\s*$/

/**
 * 보이는 화면(ANSI)에서 그 provider 의 입력 줄을 찾아 비었는지 본다(Z1ⓔ 표본 모양). **빈 입력이 확인될 때만 `empty`** —
 * 글이 있으면 `draft`, 입력 줄을 못 찾으면 `unknown`(넣지 않는다, fail-closed).
 * - Claude: 마지막 두 가로줄(─) 사이 상자, 첫 줄이 `❯`. `❯` 뒤와 상자 안 나머지 줄에 진한 글이 없어야 빈 입력(흐린 자리표시 `Try "…"` 는 빈 입력 — 새 세션 첫 화면).
 * - Codex: 마지막 `› ` 줄. 그 뒤 글이 전부 흐림(SGR 2 — 자리표시 `Ask Codex to do anything`)이면 빈 입력. 바로 아래 빈 줄 전까지 이어진 줄이 있으면 여러 줄 초안.
 * - Grok: 마지막 `│ ❯ …│` 줄과 그 아래 `│ … │` 줄(상자 끝 `╰` 전까지)이 비어야 빈 입력.
 */
export function draftState(input: { kind: MobileAgentKind; screen: string }): DraftState {
  const lines = input.screen.split(/\r?\n/).map(runsOf)
  const plain = lines.map(plainOf)
  switch (input.kind) {
    case 'claude': {
      const rules: number[] = []
      plain.forEach((line, index) => { if (RULE.test(line)) rules.push(index) })
      if (rules.length < 2) return 'unknown'
      const end = rules[rules.length - 1]!
      const start = rules[rules.length - 2]!
      const first = plain[start + 1]
      if (first === undefined || start + 1 >= end || !first.startsWith('❯')) return 'unknown'
      // 흐린 글(SGR 2)은 자리표시(`Try "…"`)다 — 진한 글만 초안으로 센다. 첫 줄 맨 앞 `❯` 는 표식.
      let typed = false
      for (let index = start + 1; index < end; index += 1) {
        let skip = index === start + 1 ? 1 : 0
        for (const run of lines[index]!) {
          const body = run.text.slice(Math.min(skip, run.text.length))
          skip = Math.max(0, skip - run.text.length)
          if (!run.dim && body.replace(/[\s\u00a0]+/g, '').length > 0) typed = true
        }
      }
      return typed ? 'draft' : 'empty'
    }
    case 'codex': {
      let at = -1
      plain.forEach((line, index) => { if (line.startsWith('› ')) at = index })
      if (at < 0) return 'unknown'
      const runs = lines[at]!
      let seen = 0
      let typed = false
      for (const run of runs) {
        // 앞의 `› ` 두 글자는 프롬프트 표식이다.
        const skip = Math.max(0, Math.min(run.text.length, 2 - seen))
        const body = run.text.slice(skip)
        seen += run.text.length
        if (body.trim().length > 0 && !run.dim) typed = true
      }
      const next = plain[at + 1]
      if (next !== undefined && next.trim().length > 0) typed = true
      return typed ? 'draft' : 'empty'
    }
    case 'grok': {
      let at = -1
      plain.forEach((line, index) => { if (/^\s*│ ❯/.test(line)) at = index })
      if (at < 0) return 'unknown'
      const inner = (line: string): string | null => {
        const match = /^\s*│(.*)│\s*$/.exec(line)
        return match === null ? null : match[1]!
      }
      const first = inner(plain[at]!)
      if (first === null) return 'unknown'
      let content = first.replace(/^\s*❯/, '')
      for (let index = at + 1; index < plain.length; index += 1) {
        const line = plain[index]!
        if (/^\s*╰/.test(line)) break
        const body = inner(line)
        if (body === null) break
        content += body
      }
      return content.trim().length === 0 ? 'empty' : 'draft'
    }
  }
}
