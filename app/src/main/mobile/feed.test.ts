// 목록 구독 공급 (LIFE-580 J8 · L1ⓐⓓ · L10ⓑ) — 구독자 0 이면 변환 0 · 뭉침 · 스냅샷 공유 · 일련번호.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ListFeed, type ListMessage } from './feed.js'
import { FIXTURE_NOW, listFixture } from './list-fixture.js'
import type { ListInput } from './list.js'

afterEach(() => {
  vi.useRealTimers()
})

function harness(input: { coalesceMs?: number; maxWaitMs?: number } = {}) {
  let state = listFixture()
  const reads = { count: 0 }
  const logs: { tag: string; fields: Record<string, unknown> }[] = []
  const feed = new ListFeed({
    read: (): ListInput => {
      reads.count += 1
      return { state, prefs: null, now: FIXTURE_NOW }
    },
    log: (tag, fields = {}) => logs.push({ tag, fields }),
    coalesceMs: input.coalesceMs ?? 100,
    maxWaitMs: input.maxWaitMs ?? 300,
    refreshMs: 60_000,
  })
  const setState = (next: ReturnType<typeof listFixture>): void => {
    state = next
  }
  return { feed, reads, logs, setState }
}

function collector() {
  const got: ListMessage[] = []
  return { got, sink: (text: string) => got.push(JSON.parse(text)) }
}

describe('ListFeed', () => {
  it('L10ⓑ 구독자 0 이면 changed() 가 상태를 읽지도 변환하지도 않는다', () => {
    vi.useFakeTimers()
    const { feed, reads, logs } = harness()
    for (let i = 0; i < 100; i += 1) feed.changed()
    vi.advanceTimersByTime(5_000)
    expect(reads.count).toBe(0)
    expect(logs).toEqual([])
    // 구독이 끝난 뒤에도 같다.
    const unsubscribe = feed.subscribe(() => {})
    unsubscribe()
    const before = reads.count
    for (let i = 0; i < 10; i += 1) feed.changed()
    vi.advanceTimersByTime(5_000)
    expect(reads.count).toBe(before)
  })

  it('L1ⓐ 구독 = 전체 스냅샷, 변경 = 다음 번호의 전체, 같은 내용이면 안 보낸다', () => {
    vi.useFakeTimers()
    const { feed, setState } = harness()
    const a = collector()
    feed.subscribe(a.sink)
    expect(a.got).toHaveLength(1)
    expect(a.got[0]?.seq).toBe(1)
    expect(a.got[0]?.list.available).toBe(true)
    // 같은 내용 — revision 만 오른 꼴.
    feed.changed()
    vi.advanceTimersByTime(500)
    expect(a.got).toHaveLength(1)
    setState(listFixture({ p6: { agentStatus: 'working' } }))
    feed.changed()
    vi.advanceTimersByTime(500)
    expect(a.got.map((message) => message.seq)).toEqual([1, 2])
    expect(a.got[1]?.epoch).toBe(a.got[0]?.epoch)
  })

  it('뭉침 — 흔들려도 한 번, 첫 변경에서 maxWait 를 넘기지 않는다', () => {
    vi.useFakeTimers()
    const { feed, reads, setState } = harness({ coalesceMs: 100, maxWaitMs: 300 })
    const a = collector()
    feed.subscribe(a.sink)
    const readsAfterSubscribe = reads.count
    // 50ms 마다 계속 바뀐다 — 디바운스만이면 영원히 밀린다.
    for (let i = 0; i < 6; i += 1) {
      setState(listFixture({ p6: { agentStatus: i % 2 === 0 ? 'working' : 'blocked' } }))
      feed.changed()
      vi.advanceTimersByTime(50)
    }
    // 첫 변경 뒤 300ms 안에 한 번은 나갔다.
    expect(a.got.length).toBeGreaterThanOrEqual(2)
    vi.advanceTimersByTime(1_000)
    expect(reads.count - readsAfterSubscribe).toBeLessThanOrEqual(3)
  })

  it('L1ⓓ 동시 구독은 스냅샷 한 번을 공유한다 — 같은 문자열, read 1회', () => {
    const { feed, reads } = harness()
    const sinks = Array.from({ length: 8 }, () => collector())
    for (const sink of sinks) feed.subscribe(sink.sink)
    expect(reads.count).toBe(1)
    const seqs = new Set(sinks.map((sink) => sink.got[0]?.seq))
    expect(seqs).toEqual(new Set([1]))
    feed.stop()
  })

  it('구독이 새 내용을 만들면 기존 구독자에게도 간다(옛 목록에 머물지 않는다)', () => {
    vi.useFakeTimers()
    const { feed, setState } = harness()
    const a = collector()
    feed.subscribe(a.sink)
    setState(listFixture({ p9: { agentStatus: 'working', digest: { turnOutcome: null } } }))
    feed.changed()
    // 뭉침 타이머가 돌기 전에 새 구독이 들어온다.
    const b = collector()
    feed.subscribe(b.sink)
    expect(a.got.map((message) => message.seq)).toEqual([1, 2])
    expect(b.got.map((message) => message.seq)).toEqual([2])
    vi.advanceTimersByTime(1_000)
    expect(a.got).toHaveLength(2)
  })

  it('재구독(포그라운드 복귀)은 지금 번호의 전체를 다시 받는다', () => {
    const { feed } = harness()
    const a = collector()
    const stop = feed.subscribe(a.sink)
    stop()
    feed.subscribe(a.sink)
    expect(a.got).toHaveLength(2)
    expect(a.got[1]?.list).toEqual(a.got[0]?.list)
    expect(a.got[1]?.seq).toBe(a.got[0]?.seq)
    feed.stop()
  })

  it('상태를 아직 못 냈으면(read null) 보내지 않고, 첫 변경 때 보낸다', () => {
    vi.useFakeTimers()
    let ready = false
    const feed = new ListFeed({ read: () => (ready ? { state: listFixture(), prefs: null, now: FIXTURE_NOW } : null), log: () => {}, coalesceMs: 10, maxWaitMs: 50, refreshMs: 60_000 })
    const a = collector()
    feed.subscribe(a.sink)
    expect(a.got).toHaveLength(0)
    ready = true
    feed.changed()
    vi.advanceTimersByTime(100)
    expect(a.got).toHaveLength(1)
  })

  it('push 비용 로그 — 만들기·직렬화(buildMs)·전송(sendMs), 내용은 없다', () => {
    const { feed, logs } = harness()
    feed.subscribe(() => {})
    const built = logs.find((entry) => entry.tag === 'mobile.list_built')
    expect(built?.fields).toEqual({ seq: 1, bytes: expect.any(Number), buildMs: expect.any(Number), subscribers: 1 })
    expect(logs.find((entry) => entry.tag === 'mobile.list_push')?.fields).toEqual({ seq: 1, subscribers: 1, sendMs: expect.any(Number) })
    feed.stop()
  })
})
