// LIFE-569 — orchestration 의 회수 닫기(worker-release·worker-stop → `closePane`)가 CLI
// `terminal close` 와 **같은 억제 표**를 지나는가.
//
// 결함: orchestration 이 내부 터미널 모듈을 desktop 없이 만들어서 회수 닫기의
// `desktop?.retention?.suppress` 가 no-op 이었다. 그래서 done 워커 pane 을 회수하면 store 가
// 그 닫힘을 비명시 사라짐으로 보고 「닫힌 탭」 완료 행으로 남겼다(C1 네이티브 재현).
//
// 여기서는 **실제 `orchestrationModule` → 실제 `terminal close` → 실제 `WorkspaceStore`** 를
// 태운다. 억제 표를 찍고 걷는 것은 제품 코드이고, 분류는 CLI 와 같은
// `settleSuppression` 이다(새 분류기 없음). herdr 자리는 close-retention.test.ts 와 같은
// 진짜 unix 소켓 스텁 — 요청 1건 = 커넥션 1개. 단정은 표(`isSuppressed`)와 보존 결과
// (`retainedRows`)로만 본다.
//
// 이 파일이 `adapter/internal/` 에 있는 이유는 close-retention.test.ts 와 같다(check:boundary R1).
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isRecord } from '../../../shared/json.js'
import { orchestrationModule } from '../../../runtime/orchestration/index.js'
import { startRuntime } from '../../../runtime/server.js'
import { OrchestrationStore } from '../../../runtime/orchestration/store.js'
import { createDispatch, createRun, createTask, emptyState, transition } from '../../../runtime/orchestration/model.js'
import { emptyWorker } from '../../../runtime/orchestration/worker.js'
import type { TerminalDesktop } from '../../../runtime/terminal/index.js'
import { Tokens } from '../../../runtime/terminal/tokens.js'
import type { CommandContext } from '../../../runtime/contracts.js'
import { WorkspaceStore } from './store.js'

const cleanups: (() => Promise<void> | void)[] = []
const previousEnv = { ...process.env }
afterEach(async () => { for (const fn of cleanups.reverse()) await fn(); cleanups.length = 0; process.env = { ...previousEnv } })

/** 워커 pane(회수 대상)과 같은 workspace 의 다른 탭 pane(C5). 둘 다 herdr 기준 `done`. */
const WORKER = { pane: 'w1:p1', tab: 'w1:t1', terminal: 'term1', generation: '7' }
const OTHER = { pane: 'w1:p2', tab: 'w1:t2', terminal: 'term2', generation: '3' }
const WORKSPACE = 'w1'
const PANES = [WORKER, OTHER]

/**
 * `pane.close` 에 스텁이 할 일.
 *   closed  — 닫고(목록에서 뺀다) 성공을 답한다
 *   stays   — 성공을 답하지만 PTY 가 목록에 남는다 (수락 뒤 잔존 = 결과 불명)
 *   error   — 그 코드로 거절한다 (답까지 받은 거절)
 *   hang    — 답하지 않는다 (전송 뒤 무응답 = backend_timeout)
 */
type CloseReply = { kind: 'closed' } | { kind: 'stays' } | { kind: 'error'; code: string } | { kind: 'hang' }

function herdrStub(input: { onClose: CloseReply; goneAfterSnapshots?: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l569-'))
  const socket = path.join(dir, 'h.sock')
  const live = new Set<net.Socket>()
  const listed = new Set(PANES.map(pane => pane.pane))
  const seen = { snapshots: 0, closes: 0 }
  const snapshot = () => ({
    snapshot: {
      workspaces: [{ workspace_id: WORKSPACE, worktree: { checkout_path: '/tmp', repo_root: '/tmp' } }],
      tabs: PANES.map(pane => ({ tab_id: pane.tab, label: pane.tab })),
      panes: PANES.filter(pane => listed.has(pane.pane)).map(pane => ({
        pane_id: pane.pane, tab_id: pane.tab, workspace_id: WORKSPACE, terminal_id: pane.terminal, corral_pty_generation: pane.generation, cwd: '/tmp',
      })),
    },
  })
  const server = net.createServer(connection => {
    live.add(connection)
    connection.setEncoding('utf8')
    connection.on('error', () => {})
    connection.on('close', () => live.delete(connection))
    connection.on('data', chunk => {
      const message: unknown = JSON.parse(String(chunk))
      if (!isRecord(message)) return
      const params = isRecord(message.params) ? message.params : {}
      const answer = (body: { result: unknown } | { error: { code: string; message: string } }) =>
        connection.end(JSON.stringify({ id: message.id, ...body }) + '\n')
      if (message.method === 'corral.terminal' && params.operation === undefined) {
        answer({ result: { epoch: 'e', guard_version: 1, raw_capacity: 1048576, conditional_process: false, agent_ops: 1 } })
        return
      }
      const operation = isRecord(params.operation) ? String(params.operation.method) : null
      if (operation === 'session.snapshot') {
        seen.snapshots++
        // `stale_terminal` 을 실제 경로로 만든다: 회수의 관측은 pane 을 보고, 그 뒤 `terminal close`
        // 가 핸들을 풀 때는 pane 이 없다 — 관측과 닫기 사이에 pane 이 사라진 모양.
        if (input.goneAfterSnapshots !== undefined && seen.snapshots > input.goneAfterSnapshots) listed.delete(WORKER.pane)
        answer({ result: snapshot() })
        return
      }
      if (operation === 'pane.close') {
        seen.closes++
        const reply = input.onClose
        if (reply.kind === 'hang') return
        if (reply.kind === 'error') { answer({ error: { code: reply.code, message: reply.code } }); return }
        if (reply.kind === 'closed') listed.delete(WORKER.pane)
        answer({ result: {} })
        return
      }
      answer({ error: { code: 'unsupported', message: 'unsupported' } })
    })
  })
  cleanups.push(async () => {
    for (const connection of live) connection.destroy()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { socket, seen, listen: () => new Promise<void>(resolve => { server.listen(socket, resolve) }) }
}

/**
 * GUI 의 store — 두 pane 이 `done` 인 스냅샷을 먹인다. 회수 뒤 `pane_closed` 를 흘려
 * 실제 보존 규칙(`retain`)이 무엇을 남기는지 본다.
 */
function guiStore(): WorkspaceStore {
  const store = new WorkspaceStore()
  store.applySnapshot({
    workspaces: [{ workspace_id: WORKSPACE, label: 'repo', number: 1, focused: true, agent_status: 'done' }],
    tabs: PANES.map((pane, index) => ({ tab_id: pane.tab, workspace_id: WORKSPACE, label: pane.tab, number: index + 1, agent_status: 'done' })),
    panes: PANES.map(pane => ({ pane_id: pane.pane, tab_id: pane.tab, workspace_id: WORKSPACE, agent_status: 'done' })),
  })
  return store
}

/**
 * 프로덕션 `main/index.ts` 의 `terminalDesktop` 과 같은 다리 — 표는 실제 store 에 찍힌다.
 * `changed` 는 GUI 트리 재구성 자리다. 기본은 즉시 끝나고, F1·F2 단위는 느린·던지는 것으로 바꾼다.
 */
function desktopFor(input: { store: WorkspaceStore; changed?: () => Promise<void> }) {
  const { store } = input
  const seen: { changed: number; settled: { code: string | null; sent: boolean; effect: string }[] } = { changed: 0, settled: [] }
  const desktop: TerminalDesktop = {
    available: () => true,
    changed: async () => { seen.changed++; await input.changed?.() },
    reveal: async () => {},
    retention: {
      suppress: id => { store.suppressRetention(id) },
      release: id => { store.releaseSuppression(id) },
      settle: input => {
        const settled = store.settleSuppression(input)
        seen.settled.push({ code: input.code ?? null, sent: input.sent, effect: settled.effect })
        return { effect: settled.effect }
      },
    },
  }
  return { desktop, seen }
}

/**
 * 워커 pane 을 쥔 시도 하나를 제품의 이동만으로 만든다. `release` 는 끝난 시도(worker-release 대상),
 * `stop` 은 열린 시도(worker-stop 대상).
 */
function attempt(input: { data: string; kind: 'release' | 'stop'; runtimeId: string }): string {
  const { data, kind, runtimeId } = input
  const at = new Date().toISOString()
  const run = createRun(emptyState(), 'l569', at)
  const made = createTask(run.state, { runId: run.run.id, spec: 'worker', title: null, deps: [], at })
  const handle = new Tokens(data).encode('t1', { runtimeId, epoch: 'e', ptyId: `${WORKER.terminal}.${WORKER.generation}`, paneId: WORKER.pane })
  const dispatched = createDispatch(made.state, {
    task: made.task, target: { handle, runtimeId, epoch: 'e', ptyId: `${WORKER.terminal}.${WORKER.generation}`, paneId: WORKER.pane },
    agent: null, agentAbsenceReason: 'no_managed_agent', at,
    worker: emptyWorker({ launch: 'created', ownership: 'owned', paneSession: null, originDispatchId: null }),
  })
  const state = kind === 'release'
    ? transition(dispatched.state, { taskId: made.task.id, to: 'completed', settledBy: 'worker_done', at }).state
    : dispatched.state
  new OrchestrationStore(data).write(state)
  return dispatched.dispatch.id
}

async function recover(input: { kind: 'release' | 'stop'; stub: ReturnType<typeof herdrStub>; desktop?: TerminalDesktop; deadlineMs?: number }) {
  await input.stub.listen()
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'l569d-'))
  cleanups.push(() => { fs.rmSync(data, { recursive: true, force: true }) })
  process.env.CORRAL_BACKEND_SOCKET = input.stub.socket
  delete process.env.CORRAL_SESSION
  process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
  const dispatchId = attempt({ data, kind: input.kind, runtimeId: 'test' })
  const mod = input.desktop === undefined ? orchestrationModule(data) : orchestrationModule(data, { terminalDesktop: input.desktop })
  const context: CommandContext = { runtimeId: 'test', instanceId: randomUUID(), userData: data,
    signal: new AbortController().signal, remote: false, deadlineAt: Date.now() + (input.deadlineMs ?? 5000) }
  const result = await mod.execute({ command: `orchestration worker-${input.kind}`, args: [], cwd: '/tmp',
    flags: { dispatch: dispatchId, 'request-id': `r1.${Date.now()}.${randomUUID()}` } }, context)
  if (!isRecord(result)) throw Error(`not a record: ${JSON.stringify(result)}`)
  return result
}

/** 회수 뒤 herdr 가 보내는 닫힘 통보를 store 에 흘린다 — 남는 행은 보존 규칙이 정한다. */
const closeBoth = (store: WorkspaceStore) => {
  for (const pane of PANES) store.applyEvent({ event: 'pane_closed', data: { pane_id: pane.pane } })
}
const retained = (store: WorkspaceStore) => store.retainedRows().map(row => row.paneId)

describe('C2 — 회수 닫기가 억제 표를 찍는다 (worker-release·worker-stop)', () => {
  it('worker-release: 닫기 전에 표를 찍고, 닫힘 통보 뒤 워커 pane 은 남지 않는다', async () => {
    const store = guiStore(), { desktop, seen } = desktopFor({ store })
    const stub = herdrStub({ onClose: { kind: 'closed' } })
    const result = await recover({ kind: 'release', stub, desktop })
    expect(result).toMatchObject({ state: 'released', reason: 'owned_generation_matches', processAction: 'closed' })
    expect(stub.seen.closes).toBe(1)
    expect(store.isSuppressed(WORKER.pane)).toBe(true)
    // CLI `terminal close` 와 같이 GUI 에 트리 변경을 알린다 — 재시작 없이 live 목록에서 빠진다(C2ⓒ 단위 쪽)
    await vi.waitFor(() => { expect(seen.changed).toBe(1) })
    closeBoth(store)
    expect(retained(store)).not.toContain(WORKER.pane)
  })

  it('worker-stop: 열린 시도를 끊어도 같은 표를 지난다', async () => {
    const store = guiStore(), { desktop, seen } = desktopFor({ store })
    const stub = herdrStub({ onClose: { kind: 'closed' } })
    const result = await recover({ kind: 'stop', stub, desktop })
    expect(result).toMatchObject({ state: 'released', reason: 'worker_stopped', processAction: 'closed' })
    expect(store.isSuppressed(WORKER.pane)).toBe(true)
    await vi.waitFor(() => { expect(seen.changed).toBe(1) })
    closeBoth(store)
    expect(retained(store)).not.toContain(WORKER.pane)
  })

  it('양성 대조 — 표가 없으면 같은 닫힘 통보에서 워커 pane 이 남는다 (수정 전 모양)', () => {
    const store = guiStore()
    closeBoth(store)
    expect(retained(store)).toContain(WORKER.pane)
  })
})

describe('C3 — 실패·불명 정산은 CLI 와 같은 분류를 지난다 (실제 closePane 경로)', () => {
  it('ⓐ 확정 거절(`confirmation_required`)은 표를 걷는다', async () => {
    const store = guiStore(), { desktop, seen } = desktopFor({ store })
    const result = await recover({ kind: 'release', stub: herdrStub({ onClose: { kind: 'error', code: 'confirmation_required' } }), desktop })
    expect(result).toMatchObject({ state: 'unknown', reason: 'close_outcome_unknown' })
    expect(seen.settled).toEqual([{ code: 'confirmation_required', sent: true, effect: 'refused' }])
    expect(store.isSuppressed(WORKER.pane)).toBe(false)
    expect(seen.changed).toBe(0)
  })

  it('ⓑ 전송 뒤 무응답(`backend_timeout`)은 표를 남긴다', async () => {
    const store = guiStore(), { desktop, seen } = desktopFor({ store })
    const result = await recover({ kind: 'release', stub: herdrStub({ onClose: { kind: 'hang' } }), desktop, deadlineMs: 1500 })
    expect(result).toMatchObject({ state: 'unknown', reason: 'close_outcome_unknown' })
    expect(seen.settled).toEqual([{ code: 'backend_timeout', sent: true, effect: 'unknown' }])
    expect(store.isSuppressed(WORKER.pane)).toBe(true)
  })

  it('ⓑ 수락 뒤 PTY 잔존(`outcome_unknown`)은 표를 남긴다 — settle 을 부르지 않는다', async () => {
    const store = guiStore(), { desktop, seen } = desktopFor({ store })
    const result = await recover({ kind: 'release', stub: herdrStub({ onClose: { kind: 'stays' } }), desktop })
    expect(result).toMatchObject({ state: 'unknown', reason: 'close_outcome_unknown' })
    expect(seen.settled).toEqual([])
    expect(store.isSuppressed(WORKER.pane)).toBe(true)
  })

  it('ⓒ pane 이 이미 없음(`stale_terminal` → `pane_gone`)은 표를 찍지 않는다', async () => {
    const store = guiStore(), { desktop, seen } = desktopFor({ store })
    // worker-stop 은 스냅샷 두 번(명령 앞 열린 시도 재관측 R2 · stop 의 소유 관측) 뒤 곧장 `closePane` 이다 —
    // 세 번째(`terminal close` 의 핸들 풀이)부터 pane 이 없다. 순서가 바뀌면 이 단정이 깨져서 알린다(조용히 통과하지 않는다).
    const stub = herdrStub({ onClose: { kind: 'closed' }, goneAfterSnapshots: 2 })
    const result = await recover({ kind: 'stop', stub, desktop })
    expect(result).toMatchObject({ state: 'retained', reason: 'pane_gone', processAction: 'none' })
    expect(stub.seen.closes).toBe(0)
    expect(store.isSuppressed(WORKER.pane)).toBe(false)
    expect(seen.settled).toEqual([])
  })
})

describe('C4ⓓ — desktop 없는 런타임(헤드리스·CLI 직접 모듈)의 회수는 그대로다', () => {
  it('worker-release 가 같은 답으로 닫는다 — 찍을 표가 없을 뿐이다', async () => {
    const stub = herdrStub({ onClose: { kind: 'closed' } })
    const result = await recover({ kind: 'release', stub })
    expect(result).toMatchObject({ state: 'released', reason: 'owned_generation_matches', processAction: 'closed' })
    expect(stub.seen.closes).toBe(1)
  })

  it('확정 거절도 그대로 결과 불명으로 정산한다', async () => {
    const result = await recover({ kind: 'release', stub: herdrStub({ onClose: { kind: 'error', code: 'confirmation_required' } }) })
    expect(result).toMatchObject({ state: 'unknown', reason: 'close_outcome_unknown', processAction: 'closed' })
  })
})

describe('C5 — 억제가 다른 pane 에 새지 않는다 (비명시 사라짐 보존 ①)', () => {
  it('회수한 워커 pane 만 표에 오르고, 같은 workspace 의 다른 done pane 은 닫히면 남는다', async () => {
    const store = guiStore(), { desktop } = desktopFor({ store })
    await recover({ kind: 'release', stub: herdrStub({ onClose: { kind: 'closed' } }), desktop })
    expect(store.isSuppressed(WORKER.pane)).toBe(true)
    // 탭·workspace 표에 오르면 그 아래 pane 전부가 보존을 잃는다(`retain` 이 셋 다 본다)
    for (const id of [OTHER.pane, WORKER.tab, OTHER.tab, WORKSPACE]) expect({ id, suppressed: store.isSuppressed(id) }).toEqual({ id, suppressed: false })
    closeBoth(store)
    expect(retained(store)).toEqual([OTHER.pane])
  })
})

/** 대기 문 — 테스트가 열 때까지 `changed()` 를 붙잡는다(느린 트리 재구성). */
function gate() {
  let open = (): void => {}
  const opened = new Promise<void>(resolve => { open = resolve })
  return { opened, open }
}
const BLOCKED = 'blocked-on-changed'
/** 회수가 `changed()` 를 기다리면 이 시간 안에 안 돌아온다 — 기다리지 않으면 수십 ms 안에 돌아온다. */
const within = <T>(work: Promise<T>, ms = 2000): Promise<T | typeof BLOCKED> =>
  Promise.race([work, new Promise<typeof BLOCKED>(resolve => { setTimeout(() => resolve(BLOCKED), ms) })])

describe('F1·F2 — 회수는 GUI 트리 재구성을 기다리지 않고, 그 실패에 결과가 흔들리지 않는다', () => {
  for (const kind of ['release', 'stop'] as const) {
    it(`worker-${kind}: 끝나지 않는 changed() 를 기다리지 않는다 — 표는 그대로 찍히고 재구성은 시작된다`, async () => {
      const store = guiStore(), slow = gate(), { desktop, seen } = desktopFor({ store, changed: () => slow.opened })
      const stub = herdrStub({ onClose: { kind: 'closed' } })
      const started = Date.now()
      const result = await within(recover({ kind, stub, desktop }))
      slow.open()
      expect(result).not.toBe(BLOCKED)
      expect(result).toMatchObject({ state: 'released', reason: kind === 'release' ? 'owned_generation_matches' : 'worker_stopped', processAction: 'closed' })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(store.isSuppressed(WORKER.pane)).toBe(true)
      expect(seen.changed).toBe(1)
    })

    it(`worker-${kind}: 닫기 뒤 changed() 가 던져도 released 다 — unknown 으로 바뀌지 않는다`, async () => {
      const store = guiStore(), { desktop, seen } = desktopFor({ store, changed: async () => { throw new Error('tree rebuild failed') } })
      const stub = herdrStub({ onClose: { kind: 'closed' } })
      const result = await within(recover({ kind, stub, desktop }))
      expect(result).toMatchObject({ state: 'released', processAction: 'closed' })
      expect(stub.seen.closes).toBe(1)
      expect(store.isSuppressed(WORKER.pane)).toBe(true)
      await vi.waitFor(() => { expect(seen.changed).toBe(1) })
    })
  }
})

describe('F3 — server.ts 가 orchestration 에 terminalDesktop 을 넘긴다 (실제 startRuntime)', () => {
  it('startRuntime 의 worker-release 가 GUI store 에 표를 찍는다', async () => {
    const stub = herdrStub({ onClose: { kind: 'closed' } })
    await stub.listen()
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'l569r-'))
    cleanups.push(() => { fs.rmSync(data, { recursive: true, force: true }) })
    process.env.CORRAL_BACKEND_SOCKET = stub.socket
    process.env.CORRAL_SESSION = 'l569-unit'
    process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
    const store = guiStore(), { desktop } = desktopFor({ store })
    const runtime = await startRuntime({ userData: data, terminalDesktop: desktop })
    cleanups.push(() => runtime.close())
    const dispatchId = attempt({ data, kind: 'release', runtimeId: runtime.runtimeId })
    const response = await runtime.invoke({ command: 'orchestration worker-release', args: [], cwd: '/tmp',
      flags: { dispatch: dispatchId, 'request-id': `r1.${Date.now()}.${randomUUID()}` } }, 10000)
    expect(response).toMatchObject({ ok: true, result: { state: 'released', reason: 'owned_generation_matches' } })
    expect(store.isSuppressed(WORKER.pane)).toBe(true)
  })
})
