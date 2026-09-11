// 한 herdr 세션 소켓에 붙어 있는 링크 — 부트스트랩 + 복구 루프 + 주기 재동기.
//
// 부트스트랩 순서 (스파이크 A4 가 통과시킨 그대로):
//   구독 → ack → 버퍼링 → session.snapshot → 버퍼 멱등 적용
// 구독은 replay 가 없으므로 ack 이후 도착분을 버퍼에 쌓아 두고, 스냅샷을 적용한 뒤 순서대로 흘린다.
//
// 복구 루프: EOF 로 끊김 감지 → 백오프+jitter 재시도 → 재구독 → 스냅샷 재획득 → live 재개.
// 시도마다 새 소켓·새 error 리스너다 (line-socket.ts).
//
// **주기 재동기** (기준 N7): push 는 유실된다 (실측 152/274). 구독은 갱신이지 진실이 아니다 —
// 진실은 스냅샷이다. 그래서 커넥션이 멀쩡해도 주기적으로 스냅샷을 다시 받아 맞춘다.

import type { LinkPhase, LinkState, SessionInfo } from '../../../shared/types.js'
import { log } from '../../log.js'
import { checkUnixSocketPath } from '../../unix-socket-path.js'
import { SUBSCRIPTION_TYPES, agentStatusSubscriptions, subjectOf, type PushFrame } from './protocol.js'
import { HerdrRequestError, request } from './request.js'
import { Subscription } from './subscription.js'
import { WorkspaceStore } from './store.js'

/** 백오프: equal jitter. 간격이 실제로 벌어지면서 매번 값이 다르다. */
const BACKOFF_BASE_MS = 200
const BACKOFF_CAP_MS = 2000

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
  const half = ceiling / 2
  return Math.round(half + random() * half)
}

/** pane 이 우르르 생길 때 상태 구독 커넥션을 매번 새로 열지 않도록 뭉치는 시간. */
const AGENT_SUBSCRIPTION_DEBOUNCE_MS = 400

/**
 * 주기 재동기 간격 (A4).
 *
 * 30초를 고른 이유: 유실은 드물지만 **한 번 어긋나면 사용자가 알아챌 때까지 어긋난 채로 있다.**
 * 사람이 목록을 다시 보는 주기(수십 초)보다 짧으면 "본 것이 틀렸다" 는 일이 거의 안 생기고,
 * 비용은 세션당 30초에 요청 1건이라 무시할 만하다. 창에 포커스가 돌아올 때도 한 번 돈다 —
 * 그때가 사용자가 실제로 목록을 읽는 순간이라서다.
 * 계측은 `CORRAL_RESYNC_MS` 로 바꾼다 (N5 는 길게, N7 은 짧게).
 */
export const DEFAULT_RESYNC_MS = 30_000

function resyncIntervalMs(): number {
  const raw = Number(process.env.CORRAL_RESYNC_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESYNC_MS
}

export type SessionLinkHooks = {
  onChange: () => void
  /** 목록이 실제로 바뀌었다 — repo 층(worktree 열림상태)을 다시 보라는 신호. */
  onTopologyChange?: () => void
}

export class SessionLink {
  readonly store = new WorkspaceStore()
  private readonly hooks: SessionLinkHooks
  /**
   * 링크 세대. `open()`·`close()` 마다 올라간다.
   * 부트스트랩은 비동기라(구독 → ack → 스냅샷 → 버퍼) 도중에 세션을 바꾸면 **먼저 나간 시도가
   * 뒤늦게 돌아온다**. 그대로 두면 옛 세션의 스냅샷이 새 세션의 저장소에 부어진다.
   */
  private generation = 0
  private session: SessionInfo | null = null
  private subscription: Subscription | null = null
  private agentSubscription: Subscription | null = null
  private agentPaneKey = ''
  private agentTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  private buffer: Array<{ frame: PushFrame; at: number }> = []
  private bootstrapping = false
  private resyncing = false
  private stopped = false
  /** 계측용 — push 를 **조용히 버린다** (N7 의 유실 주입). 커넥션은 살아 있다. */
  private droppingPush = false
  private state: LinkState = {
    phase: 'idle',
    sessionName: null,
    socketPath: null,
    attempt: 0,
    nextRetryInMs: null,
    lastError: null,
    lastPushAt: null,
    bufferedAtSnapshot: null,
    lastResyncAt: null,
    lastResyncNote: null,
    resyncCount: 0,
    droppingPush: false,
  }

  constructor(hooks: SessionLinkHooks) {
    this.hooks = hooks
  }

  linkState(): LinkState {
    return { ...this.state }
  }

  /**
   * 계측 스위치 — 구독 push 를 버리기 시작/멈춘다.
   *
   * **소켓을 끊지 않는다**: 끊으면 EOF 복구 루프가 곧바로 재부트스트랩(=스냅샷)을 돌려서
   * "재동기가 돌아서 맞췄다" 가 증명되지 않는다. 실측한 유실은 커넥션이 멀쩡한 채로 일어났다.
   */
  setDroppingPush(dropping: boolean): void {
    this.droppingPush = dropping
    this.state = { ...this.state, droppingPush: dropping }
    log('link.drop_push', { dropping })
    this.hooks.onChange()
  }

  open(session: SessionInfo): void {
    this.close()
    this.generation += 1
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
    this.generation += 1
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.resyncTimer) clearInterval(this.resyncTimer)
    this.resyncTimer = null
    if (this.agentTimer) clearTimeout(this.agentTimer)
    this.agentTimer = null
    this.subscription?.close()
    this.subscription = null
    this.agentSubscription?.close()
    this.agentSubscription = null
    this.agentPaneKey = ''
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
    const generation = this.generation
    const stale = (): boolean => generation !== this.generation
    this.state = { ...this.state, attempt: this.state.attempt + 1, nextRetryInMs: null }
    this.setPhase('connecting')

    // 경로 길이는 재시도로 나아지지 않는다 — 그 자리에서 식별 가능한 실패로 남긴다.
    const pathCheck = checkUnixSocketPath(session.socketPath)
    if (!pathCheck.ok) {
      log('link.socket_path_too_long', { socketPath: session.socketPath, bytes: pathCheck.bytes })
      this.setPhase('failed', { lastError: pathCheck.reason })
      return
    }

    const subscription = new Subscription({
      label: 'main',
      onPush: (frame, at) => {
        if (stale()) return
        this.onPush(frame, at)
      },
      onDrop: (reason, detail) => {
        if (stale()) return
        this.onDrop(reason, detail)
      },
    })
    this.subscription = subscription
    this.buffer = []
    this.bootstrapping = true

    try {
      // ① 구독 먼저. 스냅샷보다 **먼저** 붙어야 그 사이 변화를 놓치지 않는다 (replay 없음).
      this.setPhase('subscribing')
      await subscription.connect(session.socketPath, SUBSCRIPTION_TYPES)
      if (this.abandon(subscription, generation, 'subscribe.ack')) return

      // ② ack 이후 도착분은 버퍼로 간다 (this.bootstrapping === true).
      this.setPhase('buffering')

      // ③ 스냅샷은 **별도 커넥션**으로 부른다. 구독 커넥션으로 부르면 그 자리에서 구독이 죽는다.
      this.setPhase('snapshotting')
      const response = await request(session.socketPath, 'session.snapshot', {}, { reason: 'bootstrap' })
      // 여기부터 **공용 저장소를 건드린다.** 세대가 바뀌었으면 손대지 않는다.
      if (this.abandon(subscription, generation, 'snapshot.response')) return
      if (response.error) {
        throw new HerdrRequestError(response.error.code ?? 'error', response.error.message ?? 'snapshot 실패')
      }
      const applied = this.store.applySnapshot(response.result)
      log('boot.snapshot.applied', { note: applied.note })

      // ④ 버퍼를 순서대로, 멱등하게 적용한다.
      const buffered = this.buffer
      this.buffer = []
      this.bootstrapping = false
      for (const item of buffered) {
        const result = this.store.applyEvent(item.frame)
        log('boot.buffer.apply', {
          event: item.frame.event,
          subject: subjectOf(item.frame),
          changed: result.changed,
          note: result.note,
        })
      }
      log('boot.converged', { buffered: buffered.length, ...this.store.ids() })
      // 성공했으면 재시도 카운터를 턴다 — 안 털면 다음 끊김의 백오프가 늘 상한에서 시작한다.
      this.state = { ...this.state, bufferedAtSnapshot: buffered.length, lastError: null, attempt: 0 }
      this.setPhase('live')
      this.hooks.onTopologyChange?.()
      this.scheduleAgentSubscription()
      this.startResync()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      const code = 'code' in failure && typeof failure.code === 'string' ? failure.code : 'unknown'
      log('boot.failed', { code, message: failure.message, attempt: this.state.attempt })
      subscription.close()
      if (stale()) {
        log('link.attempt.stale', { at: 'boot.failed', generation, current: this.generation })
        return
      }
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

  // --- 재동기 (N7) -------------------------------------------------------------

  private startResync(): void {
    if (this.resyncTimer !== null) return
    const every = resyncIntervalMs()
    log('resync.scheduled', { everyMs: every })
    this.resyncTimer = setInterval(() => void this.resync('timer'), every)
  }

  /**
   * 스냅샷을 다시 받아 어긋난 것을 맞춘다. **덮어쓰기가 아니라 대조 후 수정**이다 —
   * 무엇이 어긋나 있었는지가 로그에 남아야 "재동기가 돌아서 맞췄다" 를 말할 수 있다.
   */
  async resync(reason: string): Promise<{ ok: boolean; note: string }> {
    const session = this.session
    if (session === null || this.stopped || this.state.phase !== 'live') {
      return { ok: false, note: `재동기 건너뜀 (phase=${this.state.phase})` }
    }
    if (this.resyncing) return { ok: false, note: '재동기 진행 중' }
    this.resyncing = true
    const generation = this.generation
    const requestedAt = Date.now()
    try {
      const response = await request(session.socketPath, 'session.snapshot', {}, { reason: `resync:${reason}` })
      if (generation !== this.generation || this.stopped) return { ok: false, note: '세대가 바뀜' }
      if (response.error) throw new HerdrRequestError(response.error.code ?? 'error', response.error.message ?? '')
      const result = this.store.reconcile(response.result, requestedAt)
      this.state = {
        ...this.state,
        lastResyncAt: Date.now(),
        lastResyncNote: result.note,
        resyncCount: this.state.resyncCount + 1,
      }
      log('resync.applied', {
        reason,
        requestedAt,
        changed: result.changed,
        note: result.note,
        added: result.added,
        removed: result.removed,
        keptNewer: result.keptNewer,
        after: this.store.ids(),
      })
      this.hooks.onChange()
      if (result.changed) {
        this.hooks.onTopologyChange?.()
        this.scheduleAgentSubscription()
      }
      return { ok: true, note: result.note }
    } catch (error) {
      log('resync.failed', { reason, error: String(error) })
      return { ok: false, note: String(error) }
    } finally {
      this.resyncing = false
    }
  }

  /**
   * 대조용 — **지금 herdr 가 뭐라고 하나**를 앱 상태를 건드리지 않고 떠 본다.
   * 별도 저장소에 적용해 id 집합만 돌려준다.
   */
  async herdrIds(): Promise<{ workspaces: string[]; tabs: string[]; panes: string[] } | null> {
    const session = this.session
    if (session === null) return null
    try {
      const response = await request(session.socketPath, 'session.snapshot', {}, { reason: 'verify' })
      const truth = new WorkspaceStore()
      truth.applySnapshot(response.result)
      return truth.ids()
    } catch (error) {
      log('verify.failed', { error: String(error) })
      return null
    }
  }

  // --- 상태 전이 구독 ----------------------------------------------------------

  private scheduleAgentSubscription(): void {
    if (this.stopped || this.agentTimer !== null) return
    this.agentTimer = setTimeout(() => {
      this.agentTimer = null
      void this.openAgentSubscription()
    }, AGENT_SUBSCRIPTION_DEBOUNCE_MS)
  }

  private async openAgentSubscription(): Promise<void> {
    const session = this.session
    if (session === null || this.stopped) return
    const generation = this.generation
    const paneIds = this.store.paneIds()
    const key = paneIds.join(',')
    if (key === this.agentPaneKey) return
    this.agentPaneKey = key
    this.agentSubscription?.close()
    this.agentSubscription = null
    if (paneIds.length === 0) return

    const subscription = new Subscription({
      // **일부러 자주 닫혔다 열리는 커넥션이다.** 측정이 구독 끊김을 셀 때 본 구독과 섞으면 안 된다.
      label: 'agent',
      onPush: (frame, at) => {
        if (generation !== this.generation) return
        if (this.droppingPush) {
          log('push.dropped', { label: 'agent', event: frame.event })
          return
        }
        this.state = { ...this.state, lastPushAt: at }
        const result = this.store.applyEvent(frame)
        log('agent.push.applied', { event: frame.event, changed: result.changed, note: result.note })
        if (result.changed) this.hooks.onChange()
      },
      onDrop: (reason, detail) => {
        if (generation !== this.generation) return
        log('agent.sub.dropped', { reason, detail })
        this.agentSubscription = null
        this.agentPaneKey = ''
        // 본 구독이 살아 있으면 상태 구독만 다시 연다. 죽었으면 본 구독의 복구 루프가 처리한다.
        if (reason !== 'local' && this.state.phase === 'live') this.scheduleAgentSubscription()
      },
    })
    this.agentSubscription = subscription
    try {
      await subscription.connect(session.socketPath, agentStatusSubscriptions(paneIds))
      if (generation !== this.generation) {
        subscription.close()
        return
      }
      log('agent.sub.open', { panes: paneIds.length })
    } catch (error) {
      log('agent.sub.failed', { error: String(error), panes: paneIds.length })
      subscription.close()
      if (this.agentSubscription === subscription) this.agentSubscription = null
      this.agentPaneKey = ''
    }
  }

  // --- push ------------------------------------------------------------------

  private onPush(frame: PushFrame, at: number): void {
    if (this.droppingPush) {
      log('push.dropped', { label: 'main', event: frame.event, subject: subjectOf(frame) })
      return
    }
    this.state = { ...this.state, lastPushAt: at }
    if (this.bootstrapping) {
      this.buffer.push({ frame, at })
      log('push.buffered', { event: frame.event, subject: subjectOf(frame), size: this.buffer.length })
      return
    }
    const result = this.store.applyEvent(frame)
    log('push.applied', { event: frame.event, changed: result.changed, note: result.note, subject: subjectOf(frame) })
    this.hooks.onChange()
    if (result.changed || frame.event.startsWith('worktree_')) {
      this.hooks.onTopologyChange?.()
      this.scheduleAgentSubscription()
    }
  }

  private onDrop(reason: string, detail: string): void {
    if (this.stopped) return
    log('link.dropped', { reason, detail, phase: this.state.phase })
    this.subscription = null
    this.bootstrapping = false
    if (this.resyncTimer) clearInterval(this.resyncTimer)
    this.resyncTimer = null
    if (reason === 'local') return
    this.scheduleRetry(`구독 끊김(${reason}): ${detail}`)
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return
    const delay = backoffDelay(this.state.attempt)
    this.setPhase('reconnecting', { lastError: reason, nextRetryInMs: delay })
    log('link.retry.scheduled', { attempt: this.state.attempt, delayMs: delay, reason })
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.attempt()
    }, delay)
  }

  /**
   * 이 시도가 낡았으면 자기 커넥션을 닫고 물러난다. 닫아 주지 않으면 옛 세션의 소켓이 계속
   * 살아서 push 를 뱉는다 — 헤더와 목록이 다른 세션을 가리키는 화면이 그렇게 만들어진다.
   */
  private abandon(subscription: Subscription, generation: number, at: string): boolean {
    if (generation === this.generation) return false
    log('link.attempt.stale', { at, generation, current: this.generation })
    subscription.close()
    return true
  }
}
