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
import { AGENT_KINDS, AGENT_START_TIMEOUT_MS, AgentStore, EXPECTED_MANIFESTS, SESSION_MARKER_NAMES, SESSION_MARKER_PREFIXES, agentName, bodyIdentity, captureCursor, classifyCount, codexCandidates, codexSessionDates, countSubmissions, evaluateManifest, mintsSessionId, normalizeBody, providerArgv, readySatisfied, sessionRecordPaths, strippedSessionMarkers, withoutSessionMarkers, type AgentKind, type AgentPhase, type ReadySample } from './terminal/agent.js'
import { terminalModule } from './terminal/index.js'
import { Tokens } from './terminal/tokens.js'
import { TerminalBackend, type AgentObservation, type TerminalIdentity } from '../main/adapter/index.js'
import { asResponseFrame } from '../main/adapter/internal/protocol.js'
import { isRecord } from '../shared/json.js'
import type { CommandContext } from './contracts.js'
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
    expect(readySatisfied([sample(), sample()], 'ready')).toBe(true)
    // A recorded transition between the samples is exactly what N=2 is there to exclude.
    expect(readySatisfied([sample(), sample({ stateChangeSeq: 8 })], 'ready')).toBe(false)
    expect(readySatisfied([sample({ status: 'working' }), sample()], 'ready')).toBe(false)
    expect(readySatisfied([sample(), sample({ launchPending: true })], 'ready')).toBe(false)
    expect(readySatisfied([sample({ interactiveReady: false }), sample({ interactiveReady: false })], 'ready')).toBe(false)
    expect(readySatisfied([sample()], 'ready')).toBe(false)
    expect(readySatisfied([], 'ready')).toBe(false)
    // agent-idle is the same gate over a finished turn, so `done` counts there and only there.
    expect(readySatisfied([sample({ status: 'done' }), sample({ status: 'done' })], 'ready')).toBe(false)
    expect(readySatisfied([sample({ status: 'done' }), sample({ status: 'done' })], 'idle')).toBe(true)
  })

  it('counts the body inside the submission window, not by scanning the whole file (F7 1-3)', () => {
    const identity = bodyIdentity(BODY), file = '/records/claude.jsonl'
    const earlier = claudeUser(BODY, '2026-09-21T05:55:00.100Z'), later = claudeUser(BODY, '2026-09-21T05:55:00.900Z')
    const submittedAtMs = Date.parse('2026-09-21T05:55:00.500Z')
    // 1: the same second already holds the previous submission of the same body. The cursor, not the
    //    clock, separates them, and a time-only filter counts two.
    const both = earlier + '\n' + later + '\n', cursor = captureCursor([file], reader({ [file]: earlier + '\n' }))
    expect(cursor).toEqual([{ path: file, existed: true, bytes: Buffer.byteLength(earlier + '\n'), lines: 1 }])
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

  it('refuses every manifest that is not the expected bundled one, for all three providers (F12b)', () => {
    const bundled = (agent: string, version: string) => ({ agent, source_kind: 'bundled', active_version: version, local_override_shadowing_remote: false })
    for (const kind of ['claude', 'codex', 'grok'] as const) {
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
    expect(EXPECTED_MANIFESTS.claude.version).toBe('2026.09.04.1')
    expect(evaluateManifest('claude', [{ agent: 'claude', source_kind: 'local_override', active_version: '2026.09.04.1', local_override_shadowing_remote: false }], null).verified).toBe(false)
    expect(EXPECTED_MANIFESTS.codex.version).toBe(EXPECTED_MANIFESTS.grok.version)
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
    const harness = await import('../../scripts/l394/env.mjs')
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
describe('LIFE-394 review r0 reproductions (R1-R5, R7)', () => {
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
    const info: AgentObservation = { name: 'corral-fixture', kind, status: 'idle', launchPending: false, interactiveReady: true,
      stateChangeSeq: 2, stateLabels: {}, session: null, paneId: 'pane', observedAt: new Date().toISOString() }
    const verified = AGENT_KINDS.map(agent => ({ agent, source_kind: EXPECTED_MANIFESTS[agent].sourceKind,
      active_version: EXPECTED_MANIFESTS[agent].version, local_override_shadowing_remote: false }))
    const state = { info, manifests: verified, onPrompt: () => {} }
    const proto = TerminalBackend.prototype
    const stubs = [
      vi.spyOn(proto, 'epoch').mockImplementation(async () => 'e'),
      vi.spyOn(proto, 'agentCapable').mockImplementation(() => true),
      vi.spyOn(proto, 'list').mockImplementation(async () => [live]),
      vi.spyOn(proto, 'create').mockImplementation(async () => live),
      vi.spyOn(proto, 'agentInfo').mockImplementation(async () => state.info),
      vi.spyOn(proto, 'agentManifests').mockImplementation(async () => state.manifests),
      vi.spyOn(proto, 'read').mockImplementation(async () => ({ text: 'fixture', truncated: false, total: 7 })),
      vi.spyOn(proto, 'process').mockImplementation(async () => ({ shellPid: 123, foregroundGroupId: null, foreground: [{ pid: 456, name: kind, argv: null }] })),
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

  it('R7: the guard rejection keeps the AgentInfo it observed in the error envelope', () => {
    const observed = { name: 'corral-fixture', kind: 'claude', status: 'working', state_change_seq: 3 }
    const frame = asResponseFrame({ id: 'r', error: { code: 'agent_not_ready', message: 'state changed', observed } })
    expect(frame?.error).toMatchObject({ code: 'agent_not_ready', message: 'state changed', observed })
  })
})
