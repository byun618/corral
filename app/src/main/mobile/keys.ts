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
    const keyOf = (n: number): string => digit(n) ?? ''
    const otherKey = kind === 'grok' ? 'z' : keyOf(question.options + 1)
    const keys: string[] = []
    groups.push({ check: { kind: 'question', index }, keys })
    if (question.multiSelect === true) {
      // Claude 만 온다(answerLock).
      review = true
      for (const choice of answer.choices) keys.push(keyOf(choice + 1))
      if (answer.other !== null) {
        keys.push(otherKey)
        for (let row = 0; row < question.options; row += 1) keys.push(KEY.down)
        keys.push(answer.other, KEY.tab, KEY.enter)
      } else {
        for (let row = 0; row <= question.options; row += 1) keys.push(KEY.down)
        keys.push(KEY.enter)
      }
      continue
    }
    if (answer.other !== null) {
      keys.push(otherKey, answer.other, KEY.enter)
      continue
    }
    keys.push(keyOf(answer.choices[0]! + 1))
    if (kind === 'claude' && question.preview) keys.push(KEY.enter)
  }
  if (kind === 'claude' && (questions.length > 1 || review)) groups.push({ check: { kind: 'review' }, keys: ['1'] })
  if (groups.some((group) => group.keys.some((key) => key.length === 0))) return { ok: false, reason: 'locked' }
  return { ok: true, groups }
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
 * - `question`: 문항 글 · 선택지 글(직접 입력 행 제외) · 보이면 몇 번째 문항(1부터)과 총 수.
 * - `collapsed`: Codex 의 접힌 질문 표시(`? N question(s)` + `⇧← to answer`). `review`: Claude 검토 화면.
 * - `none`: 질문 상자를 못 찾음(다른 대화상자·권한 질문·한가 화면 포함) — 넣지 않는다.
 */
export type ActiveQuestion =
  | { kind: 'question'; title: string; options: string[]; position: number | null; total: number | null }
  | { kind: 'collapsed'; count: number }
  | { kind: 'review' }
  | { kind: 'none' }

const squash = (text: string): string => text.replace(/[\s\u00a0]+/g, ' ').trim()

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

/**
 * Claude: 맨 아래 안내 줄(`… Esc to cancel`) 위의 두 가로줄 사이 상자. 첫 줄은 머리(` ☐ X` 또는 `←  ☒ A  ☐ B  ✔ Submit  →`),
 * 다음 줄들이 문항 글, `N. 글` 이 선택지(아래 들여쓴 설명 줄·preview 상자는 뺀다). 머리 줄의 `☐`/`☒` 순서에서 현재 문항은 알 수 없어 위치는 null.
 */
function claudeQuestion(lines: string[]): ActiveQuestion {
  // 검토 화면(Z1 a-q4-review) — 마지막 머리 줄 아래가 `Review your answers` 와 `1. Submit answers` 뿐이다(아래 안내 줄이 없다).
  const tabs = lastIndex(lines, (line) => /^\s*←\s.*✔\s*Submit\s*→\s*$/.test(line))
  if (tabs >= 0) {
    const rest = lines.slice(tabs + 1).filter((line) => line.trim().length > 0)
    if (rest[0]?.trim() === 'Review your answers' && rest.some((line) => /^\s*(?:❯\s*)?1\.\s+Submit answers$/.test(line))) return { kind: 'review' }
  }
  const footer = lastIndex(lines, (line) => /Esc to cancel\s*$/.test(line))
  if (footer < 0) return { kind: 'none' }
  const rules: number[] = []
  for (let index = 0; index < footer; index += 1) if (RULE.test(lines[index]!)) rules.push(index)
  // 아래 가로줄 뒤에는 `Chat about this` 와 안내 줄만 있어야 한다.
  const bottom = rules.at(-1)
  const top = rules.at(-2)
  if (bottom === undefined || top === undefined || footer - bottom > 3) return { kind: 'none' }
  const box = lines.slice(top + 1, bottom).filter((line) => line.trim().length > 0)
  const head = box[0]
  if (head === undefined || !/^\s*(←\s+)?[☐☒✔]/.test(head)) return { kind: 'none' }
  const body = box.slice(1)
  const option = /^\s*(?:❯\s*)?(\d+)\.\s+(?:\[[ ✔×x]\]\s+)?(.*)$/
  const first = body.findIndex((line) => option.test(line))
  if (first <= 0) return { kind: 'none' }
  const title = squash(body.slice(0, first).join(' '))
  const options: string[] = []
  for (const line of body.slice(first)) {
    const match = option.exec(line)
    if (match === null) continue
    if (Number(match[1]) !== options.length + 1) return { kind: 'none' }
    // preview 레이아웃은 선택지 글 옆에 상자가 붙는다 — 두 칸 이상 공백 앞까지가 글.
    options.push(squash(match[2]!.split(/\s{2,}/)[0]!))
  }
  // 직접 입력 행(`Type something`) 은 선택지가 아니다.
  if (options.length > 0 && /^Type something\.?$/.test(options.at(-1)!)) options.pop()
  return { kind: 'question', title, options, position: null, total: null }
}

/**
 * Codex: 맨 아래 안내 줄(`enter submit … ⇧→ main prompt`) 위 — `› N. 글` 선택지, 그 위 문항 글, 문항이 여럿이면 `k of n` 줄.
 * 문항 글 위는 `•` 줄(진행 표시)이다. 접힌 상태면 `? N question(s)` + `⇧← to answer`.
 */
function codexQuestion(lines: string[]): ActiveQuestion {
  const footer = lastIndex(lines, (line) => /^\s*enter submit\b.*⇧→ main prompt/.test(line))
  if (footer < 0) {
    const hint = lastIndex(lines, (line) => /^\s*⇧← to answer\s*$/.test(line))
    const count = hint > 0 ? /^\s*\?\s+(\d+) questions?\b/.exec(lines[hint - 1]!) : null
    // 접힌 표시 아래는 입력 상자다 — 그보다 아래에 다른 질문 상자가 있으면 이 표시는 지금 것이 아니다.
    return count === null ? { kind: 'none' } : { kind: 'collapsed', count: Number(count[1]) }
  }
  const option = /^\s*(?:›\s*)?(\d+)\.\s+(.*)$/
  const blank = (index: number): boolean => lines[index]!.trim().length === 0
  // 안내 줄 위로 빈 줄 → 선택지 줄들 → 빈 줄 → 문항 글 줄들(위는 빈 줄·`•` 진행 줄·`k of n` 줄).
  let at = footer - 1
  while (at >= 0 && blank(at)) at -= 1
  const optionLines: string[] = []
  while (at >= 0 && option.test(lines[at]!)) optionLines.unshift(lines[at--]!)
  if (optionLines.length === 0) return { kind: 'none' }
  const options = optionLines.map((line) => option.exec(line)!)
  if (options.some((match, index) => Number(match[1]) !== index + 1)) return { kind: 'none' }
  while (at >= 0 && blank(at)) at -= 1
  const titleLines: string[] = []
  const counterLine = /^\s*(\d+) of (\d+)\s*$/
  while (at >= 0 && !blank(at) && !/^\s*•/.test(lines[at]!) && !counterLine.test(lines[at]!)) titleLines.unshift(lines[at--]!)
  const counter = at >= 0 ? counterLine.exec(lines[at]!) : null
  const title = squash(titleLines.join(' '))
  if (title.length === 0) return { kind: 'none' }
  const labels = options.map((match) => squash(match[2]!))
  if (labels.at(-1) === 'Other') labels.pop()
  return { kind: 'question', title, options: labels, position: counter === null ? null : Number(counter[1]), total: counter === null ? null : Number(counter[2]) }
}

/**
 * Grok: 맨 아래 `┃` 상자 — 안내 줄(`… navigate …  Enter:…`, 여럿이면 앞에 `[k/n]`) 위에 `N (○) 글  설명` 선택지와 `z` 직접 입력 행,
 * 그 위 문항 글.
 */
function grokQuestion(lines: string[]): ActiveQuestion {
  const inner = (line: string): string | null => {
    const match = /^\s*┃(.*)$/.exec(line)
    return match === null ? null : match[1]!
  }
  const footer = lastIndex(lines, (line) => inner(line) !== null && /navigate\b.*Enter:/.test(line))
  if (footer < 0) return { kind: 'none' }
  let top = footer
  while (top > 0 && inner(lines[top - 1]!) !== null) top -= 1
  const box = lines.slice(top, footer).map((line) => inner(line)!).filter((line) => line.trim().length > 0)
  const option = /^\s*(\d+|z) [([][ ○●✔x][)\]]\s+(.*)$/
  const first = box.findIndex((line) => option.test(line))
  if (first <= 0) return { kind: 'none' }
  const title = squash(box.slice(0, first).join(' '))
  const options: string[] = []
  for (const line of box.slice(first)) {
    const match = option.exec(line)
    if (match === null) return { kind: 'none' }
    if (match[1] === 'z') continue
    if (Number(match[1]) !== options.length + 1) return { kind: 'none' }
    options.push(squash(match[2]!.split(/\s{2,}/)[0]!))
  }
  const counter = /\[(\d+)\/(\d+)\]/.exec(lines[footer]!)
  return { kind: 'question', title, options, position: counter === null ? null : Number(counter[1]), total: counter === null ? null : Number(counter[2]) }
}

/**
 * 활성 질문 영역이 기록의 그 문항인가 — 문항 글 전체와 선택지 글 전부가 같고(공백만 무시), 위치가 보이면 그 위치까지 같아야 한다.
 * 앞부분 포함·화면 아무 곳 포함은 세지 않는다(R2-A1).
 */
export function sameQuestion(input: { active: ActiveQuestion; question: { question: string; options: string[] }; index: number; total: number }): boolean {
  const { active, question } = input
  if (active.kind !== 'question') return false
  if (active.position !== null && (active.position !== input.index + 1 || active.total !== input.total)) return false
  const key = (text: string): string => text.replace(/[\s\u00a0]+/g, '')
  if (key(active.title) !== key(question.question)) return false
  return active.options.length === question.options.length && active.options.every((label, index) => key(label) === key(question.options[index]!))
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
        // 확장 색(38·48·58 + `;5;n` 256색 · `;2;r;g;b` truecolor)은 뒤 인자까지 한 묶음으로 먹는다 — 그 안의 `2` 는 흐림이 아니다(R1-A9).
        for (let at = 0; at < params.length; at += 1) {
          const param = params[at]
          if (param === '38' || param === '48' || param === '58') {
            const mode = params[at + 1]
            at += mode === '5' ? 2 : mode === '2' ? 4 : 1
          } else if (param === '0' || param === '') dim = false
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

/** 보이는 화면(ANSI)의 글만 — 줄 순서 그대로(R1-A2 질문 화면 대조). */
export const screenPlain = (screen: string): string => screen.split(/\r?\n/).map((line) => plainOf(runsOf(line))).join('\n')
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
