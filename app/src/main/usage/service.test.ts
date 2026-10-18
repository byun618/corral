// LIFE-636 E7 갱신 일정 — 가짜 시계·가짜 수집기로 ⓐ~ⓗ. E6ⓑ: 시험 토큰이 스냅숏(IPC 페이로드)·로그 인자에 0회.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSnapshot } from '../../shared/usage.js'
import type { CollectorDeps, FetchOutcome, UsageCollector } from './collector.js'
import { TEST_TOKEN, fakeDeps } from './fake-deps.test-helper.js'
import { USAGE_BACKOFF_BASE_MS, USAGE_BACKOFF_CAP_MS, USAGE_POLL_MS, USAGE_TIMEOUT_MS, UsageService } from './service.js'

const OK: FetchOutcome = { kind: 'ok', windows: [{ label: '7d', windowMinutes: 10080, usedPercent: 42, resetsAt: null }] }
const fail = (kind: 'network' | 'rate_limited' = 'network', retryAfterMs: number | null = null): FetchOutcome => ({ kind: 'error', error: { kind, message: `실패 ${kind}` }, retryAfterMs })

/** 결과를 차례로 내는 가짜 수집기. `hold` 면 풀어 줄 때까지 기다린다. */
function collector(id: string): UsageCollector & { calls: number; next: FetchOutcome[]; hold: boolean; release: () => void; signals: AbortSignal[] } {
  let waiting: (() => void)[] = []
  const next: FetchOutcome[] = []
  const signals: AbortSignal[] = []
  const self = {
    id,
    name: id.toUpperCase(),
    calls: 0,
    next,
    hold: false,
    signals,
    release: () => { for (const resolve of waiting.splice(0)) resolve() },
    fetch: async (deps: CollectorDeps): Promise<FetchOutcome> => {
      self.calls += 1
      self.signals.push(deps.signal)
      // 수집기 안에서만 토큰을 쥔다 — 서비스 밖으로 나가는지 본다.
      const token = TEST_TOKEN
      if (self.hold) await new Promise<void>((resolve) => { waiting.push(resolve) })
      if (deps.signal.aborted) return { kind: 'error', error: { kind: 'timeout', message: '응답이 늦음 — 시간 초과' }, retryAfterMs: null }
      void token
      return self.next.shift() ?? OK
    },
  }
  waiting = []
  return self
}

let active = true
let enabled: Record<string, boolean> = {}
const pushes: UsageSnapshot[] = []
const logs: unknown[][] = []
function service(collectors: UsageCollector[]): UsageService {
  return new UsageService({
    collectors,
    isEnabled: (id) => enabled[id] ?? false,
    isActive: () => active,
    deps: (signal) => fakeDeps({ signal }).deps,
    onChange: (snapshot) => pushes.push(JSON.parse(JSON.stringify(snapshot))),
    log: (...args) => logs.push(args),
  })
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const usageOf = (svc: UsageService, id: string) => svc.snapshot().providers.find((entry) => entry.id === id)!.usage

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
  active = true
  enabled = { a: true, b: true }
  pushes.length = 0
  logs.length = 0
})
afterEach(() => vi.useRealTimers())

describe('E7ⓐ 5분 주기 — 창이 보이고 포커스일 때만', () => {
  it('기동 1회 → 5분마다 1회, 비활성이면 틱 0회', async () => {
    const a = collector('a')
    const svc = service([a])
    svc.start()
    await flush()
    expect(a.calls).toBe(1)
    expect(usageOf(svc, 'a').status).toBe('ok')
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
    expect(a.calls).toBe(2)
    active = false
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3)
    expect(a.calls).toBe(2)
    active = true
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
    expect(a.calls).toBe(3)
    svc.dispose()
  })
})

describe('E7ⓑ 포커스 복귀', () => {
  it('마지막 성공 5분 이내면 0회, 넘으면 즉시 1회', async () => {
    const a = collector('a')
    const svc = service([a])
    active = false
    svc.start()
    await flush()
    expect(a.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(2)
    svc.dispose()
  })
})

describe('E7ⓒ 새로고침 — 즉시, 진행 중이면 중복 0', () => {
  it('동시 새로고침 두 번 = 요청 1회, refreshing 표시', async () => {
    const a = collector('a')
    const svc = service([a])
    svc.start()
    await flush()
    a.hold = true
    const first = svc.refresh('a')
    const second = svc.refresh(null)
    await flush()
    expect(a.calls).toBe(2)
    expect(svc.snapshot().providers[0]!.refreshing).toBe(true)
    a.release()
    await Promise.all([first, second])
    expect(a.calls).toBe(2)
    expect(svc.snapshot().providers[0]!.refreshing).toBe(false)
    svc.dispose()
  })
  it('지수 백오프 중이어도 새로고침은 간다', async () => {
    const a = collector('a')
    a.next = [fail()]
    const svc = service([a])
    svc.start()
    await flush()
    await svc.refresh('a')
    expect(a.calls).toBe(2)
    svc.dispose()
  })
})

describe('E7ⓓ 백오프 · Retry-After', () => {
  it('실패마다 30초 × 2^(n-1), 상한 15분 — 그 사이 틱·포커스 요청 0', async () => {
    const a = collector('a')
    a.next = Array.from({ length: 8 }, () => fail())
    const svc = service([a])
    svc.start()
    await flush()
    expect(a.calls).toBe(1)
    // 백오프 30초 안의 포커스 = 0
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(USAGE_BACKOFF_BASE_MS)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(2)
    // 2번째 실패 → 60초. 30초 뒤 포커스 0, 60초 뒤 1
    await vi.advanceTimersByTimeAsync(30_000)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(3)
    svc.dispose()
    expect(Math.min(USAGE_BACKOFF_CAP_MS, USAGE_BACKOFF_BASE_MS * 2 ** 9)).toBe(15 * 60_000)
  })
  it('백오프 상한 15분 — 실패 6번 뒤에도 15분이면 다시 간다', async () => {
    const a = collector('a')
    a.next = Array.from({ length: 10 }, () => fail())
    const svc = service([a])
    svc.start()
    await flush()
    for (let i = 0; i < 6; i++) await svc.refresh('a')
    expect(a.calls).toBe(7)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(7)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(8)
    svc.dispose()
  })
  it('429 Retry-After 동안 새로고침 포함 요청 0, 지나면 간다', async () => {
    const a = collector('a')
    a.next = [fail('rate_limited', 10 * 60_000)]
    const svc = service([a])
    svc.start()
    await flush()
    await svc.refresh('a')
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
    expect(a.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
    await svc.refresh('a')
    expect(a.calls).toBeGreaterThanOrEqual(2)
    svc.dispose()
  })
})

describe('E7ⓔ 꺼 둔 provider — 접근 0 · E9ⓒ 즉시 반영', () => {
  it('꺼짐이면 수집기를 부르지 않는다, 켜면 즉시 1회, 끄면 진행 중 요청 취소·disabled', async () => {
    const a = collector('a')
    enabled = { a: false }
    const svc = service([a])
    svc.start()
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 2)
    svc.onFocus()
    await svc.refresh(null)
    expect(a.calls).toBe(0)
    expect(usageOf(svc, 'a')).toEqual({ status: 'disabled' })
    enabled = { a: true }
    a.hold = true
    svc.settingsChanged()
    await flush()
    expect(a.calls).toBe(1)
    expect(usageOf(svc, 'a')).toEqual({ status: 'loading' })
    enabled = { a: false }
    svc.settingsChanged()
    expect(a.signals[0]!.aborted).toBe(true)
    a.release()
    await flush()
    expect(usageOf(svc, 'a')).toEqual({ status: 'disabled' })
    svc.dispose()
  })
})

describe('E7ⓕ 오류 때 직전 값 유지(stale) — 30분 넘으면 error', () => {
  it('ok → 실패 = stale(값 + 사유) → 30분 뒤 error', async () => {
    const a = collector('a')
    a.next = [OK, fail(), fail()]
    const svc = service([a])
    svc.start()
    await flush()
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
    const stale = usageOf(svc, 'a')
    expect(stale).toMatchObject({ status: 'stale', windows: OK.kind === 'ok' ? OK.windows : [], error: { kind: 'network' } })
    // 창이 쉬면 틱이 없다 — 직전 값이 그대로 늙는다.
    active = false
    await vi.advanceTimersByTimeAsync(24 * 60_000)
    expect(usageOf(svc, 'a').status).toBe('stale')
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(usageOf(svc, 'a')).toMatchObject({ status: 'error', error: { kind: 'network' } })
    svc.dispose()
  })
  it('값이 없을 때의 실패 = error · unavailable 은 직전 값을 버린다', async () => {
    const a = collector('a')
    a.next = [fail(), OK, { kind: 'unavailable', reason: '로그인 정보 없음' }]
    const svc = service([a])
    svc.start()
    await flush()
    expect(usageOf(svc, 'a').status).toBe('error')
    await svc.refresh('a')
    expect(usageOf(svc, 'a').status).toBe('ok')
    await svc.refresh('a')
    expect(usageOf(svc, 'a')).toEqual({ status: 'unavailable', reason: '로그인 정보 없음' })
    svc.dispose()
  })
})

describe('E7ⓖ 정리 · ⓗ 타임아웃', () => {
  it('dispose 뒤 남는 타이머 0, 진행 중 요청 취소, 이후 호출 무동작', async () => {
    const a = collector('a')
    const svc = service([a])
    svc.start()
    await flush()
    a.hold = true
    void svc.refresh('a')
    await flush()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    svc.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(a.signals.at(-1)!.aborted).toBe(true)
    const before = a.calls
    svc.onFocus()
    svc.tick()
    await svc.refresh(null)
    expect(a.calls).toBe(before)
    a.release()
  })
  it('10초 타임아웃 — signal 이 끊기고 timeout 으로 보인다', async () => {
    const a = collector('a')
    a.hold = true
    const svc = service([a])
    svc.start()
    await vi.advanceTimersByTimeAsync(USAGE_TIMEOUT_MS - 1)
    expect(a.signals[0]!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.signals[0]!.aborted).toBe(true)
    a.release()
    await flush()
    expect(usageOf(svc, 'a')).toMatchObject({ status: 'error', error: { kind: 'timeout' } })
    svc.dispose()
  })
})

describe('E6ⓑ 토큰은 main 밖으로 안 나간다', () => {
  it('스냅숏 푸시(직렬화)·로그 인자에 시험 토큰 0회', async () => {
    const a = collector('a')
    a.next = [OK, fail(), fail('rate_limited', 1000)]
    const svc = service([a])
    svc.start()
    await flush()
    await svc.refresh('a')
    await vi.advanceTimersByTimeAsync(USAGE_BACKOFF_BASE_MS)
    await svc.refresh('a')
    expect(pushes.length).toBeGreaterThan(3)
    expect(JSON.stringify(pushes)).not.toContain(TEST_TOKEN)
    expect(JSON.stringify(logs)).not.toContain(TEST_TOKEN)
    svc.dispose()
  })
})

describe('fix1 — 리뷰 r1 재현을 시험으로', () => {
  it('R1-2 헤더 없는 429 — 백오프 동안 새로고침 5번·켜기도 요청 0(첫 요청 1회만), 백오프가 지나면 새로고침이 간다', async () => {
    const a = collector('a')
    a.next = [fail('rate_limited', null)]
    const svc = service([a])
    svc.start()
    await flush()
    for (let i = 0; i < 5; i++) await svc.refresh('a')
    expect(a.calls).toBe(1)
    // 끄고 켜기로도 건너뛰지 못한다 — 켜면 요청 대신 「요청 제한」 상태.
    enabled = { a: false }
    svc.settingsChanged()
    enabled = { a: true }
    svc.settingsChanged()
    await flush()
    expect(a.calls).toBe(1)
    expect(usageOf(svc, 'a')).toMatchObject({ status: 'error', error: { kind: 'rate_limited' } })
    // 대기가 끝나면 다음 틱(창 활성)이 다시 부른다.
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
    expect(a.calls).toBe(2)
    svc.dispose()
  })
  it('R1-2 헤더 없는 429 → 백오프(30초)가 지나면 새로고침이 간다', async () => {
    const a = collector('a')
    a.next = [fail('rate_limited', null)]
    const svc = service([a])
    svc.start()
    await flush()
    await svc.refresh('a')
    expect(a.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(USAGE_BACKOFF_BASE_MS)
    await svc.refresh('a')
    expect(a.calls).toBe(2)
    svc.dispose()
  })
  it('R1-2 유지 — 5xx·네트워크 실패 뒤 새로고침은 바로 간다', async () => {
    const a = collector('a')
    a.next = [fail('network'), fail('network')]
    const svc = service([a])
    svc.start()
    await flush()
    await svc.refresh('a')
    await svc.refresh('a')
    expect(a.calls).toBe(3)
    svc.dispose()
  })
  it('R1-3 unavailable — 포커스 10번 = 요청 0(기동 1회만), 60초 지나면 포커스 1회(r2 R2-2), 새로고침은 바로', async () => {
    const a = collector('a')
    a.next = Array.from({ length: 5 }, (): FetchOutcome => ({ kind: 'unavailable', reason: '로그인 정보 없음' }))
    active = false
    const svc = service([a])
    svc.start()
    await flush()
    for (let i = 0; i < 10; i++) {
      svc.onFocus()
      await flush()
    }
    expect(a.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000 + 1)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(2)
    await svc.refresh('a')
    expect(a.calls).toBe(3)
    svc.dispose()
  })
  it('R1-4ⓑ 못 읽은 창 — 값은 없고 로그 한 줄(provider·skipped 개수)', async () => {
    const a = collector('a')
    a.next = [{ kind: 'ok', windows: OK.kind === 'ok' ? OK.windows : [], skipped: 2 }]
    const svc = service([a])
    svc.start()
    await flush()
    const result = logs.find((entry) => entry[0] === 'usage.result')
    expect(result?.[1]).toEqual({ provider: 'a', status: 'ok', windows: 1, skipped: 2 })
    expect(usageOf(svc, 'a')).toMatchObject({ status: 'ok', windows: OK.kind === 'ok' ? OK.windows : [] })
    svc.dispose()
  })
  it('r2 R2-2 로그인 직후 — unavailable → ok 수집기: 30초 뒤 포커스는 건너뛰고, 61초 뒤 포커스면 1회 더 조회해 ok', async () => {
    const a = collector('a')
    a.next = [{ kind: 'unavailable', reason: '로그인 정보 없음' }, OK]
    active = false
    const svc = service([a])
    svc.start()
    await flush()
    expect(usageOf(svc, 'a').status).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(30_000)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(31_000)
    svc.onFocus()
    await flush()
    expect(a.calls).toBe(2)
    expect(usageOf(svc, 'a').status).toBe('ok')
    svc.dispose()
  })
})
