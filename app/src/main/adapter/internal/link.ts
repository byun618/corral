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
//
// **세션 조회** (LIFE-710): 세션 참조 보고에는 push 가 없어서, 에이전트가 붙은 pane 이 있는 동안만
// `agent.list` 한 건을 짧은 주기로 보내 세션 참조만 맞춘다 (`AGENT_SESSION_POLL_MS`).

import type { LinkPhase, LinkState } from '../../../shared/types.js'
import { pickBlockedRule } from '../../../shared/agent-state.js'
import { isRecord, readRecord } from '../../../shared/json.js'
import type { SessionHandle } from './sessions.js'
import { log } from '../../log.js'
import { checkUnixSocketPath } from '../../unix-socket-path.js'
import { SUBSCRIPTION_TYPES, agentStatusSubscriptions, subjectOf, type PushFrame } from './protocol.js'
import { HerdrRequestError, request } from './request.js'
import { Subscription } from './subscription.js'
import { WorkspaceStore } from './store.js'
import { AttachSessionResolver, makeRunClaudeAgents, type AgentsRun } from './attach-session.js'

/** attach 해소의 `pane.process_info` 한 건 시한 — 세션 조회와 같다. */
const ATTACH_PROCESS_INFO_TIMEOUT_MS = 1_000

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
 * 에이전트가 붙은 뒤 **재동기를 두 번 당기는 시각** (LIFE-366).
 *
 * herdr 는 `pane.report_agent_session` 에 **push 를 안 준다** — 실측이다
 * (`raw/claude/push-probe.json`: 같은 구독이 `pane_created` 는 받는데 보고 뒤에는 0건이고,
 * `pane.agent_session_*` 류 구독 타입은 herdr 가 모른다).
 *
 * **LIFE-710 이전에는** 그래서 통합 훅이 알린 세션 id 가 30초 주기 재동기 스냅샷까지 corral 에 안 왔고,
 * 이 nudge 가 그 구멍을 메웠다 — 에이전트가 붙는 순간(`pane_agent_detected`) 재동기를 두 번 더 당긴다
 * (훅은 SessionStart 에서 뜨므로 검출 직후 몇 초 안에 참조가 생긴다 — A3ⓑ 실측: 기동 → 참조 1,068ms).
 * 그때는 폴링을 따로 두지 않고 이미 있는 재동기를 당겨 썼고, 비용은 에이전트 기동 1회당 스냅샷 2회였다.
 *
 * **지금은** 아래 세션 조회(`AGENT_SESSION_POLL_MS` — 에이전트 pane 이 있는 동안 1.5 s 마다 `agent.list`)가
 * 첫 참조와 그 뒤의 세션 변경을 줍는다. 이 nudge 는 지우지 않고 둔다(수정 범위 최소화 — 겹쳐도 같은 값이라
 * 조회 쪽은 화면 갱신 신호를 내지 않는다).
 */
export const AGENT_SESSION_NUDGE_MS: readonly number[] = [2_000, 8_000]

/**
 * 에이전트가 **이미 붙은 채** 세션만 바뀔 때(`/clear` 등) 세션 참조를 주우러 가는 주기 (LIFE-710).
 *
 * 위 nudge 는 `pane_agent_detected` 때만 당긴다. `/clear` 는 같은 에이전트가 붙은 채 세션만 바뀌어
 * 아무 계기도 없었고, 그래서 목록이 다음 30초 타이머까지 옛 세션이었다(C0 실측: 5회 17~26 s,
 * 매 회차 `resync.applied reason=timer` 와 짝). `/clear` 가 내는 push 도 기대할 수 없다 — 5회 중 4회는
 * 구독 push 가 0건이었다(`pane_updated` 0건, 상태 전이는 1회만).
 *
 * 그래서 에이전트가 붙은 pane 이 **있는 동안만** `agent.list` 한 건(세션 안 전 에이전트의 참조가 한 번에 온다)을
 * 이 주기로 보내 **세션 참조만** 맞춘다 — 스냅샷·reconcile 을 돌리지 않고, 값이 같으면 화면 갱신 신호도 없다.
 * 비용은 세션당 1.5 s 에 요청 1건(120 s 에 80건). 성공·변화 없음은 로그도 남기지 않는다(조회의 `req.*` 포함 — 리뷰 r1 A:
 * 4줄이면 하루 약 36 MB). 실패와 세션 변경만 남는다.
 *
 * **따라잡기 상한**: 다음 조회는 앞 조회가 **끝난 뒤**, 앞 조회 시작 + 이 주기에 건다(겹치지 않는다).
 * 요청 timeout(`AGENT_SESSION_POLL_TIMEOUT_MS`)이 주기보다 짧아서 느린 답이 다음 조회를 미루지 않는다.
 * 정상 응답(수 ms)이면 herdr 보고 뒤 **1.5 s + 왕복**, herdr 가 느려도 **응답이 timeout 안에 오는 한** 최악
 * **1.5 s + timeout 1.0 s = 약 2.5 s** 다(보고 직후 나간 조회가 옛 값을 늦게 돌려주는 경우 — 리뷰 r1 D: 전에는 건너뛴 틱
 * 때문에 약 3 s 였다). 연속 timeout 이면 그보다 늦고, 그때는 `agent_session.poll.failed` 가 남는다.
 * timeout 은 **연결 단계까지** 덮는다 — 조회 경로만 abort 기한을 따로 건다(공용 `request()` 의 timeout 은 연결 뒤에 시작한다).
 *
 * **실패 로그**: 같은 오류가 이어지면 첫 건(`poll.failed`)과 `AGENT_SESSION_POLL_FAILURE_SUMMARY_MS` 마다 요약
 * (`poll.failing`) 한 줄만 남기고, 회복하면 `poll.recovered` 한 줄 — 지속 실패가 1.5 s 마다 로그를 쌓지 않게(리뷰 r2 5).
 */
export const AGENT_SESSION_POLL_MS = 1_500

/** 세션 조회 한 건의 timeout — 주기보다 짧게 둔다(위 상한). */
export const AGENT_SESSION_POLL_TIMEOUT_MS = 1_000

/** 같은 조회 오류가 이어질 때 요약 한 줄을 남기는 간격. */
export const AGENT_SESSION_POLL_FAILURE_SUMMARY_MS = 60_000

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
  /**
   * `claude attach` pane 의 세션 해소(LIFE-769)에 쓸 claude 실행 파일 — argv[0] 가 절대경로가 아닐 때(보통 `claude`).
   * 로그인 셸 PATH·설치 폴더 감지 결과를 준다. 없거나 null 이면 그 pane 은 없음.
   */
  claudeExecutable?: () => string | null
  /** 시험용 — `claude agents --json --all` 실행기를 바꾼다. */
  runClaudeAgents?: AgentsRun
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
  /**
   * 이미 사유를 물어본 blocked 삽화 (`paneId:entry`). **실패한 것도 남는다** —
   * 「실패」와 「아직 안 물어봄」을 가르는 자리이고, 그래서 매 주기 재시도가 안 생긴다 (F1).
   * 삽화가 끝나거나 사유가 채워지면 `sweepBlockedReasons` 가 턴다.
   */
  private reasonAttempts = new Set<string>()
  private session: SessionHandle | null = null
  private subscription: Subscription | null = null
  private agentSubscription: Subscription | null = null
  private agentPaneKey = ''
  private agentTimer: ReturnType<typeof setTimeout> | null = null
  /** 에이전트 검출 뒤 참조를 주우러 가는 타이머들 (LIFE-366). */
  private nudgeTimers = new Set<ReturnType<typeof setTimeout>>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  /** 세션 조회 타이머·진행 중 표시 (LIFE-710). */
  private sessionPollTimer: ReturnType<typeof setTimeout> | null = null
  private sessionPolling = false
  /** 진행 중 조회의 기한(연결 포함) — `stopSessionPoll` 이 끊는다. */
  private sessionPollDeadline: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | null = null
  /** 실패 상태 — 실패가 이어지는 동안(오류 문구가 바뀌어도) 첫 건과 요약만 남기려고 센다. `open()`·끊김에서 비운다. */
  private sessionPollFailure: { error: string; count: number; loggedAt: number } | null = null
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

  /** herdr 가 참조를 주지 않는 claude pane 의 세션 해소 (LIFE-769) — 세션 조회 한 번마다 한 판(`resolveAttachSessions`). */
  readonly attach: AttachSessionResolver

  constructor(hooks: SessionLinkHooks) {
    this.hooks = hooks
    this.attach = new AttachSessionResolver({
      processInfo: (paneId) => this.processInfo(paneId),
      runAgents: hooks.runClaudeAgents ?? makeRunClaudeAgents(),
      claudeExecutable: () => hooks.claudeExecutable?.() ?? null,
      now: () => Date.now(),
    })
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
    this.reasonAttempts.clear()
    this.sessionPollFailure = null
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
    this.stopSessionPoll()
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
      // 부팅 스냅샷·버퍼 재생으로 이미 blocked 인 pane 이 있을 수 있다 — 여기서 훑는다 (F1).
      this.sweepBlockedReasons()
      // 성공했으면 재시도 카운터를 턴다 — 안 털면 다음 끊김의 백오프가 늘 상한에서 시작한다.
      this.state = { ...this.state, bufferedAtSnapshot: buffered.length, lastError: null, attempt: 0 }
      this.setPhase('live')
      this.hooks.onTopologyChange?.()
      this.scheduleAgentSubscription()
      this.startResync()
      this.startSessionPoll()
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
      // 재동기로 알게 된 blocked 도 사유를 받는다 (F1).
      this.sweepBlockedReasons()
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

  // --- 세션 조회 (LIFE-710) -----------------------------------------------------

  private startSessionPoll(): void {
    this.scheduleSessionPoll(AGENT_SESSION_POLL_MS)
  }

  /**
   * 다음 조회 하나를 건다 — **한 번에 타이머 하나**. live 가 아니면 걸지 않는다(끊김·close 뒤 타이머 0).
   * 진행 중인 조회가 있으면 그 조회의 `finally` 가 다음을 건다 — 재연결로 세대가 바뀌어도 이어진다.
   */
  private scheduleSessionPoll(delayMs: number): void {
    if (this.stopped || this.state.phase !== 'live' || this.sessionPollTimer !== null) return
    this.sessionPollTimer = setTimeout(() => {
      this.sessionPollTimer = null
      void this.pollAgentSessions()
    }, delayMs)
  }

  private stopSessionPoll(): void {
    if (this.sessionPollTimer) clearTimeout(this.sessionPollTimer)
    this.sessionPollTimer = null
    // 진행 중 조회도 끊는다 — 그 답은 어차피 낡았고, 기한 타이머가 남지 않게.
    const deadline = this.sessionPollDeadline
    this.sessionPollDeadline = null
    if (deadline !== null) {
      clearTimeout(deadline.timer)
      deadline.controller.abort()
    }
  }

  /**
   * 실패 상태 플래그로 판정한다(리뷰 r3 4) — 직전 문구와 비교하면 오류가 번갈아 올 때 매 조회가 로그를 남겼다.
   * 상태에 들어갈 때 `poll.failed` 한 줄, 머무는 동안은 요약 간격마다 `poll.failing`(횟수·마지막 오류) 한 줄.
   * 요약 간격은 단조 시계로 잰다(벽시계 되감김에 요약이 멎지 않게).
   */
  private notePollFailure(error: string): void {
    const now = performance.now()
    const previous = this.sessionPollFailure
    if (previous === null) {
      log('agent_session.poll.failed', { error })
      this.sessionPollFailure = { error, count: 1, loggedAt: now }
      return
    }
    const count = previous.count + 1
    if (now - previous.loggedAt >= AGENT_SESSION_POLL_FAILURE_SUMMARY_MS) {
      log('agent_session.poll.failing', { error, count })
      this.sessionPollFailure = { error, count, loggedAt: now }
      return
    }
    this.sessionPollFailure = { error, count, loggedAt: previous.loggedAt }
  }

  private notePollRecovered(): void {
    const previous = this.sessionPollFailure
    if (previous === null) return
    this.sessionPollFailure = null
    log('agent_session.poll.recovered', { error: previous.error, count: previous.count })
  }

  /**
   * 에이전트가 붙은 pane 이 있으면 `agent.list` 로 세션 참조만 맞춘다. 바뀐 것이 있을 때만 `onChange`·로그.
   * 실패는 버린다 — 알던 세션을 지우지 않고 다음 주기(또는 재동기)가 다시 본다.
   */
  async pollAgentSessions(): Promise<void> {
    const session = this.session
    if (session === null || this.stopped || this.state.phase !== 'live' || this.sessionPolling) return
    const startedAt = Date.now()
    if (!this.store.hasAgentPane()) {
      this.scheduleSessionPoll(AGENT_SESSION_POLL_MS)
      return
    }
    this.sessionPolling = true
    const generation = this.generation
    const requestedAt = startedAt
    let deadlineHit = false
    const deadline = {
      controller: new AbortController(),
      timer: setTimeout(() => {
        deadlineHit = true
        deadline.controller.abort()
      }, AGENT_SESSION_POLL_TIMEOUT_MS),
    }
    this.sessionPollDeadline = deadline
    try {
      const response = await request(session.socketPath, 'agent.list', {}, {
        reason: 'agent-session-poll', timeoutMs: AGENT_SESSION_POLL_TIMEOUT_MS, quiet: true, signal: deadline.controller.signal,
      })
      if (generation !== this.generation || this.stopped) return
      if (response.error) throw new HerdrRequestError(response.error.code ?? 'error', response.error.message ?? '')
      this.notePollRecovered()
      const result = this.store.applyAgentSessions({ result: response.result, requestedAt })
      // 키 없는 claude pane 이 있으면 그 세션을 푼다(LIFE-769). 기다리지 않는다 — 조회 주기를 늦추지 않게(해소기는 겹쳐 돌지 않는다).
      void this.resolveAttachSessions(generation)
      if (!result.changed) return
      log('agent_session.poll.applied', { requestedAt, note: result.note })
      this.hooks.onChange()
    } catch (error) {
      // 끊김·close 로 끊은 조회는 실패가 아니다 — 남기지 않는다.
      if (this.stopped || generation !== this.generation || (deadline.controller.signal.aborted && !deadlineHit)) return
      this.notePollFailure(deadlineHit ? `timeout: agent.list ${AGENT_SESSION_POLL_TIMEOUT_MS}ms (연결 포함)` : String(error))
    } finally {
      clearTimeout(deadline.timer)
      if (this.sessionPollDeadline === deadline) this.sessionPollDeadline = null
      this.sessionPolling = false
      // 한 주기를 넘지 않게 묶는다 — 벽시계가 되감기면 `startedAt + 주기 - now` 가 되감긴 만큼 커져 체인이 멎는다(리뷰 r3 1).
      this.scheduleSessionPoll(Math.min(AGENT_SESSION_POLL_MS, Math.max(0, startedAt + AGENT_SESSION_POLL_MS - Date.now())))
    }
  }

  // --- attach 세션 해소 (LIFE-769) ---------------------------------------------

  private async processInfo(paneId: string): Promise<unknown> {
    const session = this.session
    if (session === null) throw new Error('세션 없음')
    const response = await request(session.socketPath, 'pane.process_info', { pane_id: paneId }, {
      reason: 'attach-session', timeoutMs: ATTACH_PROCESS_INFO_TIMEOUT_MS, quiet: true,
    })
    if (response.error) throw new HerdrRequestError(response.error.code ?? 'error', response.error.message ?? '')
    return response.result
  }

  /**
   * 키 없는 claude pane 마다 argv 를 보고 `claude attach <ref>` 면 세션을 푼다(`attach-session.ts`). 후보가 없으면 아무것도 부르지 않는다.
   * 바뀐 것이 있을 때만 `onChange`·로그. 세대가 바뀌었으면(끊김·close) 버린다.
   */
  async resolveAttachSessions(generation: number = this.generation): Promise<void> {
    try {
      const results = await this.attach.round(this.store.attachCandidates())
      if (results === null || generation !== this.generation || this.stopped) return
      const applied = this.store.applyAttachSessions(results)
      if (!applied.changed) return
      log('attach_session.applied', { note: applied.note, results })
      this.hooks.onChange()
    } catch (error) {
      log('attach_session.failed', { error: String(error) })
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
        this.sweepBlockedReasons()
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
    this.sweepBlockedReasons()
  }

  /**
   * **사유 없는 blocked pane 을 훑어 한 번씩 물어본다** (LIFE-456 S3 · 수정 라운드 1 F1).
   *
   * 왜 따로 묻나: 사유가 실려 오는 자리가 없다. `pane.agent_status_changed` 봉투는
   * `{agent, agent_status, pane_id, workspace_id}` 뿐이고, herdr 0.9.0 은 claude·codex·grok 에
   * `state_labels` 를 **아예 안 싣는다**(실측 — `raw/claude/s3/s3-state-labels-findings.md`).
   * 사유를 주는 유일한 자리가 `agent.explain` 이다.
   *
   * **왜 전이가 아니라 훑기인가** (F1): 처음에는 blocked 로 들어가는 live push 전이에서만
   * 불렀다. 그래서 **부팅 스냅샷에 이미 blocked 이던 pane · 부팅 버퍼로 재생된 전이 ·
   * 재동기로 알게 된 blocked · 같은 값 재관측 · explain 이 실패한 뒤** 는 사유를 영영 못 받았다.
   * 진입 경로마다 훅을 다는 대신 **상태를 본다**: "지금 blocked 인데 사유가 없는 pane".
   *
   * **폴링이 아니다.** 두 겹으로 막는다:
   *   ① 사유가 채워지면 저장소 목록에서 빠진다
   *   ② 물어본 삽화는 `reasonAttempts` 에 남아 **다시 묻지 않는다** — 실패해도 그렇다.
   *      「실패」와 「아직 안 물어봄」을 가르는 자리가 여기다. 실패를 자동 재시도로 덮으면
   *      죽은 백엔드에 매 주기 요청을 쏘게 된다
   * blocked 를 떠났다 다시 들어오면 삽화 번호가 바뀌므로 **새 삽화로 한 번 더** 묻는다.
   */
  private sweepBlockedReasons(): void {
    const session = this.session
    if (this.stopped || session === null) return
    const pending = this.store.blockedNeedingReason()
    // 끝난 삽화의 기억은 버린다 — 표가 무한히 자라지 않게. 남는 것은 아직 사유가 없는 삽화뿐이다.
    const live = new Set(pending.map(({ paneId, entry }) => `${paneId}:${String(entry)}`))
    for (const key of [...this.reasonAttempts]) if (!live.has(key)) this.reasonAttempts.delete(key)

    for (const { paneId, entry } of pending) {
      const key = `${paneId}:${String(entry)}`
      if (this.reasonAttempts.has(key)) continue
      this.reasonAttempts.add(key)
      this.explainBlocked(paneId, entry)
    }
  }

  /**
   * 한 삽화의 사유를 물어 온다. 기다리지 않는다(이벤트 처리를 막지 않는다) — 응답이 오는
   * 사이에 삽화가 끝났으면 `applyBlockedRule` 이 **삽화 번호를 보고** 그 값을 버린다(F4).
   *
   * **여기서 사유를 계산하지 않는다** (R2-F2). 고른 규칙 id 만 넘기고, store 가 그것을 자기가
   * 기억한 `state_labels` 와 **함께** 한 함수에 먹인다. 전에는 여기서 `blockedReason({ruleId})`
   * 만 불러 labels 를 빠뜨렸고, 그래서 같은 pane 이 CLI(둘 다 먹임)와 다른 답을 낼 수 있었다.
   */
  private explainBlocked(paneId: string, entry: number): void {
    const session = this.session
    if (this.stopped || session === null) return
    const generation = this.generation
    void request(session.socketPath, 'agent.explain', { target: paneId }, { reason: 'blocked-reason' })
      .then((frame) => {
        if (this.stopped || generation !== this.generation) return
        const explain = readRecord(isRecord(frame.result) ? frame.result : {}, 'explain')
        const picked = pickBlockedRule(explain)
        const result = this.store.applyBlockedRule({ paneId, entry, ruleId: picked.ruleId })
        log('agent_explain.reason', {
          paneId, entry, ruleId: picked.ruleId, source: picked.source, matchedRuleId: picked.matchedRuleId,
          changed: result.changed, note: result.note,
        })
        if (result.changed) this.hooks.onChange()
      })
      .catch((error: unknown) => {
        // 사유를 못 받은 것은 상태를 못 받은 것이 아니다 — blocked 는 이미 화면에 있다.
        // `reasonAttempts` 에 이미 올라가 있으므로 **자동 재시도는 없다**(F1 — 실패 ≠ 미시도).
        log('agent_explain.failed', { paneId, entry, error: error instanceof Error ? error.message : String(error) })
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
    this.stopSessionPoll()
    this.sessionPollFailure = null
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
