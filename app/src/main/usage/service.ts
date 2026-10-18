// 사용량 갱신 일정 (LIFE-636 E7) — 수집기들을 언제 부를지, 실패를 어떻게 보일지 정한다. Electron 을 모른다(창 상태·푸시는 주입).
//
// 일정(00-analysis D6, Orca `service-polling.ts` 를 corral 값으로):
//   ⓐ 기본 5분 주기 — 배경 틱은 **창이 보이고 포커스일 때만**(`isActive`). 기동 때 한 번은 조회한다.
//   ⓑ 포커스 복귀 — 마지막 성공이 5분 넘었으면 즉시 1회, 아니면 0회.
//   ⓒ 팝오버 새로고침 = 즉시(지수 백오프 무시). 진행 중이면 그 요청을 같이 기다린다(중복 요청 0).
//   ⓓ provider 별 지수 백오프 30초 × 2^(실패-1), 상한 15분. 429 `Retry-After` 동안은 새로고침까지 포함해 그 provider 요청 0.
//   ⓔ 꺼 둔 provider 는 수집기를 부르지 않는다 — 키체인·파일·네트워크 접근 0.
//   ⓕ 실패해도 30분 안의 직전 값은 `stale` 로 남는다. 30분 넘으면 버리고 `error`.
//   ⓖ `dispose` — 타이머·진행 중 요청을 모두 정리한다.
//   ⓗ 요청 하나 10초 타임아웃(AbortSignal).
import { expireStale, type ProviderUsage, type UsageError, type UsageSnapshot, type UsageWindow } from '../../shared/usage.js'
import type { CollectorDeps, FetchOutcome, UsageCollector } from './collector.js'

export const USAGE_POLL_MS = 5 * 60 * 1000
export const USAGE_FOCUS_STALE_MS = 5 * 60 * 1000
export const USAGE_BACKOFF_BASE_MS = 30 * 1000
export const USAGE_BACKOFF_CAP_MS = 15 * 60 * 1000
export const USAGE_TIMEOUT_MS = 10 * 1000

export type UsageServiceOptions = {
  collectors: readonly UsageCollector[]
  isEnabled: (id: string) => boolean
  /** 창이 보이고 포커스인가 — 배경 틱의 조건. */
  isActive: () => boolean
  /** 요청 하나의 deps — signal 은 서비스가 만든다(타임아웃·끄기 취소). */
  deps: (signal: AbortSignal) => CollectorDeps
  onChange: (snapshot: UsageSnapshot) => void
  log: (tag: string, fields: Record<string, unknown>) => void
  now?: () => number
}

type Slot = {
  collector: UsageCollector
  usage: ProviderUsage
  failures: number
  backoffUntil: number
  retryAfterUntil: number
  inflight: Inflight | null
}

type Inflight = { controller: AbortController; timeout: ReturnType<typeof setTimeout>; promise: Promise<void> }

/** 진행 중 요청을 버린다 — 타임아웃 타이머도 지금 지운다(수집기가 abort 를 무시하고 매달려도 타이머가 남지 않게, ⓖ). */
function cancel(inflight: Inflight | null): void {
  if (inflight === null) return
  clearTimeout(inflight.timeout)
  inflight.controller.abort()
}

type Reason = 'start' | 'tick' | 'focus' | 'manual' | 'enabled'

export class UsageService {
  private readonly slots: Slot[]
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly options: UsageServiceOptions) {
    this.now = options.now ?? Date.now
    this.slots = options.collectors.map((collector) => ({
      collector,
      usage: options.isEnabled(collector.id) ? { status: 'loading' } : { status: 'disabled' },
      failures: 0,
      backoffUntil: 0,
      retryAfterUntil: 0,
      inflight: null,
    }))
  }

  /** 기동 — 켜진 provider 를 한 번 조회하고 5분 틱을 건다. */
  start(): void {
    if (this.disposed || this.timer !== null) return
    this.timer = setInterval(() => this.tick(), USAGE_POLL_MS)
    for (const slot of this.slots) void this.request({ slot, reason: 'start' })
  }

  /** 5분 틱 — 창이 보이고 포커스일 때만(ⓐ). */
  tick(): void {
    if (this.disposed || !this.options.isActive()) return
    for (const slot of this.slots) void this.request({ slot, reason: 'tick' })
  }

  /** 창 포커스 복귀(ⓑ) — 마지막 성공이 5분 넘었거나 성공이 없으면 즉시. */
  onFocus(): void {
    if (this.disposed) return
    const now = this.now()
    for (const slot of this.slots) {
      const updatedAt = lastSuccessAt(slot.usage)
      if (updatedAt === null || now - updatedAt > USAGE_FOCUS_STALE_MS) void this.request({ slot, reason: 'focus' })
    }
  }

  /** 새로고침 버튼(ⓒ) — id 가 없으면 전부. 끝난 뒤 스냅숏을 돌려준다. */
  async refresh(id: string | null): Promise<UsageSnapshot> {
    const targets = this.slots.filter((slot) => id === null || slot.collector.id === id)
    await Promise.all(targets.map((slot) => this.request({ slot, reason: 'manual' })))
    return this.snapshot()
  }

  /** 설정이 바뀌었다(E9ⓒ) — 꺼진 것은 즉시 비우고 요청을 취소, 새로 켜진 것은 즉시 1회. */
  settingsChanged(): void {
    if (this.disposed) return
    let changed = false
    for (const slot of this.slots) {
      const enabled = this.options.isEnabled(slot.collector.id)
      if (!enabled && slot.usage.status !== 'disabled') {
        const inflight = slot.inflight
        slot.inflight = null
        cancel(inflight)
        Object.assign(slot, { usage: { status: 'disabled' }, failures: 0, backoffUntil: 0, retryAfterUntil: 0 })
        changed = true
      } else if (enabled && slot.usage.status === 'disabled') {
        slot.usage = { status: 'loading' }
        changed = true
        void this.request({ slot, reason: 'enabled' })
      }
    }
    if (changed) this.emit()
  }

  snapshot(): UsageSnapshot {
    const now = this.now()
    return {
      providers: this.slots.map((slot) => ({
        id: slot.collector.id,
        name: slot.collector.name,
        usage: expireStale({ usage: slot.usage, now }),
        refreshing: slot.inflight !== null,
      })),
    }
  }

  /** 타이머·진행 중 요청 정리(ⓖ). 이후 호출은 아무것도 하지 않는다. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    for (const slot of this.slots) {
      const inflight = slot.inflight
      slot.inflight = null
      cancel(inflight)
    }
  }

  private request({ slot, reason }: { slot: Slot; reason: Reason }): Promise<void> {
    if (this.disposed || !this.options.isEnabled(slot.collector.id)) return Promise.resolve()
    if (slot.inflight !== null) return slot.inflight.promise
    const now = this.now()
    if (now < slot.retryAfterUntil) return Promise.resolve()
    if (reason !== 'manual' && reason !== 'enabled' && now < slot.backoffUntil) return Promise.resolve()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS)
    const promise = (async () => {
      let outcome: FetchOutcome
      try {
        outcome = await slot.collector.fetch(this.options.deps(controller.signal))
      } catch {
        // 수집기는 던지지 않는 계약이지만, 던져도 예외 메시지(경로·응답 조각이 섞일 수 있다)를 옮기지 않는다.
        outcome = { kind: 'error', error: { kind: 'network', message: '조회 실패' }, retryAfterMs: null }
      } finally {
        clearTimeout(timeout)
      }
      // 끄기·종료로 버려진 요청이면 결과를 버린다.
      if (slot.inflight?.controller !== controller) return
      slot.inflight = null
      this.apply({ slot, outcome })
      this.emit()
    })()
    slot.inflight = { controller, timeout, promise }
    this.options.log('usage.request', { provider: slot.collector.id, reason })
    this.emit()
    return promise
  }

  private apply({ slot, outcome }: { slot: Slot; outcome: FetchOutcome }): void {
    const now = this.now()
    switch (outcome.kind) {
      case 'ok':
        Object.assign(slot, { usage: { status: 'ok', windows: outcome.windows, updatedAt: now }, failures: 0, backoffUntil: 0, retryAfterUntil: 0 })
        this.options.log('usage.result', { provider: slot.collector.id, status: 'ok', windows: outcome.windows.length })
        return
      case 'unavailable':
        Object.assign(slot, { usage: { status: 'unavailable', reason: outcome.reason }, failures: 0, backoffUntil: 0, retryAfterUntil: 0 })
        this.options.log('usage.result', { provider: slot.collector.id, status: 'unavailable' })
        return
      case 'error': {
        slot.failures += 1
        const backoff = Math.min(USAGE_BACKOFF_CAP_MS, USAGE_BACKOFF_BASE_MS * 2 ** (slot.failures - 1))
        slot.backoffUntil = now + Math.max(backoff, outcome.retryAfterMs ?? 0)
        slot.retryAfterUntil = outcome.retryAfterMs === null ? 0 : now + outcome.retryAfterMs
        slot.usage = failedUsage({ previous: expireStale({ usage: slot.usage, now }), error: outcome.error, now })
        this.options.log('usage.result', { provider: slot.collector.id, status: slot.usage.status, error: outcome.error.kind, failures: slot.failures })
        return
      }
    }
  }

  private emit(): void {
    if (!this.disposed) this.options.onChange(this.snapshot())
  }
}

function lastSuccessAt(usage: ProviderUsage): number | null {
  switch (usage.status) {
    case 'ok':
    case 'stale':
      return usage.updatedAt
    case 'loading':
    case 'error':
    case 'unavailable':
    case 'disabled':
      return null
  }
}

/** 실패 — 직전 값이 있으면 `stale`(값 + 사유), 없으면 `error`(ⓕ). */
function failedUsage({ previous, error, now }: { previous: ProviderUsage; error: UsageError; now: number }): ProviderUsage {
  const kept = keptWindows(previous)
  return kept === null ? { status: 'error', error, checkedAt: now } : { status: 'stale', windows: kept.windows, updatedAt: kept.updatedAt, error }
}

function keptWindows(usage: ProviderUsage): { windows: UsageWindow[]; updatedAt: number } | null {
  switch (usage.status) {
    case 'ok':
    case 'stale':
      return { windows: usage.windows, updatedAt: usage.updatedAt }
    case 'loading':
    case 'error':
    case 'unavailable':
    case 'disabled':
      return null
  }
}
