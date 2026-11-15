/**
 * LIFE-771 C2 — `worker-start --terminal` on a claude pane whose session moved to the background.
 *
 * 「합성」: no terminal mock here. worker-start runs the real `terminal` module as its child
 * (`terminalChild` → `terminal prompt`), only the herdr backend is stubbed, and the provider record
 * is a hand-written chain in the shape the coordinator measured on Claude Code 2.1.296 (LIFE-771
 * analysis): the minted file ends with `continued-in`, the new file holds meta rows
 * until its first input, and that input copies the old rows in with their `uuid`. It proves that the
 * child's answer over that chain reaches worker-start's verdict, not that Claude Code writes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchestrationStore } from './store.js'
import { createRun, createTask, emptyState } from './model.js'
import { TerminalBackend, type AgentObservation, type TerminalIdentity } from '../../main/adapter/index.js'
import { AGENT_KINDS, AGENT_START_TIMEOUT_MS, AgentStore, EXPECTED_MANIFESTS, agentName, sessionRecordPaths } from '../terminal/agent.js'
import { Tokens } from '../terminal/tokens.js'
import { clearContinuedMemo } from '../../main/transcript-continued.js'
import { isRecord } from '../../shared/json.js'

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
const userRow = (input: { body: string; at: string; uuid: string; session: string }) =>
  JSON.stringify({ type: 'user', origin: { kind: 'human' }, uuid: input.uuid, sessionId: input.session, timestamp: input.at, message: { content: input.body } }) + '\n'
const metaRows = (session: string) => ['ai-title', 'agent-name'].map(type => JSON.stringify({ type, sessionId: session }) + '\n').join('')
const continuedRow = (from: string, to: string) =>
  JSON.stringify({ type: 'continued-in', timestamp: new Date().toISOString(), sessionId: from, continuedInSessionId: to }) + '\n'

/** One claude pane corral launched, a Run with one Task, and a backend whose answers the test owns. */
function setup() {
  clearContinuedMemo()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l771-orch-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'repo')
  fs.mkdirSync(cwd, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude')
  process.env.CORRAL_REGISTRY = path.join(dir, 'repos.json')
  process.env.CORRAL_BACKEND_SOCKET = path.join(dir, 'never-connected.sock')
  delete process.env.CORRAL_SESSION
  delete process.env.CORRAL_RUNTIME_SOCKET
  const live: TerminalIdentity = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 'tab', workspaceId: 'w', path: cwd, repo: cwd, title: 'l771' }
  const info: AgentObservation = { name: agentName('pane'), kind: 'claude', status: 'idle', launchPending: false, interactiveReady: true,
    stateChangeSeq: 2, stateLabels: {}, session: null, paneId: 'pane', observedAt: new Date().toISOString() }
  const manifests = AGENT_KINDS.map(agent => ({ agent, source_kind: EXPECTED_MANIFESTS[agent].sourceKind,
    active_version: EXPECTED_MANIFESTS[agent].version, local_override_shadowing_remote: false }))
  const state: { onPrompt: (text: string) => void } = { onPrompt: () => {} }
  const proto = TerminalBackend.prototype
  vi.spyOn(proto, 'epoch').mockImplementation(async () => 'e')
  vi.spyOn(proto, 'agentCapable').mockImplementation(() => true)
  vi.spyOn(proto, 'list').mockImplementation(async () => [live])
  vi.spyOn(proto, 'agentInfo').mockImplementation(async () => info)
  vi.spyOn(proto, 'agentManifests').mockImplementation(async () => manifests)
  vi.spyOn(proto, 'read').mockImplementation(async () => ({ text: 'fixture', truncated: false, total: 7 }))
  vi.spyOn(proto, 'process').mockImplementation(async () => ({ shellPid: 123, foregroundGroupId: null, foreground: [{ pid: 456, name: 'claude', argv: null }] }))
  vi.spyOn(proto, 'send').mockImplementation(async () => undefined)
  vi.spyOn(proto, 'promptAgent').mockImplementation(async (_live, text) => { state.onPrompt(text); return info })
  const t0 = Date.now() - 1000, a = randomUUID()
  new AgentStore(dir).write('pane', { epoch: 'e', ptyGeneration: 'p', kind: 'claude', name: info.name!, argv: ['claude'],
    requestedModel: null, requestedEffort: null, requestedAdvisor: null, sessionId: a, sessionIdSource: 'client-minted',
    t0, launchDeadline: t0 + AGENT_START_TIMEOUT_MS, phase: 'ready', workingObserved: false, lastSubmission: null, updatedAt: Date.now() })
  const token = new Tokens(dir).encode('t1', { runtimeId: 'runtime', epoch: 'e', ptyId: 'p', paneId: 'pane' })
  const run = createRun(emptyState(), 'l771', new Date().toISOString())
  const made = createTask(run.state, { runId: run.run.id, spec: 'task body', title: null, deps: [], at: new Date().toISOString() })
  const store = new OrchestrationStore(dir)
  store.write(made.state)
  const fileA = sessionRecordPaths('claude', { cwd, sessionId: a, t0Ms: t0, nowMs: Date.now() })[0]!
  const b = randomUUID(), fileB = path.join(path.dirname(fileA), `${b}.jsonl`)
  fs.mkdirSync(path.dirname(fileA), { recursive: true })
  return { dir, cwd, store, token, task: made.task.id, state, info, a, b, fileA, fileB }
}
async function workerStart(f: ReturnType<typeof setup>, ms = 20000) {
  const { orchestrationModule } = await import('./index.js')
  const mod = orchestrationModule(f.dir)
  const ctx = { runtimeId: 'runtime', instanceId: 'instance', userData: f.dir, signal: new AbortController().signal, deadlineAt: Date.now() + ms, remote: false }
  return asRecord(await mod.execute({ command: 'orchestration worker-start',
    flags: { task: f.task, terminal: f.token, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: f.cwd, caller: undefined }, ctx))
}
/** Drop the claim record so the next worker-start meets the duplicate pre-check (as in admission V23). */
const forgetTheSubmission = (store: OrchestrationStore): void => {
  const current = store.read()
  store.write({ ...current, dispatches: current.dispatches.map(entry =>
    entry.worker === null ? entry : { ...entry, worker: { ...entry.worker, prompt: null } }) })
}
const past = () => new Date(Date.now() - 60_000).toISOString()

describe('LIFE-771 C2 합성 — worker-start on a pane whose claude session continued in a new file', () => {
  it('E2 꼴: the dispatch body lands in the continued file and worker-start calls the input delivered', async () => {
    const f = setup()
    const original = { body: 'Reply with exactly: before', at: past(), uuid: randomUUID(), session: f.a }
    fs.writeFileSync(f.fileA, metaRows(f.a) + userRow(original) + continuedRow(f.a, f.b))
    fs.writeFileSync(f.fileB, metaRows(f.b))
    f.state.onPrompt = text => fs.appendFileSync(f.fileB, userRow({ ...original, session: f.b })
      + userRow({ body: text, at: new Date().toISOString(), uuid: randomUUID(), session: f.b }))
    const started = await workerStart(f)
    expect(started.state).toBe('ready')
    expect(asRecord(asRecord(started.stages).input)).toMatchObject({ status: 'completed' })
    expect(asRecord(asRecord(started.input).record)).toMatchObject({ path: f.fileB, matchCount: 1, unavailableReason: null })
  }, 30000)

  it('E4 꼴: a body already in the minted file and copied into the continued one is one match — already_present, not duplicate_submissions', async () => {
    const f = setup()
    fs.writeFileSync(f.fileA, metaRows(f.a))
    let body = ''
    // First start: no move yet, the body lands in the minted file — stamped before the submit
    // second, so this run's own count cannot confirm it — and the pane shows a blocking screen right
    // after the submit, so the confirm loop ends on `agent_blocked` at once instead of waiting out a
    // deadline (r2 D2: no wall-clock bound decides the stage). The attempt stays open (resumable).
    f.state.onPrompt = text => {
      body = text
      fs.appendFileSync(f.fileA, userRow({ body: text, at: past(), uuid: 'dispatch-row', session: f.a }))
      f.info.status = 'blocked'
    }
    const first = await workerStart(f)
    expect([first.state, first.stage]).toEqual(['incomplete', 'dispatch_input_unconfirmed'])
    f.info.status = 'idle'
    // Then the session moves and the new file's first input copies that row in (same uuid).
    const copied = fs.readFileSync(f.fileA, 'utf8').split('\n').filter(line => line.includes('"dispatch-row"'))[0]!
    fs.appendFileSync(f.fileA, continuedRow(f.a, f.b))
    fs.writeFileSync(f.fileB, metaRows(f.b) + copied.replace(f.a, f.b) + '\n')
    forgetTheSubmission(f.store)
    let submitted = 0
    f.state.onPrompt = () => { submitted++ }
    const second = await workerStart(f)
    expect(body).not.toBe('')
    expect(submitted).toBe(0)
    expect(second.state).toBe('ready')
    expect(asRecord(asRecord(second.stages).input).delivery).toBe('already_present')
    expect(asRecord(second.input).matchCount).toBe(1)
  }, 30000)
})
