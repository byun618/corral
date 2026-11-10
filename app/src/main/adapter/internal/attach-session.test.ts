// LIFE-769 — `/bg` 뒤 `claude attach` 한 pane 의 세션 해소 (01-criteria C1·C2·C3·C5).
//
// **모두 합성 시험이다**: argv·`claude agents --json` 출력·herdr `agent.list` 답을 손으로 지었다. 증명하는 것은 해소 규칙과 store·link 의 배선뿐이고,
// 실제 Claude Code·herdr 가 이 모양을 낸다는 근거는 C6 실제 pane 회차다. 모양은 corral-specs LIFE-769 `raw/coordinator/probe1/`
// (`agents-all-after-bg.json`·`snap-3-after-attach.txt`)과 워커 사전 실측 `raw/claude/pre/`(foreground 에 MCP 자식이 같이 실림)에서 떴다.
// id·이름·경로는 지어낸 값이다(공개 레포).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATTACH_SESSION_SOURCE } from '../../../shared/types.js'
import { WorkspaceStore } from './store.js'
import { AttachSessionResolver, makeRunClaudeAgents, readAttachArgv, resolveAttachRef, type AgentsRunOutcome } from './attach-session.js'

type SubHooks = { label?: string; onPush: (frame: unknown, at: number) => void; onDrop: (reason: string, detail: string) => void }

const requestMock = vi.hoisted(() => vi.fn())
const logMock = vi.hoisted(() => vi.fn())
const subs = vi.hoisted(() => {
  const list: Array<{ hooks: SubHooks }> = []
  return list
})

vi.mock('../../log.js', () => ({ log: logMock }))
vi.mock('./request.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request.js')>()
  return { ...actual, request: requestMock }
})
vi.mock('./subscription.js', () => ({
  Subscription: class {
    constructor(readonly hooks: SubHooks) {
      subs.push(this)
    }
    async connect(): Promise<unknown> { return {} }
    close(): void {}
  },
}))

const { AGENT_SESSION_POLL_MS, SessionLink } = await import('./link.js')

// --- 합성 재료 (모양은 probe1 실측) ---------------------------------------------

const OLD = '0000aaaa-0000-4000-8000-000000000001' // `/bg` 전 세션 (store 에 남는 옛 참조)
const BG_X = '1111bbbb-1111-4111-8111-111111111111'
const BG_Y = '2222cccc-2222-4222-8222-222222222222'
const HERDR_NEW = '3333dddd-3333-4333-8333-333333333333'

const bgRow = (input: { id: string; sessionId: string; name: string }) => ({ pid: 4242, id: input.id, cwd: '/w/repo', kind: 'background', startedAt: 1, sessionId: input.sessionId, name: input.name, status: 'idle', state: 'idle' })
const AGENTS = [
  { pid: 9000, cwd: '/w/repo', kind: 'interactive', startedAt: 1, sessionId: '9999eeee-9999-4999-8999-999999999999', name: 'alpha-probe interactive', status: 'idle' },
  bgRow({ id: '1111bbbb', sessionId: BG_X, name: 'ALPHA-PROBE-ONE' }),
  bgRow({ id: '2222cccc', sessionId: BG_Y, name: 'BETA-PROBE-TWO' }),
  bgRow({ id: '4444ffff', sessionId: '4444ffff-4444-4444-8444-444444444444', name: 'beta-other' }),
]
const agentsOk = (rows: unknown = AGENTS): AgentsRunOutcome => ({ ok: true, stdout: JSON.stringify(rows) })

/** herdr `pane.process_info` result — foreground 에 MCP 자식이 같이 실린다(사전 실측). */
const processInfo = (claudeArgv: string[] | null) => ({
  process_info: {
    shell_pid: 1,
    foreground_processes: [
      { argv: ['node', '/x/mcp-server'], argv0: 'node', cmdline: 'node /x/mcp-server', name: 'node', pid: 11 },
      { argv0: 'mcp@latest', name: 'node', pid: 12 },
      ...(claudeArgv === null ? [{ argv: ['-zsh'], argv0: 'zsh', name: 'zsh', pid: 13 }] : [{ argv: claudeArgv, argv0: 'claude', cmdline: claudeArgv.join(' '), name: '2.1.296', pid: 14 }]),
    ],
  },
})

const herdrRef = (value: string) => ({ source: 'herdr:claude', agent: 'claude', kind: 'id', value })
const snapshot = (input: { session: string | null; agent?: string | null }): unknown => ({
  workspaces: [{ workspace_id: 'w1', label: 'repo', number: 1, focused: true, agent_status: 'idle' }],
  tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 't1', number: 1, agent_status: 'idle' }],
  panes: [{
    pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent_status: 'idle', agent: input.agent === undefined ? 'claude' : input.agent,
    ...(input.session === null ? {} : { agent_session: herdrRef(input.session) }),
  }],
})
/** `agent.list` 답 — `key` 가 'absent' 면 probe2 실측처럼 키 자체가 없다. */
const agentList = (key: string | 'absent' | 'none-listed') => ({
  type: 'agent_list',
  agents: key === 'none-listed' ? [] : [{ pane_id: 'w1:p1', agent: 'claude', ...(key === 'absent' ? {} : { agent_session: herdrRef(key) }) }],
})
const paneOf = (store: WorkspaceStore) => store.rows().flatMap((w) => w.tabs).flatMap((t) => t.panes).find((p) => p.paneId === 'w1:p1')
const sessionOf = (store: WorkspaceStore): string | null | undefined => {
  const value = paneOf(store)?.agentSession
  return value === undefined || value === null ? value : value.kind === 'id' ? value.id : value.path
}

// --- C1 해소 규칙 (합성) --------------------------------------------------------

type Case = {
  /** herdr `agent.list` 가 이 pane 에 주는 키 — 'absent' = 키 없음(attach) */
  herdr: string | 'absent'
  /** store 에 남은 옛 참조 (`/bg` 전 세션) */
  old: string | null
  argv: string[] | null
  agents: AgentsRunOutcome
  agent?: string
}

async function resolveCase(input: Case) {
  const store = new WorkspaceStore()
  store.applySnapshot(snapshot({ session: input.old, agent: input.agent ?? 'claude' }))
  store.applyAgentSessions({ result: agentList(input.herdr), requestedAt: Date.now() + 1 })
  const runAgents = vi.fn(async () => input.agents)
  const processInfoCalls = vi.fn(async () => processInfo(input.argv))
  const resolver = new AttachSessionResolver({ processInfo: processInfoCalls, runAgents, claudeExecutable: () => '/opt/fake/bin/claude' })
  const candidates = store.attachCandidates()
  const results = await resolver.round(candidates.map((candidate) => candidate.paneId))
  store.applyAttachSessions((results ?? []).map((result) => ({ ...result, epoch: candidates.find((candidate) => candidate.paneId === result.paneId)?.epoch ?? -1 })))
  return { store, session: sessionOf(store), runAgents, processInfoCalls, source: paneOf(store)?.agentSession?.source ?? null }
}

describe('C1 해소 규칙 (합성 — argv·agents 출력을 지어 규칙만 증명)', () => {
  it('ⓐ 키 없음 + argv `claude attach <id>` + 그 id 의 background 행 → 그 행 sessionId (출처 corral:claude-attach)', async () => {
    const out = await resolveCase({ herdr: 'absent', old: null, argv: ['claude', 'attach', '1111bbbb'], agents: agentsOk() })
    expect(out.session).toBe(BG_X)
    expect(out.source).toBe(ATTACH_SESSION_SOURCE)
    expect(out.runAgents).toHaveBeenCalledWith({ executable: '/opt/fake/bin/claude' })
  })

  it('ⓑ argv[0] 가 절대경로여도 같다 — 그 경로로 실행한다', async () => {
    const out = await resolveCase({ herdr: 'absent', old: null, argv: ['/Users/someone/.local/bin/claude', 'attach', '1111bbbb'], agents: agentsOk() })
    expect(out.session).toBe(BG_X)
    expect(out.runAgents).toHaveBeenCalledWith({ executable: '/Users/someone/.local/bin/claude' })
  })

  it('ⓒ ref 가 id 가 아니고 name 에 하나만 걸림(대소문자 무시) → 그 행', async () => {
    expect((await resolveCase({ herdr: 'absent', old: null, argv: ['claude', 'attach', 'ALPHA'], agents: agentsOk() })).session).toBe(BG_X)
    expect((await resolveCase({ herdr: 'absent', old: null, argv: ['claude', 'attach', 'probe-two'], agents: agentsOk() })).session).toBe(BG_Y)
  })

  it('F2 id 접두가 이름보다 먼저 — 접두 한 행이면 이름에 걸리는 다른 행이 있어도 그 행, 접두 둘 이상이면 없음 (claude attach 실측 순서)', () => {
    // 리뷰 r1 실측 모양: ref 가 한 행 id 의 접두이고, 다른 행의 이름에도 들어 있다(`afb6` ↔ `afb6-collide`)
    const rows = [...AGENTS, bgRow({ id: '5555aaaa', sessionId: '5555aaaa-5555-4555-8555-555555555555', name: '1111-collide' })]
    expect(resolveAttachRef({ ref: '1111', agents: rows })).toEqual({ ok: true, sessionId: BG_X })
    expect(resolveAttachRef({ ref: '1111bbbb', agents: rows })).toEqual({ ok: true, sessionId: BG_X })
    // 접두가 둘 이상 — 이름으로 내려가지 않고 없음
    const twoPrefix = [...rows, bgRow({ id: '1111cccc', sessionId: '1111cccc-1111-4111-8111-111111111112', name: 'other' })]
    expect(resolveAttachRef({ ref: '1111', agents: twoPrefix }).ok).toBe(false)
    expect(resolveAttachRef({ ref: '1111b', agents: twoPrefix })).toEqual({ ok: true, sessionId: BG_X })
    // 접두 0 → 이름
    expect(resolveAttachRef({ ref: 'collide', agents: rows })).toEqual({ ok: true, sessionId: '5555aaaa-5555-4555-8555-555555555555' })
  })

  it('ⓓ name 에 둘 이상·0 → 없음 (interactive 행 이름은 세지 않는다)', async () => {
    expect((await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', 'beta'], agents: agentsOk() })).session).toBeNull()
    expect((await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', 'gamma'], agents: agentsOk() })).session).toBeNull()
    // 'alpha-probe' 는 interactive 행에도 걸리지만 background 는 하나뿐 → 그 행
    expect((await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', 'alpha-probe'], agents: agentsOk() })).session).toBe(BG_X)
    expect(resolveAttachRef({ ref: 'beta', agents: AGENTS })).toEqual({ ok: false, reason: '이름이 ref 를 담는 행 2개' })
  })

  it('ⓔ argv `claude agents`·`claude` 단독·다른 하위 명령·셸 → 없음, claude agents 를 부르지 않는다', async () => {
    for (const argv of [['claude', 'agents'], ['claude'], ['claude', 'logs', '1111bbbb'], ['claude', '--model', 'm', '--session-id', OLD], ['claude', 'attach'], ['claude', 'attach', '--help'], null]) {
      const out = await resolveCase({ herdr: 'absent', old: OLD, argv, agents: agentsOk() })
      expect(out.session, JSON.stringify(argv)).toBeNull()
      expect(out.runAgents).not.toHaveBeenCalled()
    }
  })

  it('ⓔ attach 와 다른 claude 프로세스가 같이 foreground 면 없음 · readAttachArgv 모양 아님도 없음', () => {
    const both = { process_info: { foreground_processes: [{ argv: ['claude', 'attach', '1111bbbb'] }, { argv: ['claude', 'agents'] }] } }
    expect(readAttachArgv(both).kind).toBe('none')
    const two = { process_info: { foreground_processes: [{ argv: ['claude', 'attach', '1111bbbb'] }, { argv: ['claude', 'attach', '2222cccc'] }] } }
    expect(readAttachArgv(two)).toEqual({ kind: 'none', reason: 'attach ref 가 여럿' })
    expect(readAttachArgv({}).kind).toBe('none')
    expect(readAttachArgv({ process_info: { foreground_processes: 'x' } }).kind).toBe('none')
    expect(readAttachArgv(processInfo(['claude', 'attach', '1111bbbb']))).toEqual({ kind: 'attach', ref: '1111bbbb', argv0: 'claude' })
  })

  it('ⓕ agents 실패·시간 초과·JSON 아님·배열 아님·sessionId 가 UUID 모양 아님 → 없음', async () => {
    const outcomes: AgentsRunOutcome[] = [
      { ok: false, reason: 'ENOENT' },
      { ok: false, reason: 'timeout' },
      { ok: true, stdout: 'not json' },
      { ok: true, stdout: JSON.stringify({ agents: AGENTS }) },
      agentsOk([bgRow({ id: '1111bbbb', sessionId: '1111bbbb', name: 'x' })]),
      agentsOk([{ ...bgRow({ id: '1111bbbb', sessionId: BG_X, name: 'x' }), sessionId: 7 }]),
    ]
    for (const agents of outcomes) {
      expect((await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', '1111bbbb'], agents })).session, JSON.stringify(agents)).toBeNull()
    }
  })

  it('ⓖ herdr 가 참조를 주면 그것이 이긴다 — 해소를 부르지 않는다', async () => {
    const out = await resolveCase({ herdr: HERDR_NEW, old: OLD, argv: ['claude', 'attach', '1111bbbb'], agents: agentsOk() })
    expect(out.session).toBe(HERDR_NEW)
    expect(out.processInfoCalls).not.toHaveBeenCalled()
    expect(out.runAgents).not.toHaveBeenCalled()
  })

  it('ⓗ agent 가 claude 가 아닌 pane → 부르지 않고 알던 값 그대로', async () => {
    const out = await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', '1111bbbb'], agents: agentsOk(), agent: 'codex' })
    expect(out.session).toBe(OLD)
    expect(out.processInfoCalls).not.toHaveBeenCalled()
    expect(out.runAgents).not.toHaveBeenCalled()
  })

  it('ⓘ store 에 옛 참조가 남아 있어도 키 없음이면 해소 결과가 이긴다 — ⓓ·ⓔ·ⓕ 에서 옛 참조로 떨어지지 않는다', async () => {
    expect((await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', '1111bbbb'], agents: agentsOk() })).session).toBe(BG_X)
    expect((await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', 'beta'], agents: agentsOk() })).session).toBeNull() // ⓓ
    expect((await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'agents'], agents: agentsOk() })).session).toBeNull() // ⓔ
    expect((await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', '1111bbbb'], agents: { ok: false, reason: 'x' } })).session).toBeNull() // ⓕ
    // 해소 판이 돌기 전(키 없음만 본 순간)에도 옛 참조가 아니라 없음이다
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ session: OLD }))
    store.applyAgentSessions({ result: agentList('absent'), requestedAt: Date.now() + 1 })
    expect(sessionOf(store)).toBeNull()
  })

  it('ⓘ 닫힌 채널(보존 행)도 같은 값을 붙든다 — 옛 참조가 아니다', async () => {
    const out = await resolveCase({ herdr: 'absent', old: OLD, argv: ['claude', 'attach', '1111bbbb'], agents: agentsOk() })
    out.store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'done' } })
    out.store.applyEvent({ event: 'pane_closed', data: { pane_id: 'w1:p1', workspace_id: 'w1' } })
    const retained = out.store.retainedRows()
    expect(retained[0]?.agentSession).toEqual({ kind: 'id', agent: 'claude', source: ATTACH_SESSION_SOURCE, id: BG_X })
  })
})

// --- C5 비용 (합성) -------------------------------------------------------------

describe('C5 비용 — 해소기', () => {
  const deps = (input: { argv: string[] | null; agents?: () => Promise<AgentsRunOutcome>; executable?: string | null }) => {
    const runAgents = vi.fn(input.agents ?? (async () => agentsOk()))
    const info = vi.fn(async () => processInfo(input.argv))
    const resolver = new AttachSessionResolver({ processInfo: info, runAgents, claudeExecutable: () => (input.executable === undefined ? '/opt/fake/bin/claude' : input.executable) })
    return { resolver, runAgents, info }
  }

  it('후보 pane 이 없으면 아무것도 부르지 않는다 (process_info 0 · claude agents 0)', async () => {
    const d = deps({ argv: ['claude', 'attach', '1111bbbb'] })
    for (let i = 0; i < 5; i += 1) expect(await d.resolver.round([])).toEqual([])
    expect(d.info).not.toHaveBeenCalled()
    expect(d.runAgents).not.toHaveBeenCalled()
  })

  it('argv 가 attach 가 아니면 claude agents 0', async () => {
    const d = deps({ argv: ['claude', '--model', 'm'] })
    for (let i = 0; i < 5; i += 1) await d.resolver.round(['w1:p1'])
    expect(d.info).toHaveBeenCalledTimes(5)
    expect(d.runAgents).not.toHaveBeenCalled()
  })

  it('F1 같은 argv 여도 판마다 다시 푼다 — attach 안 `/clear` 로 같은 id 행의 sessionId 가 바뀌면 다음 판에 새 값 (판당 claude agents 1회)', async () => {
    const argv = ['claude', 'attach', '1111bbbb']
    let rows: unknown = AGENTS
    const runAgents = vi.fn(async () => agentsOk(rows))
    const resolver = new AttachSessionResolver({ processInfo: async () => processInfo(argv), runAgents, claudeExecutable: () => '/opt/fake/bin/claude' })
    for (let i = 0; i < 3; i += 1) expect((await resolver.round(['w1:p1']))?.[0]?.sessionId).toBe(BG_X)
    expect(runAgents).toHaveBeenCalledTimes(3)
    // `/clear` 실측 모양(리뷰 r1 claude-r1-clear-in-attach.txt): 같은 `id`, 새 `sessionId`
    rows = AGENTS.map((row) => ('id' in row && row.id === '1111bbbb' ? { ...row, sessionId: HERDR_NEW } : row))
    expect((await resolver.round(['w1:p1']))?.[0]?.sessionId).toBe(HERDR_NEW)
    expect(runAgents).toHaveBeenCalledTimes(4)
  })

  it('여러 pane 이 한 판에 같은 실행 파일이면 claude agents 는 한 번', async () => {
    const runAgents = vi.fn(async () => agentsOk())
    const argvByPane: Record<string, string[]> = { a: ['claude', 'attach', '1111bbbb'], b: ['claude', 'attach', '2222cccc'] }
    const resolver = new AttachSessionResolver({ processInfo: async (paneId) => processInfo(argvByPane[paneId] ?? null), runAgents, claudeExecutable: () => '/opt/fake/bin/claude' })
    const results = await resolver.round(['a', 'b'])
    expect(results?.map((r) => r.sessionId)).toEqual([BG_X, BG_Y])
    expect(runAgents).toHaveBeenCalledTimes(1)
  })

  it('판은 겹치지 않는다 — 진행 중이면 다음 판은 null(건너뜀)', async () => {
    let release: (value: AgentsRunOutcome) => void = () => {}
    const d = deps({ argv: ['claude', 'attach', '1111bbbb'], agents: () => new Promise((resolve) => { release = resolve }) })
    const first = d.resolver.round(['w1:p1'])
    await new Promise((resolve) => setImmediate(resolve))
    expect(await d.resolver.round(['w1:p1'])).toBeNull()
    release(agentsOk())
    expect((await first)?.[0]?.sessionId).toBe(BG_X)
    expect(d.runAgents).toHaveBeenCalledTimes(1)
  })

  it('claude 실행 파일을 못 찾으면(argv 상대 + 감지 없음) 부르지 않고 없음', async () => {
    const d = deps({ argv: ['claude', 'attach', '1111bbbb'], executable: null })
    const results = await d.resolver.round(['w1:p1'])
    expect(results?.[0]).toEqual({ paneId: 'w1:p1', sessionId: null, reason: 'claude 실행 파일 없음' })
    expect(d.runAgents).not.toHaveBeenCalled()
  })

  it('process_info 실패는 그 pane 만 없음', async () => {
    const resolver = new AttachSessionResolver({ processInfo: async () => { throw new Error('pane_not_found') }, runAgents: async () => agentsOk(), claudeExecutable: () => null })
    expect((await resolver.round(['w1:p1']))?.[0]?.sessionId).toBeNull()
  })
})

describe('C5 비용 — 실제 실행기(비동기·시간 초과·출력)', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l769-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const script = (body: string) => {
    const file = path.join(dir, 'claude')
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }

  it('인자는 agents --json --all 이고 stdout 을 돌려준다 (--cwd 없음)', async () => {
    const run = makeRunClaudeAgents()
    expect(await run({ executable: script('printf "%s|" "$@"') })).toEqual({ ok: true, stdout: 'agents|--json|--all|' })
  })

  it('시한을 넘기면 timeout 으로 끝난다 — 기다리지 않는다', async () => {
    const run = makeRunClaudeAgents({ timeoutMs: 200 })
    const started = Date.now()
    expect(await run({ executable: script('sleep 5') })).toEqual({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('없는 실행 파일·비정상 종료는 실패로 돌려주고 던지지 않는다', async () => {
    const run = makeRunClaudeAgents()
    expect((await run({ executable: path.join(dir, 'missing') })).ok).toBe(false)
    expect((await run({ executable: script('exit 3') })).ok).toBe(false)
  })
})

// --- C2 전환 · C5 link 배선 (합성 — herdr 답·argv 를 지었다) ------------------------

describe('C2 전환 — SessionLink 세션 조회 + 해소 (상한 = 세션 조회 한 주기)', () => {
  /** herdr 의 지금 상태 — 스냅샷도 `agent.list` 와 같이 키를 싣거나 뺀다(probe2 `snapshot-2-after-bg`·`snapshot-3-after-attach`: /bg 뒤·attach 뒤 키 없음). */
  type World = { herdr: string | 'absent' | 'none-listed'; agent: string | null; argv: string[] | null }
  let world: World
  let agentsOutcome: AgentsRunOutcome
  let listFails = false

  beforeEach(() => {
    vi.useFakeTimers()
    requestMock.mockReset()
    logMock.mockClear()
    subs.length = 0
    agentsOutcome = agentsOk()
    listFails = false
    world = { herdr: OLD, agent: 'claude', argv: ['claude', '--model', 'm', '--session-id', OLD] }
    requestMock.mockImplementation(async (_socket: string, method: string) => {
      if (method === 'session.snapshot') return { id: 's', result: snapshot({ session: world.herdr === 'absent' || world.herdr === 'none-listed' ? null : world.herdr, agent: world.agent }) }
      if (method === 'agent.list') return listFails ? { id: 'a', error: { code: 'internal', message: 'boom' } } : { id: 'a', result: agentList(world.agent === null ? 'none-listed' : world.herdr) }
      if (method === 'pane.process_info') return { id: 'p', result: processInfo(world.argv) }
      throw new Error(`예상 밖 호출 ${method}`)
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const runAgents = vi.fn(async () => agentsOutcome)
  async function liveLink(onChange: () => void = () => {}) {
    runAgents.mockClear()
    const link = new SessionLink({ onChange, runClaudeAgents: runAgents, claudeExecutable: () => '/opt/fake/bin/claude' })
    link.open({ name: 't', isDefault: false, running: true, socketPath: '/tmp/l769-unit.sock', sessionDir: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(link.linkState().phase).toBe('live')
    return link
  }
  const push = (event: string, data: Record<string, unknown>) => subs.find((sub) => sub.hooks.label === 'main')?.hooks.onPush({ event, data: { pane_id: 'w1:p1', workspace_id: 'w1', ...data } }, Date.now())
  const tick = () => vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS)
  const infoCalls = () => requestMock.mock.calls.filter((call) => call[1] === 'pane.process_info').length

  /** `/bg`: claude 가 끝나 셸 — herdr 는 agent 를 빼고 agent.list 에 이 pane 이 없다. */
  const goBg = () => {
    world = { ...world, agent: null, herdr: 'none-listed', argv: null }
    push('pane_agent_detected', { agent: 'claude', released: true })
  }
  /** `claude attach <ref>`: herdr 는 claude 를 잡지만 키를 주지 않는다(probe2·사전 실측). */
  const goAttach = (ref: string) => {
    world = { ...world, agent: 'claude', herdr: 'absent', argv: ['claude', 'attach', ref] }
    push('pane_agent_detected', { agent: 'claude' })
  }

  it('ⓐ 정상(herdr 참조) → /bg → attach X: 한 주기 뒤 X · 그 사이에도 옛 참조가 아니다 · 정상일 때 해소 호출 0', async () => {
    const onChange = vi.fn()
    const link = await liveLink(onChange)
    await tick()
    await tick()
    expect(sessionOf(link.store)).toBe(OLD)
    expect(infoCalls()).toBe(0)
    expect(runAgents).not.toHaveBeenCalled()
    goBg()
    await tick()
    expect(paneOf(link.store)?.agent).toBeNull()
    goAttach('1111bbbb')
    // fix1 F3 — 붙는 순간(조회 전)에도 `/bg` 전 herdr 참조(OLD)가 아니라 없음
    expect(paneOf(link.store)?.agent).toBe('claude')
    expect(sessionOf(link.store)).toBeNull()
    await tick()
    expect(sessionOf(link.store)).toBe(BG_X)
    expect(paneOf(link.store)?.agentSession?.source).toBe(ATTACH_SESSION_SOURCE)
    expect(tagsOf('attach_session.applied')).toBeGreaterThan(0)
    link.close()
  })

  it('ⓑ attach → agent view(argv `claude agents`) → 한 주기 뒤 없음 · Enter 로 돌아와도 argv 가 그대로면 없음', async () => {
    const link = await liveLink()
    goBg()
    await tick()
    goAttach('1111bbbb')
    await tick()
    expect(sessionOf(link.store)).toBe(BG_X)
    world = { ...world, argv: ['claude', 'agents'] }
    await tick()
    expect(sessionOf(link.store)).toBeNull()
    await tick()
    expect(sessionOf(link.store)).toBeNull()
    link.close()
  })

  it('ⓒ attach → 셸 복귀(agent 빠짐): agent 없음 — 세션 칸은 base 의 /bg 와 같이 herdr 가 마지막에 준 참조(대화 채널은 agent 가 없어 열리지 않는다)', async () => {
    const link = await liveLink()
    goBg()
    await tick()
    goAttach('1111bbbb')
    await tick()
    goBg()
    await tick()
    expect(paneOf(link.store)?.agent).toBeNull()
    expect(sessionOf(link.store)).toBe(OLD)
    expect(link.store.attachCandidates()).toEqual([])
    link.close()
  })

  it('ⓓ attach X → 셸 → attach Y: 한 주기 뒤 Y — 다시 붙는 순간에도 X 가 남지 않는다', async () => {
    const link = await liveLink()
    goBg()
    await tick()
    goAttach('1111bbbb')
    await tick()
    expect(sessionOf(link.store)).toBe(BG_X)
    goBg()
    await tick()
    goAttach('2222cccc')
    expect(sessionOf(link.store)).toBeNull() // 다음 판 전: X 아님
    await tick()
    expect(sessionOf(link.store)).toBe(BG_Y)
    link.close()
  })

  it('ⓔ 해소된 상태에서 herdr 참조가 들어오면 한 주기 뒤 herdr 값', async () => {
    const link = await liveLink()
    goBg()
    await tick()
    goAttach('1111bbbb')
    await tick()
    expect(sessionOf(link.store)).toBe(BG_X)
    world = { ...world, herdr: HERDR_NEW }
    await tick()
    expect(sessionOf(link.store)).toBe(HERDR_NEW)
    expect(paneOf(link.store)?.agentSession?.source).toBe('herdr:claude')
    link.close()
  })

  it('F1 같은 attach 에서 `/clear`(같은 id, 새 sessionId) → 한 주기 뒤 새 세션', async () => {
    const link = await liveLink()
    goBg()
    await tick()
    goAttach('1111bbbb')
    await tick()
    expect(sessionOf(link.store)).toBe(BG_X)
    agentsOutcome = agentsOk(AGENTS.map((row) => ('id' in row && row.id === '1111bbbb' ? { ...row, sessionId: HERDR_NEW } : row)))
    await tick()
    expect(sessionOf(link.store)).toBe(HERDR_NEW)
    link.close()
  })

  it('F3 `agent.list` 조회가 계속 실패해도 붙는 순간 없음 · 한 주기 뒤 해소 값 · `/clear` 도 한 주기 뒤 (상한 = 조회 주기)', async () => {
    const link = await liveLink()
    goBg()
    await tick()
    listFails = true
    goAttach('1111bbbb')
    expect(sessionOf(link.store)).toBeNull()
    await tick()
    expect(sessionOf(link.store)).toBe(BG_X)
    agentsOutcome = agentsOk(AGENTS.map((row) => ('id' in row && row.id === '1111bbbb' ? { ...row, sessionId: HERDR_NEW } : row)))
    await tick()
    expect(sessionOf(link.store)).toBe(HERDR_NEW)
    expect(tagsOf('agent_session.poll.failed')).toBe(1)
    link.close()
  })

  it('ⓕ corral 재시작(빈 store) 뒤 attach pane → 한 주기 뒤 해소 값 (base 는 no_session)', async () => {
    world = { herdr: 'absent', agent: 'claude', argv: ['claude', 'attach', '1111bbbb'] }
    const link = await liveLink()
    expect(sessionOf(link.store)).toBeNull()
    await tick()
    expect(sessionOf(link.store)).toBe(BG_X)
    link.close()
  })

  it('C5 attach pane 이 있으면 주기마다 process_info 한 건·claude agents 한 번(상한 = 세션 조회 주기, fix1 F1 로 캐시 없음)', async () => {
    const link = await liveLink()
    goBg()
    await tick()
    goAttach('1111bbbb')
    requestMock.mockClear()
    runAgents.mockClear()
    for (let i = 0; i < 8; i += 1) await tick()
    expect(sessionOf(link.store)).toBe(BG_X)
    expect(runAgents).toHaveBeenCalledTimes(8)
    expect(infoCalls()).toBe(8)
    link.close()
  })

  it('C5 조건 밖(herdr 참조가 있는 claude pane · claude 아닌 pane)이면 process_info·claude agents 0', async () => {
    const link = await liveLink()
    requestMock.mockClear()
    for (let i = 0; i < 6; i += 1) await tick()
    world = { ...world, agent: 'codex', herdr: 'absent', argv: ['claude', 'attach', '1111bbbb'] }
    push('pane_agent_detected', { agent: 'codex' })
    for (let i = 0; i < 6; i += 1) await tick()
    expect(infoCalls()).toBe(0)
    expect(runAgents).not.toHaveBeenCalled()
    link.close()
  })

  const tagsOf = (tag: string) => logMock.mock.calls.filter((call) => call[0] === tag).length
})

// --- C3 herdr 상태 무변경 ---------------------------------------------------------

describe('F3 늦은 스냅샷 — 전환보다 먼저 요청된 스냅샷의 옛 키는 키 없음을 되돌리지 못한다 (store, 합성)', () => {
  const setup = () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ session: OLD }))
    store.applyEvent({ event: 'pane_agent_detected', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', released: true } })
    const before = Date.now() - 1_000 // `/bg` 전에 요청된 재동기 사진
    store.applyEvent({ event: 'pane_agent_detected', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude' } })
    return { store, before }
  }

  it('push 로 claude 가 붙은 뒤 먼저 요청된 스냅샷이 OLD 키를 싣고 와도 없음 그대로', () => {
    const { store, before } = setup()
    expect(sessionOf(store)).toBeNull()
    store.reconcile(snapshot({ session: OLD }), before)
    expect(sessionOf(store)).toBeNull()
    expect(store.attachCandidates().map((candidate) => candidate.paneId)).toEqual(['w1:p1'])
  })

  it('대조: 전환 뒤에 요청된 스냅샷이 키를 실으면 herdr 값이 이긴다 (정상 기동의 훅 보고)', () => {
    const { store } = setup()
    store.reconcile(snapshot({ session: HERDR_NEW }), Date.now() + 1)
    expect(sessionOf(store)).toBe(HERDR_NEW)
    expect(store.attachCandidates()).toEqual([])
  })

  it('push 를 놓쳐 agent.list 로 처음 키 없음을 본 경우도 먼저 요청된 스냅샷이 되돌리지 못한다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ session: OLD }))
    const before = Date.now() - 1_000
    store.applyAgentSessions({ result: agentList('absent'), requestedAt: Date.now() + 1 })
    store.reconcile(snapshot({ session: OLD }), before)
    expect(sessionOf(store)).toBeNull()
  })
})

describe('fix2 F8 세션 시계 판별 — 사진 요청이 최초 키 시계 **뒤**·전환 **앞** (실제 /bg 직전 재동기 순서, store 합성)', () => {
  // 위 「F3 늦은 스냅샷」 은 사진을 최초 키 시계보다 이르게 요청해 시계 올림 없이도 물러났다(리뷰 r2 R2-2). 여기는 벽시계를 고정해 순서를 박는다:
  // t=1000 부팅 스냅샷(키 OLD, 시계 1000) → t=1500 재동기 사진 요청(아직 OLD 키) → t=2000 전환 → 그 사진이 늦게 도착.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const PHOTO_AT = 1_500
  const boot = () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ session: OLD }))
    vi.setSystemTime(2_000)
    return store
  }
  const detected = (store: WorkspaceStore, data: Record<string, unknown>) => store.applyEvent({ event: 'pane_agent_detected', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', ...data } })

  it('Mb — push `pane_agent_detected` 로 claude 가 붙으면 시계가 올라 그 사진의 OLD 키가 못 되돌린다', () => {
    const store = boot()
    detected(store, { released: true })
    detected(store, {})
    store.reconcile(snapshot({ session: OLD }), PHOTO_AT)
    expect(sessionOf(store)).toBeNull()
  })

  it('Mc — push 를 놓쳐 `agent.list` 로 처음 키 없음을 본 claude pane 도 시계가 올라 못 되돌린다', () => {
    const store = boot()
    store.applyAgentSessions({ result: agentList('absent'), requestedAt: 2_000 })
    store.reconcile(snapshot({ session: OLD }), PHOTO_AT)
    expect(sessionOf(store)).toBeNull()
  })

  it('Md — 봉투(`pane_updated`, putPane)로 claude 가 새로 붙어도 시계가 올라 못 되돌린다', () => {
    const store = boot()
    detected(store, { released: true })
    store.applyEvent({ event: 'pane_updated', data: { pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent_status: 'idle', agent: 'claude' } } })
    expect(sessionOf(store)).toBeNull()
    store.reconcile(snapshot({ session: OLD }), PHOTO_AT)
    expect(sessionOf(store)).toBeNull()
  })

  it('대조 — 전환 뒤에 요청된 사진의 키는 이긴다(herdr 가 지금 키를 준다)', () => {
    const store = boot()
    detected(store, { released: true })
    detected(store, {})
    store.reconcile(snapshot({ session: HERDR_NEW }), 2_500)
    expect(sessionOf(store)).toBe(HERDR_NEW)
  })

  it('Me — herdr 키가 있는 pane(키 없음 아님)에는 해소 답을 적지 않는다', () => {
    const store = boot()
    expect(store.applyAttachSessions([{ paneId: 'w1:p1', epoch: 0, sessionId: BG_X }]).changed).toBe(false)
    expect(sessionOf(store)).toBe(OLD)
  })
})

describe('fix2 F11 해소 세대 — 판 진행 중 agent 가 바뀌면 그 판의 답을 버린다 (store 합성)', () => {
  it('판 시작 뒤 attach X → 셸 → attach Y: 시작 때 세대로 온 X 답은 적지 않고, 새 세대 답은 적는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ session: null }))
    const [start] = store.attachCandidates()
    expect(start?.paneId).toBe('w1:p1')
    // 판이 X 를 푸는 동안 pane 이 셸로 나갔다 Y 로 다시 붙는다
    store.applyEvent({ event: 'pane_agent_detected', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', released: true } })
    store.applyEvent({ event: 'pane_agent_detected', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude' } })
    expect(store.applyAttachSessions([{ paneId: 'w1:p1', epoch: start?.epoch ?? -1, sessionId: BG_X }]).changed).toBe(false)
    expect(sessionOf(store)).toBeNull()
    const [next] = store.attachCandidates()
    expect(next?.epoch).not.toBe(start?.epoch)
    expect(store.applyAttachSessions([{ paneId: 'w1:p1', epoch: next?.epoch ?? -1, sessionId: BG_Y }]).changed).toBe(true)
    expect(sessionOf(store)).toBe(BG_Y)
  })
})

describe('C3 herdr 상태 무변경 — corral 은 세션 보고를 부르지 않는다', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full)
    return /\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
  })

  it('허용 목록에 pane.report_agent* 가 없다', () => {
    const text = fs.readFileSync(path.join(import.meta.dirname, 'request.ts'), 'utf8')
    const start = text.indexOf('const ALLOWED_METHODS: readonly string[] = [')
    const allowed = text.slice(start, text.indexOf('\n]', start))
    expect(allowed).toContain("'pane.process_info'")
    expect(allowed).not.toMatch(/report_agent/)
  })

  it("코드에 'pane.report_agent…' 문자열 리터럴이 없다 (주석의 백틱 언급은 제외)", () => {
    const hits = sources(root).filter((file) => /['"]pane\.report_agent/.test(fs.readFileSync(file, 'utf8')))
    expect(hits).toEqual([])
  })
})
