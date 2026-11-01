// LIFE-708 r2 (L1) — guard ↔ TS 이음새: 「모든 입력」 값(`corral_any_input_revision`·`corral_any_input_idle_ms`)을 실제 `TerminalBackend` 가 guard 봉투에서
// `anyInput`·`anyRevision` 으로 읽고, 답 키(fenced `pane.send_text`)에 `expected_any_input_revision` 을 싣는지 — 칸 이름이 어긋나면 답 경로가 조용히
// 초안 울타리로만 돈다(fail-open). 소켓 stub(guard 봉투 모양) 위의 `HerdrInputBackend` 로 본다. guard 봉투 낱말을 쓰므로 어댑터 안에 둔다(check:boundary R4).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRecord, readRecord } from '../../../shared/json.js'
import { HerdrInputBackend } from '../../mobile/input-backend.js'

vi.mock('../../log.js', () => ({ log: () => {} }))

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Params = Record<string, unknown>
const methodOf = (params: Params): unknown => readRecord(params, 'operation')?.method

/** guard 봉투 stub — `any` 면 새 guard(모든 입력 칸을 싣는다), 아니면 r0 guard(초안 칸만). */
async function stubGuard(input: { any: boolean; sendError?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l708s-'))
  const socket = path.join(dir, 'guard.sock')
  const calls: Params[] = []
  const anyFields = (revision: number, idle: number) => (input.any ? { corral_any_input_revision: revision, corral_any_input_idle_ms: idle } : {})
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
      if (method === undefined) return reply({ result: { epoch: 'e', guard_version: 1, raw_capacity: 1048576, conditional_process: false, agent_ops: 1, unmanaged_prompt: 1 } })
      if (method === 'session.snapshot') return reply({ result: { snapshot: { workspaces: [], tabs: [], panes: [{ pane_id: 'c1', terminal_id: 't', corral_pty_generation: '1', workspace_id: 'w', tab_id: 'tab', cwd: '/w' }] } } })
      if (method === 'agent.get') {
        return reply({ result: { agent: { agent: 'claude', name: 'corral-x', agent_status: 'blocked', launch_pending: false, interactive_ready: true, state_change_seq: 7, pane_id: 'c1',
          corral_input_revision: 3, corral_input_idle_ms: 5_000, ...anyFields(41, 4_000) } } })
      }
      if (method === 'pane.read') return reply({ result: { read: { text: 'x', corral_input_revision: 3, corral_input_idle_ms: 5_000, corral_state_change_seq: 7, ...anyFields(41, 4_000) } } })
      // LIFE-708 r3: guard 가 울타리로 거절한 모양(아무것도 쓰지 않았다) — 코드만 다르다.
      if (method === 'pane.send_text' && input.sendError !== undefined) return reply({ error: { code: input.sendError, message: 'pane input moved since corral observed it' } })
      if (method === 'pane.send_text') return reply({ result: { corral_input_revision: 4, corral_input_idle_ms: 0, ...anyFields(42, 0) } })
      return reply({ error: { code: 'unsupported', message: String(method) } })
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve() })))
  return { socket, sends: () => calls.filter((call) => methodOf(call) === 'pane.send_text') }
}

describe('LIFE-708 r2 L1 — 모든 입력 칸의 guard ↔ TS 이음새', () => {
  it('새 guard — agent.get·pane.read 의 칸을 anyInput 으로, 답 키 요청에 expected_any_input_revision, 결과의 쓴 뒤 값을 anyRevision 으로', async () => {
    const guard = await stubGuard({ any: true })
    const backend = new HerdrInputBackend(guard.socket)
    const pane = await backend.locate('c1')
    if (pane === null) throw new Error('pane')
    expect((await backend.observe(pane)).anyInput).toEqual({ revision: 41, idleMs: 4_000 })
    expect((await backend.screen(pane)).anyInput).toEqual({ revision: 41, idleMs: 4_000 })
    expect(await backend.send(pane, { text: '1', seq: 7, inputRevision: 3, anyInputRevision: 41 })).toEqual({ kind: 'sent', revision: 4, anyRevision: 42 })
    expect(guard.sends().map((call) => [call.expected_input_revision, call.expected_any_input_revision])).toEqual([[3, 41]])
  })
  it('칸이 없는 guard(r0) — anyInput·anyRevision 은 null, 울타리 칸을 주지 않으면 요청에 싣지 않는다', async () => {
    const guard = await stubGuard({ any: false })
    const backend = new HerdrInputBackend(guard.socket)
    const pane = await backend.locate('c1')
    if (pane === null) throw new Error('pane')
    expect((await backend.observe(pane)).anyInput).toBeNull()
    expect((await backend.screen(pane)).anyInput).toBeNull()
    expect(await backend.send(pane, { text: '1', seq: 7, inputRevision: 3, anyInputRevision: null })).toEqual({ kind: 'sent', revision: 4, anyRevision: null })
    expect(guard.sends().map((call) => Object.hasOwn(call, 'expected_any_input_revision'))).toEqual([false])
  })
  // r3 M1: 울타리 거절은 「쓰지 않았다」(refused) — `unknown`(썼을 수 있음 → unconfirmed/backend)으로 새면 안 된다.
  for (const code of ['any_input_changed', 'input_changed', 'input_recent']) {
    it(`guard 울타리 거절 ${code} → send 는 refused(쓰지 않았다)`, async () => {
      const guard = await stubGuard({ any: true, sendError: code })
      const backend = new HerdrInputBackend(guard.socket)
      const pane = await backend.locate('c1')
      if (pane === null) throw new Error('pane')
      expect(await backend.send(pane, { text: '1', seq: 7, inputRevision: 3, anyInputRevision: 41 })).toEqual({ kind: 'refused' })
      expect(guard.sends()).toHaveLength(1)
    })
  }
  it('대조 — 울타리 밖 오류 코드(예: internal)는 unknown(썼을 수 있음)', async () => {
    const guard = await stubGuard({ any: true, sendError: 'internal' })
    const backend = new HerdrInputBackend(guard.socket)
    const pane = await backend.locate('c1')
    if (pane === null) throw new Error('pane')
    expect(await backend.send(pane, { text: '1', seq: 7, inputRevision: 3, anyInputRevision: 41 })).toEqual({ kind: 'unknown' })
  })
})
