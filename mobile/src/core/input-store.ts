// 폰 쓰기 상태 (LIFE-582 P2·P3·P6) — 보낸 지시·질문 답·중단을 id 로 들고 서버 `input.state` 로 갱신한다. RN 을 모른다(연결·시계 주입).
//
// - 보내기·답·중단은 **연결됨에서만**(`connection.send` 가 거짓이면 아무것도 보내지 않은 것 — 실패로 남기고 자동 재전송 없음, P6ⓐ).
// - 같은 id 는 한 번만 만든다. 「다시 보내기」 는 **새 id**(P2) — 이전 항목은 지운다.
// - 연결이 (다시) 확인되면(`live`) 끝나지 않은 id 를 `input.status` 로 묻는다(P6ⓑ) — 다시 넣지 않는다.
//   서버가 모르는 id(`unknown` — 맥 앱 재시작·기억 만료)는 `들어갔는지 확인하지 못했습니다`(unconfirmed) — 들어갔을 수 있으니 「보내지 못함」 이라 하지 않는다.
// - `보내는 중` 이 무기한 남지 않는다(P6ⓒ): 서버 답 없이 `SENDING_QUERY_MS` 가 지나면 조회, `SENDING_GIVEUP_MS` 까지도 답이 없으면 `unconfirmed`(no_reply).
//   이 「확인 못 함」 은 앱이 혼자 정한 것이라(`provisional`) 끝이 아니다 — 재연결 조회·늦은 결과로 바뀐다(R1-A7). 서버가 확정한 끝만 끝이다.
// - 앱이 다시 시작되면 id 를 잊는다 — 연결될 때마다 `input.pending` 으로 이 기기의 끝나지 않은 요청을 다시 받아(본문 포함) 보이고 취소할 수 있게 한다(R1-A8, P6ⓔ).
//   이미 들어간 지시는 대화 기록의 「내 지시」 로 보인다.
// - 기록(`input_*`)에는 글을 남기지 않는다(바이트 수만).
import type { SessionEvent, TimerHandle } from './connection'
import {
  FINAL_STATES,
  SENDING_GIVEUP_MS,
  SENDING_QUERY_MS,
  newInputId,
  utf8Bytes,
  type InputOp,
  type InputStateMessage,
  type SentEntry,
  type StepAnswer,
  settled,
} from './input'
import type { ConnectionLog } from './log'

export type InputConnection = {
  onSession(listener: (event: SessionEvent) => void): () => void
  send(message: Record<string, unknown>): boolean
}

export type InputTimer = { setTimeout(fn: () => void, ms: number): TimerHandle; clearTimeout(handle: TimerHandle): void }

export type InputSnapshot = { entries: readonly SentEntry[] }

/** 채널당 기억하는 끝난 항목 수 — 화면에는 최근 것만 보인다. */
const KEEP_FINAL = 20

export class InputStore {
  private readonly connection: InputConnection
  private readonly now: () => number
  private readonly random: () => number
  private readonly timer: InputTimer
  private readonly log: ConnectionLog | null
  private readonly listeners = new Set<() => void>()
  private readonly timers = new Map<string, TimerHandle>()
  private snapshot: InputSnapshot = { entries: [] }

  constructor(input: { connection: InputConnection; now: () => number; random?: () => number; timer: InputTimer; log?: ConnectionLog }) {
    this.connection = input.connection
    this.now = input.now
    this.random = input.random ?? Math.random
    this.timer = input.timer
    this.log = input.log ?? null
    this.connection.onSession((event) => this.handle(event))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): InputSnapshot => this.snapshot

  /** 지시 보내기 — 보냈으면 id, 연결이 없어 못 보냈으면 null(쓴 글은 화면이 들고 있다). */
  send(input: { channel: string; text: string; tailId: number | null }): string | null {
    const id = newInputId({ now: this.now(), random: this.random })
    const sent = this.connection.send({ type: 'input.send', id, channel: input.channel, text: input.text })
    this.log?.add('input_send', { sent, bytes: utf8Bytes(input.text) })
    if (!sent) return null
    this.add({ id, channel: input.channel, op: 'send', text: input.text, tailId: input.tailId })
    return id
  }

  /** 다시 보내기 — 같은 글을 새 id 로(P2). 이전 항목은 지운다. 못 보내면 이전 항목을 그대로 둔다. */
  retry(id: string): string | null {
    const entry = this.find(id)
    if (entry === null || entry.op !== 'send' || entry.text === null || !settled(entry)) return null
    const next = this.send({ channel: entry.channel, text: entry.text, tailId: entry.tailId })
    if (next !== null) this.remove(id)
    return next
  }

  /** 큐 취소 — 서버가 받은(대기 중) 것만. 결과는 서버 `input.state`(cancelled 또는 이미 넣기 시작한 상태). */
  cancel(id: string): boolean {
    const entry = this.find(id)
    if (entry === null || entry.state !== 'queued' || !entry.acked) return false
    return this.connection.send({ type: 'input.cancel', id })
  }

  /** `call` = 그 질문 말풍선의 도구 호출 id — 서버가 같은 질문인지 대조한다(R1-A2). */
  answer(input: { channel: string; question: number; call: string | null; answers: StepAnswer[] }): string | null {
    const id = newInputId({ now: this.now(), random: this.random })
    const sent = this.connection.send({ type: 'question.answer', id, channel: input.channel, question: input.question, call: input.call, answers: input.answers })
    this.log?.add('input_answer', { sent, questions: input.answers.length })
    if (!sent) return null
    this.add({ id, channel: input.channel, op: 'answer', text: null, tailId: null })
    return id
  }

  stop(input: { channel: string }): string | null {
    const id = newInputId({ now: this.now(), random: this.random })
    const sent = this.connection.send({ type: 'turn.stop', id, channel: input.channel })
    this.log?.add('input_stop', { sent })
    if (!sent) return null
    this.add({ id, channel: input.channel, op: 'stop', text: null, tailId: null })
    return id
  }

  /** 그 채널의 항목(보낸 순서). */
  of(input: { channel: string; op: InputOp }): SentEntry[] {
    return this.snapshot.entries.filter((entry) => entry.channel === input.channel && entry.op === input.op)
  }

  /** 화면이 결과 줄을 닫았다(중단·답 결과). */
  dismiss(id: string): void {
    this.remove(id)
  }

  private handle(event: SessionEvent): void {
    switch (event.kind) {
      case 'live': {
        const open = this.snapshot.entries.filter((entry) => !settled(entry)).map((entry) => entry.id)
        if (open.length > 0) {
          this.connection.send({ type: 'input.status', ids: open })
          this.log?.add('input_status', { ids: open.length, reason: event.reason })
        }
        // 앱이 잊은(다시 시작) 서버 큐까지 — 이 기기의 끝나지 않은 요청 전부(R1-A8).
        this.connection.send({ type: 'input.pending' })
        return
      }
      case 'input':
        return this.accept(event.message)
      case 'list':
      case 'list_failed':
      case 'chat':
      case 'chat_invalid':
      case 'server_error':
        return
    }
  }

  private accept(message: InputStateMessage): void {
    const entry = this.find(message.id)
    if (entry === null) return this.recover(message)
    // 서버가 확정한 끝은 바꾸지 않는다 — 늦게 온 조회 답(queued 등)이 결과를 되돌리지 않게. 앱 혼자 정한 확인 못 함은 서버 답으로 바뀐다(R1-A7).
    if (settled(entry)) return
    if (message.state === 'unknown') return this.update(entry.id, { state: 'unconfirmed', reason: message.reason ?? 'unknown', wait: null, acked: true, provisional: false, at: this.now() })
    this.update(entry.id, { state: message.state, wait: message.wait, reason: message.reason, acked: true, provisional: false, at: message.at ?? this.now() })
  }

  /** 앱이 모르는 id 의 끝나지 않은 요청(복구 조회 답) — 다시 보이고 취소할 수 있게 들인다. 끝난 것·채널 모름은 버린다. */
  private recover(message: InputStateMessage): void {
    if (message.channel === null || message.op === null || FINAL_STATES.has(message.state) || message.state === 'unknown') return
    const at = message.at ?? this.now()
    const entry: SentEntry = { id: message.id, channel: message.channel, op: message.op, text: message.text, state: message.state, wait: message.wait, reason: message.reason, acked: true, sentAt: at, at, tailId: null, provisional: false }
    this.log?.add('input_recovered', { op: message.op })
    this.set({ entries: [...this.snapshot.entries, entry] })
  }

  private add(input: { id: string; channel: string; op: InputOp; text: string | null; tailId: number | null }): void {
    const at = this.now()
    const entry: SentEntry = { ...input, state: 'sending', wait: null, reason: null, acked: false, sentAt: at, at, provisional: false }
    const entries = [...this.snapshot.entries, entry]
    // 채널·종류마다 끝난 것은 최근 `KEEP_FINAL` 개만.
    const finals = entries.filter((item) => item.channel === input.channel && item.op === input.op && FINAL_STATES.has(item.state))
    const drop = new Set(finals.slice(0, Math.max(0, finals.length - KEEP_FINAL)).map((item) => item.id))
    this.set({ entries: entries.filter((item) => !drop.has(item.id)) })
    this.watch(input.id)
  }

  /** 서버 답 없는 `보내는 중` — 조회 한 번, 그래도 없으면 확인 못 함(P6ⓒ). */
  private watch(id: string): void {
    this.timers.set(id, this.timer.setTimeout(() => {
      const entry = this.find(id)
      if (entry === null || entry.acked || FINAL_STATES.has(entry.state)) return
      this.connection.send({ type: 'input.status', ids: [id] })
      this.timers.set(id, this.timer.setTimeout(() => {
        this.timers.delete(id)
        const late = this.find(id)
        if (late === null || late.acked || FINAL_STATES.has(late.state)) return
        this.log?.add('input_no_reply', { op: late.op })
        this.update(id, { state: 'unconfirmed', reason: 'no_reply', provisional: true, at: this.now() })
      }, SENDING_GIVEUP_MS - SENDING_QUERY_MS))
    }, SENDING_QUERY_MS))
  }

  private find(id: string): SentEntry | null {
    return this.snapshot.entries.find((entry) => entry.id === id) ?? null
  }

  private update(id: string, patch: Partial<SentEntry>): void {
    this.set({ entries: this.snapshot.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) })
    const next = this.find(id)
    if (next !== null && (next.acked || FINAL_STATES.has(next.state))) this.clearTimer(id)
  }

  private remove(id: string): void {
    this.clearTimer(id)
    this.set({ entries: this.snapshot.entries.filter((entry) => entry.id !== id) })
  }

  private clearTimer(id: string): void {
    const handle = this.timers.get(id)
    if (handle !== undefined) this.timer.clearTimeout(handle)
    this.timers.delete(id)
  }

  private set(next: InputSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
