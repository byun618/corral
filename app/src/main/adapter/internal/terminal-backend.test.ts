// LIFE-417 N4 — `agent.start` 의 `agent_pane_busy` 되걸기를 **되걸기 루프 자체 수준에서** 잰다.
//
// 결함은 CLI 경로(`terminal create --agent` = `worker-start` 기동)가 GUI 행 생성(lifecycle.ts
// createRow, L2)과 달리 되걸기를 안 해서 났다. 네이티브 3/3 재현: pane 의 zsh 가 rc(pyenv·nvm)를
// 도는 동안 전경 그룹이 셸 하나가 아니라 herdr 가 거절하고, 1회 호출이라 그대로 실패로 끝났다.
//
// 여기서 재는 것은 규약 네 줄이다: ① busy 만 되건다 ② 간격을 두고 되건다 ③ 상한을 넘기면
// **마지막 거절을 그대로** 던진다 ④ 호출자 deadline 이 더 이르면 그쪽이 상한이다.
// 실제 15초는 기다리지 않는다 — 상한·간격을 생성자로 주입한다.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { isRecord } from '../../../shared/json.js'
import { TerminalBackend, type TerminalIdentity } from './terminal-backend.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.reverse()) await fn(); cleanups.length = 0 })

const TARGET: TerminalIdentity = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 'tab', workspaceId: 'w', path: '/tmp', repo: '/tmp', title: '' }
const AGENT = { agent_status: 'idle', name: 'corral-fixture', agent: 'claude', launch_pending: true, state_change_seq: 1 }

/**
 * 스텁 guard — 핸드셰이크(`operation` 없음)와 `agent.start` 만 답한다. `replies` 가 시도마다
 * 무엇을 돌려줄지 정한다: 목록이 마르면 마지막 항목을 계속 쓴다(무한 busy).
 */
function guard(replies: ({ code: string } | 'ok')[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l417-'))
  const socket = path.join(dir, 'guard.sock')
  const attempts: number[] = []
  const server = net.createServer(connection => {
    connection.setEncoding('utf8')
    connection.on('data', chunk => {
      const message: unknown = JSON.parse(String(chunk))
      const params = isRecord(message) && isRecord(message.params) ? message.params : {}
      if (params.operation === undefined) { connection.end(JSON.stringify({ id: 'x', result: { guard_version: 1, agent_ops: 1, epoch: 'e' } }) + '\n'); return }
      const reply = replies[Math.min(attempts.length, replies.length - 1)]!
      attempts.push(Date.now())
      connection.end(JSON.stringify(reply === 'ok'
        ? { id: 'x', result: { agent: AGENT, argv: ['claude'] } }
        : { id: 'x', error: { code: reply.code, message: `agent target pane ${String(TARGET.paneId)} is not an available shell` } }) + '\n')
    })
  })
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve() }) }))
  return { socket, attempts, listen: () => new Promise<void>(resolve => server.listen(socket, resolve)) }
}

const BUSY = { code: 'agent_pane_busy' }
const POLICY = { timeoutMs: 600, intervalMs: 20 }

async function start(stub: ReturnType<typeof guard>, options: { deadlineMs?: number; retriesSeen?: number[] } = {}) {
  await stub.listen()
  const backend = new TerminalBackend(stub.socket, POLICY)
  const ctx = { signal: new AbortController().signal, deadlineAt: Date.now() + (options.deadlineMs ?? 5000) }
  expect(await backend.epoch(ctx)).toBe('e')
  return backend.startAgent(TARGET, { name: 'corral-fixture', kind: 'claude', args: [], timeoutMs: 1000,
    onBusyRetry: retries => { options.retriesSeen?.push(retries) } }, ctx)
}

describe('LIFE-417 N4 — agent.start busy 되걸기 (CLI 경로)', () => {
  it('busy 2회 뒤 성공한다 — 시도 3회, 되걸기 2회, 간격을 실제로 둔다', async () => {
    const stub = guard([BUSY, BUSY, 'ok']), retriesSeen: number[] = []
    const started = await start(stub, { retriesSeen })
    expect(started.argv).toEqual(['claude'])
    expect(started.agent.status).toBe('idle')
    expect(retriesSeen).toEqual([1, 2])
    expect(stub.attempts).toHaveLength(3)
    expect(stub.attempts[2]! - stub.attempts[0]!).toBeGreaterThanOrEqual(2 * POLICY.intervalMs - 5)
  })

  it('상한을 넘기면 마지막 agent_pane_busy 를 그대로 던진다 — 되걸기 ≥ 1', async () => {
    const stub = guard([BUSY]), retriesSeen: number[] = []
    await expect(start(stub, { retriesSeen })).rejects.toMatchObject({ code: 'agent_pane_busy' })
    expect(retriesSeen.length).toBeGreaterThanOrEqual(1)
    expect(retriesSeen[retriesSeen.length - 1]).toBe(retriesSeen.length)
    expect(stub.attempts.length).toBe(retriesSeen.length + 1)
  })

  it('busy 가 아닌 거절은 되걸지 않는다 — 시도 1회', async () => {
    const stub = guard([{ code: 'invalid_agent_name' }]), retriesSeen: number[] = []
    await expect(start(stub, { retriesSeen })).rejects.toMatchObject({ code: 'invalid_agent_name' })
    expect(retriesSeen).toEqual([])
    expect(stub.attempts).toHaveLength(1)
  })

  it('호출자 deadline 이 더 이르면 그쪽이 상한이다 — 그래도 원인은 agent_pane_busy 다', async () => {
    const stub = guard([BUSY]), retriesSeen: number[] = []
    const started = Date.now()
    // 상한 600ms 보다 훨씬 이른 deadline. `deadline_exceeded`·`backend_timeout` 으로 원인이
    // 덮이면 이 단언이 깨진다 — 되걸기를 멈추는 자리가 마지막 시도 **뒤**여야 하는 이유다.
    await expect(start(stub, { deadlineMs: 150, retriesSeen })).rejects.toMatchObject({ code: 'agent_pane_busy' })
    expect(Date.now() - started).toBeLessThan(POLICY.timeoutMs)
  })
})
