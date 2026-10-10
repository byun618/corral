// 대화 상태 (LIFE-581) — 연결 위에서 대화 하나를 구독하고 받은 말풍선을 든다. RN 을 모른다(연결·시계 주입).
//
// - 화면이 열면(`open`) 지금 인증된 연결로 `chat.subscribe`. 연결이 (다시) 확인될 때마다(`live` — 재연결·포그라운드 복귀) **사용자 조작 없이** 다시 구독한다(X6).
//   이미 받은 말풍선이 있으면 같은 세대 + 마지막 말풍선 id 로 이어 받기(`resume`) — 서버가 그 뒤 전부를 준다. 세대가 다르면 서버가 처음부터(`reset`).
// - **늦은 갱신을 버린다(Y5ⓑ)**: 지금 시도가 아닌 소켓의 프레임 · 다른 채널 · 다른 세대의 `chat.items`·`older`.
// - 아직 첫 페이지를 못 받았으면 `loading` — 화면은 이것을 「빈 대화」 로 그리지 않는다(Y6ⓔ). 못 열면 `unavailable`(사유)·`failed`(응답 없음·서버가 모름·읽지 못함).
// - 끊겨도 받은 말풍선은 들고 있다(C18 — 흐리게). 다시 붙으면 이어 받는다.
// - 받은 프레임마다 기록 한 줄(`chat_recv`) — 3초 측정(X4)의 폰 수신 원자료. 글은 남기지 않는다(개수·id·시각).
import { mergeItems, type ChatItem, type ChatMessage } from './chat'
import type { ClockSample, SessionEvent, TimerHandle } from './connection'
import type { ConnectionLog } from './log'

/** 구독을 보낸 뒤 이 안에 첫 페이지가 없으면 실패(timeout). 서버는 색인이 끝나면 곧장 보낸다(큰 기록 ≤ 1초, X5). */
export const CHAT_DEADLINE_MS = 10_000

export type ChatPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: 'timeout' | 'rejected' | 'invalid' }

export type ChatSnapshot = {
  channel: string | null
  phase: ChatPhase
  gen: string | null
  items: readonly ChatItem[]
  hasOlder: boolean
  loadingOlder: boolean
  /** 마지막으로 프레임을 받은 시각(폰 시계). */
  receivedAt: number | null
}

export type ChatConnection = {
  onSession(listener: (event: SessionEvent) => void): () => void
  liveAttempt(): number | null
  send(message: Record<string, unknown>): boolean
  clockSample(): ClockSample | null
}

export type ChatTimer = { setTimeout(fn: () => void, ms: number): TimerHandle; clearTimeout(handle: TimerHandle): void }

const IDLE: ChatSnapshot = { channel: null, phase: { kind: 'idle' }, gen: null, items: [], hasOlder: false, loadingOlder: false, receivedAt: null }

export class ChatStore {
  private readonly connection: ChatConnection
  private readonly now: () => number
  private readonly timer: ChatTimer
  private readonly log: ConnectionLog | null
  private readonly listeners = new Set<() => void>()
  private attempt: number | null = null
  private deadline: TimerHandle | null = null
  private olderDeadline: TimerHandle | null = null
  private snapshot: ChatSnapshot = IDLE
  /** 버린 프레임 수 — 시험·기록용. */
  dropped = 0

  constructor(input: { connection: ChatConnection; now: () => number; timer: ChatTimer; log?: ConnectionLog }) {
    this.connection = input.connection
    this.now = input.now
    this.timer = input.timer
    this.log = input.log ?? null
    this.connection.onSession((event) => this.handle(event))
    this.attempt = this.connection.liveAttempt()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ChatSnapshot => this.snapshot

  /** 대화 열기 — 같은 채널이 이미 열려 있으면 그대로. 다른 채널이면 이전 것을 버리고 새로. */
  open(channel: string): void {
    if (this.snapshot.channel === channel) return
    this.clearTimers()
    this.set({ ...IDLE, channel, phase: { kind: 'loading' } })
    const attempt = this.connection.liveAttempt()
    if (attempt !== null) {
      this.attempt = attempt
      this.request(attempt, 'open')
    }
  }

  /** 대화 닫기(화면을 떠남) — 그 채널이 열려 있을 때만. */
  close(channel: string): void {
    if (this.snapshot.channel !== channel) return
    this.clearTimers()
    this.connection.send({ type: 'chat.unsubscribe' })
    this.log?.add('chat_close', {})
    this.set(IDLE)
  }

  /** 위로 끝까지 밀었다(C16) — 이전 페이지. 보냈으면 true. */
  loadOlder(): boolean {
    const { phase, hasOlder, loadingOlder, gen, items } = this.snapshot
    const first = items[0]
    if (phase.kind !== 'ready' || !hasOlder || loadingOlder || gen === null || first === undefined) return false
    if (!this.connection.send({ type: 'chat.older', gen, before: first.id })) return false
    this.set({ loadingOlder: true })
    if (this.olderDeadline !== null) this.timer.clearTimeout(this.olderDeadline)
    this.olderDeadline = this.timer.setTimeout(() => {
      this.olderDeadline = null
      this.set({ loadingOlder: false })
    }, CHAT_DEADLINE_MS)
    return true
  }

  /** 「다시 시도」 — 실패·사유 뒤 같은 채널을 처음부터 다시 연다. */
  retry(): void {
    const channel = this.snapshot.channel
    if (channel === null) return
    this.set({ ...IDLE })
    this.open(channel)
  }

  private handle(event: SessionEvent): void {
    switch (event.kind) {
      case 'live':
        this.attempt = event.attempt
        if (this.snapshot.channel !== null) this.request(event.attempt, event.reason)
        return
      case 'chat':
        return this.accept(event.attempt, event.message)
      case 'chat_invalid':
        if (event.attempt !== this.attempt || this.snapshot.channel === null) return
        this.dropped += 1
        if (this.snapshot.phase.kind === 'loading') this.fail('invalid')
        return
      case 'server_error':
        // 인증 뒤 `unknown_type` — 서버(맥 corral)가 대화를 모른다. 첫 페이지를 기다리던 중이면 실패로.
        if (event.attempt !== this.attempt || event.code !== 'unknown_type' || this.snapshot.phase.kind !== 'loading') return
        this.fail('rejected')
        return
      case 'list':
      case 'list_failed':
        return
    }
  }

  /** (다시) 구독 — 받은 것이 있으면 같은 세대 + 마지막 id 로 이어 받기. 첫 페이지 마감을 건다. */
  private request(attempt: number, reason: string): void {
    const { channel, gen, items } = this.snapshot
    if (channel === null) return
    const last = items[items.length - 1]
    const resume = gen !== null && last !== undefined ? { gen, after: last.id } : null
    const sent = this.connection.send(resume === null ? { type: 'chat.subscribe', channel } : { type: 'chat.subscribe', channel, gen: resume.gen, after: resume.after })
    this.log?.add('chat_subscribe', { attempt, reason, resume: resume !== null })
    if (this.deadline !== null) this.timer.clearTimeout(this.deadline)
    this.deadline = null
    if (!sent) return
    this.deadline = this.timer.setTimeout(() => {
      this.deadline = null
      if (attempt !== this.attempt || this.connection.liveAttempt() !== attempt) return
      if (this.snapshot.phase.kind === 'loading') this.fail('timeout')
    }, CHAT_DEADLINE_MS)
  }

  private fail(reason: 'timeout' | 'rejected' | 'invalid'): void {
    this.log?.add('chat_failed', { reason })
    this.set({ phase: { kind: 'failed', reason } })
  }

  private accept(attempt: number, message: ChatMessage): void {
    const snapshot = this.snapshot
    if (attempt !== this.attempt || message.channel !== snapshot.channel) {
      this.drop(attempt !== this.attempt ? 'stale_attempt' : 'other_channel')
      return
    }
    const now = this.now()
    if (message.type === 'unavailable') {
      this.clearDeadline()
      this.log?.add('chat_unavailable', { reason: message.reason })
      this.set({ phase: { kind: 'unavailable', reason: message.reason }, receivedAt: now })
      return
    }
    // 3초 측정(X4) 폰 원자료 — 받은 시각 · 서버가 보낸 시각 · 기록을 읽은 시각 · 파일 수정 시각 · 말풍선의 기록 시각 · 시계 차. 글 없음.
    const clock = this.connection.clockSample()
    this.log?.add('chat_recv', {
      type: message.type,
      mode: message.type === 'page' ? message.mode : null,
      items: message.items.length,
      firstId: message.items[0]?.id ?? null,
      lastId: message.items[message.items.length - 1]?.id ?? null,
      itemAt: Math.max(0, ...message.items.map((item) => item.at ?? 0)) || null,
      serverAt: message.at,
      readAt: message.readAt,
      writtenAt: message.writtenAt,
      recvAt: now,
      offsetMs: clock?.offsetMs ?? null,
      rttMs: clock?.rttMs ?? null,
      dropped: message.dropped,
    })
    if (message.type === 'items') {
      if (message.gen !== snapshot.gen) return this.drop('other_gen')
      this.set({ items: mergeItems({ have: snapshot.items, incoming: message.items }), receivedAt: now })
      return
    }
    switch (message.mode) {
      case 'reset':
        this.clearDeadline()
        this.set({ phase: { kind: 'ready' }, gen: message.gen, items: mergeItems({ have: [], incoming: message.items }), hasOlder: message.hasOlder, loadingOlder: false, receivedAt: now })
        return
      case 'resume':
        this.clearDeadline()
        if (message.gen !== snapshot.gen) {
          // 이어 받기를 청했는데 세대가 다르다 — 서버는 그때 reset 을 보낸다. 방어로 처음부터처럼 받는다.
          this.set({ phase: { kind: 'ready' }, gen: message.gen, items: mergeItems({ have: [], incoming: message.items }), hasOlder: message.hasOlder, loadingOlder: false, receivedAt: now })
          return
        }
        this.set({ phase: { kind: 'ready' }, items: mergeItems({ have: snapshot.items, incoming: message.items }), receivedAt: now })
        return
      case 'older':
        if (message.gen !== snapshot.gen) return this.drop('other_gen')
        if (this.olderDeadline !== null) this.timer.clearTimeout(this.olderDeadline)
        this.olderDeadline = null
        this.set({ items: mergeItems({ have: snapshot.items, incoming: message.items }), hasOlder: message.hasOlder, loadingOlder: false, receivedAt: now })
    }
  }

  private drop(why: string): void {
    this.dropped += 1
    this.log?.add('chat_drop', { why })
  }

  private clearDeadline(): void {
    if (this.deadline === null) return
    this.timer.clearTimeout(this.deadline)
    this.deadline = null
  }

  private clearTimers(): void {
    this.clearDeadline()
    if (this.olderDeadline !== null) this.timer.clearTimeout(this.olderDeadline)
    this.olderDeadline = null
  }

  private set(patch: Partial<ChatSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}
