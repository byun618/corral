// 대화 상태 (LIFE-581) — 연결 위에서 대화 하나를 구독하고 받은 말풍선을 든다. RN 을 모른다(연결·시계 주입).
//
// - 화면이 열면(`open`) 지금 인증된 연결로 `chat.subscribe`. 연결이 (다시) 확인될 때마다(`live` — 재연결·포그라운드 복귀) **사용자 조작 없이** 다시 구독한다(X6).
//   이미 받은 말풍선이 있으면 같은 세대 + 들고 있는 첫 id + 받은 가장 큰 변경 순번으로 이어 받기(`resume`, R1-A2) — 서버가 그 뒤 생기거나 바뀐 것 전부를 준다.
//   세대가 다르면 서버가 처음부터(`reset`).
// - **다시 구독할 때마다 이번 구독의 성공을 따로 본다**(R1-A7): 받은 말풍선이 있어도 이번 요청이 응답 없음·서버가 모름·형식 틀림이면 `stale`(본문은 들고 흐리게 + 안내).
// - 말풍선이 전부 읽히지 않은 페이지는 「빈 대화」 가 아니라 형식 불일치(R1-A8). 일부만 못 읽었으면 그 수를 `dropped` 로 들고 화면이 알린다.
// - `tailRev` = 맨 아래 쪽(마지막 말풍선 이후·그 말풍선 자체)이 바뀐 횟수 — 같은 id 의 답이 자라도 오른다(`새 메시지 ↓`, R1-A10).
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

export type ChatStale = 'timeout' | 'rejected' | 'invalid'

export type ChatSnapshot = {
  channel: string | null
  phase: ChatPhase
  gen: string | null
  /** 받은 가장 큰 변경 순번 — 이어 받기 열쇠(R1-A2). */
  cursor: number | null
  items: readonly ChatItem[]
  hasOlder: boolean
  loadingOlder: boolean
  /** 마지막으로 프레임을 받은 시각(폰 시계). */
  receivedAt: number | null
  /** 들고 있는 본문이 최신이 아닐 수 있다 — 다시 구독이 실패했다(R1-A7). null = 이번 구독이 성공했거나 아직 기다리는 중. */
  stale: ChatStale | null
  /** 이 세대에서 읽지 못해 버린 말풍선 수(R1-A8). */
  dropped: number
  /** 맨 아래 쪽 변경 횟수(R1-A10). */
  tailRev: number
}

export type ChatConnection = {
  onSession(listener: (event: SessionEvent) => void): () => void
  liveAttempt(): number | null
  send(message: Record<string, unknown>): boolean
  clockSample(): ClockSample | null
}

export type ChatTimer = { setTimeout(fn: () => void, ms: number): TimerHandle; clearTimeout(handle: TimerHandle): void }

const IDLE: ChatSnapshot = { channel: null, phase: { kind: 'idle' }, gen: null, cursor: null, items: [], hasOlder: false, loadingOlder: false, receivedAt: null, stale: null, dropped: 0, tailRev: 0 }

export class ChatStore {
  private readonly connection: ChatConnection
  private readonly now: () => number
  private readonly timer: ChatTimer
  private readonly log: ConnectionLog | null
  private readonly listeners = new Set<() => void>()
  private attempt: number | null = null
  private deadline: TimerHandle | null = null
  private olderDeadline: TimerHandle | null = null
  /** 이번 구독의 첫 페이지를 기다리는 중 — 응답 없음·거절·형식 틀림을 이 요청의 실패로 본다(R1-A7). */
  private pending = false
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
        // 첫 페이지 대기 중이면 이번 구독의 실패, 받는 중이면 놓친 갱신이 있다 — 어느 쪽이든 본문을 최신이라 하지 않는다.
        if (this.pending || this.snapshot.phase.kind === 'ready') this.fail('invalid')
        return
      case 'server_error':
        // 인증 뒤 `unknown_type` — 서버(맥 corral)가 대화를 모른다. 이번 구독의 첫 페이지를 기다리던 중이면 실패로(받은 본문이 있어도, R1-A7).
        if (event.attempt !== this.attempt || event.code !== 'unknown_type' || !this.pending) return
        this.fail('rejected')
        return
      case 'list':
      case 'list_failed':
        return
    }
  }

  /** (다시) 구독 — 받은 것이 있으면 같은 세대 + 첫 id + 변경 순번으로 이어 받기. 이번 구독의 첫 페이지 마감을 건다(받은 본문이 있어도). */
  private request(attempt: number, reason: string): void {
    const { channel, gen, items, cursor } = this.snapshot
    if (channel === null) return
    const first = items[0]
    const resume = gen !== null && cursor !== null && first !== undefined ? { gen, from: first.id, cursor } : null
    const sent = this.connection.send(resume === null ? { type: 'chat.subscribe', channel } : { type: 'chat.subscribe', channel, gen: resume.gen, from: resume.from, cursor: resume.cursor })
    this.log?.add('chat_subscribe', { attempt, reason, resume: resume !== null })
    if (this.deadline !== null) this.timer.clearTimeout(this.deadline)
    this.deadline = null
    this.pending = sent
    if (!sent) return
    this.deadline = this.timer.setTimeout(() => {
      this.deadline = null
      if (attempt !== this.attempt || this.connection.liveAttempt() !== attempt || !this.pending) return
      this.fail('timeout')
    }, CHAT_DEADLINE_MS)
  }

  /** 이번 구독 실패 — 받은 본문이 없으면 실패 화면, 있으면 본문을 든 채 `stale`(R1-A7). */
  private fail(reason: ChatStale): void {
    this.pending = false
    this.clearDeadline()
    this.log?.add('chat_failed', { reason, held: this.snapshot.items.length })
    if (this.snapshot.items.length === 0) this.set({ phase: { kind: 'failed', reason } })
    else this.set({ stale: reason })
  }

  /** 맨 아래 쪽이 바뀌었나 — 새 말풍선이 마지막 뒤에 붙거나 마지막 말풍선 자체가 바뀌었다(R1-A10). */
  private touchesTail(incoming: readonly ChatItem[]): boolean {
    const last = this.snapshot.items[this.snapshot.items.length - 1]
    return incoming.some((item) => last === undefined || item.id >= last.id)
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
      this.pending = false
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
    const cursor = (fallback: number | null): number | null => (message.cursor === null ? fallback : Math.max(fallback ?? 0, message.cursor))
    // 말풍선이 있었는데 하나도 못 읽었다 — 「빈 대화」 가 아니라 형식 불일치(R1-A8).
    const unreadable = message.items.length === 0 && message.dropped > 0
    if (message.type === 'items') {
      if (message.gen !== snapshot.gen) return this.drop('other_gen')
      this.set({ items: mergeItems({ have: snapshot.items, incoming: message.items }), cursor: cursor(snapshot.cursor), receivedAt: now, dropped: snapshot.dropped + message.dropped, tailRev: snapshot.tailRev + (this.touchesTail(message.items) ? 1 : 0) })
      return
    }
    switch (message.mode) {
      case 'reset':
      case 'resume': {
        this.clearDeadline()
        this.pending = false
        // 이어 받기를 청했는데 세대가 다르다 — 서버는 그때 reset 을 보낸다. 방어로 처음부터처럼 받는다.
        const fresh = message.mode === 'reset' || message.gen !== snapshot.gen
        if (unreadable && (fresh || snapshot.items.length === 0)) {
          this.log?.add('chat_unreadable', { mode: message.mode, dropped: message.dropped })
          if (fresh) this.set({ gen: message.gen, cursor: message.cursor, items: [], dropped: message.dropped })
          this.fail('invalid')
          return
        }
        if (fresh) {
          this.set({ phase: { kind: 'ready' }, gen: message.gen, cursor: message.cursor, items: mergeItems({ have: [], incoming: message.items }), hasOlder: message.hasOlder, loadingOlder: false, receivedAt: now, stale: null, dropped: message.dropped, tailRev: snapshot.tailRev + 1 })
          return
        }
        this.set({ phase: { kind: 'ready' }, items: mergeItems({ have: snapshot.items, incoming: message.items }), cursor: cursor(snapshot.cursor), receivedAt: now, stale: null, dropped: snapshot.dropped + message.dropped, tailRev: snapshot.tailRev + (this.touchesTail(message.items) ? 1 : 0) })
        return
      }
      case 'older':
        if (message.gen !== snapshot.gen) return this.drop('other_gen')
        if (this.olderDeadline !== null) this.timer.clearTimeout(this.olderDeadline)
        this.olderDeadline = null
        this.set({ items: mergeItems({ have: snapshot.items, incoming: message.items }), hasOlder: message.hasOlder, loadingOlder: false, receivedAt: now, dropped: snapshot.dropped + message.dropped })
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
    this.pending = false
    if (this.olderDeadline !== null) this.timer.clearTimeout(this.olderDeadline)
    this.olderDeadline = null
  }

  private set(patch: Partial<ChatSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}
