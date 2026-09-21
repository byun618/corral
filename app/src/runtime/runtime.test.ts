import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { workspaceModule } from './workspace/index.js'
import { startRuntime } from './server.js'
import { localCall, request, MAX_REQUEST } from './transport.js'
import { CommandRegistry, foundationSpecs, validateFoundation } from './registry.js'
import { EXPECTED_MANIFESTS, SESSION_MARKER_NAMES, SESSION_MARKER_PREFIXES, agentName, bodyIdentity, captureCursor, classifyCount, codexCandidates, codexSessionDates, countSubmissions, evaluateManifest, mintsSessionId, normalizeBody, providerArgv, readySatisfied, strippedSessionMarkers, withoutSessionMarkers, type ReadySample } from './terminal/agent.js'
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
