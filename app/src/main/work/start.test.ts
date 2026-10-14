// LIFE-603 C6·C7 — 시작 서비스: 단계 매핑 · 실패 분기(양성 대조) · 같은 id 합류 · 이어 받기 · 빈 터미널 · 링크 저장.
// 런타임 응답은 `worktree create --agent` 가 실제로 내는 모양(`runtime/workspace/index.ts` 의 stages)을 그대로 만든다.
import { describe, expect, it } from 'vitest'
import type { Invocation, RpcResponse } from '../../runtime/contracts.js'
import { newAttemptId, type StartWorkInput } from '../../shared/work-start.js'
import { testRepo, testWorktree } from '../../shared/test-rows.js'
import type { RepoRow } from '../../shared/types.js'
import type { StoredWorkLink } from '../../shared/work-link.js'
import type { WorkActivityChange } from '../../shared/work.js'
import { StartService, mapAgentStages } from './start.js'
import type { LinkWorkPort } from './links.js'

const ROOT = '/repo'
const NAME = 'LIFE-603-start'
const PATH = `${ROOT}/.claude/worktrees/${NAME}`
let seq = 0
const attempt = () => newAttemptId({ now: 1_760_000_000_000 + (seq += 1), uuid: '0b8f6a4e-7a8c-4c33-9a43-5f3c3f6d2b11' })
const input = (patch: Partial<StartWorkInput> = {}): StartWorkInput => ({ attemptId: attempt(), connectionId: 'c', sourceId: 'mock-jira', itemId: 'm-1', itemKey: 'CORE-1', repoRoot: ROOT, name: NAME, agent: 'claude', model: 'opus', effort: 'high', prompt: '작업 본문', submit: false, ...patch })

const ok = (result: unknown): RpcResponse => ({ id: 'x', ok: true, result, _meta: { runtimeId: 'r' } })
const fail = (code: string, message = code, resources?: unknown): RpcResponse => ({ id: 'x', ok: false, error: { code, message, ...(resources === undefined ? {} : { resources }) }, _meta: { runtimeId: 'r' } })
const created = (stages: Record<string, unknown>) => ok({ worktree: { path: PATH }, stages: { worktree: { status: 'completed', path: PATH }, terminal: { status: 'completed' }, agent: { status: 'completed' }, prompt: { status: 'completed', mode: 'draft', submitted: false }, ...stages }, outcome: 'completed' })

function harness({ answer, repos }: { answer: (invocation: Invocation, n: number) => Promise<RpcResponse> | RpcResponse; repos?: () => RepoRow[] }) {
  const calls: Invocation[] = []
  const saved: { path: string; link: StoredWorkLink }[] = []
  const events: { eventKey: string; change: WorkActivityChange }[] = []
  const stores: string[] = []
  const work: LinkWorkPort = {
    linkConnections: () => [], repoDefaultConnection: () => null,
    recordEvent: ({ eventKey, change }) => { events.push({ eventKey, change }); return true },
    storeLink: async ({ action }) => { stores.push(action); return { state: 'saved', message: null } },
  }
  const links = { saveExplicit: ({ path, link }: { path: string; link: StoredWorkLink }) => { saved.push({ path, link }); return true } }
  const service = new StartService({
    invoke: () => async (invocation) => { calls.push(invocation); return answer(invocation, calls.length) },
    repos: repos ?? (() => [testRepo({ root: ROOT, worktrees: [] })]),
    // 시험은 저장 한 칸만 쓴다 — 나머지 링크 기능은 links.test.ts.
    links: () => links,
    work: () => work,
    log: () => {},
    cwd: '/',
    sleep: async () => {},
  })
  return { service, calls, saved, events, stores }
}

describe('worktree create 단계 → 모달 3단계', () => {
  it('초안 완료 — 세 단계 완료, 런타임에 --draft · 모델 · effort · 같은 id', async () => {
    const h = harness({ answer: () => created({}) })
    const given = input()
    const result = await h.service.start(given)
    expect(result.stages).toEqual({ worktree: { status: 'completed', code: null, message: null }, agent: { status: 'completed', code: null, message: null }, prompt: { status: 'completed', code: null, message: null } })
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
  it('worktree 는 생겼는데 뒤가 던졌다(resources.path) — worktree 완료 · 에이전트 실패 · 링크 저장', async () => {
    const h = harness({ answer: () => fail('git_failed', 'Worktree created, follow-up failed', { path: PATH, branch: NAME }) })
    const result = await h.service.start(input())
    expect(result.stages.worktree.status).toBe('completed')
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
  it('호출자 timeout(request_cancelled) · 미확정(outcome_unknown) 은 실패가 아니다 — 같은 id 로 이어 받는다', async () => {
    const h = harness({ answer: (_invocation, n) => (n === 1 ? fail('request_cancelled') : n === 2 ? fail('outcome_unknown') : created({})) })
    const given = input()
    const result = await h.service.start(given)
    expect(result.stages.worktree.status).toBe('completed')
    expect(h.calls.map((call) => call.flags['request-id'])).toEqual([given.attemptId, given.attemptId, given.attemptId])
  })
  it('재시작 뒤 같은 이름(영수증 만료 · 빈 터미널) — 이 작업에 이미 붙은 worktree 면 실패가 아니라 합류', async () => {
    const repos = () => [testRepo({ root: ROOT, worktrees: [testWorktree({ path: PATH, branch: NAME, workLink: { mode: 'explicit', sourceId: 'mock-jira', connectionId: 'c', key: 'CORE-1', itemId: 'm-1', connected: true } })] })]
    const h = harness({ answer: () => fail('already_exists'), repos })
    const result = await h.service.start(input({ agent: 'shell', prompt: '' }))
    expect(result.stages.worktree).toMatchObject({ status: 'completed', code: 'already_linked' })
    expect(result.stages.agent.status).toBe('skipped')
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
  it('빈 터미널·틀린 입력은 거절, 런타임 실패는 에이전트 단계 실패', async () => {
    const h = harness({ answer: () => fail('agent_failed', '에이전트 기동 실패'), repos: linkedRepos('m-1') })
    expect((await h.service.relaunch(relaunch({ agent: 'shell' }))).refused).not.toBeNull()
    expect((await h.service.relaunch(relaunch({ attemptId: 'x' }))).refused).not.toBeNull()
    expect((await h.service.relaunch(relaunch())).stages.agent).toEqual({ status: 'failed', code: 'agent_failed', message: '에이전트 기동 실패' })
  })
})
