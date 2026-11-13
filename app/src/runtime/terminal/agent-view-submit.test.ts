/**
 * LIFE-787 C2 — where the agent-view refusal sits in a submission, and what it fences.
 *
 * 「합성」: the herdr guard is a stub that answers from state this file owns, and the screens are the
 * LIFE-770 real 2.1.296 samples (`main/fixtures/agent-view/`). These tests prove the order of calls
 * and the shape of the refusal — that on agent view nothing reaches a write, that a revision moved
 * between the judged screen and the write is refused, and that an ordinary submission keeps its
 * shape. They do not prove Claude Code would have opened a new session: that is the live run (C5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { terminalModule } from './index.js'
import { Tokens } from './tokens.js'
import { AGENT_KINDS, AGENT_START_TIMEOUT_MS, AgentStore, EXPECTED_MANIFESTS, agentName, mintsSessionId, type AgentKind } from './agent.js'
import { workspaceModule } from '../workspace/index.js'
import { RuntimeError, type CommandContext } from '../contracts.js'
import { TerminalBackend, type AgentObservation, type TerminalIdentity } from '../../main/adapter/index.js'
import { isRecord } from '../../shared/json.js'
import { mapAgentStages } from '../../main/work/start.js'
import { INPUT_TIMING } from '../../main/mobile/input.js'

const cleanups: (() => void)[] = []
const previous = { ...process.env }
afterEach(() => {
  vi.restoreAllMocks()
  for (const fn of cleanups.splice(0).reverse()) fn()
  process.env = { ...previous }
})
const asObject = (value: unknown): Record<string, unknown> => { if (!isRecord(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`); return value }
const sample = (name: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'main', 'fixtures', 'agent-view', `${name}.ansi`), 'utf8')
const NORMAL = 'normal-named-empty'
const VIEW_TITLE = '6 awaiting input · claude agents'

/** One pane with a recorded agent, and a guard stub that keeps an input revision the way herdr's does. */
function setup(kind: AgentKind, options: { git?: boolean } = {}) {
  delete process.env.CORRAL_RUNTIME_SOCKET; delete process.env.CORRAL_SESSION
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l787-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const data = path.join(dir, 'data'), cwd = path.join(dir, 'repo')
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(cwd, { recursive: true })
  for (const [name, sub] of [['CLAUDE_CONFIG_DIR', 'claude'], ['CODEX_HOME', 'codex'], ['GROK_HOME', 'grok']] as const) process.env[name] = path.join(dir, sub)
  process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
  process.env.CORRAL_BACKEND_SOCKET = path.join(dir, 'never-connected.sock')
  if (options.git) {
    for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    }
  }
  const live: TerminalIdentity = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 'tab', workspaceId: 'w', path: cwd, repo: cwd, title: 'l787' }
  const title: string | null = 'L787-A', writes: string[] = []
  const state = {
    screen: sample(NORMAL), title, revision: 7,
    /** Runs inside `agent.get` — after the screen was read, before the write: where a human's `←` would land. */
    onAgentGet: () => {},
    writes,
    info: { name: agentName('pane'), kind, status: 'idle', launchPending: false, interactiveReady: true, stateChangeSeq: 2, stateLabels: {},
      session: null, paneId: 'pane', observedAt: new Date().toISOString() } satisfies AgentObservation,
  }
  const guardFence = (expected: number) => {
    if (expected !== state.revision) throw new RuntimeError('input_changed', 'pane input moved since corral observed it', undefined, 'backend', 'not_started')
  }
  const proto = TerminalBackend.prototype
  const spies = {
    screenRead: vi.spyOn(proto, 'screenRead').mockImplementation(async () => ({ text: state.screen, input: { revision: state.revision, idleMs: 5000 }, anyInput: null, seq: state.info.stateChangeSeq })),
    promptAgent: vi.spyOn(proto, 'promptAgent').mockImplementation(async (_live, text) => { state.writes.push(text); return state.info }),
    promptAgentIfQuiet: vi.spyOn(proto, 'promptAgentIfQuiet').mockImplementation(async (_live, input) => { guardFence(input.inputRevision); state.writes.push(input.text); state.revision++; return state.info }),
    send: vi.spyOn(proto, 'send').mockImplementation(async (_live, text) => { state.writes.push(text) }),
    sendFenced: vi.spyOn(proto, 'sendFenced').mockImplementation(async (_live, input) => { guardFence(input.inputRevision); state.writes.push(input.text); return { revision: ++state.revision, anyRevision: null } }),
    sendIfUnchanged: vi.spyOn(proto, 'sendIfUnchanged').mockImplementation(async (_live, text) => { state.writes.push(text) }),
  }
  vi.spyOn(proto, 'epoch').mockImplementation(async () => 'e')
  vi.spyOn(proto, 'agentCapable').mockImplementation(() => true)
  vi.spyOn(proto, 'list').mockImplementation(async () => [live])
  vi.spyOn(proto, 'create').mockImplementation(async () => live)
  vi.spyOn(proto, 'agentInfo').mockImplementation(async () => { state.onAgentGet(); return { ...state.info, terminalTitle: state.title } })
  vi.spyOn(proto, 'agentManifests').mockImplementation(async () => AGENT_KINDS.map(agent => ({ agent, source_kind: EXPECTED_MANIFESTS[agent].sourceKind,
    active_version: EXPECTED_MANIFESTS[agent].version, local_override_shadowing_remote: false })))
  vi.spyOn(proto, 'read').mockImplementation(async () => ({ text: 'fixture', truncated: false, total: 7 }))
  vi.spyOn(proto, 'process').mockImplementation(async () => ({ shellPid: 123, foregroundGroupId: null, foreground: [{ pid: 456, name: kind, argv: null }] }))
  vi.spyOn(proto, 'startAgent').mockImplementation(async () => ({ agent: state.info, argv: [] }))
  const t0 = Date.now() - 1000, store = new AgentStore(data), sessionId = mintsSessionId(kind) ? randomUUID() : null
  store.write('pane', { epoch: 'e', ptyGeneration: 'p', kind, name: state.info.name, argv: [kind], requestedModel: null, requestedEffort: null, requestedAdvisor: null,
    sessionId, sessionIdSource: sessionId === null ? null : 'client-minted', t0, launchDeadline: t0 + AGENT_START_TIMEOUT_MS,
    phase: 'ready', workingObserved: false, lastSubmission: null, updatedAt: Date.now() })
  const token = new Tokens(data).encode('t1', { runtimeId: 'test', epoch: 'e', ptyId: 'p', paneId: 'pane' })
  const terminal = terminalModule(data)
  const context = (ms: number): CommandContext => ({ runtimeId: 'test', instanceId: 'test', userData: data, signal: new AbortController().signal, remote: false, deadlineAt: Date.now() + ms })
  const prompt = (requestId = `r1.${Date.now()}.${randomUUID()}`) => terminal.execute({ command: 'terminal prompt',
    flags: { terminal: token, text: 'Reply with exactly: L787', 'request-id': requestId }, args: [], cwd }, context(6000))
  /** Every arm that puts bytes into the pane. */
  const writeCalls = () => Object.values(spies).filter(spy => spy !== spies.screenRead).reduce((sum, spy) => sum + spy.mock.calls.length, 0)
  return { data, cwd, live, state, spies, store, token, terminal, context, prompt, writeCalls }
}
/** The refusal and its own resources — `Receipts.run` re-wraps them under `detail`. */
const refusal = async (promise: Promise<unknown>): Promise<RuntimeError> => {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  if (!(error instanceof RuntimeError)) throw new Error(`expected a RuntimeError, got ${String(error)}`)
  return error
}

const detail = (error: RuntimeError): Record<string, unknown> => asObject(asObject(error.resources).detail)

describe('C2ⓐ 합성 — agent view 면 넣기 0, agent_view · not_started · preflight', () => {
  it.each([['K1 자기 행 선택', 'view-default'], ['K2ⓐ ↓ 다른 행', 'view-down'], ['K2ⓑ ? 안내표', 'view-help'], ['K2ⓒ Space 패널', 'view-peek']])('%s (%s)', async (_label, name) => {
    const f = setup('claude')
    f.state.screen = sample(name)
    const error = await refusal(f.prompt())
    expect([error.code, error.outcome, error.stage]).toEqual(['agent_view', 'not_started', 'preflight'])
    expect(asObject(detail(error).agentView).marks).toEqual(['screen'])
    expect(String(detail(error).recovery)).toContain('esc')
    expect(error.message).toContain('esc')
    expect(f.writeCalls()).toBe(0)
    // Nothing for this submission reached the record either — no pre-effect cursor, no request id.
    expect(f.store.read('pane', 'e', 'p')?.lastSubmission).toBe(null)
  }, 20000)

  it('K1 제목만(화면은 일반) — title 로 거절', async () => {
    const f = setup('claude')
    f.state.title = VIEW_TITLE
    const error = await refusal(f.prompt())
    expect(error.code).toBe('agent_view')
    expect(detail(error).agentView).toEqual({ marks: ['title'], title: VIEW_TITLE })
    expect(f.writeCalls()).toBe(0)
  }, 20000)

  it('같은 --request-id 가 esc 뒤에 다시 쓰인다(거절이 id 를 쓰지 않는다)', async () => {
    const f = setup('claude')
    f.state.screen = sample('view-default'); f.state.title = VIEW_TITLE
    const id = `r1.${Date.now()}.${randomUUID()}`
    expect((await refusal(f.prompt(id))).code).toBe('agent_view')
    f.state.screen = sample(NORMAL); f.state.title = 'L787-A'
    const result = asObject(await f.prompt(id))
    expect([result.stage, result.outcome]).toEqual(['submitted', 'queued'])
    expect(f.state.writes).toEqual(['Reply with exactly: L787'])
  }, 20000)
})

describe('C2ⓑ 합성 — 판정 화면의 입력 revision 이 넣기 때 다르면 넣지 않는다 (K8)', () => {
  it('판정 뒤 사람이 ← 를 누름(revision +1) → input_changed · not_started, 넣기 0, 기록 원상', async () => {
    const f = setup('claude')
    // The screen corral judged is the ordinary prompt; the key arrives after it, before the write.
    f.state.onAgentGet = () => { if (f.spies.screenRead.mock.calls.length === 1 && f.state.revision === 7) { f.state.revision++; f.state.screen = sample('view-default') } }
    const error = await refusal(f.prompt())
    expect([error.code, error.outcome, error.stage]).toEqual(['input_changed', 'not_started', 'preflight'])
    expect(detail(error).guard).toBe('input_changed')
    expect(f.spies.promptAgentIfQuiet).toHaveBeenCalledTimes(1)
    expect(f.spies.promptAgentIfQuiet.mock.calls[0]![1]).toMatchObject({ inputRevision: 7, minIdleMs: INPUT_TIMING.quietMs, expectedStateChangeSeq: 2 })
    expect(f.state.writes).toEqual([])
    expect(f.store.read('pane', 'e', 'p')?.lastSubmission).toBe(null)
    // The next try reads the screen as it is now — agent view — and refuses for that.
    f.state.onAgentGet = () => {}
    expect((await refusal(f.prompt())).code).toBe('agent_view')
    expect(f.state.writes).toEqual([])
  }, 20000)
})

describe('C2ⓒ 합성 — 일반 프롬프트 (K0) 는 그대로', () => {
  it('넣기 정확히 1회, 결과 모양 그대로(queued)', async () => {
    const f = setup('claude')
    const result = asObject(await f.prompt())
    expect(f.state.writes).toEqual(['Reply with exactly: L787'])
    expect(f.writeCalls()).toBe(1)
    // `requestId`·`replayed` are the receipt's (`Receipts.run`), as before.
    expect(Object.keys(result).sort()).toEqual(['agent', 'delivery', 'outcome', 'record', 'replayed', 'requestId', 'stage', 'terminal'])
    expect([result.stage, result.outcome, result.record]).toEqual(['submitted', 'queued', null])
    expect(Object.keys(asObject(result.delivery)).sort()).toEqual(['bytes', 'cursor', 'lines', 'screen', 'sha256', 'submittedAt'])
  }, 20000)
  it('입력 revision 을 주지 않는 guard 는 판정만 하고 seq 울타리로 넣는다', async () => {
    const f = setup('claude')
    f.spies.screenRead.mockImplementation(async () => ({ text: f.state.screen, input: null, anyInput: null, seq: null }))
    await f.prompt()
    expect([f.spies.promptAgent.mock.calls.length, f.spies.promptAgentIfQuiet.mock.calls.length]).toEqual([1, 0])
    f.state.screen = sample('view-default')
    expect((await refusal(f.prompt())).code).toBe('agent_view')
    expect(f.spies.promptAgent).toHaveBeenCalledTimes(1)
  }, 20000)
})

describe('C2ⓓ 합성 — codex·grok pane (K7)', () => {
  it.each(['codex', 'grok'] as const)('%s: agent view 화면·제목이어도 화면을 읽지 않고 예전처럼 넣는다', async kind => {
    const f = setup(kind)
    f.state.screen = sample('view-default'); f.state.title = VIEW_TITLE
    const result = asObject(await f.prompt())
    expect(result.outcome).toBe('queued')
    expect(f.spies.screenRead).not.toHaveBeenCalled()
    expect([f.spies.promptAgent.mock.calls.length, f.spies.promptAgentIfQuiet.mock.calls.length]).toEqual([1, 0])
  }, 20000)
})

describe('C2ⓔ 합성 — terminal create --agent claude --prompt (K5)', () => {
  it('agent view 면 prompt stage 에 agent_view 가 실리고 넣기 0; GUI 모달은 failed · agent_view 로 런타임 문구를 그대로 보인다', async () => {
    const f = setup('claude', { git: true })
    await workspaceModule(f.data).execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
    f.state.screen = sample('view-default')
    const created = asObject(await f.terminal.execute({ command: 'terminal create',
      flags: { worktree: f.cwd, agent: 'claude', prompt: 'Reply with exactly: L787', 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: f.cwd }, f.context(14000)))
    const stage = asObject(asObject(created.stages).prompt)
    expect([created.stage, stage.status, stage.error]).toEqual(['agent_started', 'failed', 'agent_view'])
    expect(f.writeCalls()).toBe(0)
    // C10ⓓ: `PROMPT_REASON` has no entry for a `failed` stage; the modal shows the runtime's message.
    const modal = mapAgentStages({ stages: { worktree: { status: 'completed' }, terminal: { status: 'completed' }, agent: { status: 'completed' }, prompt: stage } }).stages.prompt
    expect([modal.status, modal.code]).toEqual(['failed', 'agent_view'])
    expect(modal.message).toContain('agent view')
  }, 30000)
  it('양성 대조: 같은 create 가 일반 프롬프트면 넣는다', async () => {
    const f = setup('claude', { git: true })
    await workspaceModule(f.data).execute({ command: 'repo add', flags: { path: f.cwd }, args: [], cwd: f.cwd }, f.context(8000))
    const created = asObject(await f.terminal.execute({ command: 'terminal create',
      flags: { worktree: f.cwd, agent: 'claude', prompt: 'Reply with exactly: L787', 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: f.cwd }, f.context(14000)))
    expect([created.stage, asObject(asObject(created.stages).prompt).status]).toEqual(['agent_prompted', 'queued'])
    expect(f.state.writes).toEqual(['Reply with exactly: L787'])
  }, 30000)
})

describe('합성 — terminal send 는 CLI 에서 그대로, 내부 refuse-agent-view 만 판정한다 (E9)', () => {
  it('플래그 없는 send 는 agent view 에서도 화면을 읽지 않고 쓴다', async () => {
    const f = setup('claude')
    f.state.screen = sample('view-default')
    await f.terminal.execute({ command: 'terminal send', flags: { terminal: f.token, text: 'raw' }, args: [], cwd: f.cwd }, f.context(4000))
    expect(f.spies.screenRead).not.toHaveBeenCalled()
    expect([f.spies.send.mock.calls.length, f.state.writes]).toEqual([1, ['raw']])
  }, 20000)
})

// --- fix1 (리뷰 r1 A·B·C·D·F) ---------------------------------------------------------------

describe('fix1 A 합성 — 판정 화면은 입력이 quiet(폰 quietMs) 이상 조용할 때만 믿는다', () => {
  it('읽기 전 ←: revision 은 이미 올랐고 화면은 아직 예전(에코 전) → 남은 만큼 기다려 다시 읽고 agent_view, 넣기 0', async () => {
    const f = setup('claude')
    const reads: number[] = []
    // The key went in 100 ms before the first read; Claude draws agent view by the second read.
    f.spies.screenRead.mockImplementation(async () => {
      reads.push(Date.now())
      const first = reads.length === 1
      return { text: sample(first ? NORMAL : 'view-default'), input: { revision: 8, idleMs: first ? 100 : INPUT_TIMING.quietMs + 100 }, anyInput: null, seq: 2 }
    })
    const error = await refusal(f.prompt())
    expect(error.code).toBe('agent_view')
    expect(reads).toHaveLength(2)
    expect(reads[1]! - reads[0]!).toBeGreaterThanOrEqual(INPUT_TIMING.quietMs - 100 - 20)
    expect(f.writeCalls()).toBe(0)
  }, 20000)
  it('끝내 조용해지지 않으면 6번 읽고 input_changed(not_quiet) · not_started, 넣기 0', async () => {
    const f = setup('claude')
    f.spies.screenRead.mockImplementation(async () => ({ text: sample(NORMAL), input: { revision: ++f.state.revision, idleMs: 10 }, anyInput: null, seq: 2 }))
    const error = await refusal(f.prompt())
    expect([error.code, error.outcome, error.stage, detail(error).guard, detail(error).reads]).toEqual(['input_changed', 'not_started', 'preflight', 'not_quiet', 6])
    expect(f.writeCalls()).toBe(0)
  }, 20000)
})

describe('fix1 F 합성 — 읽기 순서·같은 id 재사용', () => {
  it('화면(revision)을 먼저, 제목을 그 뒤에 읽는다', async () => {
    const f = setup('claude')
    await f.prompt()
    const screenAt = f.spies.screenRead.mock.invocationCallOrder.at(-1)!
    const agentGets = vi.mocked(TerminalBackend.prototype.agentInfo).mock.invocationCallOrder
    // The title read is the first agent.get after the screen read, and the write comes after both.
    const titleAt = agentGets.find(order => order > screenAt)!
    expect(titleAt).toBeGreaterThan(screenAt)
    expect(f.spies.promptAgentIfQuiet.mock.invocationCallOrder[0]!).toBeGreaterThan(titleAt)
  }, 20000)
  it('input_changed 뒤 같은 --request-id 로 다시 넣으면 들어간다', async () => {
    const f = setup('claude')
    f.state.onAgentGet = () => { if (f.spies.screenRead.mock.calls.length === 1 && f.state.revision === 7) f.state.revision++ }
    const id = `r1.${Date.now()}.${randomUUID()}`
    expect((await refusal(f.prompt(id))).code).toBe('input_changed')
    const result = asObject(await f.prompt(id))
    expect(result.outcome).toBe('queued')
    expect(f.state.writes).toEqual(['Reply with exactly: L787'])
  }, 20000)
})

describe('fix1 B 합성 — 울타리 거절은 이 호출이 쓴 기록만 되돌린다', () => {
  it('거절 사이에 다른 제출이 기록을 쓰면 그 기록을 덮지 않는다', async () => {
    const f = setup('claude')
    const other = { sha256: 'other', bytes: 5, submittedAt: new Date().toISOString(), cursor: [], requestId: `r1.${Date.now()}.${randomUUID()}` }
    f.spies.promptAgentIfQuiet.mockImplementation(async () => {
      // Another submission to this pane recorded its own delivery meanwhile; then the guard refuses ours.
      f.store.update('pane', 'e', 'p', { phase: 'accepted', workingObserved: true, lastSubmission: other })
      throw new RuntimeError('input_changed', 'pane input moved since corral observed it', undefined, 'backend', 'not_started')
    })
    expect((await refusal(f.prompt())).code).toBe('input_changed')
    expect(f.store.read('pane', 'e', 'p')).toMatchObject({ phase: 'accepted', workingObserved: true, lastSubmission: other })
  }, 20000)
  it('겹침이 없으면 원래 값으로 돌아간다(대조)', async () => {
    const f = setup('claude')
    f.spies.promptAgentIfQuiet.mockImplementation(async () => { throw new RuntimeError('input_changed', 'moved', undefined, 'backend', 'not_started') })
    expect((await refusal(f.prompt())).code).toBe('input_changed')
    expect(f.store.read('pane', 'e', 'p')).toMatchObject({ phase: 'ready', workingObserved: false, lastSubmission: null })
  }, 20000)
})

describe('fix1 C 합성 — 판정 읽기 실패는 쓰기 전 거절', () => {
  it.each([['screenRead', 'backend_timeout'], ['screenRead', 'invalid_backend_response']])('%s 가 %s → preflight · not_started, 넣기 0', async (_arm, code) => {
    const f = setup('claude')
    f.spies.screenRead.mockImplementation(async () => { throw new RuntimeError(code, 'read failed', undefined, 'backend') })
    const error = await refusal(f.prompt())
    expect([error.code, error.outcome, error.stage]).toEqual([code, 'not_started', 'preflight'])
    expect(f.writeCalls()).toBe(0)
  }, 20000)
  it('제목 읽기(agent.get) 실패도 같다', async () => {
    const f = setup('claude')
    f.state.onAgentGet = () => { if (f.spies.screenRead.mock.calls.length > 0) throw new RuntimeError('agent_not_found', 'gone', undefined, 'backend', 'unknown') }
    const error = await refusal(f.prompt())
    expect([error.code, error.outcome, error.stage]).toEqual(['agent_not_found', 'not_started', 'preflight'])
    expect(f.writeCalls()).toBe(0)
  }, 20000)
})

describe('fix1 D — 최상위 recovery 에 esc', () => {
  it('Receipts 가 감싼 agent_view·input_changed 의 recovery 는 esc 안내, 다른 거절은 그대로', async () => {
    const f = setup('claude')
    f.state.screen = sample('view-default')
    expect(String(asObject((await refusal(f.prompt())).resources).recovery)).toContain('press esc')
    f.state.screen = sample(NORMAL)
    f.state.onAgentGet = () => { if (f.spies.screenRead.mock.calls.length === 2 && f.state.revision === 7) f.state.revision++ }
    expect(String(asObject((await refusal(f.prompt())).resources).recovery)).toContain('esc')
    f.state.onAgentGet = () => {}
    f.state.info.status = 'blocked'
    const blocked = await refusal(f.prompt())
    expect(blocked.code).toBe('agent_blocked')
    expect(asObject(blocked.resources).recovery).toBe('Retry the same request ID or inspect terminal list/read')
  }, 20000)
  it('소켓 응답(server.ts)의 최상위 recovery 도 같다, 다른 거절은 일반 문구 그대로', async () => {
    const f = setup('claude')
    const { startRuntime } = await import('../server.js')
    const { localCall, request } = await import('../transport.js')
    // An explicit binding needs both halves; the socket is never dialled — the guard is the stub above.
    process.env.CORRAL_SESSION = 'l787-fixture'
    const runtime = await startRuntime({ userData: f.data }); cleanups.push(() => { void runtime.close() })
    const token = new Tokens(f.data).encode('t1', { runtimeId: runtime.runtimeId, epoch: 'e', ptyId: 'p', paneId: 'pane' })
    const call = () => localCall(path.join(f.data, 'runtime/rpc.sock'), request({ command: 'terminal prompt',
      flags: { terminal: token, text: 'Reply with exactly: L787', 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: f.cwd }, runtime.runtimeId, 8000))
    f.state.screen = sample('view-default')
    const viewed = await call()
    expect(viewed).toMatchObject({ ok: false, error: { code: 'agent_view', stage: 'preflight' }, _meta: { outcome: 'not_started' } })
    expect(JSON.stringify(viewed)).toContain('"recovery":"press esc in the pane')
    f.state.screen = sample(NORMAL); f.state.info.status = 'blocked'
    const blocked = await call()
    expect(blocked).toMatchObject({ ok: false, error: { code: 'agent_blocked', resources: { recovery: 'Inspect terminal list/show/read; retry mutations only with the same request ID' } } })
  }, 30000)
})
