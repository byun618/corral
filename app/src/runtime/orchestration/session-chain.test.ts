/**
 * LIFE-796 — a worker report from a claude session moved to the background (`←`, `/bg`).
 *
 * That session runs inside Claude Code's account-wide daemon, so its `HERDR_PANE_ID` names whichever pane
 * first started the daemon (LIFE-795 analysis M1·P4) and the pane proof cannot hold. These tests pin the
 * second proof — the caller's `CLAUDE_CODE_SESSION_ID` is the Dispatch's minted claude session or one it
 * continued in — and, above all, every way it must *not* admit a caller (01-criteria C3 (a)~(i), C10).
 *
 * 「합성」: the units hand `verifySender` a chain directly. The module tests below run the real
 * orchestration and terminal modules over a stubbed herdr backend and a hand-written record chain in the
 * shape measured on Claude Code 2.1.296 (minted file ends with `continued-in`, the new file exists) — they
 * prove that `send`/`ask` read that chain from the record files of the Dispatch's frozen minted id (no
 * `terminal show`, no backend) and judge on it, also after the pane is gone — not that Claude Code writes it
 * or that a real background session sends these ids (that is the live gate C1/C2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RuntimeError } from '../contracts.js'
import { isRecord } from '../../shared/json.js'
import { OrchestrationStore } from './store.js'
import {
  createDispatch, createRun, createTask, emptyState, findDispatch,
  type AgentSnapshot, type DispatchTarget, type OrchestrationState, type PaneObservation,
} from './model.js'
import { emptyWorker, replaceDispatchRecord, sessionChainProves, verifySender, wantsSessionChain, withWorker, type CallerClaim, type SessionChain } from './worker.js'
import { TerminalBackend, type AgentObservation, type TerminalIdentity } from '../../main/adapter/index.js'
import { AGENT_KINDS, AGENT_START_TIMEOUT_MS, AgentStore, EXPECTED_MANIFESTS, agentName, claudeRecordById, sessionRecordPaths } from '../terminal/agent.js'
import { Tokens } from '../terminal/tokens.js'
import { clearContinuedMemo } from '../../main/transcript-continued.js'

const AT = '2026-11-14T00:00:00.000Z'
const LIVE: PaneObservation = { kind: 'live' }
const PANE = { paneId: 'w1:p1', session: 'l796' }
/** Where Claude Code's daemon was first started — the pane every background session claims to be. */
const DAEMON_PANE = { paneId: 'w9:p9', session: null }
const M = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const agentOf = (input: { kind: string; sessionId: string | null }): AgentSnapshot => ({
  kind: input.kind, name: 'corral-1', phase: 'ready', requestedModel: null, requestedEffort: null, requestedAdvisor: null,
  resolvedModel: null, resolvedAdvisor: null, argv: ['claude'], sessionId: input.sessionId, sessionIdSource: input.sessionId === null ? null : 'client-minted', observedAt: AT,
})
const target = (paneId: string): DispatchTarget => ({ handle: `t1.${paneId}`, runtimeId: 'runtime-1', epoch: 'epoch-1', ptyId: `pty-${paneId}`, paneId })

/** One Run, and one dispatched claude worker attempt per entry — built with the product's own constructors. */
function attempts(entries: { paneId: string; agent: AgentSnapshot | null }[]) {
  let state: OrchestrationState = emptyState()
  const run = createRun(state, 'LIFE-796 units', AT)
  state = run.state
  const out: { taskId: string; dispatchId: string }[] = []
  for (const entry of entries) {
    const made = createTask(state, { runId: run.run.id, spec: 'work', title: null, deps: [], at: AT })
    const dispatched = createDispatch(made.state, {
      task: made.task, target: target(entry.paneId), agent: entry.agent, agentAbsenceReason: entry.agent === null ? 'no_managed_agent' : null,
      worker: emptyWorker({ launch: 'created', ownership: 'owned', paneSession: PANE.session, originDispatchId: null }), at: AT,
    })
    const self = findDispatch(dispatched.state, dispatched.dispatch.id)!
    state = replaceDispatchRecord(dispatched.state, withWorker(self, { originDispatchId: self.id }, AT))
    out.push({ taskId: made.task.id, dispatchId: dispatched.dispatch.id })
  }
  return { state, out }
}
const bgCaller = (claudeSession: string | null): CallerClaim => ({ ...DAEMON_PANE, socketIsBackend: false, claudeSession })
const chainOf = (minted: string, ...continuedIn: string[]): SessionChain => ({ minted, continuedIn })

describe('LIFE-796 C3 — the session chain admits only the Dispatch\'s own claude session (units)', () => {
  it('admits the background session the minted one continued in, and says it was the chain', () => {
    const { state, out: [a] } = attempts([{ paneId: PANE.paneId, agent: agentOf({ kind: 'claude', sessionId: M }) }])
    const verdict = verifySender(state, { ...a!, caller: bgCaller(B), observation: LIVE, chain: chainOf(M, B) }, 'reject')
    expect(verdict.ok && [verdict.proof, verdict.sessionVerified]).toEqual(['session_chain', false])
  })

  it('(a) a session id outside the chain, from another pane → sender_mismatch', () => {
    const { state, out: [a] } = attempts([{ paneId: PANE.paneId, agent: agentOf({ kind: 'claude', sessionId: M }) }])
    const verdict = verifySender(state, { ...a!, caller: bgCaller(randomUUID()), observation: LIVE, chain: chainOf(M, B) }, 'reject')
    expect(verdict.ok === false && verdict.code).toBe('sender_mismatch')
  })

  it('(b) a session in ANOTHER Dispatch\'s chain → sender_mismatch, however the chain is handed in', () => {
    const M2 = randomUUID(), B2 = randomUUID()
    const { state, out: [a, other] } = attempts([
      { paneId: PANE.paneId, agent: agentOf({ kind: 'claude', sessionId: M }) },
      { paneId: 'w2:p1', agent: agentOf({ kind: 'claude', sessionId: M2 }) },
    ])
    // The other worker names *this* Dispatch: its id is not in this Dispatch's chain.
    const named = verifySender(state, { ...a!, caller: bgCaller(B2), observation: LIVE, chain: chainOf(M, B) }, 'reject')
    expect(named.ok === false && named.code).toBe('sender_mismatch')
    // A chain read from the other pane (minted M2) is not this attempt's chain, even though it holds the caller.
    const borrowed = verifySender(state, { ...a!, caller: bgCaller(B2), observation: LIVE, chain: chainOf(M2, B2) }, 'reject')
    expect(borrowed.ok === false && borrowed.code).toBe('sender_mismatch')
    // …and the other Dispatch still admits its own session.
    expect(verifySender(state, { ...other!, caller: bgCaller(B2), observation: LIVE, chain: chainOf(M2, B2) }, 'reject').ok).toBe(true)
  })

  it('(c) an attempt with no minted session → refused exactly as before (no chain is even wanted)', () => {
    for (const agent of [null, agentOf({ kind: 'claude', sessionId: null })]) {
      const { state, out: [a] } = attempts([{ paneId: PANE.paneId, agent }])
      const dispatch = findDispatch(state, a!.dispatchId)!
      expect(wantsSessionChain({ dispatch, caller: bgCaller(B) })).toBe(false)
      const verdict = verifySender(state, { ...a!, caller: bgCaller(B), observation: LIVE, chain: chainOf(M, B) }, 'reject')
      expect(verdict.ok === false && verdict.code).toBe('sender_mismatch')
    }
  })

  it('(d) a chain broken by /clear inside the background session (a new id, no continued-in) → sender_mismatch', () => {
    const { state, out: [a] } = attempts([{ paneId: PANE.paneId, agent: agentOf({ kind: 'claude', sessionId: M }) }])
    const cleared = randomUUID()   // P8: after /clear the session has a new id and `B` has no continued-in to it
    const verdict = verifySender(state, { ...a!, caller: bgCaller(cleared), observation: LIVE, chain: chainOf(M, B) }, 'reject')
    expect(verdict.ok === false && verdict.code).toBe('sender_mismatch')
  })

  it('(e) the Dispatch pane is gone → stale_dispatch, chain or not', () => {
    const { state, out: [a] } = attempts([{ paneId: PANE.paneId, agent: agentOf({ kind: 'claude', sessionId: M }) }])
    const verdict = verifySender(state, { ...a!, caller: bgCaller(B), observation: { kind: 'pane_gone' }, chain: chainOf(M, B) }, 'reject')
    expect(verdict.ok === false && verdict.code).toBe('stale_dispatch')
  })

  it('(f) a stopped attempt → capability_revoked, chain or not', () => {
    const { state, out: [a] } = attempts([{ paneId: PANE.paneId, agent: agentOf({ kind: 'claude', sessionId: M }) }])
    const entry = findDispatch(state, a!.dispatchId)!
    const stopped = replaceDispatchRecord(state, withWorker(entry, { capabilityRevokedAt: AT, capabilityRevokedReason: 'stopped' }, AT))
    const verdict = verifySender(stopped, { ...a!, caller: bgCaller(B), observation: LIVE, chain: chainOf(M, B) }, 'defer')
    expect(verdict.ok === false && verdict.code).toBe('capability_revoked')
  })

  it('(h) a caller that names no claude session, and a foreground worker in its own pane, are judged as before', () => {
    const { state, out: [a] } = attempts([{ paneId: PANE.paneId, agent: agentOf({ kind: 'claude', sessionId: M }) }])
    for (const claudeSession of [null, undefined, '']) {
      const caller: CallerClaim = { ...DAEMON_PANE, socketIsBackend: false, claudeSession }
      const verdict = verifySender(state, { ...a!, caller, observation: LIVE, chain: chainOf(M, B) }, 'reject')
      expect(verdict.ok === false && verdict.code).toBe('sender_mismatch')
    }
    const foreground = verifySender(state, { ...a!, caller: { ...PANE, claudeSession: M }, observation: LIVE, chain: null }, 'reject')
    expect(foreground.ok && [foreground.proof, foreground.sessionVerified]).toEqual(['pane', true])
    const dispatch = findDispatch(state, a!.dispatchId)!
    expect(wantsSessionChain({ dispatch, caller: { ...PANE, claudeSession: M } })).toBe(false)
  })

  it('(i) the chain is a claude proof only — a codex or grok attempt with a session id is refused', () => {
    for (const kind of ['codex', 'grok']) {
      const { state, out: [a] } = attempts([{ paneId: PANE.paneId, agent: agentOf({ kind, sessionId: M }) }])
      const dispatch = findDispatch(state, a!.dispatchId)!
      expect(wantsSessionChain({ dispatch, caller: bgCaller(M) })).toBe(false)
      expect(sessionChainProves({ dispatch, caller: bgCaller(M), chain: chainOf(M, B) })).toBe(false)
      const verdict = verifySender(state, { ...a!, caller: bgCaller(M), observation: LIVE, chain: chainOf(M, B) }, 'reject')
      expect(verdict.ok === false && verdict.code).toBe('sender_mismatch')
    }
  })
})

// --- module: send / ask over a real terminal module and a hand-written record chain -------------------

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
const userRow = (input: { body: string; session: string }) =>
  JSON.stringify({ type: 'user', origin: { kind: 'human' }, uuid: randomUUID(), sessionId: input.session, timestamp: new Date().toISOString(), message: { content: input.body } }) + '\n'
const metaRows = (session: string) => JSON.stringify({ type: 'ai-title', sessionId: session }) + '\n'
const continuedRow = (from: string, to: string) =>
  JSON.stringify({ type: 'continued-in', timestamp: new Date().toISOString(), sessionId: from, continuedInSessionId: to }) + '\n'

/**
 * Two claude panes corral launched, each with its own minted session that continued in a new file, and one
 * Task per pane. The worker body lands in the continued file, as it does after `←` (LIFE-771).
 */
function setup() {
  clearContinuedMemo()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l796-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'repo')
  fs.mkdirSync(cwd, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude')
  process.env.CORRAL_REGISTRY = path.join(dir, 'repos.json')
  process.env.CORRAL_BACKEND_SOCKET = path.join(dir, 'never-connected.sock')
  delete process.env.CORRAL_SESSION
  delete process.env.CORRAL_RUNTIME_SOCKET
  const gone = new Set<string>()
  const panes = ['w1:p1', 'w2:p1'].map(paneId => {
    const live: TerminalIdentity = { epoch: 'e', ptyId: `p-${paneId}`, paneId, tabId: 'tab', workspaceId: 'w', path: cwd, repo: cwd, title: 'l796' }
    const t0 = Date.now() - 1000, minted = randomUUID(), moved = randomUUID()
    const name = agentName(paneId)
    new AgentStore(dir).write(paneId, { epoch: 'e', ptyGeneration: live.ptyId, kind: 'claude', name, argv: ['claude'],
      requestedModel: null, requestedEffort: null, requestedAdvisor: null, sessionId: minted, sessionIdSource: 'client-minted',
      t0, launchDeadline: t0 + AGENT_START_TIMEOUT_MS, phase: 'ready', workingObserved: false, lastSubmission: null, updatedAt: Date.now() })
    const fileA = sessionRecordPaths('claude', { cwd, sessionId: minted, t0Ms: t0, nowMs: Date.now() })[0]!
    const fileB = path.join(path.dirname(fileA), `${moved}.jsonl`)
    fs.mkdirSync(path.dirname(fileA), { recursive: true })
    fs.writeFileSync(fileA, metaRows(minted) + userRow({ body: 'warm', session: minted }) + continuedRow(minted, moved))
    fs.writeFileSync(fileB, metaRows(moved))
    const token = new Tokens(dir).encode('t1', { runtimeId: 'runtime', epoch: 'e', ptyId: live.ptyId, paneId })
    return { live, minted, moved, fileB, token, name }
  })
  const infoOf = (paneId: string): AgentObservation => ({ name: agentName(paneId), kind: 'claude', status: 'idle', launchPending: false, interactiveReady: true,
    stateChangeSeq: 2, stateLabels: {}, session: null, paneId, observedAt: new Date().toISOString() })
  const manifests = AGENT_KINDS.map(agent => ({ agent, source_kind: EXPECTED_MANIFESTS[agent].sourceKind,
    active_version: EXPECTED_MANIFESTS[agent].version, local_override_shadowing_remote: false }))
  const deliver = (live: TerminalIdentity, text: string) => {
    const pane = panes.find(entry => entry.live.paneId === live.paneId)!
    fs.appendFileSync(pane.fileB, userRow({ body: text, session: pane.moved }))
  }
  const proto = TerminalBackend.prototype
  vi.spyOn(proto, 'epoch').mockImplementation(async () => 'e')
  vi.spyOn(proto, 'agentCapable').mockImplementation(() => true)
  const list = vi.spyOn(proto, 'list').mockImplementation(async () => panes.filter(entry => !gone.has(entry.live.paneId)).map(entry => entry.live))
  const agentInfo = vi.spyOn(proto, 'agentInfo').mockImplementation(async live => infoOf(live.paneId))
  vi.spyOn(proto, 'agentManifests').mockImplementation(async () => manifests)
  vi.spyOn(proto, 'read').mockImplementation(async () => ({ text: 'fixture', truncated: false, total: 7 }))
  vi.spyOn(proto, 'process').mockImplementation(async () => ({ shellPid: 123, foregroundGroupId: null, foreground: [{ pid: 456, name: 'claude', argv: null }] }))
  vi.spyOn(proto, 'send').mockImplementation(async () => undefined)
  vi.spyOn(proto, 'promptAgent').mockImplementation(async (live, text) => { deliver(live, text); return infoOf(live.paneId) })
  const screenRead = vi.spyOn(proto, 'screenRead').mockImplementation(async live => ({ text: '', input: { revision: 1, idleMs: 5000 }, anyInput: null, seq: infoOf(live.paneId).stateChangeSeq }))
  vi.spyOn(proto, 'sendFenced').mockImplementation(async () => ({ revision: 2, anyRevision: null }))
  vi.spyOn(proto, 'promptAgentIfQuiet').mockImplementation(async (live, input) => { deliver(live, input.text); return infoOf(live.paneId) })
  let state = createRun(emptyState(), 'l796', new Date().toISOString()).state
  const tasks: string[] = []
  for (const _ of panes) {
    const made = createTask(state, { runId: state.runs[0]!.id, spec: 'task body', title: null, deps: [], at: new Date().toISOString() })
    state = made.state; tasks.push(made.task.id)
  }
  new OrchestrationStore(dir).write(state)
  return { dir, cwd, panes, tasks, gone, spies: { list, agentInfo, screenRead } }
}
type Fixture = ReturnType<typeof setup>
async function call(f: Fixture, input: { command: string; flags: Record<string, string>; caller?: CallerClaim & { socket?: string | null } }, ms = 20000) {
  const { orchestrationModule } = await import('./index.js')
  const mod = orchestrationModule(f.dir)
  const ctx = { runtimeId: 'runtime', instanceId: 'instance', userData: f.dir, signal: new AbortController().signal, deadlineAt: Date.now() + ms, remote: false }
  const caller = input.caller === undefined ? undefined : { paneId: input.caller.paneId, session: input.caller.session, socket: input.caller.socket ?? null, claudeSession: input.caller.claudeSession ?? null }
  // The id is minted after the module: an id older than the runtime that judges it is refused as unknown.
  const flags = { ...input.flags, 'request-id': `r1.${Date.now()}.${randomUUID()}` }
  try { return asRecord(await mod.execute({ command: input.command, flags, args: [], cwd: f.cwd, caller }, ctx)) }
  catch (error) { if (error instanceof RuntimeError) return { error: error.code, message: error.message, resources: error.resources }; throw error }
}
async function started(f: Fixture) {
  const dispatches: string[] = []
  for (const [index, pane] of f.panes.entries()) {
    const out = await call(f, { command: 'orchestration worker-start', flags: { task: f.tasks[index]!, terminal: pane.token } })
    expect([out.state, out.error]).toEqual(['ready', undefined])
    dispatches.push(String(out.dispatchId))
  }
  return dispatches
}
/** What the background session's Bash call carries: the daemon's first pane and the user's socket, plus its own claude id. */
const fromBackground = (claudeSession: string) => ({ paneId: DAEMON_PANE.paneId, session: null, socket: '/somewhere/else/herdr.sock', claudeSession })
const report = (f: Fixture, input: { index: number; dispatchId: string; type: string; claudeSession: string }) => call(f, {
  command: 'orchestration send',
  caller: fromBackground(input.claudeSession),
  flags: { type: input.type, subject: 'l796', body: 'b', 'task-id': f.tasks[input.index]!, 'dispatch-id': input.dispatchId,
    ...(input.type === 'worker_done' ? { outcome: 'succeeded' } : {}) },
})

describe('LIFE-796 C3 합성 — send from a background session, through the real terminal chain', () => {
  it('admits heartbeat and worker_done from the continued session (proof session_chain), settles once, then illegal_transition (g)', async () => {
    const f = setup()
    const [first] = await started(f)
    const beat = await report(f, { index: 0, dispatchId: first!, type: 'heartbeat', claudeSession: f.panes[0]!.moved })
    expect([beat.error, beat.proof, beat.sessionVerified]).toEqual([undefined, 'session_chain', false])
    const done = await report(f, { index: 0, dispatchId: first!, type: 'worker_done', claudeSession: f.panes[0]!.moved })
    expect([done.error, done.proof, done.settledBy]).toEqual([undefined, 'session_chain', 'worker_done'])
    expect(asRecord(done.dispatch).status).toBe('completed')
    const again = await report(f, { index: 0, dispatchId: first!, type: 'worker_done', claudeSession: f.panes[0]!.moved })
    expect(again.error).toBe('illegal_transition')
  }, 60000)

  it('(a)(b) refuses a session outside the chain and the OTHER Dispatch\'s continued session — nothing stored', async () => {
    const f = setup()
    const [first, second] = await started(f)
    const before = fs.readFileSync(path.join(f.dir, 'runtime', 'orchestration', 'state.json'), 'utf8')
    for (const claudeSession of [randomUUID(), f.panes[1]!.moved, f.panes[1]!.minted]) {
      const out = await report(f, { index: 0, dispatchId: first!, type: 'worker_done', claudeSession })
      expect(out.error).toBe('sender_mismatch')
    }
    expect(fs.readFileSync(path.join(f.dir, 'runtime', 'orchestration', 'state.json'), 'utf8')).toBe(before)
    // The other Dispatch's own session is still admitted for that Dispatch.
    const own = await report(f, { index: 1, dispatchId: second!, type: 'heartbeat', claudeSession: f.panes[1]!.moved })
    expect(own.proof).toBe('session_chain')
  }, 60000)
})

describe('LIFE-796 fix1 B·C 합성 — the chain is read from the record, not from the pane', () => {
  it('(e) the Dispatch pane is gone: the background session still proves the chain, and the look answers stale_dispatch', async () => {
    const f = setup()
    const [first] = await started(f)
    f.gone.add(f.panes[0]!.live.paneId)   // the pane is closed after the session moved to the background
    const before = fs.readFileSync(path.join(f.dir, 'runtime', 'orchestration', 'state.json'), 'utf8')
    for (const type of ['heartbeat', 'worker_done']) {
      const out = await report(f, { index: 0, dispatchId: first!, type, claudeSession: f.panes[0]!.moved })
      expect([type, out.error, asRecord(out.resources).reason]).toEqual([type, 'stale_dispatch', 'pane_gone'])
    }
    // Without the chain the same call is the pane comparison's refusal — the (e) answer above is the chain's doing.
    const stranger = await report(f, { index: 0, dispatchId: first!, type: 'heartbeat', claudeSession: randomUUID() })
    expect(stranger.error).toBe('sender_mismatch')
    expect(fs.readFileSync(path.join(f.dir, 'runtime', 'orchestration', 'state.json'), 'utf8')).toBe(before)
  }, 60000)

  it('C: admitting on the chain takes no ready gate and no terminal show — only the one memoized pane sweep', async () => {
    const f = setup()
    const [first] = await started(f)
    for (const spy of Object.values(f.spies)) spy.mockClear()
    const beat = await report(f, { index: 0, dispatchId: first!, type: 'heartbeat', claudeSession: f.panes[0]!.moved })
    expect(beat.proof).toBe('session_chain')
    expect(f.spies.agentInfo).not.toHaveBeenCalled()
    expect(f.spies.screenRead).not.toHaveBeenCalled()
    expect(f.spies.list.mock.calls.length).toBeLessThanOrEqual(1)
  }, 60000)
})

describe('LIFE-796 fix1 B — the minted record is found by its id only when the answer is unique', () => {
  it('one file is the record; none, or the same id in two project folders, is no record (and so no chain)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l796-id-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    process.env.CLAUDE_CONFIG_DIR = dir
    const id = randomUUID()
    expect(claudeRecordById({ sessionId: id })).toBeNull()
    fs.mkdirSync(path.join(dir, 'projects', 'a'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'projects', 'a', `${id}.jsonl`), '')
    expect(claudeRecordById({ sessionId: id })).toBe(path.join(dir, 'projects', 'a', `${id}.jsonl`))
    fs.mkdirSync(path.join(dir, 'projects', 'b'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'projects', 'b', `${id}.jsonl`), '')
    expect(claudeRecordById({ sessionId: id })).toBeNull()
  })
})

describe('LIFE-796 C10 합성 — ask uses the same proof', () => {
  const ask = (f: Fixture, input: { index: number; dispatchId: string; claudeSession: string }) => call(f, {
    command: 'orchestration ask', caller: fromBackground(input.claudeSession),
    flags: { question: 'which?', 'task-id': f.tasks[input.index]!, 'dispatch-id': input.dispatchId, 'timeout-ms': '300' },
  })
  it('stores the question from the continued session (proof session_chain) and refuses (a) and (b)', async () => {
    const f = setup()
    const [first] = await started(f)
    expect((await ask(f, { index: 0, dispatchId: first!, claudeSession: randomUUID() })).error).toBe('sender_mismatch')
    expect((await ask(f, { index: 0, dispatchId: first!, claudeSession: f.panes[1]!.moved })).error).toBe('sender_mismatch')
    const pending = await ask(f, { index: 0, dispatchId: first!, claudeSession: f.panes[0]!.moved })
    expect([pending.error, pending.state, pending.proof, pending.sessionVerified]).toEqual([undefined, 'pending', 'session_chain', false])
  }, 60000)

  it('fix2 P: a gone Dispatch pane is stale_dispatch (pane_gone) for the background session, and the chain costs no ready gate or terminal show', async () => {
    const f = setup()
    const [first] = await started(f)
    for (const spy of Object.values(f.spies)) spy.mockClear()
    const pending = await ask(f, { index: 0, dispatchId: first!, claudeSession: f.panes[0]!.moved })
    expect(pending.proof).toBe('session_chain')
    expect(f.spies.agentInfo).not.toHaveBeenCalled()
    expect(f.spies.screenRead).not.toHaveBeenCalled()
    expect(f.spies.list.mock.calls.length).toBeLessThanOrEqual(1)
    f.gone.add(f.panes[0]!.live.paneId)
    const gone = await ask(f, { index: 0, dispatchId: first!, claudeSession: f.panes[0]!.moved })
    expect([gone.error, asRecord(gone.resources).reason]).toEqual(['stale_dispatch', 'pane_gone'])
  }, 60000)
})

describe('LIFE-796 fix2 N — a minted id that is not a session id shape gives no chain', () => {
  it('a stored minted id like `../<folder>/<id>` is not followed into a path, so the background caller is refused as before', async () => {
    const f = setup()
    const [first] = await started(f)
    const store = new OrchestrationStore(f.dir)
    const state = store.read()
    // 「합성」: a tampered snapshot. Joined into a path it would still land on the real minted file
    // (`projects/<any>/../<folder>/<id>.jsonl`), so without the shape guard the chain would admit the caller.
    const minted = f.panes[0]!.minted, folder = path.basename(path.dirname(f.panes[0]!.fileB))
    store.write({ ...state, dispatches: state.dispatches.map(entry => entry.id !== first || entry.agent === null ? entry
      : { ...entry, agent: { ...entry.agent, sessionId: `../${folder}/${minted}` } }) })
    const out = await report(f, { index: 0, dispatchId: first!, type: 'heartbeat', claudeSession: f.panes[0]!.moved })
    expect(out.error).toBe('sender_mismatch')
  }, 60000)
})
