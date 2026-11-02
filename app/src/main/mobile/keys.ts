// provider 별 키 표 (LIFE-582 P4·P5·P8·P9) — 폰은 키를 보내지 않는다. 질문 답·중단의 바이트는 전부 여기서 서버가 만든다.
// 표의 근거는 실측 원자료 `specs/LIFE-582-mobile-input/raw/claude/z1-measure.md`(Claude 2.1.296 · Codex 0.162.1 · Grok 1.0.50).
// 순수 함수만 둔다 — 시험이 provider 없이 돈다.
import { createHash } from 'node:crypto'
import type { SessionQuestion } from '../../shared/types.js'
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
      return true
    // Grok 은 질문·권한 대기 모두 숨긴다 — 질문은 Ctrl+C 가 질문만 거절(Z1ⓒ), 권한은 상자가 입력 줄을 덮어 초안 확인(draftState)이
    // unknown 이라 멈추지 않는다(최종 관문 Z5ⓔ s59 · raw/claude/final/grok-perm).
    case 'approval':
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
  const plan = answerGroups(input)
  return plan.ok ? { ok: true, steps: plan.groups.flatMap((group) => group.keys) } : plan
}

/**
 * 키 묶음 앞에서 화면으로 확인할 것(R2-A1) — `open` = Codex 의 접힌 질문 표시(문항 수) · `question` = 활성 질문 영역이 그 문항 ·
 * `review` = Claude 검토 화면.
 */
export type AnswerCheck = { kind: 'open' } | { kind: 'question'; index: number } | { kind: 'review' }
export type AnswerGroup = { check: AnswerCheck; keys: string[] }
export type AnswerGroups = { ok: true; groups: AnswerGroup[] } | { ok: false; reason: 'locked' | 'other_locked' | 'bad_answer' }

/** `answerSteps` 의 키를 화면 확인 단위로 묶은 것 — 묶음마다 그 앞에서 활성 질문 영역을 다시 대조한다(R2-A1). */
export function answerGroups(input: { kind: MobileAgentKind; questions: AnswerQuestion[]; answers: QuestionAnswer[] }): AnswerGroups {
  const { kind, questions, answers } = input
  if (answerLock({ kind, questions }) !== null) return { ok: false, reason: 'locked' }
  if (answers.length !== questions.length) return { ok: false, reason: 'bad_answer' }
  const groups: AnswerGroup[] = []
  if (kind === 'codex') groups.push({ check: { kind: 'open' }, keys: [KEY.shiftLeft] })
  let review = false
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!
    const answer = answers[index]!
    if (!validAnswer({ question, answer })) return { ok: false, reason: 'bad_answer' }
    if (answer.other !== null && !otherAllowed({ kind, question })) return { ok: false, reason: 'other_locked' }
    if (question.multiSelect === true) review = true
    groups.push({ check: { kind: 'question', index }, keys: questionKeys({ kind, question, answer, checked: [] }) })
  }
  if (kind === 'claude' && (questions.length > 1 || review)) groups.push({ check: { kind: 'review' }, keys: ['1'] })
  if (groups.some((group) => group.keys.some((key) => key.length === 0))) return { ok: false, reason: 'locked' }
  return { ok: true, groups }
}

/**
 * 문항 하나의 키 — `checked` = 화면에 이미 체크된 선택지(0부터, Claude multiSelect 만 — R3-A1). 숫자는 체크를 뒤집기만 하고 커서를 옮기지 않는다
 * (Z1 a-q2-after13: `1`·`3` 뒤 커서는 1행) — 그래서 이미 체크된 상태에서 폰 답으로 가는 키는 「바뀌어야 하는 칸만 뒤집기」로 정확히 셀 수 있다.
 * 못 만드는 키는 빈 글(부르는 쪽이 잠근다).
 */
export function questionKeys(input: { kind: MobileAgentKind; question: AnswerQuestion; answer: QuestionAnswer; checked: number[] }): string[] {
  const { kind, question, answer } = input
  const keyOf = (n: number): string => digit(n) ?? ''
  const otherKey = kind === 'grok' ? 'z' : keyOf(question.options + 1)
  const keys: string[] = []
  if (question.multiSelect === true) {
    // Claude 만 온다(answerLock). 지금 체크와 원하는 체크가 다른 칸만 뒤집는다.
    const want = new Set(answer.choices)
    const have = new Set(input.checked)
    for (let choice = 0; choice < question.options; choice += 1) if (want.has(choice) !== have.has(choice)) keys.push(keyOf(choice + 1))
    if (answer.other !== null) {
      keys.push(otherKey)
      for (let row = 0; row < question.options; row += 1) keys.push(KEY.down)
      keys.push(answer.other, KEY.tab, KEY.enter)
    } else {
      for (let row = 0; row <= question.options; row += 1) keys.push(KEY.down)
      keys.push(KEY.enter)
    }
    return keys
  }
  if (input.checked.length > 0) return ['']
  if (answer.other !== null) return [otherKey, answer.other, KEY.enter]
  keys.push(keyOf(answer.choices[0]! + 1))
  if (kind === 'claude' && question.preview) keys.push(KEY.enter)
  return keys
}

// --- 활성 질문 영역 (R2-A1) ---------------------------------------------------------------------------

/**
 * 질문 내용 지문 — 기록에서 읽은 문항 전체(글·머리·선택지 글과 설명·여럿 고름·preview)의 해시 앞 32자. 서버가 대화에 실어 보내고(`chat.ts`)
 * 폰이 답과 함께 돌려준다. 같은 말풍선 id·도구 호출 id 라도 내용이 바뀌었으면 다른 질문이다(R2-A1).
 */
export function questionDigest(questions: readonly SessionQuestion[]): string {
  const shape = questions.map((q) => [q.question, q.header, q.options.map((option) => [option.label, option.description]), q.multiSelect, q.preview === true])
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32)
}

/**
 * 화면 맨 아래의 **지금 답을 받는 질문 상자**(Z1ⓑ 실측 모양). 화면 위쪽의 과거 글은 보지 않는다.
 * 상자의 끝(안내 줄)부터 **화면 끝까지** provider 마다 정해진 줄만 있어야 한다(R3-A2) — 모르는 줄이나 다른 대화상자(권한 질문 등)가
 * 아래에 있으면 그 상자는 지금 것이 아니다(`none`).
 * - `question`: 문항 글 · 선택지 글(직접 입력 행 제외 — 자리표시 글일 때) · 보이면 위치 표시(k·n) · 행 전부(`rows` — 직접 입력 행 포함,
 *   커서·체크 표시) · Claude 머리 줄 문항 탭의 답함 표시(`tabs`).
 * - `collapsed`: Codex 의 접힌 질문 표시(`? N question(s)` + `⇧← to answer`) — 그 아래가 입력창과 상태 줄뿐일 때만(D2).
 * - `review`: Claude 검토 화면. `none`: 질문 상자를 못 찾음(다른 대화상자·권한 질문·한가 화면 포함) — 넣지 않는다.
 */
export type ActiveQuestion =
  | { kind: 'question'; title: string; options: string[]; position: number | null; total: number | null; rows: QuestionRow[]; tabs: boolean[] | null }
  | { kind: 'collapsed'; count: number }
  | { kind: 'review' }
  | { kind: 'none' }

/**
 * 선택지 행 하나(직접 입력 행 포함) — 글(첫 물리 줄의 첫 칸) · 커서가 이 행인가(화면이 커서를 안 보이면 null) · 체크 상자(없으면 null) ·
 * 번호(Grok `z` 는 null) · 이 행의 글 조각 전부(`pieces` — 첫 줄을 두 칸 이상 공백으로 나눈 칸 + 아래 이어진 물리 줄. 좁은 pane 에서 줄이 바뀐
 * 선택지 글·설명을 복원하는 재료, R4-A2).
 */
export type QuestionRow = { label: string; cursor: boolean | null; checked: boolean | null; number: number | null; pieces: string[] }

const squash = (text: string): string => text.replace(/[\s\u00a0]+/g, ' ').trim()
const blankLine = (line: string): boolean => line.trim().length === 0

export function activeQuestion(input: { kind: MobileAgentKind; screen: string }): ActiveQuestion {
  const lines = screenPlain(input.screen).split('\n').map((line) => line.replace(/\s+$/, ''))
  switch (input.kind) {
    case 'claude':
      return claudeQuestion(lines)
    case 'codex':
      return codexQuestion(lines)
    case 'grok':
      return grokQuestion(lines)
  }
}

/** 마지막 줄부터 위로 처음 맞는 줄. */
function lastIndex(lines: string[], test: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) if (test(lines[index]!)) return index
  return -1
}

/** `from` 뒤 화면 끝까지가 빈 줄뿐인가. */
const onlyBlankAfter = (lines: string[], from: number): boolean => lines.slice(from + 1).every(blankLine)

/** 직접 입력 행의 자리표시 글(빈 상태) — provider 마다. */
const OTHER_PLACEHOLDER: Record<MobileAgentKind, RegExp> = {
  claude: /^Type something\.?$/,
  codex: /^Other$/,
  grok: /^Type your answer here$/,
}

const CLAUDE_OPTION = /^\s*(❯\s*)?(\d+)\.\s+(?:\[([ ✔×x])\]\s+)?(.*)$/
const CLAUDE_FOOTER = /^\s*Enter to select\b.*Esc to cancel\s*$/

// 실측한 Claude 안내 줄의 조각(Z1·r4/width) — 꺾인 안내 줄은 이 조각들로만 다시 이어 읽는다(R5-A4).
const CLAUDE_FOOTER_KNOWN = /^Enter to select(?: · (?:↑\/↓ to navigate|Tab\/Arrow keys to navigate|ctrl\+g to edit in VS Code|n to add notes))* · Esc to cancel$/

/**
 * Claude 안내 줄 — `Enter to select` 로 시작하는 마지막 줄. 그 줄이 이미 `Esc to cancel` 로 끝나면 거기서 멈춘다(R5-A4).
 * 덜 끝났으면(좁은 pane 에서 꺾임 — R4-A2 실측 40열) 다음 줄들을 이어 실측 안내 문구가 될 때까지만 읽는다. 그 뒤는 화면 끝까지 빈 줄만(R3-A2)이고, 세션 이름 줄 하나(`NAMED_RULE`, LIFE-766)는 받는다 — 그 밖의 글이 있거나 그 줄 뒤에 글이 있으면 -1.
 */
function claudeFooter(lines: string[]): number {
  const footer = lastIndex(lines, (line) => /^\s*Enter to select\b/.test(line))
  if (footer < 0) return -1
  let end = footer
  if (!CLAUDE_FOOTER.test(lines[footer]!)) {
    let text = squash(lines[footer]!)
    while (!CLAUDE_FOOTER_KNOWN.test(text)) {
      end += 1
      if (end >= lines.length || end - footer > 2 || blankLine(lines[end]!)) return -1
      text = squash(`${text} ${lines[end]!}`)
    }
  }
  const below = lines.slice(end + 1).filter((line) => !blankLine(line))
  return below.length === 0 || (below.length === 1 && NAMED_RULE.test(below[0]!)) ? footer : -1
}

/**
 * Claude: 맨 아래 안내 줄(`Enter to select … Esc to cancel`) 위의 두 가로줄 사이 상자. 첫 줄은 머리(` ☐ X` 또는 `←  ☒ A  ☐ B  ✔ Submit  →`),
 * 다음 줄들이 문항 글, `N. 글` 이 선택지(아래 들여쓴 설명 줄·preview 상자는 뺀다). 아래 가로줄과 안내 줄 사이는 `Chat about this` 행뿐,
 * 안내 줄 아래는 빈 줄뿐이거나 세션 이름 줄 하나여야 한다(R3-A2 — 권한 질문의 `Esc to cancel · Tab to amend` 는 안내 줄이 아니다).
 */
function claudeQuestion(lines: string[]): ActiveQuestion {
  const tabsLine = lastIndex(lines, (line) => /^\s*←\s.*✔\s*Submit\s*→\s*$/.test(line))
  if (tabsLine >= 0 && claudeReview(lines.slice(tabsLine + 1))) return { kind: 'review' }
  const footer = claudeFooter(lines)
  if (footer < 0) return { kind: 'none' }
  const rules: number[] = []
  for (let index = 0; index < footer; index += 1) if (RULE.test(lines[index]!)) rules.push(index)
  const bottom = rules.at(-1)
  const top = rules.at(-2)
  if (bottom === undefined || top === undefined) return { kind: 'none' }
  // 아래 가로줄 뒤에는 `Chat about this` 행과 빈 줄만.
  if (!lines.slice(bottom + 1, footer).every((line) => blankLine(line) || /^\s*(?:❯\s*)?(?:\d+\.\s+)?Chat about this$/.test(line))) return { kind: 'none' }
  const box = lines.slice(top + 1, bottom).filter((line) => !blankLine(line))
  const head = box[0]
  if (head === undefined || !/^\s*(←\s+)?[☐☒✔]/.test(head)) return { kind: 'none' }
  const body = box.slice(1)
  const first = body.findIndex((line) => CLAUDE_OPTION.test(line))
  if (first <= 0) return { kind: 'none' }
  const title = squash(claudeTitleLines(body.slice(0, first)).join(' '))
  const rows: QuestionRow[] = []
  for (const line of body.slice(first)) {
    const match = CLAUDE_OPTION.exec(line)
    if (match === null) {
      // 번호 없는 줄 = 바로 위 행의 이어진 물리 줄(줄 바뀐 선택지 글 · 설명 — R4-A2).
      rows.at(-1)?.pieces.push(squash(line))
      continue
    }
    if (Number(match[2]) !== rows.length + 1) return { kind: 'none' }
    // preview 레이아웃은 선택지 글 옆에 상자가 붙는다 — 두 칸 이상 공백 앞까지가 글.
    const cells = match[4]!.split(/\s{2,}/).map(squash).filter((cell) => cell.length > 0)
    rows.push({ label: cells[0] ?? '', cursor: match[1] !== undefined, checked: match[3] === undefined ? null : match[3] !== ' ', number: Number(match[2]), pieces: cells })
  }
  // 머리 줄의 문항 탭 — `☐` = 아직, `☒`·`✔` = 답함(마지막 `✔ Submit` 은 탭이 아니다).
  const marks = [...head.matchAll(/([☐☒✔])\s+([^☐☒✔→]+)/g)].filter((match) => !(match[1] === '✔' && match[2]!.trim() === 'Submit'))
  const tabs = marks.map((match) => match[1] !== '☐')
  return { kind: 'question', title, options: optionLabels({ kind: 'claude', rows }), position: null, total: null, rows, tabs }
}

const CLAUDE_TITLE_BAR = /^│(?: |$)/

/**
 * 문항 글 줄의 렌더러 표시 — Claude 2.1.296 은 문항 글의 줄마다 맨 앞에 `│ `, 빈 문단에 `│` 단독 줄을 그린다(LIFE-754 실측).
 * 한 줄 짧은 글(12·47자)에는 없고, 긴 한 줄(114·116자)·줄바뀐 글·개행이 든 글(짧아도)은 줄마다 있다 — 붙는 조건(임계)은 가리지 않았다.
 * 문항 글 줄 **모두**가 그 모양일 때만 줄 맨 앞 하나를 뗀다 — 접두사 없는 구 렌더링은 그대로, 글 안쪽의 `│` 는 남는다.
 */
function claudeTitleLines(lines: string[]): string[] {
  if (!lines.every((line) => CLAUDE_TITLE_BAR.test(line))) return lines
  return lines.map((line) => line.replace(CLAUDE_TITLE_BAR, ''))
}

/**
 * Claude 검토 화면(Z1 a-q4-review·a-q5-review) — 머리 줄 아래가 `Review your answers` → 답 요약(들여쓴 줄) → `Ready to submit your answers?`
 * → `1. Submit answers` · `2. Cancel` 로 끝나야 한다(뒤에 안내 줄 하나까지). 그 밖의 줄이 화면 끝까지 하나라도 있으면 아니다(R3-A2).
 */
function claudeReview(rest: string[]): boolean {
  const shown = rest.filter((line) => !blankLine(line))
  // 맨 끝 세션 이름 줄 하나는 화면 틀이다(LIFE-766) — 그 뒤에 글이 있으면 아래 끝 줄 검사가 막는다.
  const lines = NAMED_RULE.test(shown.at(-1) ?? '') ? shown.slice(0, -1) : shown
  if (lines[0]?.trim() !== 'Review your answers') return false
  const end = lines.length - (CLAUDE_FOOTER.test(lines.at(-1) ?? '') ? 1 : 0)
  if (end < 4) return false
  if (!/^\s*(?:❯\s*)?1\.\s+Submit answers$/.test(lines[end - 2]!) || !/^\s*(?:❯\s*)?2\.\s+Cancel$/.test(lines[end - 1]!)) return false
  if (lines[end - 3]!.trim() !== 'Ready to submit your answers?') return false
  // 요약은 들여쓴 줄(` ● 문항` · `   → 답` · 경고)만.
  return lines.slice(1, end - 3).every((line) => /^\s+\S/.test(line))
}

/** 화면 선택지 글 — 직접 입력 행이 자리표시 글이면 뺀다(R2 와 같은 모양). */
function optionLabels(input: { kind: MobileAgentKind; rows: QuestionRow[] }): string[] {
  const labels = input.rows.map((row) => row.label)
  if (labels.length > 0 && OTHER_PLACEHOLDER[input.kind].test(labels.at(-1)!)) labels.pop()
  return labels
}

const CODEX_OPTION = /^\s*(›\s*)?(\d+)\.\s+(.*)$/

/**
 * Codex 입력창 아래 상태 줄의 실측 모양(R4-A3 — Z1 ca-q1-screen · r4 `codex-collapsed-*`): 모델·노력 · 작업 경로 · 대화 제목 /
 * `? for shortcuts`(오른쪽에 경고 표시가 붙을 수 있다) / 경고 표시만.
 */
const CODEX_STATUS: readonly RegExp[] = [
  /^\s*\S+(?: \S+)* · (?:~|\/)\S*(?: · .*)?$/,
  /^\s*\? for shortcuts(?:\s{2,}⚠ \d+ warnings? · f2 to view)?$/,
  /^\s*⚠ \d+ warnings? · f2 to view$/,
]

/**
 * Codex: 맨 아래 안내 줄(`enter submit … ⇧→ main prompt`) 위 — `› N. 글` 선택지, 그 위 문항 글, 남은 문항이 둘 이상이면 `k of n` 줄
 * (실측: 남은 문항 중 위치 — 3문항이면 `1 of 3` → 답 뒤 `1 of 2` → 마지막은 표시 없음, R3-A3). 문항 글 위는 `•` 줄(진행 표시)이다.
 * 안내 줄 아래는 빈 줄뿐이어야 한다. 접힌 상태면 `? N question(s)` + `⇧← to answer` — 그 아래가 입력창과 상태 줄뿐일 때만(D2).
 */
function codexQuestion(lines: string[]): ActiveQuestion {
  const footer = lastIndex(lines, (line) => /^\s*enter submit\b.*⇧→ main prompt/.test(line))
  if (footer < 0) return codexCollapsed(lines)
  if (!onlyBlankAfter(lines, footer)) return { kind: 'none' }
  // 안내 줄 위로 빈 줄 → 선택지 줄들 → 빈 줄 → 문항 글 줄들(위는 빈 줄·`•` 진행 줄·`k of n` 줄).
  let at = footer - 1
  while (at >= 0 && blankLine(lines[at]!)) at -= 1
  const optionLines: string[] = []
  while (at >= 0 && CODEX_OPTION.test(lines[at]!)) optionLines.unshift(lines[at--]!)
  if (optionLines.length === 0) return { kind: 'none' }
  const matches = optionLines.map((line) => CODEX_OPTION.exec(line)!)
  if (matches.some((match, index) => Number(match[2]) !== index + 1)) return { kind: 'none' }
  while (at >= 0 && blankLine(lines[at]!)) at -= 1
  const titleLines: string[] = []
  const counterLine = /^\s*(\d+) of (\d+)\s*$/
  while (at >= 0 && !blankLine(lines[at]!) && !/^\s*•/.test(lines[at]!) && !counterLine.test(lines[at]!)) titleLines.unshift(lines[at--]!)
  const counter = at >= 0 ? counterLine.exec(lines[at]!) : null
  const title = squash(titleLines.join(' '))
  if (title.length === 0) return { kind: 'none' }
  const rows = matches.map((match) => ({ label: squash(match[3]!), cursor: match[1] !== undefined, checked: null, number: Number(match[2]), pieces: [squash(match[3]!)] }))
  return { kind: 'question', title, options: optionLabels({ kind: 'codex', rows }), position: counter === null ? null : Number(counter[1]), total: counter === null ? null : Number(counter[2]), rows, tabs: null }
}

/**
 * Codex 접힌 질문(Z1 ca-q1-screen) — `? N question(s)` 바로 아래 `⇧← to answer`, 그 아래 빈 줄 → 입력창(`› …`, 맥 초안이면 이어지는 들여쓴 줄)
 * → 빈 줄 → 상태 줄(최대 3줄)뿐. 상태 줄에 대화상자 모양(번호 선택지·확인 안내·다른 질문 표시)이 있으면 아니다(D2 — 화면 아무 곳의 마지막 표시를 쓰지 않는다).
 */
function codexCollapsed(lines: string[]): ActiveQuestion {
  const hint = lastIndex(lines, (line) => /^\s*⇧← to answer\s*$/.test(line))
  const count = hint > 0 ? /^\s*\?\s+(\d+) questions?\b/.exec(lines[hint - 1]!) : null
  if (count === null) return { kind: 'none' }
  let at = hint + 1
  while (at < lines.length && blankLine(lines[at]!)) at += 1
  // 입력창 — `›` 로 시작하는 한 줄(번호 선택지 `› 1.` 은 대화상자다).
  if (at >= lines.length || !/^›(\s|$)/.test(lines[at]!) || CODEX_OPTION.test(lines[at]!)) return { kind: 'none' }
  at += 1
  // 입력창 이어짐 — 맥 초안이 감긴 물리 줄은 두 칸 들여쓴다(r4 실측 `codex-collapsed-long-80`). 빈 줄 전까지.
  while (at < lines.length && !blankLine(lines[at]!)) {
    if (!/^ {2}\S/.test(lines[at]!)) return { kind: 'none' }
    at += 1
  }
  // 그 아래는 실측한 상태 줄 모양만(R4-A3) — 모르는 줄이 한 줄이라도 있으면 맨 아래 활성 영역이 아니다.
  const status = lines.slice(at).filter((line) => !blankLine(line))
  if (status.length > 3 || !status.every((line) => CODEX_STATUS.some((shape) => shape.test(line)))) return { kind: 'none' }
  return { kind: 'collapsed', count: Number(count[1]) }
}

const GROK_OPTION = /^\s*(\d+|z) ([([])([ ○●✔x])[)\]]\s+(.*)$/

/**
 * Grok: 맨 아래 `┃` 상자 — 안내 줄(`… navigate …  Enter:…`, 여럿이면 앞에 `[k/n]`) 위에 `N (○) 글  설명` 선택지와 `z` 직접 입력 행,
 * 그 위 문항 글. 안내 줄 아래는 빈 `┃` 줄·빈 줄과 단축키 줄(`Tab:next answer │ …` · `Enter:submit │ …`) 하나뿐이어야 한다(R3-A2).
 */
function grokQuestion(lines: string[]): ActiveQuestion {
  const inner = (line: string): string | null => {
    const match = /^\s*┃(.*)$/.exec(line)
    return match === null ? null : match[1]!
  }
  const footer = lastIndex(lines, (line) => inner(line) !== null && /navigate\b.*Enter:/.test(line))
  if (footer < 0) return { kind: 'none' }
  const below = lines.slice(footer + 1).filter((line) => !blankLine(line) && !/^\s*┃\s*$/.test(line))
  if (below.length > 1 || (below.length === 1 && !/^\s*(?:Tab:next answer|Enter:(?:submit|edit|select))\s+│/.test(below[0]!))) return { kind: 'none' }
  let top = footer
  while (top > 0 && inner(lines[top - 1]!) !== null) top -= 1
  const box = lines.slice(top, footer).map((line) => inner(line)!).filter((line) => !blankLine(line))
  const first = box.findIndex((line) => GROK_OPTION.test(line))
  if (first <= 0) return { kind: 'none' }
  const title = squash(box.slice(0, first).join(' '))
  const rows: QuestionRow[] = []
  let numbered = 0
  let last: number | null = null
  // 오른쪽 끝 스크롤 막대(`█`)는 글이 아니다.
  const cellsOf = (text: string): string[] => text.replace(/\s*█\s*$/, '').split(/\s{2,}/).map(squash).filter((cell) => cell.length > 0 && cell !== '█')
  for (const line of box.slice(first)) {
    const match = GROK_OPTION.exec(line)
    if (match === null) {
      // 번호 없는 줄 = 바로 위 행의 이어진 물리 줄(좁은 pane 에서 줄 바뀐 선택지 글 · 설명 — R4-A2 실측 100·80·60열). 직접 입력 행 뒤에는 없다.
      const row = rows.at(-1)
      if (row === undefined || row.number === null) return { kind: 'none' }
      row.pieces.push(...cellsOf(line))
      continue
    }
    const number = match[1] === 'z' ? null : Number(match[1])
    if (number !== null) {
      // 좁은 pane 에서는 위·아래 행이 스크롤로 안 보일 수 있다(R4-A2 실측 40열) — 보이는 번호는 이어져야 한다.
      if (last !== null && number !== last + 1) return { kind: 'none' }
      last = number
      numbered += 1
    }
    const cells = cellsOf(match[4]!)
    rows.push({ label: cells[0] ?? '', cursor: null, checked: match[3] !== ' ' && match[3] !== '○', number, pieces: cells })
  }
  // 직접 입력 행(`z`)은 맨 끝 하나만.
  if (rows.length - numbered > 1 || (rows.length > numbered && rows.at(-1)!.number !== null)) return { kind: 'none' }
  const counter = /\[(\d+)\/(\d+)\]/.exec(lines[footer]!)
  const options = rows.slice(0, numbered).map((row) => row.label)
  return { kind: 'question', title, options, position: counter === null ? null : Number(counter[1]), total: counter === null ? null : Number(counter[2]), rows, tabs: null }
}

/**
 * 활성 질문 영역이 기록의 그 문항인가(R2-A1) — 문항 글 전체와 선택지 글 전부가 같고(공백만 무시), 위치가 보이면 그 위치까지 같아야 한다.
 * 위치의 뜻은 provider 마다: Grok `[k/n]` = 전체 중 k번째, Codex `k of n` = **남은** 문항 중 위치(R3-A3 — 남은 게 하나면 표시 없음),
 * Claude 는 위치 대신 머리 줄 탭. 앞부분 포함·화면 아무 곳 포함은 세지 않는다.
 * - `same`: 그 문항이고 갓 열린 빈 상태(또는 Claude multiSelect 의 체크만 있는 상태 — `checked` 로 키를 다시 센다, R3-A1).
 * - `busy`: 그 문항이지만 맥에서 이미 고르는 중(커서 이동·체크·직접 입력 글·문항 진행) — 키 0회로 「맥에서 답해 주세요」.
 * - `other`: 다른 질문·다른 화면.
 */
export type QuestionMatch = { kind: 'same'; checked: number[] } | { kind: 'busy' } | { kind: 'truncated' } | { kind: 'other' }

/**
 * - `truncated`(R4-A2): 그 문항으로 보이지만(문항 글이 같고 보이는 행이 모두 기록과 어긋나지 않음) 좁은 pane 에서 행이 스크롤로 안 보이거나
 *   선택지 글이 보이는 글자 없이 잘려 **복원할 수 없다** — 키 0회 「맥에서 답해 주세요」.
 * 선택지 행은 물리 줄 바꿈을 복원해 「선택지 글 + 설명」 과 비교한다(`rowFits`). 끝이 `…` 인 칸은 provider 가 잘라 보인 것 — 보이는 앞부분이
 * 기록과 같으면 받아들이고 그 칸의 나머지는 건너뛴다(Grok 비포커스 행 실측).
 */
export function matchQuestion(input: {
  kind: MobileAgentKind
  active: ActiveQuestion
  question: { question: string; options: string[]; descriptions?: (string | null)[]; multiSelect: boolean | null; preview: boolean }
  index: number
  total: number
}): QuestionMatch {
  const { kind, active, question, index, total } = input
  if (active.kind !== 'question') return { kind: 'other' }
  if (!positionMatches({ kind, active, index, total })) return { kind: 'other' }
  const key = (text: string): string => text.replace(/[\s\u00a0]+/g, '')
  if (key(active.title) !== key(question.question)) return { kind: 'other' }
  const options = question.options.length
  const hasOther = otherAllowed({ kind, question: { options, multiSelect: question.multiSelect, preview: question.preview } })
  const rows = active.rows
  // 직접 입력 행 — Claude·Codex 는 번호 N+1, Grok 은 번호 없는 `z`.
  const isOther = (row: QuestionRow): boolean => (kind === 'grok' ? row.number === null : row.number === options + 1)
  const otherRows = rows.filter(isOther)
  const optionRows = rows.filter((row) => !isOther(row))
  if (otherRows.length > (hasOther ? 1 : 0)) return { kind: 'other' }
  if (optionRows.some((row) => row.number === null || row.number < 1 || row.number > options)) return { kind: 'other' }
  let cut = optionRows.length < options || (hasOther && otherRows.length === 0)
  for (const row of optionRows) {
    const at = row.number! - 1
    // preview 레이아웃은 옆 상자가 이어진 줄에 섞인다 — 첫 줄 글만 본다(R2 와 같음).
    const fit = question.preview ? rowFits({ pieces: row.pieces.slice(0, 1), parts: [question.options[at]!] }) : rowFits({ pieces: row.pieces, parts: [question.options[at]!, question.descriptions?.[at] ?? null] })
    if (fit === 'no') return { kind: 'other' }
    if (fit === 'cut') cut = true
  }
  if (cut) return { kind: 'truncated' }
  // 여기부터 그 문항이다 — 갓 열린 빈 상태인가.
  const otherRow = otherRows[0] ?? null
  if (otherRow !== null && (!OTHER_PLACEHOLDER[kind].test(otherRow.label) || otherRow.checked === true)) return { kind: 'busy' }
  // 커서를 보이는 화면(Claude ❯ · Codex ›)이면 첫 행에만 있어야 한다.
  if (kind !== 'grok' && (optionRows[0]!.cursor !== true || rows.some((row) => row !== optionRows[0] && row.cursor === true))) return { kind: 'busy' }
  const checked = optionRows.flatMap((row) => (row.checked === true ? [row.number! - 1] : []))
  // 체크에서 폰 답으로 가는 키를 셀 수 있는 것은 Claude multiSelect 뿐(숫자 = 뒤집기). 나머지는 체크가 있으면 고르는 중이다.
  if (checked.length > 0 && !(kind === 'claude' && question.multiSelect === true)) return { kind: 'busy' }
  if (active.tabs !== null) {
    // Claude 머리 줄 탭 — 앞 문항은 답함(이 요청이 답했다), 뒤 문항은 아직. 이 문항은 체크가 있을 때만 답함 표시(Z1 a-q2-after13).
    if (active.tabs.length !== total) return { kind: 'other' }
    if (active.tabs.some((done, at) => (at < index ? !done : at > index ? done : done !== checked.length > 0))) return { kind: 'busy' }
  }
  return { kind: 'same', checked }
}

/**
 * 한 행의 글 조각(물리 줄·칸)을 차례로 「선택지 글 → 설명」 에 맞춘다(공백 무시). 조각이 `…` 로 끝나면 그 부분은 잘려 보인 것.
 * - `full`: 선택지 글이 끝까지 보이고 기록과 같음(설명은 `…` 로 잘렸으면 보이는 앞부분만 같으면 된다)
 * - `cut`: 선택지 글이 `…` 로 잘렸거나 끝까지 안 보임 — 앞부분이 같아도 받지 않는다(R5-A1, 복원 불가) · `no`: 기록과 다른 글.
 */
function rowFits(input: { pieces: string[]; parts: (string | null)[] }): 'full' | 'cut' | 'no' {
  const key = (text: string): string => text.replace(/[\s\u00a0]+/g, '')
  const parts = input.parts.flatMap((part) => (part === null || key(part).length === 0 ? [] : [key(part)]))
  if (parts.length === 0) return 'no'
  let part = 0
  let rest = parts[0]!
  for (const piece of input.pieces) {
    if (part >= parts.length) return 'no'
    let text = key(piece)
    const ellipsis = text.endsWith('…')
    if (ellipsis) text = text.slice(0, -1)
    if (!rest.startsWith(text)) return 'no'
    if (ellipsis) {
      // 선택지 글이 잘렸다 — 보이는 앞부분이 같아도 숨은 뒷부분이 다를 수 있다(R5-A1). 설명만 잘린 것은 받는다(선택지 글은 다 보였다).
      if (part === 0) return 'cut'
      part += 1
      rest = parts[part] ?? ''
      continue
    }
    rest = rest.slice(text.length)
    if (rest.length === 0) {
      part += 1
      rest = parts[part] ?? ''
    }
  }
  // 선택지 글이 끝까지 안 보였다(조각이 모자람) — 복원할 수 없다.
  if (part === 0) return input.pieces.length === 0 ? 'no' : 'cut'
  // 설명을 보이다 만 채로 끝났다(… 없이) — 다른 글이다.
  if (part < parts.length && rest.length > 0 && rest !== parts[part]) return 'no'
  return 'full'
}

function positionMatches(input: { kind: MobileAgentKind; active: Extract<ActiveQuestion, { kind: 'question' }>; index: number; total: number }): boolean {
  const { kind, active, index, total } = input
  switch (kind) {
    case 'claude':
      return active.position === null
    case 'grok':
      return active.position === null || (active.position === index + 1 && active.total === total)
    case 'codex': {
      const remaining = total - index
      return remaining > 1 ? active.position === 1 && active.total === remaining : active.position === null
    }
  }
}

// --- 맥 입력창 초안 (P9) -----------------------------------------------------------------------------

export type DraftState = 'empty' | 'draft' | 'unknown'

type Run = { text: string; dim: boolean; italic: boolean }

/** ANSI 한 줄 → 글자 덩어리(흐림·기울임 여부). SGR 의 `2`(흐림)·`22`·`3`(기울임)·`23`·`0`/빈 값(해제)만 본다. 다른 제어 열은 버린다. */
function runsOf(line: string): Run[] {
  const runs: Run[] = []
  let dim = false
  let italic = false
  let index = 0
  let text = ''
  const flush = (): void => {
    if (text.length > 0) runs.push({ text, dim, italic })
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
        // 확장 색(38·48·58 + `;5;n` 256색 · `;2;r;g;b` truecolor)은 뒤 인자까지 한 묶음으로 먹는다 — 그 안의 `2` 는 흐림이 아니다(R1-A9).
        for (let at = 0; at < params.length; at += 1) {
          const param = params[at]
          if (param === '38' || param === '48' || param === '58') {
            const mode = params[at + 1]
            at += mode === '5' ? 2 : mode === '2' ? 4 : 1
          } else if (param === '0' || param === '') {
            dim = false
            italic = false
          } else if (param === '2') dim = true
          else if (param === '22') dim = false
          else if (param === '3') italic = true
          else if (param === '23') italic = false
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

/** 보이는 화면(ANSI)의 글만 — 줄 순서 그대로(R1-A2 질문 화면 대조). */
export const screenPlain = (screen: string): string => screen.split(/\r?\n/).map((line) => plainOf(runsOf(line))).join('\n')
const RULE = /^\s*─{20,}\s*$/
/** Claude 입력 상자 윗줄에 세션 이름이 붙은 꼴(`─────… 이름 ─`, 세션을 백그라운드로 옮겼다 돌아온 뒤 — LIFE-766 실측 2.1.296). 첫 칸에서 시작하는 줄만 — 상자 안 여러 줄 초안은 들여 쓰인다. */
const NAMED_RULE = /^─{3,} \S(?:.*\S)? ─+\s*$/

/**
 * 보이는 화면(ANSI)에서 그 provider 의 입력 줄을 찾아 비었는지 본다(Z1ⓔ 표본 모양). **빈 입력이 확인될 때만 `empty`** —
 * 글이 있으면 `draft`, 입력 줄을 못 찾으면 `unknown`(넣지 않는다, fail-closed).
 * - Claude: 마지막 두 가로줄(─) 사이 상자, 첫 줄이 `❯`. 윗줄은 이름이 붙어도 되고(`NAMED_RULE`) 아랫줄은 글 없는 가로줄이어야 한다. `❯` 뒤와 상자 안 나머지 줄에 진한 글이 없어야 빈 입력(흐린 자리표시 `Try "…"` 는 빈 입력 — 새 세션 첫 화면).
 * - Codex: 마지막 `› ` 줄. 그 뒤 글이 전부 흐림(SGR 2 — 자리표시 `Ask Codex to do anything`)이면 빈 입력. 바로 아래 빈 줄 전까지 이어진 줄이 있으면 여러 줄 초안.
 * - Grok: 마지막 `│ ❯ …│` 줄과 그 아래 `│ … │` 줄(상자 끝 `╰` 전까지)이 비어야 빈 입력. 상자 바로 아래 줄(또는 빈 줄 하나 다음 줄)에 `accept suggestion` 힌트가 있으면
 *   입력칸의 기울임(SGR 3) 글은 Grok 의 다음 문장 제안(ghost)이라 빼고 본다 — 힌트가 없으면 기울임도 초안으로 센다(fail-closed, LIFE-582 최종 관문).
 */
export function draftState(input: { kind: MobileAgentKind; screen: string }): DraftState {
  const lines = input.screen.split(/\r?\n/).map(runsOf)
  const plain = lines.map(plainOf)
  switch (input.kind) {
    case 'claude': {
      const rules: number[] = []
      plain.forEach((line, index) => { if (RULE.test(line) || NAMED_RULE.test(line)) rules.push(index) })
      if (rules.length < 2) return 'unknown'
      const end = rules[rules.length - 1]!
      const start = rules[rules.length - 2]!
      if (!RULE.test(plain[end]!)) return 'unknown'
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
      let end = at + 1
      while (end < plain.length && !/^\s*╰/.test(plain[end]!) && inner(plain[end]!) !== null) end += 1
      // 힌트는 상자 바로 아래 줄, 또는 공백만 있는 줄 **하나** 다음 줄이다(실측 Grok 1.0.50: `╰` 와 힌트 사이 빈 줄 하나 — R7-A1).
      // 더 아래에서 찾지 않는다(오래된 힌트 오인 — fail-closed).
      const below = (plain[end + 1] ?? '').trim().length === 0 ? end + 2 : end + 1
      const suggestion = /^\s*╰/.test(plain[end] ?? '') && /accept suggestion/.test(plain[below] ?? '')
      // 기울임 run 을 빼고 남은 글 — 제안 힌트가 있을 때만 뺀다. 틀(`│`)·표식(`❯`)은 그 뒤 inner·replace 가 지운다.
      const visible = (index: number): string => suggestion ? lines[index]!.filter((run) => !run.italic).map((run) => run.text).join('') : plain[index]!
      const first = inner(visible(at))
      if (first === null) return 'unknown'
      let content = first.replace(/^\s*❯/, '')
      for (let index = at + 1; index < end; index += 1) content += inner(visible(index)) ?? ''
      return content.trim().length === 0 ? 'empty' : 'draft'
    }
  }
}
