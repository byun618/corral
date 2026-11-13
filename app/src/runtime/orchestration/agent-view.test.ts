/**
 * LIFE-787 C3 — `worker-start` on a claude pane showing agent view.
 *
 * 「합성」: worker-start runs the real `terminal` module as its child, only the herdr guard is a stub
 * (it keeps an input revision and refuses a stale one, as herdr-guard.patch does), and the screens
 * are LIFE-770's real 2.1.296 samples. It proves the order — the judgment comes before the lead line —
 * and that the refused attempt resumes into one lead and one body; not what Claude Code would do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchestrationStore } from './store.js'
import { createRun, createTask, emptyState } from './model.js'
import { TerminalBackend, type AgentObservation, type TerminalIdentity } from '../../main/adapter/index.js'
import { AGENT_KINDS, AGENT_START_TIMEOUT_MS, AgentStore, EXPECTED_MANIFESTS, PROMPT_LEAD, agentName, sessionRecordPaths } from '../terminal/agent.js'
import { Tokens } from '../terminal/tokens.js'
import { RuntimeError } from '../contracts.js'
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
const sample = (name: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'main', 'fixtures', 'agent-view', `${name}.ansi`), 'utf8')

function setup() {
  clearContinuedMemo()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l787-orch-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'repo')
  fs.mkdirSync(cwd, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude')
  process.env.CORRAL_REGISTRY = path.join(dir, 'repos.json')
  process.env.CORRAL_BACKEND_SOCKET = path.join(dir, 'never-connected.sock')
  delete process.env.CORRAL_SESSION
  delete process.env.CORRAL_RUNTIME_SOCKET
  const live: TerminalIdentity = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 'tab', workspaceId: 'w', path: cwd, repo: cwd, title: 'l787' }
  const info: AgentObservation = { name: agentName('pane'), kind: 'claude', status: 'idle', launchPending: false, interactiveReady: true,
    stateChangeSeq: 2, stateLabels: {}, session: null, paneId: 'pane', observedAt: new Date().toISOString() }
  const writes: string[] = []
  const state = { screen: sample('view-default'), revision: 3, writes, afterLead: () => {}, file: '' }
  const fence = (expected: number) => {
    if (expected !== state.revision) throw new RuntimeError('input_changed', 'pane input moved since corral observed it', undefined, 'backend', 'not_started')
  }
  const proto = TerminalBackend.prototype
  vi.spyOn(proto, 'epoch').mockImplementation(async () => 'e')
  vi.spyOn(proto, 'agentCapable').mockImplementation(() => true)
  vi.spyOn(proto, 'list').mockImplementation(async () => [live])
  vi.spyOn(proto, 'agentInfo').mockImplementation(async () => ({ ...info, terminalTitle: 'L787-C' }))
  vi.spyOn(proto, 'agentManifests').mockImplementation(async () => AGENT_KINDS.map(agent => ({ agent, source_kind: EXPECTED_MANIFESTS[agent].sourceKind,
    active_version: EXPECTED_MANIFESTS[agent].version, local_override_shadowing_remote: false })))
  vi.spyOn(proto, 'read').mockImplementation(async () => ({ text: 'fixture', truncated: false, total: 7 }))
  vi.spyOn(proto, 'process').mockImplementation(async () => ({ shellPid: 123, foregroundGroupId: null, foreground: [{ pid: 456, name: 'claude', argv: null }] }))
  vi.spyOn(proto, 'screenRead').mockImplementation(async () => ({ text: state.screen, input: { revision: state.revision, idleMs: 5000 }, anyInput: null, seq: info.stateChangeSeq }))
  const writers = [
    vi.spyOn(proto, 'send').mockImplementation(async (_live, text) => { state.writes.push(text) }),
    vi.spyOn(proto, 'sendIfUnchanged').mockImplementation(async (_live, text) => { state.writes.push(text) }),
    vi.spyOn(proto, 'sendFenced').mockImplementation(async (_live, input) => {
      fence(input.inputRevision); state.writes.push(input.text); state.revision++; state.afterLead(); return { revision: state.revision, anyRevision: null }
    }),
    vi.spyOn(proto, 'promptAgent').mockImplementation(async (_live, text) => { state.writes.push(text); return info }),
    vi.spyOn(proto, 'promptAgentIfQuiet').mockImplementation(async (_live, input) => {
      fence(input.inputRevision); state.writes.push(input.text); state.revision++
      // The provider records the body in the minted session file, as Claude Code does.
      fs.appendFileSync(state.file, JSON.stringify({ type: 'user', origin: { kind: 'human' }, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { content: input.text } }) + '\n')
      return info
    }),
  ]
  const t0 = Date.now() - 1000, sessionId = randomUUID()
  new AgentStore(dir).write('pane', { epoch: 'e', ptyGeneration: 'p', kind: 'claude', name: info.name!, argv: ['claude'],
    requestedModel: null, requestedEffort: null, requestedAdvisor: null, sessionId, sessionIdSource: 'client-minted',
    t0, launchDeadline: t0 + AGENT_START_TIMEOUT_MS, phase: 'ready', workingObserved: false, lastSubmission: null, updatedAt: Date.now() })
  state.file = sessionRecordPaths('claude', { cwd, sessionId, t0Ms: t0, nowMs: Date.now() })[0]!
  fs.mkdirSync(path.dirname(state.file), { recursive: true })
  fs.writeFileSync(state.file, '')
  const token = new Tokens(dir).encode('t1', { runtimeId: 'runtime', epoch: 'e', ptyId: 'p', paneId: 'pane' })
  const run = createRun(emptyState(), 'l787', new Date().toISOString())
  const made = createTask(run.state, { runId: run.run.id, spec: 'Reply with exactly: L787-C and do nothing else.', title: null, deps: [], at: new Date().toISOString() })
  const store = new OrchestrationStore(dir)
  store.write(made.state)
  const writeCalls = () => writers.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
  return { dir, cwd, store, token, task: made.task.id, state, writeCalls }
}
async function workerStart(f: ReturnType<typeof setup>, ms = 20000) {
  const { orchestrationModule } = await import('./index.js')
  const ctx = { runtimeId: 'runtime', instanceId: 'instance', userData: f.dir, signal: new AbortController().signal, deadlineAt: Date.now() + ms, remote: false }
  return asRecord(await orchestrationModule(f.dir).execute({ command: 'orchestration worker-start',
    flags: { task: f.task, terminal: f.token, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: f.cwd, caller: undefined }, ctx))
}
const claims = (f: ReturnType<typeof setup>) => {
  const worker = f.store.read().dispatches[0]?.worker ?? null
  return { lead: worker?.lead ?? null, prompt: worker?.prompt ?? null }
}

describe('LIFE-787 C3 합성 — worker-start 가 agent view pane 에 리드 줄도 치지 않는다', () => {
  it('ⓐ K3: 넣기 0, incomplete · dispatch_input · agent_view, claim 남지 않음 → ⓑ esc 뒤 같은 Task 재호출이 같은 시도로 재개해 리드 1 · 본문 1', async () => {
    const f = setup()
    const first = await workerStart(f)
    expect([first.state, first.stage]).toEqual(['incomplete', 'dispatch_input'])
    expect(asRecord(asRecord(first.stages).input)).toMatchObject({ status: 'failed', error: 'agent_view', lead: 'released' })
    expect(f.writeCalls()).toBe(0)
    expect(claims(f)).toEqual({ lead: null, prompt: null })
    const residuals = first.residualResources
    const residual = Array.isArray(residuals) ? residuals.map(asRecord).find(entry => entry.kind === 'dispatch') : undefined
    expect(String(residual?.action)).toContain('press esc')
    const dispatchId = first.dispatchId

    f.state.screen = sample('normal-named-empty')
    const second = await workerStart(f)
    expect([second.state, second.launch, second.dispatchId]).toEqual(['ready', 'resumed', dispatchId])
    expect(f.state.writes.filter(text => text === PROMPT_LEAD)).toHaveLength(1)
    expect(f.state.writes).toHaveLength(2)
    expect(f.state.writes[0]).toBe(PROMPT_LEAD)
  }, 60000)

  it('ⓒ K4: 리드 claim 이 있는 재개에서 agent view → 본문 단계 거절로 incomplete, 재개하면 리드 없이 본문 1', async () => {
    const f = setup()
    f.state.screen = sample('normal-named-empty')
    // The lead lands, then the person presses ← before the body.
    f.state.afterLead = () => { f.state.screen = sample('view-default') }
    const first = await workerStart(f)
    expect([first.state, first.stage]).toEqual(['incomplete', 'dispatch_input'])
    expect(asRecord(asRecord(first.stages).input)).toMatchObject({ status: 'failed', error: 'agent_view', submission: 'released' })
    expect(f.state.writes).toEqual([PROMPT_LEAD])
    expect(claims(f).lead).not.toBe(null)
    expect(claims(f).prompt).toBe(null)

    f.state.afterLead = () => {}
    f.state.screen = sample('normal-named-empty')
    const second = await workerStart(f)
    expect([second.state, second.launch, second.dispatchId]).toEqual(['ready', 'resumed', first.dispatchId])
    expect(f.state.writes.filter(text => text === PROMPT_LEAD)).toHaveLength(1)
    expect(f.state.writes).toHaveLength(2)
  }, 60000)
})
