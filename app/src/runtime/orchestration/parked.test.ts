/**
 * LIFE-797 — `worker-start` and the worker's reports on a claude pane whose session was parked by `←` before it
 * held a conversation (LIFE-797 analysis §3 e1).
 *
 * There is no minted file to leave `continued-in` in, so neither the delivery check (LIFE-771) nor the session
 * chain (LIFE-796) had anywhere to start: `worker-start` answered `dispatch_input_unconfirmed` and the worker's
 * `worker_done` from the background session was `sender_mismatch`. The one hop through Claude Code's session
 * registry (`parkedJobId` → the bg entry's `sessionId`) starts the chain at the job's file.
 *
 * 「합성」: the real orchestration and terminal modules over a stubbed herdr backend, and registry entries and
 * record files written by hand in the shape measured on Claude Code 2.1.296 (the pane's interactive entry keeps
 * the minted id and gains `parkedJobId`, the job's entry is `kind: "bg"` with `jobId` and the job's `sessionId`,
 * the job's file appears at the first input). They prove the rule and its fail-closed edges, not that Claude Code
 * writes that shape (that is the live gate C1/C2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RuntimeError } from '../contracts.js'
import { isRecord } from '../../shared/json.js'
import { OrchestrationStore } from './store.js'
import { createRun, createTask, emptyState } from './model.js'
import { TerminalBackend, type AgentObservation, type TerminalIdentity } from '../../main/adapter/index.js'
import { AGENT_KINDS, AGENT_START_TIMEOUT_MS, AgentStore, EXPECTED_MANIFESTS, agentName, claudeParkedSession, sessionRecordPaths } from '../terminal/agent.js'
import { Tokens } from '../terminal/tokens.js'
import { clearContinuedMemo } from '../../main/transcript-continued.js'

const cleanups: (() => void)[] = []
const previous = { ...process.env }
afterEach(() => {
  vi.restoreAllMocks()
  for (const fn of cleanups.splice(0).reverse()) fn()
  process.env = { ...previous }
})
const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw Error(`not a record: ${JSON.stringify(value)}`)
  return value
}
const userRow = (input: { body: string; session: string; at?: string }) =>
  JSON.stringify({ type: 'user', origin: { kind: 'human' }, uuid: randomUUID(), sessionId: input.session, timestamp: input.at ?? new Date().toISOString(), message: { content: input.body } }) + '\n'
const metaRows = (session: string) => JSON.stringify({ type: 'agent-name', agentName: 'synthetic', sessionId: session }) + '\n'
const continuedRow = (from: string, to: string) =>
  JSON.stringify({ type: 'continued-in', timestamp: new Date().toISOString(), sessionId: from, continuedInSessionId: to }) + '\n'
type Entry = Record<string, unknown>

/** One claude pane corral launched with minted session `minted`, parked as job `job` running session `bg`; one Task. */
function setup() {
  clearContinuedMemo()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l797-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'repo')
  fs.mkdirSync(cwd, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude')
  process.env.CORRAL_REGISTRY = path.join(dir, 'repos.json')
  process.env.CORRAL_BACKEND_SOCKET = path.join(dir, 'never-connected.sock')
  delete process.env.CORRAL_SESSION
  delete process.env.CORRAL_RUNTIME_SOCKET
  const paneId = 'w1:p1'
  const live: TerminalIdentity = { epoch: 'e', ptyId: 'p', paneId, tabId: 'tab', workspaceId: 'w', path: cwd, repo: cwd, title: 'l797' }
  const t0 = Date.now() - 1000, minted = randomUUID(), bg = randomUUID(), job = bg.slice(0, 8)
  new AgentStore(dir).write(paneId, { epoch: 'e', ptyGeneration: 'p', kind: 'claude', name: agentName(paneId), argv: ['claude'],
    requestedModel: null, requestedEffort: null, requestedAdvisor: null, sessionId: minted, sessionIdSource: 'client-minted',
    t0, launchDeadline: t0 + AGENT_START_TIMEOUT_MS, phase: 'ready', workingObserved: false, lastSubmission: null, updatedAt: Date.now() })
  const fileMinted = sessionRecordPaths('claude', { cwd, sessionId: minted, t0Ms: t0, nowMs: Date.now() })[0]!
  const folder = path.dirname(fileMinted), fileBg = path.join(folder, `${bg}.jsonl`)
  fs.mkdirSync(folder, { recursive: true })
  const sessions = path.join(dir, 'claude', 'sessions')
  const pane: Entry = { pid: 100, sessionId: minted, cwd, kind: 'interactive', entrypoint: 'cli', status: 'idle', parkedJobId: job }
  const bgEntry: Entry = { pid: 200, sessionId: bg, cwd, kind: 'bg', entrypoint: 'cli', status: 'idle', jobId: job }
  const registry = (entries: Entry[]) => {
    fs.rmSync(sessions, { recursive: true, force: true })
    fs.mkdirSync(sessions, { recursive: true })
    for (const [index, entry] of entries.entries()) fs.writeFileSync(path.join(sessions, `${index + 100}.json`), JSON.stringify(entry))
  }
  registry([pane, bgEntry])
  const token = new Tokens(dir).encode('t1', { runtimeId: 'runtime', epoch: 'e', ptyId: 'p', paneId })
  const info: AgentObservation = { name: agentName(paneId), kind: 'claude', status: 'idle', launchPending: false, interactiveReady: true,
    stateChangeSeq: 2, stateLabels: {}, session: null, paneId, observedAt: new Date().toISOString() }
  const manifests = AGENT_KINDS.map(agent => ({ agent, source_kind: EXPECTED_MANIFESTS[agent].sourceKind,
    active_version: EXPECTED_MANIFESTS[agent].version, local_override_shadowing_remote: false }))
  /** Claude Code's first input after `esc` lands in the job's file — created then. */
  const state = { lands: (text: string) => fs.appendFileSync(fileBg, (fs.existsSync(fileBg) ? '' : metaRows(bg)) + userRow({ body: text, session: bg })) }
  const proto = TerminalBackend.prototype
  vi.spyOn(proto, 'epoch').mockImplementation(async () => 'e')
  vi.spyOn(proto, 'agentCapable').mockImplementation(() => true)
  vi.spyOn(proto, 'list').mockImplementation(async () => [live])
  vi.spyOn(proto, 'agentInfo').mockImplementation(async () => info)
  vi.spyOn(proto, 'agentManifests').mockImplementation(async () => manifests)
  vi.spyOn(proto, 'read').mockImplementation(async () => ({ text: 'fixture', truncated: false, total: 7 }))
  vi.spyOn(proto, 'process').mockImplementation(async () => ({ shellPid: 123, foregroundGroupId: null, foreground: [{ pid: 456, name: 'claude', argv: null }] }))
  vi.spyOn(proto, 'send').mockImplementation(async () => undefined)
  vi.spyOn(proto, 'promptAgent').mockImplementation(async (_live, text) => { state.lands(text); return info })
  vi.spyOn(proto, 'screenRead').mockImplementation(async () => ({ text: '', input: { revision: 1, idleMs: 5000 }, anyInput: null, seq: info.stateChangeSeq }))
  vi.spyOn(proto, 'sendFenced').mockImplementation(async () => ({ revision: 2, anyRevision: null }))
  vi.spyOn(proto, 'promptAgentIfQuiet').mockImplementation(async (_live, input) => { state.lands(input.text); return info })
  const run = createRun(emptyState(), 'l797', new Date().toISOString())
  const made = createTask(run.state, { runId: run.run.id, spec: 'task body', title: null, deps: [], at: new Date().toISOString() })
  new OrchestrationStore(dir).write(made.state)
  return { dir, cwd, token, task: made.task.id, minted, bg, job, folder, fileMinted, fileBg, sessions, pane, bgEntry, registry, state }
}
type Fixture = ReturnType<typeof setup>
async function call(f: Fixture, input: { command: string; flags: Record<string, string>; caller?: { paneId: string; claudeSession: string } }, ms = 20000) {
  const { orchestrationModule } = await import('./index.js')
  const mod = orchestrationModule(f.dir)
  const ctx = { runtimeId: 'runtime', instanceId: 'instance', userData: f.dir, signal: new AbortController().signal, deadlineAt: Date.now() + ms, remote: false }
  // What a background session's Bash call carries: the daemon's first pane and the user's socket, plus its own claude id.
  const caller = input.caller === undefined ? undefined
    : { paneId: input.caller.paneId, session: null, socket: '/somewhere/else/herdr.sock', claudeSession: input.caller.claudeSession }
  const flags = { ...input.flags, 'request-id': `r1.${Date.now()}.${randomUUID()}` }
  try { return asRecord(await mod.execute({ command: input.command, flags, args: [], cwd: f.cwd, caller }, ctx)) }
  catch (error) { if (error instanceof RuntimeError) return { error: error.code, message: error.message, resources: error.resources }; throw error }
}
const workerStart = (f: Fixture, ms = 20000) => call(f, { command: 'orchestration worker-start', flags: { task: f.task, terminal: f.token } }, ms)
const report = (f: Fixture, input: { dispatchId: string; type: string; claudeSession: string }) => call(f, {
  command: 'orchestration send', caller: { paneId: 'w9:p9', claudeSession: input.claudeSession },
  flags: { type: input.type, subject: 'l797', body: 'b', 'task-id': f.task, 'dispatch-id': input.dispatchId,
    ...(input.type === 'worker_done' ? { outcome: 'succeeded' } : {}) },
})
const statePath = (f: Fixture) => path.join(f.dir, 'runtime', 'orchestration', 'state.json')

describe('LIFE-797 C5 합성 — worker-start and the worker\'s reports through the registry hop', () => {
  it('worker-start confirms the body in the job\'s file, and worker_done from the job\'s session is admitted on the chain', async () => {
    const f = setup()
    const started = await workerStart(f)
    expect([started.state, started.error]).toEqual(['ready', undefined])
    expect(asRecord(asRecord(started.stages).input)).toMatchObject({ status: 'completed' })
    expect(asRecord(asRecord(started.input).record)).toMatchObject({ path: f.fileBg, matchCount: 1, unavailableReason: null })
    const dispatchId = String(started.dispatchId)
    const beat = await report(f, { dispatchId, type: 'heartbeat', claudeSession: f.bg })
    expect([beat.error, beat.proof, beat.sessionVerified]).toEqual([undefined, 'session_chain', false])
    const done = await report(f, { dispatchId, type: 'worker_done', claudeSession: f.bg })
    expect([done.error, done.proof, done.settledBy]).toEqual([undefined, 'session_chain', 'worker_done'])
  }, 60000)

  it('fix1 A: unrelated entries in the registry (another pane parked as another job, that job\'s bg entry) do not stop the chain to this job', async () => {
    const f = setup()
    const started = await workerStart(f)
    expect(started.state).toBe('ready')
    const other = randomUUID(), otherBg = randomUUID(), otherJob = otherBg.slice(0, 8)
    f.registry([
      { ...f.pane, pid: 300, sessionId: other, parkedJobId: otherJob },
      { ...f.bgEntry, pid: 301, sessionId: otherBg, jobId: otherJob },
      f.pane, f.bgEntry,
      { pid: 302, sessionId: randomUUID(), kind: 'interactive', entrypoint: 'cli', status: 'idle' },
    ])
    const beat = await report(f, { dispatchId: String(started.dispatchId), type: 'heartbeat', claudeSession: f.bg })
    expect([beat.error, beat.proof]).toEqual([undefined, 'session_chain'])
  }, 60000)

  it('a job file that ends with continued-in is followed on — the later session is admitted too', async () => {
    const f = setup()
    const started = await workerStart(f)
    const c = randomUUID()
    fs.appendFileSync(f.fileBg, continuedRow(f.bg, c))
    fs.writeFileSync(path.join(f.folder, `${c}.jsonl`), metaRows(c))
    const beat = await report(f, { dispatchId: String(started.dispatchId), type: 'heartbeat', claudeSession: c })
    expect([beat.error, beat.proof]).toEqual([undefined, 'session_chain'])
  }, 60000)
})

// C4: every way the hop must not stand, on the reporter's side. Each is refused exactly as before LIFE-797
// (`sender_mismatch`, nothing stored) although the caller names the job's real session.
type Case = { name: string; arrange: (f: Fixture) => void }
const failClosed: Case[] = [
  { name: 'no registry folder', arrange: f => fs.rmSync(f.sessions, { recursive: true, force: true }) },
  { name: 'a registry entry that cannot be parsed', arrange: f => fs.writeFileSync(path.join(f.sessions, '999.json'), '{"pid":') },
  { name: 'a registry entry that cannot be read', arrange: f => fs.mkdirSync(path.join(f.sessions, '999.json')) },
  { name: 'no interactive entry with the minted id', arrange: f => f.registry([{ ...f.pane, sessionId: randomUUID() }, f.bgEntry]) },
  { name: 'two interactive entries with the minted id', arrange: f => f.registry([f.pane, { ...f.pane, pid: 101 }, f.bgEntry]) },
  { name: 'the minted id\'s entry is not interactive', arrange: f => f.registry([{ ...f.pane, kind: 'bg' }, f.bgEntry]) },
  { name: 'no parkedJobId', arrange: f => f.registry([{ ...f.pane, parkedJobId: undefined }, f.bgEntry]) },
  { name: 'a parkedJobId that is not a string', arrange: f => f.registry([{ ...f.pane, parkedJobId: 12345678 }, f.bgEntry]) },
  { name: 'a parkedJobId that is not a job id', arrange: f => f.registry([{ ...f.pane, parkedJobId: '../x' }, f.bgEntry]) },
  { name: 'no bg entry for the job', arrange: f => f.registry([f.pane]) },
  { name: 'fix1 A: a bg entry with the job\'s session (same prefix) but another jobId', arrange: f => f.registry([f.pane, { ...f.bgEntry, jobId: f.job === 'abcdef01' ? 'abcdef02' : 'abcdef01' }]) },
  { name: 'fix1 C: an empty parkedJobId and an empty jobId', arrange: f => f.registry([{ ...f.pane, parkedJobId: '' }, { ...f.bgEntry, jobId: '' }]) },
  { name: 'fix1 D(m11): a registry entry that is JSON but an array', arrange: f => fs.writeFileSync(path.join(f.sessions, '999.json'), '[]') },
  { name: 'fix1 D(m11): a registry entry that is JSON null', arrange: f => fs.writeFileSync(path.join(f.sessions, '999.json'), 'null') },
  { name: 'fix1 D(m11): a registry entry that is a JSON string', arrange: f => fs.writeFileSync(path.join(f.sessions, '999.json'), '"x"') },
  { name: 'fix1 B: a project folder whose <id>.jsonl place cannot be looked at (EACCES — not "no file")', arrange: f => {
    // Unreadable is not "none": the minted id could be in there, so the "no minted file" link cannot be proven.
    const locked = path.join(path.dirname(f.folder), 'locked')
    fs.mkdirSync(locked)
    fs.chmodSync(locked, 0o000)
    cleanups.push(() => fs.chmodSync(locked, 0o700))
  } },
  { name: 'two bg entries for the job', arrange: f => f.registry([f.pane, f.bgEntry, { ...f.bgEntry, pid: 201 }]) },
  { name: 'the job\'s entry is not bg', arrange: f => f.registry([f.pane, { ...f.bgEntry, kind: 'interactive' }]) },
  { name: 'a bg session id that is not a UUID', arrange: f => f.registry([f.pane, { ...f.bgEntry, sessionId: `${f.job}-x` }]) },
  { name: 'a bg session id that does not begin with the job id', arrange: f => {
    const other = f.job === '00000000' ? '11111111' : '00000000'
    f.registry([{ ...f.pane, parkedJobId: other }, { ...f.bgEntry, jobId: other }])
  } },
  { name: 'no file for the job\'s session', arrange: f => fs.rmSync(f.fileBg) },
  { name: 'the job\'s session file in two project folders', arrange: f => {
    fs.mkdirSync(path.join(path.dirname(f.folder), 'elsewhere'), { recursive: true })
    fs.copyFileSync(f.fileBg, path.join(path.dirname(f.folder), 'elsewhere', `${f.bg}.jsonl`))
  } },
  { name: 'a minted file that exists (its own record decides; it has no continued-in)', arrange: f => fs.writeFileSync(f.fileMinted, metaRows(f.minted)) },
  { name: 'the minted id in two project folders', arrange: f => {
    fs.writeFileSync(f.fileMinted, metaRows(f.minted))
    fs.mkdirSync(path.join(path.dirname(f.folder), 'elsewhere'), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(f.folder), 'elsewhere', `${f.minted}.jsonl`), metaRows(f.minted))
  } },
]

describe('LIFE-797 C4 합성 — the reporter\'s side fails closed', () => {
  for (const { name, arrange } of failClosed) {
    it(`${name} → sender_mismatch, nothing stored`, async () => {
      const f = setup()
      const started = await workerStart(f)
      expect(started.state).toBe('ready')
      arrange(f)
      const before = fs.readFileSync(statePath(f), 'utf8')
      const out = await report(f, { dispatchId: String(started.dispatchId), type: 'worker_done', claudeSession: f.bg })
      expect(out.error).toBe('sender_mismatch')
      expect(fs.readFileSync(statePath(f), 'utf8')).toBe(before)
    }, 60000)
  }
})

describe('LIFE-797 C4 합성 — worker-start before the hop: the answer before LIFE-797', () => {
  it('no registry: the body lands in the job\'s file, and worker-start says dispatch_input_unconfirmed (not_found)', async () => {
    const f = setup()
    fs.rmSync(f.sessions, { recursive: true, force: true })
    const started = await workerStart(f, 10000)
    expect([started.state, started.stage]).toEqual(['incomplete', 'dispatch_input_unconfirmed'])
    expect(asRecord(asRecord(started.input).record)).toMatchObject({ matchCount: 0, unavailableReason: 'not_found' })
    expect(fs.readFileSync(f.fileBg, 'utf8')).toContain('"type":"user"')
  }, 30000)
})

describe('LIFE-797 claudeParkedSession — the rule itself', () => {
  it('answers the job\'s session and its file; with no folder it finds the one file by id', () => {
    const f = setup()
    fs.writeFileSync(f.fileBg, metaRows(f.bg))
    expect(claudeParkedSession({ sessionId: f.minted, folder: f.folder })).toEqual({ sessionId: f.bg, file: f.fileBg })
    expect(claudeParkedSession({ sessionId: f.minted, folder: null })).toEqual({ sessionId: f.bg, file: f.fileBg })
  })
  it('a minted id that is not a session id, a minted path that is a folder, and a job that is the minted id give nothing', () => {
    const f = setup()
    fs.writeFileSync(f.fileBg, metaRows(f.bg))
    expect(claudeParkedSession({ sessionId: `../x/${f.minted}`, folder: f.folder })).toBeNull()
    fs.mkdirSync(f.fileMinted)
    expect(claudeParkedSession({ sessionId: f.minted, folder: f.folder })).toBeNull()
    fs.rmdirSync(f.fileMinted)
    f.registry([{ ...f.pane, parkedJobId: f.minted.slice(0, 8) }, { ...f.bgEntry, jobId: f.minted.slice(0, 8), sessionId: f.minted }])
    expect(claudeParkedSession({ sessionId: f.minted, folder: f.folder })).toBeNull()
  })
  it('fix1 D(m7): a job session id that is a path is not joined into one, even when it would land on the real job file', () => {
    const f = setup()
    fs.writeFileSync(f.fileBg, metaRows(f.bg))
    f.registry([f.pane, { ...f.bgEntry, sessionId: `${f.bg}/../${f.bg}` }])
    expect(fs.existsSync(path.join(f.folder, `${f.bg}/../${f.bg}.jsonl`))).toBe(true)
    expect(claudeParkedSession({ sessionId: f.minted, folder: f.folder })).toBeNull()
    expect(claudeParkedSession({ sessionId: f.minted, folder: null })).toBeNull()
  })
  it('fix1 D(m16): a folder where the job\'s file should be is not a file', () => {
    const f = setup()
    fs.mkdirSync(f.fileBg)
    expect(claudeParkedSession({ sessionId: f.minted, folder: f.folder })).toBeNull()
    expect(claudeParkedSession({ sessionId: f.minted, folder: null })).toBeNull()
  })
})
