/**
 * LIFE-394 — agent launch, readiness and prompt-delivery rules (03-design §2~§4.7).
 *
 * Everything here is either a pure function or a small file-backed store, so the l394 verification
 * scripts run the same rules the product runs (§4.6). corral never parses provider screens and
 * never reads provider trust records: readiness comes from herdr's own agent state machine, and a
 * submission is only "accepted" when the provider's session record contains the body once.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { RuntimeError } from '../contracts.js'
import { isRecord } from '../../shared/json.js'
import { atomicWrite, privateDirectory, readFile } from '../storage.js'

export const AGENT_KINDS = ['claude', 'codex', 'grok'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]
export const isAgentKind = (value: unknown): value is AgentKind => AGENT_KINDS.some(kind => kind === value)

export type AgentPhase = 'launching' | 'blocked' | 'ready' | 'accepted' | 'responded' | 'exited'
/** herdr's startup deadline (src/terminal/state.rs); a human may sit on a trust screen for minutes. */
export const AGENT_START_TIMEOUT_MS = 300000
export const READY_SAMPLES = 2
export const READY_SAMPLE_INTERVAL_MS = 750
export const SCREEN_EXCERPT_BYTES = 4096

// --- §3 ready gate ------------------------------------------------------------------------------

export interface ReadySample { status: string; launchPending: boolean; interactiveReady: boolean; stateChangeSeq: number }
/** One observation that is quiet: bound, not launching, and either idle or (for `idle`) finished. */
export const agentQuiescent = (sample: ReadySample, want: 'ready' | 'idle'): boolean =>
    sample.interactiveReady && !sample.launchPending && (want === 'ready' ? sample.status === 'idle' : sample.status === 'idle' || sample.status === 'done')
/**
 * §3: ready is N consecutive quiet observations 750 ms apart whose `state_change_seq` never moved.
 * The unchanged seq is the real proof — it says herdr recorded no transition between the samples —
 * so N stays 2 rather than approximating "no transition in flight" with more samples.
 */
export function readySatisfied(samples: ReadySample[], want: 'ready' | 'idle'): boolean {
    const first = samples[0]
    if (samples.length !== READY_SAMPLES || first === undefined) return false
    return samples.every(sample => agentQuiescent(sample, want) && sample.stateChangeSeq === first.stateChangeSeq)
}

// --- §4.5 body identity -------------------------------------------------------------------------

/**
 * Trim only SPACE, TAB, CR and LF from both ends (C4/D25). NBSP, BOM and every other Unicode space
 * are content: a body wrapped in them is a *different* body. Nothing inside is touched.
 */
export function normalizeBody(text: string): string {
    const trimmable = (code: number) => code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a
    let start = 0, end = text.length
    while (start < end && trimmable(text.charCodeAt(start))) start++
    while (end > start && trimmable(text.charCodeAt(end - 1))) end--
    return text.slice(start, end)
}
export interface BodyIdentity { bytes: number; lines: number; sha256: string }
/** Length + digest of the normalized body. The body itself is never stored (§4.5, LIFE-393 rule). */
export function bodyIdentity(text: string): BodyIdentity {
    const normalized = normalizeBody(text)
    return {
        bytes: Buffer.byteLength(normalized),
        lines: normalized.length ? normalized.split('\n').length : 0,
        sha256: createHash('sha256').update(normalized).digest('hex'),
    }
}
export function sameBody(identity: BodyIdentity, text: string): boolean {
    const other = bodyIdentity(text)
    return other.bytes === identity.bytes && other.sha256 === identity.sha256
}

// --- §4.2 argv and §4.1 validation --------------------------------------------------------------

export interface AgentRequest { kind: AgentKind; model?: string; effort?: string; advisor?: string; sessionId?: string }
/** herdr rejects control characters in agent args (invalid_agent_argument); refuse before the call. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
function argument(value: string, name: string): string {
    if (!value.length || CONTROL_CHARACTER.test(value)) throw new RuntimeError('invalid_argument', `--${name} must be printable text`)
    return value
}
export function providerArgv(request: AgentRequest): string[] {
    const { kind, model, effort, advisor, sessionId } = request
    if (advisor !== undefined && kind !== 'claude') throw new RuntimeError('invalid_request', '--advisor applies to --agent claude only')
    const argv: string[] = [kind]
    if (kind === 'claude') {
        if (model !== undefined) argv.push('--model', argument(model, 'model'))
        if (effort !== undefined) argv.push('--effort', argument(effort, 'effort'))
        if (advisor !== undefined) argv.push('--advisor', argument(advisor, 'advisor'))
        if (sessionId !== undefined) argv.push('--session-id', sessionId)
    } else if (kind === 'codex') {
        if (model !== undefined) argv.push('-m', argument(model, 'model'))
        if (effort !== undefined) argv.push('-c', `model_reasoning_effort=${argument(effort, 'effort')}`)
    } else {
        if (model !== undefined) argv.push('-m', argument(model, 'model'))
        if (effort !== undefined) argv.push('--reasoning-effort', argument(effort, 'effort'))
        if (sessionId !== undefined) argv.push('-s', sessionId)
    }
    return argv
}
/** corral mints the session id for the providers that accept one; codex is found by scan (§2). */
export const mintsSessionId = (kind: AgentKind): boolean => kind !== 'codex'
/** herdr agent names must match ^[a-z][a-z0-9_-]{0,31}$ and be unique per pane (src/app/agents.rs). */
export const agentName = (paneId: string): string => 'corral-' + createHash('sha256').update(paneId).digest('hex').slice(0, 8)

// --- §3 detect manifest gate (D17, C2) ----------------------------------------------------------

export interface ManifestExpectation { version: string; sourceKind: string; localOverrideShadowingRemote: boolean }
/**
 * What the guard's `server.agent_manifests` must report before corral will submit for a provider.
 * codex and grok carry the versions `app/backend/herdr-detect.patch` sets; claude is not patched, so
 * its expectation is the stock bundled version. All three are gated by the same code (C2/D23): "we
 * did not patch it" is not a guarantee that the provider's trust rule is still present — review r4
 * showed a claude override that drops the rule reports the real trust screen as Idle.
 */
export const EXPECTED_MANIFESTS: Readonly<Record<AgentKind, ManifestExpectation>> = {
    claude: { version: '2026.09.04.1', sourceKind: 'bundled', localOverrideShadowingRemote: false },
    codex: { version: '2026.09.21.3', sourceKind: 'bundled', localOverrideShadowingRemote: false },
    grok: { version: '2026.09.21.3', sourceKind: 'bundled', localOverrideShadowingRemote: false },
}
export interface ManifestReport { agent?: unknown; source_kind?: unknown; active_version?: unknown; local_override_shadowing_remote?: unknown }
export interface DetectManifestObservation {
    sourceKind: string | null
    activeVersion: string | null
    expectedVersion: string
    localOverrideShadowingRemote: boolean | null
    verified: boolean
    queryError: string | null
}
/** Fail-closed: anything other than the expected bundled manifest means "do not submit" (§3). */
export function evaluateManifest(kind: AgentKind, manifests: ManifestReport[] | null, queryError: string | null): DetectManifestObservation {
    const expected = EXPECTED_MANIFESTS[kind]
    const unverified = (error: string): DetectManifestObservation => ({
        sourceKind: null, activeVersion: null, expectedVersion: expected.version,
        localOverrideShadowingRemote: null, verified: false, queryError: error,
    })
    if (queryError !== null) return unverified(queryError)
    if (manifests === null) return unverified('server.agent_manifests returned no manifest list')
    const entry = manifests.find(item => item.agent === kind)
    if (!entry) return unverified(`no manifest reported for ${kind}`)
    const sourceKind = typeof entry.source_kind === 'string' ? entry.source_kind : null
    const activeVersion = typeof entry.active_version === 'string' ? entry.active_version : null
    const shadowing = typeof entry.local_override_shadowing_remote === 'boolean' ? entry.local_override_shadowing_remote : null
    const verified = sourceKind === expected.sourceKind && activeVersion === expected.version && shadowing === expected.localOverrideShadowingRemote
    return { sourceKind, activeVersion, expectedVersion: expected.version, localOverrideShadowingRemote: shadowing, verified, queryError: null }
}
export function manifestGateError(kind: AgentKind, observation: DetectManifestObservation): RuntimeError {
    return new RuntimeError(
        'detect_manifest_unverified',
        'Active detect manifest is not the verified bundled one; refusing to submit into a possibly undetected dialog',
        { observed: { provider: kind, ...observation }, recovery: 'terminal show / terminal read' },
        'preflight', 'not_started')
}

// --- §2 codex session scan ----------------------------------------------------------------------

const pad = (value: number) => String(value).padStart(2, '0')
const localDate = (ms: number) => { const at = new Date(ms); return `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}` }
const utcDate = (ms: number) => { const at = new Date(ms); return `${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())}` }
const DAY_MS = 86400000
/**
 * Date directories to scan, recomputed from `now` on every check (D14) so a human who sits on the
 * trust screen past midnight — or past two — does not lose the directory the rollout lands in. Both
 * the local and the UTC calendar are walked because the file name's timezone is not contracted
 * (review r3 미확인 2), and one extra day is added for a launch that crosses the boundary.
 */
export function codexSessionDates(t0Ms: number, nowMs: number): string[] {
    const dates = new Set<string>()
    for (let at = t0Ms; at <= nowMs + DAY_MS; at += DAY_MS) { dates.add(localDate(at)); dates.add(utcDate(at)) }
    dates.add(localDate(nowMs + DAY_MS)); dates.add(utcDate(nowMs + DAY_MS))
    return [...dates].sort()
}
export const codexHome = (home = os.homedir()): string => process.env.CODEX_HOME ?? path.join(home, '.codex')
export function codexRolloutFiles(t0Ms: number, nowMs: number, root = codexHome()): string[] {
    const files: string[] = []
    for (const date of codexSessionDates(t0Ms, nowMs)) {
        const directory = path.join(root, 'sessions', date)
        let names: string[]
        try { names = fs.readdirSync(directory) } catch { continue }
        for (const name of names) if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(path.join(directory, name))
    }
    return files.sort()
}
export interface CodexCandidate { path: string; sessionId: string; cwd: string; timestamp: string }
const realpath = (value: string) => { try { return fs.realpathSync(value) } catch { return value } }
/**
 * A candidate is a rollout whose `session_meta` cwd resolves to the pane's cwd and whose timestamp
 * is not older than the launch. The realpath normalization is not optional: corral hands codex
 * `/tmp/...` while the rollout records `/private/tmp/...` (fix1 findings §2). Two or more candidates
 * are never narrowed by guessing — the caller keeps `sessionId: null` and reports them (§2 rule 4).
 */
export function codexCandidates(files: string[], cwd: string, t0Ms: number, read?: (file: string) => string | null): CodexCandidate[] {
    const load = read ?? ((file: string) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } })
    const target = realpath(cwd), found: CodexCandidate[] = []
    for (const file of files) {
        const text = load(file)
        if (text === null) continue
        let row: unknown
        try { row = JSON.parse(text.split('\n', 1)[0] ?? '') } catch { continue }
        const payload = asRecord(asRecord(row)?.payload)
        if (!payload || typeof payload.cwd !== 'string' || typeof payload.id !== 'string' || typeof payload.timestamp !== 'string') continue
        if (realpath(payload.cwd) !== target) continue
        if (Date.parse(payload.timestamp) < t0Ms - 5000) continue
        found.push({ path: file, sessionId: payload.id, cwd: payload.cwd, timestamp: payload.timestamp })
    }
    return found
}

// --- §4.6 record window and match counting ------------------------------------------------------

export interface CursorEntry { path: string; existed: boolean; bytes: number; lines: number }
/** Capture where each candidate record file ends *before* the submit RPC (§4.6; persisted per C3). */
export function captureCursor(paths: string[], read?: (file: string) => string | null): CursorEntry[] {
    const load = read ?? ((file: string) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } })
    return paths.map(file => {
        const text = load(file)
        if (text === null) return { path: file, existed: false, bytes: 0, lines: 0 }
        return { path: file, existed: true, bytes: Buffer.byteLength(text), lines: text.length ? text.split('\n').length - 1 : 0 }
    })
}
/**
 * grok writes integer Unix seconds; codex and claude write ISO-8601 ms. The lower bound is a second
 * for all three (C8, review r4 미확인 6), so a record stamped in the same second as the submit still
 * counts. No slack is added: slack drags the previous submission of the same second back in, and the
 * cursor is what separates those.
 */
export const submissionSecond = (submittedAtMs: number): number => Math.floor(submittedAtMs / 1000)

export type RecordUnavailable = 'record_disabled' | 'not_found' | 'ambiguous' | 'hook_blocked'
export interface ScannedFile { path: string; rows: number; fromLine: number; whole: boolean }
export interface CountResult {
    matchCount: number
    naiveCount: number
    cursorInvalidated: boolean
    assistantAfter: boolean
    hookBlocked: boolean
    scanned: ScannedFile[]
}
type RowRole = 'user' | 'assistant' | 'other'
interface Row { index: number; text: string | null; timeSeconds: number | null; role: RowRole }

const asRecord = (value: unknown): Record<string, unknown> | null => isRecord(value) ? value : null
const isoSeconds = (value: unknown): number | null => {
    if (typeof value !== 'string') return null
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}
/**
 * The per-provider filter of §4.6. Counting by substring is wrong for every provider: the same body
 * comes back as an assistant echo or an event mirror, which is why codex shows 2 naive hits for one
 * submission and 1 under this rule.
 */
function projectRow(kind: AgentKind, row: Record<string, unknown>): Omit<Row, 'index'> {
    if (kind === 'claude') {
        const message = asRecord(row.message), origin = asRecord(row.origin)
        const human = row.type === 'user' && origin?.kind === 'human' && typeof message?.content === 'string'
        return {
            text: human ? String(message?.content) : null,
            timeSeconds: isoSeconds(row.timestamp),
            role: row.type === 'assistant' ? 'assistant' : row.type === 'user' ? 'user' : 'other',
        }
    }
    if (kind === 'codex') {
        const payload = asRecord(row.payload)
        const message = row.type === 'response_item' && payload?.type === 'message'
        const parts = Array.isArray(payload?.content) ? payload.content : []
        const text = message && payload?.role === 'user'
            ? parts.filter(part => asRecord(part)?.type === 'input_text').map(part => String(asRecord(part)?.text ?? '')).join('')
            : null
        const role: RowRole = message && payload?.role === 'assistant' ? 'assistant' : message && payload?.role === 'user' ? 'user' : 'other'
        return { text, timeSeconds: isoSeconds(row.timestamp), role }
    }
    const update = asRecord(asRecord(row.params)?.update) ?? asRecord(row.update)
    const sessionUpdate = update?.sessionUpdate
    const content = update?.content
    const text = sessionUpdate === 'user_message_chunk'
        ? (typeof content === 'string' ? content
            : Array.isArray(content) ? content.map(part => String(asRecord(part)?.text ?? '')).join('')
                : String(asRecord(content)?.text ?? ''))
        : null
    const role: RowRole = sessionUpdate === 'agent_message_chunk' ? 'assistant' : sessionUpdate === 'user_message_chunk' ? 'user' : 'other'
    return { text, timeSeconds: typeof row.timestamp === 'number' ? Math.floor(row.timestamp) : isoSeconds(row.timestamp), role }
}
function parseRows(kind: AgentKind, text: string): Row[] {
    const rows: Row[] = []
    text.split('\n').forEach((line, index) => {
        if (!line.trim()) return
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { return }
        const record = asRecord(parsed)
        if (record) rows.push({ index, ...projectRow(kind, record) })
    })
    return rows
}
export interface CountInput {
    kind: AgentKind
    files: string[]
    identity: BodyIdentity
    submittedAtMs: number
    cursor: CursorEntry[]
    read?: (file: string) => string | null
}
/**
 * Count the submitted body in the provider's own record, inside the submission window: at or after
 * the submit second, and after the pre-submit cursor. A file that grew from a known cursor is read
 * from that cursor; a file that did not exist then — or that appeared since — is read whole, with the
 * time bound doing the separating (codex's rollout is created after the queue ack, so its cursor set
 * can be empty). A file that is now *shorter* than its cursor was rotated or replaced: it is scanned
 * whole and flagged, and the caller must keep the outcome unknown (C3/D24) because the time bound
 * alone re-counts a previous row from the same second.
 */
export function countSubmissions(input: CountInput): CountResult {
    const read = input.read ?? ((file: string) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } })
    const second = submissionSecond(input.submittedAtMs)
    const result: CountResult = { matchCount: 0, naiveCount: 0, cursorInvalidated: false, assistantAfter: false, hookBlocked: false, scanned: [] }
    for (const file of input.files) {
        const text = read(file)
        if (text === null) continue
        const prior = input.cursor.find(entry => entry.path === file)
        let fromLine = 0, whole = true
        if (prior?.existed) {
            if (Buffer.byteLength(text) < prior.bytes) result.cursorInvalidated = true
            else { fromLine = prior.lines; whole = false }
        }
        const rows = parseRows(input.kind, text)
        result.scanned.push({ path: file, rows: rows.length, fromLine, whole })
        let lastMatch = -1
        for (const row of rows) {
            if (row.text !== null && sameBody(input.identity, row.text)) result.naiveCount++
            if (row.index < fromLine) continue
            if (row.timeSeconds !== null && row.timeSeconds < second) continue
            if (row.text === null || !sameBody(input.identity, row.text)) continue
            result.matchCount++
            lastMatch = row.index
        }
        if (lastMatch >= 0 && rows.some(row => row.index > lastMatch && row.role === 'assistant')) result.assistantAfter = true
        if (input.kind === 'grok' && grokSubmitHookBlocked(text)) result.hookBlocked = true
    }
    return result
}
/**
 * grok writes a `hook_execution` row for `user_prompt_submit` even when the prompt goes through, and
 * one failing run does not mean the prompt was blocked — fix1 saw `status: failed` on a prompt that
 * arrived (findings §4, review 미확인 7). Only a run reporting a blocking status counts.
 */
function grokSubmitHookBlocked(text: string): boolean {
    for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        const row = asRecord(parsed)
        const update = asRecord(asRecord(row?.params)?.update) ?? asRecord(row?.update)
        if (update?.sessionUpdate !== 'hook_execution' || update.event_name !== 'user_prompt_submit') continue
        const runs = Array.isArray(update.runs) ? update.runs : []
        if (runs.some(run => ['blocked', 'denied', 'rejected'].includes(String(asRecord(asRecord(run)?.status)?.status ?? '')))) return true
    }
    return false
}
/**
 * Exactly one match confirms the submission. Everything else stays unknown with a reason (§4.5), and
 * an invalidated cursor is unknown even at one match: that count cannot prove the row came after
 * this submission rather than before it (C3/D24).
 */
export function classifyCount(result: CountResult, filesSeen: number): RecordUnavailable | null {
    if (result.cursorInvalidated) return 'ambiguous'
    if (result.matchCount === 1) return null
    if (result.matchCount > 1) return 'ambiguous'
    if (result.hookBlocked) return 'hook_blocked'
    return filesSeen === 0 ? 'not_found' : 'ambiguous'
}

/**
 * §4.4: `resolvedModel`/`resolvedAdvisor` are filled only from what the provider itself recorded.
 * claude writes the model on its assistant rows and the advisor on its own row; codex writes both
 * in `turn_context`. grok records neither in `updates.jsonl`, and corral does not go looking in a
 * second file for it, so grok stays `null` — an unconfirmed value is not a resolution.
 */
export interface ResolvedIdentity { model: string | null; advisor: string | null; effort: string | null }
export function resolvedIdentity(kind: AgentKind, files: string[], read?: (file: string) => string | null): ResolvedIdentity {
    const load = read ?? ((file: string) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } })
    const found: ResolvedIdentity = { model: null, advisor: null, effort: null }
    if (kind === 'grok') return found
    for (const file of files) {
        const text = load(file)
        if (text === null) continue
        for (const line of text.split('\n')) {
            if (!line.trim()) continue
            let parsed: unknown
            try { parsed = JSON.parse(line) } catch { continue }
            const row = asRecord(parsed)
            if (!row) continue
            if (kind === 'claude') {
                const message = asRecord(row.message)
                if (typeof message?.model === 'string') found.model = message.model
                if (typeof row.advisorModel === 'string') found.advisor = row.advisorModel
                if (typeof row.effort === 'string') found.effort = row.effort
                continue
            }
            // codex writes one `turn_context` row per turn, carrying the model and effort it resolved.
            const context = row.type === 'turn_context' || asRecord(row.payload)?.type === 'turn_context'
                ? asRecord(row.payload) : asRecord(row.turn_context)
            if (typeof context?.model === 'string') found.model = context.model
            if (typeof context?.effort === 'string') found.effort = context.effort
        }
    }
    return found
}

// --- §4.7 per-terminal agent record -------------------------------------------------------------

export interface LastSubmission { sha256: string; bytes: number; submittedAt: string; cursor: CursorEntry[]; requestId: string | null }
export interface AgentRecord {
    epoch: string
    ptyGeneration: string
    kind: AgentKind
    name: string
    argv: string[]
    requestedModel: string | null
    requestedEffort: string | null
    requestedAdvisor: string | null
    sessionId: string | null
    sessionIdSource: 'client-minted' | 'herdr-hook' | 'record-scan' | null
    t0: number
    launchDeadline: number
    phase: AgentPhase
    workingObserved: boolean
    lastSubmission: LastSubmission | null
    updatedAt: number
}
export const AGENT_RECORD_TTL = 24 * 60 * 60 * 1000
/**
 * herdr's AgentInfo has no argv, no T0 and no prompt history, and LIFE-393 receipts are per request.
 * `show`/`wait`/`prompt` restore that from here. The key is (profile, backend epoch, PTY generation):
 * a record whose epoch or generation differs describes a terminal that no longer exists, so it reads
 * as absent and `show` reports nulls rather than guessing (§4.4 D4).
 */
export class AgentStore {
    private readonly directory: string
    constructor(userData: string) { this.directory = path.join(userData, 'runtime/terminal-agents') }
    private file(terminalId: string): string { return path.join(this.directory, terminalId.replace(/[^A-Za-z0-9._-]/g, '_') + '.json') }
    read(terminalId: string, epoch: string, ptyGeneration: string, now = Date.now()): AgentRecord | null {
        const record = readFile<AgentRecord | null>(this.file(terminalId), () => null)
        if (!record || record.epoch !== epoch || record.ptyGeneration !== ptyGeneration) return null
        return now - record.updatedAt > AGENT_RECORD_TTL ? null : record
    }
    write(terminalId: string, record: AgentRecord): AgentRecord {
        privateDirectory(this.directory)
        const stored = { ...record, updatedAt: Date.now() }
        atomicWrite(this.file(terminalId), stored)
        return stored
    }
    update(terminalId: string, epoch: string, ptyGeneration: string, patch: Partial<AgentRecord>): AgentRecord | null {
        const current = this.read(terminalId, epoch, ptyGeneration)
        return current ? this.write(terminalId, { ...current, ...patch }) : null
    }
    remove(terminalId: string): void { fs.rmSync(this.file(terminalId), { force: true }) }
    /** Receipts keep 24 hours; so does this. Sweeping on read keeps the directory bounded. */
    sweep(now = Date.now()): number {
        let names: string[]
        try { names = fs.readdirSync(this.directory) } catch { return 0 }
        let removed = 0
        for (const name of names) {
            const file = path.join(this.directory, name)
            const record = readFile<AgentRecord | null>(file, () => null)
            if (!record || now - record.updatedAt > AGENT_RECORD_TTL) { fs.rmSync(file, { force: true }); removed++ }
        }
        return removed
    }
}

// --- record locations ---------------------------------------------------------------------------

export interface RecordLocationInput { cwd: string; sessionId: string | null; t0Ms: number; nowMs: number; home?: string }
/** Where each provider writes the session record corral reads back. corral only ever reads these. */
export function sessionRecordPaths(kind: AgentKind, options: RecordLocationInput): string[] {
    const home = options.home ?? os.homedir()
    if (kind === 'claude') {
        if (!options.sessionId) return []
        const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')
        return [path.join(configDir, 'projects', realpath(options.cwd).replace(/[^A-Za-z0-9]/g, '-'), options.sessionId + '.jsonl')]
    }
    if (kind === 'grok') {
        if (!options.sessionId) return []
        const grokHome = process.env.GROK_HOME ?? path.join(home, '.grok')
        return [path.join(grokHome, 'sessions', encodeURIComponent(realpath(options.cwd)), options.sessionId, 'updates.jsonl')]
    }
    return codexRolloutFiles(options.t0Ms, options.nowMs, codexHome(home))
}

// --- §8.2 provider session markers --------------------------------------------------------------

/**
 * A corral CLI launched from inside an agent inherits that agent's session markers, and a child
 * provider then treats itself as a nested session and stops writing a record (§8.2, findings E11).
 * The removal is an allowlist, not a pattern: CODEX_HOME, GROK_HOME and CLAUDE_CONFIG_DIR must
 * survive or the child writes somewhere corral is not looking.
 */
export const SESSION_MARKER_NAMES = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'] as const
export const SESSION_MARKER_PREFIXES = ['CLAUDE_CODE_', 'ORCA_AGENT_HOOK_'] as const
export function strippedSessionMarkers(environment: Record<string, string | undefined>): string[] {
    return Object.keys(environment)
        .filter(name => SESSION_MARKER_NAMES.some(marker => marker === name) || SESSION_MARKER_PREFIXES.some(prefix => name.startsWith(prefix)))
        .sort()
}
export function withoutSessionMarkers(environment: Record<string, string | undefined>): Record<string, string | undefined> {
    const copy = { ...environment }
    for (const name of strippedSessionMarkers(environment)) delete copy[name]
    return copy
}
