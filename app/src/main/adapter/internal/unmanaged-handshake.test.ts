// LIFE-597 R1-A1 — guard 능력(`unmanaged_prompt`)을 실제 `TerminalBackend` handshake 로 읽는 경계.
// 가짜 InputBackend 가 아니라 소켓 stub(guard 봉투 모양) 위의 `HerdrInputBackend` 를 `InputHub` 에 물려, 광고가 있을 때만 관리 밖 pane 에
// `unmanaged_agent` 를 실어 넣고, 광고가 없거나(옛 guard) handshake 전이면 관리 밖 pane 에 쓰지 않는지 본다.
// guard 봉투 낱말(메서드·snake_case 칸)을 쓰므로 어댑터 안에 둔다(check:boundary R4).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRecord, readRecord } from '../../../shared/json.js'
import { TerminalBackend } from './terminal-backend.js'
import { CHAT_SESSIONS, chatListState } from '../../mobile/chat-fixture.js'
import { InputHub, type InputWire } from '../../mobile/input.js'
import { HerdrInputBackend } from '../../mobile/input-backend.js'

vi.mock('../../log.js', () => ({ log: () => {} }))

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const RULE = '─'.repeat(40)
const EMPTY = ['', RULE, '❯ ', RULE].join('\r\n')

let uuid = 0
const userLine = (text: string): string => {
  uuid += 1
  return JSON.stringify({ type: 'user', isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: text }, uuid: `b-${uuid}`, parentUuid: null, timestamp: new Date().toISOString(), sessionId: CHAT_SESSIONS.claude.id })
}

type Params = Record<string, unknown>
const methodOf = (params: Params): unknown => readRecord(params, 'operation')?.method

/** guard 봉투 stub — handshake(광고 여부 선택) · snapshot · agent.get · manifests · pane.read · agent.prompt. */
async function stubGuard(input: { advertise: boolean; managed: boolean; file: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l597b-'))
  const socket = path.join(dir, 'guard.sock')
  const calls: Params[] = []
  const agent = {
    agent: 'claude', name: input.managed ? 'corral-x' : null, agent_status: 'idle', launch_pending: false, interactive_ready: input.managed,
    state_change_seq: 7, pane_id: 'c1', corral_input_revision: 3, corral_input_idle_ms: 5_000,
    // 옛 guard 는 이 칸을 모른다.
    ...(input.advertise ? { corral_state_quiet_ms: 5_000 } : {}),
  }
  const server = net.createServer((connection) => {
    connection.setEncoding('utf8')
    let buffer = ''
    connection.on('data', (chunk) => {
      buffer += String(chunk)
      if (!buffer.includes('\n')) return
      const request: unknown = JSON.parse(buffer.split('\n')[0]!)
      const params: Params = isRecord(request) && isRecord(request.params) ? request.params : {}
      calls.push(params)
      const reply = (body: Record<string, unknown>) => connection.end(JSON.stringify({ id: isRecord(request) ? request.id : null, ...body }) + '\n')
      const method = methodOf(params)
      if (method === undefined) return reply({ result: { epoch: 'e', guard_version: 1, raw_capacity: 1048576, conditional_process: false, agent_ops: 1, ...(input.advertise ? { unmanaged_prompt: 1 } : {}) } })
      if (method === 'session.snapshot') return reply({ result: { snapshot: { workspaces: [], tabs: [], panes: [{ pane_id: 'c1', terminal_id: 't', corral_pty_generation: '1', workspace_id: 'w', tab_id: 'tab', cwd: '/w' }] } } })
      if (method === 'agent.get') return reply({ result: { agent } })
      if (method === 'server.agent_manifests') return reply({ result: { manifests: [{ agent: 'claude', source_kind: 'bundled', active_version: '2026.09.04.1', local_override_shadowing_remote: false }] } })
      if (method === 'pane.read') return reply({ result: { read: { text: EMPTY, corral_input_revision: 3, corral_input_idle_ms: 5_000, corral_state_change_seq: 7 } } })
      if (method === 'agent.prompt') {
        // guard 술어처럼: 관리 밖 pane 은 광고하는 guard 가 `unmanaged_agent: claude` 를 받았을 때만, 관리 pane 은 언제나.
        const ok = input.managed || (input.advertise && params.unmanaged_agent === 'claude')
        if (!ok) return reply({ error: { code: 'agent_not_ready', message: 'agent is not the observed ready state', observed: agent } })
        fs.appendFileSync(input.file, `${userLine(String(readRecord(readRecord(params, 'operation') ?? {}, 'params')?.text))}\n`)
        return reply({ result: { agent } })
      }
      return reply({ error: { code: 'unsupported', message: String(method) } })
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve() })))
  return { socket, calls, prompts: () => calls.filter((call) => methodOf(call) === 'agent.prompt') }
}

function recordFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l597r-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'claude.jsonl')
  fs.writeFileSync(file, `${userLine('이전 지시')}\n`)
  return file
}

function hubOn(backend: HerdrInputBackend, file: string) {
  const state = chatListState()
  const hub = new InputHub({
    read: () => ({ state, prefs: null }),
    backend: () => backend,
    resolveFile: () => ({ kind: 'found', file }),
    questionItems: () => [],
    log: () => {},
    timing: { pollMs: 5, gateMs: 5, quietMs: 500, confirmMs: 1_000, recordPollMs: 10, stepGapMs: 1, answerConfirmMs: 300, stopConfirmMs: 200 },
  })
  cleanups.push(() => hub.stop())
  const wires: InputWire[] = []
  hub.attach({ device: 'd1', sink: (text) => wires.push(JSON.parse(text)) })
  const settled = async (id: string): Promise<InputWire> => {
    const started = Date.now()
    for (;;) {
      const wire = wires.filter((item) => item.id === id).at(-1)
      if (wire !== undefined && !['queued', 'sending'].includes(wire.state)) return wire
      if (Date.now() - started > 3_000) throw new Error(`settle timeout ${id}: ${JSON.stringify(wire)}`)
      await new Promise((done) => setTimeout(done, 5))
    }
  }
  return { hub, settled }
}

describe('guard 능력 handshake (LIFE-597 R1-A1)', () => {
  it('handshake 전에는 관리 밖 갈래를 모른다고 본다', () => {
    expect(new TerminalBackend('/nonexistent').unmanagedPromptCapable()).toBe(false)
    expect(new HerdrInputBackend('/nonexistent').unmanagedPrompt()).toBe(false)
  })
  it('새 guard handshake(`unmanaged_prompt: 1`)면 안다 · 옛 guard 면 모른다', async () => {
    for (const advertise of [true, false]) {
      const stub = await stubGuard({ advertise, managed: false, file: recordFile() })
      const backend = new HerdrInputBackend(stub.socket)
      expect(backend.unmanagedPrompt()).toBe(false)
      const pane = await backend.locate('c1')
      expect(pane).not.toBeNull()
      expect(backend.unmanagedPrompt()).toBe(advertise)
      const observed = await backend.observe(pane!)
      // 관리 밖 pane — 옛 guard 면 settle 을 몰라 quiet 가 되지 않는다.
      expect({ unmanaged: observed.unmanaged, quiet: observed.quiet }).toEqual({ unmanaged: true, quiet: advertise })
    }
  })
})

describe('InputHub + 실제 TerminalBackend (LIFE-597 R1-A1 · U5)', () => {
  it('새 guard + 관리 밖 pane → `unmanaged_agent: claude` 로 넣어 들어감', async () => {
    const file = recordFile()
    const stub = await stubGuard({ advertise: true, managed: false, file })
    const t = hubOn(new HerdrInputBackend(stub.socket), file)
    t.hub.send({ device: 'd1', id: 'l597-b-0001', channel: 'c1', text: '셸 세션' })
    expect(await t.settled('l597-b-0001')).toMatchObject({ state: 'delivered' })
    expect(stub.prompts().map((call) => call.unmanaged_agent)).toEqual(['claude'])
  })
  it('옛 guard + 관리 밖 pane → agent.prompt 0회 · failed/guard_outdated', async () => {
    const file = recordFile()
    const stub = await stubGuard({ advertise: false, managed: false, file })
    const t = hubOn(new HerdrInputBackend(stub.socket), file)
    t.hub.send({ device: 'd1', id: 'l597-b-0002', channel: 'c1', text: '옛 guard' })
    expect(await t.settled('l597-b-0002')).toMatchObject({ state: 'failed', reason: 'guard_outdated' })
    expect(stub.prompts()).toHaveLength(0)
  })
  it('옛 guard + 관리 pane → 옵션 없이 넣어 들어감', async () => {
    const file = recordFile()
    const stub = await stubGuard({ advertise: false, managed: true, file })
    const t = hubOn(new HerdrInputBackend(stub.socket), file)
    t.hub.send({ device: 'd1', id: 'l597-b-0003', channel: 'c1', text: '관리 pane' })
    expect(await t.settled('l597-b-0003')).toMatchObject({ state: 'delivered' })
    expect(stub.prompts()).toHaveLength(1)
    expect('unmanaged_agent' in stub.prompts()[0]!).toBe(false)
  })
})
