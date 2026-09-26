// LIFE-417 N4 — `agent.start` 의 `agent_pane_busy` 되걸기를 **되걸기 루프 자체 수준에서** 잰다.
//
// 결함은 CLI 경로(`terminal create --agent` = `worker-start` 기동)가 GUI 행 생성(lifecycle.ts
// createRow, L2)과 달리 되걸기를 안 해서 났다. 네이티브 3/3 재현: pane 의 zsh 가 rc(pyenv·nvm)를
// 도는 동안 전경 그룹이 셸 하나가 아니라 herdr 가 거절하고, 1회 호출이라 그대로 실패로 끝났다.
//
// 여기서 재는 것은 규약이다: ① busy 만 되건다 ② 간격을 두고 되건다 ③ **기다림까지 상한 안에**
// 들어야 한다(r6 R5-1) ④ 상한을 넘기면 마지막 거절을 그대로 던진다 ⑤ 호출자 deadline 이 더
// 이르면 그쪽이 상한이다 ⑥ 취소는 간격 도중에도 즉시 따르고, 나가지 않은 시도는 안 센다(r6 R5-3).
//
// 실제 15초는 기다리지 않는다 — 상한·간격을 생성자로 주입한다. 시간에 기대는 두 사례(상한 경계·
// 취소)는 **간격 대비 여유를 크게** 잡아 실시간 확률 의존을 없앴다(r6 R5-4).
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { isRecord } from '../../../shared/json.js'
import { TerminalBackend, type BusyRetryPolicy, type TerminalIdentity } from './terminal-backend.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.reverse()) await fn(); cleanups.length = 0 })

const TARGET: TerminalIdentity = { epoch: 'e', ptyId: 'p', paneId: 'pane', tabId: 'tab', workspaceId: 'w', path: '/tmp', repo: '/tmp', title: '' }
const AGENT = { agent_status: 'idle', name: 'corral-fixture', agent: 'claude', launch_pending: true, state_change_seq: 1 }

/**
 * 스텁 guard — 핸드셰이크(`operation` 없음)와 `agent.start` 만 답한다. `replies` 가 시도마다
 * 무엇을 돌려줄지 정한다: 목록이 마르면 마지막 항목을 계속 쓴다(무한 busy). `attempts` 에는
 * 시도가 **서버에 닿은 시각**이 쌓인다 — 상한 경계는 이 값으로 잰다.
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
const POLICY: BusyRetryPolicy = { timeoutMs: 600, intervalMs: 20 }

/**
 * 핸드셰이크를 먼저 끝내고 **그 뒤에** startAgent 의 ctx 를 만든다 — deadline 사례가 재는 것은
 * `agent.start` 한 번에 남은 시간이지 핸드셰이크까지 포함한 시간이 아니다.
 */
async function start(stub: ReturnType<typeof guard>, options: { policy?: BusyRetryPolicy; deadlineMs?: number; retriesSeen?: number[]; signal?: AbortSignal } = {}) {
  await stub.listen()
  const backend = new TerminalBackend(stub.socket, options.policy ?? POLICY)
  const signal = options.signal ?? new AbortController().signal
  expect(await backend.epoch({ signal, deadlineAt: Date.now() + 5000 })).toBe('e')
  const ctx = { signal, deadlineAt: Date.now() + (options.deadlineMs ?? 5000) }
  return backend.startAgent(TARGET, { name: 'corral-fixture', kind: 'claude', args: [], timeoutMs: 1000,
    onBusyRetry: retries => { options.retriesSeen?.push(retries) } }, ctx)
}

describe('LIFE-417 N4 — agent.start busy 되걸기 (CLI 경로)', () => {
  it('첫 시도에 성공하면 되걸기 0 — 시도 1회, onBusyRetry 는 안 불린다', async () => {
    const stub = guard(['ok']), retriesSeen: number[] = []
    const started = await start(stub, { retriesSeen })
    expect(started.argv).toEqual(['claude'])
    expect(started.agent.status).toBe('idle')
    expect(retriesSeen).toEqual([])
    expect(stub.attempts).toHaveLength(1)
  })

  it('busy 2회 뒤 성공한다 — 시도 3회, 되걸기 2회, 간격을 실제로 둔다', async () => {
    const stub = guard([BUSY, BUSY, 'ok']), retriesSeen: number[] = []
    const started = await start(stub, { retriesSeen })
    expect(started.argv).toEqual(['claude'])
    expect(retriesSeen).toEqual([1, 2])
    expect(stub.attempts).toHaveLength(3)
    expect(stub.attempts[2]! - stub.attempts[0]!).toBeGreaterThanOrEqual(2 * POLICY.intervalMs - 5)
  })

  it('상한을 넘기면 마지막 agent_pane_busy 를 그대로 던진다 — 되걸기 ≥ 1, 시도 = 되걸기+1', async () => {
    const stub = guard([BUSY]), retriesSeen: number[] = []
    await expect(start(stub, { retriesSeen })).rejects.toMatchObject({ code: 'agent_pane_busy' })
    expect(retriesSeen.length).toBeGreaterThanOrEqual(1)
    expect(retriesSeen[retriesSeen.length - 1]).toBe(retriesSeen.length)
    expect(stub.attempts.length).toBe(retriesSeen.length + 1)
  })

  it('마지막 시도가 상한 안에서 나간다 — 기다림까지 상한에 넣고 센다 (R5-1)', async () => {
    // 간격 100 · 상한 260 이라 규약대로면 시도는 ~0·100·200 세 번이고 마지막이 상한 안이다.
    // 고친 검사(`경과 + 간격 > 상한`)가 없으면 네 번째가 ~300 에 나가 상한 밖이 된다.
    // 상한을 간격의 정수배에서 60ms 띄워 둬서 setTimeout 지연이 판정을 흔들지 못한다.
    const policy: BusyRetryPolicy = { timeoutMs: 260, intervalMs: 100 }
    const stub = guard([BUSY]), retriesSeen: number[] = []
    const before = Date.now() // startAgent 안의 startedAt 보다 이르거나 같다 — 보수적인 기준점
    await expect(start(stub, { policy, retriesSeen, deadlineMs: 10_000 })).rejects.toMatchObject({ code: 'agent_pane_busy' })
    expect(stub.attempts.length).toBeGreaterThanOrEqual(2)
    expect(stub.attempts.length).toBeLessThanOrEqual(3)
    expect(stub.attempts[stub.attempts.length - 1]! - before).toBeLessThanOrEqual(policy.timeoutMs)
    expect(stub.attempts.length).toBe(retriesSeen.length + 1)
  })

  it('busy 가 아닌 거절은 되걸지 않는다 — 시도 1회', async () => {
    const stub = guard([{ code: 'invalid_agent_name' }]), retriesSeen: number[] = []
    await expect(start(stub, { retriesSeen })).rejects.toMatchObject({ code: 'invalid_agent_name' })
    expect(retriesSeen).toEqual([])
    expect(stub.attempts).toHaveLength(1)
  })

  it('호출자 deadline 이 간격보다 짧으면 되걸지 않는다 — 원인은 agent_pane_busy 다', async () => {
    // 간격 5000 · deadline 1000: 첫 busy 응답 시점이 언제든 `now + 5000 >= deadlineAt` 이라
    // 판정이 시간에 안 걸린다. 시도 자체에는 1초가 통째로 있어 실시간 확률 의존이 없다 (R5-4).
    const stub = guard([BUSY]), retriesSeen: number[] = []
    const before = Date.now()
    await expect(start(stub, { policy: { timeoutMs: 60_000, intervalMs: 5_000 }, deadlineMs: 1000, retriesSeen }))
      .rejects.toMatchObject({ code: 'agent_pane_busy' })
    expect(retriesSeen).toEqual([])
    expect(stub.attempts).toHaveLength(1)
    expect(Date.now() - before).toBeLessThan(1000)
  })

  it('간격 도중 취소는 즉시 따르고, 나가지 않은 시도는 안 센다 (R5-3)', async () => {
    // 간격 1000 에 취소는 100ms 에 — 취소가 요청 왕복 중에 떨어질 여지가 없을 만큼 띄웠다.
    const stub = guard([BUSY]), retriesSeen: number[] = []
    const controller = new AbortController()
    const before = Date.now()
    setTimeout(() => { controller.abort() }, 100)
    await expect(start(stub, { policy: { timeoutMs: 60_000, intervalMs: 1_000 }, deadlineMs: 10_000, retriesSeen, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(retriesSeen).toEqual([])
    expect(stub.attempts).toHaveLength(1)
    expect(Date.now() - before).toBeLessThan(500)
  })
})
