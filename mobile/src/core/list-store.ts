// 목록 상태 (LIFE-580) — 연결 위에서 구독하고 받은 목록을 든다. RN 을 모른다(연결·시계·장부 주입).
//
// - 인증된 연결이 (다시) 확인될 때마다(`live` — 새 연결 hello · 포그라운드 복귀 프로브 · 페어링 직후) `list.subscribe` 를 보낸다 → 서버가 전체를 다시 보낸다(J8).
// - **늦은·역행 갱신을 버린다(L4ⓑ)**: ① 지금 시도가 아닌 소켓의 목록 ② 같은 epoch 에서 지금보다 낮은 seq. epoch 가 바뀌면(맥 corral 재기동) 새 기준으로 받는다.
// - 아직 하나도 못 받았으면 `waiting` — 화면은 이것을 「세션 0」(B9)으로 그리지 않는다(L5ⓗ).
// - 끊겨도 마지막 목록은 들고 있는다(B7 — 흐리게 + 기준 시각). 다시 붙으면 새 구독의 전체로 바뀐다(L4ⓐ).
// - 상태 점이 바뀐 채널은 1.5초 「방금 바뀜」(B5).
// - **목록 실패는 따로 든다(R1-A4)** — 읽지 못한 `list`(invalid) · 구독 거부(rejected, 옛 서버) · 구독 뒤 마감 안에 목록 없음(timeout).
//   들고 있던 목록은 지우지 않되 「오래된 값」 으로 표시하게 하고(기준 시각 = 받은 시각), 받은 게 없으면 「받는 중」·「세션 0」 대신 실패를 그린다.
//   다음 정상 목록이 오면 실패를 지운다.
import { allChannels, type Channel, type ChannelList, type ListMessage } from './list'
import type { ClockSample, SessionEvent, TimerHandle } from './connection'
import type { ConnectionLog } from './log'
import type { UnreadLedger } from './unread'

export const FLASH_MS = 1_500
/** 구독(재구독·새로고침)을 보낸 뒤 이 안에 목록이 없으면 실패(timeout). 서버는 구독 즉시 전체를 보낸다. */
export const SUBSCRIBE_DEADLINE_MS = 10_000

/** 목록 실패(R1-A4). `incompatible` = 앱·맥 corral 의 목록 형식이 맞지 않는다(업데이트 안내). */
export type ListFailure = { reason: 'invalid' | 'rejected' | 'timeout'; at: number; incompatible: boolean }

export type ListPhase = { kind: 'waiting' } | { kind: 'ready'; message: ListMessage; receivedAt: number }

export type ListSnapshot = {
  phase: ListPhase
  /** 채널 id → 「방금 바뀜」 끝 시각. */
  flashUntil: Readonly<Record<string, number>>
  /** 장부가 바뀔 때마다 오른다 — 화면이 다시 그릴 근거. */
  ledgerVersion: number
  /** 목록 실패 — null 이면 지금 목록이 최신이다(또는 받는 중). */
  failure: ListFailure | null
}

export type ListConnection = {
  onSession(listener: (event: SessionEvent) => void): () => void
  liveAttempt(): number | null
  send(message: Record<string, unknown>): boolean
  /** 시계 차 추정(R1 C1) — `list_recv` 기록에 같이 남긴다. */
  clockSample(): ClockSample | null
}

export type ListTimer = { setTimeout(fn: () => void, ms: number): TimerHandle; clearTimeout(handle: TimerHandle): void }

export class ListStore {
  private readonly connection: ListConnection
  private readonly ledger: UnreadLedger
  private readonly now: () => number
  private readonly log: ConnectionLog | null
  private readonly timer: ListTimer
  private readonly listeners = new Set<() => void>()
  private attempt: number | null = null
  private deadline: TimerHandle | null = null
  private snapshot: ListSnapshot = { phase: { kind: 'waiting' }, flashUntil: {}, ledgerVersion: 0, failure: null }
  /** 받아들이지 않은 목록 수 — 시험·기록용. */
  dropped = 0

  /** `log` 이 있으면 받은 목록마다 한 줄(`list_recv` — seq·서버 시각) — 3초 측정(J5)의 폰 수신 원자료. 제목은 남기지 않는다. */
  constructor(input: { connection: ListConnection; ledger: UnreadLedger; now: () => number; timer: ListTimer; log?: ConnectionLog }) {
    this.connection = input.connection
    this.ledger = input.ledger
    this.now = input.now
    this.timer = input.timer
    this.log = input.log ?? null
    this.connection.onSession((event) => this.handle(event))
    // 화면 모듈이 연결보다 늦게 실린 경우 — 이미 인증된 연결이면 지금 구독한다(첫 `live` 를 놓치지 않게).
    const attempt = this.connection.liveAttempt()
    if (attempt !== null) this.handle({ kind: 'live', attempt, reason: 'connect' })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ListSnapshot => this.snapshot

  isUnread(channel: Channel): boolean {
    return this.ledger.isUnread(channel)
  }

  /** 채널을 열었다(J3) — 읽음. */
  markRead(channel: Channel): void {
    if (channel.status !== 'live') return
    this.ledger.markRead(channel)
    this.set({ ledgerVersion: this.snapshot.ledgerVersion + 1 })
  }

  /** 당겨서 새로고침 — 연결돼 있으면 구독을 다시 보내 전체를 새로 받는다(보내지 못하면 false). */
  refresh(): boolean {
    if (this.attempt === null) return false
    return this.requestList(this.attempt, 'refresh')
  }

  private handle(event: SessionEvent): void {
    switch (event.kind) {
      case 'live':
        this.attempt = event.attempt
        this.requestList(event.attempt, event.reason)
        return
      case 'list':
        return this.accept(event.attempt, event.message)
      case 'list_failed':
        if (event.attempt !== this.attempt) return
        this.clearDeadline()
        this.log?.add('list_failed', { attempt: event.attempt, reason: event.reason, seq: event.seq })
        // 읽지 못한 목록·구독 거부는 다시 보내도 같다 — 앱이나 맥 corral 을 맞춰야 한다.
        this.set({ failure: { reason: event.reason, at: this.now(), incompatible: true } })
        return
    }
  }

  /** 구독을 보내고 마감을 건다 — 마감 안에 이 시도의 정상 목록이 없으면 timeout 실패. */
  private requestList(attempt: number, reason: string): boolean {
    this.log?.add('list_subscribe', { attempt, reason })
    const sent = this.connection.send({ type: 'list.subscribe' })
    this.clearDeadline()
    if (!sent) return false
    this.deadline = this.timer.setTimeout(() => {
      this.deadline = null
      // 그사이 연결이 바뀌었으면 연결 띠가 말한다 — 목록 실패로 세지 않는다.
      if (attempt !== this.attempt || this.connection.liveAttempt() !== attempt) return
      this.log?.add('list_failed', { attempt, reason: 'timeout', seq: null })
      this.set({ failure: { reason: 'timeout', at: this.now(), incompatible: false } })
    }, SUBSCRIBE_DEADLINE_MS)
    return true
  }

  private clearDeadline(): void {
    if (this.deadline === null) return
    this.timer.clearTimeout(this.deadline)
    this.deadline = null
  }

  private accept(attempt: number, message: ListMessage): void {
    // 이전 소켓의 늦은 목록 — 지금 연결이 받은 전체만 믿는다.
    if (attempt !== this.attempt) {
      this.dropped += 1
      this.log?.add('list_drop', { why: 'stale_attempt', seq: message.seq })
      return
    }
    const phase = this.snapshot.phase
    if (phase.kind === 'ready' && phase.message.epoch === message.epoch && message.seq < phase.message.seq) {
      this.dropped += 1
      this.log?.add('list_drop', { why: 'old_seq', seq: message.seq, have: phase.message.seq })
      return
    }
    const now = this.now()
    this.clearDeadline()
    // J5 네이티브 원자료 — 폰 수신 시각(이 기록의 시각) · 서버 시각 · 그때의 시계 차(서버 − 폰, 왕복 중간점 기준, R1 C1).
    const clock = this.connection.clockSample()
    this.log?.add('list_recv', {
      seq: message.seq,
      at: message.at,
      changedAt: message.changedAt,
      recvAt: now,
      offsetMs: clock?.offsetMs ?? null,
      rttMs: clock?.rttMs ?? null,
      available: message.list.available,
      channels: allChannels(message.list).length,
    })
    const flashUntil: Record<string, number> = {}
    for (const [id, until] of Object.entries(this.snapshot.flashUntil)) if (until > now) flashUntil[id] = until
    if (phase.kind === 'ready') {
      const before = new Map(allChannels(phase.message.list).map((channel) => [channel.id, channel]))
      for (const channel of allChannels(message.list)) {
        const old = before.get(channel.id)
        if (old !== undefined && (old.dot !== channel.dot || old.dotUnseen !== channel.dotUnseen)) flashUntil[channel.id] = now + FLASH_MS
      }
    }
    this.ledger.observe(message.list)
    this.set({ phase: { kind: 'ready', message, receivedAt: now }, flashUntil, ledgerVersion: this.snapshot.ledgerVersion + 1, failure: null })
  }

  private set(patch: Partial<ListSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}

export function listOf(snapshot: ListSnapshot): ChannelList | null {
  return snapshot.phase.kind === 'ready' ? snapshot.phase.message.list : null
}
