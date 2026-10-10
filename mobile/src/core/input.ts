// 폰 쓰기 (LIFE-582) — 서버 `input.state` 의 앱 쪽 사본 + 화면 규칙(Composer 상태표 · 중단 버튼 · 질문 잠금 · 보낸 지시 자리). RN 을 모른다.
// 정본은 `app/src/main/mobile/SURFACE.md` 「쓰기」. 키 표는 서버(`keys.ts`)에만 있다 — 앱은 「몇 번째 선택지 / 직접 입력 글」 만 보낸다.
import type { ChatItem, ChatQuestion } from './chat'
import type { ConnState } from './connection'
import type { AgentKind, Channel } from './list'

export type InputOp = 'send' | 'answer' | 'stop'
export type InputState = 'queued' | 'sending' | 'delivered' | 'unconfirmed' | 'failed' | 'cancelled' | 'stopped' | 'unknown'
export type InputWait = 'turn' | 'gate'

/** `text` — 복구 조회(`input.pending`) 답에만 실리는 지시 본문(R1-A8). */
export type InputStateMessage = { id: string; channel: string | null; op: InputOp | null; state: InputState; wait: InputWait | null; reason: string | null; at: number | null; text: string | null }

/** 본문 상한(UTF-8 바이트) — 서버·CLI 와 같다(P7). */
export const MAX_INPUT_BYTES = 65536
/** 이보다 긴 붙여넣기는 칩으로(C14). */
export const PASTE_CHIP_CHARS = 1000
/** 서버 확인 없이 `보내는 중` 으로 둘 최대 시간 — 지나면 조회(P6ⓒ). */
export const SENDING_QUERY_MS = 20_000
/** 조회에도 답이 없으면 「확인하지 못했습니다」(P6ⓒ — 30초 안). */
export const SENDING_GIVEUP_MS = 30_000

const STATES: readonly InputState[] = ['queued', 'sending', 'delivered', 'unconfirmed', 'failed', 'cancelled', 'stopped', 'unknown']
const OPS: readonly InputOp[] = ['send', 'answer', 'stop']
const WAITS: readonly InputWait[] = ['turn', 'gate']

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  for (const item of allowed) if (item === value) return item
  return null
}

/** `input.state` 읽기 — id·state 가 틀리면 null. */
export function parseInputState(value: Record<string, unknown>): InputStateMessage | null {
  const id = typeof value.id === 'string' ? value.id : null
  const state = pick(value.state, STATES)
  if (id === null || state === null) return null
  return {
    id,
    channel: typeof value.channel === 'string' ? value.channel : null,
    op: pick(value.op, OPS),
    state,
    wait: pick(value.wait, WAITS),
    reason: typeof value.reason === 'string' ? value.reason : null,
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : null,
    text: typeof value.text === 'string' ? value.text : null,
  }
}

/** UTF-8 바이트 수 — RN 에 Buffer 가 없어 직접 센다. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** 메시지 id — 서버 규칙 `[A-Za-z0-9_-]{8,64}`. */
export function newInputId(input: { now: number; random: () => number }): string {
  let tail = ''
  for (let index = 0; index < 10; index += 1) tail += Math.floor(input.random() * 36).toString(36)
  return `m${input.now.toString(36)}-${tail}`
}

// --- 질문 ---------------------------------------------------------------------------------------------

/** 대화의 지금 열린 질문 — 기록의 **마지막 대기 질문**(서버도 이것만 받는다). */
export function openQuestion(items: readonly ChatItem[]): Extract<ChatItem, { kind: 'question' }> | null {
  let last: Extract<ChatItem, { kind: 'question' }> | null = null
  for (const item of items) if (item.kind === 'question' && item.state === 'pending') last = item
  return last
}

/** 서버 `answerLock` 과 같은 규칙 — 폰에서 답할 수 없는 질문(선택지 9개 이상 · Claude 아닌 multiSelect · 문항 없음 · 서버가 덜어 냄). */
export function questionLocked(input: { kind: AgentKind | null; item: Extract<ChatItem, { kind: 'question' }> }): boolean {
  const { kind, item } = input
  if (kind === null || item.clipped || item.questions.length === 0) return true
  for (const question of item.questions) {
    if (question.options.length < 1 || question.options.length + 1 > 9) return true
    if (question.multiSelect === true && kind !== 'claude') return true
  }
  return false
}

/** 직접 입력 허용(R2) — Claude preview 레이아웃만 막힌다(Codex `Other` · Grok `z` 는 실측으로 있다). */
export function otherAllowed(input: { kind: AgentKind | null; question: ChatQuestion }): boolean {
  return !(input.kind === 'claude' && input.question.preview)
}

export type StepAnswer = { choices: number[]; other: string | null }

/** 한 문항의 답이 보낼 수 있는 모양인가 — 하나 고르기는 정확히 하나, 여럿은 하나 이상. */
export function stepReady(input: { question: ChatQuestion; answer: StepAnswer }): boolean {
  const count = input.answer.choices.length + (input.answer.other === null ? 0 : 1)
  return input.question.multiSelect === true ? count >= 1 : count === 1
}

/** 직접 입력으로 문항 하나를 채운다 — 하나 고르기는 직접 입력만, 여럿은 고른 것에 더한다. */
export function withOther(input: { question: ChatQuestion; answer: StepAnswer; text: string }): StepAnswer {
  return { choices: input.question.multiSelect === true ? input.answer.choices : [], other: input.text }
}

/** 선택지 누름 — 하나 고르기는 바꿔 끼우고(직접 입력은 지운다), 여럿은 토글. */
export function toggleChoice(input: { question: ChatQuestion; answer: StepAnswer; choice: number }): StepAnswer {
  const { question, answer, choice } = input
  if (question.multiSelect !== true) return { choices: [choice], other: null }
  const has = answer.choices.includes(choice)
  return { choices: has ? answer.choices.filter((item) => item !== choice) : [...answer.choices, choice].sort((a, b) => a - b), other: answer.other }
}

// --- Composer 상태표 (design-handoff §2 Composer 8행) ------------------------------------------------

export type ConnKind = 'connected' | 'checking' | 'reconnecting' | 'offline' | 'mismatch'

/** 연결 상태 → 입력 규칙의 다섯 갈래. 재연결 중이 끊김(`offline`)으로 넘어가면 끊김 행(C18)이다. */
export function connKind(conn: ConnState): ConnKind {
  switch (conn.kind) {
    case 'connected':
      return 'connected'
    case 'checking':
      return 'checking'
    case 'reconnecting':
      return conn.offline ? 'offline' : 'reconnecting'
    case 'mismatch':
      return 'mismatch'
    case 'loading':
    case 'unpaired':
    case 'unpairing':
    case 'unpair_failed':
      return 'offline'
  }
}

export type ComposerMode =
  /** 입력창 없이 안내 줄 56(닫힘). */
  | { kind: 'closed' }
  | { kind: 'open'; target: 'send' | 'answer'; placeholder: string; note: string | null }
  /** 잠김 — `keep` 이면 쓴 글을 그대로 둔다(재연결 중, C17). */
  | { kind: 'locked'; placeholder: string; note: string | null; keep: boolean }

export function composerMode(input: {
  channel: Channel
  conn: ConnKind
  /** 목록 실패 — 지금 상태를 믿을 수 없다. */
  unknown: boolean
  question: Extract<ChatItem, { kind: 'question' }> | null
  /** 지금 답하는 문항(여러 문항이면 단계). */
  step: number
  /** 대화가 세션 참조를 아직 못 찾는다(Codex 첫 지시 전 등). */
  noSession: boolean
}): ComposerMode {
  const { channel, conn, question } = input
  if (channel.status === 'closed') return { kind: 'closed' }
  if (conn === 'reconnecting' || conn === 'checking') return { kind: 'locked', placeholder: '지시 보내기', note: '연결되면 보낼 수 있습니다', keep: true }
  if (conn !== 'connected' || input.unknown) return { kind: 'locked', placeholder: '연결이 끊겨 보낼 수 없음', note: null, keep: true }
  if (channel.kind === null) return { kind: 'locked', placeholder: 'AI 세션에만 보낼 수 있음', note: null, keep: true }
  if (input.noSession) return { kind: 'locked', placeholder: '맥에서 첫 지시를 보낸 뒤 쓸 수 있음', note: null, keep: true }
  if (question !== null) {
    if (questionLocked({ kind: channel.kind, item: question })) return { kind: 'locked', placeholder: '맥에서 답해 주세요', note: null, keep: true }
    const current = question.questions[Math.min(input.step, question.questions.length - 1)]
    if (current !== undefined && otherAllowed({ kind: channel.kind, question: current })) return { kind: 'open', target: 'answer', placeholder: '선택지 밖 답을 직접 쓰기', note: null }
    return { kind: 'locked', placeholder: '선택지로 답해 주세요', note: null, keep: true }
  }
  if (channel.waiting === 'approval') return { kind: 'locked', placeholder: '맥에서 승인할 때까지 보낼 수 없음', note: null, keep: true }
  if (channel.waiting === 'login' || channel.waiting === 'other') return { kind: 'locked', placeholder: '맥에서 처리할 때까지 보낼 수 없음', note: null, keep: true }
  if (channel.dot === 'working') return { kind: 'open', target: 'send', placeholder: '지시 보내기 — 이 턴이 끝나면 들어갑니다', note: null }
  // 백그라운드가 남으면 herdr 는 작업 중으로 보고 큐는 그것이 끝날 때까지 기다린다(Z1ⓓ, C2 — 문구 후보는 RESULT r1, 게이트 ① 에서 확정).
  if (channel.dot === 'monitoring') return { kind: 'open', target: 'send', placeholder: '지시 보내기 — 백그라운드 작업까지 끝나면 들어갑니다', note: null }
  return { kind: 'open', target: 'send', placeholder: '지시 보내기', note: null }
}

/** 보내기 버튼 — 글이 있고 상한 안이어야. 넘으면 남은(넘친) 바이트를 보인다(P7). */
export function sendGate(input: { mode: ComposerMode; body: string }): { enabled: boolean; over: number } {
  const bytes = utf8Bytes(input.body)
  const over = Math.max(0, bytes - MAX_INPUT_BYTES)
  const enabled = input.mode.kind === 'open' && input.body.trim().length > 0 && over === 0
  return { enabled, over }
}

// --- 중단 버튼 (StopButton 4상태 · P5) -----------------------------------------------------------------

export type StopView = 'hidden' | 'enabled' | 'disabled'

/**
 * 보이는 조건: 작업 중 · 지켜보는 중 · 질문 대기 · 권한 대기(서버 `stopAllowed` 와 같다). Grok 의 질문 대기는 숨긴다(Ctrl+C 가 질문만 거절 — Z1ⓒ),
 * 로그인·기타 대기는 숨긴다(실측 없음). 연결이 없거나 상태를 믿을 수 없으면 흐린 비활성.
 */
export function stopView(input: { channel: Channel; conn: ConnKind; unknown: boolean }): StopView {
  const { channel } = input
  if (channel.status !== 'live' || channel.kind === null) return 'hidden'
  let visible = false
  if (channel.waiting === 'approval') visible = true
  else if (channel.waiting === 'question') visible = channel.kind !== 'grok'
  else if (channel.waiting === null) visible = channel.dot === 'working' || channel.dot === 'monitoring'
  if (!visible) return 'hidden'
  return input.conn === 'connected' && !input.unknown ? 'enabled' : 'disabled'
}

/** 두 번 누름 — 첫 누름에 장전, 이 안에 다시 누르면 중단(Q8). */
export const STOP_ARM_MS = 3_000

// --- 보낸 지시 (C12) ----------------------------------------------------------------------------------

export type SentEntry = {
  id: string
  channel: string
  op: InputOp
  /** 지시 본문(보낸 그대로) — 「다시 보내기」·말풍선. 답·중단은 null. */
  text: string | null
  state: InputState
  wait: InputWait | null
  reason: string | null
  /** 서버가 이 id 를 받았다고 한 번이라도 답했나. */
  acked: boolean
  sentAt: number
  at: number
  /** 보낼 때 대화의 마지막 말풍선 id — 들어간 뒤 기록의 「내 지시」 를 찾는 기준. */
  tailId: number | null
  /**
   * 앱이 혼자 정한 「확인 못 함」(서버 답 없이 시간 초과 — R1-A7). 서버 결과가 아니라서 끝이 아니다 — 재연결 조회·늦은 결과로 바뀐다.
   * 이 동안 「다시 보내기」 는 없다(아직 들어가는 중일 수 있다 — 같은 글이 두 번 들어간다).
   */
  provisional: boolean
}

export const FINAL_STATES: ReadonlySet<InputState> = new Set(['delivered', 'unconfirmed', 'failed', 'cancelled', 'stopped'])

/** 서버가 확정한 끝 — 앱 혼자 정한 「확인 못 함」(provisional)은 끝이 아니다(R1-A7). */
export const settled = (entry: SentEntry): boolean => FINAL_STATES.has(entry.state) && !entry.provisional

export type SentLine = { tone: 'muted' | 'question' | 'dim' | 'error'; text: string; action: 'cancel' | 'retry' | null; faded: boolean }

const REASON: Record<string, string> = {
  mac_draft: '맥 입력창에 쓰던 글이 있어 보내지 않았습니다',
  draft_unknown: '맥 입력창을 확인하지 못해 보내지 않았습니다',
  queue_full: '대기 중인 지시가 많아 보내지 않았습니다',
  mobile_off: '맥에서 모바일이 꺼져 보내지 않았습니다',
  closed: '세션이 닫혀 보내지 않았습니다',
  not_listed: '목록에 없는 세션입니다',
  no_session: '맥에서 첫 지시를 보낸 뒤 쓸 수 있습니다',
  unmanaged: '맥 셸에서 직접 띄운 세션이라 폰에서 지시할 수 없습니다 — 맥에서 새 탭으로 띄운 세션을 써 주세요',
  not_ready: '맥이 아직 세션을 읽지 못했습니다',
  empty: '보낼 글이 없습니다',
  offline: '연결이 없어 보내지 않았습니다',
  backend: '맥의 터미널 연결이 실패했습니다',
  record_missing: '대화 기록에서 찾지 못했습니다 — 대화에서 확인해 주세요',
  record_ambiguous: '대화 기록에서 같은 글을 둘 이상 찾았습니다 — 대화에서 확인해 주세요',
  record_rewritten: '대화 기록이 다시 쓰였습니다 — 대화에서 확인해 주세요',
  no_reply: '맥이 아직 답하지 않았습니다 — 연결되면 다시 확인합니다',
  unknown: '맥이 이 지시를 모릅니다(맥 앱이 다시 시작됨)',
  expired: '맥이 이 지시를 더 기억하지 않습니다',
  revoked: '이 기기의 연결이 해지되었습니다',
  target_changed: '그 사이 세션이 바뀌어 보내지 않았습니다',
  guard_outdated: '맥의 터미널 백엔드가 오래되어 보내지 않았습니다',
}

export function reasonText(reason: string | null): string | null {
  return reason === null ? null : (REASON[reason] ?? null)
}

/**
 * 말풍선 아래 상태 한 줄(design-handoff §1 Q7 · P6ⓒ 「확인하지 못했습니다」 변형). `monitoring` = 그 채널이 백그라운드 작업을 지켜보는 중 —
 * 큐는 그것까지 끝나야 넣는다(C2).
 */
export function sentLine(input: { entry: SentEntry; hhmm: (at: number) => string; monitoring?: boolean }): SentLine | null {
  const { entry } = input
  switch (entry.state) {
    case 'sending':
      return { tone: 'muted', text: '보내는 중…', action: null, faded: true }
    case 'queued': {
      const wait = input.monitoring === true ? '대기 중 · 백그라운드 작업까지 끝나면 들어갑니다' : '대기 중 · 이 턴이 끝나면 들어갑니다'
      return { tone: 'question', text: entry.acked ? wait : '보내는 중…', action: entry.acked ? 'cancel' : null, faded: !entry.acked }
    }
    case 'delivered':
      return { tone: 'dim', text: `들어감 ✓ ${input.hhmm(entry.at)}`, action: null, faded: false }
    case 'failed': {
      const why = reasonText(entry.reason)
      return { tone: 'error', text: why === null ? '보내지 못했습니다' : `보내지 못했습니다 · ${why}`, action: 'retry', faded: false }
    }
    case 'unconfirmed': {
      const why = reasonText(entry.reason)
      return { tone: 'error', text: why === null ? '들어갔는지 확인하지 못했습니다 — 대화에서 확인해 주세요' : `들어갔는지 확인하지 못했습니다 · ${why}`, action: entry.provisional ? null : 'retry', faded: false }
    }
    case 'cancelled':
    case 'stopped':
    case 'unknown':
      return null
  }
}

/** 공백 정리 — 기록의 「내 지시」 와 보낸 글을 맞춰 본다(서버가 경로를 가리면 안 맞을 수 있다 — 그때는 따로 보인다). */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * 보낸 지시를 어디에 그리나 — 들어간 지시는 기록에 「내 지시」 로 보이므로, 보낸 뒤 생긴 같은 글의 지시 말풍선을 찾으면 그 아래에 상태 줄만 붙인다.
 * 못 찾으면(아직 안 들어감·실패·확인 못 함) 대화 끝에 따로 그린다. 한 지시 말풍선에는 한 항목만.
 */
export function placeSent(input: { items: readonly ChatItem[]; sent: readonly SentEntry[] }): { attached: Map<number, SentEntry>; trailing: SentEntry[] } {
  const attached = new Map<number, SentEntry>()
  const trailing: SentEntry[] = []
  for (const entry of input.sent) {
    if (entry.op !== 'send' || entry.text === null || entry.state === 'cancelled') continue
    const want = squash(entry.text)
    const match = entry.state === 'delivered' || entry.state === 'unconfirmed'
      ? input.items.find((item) => item.kind === 'prompt' && (entry.tailId === null || item.id > entry.tailId) && !attached.has(item.id) && squash(item.body.text) === want)
      : undefined
    if (match !== undefined) attached.set(match.id, entry)
    else trailing.push(entry)
  }
  return { attached, trailing }
}

/** 중단 결과 한 줄(C10 문구 후보 A — 게이트 ① 에서 코디가 고른다). 진행 중이면 `멈추는 중…`. */
export function stopLine(entry: SentEntry): { tone: 'muted' | 'dim' | 'error'; text: string } | null {
  switch (entry.state) {
    case 'queued':
    case 'sending':
      return { tone: 'muted', text: '멈추는 중…' }
    case 'stopped':
      return { tone: 'dim', text: '턴을 멈췄습니다 · 백그라운드는 계속 돕니다' }
    case 'failed':
      return { tone: 'error', text: STOP_REASON[entry.reason ?? ''] ?? '멈추지 못했습니다' }
    case 'unconfirmed':
      return { tone: 'error', text: entry.reason === 'still_running' ? '멈췄는지 확인하지 못했습니다 — 아직 작업 중으로 보입니다' : '멈췄는지 확인하지 못했습니다' }
    case 'delivered':
    case 'cancelled':
    case 'unknown':
      return null
  }
}

const STOP_REASON: Record<string, string> = {
  not_running: '이미 멈춰 있습니다',
  stop_hidden: '이 대기에서는 맥에서 멈춰 주세요',
  mac_draft: '맥 입력창에 쓰던 글이 있어 멈추지 못했습니다',
  state_changed: '그 사이 상태가 바뀌어 멈추지 않았습니다',
  busy: '다른 요청을 처리하는 중이라 멈추지 않았습니다',
  closed: '세션이 닫혔습니다',
  offline: '연결이 없어 멈추지 못했습니다',
}

/** 질문 답 결과 한 줄 — 보내는 동안·실패만(들어가면 질문 카드가 「답함」 으로 바뀐다). */
export function answerLine(entry: SentEntry): { tone: 'muted' | 'error'; text: string } | null {
  switch (entry.state) {
    case 'queued':
    case 'sending':
      return { tone: 'muted', text: '답을 보내는 중…' }
    case 'failed':
      return { tone: 'error', text: ANSWER_REASON[entry.reason ?? ''] ?? '답을 보내지 못했습니다' }
    case 'unconfirmed':
      // 기록의 답 값이 고른 답과 다름(LIFE-582 R3-A1) — 맥에서 먼저 고른 칸이 섞였을 수 있다.
      if (entry.reason === 'answer_mismatch') return { tone: 'error', text: '기록된 답이 고른 답과 다릅니다 — 맥에서 확인해 주세요' }
      return { tone: 'error', text: '답이 들어갔는지 확인하지 못했습니다 — 대화에서 확인해 주세요' }
    case 'delivered':
    case 'cancelled':
    case 'stopped':
    case 'unknown':
      return null
  }
}

const ANSWER_REASON: Record<string, string> = {
  question_closed: '질문이 이미 닫혔습니다',
  question_changed: '그 사이 질문이 바뀌어 답하지 않았습니다',
  question_locked: '이 질문은 맥에서 답해 주세요',
  question_in_progress: '맥에서 이미 고르는 중이라 보내지 않았습니다 — 맥에서 답해 주세요',
  other_locked: '이 질문은 직접 입력을 받지 않습니다',
  bad_answer: '답 모양이 맞지 않습니다',
  busy: '다른 요청을 처리하는 중입니다',
  offline: '연결이 없어 보내지 않았습니다',
}
