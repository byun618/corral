// 목록 구독 (LIFE-580 J8) — 인증된 연결이 `list.subscribe` 하면 전체 스냅샷, 이후 바뀔 때마다 전체를 다시 보낸다.
//
// - **구독자 0 이면 아무 일도 안 한다** — `changed()` 는 카운터만 본다. 폰용 변환·직렬화는 구독자가 있을 때만(K9, L10ⓑ).
// - **뭉침** — 상태가 흔들려도 `coalesceMs` 뒤 한 번, 첫 변경에서 `maxWaitMs` 를 넘기지 않는다(J5 — 3초 예산 안에서 push 쪽은 1초 안팎).
// - **스냅샷 하나를 공유한다** — 같은 상태 세대에서 붙은 구독은 이미 만든 직렬화 문자열을 그대로 받는다(W2). push 도 한 번 만들어 모두에게.
// - **일련번호** — `epoch`(서버 기동마다 새 값) + `seq`(보낼 내용이 바뀔 때만 +1). 폰은 같은 epoch 의 더 낮은 seq 를 버린다(L4ⓑ).
//   구독(재연결·포그라운드 복귀)에는 지금 seq 의 전체를 다시 보낸다 — 번호는 올리지 않는다(내용이 같다).
// - 내용이 같으면 보내지 않는다 — main 의 revision 은 터미널·창 상태로도 오르는데 폰 목록은 그대로일 때가 많다.
// - 시간 경계(smart 정렬의 30분 신선도)는 상태 이벤트 없이 바뀔 수 있어 구독자가 있는 동안 `refreshMs` 마다 다시 계산한다.
// - electron 을 모른다 — 상태는 `read()` 로 주입받는다.
import { randomBytes } from 'node:crypto'
import { buildMobileList, type ListInput, type MobileList } from './list.js'

export const LIST_COALESCE_MS = 100
export const LIST_MAX_WAIT_MS = 300
export const LIST_REFRESH_MS = 30_000

export type ListMessage = { type: 'list'; epoch: string; seq: number; at: number; changedAt: number; list: MobileList }

export type ListFeedDeps = {
  /** 지금 상태 — 구독·push 때만 부른다. 상태를 못 내면(창·herdr 준비 전) null. */
  read: () => ListInput | null
  log: (tag: string, fields?: Record<string, unknown>) => void
  coalesceMs?: number
  maxWaitMs?: number
  refreshMs?: number
  now?: () => number
}

type Sink = (text: string) => void

export class ListFeed {
  private readonly deps: ListFeedDeps
  private readonly sinks = new Set<Sink>()
  readonly epoch = randomBytes(6).toString('hex')
  private seq = 0
  /** 상태 세대 — `changed()` 마다 오른다. 캐시가 이 세대 것이면 다시 만들지 않는다. */
  private stamp = 0
  private cache: { stamp: number; seq: number; body: string; text: string } | null = null
  /** 구독자 모두에게 보낸 마지막 seq. */
  private sentSeq = 0
  private timer: NodeJS.Timeout | null = null
  private refresh: NodeJS.Timeout | null = null
  /** 아직 보내지 않은 첫 변경 시각 — 뭉침 상한과 측정(J5ⓐ `changedAt`)용. */
  private pendingSince: number | null = null
  private lastChangedAt = 0

  constructor(deps: ListFeedDeps) {
    this.deps = deps
  }

  subscriberCount(): number {
    return this.sinks.size
  }

  /** 구독 — 지금 전체를 곧장 보낸다. 돌려준 함수로 끊는다(연결 닫힘·해지·교체). */
  subscribe(sink: Sink): () => void {
    this.sinks.add(sink)
    if (this.refresh === null) {
      this.refresh = setInterval(() => this.changed(), this.deps.refreshMs ?? LIST_REFRESH_MS)
      this.refresh.unref()
    }
    const snapshot = this.current()
    if (snapshot !== null) {
      // 이 구독이 새 내용을 만들었으면 기존 구독자도 받아야 한다 — 아니면 다음 변경까지 옛 목록에 머문다.
      if (snapshot.seq > this.sentSeq) this.broadcast(snapshot)
      else sink(snapshot.text)
    }
    return () => this.unsubscribe(sink)
  }

  /** 상태가 바뀌었을 수 있다 — 구독자가 없으면 아무것도 안 한다. */
  changed(): void {
    if (this.sinks.size === 0) return
    this.stamp += 1
    const now = this.now()
    if (this.pendingSince === null) this.pendingSince = now
    if (this.timer !== null) clearTimeout(this.timer)
    const maxWait = this.deps.maxWaitMs ?? LIST_MAX_WAIT_MS
    const delay = Math.max(0, Math.min(this.deps.coalesceMs ?? LIST_COALESCE_MS, this.pendingSince + maxWait - now))
    this.timer = setTimeout(() => this.flush(), delay)
  }

  stop(): void {
    this.sinks.clear()
    this.clearTimers()
  }

  private unsubscribe(sink: Sink): void {
    this.sinks.delete(sink)
    if (this.sinks.size === 0) {
      this.clearTimers()
      // 구독자가 없는 동안의 변화는 세지 않는다 — 다음 구독이 다시 만들게 세대만 넘긴다. 내용이 같으면 번호는 그대로다.
      this.stamp += 1
      this.pendingSince = null
    }
  }

  private clearTimers(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.refresh !== null) clearInterval(this.refresh)
    this.refresh = null
  }

  private flush(): void {
    this.timer = null
    if (this.sinks.size === 0) return
    const snapshot = this.current()
    if (snapshot === null || snapshot.seq <= this.sentSeq) return
    this.broadcast(snapshot)
  }

  private broadcast(snapshot: { seq: number; text: string }): void {
    this.sentSeq = snapshot.seq
    const started = performance.now()
    for (const sink of [...this.sinks]) sink(snapshot.text)
    this.deps.log('mobile.list_push', { seq: snapshot.seq, subscribers: this.sinks.size, sendMs: Math.round((performance.now() - started) * 100) / 100 })
  }

  /** 지금 세대의 스냅샷 — 이미 만들었으면 그대로(동시 구독 공유), 아니면 한 번 만든다. 내용이 바뀌었을 때만 seq 를 올린다. */
  private current(): { seq: number; body: string; text: string } | null {
    if (this.cache !== null && this.cache.stamp === this.stamp) return this.cache
    const started = performance.now()
    const input = this.deps.read()
    if (input === null) return null
    const list = buildMobileList(input)
    const body = JSON.stringify(list)
    const changedAt = this.pendingSince ?? this.now()
    this.pendingSince = null
    if (this.cache !== null && this.cache.body === body) {
      this.cache = { ...this.cache, stamp: this.stamp }
      return this.cache
    }
    this.seq += 1
    this.lastChangedAt = changedAt
    const message: ListMessage = { type: 'list', epoch: this.epoch, seq: this.seq, at: this.now(), changedAt: this.lastChangedAt, list }
    const text = JSON.stringify(message)
    this.cache = { stamp: this.stamp, seq: this.seq, body, text }
    // push 1회 비용(만들기 + 직렬화) — J6 네이티브 판정 재료. 내용(제목 등)은 남기지 않는다.
    this.deps.log('mobile.list_built', { seq: this.seq, bytes: text.length, buildMs: Math.round((performance.now() - started) * 100) / 100, subscribers: this.sinks.size })
    return this.cache
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
