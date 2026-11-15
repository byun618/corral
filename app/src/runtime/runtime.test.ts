import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { workspaceModule } from './workspace/index.js'
import { startRuntime } from './server.js'
import { localCall, request, MAX_REQUEST } from './transport.js'
import { CommandRegistry, foundationSpecs, validateFoundation } from './registry.js'
import { AGENT_KINDS, AGENT_START_TIMEOUT_MS, AgentStore, EXPECTED_MANIFESTS, SESSION_MARKER_NAMES, SESSION_MARKER_PREFIXES, PROMPT_LEAD, agentName, bodyIdentity, captureCursor, sameBody, unwrapPasted, classifyCount, codexCandidates, codexSessionDates, countSubmissions, evaluateManifest, mintsSessionId, normalizeBody, providerArgv, readySatisfied, sessionRecordPaths, strippedSessionMarkers, withoutSessionMarkers, type AgentKind, type AgentPhase, type ReadySample } from './terminal/agent.js'
import { terminalModule } from './terminal/index.js'
import { Tokens } from './terminal/tokens.js'
import { TerminalBackend, type AgentManifestObservation, type AgentObservation, type TerminalIdentity } from '../main/adapter/index.js'
import { isRecord } from '../shared/json.js'
import { clearContinuedMemo } from '../main/transcript-continued.js'
import { submissionVerdict } from './orchestration/worker.js'
import { RuntimeError, type CommandContext } from './contracts.js'
const cleanups: (() => Promise<void> | void)[] = []
const previous = { ...process.env }
afterEach(async () => { for (const fn of cleanups.reverse()) await fn(); cleanups.length = 0; process.env = { ...previous } })
function fixture() {
  delete process.env.CORRAL_RUNTIME_SOCKET; delete process.env.CORRAL_BACKEND_SOCKET; delete process.env.CORRAL_SESSION
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const invocation = (command = 'status') => ({ command, flags: {}, args: [], cwd: '/tmp' })
describe('first release boundary and ownership', () => {
  it('has five foundation plus nineteen workspace commands and rejects future commands and unsupported options', () => {
    const registry = new CommandRegistry()
    registry.register({ specs: foundationSpecs, validate: validateFoundation, execute: async () => null })
    expect(registry.schema().commands.map(s => s.command)).toEqual(['open','serve','status','agent-context','diagnostics memory'])
    registry.register(workspaceModule('/tmp/metadata-only'))
    expect(registry.schema().commandCount).toBe(24)
    expect(registry.parse(['repo', 'add', '--path', '/tmp/repo'], '/tmp').command).toBe('repo add')
    for (const args of [['terminal','list'],['environment','list'],['repo','add'],['status','--host','local'],['serve','--port','0'],['status','--timeout-ms','0'],['status','--json','--json'],['status','unexpected']]) expect(() => registry.parse(args, '/tmp')).toThrow()
  })
  it('preserves runtime identity across restart, rejects another identity and a live owner', async () => {
    const dir = fixture(), socket = path.join(dir, 'runtime/rpc.sock')
    const first = await startRuntime({ userData: dir })
    cleanups.push(first.close)
    const prior = await localCall(socket, request(invocation()))
    expect(prior.ok).toBe(true)
    await expect(startRuntime({ userData: dir })).rejects.toMatchObject({ code: 'runtime_busy' })
    expect((await localCall(socket, request(invocation(), 'wrong'))).error?.code).toBe('identity_mismatch')
    expect((await localCall(socket, request(invocation('terminal list')))).ok).toBe(false)
    await first.close()
    const second = await startRuntime({ userData: dir }); cleanups.push(second.close)
    expect(second.runtimeId).toBe(first.runtimeId)
    expect(second.status().runtime.instanceId).not.toBe(first.status().runtime.instanceId)
  })
  it('rejects unsafe target sockets, bounds requests and leaves unrelated endpoints intact', async () => {
    const dir = fixture(), socket = path.join(dir, 'foreign.sock')
    const server = net.createServer(s => s.end())
    await new Promise<void>(resolve => server.listen(socket, resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    fs.chmodSync(socket, 0o666)
    await expect(localCall(socket, request(invocation()))).rejects.toMatchObject({ code: 'unsafe_permissions' })
    fs.chmodSync(socket, 0o600)
    const inode = fs.statSync(socket).ino
    process.env.CORRAL_RUNTIME_SOCKET = socket
    await expect(startRuntime({ userData: dir })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(fs.statSync(socket).ino).toBe(inode)
    await expect(localCall(socket, request({ ...invocation(), cwd: 'x'.repeat(MAX_REQUEST) }))).rejects.toMatchObject({ code: 'invalid_argument' })
  })
  it('times out lost responses and cancels connected requests without retry', async () => {
    const dir = fixture(), socket = path.join(dir, 'mock.sock'), clients = new Set<net.Socket>()
    let writes = 0
    const server = net.createServer(s => { clients.add(s); s.on('data', () => writes++); s.on('close', () => clients.delete(s)) })
    await new Promise<void>(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600)
    cleanups.push(() => { for (const s of clients) s.destroy(); return new Promise<void>(resolve => server.close(() => resolve())) })
    await expect(localCall(socket, request(invocation()), 30)).rejects.toMatchObject({ code: 'outcome_unknown' })
    const abort = new AbortController(), result = localCall(socket, request(invocation()), 500, abort.signal)
    setTimeout(() => abort.abort(), 30)
    await expect(result).rejects.toMatchObject({ code: 'request_cancelled' })
    expect(writes).toBe(2)
  })
  it('rejects foreign and missing open profiles before handoff, including matching runtime IDs', async () => {
    const dir = fixture(), foreign = fixture(), socket = path.join(dir, 'runtime/rpc.sock')
    let handoffs = 0
    const runtime = await startRuntime({ userData: dir, requestDesktop: () => handoffs++ }); cleanups.push(runtime.close)
    for (const expectedRuntimeId of [undefined, runtime.runtimeId]) {
      for (const expectedUserData of [undefined, foreign]) {
        const response = await localCall(socket, { ...request(invocation('open'), expectedRuntimeId), expectedUserData })
        expect(response).toMatchObject({ ok: false, error: { code: 'profile_mismatch' }, _meta: { outcome: 'not_started' } })
      }
    }
    expect(handoffs).toBe(0)
    const response = await localCall(socket, { ...request(invocation('open'), runtime.runtimeId), expectedUserData: dir })
    expect(response.ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(handoffs).toBe(1)
  })
  it('focuses a hidden desktop before waiting for availability and reports uncertain effects on deadline', async () => {
    const dir = fixture(), socket = path.join(dir, 'runtime/rpc.sock')
    let visible = false, focuses = 0, allowShow = true
    const runtime = await startRuntime({ userData: dir, ui: () => visible, focus: () => { focuses++; visible = allowShow } }); cleanups.push(runtime.close)
    const call = (timeoutMs: number) => localCall(socket, { ...request(invocation('open'), runtime.runtimeId, timeoutMs), expectedUserData: dir }, 1000)
    expect((await call(500)).ok).toBe(true)
    expect(visible).toBe(true)
    visible = false; allowShow = false
    expect(await call(30)).toMatchObject({ ok: false, _meta: { outcome: 'unknown' } })
    expect(focuses).toBeGreaterThan(1)
  })

})

// --- LIFE-394 §3/§4.5/§4.6 pure-function fixtures -----------------------------------------------
const DAY = 86400000
const pad2 = (value: number) => String(value).padStart(2, '0')
const localDay = (ms: number) => { const at = new Date(ms); return `${at.getFullYear()}/${pad2(at.getMonth() + 1)}/${pad2(at.getDate())}` }
const utcDay = (ms: number) => { const at = new Date(ms); return `${at.getUTCFullYear()}/${pad2(at.getUTCMonth() + 1)}/${pad2(at.getUTCDate())}` }
const sample = (over: Partial<ReadySample> = {}): ReadySample => ({ status: 'idle', launchPending: false, interactiveReady: true, stateChangeSeq: 7, ...over })
const claudeUser = (body: string, at: string) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: body }, timestamp: at })
const claudeAssistant = (at: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: at })
const claudeToolResult = (body: string, at: string) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'tool_result', content: body }] }, timestamp: at })
const grokUser = (body: string, seconds: number) => JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: { text: body } } }, timestamp: seconds })
const grokHook = (status: string) => JSON.stringify({ params: { update: { sessionUpdate: 'hook_execution', event_name: 'user_prompt_submit', runs: [{ status: { status } }] } } })
const codexMeta = (id: string, cwd: string, at: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: at } })
const codexUser = (body: string, at: string) => JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] } })
const reader = (files: Record<string, string>) => (file: string) => files[file] ?? null

describe('LIFE-394 body identity, ready gate and submission window', () => {
  const BODY = 'first line\n  두 번째 줄  🙂\nthird line'

  it('trims only the four ASCII spaces and keeps NBSP, BOM, Korean and emoji as content', () => {
    // C4/D25: the design-fix 3 harness stripped \s plus BOM and NBSP, and so called two different
    // bodies the same. Product and harness share this one function now; these are its boundaries.
    expect(normalizeBody(` \t\r\n${BODY}\n\r\t `)).toBe(BODY)
    expect(normalizeBody(BODY)).toBe(BODY)
    for (const wrapper of [' ', '﻿', ' ', '　']) {
      expect(normalizeBody(wrapper + BODY + wrapper)).toBe(wrapper + BODY + wrapper)
      expect(bodyIdentity(wrapper + BODY + wrapper).sha256).not.toBe(bodyIdentity(BODY).sha256)
    }
    expect(normalizeBody('a\r\n\r\nb')).toBe('a\r\n\r\nb')
    expect(normalizeBody('a  \t  b')).toBe('a  \t  b')
    expect(bodyIdentity(BODY)).toEqual({ bytes: Buffer.byteLength(BODY), lines: 3, sha256: bodyIdentity(` ${BODY} `).sha256 })
    expect(normalizeBody('   \t\r\n ')).toBe('')
  })

  it('issues ready only for two quiet samples that share one state_change_seq (F6)', () => {
    expect(readySatisfied([sample(), sample()])).toBe(true)
    // A recorded transition between the samples is exactly what N=2 is there to exclude.
    expect(readySatisfied([sample(), sample({ stateChangeSeq: 8 })])).toBe(false)
    expect(readySatisfied([sample({ status: 'working' }), sample()])).toBe(false)
    expect(readySatisfied([sample(), sample({ launchPending: true })])).toBe(false)
    expect(readySatisfied([sample({ interactiveReady: false }), sample({ interactiveReady: false })])).toBe(false)
    expect(readySatisfied([sample()])).toBe(false)
    expect(readySatisfied([])).toBe(false)
    // r0 asserted `done` here only for agent-idle. That was wrong about herdr (R11): `done` is not a
    // state of its own, it is `AgentState::Idle` that no focused active tab has *seen*
    // (`api_helpers.rs` 96~106), and "nobody looked at it" is not "cannot take a prompt". Both waits
    // now run one predicate, so a finished turn on a background pane is quiet for either of them.
    expect(readySatisfied([sample({ status: 'done' }), sample({ status: 'done' })])).toBe(true)
    // Still not quiet, whoever is looking: a moving seq, a launch in flight, an unbound pane.
    expect(readySatisfied([sample({ status: 'done' }), sample({ status: 'done', stateChangeSeq: 9 })])).toBe(false)
    expect(readySatisfied([sample({ status: 'done', launchPending: true }), sample({ status: 'done' })])).toBe(false)
    expect(readySatisfied([sample({ status: 'unknown' }), sample({ status: 'unknown' })])).toBe(false)
  })

  it('counts the body inside the submission window, not by scanning the whole file (F7 1-3)', () => {
    const identity = bodyIdentity(BODY), file = '/records/claude.jsonl'
    const earlier = claudeUser(BODY, '2026-09-21T05:55:00.100Z'), later = claudeUser(BODY, '2026-09-21T05:55:00.900Z')
    const submittedAtMs = Date.parse('2026-09-21T05:55:00.500Z')
    // 1: the same second already holds the previous submission of the same body. The cursor, not the
    //    clock, separates them, and a time-only filter counts two.
    const both = earlier + '\n' + later + '\n', cursor = captureCursor([file], reader({ [file]: earlier + '\n' }))
    expect(cursor).toEqual([{ path: file, existed: true, bytes: Buffer.byteLength(earlier + '\n'), lines: 1, prefixSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }])
    expect(countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs, cursor, read: reader({ [file]: both }) }).matchCount).toBe(1)
    expect(countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs, cursor: [], read: reader({ [file]: both }) }).matchCount).toBe(2)
    // 2: the provider restarted after the submit and wrote a second file the cursor never saw.
    const rotated = '/records/claude-2.jsonl'
    const before = claudeUser(BODY, '2026-09-21T05:54:50.000Z') + '\n'
    const after = countSubmissions({ kind: 'claude', files: [file, rotated], identity, submittedAtMs,
      cursor: captureCursor([file], reader({ [file]: before })), read: reader({ [file]: before, [rotated]: later + '\n' }) })
    expect(after.matchCount).toBe(1)
    // 3: the record file did not exist at submit time. Absent is `not_found`, not a failed match.
    const missing = captureCursor([file], reader({}))
    expect(missing).toEqual([{ path: file, existed: false, bytes: 0, lines: 0 }])
    const none = countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs, cursor: missing, read: reader({}) })
    expect([none.matchCount, classifyCount(none, none.scanned.length)]).toEqual([0, 'not_found'])
    const appeared = countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs, cursor: missing, read: reader({ [file]: later + '\n' }) })
    expect([appeared.matchCount, classifyCount(appeared, appeared.scanned.length)]).toEqual([1, null])
  })

  it('keeps a truncated or replaced record ambiguous even at one match (F7 4-5, F8 d)', () => {
    const identity = bodyIdentity(BODY), file = '/records/rollout.jsonl'
    const submittedAtMs = Date.parse('2026-09-21T05:55:00.500Z')
    const long = codexMeta('11111111-2222-3333-4444-555555555555', '/tmp/repo', '2026-09-21T05:54:00.000Z') + '\n'
      + codexUser(BODY, '2026-09-21T05:55:00.900Z') + '\n' + codexUser('filler '.repeat(60), '2026-09-21T05:55:01.000Z') + '\n'
    const cursor = captureCursor([file], reader({ [file]: long }))
    // 4: the file is now shorter than its cursor, so the match cannot be placed after the submit.
    const truncated = codexUser(BODY, '2026-09-21T05:55:00.900Z') + '\n'
    const cut = countSubmissions({ kind: 'codex', files: [file], identity, submittedAtMs, cursor, read: reader({ [file]: truncated }) })
    expect(cut.cursorInvalidated).toBe(true)
    expect(cut.matchCount).toBe(1)
    expect(classifyCount(cut, cut.scanned.length)).toBe('ambiguous')
    // 5: same path, different session file. Same verdict, and no automatic re-submission follows.
    const replaced = codexMeta('99999999-8888-7777-6666-555555555555', '/tmp/repo', '2026-09-21T05:55:02.000Z') + '\n' + codexUser(BODY, '2026-09-21T05:55:03.000Z') + '\n'
    const swapped = countSubmissions({ kind: 'codex', files: [file], identity, submittedAtMs, cursor, read: reader({ [file]: replaced }) })
    expect(swapped.cursorInvalidated).toBe(true)
    expect(classifyCount(swapped, swapped.scanned.length)).toBe('ambiguous')
  })

  it('reads each provider record with its own filter and finds the assistant after the match', () => {
    const identity = bodyIdentity(BODY), submittedAtMs = Date.parse('2026-09-21T05:55:00.000Z')
    const claude = '/r/c.jsonl', grok = '/r/updates.jsonl', codex = '/r/rollout.jsonl'
    // A tool result repeats the body with an array content, and the assistant echo is not a user row.
    const claudeText = claudeUser(BODY, '2026-09-21T05:55:01.000Z') + '\n' + claudeToolResult(BODY, '2026-09-21T05:55:02.000Z') + '\n' + claudeAssistant('2026-09-21T05:55:03.000Z') + '\n'
    const one = countSubmissions({ kind: 'claude', files: [claude], identity, submittedAtMs, cursor: [], read: reader({ [claude]: claudeText }) })
    expect([one.matchCount, one.assistantAfter]).toEqual([1, true])
    const second = Math.floor(submittedAtMs / 1000)
    const grokText = grokUser(BODY, second + 1) + '\n'
      + JSON.stringify({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } } }, timestamp: second + 2 }) + '\n'
    const grokCount = countSubmissions({ kind: 'grok', files: [grok], identity, submittedAtMs, cursor: [], read: reader({ [grok]: grokText }) })
    expect([grokCount.matchCount, grokCount.assistantAfter, grokCount.hookBlocked]).toEqual([1, true, false])
    // A failing user_prompt_submit hook run is not proof the prompt was blocked (review 미확인 7).
    expect(countSubmissions({ kind: 'grok', files: [grok], identity, submittedAtMs, cursor: [], read: reader({ [grok]: grokText + grokHook('failed') + '\n' }) }).hookBlocked).toBe(false)
    expect(countSubmissions({ kind: 'grok', files: [grok], identity, submittedAtMs, cursor: [], read: reader({ [grok]: grokText + grokHook('blocked') + '\n' }) }).hookBlocked).toBe(true)
    const codexText = codexMeta('11111111-2222-3333-4444-555555555555', '/tmp/repo', '2026-09-21T05:54:00.000Z') + '\n'
      + JSON.stringify({ type: 'event_msg', timestamp: '2026-09-21T05:55:01.000Z', payload: { type: 'user_message', message: BODY } }) + '\n'
      + codexUser(BODY, '2026-09-21T05:55:01.500Z') + '\n'
    expect(countSubmissions({ kind: 'codex', files: [codex], identity, submittedAtMs, cursor: [], read: reader({ [codex]: codexText }) }).matchCount).toBe(1)
  })

  it('never narrows two codex candidates by guessing and recomputes the date set from now (F7 7-10)', () => {
    const t0 = Date.parse('2026-09-21T05:54:00.000Z'), cwd = '/tmp/l394-fixture-repo'
    const head = (id: string, at: string, where = cwd) => codexMeta(id, where, at) + '\n' + codexUser(BODY, at) + '\n'
    const a = '/s/a.jsonl', b = '/s/b.jsonl', elsewhere = '/s/c.jsonl'
    const files = { [a]: head('aaaaaaaa-1111-2222-3333-444444444444', '2026-09-21T05:54:30.000Z'),
      [b]: head('bbbbbbbb-1111-2222-3333-444444444444', '2026-09-21T05:54:40.000Z'),
      [elsewhere]: head('cccccccc-1111-2222-3333-444444444444', '2026-09-21T05:54:30.000Z', '/tmp/other-repo') }
    // 7: none in this cwd, and two in this cwd. Both leave ownership unproven.
    expect(codexCandidates([elsewhere], cwd, t0, reader(files))).toEqual([])
    expect(codexCandidates([a, b], cwd, t0, reader(files)).map(row => row.sessionId)).toEqual(['aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444'])
    // 8: two sessions carrying the same body. The count itself is ambiguous, so it never confirms.
    const collision = countSubmissions({ kind: 'codex', files: [a, b], identity: bodyIdentity(BODY), submittedAtMs: t0, cursor: [], read: reader(files) })
    expect(collision.matchCount).toBe(2)
    expect(classifyCount(collision, collision.scanned.length)).toBe('ambiguous')
    // 9: the file name's timezone is not contracted, so both calendars are walked for every step.
    const dates = codexSessionDates(t0, t0)
    expect(dates).toContain(localDay(t0))
    expect(dates).toContain(utcDay(t0))
    // 10: a human sits on the trust screen for two days. The set follows `now`, not T0.
    const late = codexSessionDates(t0, t0 + 2 * DAY)
    for (const step of [0, 1, 2, 3]) { expect(late).toContain(localDay(t0 + step * DAY)); expect(late).toContain(utcDay(t0 + step * DAY)) }
    expect(codexSessionDates(t0, t0)).not.toContain(localDay(t0 + 2 * DAY))
  })

  it('joins a grok body that arrived as consecutive chunks and never joins across a turn (G6)', () => {
    const file = '/r/updates.jsonl', submittedAtMs = Date.parse('2026-09-21T05:55:00.000Z')
    const second = Math.floor(submittedAtMs / 1000)
    const chunk = (body: string, at: number) => grokUser(body, at) + '\n'
    const agent = (at: number) => JSON.stringify({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } } }, timestamp: at }) + '\n'
    // One submission, split across three chunk rows. Each row alone is neither this body nor another.
    const split = chunk('first line\n', second + 1) + chunk('second line\n', second + 1) + chunk('third line', second + 1) + agent(second + 2)
    const whole = countSubmissions({ kind: 'grok', files: [file], identity: bodyIdentity('first line\nsecond line\nthird line'), submittedAtMs, cursor: [], read: reader({ [file]: split }) })
    expect([whole.matchCount, whole.assistantAfter]).toEqual([1, true])
    // A single chunk of it is not the body, so a partial match cannot confirm anything.
    expect(countSubmissions({ kind: 'grok', files: [file], identity: bodyIdentity('first line'), submittedAtMs, cursor: [], read: reader({ [file]: split }) }).matchCount).toBe(0)
    // Two turns of the same body stay two rows: the assistant row between them ends the run.
    const twice = chunk('repeat me', second + 1) + agent(second + 2) + chunk('repeat me', second + 3)
    const both = countSubmissions({ kind: 'grok', files: [file], identity: bodyIdentity('repeat me'), submittedAtMs, cursor: [], read: reader({ [file]: twice }) })
    expect([both.matchCount, classifyCount(both, both.scanned.length)]).toEqual([2, 'ambiguous'])
    // The merged row is dated by its FIRST chunk, so a turn that began before the submit stays out.
    const straddling = chunk('early half ', second - 1) + chunk('late half', second + 1)
    expect(countSubmissions({ kind: 'grok', files: [file], identity: bodyIdentity('early half late half'), submittedAtMs, cursor: [], read: reader({ [file]: straddling }) }).matchCount).toBe(0)
  })

  it('refuses every manifest that is not the expected bundled one, for all three providers (F12b)', () => {
    const bundled = (agent: string, version: string) => ({ agent, source_kind: 'bundled', active_version: version, local_override_shadowing_remote: false })
    for (const kind of AGENT_KINDS) {
      const expected = EXPECTED_MANIFESTS[kind]
      expect(evaluateManifest(kind, [bundled(kind, expected.version)], null).verified).toBe(true)
      // 1: an older local override is active and shadows the remote.
      expect(evaluateManifest(kind, [{ agent: kind, source_kind: 'local_override', active_version: '2026.09.21.2', local_override_shadowing_remote: true }], null))
        .toMatchObject({ verified: false, sourceKind: 'local_override', activeVersion: '2026.09.21.2', expectedVersion: expected.version })
      // 2: a cached remote at the same or a higher version is still not the manifest corral checked.
      expect(evaluateManifest(kind, [{ agent: kind, source_kind: 'remote_cache', active_version: expected.version, local_override_shadowing_remote: false }], null).verified).toBe(false)
      expect(evaluateManifest(kind, [bundled(kind, '2027.01.01.1')], null).verified).toBe(false)
      // 3: the query itself failed. Unverified, with the reason carried rather than assumed away.
      expect(evaluateManifest(kind, null, 'socket closed')).toMatchObject({ verified: false, queryError: 'socket closed', activeVersion: null })
      expect(evaluateManifest(kind, [], null)).toMatchObject({ verified: false, queryError: `no manifest reported for ${kind}` })
    }
    // 4: C2/D23. claude runs the same code. "We did not patch it" is not a guarantee.
    expect(EXPECTED_MANIFESTS.claude.version).toBe('2026.11.03.1')
    expect(evaluateManifest('claude', [{ agent: 'claude', source_kind: 'local_override', active_version: '2026.11.03.1', local_override_shadowing_remote: false }], null).verified).toBe(false)
    // LIFE-780: a new app on a herdr server that has not restarted still reports the old bundled claude manifest.
    expect(EXPECTED_MANIFESTS.claude.priorVersions).toEqual(['2026.09.04.1'])
    expect(evaluateManifest('claude', [bundled('claude', '2026.09.04.1')], null)).toMatchObject({ verified: true, activeVersion: '2026.09.04.1', expectedVersion: '2026.11.03.1' })
    for (const version of ['2026.11.03.1', '2026.09.04.1']) {
      expect(evaluateManifest('claude', [{ agent: 'claude', source_kind: 'remote_cache', active_version: version, local_override_shadowing_remote: false }], null).verified).toBe(false)
      expect(evaluateManifest('claude', [{ agent: 'claude', source_kind: 'local_override', active_version: version, local_override_shadowing_remote: false }], null).verified).toBe(false)
      expect(evaluateManifest('claude', [{ agent: 'claude', source_kind: 'bundled', active_version: version, local_override_shadowing_remote: true }], null).verified).toBe(false)
    }
    expect(evaluateManifest('claude', [bundled('claude', '2026.10.11.1')], null).verified).toBe(false)
    // The other two keep one value: the claude allowance is not a general one.
    for (const kind of ['codex', 'grok'] as const) {
      expect(EXPECTED_MANIFESTS[kind].priorVersions).toEqual([])
      expect(evaluateManifest(kind, [bundled(kind, '2026.09.04.1')], null).verified).toBe(false)
    }
    // LIFE-626 bumped only the codex manifest; grok keeps the version LIFE-603 K1b gave both.
    expect(EXPECTED_MANIFESTS.codex.version).toBe('2026.10.28.1')
    expect(EXPECTED_MANIFESTS.grok.version).toBe('2026.10.15.2')
  })

  it('maps provider flags and session ids the way section 4.2 freezes them', () => {
    expect(providerArgv({ kind: 'claude', model: 'opus', effort: 'high', advisor: 'fable', sessionId: 'S' }))
      .toEqual(['claude', '--model', 'opus', '--effort', 'high', '--advisor', 'fable', '--session-id', 'S'])
    expect(providerArgv({ kind: 'codex', model: 'gpt', effort: 'high' })).toEqual(['codex', '-m', 'gpt', '-c', 'model_reasoning_effort=high'])
    expect(providerArgv({ kind: 'grok', model: 'grok-4', effort: 'high', sessionId: 'S' })).toEqual(['grok', '-m', 'grok-4', '--reasoning-effort', 'high', '-s', 'S'])
    expect(() => providerArgv({ kind: 'codex', advisor: 'fable' })).toThrow(/advisor/)
    // herdr rejects control characters in agent args; corral refuses them before the call.
    expect(() => providerArgv({ kind: 'claude', model: `a${String.fromCharCode(1)}b` })).toThrow(/printable/)
    expect(mintsSessionId('codex')).toBe(false)
    expect([mintsSessionId('claude'), mintsSessionId('grok')]).toEqual([true, true])
    expect(agentName('pane-1')).toMatch(/^corral-[0-9a-f]{8}$/)
    expect(agentName('pane-1')).not.toBe(agentName('pane-2'))
  })

  it('keeps the harness marker allowlist identical to the product one and preserves the home vars', async () => {
    const harness = await import('../../scripts/harness-env/env.mjs')
    expect(harness.SESSION_MARKER_NAMES).toEqual([...SESSION_MARKER_NAMES])
    expect(harness.SESSION_MARKER_PREFIXES).toEqual([...SESSION_MARKER_PREFIXES])
    const environment = { CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', ORCA_AGENT_HOOK_PORT: '9', CODEX_HOME: '/h/.codex', GROK_HOME: '/h/.grok', CLAUDE_CONFIG_DIR: '/h/.claude', PATH: '/bin' }
    expect(strippedSessionMarkers(environment)).toEqual(['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'ORCA_AGENT_HOOK_PORT'])
    expect(harness.strippedSessionMarkers(environment)).toEqual(strippedSessionMarkers(environment))
    // Dropping these would move the very account and record path under measurement (section 7.3).
    expect(Object.keys(withoutSessionMarkers(environment)).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'PATH'])
    expect(Object.keys(harness.withoutSessionMarkers(environment)).sort()).toEqual(Object.keys(withoutSessionMarkers(environment)).sort())
  })
})

// --- LIFE-394 fix round 1: the code review's reproductions, as regressions -----------------------
// Rewritten from the review's `repro.ts`/`extra.mts` rather than copied — those files are the work
// branch's raw material for the review, not source. Each case below fails on r0 (0e61a26) and is
// what the corresponding fix has to turn green: R1 foreign codex rollout, R2 same-path replacement
// that grew, R3 an unmet `--wait responded`, R4 a Working carried over from the previous turn,
// R5 a stored `ready` under an unverified manifest, R7 the guard's `error.observed`.
describe('LIFE-394 review reproductions (r0 R1-R5·R7, r1 R11·R5 잔여·R12)', () => {
  const PROMPT = 'REVIEW REGRESSION BODY'
  const claudeRow = (body: string, at = new Date().toISOString()) =>
    JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: at, message: { content: body } }) + '\n'
  const assistantRow = (at = new Date().toISOString()) =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { content: 'answered' } }) + '\n'
  const codexMetaRow = (id: string, where: string, at: string) =>
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: where, timestamp: at } }) + '\n'
  const codexUserRow = (body: string, at = new Date().toISOString()) =>
    JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] } }) + '\n'
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

  interface FixtureOptions { phase?: AgentPhase; workingObserved?: boolean; git?: boolean }
  /** One pane, one recorded agent and a backend whose every answer this test owns. */
  function agentFixture(kind: AgentKind, options: FixtureOptions = {}) {
    const dir = fixture(), data = path.join(dir, 'data'), cwd = path.join(dir, 'repo')
    fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(cwd, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude')
    process.env.CODEX_HOME = path.join(dir, 'codex')
    process.env.GROK_HOME = path.join(dir, 'grok')
    process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
    process.env.CORRAL_BACKEND_SOCKET = path.join(dir, 'never-connected.sock')
    if (options.git) {
      for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
        execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      }
    }
    const live: TerminalIdentity = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 'tab', workspaceId: 'w', path: cwd, repo: cwd, title: 'fixture' }
    const info: AgentObservation = { name: agentName('pane'), kind, status: 'idle', launchPending: false, interactiveReady: true,
      stateChangeSeq: 2, stateLabels: {}, session: null, paneId: 'pane', observedAt: new Date().toISOString() }
    const verified = AGENT_KINDS.map(agent => ({ agent, source_kind: EXPECTED_MANIFESTS[agent].sourceKind,
      active_version: EXPECTED_MANIFESTS[agent].version, local_override_shadowing_remote: false }))
    /** `observe` lets a case answer each `agent.get` differently — a moving seq, one Working frame. */
    interface FixtureState {
      info: AgentObservation
      manifests: AgentManifestObservation[]
      onPrompt: () => void
      observe: ((current: AgentObservation) => AgentObservation) | null
      /** 전경 프로세스 — 네이티브 설치처럼 이름이 kind 가 아닌 경우를 사례가 직접 정한다. */
      foreground: { pid: number; name: string; argv: string[] | null }[]
    }
    const state: FixtureState = { info, manifests: verified, onPrompt: () => {}, observe: null,
      foreground: [{ pid: 456, name: kind, argv: null }] }
    const proto = TerminalBackend.prototype
    const stubs = [
      vi.spyOn(proto, 'epoch').mockImplementation(async () => 'e'),
      vi.spyOn(proto, 'agentCapable').mockImplementation(() => true),
      vi.spyOn(proto, 'list').mockImplementation(async () => [live]),
      vi.spyOn(proto, 'create').mockImplementation(async () => live),
      vi.spyOn(proto, 'agentInfo').mockImplementation(async () => state.observe === null ? state.info : state.observe(state.info)),
      vi.spyOn(proto, 'agentManifests').mockImplementation(async () => state.manifests),
      vi.spyOn(proto, 'read').mockImplementation(async () => ({ text: 'fixture', truncated: false, total: 7 })),
      vi.spyOn(proto, 'process').mockImplementation(async () => ({ shellPid: 123, foregroundGroupId: null, foreground: state.foreground })),
      vi.spyOn(proto, 'startAgent').mockImplementation(async () => ({ agent: state.info, argv: [] })),
      vi.spyOn(proto, 'promptAgent').mockImplementation(async () => { state.onPrompt(); return state.info }),
    ]
    cleanups.push(() => { for (const stub of stubs) stub.mockRestore() })
    const t0 = Date.now() - 1000, store = new AgentStore(data)
    const sessionId = mintsSessionId(kind) ? randomUUID() : null
    const record = store.write('pane', { epoch: 'e', ptyGeneration: 'p', kind, name: info.name!, argv: [kind],
      requestedModel: null, requestedEffort: null, requestedAdvisor: null, sessionId,
      sessionIdSource: sessionId === null ? null : 'client-minted', t0, launchDeadline: t0 + AGENT_START_TIMEOUT_MS,
      phase: options.phase ?? 'ready', workingObserved: options.workingObserved ?? false, lastSubmission: null, updatedAt: Date.now() })
    const token = new Tokens(data).encode('t1', { runtimeId: 'test', epoch: 'e', ptyId: 'p', paneId: 'pane' })
    const terminal = terminalModule(data)
    const context = (ms: number): CommandContext => ({ runtimeId: 'test', instanceId: 'test', userData: data,
      signal: new AbortController().signal, remote: false, deadlineAt: Date.now() + ms })
    const run = (command: string, flags: Record<string, unknown> = {}, ms = 4000) => terminal.execute({ command,
      flags: { ...(command === 'terminal create' ? {} : { terminal: token }), ...flags,
        ...(command === 'terminal prompt' ? { 'request-id': `r1.${Date.now()}.${randomUUID()}` } : {}) },
      args: [], cwd }, context(ms))
    const recordFile = () => sessionRecordPaths(kind, { cwd, sessionId: record.sessionId, t0Ms: t0, nowMs: Date.now() })[0]!
    return { dir, data, cwd, live, state, store, record, token, terminal, context, run, recordFile, t0 }
  }
  const asObject = (value: unknown): Record<string, unknown> => { if (!isRecord(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`); return value }
  const nested = (value: unknown, ...keys: string[]): Record<string, unknown> => keys.reduce((current, key) => asObject(asObject(current)[key]), asObject(value))

  it('R1: never takes a foreign codex rollout as its own match, model or record path', async () => {
    const f = agentFixture('codex')
    const day = codexSessionDates(f.t0, Date.now())[0]!
    const sessions = path.join(process.env.CODEX_HOME!, 'sessions', day)
    const owned = path.join(sessions, 'rollout-a-owned.jsonl'), foreign = path.join(sessions, 'rollout-z-foreign.jsonl')
    const at = new Date(f.t0).toISOString()
    put(owned, codexMetaRow('owner-session', f.cwd, at))
    put(foreign, codexMetaRow('foreign-session', path.join(f.dir, 'elsewhere'), at))
    // Another codex session in another directory answers the same body and resolves another model.
    f.state.onPrompt = () => fs.appendFileSync(foreign, codexUserRow(PROMPT)
      + JSON.stringify({ type: 'turn_context', payload: { model: 'FOREIGN-MODEL', effort: 'low' } }) + '\n')
    const result = asObject(await f.run('terminal prompt', { text: PROMPT, wait: 'accepted' }, 3000))
    expect(result.outcome).toBe('unknown')
    expect(nested(result, 'record').matchCount).toBe(0)
    expect(nested(result, 'record').path).toBe(owned)
    expect(nested(result, 'agent').resolvedModel).toBe(null)
  }, 20000)

  it('R2: a same-path record that grew with a different prefix is a replacement, not a continuation', () => {
    const file = '/records/claude.jsonl', identity = bodyIdentity(PROMPT)
    const submittedAtMs = Date.parse('2026-09-21T05:55:00.500Z')
    const before = claudeRow(PROMPT, '2026-09-21T05:55:00.100Z')
    const cursor = captureCursor([file], reader({ [file]: before }))
    // The provider replaced the file with a longer one that pushed the OLD row past the old line
    // cursor. Byte length alone says "it grew", and the row it then counts predates the submission.
    const replaced = JSON.stringify({ type: 'padding', text: 'x'.repeat(before.length) }) + '\n' + before
    const swapped = countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs, cursor, read: reader({ [file]: replaced }) })
    expect(swapped.cursorInvalidated).toBe(true)
    expect(classifyCount(swapped, swapped.scanned.length)).toBe('ambiguous')
    // Positive control: the same file appended to, which must stay a plain continuation.
    const appended = before + claudeRow(PROMPT, '2026-09-21T05:55:00.900Z')
    const grew = countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs, cursor, read: reader({ [file]: appended }) })
    expect([grew.cursorInvalidated, grew.matchCount, classifyCount(grew, grew.scanned.length)]).toEqual([false, 1, null])
  })

  it('R3: an unmet --wait responded is outcome unknown with the delivery still confirmed', async () => {
    const f = agentFixture('claude')
    const file = f.recordFile()
    put(file, '')
    // The body lands in the record, but the turn never produces an assistant row before the deadline.
    f.state.onPrompt = () => fs.appendFileSync(file, claudeRow(PROMPT))
    const result = asObject(await f.run('terminal prompt', { text: PROMPT, wait: 'responded' }, 3000))
    expect(result.outcome).toBe('unknown')
    expect(nested(result, 'wait')).toMatchObject({ requested: 'responded', satisfied: false, reason: 'deadline' })
    // Delivery is a separate fact and survives: one match, and the phase says accepted, not responded.
    expect(nested(result, 'record')).toMatchObject({ matchCount: 1, unavailableReason: null })
    expect(nested(result, 'agent').phase).toBe('accepted')
  }, 20000)

  it('R4: a Working seen before this submission never justifies responded', async () => {
    const f = agentFixture('claude', { workingObserved: true })
    const file = f.recordFile()
    put(file, '')
    // Answer and question appear at once and the agent is idle throughout: this turn shows no Working.
    f.state.onPrompt = () => fs.appendFileSync(file, claudeRow(PROMPT) + assistantRow())
    const result = asObject(await f.run('terminal prompt', { text: PROMPT, wait: 'responded' }, 3000))
    expect(result.outcome).toBe('unknown')
    expect(nested(result, 'agent').phase).toBe('accepted')
    expect(nested(result, 'agent', 'evidence').workingObserved).toBe(false)
    expect(nested(result, 'wait').satisfied).toBe(false)
  }, 20000)

  it('R5: a stored ready is not reported while the current manifest gate is false', async () => {
    const f = agentFixture('claude', { phase: 'ready' })
    // The override arrives after the session was already promoted to ready.
    f.state.manifests = [{ agent: 'claude', source_kind: 'local_override', active_version: EXPECTED_MANIFESTS.claude.version, local_override_shadowing_remote: true }]
    const shown = asObject(await f.run('terminal show', {}, 6000))
    expect(nested(shown, 'agent').phase).not.toBe('ready')
    expect(nested(shown, 'agent', 'evidence', 'detectManifest').verified).toBe(false)
  }, 20000)

  it('R5/G1: an unverified manifest ends the wait at once and leaves create --prompt not_started', async () => {
    const f = agentFixture('claude', { phase: 'ready', git: true })
    f.state.manifests = [{ agent: 'claude', source_kind: 'local_override', active_version: EXPECTED_MANIFESTS.claude.version, local_override_shadowing_remote: true }]
    const started = Date.now()
    const waited = asObject(await f.run('terminal wait', { for: 'agent-ready' }, 8000))
    expect(waited.satisfied).toBe(false)
    expect(nested(waited, 'agent', 'evidence', 'detectManifest').verified).toBe(false)
    // "Not ready" is answered, not waited out: the gate reports it instead of burning the deadline.
    expect(Date.now() - started).toBeLessThan(6000)
    // The same reason is what `create --prompt` must report; today that branch cannot be reached.
    const workspace = workspaceModule(f.data)
    await workspace.execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
    const created = asObject(await f.run('terminal create', { worktree: f.cwd, agent: 'claude', prompt: PROMPT,
      'request-id': `r1.${Date.now()}.${randomUUID()}` }, 8000))
    expect(nested(created, 'stages', 'prompt')).toMatchObject({ status: 'not_started', reason: 'detect_manifest_unverified' })
  }, 30000)

  it('R7: the guard rejection keeps the AgentInfo it observed, all the way to the RuntimeError', async () => {
    // Driven through the adapter's public surface against a stub guard, not through the envelope
    // parser: the runtime is not allowed to reach adapter internals (N2), and what has to be true
    // is what the *caller* receives. A compare-and-submit refusal is justified entirely by the
    // state the guard saw at that instant; re-reading agent.get afterwards sees a state that has
    // already moved on, so the observation has to survive the error envelope.
    const dir = fixture(), guard = path.join(dir, 'guard.sock')
    const observed = { name: 'corral-fixture', kind: 'claude', status: 'working', state_change_seq: 3 }
    const server = net.createServer(connection => {
      connection.setEncoding('utf8')
      connection.on('data', chunk => {
        const message: unknown = JSON.parse(String(chunk))
        const params = isRecord(message) ? asObject(message).params : undefined
        const operation = isRecord(params) ? params.operation : undefined
        const body = operation === undefined
          ? { id: 'x', result: { guard_version: 1, agent_ops: 1, epoch: 'e' } }
          : { id: 'x', error: { code: 'agent_not_ready', message: 'state changed; guard observed seq 3', observed } }
        connection.end(JSON.stringify(body) + '\n')
      })
    })
    await new Promise<void>(resolve => server.listen(guard, resolve))
    cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
    const backend = new TerminalBackend(guard)
    const ctx = { signal: new AbortController().signal, deadlineAt: Date.now() + 5000 }
    expect(await backend.epoch(ctx)).toBe('e')
    const target: TerminalIdentity = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 't', workspaceId: 'w', path: '/tmp', repo: '/tmp', title: '' }
    await expect(backend.promptAgent(target, 'body', 2, ctx)).rejects.toMatchObject({ code: 'agent_not_ready', resources: { observed } })
  })

  // LIFE-417 N4: the busy re-knock lives in the backend (its own unit test pins the loop). What the
  // runtime owes is the count — on the failure path too, where there is no return value to carry it.
  // r6 (R5-6): the stage is pinned as an equality, not a subset, and `no retry` is its own case —
  // a `retries` that silently went missing on the quiet path would pass a `toMatchObject`.
  for (const mode of ['no retry', 'succeeds', 'gives up'] as const) {
    it(`N4: stages.agent carries the busy retry count when the start ${mode}`, async () => {
      const f = agentFixture('claude', { git: true })
      const workspace = workspaceModule(f.data)
      await workspace.execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
      const stub = vi.spyOn(TerminalBackend.prototype, 'startAgent').mockImplementation(async (_target, params) => {
        if (mode === 'no retry') return { agent: f.state.info, argv: [] }
        params.onBusyRetry?.(1)
        if (mode === 'gives up') throw new RuntimeError('agent_pane_busy', 'agent target pane is not an available shell', undefined, 'backend', 'unknown')
        params.onBusyRetry?.(2)
        return { agent: f.state.info, argv: [] }
      })
      cleanups.push(() => { stub.mockRestore() })
      const created = asObject(await f.run('terminal create', { worktree: f.cwd, agent: 'claude', 'request-id': `r1.${Date.now()}.${randomUUID()}` }, 8000))
      // `argv` carries a freshly minted session id, so it is checked apart from the equality — the
      // point of `toEqual` here is that the stage holds *these keys and no others*.
      const { argv, ...stage } = nested(created, 'stages', 'agent')
      expect(stage).toEqual(mode === 'gives up'
        ? { status: 'unknown', error: 'agent_pane_busy', message: 'agent target pane is not an available shell', retries: 1 }
        : { status: 'completed', name: agentName('pane'), retries: mode === 'no retry' ? 0 : 2 })
      expect(mode === 'gives up' ? argv : Array.isArray(argv) && argv[0]).toBe(mode === 'gives up' ? undefined : 'claude')
      expect(created.stage).toBe(mode === 'gives up' ? 'pty_created' : 'agent_started')
      expect(created.outcome).toBe(mode === 'gives up' ? 'unknown' : 'completed')
    }, 30000)
  }

  it('R11: a finished turn reported as done takes the next prompt on the same pane', async () => {
    // herdr reports a *seen* idle pane as `idle` and an unseen one as `done` (api_helpers.rs 96~106:
    // `(AgentState::Idle, false) => Done`). `seen` is set only on a completion transition of the
    // active tab of a focused window, so headless use — every pane corral drives — reports `done`
    // after the first turn. A pane that finished its turn is precisely a pane ready for the next
    // prompt, so `done` has to pass the same gate `idle` does.
    const f = agentFixture('claude', { phase: 'responded', workingObserved: true })
    f.state.info = { ...f.state.info, status: 'done' }
    f.store.update('pane', 'e', 'p', { lastSubmission: { sha256: bodyIdentity('first turn').sha256,
      bytes: 10, submittedAt: new Date(f.t0).toISOString(), cursor: [], requestId: 'previous' } })
    // The same pane already satisfies `agent-idle`, which is the contradiction this fixes.
    const idle = asObject(await f.run('terminal wait', { for: 'agent-idle' }, 8000))
    expect(idle.satisfied).toBe(true)
    expect(nested(idle, 'agent', 'evidence').agentStatus).toBe('done')
    let sends = 0
    f.state.onPrompt = () => { sends++ }
    const second = asObject(await f.run('terminal prompt', { text: 'second turn body' }, 8000))
    expect(second.outcome).toBe('queued')
    expect(sends).toBe(1)
  }, 30000)

  // R5 잔여: the r1 fix masked a stored `ready` only when the manifest was unverified. Every other
  // way the gate can fail — a Working frame, a seq that moved, a single sample — still reported the
  // phase the record happened to hold.
  type GateFailure = 'working' | 'seq-change' | 'one-sample'
  const GATE_FAILURES: readonly GateFailure[] = ['working', 'seq-change', 'one-sample']
  for (const mode of GATE_FAILURES) {
    it(`R5: a stored ready survives no gate failure (${mode})`, async () => {
      const f = agentFixture('claude', { phase: 'ready' })
      let seq = 2
      if (mode === 'working') f.state.observe = current => ({ ...current, status: 'working' })
      if (mode === 'seq-change') f.state.observe = current => ({ ...current, stateChangeSeq: ++seq })
      // `one-sample` leaves the observation alone and starves the gate of its second sample instead.
      const shown = asObject(await f.run('terminal show', {}, mode === 'one-sample' ? 500 : 6000))
      expect(nested(shown, 'agent').phase).toBe('launching')
      expect(nested(shown, 'agent', 'evidence', 'detectManifest').verified).toBe(true)
      expect(nested(shown, 'agent', 'evidence').samples).toBe(mode === 'one-sample' ? 1 : 2)
    }, 20000)
  }

  it('R12: the responded evidence is the observation the idle gate ended on', async () => {
    const f = agentFixture('claude', { phase: 'ready' })
    const file = f.recordFile()
    put(file, '')
    let submitted = false, after = 0
    // One Working frame right after the submission, then a quiet turn at a new seq. The response has
    // to carry what the *gate* saw, not the single pre-gate frame the turn started from.
    f.state.observe = current => {
      const working = submitted && after++ === 0
      return { ...current, status: working ? 'working' : 'idle', stateChangeSeq: working ? 3 : 4 }
    }
    f.state.onPrompt = () => { submitted = true; fs.appendFileSync(file, claudeRow(PROMPT) + assistantRow()) }
    const result = asObject(await f.run('terminal prompt', { text: PROMPT, wait: 'responded' }, 12000))
    expect(result.outcome).toBe('completed')
    expect(nested(result, 'agent').phase).toBe('responded')
    expect(nested(result, 'agent', 'evidence')).toMatchObject({ samples: 2, agentStatus: 'idle', stateChangeSeq: 4, workingObserved: true })
  }, 30000)

  // R5/R12 를 고치면서 `phaseOf` 의 null 가드를 같이 지웠다가 되돌린 자리다. 기록 없는 bound pane —
  // 다른 프로파일이 띄운 pane, 또는 epoch·PTY 세대가 바뀌어 기록이 읽히지 않는 pane — 은
  // `observeAgent` 가 명시적으로 `bound` 로 돌려주므로(208행) 게이트가 불만족이면 이 줄에 도달한다.
  // 나머지 473건은 전부 기록을 쓰고 시작해서 이 경로를 한 번도 지나지 않았다.
  it('a bound pane with no record of its own reports launching instead of throwing', async () => {
    const f = agentFixture('claude')
    f.store.remove('pane')
    f.state.info = { ...f.state.info, status: 'working' }
    const shown = asObject(await f.run('terminal show', {}, 8000))
    expect(nested(shown, 'agent').phase).toBe('launching')
    expect(nested(shown, 'agent')).toMatchObject({ kind: 'claude', argv: null, sessionId: null })
  }, 30000)

  // --- LIFE-456 R2-F1: **공개 CLI → guard → 사유** 경로 --------------------------------------
  // 라운드 1 은 `blockedReasonOf` 를 단위로만 쟀다. 그래서 그 함수가 옳아도 **CLI 가 사유를
  // 영영 `unknown` 으로 낸다**는 것을 못 봤다: guard 허용 목록에 `agent.explain` 이 없어
  // `backend.agentExplain` 이 `unsupported` 로 거절당하고, `terminal show` 는 그 실패를
  // `null` 로 접어 `unknown` 을 냈다. 사유가 없는 것과 규칙이 사유를 안 가르는 것이
  // **같은 글자**로 나온 것이다.
  //
  // 여기서는 `terminal show` 명령을 실제로 실행해 그 경로 전체(명령 → `agentBlock` →
  // `blockedRuleId` → `pickBlockedRule` → `blockedReasonOf`)를 탄다. 대역으로 두는 것은
  // **Rust 백엔드 프로세스 하나뿐**이고, guard 자체는 같은 이름의 Rust 테스트가 맡는다
  // (`app/backend/herdr-guard.patch` — `corral_terminal_allows_agent_explain_with_the_same_identity_fence`).
  // 끝에서 끝까지는 네이티브 회차가 잰다.
  const claudeExplain = (): Record<string, unknown> => {
    const file = new URL('../shared/fixtures/agent-explain/claude-explain.json', import.meta.url)
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return asObject(parsed)
  }
  it('R2-F1: `terminal show` 가 blocked pane 의 사유를 실제로 낸다 (실화면 explain 원자료)', async () => {
    const f = agentFixture('claude', { phase: 'blocked' })
    f.state.info = { ...f.state.info, status: 'blocked' }
    const explain = vi.spyOn(TerminalBackend.prototype, 'agentExplain').mockImplementation(async () => claudeExplain())
    cleanups.push(() => { explain.mockRestore() })
    const shown = asObject(await f.run('terminal show', {}, 8000))
    expect(nested(shown, 'agent').phase).toBe('blocked')
    expect(nested(shown, 'agent', 'blocked').reason).toBe('permission')
    expect(explain).toHaveBeenCalled()
  }, 30000)
  it('R2-F1 반례: guard 가 explain 호출을 막으면 같은 화면이 `unknown` 이 된다', async () => {
    // 라운드 1 의 상태를 그대로 재현한다 — 허용 목록에 없는 메서드에 guard 가 주는 응답이
    // `unsupported` 다. **사유가 `unknown` 인 것이 규칙 탓이 아니라 guard 탓**이라는 것을
    // 이 대조가 보인다. 위 회차와 다른 것은 백엔드 응답 하나뿐이다.
    const f = agentFixture('claude', { phase: 'blocked' })
    f.state.info = { ...f.state.info, status: 'blocked' }
    const explain = vi.spyOn(TerminalBackend.prototype, 'agentExplain')
      .mockImplementation(async () => { throw new RuntimeError('unsupported', 'corral_terminal refused the explain call', {}, 'show', 'not_started') })
    cleanups.push(() => { explain.mockRestore() })
    const shown = asObject(await f.run('terminal show', {}, 8000))
    expect(nested(shown, 'agent').phase).toBe('blocked')
    expect(nested(shown, 'agent', 'blocked').reason).toBe('unknown')
  }, 30000)
  // --- 수정 라운드 4: 게이트 ① 사용자 확인에서 나온 기동 창 `exited` 오판 (06-gate1-fix.md) --------
  // 사용자 환경에서 `create --prompt` 가 1.07 s 만에 `agent_not_ready` 로 초기 프롬프트를 버렸다.
  // 두 가지가 겹쳤다: (①) 기동 직후 전경이 아직 비어 있고, (②) 네이티브 설치 claude 는 프로세스
  // 이름이 버전 문자열(`2.1.252`)이라 이름 포함 검사로는 전경에서 영영 보이지 않는다.
  it('R-gate1(a): a provider named for its version is still foreground by argv[0], and create --prompt delivers', async () => {
    const f = agentFixture('claude', { git: true })
    const workspace = workspaceModule(f.data)
    await workspace.execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
    // `~/.local/share/claude/versions/2.1.252/claude` 로 설치된 provider 의 실제 모양이다.
    f.state.foreground = [{ pid: 456, name: '2.1.252', argv: ['/home/u/.local/share/claude/versions/2.1.252/claude', '--model', 'opus'] }]
    let seen = 0
    f.state.observe = current => seen++ < 2 ? { ...current, status: 'unknown', launchPending: true, interactiveReady: false } : current
    let submitted = 0
    f.state.onPrompt = () => { submitted++ }
    const created = asObject(await f.run('terminal create', { worktree: f.cwd, agent: 'claude', prompt: PROMPT,
      'request-id': `r1.${Date.now()}.${randomUUID()}` }, 14000))
    // r2 에서는 여기가 `{ status: 'not_started', reason: 'agent_not_ready' }` 로 끝났다.
    expect(created.stage).toBe('agent_prompted')
    expect(nested(created, 'stages', 'prompt')).toMatchObject({ status: 'queued' })
    expect(nested(created, 'stages', 'prompt').reason).toBeUndefined()
    // 제출 뒤 한 번의 관측은 게이트를 다시 증명하지 못하므로 `launching` 이다(R5) — `exited` 가 아니다.
    expect(nested(created, 'agent').phase).toBe('launching')
    expect(submitted).toBe(1)
    // 술어를 직접 지나는 대조(R17): 결속이 사라져도(`agent_not_found`) 전경에 네이티브 항목이
    // 있으면 종료가 아니라 결속만 풀린 것이다(D6). 이름 검사만 남기면 여기서 `exited` 가 된다.
    f.state.observe = () => { throw new RuntimeError('agent_not_found', 'no agent for this pane') }
    expect(nested(asObject(await f.run('terminal show', {}, 6000)), 'agent').phase).toBe('launching')
  }, 40000)

  it('R-gate1(b): an empty foreground inside the launch window is launching, and exited only once it closes', async () => {
    const f = agentFixture('claude', { phase: 'launching' })
    // 셸이 아직 provider 를 exec 하기 전 — `agent.get` 은 성공하지만 전경은 비어 있다.
    f.state.foreground = []
    let seen = 0
    // 전경은 관측이 실제로 bound 가 되는 순간에만 찬다 — 기동 창 동안은 비어 있어야 이 회귀가
    // 기동 창 조건을 전경 판정 뒤로 되돌린 변형에서 실패한다(R17).
    f.state.observe = current => {
      if (seen++ < 2) return { ...current, status: 'unknown', launchPending: true, interactiveReady: false }
      f.state.foreground = [{ pid: 456, name: '2.1.252', argv: ['claude'] }]
      return current
    }
    const waited = asObject(await f.run('terminal wait', { for: 'agent-ready' }, 12000))
    expect(waited.satisfied).toBe(true)
    expect(nested(waited, 'agent').phase).toBe('ready')
    // 대조 ①: 기한이 지난 뒤의 빈 전경은 지금까지처럼 `exited` 다 (F10 보존).
    f.store.update('pane', 'e', 'p', { launchDeadline: Date.now() - 1 })
    f.state.foreground = []
    f.state.observe = current => ({ ...current, status: 'unknown', launchPending: false, interactiveReady: false })
    expect(nested(asObject(await f.run('terminal show', {}, 6000)), 'agent').phase).toBe('exited')
    // 대조 ②: 같은 조건에서 전경에 provider 가 argv[0] 로 남아 있으면 종료가 아니라 결속 만료다.
    f.state.foreground = [{ pid: 456, name: '2.1.252', argv: ['/home/u/.local/share/claude/versions/2.1.252/claude'] }]
    await expect(f.run('terminal wait', { for: 'agent-ready' }, 6000)).rejects.toMatchObject({ code: 'agent_launch_expired' })
  }, 40000)

  it('R-gate1(c): a stored exited is released the moment the gate holds again, but /exit is not', async () => {
    const f = agentFixture('claude', { phase: 'exited' })
    // 살아 있는 결속을 두 번 증명한 pane 이다 — 한 번의 오관측이 pane 수명 내내 남지 않는다.
    expect(nested(asObject(await f.run('terminal show', {}, 6000)), 'agent').phase).toBe('ready')
    // `/exit` 뒤에는 `agent.get` 자체가 `agent_not_found` 라 게이트가 성립하지 않는다 (F10).
    f.state.observe = () => { throw new RuntimeError('agent_not_found', 'no agent for this pane') }
    f.state.foreground = []
    expect(nested(asObject(await f.run('terminal show', {}, 6000)), 'agent').phase).toBe('exited')
  }, 30000)

  // 라운드 5 (R18). `gatePass` 의 `satisfied` 는 관측이 *누구의* pane 인지 묻지 않는다 — 조용하고
  // seq 가 그대로면 만족이다. herdr 은 살아 있는 managed agent 의 이름을 바꿀 수 있으므로
  // (`agents.rs` `rename_agent_target`), 저장된 `exited` 를 푸는 증거는 "조용한 표본 2회" 가 아니라
  // "같은 결속의 `bound` 2회" 여야 한다. 입력은 리뷰의 `probes.mts` nameChange 와 같다.
  it('R-gate1(d) R18: a gate sample that belongs to another name never promotes a stored exited', async () => {
    const f = agentFixture('claude', { phase: 'exited' })
    let calls = 0
    // `terminal show` 는 게이트 앞에서 단일 관측을 한 번 더 한다 — 게이트 표본은 2·3번째 호출이다.
    f.state.observe = current => ({ ...current, name: ++calls >= 3 ? 'someone-else' : current.name })
    const shown = asObject(await f.run('terminal show', {}, 6000))
    expect(nested(shown, 'agent').phase).toBe('exited')
    expect(calls).toBeGreaterThanOrEqual(3)
  }, 30000)

  // --- LIFE-603 D8 — the draft stage: typed once as a bracketed paste, never submitted ----------------
  const DRAFT_REFUSALS: ('blocked' | 'unverified')[] = ['blocked', 'unverified']
  const DRAFT_BODY = '작업 LIFE-1 첫 줄\r\n둘째 줄 \u001b[201~ 끼어든 끝 시퀀스\r셋째 줄\u0007벨\n넷째 줄\n' + '긴 본문 '.repeat(120) + '\n\n'
  const sendSpy = () => vi.spyOn(TerminalBackend.prototype, 'sendIfUnchanged').mockImplementation(async () => undefined)
  it('LIFE-603: worktree create --draft types the sanitized body once, sends no Enter (enterSent false) and never takes the agent.prompt path', async () => {
    const f = agentFixture('claude', { git: true })
    const send = sendSpy()
    cleanups.push(() => { send.mockRestore() })
    let submitted = 0
    f.state.onPrompt = () => { submitted++ }
    const workspace = workspaceModule(f.data)
    await workspace.execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
    const requestId = `r1.${Date.now()}.${randomUUID()}`
    const create = () => workspace.execute({ command: 'worktree create', flags: { name: 'draft-wt', repo: f.cwd, agent: 'claude', prompt: DRAFT_BODY, draft: true, 'request-id': requestId }, args: [], cwd: f.cwd }, f.context(14000))
    const created = asObject(await create())
    expect(nested(created, 'stages', 'prompt')).toMatchObject({ status: 'completed', mode: 'draft', enterSent: false })
    // K1: the draft response carries the manifest the ready gate verified before the paste.
    expect(nested(created, 'agent', 'evidence', 'detectManifest')).toMatchObject({ verified: true, expectedVersion: EXPECTED_MANIFESTS.claude.version })
    expect(submitted).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
    const payload = String(send.mock.calls[0]![1])
    // One frame: the only ESC bytes are the frame's own, so the body cannot close it early.
    expect(payload.startsWith('\u001b[200~')).toBe(true)
    expect(payload.endsWith('\u001b[201~')).toBe(true)
    expect(payload.split('\u001b').length - 1).toBe(2)
    // No other control character survives, and nothing follows the frame (no Enter).
    const stray = [...payload].map((char) => char.charCodeAt(0)).filter((code) => (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x1b) || code === 0x7f)
    expect(stray).toEqual([])
    expect(payload.slice(6, -6).endsWith('\r')).toBe(false)
    expect(payload).toContain('넷째 줄')
    expect(send.mock.calls[0]![2]).toBe(2) // fenced on the ready observation's seq
    // Same request id → replay: the draft is not typed a second time.
    const again = asObject(await create())
    expect(again.replayed).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(submitted).toBe(0)
  }, 40000)
  it('LIFE-603: a blocked or unverified agent leaves the draft not_started and types nothing (fail-closed)', async () => {
    for (const mode of DRAFT_REFUSALS) {
      const f = agentFixture('claude', { git: true })
      await workspaceModule(f.data).execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
      const send = sendSpy()
      cleanups.push(() => { send.mockRestore() })
      if (mode === 'blocked') f.state.info = { ...f.state.info, status: 'blocked' }
      else f.state.manifests = []
      const created = asObject(await f.run('terminal create', { worktree: f.cwd, agent: 'claude', prompt: DRAFT_BODY, draft: true, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, 8000))
      expect([mode, nested(created, 'stages', 'prompt').status]).toEqual([mode, 'not_started'])
      expect(send).not.toHaveBeenCalled()
      send.mockRestore()
    }
  }, 40000)
  it('LIFE-603 R2-K: a body that is empty after sanitizing leaves the draft not_started (empty_after_sanitize) and types nothing', async () => {
    const f = agentFixture('claude', { git: true })
    await workspaceModule(f.data).execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
    const send = sendSpy()
    cleanups.push(() => { send.mockRestore() })
    let submitted = 0
    f.state.onPrompt = () => { submitted++ }
    // Only control bytes, invisible code points and whitespace: nothing survives sanitizeDraftBody.
    const created = asObject(await f.run('terminal create', { worktree: f.cwd, agent: 'claude', prompt: '\u0007\u001b\u200b\u202e\u{E0041}\r\n  \t', draft: true, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, 8000))
    expect(nested(created, 'stages', 'prompt')).toEqual({ status: 'not_started', mode: 'draft', reason: 'empty_after_sanitize' })
    expect(send).not.toHaveBeenCalled()
    expect(submitted).toBe(0)
    // Positive control: one visible character is enough to type the draft once.
    const control = asObject(await f.run('terminal create', { worktree: f.cwd, agent: 'claude', prompt: '\u0007x', draft: true, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, 8000))
    expect(nested(control, 'stages', 'prompt')).toMatchObject({ status: 'completed', mode: 'draft' })
    expect(send).toHaveBeenCalledTimes(1)
  }, 40000)
  it('LIFE-603 positive control: without --draft the same body is submitted through agent.prompt and never typed', async () => {
    const f = agentFixture('claude', { git: true })
    await workspaceModule(f.data).execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
    const send = sendSpy()
    cleanups.push(() => { send.mockRestore() })
    let submitted = 0
    f.state.onPrompt = () => { submitted++ }
    const created = asObject(await f.run('terminal create', { worktree: f.cwd, agent: 'claude', prompt: PROMPT, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, 8000))
    expect(created.stage).toBe('agent_prompted')
    expect(nested(created, 'stages', 'prompt').mode).toBeUndefined()
    expect(submitted).toBe(1)
    expect(send).not.toHaveBeenCalled()
  }, 30000)

  // LIFE-771 — a claude session moved to the background (`←`·`/bg`) goes on in a new id's file. Every
  // case here is 「합성」: the files are written by hand in the shape the coordinator measured on
  // Claude Code 2.1.296 (LIFE-771 analysis, the coordinator's real-pane probe) — the minted
  // file ends with `continued-in`, the new file holds only meta rows until its first input, and that
  // input copies the old rows in with their original `uuid` and timestamp under the new `sessionId`.
  // They prove the following and counting rules, not that Claude Code writes that shape.
  describe('LIFE-771 합성 — delivery follows the continued session file', () => {
    const OLD = 'Reply with exactly: P771-A0', NEW = 'Reply with exactly: P771-B1'
    const userRow = (input: { body: string; at: string; uuid: string; session: string }) =>
      JSON.stringify({ type: 'user', origin: { kind: 'human' }, uuid: input.uuid, sessionId: input.session, timestamp: input.at, message: { content: input.body } }) + '\n'
    const metaRows = (session: string) => [{ type: 'mode', mode: 'default' }, { type: 'permission-mode', permissionMode: 'default' }]
      .map(row => JSON.stringify({ ...row, sessionId: session }) + '\n').join('')
    const continuedRow = (from: string, to: string) =>
      JSON.stringify({ type: 'continued-in', timestamp: new Date().toISOString(), sessionId: from, continuedInSessionId: to }) + '\n'
    const past = new Date(Date.now() - 60_000).toISOString()
    /** A pane whose minted session `a` holds one delivered body and then moved to `b` (meta rows only). */
    function moved(options: { target?: 'exists' | 'missing'; tail?: string } = {}) {
      clearContinuedMemo()
      const f = agentFixture('claude')
      const a = f.record.sessionId!, b = randomUUID(), fileA = f.recordFile(), fileB = path.join(path.dirname(fileA), `${b}.jsonl`)
      const original = { body: OLD, at: past, uuid: randomUUID(), session: a }
      put(fileA, metaRows(a) + userRow(original) + assistantRow(past) + continuedRow(a, b) + (options.tail ?? ''))
      if ((options.target ?? 'exists') === 'exists') put(fileB, metaRows(b))
      /** Claude Code's first input in `b`: the old conversation copied in, then the new row. */
      const firstInput = (row: string) => fs.appendFileSync(fileB, userRow({ ...original, session: b }) + assistantRow(past) + row)
      return { f, a, b, fileA, fileB, original, firstInput }
    }
    const refusal = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal') }, (error: unknown) => error)
    const rowsWith = (file: string, body: string) => fs.readFileSync(file, 'utf8').split('\n').filter(line => line.includes(JSON.stringify(body))).length

    it('E0 합성 유지: without a move the minted file confirms, and nothing is reported as continued', async () => {
      clearContinuedMemo()
      const f = agentFixture('claude'), file = f.recordFile()
      put(file, metaRows(f.record.sessionId!))
      f.state.onPrompt = () => fs.appendFileSync(file, userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: f.record.sessionId! }))
      const result = asObject(await f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 4000))
      expect([result.stage, result.outcome]).toEqual(['confirmed', 'completed'])
      expect(nested(result, 'record')).toMatchObject({ path: file, matchCount: 1, unavailableReason: null })
      expect(nested(result, 'agent', 'sessionRecord')).toEqual({ path: file, exists: true, continuedIn: [] })
    }, 20000)

    it('E1 합성 유지: without a move a body already in the minted file is refused', async () => {
      clearContinuedMemo()
      const f = agentFixture('claude'), file = f.recordFile()
      put(file, userRow({ body: OLD, at: past, uuid: randomUUID(), session: f.record.sessionId! }))
      let submitted = 0
      f.state.onPrompt = () => { submitted++ }
      expect(await refusal(f.run('terminal prompt', { text: OLD, wait: 'accepted' }, 3000)))
        .toMatchObject({ code: 'prompt_already_delivered', resources: { detail: { matchCount: 1 } } })
      expect(submitted).toBe(0)
    }, 20000)

    it('E2·E6 합성: the first body after the move is confirmed in the new file, and the copied rows do not count', async () => {
      const m = moved()
      m.f.state.onPrompt = () => m.firstInput(userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: m.b }))
      const result = asObject(await m.f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 4000))
      expect([result.stage, result.outcome]).toEqual(['confirmed', 'completed'])
      expect(nested(result, 'record')).toMatchObject({ path: m.fileB, matchCount: 1, cursorInvalidated: false, unavailableReason: null })
      // The minted id still names the pane; the record is the file growing now.
      expect(nested(result, 'agent')).toMatchObject({ sessionId: m.a, sessionIdSource: 'client-minted' })
      expect(nested(result, 'agent', 'sessionRecord')).toEqual({ path: m.fileB, exists: true, continuedIn: [m.b] })
      // C1ⓓ: the cursor the submission persisted names the same chain the count read.
      const stored = m.f.store.read('pane', 'e', 'p')!.lastSubmission!.cursor
      expect(stored.map(entry => entry.path)).toEqual([m.fileA, m.fileB])
      expect(stored[1]).toMatchObject({ existed: true, lines: 2 })
      // C2: worker-start reads this child answer as a delivery, not `dispatch_input_unconfirmed`.
      expect(submissionVerdict(result)).toEqual({ kind: 'delivered', confirmed: 'wait_satisfied' })
    }, 20000)

    it('E3 합성: the same body sent again after the move is refused, and the new file still holds it once', async () => {
      const m = moved()
      m.firstInput(userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: m.b }))
      let submitted = 0
      m.f.state.onPrompt = () => { submitted++ }
      expect(await refusal(m.f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 3000)))
        .toMatchObject({ code: 'prompt_already_delivered', stage: 'preflight', outcome: 'not_started', resources: { detail: { matchCount: 1 } } })
      expect([submitted, rowsWith(m.fileB, NEW)]).toEqual([0, 1])
    }, 20000)

    for (const copied of [false, true]) {
      it(`E4 합성: a body from before the move is refused with matchCount 1 (${copied ? 'after the copy — original + copy fold to one' : 'before the copy'})`, async () => {
        const m = moved()
        if (copied) m.firstInput(userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: m.b }))
        expect(rowsWith(m.fileB, OLD)).toBe(copied ? 1 : 0)
        let submitted = 0
        m.f.state.onPrompt = () => { submitted++ }
        const error = await refusal(m.f.run('terminal prompt', { text: OLD, wait: 'accepted' }, 3000))
        // C1ⓐ: one, not two — worker-start calls exactly one match `already_present` (orchestration V23).
        expect(error).toMatchObject({ code: 'prompt_already_delivered', resources: { detail: { matchCount: 1 } } })
        expect(submitted).toBe(0)
      }, 20000)
    }

    it('E5 합성: --wait responded completes on the new file', async () => {
      const m = moved()
      let submitted = false, after = 0
      m.f.state.observe = current => {
        const working = submitted && after++ === 0
        return { ...current, status: working ? 'working' : 'idle', stateChangeSeq: working ? 3 : 4 }
      }
      m.f.state.onPrompt = () => { submitted = true; m.firstInput(userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: m.b }) + assistantRow()) }
      const result = asObject(await m.f.run('terminal prompt', { text: NEW, wait: 'responded' }, 12000))
      expect(result.outcome).toBe('completed')
      expect(nested(result, 'record')).toMatchObject({ path: m.fileB, matchCount: 1, assistantAfter: true })
      expect(nested(result, 'agent').phase).toBe('responded')
    }, 30000)

    it('E7 합성 유지: a session revived after continued-in is read in the minted file again', async () => {
      const m = moved()
      // `--resume <old id>` writes on in the old file: a human row after `continued-in` ends the move.
      fs.appendFileSync(m.fileA, userRow({ body: 'revived', at: new Date().toISOString(), uuid: randomUUID(), session: m.a }))
      m.f.state.onPrompt = () => fs.appendFileSync(m.fileA, userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: m.a }))
      const result = asObject(await m.f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 4000))
      expect(result.outcome).toBe('completed')
      expect(nested(result, 'record')).toMatchObject({ path: m.fileA, matchCount: 1 })
      expect(nested(result, 'agent', 'sessionRecord')).toMatchObject({ path: m.fileA, continuedIn: [] })
    }, 20000)

    // C1ⓒ: the three ways the rule cannot conclude. Each stays on the minted file — what corral read
    // before this change — and the new file is not read at all: a body waiting there is not refused.
    const undecided: { name: string; options: { target?: 'exists' | 'missing'; tail?: string } }[] = [
      { name: 'unknown (an unreadable row after continued-in)', options: { tail: '{"type":"user","message":' } },
      { name: 'out of window (continued-in pushed past the widest read)', options: { tail: metaRows('x').repeat(Math.ceil(70_000 / metaRows('x').length)) } },
      { name: 'no target file', options: { target: 'missing' } },
    ]
    for (const { name, options } of undecided) {
      it(`E8 합성 유지: ${name} stays on the minted file`, async () => {
        const m = moved(options)
        if (options.target !== 'missing') fs.appendFileSync(m.fileB, userRow({ body: NEW, at: past, uuid: randomUUID(), session: m.b }))
        let submitted = 0
        m.f.state.onPrompt = () => { submitted++ }
        const result = asObject(await m.f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 1500))
        expect(submitted).toBe(1)
        expect(result.outcome).toBe('unknown')
        expect(nested(result, 'record')).toMatchObject({ path: m.fileA, matchCount: 0 })
        expect(nested(result, 'agent', 'sessionRecord')).toMatchObject({ path: m.fileA, continuedIn: [] })
        expect(m.f.store.read('pane', 'e', 'p')!.lastSubmission!.cursor.map(entry => entry.path)).toEqual([m.fileA])
      }, 20000)
    }

    it('C1ⓓ 합성: a move during the wait adds the new file after the cursor set, and its copy of this submission folds into one', async () => {
      clearContinuedMemo()
      const f = agentFixture('claude'), a = f.record.sessionId!, b = randomUUID(), fileA = f.recordFile(), fileB = path.join(path.dirname(fileA), `${b}.jsonl`)
      put(fileA, metaRows(a))
      f.state.onPrompt = () => {
        // Delivered in the minted file, then moved at once; the new file's first input copies it in.
        const row = { body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: a }
        fs.appendFileSync(fileA, userRow(row) + continuedRow(a, b))
        put(fileB, metaRows(b) + userRow({ ...row, session: b }))
      }
      const result = asObject(await f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 4000))
      expect(result.outcome).toBe('completed')
      expect(nested(result, 'record')).toMatchObject({ path: fileB, matchCount: 1, naiveCount: 1, unavailableReason: null })
      expect(f.store.read('pane', 'e', 'p')!.lastSubmission!.cursor.map(entry => entry.path)).toEqual([fileA])
    }, 20000)

    it('B 합성: the count keeps reading the cursor\'s files when the chain shrinks after submit (revived origin, body in the later file)', async () => {
      const m = moved()
      m.f.state.onPrompt = () => {
        // The body lands in the continued file; then the minted session is revived before the count
        // runs, so the chain is the minted file alone again. The cursor still names both files.
        m.firstInput(userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: m.b }))
        fs.appendFileSync(m.fileA, userRow({ body: 'revived', at: new Date().toISOString(), uuid: randomUUID(), session: m.a }))
      }
      const result = asObject(await m.f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 4000))
      expect(m.f.store.read('pane', 'e', 'p')!.lastSubmission!.cursor.map(entry => entry.path)).toEqual([m.fileA, m.fileB])
      expect(result.outcome).toBe('completed')
      expect(nested(result, 'record')).toMatchObject({ path: m.fileA, matchCount: 1, unavailableReason: null })
    }, 20000)

    it('I 합성: two hops — the chain index.ts builds ends in the file the rule chose', async () => {
      const m = moved()
      const c = randomUUID(), fileC = path.join(path.dirname(m.fileA), `${c}.jsonl`)
      m.firstInput(userRow({ body: 'first after move', at: past, uuid: randomUUID(), session: m.b }))
      fs.appendFileSync(m.fileB, continuedRow(m.b, c))
      put(fileC, metaRows(c))
      m.f.state.onPrompt = () => fs.appendFileSync(fileC, userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: c }))
      const result = asObject(await m.f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 4000))
      const cursor = m.f.store.read('pane', 'e', 'p')!.lastSubmission!.cursor.map(entry => entry.path)
      expect(cursor).toEqual([m.fileA, m.fileB, fileC])
      expect(nested(result, 'record').path).toBe(cursor[cursor.length - 1])
      expect(nested(result, 'agent', 'sessionRecord')).toEqual({ path: fileC, exists: true, continuedIn: [m.b, c] })
      expect(result.outcome).toBe('completed')
    }, 20000)

    it('G 합성 (실측 구조): ai-title/agent-name meta, one tail row after continued-in, copy after the first input\'s meta', async () => {
      clearContinuedMemo()
      const f = agentFixture('claude'), a = f.record.sessionId!, b = randomUUID(), fileA = f.recordFile(), fileB = path.join(path.dirname(fileA), `${b}.jsonl`)
      const line = (row: Record<string, unknown>) => JSON.stringify(row) + '\n'
      const original = { body: OLD, at: past, uuid: randomUUID(), session: a }
      // Minted file: meta, the delivered turn, more meta, `continued-in`, then one trailing meta row.
      put(fileA, ['last-prompt', 'mode', 'permission-mode', 'file-history-snapshot'].map(type => line({ type, sessionId: a })).join('')
        + userRow(original) + assistantRow(past) + ['ai-title', 'mode', 'cost-state'].map(type => line({ type, sessionId: a })).join('')
        + continuedRow(a, b) + line({ type: 'cost-state', sessionId: a }))
      // New file at the switch: `ai-title` and `agent-name` only.
      put(fileB, line({ type: 'ai-title', aiTitle: 'synthetic', sessionId: b }) + line({ type: 'agent-name', agentName: 'synthetic', sessionId: b }))
      f.state.onPrompt = () => fs.appendFileSync(fileB,
        ['mode', 'permission-mode', 'atis-latch', 'file-history-snapshot', 'attachment'].map(type => line({ type, sessionId: b })).join('')
        + userRow({ ...original, session: b }) + assistantRow(past) + line({ type: 'system', sessionId: b })
        + userRow({ body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: b }))
      const result = asObject(await f.run('terminal prompt', { text: NEW, wait: 'accepted' }, 4000))
      expect([result.stage, result.outcome]).toEqual(['confirmed', 'completed'])
      expect(nested(result, 'record')).toMatchObject({ path: fileB, matchCount: 1, cursorInvalidated: false })
      // The pre-move body: original + copy fold to one refusal.
      expect(await refusal(f.run('terminal prompt', { text: OLD, wait: 'accepted' }, 3000)))
        .toMatchObject({ code: 'prompt_already_delivered', resources: { detail: { matchCount: 1 } } })
    }, 20000)

    it('F 합성 (한계): --wait responded with a move while answering confirms delivery and leaves the wait unsatisfied', async () => {
      clearContinuedMemo()
      const f = agentFixture('claude'), a = f.record.sessionId!, b = randomUUID(), fileA = f.recordFile(), fileB = path.join(path.dirname(fileA), `${b}.jsonl`)
      put(fileA, metaRows(a))
      let submitted = false, after = 0
      f.state.observe = current => {
        const working = submitted && after++ === 0
        return { ...current, status: working ? 'working' : 'idle', stateChangeSeq: working ? 3 : 4 }
      }
      f.state.onPrompt = () => {
        submitted = true
        const row = { body: NEW, at: new Date().toISOString(), uuid: randomUUID(), session: a }
        fs.appendFileSync(fileA, userRow(row) + continuedRow(a, b))
        put(fileB, metaRows(b) + userRow({ ...row, session: b }) + assistantRow())
      }
      const result = asObject(await f.run('terminal prompt', { text: NEW, wait: 'responded' }, 3000))
      expect(result.outcome).toBe('unknown')
      expect(nested(result, 'wait')).toMatchObject({ requested: 'responded', satisfied: false })
      expect(nested(result, 'record')).toMatchObject({ path: fileB, matchCount: 1, unavailableReason: null })
    }, 20000)

    it('합성: a copy with the same uuid but a fresh timestamp is still the earlier file\'s row — counted once, in the earlier file', () => {
      const fileA = '/records/a.jsonl', fileB = '/records/b.jsonl', identity = bodyIdentity(NEW), submittedAtMs = Date.now()
      const row = { body: NEW, at: new Date(submittedAtMs).toISOString(), uuid: 'u-1', session: 'a' }
      const restamped = userRow({ ...row, at: new Date(submittedAtMs + 2000).toISOString(), session: 'b' })
      // In the window in both files: the earlier file counts it, the later file's copy is folded.
      const both = countSubmissions({ kind: 'claude', files: [fileA, fileB], identity, submittedAtMs, cursor: [], read: reader({ [fileA]: userRow(row), [fileB]: restamped }) })
      expect([both.matchCount, both.naiveCount]).toEqual([1, 1])
      // The earlier row is before the cursor; its re-stamped copy is still not a new submission.
      const cursor = captureCursor([fileA, fileB], reader({ [fileA]: userRow(row), [fileB]: '' }))
      const behind = countSubmissions({ kind: 'claude', files: [fileA, fileB], identity, submittedAtMs, cursor, read: reader({ [fileA]: userRow(row), [fileB]: restamped }) })
      expect(behind.matchCount).toBe(0)
    })

    it('합성 경계: one file, and codex across files, count exactly as before (no uuid fold)', () => {
      const file = '/records/one.jsonl', identity = bodyIdentity(NEW), submittedAtMs = Date.now(), at = new Date(submittedAtMs).toISOString()
      // The same uuid twice in one file is not a copy across a move — the single-file count is unchanged (phone input).
      const twice = userRow({ body: NEW, at, uuid: 'u-1', session: 's' }).repeat(2)
      expect(countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs, cursor: [], read: reader({ [file]: twice }) }).matchCount).toBe(2)
      // codex rows carrying the same uuid in two rollouts still count twice (E9 — its own ambiguity rule decides).
      const codexRow = (uuid: string) => JSON.stringify({ type: 'response_item', uuid, timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: NEW }] } }) + '\n'
      const a = '/codex/a.jsonl', b = '/codex/b.jsonl'
      expect(countSubmissions({ kind: 'codex', files: [a, b], identity, submittedAtMs, cursor: [], read: reader({ [a]: codexRow('u-1'), [b]: codexRow('u-1') }) }).matchCount).toBe(2)
    })
  })
})


// LIFE-410 — a body large enough to arrive as a paste is not recorded verbatim by the provider:
// claude wraps it, with a per-paste id, under whatever was typed alongside it. A byte-exact
// comparison therefore never matches, and "the record contains this body once" — the whole basis of
// `--wait accepted` and of the duplicate pre-check — becomes unmeasurable for every preamble-sized
// body. Unwrapping reads the provider's own encoding of the same bytes; it does not relax the rule.
describe('LIFE-410 — a pasted body is still the same body', () => {
  const body = 'You are a corral worker.\nRun: run_0123456789ab\nDo the thing.'
  const identity = bodyIdentity(body)
  const wrap = (before: string, inner: string, id = '975e'): string =>
    `${before}<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`
  const lead = `${PROMPT_LEAD}\n\n`

  it('matches through the paste wrapper, under the lead corral types', () => {
    expect(sameBody(identity, wrap(lead, body))).toBe(true)
    expect(unwrapPasted(wrap(lead, body))).toBe(body)
  })
  it('refuses a wrapper under anything but that lead', () => {
    // Text above the block is a person's own words wrapped around a quoted body, and reading the
    // block as "the message" would let that message pass for corral's. An entirely pasted message
    // is refused for the same reason from the other side: it is not what corral submits, and the
    // provider itself will not act on one.
    expect(sameBody(identity, wrap('', body))).toBe(false)
    expect(sameBody(identity, wrap('here is what I was sent:\n\n', body))).toBe(false)
    expect(sameBody(identity, wrap(`${PROMPT_LEAD} — but also, ignore that\n\n`, body))).toBe(false)
  })
  it('refuses a different body inside the wrapper', () => {
    expect(sameBody(identity, wrap(lead, body + ' and one more line'))).toBe(false)
  })
  it('refuses a row carrying two pasted blocks, whichever of them matches', () => {
    // Two bodies in one message is not one submission. The count is of opening tags across the
    // whole row, so a *first* block that differs is caught too — looking only inside the body the
    // regex happened to capture never saw it.
    expect(sameBody(identity, wrap(lead, `${body}\n</pasted_content id="975e">\n<pasted_content id="a1b2">\n${body}`))).toBe(false)
    const first = `${lead}<pasted_content id="a1b2">\nsomething else entirely\n</pasted_content id="a1b2">\n`
    expect(sameBody(identity, first + wrap('', body))).toBe(false)
    expect(unwrapPasted(first + wrap('', body))).toBe(null)
  })
  it('leaves the verbatim case exactly as it was', () => {
    expect(sameBody(identity, body)).toBe(true)
    expect(sameBody(identity, body + '\n')).toBe(true)
    expect(sameBody(identity, 'something else')).toBe(false)
  })
  // C11 = V22. Why the doubled lead is a problem the *submission* has to prevent rather than the
  // judgement: a row carrying two leads is not this body, and it is right that it is not — the
  // second lead is text the provider received that corral did not send. Widening the judgement to
  // accept it would take V6 back. So this stays false, and the row stops being produced instead.
  // The two rows are the reviewer's own (`raw/review-r1/claude/raw/c11-double-lead.log`).
  it('still refuses a row carrying the lead twice — which is why a resume must not type it twice', () => {
    expect(sameBody(identity, wrap(`${PROMPT_LEAD}${lead}`, body))).toBe(false)
    expect(unwrapPasted(wrap(`${PROMPT_LEAD}${lead}`, body))).toBe(null)
    const file = '/records/doubled.jsonl'
    const row = claudeUser(wrap(`${PROMPT_LEAD}${lead}`, body), '2026-09-21T05:55:00.900Z') + '\n'
    expect(countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs: 0, cursor: [], read: reader({ [file]: row }) }).matchCount).toBe(0)
    // The positive control: the same row with one lead is found, so the zero above is the doubling
    // and not the harness.
    const single = claudeUser(wrap(lead, body), '2026-09-21T05:55:00.900Z') + '\n'
    expect(countSubmissions({ kind: 'claude', files: [file], identity, submittedAtMs: 0, cursor: [], read: reader({ [file]: single }) }).matchCount).toBe(1)
  })
})
