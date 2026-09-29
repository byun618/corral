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

import type { LinkPhase, LinkState } from '../../../shared/types.js'
import { blockedReason } from '../../../shared/agent-state.js'
import { isRecord, readRecord, readString } from '../../../shared/json.js'
import type { SessionHandle } from './sessions.js'
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

/**
 * 에이전트가 붙은 뒤 **세션 참조를 주우러 가는 시각** (LIFE-366).
 *
 * herdr 는 `pane.report_agent_session` 에 **push 를 안 준다** — 실측이다
 * (`raw/claude/push-probe.json`: 같은 구독이 `pane_created` 는 받는데 보고 뒤에는 0건이고,
 * `pane.agent_session_*` 류 구독 타입은 herdr 가 모른다). 그래서 통합 훅이 알린 세션 id 는
 * **30초 주기 재동기 스냅샷**까지 corral 에 안 온다 — 세션 행 2차 줄이 최대 30초 늦게 붙는다.
 *
 * 에이전트가 붙는 순간(`pane_agent_detected`)에 두 번 더 주워 그 구멍을 메운다. 훅은
 * 에이전트의 SessionStart 에서 뜨므로 검출 직후 몇 초 안에 참조가 생긴다(A3ⓑ 실측: 기동 →
 * 참조 1,068ms). 폴링을 새로 들이지 않고 **이미 있는 재동기를 두 번 당겨 쓰는** 것이라
 * 비용은 에이전트 기동 1회당 스냅샷 2회다.
 */
export const AGENT_SESSION_NUDGE_MS: readonly number[] = [2_000, 8_000]

function resyncIntervalMs(): number {
  const raw = Number(process.env.CORRAL_RESYNC_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESYNC_MS
}

export type SessionLinkHooks = {
  onChange: () => void
  /** 목록이 실제로 바뀌었다 — repo 층(worktree 열림상태)을 다시 보라는 신호. */
  onTopologyChange?: () => void
  /**
   * 재동기 때 **worktree→workspace 바인딩**도 새로 대조하라는 신호 (게이트 ① 버그 ①).
   *
   * `store.reconcile` 은 workspace/tab/pane **행**만 본다 — 바인딩은 골격(`buildSkeleton` 가 얼린
   * open_workspace_id)에 있어 index.ts 만 갱신할 수 있다. cd 로 worktree 경계를 넘나든 뒤 골격이
   * 낡은 바인딩을 들고 있어도 행에는 드리프트가 없어(재동기가 '어긋난 것 없음'이라 함) 자가 회복이
   * 안 되던 정황을 이 훅이 덮는다. 걷어 낸 드리프트의 note 를 재동기 기록에 함께 싣는다.
   */
  onResync?: (reason: string) => Promise<{ changed: boolean; note: string | null }>
}

export class SessionLink {
  readonly store = new WorkspaceStore()
  private readonly hooks: SessionLinkHooks
  /**
   * 링크 세대. `open()`·`close()`·**`attempt()`** 마다 올라간다 (마지막은 수정 1회차 M3).
   * 부트스트랩은 비동기라(구독 → ack → 스냅샷 → 버퍼) 도중에 세션을 바꾸거나 재부트스트랩이
   * 돌면 **먼저 나간 시도가 뒤늦게 돌아온다**. 그대로 두면 옛 스냅샷이 새 저장소에 부어진다.
   */
  private generation = 0
  private session: SessionHandle | null = null
  private subscription: Subscription | null = null
  private agentSubscription: Subscription | null = null
  private agentPaneKey = ''
  private agentTimer: ReturnType<typeof setTimeout> | null = null
  /** 에이전트 검출 뒤 참조를 주우러 가는 타이머들 (LIFE-366). */
  private nudgeTimers = new Set<ReturnType<typeof setTimeout>>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  private buffer: Array<{ frame: PushFrame; at: number }> = []
  private bootstrapping = false
  private resyncing = false
  private stopped = false
  /** 계측용 — push 를 **조용히 버린다** (N7 의 유실 주입). 커넥션은 살아 있다. */
  private droppingPush = false
  /** 버릴 이벤트를 고른 목록. null 이면 전부. */
  private dropPushOnly: readonly string[] | null = null
  private state: LinkState = {
    phase: 'idle',
    sessionName: null,
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
   *
   * `only` 를 주면 **그 이벤트만** 버린다 (수정 2회차 H-1 재측정). 전부 버리면 corral 은
   * 아무것도 모르는 채로 멈춰 있을 뿐이라, "일부만 모르는 corral 이 스스로 틀린 추정을 한다"
   * 는 바로 그 상태를 못 만든다. 골라 버려야 `tab_created` 는 놓치고 `tab_closed` 는 받는다.
   */
  setDroppingPush(input: { dropping: boolean; only?: readonly string[] | null }): void {
    this.droppingPush = input.dropping
    this.dropPushOnly = input.dropping ? (input.only ?? null) : null
    // 고른 목록은 **화면 타입에 안 싣는다** (수정 3회차 F3-L5 — grok, L9 와 같은 방향).
    // 계측 전용이라 main 에만 두고, 원자료에는 아래 `link.drop_push` 로그로 남는다.
    this.state = { ...this.state, droppingPush: input.dropping }
    log('link.drop_push', { dropping: input.dropping, only: this.dropPushOnly })
    this.hooks.onChange()
  }

  /** 이 봉투를 버리나 — 켜져 있고, 고른 목록이 있으면 거기 든 것만. */
  private shouldDrop(frame: PushFrame): boolean {
    if (!this.droppingPush) return false
    return this.dropPushOnly === null || this.dropPushOnly.includes(frame.event)
  }

  open(session: SessionHandle): void {
    this.close()
    this.generation += 1
    this.stopped = false
    this.session = session
    this.store.reset()
    this.state = {
      ...this.state,
      sessionName: session.name,
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
    for (const timer of this.nudgeTimers) clearTimeout(timer)
    this.nudgeTimers.clear()
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
    // 세대를 로그에 싣는다 — 재부트스트랩이 실제로 세대를 올렸다는 것이 원자료로 보여야 한다 (M3).
    log('link.phase', {
      phase,
      session: this.state.sessionName,
      attempt: this.state.attempt,
      generation: this.generation,
    })
    this.hooks.onChange()
  }

  private async attempt(): Promise<void> {
    const session = this.session
    if (session === null || this.stopped) return
    /**
     * **부트스트랩마다 세대를 올린다** (수정 1회차 M3).
     *
     * 1회차에는 `open()`·`close()` 만 올렸다. 그래서 주기 재동기가 날아간 뒤 구독이 끊겨
     * 재부트스트랩이 돌면(그 안의 `applySnapshot` 이 `reset()` 으로 **묘비를 전부 턴다**),
     * 뒤늦게 도착한 옛 스냅샷의 세대가 여전히 같아서 `reconcile` 이 실행됐다 —
     * 그 사이 닫힌 행이 묘비 없는 저장소에 그대로 부어진다. 삭제 방향은 `knownAt` 이 막지만
     * 추가 방향은 아무도 안 막았다. 세대를 여기서 올리면 열쇠 하나로 정리된다.
     *
     * 세대를 올리면 **agent 구독도 같이 무효가 된다** — 그 커넥션의 push 가드가 세대를 보므로,
     * 살려 두면 상태 push 를 조용히 버리는 유령이 된다. 그래서 여기서 닫고 키도 턴다.
     */
    this.generation += 1
    this.agentSubscription?.close()
    this.agentSubscription = null
    this.agentPaneKey = ''
    if (this.agentTimer) clearTimeout(this.agentTimer)
    this.agentTimer = null
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
      if (generation !== this.generation || this.stopped) {
        // M3 가 막는 바로 그 경로다 — 응답이 돌아온 사이에 재부트스트랩이 끼었다.
        log('resync.stale', { reason, generation, current: this.generation })
        return { ok: false, note: '세대가 바뀜' }
      }
      if (response.error) throw new HerdrRequestError(response.error.code ?? 'error', response.error.message ?? '')
      const result = this.store.reconcile(response.result, requestedAt)
      // 행 대조 뒤 바인딩도 대조한다 (버그 ①). onChange 전에 불러 골격을 먼저 패치해야 이어지는
      // emit 이 고쳐진 골격을 싣는다. note 를 합쳐 재동기 기록이 '어긋난 것 없음'으로 거짓말 안 하게.
      const binding = (await this.hooks.onResync?.(reason)) ?? { changed: false, note: null }
      const changed = result.changed || binding.changed
      const note = binding.note !== null ? (result.note === '어긋난 것 없음' ? binding.note : `${result.note} · ${binding.note}`) : result.note
      this.state = {
        ...this.state,
        lastResyncAt: Date.now(),
        lastResyncNote: note,
        resyncCount: this.state.resyncCount + 1,
      }
      log('resync.applied', {
        reason,
        requestedAt,
        changed,
        note,
        added: result.added,
        removed: result.removed,
        keptNewer: result.keptNewer,
        // 걷어 낸 묘비 — "추정이 틀렸고 재동기가 되돌렸다" 의 원자료 (수정 2회차 H-1ⓑ).
        lifted: result.lifted,
        binding, // 바인딩 드리프트 갱신 결과 (버그 ①)
        after: this.store.ids(),
      })
      this.hooks.onChange()
      if (result.changed) {
        this.hooks.onTopologyChange?.()
        this.scheduleAgentSubscription()
      }
      return { ok: true, note }
    } catch (error) {
      log('resync.failed', { reason, error: String(error) })
      return { ok: false, note: String(error) }
    } finally {
      this.resyncing = false
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
        if (this.shouldDrop(frame)) {
          log('push.dropped', { label: 'agent', event: frame.event })
          return
        }
        this.state = { ...this.state, lastPushAt: at }
        const result = this.store.applyEvent(frame)
        log('agent.push.applied', { event: frame.event, changed: result.changed, note: result.note })
        if (result.changed) this.hooks.onChange()
        if (result.blockedEntry !== undefined) this.explainBlocked(result.blockedEntry)
      },
      onDrop: (reason, detail) => {
        if (generation !== this.generation) return
        /**
         * **자기 구독일 때만 참조를 턴다** (수정 2회차 M-2 — codex, fix1 원자료로 실증).
         *
         * 이 구독을 교체할 때 `close()` 를 먼저 부르고 새 `Subscription` 을 할당하는데,
         * 옛 소켓의 `close` 이벤트는 **새 참조가 들어간 뒤에** 온다. 세대는 안 바뀌므로
         * 위의 가드도 안 걸린다. 그대로 두면 방금 연 구독의 참조가 지워져 다시 닫을 수 없는
         * 커넥션이 남았다 (`n5-consistency/app.ndjson`: open 44 vs local drop 26).
         * `catch` 경로에는 이미 같은 검사가 있었다 — 그 모양을 여기에도 둔다.
         */
        const mine = this.agentSubscription === subscription
        log('agent.sub.dropped', { reason, detail, mine })
        if (!mine) return
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
      // 실패도 **자기 구독일 때만** 턴다 (수정 3회차 F3-L3 — codex).
      // 참조는 이미 가드 안이었는데 `agentPaneKey` 만 무조건 지웠다: 늦게 실패한 옛 구독이
      // 방금 연 구독의 key 를 지우면, 같은 pane 집합으로 한 번 더 여는 낭비가 생긴다.
      const mine = this.agentSubscription === subscription
      log('agent.sub.failed', { error: String(error), panes: paneIds.length, mine })
      subscription.close()
      if (!mine) return
      this.agentSubscription = null
      this.agentPaneKey = ''
    }
  }

  // --- push ------------------------------------------------------------------

  private onPush(frame: PushFrame, at: number): void {
    if (this.shouldDrop(frame)) {
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
    // 에이전트가 붙었다 — 곧 통합 훅이 세션 id 를 알린다. 그 보고에는 push 가 없으므로
    // 여기서 재동기를 두 번 당겨 준다 (`AGENT_SESSION_NUDGE_MS` 주석에 실측 근거).
    if (frame.event === 'pane_agent_detected' && frame.data['released'] !== true) this.nudgeForAgentSession()
    if (result.blockedEntry !== undefined) this.explainBlocked(result.blockedEntry)
  }

  /**
   * **blocked 사유를 한 번 물어 온다** (LIFE-456 S3).
   *
   * 왜 따로 묻나: 사유가 실려 오는 자리가 없다. `pane.agent_status_changed` 봉투는
   * `{agent, agent_status, pane_id, workspace_id}` 뿐이고, herdr 0.9.0 은 claude·codex·grok 에
   * `state_labels` 를 **아예 안 싣는다**(실측 — `raw/claude/s3/s3-state-labels-findings.md`).
   * 사유를 주는 유일한 자리가 `agent.explain` 의 `matched_rule.id` 다.
   *
   * **진입 1회다.** 폴링이 아니다 — blocked 로 들어가는 전이에서만 부르고, 스냅샷·재동기에서는
   * 안 부른다. blocked 진입은 드물어서 요청 1건(커넥션 1개, 0.3ms)이면 충분하다.
   * 기다리지 않는다(이벤트 처리를 막지 않는다). 응답이 오는 사이 상태가 바뀌었으면
   * `applyBlockedReason` 이 그 값을 버린다.
   */
  private explainBlocked(paneId: string): void {
    const session = this.session
    if (this.stopped || session === null) return
    const generation = this.generation
    void request(session.socketPath, 'agent.explain', { target: paneId }, { reason: 'blocked-reason' })
      .then((frame) => {
        if (this.stopped || generation !== this.generation) return
        // 7KB 응답에서 **한 칸만** 읽는다 — `evaluated_rules` 는 버린다.
        const explain = readRecord(isRecord(frame.result) ? frame.result : {}, 'explain')
        const ruleId = explain === null ? null : readString(readRecord(explain, 'matched_rule') ?? {}, 'id')
        const reason = blockedReason({ ruleId })
        const result = this.store.applyBlockedReason({ paneId, reason })
        log('agent_explain.reason', { paneId, ruleId, reason, changed: result.changed, note: result.note })
        if (result.changed) this.hooks.onChange()
      })
      .catch((error: unknown) => {
        // 사유를 못 받은 것은 상태를 못 받은 것이 아니다 — blocked 는 이미 화면에 있다.
        log('agent_explain.failed', { paneId, error: error instanceof Error ? error.message : String(error) })
      })
  }

  private nudgeForAgentSession(): void {
    if (this.stopped) return
    for (const delay of AGENT_SESSION_NUDGE_MS) {
      const timer = setTimeout(() => {
        this.nudgeTimers.delete(timer)
        void this.resync('agent-session-nudge')
      }, delay)
      this.nudgeTimers.add(timer)
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
