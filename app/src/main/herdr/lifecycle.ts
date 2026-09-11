// 행의 생성과 종료 (LIFE-346).
//
// "행" = herdr **tab + 그 root pane** 이다 (00-analysis.md §1). herdr 세션 자체를 기동·종료하는
// 층이 아니다 — corral 은 세션에 붙는 쪽이다.
//
// # 생성이 왜 두 걸음인가
//
// `tab.create` 에는 시작 커맨드 파라미터가 없다 (실측 ⓐ). 커맨드는 만들어진 pane 에 `agent.start`
// 를 걸어 올린다 (ⓑ). 그래서 경로가 이렇다:
//
//   tab.create {workspace_id, cwd, label}  →  {tab, root_pane}      ~110ms
//   agent.start {name, kind, pane_id}      →  {launch_pending:true} ~106ms
//   (관측)  pane.process_info 의 foreground 가 그 실행 파일이 될 때까지
//
// # 함정 셋 — 전부 실측이 만든 것이다
//
// ① **`agent.start` 의 성공 응답은 "떴다" 가 아니다.** `launch_pending:true` 로 106ms 만에
//    돌아온다. 응답만 보고 "claude 가 떴다" 고 그리면 거짓말이 된다. 그래서 이 파일은 응답을
//    `launching` 으로만 적고, `running` 은 **포그라운드 프로세스를 실제로 본 뒤에만** 적는다.
// ② **시간으로 판정하면 안 된다.** grok 은 4초에 안 뜨고 5초에 떴다 (분석 §3 의 P5 오판).
//    기동 중에는 포그라운드가 여전히 셸이라 "셸이면 실패" 도 쓸 수 없다. 판정은 **관측**뿐이고,
//    예산(`OBSERVE_BUDGET_MS`)이 지나면 실패지 "셸이니까 실패" 가 아니다.
// ③ **생성 직후 `agent.start` 는 레이스다.** 셸이 프롬프트에 못 오면 `agent_pane_busy` 로
//    튕긴다. 1.0초를 기다려도 튕긴 적이 있어(P7) 고정 대기로는 못 막는다. herdr CLI 는 이
//    코드를 최대 2초 재시도하지만 **소켓 `agent.start` 는 재시도하지 않는다** — 그 재시도를
//    여기가 한다. 삼키지 않는다: 재시도 횟수는 상태에 실려 화면과 로그 양쪽에 남는다.

import type { LaunchRow, LifecycleState, ClosingRow, LaunchPhase, SessionInfo } from '../../shared/types.js'
import { log } from '../log.js'
import { defaultSessionWriteBlocked } from './default-session-guard.js'
import { isRecord, readRecord, readString, type PushFrame } from './protocol.js'
import { request } from './request.js'

/** 셸 행 — `agent.start` 를 아예 부르지 않는다는 뜻의 값이다. herdr 의 kind 가 아니다. */
export const SHELL_KIND = 'shell'

/** UI 가 고르게 하는 시작 커맨드. 일감이 지정한 4종이다. */
export const LAUNCH_KINDS: readonly string[] = [SHELL_KIND, 'claude', 'codex', 'grok']

/**
 * `agent_pane_busy` 재시도 (함정 ③). 간격은 셸이 프롬프트를 그리는 시간 규모에 맞춘다.
 * 예산은 herdr CLI 의 2초보다 넉넉하게 — 우리는 사용자 대신 기다리는 쪽이고, 실패로 적는
 * 비용이 조금 더 기다리는 비용보다 크다.
 */
const BUSY_RETRY_MS = 300
const BUSY_BUDGET_MS = 10000

/**
 * 기동 관측 예산. herdr 자신의 `agent start --timeout` 기본값(30초)에 맞춘다 — 같은 일을
 * 재는 두 층이 서로 다른 약속을 하면 안 된다. 실측 최장은 grok 의 ~5초였다.
 */
const OBSERVE_BUDGET_MS = 30000
const OBSERVE_POLL_MS = 600

/** 뜬 행의 기동 기록은 잠깐만 들고 있는다 — 그 뒤로는 행 자체가 제 상태를 말한다. */
const RUNNING_KEEP_MS = 5000

const SHELL_NAMES: readonly string[] = ['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh']

/** 포그라운드 프로세스 한 줄 — `pane.process_info` 가 주는 모양 그대로. */
type ForegroundProcess = { pid: number; name: string; argv0: string; cmdline: string }

export type LifecycleHooks = {
  onChange: () => void
  /** 새 행의 pane 이 생겼다 — 목록에서 그 행을 고른다 (만들었으면 보여 준다). */
  onPaneCreated: (paneId: string) => void
  /**
   * 탭 하나의 정체. store 를 이 파일이 직접 알지 않도록 index 가 넣어 준다 —
   * 종료 확인(N6)이 "이 탭에 에이전트가 도나" 를 물어야 하는데 그건 목록 층의 지식이다.
   */
  describeTab: (tabId: string) => { workspaceId: string; agents: string[]; paneIds: string[] } | null
}

export type CreateRequest = {
  workspaceId: string
  /** herdr agent kind, 또는 `shell`. UI 는 4종만 주지만 이 층은 문자열을 그대로 흘린다 —
   *  미지원 kind 의 거절(`unsupported_agent_kind`)도 정상 경로 중 하나라서다 (N4). */
  kind: string
  label: string | null
  /** 어디서 여나 (A4). null 이면 파라미터를 생략해 herdr 세션의 launch cwd 로 간다. */
  cwd: string | null
}

export type CloseRequest = { tabId: string; confirmed: boolean }

export type CloseOutcome =
  | { ok: true }
  | { ok: false; needsConfirm: true; agents: string[]; paneIds: string[] }
  | { ok: false; needsConfirm: false; error: string }

let nextLaunchId = 0

export class Lifecycle {
  private readonly hooks: LifecycleHooks
  private session: SessionInfo | null = null
  /**
   * 세션 세대. 세션을 바꾸면 올라간다.
   *
   * 기동 관측은 **초 단위로 매달려 있는 폴링**이다. 그 사이 세션을 바꾸면 옛 세션의 pane 을
   * 계속 찌르게 되고, 더 나쁘게는 새 세션의 상태에 옛 세션의 결과를 적는다. LIFE-344 가
   * `33-session-switch` 에서 물린 자리와 같은 층이라 같은 방식으로 막는다.
   */
  private generation = 0
  private launches: LaunchRow[] = []
  private closings: ClosingRow[] = []

  constructor(hooks: LifecycleHooks) {
    this.hooks = hooks
  }

  setSession(session: SessionInfo | null): void {
    this.session = session
    this.generation += 1
    // 진행 중이던 것은 새 세션의 화면에 남을 자격이 없다. 실패로 적지도 않는다 —
    // 실패한 것이 아니라 **더 이상 이 화면의 일이 아니다**.
    this.launches = []
    this.closings = []
    log('life.session', { session: session?.name ?? null, generation: this.generation })
    this.hooks.onChange()
  }

  state(): LifecycleState {
    return { launches: [...this.launches], closings: [...this.closings] }
  }

  /** 지금 화면에 있는 행 중 이 탭의 기동 기록. 렌더러가 탭 줄에 붙여 그린다. */
  private emit(): void {
    this.hooks.onChange()
  }

  // --- 생성 ----------------------------------------------------------------

  async create(input: CreateRequest): Promise<{ ok: boolean; launchId: string; error?: string }> {
    const session = this.session
    const launchId = `L${++nextLaunchId}`
    if (session === null) {
      return { ok: false, launchId, error: '세션이 선택되지 않았다' }
    }
    const blocked = defaultSessionWriteBlocked(session.isDefault)
    if (blocked !== null) {
      log('life.create.blocked', { session: session.name, reason: blocked })
      return { ok: false, launchId, error: blocked }
    }
    const generation = this.generation
    const row: LaunchRow = {
      launchId,
      sessionName: session.name,
      workspaceId: input.workspaceId,
      kind: input.kind,
      label: input.label,
      cwd: input.cwd,
      tabId: null,
      paneId: null,
      phase: 'creating',
      busyRetries: 0,
      observedCmdline: null,
      error: null,
      startedAt: Date.now(),
      settledAt: null,
    }
    this.launches = [...this.launches, row]
    log('life.create.request', {
      launchId,
      session: session.name,
      workspaceId: input.workspaceId,
      kind: input.kind,
      label: input.label,
      cwd: input.cwd,
    })
    this.emit()
    void this.runCreate(launchId, generation, session, input)
    return { ok: true, launchId }
  }

  private patch(launchId: string, patch: Partial<LaunchRow>): LaunchRow | null {
    let updated: LaunchRow | null = null
    this.launches = this.launches.map((item) => {
      if (item.launchId !== launchId) return item
      updated = { ...item, ...patch }
      return updated
    })
    if (updated !== null) this.emit()
    return updated
  }

  private settle(launchId: string, phase: LaunchPhase, patch: Partial<LaunchRow> = {}): void {
    this.patch(launchId, { ...patch, phase, settledAt: Date.now() })
    if (phase !== 'running') return
    // 뜬 행은 잠깐 뒤에 기록을 턴다. 실패는 남긴다 — 그게 N4 의 정책이다.
    setTimeout(() => {
      this.launches = this.launches.filter((item) => item.launchId !== launchId)
      this.emit()
    }, RUNNING_KEEP_MS)
  }

  private stale(generation: number): boolean {
    return generation !== this.generation
  }

  private async runCreate(
    launchId: string,
    generation: number,
    session: SessionInfo,
    input: CreateRequest,
  ): Promise<void> {
    // ① 탭 만들기. 응답이 root pane 을 함께 주므로 별도 조회가 필요 없다 (실측 §3).
    const params: Record<string, unknown> = { workspace_id: input.workspaceId, focus: false }
    if (input.cwd !== null) params['cwd'] = input.cwd
    if (input.label !== null && input.label.length > 0) params['label'] = input.label

    let created: { tabId: string; paneId: string }
    const createStartedAt = Date.now()
    try {
      const response = await request(session.socketPath, 'tab.create', params, { reason: 'life.create' })
      if (this.stale(generation)) return
      if (response.error) throw new Error(`${response.error.code ?? 'error'}: ${response.error.message ?? ''}`)
      const parsed = readCreated(response.result)
      if (parsed === null) throw new Error(`tab.create 응답 모양이 예상과 다르다: ${JSON.stringify(response.result)}`)
      created = parsed
    } catch (error) {
      if (this.stale(generation)) return
      log('life.create.failed', { launchId, error: String(error) })
      this.settle(launchId, 'failed', { error: `탭을 못 만들었다 — ${String(error)}` })
      return
    }
    log('life.tab.created', {
      launchId,
      tabId: created.tabId,
      paneId: created.paneId,
      ms: Date.now() - createStartedAt,
    })
    this.patch(launchId, { tabId: created.tabId, paneId: created.paneId })
    // 만들었으면 보여 준다 — 사용자가 방금 만든 것을 찾으러 다니게 두지 않는다.
    this.hooks.onPaneCreated(created.paneId)

    // ② 셸 행은 여기서 끝이다. `agent.start` 를 부르지 않는 것이 곧 "셸을 띄운다" 다.
    //    다만 **뜬 것을 봤다고 적으려면 봐야 한다** — 셸도 관측을 거친다 (관문 ④).
    if (input.kind === SHELL_KIND) {
      await this.observe(launchId, generation, session, created.paneId, SHELL_NAMES, 'shell')
      return
    }

    // ③ 에이전트 기동. 레이스는 여기서 받아 낸다 (함정 ③).
    const started = await this.startAgent(launchId, generation, session, created, input.kind)
    if (started === null) return
    await this.observe(launchId, generation, session, created.paneId, [started.executable], 'agent')
  }

  /**
   * `agent.start` 를 건다. `agent_pane_busy` 면 예산 안에서 다시 건다.
   *
   * **기다렸다 거는 대신 걸고 재시도한다.** `process_info` 가 셸을 보여 준다는 것은 herdr 가
   * 말하는 "available shell" 과 다르다 — 셸 프로세스는 프롬프트보다 먼저 있다. 선검사로는
   * 못 막고(P7 이 1.0초 뒤에도 튕겼다) 재시도만이 실제로 일하는 장치다.
   */
  private async startAgent(
    launchId: string,
    generation: number,
    session: SessionInfo,
    created: { tabId: string; paneId: string },
    kind: string,
  ): Promise<{ executable: string } | null> {
    const deadline = Date.now() + BUSY_BUDGET_MS
    let busyRetries = 0
    for (;;) {
      this.patch(launchId, { phase: 'starting', busyRetries })
      const attemptAt = Date.now()
      // `agent.start` 의 positional `name` — 나중에 로그에서 이 기동을 되찾는 열쇠다.
      const name = `${kind}-${created.paneId.replace(/[^A-Za-z0-9]/g, '')}`
      let code: string | null = null
      let message = ''
      let result: unknown = null
      try {
        const response = await request(
          session.socketPath,
          'agent.start',
          { name, kind, pane_id: created.paneId },
          { reason: 'life.agent.start' },
        )
        code = response.error?.code ?? null
        message = response.error?.message ?? ''
        result = response.result
      } catch (error) {
        code = 'request_failed'
        message = String(error)
      }
      if (this.stale(generation)) return null

      log('life.agent.start.attempt', {
        launchId,
        paneId: created.paneId,
        kind,
        name,
        attempt: busyRetries + 1,
        ms: Date.now() - attemptAt,
        code,
        message: message.length > 0 ? message : null,
      })

      if (code === null) {
        const executable = readArgv(result) ?? kind
        log('life.agent.start.ok', { launchId, paneId: created.paneId, executable, busyRetries })
        this.patch(launchId, { phase: 'launching', busyRetries })
        return { executable }
      }

      if (code !== 'agent_pane_busy') {
        // 미지원 kind 등 — 다시 걸어도 같은 결과다. 그대로 실패로 적는다 (N4).
        this.settle(launchId, 'failed', { busyRetries, error: `기동 거절 — ${code}: ${message}` })
        return null
      }

      if (Date.now() + BUSY_RETRY_MS > deadline) {
        this.settle(launchId, 'failed', {
          busyRetries,
          error: `셸이 준비되지 않았다 — agent_pane_busy 가 ${BUSY_BUDGET_MS}ms 동안 이어졌다 (재시도 ${busyRetries}회)`,
        })
        return null
      }
      busyRetries += 1
      await sleep(BUSY_RETRY_MS)
      if (this.stale(generation)) return null
    }
  }

  /**
   * **떴는지는 봐야 안다.** `pane.process_info` 의 포그라운드가 기대한 실행 파일이 될 때까지
   * 예산 안에서 본다. 예산이 지나면 실패지만, 그 실패의 근거도 "마지막으로 본 포그라운드" 라는
   * 관측이다 — "N초 기다렸다" 가 아니다.
   */
  private async observe(
    launchId: string,
    generation: number,
    session: SessionInfo,
    paneId: string,
    expected: readonly string[],
    mode: 'shell' | 'agent',
  ): Promise<void> {
    const startedAt = Date.now()
    const deadline = startedAt + OBSERVE_BUDGET_MS
    let last: string | null = null
    let polls = 0
    for (;;) {
      const info = await request(session.socketPath, 'pane.process_info', { pane_id: paneId }, { reason: 'life.observe' })
        .catch(() => null)
      if (this.stale(generation)) return
      const foreground = readForeground(info?.result)
      const hit = foreground.find((item) => matches(item, expected, mode)) ?? null
      last = foreground.map((item) => item.cmdline).join(' | ') || null
      polls += 1
      log('life.observe.poll', {
        launchId,
        paneId,
        poll: polls,
        sinceMs: Date.now() - startedAt,
        expected: expected.join(','),
        foreground: foreground.map((item) => `${item.argv0}(${item.pid})`),
        hit: hit?.cmdline ?? null,
      })
      if (hit !== null) {
        log('life.observe.running', {
          launchId,
          paneId,
          cmdline: hit.cmdline,
          pid: hit.pid,
          polls,
          ms: Date.now() - startedAt,
        })
        this.settle(launchId, 'running', { observedCmdline: hit.cmdline })
        return
      }
      if (Date.now() + OBSERVE_POLL_MS > deadline) {
        log('life.observe.timeout', { launchId, paneId, expected: expected.join(','), last, polls, ms: Date.now() - startedAt })
        this.settle(launchId, 'failed', {
          observedCmdline: last,
          error: `기동을 관측하지 못했다 (${Math.round(OBSERVE_BUDGET_MS / 1000)}초). 마지막 포그라운드: ${last ?? '없음'}`,
        })
        return
      }
      await sleep(OBSERVE_POLL_MS)
      if (this.stale(generation)) return
    }
  }

  /**
   * 구독 push 를 본다. 판정에 쓰지 않는다 — `pane_agent_detected` 는 **폴링을 앞당기는 신호**일
   * 뿐이고, "떴다" 는 여전히 `process_info` 로만 적는다. 판정 근거를 하나로 두기 위해서다.
   */
  onPush(frame: PushFrame): void {
    if (frame.event !== 'pane_agent_detected') return
    const paneId = readString(frame.data, 'pane_id')
    if (paneId === null) return
    const row = this.launches.find((item) => item.paneId === paneId && item.phase === 'launching')
    if (row === undefined) return
    log('life.detect.push', { launchId: row.launchId, paneId, agent: readString(frame.data, 'agent') })
  }

  // --- 종료 ----------------------------------------------------------------

  /**
   * 행을 종료한다.
   *
   * **되돌릴 수 없는 일에는 확인이 있어야 한다** (N6). herdr API 에는 확인이 없으므로 corral 이
   * 놓는다 — 그리고 그 확인을 **여기서** 강제한다. 모달은 화면의 일이고, 위험한 호출을 막는 것은
   * 호출하는 층의 일이다. `confirmed:false` 로 들어온 에이전트 행은 아무것도 보내지 않고
   * 되돌아간다.
   */
  async close(input: CloseRequest): Promise<CloseOutcome> {
    const session = this.session
    if (session === null) return { ok: false, needsConfirm: false, error: '세션이 선택되지 않았다' }
    const blocked = defaultSessionWriteBlocked(session.isDefault)
    if (blocked !== null) {
      log('life.close.blocked', { session: session.name, tabId: input.tabId, reason: blocked })
      return { ok: false, needsConfirm: false, error: blocked }
    }
    const described = this.hooks.describeTab(input.tabId)
    if (described === null) return { ok: false, needsConfirm: false, error: `모르는 탭: ${input.tabId}` }
    if (described.agents.length > 0 && !input.confirmed) {
      log('life.close.needs_confirm', { tabId: input.tabId, agents: described.agents })
      return { ok: false, needsConfirm: true, agents: described.agents, paneIds: described.paneIds }
    }

    const generation = this.generation
    const row: ClosingRow = {
      tabId: input.tabId,
      sessionName: session.name,
      phase: 'closing',
      error: null,
      startedAt: Date.now(),
      settledAt: null,
    }
    this.closings = [...this.closings.filter((item) => item.tabId !== input.tabId), row]
    log('life.close.request', { tabId: input.tabId, agents: described.agents, confirmed: input.confirmed })
    this.emit()

    try {
      // 실측상 653ms 가 걸린다 (SIGHUP→TERM→KILL). 그 동안 화면은 `closing` 을 들고 있다 (A1).
      const response = await request(session.socketPath, 'tab.close', { tab_id: input.tabId }, {
        reason: 'life.close',
        timeoutMs: 15000,
      })
      if (this.stale(generation)) return { ok: true }
      if (response.error) {
        // `confirmation_required` 류는 **그대로 보이고 멈춘다.** 강제 종료로 승격하지 않는다
        // (00-analysis.md §8 — worktree 그룹 케이스).
        const code = response.error.code ?? 'error'
        const message = response.error.message ?? ''
        log('life.close.rejected', { tabId: input.tabId, code, message, ms: Date.now() - row.startedAt })
        this.settleClose(input.tabId, 'failed', `${code}: ${message}`)
        return { ok: false, needsConfirm: false, error: `${code}: ${message}` }
      }
      log('life.close.ok', { tabId: input.tabId, ms: Date.now() - row.startedAt })
      this.settleClose(input.tabId, 'closing', null)
      // 목록에서 그 줄이 실제로 사라지는 것은 `tab_closed` 가 맡는다 — 여기서 지우지 않는다.
      // 기록만 잠깐 뒤에 턴다.
      setTimeout(() => {
        this.closings = this.closings.filter((item) => item.tabId !== input.tabId)
        this.emit()
      }, RUNNING_KEEP_MS)
      return { ok: true }
    } catch (error) {
      if (this.stale(generation)) return { ok: true }
      log('life.close.failed', { tabId: input.tabId, error: String(error) })
      this.settleClose(input.tabId, 'failed', String(error))
      return { ok: false, needsConfirm: false, error: String(error) }
    }
  }

  private settleClose(tabId: string, phase: ClosingRow['phase'], error: string | null): void {
    this.closings = this.closings.map((item) =>
      item.tabId === tabId ? { ...item, phase, error, settledAt: Date.now() } : item,
    )
    this.emit()
  }

  /**
   * 목록에서 사라진 탭의 기록은 같이 턴다. 없는 탭에 붙은 실패 표시는 유령이다 —
   * N4 가 막으라는 바로 그것이라 여기서도 같은 규칙을 지킨다.
   */
  prune(liveTabIds: ReadonlySet<string>): boolean {
    const launches = this.launches.filter((item) => item.tabId === null || liveTabIds.has(item.tabId))
    const closings = this.closings.filter((item) => liveTabIds.has(item.tabId))
    if (launches.length === this.launches.length && closings.length === this.closings.length) return false
    this.launches = launches
    this.closings = closings
    return true
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readCreated(result: unknown): { tabId: string; paneId: string } | null {
  if (!isRecord(result)) return null
  const tab = readRecord(result, 'tab')
  const pane = readRecord(result, 'root_pane')
  if (tab === null || pane === null) return null
  const tabId = readString(tab, 'tab_id')
  const paneId = readString(pane, 'pane_id')
  if (tabId === null || paneId === null) return null
  return { tabId, paneId }
}

/** `agent_started` 의 `argv` — herdr 가 **실제로 무엇을 실행했는지** 말해 준다 (실측 `["claude"]`). */
function readArgv(result: unknown): string | null {
  if (!isRecord(result)) return null
  const argv = result['argv']
  if (!Array.isArray(argv) || argv.length === 0) return null
  const first = argv[0]
  return typeof first === 'string' ? first : null
}

function readForeground(result: unknown): ForegroundProcess[] {
  if (!isRecord(result)) return []
  const info = readRecord(result, 'process_info')
  if (info === null) return []
  const list = info['foreground_processes']
  if (!Array.isArray(list)) return []
  const out: ForegroundProcess[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const pid = item['pid']
    out.push({
      pid: typeof pid === 'number' ? pid : -1,
      name: readString(item, 'name') ?? '',
      argv0: readString(item, 'argv0') ?? '',
      cmdline: readString(item, 'cmdline') ?? '',
    })
  }
  return out
}

/**
 * 이 포그라운드 프로세스가 기대한 것인가.
 *
 * 이름이 한 가지로 오지 않는다 — claude 는 `name:"claude.exe"` · `argv0:"claude"` 였고,
 * 로그인 셸은 `name:"zsh"` · `argv0:"zsh"` · `cmdline:"-zsh"` 였다 (실측). 그래서 세 칸을
 * 다 보되 **앞의 대시만 떼고** 비교한다.
 */
function matches(process: ForegroundProcess, expected: readonly string[], mode: 'shell' | 'agent'): boolean {
  const strip = (value: string): string => value.replace(/^-/, '').replace(/\.exe$/, '')
  const candidates = [strip(process.argv0), strip(process.name), strip(process.cmdline.split(/\s+/)[0] ?? '')]
  if (mode === 'shell') return candidates.some((candidate) => expected.includes(candidate))
  return candidates.some((candidate) => expected.some((want) => candidate === strip(want)))
}
