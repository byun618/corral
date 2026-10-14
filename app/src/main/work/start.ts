// 「작업에서 시작」 main 쪽 (LIFE-603 · K10 · D8) — 런타임 `worktree create` 를 부르고 단계 결과를 모달 모양으로 돌려준다.
//
// - **하네스를 다시 만들지 않는다**: worktree · pane · 에이전트 기동 · ready 판정 · 초안/제출은 런타임 명령 하나(`worktree create --agent …`)가 한다.
//   빈 터미널은 `worktree create`(에이전트 없음) 뒤 `terminal create`(런타임 명령 그대로).
// - **한 시도 = 요청 id 하나**(`attemptId`). 같은 id 의 두 번째 요청은 진행 중이면 그 약속에 합류하고, 끝났으면 기록을 돌려준다(main 메모리).
//   런타임도 같은 id 를 영수증으로 replay 한다(에이전트 경로) — 앱을 다시 띄운 뒤의 같은 id 도 하나다.
//   같은 작업 · 같은 레포 · 같은 이름의 진행 중 시도가 있으면 id 가 달라도 그것에 합류한다(빈 터미널은 영수증이 없어 이 합류가 유일한 방패다).
// - **호출자 timeout 은 실패가 아니다**: `request_cancelled`·`outcome_unknown` 이면 같은 id 로 다시 묻는다(런타임이 그 id 를 replay 하거나 줄에서 기다린다).
// - worktree 가 생겼으면(뒤 단계가 실패해도) 명시 링크를 저장하고 실행 갈래에 「작업 시작」 을 남긴다. 출처 링크 저장은 능력이 켜진 출처만.
// - 첫 프롬프트 본문은 로그에 남기지 않는다(외부 본문 — 킥오프 비밀값 규칙).

import type { Invocation, RpcResponse } from '../../runtime/contracts.js'
import { derivedRequestId } from '../../runtime/terminal/index.js'
import { isRecord } from '../../shared/json.js'
import type { RepoRow } from '../../shared/types.js'
import { effortOptions, knownOption, modelOptions } from '../../shared/agent-options.js'
import type { StoredWorkLink } from '../../shared/work-link.js'
import { initialStages, readStartWorkInput, readStartWorkStatusQuery, startWorktreePath, type StartAttemptView, type StartStage, type StartStageName, type StartWorkInput, type StartWorkResult } from '../../shared/work-start.js'
import type { WorkLinks } from './links.js'
import type { LinkWorkPort } from './links.js'

export type StartDeps = {
  invoke: () => ((invocation: Invocation, timeoutMs?: number) => Promise<RpcResponse>) | null
  repos: () => RepoRow[]
  links: () => Pick<WorkLinks, 'saveExplicit'> | null
  work: () => LinkWorkPort | null
  log: (event: string, data: Record<string, unknown>) => void
  cwd: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 한 시도의 전체 기한 — 기본 10분(에이전트 ready 대기 포함). */
  deadlineMs?: number
}

type Attempt = { input: StartWorkInput; promise: Promise<StartWorkResult>; result: StartWorkResult | null }

const RETRY_CODES = new Set(['request_cancelled', 'outcome_unknown'])
const INVOKE_TIMEOUT_MS = 600_000

const stage = (status: StartStage['status'], code: string | null = null, message: string | null = null): StartStage => ({ status, code, message })

function stageOf(value: unknown): { status: string; error: string | null; message: string | null; reason: string | null } {
  if (!isRecord(value)) return { status: 'unknown', error: null, message: null, reason: null }
  const read = (key: string) => (typeof value[key] === 'string' ? String(value[key]) : null)
  return { status: read('status') ?? 'unknown', error: read('error'), message: read('message'), reason: read('reason') }
}

const PROMPT_REASON: Record<string, string> = {
  agent_blocked: '에이전트가 막는 화면(신뢰·로그인·권한)을 띄웠습니다 — 터미널에서 풀어 주세요.',
  detect_manifest_unverified: '에이전트 상태 판독을 확인하지 못해 초안을 넣지 않았습니다.',
  agent_not_ready: '에이전트가 준비되지 않아 초안을 넣지 않았습니다.',
  empty_after_sanitize: '정제한 뒤 남은 본문이 없습니다.',
}

/** 런타임 `worktree create --agent` 결과의 단계 → 모달 3단계. */
export function mapAgentStages(result: unknown): { stages: Record<StartStageName, StartStage>; path: string | null } {
  const stages = initialStages()
  if (!isRecord(result) || !isRecord(result.stages)) return { stages: { worktree: stage('unknown'), agent: stage('unknown'), prompt: stage('unknown') }, path: null }
  const raw = result.stages
  const worktree = stageOf(raw.worktree), terminal = stageOf(raw.terminal), agent = stageOf(raw.agent), prompt = stageOf(raw.prompt)
  const path = isRecord(raw.worktree) && typeof raw.worktree.path === 'string' ? raw.worktree.path : isRecord(result.worktree) && typeof result.worktree.path === 'string' ? result.worktree.path : null
  stages.worktree = worktree.status === 'completed' ? stage('completed') : stage(worktree.status === 'unknown' ? 'unknown' : 'failed', worktree.error, worktree.message)
  if (terminal.status === 'failed' || terminal.status === 'unknown') stages.agent = stage(terminal.status === 'failed' ? 'failed' : 'unknown', terminal.error, terminal.message)
  else if (agent.status === 'completed') stages.agent = stage('completed')
  else stages.agent = stage(agent.status === 'unknown' ? 'unknown' : 'failed', agent.error, agent.message)
  if (stages.agent.status !== 'completed') stages.prompt = stage('skipped')
  else if (prompt.status === 'completed' || prompt.status === 'queued') stages.prompt = stage('completed')
  else if (prompt.status === 'not_started') stages.prompt = stage('failed', prompt.reason ?? 'not_started', PROMPT_REASON[prompt.reason ?? ''] ?? '초안을 넣지 않았습니다.')
  else stages.prompt = stage(prompt.status === 'unknown' ? 'unknown' : 'failed', prompt.error, prompt.message)
  return { stages, path }
}

export class StartService {
  private readonly deps: StartDeps
  private readonly attempts = new Map<string, Attempt>()
  /** 작업(연결::작업 id) → 마지막 시도 id. */
  private readonly latest = new Map<string, string>()
  private inflight = 0
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(deps: StartDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** 진행 중인 시작이 있나 — 카드 메뉴 쓰기가 workspace 줄 뒤에 서지 않고 바로 알리게(F3). */
  busy(): boolean {
    return this.inflight > 0
  }

  status(input: unknown): StartAttemptView | null {
    const query = readStartWorkStatusQuery(input)
    if (query === null) return null
    const id = this.latest.get(`${query.connectionId}::${query.itemId}`)
    const attempt = id === undefined ? undefined : this.attempts.get(id)
    if (attempt === undefined) return null
    const { input: given } = attempt
    return { attemptId: given.attemptId, name: given.name, repoRoot: given.repoRoot, agent: given.agent, model: given.model, effort: given.effort, submit: given.submit, result: attempt.result }
  }

  async start(raw: unknown): Promise<StartWorkResult> {
    const input = readStartWorkInput(raw)
    if (input === null) return this.refused('', '시작 입력이 잘못됐습니다.')
    const same = this.attempts.get(input.attemptId)
    if (same !== undefined) return { ...(await same.promise), joined: true }
    const twin = [...this.attempts.values()].find((attempt) => attempt.result === null && attempt.input.connectionId === input.connectionId && attempt.input.itemId === input.itemId
      && attempt.input.repoRoot === input.repoRoot && attempt.input.name === input.name)
    if (twin !== undefined) return { ...(await twin.promise), joined: true }
    if (!this.deps.repos().some((repo) => repo.root === input.repoRoot)) return this.refused(input.attemptId, '등록된 레포가 아닙니다.')
    if (this.deps.invoke() === null) return this.refused(input.attemptId, '런타임이 아직 서지 않았습니다.')
    const promise = this.run(input)
    const attempt: Attempt = { input, promise, result: null }
    this.attempts.set(input.attemptId, attempt)
    this.latest.set(`${input.connectionId}::${input.itemId}`, input.attemptId)
    this.inflight += 1
    try {
      const result = await promise
      attempt.result = result
      return result
    } finally {
      this.inflight -= 1
    }
  }

  private refused(attemptId: string, message: string): StartWorkResult {
    return { attemptId, joined: false, done: true, stages: { worktree: stage('failed', 'refused', message), agent: stage('skipped'), prompt: stage('skipped') }, worktreePath: null, linkSaved: false, sourceLink: null, refused: message }
  }

  /** 같은 id 로 이어 묻는다 — 호출자 timeout · 결과 미확정은 실패로 읽지 않는다. 기한이 지나면 마지막 응답 그대로. */
  private async call(invocation: Invocation): Promise<RpcResponse | null> {
    const deadline = this.now() + (this.deps.deadlineMs ?? INVOKE_TIMEOUT_MS)
    let last: RpcResponse | null = null
    for (let round = 0; ; round += 1) {
      const invoke = this.deps.invoke()
      if (invoke === null) return last
      last = await invoke({ ...invocation, args: [], cwd: this.deps.cwd }, Math.max(1_000, Math.min(INVOKE_TIMEOUT_MS, deadline - this.now())))
      const code = last.ok ? null : (last.error?.code ?? null)
      if (code === null || !RETRY_CODES.has(code) || this.now() >= deadline) return last
      this.deps.log('work.start_retry', { requestId: invocation.flags['request-id'] ?? null, code, round })
      await this.sleep(Math.min(5_000, 500 * (round + 1)))
    }
  }

  private async run(input: StartWorkInput): Promise<StartWorkResult> {
    const shell = input.agent === 'shell'
    this.deps.log('work.start', { attemptId: input.attemptId, agent: input.agent, name: input.name, repo: input.repoRoot, submit: shell ? null : input.submit, promptBytes: Buffer.byteLength(input.prompt) })
    const flags: Invocation['flags'] = { name: input.name, repo: input.repoRoot, 'request-id': input.attemptId }
    if (!shell) {
      flags.agent = input.agent
      const model = knownOption({ options: modelOptions(input.agent), value: input.model })
      const effort = knownOption({ options: effortOptions(input.agent), value: input.effort })
      if (model !== '') flags.model = model
      if (effort !== '') flags.effort = effort
      flags.prompt = input.prompt
      if (!input.submit) flags.draft = true
    }
    const response = await this.call({ command: 'worktree create', flags, args: [], cwd: this.deps.cwd })
    let stages = initialStages()
    let path: string | null = null
    if (response === null) {
      stages = { worktree: stage('unknown', 'runtime_unavailable', '런타임이 사라졌습니다.'), agent: stage('skipped'), prompt: stage('skipped') }
    } else if (!response.ok) {
      const code = response.error?.code ?? 'operation_failed', message = response.error?.message ?? '알 수 없는 오류'
      const resources = response.error?.resources
      const created = isRecord(resources) && typeof resources.path === 'string' ? resources.path : null
      const expected = startWorktreePath({ repoRoot: input.repoRoot, name: input.name })
      const mine = code === 'already_exists' ? this.linkedTo({ path: expected, input }) : false
      if (mine) {
        // 같은 작업에 이미 붙은 worktree(앞 시도·재시작 뒤 같은 이름) — 실패가 아니라 합류다. 에이전트는 다시 띄우지 않는다.
        path = expected
        stages = { worktree: stage('completed', 'already_linked', '이 작업에 이미 만든 worktree 입니다.'), agent: stage('skipped', 'already_linked', '에이전트는 다시 띄우지 않았습니다.'), prompt: stage('skipped') }
      } else {
        path = created
        stages = { worktree: created === null ? stage(RETRY_CODES.has(code) ? 'unknown' : 'failed', code, message) : stage('completed'), agent: stage(created === null ? 'skipped' : 'failed', created === null ? null : code, created === null ? null : message), prompt: stage('skipped') }
      }
    } else if (shell) {
      path = isRecord(response.result) && isRecord(response.result.worktree) && typeof response.result.worktree.path === 'string' ? response.result.worktree.path : null
      stages.worktree = stage('completed')
      stages.prompt = stage('skipped')
      if (path !== null) {
        const terminal = await this.call({ command: 'terminal create', flags: { worktree: `path:${path}`, 'request-id': derivedRequestId(input.attemptId, 'shell') }, args: [], cwd: this.deps.cwd })
        stages.agent = terminal?.ok ? stage('completed') : stage('failed', terminal?.error?.code ?? 'runtime_unavailable', terminal?.error?.message ?? '터미널을 열지 못했습니다.')
      } else stages.agent = stage('unknown', 'no_path', 'worktree 경로를 받지 못했습니다.')
    } else {
      const mapped = mapAgentStages(response.result)
      stages = mapped.stages
      path = mapped.path
    }
    const { linkSaved, sourceLink } = path === null || stages.worktree.status !== 'completed' ? { linkSaved: false, sourceLink: null } : await this.link({ input, path })
    const result: StartWorkResult = { attemptId: input.attemptId, joined: false, done: true, stages, worktreePath: path, linkSaved, sourceLink, refused: null }
    this.deps.log('work.start_done', { attemptId: input.attemptId, stages: Object.fromEntries(Object.entries(stages).map(([key, value]) => [key, value.status])), linkSaved, sourceLink: sourceLink?.state ?? null })
    return result
  }

  private linkedTo({ path, input }: { path: string; input: StartWorkInput }): boolean {
    const repo = this.deps.repos().find((row) => row.root === input.repoRoot)
    const link = repo?.worktrees.find((row) => row.path === path)?.workLink ?? null
    return link !== null && link.mode === 'explicit' && link.connectionId === input.connectionId && link.itemId === input.itemId
  }

  private async link({ input, path }: { input: StartWorkInput; path: string }): Promise<{ linkSaved: boolean; sourceLink: StartWorkResult['sourceLink'] }> {
    const stored: StoredWorkLink = { sourceId: input.sourceId, connectionId: input.connectionId, itemId: input.itemId, key: input.itemKey, linkedAt: this.now() }
    const linkSaved = this.deps.links()?.saveExplicit({ path, link: stored }) ?? false
    const work = this.deps.work()
    work?.recordEvent({
      connectionId: input.connectionId, itemId: input.itemId, itemKey: input.itemKey, eventKey: `run:start:${input.attemptId}`,
      change: { field: 'run', event: 'start', worktree: path, branch: input.name, agent: input.agent, model: input.agent === 'shell' || input.model === '' ? null : input.model },
    })
    const sourceLink = work === null ? null : await work.storeLink({ connectionId: input.connectionId, itemId: input.itemId, link: { kind: 'worktree', path, repoRoot: input.repoRoot }, action: 'save' })
    return { linkSaved, sourceLink }
  }
}
