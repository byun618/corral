import { RuntimeError } from '../../../runtime/contracts.js'
import { isRecord, readArray, readRecord } from '../../../shared/json.js'
import { request, HerdrRequestError } from './request.js'

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
  constructor(readonly socket: string) {}
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
    // The guard's compare-and-submit rejection also carries the AgentInfo it observed. The response
    // envelope keeps only code and message, so corral re-reads `agent.get` for the block it reports
    // rather than widening the envelope for a value it can observe directly (LIFE-394 §1.4, §4.4).
    if (response.error) throw new RuntimeError(response.error.code ?? 'backend_error', response.error.message ?? 'Backend rejected request', undefined, 'backend', this.acceptedEffects ? 'unknown' : 'not_started')
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
    const response = await this.operation(epoch, existing ? 'tab.create' : 'workspace.create', { cwd: directory, focus: false,
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
  async close(target: TerminalIdentity, ctx: TerminalOperation) {
    await this.operation(target.epoch, 'pane.close', { pane_id: target.paneId }, ctx, target, true)
  }
  async rename(target: TerminalIdentity, title: string, ctx: TerminalOperation) {
    await this.operation(target.epoch, 'tab.rename', { tab_id: target.tabId, label: title }, ctx, target, true)
  }
  /**
   * LIFE-394 agent arms. Every one goes through the same guard envelope as the terminal ops, and
   * always names the pane in `target` rather than relying on herdr resolving an agent name.
   */
  async startAgent(target: TerminalIdentity, params: { name: string; kind: string; args: string[]; timeoutMs: number }, ctx: TerminalOperation) {
    const result = await this.operation(target.epoch, 'agent.start',
      { name: params.name, kind: params.kind, pane_id: target.paneId, args: params.args, timeout_ms: params.timeoutMs }, ctx, target, true)
    return { agent: observation(readRecord(result, 'agent'), target.paneId), argv: readArray(result, 'argv').map(String) }
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
  }
}
