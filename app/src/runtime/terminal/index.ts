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
import { draftPastePayload, sanitizeDraftBody } from '../../shared/terminal-paste.js'
import { WorktreeMetadata, worktreeSelect } from '../workspace/model.js'
import { Tokens } from './tokens.js'
import { Receipts, REQUEST_ID } from './receipts.js'
import { backendBinding } from '../backend.js'
import { blockedReason, pickBlockedRule } from '../../shared/agent-state.js'
import { followContinued } from '../../main/transcript-continued.js'
import {
  AGENT_START_TIMEOUT_MS, AgentStore, READY_SAMPLES, READY_SAMPLE_INTERVAL_MS, SCREEN_EXCERPT_BYTES,
  agentName, bodyIdentity, captureCursor, classifyCount, codexCandidates, codexRolloutFiles, countSubmissions,
  evaluateManifest, isAgentKind, manifestGateError, mintsSessionId, normalizeBody, providerArgv, readySatisfied, resolvedIdentity, sessionRecordPaths,
  type AgentKind, type AgentPhase, type AgentRecord, type CursorEntry, type DetectManifestObservation,
} from './agent.js'
export const terminalSpecs: CommandSpec[] = specs
export const MAX_INPUT = 65536
export interface TerminalDesktop {
  available(): boolean
  changed(): Promise<void>
  reveal(target: TerminalIdentity, context: CommandContext): Promise<void>
  /**
   * The GUI's retained-completions ledger (LIFE-456 S15ⓓ / fix-r1 F6).
   *
   * `terminal close` is an explicit close just like the GUI's own, so it must mark the pane the
   * same way — otherwise closing a finished agent from the CLI resurrects it as a completion row
   * in the window. Optional because a headless runtime (`corral serve`) keeps no such ledger:
   * there is nothing to suppress, not a suppression we skipped.
   */
  /**
   * 억제 표(누가 닫았나). `settle` 은 **닫기가 끝난 뒤** 표를 걷을지 남길지 GUI 와 **같은
   * 분류 함수**로 정한다 (R2-F3) — CLI 가 혼자 판단하면 타임아웃에서 둘이 갈린다.
   */
  retention?: {
    suppress(id: string): void
    release(id: string): void
    settle(input: { ids: readonly string[]; code?: string | null; sent: boolean }): { effect: 'refused' | 'unknown' }
  }
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
/**
 * The CLI and the GUI report the same reason for the same pane (LIFE-456 S3 / fix-r1 F3).
 *
 * They now agree because they feed the **same judgment** (`shared/agent-state.ts`) from the
 * **same field**. Before, this side passed `state_labels` — which herdr 0.9.0 never sends for
 * claude/codex/grok (`raw/claude/s3/s3-state-labels-findings.md`) — while the GUI passed the
 * rule id from `agent.explain`. One pane therefore read `permission` in the GUI and `unknown`
 * in `terminal show`: two verdicts from one function, which is exactly what S6 forbids.
 *
 * Labels stay in the call as the second input, not as a fallback ranking of our own: when herdr
 * does start sending them, `blockedReason` already knows the rule id wins. `null` (herdr said
 * nothing at all) collapses to `'unknown'` here because the CLI field has always been a plain
 * string — the GUI keeps the `null`/`unknown` distinction in `agentState.blockedReason`.
 */
export function blockedReasonOf(input: { labels: Record<string, string>; ruleId: string | null }): string {
  return blockedReason(input) ?? 'unknown'
}
/** §8.2: report the marker this runtime carries. corral neither repairs it nor restarts the backend. */
function environmentWarnings(): string[] {
  return process.env.CLAUDE_CODE_CHILD_SESSION === undefined ? [] : ['claude_child_session_marker']
}
/**
 * What one observation says about the pane itself, which is not the same thing as the agent's phase:
 * `bound` only means herdr answers for a managed agent that is interactive. Promotion to `ready` is
 * the §3 gate's job, and the stored phase is never echoed back as if it had just been observed.
 */
interface AgentView { live: 'blocked' | 'exited' | 'launching' | 'bound'; info: AgentObservation | null; launchExpired: boolean; stale: boolean }
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
      const socket = backendBinding()?.socket
      if (!socket) throw new RuntimeError('backend_unavailable', 'Profile has no configured terminal backend')
      const backend = new TerminalBackend(socket)
      const epoch = await backend.epoch(ctx)
      // §5.2: the agent arms live only on a guard build that advertises agent_ops. Checked before
      // `terminal create` reaches the backend, so a stock or LIFE-393 build leaves no half-made pane.
      if (!backend.agentCapable() && ((inv.command === 'terminal create' && f.agent !== undefined) || inv.command === 'terminal prompt'
        || (inv.command === 'terminal wait' && (f.for === 'agent-ready' || f.for === 'agent-idle'))))
        throw new RuntimeError('unsupported_backend', 'Backend guard does not advertise agent_ops; rebuild with app/scripts/build-terminal-backend.sh', { recovery: 'app/scripts/build-terminal-backend.sh' }, 'preflight', 'not_started')
      const registry = new RepoRegistry(userData), records = () => new WorktreeMetadata(registry).list(registry.records(), ctx.signal)
      const handle = (target: TerminalIdentity) => codec.encode('t1', { runtimeId: ctx.runtimeId, epoch: target.epoch, ptyId: target.ptyId, paneId: target.paneId })
      const describe = async (target: TerminalIdentity) => {
        const worktree = (await records()).find(w => w.path === target.path)
        return { handle: handle(target), ...target, repo: registry.records().find(repo => repo.id === worktree?.repoId)?.path ?? target.repo, repoId: worktree?.repoId ?? null, worktreeId: worktree?.id ?? null }
      }
      let target: TerminalIdentity | undefined
      if (f.terminal !== undefined) {
        const decoded = codec.decode<TerminalIdentity & { runtimeId: string }>('t1', required('terminal'))
        if (decoded.runtimeId !== ctx.runtimeId || decoded.epoch !== epoch) throw new RuntimeError('stale_terminal', 'Handle belongs to another runtime/backend generation', { recovery: 'terminal list' }, undefined, 'not_started')
        target = decoded
      }
      // LIFE-423: neither handle check sends anything to a pane — the decode above compares against
      // the backend's epoch, `resolve()` reads its pane list — so both carry `not_started`. For the
      // one inside `receipts.run` that is what hands the `--request-id` back (README §59); the
      // decode throws before the receipt store is reached, so there it is metadata only. The stage
      // stays unset: §59 records that `stale_terminal` has none, and server.ts already answers
      // `preflight` for a refusal taken before any effect.
      const resolve = async (allowExit = false) => {
        const current = (await backend.list(epoch, ctx)).find(p => p.paneId === target!.paneId)
        if (!current && allowExit) return undefined
        if (!current || current.ptyId !== target!.ptyId) throw new RuntimeError('stale_terminal', 'PTY disappeared or was replaced', { terminal: required('terminal'), recovery: 'terminal list' }, undefined, 'not_started')
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
          if (!(error instanceof RuntimeError) || error.code !== 'agent_not_found') return { live: 'launching', info: null, launchExpired: false, stale: true }
          missing = true
        }
        if (info && info.status === 'blocked') return { live: 'blocked', info, launchExpired: false, stale: false }
        if (info && info.interactiveReady && (record === null || info.name === record.name)) return { live: 'bound', info, launchExpired: false, stale: false }
        const kind = record?.kind ?? info?.kind ?? null
        if (kind === null) return { live: 'exited', info, launchExpired: false, stale: false }
        // The launch window is asked before the foreground, not after it (D6: before the deadline the
        // phase stays `launching`). A shell that has not exec'd the provider yet has an empty
        // foreground, and reading that as `exited` stored a verdict the pane never earned.
        if (!missing && record !== null && info !== null && info.launchPending && Date.now() < record.launchDeadline) return { live: 'launching', info, launchExpired: false, stale: false }
        // The process name is the provider's own only when it came from PATH: a natively installed
        // claude is named for its version (`2.1.252`) and carries `claude` in `argv[0]` instead.
        let foreground: boolean
        try { foreground = (await backend.process(live, ctx)).foreground.some(entry => {
          const argv0 = Array.isArray(entry.argv) ? entry.argv[0] : null
          return (typeof entry.name === 'string' && entry.name.includes(kind)) || (typeof argv0 === 'string' && path.basename(argv0) === kind)
        }) }
        catch { return { live: 'launching', info, launchExpired: false, stale: true } }
        if (!foreground) return { live: 'exited', info, launchExpired: false, stale: false }
        return { live: 'launching', info, launchExpired: true, stale: false }
      }
      /** §3: N consecutive qualifying observations 750 ms apart whose state_change_seq never moved. */
      const gatePass = async (live: TerminalIdentity, record: AgentRecord | null) => {
        const views: AgentView[] = []
        for (let index = 0; index < READY_SAMPLES; index++) {
          if (index) {
            if (Date.now() + READY_SAMPLE_INTERVAL_MS >= ctx.deadlineAt - 15) break
            await delay(READY_SAMPLE_INTERVAL_MS, undefined, { signal: ctx.signal })
          }
          const view = await observeAgent(live, record)
          views.push(view)
          if (view.stale || view.launchExpired || view.live === 'blocked' || view.live === 'exited') break
        }
        const samples = views.filter(view => view.info !== null && !view.stale).map(view => view.info!)
        return { views, satisfied: samples.length === views.length && readySatisfied(samples) }
      }
      /**
       * §0/§3: `ready` needs the gate *and* a separate guard `server.agent_manifests` call confirming
       * the active detect manifest. An unverified manifest means a trust dialog can read as idle, so
       * ready is simply not issued — the reason travels in `evidence.detectManifest`.
       */
      const readyGate = async (live: TerminalIdentity, record: AgentRecord | null) => {
        const pass = await gatePass(live, record)
        const kind = record?.kind ?? pass.views[pass.views.length - 1]?.info?.kind ?? null
        // Observed on every pass, not only on a satisfying one: when it is what withheld `ready`,
        // the caller has to be able to say so (F12b wants the reason, not just satisfied: false).
        const manifest = kind !== null && isAgentKind(kind) ? await observeManifest(kind) : null
        return { views: pass.views, satisfied: pass.satisfied && manifest !== null && manifest.verified, manifest }
      }
      /**
       * A stored `ready` is a claim about a gate that held *then*. It is never echoed back while the
       * gate does not hold *now*, and the reason does not matter (R5): an unverified manifest, a
       * Working frame, a `state_change_seq` that moved, a deadline that left room for one sample —
       * each means the same thing, that corral cannot presently prove this pane will take a prompt.
       * `launching` is the §4.4 word for that, and `evidence` (`samples`, `detectManifest`) says
       * which of them it was. `accepted`/`responded` pass through untouched: they are facts about a
       * body found in the provider's own record, which no screen-detection rule can make untrue.
       */
      const unprovenPhase = (record: AgentRecord | null): AgentPhase =>
        record === null || record.phase === 'ready' ? 'launching' : record.phase
      const phaseOf = (record: AgentRecord | null, views: AgentView[], satisfied: boolean): AgentPhase => {
        const last = views[views.length - 1]
        if (!last || last.stale) return unprovenPhase(record)
        if (last.live === 'blocked') return 'blocked'
        if (last.live === 'exited') return 'exited'
        // A stored `exited` is let go here as well, but only when every observation of this gate was
        // `bound`: one bad observation (an empty foreground in the launch window) must not outlive the
        // pane, and a quiet sample that belongs to *another* name is not this binding coming back
        // (R18 — `satisfied` alone does not say whose pane answered, and herdr can rename a live
        // managed agent). `/exit` is unaffected either way: `agent_not_found` never reaches here.
        if (satisfied) return record === null || record.phase === 'launching' || record.phase === 'blocked'
          || (record.phase === 'exited' && views.every(view => view.live === 'bound')) ? 'ready' : record.phase
        if (last.live === 'launching') return 'launching'
        // Bound but the gate did not hold. A blocker that has been cleared is not a blocker any more,
        // and a pane that has not held the gate has not earned `ready` either. A bound pane with no
        // record of its own — another profile's managed pane, or one whose epoch moved — has nothing
        // to keep, so it is launching too.
        if (record === null || record.phase === 'blocked') return 'launching'
        return unprovenPhase(record)
      }
      /**
       * §2/C7: the record files corral can prove belong to *this* pane, and nothing else. claude and
       * grok are named by the session id corral minted. codex has no such id, so the proof is the
       * scan — exactly one rollout for this cwd since T0 — and 0 or 2+ candidates yield no files at
       * all. Match count, resolved model and the reported record path are then all read from this
       * one set (R1): borrowing another session's rollout for any of the three reports a body corral
       * never delivered, a model it never resolved, or both.
       *
       * LIFE-771: a claude session moved to the background (`←`·`/bg`) goes on in a new id's file and
       * leaves `continued-in` at the end of the minted one. The set is then that chain — the minted
       * file first, each continued file after it — followed by the same rule the chat view and phone
       * input use (LIFE-766 `followContinued`, `empty: 'follow'`: the next input lands in the new file
       * even before it holds a conversation). `path` is the last file the rule reached. When it cannot
       * conclude on its first look at the minted file (unknown, out of window, no target file) the
       * chain is just that file — what corral read before. Once a hop is proven, an unknown tail keeps
       * it and an unprovable later hop is not taken (LIFE-766 rule, at most `CONTINUED_CHAIN_MAX` hops). A minted session revived
       * after `continued-in` is the minted file alone again. `sessionId` stays the minted id: it names
       * the pane corral launched. The hop paths are rebuilt here with the rule's own "same folder as
       * the origin" placement; the 771 two-hop test pins them to the file the rule returns.
       */
      interface OwnedRecords { proven: boolean; files: string[]; sessionId: string | null; source: string | null; path: string | null; continuedIn: readonly string[] }
      const ownedRecords = (record: AgentRecord, cwd: string): OwnedRecords => {
        if (record.kind === 'codex') {
          const found = codexCandidates(codexRolloutFiles(record.t0, Date.now()), cwd, record.t0)
          const owner = found.length === 1 ? found[0] : undefined
          if (owner === undefined) return { proven: false, files: [], sessionId: null, source: null, path: null, continuedIn: [] }
          return { proven: true, files: [owner.path], sessionId: owner.sessionId, source: 'record-scan', path: owner.path, continuedIn: [] }
        }
        const file = sessionRecordPaths(record.kind, { cwd, sessionId: record.sessionId, t0Ms: record.t0, nowMs: Date.now() })[0] ?? null
        if (file === null || record.kind !== 'claude' || record.sessionId === null) {
          return { proven: true, files: file === null ? [] : [file], sessionId: record.sessionId, source: record.sessionIdSource, path: file, continuedIn: [] }
        }
        const followed = followContinued({ session: { kind: 'id', agent: 'claude', source: record.sessionIdSource ?? 'client-minted', id: record.sessionId }, file, empty: 'follow' })
        const files = [file, ...followed.hops.map(id => path.join(path.dirname(file), `${id}.jsonl`))]
        return { proven: true, files, sessionId: record.sessionId, source: record.sessionIdSource, path: followed.file, continuedIn: followed.hops }
      }
      /**
       * The rule id behind a blocked screen, or `null` when herdr cannot say (F3).
       *
       * A reason is a nicety on a read command, so a failure here degrades to `null` (which
       * `blockedReasonOf` renders as `unknown`) rather than failing `terminal show` — the
       * blocked *state* is already known and is the answer the caller asked for.
       */
      const blockedRuleId = async (live: TerminalIdentity): Promise<string | null> => {
        try {
          return pickBlockedRule(await backend.agentExplain(live, ctx)).ruleId
        } catch {
          return null
        }
      }
      const agentBlock = async (live: TerminalIdentity, record: AgentRecord | null, views: AgentView[], satisfied: boolean, manifest: DetectManifestObservation | null) => {
        const last = views[views.length - 1], info = last?.info ?? null, phase = phaseOf(record, views, satisfied)
        const session = record ? ownedRecords(record, live.path) : { sessionId: null, source: null, path: null, files: [], continuedIn: [] }
        // Only an observed value is reported; corral never restates the request as a resolution, and
        // it reads the resolution out of the file set it owns rather than every file it can see (R1).
        const resolved = record ? resolvedIdentity(record.kind, session.files) : { model: null, advisor: null, effort: null }
        return {
          kind: record?.kind ?? info?.kind ?? null, name: record?.name ?? info?.name ?? null, phase,
          requestedModel: record?.requestedModel ?? null, requestedEffort: record?.requestedEffort ?? null, requestedAdvisor: record?.requestedAdvisor ?? null,
          resolvedModel: resolved.model, resolvedAdvisor: resolved.advisor,
          argv: record?.argv ?? null, sessionId: session.sessionId, sessionIdSource: session.source,
          sessionRecord: session.path === null ? null : { path: session.path, exists: fs.existsSync(session.path), continuedIn: session.continuedIn },
          blocked: phase === 'blocked'
            ? { reason: blockedReasonOf({ labels: info?.stateLabels ?? {}, ruleId: await blockedRuleId(live) }), screen: await excerpt(live) }
            : null,
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
          const pass = await readyGate(live, record)
          const phase = phaseOf(record, pass.views, pass.satisfied)
          if (pass.satisfied) { patchAgent(live, { phase }); return { ...pass, phase } }
          if (pass.views[pass.views.length - 1]?.launchExpired) throw new RuntimeError('agent_launch_expired', 'Managed agent binding expired while the provider is still in the foreground', { terminal: handle(live), recovery: 'terminal show / terminal read' }, 'wait', 'not_started')
          // An unverified manifest is a refusal, not a slow answer (G1): waiting cannot make the gate
          // pass, so the reason is returned at once the way a blocking screen is, and `create --prompt`
          // can report `detect_manifest_unverified` instead of a deadline it never had a chance at.
          if (pass.manifest !== null && !pass.manifest.verified) { patchAgent(live, { phase }); return { ...pass, phase } }
          // A pane where corral never started anything is "not yet", not "exited": it waits out its
          // deadline. Only a pane with a record reports `exited`, which is the D6 case F10 relies on.
          const last = pass.views[pass.views.length - 1]
          if (last?.live === 'blocked') { patchAgent(live, { phase }); return { ...pass, phase } }
          if (last?.live === 'exited' && record !== null) { patchAgent(live, { phase }); return { ...pass, phase } }
          if (Date.now() >= ctx.deadlineAt - 15) throw new RuntimeError('wait_timeout', 'Condition not met before deadline', { terminal: handle(live), condition: want === 'ready' ? 'agent-ready' : 'agent-idle' }, 'wait')
          await delay(Math.min(READY_SAMPLE_INTERVAL_MS, Math.max(1, ctx.deadlineAt - Date.now() - 15)), undefined, { signal: ctx.signal })
        }
      }
      /**
       * §4.5/§4.6: confirm the body in the provider's own record, inside the submission window.
       *
       * Two questions, answered separately (R3). *Delivery* is the record's: exactly one match in
       * the window means the body arrived, and that stays true whatever happens next. The *wait* is
       * the caller's: `--wait responded` also asked to see the turn finish. A deadline, a blocking
       * screen or an exit ends the wait without answering it — the response then still reports the
       * delivery it confirmed, with `outcome: unknown` and the reason the wait ended. Only a wait
       * that was satisfied is `completed`, which is what README and `specs.json` promise.
       */
      const confirmPrompt = async (live: TerminalIdentity, record: AgentRecord, identity: ReturnType<typeof bodyIdentity>,
        submittedAtMs: number, cursor: CursorEntry[], delivery: Record<string, unknown>, manifest: DetectManifestObservation, want: 'accepted' | 'responded') => {
        let workingObserved = record.workingObserved, view = await observeAgent(live, record)
        for (;;) {
          ctx.signal.throwIfAborted()
          if (view.info?.status === 'working') workingObserved = true
          const owned = ownedRecords(record, live.path)
          // LIFE-771: the cursor was taken on the chain as it stood at submit, and counting reads that
          // same set. A hop that appears mid-wait only adds its new file after them — read whole, the
          // time bound and the uuid fold keep the copied rows out — so the cursor never names one file
          // while the count reads another. codex and grok keep counting exactly the files they own.
          const files = record.kind === 'claude' ? [...new Set([...cursor.map(entry => entry.path), ...owned.files])] : owned.files
          const count = countSubmissions({ kind: record.kind, files, identity, submittedAtMs, cursor })
          // C7: a codex rollout corral cannot prove it owns never confirms, whatever the count says.
          const reason = owned.proven ? classifyCount(count, count.scanned.length) : 'ambiguous'
          const delivered = reason === null
          // §3: a finished turn closes on the same N=2 · 750 ms · unchanged-seq gate `agent-idle`
          // uses (R4). One quiet frame between two tool calls is not the end of a turn.
          const closing = delivered && want === 'responded' && workingObserved && count.assistantAfter
            ? await gatePass(live, record) : null
          const responded = closing !== null && closing.satisfied
          const satisfied = delivered && (want === 'accepted' || responded)
          const stopped = view.live === 'blocked' ? 'agent_blocked' : view.live === 'exited' ? 'agent_exited' : null
          if (satisfied || stopped !== null || Date.now() >= ctx.deadlineAt - 15) {
            const phase: AgentPhase = !delivered ? 'ready' : responded ? 'responded' : 'accepted'
            const stored = patchAgent(live, { phase, workingObserved }) ?? record
            // R12: when the closing gate ran, its observations are the current ones — two samples at
            // the seq the turn ended on. The single frame this iteration opened with was taken before
            // the gate and, on a turn that started Working, describes a state already left behind.
            const observed = closing ?? { views: [view], satisfied: false }
            return { terminal: handle(live), stage: delivered ? 'confirmed' : 'submitted', outcome: satisfied ? 'completed' : 'unknown',
              wait: { requested: want, satisfied, reason: satisfied ? null : stopped ?? 'deadline' },
              delivery, record: { path: owned.path, matchCount: count.matchCount, naiveCount: count.naiveCount,
                assistantAfter: count.assistantAfter, cursorInvalidated: count.cursorInvalidated, unavailableReason: reason },
              agent: await agentBlock(live, stored, observed.views, observed.satisfied, manifest) }
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
        const pass = await gatePass(live, record)
        const phase = phaseOf(record, pass.views, pass.satisfied)
        if (!pass.satisfied) {
          patchAgent(live, { phase })
          const block = await agentBlock(live, record, pass.views, false, manifest)
          if (phase === 'blocked') throw new RuntimeError('agent_blocked', 'Agent is showing a blocking screen; a human clears it, corral does not', { terminal: handle(live), agent: block }, 'preflight', 'not_started')
          throw new RuntimeError('agent_not_ready', 'Agent did not hold the ready gate across two observations', { terminal: handle(live), agent: block }, 'preflight', 'not_started')
        }
        const info = pass.views[pass.views.length - 1]!.info!
        const text = normalizeBody(raw), identity = bodyIdentity(text), files = ownedRecords(record, live.path).files
        // §2: codex's first submission has no owning record yet, so it skips the duplicate pre-check.
        if (!(record.kind === 'codex' && record.lastSubmission === null)) {
          // Scan only what corral owns: another session's identical body must not refuse this one.
          const prior = countSubmissions({ kind: record.kind, files, identity, submittedAtMs: 0, cursor: [] })
          if (prior.matchCount > 0) throw new RuntimeError('prompt_already_delivered', 'The provider record already holds this body', { terminal: handle(live), matchCount: prior.matchCount }, 'preflight', 'not_started')
        }
        const screen = record.lastSubmission === null ? await excerpt(live) : null
        const submittedAtMs = Date.now(), submittedAt = new Date(submittedAtMs).toISOString(), cursor = captureCursor(files)
        // C3/D24: the cursor reaches disk before the effect, so a restart still knows where to look.
        // `workingObserved` is reset with it (R4): it is evidence about *this* submission's turn, and
        // a Working left over from the previous one would otherwise satisfy `responded` on its own.
        patchAgent(live, { phase: 'ready', workingObserved: false, lastSubmission: { sha256: identity.sha256, bytes: identity.bytes, submittedAt, cursor, requestId: null } })
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
        // LIFE-417 N4: a fresh pane whose shell is still running its rc refuses the start as
        // `agent_pane_busy`; the backend absorbs that the same way the GUI row path does. How many
        // times it had to re-knock is evidence about *this* create, so it travels in the stage —
        // on the failure path too, which is why the backend reports it through a callback rather
        // than in the return value it never gets to produce.
        let agentRetries = 0
        try {
          const sessionId = mintsSessionId(kind) ? randomUUID() : null
          const argv = providerArgv({ kind, model: flag('model'), effort: flag('effort'), advisor: flag('advisor'), sessionId: sessionId ?? undefined })
          const name = agentName(created.paneId), t0 = Date.now()
          // herdr prepends the provider executable itself, so only the flags travel in `args`.
          const started = await backend.startAgent(created, { name, kind, args: argv.slice(1), timeoutMs: AGENT_START_TIMEOUT_MS,
            onBusyRetry: attempt => { agentRetries = attempt } }, ctx)
          record = agents.write(created.paneId, { epoch, ptyGeneration: created.ptyId, kind, name, argv: started.argv.length ? started.argv : argv,
            requestedModel: flag('model') ?? null, requestedEffort: flag('effort') ?? null, requestedAdvisor: flag('advisor') ?? null,
            sessionId, sessionIdSource: sessionId === null ? null : 'client-minted', t0, launchDeadline: t0 + AGENT_START_TIMEOUT_MS,
            phase: 'launching', workingObserved: false, lastSubmission: null, updatedAt: t0 })
          stages.agent = { status: 'completed', name, argv: record.argv, retries: agentRetries }
        } catch (error) {
          stages.agent = { ...stageFailure(error), retries: agentRetries }
          return done('pty_created', null, [], false, null)
        }
        if (prompt === undefined) return done('agent_started', record, [await observeAgent(created, record)], false, null)
        let ready
        try { ready = await waitAgent(created, record, 'ready') } catch (error) { stages.prompt = stageFailure(error); return done('agent_started', record, [], false, null) }
        if (!ready.satisfied) {
          // §4.3: a create that met a blocker ends here, complete, and does not hold the prompt.
          stages.prompt = { status: 'not_started', reason: ready.phase === 'blocked' ? 'agent_blocked'
            : ready.manifest !== null && !ready.manifest.verified ? 'detect_manifest_unverified' : 'agent_not_ready' }
          return { ...await done('agent_started', record, ready.views, false, null), agent: await agentBlock(created, record, ready.views, false, ready.manifest) }
        }
        // LIFE-603 D8: `worktree create --draft` forwards `draft` here (terminal create itself does not advertise it).
        // The body goes into the input as one bracketed paste, fenced on the ready observation's seq, and no Enter follows.
        // `completed` means corral wrote the sanitized body to the pane once, as a bracketed paste with no Enter, while the
        // agent's state seq was still the ready one. It does **not** mean the body is visible or that nothing was submitted:
        // only the provider's session record can show that, and this stage does not read it.
        if (f.draft === true) {
          const text = sanitizeDraftBody(prompt), identity = bodyIdentity(text), info = ready.views[ready.views.length - 1]?.info ?? null
          if (text === '' || info === null) {
            stages.prompt = { status: 'not_started', mode: 'draft', reason: text === '' ? 'empty_after_sanitize' : 'agent_not_ready' }
            return done('agent_started', record, ready.views, true, null)
          }
          try {
            await backend.sendIfUnchanged(created, draftPastePayload(text), info.stateChangeSeq, ctx)
            stages.prompt = { status: 'completed', mode: 'draft', enterSent: false, bytes: identity.bytes, lines: identity.lines, sha256: identity.sha256 }
            // LIFE-603 K1: report the manifest the ready gate verified before the paste, not `null`.
            const after = [await observeAgent(created, record)]
            return { ...await done('agent_drafted', record, after, false, null), agent: await agentBlock(created, record, after, false, ready.manifest) }
          } catch (error) {
            stages.prompt = { ...stageFailure(error), mode: 'draft' }
            return done('agent_started', record, [await observeAgent(created, record)], false, null)
          }
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
            agent: await agentBlock(live, loadAgent(live), waited.views, waited.satisfied, waited.manifest), stage: 'observed' }
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
            const pass = first.stale || first.launchExpired || first.live === 'blocked' || first.live === 'exited'
              ? { views: [first], satisfied: false, manifest: record === null ? null : await observeManifest(record.kind) }
              : await readyGate(live, record)
            agent = await agentBlock(live, record, pass.views, pass.satisfied, pass.manifest)
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
          // LIFE-423 M1: `validateTerminal` lets `--stdin` with no body through, so this lands inside
          // the receipt, before `backend.send`. The shared `reject` cannot say so — it has no outcome
          // — and without one the refusal spent an id it never used.
          if (f.stdin && inv.stdin === undefined) throw new RuntimeError('invalid_argument', '--stdin requires literal UTF-8 stdin in request', undefined, undefined, 'not_started')
          const text = f.interrupt ? '\x03' : String(f.stdin ? inv.stdin : f.text ?? '') + (f.enter ? '\r' : '')
          await backend.send(live, text, ctx)
          return { terminal: required('terminal'), stage: 'backend_accepted', bytes: Buffer.byteLength(text), consumed: null, outcome: 'completed' }
        }
        if (inv.command === 'terminal close') {
          // F6 — an explicit close from the CLI marks the pane exactly as the GUI's does.
          desktop?.retention?.suppress(live.paneId)
          // R3-F1 — 전송 여부를 **여기서 실제로 잡는다**. `TerminalBackend` 는 변경 연산에서
          // `ctx.onEffect` 를 `request()` 의 `onSent` 로 넘기고, 그 훅은 소켓에 바이트를 쓰기
          // 직전에 불린다. 그래서 이 불리언은 "이 닫기 요청이 나갔는가" 그 자체다.
          //
          // `RuntimeError.outcome` 은 쓰지 않는다 — 그 값은 backend 인스턴스가 **누적으로**
          // 받아들인 효과 수(`acceptedEffects`)에서 나오므로 이 요청 한 번이 나갔는지와 다르다.
          let sent = false
          const closeCtx = { ...ctx, onEffect: () => { sent = true; ctx.onEffect?.() } }
          try {
            await backend.close(live, closeCtx)
          } catch (error) {
            // R2-F3: a refusal with no effect drops the mark; an unknown outcome KEEPS it, the
            // same call the GUI makes. Before, this dropped the mark on every throw — including
            // `backend_timeout`, where the GUI kept it. One pane, two opposite verdicts.
            const code = error instanceof RuntimeError ? error.code : null
            desktop?.retention?.settle({ ids: [live.paneId], code, sent })
            throw error
          }
          if ((await backend.list(epoch, ctx)).some(p => p.ptyId === live.ptyId)) {
            // Accepted but the PTY is still listed — the result is unknown, so the mark STAYS.
            // Resurrecting a pane the user closed is worse than losing one completion row.
            throw new RuntimeError('outcome_unknown', 'Close accepted but PTY removal not observed', { terminal: required('terminal') }, 'close', 'unknown')
          }
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
