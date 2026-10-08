// LIFE-556 fix2 M1 — H1 완화의 실제 판정(`callerPlacement` → `senderClaim`)을 런타임 층에서 본다.
// `socketIsBackend` 를 주입하지 않는다: 실제 파일 두 개(+ 심링크)와 바인딩을 두고 `orchestration send --type worker_done`
// 을 모듈 입구로 부른다. 기록은 `default`(동봉 backend 와 같은 세션 이름), 호출자는 이름 없는 pane 이다.
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { OrchestrationStore } from './store.js'
import { createRun, createTask, emptyState } from './model.js'
import { TerminalBackend, type TerminalIdentity } from '../../main/adapter/index.js'
import type { CallerIdentity } from '../contracts.js'
import { isRecord } from '../../shared/json.js'

const term = vi.hoisted(() => ({ create: { handle: 't1.child', epoch: 'e1', ptyId: 'pty-child', paneId: 'w1:p9' } }))
vi.mock('../terminal/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../terminal/index.js')>()
  return {
    ...actual,
    terminalModule: () => ({
      specs: [], validate: () => {},
      execute: async (inv: { command: string }) => {
        if (inv.command === 'terminal create') return { terminal: term.create, agent: { kind: 'claude' }, stages: { agent: { status: 'completed' } } }
        if (inv.command === 'terminal show') return { terminal: term.create, agent: { kind: 'claude' } }
        if (inv.command === 'terminal wait') return { satisfied: true, agent: { phase: 'idle' } }
        if (inv.command === 'terminal send') return {}
        if (inv.command === 'terminal prompt') return { record: { matchCount: 1, naiveCount: 1, cursorInvalidated: false, unavailableReason: null }, outcome: 'completed', wait: { requested: 'accepted', satisfied: true } }
        throw Error(inv.command)
      },
    }),
  }
})
const { orchestrationModule } = await import('./index.js')

const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l556-sock-'))
const BACKEND_SOCKET = path.join(socketDir, 'herdr.sock'), LINKED_SOCKET = path.join(socketDir, 'link.sock'), OTHER_SOCKET = path.join(socketDir, 'other.sock')
fs.writeFileSync(BACKEND_SOCKET, ''); fs.writeFileSync(OTHER_SOCKET, ''); fs.symlinkSync(BACKEND_SOCKET, LINKED_SOCKET)
const CHILD: TerminalIdentity = { epoch: 'e1', ptyId: 'pty-child', paneId: 'w1:p9', tabId: 't', workspaceId: 'w', path: '/tmp', repo: '/tmp', title: 'child' }

function bind(binding: { socket: string; session: string } | null) {
  if (binding === null) { delete process.env.CORRAL_BACKEND_SOCKET; delete process.env.CORRAL_SESSION; return }
  process.env.CORRAL_BACKEND_SOCKET = binding.socket
  process.env.CORRAL_SESSION = binding.session
}

/** 동봉과 같은 바인딩(default 세션·backend 소켓)으로 워커 시도 하나를 연다. 그 뒤 보고 때의 바인딩은 케이스가 정한다. */
async function started() {
  bind({ socket: BACKEND_SOCKET, session: 'default' })
  vi.restoreAllMocks()
  vi.spyOn(TerminalBackend.prototype, 'epoch').mockResolvedValue('e1')
  vi.spyOn(TerminalBackend.prototype, 'list').mockResolvedValue([CHILD])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l556-send-'))
  const run = createRun(emptyState(), 'l556 m1', new Date().toISOString())
  const made = createTask(run.state, { runId: run.run.id, spec: 'body', title: null, deps: [], at: new Date().toISOString() })
  const store = new OrchestrationStore(dir)
  store.write(made.state)
  const mod = orchestrationModule(dir)
  await new Promise(resolve => setTimeout(resolve, 5))
  const ctx = { runtimeId: 'runtime', instanceId: 'instance', userData: dir, signal: new AbortController().signal, deadlineAt: Date.now() + 10000, remote: false }
  const result = await mod.execute({ command: 'orchestration worker-start', flags: { task: made.task.id, agent: 'claude', worktree: dir, 'request-id': `r1.${Date.now()}.${randomUUID()}` }, args: [], cwd: dir, caller: { paneId: null, session: null } }, ctx)
  if (!isRecord(result) || typeof result.dispatchId !== 'string') throw Error(`no attempt: ${JSON.stringify(result)}`)
  const dispatchId = result.dispatchId
  expect(store.read().dispatches.find(entry => entry.id === dispatchId)?.worker?.paneSession).toBe('default')
  const report = async (caller: CallerIdentity) => {
    try {
      const sent = await mod.execute({ command: 'orchestration send', flags: { type: 'worker_done', subject: 's', body: 'b', 'task-id': made.task.id, 'dispatch-id': dispatchId, outcome: 'succeeded' }, args: [], cwd: dir, caller }, { ...ctx, deadlineAt: Date.now() + 10000 })
      return { ok: true as const, sent, status: store.read().dispatches.find(entry => entry.id === dispatchId)?.status }
    } catch (error) {
      return { ok: false as const, code: isRecord(error) ? error.code : null, status: store.read().dispatches.find(entry => entry.id === dispatchId)?.status }
    }
  }
  return { report }
}

describe('LIFE-556 fix2 M1 — sender 검사의 소켓 판정 (실제 소켓 파일)', () => {
  afterEach(() => { vi.restoreAllMocks(); bind(null) })

  it('ⓐ 같은 소켓 — 그 경로 그대로든 심링크 경유든 — + 이름 없음 → 받는다(sessionVerified)', async () => {
    for (const socket of [BACKEND_SOCKET, LINKED_SOCKET]) {
      const { report } = await started()
      const verdict = await report({ paneId: 'w1:p9', session: null, socket })
      expect(verdict).toMatchObject({ ok: true, status: 'completed' })
      expect(JSON.stringify(verdict.ok && verdict.sent)).toContain('"sessionVerified":true')
    }
  })

  it('ⓑ 다른 소켓 + 이름 없음 + 같은 pane id → sender_mismatch, 시도는 그대로', async () => {
    const { report } = await started()
    expect(await report({ paneId: 'w1:p9', session: null, socket: OTHER_SOCKET })).toEqual({ ok: false, code: 'sender_mismatch', status: 'dispatched' })
    // 없는 소켓(realpath 실패)도 같다.
    expect(await report({ paneId: 'w1:p9', session: null, socket: path.join(socketDir, 'gone.sock') })).toEqual({ ok: false, code: 'sender_mismatch', status: 'dispatched' })
    // 같은 시도에 이 backend 소켓으로 오면 받는다 — 위 거절이 시도를 망가뜨리지 않았다.
    expect(await report({ paneId: 'w1:p9', session: null, socket: BACKEND_SOCKET })).toMatchObject({ ok: true, status: 'completed' })
  })

  it('ⓒ 보고 때 바인딩이 없으면 소켓이 같아도 거절', async () => {
    const { report } = await started()
    bind(null)
    expect(await report({ paneId: 'w1:p9', session: null, socket: BACKEND_SOCKET })).toEqual({ ok: false, code: 'sender_mismatch', status: 'dispatched' })
  })
})
