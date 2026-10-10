// 폰 → 맥 쓰기 (LIFE-582 P1~P9) — 지시 보내기 · 큐 취소 · 상태 조회 · 질문 답 · 중단. electron·소켓을 모른다(시험이 가짜 백엔드로 돈다).
//
// - **메시지 id 당 많아야 한 번**(P2): (기기, id) 로 기억한다. 같은 id 가 다시 오면(재연결 뒤 재전송·조회) 다시 넣지 않고 지금 상태만 돌려준다.
//   같은 글이라도 새 id 면 새 지시다 — `prompt_already_delivered`(기록 전체 같은 글 거절)는 쓰지 않는다.
// - **「들어감」 = 이 제출 직전 커서 뒤 기록 매칭 정확히 1건**(`countSubmissions` — CLI `terminal prompt` 와 같은 대조). 0건·2건 이상·커서 무효는
//   `unconfirmed`(확인하지 못했습니다) — 들어감으로 올리지 않는다(P6ⓓ). 다시 넣지도 않는다.
// - **채널별 큐**(P3): 순서대로 한 건씩. 에이전트가 준비 관문(750 ms 두 관측 · 같은 seq · detect manifest 확인 — CLI 와 같은 관문)을 통과해야 넣는다.
//   관문 통과 = 턴이 끝났다는 뜻이라 턴 안에 끼어들지 않는다. 넣기는 guard 의 compare-and-submit(`agent.prompt` + 관측한 seq)이라 그 사이 전이가 있으면
//   아무것도 쓰지 않고 거절된다 — 그때는 큐에 그대로 두고 다시 기다린다. 취소는 넣기 시작 전(`queued`)만.
//   모바일 끔·종료·채널 사라짐이면 큐의 지시는 `failed` — 나중에 저절로 들어가지 않는다(`stop` 뒤에는 넣지 않는다).
// - **맥 입력창 초안**(P9): 넣기 직전 보이는 화면의 입력 줄이 비었는지 본다(`keys.ts draftState`). 글이 있거나 판단 못 하면 넣지 않고 실패.
// - **질문 답**(P4): 폰은 어느 질문(기록의 질문 말풍선 id)에 어떤 답인지만 보낸다. 서버가 지금 그 질문이 기록에서 아직 열려 있고(마지막 대기 질문)
//   herdr 가 `blocked` 일 때만, provider 키 순서(`answerSteps`)를 단계마다 「관측한 seq 그대로일 때만」(guard 비교) 넣는다. 들어감 = 그 질문이 기록에서 답함.
// - **중단**(P5): 그 순간 상태를 다시 관측해 작업 중·(허용된) 대기일 때만 provider 키 1회 — 역시 seq 비교. 재시도 없음. 한가면 `not_running`.
//   멈춤 = 상태가 working·blocked 를 떠남 또는 기록의 그 턴 `interrupted`(백그라운드가 있으면 herdr 는 working 에 남는다 — Z1ⓓ).
// - 본문은 로그에 남기지 않는다(길이·해시 앞 8자만). 끝난 지시의 본문은 메모리에서도 버린다.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { TerminalIdentity } from '../adapter/index.js'
import { bodyIdentity, captureCursor, countSubmissions, normalizeBody, type CursorEntry } from '../../runtime/terminal/agent.js'
import { parseGrokUpdates, parseTail } from '../transcript-parse.js'
import type { ChatItem } from '../chat-parse.js'
import {
  answerSteps,
  cleanAnswerText,
  cleanBody,
  draftState,
  MAX_ANSWER_TEXT,
  stopAllowed,
  stopKey,
  stopNeedsEmptyInput,
  type QuestionAnswer,
} from './keys.js'
import { buildMobileList, chatChannel, type ChatChannel, type ListInput, type MobileAgentKind, type MobileChannel } from './list.js'

export type InputOp = 'send' | 'answer' | 'stop'
/**
 * 지시·답·중단의 상태(폰 C12 4상태 + 확인 못 함):
 * `queued`(서버가 받음 — 관문을 기다림, 취소 가능) · `sending`(넣는 중 — 취소 불가) · `delivered`(기록 1건 확인) · `unconfirmed`(넣었거나 넣었을 수 있는데
 * 기록으로 확정 못 함) · `failed`(넣지 않았다) · `cancelled` · `stopped`(중단 확인) · `unknown`(서버가 모르는 id — 앱 재시작 등).
 */
export type InputState = 'queued' | 'sending' | 'delivered' | 'unconfirmed' | 'failed' | 'cancelled' | 'stopped' | 'unknown'
/** `queued` 의 기다림 — `turn` = 에이전트가 작업 중·대기 중(이 턴이 끝나면) · `gate` = 곧 넣는다(관문 확인 중). */
export type InputWait = 'turn' | 'gate'

export type InputWire = { type: 'input.state'; id: string; channel: string | null; op: InputOp | null; state: InputState; wait: InputWait | null; reason: string | null; at: number }

/** 채널당 큐 상한(P3 ≥ 3). 넘으면 `queue_full`. */
export const INPUT_QUEUE_MAX = 5
/** 기기당 기억하는 id 수 — 넘으면 끝난 것부터 버린다(버린 id 는 `unknown`). */
export const INPUT_IDS_MAX = 500

export type InputTiming = {
  /** 큐가 관문을 다시 보는 주기. */
  pollMs: number
  /** 준비 관문 두 관측 사이(CLI `READY_SAMPLE_INTERVAL_MS` 와 같다). */
  gateMs: number
  /** 지시를 넣은 뒤 기록에서 1건을 기다리는 시간. 넘으면 `unconfirmed`. */
  confirmMs: number
  /** 기록 확인 주기. */
  recordPollMs: number
  /** 질문 답 키 단계 사이(Z1 실측 300~500 ms). */
  stepGapMs: number
  /** 질문 답 뒤 기록에서 답함을 기다리는 시간. */
  answerConfirmMs: number
  /** 중단 뒤 멈춤을 기다리는 시간(Z5ⓐ ≤ 5초). */
  stopConfirmMs: number
}
export const INPUT_TIMING: InputTiming = { pollMs: 1000, gateMs: 750, confirmMs: 15_000, recordPollMs: 250, stepGapMs: 350, answerConfirmMs: 10_000, stopConfirmMs: 5_000 }

/**
 * `unmanaged` = herdr 가 그 pane 을 관리 에이전트로 띄우지 않았다(셸에서 직접 친 `claude` 등) — 한가해도 `interactive_ready` 가 켜지지 않아
 * guard 의 `agent.prompt` 관문을 영영 못 넘는다(격리 빠른 확인 q13). 데스크톱 GUI·하네스는 `agent.start` 로 띄워 관리된다.
 */
export type PaneObservation = { status: string; seq: number; quiet: boolean; unmanaged: boolean }
export type SendResult = 'sent' | 'refused' | 'unknown'

/** herdr 쪽 — 실제는 `input-backend.ts`(guard 봉투), 시험은 가짜. */
export interface InputBackend {
  /** 지금 그 pane(세대 포함). 없으면 null. */
  locate(paneId: string): Promise<TerminalIdentity | null>
  /** 에이전트 상태 한 번. 에이전트가 없으면 status `none`. */
  observe(pane: TerminalIdentity): Promise<PaneObservation>
  /** detect manifest 확인(CLI 와 같은 fail-closed — 신뢰 대화상자가 한가로 보일 수 있다). */
  manifestVerified(kind: MobileAgentKind): Promise<boolean>
  /** 보이는 화면(ANSI). */
  screen(pane: TerminalIdentity): Promise<string>
  /** guard `agent.prompt` — 관측한 seq 그대로일 때만. `refused` = 아무것도 쓰지 않았다. */
  prompt(pane: TerminalIdentity, text: string, seq: number): Promise<SendResult>
  /** guard `pane.send_text` + 관측한 seq 비교. `refused` = 아무것도 쓰지 않았다. */
  send(pane: TerminalIdentity, text: string, seq: number): Promise<SendResult>
}

export type InputHubDeps = {
  read: () => ListInput | null
  backend: () => InputBackend | null
  /** 채널 → 기록 파일(대화와 같은 파일 — Grok 은 `updates.jsonl`). */
  resolveFile: (channel: ChatChannel) => string | null
  /**
   * 기록 파일이 **아직 없을 때** 그 세션이 쓸 경로 — 새 Claude·Grok 세션은 첫 지시 뒤에 파일이 생긴다(격리 빠른 확인 q10).
   * CLI 와 같은 규칙(`sessionRecordPaths` — pane 의 cwd + 세션 id). 없으면(Codex 등) null — 그때는 기다린다.
   */
  expectedFile?: (input: { channel: ChatChannel; cwd: string }) => string | null
  /** 그 기록의 말풍선(열린 대화의 판독자) — 질문 확인용. 판독자가 없으면 null. */
  questionItems: (file: string) => readonly ChatItem[] | null
  log: (tag: string, fields?: Record<string, unknown>) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  readFile?: (file: string) => string | null
  timing?: Partial<InputTiming>
}

type Entry = {
  device: string
  id: string
  channel: string
  op: InputOp
  state: InputState
  wait: InputWait | null
  reason: string | null
  at: number
  order: number
  /** 지시 본문(정리한 것) — 끝나면 지운다. */
  text: string | null
  question: number | null
  answers: QuestionAnswer[] | null
}

const FINAL: ReadonlySet<InputState> = new Set(['delivered', 'unconfirmed', 'failed', 'cancelled', 'stopped'])
const defaultRead = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8)

/** 폰이 보낸 질문 답 한 문항 — 모양은 프로토콜이 이미 걸렀다. 직접 입력 글은 여기서 한 줄로 정리한다. */
export function cleanAnswers(raw: { choices: number[]; other: string | null }[]): QuestionAnswer[] | null {
  const out: QuestionAnswer[] = []
  for (const answer of raw) {
    const other = answer.other === null ? null : cleanAnswerText(answer.other)
    if (other !== null && (other.length === 0 || other.length > MAX_ANSWER_TEXT)) return null
    out.push({ choices: [...answer.choices], other })
  }
  return out
}

export class InputHub {
  private readonly deps: InputHubDeps
  private readonly timing: InputTiming
  private readonly entries = new Map<string, Entry>()
  private readonly sinks = new Map<string, (text: string) => void>()
  private readonly pumps = new Set<string>()
  private readonly busy = new Set<string>()
  private order = 0
  private stopped = false

  constructor(deps: InputHubDeps) {
    this.deps = deps
    this.timing = { ...INPUT_TIMING, ...deps.timing }
  }

  /** 기기의 지금 연결 — 상태 변화는 그 기기의 마지막으로 붙은 연결로 간다. 돌려준 함수로 뗀다(그 연결이 아직 주인일 때만). */
  attach(input: { device: string; sink: (text: string) => void }): () => void {
    this.sinks.set(input.device, input.sink)
    return () => {
      if (this.sinks.get(input.device) === input.sink) this.sinks.delete(input.device)
    }
  }

  /** 모바일 켬 — 끈 동안 실패로 끝난 것은 그대로 기억한다(조회하면 실패). */
  start(): void {
    this.stopped = false
  }

  /** 모바일 끔·종료(P3) — 큐의 지시는 실패로 끝낸다. 진행 중인 확인은 끝까지 가지만 새로 넣지는 않는다. 기억한 id 는 남긴다(조회용). */
  stop(): void {
    this.stopped = true
    for (const entry of this.entries.values()) {
      if (entry.state === 'queued') this.settle(entry, 'failed', 'mobile_off')
    }
  }

  /** 시험·계측 — 그 채널의 큐 길이. */
  queued(channel: string): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.channel === channel && entry.op === 'send' && entry.state === 'queued') count += 1
    return count
  }

  // --- 폰 메시지 ---

  send(input: { device: string; id: string; channel: string; text: string }): void {
    if (this.repeat(input)) return
    const text = cleanBody(input.text)
    const entry = this.add({ device: input.device, id: input.id, channel: input.channel, op: 'send', text, question: null, answers: null })
    this.deps.log('mobile.input_send', { bytes: Buffer.byteLength(text), sha: short(normalizeBody(text)) })
    if (this.stopped) return this.settle(entry, 'failed', 'mobile_off')
    if (normalizeBody(text).length === 0) return this.settle(entry, 'failed', 'empty')
    const located = this.locate(input.channel)
    if (!located.ok) return this.settle(entry, 'failed', located.reason)
    if (this.queued(input.channel) > INPUT_QUEUE_MAX) return this.settle(entry, 'failed', 'queue_full')
    this.emit(entry)
    void this.pump(input.channel)
  }

  cancel(input: { device: string; id: string }): void {
    const entry = this.entries.get(this.key(input))
    if (entry === undefined) return this.emitUnknown(input)
    if (entry.state === 'queued') return this.settle(entry, 'cancelled', null)
    this.emit(entry)
  }

  status(input: { device: string; ids: string[] }): void {
    for (const id of input.ids) {
      const entry = this.entries.get(this.key({ device: input.device, id }))
      if (entry === undefined) this.emitUnknown({ device: input.device, id })
      else this.emit(entry)
    }
  }

  answer(input: { device: string; id: string; channel: string; question: number; answers: { choices: number[]; other: string | null }[] }): void {
    if (this.repeat(input)) return
    const answers = cleanAnswers(input.answers)
    const entry = this.add({ device: input.device, id: input.id, channel: input.channel, op: 'answer', text: null, question: input.question, answers })
    this.deps.log('mobile.input_answer', { questions: input.answers.length })
    if (this.stopped) return this.settle(entry, 'failed', 'mobile_off')
    if (answers === null) return this.settle(entry, 'failed', 'bad_answer')
    void this.exclusive(entry, () => this.runAnswer(entry, answers))
  }

  stopTurn(input: { device: string; id: string; channel: string }): void {
    if (this.repeat(input)) return
    const entry = this.add({ device: input.device, id: input.id, channel: input.channel, op: 'stop', text: null, question: null, answers: null })
    this.deps.log('mobile.input_stop', {})
    if (this.stopped) return this.settle(entry, 'failed', 'mobile_off')
    void this.exclusive(entry, () => this.runStop(entry))
  }

  // --- 큐 ---

  private async pump(channel: string): Promise<void> {
    if (this.pumps.has(channel)) return
    this.pumps.add(channel)
    try {
      for (;;) {
        const head = this.head(channel)
        if (head === null || this.stopped) return
        const outcome = await this.deliver(head).catch((error: unknown): 'done' => {
          this.deps.log('mobile.input_error', { op: 'send', error: String(error) })
          // 넣기 전이면 넣지 않았다 — 실패. 넣기 시작한 뒤면 들어갔을 수 있다 — 확인 못 함(다시 넣지 않는다).
          if (head.state === 'queued') this.settle(head, 'failed', 'backend')
          else if (head.state === 'sending') this.settle(head, 'unconfirmed', 'backend')
          return 'done'
        })
        if (outcome === 'wait') await this.sleep(this.timing.pollMs)
      }
    } finally {
      this.pumps.delete(channel)
    }
  }

  private head(channel: string): Entry | null {
    let first: Entry | null = null
    for (const entry of this.entries.values()) {
      if (entry.channel !== channel || entry.op !== 'send' || entry.state !== 'queued') continue
      if (first === null || entry.order < first.order) first = entry
    }
    return first
  }

  /** 큐 머리 한 건 — 관문을 못 넘으면 `wait`, 끝났으면(들어감·실패·확인 못 함) `done`. */
  private async deliver(entry: Entry): Promise<'wait' | 'done'> {
    const located = this.locate(entry.channel)
    if (!located.ok) {
      if (located.reason === 'not_ready') return 'wait'
      this.settle(entry, 'failed', located.reason === 'not_listed' ? 'closed' : located.reason)
      return 'done'
    }
    const { channel, kind } = located
    const backend = this.deps.backend()
    if (backend === null) return 'wait'
    const pane = await backend.locate(entry.channel)
    if (pane === null) {
      this.settle(entry, 'failed', 'closed')
      return 'done'
    }
    const file = this.deps.resolveFile(channel) ?? this.deps.expectedFile?.({ channel, cwd: pane.path }) ?? null
    if (file === null) return 'wait'
    const first = await backend.observe(pane)
    // 관리 밖 pane — 기다려도 넣을 수 없다. 대기로 두면 블랙홀이다(P1 「증명 못 하는 채널은 잠그고 안내」).
    if (first.unmanaged) {
      this.settle(entry, 'failed', 'unmanaged')
      return 'done'
    }
    if (!first.quiet) return this.waitTurn(entry, 'turn')
    this.setWait(entry, 'gate')
    await this.sleep(this.timing.gateMs)
    const second = await backend.observe(pane)
    if (!second.quiet || second.seq !== first.seq) return this.waitTurn(entry, 'turn')
    if (!(await backend.manifestVerified(kind))) return this.waitTurn(entry, 'turn')
    const draft = draftState({ kind, screen: await backend.screen(pane) })
    if (entry.state !== 'queued') return 'done'
    if (draft !== 'empty') {
      this.settle(entry, 'failed', draft === 'draft' ? 'mac_draft' : 'draft_unknown')
      return 'done'
    }
    if (this.stopped) return 'done'
    const text = entry.text ?? ''
    const read = this.deps.readFile ?? defaultRead
    const cursor = captureCursor([file], read)
    const submittedAtMs = this.now()
    // 여기서부터 취소 불가 — 넣기 시작.
    entry.state = 'sending'
    entry.wait = null
    this.emit(entry)
    const sent = await backend.prompt(pane, text, second.seq)
    if (sent === 'refused') {
      // guard 가 거절 — 아무것도 쓰지 않았다. 큐에 되돌려 다음 관문을 기다린다.
      entry.state = 'queued'
      return this.waitTurn(entry, 'turn')
    }
    await this.confirmSend({ entry, kind, file, cursor, submittedAtMs, text })
    return 'done'
  }

  private waitTurn(entry: Entry, wait: InputWait): 'wait' {
    this.setWait(entry, wait)
    return 'wait'
  }

  private setWait(entry: Entry, wait: InputWait): void {
    if (entry.state !== 'queued' || entry.wait === wait) return
    entry.wait = wait
    this.emit(entry)
  }

  private async confirmSend(input: { entry: Entry; kind: MobileAgentKind; file: string; cursor: CursorEntry[]; submittedAtMs: number; text: string }): Promise<void> {
    const { entry } = input
    const identity = bodyIdentity(input.text)
    const read = this.deps.readFile ?? defaultRead
    const deadline = this.now() + this.timing.confirmMs
    for (;;) {
      const count = countSubmissions({ kind: input.kind, files: [input.file], identity, submittedAtMs: input.submittedAtMs, cursor: input.cursor, read })
      if (count.cursorInvalidated || count.matchCount > 1) return this.settle(entry, 'unconfirmed', count.cursorInvalidated ? 'record_rewritten' : 'record_ambiguous')
      if (count.matchCount === 1) {
        this.deps.log('mobile.input_delivered', { ms: this.now() - input.submittedAtMs })
        return this.settle(entry, 'delivered', null)
      }
      if (this.now() >= deadline) return this.settle(entry, 'unconfirmed', 'record_missing')
      await this.sleep(this.timing.recordPollMs)
    }
  }

  // --- 질문 답 ---

  private async runAnswer(entry: Entry, answers: QuestionAnswer[]): Promise<void> {
    const located = this.locate(entry.channel)
    if (!located.ok) return this.settle(entry, 'failed', located.reason === 'not_listed' ? 'closed' : located.reason)
    const { channel, kind } = located
    const file = this.deps.resolveFile(channel)
    const backend = this.deps.backend()
    if (file === null || backend === null) return this.settle(entry, 'failed', 'not_ready')
    const question = this.openQuestion({ file, id: entry.question })
    if (question === null) return this.settle(entry, 'failed', 'question_closed')
    const plan = answerSteps({
      kind,
      questions: question.questions.map((q) => ({ options: q.options.length, multiSelect: q.multiSelect, preview: q.preview === true })),
      answers,
    })
    if (!plan.ok) return this.settle(entry, 'failed', plan.reason === 'bad_answer' ? 'bad_answer' : plan.reason === 'other_locked' ? 'other_locked' : 'question_locked')
    const pane = await backend.locate(entry.channel)
    if (pane === null) return this.settle(entry, 'failed', 'closed')
    const observed = await backend.observe(pane)
    if (observed.status !== 'blocked') return this.settle(entry, 'failed', 'question_closed')
    // 관측과 같은 판독 시점에 질문이 아직 열려 있는지 한 번 더 — 관측 뒤에 바뀌면 guard 의 seq 비교가 막는다.
    if (this.openQuestion({ file, id: entry.question }) === null) return this.settle(entry, 'failed', 'question_closed')
    if (this.stopped) return this.settle(entry, 'failed', 'mobile_off')
    entry.state = 'sending'
    this.emit(entry)
    for (let index = 0; index < plan.steps.length; index += 1) {
      if (index > 0) await this.sleep(this.timing.stepGapMs)
      const sent = await backend.send(pane, plan.steps[index]!, observed.seq)
      if (sent === 'refused') {
        // 첫 키 전에 바뀌었으면 아무것도 넣지 않았다. 중간이면 일부 키는 들어갔다 — 확인 못 함.
        return this.settle(entry, index === 0 ? 'failed' : 'unconfirmed', 'question_changed')
      }
      if (sent === 'unknown') return this.settle(entry, 'unconfirmed', 'backend')
    }
    const deadline = this.now() + this.timing.answerConfirmMs
    for (;;) {
      const item = this.questionItem({ file, id: entry.question })
      if (item !== null && item.state === 'answered') return this.settle(entry, 'delivered', null)
      if (item !== null && item.state === 'closed') return this.settle(entry, 'unconfirmed', 'question_declined')
      if (this.now() >= deadline) return this.settle(entry, 'unconfirmed', 'record_missing')
      await this.sleep(this.timing.recordPollMs)
    }
  }

  private questionItem(input: { file: string; id: number | null }): Extract<ChatItem, { kind: 'question' }> | null {
    const items = this.deps.questionItems(input.file)
    if (items === null || input.id === null) return null
    for (const item of items) if (item.kind === 'question' && item.id === input.id) return item
    return null
  }

  /** 그 질문이 기록에서 아직 열려 있고 **마지막 대기 질문**일 때만(뒤에 새 질문이 열렸으면 그쪽에 들어간다 — 오입력). */
  private openQuestion(input: { file: string; id: number | null }): Extract<ChatItem, { kind: 'question' }> | null {
    const items = this.deps.questionItems(input.file)
    if (items === null || input.id === null) return null
    let last: Extract<ChatItem, { kind: 'question' }> | null = null
    for (const item of items) if (item.kind === 'question' && item.state === 'pending') last = item
    return last !== null && last.id === input.id ? last : null
  }

  // --- 중단 ---

  private async runStop(entry: Entry): Promise<void> {
    const located = this.locate(entry.channel)
    if (!located.ok) return this.settle(entry, 'failed', located.reason === 'not_listed' ? 'closed' : located.reason)
    const { channel, kind, listed } = located
    const backend = this.deps.backend()
    if (backend === null) return this.settle(entry, 'failed', 'not_ready')
    const pane = await backend.locate(entry.channel)
    if (pane === null) return this.settle(entry, 'failed', 'closed')
    const observed = await backend.observe(pane)
    if (observed.status !== 'working' && observed.status !== 'blocked') return this.settle(entry, 'failed', 'not_running')
    const waiting = observed.status === 'blocked' ? (listed.waiting ?? 'other') : null
    if (!stopAllowed({ kind, waiting })) return this.settle(entry, 'failed', 'stop_hidden')
    if (stopNeedsEmptyInput(kind) && draftState({ kind, screen: await backend.screen(pane) }) !== 'empty') return this.settle(entry, 'failed', 'mac_draft')
    if (this.stopped) return this.settle(entry, 'failed', 'mobile_off')
    const file = this.deps.resolveFile(channel)
    entry.state = 'sending'
    this.emit(entry)
    const sentAt = this.now()
    const sent = await backend.send(pane, stopKey(kind), observed.seq)
    if (sent === 'refused') return this.settle(entry, 'failed', 'state_changed')
    const deadline = sentAt + this.timing.stopConfirmMs
    for (;;) {
      const now = await backend.observe(pane).catch(() => null)
      if (now !== null && now.status !== 'working' && now.status !== 'blocked') return this.settle(entry, 'stopped', null)
      if (file !== null && this.interruptedSince({ kind, file, since: sentAt })) return this.settle(entry, 'stopped', 'record')
      if (this.now() >= deadline) return this.settle(entry, 'unconfirmed', 'still_running')
      await this.sleep(this.timing.recordPollMs)
    }
  }

  /** 기록의 마지막 턴이 이 중단 뒤에 `interrupted` 로 끝났나 — 꼬리 1 MiB 만 읽는다. */
  private interruptedSince(input: { kind: MobileAgentKind; file: string; since: number }): boolean {
    let chunk: string
    let partial = false
    try {
      const size = fs.statSync(input.file).size
      const from = Math.max(0, size - 1024 * 1024)
      partial = from > 0
      const handle = fs.openSync(input.file, 'r')
      try {
        const buffer = Buffer.alloc(size - from)
        fs.readSync(handle, buffer, 0, buffer.length, from)
        chunk = buffer.toString('utf8')
      } finally {
        fs.closeSync(handle)
      }
    } catch {
      return false
    }
    const digest = input.kind === 'grok' ? parseGrokUpdates({ chunk, partial }) : parseTail({ agent: input.kind, chunk, partial, sessionId: null })
    if (digest.turnOutcome?.outcome !== 'interrupted') return false
    // 시각이 없는 결과는 이 중단의 것인지 모른다 — 세지 않는다.
    return digest.turnOutcomeAt !== null && digest.turnOutcomeAt >= input.since - 1000
  }

  // --- 공통 ---

  /** 채널 → 살아 있는 AI 채널·세션(P1·P8). 셸 pane·닫힌 세션·목록 밖은 거절, 세션 참조가 없으면 `no_session`(입력 잠금). */
  private locate(channelId: string):
    | { ok: true; channel: ChatChannel; kind: MobileAgentKind; listed: MobileChannel }
    | { ok: false; reason: 'not_listed' | 'no_session' | 'not_ready' | 'closed' } {
    const list = this.deps.read()
    if (list === null) return { ok: false, reason: 'not_ready' }
    const built = buildMobileList(list)
    if (!built.available) return { ok: false, reason: 'not_ready' }
    const listed = built.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels)).find((channel) => channel.id === channelId)
    if (listed === undefined || listed.kind === null) return { ok: false, reason: 'not_listed' }
    if (listed.status !== 'live') return { ok: false, reason: 'closed' }
    const found = chatChannel({ list, channelId })
    if (!found.ok) return found
    return { ok: true, channel: found.channel, kind: listed.kind, listed }
  }

  /** 같은 (기기, id) 가 이미 있으면 지금 상태만 다시 보낸다 — 다시 넣지 않는다(P2). */
  private repeat(input: { device: string; id: string }): boolean {
    const existing = this.entries.get(this.key(input))
    if (existing === undefined) return false
    this.emit(existing)
    return true
  }

  private add(input: { device: string; id: string; channel: string; op: InputOp; text: string | null; question: number | null; answers: QuestionAnswer[] | null }): Entry {
    const entry: Entry = { ...input, state: 'queued', wait: null, reason: null, at: this.now(), order: (this.order += 1) }
    this.entries.set(this.key(input), entry)
    this.prune(input.device)
    return entry
  }

  /** 기기당 기억 상한 — 끝난 것 중 오래된 것부터 잊는다. */
  private prune(device: string): void {
    const mine = [...this.entries.values()].filter((entry) => entry.device === device)
    if (mine.length <= INPUT_IDS_MAX) return
    const done = mine.filter((entry) => FINAL.has(entry.state)).sort((a, b) => a.order - b.order)
    for (const entry of done.slice(0, mine.length - INPUT_IDS_MAX)) this.entries.delete(this.key(entry))
  }

  /** 답·중단은 채널당 한 번에 하나 — 겹치면 뒤의 것은 넣지 않는다. */
  private async exclusive(entry: Entry, run: () => Promise<void>): Promise<void> {
    if (this.busy.has(entry.channel)) return this.settle(entry, 'failed', 'busy')
    this.busy.add(entry.channel)
    try {
      await run()
    } catch (error) {
      this.deps.log('mobile.input_error', { op: entry.op, error: String(error) })
      if (!FINAL.has(entry.state)) this.settle(entry, entry.state === 'sending' ? 'unconfirmed' : 'failed', 'backend')
    } finally {
      this.busy.delete(entry.channel)
    }
  }

  private settle(entry: Entry, state: InputState, reason: string | null): void {
    entry.state = state
    entry.wait = null
    entry.reason = reason
    entry.at = this.now()
    if (FINAL.has(state)) {
      entry.text = null
      entry.answers = null
    }
    this.deps.log('mobile.input_state', { op: entry.op, state, reason })
    this.emit(entry)
  }

  private emit(entry: Entry): void {
    const wire: InputWire = { type: 'input.state', id: entry.id, channel: entry.channel, op: entry.op, state: entry.state, wait: entry.wait, reason: entry.reason, at: entry.at }
    this.sinks.get(entry.device)?.(JSON.stringify(wire))
  }

  private emitUnknown(input: { device: string; id: string }): void {
    const wire: InputWire = { type: 'input.state', id: input.id, channel: null, op: null, state: 'unknown', wait: null, reason: null, at: this.now() }
    this.sinks.get(input.device)?.(JSON.stringify(wire))
  }

  private key(input: { device: string; id: string }): string {
    return `${input.device}\u0000${input.id}`
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep !== undefined) return this.deps.sleep(ms)
    return new Promise((resolve) => setTimeout(resolve, ms).unref())
  }
}
