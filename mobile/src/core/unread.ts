// 안 읽음 — 폰 자체 장부 (LIFE-580 J1). RN 을 모른다(저장은 주입).
//
// 규칙: 채널이 안 읽음 = 폰에서 그 채널을 마지막으로 연 뒤 **새 활동**이 있었다 —
//   마지막 활동 시각(`activityAt`)이 앞으로 갔거나, 턴 결과(`outcome` — 완료·실패·중단)가 바뀌었다.
// - 키 = 서버가 준 `channel.key`(provider 세션 정체의 해시, 없으면 pane id) — herdr 재기동으로 pane id 가 바뀌어도 세션 id 가 있으면 흔들리지 않는다.
// - **앱 설치 뒤 첫 목록은 전부 읽음**(그때 본 값을 기준선으로 적는다). 그 뒤 처음 보는 채널은 「아직 활동 없음」 기준선 — 활동이 있으면 안 읽음.
// - 채널을 열면(J3 자리 화면) 읽음 — 그때 값을 기준선으로 다시 적는다.
// - 닫힌 세션(보존 행)은 안 읽음 대상이 아니다(J2).
// - 데스크톱에서 본 것과 동기화하지 않는다(F5).
// 저장은 토큰 금고(SecureStore)와 섞지 않는다 — 앱 문서 폴더의 평범한 JSON(`runtime/phone-store.ts`).
import type { Channel, ChannelList } from './list'
import { allChannels } from './list'

/** 기억하는 채널 수 상한 — 오래 안 본 것부터 잊는다. 잊은 채널이 다시 보이면 「처음 보는 채널」 이다. */
export const UNREAD_CAPACITY = 500

export type SeenMark = { activityAt: number | null; outcome: string | null; lastSeenAt: number }
export type UnreadData = { v: 1; initialized: boolean; seen: Record<string, SeenMark> }

export const EMPTY_UNREAD: UnreadData = { v: 1, initialized: false, seen: {} }

export type UnreadStore = { load(): UnreadData | null; save(data: UnreadData): void }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 저장 파일 읽기 — 모양이 틀린 칸은 버린다. 파일 전체가 틀리면 빈 장부(= 첫 설치처럼 다음 목록이 기준선). */
export function readUnreadData(value: unknown): UnreadData {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.seen)) return { ...EMPTY_UNREAD, seen: {} }
  const seen: Record<string, SeenMark> = {}
  for (const [key, mark] of Object.entries(value.seen)) {
    if (!isRecord(mark) || typeof mark.lastSeenAt !== 'number') continue
    seen[key] = {
      activityAt: typeof mark.activityAt === 'number' ? mark.activityAt : null,
      outcome: typeof mark.outcome === 'string' ? mark.outcome : null,
      lastSeenAt: mark.lastSeenAt,
    }
  }
  return { v: 1, initialized: value.initialized === true, seen }
}

export class UnreadLedger {
  private data: UnreadData
  private readonly store: UnreadStore
  private readonly now: () => number

  constructor(input: { store: UnreadStore; now: () => number }) {
    this.store = input.store
    this.now = input.now
    this.data = input.store.load() ?? { ...EMPTY_UNREAD, seen: {} }
  }

  /** 새 목록을 봤다 — 처음 보는 채널의 기준선을 적는다. 바뀐 것이 있을 때만 저장한다. */
  observe(list: ChannelList): void {
    if (!list.available) return
    const now = this.now()
    let changed = false
    for (const channel of allChannels(list)) {
      if (channel.status !== 'live') continue
      const mark = this.data.seen[channel.key]
      if (mark === undefined) {
        // 첫 목록이면 지금 값이 기준선(전부 읽음), 그 뒤면 「활동 없음」 이 기준선(활동이 있으면 안 읽음).
        this.data.seen[channel.key] = this.data.initialized ? { activityAt: null, outcome: null, lastSeenAt: now } : markOf(channel, now)
        changed = true
      } else if (now - mark.lastSeenAt > 60_000) {
        mark.lastSeenAt = now
        changed = true
      }
    }
    if (!this.data.initialized) {
      this.data.initialized = true
      changed = true
    }
    if (changed) this.persist()
  }

  isUnread(channel: Channel): boolean {
    if (channel.status !== 'live') return false
    const mark = this.data.seen[channel.key]
    if (mark === undefined) return false
    if (channel.activityAt !== null && (mark.activityAt === null || channel.activityAt > mark.activityAt)) return true
    return channel.outcome !== null && channel.outcome !== mark.outcome
  }

  /** 채널을 열었다 — 지금 값이 기준선. */
  markRead(channel: Channel): void {
    if (channel.status !== 'live') return
    this.data.seen[channel.key] = markOf(channel, this.now())
    this.persist()
  }

  snapshot(): UnreadData {
    return this.data
  }

  private persist(): void {
    const keys = Object.keys(this.data.seen)
    if (keys.length > UNREAD_CAPACITY) {
      const keep = keys.sort((a, b) => (this.data.seen[b]?.lastSeenAt ?? 0) - (this.data.seen[a]?.lastSeenAt ?? 0)).slice(0, UNREAD_CAPACITY)
      const next: Record<string, SeenMark> = {}
      for (const key of keep) {
        const mark = this.data.seen[key]
        if (mark !== undefined) next[key] = mark
      }
      this.data.seen = next
    }
    this.store.save(this.data)
  }
}

function markOf(channel: Channel, now: number): SeenMark {
  return { activityAt: channel.activityAt, outcome: channel.outcome, lastSeenAt: now }
}
