import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import specs from './specs.json'
import { RuntimeError, reject, stringFlag, type CommandModule, type CommandSpec, type Invocation, type CommandContext } from '../contracts.js'
import { validateFoundation } from '../registry.js'
import { TerminalBackend, type TerminalIdentity, type AgentObservation } from '../../main/adapter/index.js'
import { RepoRegistry } from '../../main/registry.js'
import { isRecord } from '../../shared/json.js'
import { WorktreeMetadata, worktreeSelect } from '../workspace/model.js'
import { Tokens } from './tokens.js'
import { Receipts, REQUEST_ID } from './receipts.js'
import {
  AGENT_START_TIMEOUT_MS, AgentStore, READY_SAMPLES, READY_SAMPLE_INTERVAL_MS, SCREEN_EXCERPT_BYTES,
  agentName, bodyIdentity, captureCursor, classifyCount, codexCandidates, codexRolloutFiles, countSubmissions,
  evaluateManifest, isAgentKind, manifestGateError, mintsSessionId, normalizeBody, providerArgv, sessionRecordPaths,
  type AgentKind, type AgentPhase, type AgentRecord, type CursorEntry, type DetectManifestObservation,
} from './agent.js'
export const terminalSpecs: CommandSpec[] = specs
export const MAX_INPUT = 65536
export interface TerminalDesktop {
  available(): boolean
  changed(): Promise<void>
  reveal(target: TerminalIdentity, context: CommandContext): Promise<void>
}
const reads = new Set(['terminal list', 'terminal show', 'terminal read', 'terminal wait'])
function bytes(value: unknown, max: number, name: string) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > max) reject(`${name} must be NUL-free UTF-8, at most ${max} bytes`)
}
/** LIFE-394 §4.1. Shared with `worktree create`, whose --agent flags synthesize this same command. */
export const AGENT_OPTIONS = ['model', 'effort', 'advisor', 'prompt', 'prompt-file']
export function validateAgentFlags(inv: Invocation): void {
  const f = inv.flags
  for (const key of ['model', 'effort', 'advisor', 'prompt-file']) if (f[key] !== undefined) stringFlag(f, key, true)
  if (f.prompt !== undefined) bytes(f.prompt, MAX_INPUT, '--prompt')
  if (f.agent === undefined) {
    if (AGENT_OPTIONS.some(key => f[key] !== undefined)) throw new RuntimeError('invalid_request', `--${AGENT_OPTIONS.find(key => f[key] !== undefined)} requires --agent`)
    return
  }
  const kind = stringFlag(f, 'agent', true)!
  if (!isAgentKind(kind)) throw new RuntimeError('invalid_request', '--agent must be claude, codex or grok')
  if (f.command !== undefined) throw new RuntimeError('invalid_request', '--command and --agent are mutually exclusive')
  if (f.prompt !== undefined && f['prompt-file'] !== undefined) throw new RuntimeError('invalid_request', '--prompt and --prompt-file are mutually exclusive')
  if (f.advisor !== undefined && kind !== 'claude') throw new RuntimeError('invalid_request', '--advisor applies to --agent claude only')
}
export function validateTerminal(inv: Invocation): void {
  validateFoundation(inv)
  const f = inv.flags
  if (!['terminal create', 'terminal list'].includes(inv.command)) stringFlag(f, 'terminal', true)
  for (const key of ['worktree', 'cursor', 'expect-process', 'file']) if (f[key] !== undefined) stringFlag(f, key, true)
  if (f.title !== undefined || inv.command === 'terminal rename') { stringFlag(f, 'title', true); bytes(f.title, 1024, '--title') }
  if (f.command !== undefined) { stringFlag(f, 'command', true); bytes(f.command, MAX_INPUT, '--command') }
  if (f.text !== undefined) bytes(f.text, MAX_INPUT, '--text')
  if (inv.stdin !== undefined) { if (!f.stdin) reject('Unexpected stdin'); bytes(inv.stdin, MAX_INPUT, 'stdin') }
  if (f['request-id'] !== undefined && !REQUEST_ID.test(String(f['request-id']))) reject('--request-id must be r1.<13-digit Unix milliseconds>.<UUID>')
  if (f.limit !== undefined && (!/^\d+$/.test(String(f.limit)) || Number(f.limit) < 1 || Number(f.limit) > (inv.command === 'terminal list' ? 10000 : 262144))) reject('--limit out of range (list 1..10000; read 1..262144)')
  if (f.screen && f.cursor !== undefined) reject('--screen and --cursor are mutually exclusive')
  if (inv.command === 'terminal create') validateAgentFlags(inv)
  else for (const key of ['agent', ...AGENT_OPTIONS]) if (f[key] !== undefined) throw new RuntimeError('invalid_request', `--${key} applies to terminal create only`)
  if (inv.command === 'terminal send') {
    if (f.stdin && f.text !== undefined) reject('--text and --stdin are mutually exclusive')
    if (f.interrupt && (f.text !== undefined || f.stdin || f.enter)) reject('--interrupt cannot be combined with text/stdin/enter')
    if (!f.interrupt && f.text === undefined && !f.stdin && !f.enter) reject('Send requires text, stdin, enter, or interrupt')
  }
  if (inv.command === 'terminal prompt') {
    if ([f.text !== undefined, f.file !== undefined, !!f.stdin].filter(Boolean).length !== 1) reject('Prompt requires exactly one of --text, --file or --stdin')
    if (f.wait !== undefined && !['accepted', 'responded'].includes(String(f.wait))) reject('--wait must be accepted or responded')
  } else if (f.wait !== undefined) reject('--wait applies to terminal prompt only')
  if (inv.command === 'terminal wait') {
    if (!['ready', 'output', 'exit', 'agent-ready', 'agent-idle'].includes(String(f.for))) reject('--for must be ready, output, exit, agent-ready, or agent-idle')
    if (f.for !== 'output' && (f.cursor !== undefined || f.text !== undefined)) reject('--cursor and --text require --for output')
    if (f.text === '') reject('Output match text must not be empty')
  }
}
interface Cursor { target: string; offset: number; pending: string }
/** Hold at most three trailing bytes until the next observation completes their UTF-8 sequence. */
function decodeChunk(bytes: Buffer): { text: string; pending: string } {
  let start = bytes.length - 1
  while (start >= Math.max(0, bytes.length - 3) && (bytes[start]! & 0xc0) === 0x80) start--
  if (start >= 0) {
    const first = bytes[start]!, width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1
    if (bytes.length - start < width) return { text: bytes.subarray(0, start).toString('utf8'), pending: bytes.subarray(start).toString('base64') }
  }
  return { text: bytes.toString('utf8'), pending: '' }
}
// --- LIFE-394 agent helpers (§3 gate, §4.1 stages, §4.4 block) ----------------------------------
type StageStatus = 'completed' | 'queued' | 'unknown' | 'failed' | 'not_started'
export interface Stage { status: StageStatus; [key: string]: unknown }
/**
 * A composition stage never throws its own failure away (§4.1 D15): the caller keeps the handle and
 * the child request id it already has. Only an effect whose outcome is genuinely unobserved becomes
 * `unknown` — an effect-free rejection (validation, the manifest gate, a refused submission) is a
 * plain `failed`, so a retry is a decision the caller can make.
 */
export function stageFailure(error: unknown): Stage {
  const runtime = error instanceof RuntimeError ? error : undefined
  return { status: runtime ? (runtime.outcome === 'unknown' ? 'unknown' : 'failed') : 'unknown',
    error: runtime?.code ?? 'outcome_unknown', message: error instanceof Error ? error.message : String(error) }
}
export function stagesOutcome(stages: Record<string, Stage>): 'completed' | 'unknown' {
  return Object.values(stages).some(stage => stage.status === 'unknown') ? 'unknown' : 'completed'
}
/**
 * §4.3: the prompt stage of `create --prompt` gets its own receipt under a derived id, so a create
 * result and a prompt result never overwrite each other and a replayed create never re-submits.
 * Deterministic by construction — sha256("<parent id>|<stage>") laid out as a UUID, which satisfies
 * the existing REQUEST_ID pattern, so `receipts.ts` stays untouched. `worktree create --agent` uses
 * the same derivation one level up for its terminal stage, so the whole composition is replayable.
 */
export function derivedRequestId(parentId: string, stage: string): string {
  const match = REQUEST_ID.exec(parentId)
  if (!match) throw new RuntimeError('invalid_argument', '--request-id must be r1.<13 digit Unix ms>.<UUID>')
  const digest = createHash('sha256').update(`${parentId}|${stage}`).digest('hex').slice(0, 32)
  return `r1.${match[1]}.${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}
export const derivedPromptId = (createId: string): string => derivedRequestId(createId, 'prompt')
/** herdr's own labels are the only source; an unlabelled blocker stays `unknown` and stays blocked. */
function blockedReason(labels: Record<string, string>): string {
  const text = Object.values(labels).join(' ').toLowerCase()
  if (text.includes('trust')) return 'trust'
  if (text.includes('login') || text.includes('sign in') || text.includes('auth')) return 'login'
  if (text.includes('permission') || text.includes('allow')) return 'permission'
  if (text.includes('update')) return 'update'
  return 'unknown'
}
/** §3 gate predicate. `agent-idle` differs only in accepting a finished turn (`done`). */
function qualifies(info: AgentObservation, target: 'ready' | 'idle'): boolean {
  return info.interactiveReady && !info.launchPending && (target === 'ready' ? info.status === 'idle' : info.status === 'idle' || info.status === 'done')
}
/** §8.2: report the marker this runtime carries. corral neither repairs it nor restarts the backend. */
function environmentWarnings(): string[] {
  return process.env.CLAUDE_CODE_CHILD_SESSION === undefined ? [] : ['claude_child_session_marker']
}
interface AgentView { phase: AgentPhase; info: AgentObservation | null; launchExpired: boolean; stale: boolean }
export function terminalModule(userData: string, desktop?: TerminalDesktop): CommandModule {
  const startedAt = Date.now(), receipts = new Receipts(userData, startedAt), agents = new AgentStore(userData)
  let tokens: Tokens | undefined
  return {
    specs: terminalSpecs, validate: validateTerminal, tracksEffects: true,
    isMutation: inv => !reads.has(inv.command),
    serialKey: inv => reads.has(inv.command) ? undefined : 'terminal',
    async execute(original, ctx) {
      tokens ??= new Tokens(userData)
      const codec = tokens, inv = { ...original, flags: { ...original.flags } }, f = inv.flags
      const flag = (name: string) => stringFlag(f, name), required = (name: string) => stringFlag(f, name, true)!
      if (f['expect-process'] !== undefined) throw new RuntimeError('unsupported', 'Backend cannot atomically condition on foreground/exec ownership; no effect started', { conditionalProcess: false }, 'preflight', 'not_started')
      if ((inv.command === 'terminal switch' || f.focus) && !desktop?.available()) throw new RuntimeError('ui_unavailable', 'This runtime has no available GUI', undefined, 'preflight', 'not_started')
      const socket = process.env.CORRAL_BACKEND_SOCKET
      if (!socket) throw new RuntimeError('backend_unavailable', 'Profile has no configured terminal backend')
      const backend = new TerminalBackend(socket)
      const epoch = await backend.epoch(ctx)
      const registry = new RepoRegistry(userData), records = () => new WorktreeMetadata(registry).list(registry.records(), ctx.signal)
      const handle = (target: TerminalIdentity) => codec.encode('t1', { runtimeId: ctx.runtimeId, epoch: target.epoch, ptyId: target.ptyId, paneId: target.paneId })
      const describe = async (target: TerminalIdentity) => {
        const worktree = (await records()).find(w => w.path === target.path)
        return { handle: handle(target), ...target, repo: registry.records().find(repo => repo.id === worktree?.repoId)?.path ?? target.repo, repoId: worktree?.repoId ?? null, worktreeId: worktree?.id ?? null }
      }
      let target: TerminalIdentity | undefined
      if (f.terminal !== undefined) {
        const decoded = codec.decode<TerminalIdentity & { runtimeId: string }>('t1', required('terminal'))
        if (decoded.runtimeId !== ctx.runtimeId || decoded.epoch !== epoch) throw new RuntimeError('stale_terminal', 'Handle belongs to another runtime/backend generation', { recovery: 'terminal list' })
        target = decoded
      }
      const resolve = async (allowExit = false) => {
        const current = (await backend.list(epoch, ctx)).find(p => p.paneId === target!.paneId)
        if (!current && allowExit) return undefined
        if (!current || current.ptyId !== target!.ptyId) throw new RuntimeError('stale_terminal', 'PTY disappeared or was replaced', { terminal: required('terminal'), recovery: 'terminal list' })
        return current
      }
      const read = async (selected: TerminalIdentity, cursor?: string, limit = 65536) => {
        const output = await backend.read(selected, false, ctx), data = Buffer.from(output.text, 'base64'), oldest = output.total - data.length
        const targetKey = createHash('sha256').update(required('terminal')).digest('hex')
        const prior = cursor ? codec.decode<Cursor>('c1', cursor) : { target: targetKey, offset: oldest, pending: '' }
        if (prior.target !== targetKey || !Number.isSafeInteger(prior.offset) || prior.offset < 0 || prior.offset > output.total) throw new RuntimeError('invalid_cursor', 'Cursor is future or belongs to another terminal')
        const gap = prior.offset < oldest, start = Math.max(oldest, prior.offset), end = Math.min(output.total, start + limit)
        const chunk = data.subarray(start - oldest, end - oldest), decoded = decodeChunk(Buffer.concat([Buffer.from(gap ? '' : prior.pending, 'base64'), chunk]))
        return { source: 'raw-pty', text: decoded.text, bytesBase64: chunk.toString('base64'), from: start, to: end, retainedFrom: oldest, availableTo: output.total,
          gap, truncated: gap || (!cursor && oldest > 0), hasMore: end < output.total, generation: selected.epoch + ':' + selected.ptyId,
          cursor: codec.encode('c1', { target: targetKey, offset: end, pending: decoded.pending } satisfies Cursor),
          recoveryCursor: codec.encode('c1', { target: targetKey, offset: oldest, pending: '' } satisfies Cursor) }
      }
      // --- LIFE-394: §3 gate, §4.4 block, §4.5 submission ---------------------------------------
      const loadAgent = (live: TerminalIdentity) => agents.read(live.paneId, epoch, live.ptyId)
      const patchAgent = (live: TerminalIdentity, patch: Partial<AgentRecord>) => agents.update(live.paneId, epoch, live.ptyId, patch)
      const observeManifest = async (kind: AgentKind): Promise<DetectManifestObservation> => {
        try { return evaluateManifest(kind, await backend.agentManifests(epoch, ctx), null) }
        catch (error) { return evaluateManifest(kind, null, error instanceof Error ? error.message : String(error)) }
      }
      const excerpt = async (live: TerminalIdentity): Promise<string | null> => {
        try { return decodeChunk(Buffer.from((await backend.read(live, true, ctx)).text).subarray(0, SCREEN_EXCERPT_BYTES)).text }
        catch { return null }
      }
      /** D6: `agent_not_found` alone never means `exited`; the foreground process decides. */
      const observeAgent = async (live: TerminalIdentity, record: AgentRecord | null): Promise<AgentView> => {
        let info: AgentObservation | null = null, missing = false
        try { info = await backend.agentInfo(live, ctx) } catch (error) {
          if (!(error instanceof RuntimeError) || error.code !== 'agent_not_found') return { phase: record?.phase ?? 'launching', info: null, launchExpired: false, stale: true }
          missing = true
        }
        if (info && info.status === 'blocked') return { phase: 'blocked', info, launchExpired: false, stale: false }
        if (info && info.interactiveReady && (record === null || info.name === record.name)) return { phase: record?.phase ?? 'ready', info, launchExpired: false, stale: false }
        const kind = record?.kind ?? info?.kind ?? null
        if (kind === null) return { phase: 'exited', info, launchExpired: false, stale: false }
        let foreground: boolean
        try { foreground = (await backend.process(live, ctx)).foreground.some(entry => typeof entry.name === 'string' && entry.name.includes(kind)) }
        catch { return { phase: record?.phase ?? 'launching', info, launchExpired: false, stale: true } }
        if (!foreground) return { phase: 'exited', info, launchExpired: false, stale: false }
        if (!missing && record !== null && info !== null && info.launchPending && Date.now() < record.launchDeadline) return { phase: 'launching', info, launchExpired: false, stale: false }
        return { phase: 'launching', info, launchExpired: true, stale: false }
      }
      /** §3: N consecutive qualifying observations 750 ms apart whose state_change_seq never moved. */
      const gatePass = async (live: TerminalIdentity, record: AgentRecord | null, want: 'ready' | 'idle') => {
        const views: AgentView[] = []
        for (let index = 0; index < READY_SAMPLES; index++) {
          if (index) {
            if (Date.now() + READY_SAMPLE_INTERVAL_MS >= ctx.deadlineAt - 15) break
            await delay(READY_SAMPLE_INTERVAL_MS, undefined, { signal: ctx.signal })
          }
          const view = await observeAgent(live, record)
          views.push(view)
          if (view.stale || view.launchExpired || view.phase === 'blocked' || view.phase === 'exited') break
        }
        const first = views[0]?.info ?? null
        const satisfied = views.length === READY_SAMPLES && first !== null
          && views.every(view => view.info !== null && !view.stale && qualifies(view.info, want) && view.info.stateChangeSeq === first.stateChangeSeq)
        return { views, satisfied }
      }
      const phaseOf = (record: AgentRecord | null, views: AgentView[], satisfied: boolean): AgentPhase => {
        const last = views[views.length - 1]
        if (!last || last.stale) return record?.phase ?? 'launching'
        if (last.phase === 'blocked' || last.phase === 'exited') return last.phase
        if (satisfied && (record === null || record.phase === 'launching' || record.phase === 'blocked')) return 'ready'
        return record?.phase ?? 'launching'
      }
      const scanFiles = (record: AgentRecord, cwd: string): string[] => record.kind === 'codex'
        ? codexRolloutFiles(record.t0, Date.now())
        : sessionRecordPaths(record.kind, { cwd, sessionId: record.sessionId, t0Ms: record.t0, nowMs: Date.now() })
      /** §2/C7: exactly one rollout for this cwd since T0 proves ownership; 0 or 2+ stays unknown. */
      const codexOwner = (record: AgentRecord, cwd: string) => {
        const found = codexCandidates(codexRolloutFiles(record.t0, Date.now()), cwd, record.t0)
        return found.length === 1 ? found[0]! : null
      }
      const sessionOf = (record: AgentRecord, cwd: string) => {
        if (record.kind === 'codex') {
          const owner = codexOwner(record, cwd)
          return owner ? { sessionId: owner.sessionId, source: 'record-scan', path: owner.path } : { sessionId: null, source: null, path: null }
        }
        const file = sessionRecordPaths(record.kind, { cwd, sessionId: record.sessionId, t0Ms: record.t0, nowMs: Date.now() })[0] ?? null
        return { sessionId: record.sessionId, source: record.sessionIdSource, path: file }
      }
      const agentBlock = async (live: TerminalIdentity, record: AgentRecord | null, views: AgentView[], satisfied: boolean, manifest: DetectManifestObservation | null) => {
        const last = views[views.length - 1], info = last?.info ?? null, phase = phaseOf(record, views, satisfied)
        const session = record ? sessionOf(record, live.path) : { sessionId: null, source: null, path: null }
        return {
          kind: record?.kind ?? info?.kind ?? null, name: record?.name ?? info?.name ?? null, phase,
          requestedModel: record?.requestedModel ?? null, requestedEffort: record?.requestedEffort ?? null, requestedAdvisor: record?.requestedAdvisor ?? null,
          // Only an observed value is reported; corral does not restate the request as a resolution.
          resolvedModel: null, resolvedAdvisor: null,
          argv: record?.argv ?? null, sessionId: session.sessionId, sessionIdSource: session.source,
          sessionRecord: session.path === null ? null : { path: session.path, exists: fs.existsSync(session.path) },
          blocked: phase === 'blocked' ? { reason: blockedReason(info?.stateLabels ?? {}), screen: await excerpt(live) } : null,
          evidence: {
            agentStatus: info?.status ?? null, launchPending: info?.launchPending ?? null, interactiveReady: info?.interactiveReady ?? null,
            stateChangeSeq: info?.stateChangeSeq ?? null, samples: views.length, workingObserved: record?.workingObserved ?? false,
            stale: last?.stale ?? true, detectManifest: manifest, observedAt: info?.observedAt ?? new Date().toISOString(),
          },
          environmentWarnings: environmentWarnings(),
        }
      }
      const waitAgent = async (live: TerminalIdentity, record: AgentRecord | null, want: 'ready' | 'idle') => {
        for (;;) {
          ctx.signal.throwIfAborted()
          const pass = await gatePass(live, record, want)
          const phase = phaseOf(record, pass.views, pass.satisfied)
          if (pass.satisfied) { patchAgent(live, { phase }); return { ...pass, phase } }
          if (pass.views[pass.views.length - 1]?.launchExpired) throw new RuntimeError('agent_launch_expired', 'Managed agent binding expired while the provider is still in the foreground', { terminal: handle(live), recovery: 'terminal show / terminal read' }, 'wait', 'not_started')
          if (phase === 'blocked' || phase === 'exited') { patchAgent(live, { phase }); return { ...pass, phase } }
          if (Date.now() >= ctx.deadlineAt - 15) throw new RuntimeError('wait_timeout', 'Condition not met before deadline', { terminal: handle(live), condition: want === 'ready' ? 'agent-ready' : 'agent-idle' }, 'wait')
          await delay(Math.min(READY_SAMPLE_INTERVAL_MS, Math.max(1, ctx.deadlineAt - Date.now() - 15)), undefined, { signal: ctx.signal })
        }
      }
      /** §4.5/§4.6: confirm the body in the provider's own record, inside the submission window. */
      const confirmPrompt = async (live: TerminalIdentity, record: AgentRecord, identity: ReturnType<typeof bodyIdentity>,
        submittedAtMs: number, cursor: CursorEntry[], delivery: Record<string, unknown>, manifest: DetectManifestObservation, want: 'accepted' | 'responded') => {
        let workingObserved = record.workingObserved, view = await observeAgent(live, record)
        for (;;) {
          ctx.signal.throwIfAborted()
          if (view.info?.status === 'working') workingObserved = true
          const files = scanFiles(record, live.path)
          const count = countSubmissions({ kind: record.kind, files, identity, submittedAtMs, cursor })
          // C7: a codex rollout corral cannot prove it owns never confirms, whatever the count says.
          const unproven = record.kind === 'codex' && codexOwner(record, live.path) === null
          const reason = unproven ? 'ambiguous' : classifyCount(count, count.scanned.length)
          const responded = workingObserved && count.assistantAfter && view.info !== null && qualifies(view.info, 'idle')
          const done = reason === null && (want === 'accepted' || responded)
          if (done || view.phase === 'blocked' || view.phase === 'exited' || Date.now() >= ctx.deadlineAt - 15) {
            const phase: AgentPhase = reason !== null ? 'ready' : responded ? 'responded' : 'accepted'
            const stored = patchAgent(live, { phase, workingObserved }) ?? record
            return { terminal: handle(live), stage: reason === null ? 'confirmed' : 'submitted', outcome: reason === null ? 'completed' : 'unknown',
              delivery, record: { path: sessionOf(record, live.path).path ?? count.scanned[0]?.path ?? null, matchCount: count.matchCount, naiveCount: count.naiveCount, assistantAfter: count.assistantAfter, unavailableReason: reason },
              agent: await agentBlock(live, stored, [view], false, manifest) }
          }
          await delay(Math.min(READY_SAMPLE_INTERVAL_MS, Math.max(1, ctx.deadlineAt - Date.now() - 15)), undefined, { signal: ctx.signal })
          view = await observeAgent(live, record)
        }
      }
      const submitPrompt = async (live: TerminalIdentity, requestId: string, raw: string, want: 'accepted' | 'responded' | undefined) => {
        const record = loadAgent(live)
        if (!record) throw new RuntimeError('agent_not_found', 'No corral-managed agent is recorded for this terminal generation', { terminal: handle(live), recovery: 'terminal create --agent' }, 'preflight', 'not_started')
        // §3 fail-closed: an unverified detect manifest means a trust dialog may read as idle.
        const manifest = await observeManifest(record.kind)
        if (!manifest.verified) throw manifestGateError(record.kind, manifest)
        const pass = await gatePass(live, record, 'ready')
        const phase = phaseOf(record, pass.views, pass.satisfied)
        if (!pass.satisfied) {
          patchAgent(live, { phase })
          const block = await agentBlock(live, record, pass.views, false, manifest)
          if (phase === 'blocked') throw new RuntimeError('agent_blocked', 'Agent is showing a blocking screen; a human clears it, corral does not', { terminal: handle(live), agent: block }, 'preflight', 'not_started')
          throw new RuntimeError('agent_not_ready', 'Agent did not hold the ready gate across two observations', { terminal: handle(live), agent: block }, 'preflight', 'not_started')
        }
        const info = pass.views[pass.views.length - 1]!.info!
        const text = normalizeBody(raw), identity = bodyIdentity(text), files = scanFiles(record, live.path)
        // §2: codex's first submission has no owning record yet, so it skips the duplicate pre-check.
        if (!(record.kind === 'codex' && record.lastSubmission === null)) {
          const prior = countSubmissions({ kind: record.kind, files, identity, submittedAtMs: 0, cursor: [] })
          if (prior.matchCount > 0) throw new RuntimeError('prompt_already_delivered', 'The provider record already holds this body', { terminal: handle(live), matchCount: prior.matchCount }, 'preflight', 'not_started')
        }
        const screen = record.lastSubmission === null ? await excerpt(live) : null
        const submittedAtMs = Date.now(), submittedAt = new Date(submittedAtMs).toISOString(), cursor = captureCursor(files)
        // C3/D24: the cursor reaches disk before the effect, so a restart still knows where to look.
        patchAgent(live, { phase: 'ready', lastSubmission: { sha256: identity.sha256, bytes: identity.bytes, submittedAt, cursor, requestId: null } })
        await backend.promptAgent(live, text, info.stateChangeSeq, ctx)
        const stored = patchAgent(live, { lastSubmission: { sha256: identity.sha256, bytes: identity.bytes, submittedAt, cursor, requestId } }) ?? record
        const delivery = { bytes: identity.bytes, lines: identity.lines, sha256: identity.sha256, submittedAt, cursor, screen }
        if (want === undefined) {
          // D9: queue acceptance is not delivery. A no-wait submission is `queued`, never `completed`.
          return { terminal: handle(live), stage: 'submitted', outcome: 'queued', delivery, record: null,
            agent: await agentBlock(live, stored, [await observeAgent(live, stored)], false, manifest) }
        }
        return confirmPrompt(live, stored, identity, submittedAtMs, cursor, delivery, manifest, want)
      }
      /** §4.1/§4.3: start the agent, then — only with a body — wait for ready and submit it once. */
      const startAgent = async (created: TerminalIdentity, prompt: string | undefined) => {
        const kind = required('agent')
        if (!isAgentKind(kind)) throw new RuntimeError('invalid_request', '--agent must be claude, codex or grok')
        const terminal = await describe(created)
        const stages: Record<string, Stage> = { terminal: { status: 'completed', handle: terminal.handle, paneId: created.paneId }, agent: { status: 'not_started' }, prompt: { status: 'not_started' } }
        const done = async (stage: string, record: AgentRecord | null, views: AgentView[], satisfied: boolean, promptResult: unknown) => ({
          terminal, stage, outcome: stagesOutcome(stages), stages, prompt: promptResult,
          agent: record === null && views.length === 0 ? null : await agentBlock(created, record, views, satisfied, null),
        })
        let record: AgentRecord
        try {
          const sessionId = mintsSessionId(kind) ? randomUUID() : null
          const argv = providerArgv({ kind, model: flag('model'), effort: flag('effort'), advisor: flag('advisor'), sessionId: sessionId ?? undefined })
          const name = agentName(created.paneId), t0 = Date.now()
          // herdr prepends the provider executable itself, so only the flags travel in `args`.
          const started = await backend.startAgent(created, { name, kind, args: argv.slice(1), timeoutMs: AGENT_START_TIMEOUT_MS }, ctx)
          record = agents.write(created.paneId, { epoch, ptyGeneration: created.ptyId, kind, name, argv: started.argv.length ? started.argv : argv,
            requestedModel: flag('model') ?? null, requestedEffort: flag('effort') ?? null, requestedAdvisor: flag('advisor') ?? null,
            sessionId, sessionIdSource: sessionId === null ? null : 'client-minted', t0, launchDeadline: t0 + AGENT_START_TIMEOUT_MS,
            phase: 'launching', workingObserved: false, lastSubmission: null, updatedAt: t0 })
          stages.agent = { status: 'completed', name, argv: record.argv }
        } catch (error) {
          stages.agent = stageFailure(error)
          return done('pty_created', null, [], false, null)
        }
        if (prompt === undefined) return done('agent_started', record, [await observeAgent(created, record)], false, null)
        let ready
        try { ready = await waitAgent(created, record, 'ready') } catch (error) { stages.prompt = stageFailure(error); return done('agent_started', record, [], false, null) }
        if (!ready.satisfied) {
          // §4.3: a create that met a blocker ends here, complete, and does not hold the prompt.
          stages.prompt = { status: 'not_started', reason: ready.phase === 'blocked' ? 'agent_blocked' : 'agent_not_ready' }
          return done('agent_started', record, ready.views, false, null)
        }
        const promptId = derivedPromptId(required('request-id'))
        const child: Invocation = { command: 'terminal prompt', flags: { terminal: terminal.handle, 'request-id': promptId, stdin: true }, args: [], cwd: inv.cwd, stdin: prompt }
        try {
          const result = await receipts.run(child, () => submitPrompt(created, promptId, prompt, undefined))
          const outcome = isRecord(result) ? String(result.outcome) : 'unknown'
          stages.prompt = { status: outcome === 'queued' ? 'queued' : outcome === 'completed' ? 'completed' : 'unknown', requestId: promptId }
          const after = loadAgent(created)
          return done('agent_prompted', after, [await observeAgent(created, after)], false, result)
        } catch (error) {
          stages.prompt = { ...stageFailure(error), requestId: promptId }
          const after = loadAgent(created)
          return done('agent_started', after, [await observeAgent(created, after)], false, null)
        }
      }
      // §4.3: the receipt hash must cover the body, not only its path — a changed file must conflict.
      let body: string | undefined
      if (inv.command === 'terminal prompt' || (inv.command === 'terminal create' && f.agent !== undefined)) {
        const prompt = inv.command === 'terminal prompt', fileFlag = flag(prompt ? 'file' : 'prompt-file'), textFlag = flag(prompt ? 'text' : 'prompt')
        if (fileFlag !== undefined) {
          const file = path.resolve(inv.cwd, fileFlag)
          let content: string
          try { content = fs.readFileSync(file, 'utf8') } catch (error) { throw new RuntimeError('invalid_argument', `Cannot read prompt file: ${String(error)}`) }
          bytes(content, MAX_INPUT, prompt ? '--file' : '--prompt-file')
          body = content
          inv.stdin = content
        } else if (textFlag !== undefined) body = textFlag
        else if (prompt && f.stdin) {
          if (inv.stdin === undefined) reject('--stdin requires literal UTF-8 stdin in request')
          body = inv.stdin
        }
        if (prompt && body === undefined) reject('Prompt requires exactly one of --text, --file or --stdin')
        if (body !== undefined && normalizeBody(body) === '') reject('Prompt body must not be empty')
      }
      const execute = async (): Promise<unknown> => {
        if (inv.command === 'terminal list') {
          const worktree = f.worktree ? worktreeSelect(await records(), required('worktree'), inv.cwd) : undefined
          const panes = (await backend.list(epoch, ctx)).filter(p => !worktree || p.path === worktree.path), limit = Number(f.limit ?? 100)
          return { terminals: await Promise.all(panes.slice(0, limit).map(describe)), totalCount: panes.length, truncated: panes.length > limit }
        }
        if (inv.command === 'terminal create') {
          const worktree = worktreeSelect(await records(), flag('worktree') ?? 'current', inv.cwd)
          const created = await backend.create(epoch, worktree.path, flag('title'), ctx)
          if (f.title !== undefined && created.title !== f.title) { await backend.rename(created, required('title'), ctx); created.title = required('title') }
          // command is intentionally a shell command; text/stdin send never execute in the CLI host shell.
          if (f.command !== undefined) await backend.send(created, required('command') + '\r', ctx)
          await desktop?.changed()
          if (f.focus) await desktop!.reveal(created, ctx)
          if (f.agent !== undefined) return startAgent(created, body)
          return { terminal: await describe(created), stage: f.command === undefined ? 'pty_created' : 'command_accepted', outcome: 'completed' }
        }
        if (inv.command === 'terminal wait' && (f.for === 'agent-ready' || f.for === 'agent-idle')) {
          const live = (await resolve())!, record = loadAgent(live)
          const waited = await waitAgent(live, record, f.for === 'agent-ready' ? 'ready' : 'idle')
          return { terminal: required('terminal'), condition: f.for, satisfied: waited.satisfied,
            agent: await agentBlock(live, loadAgent(live), waited.views, waited.satisfied, null), stage: 'observed' }
        }
        if (inv.command === 'terminal wait') {
          let cursor = flag('cursor'), matched = '', baselineSet = !!cursor
          for (;;) {
            ctx.signal.throwIfAborted()
            if (Date.now() >= ctx.deadlineAt - 15) throw new RuntimeError('wait_timeout', 'Condition not met before deadline', { terminal: required('terminal'), condition: f.for, cursor }, 'wait')
            const live = await resolve(true)
            if (!live) {
              if (f.for === 'exit') return { terminal: required('terminal'), condition: 'exit', exitCode: null, stage: 'observed' }
              throw new RuntimeError('terminal_exited', 'PTY exited before condition was met')
            }
            if (f.for === 'ready') {
              const process = await backend.process(live, ctx)
              if (process.shellPid !== null) return { terminal: required('terminal'), condition: 'ready', meaning: 'transport', agentReady: null, stage: 'observed' }
            }
            if (f.for === 'output') {
              const output = await read(live, cursor)
              if (!baselineSet) {
                // Begin after all bytes already present, including output larger than one result page.
                cursor = codec.encode('c1', { target: createHash('sha256').update(required('terminal')).digest('hex'), offset: output.availableTo, pending: '' })
                baselineSet = true
              } else {
                if (output.gap) throw new RuntimeError('output_gap', 'Output was evicted before observation', output)
                cursor = output.cursor; matched += output.text
                if (output.to > output.from && (f.text === undefined || matched.includes(String(f.text)))) return { terminal: required('terminal'), condition: 'output', output, stage: 'observed' }
                // Matching can span pages, without retaining unbounded terminal output.
                const keep = Math.max(0, String(f.text ?? '').length - 1)
                matched = keep ? matched.slice(-keep) : ''
                if (output.hasMore) continue
              }
            }
            await delay(Math.min(30, Math.max(1, ctx.deadlineAt - Date.now() - 15)), undefined, { signal: ctx.signal })
          }
        }
        const live = (await resolve())!
        if (inv.command === 'terminal show') {
          const process = await backend.process(live, ctx)
          const record = loadAgent(live)
          let agent: unknown = null
          const first = await observeAgent(live, record)
          if (record !== null || first.info !== null) {
            // §4.4 D4: without a record corral reports only what herdr answers — it does not guess.
            const pass = first.stale || first.launchExpired || first.phase === 'blocked' || first.phase === 'exited'
              ? { views: [first], satisfied: false } : await gatePass(live, record, 'ready')
            agent = await agentBlock(live, record, pass.views, pass.satisfied, record === null ? null : await observeManifest(record.kind))
          }
          return { terminal: await describe(live), process: { ...process, observationId: 'p1.' + createHash('sha256').update(JSON.stringify(process)).digest('base64url') },
            connected: true, writable: process.shellPid !== null, agent, capabilities: { atomicTerminal: true, conditionalProcess: false, rawOutput: true, gui: desktop?.available() ?? false } }
        }
        if (inv.command === 'terminal read') {
          if (!f.screen) return { terminal: required('terminal'), ...await read(live, flag('cursor'), Number(f.limit ?? 65536)) }
          const output = await backend.read(live, true, ctx), buffer = Buffer.from(output.text), limit = Number(f.limit ?? 65536), decoded = decodeChunk(buffer.subarray(0, limit))
          return { terminal: required('terminal'), source: 'screen-snapshot', text: decoded.text, truncated: output.truncated || buffer.length > limit, generation: live.epoch + ':' + live.ptyId, cursor: null }
        }
        if (inv.command === 'terminal prompt') {
          if (body === undefined) reject('Prompt requires exactly one of --text, --file or --stdin')
          const want = flag('wait')
          return submitPrompt(live, required('request-id'), body, want === 'accepted' || want === 'responded' ? want : undefined)
        }
        if (inv.command === 'terminal send') {
          if (f.stdin && inv.stdin === undefined) reject('--stdin requires literal UTF-8 stdin in request')
          const text = f.interrupt ? '\x03' : String(f.stdin ? inv.stdin : f.text ?? '') + (f.enter ? '\r' : '')
          await backend.send(live, text, ctx)
          return { terminal: required('terminal'), stage: 'backend_accepted', bytes: Buffer.byteLength(text), consumed: null, outcome: 'completed' }
        }
        if (inv.command === 'terminal close') {
          await backend.close(live, ctx)
          if ((await backend.list(epoch, ctx)).some(p => p.ptyId === live.ptyId)) throw new RuntimeError('outcome_unknown', 'Close accepted but PTY removal not observed', { terminal: required('terminal') }, 'close', 'unknown')
          agents.remove(live.paneId)
          await desktop?.changed()
          return { terminal: required('terminal'), stage: 'closed', exitCode: null, outcome: 'completed' }
        }
        if (inv.command === 'terminal rename') {
          await backend.rename(live, required('title'), ctx); await desktop?.changed()
          return { terminal: required('terminal'), tabId: live.tabId, scope: 'tab', title: required('title'), stage: 'renamed' }
        }
        if (inv.command === 'terminal switch') {
          ctx.signal.throwIfAborted(); ctx.onEffect?.(); await desktop!.reveal(live, ctx)
          return { terminal: required('terminal'), stage: 'gui_selected' }
        }
        throw new RuntimeError('unsupported', 'Unknown terminal command')
      }
      if (['terminal create', 'terminal send', 'terminal prompt'].includes(inv.command)) {
        f['request-id'] ??= `r1.${Date.now()}.${randomUUID()}`
        return receipts.run(inv, execute)
      }
      agents.sweep()
      return execute()
    },
  }
}
