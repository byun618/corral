import { RuntimeError } from '../../../runtime/contracts.js'
import { isRecord, readArray, readRecord } from '../../../shared/json.js'
import { log } from '../../log.js'
import { BUSY_RETRY_INTERVAL_MS, BUSY_RETRY_TIMEOUT_MS } from './lifecycle.js'
import { paneEnv } from './pane-env.js'
import { request, HerdrRequestError } from './request.js'

/** LIFE-417 N4: 되걸기 규약. 테스트가 주입할 수 있게 값으로 받는다 — 실제 15초를 기다리지 않는다. */
export interface BusyRetryPolicy { timeoutMs: number; intervalMs: number }
const DEFAULT_BUSY_RETRY: BusyRetryPolicy = { timeoutMs: BUSY_RETRY_TIMEOUT_MS, intervalMs: BUSY_RETRY_INTERVAL_MS }
/**
 * LIFE-417 r6 (R5-3): 되걸기 간격은 **취소를 즉시 따른다**. 취소가 간격만큼 늦게 반응하면 이미
 * 끝난 호출이 아직 기다리는 것처럼 보인다. 던지는 값은 `signal.throwIfAborted()` 가 던지는 것
 * 그대로다 — 기다림을 끝까지 마쳤어도 바로 다음 `call()` 이 같은 오류를 냈을 것이라, 취소를
 * 빨리 본다고 해서 **호출자가 보는 오류가 달라지지 않는다**.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => { try { signal.throwIfAborted() } catch (error) { reject(error) } }
    if (signal.aborted) { cancel(); return }
    const abort = (): void => { clearTimeout(timer); cancel() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** LIFE-394: herdr's AgentInfo, translated into corral words. Field renaming stops here (N2). */
export interface AgentObservation {
  name: string | null
  kind: string | null
  status: string
  launchPending: boolean
  interactiveReady: boolean
  stateChangeSeq: number
  stateLabels: Record<string, string>
  session: { source: string; kind: string; value: string } | null
  paneId: string
  observedAt: string
  /** LIFE-582 R1-A3: the pane's user-input revision and quiet time, read by the guard in the agent.get turn. null on a guard without them. */
  input?: { revision: number; idleMs: number } | null
  /** LIFE-708 r1: the same turn's any-input revision and quiet time — mouse reports included (`input` leaves them out). null on a guard without it. */
  anyInput?: { revision: number; idleMs: number } | null
  /** LIFE-597: how long the agent state (and detected kind) has held, read by the guard in the agent.get turn. null on a guard without it. */
  stateQuietMs?: number | null
  /** LIFE-787: herdr's `terminal_title` for the pane (the provider's own tab title, prefix kept). null when herdr has none. */
  terminalTitle?: string | null
}
/** One row of the guard's target-less `server.agent_manifests` read (LIFE-394 §3, D17). */
export interface AgentManifestObservation {
  agent: string
  source_kind: string | null
  active_version: string | null
  local_override_shadowing_remote: boolean | null
}

export interface TerminalIdentity {
  epoch: string; ptyId: string; paneId: string; tabId: string; workspaceId: string
  path: string; repo: string; title: string
}
export interface TerminalOperation {
  signal: AbortSignal; deadlineAt: number; onEffect?: () => void
}
/** Private guard protocol is checked by the backend App loop in the same turn as the effect. */
export class TerminalBackend {
  private acceptedEffects = 0
  /** Handshake capability: set by `epoch()`. `null` until the handshake has been read once. */
  private agentOps: boolean | null = null
  /** LIFE-597 handshake capability: the guard takes `unmanaged_agent` on agent.prompt. */
  private unmanagedPrompt: boolean | null = null
  constructor(readonly socket: string, private readonly busyRetry: BusyRetryPolicy = DEFAULT_BUSY_RETRY) {}
  /** LIFE-394 §1.4/§5.2: the agent arms exist only on a guard build that advertises `agent_ops`. */
  agentCapable(): boolean { return this.agentOps === true }
  /** LIFE-597: an older guard ignores `unmanaged_agent` and keeps refusing a pane with no managed agent. */
  unmanagedPromptCapable(): boolean { return this.unmanagedPrompt === true }
  private async call(params: Record<string, unknown>, ctx: TerminalOperation, mutation = false) {
    ctx.signal.throwIfAborted()
    if (Date.now() >= ctx.deadlineAt) throw new RuntimeError('deadline_exceeded', 'Deadline passed before backend request')
    const response = await request(this.socket, 'corral.terminal', params, {
      timeoutMs: Math.max(1, ctx.deadlineAt - Date.now()), signal: ctx.signal,
      ...(mutation ? { onSent: ctx.onEffect } : {}),
    }).catch(error => {
      if (error instanceof HerdrRequestError) throw new RuntimeError(error.code === 'timeout' || error.code === 'connect_timeout' ? 'backend_timeout' : 'backend_unavailable', error.message, undefined, 'backend')
      throw error
    })
    // The guard's compare-and-submit rejection carries the AgentInfo it observed, and that value is
    // the whole basis of the refusal — a re-read of `agent.get` afterwards sees a state that has
    // already moved on. So it travels with the error (LIFE-394 §1.4, §4.4, R7): the envelope passes
    // it through untouched and it becomes the RuntimeError's `observed` detail, unchanged.
    if (response.error) throw new RuntimeError(response.error.code ?? 'backend_error', response.error.message ?? 'Backend rejected request',
      response.error.observed === undefined ? undefined : { observed: response.error.observed }, 'backend', this.acceptedEffects ? 'unknown' : 'not_started')
    if (!isRecord(response.result)) throw new RuntimeError('invalid_backend_response', 'Missing backend result')
    if (mutation) this.acceptedEffects++
    return response.result
  }
  async epoch(ctx: TerminalOperation): Promise<string> {
    let response
    try { response = await this.call({}, ctx) } catch (error) {
      if (error instanceof RuntimeError && error.code === 'invalid_request') throw new RuntimeError('unsupported_backend', 'Use the corral terminal backend build; installed backend lacks atomic terminal guards')
      throw error
    }
    if (response.guard_version !== 1 || typeof response.epoch !== 'string') throw new RuntimeError('unsupported_backend', 'Terminal guard protocol v1 required')
    this.agentOps = response.agent_ops === 1 || response.agent_ops === true
    this.unmanagedPrompt = response.unmanaged_prompt === 1
    return response.epoch
  }
  private operation(epoch: string, method: string, params: Record<string, unknown>, ctx: TerminalOperation, target?: TerminalIdentity, mutation = false) {
    return this.call({ epoch, deadline_ms: ctx.deadlineAt, ...(target ? { pane_id: target.paneId, terminal_id: target.ptyId } : {}), operation: { method, params } }, ctx, mutation)
  }
  async list(epoch: string, ctx: TerminalOperation): Promise<TerminalIdentity[]> {
    const result = await this.operation(epoch, 'session.snapshot', {}, ctx), snap = readRecord(result, 'snapshot') ?? result
    const workspaces = readArray(snap, 'workspaces').filter(isRecord), tabs = readArray(snap, 'tabs').filter(isRecord)
    return readArray(snap, 'panes').filter(isRecord).filter(p => typeof p.corral_pty_generation === 'string').map(p => {
      const workspace = workspaces.find(w => w.workspace_id === p.workspace_id) ?? {}, worktree = readRecord(workspace, 'worktree')
      const tab = tabs.find(t => t.tab_id === p.tab_id)
      return { epoch, ptyId: `${String(p.terminal_id)}.${String(p.corral_pty_generation)}`, paneId: String(p.pane_id), tabId: String(p.tab_id), workspaceId: String(p.workspace_id),
        path: String(worktree?.checkout_path ?? p.cwd ?? ''), repo: String(worktree?.repo_root ?? ''), title: String(tab?.label || p.title || '') }
    })
  }
  async create(epoch: string, directory: string, title: string | undefined, ctx: TerminalOperation): Promise<TerminalIdentity> {
    const panes = await this.list(epoch, ctx), existing = panes.find(p => p.path === directory)
    const response = await this.operation(epoch, existing ? 'tab.create' : 'workspace.create', { cwd: directory, focus: false, env: paneEnv(),
      ...(title === undefined ? {} : { label: title }), ...(existing ? { workspace_id: existing.workspaceId } : {}) }, ctx, undefined, true)
    const pane = readRecord(response, 'root_pane'), workspace = readRecord(response, 'workspace')
    const created = (await this.list(epoch, ctx)).find(p => pane ? p.paneId === pane.pane_id : p.workspaceId === workspace?.workspace_id)
    if (!created) throw new RuntimeError('outcome_unknown', 'Created terminal could not be resolved', { response }, 'create', 'unknown')
    return created
  }
  async process(target: TerminalIdentity, ctx: TerminalOperation) {
    const result = await this.operation(target.epoch, 'pane.process_info', { pane_id: target.paneId }, ctx, target)
    const info = readRecord(result, 'process_info') ?? {}
    return { shellPid: info.shell_pid ?? null, foregroundGroupId: info.foreground_process_group_id ?? null,
      foreground: readArray(info, 'foreground_processes').filter(isRecord).map(p => ({ pid: p.pid, name: p.name, argv: p.argv ?? null })) }
  }
  async read(target: TerminalIdentity, screen: boolean, ctx: TerminalOperation) {
    const result = await this.operation(target.epoch, 'pane.read', { pane_id: target.paneId, source: screen ? 'visible' : 'corral_stream', format: 'text', strip_ansi: screen }, ctx, target)
    const content = readRecord(result, 'read') ?? {}
    if (typeof content.text !== 'string' || typeof content.revision !== 'number') throw new RuntimeError('invalid_backend_response', 'Invalid output')
    return { text: content.text, total: content.revision, truncated: content.truncated === true }
  }
  async send(target: TerminalIdentity, text: string, ctx: TerminalOperation) {
    await this.operation(target.epoch, 'pane.send_text', { pane_id: target.paneId, text }, ctx, target, true)
  }
  /**
   * LIFE-582: the same raw send, but only while the agent's `state_change_seq` is still the one corral observed —
   * the guard compares it in the turn that writes (herdr-guard.patch). A transition in between is `agent_state_changed`
   * and nothing is written. The CLI's `send` above does not carry the field and is unchanged.
   */
  async sendIfUnchanged(target: TerminalIdentity, text: string, expectedStateChangeSeq: number, ctx: TerminalOperation) {
    await this.call({ epoch: target.epoch, deadline_ms: ctx.deadlineAt, pane_id: target.paneId, terminal_id: target.ptyId,
      expected_state_change_seq: expectedStateChangeSeq, operation: { method: 'pane.send_text', params: { pane_id: target.paneId, text } } }, ctx, true)
  }
  /**
   * LIFE-582 R2-A1: a raw key fenced on the pane's input revision as well — `inputRevision` is the revision of the screen corral read,
   * or the one the previous fenced key returned. Any other input since then is `input_changed` and nothing is written. Returns the
   * revision after this write (the next key's fence); `null` from a guard that does not report it.
   * LIFE-708 r1: `anyInputRevision` (a question answer) fences on every input, a click included — `any_input_changed` and nothing written.
   * `anyRevision` is the any-input revision after this write.
   */
  async sendFenced(target: TerminalIdentity, input: { text: string; expectedStateChangeSeq: number; inputRevision: number; anyInputRevision: number | null }, ctx: TerminalOperation): Promise<{ revision: number | null; anyRevision: number | null }> {
    const result = await this.call({ epoch: target.epoch, deadline_ms: ctx.deadlineAt, pane_id: target.paneId, terminal_id: target.ptyId,
      expected_state_change_seq: input.expectedStateChangeSeq, expected_input_revision: input.inputRevision,
      ...(input.anyInputRevision === null ? {} : { expected_any_input_revision: input.anyInputRevision }),
      operation: { method: 'pane.send_text', params: { pane_id: target.paneId, text: input.text } } }, ctx, true)
    return {
      revision: typeof result.corral_input_revision === 'number' ? result.corral_input_revision : null,
      anyRevision: typeof result.corral_any_input_revision === 'number' ? result.corral_any_input_revision : null,
    }
  }
  /**
   * LIFE-582 R2-A3: the visible screen (SGR kept) with the input revision, input quiet time and agent `state_change_seq` the guard read
   * in the same turn — so corral knows the screen was captured after the input went quiet, and can fence the effect on that revision.
   * `input`·`seq` are null from a guard that does not report them.
   */
  async screenRead(target: TerminalIdentity, ctx: TerminalOperation): Promise<{ text: string; input: { revision: number; idleMs: number } | null; anyInput: { revision: number; idleMs: number } | null; seq: number | null }> {
    const result = await this.operation(target.epoch, 'pane.read', { pane_id: target.paneId, source: 'visible', format: 'ansi', strip_ansi: false }, ctx, target)
    const content = readRecord(result, 'read') ?? {}
    if (typeof content.text !== 'string') throw new RuntimeError('invalid_backend_response', 'Invalid screen')
    const input = typeof content.corral_input_revision === 'number' && typeof content.corral_input_idle_ms === 'number'
      ? { revision: content.corral_input_revision, idleMs: content.corral_input_idle_ms } : null
    const anyInput = typeof content.corral_any_input_revision === 'number' && typeof content.corral_any_input_idle_ms === 'number'
      ? { revision: content.corral_any_input_revision, idleMs: content.corral_any_input_idle_ms } : null
    return { text: content.text, input, anyInput, seq: typeof content.corral_state_change_seq === 'number' ? content.corral_state_change_seq : null }
  }
  /** LIFE-582: the visible screen with SGR attributes kept — the mobile input path reads the provider's input line from it. */
  async screenAnsi(target: TerminalIdentity, ctx: TerminalOperation): Promise<string> {
    const result = await this.operation(target.epoch, 'pane.read', { pane_id: target.paneId, source: 'visible', format: 'ansi', strip_ansi: false }, ctx, target)
    const content = readRecord(result, 'read') ?? {}
    if (typeof content.text !== 'string') throw new RuntimeError('invalid_backend_response', 'Invalid screen')
    return content.text
  }
  async close(target: TerminalIdentity, ctx: TerminalOperation) {
    await this.operation(target.epoch, 'pane.close', { pane_id: target.paneId }, ctx, target, true)
  }
  async rename(target: TerminalIdentity, title: string, ctx: TerminalOperation) {
    await this.operation(target.epoch, 'tab.rename', { tab_id: target.tabId, label: title }, ctx, target, true)
  }
  /**
   * LIFE-394 agent arms. Every one goes through the same guard envelope as the terminal ops, and
   * always names the pane in `target` rather than relying on herdr resolving an agent name.
   *
   * LIFE-417 N4: `agent_pane_busy` 만 되건다 — GUI 행 생성(lifecycle.ts createRow, L2)이 이미 쓰는
   * 규약을 CLI 경로도 그대로 쓴다. pane 의 zsh 가 rc(pyenv·nvm 초기화)를 도는 동안 전경 그룹이
   * 셸 하나가 아니라서 herdr 가 거절하는데, 그건 시간이 지나면 풀리는 상태다. 다른 실패(이름 규칙·
   * 미지원 kind)는 되걸어도 같은 결과라 즉시 던진다. 상한을 넘기면 **마지막 거절을 그대로** 던진다 —
   * 호출자가 보는 것은 지금과 같은 `agent_pane_busy` RuntimeError 다.
   *
   * 되걸기 횟수는 `onBusyRetry` 로 알린다: 실패 경로에서도 세어야 하는데 예외로는 못 싣는다
   * (에러 모양 보존). `AgentRecord` 는 건드리지 않는다.
   */
  async startAgent(target: TerminalIdentity, params: { name: string; kind: string; args: string[]; timeoutMs: number; onBusyRetry?: (retries: number) => void }, ctx: TerminalOperation) {
    const startedAt = Date.now()
    let retries = 0
    for (;;) {
      try {
        const result = await this.operation(target.epoch, 'agent.start',
          { name: params.name, kind: params.kind, pane_id: target.paneId, args: params.args, timeout_ms: params.timeoutMs }, ctx, target, true)
        return { agent: observation(readRecord(result, 'agent'), target.paneId), argv: readArray(result, 'argv').map(String) }
      } catch (error) {
        // 멈추는 자리는 **다음 시도를 보내기 전**이다. 두 상한을 같은 기준으로 본다:
        //   · 되걸기 상한 — 기다림까지 포함해 상한 안에 들어야 한다 (r6 R5-1). `경과 > 상한` 만
        //     보면 기다린 뒤의 시도가 상한 밖에서 나가, "상한을 넘기면 실패" 계약이 한 칸 샌다
        //   · 호출자 deadline — 더 이르면 그쪽이 상한이다. 안 그러면 `call()` 이
        //     `deadline_exceeded`·`backend_timeout` 을 대신 던져 진짜 원인(busy)이 지워진다
        const now = Date.now()
        if (!(error instanceof RuntimeError) || error.code !== 'agent_pane_busy'
          || now - startedAt + this.busyRetry.intervalMs > this.busyRetry.timeoutMs
          || now + this.busyRetry.intervalMs >= ctx.deadlineAt) throw error
        // 세는 것은 **실제로 다시 보낸 횟수**다 (r6 R5-3). 취소로 못 보낸 시도는 여기서 던져지고
        // `retries` 는 그대로다 — 안 그러면 나가지 않은 시도가 영수증에 한 번으로 남는다.
        await sleep(this.busyRetry.intervalMs, ctx.signal)
        retries += 1
        // 태그는 GUI 행 생성과 같게 두고 `path` 로 가른다 (r6 R5-5) — `corral.ndjson` 에서 두 경로가
        // 섞이면 어느 쪽이 되걸었는지 구분할 수 없다. GUI 쪽 로그 줄은 건드리지 않는다.
        log('lifecycle.agent_busy_retry', { paneId: target.paneId, retries, elapsedMs: Date.now() - startedAt, path: 'cli' })
        params.onBusyRetry?.(retries)
      }
    }
  }
  async agentInfo(target: TerminalIdentity, ctx: TerminalOperation): Promise<AgentObservation> {
    const result = await this.operation(target.epoch, 'agent.get', { target: target.paneId }, ctx, target)
    return observation(readRecord(result, 'agent'), target.paneId)
  }
  /** expected_state_change_seq is required by the guard: without it the submission is refused. */
  async promptAgent(target: TerminalIdentity, text: string, expectedStateChangeSeq: number, ctx: TerminalOperation) {
    const result = await this.call({ epoch: target.epoch, deadline_ms: ctx.deadlineAt, pane_id: target.paneId, terminal_id: target.ptyId,
      expected_state_change_seq: expectedStateChangeSeq, operation: { method: 'agent.prompt', params: { target: target.paneId, text } } }, ctx, true)
    return observation(readRecord(result, 'agent'), target.paneId)
  }
  /**
   * LIFE-582 R1-A3: `promptAgent` plus an input fence — the guard refuses (`input_changed`·`input_recent`) when any user input
   * reached the pane after the observation that reported `inputRevision`, or less than `minIdleMs` ago. The draft corral read
   * from the screen is then still the whole input line at submission time. The CLI's `promptAgent` above is unchanged.
   */
  async promptAgentIfQuiet(target: TerminalIdentity, input: { text: string; expectedStateChangeSeq: number; inputRevision: number; minIdleMs: number; unmanagedAgent?: string | null }, ctx: TerminalOperation) {
    const result = await this.call({ epoch: target.epoch, deadline_ms: ctx.deadlineAt, pane_id: target.paneId, terminal_id: target.ptyId,
      expected_state_change_seq: input.expectedStateChangeSeq, expected_input_revision: input.inputRevision, min_input_idle_ms: input.minIdleMs,
      ...(input.unmanagedAgent == null ? {} : { unmanaged_agent: input.unmanagedAgent }),
      operation: { method: 'agent.prompt', params: { target: target.paneId, text: input.text } } }, ctx, true)
    return observation(readRecord(result, 'agent'), target.paneId)
  }
  /**
   * Why a pane is blocked, as herdr's detection rules see it (LIFE-456 S3 / fix-r1 F3).
   *
   * The GUI already asks this and derives the reason from the rule id. The CLI used to read
   * `state_labels` instead — which herdr never sends for claude/codex/grok — so the same pane
   * reported `permission` in the GUI and `unknown` in `terminal show`. Both sides now feed the
   * same judgment (`shared/agent-state.ts`) from the same field, which is what "one vocabulary"
   * was supposed to mean.
   */
  async agentExplain(target: TerminalIdentity, ctx: TerminalOperation): Promise<Record<string, unknown> | null> {
    const result = await this.operation(target.epoch, 'agent.explain', { target: target.paneId }, ctx, target)
    return readRecord(result, 'explain')
  }
  /** Target-less read-only arm: which detect manifest is actually active (LIFE-394 §3, D17). */
  async agentManifests(epoch: string, ctx: TerminalOperation): Promise<AgentManifestObservation[]> {
    const result = await this.operation(epoch, 'server.agent_manifests', {}, ctx)
    return readArray(result, 'manifests').filter(isRecord).map(entry => ({
      agent: String(entry.agent ?? ''),
      source_kind: typeof entry.source_kind === 'string' ? entry.source_kind : null,
      active_version: typeof entry.active_version === 'string' ? entry.active_version : null,
      local_override_shadowing_remote: typeof entry.local_override_shadowing_remote === 'boolean' ? entry.local_override_shadowing_remote : null,
    }))
  }
}
function observation(agent: Record<string, unknown> | null, paneId: string): AgentObservation {
  if (!agent || typeof agent.agent_status !== 'string') throw new RuntimeError('invalid_backend_response', 'Missing agent info')
  const session = readRecord(agent, 'agent_session')
  const labels = readRecord(agent, 'state_labels') ?? {}
  return {
    name: typeof agent.name === 'string' ? agent.name : null,
    kind: typeof agent.agent === 'string' ? agent.agent : null,
    status: agent.agent_status,
    launchPending: agent.launch_pending === true,
    interactiveReady: agent.interactive_ready === true,
    stateChangeSeq: typeof agent.state_change_seq === 'number' ? agent.state_change_seq : 0,
    stateLabels: Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)])),
    session: session && typeof session.value === 'string' ? { source: String(session.source ?? ''), kind: String(session.kind ?? ''), value: session.value } : null,
    paneId: typeof agent.pane_id === 'string' ? agent.pane_id : paneId,
    observedAt: new Date().toISOString(),
    input: typeof agent.corral_input_revision === 'number' && typeof agent.corral_input_idle_ms === 'number'
      ? { revision: agent.corral_input_revision, idleMs: agent.corral_input_idle_ms } : null,
    anyInput: typeof agent.corral_any_input_revision === 'number' && typeof agent.corral_any_input_idle_ms === 'number'
      ? { revision: agent.corral_any_input_revision, idleMs: agent.corral_any_input_idle_ms } : null,
    stateQuietMs: typeof agent.corral_state_quiet_ms === 'number' ? agent.corral_state_quiet_ms : null,
    terminalTitle: typeof agent.terminal_title === 'string' ? agent.terminal_title : null,
  }
}
