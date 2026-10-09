// 목록 상태 (LIFE-580) — 연결 위에서 구독하고 받은 목록을 든다. RN 을 모른다(연결·시계·장부 주입).
//
// - 인증된 연결이 (다시) 확인될 때마다(`live` — 새 연결 hello · 포그라운드 복귀 프로브 · 페어링 직후) `list.subscribe` 를 보낸다 → 서버가 전체를 다시 보낸다(J8).
// - **늦은·역행 갱신을 버린다(L4ⓑ)**: ① 지금 시도가 아닌 소켓의 목록 ② 같은 epoch 에서 지금보다 낮은 seq. epoch 가 바뀌면(맥 corral 재기동) 새 기준으로 받는다.
// - 아직 하나도 못 받았으면 `waiting` — 화면은 이것을 「세션 0」(B9)으로 그리지 않는다(L5ⓗ).
// - 끊겨도 마지막 목록은 들고 있는다(B7 — 흐리게 + 기준 시각). 다시 붙으면 새 구독의 전체로 바뀐다(L4ⓐ).
// - 상태 점이 바뀐 채널은 1.5초 「방금 바뀜」(B5).
import { allChannels, type Channel, type ChannelList, type ListMessage } from './list'
import type { SessionEvent } from './connection'
import type { ConnectionLog } from './log'
import type { UnreadLedger } from './unread'

export const FLASH_MS = 1_500

export type ListPhase = { kind: 'waiting' } | { kind: 'ready'; message: ListMessage; receivedAt: number }

export type ListSnapshot = {
  phase: ListPhase
  /** 채널 id → 「방금 바뀜」 끝 시각. */
  flashUntil: Readonly<Record<string, number>>
  /** 장부가 바뀔 때마다 오른다 — 화면이 다시 그릴 근거. */
  ledgerVersion: number
}

export type ListConnection = {
  onSession(listener: (event: SessionEvent) => void): () => void
  liveAttempt(): number | null
  send(message: Record<string, unknown>): boolean
}

export class ListStore {
  private readonly connection: ListConnection
  private readonly ledger: UnreadLedger
  private readonly now: () => number
  private readonly log: ConnectionLog | null
  private readonly listeners = new Set<() => void>()
  private attempt: number | null = null
  private snapshot: ListSnapshot = { phase: { kind: 'waiting' }, flashUntil: {}, ledgerVersion: 0 }
  /** 받아들이지 않은 목록 수 — 시험·기록용. */
  dropped = 0

  /** `log` 이 있으면 받은 목록마다 한 줄(`list_recv` — seq·서버 시각) — 3초 측정(J5)의 폰 수신 원자료. 제목은 남기지 않는다. */
  constructor(input: { connection: ListConnection; ledger: UnreadLedger; now: () => number; log?: ConnectionLog }) {
    this.connection = input.connection
    this.ledger = input.ledger
    this.now = input.now
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
    this.log?.add('list_subscribe', { attempt: this.attempt, reason: 'refresh' })
    return this.connection.send({ type: 'list.subscribe' })
  }

  private handle(event: SessionEvent): void {
    switch (event.kind) {
      case 'live':
        this.attempt = event.attempt
        this.log?.add('list_subscribe', { attempt: event.attempt, reason: event.reason })
        this.connection.send({ type: 'list.subscribe' })
        return
      case 'list':
        return this.accept(event.attempt, event.message)
    }
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
    this.log?.add('list_recv', { seq: message.seq, at: message.at, changedAt: message.changedAt, available: message.list.available, channels: allChannels(message.list).length })
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
    this.set({ phase: { kind: 'ready', message, receivedAt: now }, flashUntil, ledgerVersion: this.snapshot.ledgerVersion + 1 })
  }

  private set(patch: Partial<ListSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}

export function listOf(snapshot: ListSnapshot): ChannelList | null {
  return snapshot.phase.kind === 'ready' ? snapshot.phase.message.list : null
}
