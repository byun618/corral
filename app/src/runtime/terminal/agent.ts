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

export type AgentKind = 'claude' | 'codex' | 'grok'
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'grok']
export const isAgentKind = (value: unknown): value is AgentKind => AGENT_KINDS.some(kind => kind === value)

export type AgentPhase = 'launching' | 'blocked' | 'ready' | 'accepted' | 'responded' | 'exited'
/** herdr's startup deadline (src/terminal/state.rs); a human may sit on a trust screen for minutes. */
export const AGENT_START_TIMEOUT_MS = 300000
export const READY_SAMPLES = 2
export const READY_SAMPLE_INTERVAL_MS = 750
export const SCREEN_EXCERPT_BYTES = 4096

// --- §3 ready gate ------------------------------------------------------------------------------

export interface ReadySample { status: string; launchPending: boolean; interactiveReady: boolean; stateChangeSeq: number }
/**
 * One observation that is quiet: bound to this pane, not still launching, and in a state that can
 * take a prompt. `idle` and `done` are one detect state, not two (R11) — herdr splits
 * `AgentState::Idle` by whether a human has *seen* the completion (`api_helpers.rs` 96~106:
 * `(Idle, false) => Done`), and on a completion transition `seen` is set to
 * `is_active_tab && outer_terminal_focus != Some(false)` (`actions.rs` 57~62·1945~1975). So a pane
 * that is **not the active tab, or whose window focus is explicitly false**, reports `done` at the
 * end of every turn it finishes — being headless is not by itself the condition (R15: an unknown
 * focus, `None`, still counts as seen on the active tab, which herdr's own test pins down at
 * `actions.rs` 3748~3751, and corral's live panes show both — active tab `idle`, background tab
 * `done`). Refusing `done` would let corral submit exactly once per such pane.
 * `seen` is GUI attention information and says nothing about whether a prompt can be taken; startup
 * is fenced off by `launch_pending` instead, which no Idle can pass while a managed launch is in
 * flight (`actions.rs` 1873~1875 `suppress_completion`). One predicate, so `agent-ready` and
 * `agent-idle` ask the same question — §3 keeps them apart by *when* they ask and about what.
 */
export const agentQuiescent = (sample: ReadySample): boolean =>
    sample.interactiveReady && !sample.launchPending && (sample.status === 'idle' || sample.status === 'done')
/**
 * §3: ready is N consecutive quiet observations 750 ms apart whose `state_change_seq` never moved.
 * The unchanged seq is the real proof — it says herdr recorded no transition between the samples —
 * so N stays 2 rather than approximating "no transition in flight" with more samples.
 */
export function readySatisfied(samples: ReadySample[]): boolean {
    const first = samples[0]
    if (samples.length !== READY_SAMPLES || first === undefined) return false
    return samples.every(sample => agentQuiescent(sample) && sample.stateChangeSeq === first.stateChangeSeq)
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
/**
 * The one line that is *typed* into a worker's pane, immediately before the preamble is pasted into
 * it. Without it the provider receives a message made entirely of pasted text and refuses to act on
 * it — correctly, since nothing in such a message was written by the person at the keyboard. It
 * ends without a newline: the Enter that submits belongs to the prompt, so a Dispatch is still one
 * submission and one `promptRequestId`. It lives here rather than beside the submission because the
 * unwrapper below is what has to recognise it.
 */
export const PROMPT_LEAD = 'The block pasted below is this session\'s task, delivered by corral. Follow it:'
const PASTED_OPEN = '<pasted_content id='
const PASTED = /^(?<before>[\s\S]*?)<pasted_content id="(?<id>[^"]*)">\n(?<body>[\s\S]*)\n<\/pasted_content id="\k<id>">\s*$/
/**
 * The provider's own encoding of a pasted body. A body big enough to arrive as a paste is not
 * recorded verbatim: claude stores it wrapped, with a per-paste id, under whatever was typed
 * alongside it —
 *
 *     <typed lead>\n\n<pasted_content id="975e">\n<body>\n</pasted_content id="975e">\n
 *
 * so a byte-exact comparison against the body can never match, and "the record contains this body
 * once" becomes unmeasurable for every body over the paste threshold. Unwrapping is not a loosening
 * of that rule: it reads the provider's encoding of the same bytes.
 *
 * What it will not read is anything else in the same message. The wrapper is accepted only when the
 * message is exactly what corral submits — the one typed lead, then one pasted block — because both
 * of the looser readings let a different message pass for this one: text before the block is a
 * person's own words wrapped around a quoted body, and a second block means two bodies arrived
 * where corral sent one. The count is of opening tags across the whole message, not of the body
 * alone: a first block that differs is still a block, and the old check never looked at it.
 */
export function unwrapPasted(text: string): string | null {
    if (text.split(PASTED_OPEN).length !== 2) return null
    const groups = PASTED.exec(text)?.groups
    if (groups === undefined || groups.body === undefined) return null
    if (normalizeBody(groups.before ?? '') !== PROMPT_LEAD) return null
    return groups.body
}
export function sameBody(identity: BodyIdentity, text: string): boolean {
    const other = bodyIdentity(text)
    if (other.bytes === identity.bytes && other.sha256 === identity.sha256) return true
    const inner = unwrapPasted(normalizeBody(text))
    if (inner === null) return false
    const unwrapped = bodyIdentity(inner)
    return unwrapped.bytes === identity.bytes && unwrapped.sha256 === identity.sha256
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

/**
 * Where one candidate record file ended *before* the submit RPC (§4.6; persisted per C3).
 *
 * `prefixSha256` digests exactly those `bytes`, so a file that is merely longer is not assumed to be
 * the same file continued (R2): a provider that rewrites the record in place can push an *older* row
 * past the old line cursor, and then a plain length comparison counts it as this submission's.
 * The field is optional because records written before this round carry no digest; those fall back
 * to the length rule they were captured under rather than being called invalid.
 */
export interface CursorEntry { path: string; existed: boolean; bytes: number; lines: number; prefixSha256?: string }
export function captureCursor(paths: string[], read?: (file: string) => string | null): CursorEntry[] {
    const load = read ?? ((file: string) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } })
    return paths.map(file => {
        const text = load(file)
        if (text === null) return { path: file, existed: false, bytes: 0, lines: 0 }
        const bytes = Buffer.byteLength(text)
        return { path: file, existed: true, bytes, lines: text.length ? text.split('\n').length - 1 : 0, prefixSha256: prefixDigest(text, bytes) }
    })
}
/** sha256 of the file's first `bytes` bytes — the identity a later read has to still start with. */
const prefixDigest = (text: string, bytes: number): string =>
    createHash('sha256').update(Buffer.from(text, 'utf8').subarray(0, bytes)).digest('hex')
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
/**
 * §4.6 (G6): grok writes the submitted body as `user_message_chunk` rows. A 466-byte, 6-line body
 * came back as exactly one chunk, but a larger body may arrive split, and half a body is neither
 * this body nor a different one — so a run of consecutive chunks is one user row. The merged row
 * keeps the *first* chunk's line index and timestamp: a turn that began before the cursor or before
 * the submit second stays outside the window instead of being dragged in by its later chunks.
 *
 * Only a run of *consecutive* chunk rows is joined (G11). If grok ever interleaves another row
 * between two chunks of one body, the halves stay separate, neither half matches the identity, and
 * the submission reports `matchCount: 0` → `outcome_unknown` — the fail-closed answer, not a wrong
 * one. Skipping rows to bridge such a gap is not implemented because no split has ever been
 * observed (§9 미확인 13), so there is no evidence of which rows may appear in between; guessing
 * the shape of an unobserved record is the same mistake the Claude path refuses to make for G7.
 */
function mergeUserChunks(rows: Row[]): Row[] {
    const merged: Row[] = []
    for (const row of rows) {
        const previous = merged[merged.length - 1]
        if (row.role === 'user' && row.text !== null && previous !== undefined && previous.role === 'user' && previous.text !== null) {
            merged[merged.length - 1] = { ...previous, text: previous.text + row.text }
            continue
        }
        merged.push(row)
    }
    return merged
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
    return kind === 'grok' ? mergeUserChunks(rows) : rows
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
            // Shorter than its cursor, or no longer starting with what the cursor saw: the file was
            // rotated or rewritten, so the line cursor means nothing here (R2/C3). Scan it whole and
            // flag it — the caller keeps the outcome unknown even at one match.
            const continued = Buffer.byteLength(text) >= prior.bytes
                && (prior.prefixSha256 === undefined || prefixDigest(text, prior.bytes) === prior.prefixSha256)
            if (!continued) result.cursorInvalidated = true
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
        // G7: the documented rule is "working directory path with non-alphanumeric characters
        // replaced by `-`", and *"for a working directory whose converted name exceeds 200
        // characters, Claude Code truncates the name to 200 characters and appends a hash of the
        // full path"* (code.claude.com/docs/en/sessions, "Where transcripts are stored"). The hash
        // function, its length and its separator are not documented anywhere, so corral does not
        // guess one: past 200 converted characters this path is simply wrong and the submission
        // reports `not_found` rather than a confirmation. The SDK page offers a workaround — list
        // `projects/` and *"match the first 200 characters of the converted name"* — which is a
        // directory scan, not this function's shape; it is the next round's to take if it matters.
        // `CLAUDE_CODE_PROJECT_DIR_NAME` (with `CLAUDE_CONFIG_DIR`) replaces the derived name
        // outright and has the same effect here. Both limits are in the README and 미확인 list.
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
export const SESSION_MARKER_NAMES: readonly string[] = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT']
export const SESSION_MARKER_PREFIXES: readonly string[] = ['CLAUDE_CODE_', 'ORCA_AGENT_HOOK_']
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
