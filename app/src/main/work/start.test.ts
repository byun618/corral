// LIFE-603 C6·C7 — 시작 서비스: 단계 매핑 · 실패 분기(양성 대조) · 같은 id 합류 · 이어 받기 · 빈 터미널 · 링크 저장.
// 런타임 응답은 `worktree create --agent` 가 실제로 내는 모양(`runtime/workspace/index.ts` 의 stages)을 그대로 만든다.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Receipts } from '../../runtime/terminal/receipts.js'
import { RuntimeError } from '../../runtime/contracts.js'
import type { Invocation, RpcResponse } from '../../runtime/contracts.js'
import { newAttemptId, type StartWorkInput } from '../../shared/work-start.js'
import { testRepo, testWorktree } from '../../shared/test-rows.js'
import type { RepoRow } from '../../shared/types.js'
import type { StoredWorkLink } from '../../shared/work-link.js'
import type { WorkActivityChange } from '../../shared/work.js'
import { StartService, mapAgentStages } from './start.js'
import { MemoryPending } from './start-pending.js'
import type { ClaimResult, LinkWorkPort } from './links.js'

const ROOT = '/repo'
const NAME = 'LIFE-603-start'
const PATH = `${ROOT}/.claude/worktrees/${NAME}`
let seq = 0
const attempt = () => newAttemptId({ now: 1_760_000_000_000 + (seq += 1), uuid: '0b8f6a4e-7a8c-4c33-9a43-5f3c3f6d2b11' })
const input = (patch: Partial<StartWorkInput> = {}): StartWorkInput => ({ attemptId: attempt(), connectionId: 'c', sourceId: 'mock-jira', itemId: 'm-1', itemKey: 'CORE-1', repoRoot: ROOT, name: NAME, agent: 'claude', model: 'opus', effort: 'high', prompt: '작업 본문', submit: false, ...patch })

const ok = (result: unknown): RpcResponse => ({ id: 'x', ok: true, result, _meta: { runtimeId: 'r' } })
const fail = (code: string, message = code, resources?: unknown): RpcResponse => ({ id: 'x', ok: false, error: { code, message, ...(resources === undefined ? {} : { resources }) }, _meta: { runtimeId: 'r' } })
const created = (stages: Record<string, unknown>) => ok({ worktree: { path: PATH }, stages: { worktree: { status: 'completed', path: PATH }, terminal: { status: 'completed' }, agent: { status: 'completed' }, prompt: { status: 'completed', mode: 'draft', enterSent: false }, ...stages }, outcome: 'completed' })

/**
 * 링크 저장 가짜 — 레지스트리 한 칸(경로 → 명시 링크 · 떼기 예외)을 흉내 낸다. `claimExplicit` 는 `WorkLinks` 와 같은 규칙(실물 시험은 links.test.ts).
 * `saved` 에는 실제로 쓴 것만 쌓인다.
 */
function fakeLinks({ held = {}, canSave = () => true }: { held?: Record<string, StoredWorkLink | 'suppressed'>; canSave?: () => boolean } = {}) {
  const table = new Map<string, StoredWorkLink | 'suppressed'>(Object.entries(held))
  const saved: { path: string; link: StoredWorkLink }[] = []
  const write = ({ path, link }: { path: string; link: StoredWorkLink }): boolean => {
    if (!canSave()) return false
    table.set(path, link)
    saved.push({ path, link })
    return true
  }
  return {
    saved,
    table,
    saveExplicit: write,
    claimExplicit: ({ path, link }: { path: string; link: StoredWorkLink }): ClaimResult => {
      const current = table.get(path)
      if (current === 'suppressed') return 'held'
      if (current !== undefined) return current.connectionId === link.connectionId && current.itemId === link.itemId ? 'linked' : 'held'
      return write({ path, link }) ? 'saved' : 'failed'
    },
  }
}

function harness({ answer, repos, worktreeExists, pending, storeState = 'saved' }: { answer: (invocation: Invocation, n: number) => Promise<RpcResponse> | RpcResponse; repos?: () => RepoRow[]; worktreeExists?: (path: string) => boolean; pending?: MemoryPending; storeState?: 'saved' | 'failed' }) {
  const calls: Invocation[] = []
  const events: { eventKey: string; change: WorkActivityChange }[] = []
  const stores: string[] = []
  const work: LinkWorkPort = {
    linkConnections: () => [], repoDefaultConnection: () => null,
    recordEvent: ({ eventKey, change }) => { events.push({ eventKey, change }); return true },
    storeLink: async ({ action }) => { stores.push(action); return storeState === 'saved' ? { state: 'saved', message: null } : { state: 'failed', message: 'LA 에 닿지 않습니다 (ECONNRESET).' } },
    refreshEvent: () => false,
    storeAutoLink: async () => null,
  }
  const links = fakeLinks()
  const saved = links.saved
  const service = new StartService({
    invoke: () => async (invocation) => { calls.push(invocation); return answer(invocation, calls.length) },
    repos: repos ?? (() => [testRepo({ root: ROOT, worktrees: [] })]),
    // 시험은 저장 한 칸만 쓴다 — 나머지 링크 기능은 links.test.ts.
    links: () => links,
    work: () => work,
    log: () => {},
    cwd: '/',
    sleep: async () => {},
    worktreeExists,
    pending,
  })
  return { service, calls, saved, events, stores }
}

describe('worktree create 단계 → 모달 3단계', () => {
  it('초안 완료 — 세 단계 완료, 런타임에 --draft · 모델 · effort · 같은 id', async () => {
    const h = harness({ answer: () => created({}) })
    const given = input()
    const result = await h.service.start(given)
    expect(result.stages).toEqual({ worktree: { status: 'completed', code: null, message: null }, agent: { status: 'completed', code: null, message: null }, prompt: { status: 'completed', code: 'draft', message: '붙여넣기를 한 번 썼습니다 — 입력창에서 확인하세요.' } })
    expect(h.calls[0]?.flags).toMatchObject({ name: NAME, repo: ROOT, agent: 'claude', model: 'opus', effort: 'high', prompt: '작업 본문', draft: true, 'request-id': given.attemptId })
    expect(result).toMatchObject({ worktreePath: PATH, linkSaved: true, sourceLink: { state: 'saved' } })
    expect(h.saved[0]).toMatchObject({ path: PATH, link: { sourceId: 'mock-jira', connectionId: 'c', itemId: 'm-1', key: 'CORE-1' } })
    expect(h.events).toEqual([{ eventKey: `run:start:${given.attemptId}`, change: { field: 'run', event: 'start', worktree: PATH, branch: NAME, agent: 'claude', model: 'opus' } }])
  })
  it('바로 보내기 — --draft 없음(기존 제출 경로), 기본값 모델·effort 는 플래그를 뺀다, 목록 밖 값도 뺀다', async () => {
    const h = harness({ answer: () => created({ prompt: { status: 'queued', requestId: 'r' } }) })
    await h.service.start(input({ submit: true, model: '', effort: 'ultra' }))
    expect(h.calls[0]?.flags.draft).toBeUndefined()
    expect(h.calls[0]?.flags.model).toBeUndefined()
    expect(h.calls[0]?.flags.effort).toBeUndefined()
  })
})

describe('실패 분기 — 그 단계에서 멈추고 이유를 준다 (C6 양성 대조)', () => {
  it('worktree 실패(already_exists) — 뒤 단계 건너뜀 · 링크 없음', async () => {
    const h = harness({ answer: () => fail('already_exists', 'Branch or path exists: LIFE-603-start') })
    const result = await h.service.start(input())
    expect(result.stages.worktree).toEqual({ status: 'failed', code: 'already_exists', message: 'Branch or path exists: LIFE-603-start' })
    expect(result.stages.agent.status).toBe('skipped')
    expect(result).toMatchObject({ worktreePath: null, linkSaved: false })
    expect(h.saved).toEqual([])
  })
  it('에이전트 실패(터미널 실패) — worktree 는 남고 링크는 저장된다', async () => {
    const h = harness({ answer: () => created({ terminal: { status: 'failed', error: 'backend_unavailable', message: 'no backend' }, agent: { status: 'not_started' }, prompt: { status: 'not_started' } }) })
    const result = await h.service.start(input())
    expect(result.stages.agent).toEqual({ status: 'failed', code: 'backend_unavailable', message: 'no backend' })
    expect(result.stages.prompt.status).toBe('skipped')
    expect(result.linkSaved).toBe(true)
  })
  it('에이전트 기동 실패(agent 단계) — 같은 갈래', async () => {
    const h = harness({ answer: () => created({ agent: { status: 'failed', error: 'agent_pane_busy', message: 'busy' }, prompt: { status: 'not_started' } }) })
    expect((await h.service.start(input())).stages.agent).toMatchObject({ status: 'failed', code: 'agent_pane_busy' })
  })
  it('프롬프트 실패(차단 화면 · manifest 미검증 · not ready) — 이유 코드 그대로', async () => {
    for (const reason of ['agent_blocked', 'detect_manifest_unverified', 'agent_not_ready']) {
      const h = harness({ answer: () => created({ prompt: { status: 'not_started', reason } }) })
      const result = await h.service.start(input())
      expect([reason, result.stages.prompt.status, result.stages.prompt.code]).toEqual([reason, 'failed', reason])
      expect(result.stages.agent.status).toBe('completed')
      expect(result.linkSaved).toBe(true)
    }
  })
  it('worktree 는 생겼는데 뒤가 던졌다(resources.path) — worktree 미확정(R4-D: 완료 아님) · 에이전트 실패 · 빈 자리라 링크 저장', async () => {
    const h = harness({ answer: () => fail('git_failed', 'Worktree created, follow-up failed', { path: PATH, branch: NAME }) })
    const result = await h.service.start(input())
    expect(result.stages.worktree).toMatchObject({ status: 'unknown', code: 'git_failed' })
    expect(result.worktreePath).toBe(PATH)
    expect(result.stages.agent).toMatchObject({ status: 'failed', code: 'git_failed' })
    expect(result.linkSaved).toBe(true)
  })
  it('대조 — 모양을 모르는 성공 응답은 완료로 그리지 않는다(unknown)', () => {
    expect(mapAgentStages({ nothing: true }).stages.worktree.status).toBe('unknown')
  })
})

describe('합류 · 이어 받기 (C7)', () => {
  it('같은 시도 10회 연타 — 런타임 호출 1 · 결과 하나 · 링크 저장 1', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness({ answer: async () => { await gate; return created({}) } })
    const given = input()
    const presses = Array.from({ length: 10 }, () => h.service.start(given))
    expect(h.service.busy()).toBe(true)
    release()
    const results = await Promise.all(presses)
    expect(h.calls).toHaveLength(1)
    expect(results.filter((result) => result.joined)).toHaveLength(9)
    expect(new Set(results.map((result) => JSON.stringify(result.stages))).size).toBe(1)
    expect(h.saved).toHaveLength(1)
    expect(h.service.busy()).toBe(false)
    // 끝난 뒤 같은 id 로 다시 눌러도 기록을 돌려준다(런타임 호출 0).
    expect(await h.service.start(given)).toMatchObject({ joined: true })
    expect(h.calls).toHaveLength(1)
  })
  it('진행 중 모달을 닫고 다시 시작(새 id · 같은 이름) — 진행 중 시도에 합류', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness({ answer: async () => { await gate; return created({}) } })
    const first = h.service.start(input())
    const status = h.service.status({ connectionId: 'c', itemId: 'm-1' })
    expect(status).toMatchObject({ name: NAME, result: null })
    const second = h.service.start(input())
    release()
    expect((await second).joined).toBe(true)
    await first
    expect(h.calls).toHaveLength(1)
    expect(h.service.status({ connectionId: 'c', itemId: 'm-1' })?.result?.done).toBe(true)
  })
  it('빈 터미널 연타 — 영수증이 없어도 worktree create 1 · terminal create 1', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness({ answer: async (invocation) => { await gate; return invocation.command === 'worktree create' ? ok({ worktree: { path: PATH } }) : ok({ terminal: { handle: 't' }, stage: 'pty_created' }) } })
    const given = input({ agent: 'shell', prompt: '' })
    const presses = Array.from({ length: 10 }, () => h.service.start(given))
    release()
    const results = await Promise.all(presses)
    expect(h.calls.map((call) => call.command)).toEqual(['worktree create', 'terminal create'])
    expect(h.calls[0]?.flags.agent).toBeUndefined()
    expect(h.calls[0]?.flags.prompt).toBeUndefined()
    expect(h.calls[1]?.flags).toMatchObject({ worktree: `path:${PATH}` })
    expect(results.every((result) => result.stages.agent.status === 'completed' && result.stages.prompt.status === 'skipped')).toBe(true)
  })
  it('호출자 timeout(request_cancelled) 은 실패가 아니다 — 같은 id 로 이어 받는다', async () => {
    const h = harness({ answer: (_invocation, n) => (n <= 2 ? fail('request_cancelled') : created({})) })
    const given = input()
    const result = await h.service.start(given)
    expect(result.stages.worktree.status).toBe('completed')
    expect(h.calls.map((call) => call.flags['request-id'])).toEqual([given.attemptId, given.attemptId, given.attemptId])
  })
  it('R1-B 미확정(outcome_unknown) 은 다시 묻지 않는다 — 단계 unknown, 예정 경로에 worktree 가 있으면 링크 · 없으면 미확정 기록을 남긴다', async () => {
    const pending = new MemoryPending()
    // worktree 는 런타임 호출 뒤에 생긴다(시도 전부터 있던 자리는 R2-A — 붙이지 않는다).
    let called = false
    const found = harness({ answer: () => { called = true; return fail('outcome_unknown') }, worktreeExists: (path) => called && path === PATH, pending })
    const result = await found.service.start(input())
    expect(found.calls).toHaveLength(1)
    expect(result.stages.worktree).toMatchObject({ status: 'unknown', code: 'outcome_unknown' })
    expect(result).toMatchObject({ worktreePath: PATH, linkSaved: true })
    expect(pending.entries).toEqual([])
    const lost = harness({ answer: () => fail('outcome_unknown'), pending })
    const second = await lost.service.start(input())
    expect(second).toMatchObject({ worktreePath: null, linkSaved: false })
    expect(pending.entries.map((entry) => entry.path)).toEqual([PATH])
  })
  it('R1-A 재시작 뒤 같은 이름 — 이 작업에 이미 붙은 worktree 면 실패도 성공도 아닌 「이미 있음」(새로 만든 것 없음)', async () => {
    const repos = () => [testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME, workLink: { mode: 'explicit', sourceId: 'mock-jira', connectionId: 'c', key: 'CORE-1', itemId: 'm-1', connected: true } })] })]
    const h = harness({ answer: () => fail('already_exists'), repos })
    const result = await h.service.start(input({ agent: 'shell', prompt: '' }))
    expect(result.stages.worktree).toMatchObject({ status: 'skipped', code: 'already_linked' })
    expect(result.stages.agent).toMatchObject({ status: 'skipped', code: 'already_linked' })
    expect(result).toMatchObject({ worktreePath: PATH, linkSaved: true })
    expect(h.saved).toEqual([])
    // 다른 작업에 붙은 같은 이름은 지금처럼 실패다.
    const other = harness({ answer: () => fail('already_exists'), repos })
    expect((await other.service.start(input({ itemId: 'm-2' }))).stages.worktree).toMatchObject({ status: 'failed', code: 'already_exists' })
  })
  it('등록 안 된 레포 · 틀린 입력은 런타임을 부르지 않는다', async () => {
    const h = harness({ answer: () => created({}) })
    expect((await h.service.start(input({ repoRoot: '/elsewhere' }))).refused).toBe('등록된 레포가 아닙니다.')
    expect((await h.service.start({ ...input(), name: 'a b' })).refused).toBe('시작 입력이 잘못됐습니다.')
    expect(h.calls).toHaveLength(0)
  })
})

describe('에이전트 다시 띄우기 (C6) — 그 작업에 붙은 worktree 에만 · terminal create --agent · 프롬프트 없음', () => {
  const linkedRepos = (itemId: string) => () => [testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME, workLink: { mode: 'explicit', sourceId: 'mock-jira', connectionId: 'c', key: 'CORE-1', itemId, connected: true } })] })]
  const relaunch = (patch: Record<string, unknown> = {}) => ({ attemptId: attempt(), connectionId: 'c', itemId: 'm-1', path: PATH, agent: 'claude', model: 'opus', effort: 'high', ...patch })
  it('명령 그대로 — worktree path · agent · model · effort · 새 id, 프롬프트 플래그 없음, 같은 id 연타는 호출 1', async () => {
    const h = harness({ answer: () => ok({ terminal: { handle: 't1.x' } }), repos: linkedRepos('m-1') })
    const given = relaunch()
    const results = await Promise.all(Array.from({ length: 5 }, () => h.service.relaunch(given)))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ command: 'terminal create', flags: { worktree: `path:${PATH}`, agent: 'claude', model: 'opus', effort: 'high', 'request-id': given.attemptId } })
    expect(h.calls[0]?.flags.prompt).toBeUndefined()
    expect(results[0]?.stages).toMatchObject({ worktree: { status: 'completed' }, agent: { status: 'completed' }, prompt: { status: 'skipped', code: 'relaunch' } })
    expect(results.slice(1).every((entry) => entry.joined)).toBe(true)
  })
  it('다른 작업에 붙은 · 링크 없는 worktree 는 거절(런타임 호출 0)', async () => {
    const other = harness({ answer: () => ok({}), repos: linkedRepos('m-other') })
    expect((await other.service.relaunch(relaunch())).refused).not.toBeNull()
    const none = harness({ answer: () => ok({}) })
    expect((await none.service.relaunch(relaunch())).refused).not.toBeNull()
    expect([...other.calls, ...none.calls]).toHaveLength(0)
  })
  it('R1-A 빈 터미널은 「터미널 다시 열기」 — 에이전트 플래그 없이 terminal create', async () => {
    const h = harness({ answer: () => ok({ terminal: { handle: 't1.x' } }), repos: linkedRepos('m-1') })
    const result = await h.service.relaunch(relaunch({ agent: 'shell' }))
    expect(h.calls[0]?.command).toBe('terminal create')
    expect(h.calls[0]?.flags.agent).toBeUndefined()
    expect(result.stages.agent.status).toBe('completed')
  })
  it('틀린 입력은 거절, 런타임 실패는 에이전트 단계 실패', async () => {
    const h = harness({ answer: () => fail('agent_failed', '에이전트 기동 실패'), repos: linkedRepos('m-1') })
    expect((await h.service.relaunch(relaunch({ attemptId: 'x' }))).refused).not.toBeNull()
    expect((await h.service.relaunch(relaunch({ agent: 'gemini' }))).refused).not.toBeNull()
    expect((await h.service.relaunch(relaunch())).stages.agent).toEqual({ status: 'failed', code: 'agent_failed', message: '에이전트 기동 실패' })
  })
})

describe('R1-B 실제 Receipts 위에서 — 효과 시작 뒤 취소된 요청', () => {
  // 리뷰 재현(`raw/review/claude-r1-raw/repro-pending-receipt.test.ts.txt`)을 시험으로 고정: 첫 호출만 실행 중 abort(영수증 pending),
  // 그 뒤 같은 id 는 실제 Receipts 가 늘 outcome_unknown 을 돌려준다. 고친 서비스는 되묻지 않고 예정 경로의 worktree 를 링크한다.
  async function run({ exists }: { exists: boolean }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-rcpt-'))
    const receipts = new Receipts(dir, Date.now() - 10_000)
    let calls = 0
    const answers: string[] = []
    const invoke = async (inv: Invocation): Promise<RpcResponse> => {
      calls += 1
      try {
        await receipts.run(inv, async () => { if (calls === 1) throw new DOMException('aborted', 'AbortError'); return { worktree: { path: PATH }, stages: {} } })
        answers.push('ok')
        return ok({})
      } catch (error) {
        const code = calls === 1 ? 'request_cancelled' : error instanceof RuntimeError ? error.code : 'operation_failed'
        answers.push(code)
        return fail(code, String(error))
      }
    }
    let clock = 1_000_000
    const pending = new MemoryPending()
    const links = fakeLinks()
    const saved = links.saved
    const service = new StartService({
      invoke: () => invoke, repos: () => [testRepo({ root: ROOT, worktrees: [] })], links: () => links, work: () => null,
      log: () => {}, cwd: '/', now: () => clock, sleep: async (ms) => { clock += ms }, deadlineMs: 600_000, pending, worktreeExists: () => exists && calls > 0,
    })
    // 영수증은 런타임 시작보다 오래된 id 를 request_expired 로 거절한다 — 지금 시각의 id 를 쓴다.
    const result = await service.start(input({ attemptId: newAttemptId({ now: Date.now(), uuid: randomUUID() }) }))
    fs.rmSync(dir, { recursive: true, force: true })
    return { result, calls, answers, virtualMs: clock - 1_000_000, saved, pending }
  }
  it('같은 id 재시도는 실제로 outcome_unknown — 한 번 받고 멈춘다(헛도는 10분 없음), 예정 경로의 worktree 를 링크', async () => {
    const r = await run({ exists: true })
    expect(r.answers).toEqual(['request_cancelled', 'outcome_unknown'])
    expect(r.calls).toBe(2)
    expect(r.virtualMs).toBeLessThan(5_000)
    expect(r.result.stages.worktree).toMatchObject({ status: 'unknown', code: 'outcome_unknown' })
    expect(r.result).toMatchObject({ worktreePath: PATH, linkSaved: true })
    expect(r.saved.map((row) => row.path)).toEqual([PATH])
  })
  it('worktree 가 아직 없으면 링크 없이 미확정 기록을 남긴다 — 나타나면 recover 가 붙인다', async () => {
    const r = await run({ exists: false })
    expect(r.calls).toBe(2)
    expect(r.result).toMatchObject({ worktreePath: null, linkSaved: false })
    expect(r.pending.entries).toHaveLength(1)
  })
})

describe('R1-C 응답 전 종료 — 시작 의도를 먼저 적고, 다음 실행이 트리와 맞춰 링크한다', () => {
  it('런타임 호출 전에 미확정 기록 → (새 서비스 = 재시작) recover 가 그 경로를 트리에서 찾으면 링크 · 「작업 시작」 활동 · 출처 링크, 기록 삭제', async () => {
    const pending = new MemoryPending()
    let seenBefore = -1
    const crashing = harness({ answer: () => { seenBefore = pending.entries.length; return new Promise<RpcResponse>(() => {}) }, pending })
    void crashing.service.start(input())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seenBefore).toBe(1)
    const entry = pending.entries[0]
    expect(entry).toMatchObject({ path: PATH, itemId: 'm-1', itemKey: 'CORE-1' })
    // 재시작: 새 서비스 · 같은 기록. 트리에 아직 없으면 아무것도 하지 않는다.
    const after = harness({ answer: () => ok({}), pending })
    expect(await after.service.recover([testRepo({ root: ROOT, worktrees: [] })])).toBe(0)
    expect(await after.service.recover([testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME })] })])).toBe(1)
    expect(after.saved.map((row) => row.path)).toEqual([PATH])
    expect(after.events.map((event) => event.eventKey)).toEqual([`run:start:${entry?.attemptId}`])
    expect(after.stores).toEqual(['save'])
    expect(pending.entries).toEqual([])
    expect(after.calls).toHaveLength(0)
  })
  it('양성 대조 — 진행 중인 시도의 기록은 recover 가 건드리지 않는다', async () => {
    const pending = new MemoryPending()
    const h = harness({ answer: () => new Promise<RpcResponse>(() => {}), pending })
    void h.service.start(input())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await h.service.recover([testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME })] })])).toBe(0)
    expect(h.saved).toEqual([])
  })
})

describe('R1-E·R1-P 바로 보내기 — 본문 정제 · queued 는 「줄에 넣음」', () => {
  it('제출 경로도 제어·비가시 글자를 지운 본문을 보낸다, queued 는 completed 와 다르다', async () => {
    const h = harness({ answer: () => created({ prompt: { status: 'queued', requestId: 'r' } }) })
    const result = await h.service.start(input({ submit: true, prompt: '첫 줄\u001b[201~\r!rm -rf ~\u200b\u202e\u{E0041}끝' }))
    expect(h.calls[0]?.flags.prompt).toBe('첫 줄[201~\n!rm -rf ~끝')
    expect(h.calls[0]?.flags.draft).toBeUndefined()
    expect(result.stages.prompt.status).toBe('queued')
  })
})

describe('R2-A 시도 전부터 있던 worktree 는 이 작업에 붙이지 않는다 (리뷰 재현 grok-r2-raw/repro.test.ts)', () => {
  const OTHER = { mode: 'explicit' as const, sourceId: 'mock-jira', connectionId: 'c', key: 'CORE-1', itemId: 'm-1', connected: true }
  const OTHER_STORED: StoredWorkLink = { sourceId: 'mock-jira', connectionId: 'c', key: 'CORE-1', itemId: 'm-1', linkedAt: 1 }
  const mine = (patch: Partial<StartWorkInput> = {}): StartWorkInput => input({ itemId: 'm-new', itemKey: 'CORE-9', ...patch })
  function rig({ answer, exists = true, pending }: { answer: (n: number) => RpcResponse; exists?: boolean; pending?: MemoryPending }) {
    const calls: Invocation[] = []
    const links = fakeLinks({ held: exists ? { [PATH]: OTHER_STORED } : {} })
    const saved = links.saved
    const repos = () => [testRepo({ root: ROOT, worktrees: exists ? [testWorktree({ path: PATH, branch: NAME, workLink: OTHER })] : [] })]
    const service = new StartService({
      invoke: () => async (invocation) => { calls.push(invocation); return answer(calls.length) },
      repos,
      links: () => links,
      work: () => null, log: () => {}, cwd: '/', sleep: async () => {}, pending, deadlineMs: 60_000,
    })
    return { service, calls, saved, links }
  }
  it('대조 — 재시도 없는 already_exists 는 링크하지 않는다(이름 바꾸기)', async () => {
    const h = rig({ answer: () => fail('already_exists') })
    const result = await h.service.start(mine())
    expect(result.stages.worktree.status).toBe('failed')
    expect(h.saved).toEqual([])
  })
  it('취소 뒤 already_exists — 다른 작업에 붙은 기존 worktree 를 덮지 않는다(고침 전: m-new 로 덮음)', async () => {
    const pending = new MemoryPending()
    const h = rig({ answer: (n) => (n === 1 ? fail('request_cancelled') : fail('already_exists')), pending })
    const result = await h.service.start(mine())
    expect(h.calls).toHaveLength(2)
    expect(h.saved).toEqual([])
    expect(result).toMatchObject({ worktreePath: null, linkSaved: false })
    expect(result.stages.worktree).toMatchObject({ status: 'failed', code: 'already_exists' })
    expect(pending.entries).toEqual([])
  })
  it('미확정(outcome_unknown) 이어도 시도 전부터 있던 자리는 붙이지 않고 그 사실을 적는다', async () => {
    const pending = new MemoryPending()
    const h = rig({ answer: () => fail('outcome_unknown'), pending })
    const result = await h.service.start(mine())
    expect(h.saved).toEqual([])
    expect(result.worktreePath).toBeNull()
    expect(result.stages.worktree.message).toContain('시작 전부터 있어')
    expect(pending.entries).toEqual([])
  })
  it('대조 — 경로가 없으면 링크 없이 미확정 기록만(기록에 preexisting=false)', async () => {
    const pending = new MemoryPending()
    const h = rig({ answer: (n) => (n === 1 ? fail('request_cancelled') : fail('already_exists')), exists: false, pending })
    const result = await h.service.start(mine())
    expect(result).toMatchObject({ worktreePath: null, linkSaved: false })
    expect(h.saved).toEqual([])
    expect(pending.entries.map((entry) => entry.preexisting)).toEqual([false])
  })
  it('recover — 시도 전부터 있던 자리의 기록은 붙이지 않고 버린다(양성 대조: 없던 자리는 붙인다)', async () => {
    const pending = new MemoryPending()
    const given = mine()
    const base = { attemptId: given.attemptId, connectionId: 'c', sourceId: 'mock-jira', itemId: 'm-new', itemKey: 'CORE-9', repoRoot: ROOT, name: NAME, path: PATH, agent: 'claude' as const, model: 'opus', startedAt: 1_760_000_000_000 }
    pending.add({ ...base, preexisting: true })
    const h = rig({ answer: () => fail('already_exists'), pending })
    const tree = [testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME, workLink: OTHER })] })]
    expect(await h.service.recover(tree)).toBe(0)
    expect(h.saved).toEqual([])
    expect(pending.entries).toEqual([])
    // 양성 대조는 비어 있는 자리 — 다른 작업의 링크가 있는 자리는 R3-C 로 붙이지 않는다.
    h.links.table.delete(PATH)
    pending.add({ ...base, preexisting: false })
    expect(await h.service.recover([testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME })] })])).toBe(1)
    expect(h.saved.map((row) => row.link.itemId)).toEqual(['m-new'])
  })
})

describe('R2-B 링크 저장 실패 — 성공으로 그리지 않고 미확정 기록을 남긴다 (리뷰 재현 claude-r2-raw/repro-linkfail)', () => {
  it('saveExplicit=false → 단계 link_failed · 기록 유지 → 다음 recover 가 다시 붙인다', async () => {
    const pending = new MemoryPending()
    let canSave = false
    const links = fakeLinks({ canSave: () => canSave })
    const service = new StartService({
      invoke: () => async () => ok({ worktree: { path: PATH }, stages: { worktree: { status: 'completed', path: PATH }, terminal: { status: 'completed' }, agent: { status: 'completed' }, prompt: { status: 'completed', mode: 'draft', enterSent: false } }, outcome: 'completed' }),
      repos: () => [testRepo({ root: ROOT, worktrees: [] })],
      links: () => links,
      work: () => null, log: () => {}, cwd: '/', sleep: async () => {}, pending,
    })
    const result = await service.start(input())
    expect(result.linkSaved).toBe(false)
    expect(result.stages.worktree).toMatchObject({ status: 'completed', code: 'link_failed' })
    expect(pending.entries).toHaveLength(1)
    // 저장이 다시 되면 recover 가 붙이고 기록을 지운다.
    expect(await service.recover([testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME })] })])).toBe(0)
    expect(pending.entries).toHaveLength(1)
    canSave = true
    expect(await service.recover([testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME })] })])).toBe(1)
    expect(pending.entries).toHaveLength(0)
  })
})

describe('R3-A 같은 경로의 앞 미확정 기록은 뒤 시도가 확정하면 끝난다 (리뷰 재현 claude-r3-raw/scratch-start2)', () => {
  const done = created({})
  function rig({ held }: { held?: Record<string, StoredWorkLink | 'suppressed'> } = {}) {
    const pending = new MemoryPending()
    const links = fakeLinks({ held })
    const events: { eventKey: string; change: WorkActivityChange }[] = []
    const stores: string[] = []
    const work: LinkWorkPort = {
      linkConnections: () => [], repoDefaultConnection: () => null,
      recordEvent: ({ eventKey, change }) => { if (events.some((row) => row.eventKey === eventKey)) return false; events.push({ eventKey, change }); return true },
      storeLink: async ({ action }) => { stores.push(action); return { state: 'saved', message: null } }, refreshEvent: () => false, storeAutoLink: async () => null,
    }
    let n = 0
    const service = new StartService({
      invoke: () => async () => { n += 1; return n === 1 ? fail('outcome_unknown') : done },
      repos: () => [testRepo({ root: ROOT, worktrees: [] })],
      links: () => links, work: () => work, log: () => {}, cwd: '/', sleep: async () => {}, pending, deadlineMs: 60_000,
    })
    const starts = () => events.filter((row) => row.change.field === 'run' && row.change.event === 'start')
    return { service, pending, links, events, stores, starts }
  }
  const tree = [testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME })] })]

  it('S3 같은 작업 — 앞 시도 미확정 · 뒤 시도 성공 → recover 뒤에도 「작업 시작」 1회 · 기록 0 (고침 전: 2회)', async () => {
    const h = rig()
    const first = await h.service.start(input())
    expect(first.stages.worktree.status).toBe('unknown')
    expect(h.pending.entries).toHaveLength(1)
    const second = await h.service.start(input())
    expect(second.linkSaved).toBe(true)
    expect(h.pending.entries).toEqual([])
    expect(await h.service.recover(tree)).toBe(0)
    expect(h.starts().map((row) => row.eventKey)).toEqual([`run:start:${second.attemptId}`])
    expect(h.stores).toEqual(['save'])
  })
  it('S4 다른 작업 — 뒤 작업 링크가 남는다(고침 전: 앞 작업으로 덮음)', async () => {
    const h = rig()
    await h.service.start(input({ itemId: 'm-A', itemKey: 'CORE-A' }))
    await h.service.start(input({ itemId: 'm-B', itemKey: 'CORE-B' }))
    await h.service.recover(tree)
    expect(h.links.saved.map((row) => row.link.key)).toEqual(['CORE-B'])
    expect(h.pending.entries).toEqual([])
  })
  it('방어선 — 앞 기록이 남아 있어도(다른 프로세스가 붙임) recover 는 남의 자리 · 같은 작업이 붙인 자리를 덮지 않고 기록만 버린다', async () => {
    const other: StoredWorkLink = { sourceId: 'mock-jira', connectionId: 'c', itemId: 'm-B', key: 'CORE-B', linkedAt: 1 }
    const same: StoredWorkLink = { sourceId: 'mock-jira', connectionId: 'c', itemId: 'm-1', key: 'CORE-1', linkedAt: 1 }
    for (const holder of [other, same, 'suppressed' as const]) {
      const h = rig({ held: { [PATH]: holder } })
      await h.service.start(input())
      expect(h.pending.entries).toHaveLength(1)
      expect(await h.service.recover(tree)).toBe(0)
      expect(h.links.saved).toEqual([])
      expect(h.starts()).toEqual([])
      expect(h.stores).toEqual([])
      expect(h.pending.entries).toEqual([])
    }
  })
  it('양성 대조 — 비어 있는 자리면 recover 가 앞 시도로 붙이고 「작업 시작」 1회', async () => {
    const h = rig()
    const first = await h.service.start(input())
    expect(await h.service.recover(tree)).toBe(1)
    expect(h.links.saved.map((row) => row.link.itemId)).toEqual(['m-1'])
    expect(h.starts().map((row) => row.eventKey)).toEqual([`run:start:${first.attemptId}`])
    expect(h.pending.entries).toEqual([])
  })
})

describe('R3-C 미확정에서 붙이는 갈래는 남의 명시 링크 · 떼기 예외를 덮지 않는다 (리뷰 재현 claude-r3-raw/scratch-start S2)', () => {
  const OTHER = { mode: 'explicit' as const, sourceId: 'mock-jira', connectionId: 'c', key: 'CORE-1', itemId: 'm-1', connected: true }
  const OTHER_STORED: StoredWorkLink = { sourceId: 'mock-jira', connectionId: 'c', key: 'CORE-1', itemId: 'm-1', linkedAt: 1 }
  /** 시도 전엔 없던 자리를 첫 호출 중에 남이 만든다 — `holder` 가 그 자리에 붙은 것. */
  function rig({ first, holder }: { first: string; holder: StoredWorkLink | 'suppressed' | null }) {
    let appeared = false
    let n = 0
    const links = fakeLinks()
    const pending = new MemoryPending()
    const service = new StartService({
      invoke: () => async () => {
        n += 1
        if (n === 1) { appeared = true; if (holder !== null) links.table.set(PATH, holder); return fail(first) }
        return fail('already_exists')
      },
      repos: () => [testRepo({ root: ROOT, worktrees: appeared ? [testWorktree({ path: PATH, branch: NAME, workLink: holder === OTHER_STORED ? OTHER : null })] : [] })],
      links: () => links, work: () => null, log: () => {}, cwd: '/', sleep: async () => {}, pending, deadlineMs: 60_000,
    })
    return { service, links, pending }
  }
  const mine = () => input({ itemId: 'm-new', itemKey: 'CORE-9' })
  for (const first of ['request_cancelled', 'outcome_unknown']) {
    for (const [label, holder] of [['다른 작업 명시 링크', OTHER_STORED], ['떼기 예외', 'suppressed']] as const) {
      it(`${first} 뒤 ${label} 자리 — 덮지 않고 「다른 작업에 붙어 있어」 · 성공 아님 · 기록 0`, async () => {
        const h = rig({ first, holder })
        const result = await h.service.start(mine())
        expect(h.links.saved).toEqual([])
        expect(h.links.table.get(PATH)).toBe(holder)
        expect(result).toMatchObject({ worktreePath: null, linkSaved: false })
        expect(result.stages.worktree).toMatchObject({ status: 'unknown', code: 'held_by_other' })
        expect(result.stages.worktree.message).toContain('다른 작업에 붙어 있어')
        expect(h.pending.entries).toEqual([])
      })
    }
    it(`${first} 양성 대조 — 비어 있는 자리는 붙인다`, async () => {
      const h = rig({ first, holder: null })
      const result = await h.service.start(mine())
      expect(h.links.saved.map((row) => row.link.itemId)).toEqual(['m-new'])
      expect(result).toMatchObject({ worktreePath: PATH, linkSaved: true })
      expect(result.stages.worktree.status).toBe('unknown')
      expect(h.pending.entries).toEqual([])
    })
    it(`${first} 양성 대조 — 같은 작업 링크면 그대로 붙은 것으로(다시 쓰지 않음)`, async () => {
      const h = rig({ first, holder: { ...OTHER_STORED, itemId: 'm-new', key: 'CORE-9' } })
      const result = await h.service.start(mine())
      expect(h.links.saved).toEqual([])
      expect(result).toMatchObject({ worktreePath: PATH, linkSaved: true })
      expect(result.stages.worktree.code).not.toBe('held_by_other')
      expect(h.pending.entries).toEqual([])
    })
  }
  it('새로 만든(completed) 자리는 지금대로 덮는다', async () => {
    const links = fakeLinks({ held: { [PATH]: OTHER_STORED } })
    const service = new StartService({
      invoke: () => async () => created({}), repos: () => [testRepo({ root: ROOT, worktrees: [] })],
      links: () => links, work: () => null, log: () => {}, cwd: '/', sleep: async () => {}, pending: new MemoryPending(),
    })
    const result = await service.start(mine())
    expect(result).toMatchObject({ worktreePath: PATH, linkSaved: true })
    expect(links.saved.map((row) => row.link.itemId)).toEqual(['m-new'])
  })
})

describe('R4-D 실패 응답에 실린 경로는 미확정 붙이기로만 — 남의 링크를 덮지 않고 완료로 그리지 않는다 (리뷰 재현 grok-r4-raw/probe-git-failed)', () => {
  const OTHER_STORED: StoredWorkLink = { sourceId: 'mock-jira', connectionId: 'c', key: 'CORE-1', itemId: 'm-1', linkedAt: 1 }
  const gitFailed = () => fail('git_failed', 'Git command failed', { path: PATH })
  function rig({ held, answer }: { held?: Record<string, StoredWorkLink | 'suppressed'>; answer: () => RpcResponse }) {
    const links = fakeLinks({ held })
    const stores: string[] = []
    const work: LinkWorkPort = {
      linkConnections: () => [], repoDefaultConnection: () => null, recordEvent: () => true,
      storeLink: async ({ action }) => { stores.push(action); return { state: 'saved', message: null } }, refreshEvent: () => false, storeAutoLink: async () => null,
    }
    const pending = new MemoryPending()
    const service = new StartService({
      invoke: () => async () => answer(), repos: () => [testRepo({ root: ROOT, worktrees: [] })],
      links: () => links, work: () => work, log: () => {}, cwd: '/', sleep: async () => {}, pending,
    })
    return { service, links, stores, pending }
  }
  const mine = () => input({ itemId: 'm-new', itemKey: 'CORE-9' })
  for (const [label, holder] of [['다른 작업 명시 링크', OTHER_STORED], ['떼기 예외', 'suppressed']] as const) {
    it(`${label} 자리 + git_failed{resources.path} — 링크 유지 · held_by_other · 완료 아님(상태 옮기기 조건 거짓) · 출처 저장 0 (고침 전: 덮음 · completed)`, async () => {
      const h = rig({ held: { [PATH]: holder }, answer: gitFailed })
      const result = await h.service.start(mine())
      expect(h.links.saved).toEqual([])
      expect(h.links.table.get(PATH)).toBe(holder)
      expect(result.stages.worktree).toMatchObject({ status: 'unknown', code: 'held_by_other' })
      expect(result.stages.worktree.status).not.toBe('completed')
      expect(result).toMatchObject({ worktreePath: null, linkSaved: false })
      expect(h.stores).toEqual([])
      expect(h.pending.entries).toEqual([])
    })
  }
  it('양성 대조 — 빈 자리 + 같은 응답(added 뒤 실패와 같은 모양)은 이 작업으로 붙는다 · 단계는 미확정 · 열기/다시 띄우기', async () => {
    const h = rig({ answer: gitFailed })
    const result = await h.service.start(mine())
    expect(h.links.saved.map((row) => [row.path, row.link.itemId])).toEqual([[PATH, 'm-new']])
    expect(result).toMatchObject({ worktreePath: PATH, linkSaved: true })
    expect(result.stages.worktree).toMatchObject({ status: 'unknown', code: 'git_failed' })
    expect(result.stages.agent).toMatchObject({ status: 'failed', code: 'git_failed' })
    expect(h.stores).toEqual(['save'])
    expect(h.pending.entries).toEqual([])
  })
  it('무회귀 — 경로 없는 already_exists 는 실패 · 링크 없음 · 기존 링크 그대로', async () => {
    const h = rig({ held: { [PATH]: OTHER_STORED }, answer: () => fail('already_exists') })
    const result = await h.service.start(mine())
    expect(result.stages.worktree).toMatchObject({ status: 'failed', code: 'already_exists' })
    expect(h.links.saved).toEqual([])
    expect(h.links.table.get(PATH)).toBe(OTHER_STORED)
  })
})

describe('R4-B recover 가 붙인 링크의 출처 저장 실패는 활동 줄로 남는다 (리뷰 C4-2)', () => {
  function rig(answer: () => Promise<{ state: 'saved' | 'failed' | 'skipped'; message: string | null }>) {
    const pending = new MemoryPending()
    const events: { eventKey: string; change: WorkActivityChange }[] = []
    const work: LinkWorkPort = {
      linkConnections: () => [], repoDefaultConnection: () => null,
      recordEvent: ({ eventKey, change }) => { if (events.some((row) => row.eventKey === eventKey)) return false; events.push({ eventKey, change }); return true },
      storeLink: () => answer(), refreshEvent: () => false, storeAutoLink: async () => null,
    }
    const service = new StartService({
      invoke: () => async () => fail('outcome_unknown'), repos: () => [testRepo({ root: ROOT, worktrees: [] })],
      links: () => fakeLinks(), work: () => work, log: () => {}, cwd: '/', sleep: async () => {}, pending,
    })
    const failures = () => events.filter((row) => row.change.field === 'run' && row.change.event === 'source_link_failed')
    return { service, pending, failures }
  }
  const tree = [testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME })] })]
  it('실패 주입 → 활동 1줄(열쇠 run:srcfail:run:start:<id>) · 두 번 recover 해도 1줄 (고침 전: 0줄)', async () => {
    const h = rig(async () => ({ state: 'failed', message: '출처에 링크를 남기지 못했습니다.' }))
    const first = await h.service.start(input())
    expect(await h.service.recover(tree)).toBe(1)
    await h.service.recover(tree)
    expect(h.failures()).toEqual([{ eventKey: `run:srcfail:run:start:${first.attemptId}`, change: { field: 'run', event: 'source_link_failed', worktree: PATH, message: '출처에 링크를 남기지 못했습니다.' } }])
  })
  it('양성 대조 — 출처 저장 성공 · 건너뜀이면 0줄', async () => {
    for (const state of ['saved', 'skipped'] as const) {
      const h = rig(async () => ({ state, message: null }))
      await h.service.start(input())
      expect(await h.service.recover(tree)).toBe(1)
      expect(h.failures()).toEqual([])
    }
  })
})

describe('R3-H 로컬 링크 저장이 실패한 회차엔 출처 저장을 부르지 않는다 (리뷰 재현 claude-r3-raw/scratch-start S1)', () => {
  function rig(canSave: () => boolean) {
    const pending = new MemoryPending()
    const stores: string[] = []
    const work: LinkWorkPort = {
      linkConnections: () => [], repoDefaultConnection: () => null, recordEvent: () => true,
      storeLink: async ({ action }) => { stores.push(action); return { state: 'saved', message: null } }, refreshEvent: () => false, storeAutoLink: async () => null,
    }
    const service = new StartService({
      invoke: () => async () => created({}), repos: () => [testRepo({ root: ROOT, worktrees: [] })],
      links: () => fakeLinks({ canSave }), work: () => work, log: () => {}, cwd: '/', sleep: async () => {}, pending,
    })
    return { service, pending, stores }
  }
  const tree = [testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME })] })]
  it('S1 시작 1 + recover 5 가 모두 실패 → storeLink 0 (고침 전: 6) · 결과 sourceLink null · 기록 유지', async () => {
    const h = rig(() => false)
    const result = await h.service.start(input())
    for (let i = 0; i < 5; i += 1) await h.service.recover(tree)
    expect(h.stores).toEqual([])
    expect(result.sourceLink).toBeNull()
    expect(h.pending.entries).toHaveLength(1)
  })
  it('양성 대조 — 실패 뒤 저장이 되는 회차에 한 번만 출처 저장', async () => {
    let can = false
    const h = rig(() => can)
    await h.service.start(input())
    await h.service.recover(tree)
    can = true
    await h.service.recover(tree)
    await h.service.recover(tree)
    expect(h.stores).toEqual(['save'])
    expect(h.pending.entries).toEqual([])
  })
})

describe('R2-K 초안 단계 문구 · 넣지 못한 이유', () => {
  const draftStages = (prompt: Record<string, unknown>) => ({ stages: { worktree: { status: 'completed', path: PATH }, terminal: { status: 'completed' }, agent: { status: 'completed' }, prompt }, worktree: { path: PATH } })
  it('초안 완료는 「붙여넣기를 한 번 썼습니다 — 입력창에서 확인하세요.」 — 입력창에 있다 · 제출 안 됨이라고 쓰지 않는다', () => {
    const { stages } = mapAgentStages(draftStages({ status: 'completed', mode: 'draft', enterSent: false }))
    expect(stages.prompt).toEqual({ status: 'completed', code: 'draft', message: '붙여넣기를 한 번 썼습니다 — 입력창에서 확인하세요.' })
    expect(stages.prompt.message).not.toMatch(/제출되지|입력창에 있/)
    expect(mapAgentStages(draftStages({ status: 'completed' })).stages.prompt).toEqual({ status: 'completed', code: null, message: null })
  })
  it('empty_after_sanitize · agent_not_ready 는 그 이유로 실패 단계', () => {
    expect(mapAgentStages(draftStages({ status: 'not_started', mode: 'draft', reason: 'empty_after_sanitize' })).stages.prompt).toEqual({ status: 'failed', code: 'empty_after_sanitize', message: '정제한 뒤 남은 본문이 없습니다.' })
    expect(mapAgentStages(draftStages({ status: 'not_started', mode: 'draft', reason: 'agent_not_ready' })).stages.prompt).toEqual({ status: 'failed', code: 'agent_not_ready', message: '에이전트가 준비되지 않아 초안을 넣지 않았습니다.' })
  })
})

describe('LIFE-635 C6 일반 시작 — 출처 링크 저장 실패', () => {
  it('로컬 링크 저장 · 시작 단계 완료(진행 막힘 없음) · 결과 failed + 이쪽 말 · 활동에 출처 저장 실패 1줄', async () => {
    const h = harness({ answer: () => created({}), storeState: 'failed' })
    const given = input()
    const result = await h.service.start(given)
    expect(result.stages.worktree.status).toBe('completed')
    expect(result.stages.agent.status).toBe('completed')
    expect(result).toMatchObject({ linkSaved: true, sourceLink: { state: 'failed', message: 'LA 에 닿지 않습니다 (ECONNRESET).' } })
    expect(h.saved).toHaveLength(1)
    expect(h.events.map((row) => row.eventKey)).toEqual([`run:start:${given.attemptId}`, `run:srcfail:run:start:${given.attemptId}`])
  })
  it('양성 대조 — 저장 성공이면 출처 실패 줄 0', async () => {
    const h = harness({ answer: () => created({}) })
    await h.service.start(input())
    expect(h.events.filter((row) => row.change.field === 'run' && row.change.event === 'source_link_failed')).toEqual([])
  })
})
