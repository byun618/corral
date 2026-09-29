// R3-F1 — **닫기 억제 표를 실제 호출부로 잰다.**
//
// 라운드 2 까지 이 판정의 증거는 `store.settleSuppression` 을 직접 부른 표였다. 그래서
// **호출부가 store 에 무엇을 넘기는지는 아무도 안 쟀고**, 거기 있던 결함 둘이 그 틈으로 지나갔다:
//
//   ① GUI 는 herdr 의 **모든** 거절을 `sent:false` 로 넘겼다 — 주석에는 "소켓에 나가지 않았다"
//      라고 적혀 있었지만 `closeTab`/`closePane` 의 `rejected` 는 **답까지 받은** 것이다.
//      그래서 결과 불명이어야 할 거절에서도 표를 걷었다
//   ② CLI 는 `confirmation_required` 를 확정 거절 목록에 두지 않아 표를 남겼다 — 같은 상황을
//      GUI 와 반대로 판정했다
//
// 그래서 여기서는 **실제 GUI wrapper(`withRetentionSuppressed`)와 실제 CLI caller
// (`terminal close`)** 를 태운다. herdr 자리에는 진짜 unix 소켓 스텁을 둬서 바이트가 실제로
// 나간 뒤에 응답이 온다 — `sent` 를 테스트가 지어내지 않는다. 단정은 표의 상태
// (`store.isSuppressed`)로만 본다.
//
// 이 파일이 `adapter/internal/` 에 있는 이유는 경계다: 실제 `WorkspaceStore` 를 써야 하는데
// 어댑터 밖에서 internal 을 import 하면 `check:boundary` R1 위반이다 (r114 에서 겪었다).
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isRecord } from '../../../shared/json.js'
import { withRetentionSuppressed } from '../../close-retention.js'
import { terminalModule, type TerminalDesktop } from '../../../runtime/terminal/index.js'
import { Tokens } from '../../../runtime/terminal/tokens.js'
import type { CommandContext } from '../../../runtime/contracts.js'
import { closeTab } from './lifecycle.js'
import { WorkspaceStore } from './store.js'

const cleanups: (() => Promise<void> | void)[] = []
const previousEnv = { ...process.env }
afterEach(async () => { for (const fn of cleanups.reverse()) await fn(); cleanups.length = 0; process.env = { ...previousEnv } })

/** 스텁이 한 요청에 무엇을 할지. `hang` 은 답하지 않고, `eof` 는 답 없이 끊는다. */
type Reply =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; code: string; message?: string }
  | { kind: 'hang' }
  | { kind: 'eof' }

const PANE = 'w1:p1', TAB = 'w1:t1', WORKSPACE = 'w1', PTY = 'term1.7'
const SNAPSHOT = {
  snapshot: {
    workspaces: [{ workspace_id: WORKSPACE, worktree: { checkout_path: '/tmp', repo_root: '/tmp' } }],
    tabs: [{ tab_id: TAB, label: 'fixture' }],
    panes: [{ pane_id: PANE, tab_id: TAB, workspace_id: WORKSPACE, terminal_id: 'term1', corral_pty_generation: '7', cwd: '/tmp' }],
  },
}

/**
 * herdr 자리의 소켓 스텁. 요청 1건 = 커넥션 1개라는 실제 규약을 그대로 따른다.
 * `stop()` 은 소켓 파일까지 지운다 — **그 뒤의 연결은 ENOENT 로 실패하고, 그것이
 * 「전송 전 실패」의 진짜 모양이다** (스텁이 sent=false 를 흉내내는 게 아니다).
 */
function herdrStub(answer: (method: string, operation: string | null, stub: { vanish: () => void }) => Reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l456f1-'))
  const socket = path.join(dir, 'h.sock')
  const live = new Set<net.Socket>()
  const server = net.createServer(connection => {
    live.add(connection)
    connection.setEncoding('utf8')
    connection.on('error', () => {})
    connection.on('close', () => live.delete(connection))
    connection.on('data', chunk => {
      const message: unknown = JSON.parse(String(chunk))
      if (!isRecord(message)) return
      const params = isRecord(message.params) ? message.params : {}
      const inner = isRecord(params.operation) ? String(params.operation.method) : null
      // 핸드셰이크는 `operation` 없는 `corral.terminal` 이다 — 스텁이 늘 같은 봉투를 준다.
      if (message.method === 'corral.terminal' && params.operation === undefined) {
        connection.end(JSON.stringify({ id: message.id, result: { epoch: 'e', guard_version: 1, raw_capacity: 1048576, conditional_process: false, agent_ops: 1 } }) + '\n')
        return
      }
      const reply = answer(String(message.method), inner, { vanish })
      if (reply.kind === 'hang') return
      if (reply.kind === 'eof') { connection.destroy(); return }
      connection.end(JSON.stringify(reply.kind === 'result'
        ? { id: message.id, result: reply.result }
        : { id: message.id, error: { code: reply.code, message: reply.message ?? reply.code } }) + '\n')
    })
  })
  /**
   * 소켓 파일을 **답을 쓰기 전에** 지운다. 요청 1건 = 커넥션 1개라, 이 답을 받은 클라이언트가
   * 그 다음에 여는 연결은 반드시 ENOENT 다 — 「전송 전 실패」가 경쟁 없이 재현된다.
   */
  const vanish = (): void => { fs.rmSync(socket, { force: true }) }
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const connection of live) connection.destroy()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    fs.rmSync(socket, { force: true })
  }
  cleanups.push(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { socket, stop, listen: () => new Promise<void>(resolve => { server.listen(socket, resolve) }) }
}

/**
 * 실제 억제 표. **표를 찍는 것도 걷는 것도 테스트가 아니라 제품 코드가 한다** —
 * GUI 는 `withRetentionSuppressed` 가, CLI 는 `terminal close` 가 부른다.
 * 여기서는 그 결과(`isSuppressed`)만 읽는다.
 */
const ledger = (): WorkspaceStore => new WorkspaceStore()

describe('R3-F1 — GUI 닫기 wrapper 가 전송 여부를 실제로 넘긴다', () => {
  const closeRow = async (store: WorkspaceStore, socket: string) =>
    withRetentionSuppressed({
      store, ids: [TAB], what: 'tab',
      run: hooks => closeTab(socket, TAB, hooks),
    })

  it('`confirmation_required` — herdr 가 손대지 않고 거절했다: 표를 걷는다', async () => {
    const stub = herdrStub(() => ({ kind: 'error', code: 'confirmation_required', message: 'closing this tab would close a worktree group' }))
    await stub.listen()
    const store = ledger()
    const outcome = await closeRow(store, stub.socket)
    expect(outcome).toMatchObject({ outcome: 'rejected', rejection: { code: 'confirmation_required' } })
    expect(store.isSuppressed(TAB)).toBe(false)
  })

  it('**모르는 코드의 거절은 표를 남긴다** — 라운드 2 는 여기서 `sent:false` 를 박아 걷었다', async () => {
    const stub = herdrStub(() => ({ kind: 'error', code: 'pane_send_failed' }))
    await stub.listen()
    const store = ledger()
    const outcome = await closeRow(store, stub.socket)
    expect(outcome).toMatchObject({ outcome: 'rejected', rejection: { code: 'pane_send_failed' } })
    expect(store.isSuppressed(TAB)).toBe(true)
  })

  it('전송 전 실패(소켓 없음)는 표를 걷는다 — 코드만으로는 못 가르는 자리다', async () => {
    const stub = herdrStub(() => ({ kind: 'result', result: {} }))
    await stub.listen()
    await stub.stop()
    const store = ledger()
    await expect(closeRow(store, stub.socket)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(store.isSuppressed(TAB)).toBe(false)
  })

  it('전송 뒤 끊김(EOF)은 표를 남긴다 — 닫혔을 수도 있다', async () => {
    const stub = herdrStub(() => ({ kind: 'eof' }))
    await stub.listen()
    const store = ledger()
    await expect(closeRow(store, stub.socket)).rejects.toMatchObject({ code: 'closed' })
    expect(store.isSuppressed(TAB)).toBe(true)
  })
})

describe('R3-F1 — CLI `terminal close` 가 GUI 와 **같은 분류**를 쓴다', () => {
  /** 실제 terminalModule 을 실제 store 에 연결한다 — 프로덕션의 `terminalDesktop` 과 같은 다리다. */
  function cli(stubSocket: string) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'l456f1d-'))
    cleanups.push(() => { fs.rmSync(data, { recursive: true, force: true }) })
    process.env.CORRAL_BACKEND_SOCKET = stubSocket
    process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
    const store = ledger()
    const desktop: TerminalDesktop = {
      available: () => true,
      changed: async () => {},
      reveal: async () => {},
      retention: {
        suppress: id => { store.suppressRetention(id) },
        release: id => { store.releaseSuppression(id) },
        settle: input => ({ effect: store.settleSuppression(input).effect }),
      },
    }
    const token = new Tokens(data).encode('t1', { runtimeId: 'test', epoch: 'e', ptyId: PTY, paneId: PANE })
    const context: CommandContext = { runtimeId: 'test', instanceId: randomUUID(), userData: data,
      signal: new AbortController().signal, remote: false, deadlineAt: Date.now() + 1500 }
    const close = () => terminalModule(data, desktop).execute({ command: 'terminal close', flags: { terminal: token }, args: [], cwd: '/tmp' }, context)
    return { store, close }
  }
  const route = (onClose: Reply) => (method: string, operation: string | null): Reply => {
    if (method === 'corral.terminal' && operation === 'session.snapshot') return { kind: 'result', result: SNAPSHOT }
    if (method === 'corral.terminal' && operation === 'pane.close') return onClose
    return { kind: 'error', code: 'unsupported' }
  }

  it('`confirmation_required` — **라운드 2 의 CLI 는 여기서 표를 남겼다**. 이제 걷는다', async () => {
    const stub = herdrStub(route({ kind: 'error', code: 'confirmation_required' }))
    await stub.listen()
    const { store, close } = cli(stub.socket)
    await expect(close()).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(store.isSuppressed(PANE)).toBe(false)
  })

  it('전송 뒤 끊김과 전송 전 실패는 **같은 `backend_unavailable`** 인데 판정이 갈린다', async () => {
    // ① 전송 뒤 EOF — 닫혔을 수도 있다 → 표를 남긴다
    const after = herdrStub(route({ kind: 'eof' }))
    await after.listen()
    const live = cli(after.socket)
    await expect(live.close()).rejects.toMatchObject({ code: 'backend_unavailable' })
    expect(live.store.isSuppressed(PANE)).toBe(true)

    // ② 스냅샷까지 답한 뒤 backend 가 사라진다 — 닫기 요청은 나가지도 못했다 → 표를 걷는다
    const gone = herdrStub((method, operation, stub) => {
      if (method === 'corral.terminal' && operation === 'session.snapshot') { stub.vanish(); return { kind: 'result', result: SNAPSHOT } }
      return { kind: 'error', code: 'unsupported' }
    })
    await gone.listen()
    const dying = cli(gone.socket)
    await expect(dying.close()).rejects.toMatchObject({ code: 'backend_unavailable' })
    expect(dying.store.isSuppressed(PANE)).toBe(false)
  })

  it('전송 뒤 무응답(타임아웃)은 표를 남긴다 — GUI 와 같은 쪽이다', async () => {
    const stub = herdrStub(route({ kind: 'hang' }))
    await stub.listen()
    const { store, close } = cli(stub.socket)
    await expect(close()).rejects.toMatchObject({ code: 'backend_timeout' })
    expect(store.isSuppressed(PANE)).toBe(true)
  })
})
