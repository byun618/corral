// 한 herdr 세션 소켓에 붙어 있는 링크 — 부트스트랩 + 복구 루프.
//
// 부트스트랩 순서 (01-criteria.md K1, 스파이크 A4 가 통과시킨 그대로):
//   구독 → ack → 버퍼링 → session.snapshot → 버퍼 멱등 적용
// 구독은 replay 가 없으므로 ack 이후 도착분을 버퍼에 쌓아 두고, 스냅샷을 적용한 뒤 순서대로 흘린다.
//
// 복구 루프 (K6·K7): EOF 로 끊김 감지 → 백오프+jitter 재시도 → 재구독 → 스냅샷 재획득 → live 재개.
// 시도마다 새 소켓·새 error 리스너다 (line-socket.ts). 재시도 대상은 ENOENT 와 ECONNREFUSED 둘 다.

import type { LinkPhase, LinkState, SessionInfo } from '../../shared/types.js'
import { log } from '../log.js'
import { SUBSCRIPTION_TYPES, readRecord, type PushFrame } from './protocol.js'
import { HerdrRequestError, request } from './request.js'
import { Subscription } from './subscription.js'
import { WorkspaceStore } from './store.js'
import { checkUnixSocketPath } from '../unix-socket-path.js'

/** 백오프: equal jitter. 간격이 실제로 벌어지면서 매번 값이 다르다. 상한은 K6 의 15초 예산에 맞춘다. */
const BACKOFF_BASE_MS = 200
const BACKOFF_CAP_MS = 2000

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
  const half = ceiling / 2
  return Math.round(half + random() * half)
}

type Injection = { duplicateBufferedEvents: boolean; badSubscriptionType: string | null }

function readInjection(): Injection {
  return {
    duplicateBufferedEvents: process.env.CORRAL_INJECT_DUP === '1',
    badSubscriptionType: process.env.CORRAL_INJECT_BAD_SUB === '1' ? 'workspace.definitely_not_a_type' : null,
  }
}

export type SessionLinkHooks = { onChange: () => void }

export class SessionLink {
  readonly store = new WorkspaceStore()
  private readonly hooks: SessionLinkHooks
  private session: SessionInfo | null = null
  private subscription: Subscription | null = null
  private buffer: Array<{ frame: PushFrame; at: number }> = []
  private bootstrapping = false
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  private state: LinkState = {
    phase: 'idle',
    sessionName: null,
    socketPath: null,
    attempt: 0,
    nextRetryInMs: null,
    lastError: null,
    lastPushAt: null,
    bufferedAtSnapshot: null,
  }

  constructor(hooks: SessionLinkHooks) {
    this.hooks = hooks
  }

  linkState(): LinkState {
    return { ...this.state }
  }

  open(session: SessionInfo): void {
    this.close()
    this.stopped = false
    this.session = session
    this.store.reset()
    this.state = {
      ...this.state,
      sessionName: session.name,
      socketPath: session.socketPath,
      attempt: 0,
      lastError: null,
      bufferedAtSnapshot: null,
    }
    log('link.open', { session: session.name, socketPath: session.socketPath })
    void this.attempt()
  }

  close(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.subscription?.close()
    this.subscription = null
    this.buffer = []
    if (this.state.phase !== 'idle') {
      log('link.close', { session: this.state.sessionName })
      this.setPhase('idle')
    }
  }

  private setPhase(phase: LinkPhase, extra: Partial<LinkState> = {}): void {
    this.state = { ...this.state, phase, ...extra }
    log('link.phase', { phase, session: this.state.sessionName, attempt: this.state.attempt })
    this.hooks.onChange()
  }

  private async attempt(): Promise<void> {
    const session = this.session
    if (session === null || this.stopped) return
    this.state = { ...this.state, attempt: this.state.attempt + 1, nextRetryInMs: null }
    this.setPhase('connecting')

    // 경로 길이는 재시도로 나아지지 않는다 — 재시도 루프에 넣지 않고 그 자리에서 실패로 남긴다.
    const pathCheck = checkUnixSocketPath(session.socketPath)
    if (!pathCheck.ok) {
      log('link.socket_path_too_long', { socketPath: session.socketPath, bytes: pathCheck.bytes, limit: pathCheck.limit })
      this.setPhase('failed', { lastError: pathCheck.reason })
      return
    }

    const injection = readInjection()

    const subscription = new Subscription({
      onPush: (frame, at) => this.onPush(frame, at),
      onDrop: (reason, detail) => this.onDrop(reason, detail),
    })
    this.subscription = subscription
    this.buffer = []
    this.bootstrapping = true

    try {
      // ① 구독 먼저. 스냅샷보다 **먼저** 붙어야 그 사이 변화를 놓치지 않는다 (replay 없음).
      const types =
        injection.badSubscriptionType === null
          ? SUBSCRIPTION_TYPES
          : [...SUBSCRIPTION_TYPES, injection.badSubscriptionType]
      this.setPhase('subscribing')
      log('boot.subscribe.begin', { types: types.length, injectedBadType: injection.badSubscriptionType })
      const ack = await subscription.connect(session.socketPath, types)
      log('boot.subscribe.ack', { ack: JSON.stringify(ack) })

      // ② ack 이후 도착분은 버퍼로 간다 (this.bootstrapping === true).
      this.setPhase('buffering')

      // ③ 스냅샷은 **별도 커넥션**으로 부른다. 구독 커넥션으로 부르면 그 자리에서 구독이 죽는다.
      this.setPhase('snapshotting')
      log('boot.snapshot.request', {})
      const response = await request(session.socketPath, 'session.snapshot', {}, { reason: 'bootstrap' })
      if (response.error) {
        throw new HerdrRequestError(response.error.code ?? 'error', response.error.message ?? 'snapshot 실패')
      }
      const applied = this.store.applySnapshot(response.result)
      log('boot.snapshot.applied', { note: applied.note })

      // ④ 버퍼를 순서대로, 멱등하게 적용한다.
      const buffered = this.buffer
      this.buffer = []
      this.bootstrapping = false
      log('boot.buffer.apply.begin', { count: buffered.length, duplicateInjection: injection.duplicateBufferedEvents })
      for (const item of buffered) {
        const result = this.store.applyEvent(item.frame)
        log('boot.buffer.apply', { event: item.frame.event, changed: result.changed, note: result.note })
        if (injection.duplicateBufferedEvents) {
          const again = this.store.applyEvent(item.frame)
          log('boot.buffer.apply.duplicate', { event: item.frame.event, changed: again.changed, note: again.note })
        }
      }
      const converged = this.store.ids()
      log('boot.converged', {
        buffered: buffered.length,
        workspaces: converged.workspaces,
        tabs: converged.tabs,
        panes: converged.panes,
      })
      this.state = { ...this.state, bufferedAtSnapshot: buffered.length, lastError: null }
      this.setPhase('live')
      this.hooks.onChange()

      if (process.env.CORRAL_VERIFY_CONVERGE === '1') await this.verifyConvergence()
      if (process.env.CORRAL_PROBE_REQUESTS) await this.probeRequests(session)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      const code = 'code' in failure && typeof failure.code === 'string' ? failure.code : 'unknown'
      log('boot.failed', { code, message: failure.message, attempt: this.state.attempt })
      subscription.close()
      this.subscription = null
      this.bootstrapping = false
      if (code === 'invalid_request' || code === 'unknown_subscription') {
        // 구독 자체가 거부됐다 — 재시도해도 같은 결과다. 식별 가능한 실패로 남긴다.
        this.setPhase('failed', { lastError: `${code}: ${failure.message}` })
        return
      }
      this.scheduleRetry(`${code}: ${failure.message}`)
    }
  }

  /**
   * K1 — 수렴 집합이 **직후 재조회한 실제 상태**와 일치하는지 스스로 검사한다.
   * 비교용 스냅샷은 별도 커넥션으로 새로 받아 와 별도 저장소에 적용한다 (앱 상태를 건드리지 않는다).
   */
  async verifyConvergence(): Promise<{ match: boolean; converged: unknown; actual: unknown } | null> {
    const session = this.session
    if (session === null) return null
    try {
      const response = await request(session.socketPath, 'session.snapshot', {}, { reason: 'verify' })
      const truth = new WorkspaceStore()
      truth.applySnapshot(response.result)
      const mine = this.store.ids()
      const theirs = truth.ids()
      const same = JSON.stringify(mine) === JSON.stringify(theirs)
      log('boot.verify', { match: same, converged: mine, actual: theirs })
      return { match: same, converged: mine, actual: theirs }
    } catch (error) {
      log('boot.verify.error', { error: String(error) })
      return null
    }
  }

  /** K2·K3 — 구독이 살아 있는 동안 요청을 여러 번 보내도 push 가 계속 오는지. */
  private async probeRequests(session: SessionInfo): Promise<void> {
    const count = Number(process.env.CORRAL_PROBE_REQUESTS)
    if (!Number.isFinite(count) || count <= 0) return
    log('probe.requests.begin', { count, pushesSoFar: this.state.lastPushAt })
    for (let i = 1; i <= count; i++) {
      try {
        const response = await request(session.socketPath, 'ping', {}, { reason: `probe-${i}` })
        log('probe.requests.one', { i, result: JSON.stringify(response.result) })
      } catch (error) {
        log('probe.requests.error', { i, error: String(error) })
      }
      await sleep(150)
    }
    log('probe.requests.end', { count })
  }

  private onPush(frame: PushFrame, at: number): void {
    this.state = { ...this.state, lastPushAt: at }
    if (this.bootstrapping) {
      this.buffer.push({ frame, at })
      log('push.buffered', { event: frame.event, size: this.buffer.length })
      return
    }
    const result = this.store.applyEvent(frame)
    log('push.applied', {
      event: frame.event,
      changed: result.changed,
      note: result.note,
      subject: subjectOf(frame),
    })
    this.hooks.onChange()
  }

  private onDrop(reason: string, detail: string): void {
    if (this.stopped) return
    log('link.dropped', { reason, detail, phase: this.state.phase })
    this.subscription = null
    this.bootstrapping = false
    if (reason === 'local') return
    this.scheduleRetry(`구독 끊김(${reason}): ${detail}`)
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return
    const delay = backoffDelay(this.state.attempt)
    this.setPhase('reconnecting', { lastError: reason, nextRetryInMs: delay })
    log('link.retry.scheduled', { attempt: this.state.attempt, delayMs: delay, reason })
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.attempt()
    }, delay)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 로그에서 유발↔반영을 짝짓기 위한 주체 id (L3). */
function subjectOf(frame: PushFrame): string | null {
  const direct = frame.data['workspace_id']
  if (typeof direct === 'string') return direct
  const workspace = readRecord(frame.data, 'workspace')
  if (workspace !== null) {
    const id = workspace['workspace_id']
    if (typeof id === 'string') return id
  }
  const pane = readRecord(frame.data, 'pane')
  if (pane !== null) {
    const id = pane['workspace_id']
    if (typeof id === 'string') return id
  }
  return null
}
