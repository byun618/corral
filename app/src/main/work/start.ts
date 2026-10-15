// 「작업에서 시작」 main 쪽 (LIFE-603 · K10 · D8) — 런타임 `worktree create` 를 부르고 단계 결과를 모달 모양으로 돌려준다.
//
// - **하네스를 다시 만들지 않는다**: worktree · pane · 에이전트 기동 · ready 판정 · 초안/제출은 런타임 명령 하나(`worktree create --agent …`)가 한다.
//   빈 터미널은 `worktree create`(에이전트 없음) 뒤 `terminal create`(런타임 명령 그대로).
// - **한 시도 = 요청 id 하나**(`attemptId`). 같은 id 의 두 번째 요청은 진행 중이면 그 약속에 합류하고, 끝났으면 기록을 돌려준다(main 메모리).
//   런타임도 같은 id 를 영수증으로 replay 한다(에이전트 경로) — 앱을 다시 띄운 뒤의 같은 id 도 하나다.
//   같은 작업 · 같은 레포 · 같은 이름의 진행 중 시도가 있으면 id 가 달라도 그것에 합류한다(빈 터미널은 영수증이 없어 이 합류가 유일한 방패다).
// - **호출자 timeout 은 실패가 아니다**: `request_cancelled` 면 같은 id 로 다시 묻는다(줄에서 기다리다 끊긴 요청은 영수증이 풀려 다시 돈다).
//   `outcome_unknown`(효과가 시작된 뒤 끊겨 영수증이 pending)은 **다시 묻지 않는다** — 같은 답이 영원히 온다(R1-B). 단계는 `unknown` 이고,
//   예정 경로에 worktree 가 있으면 그것을 링크한다(없으면 미확정 기록이 남아 나중에 나타나면 붙인다 — `recover`).
// - **시작 의도를 먼저 적는다**(R1-C): 런타임을 부르기 전에 미확정 기록(`start-pending.ts`), 링크를 저장하면 지운다.
// - worktree 가 생겼으면(뒤 단계가 실패해도) 명시 링크를 저장하고 실행 갈래에 「작업 시작」 을 남긴다. 출처 링크 저장은 능력이 켜진 출처만.
// - 첫 프롬프트 본문은 로그에 남기지 않는다(외부 본문 — 킥오프 비밀값 규칙).

import type { Invocation, RpcResponse } from '../../runtime/contracts.js'
import { derivedRequestId } from '../../runtime/terminal/index.js'
import { isRecord } from '../../shared/json.js'
import type { RepoRow } from '../../shared/types.js'
import { effortOptions, knownOption, modelOptions } from '../../shared/agent-options.js'
import type { StoredWorkLink } from '../../shared/work-link.js'
import { initialStages, readRelaunchAgentInput, readStartWorkInput, readStartWorkStatusQuery, startWorktreePath, type StartAttemptView, type StartStage, type StartStageName, type StartWorkInput, type StartWorkResult } from '../../shared/work-start.js'
import type { WorkLinks } from './links.js'
import type { ClaimResult, LinkWorkPort } from './links.js'
import type { PendingPort, PendingStart } from './start-pending.js'
import { PENDING_TTL_MS } from './start-pending.js'
import { sanitizeDraftBody } from '../../shared/terminal-paste.js'

export type StartDeps = {
  invoke: () => ((invocation: Invocation, timeoutMs?: number) => Promise<RpcResponse>) | null
  repos: () => RepoRow[]
  links: () => Pick<WorkLinks, 'saveExplicit' | 'claimExplicit'> | null
  work: () => LinkWorkPort | null
  log: (event: string, data: Record<string, unknown>) => void
  cwd: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 미확정 시작 기록(R1-C). 없으면 기록하지 않는다(시험). */
  pending?: PendingPort
  /** 그 경로에 git worktree 가 있나 — 결과 미확정 뒤 찾기(R1-B). 기본은 트리만 본다. */
  worktreeExists?: (path: string) => boolean
  /** 한 시도의 전체 기한 — 기본 10분(에이전트 ready 대기 포함). */
  deadlineMs?: number
}

type Attempt = { input: StartWorkInput; promise: Promise<StartWorkResult>; result: StartWorkResult | null }

const RETRY_CODES = new Set(['request_cancelled'])
const UNKNOWN_CODES = new Set(['request_cancelled', 'outcome_unknown'])
/** 끝난 시도를 몇 개까지 기억하나(R1-Q) — 작업마다 마지막 시도는 늘 남긴다. */
const KEEP_FINISHED = 50
const INVOKE_TIMEOUT_MS = 600_000

const stage = (status: StartStage['status'], code: string | null = null, message: string | null = null): StartStage => ({ status, code, message })

function stageOf(value: unknown): { status: string; error: string | null; message: string | null; reason: string | null } {
  if (!isRecord(value)) return { status: 'unknown', error: null, message: null, reason: null }
  const read = (key: string) => (typeof value[key] === 'string' ? String(value[key]) : null)
  return { status: read('status') ?? 'unknown', error: read('error'), message: read('message'), reason: read('reason') }
}

export const DRAFT_WRITTEN = '붙여넣기를 한 번 썼습니다 — 입력창에서 확인하세요.'

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
  // 초안 완료는 「corral 이 붙여넣기를 한 번 썼다」 는 관측이다(R2-K) — 입력창에 남았다거나 제출되지 않았다는 증명으로 읽히지 않게 그대로 적는다.
  else if (prompt.status === 'completed') stages.prompt = isRecord(raw.prompt) && raw.prompt.mode === 'draft' ? stage('completed', 'draft', DRAFT_WRITTEN) : stage('completed')
  // 바로 보내기의 `queued` = 런타임 줄이 받았다는 뜻(D9) — 전달 확인이 아니라 「줄에 넣음」 으로 따로 그린다(R1-P).
  else if (prompt.status === 'queued') stages.prompt = stage('queued')
  else if (prompt.status === 'not_started') stages.prompt = stage('failed', prompt.reason ?? 'not_started', PROMPT_REASON[prompt.reason ?? ''] ?? '초안을 넣지 않았습니다.')
  else stages.prompt = stage(prompt.status === 'unknown' ? 'unknown' : 'failed', prompt.error, prompt.message)
  return { stages, path }
}

export class StartService {
  private readonly deps: StartDeps
  private readonly attempts = new Map<string, Attempt>()
  private readonly relaunches = new Map<string, Promise<StartWorkResult>>()
  private readonly recovering = new Set<string>()
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
      this.prune()
      return result
    } finally {
      this.inflight -= 1
    }
  }

  /** 끝난 시도는 최근 `KEEP_FINISHED` 개만(작업마다 마지막 시도는 이어 받기용으로 남긴다). */
  private prune(): void {
    const latest = new Set(this.latest.values())
    const finished = [...this.attempts.entries()].filter(([id, attempt]) => attempt.result !== null && !latest.has(id))
    for (const [id] of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.attempts.delete(id)
    for (const id of [...this.relaunches.keys()].slice(0, Math.max(0, this.relaunches.size - KEEP_FINISHED))) this.relaunches.delete(id)
  }

  /**
   * 미확정 시작 맞추기(R1-C) — 상태를 내보낼 때마다 부른다. 이번 실행에서 진행 중인 시도는 건너뛴다.
   * 예정 경로의 worktree 가 트리에 있으면 링크 · 「작업 시작」 활동 · 출처 링크를 적고 기록을 지운다(링크 저장이 실패하면 남겨 다음에 다시 — R2-B).
   * 시도 전부터 그 경로가 있었던 기록은 붙이지 않고 버린다(R2-A). 하루 넘게 안 나타나면 버린다.
   */
  async recover(repos: RepoRow[]): Promise<number> {
    const pending = this.deps.pending
    if (pending === undefined) return 0
    const paths = new Set(repos.flatMap((repo) => repo.worktrees.map((row) => row.path)))
    let linked = 0
    for (const entry of pending.list()) {
      // 앞 기록이 같은 경로를 확정하며 지웠으면 건너뛴다(R3-A).
      if (!pending.list().some((row) => row.attemptId === entry.attemptId)) continue
      const live = this.attempts.get(entry.attemptId)
      if (live !== undefined && live.result === null) continue
      if (this.recovering.has(entry.attemptId)) continue
      if (entry.preexisting) {
        // 시도 전부터 있던 자리 — 거기 있는 worktree 가 이 시도의 것인지 알 길이 없다. 붙이지 않고 기록만 버린다(R2-A).
        pending.remove(entry.attemptId)
        this.deps.log('work.start_pending_preexisting', { attemptId: entry.attemptId, path: entry.path })
      } else if (paths.has(entry.path)) {
        this.recovering.add(entry.attemptId)
        try {
          // 이 기록의 시도가 만든 것인지 모르는 자리라 남의 링크 · 떼기 예외 · 다른 시도가 붙인 링크를 덮지 않는다(R3-A·R3-C).
          const { claim, sourceLink } = await this.link({ input: entry, path: entry.path, claim: true })
          this.deps.log('work.start_recovered', { attemptId: entry.attemptId, path: entry.path, claim, sourceLink: sourceLink?.state ?? null })
          // 복구가 붙인 링크는 결과를 볼 모달이 없다 — 출처 저장 실패를 자동 연결과 같은 활동 줄로 남긴다(R4-B · C14, 열쇠로 한 번).
          if (sourceLink?.state === 'failed') {
            this.deps.work()?.recordEvent({
              connectionId: entry.connectionId, itemId: entry.itemId, itemKey: entry.itemKey, eventKey: `run:srcfail:run:start:${entry.attemptId}`,
              change: { field: 'run', event: 'source_link_failed', worktree: entry.path, message: sourceLink.message },
            })
          }
          if (claim === 'saved') linked += 1
          if (claim === 'held' || claim === 'linked') pending.remove(entry.attemptId)
        } finally {
          this.recovering.delete(entry.attemptId)
        }
      } else if (this.now() - entry.startedAt > PENDING_TTL_MS) {
        pending.remove(entry.attemptId)
        this.deps.log('work.start_pending_expired', { attemptId: entry.attemptId })
      }
    }
    return linked
  }

  /**
   * 에이전트 다시 띄우기(C6) — 그 작업에 명시 링크로 붙은 worktree 에만. 런타임 `terminal create --agent`(명령 그대로, 프롬프트 없음).
   * 새 시도 id 가 런타임 영수증 id 다 — 같은 id 연타는 pane 하나(replay).
   */
  async relaunch(raw: unknown): Promise<StartWorkResult> {
    const input = readRelaunchAgentInput(raw)
    if (input === null) return this.refused('', '다시 띄우기 입력이 잘못됐습니다.')
    const same = this.relaunches.get(input.attemptId)
    if (same !== undefined) return { ...(await same), joined: true }
    const link = this.deps.repos().flatMap((repo) => repo.worktrees).find((row) => row.path === input.path)?.workLink ?? null
    if (link === null || link.mode !== 'explicit' || link.connectionId !== input.connectionId || link.itemId !== input.itemId) return this.refused(input.attemptId, '이 작업에 붙은 worktree 가 아닙니다.')
    if (this.deps.invoke() === null) return this.refused(input.attemptId, '런타임이 아직 서지 않았습니다.')
    const promise = (async (): Promise<StartWorkResult> => {
      // 빈 터미널이면 에이전트 플래그 없이 터미널만 다시 연다(R1-A).
      const flags: Invocation['flags'] = { worktree: `path:${input.path}`, 'request-id': input.attemptId }
      if (input.agent !== 'shell') {
        flags.agent = input.agent
        const model = knownOption({ options: modelOptions(input.agent), value: input.model })
        const effort = knownOption({ options: effortOptions(input.agent), value: input.effort })
        if (model !== '') flags.model = model
        if (effort !== '') flags.effort = effort
      }
      this.deps.log('work.start_relaunch', { attemptId: input.attemptId, agent: input.agent, path: input.path })
      const { response } = await this.call({ command: 'terminal create', flags, args: [], cwd: this.deps.cwd })
      const failed = input.agent === 'shell' ? '터미널을 열지 못했습니다.' : '에이전트를 띄우지 못했습니다.'
      const agent = response === null ? stage('unknown', 'runtime_unavailable', '런타임이 사라졌습니다.')
        : !response.ok ? stage(UNKNOWN_CODES.has(response.error?.code ?? '') ? 'unknown' : 'failed', response.error?.code ?? 'operation_failed', response.error?.message ?? failed)
          : stage('completed', 'relaunched')
      return { attemptId: input.attemptId, joined: false, done: true, stages: { worktree: stage('completed', 'relaunch', '이미 있는 worktree 에 다시 열었습니다.'), agent, prompt: stage('skipped', 'relaunch', input.agent === 'shell' ? null : '다시 띄운 에이전트에는 프롬프트를 넣지 않습니다.') }, worktreePath: input.path, linkSaved: true, sourceLink: null, refused: null }
    })()
    this.relaunches.set(input.attemptId, promise)
    this.inflight += 1
    try { return await promise } finally { this.inflight -= 1 }
  }

  private refused(attemptId: string, message: string): StartWorkResult {
    return { attemptId, joined: false, done: true, stages: { worktree: stage('failed', 'refused', message), agent: stage('skipped'), prompt: stage('skipped') }, worktreePath: null, linkSaved: false, sourceLink: null, refused: message }
  }

  /**
   * 같은 id 로 이어 묻는다 — `request_cancelled`(호출자 timeout)만. 기한이 지나면 마지막 응답 그대로.
   * `retried` = 한 번이라도 끊겼다 — 그 뒤의 `already_exists`(빈 터미널은 영수증이 없다)는 이 시도가 만든 것일 수 있다.
   */
  private async call(invocation: Invocation): Promise<{ response: RpcResponse | null; retried: boolean }> {
    const deadline = this.now() + (this.deps.deadlineMs ?? INVOKE_TIMEOUT_MS)
    let last: RpcResponse | null = null
    for (let round = 0; ; round += 1) {
      const invoke = this.deps.invoke()
      if (invoke === null) return { response: last, retried: round > 0 }
      last = await invoke({ ...invocation, args: [], cwd: this.deps.cwd }, Math.max(1_000, Math.min(INVOKE_TIMEOUT_MS, deadline - this.now())))
      const code = last.ok ? null : (last.error?.code ?? null)
      if (code === null || !RETRY_CODES.has(code) || this.now() >= deadline) return { response: last, retried: round > 0 }
      this.deps.log('work.start_retry', { requestId: invocation.flags['request-id'] ?? null, code, round })
      await this.sleep(Math.min(5_000, 500 * (round + 1)))
    }
  }

  private exists(path: string): boolean {
    return this.deps.repos().some((repo) => repo.worktrees.some((row) => row.path === path)) || (this.deps.worktreeExists?.(path) ?? false)
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
      // 외부 본문 정제는 바로 보내기에도(R1-E) — 초안은 런타임이 한 번 더 정제한다(같은 함수, 멱등).
      flags.prompt = sanitizeDraftBody(input.prompt)
      if (!input.submit) flags.draft = true
    }
    const expected = startWorktreePath({ repoRoot: input.repoRoot, name: input.name })
    // 시도 전에 그 자리가 이미 있었나(R2-A) — 있었으면 끊긴 뒤에 그 자리를 보더라도 이 시도가 만든 것이라고 볼 수 없다.
    const preexisting = this.exists(expected)
    this.deps.pending?.add(pendingOf({ input, path: expected, now: this.now(), preexisting }))
    const { response, retried } = await this.call({ command: 'worktree create', flags, args: [], cwd: this.deps.cwd })
    let stages = initialStages()
    let path: string | null = null
    const unknown = (code: string, message: string): { path: string | null; stages: Record<StartStageName, StartStage> } => {
      // 결과 미확정 — 예정 경로에 worktree 가 있으면 그것을 이 시도의 것으로 링크하고 「worktree 열기」 를 준다(R1-B).
      // 시도 전부터 있던 자리면 붙이지 않는다(R2-A) — 다른 작업의 링크 · 떼기 예외일 수 있다.
      const found = !preexisting && this.exists(expected) ? expected : null
      const note = preexisting ? `${message} — 이 이름의 worktree 는 시작 전부터 있어 이 작업에 붙이지 않았습니다.`
        : found === null ? `${message} — worktree 가 나타나면 이 작업에 붙입니다.` : `${message} — worktree 는 만들어졌습니다.`
      return {
        path: found,
        stages: {
          worktree: stage('unknown', code, note),
          agent: stage('unknown', code, '에이전트 단계 결과를 받지 못했습니다.'),
          prompt: stage('unknown', code, null),
        },
      }
    }
    if (response === null) {
      ({ path, stages } = unknown('runtime_unavailable', '런타임이 사라졌습니다'))
    } else if (!response.ok) {
      const code = response.error?.code ?? 'operation_failed', message = response.error?.message ?? '알 수 없는 오류'
      const resources = response.error?.resources
      const created = isRecord(resources) && typeof resources.path === 'string' ? resources.path : null
      if (UNKNOWN_CODES.has(code)) ({ path, stages } = unknown(code, '런타임이 이 요청의 결과를 확정하지 못했습니다'))
      else if (code === 'already_exists' && this.linkedTo({ path: expected, input })) {
        // 같은 작업에 이미 붙은 worktree — 새로 만든 것이 없다. 성공이 아니라 「이미 있음」(R1-A): 열기 · 다시 띄우기로.
        path = expected
        const note = '이 작업에 이미 만든 worktree 입니다 — 새로 만들지 않았습니다.'
        stages = { worktree: stage('skipped', 'already_linked', note), agent: stage('skipped', 'already_linked', input.agent === 'shell' ? '터미널을 열지 않았습니다.' : '에이전트를 띄우지 않았습니다.'), prompt: stage('skipped', 'already_linked', null) }
      } else if (code === 'already_exists' && retried && !preexisting) {
        // 끊긴 뒤의 재시도가 자기 결과에 부딪혔다(빈 터미널은 영수증이 없다) — 시도 전엔 없던 자리라 이 시도가 만든 것일 수 있어 미확정으로 링크한다.
        // 시도 전부터 있던 자리면(R2-A) 아래 일반 실패 갈래 — 「이름을 바꿔 다시 시작」.
        ({ path, stages } = unknown('outcome_unknown', '앞 요청이 끊긴 뒤 같은 이름이 이미 있습니다'))
      } else {
        // 실패 응답에 실린 경로(R4-D) — 런타임은 `git worktree add` 가 실패해도 그 자리가 있으면 경로를 싣는다(같은 이름 동시 시작이면 남의 worktree).
        // 이 시도가 만든 것인지 모르니 `completed` 로 그리지 않고(상태 옮기기 안 나감) 미확정 붙이기(`claimExplicit`)로만 — 남의 링크 · 떼기 예외면 `held`.
        path = created
        stages = created === null
          ? { worktree: stage('failed', code, message), agent: stage('skipped'), prompt: stage('skipped') }
          : { worktree: stage('unknown', code, 'worktree 는 있지만 런타임이 오류로 끝나 이 시도가 만든 것인지 확정하지 못했습니다.'), agent: stage('failed', code, message), prompt: stage('skipped') }
      }
    } else if (shell) {
      path = isRecord(response.result) && isRecord(response.result.worktree) && typeof response.result.worktree.path === 'string' ? response.result.worktree.path : null
      stages.worktree = stage('completed')
      stages.prompt = stage('skipped')
      if (path !== null) {
        const { response: terminal } = await this.call({ command: 'terminal create', flags: { worktree: `path:${path}`, 'request-id': derivedRequestId(input.attemptId, 'shell') }, args: [], cwd: this.deps.cwd })
        stages.agent = terminal?.ok ? stage('completed') : stage('failed', terminal?.error?.code ?? 'runtime_unavailable', terminal?.error?.message ?? '터미널을 열지 못했습니다.')
      } else stages.agent = stage('unknown', 'no_path', 'worktree 경로를 받지 못했습니다.')
    } else {
      const mapped = mapAgentStages(response.result)
      stages = mapped.stages
      path = mapped.path
    }
    // 링크는 새로 만들었거나(completed) 미확정이지만 그 자리에 있을 때(unknown + 경로). 이미 붙은 합류는 다시 적지 않는다.
    // 미확정 자리는 이 시도가 만든 것인지 모른다 — 남의 링크 · 떼기 예외를 덮지 않는다(R3-C). 새로 만든 자리는 덮는다(이 작업을 하려고 만든 것).
    const linkable = path !== null && (stages.worktree.status === 'completed' || stages.worktree.status === 'unknown')
    const claim = stages.worktree.status === 'unknown'
    const linked = path === null || !linkable ? { linkSaved: stages.worktree.code === 'already_linked', sourceLink: null, claim: null } : await this.link({ input, path, claim })
    const { linkSaved, sourceLink } = linked
    const held = linked.claim === 'held'
    if (held) {
      // 다른 작업에 붙은(또는 떼기 예외인) 자리 — 이 작업에 붙이지 않고 성공으로도 그리지 않는다. 기록도 버린다(다시 봐도 같은 자리).
      stages = { ...stages, worktree: stage('unknown', 'held_by_other', '이 이름의 worktree 는 다른 작업에 붙어 있어(또는 떼어 둔 자리라) 이 작업에 붙이지 않았습니다.') }
      path = null
    } else if (linkable && !linkSaved) {
      // 링크 저장 실패(R2-B) — 성공으로 그리지 않고, 미확정 기록을 남겨 다음 `recover` 가 다시 붙인다.
      stages = { ...stages, worktree: stage(stages.worktree.status, 'link_failed', '이 작업에 링크를 저장하지 못했습니다 — 다음 상태 갱신 때 다시 붙입니다.') }
    }
    // 기록을 남기는 경우: 미확정인데 시도 전엔 없던 자리라 나중에 나타날 수 있음 · 링크 저장 실패. 그 밖엔 지운다.
    const keep = !held && ((stages.worktree.status === 'unknown' && path === null && !preexisting) || (linkable && !linkSaved))
    if (!keep) this.deps.pending?.remove(input.attemptId)
    const result: StartWorkResult = { attemptId: input.attemptId, joined: false, done: true, stages, worktreePath: path, linkSaved, sourceLink, refused: null }
    this.deps.log('work.start_done', { attemptId: input.attemptId, stages: Object.fromEntries(Object.entries(stages).map(([key, value]) => [key, value.status])), linkSaved, sourceLink: sourceLink?.state ?? null })
    return result
  }

  private linkedTo({ path, input }: { path: string; input: StartWorkInput }): boolean {
    const repo = this.deps.repos().find((row) => row.root === input.repoRoot)
    const link = repo?.worktrees.find((row) => row.path === path)?.workLink ?? null
    return link !== null && link.mode === 'explicit' && link.connectionId === input.connectionId && link.itemId === input.itemId
  }

  /**
   * 링크 · 「작업 시작」 활동 · 출처 링크. `claim` 이면 비어 있는 자리에만 쓴다(`claimExplicit` — R3-A·R3-C):
   * 남의 자리(`held`)와 다른 시도가 이미 붙인 자리(`linked`)는 활동 · 출처 저장 없이 끝낸다(같은 작업의 「작업 시작」 이 두 번 남지 않게).
   * 링크를 확정하면 같은 경로의 다른 미확정 기록도 지운다(R3-A). 로컬 링크를 저장하지 못한 회차엔 출처 저장을 부르지 않는다(R3-H).
   */
  private async link({ input, path, claim }: { input: LinkInput; path: string; claim: boolean }): Promise<{ linkSaved: boolean; sourceLink: StartWorkResult['sourceLink']; claim: ClaimResult | null }> {
    const stored: StoredWorkLink = { sourceId: input.sourceId, connectionId: input.connectionId, itemId: input.itemId, key: input.itemKey, linkedAt: this.now() }
    const links = this.deps.links()
    const result: ClaimResult = links === null ? 'failed' : claim ? links.claimExplicit({ path, link: stored }) : links.saveExplicit({ path, link: stored }) ? 'saved' : 'failed'
    if (result === 'held' || result === 'linked') {
      this.deps.log('work.start_link_claim', { attemptId: input.attemptId, path, claim: result })
      return { linkSaved: result === 'linked', sourceLink: null, claim: result }
    }
    const linkSaved = result === 'saved'
    const work = this.deps.work()
    work?.recordEvent({
      connectionId: input.connectionId, itemId: input.itemId, itemKey: input.itemKey, eventKey: `run:start:${input.attemptId}`,
      change: { field: 'run', event: 'start', worktree: path, branch: input.name, agent: input.agent, model: input.agent === 'shell' || input.model === '' ? null : input.model },
    })
    if (linkSaved) {
      // 링크와 활동을 적었으면 미확정 기록은 끝 — 출처 저장 결과와 무관(출처 실패는 결과에 보인다). 같은 경로의 앞 시도 기록도 끝이다(R3-A).
      const pending = this.deps.pending
      for (const row of pending?.list() ?? []) if (row.attemptId === input.attemptId || row.path === path) pending?.remove(row.attemptId)
    }
    const sourceLink = work === null || !linkSaved ? null : await work.storeLink({ connectionId: input.connectionId, itemId: input.itemId, link: { kind: 'worktree', path, repoRoot: input.repoRoot }, action: 'save' })
    return { linkSaved, sourceLink, claim: claim ? result : null }
  }
}

/** 링크·활동에 필요한 시도 정보 — 진행 중 시도(`StartWorkInput`)와 미확정 기록(`PendingStart`)이 같이 쓴다. */
type LinkInput = Pick<StartWorkInput, 'attemptId' | 'connectionId' | 'sourceId' | 'itemId' | 'itemKey' | 'repoRoot' | 'name' | 'agent' | 'model'>

function pendingOf({ input, path, now, preexisting }: { input: StartWorkInput; path: string; now: number; preexisting: boolean }): PendingStart {
  return { attemptId: input.attemptId, connectionId: input.connectionId, sourceId: input.sourceId, itemId: input.itemId, itemKey: input.itemKey, repoRoot: input.repoRoot, name: input.name, path, agent: input.agent, model: input.model, startedAt: now, preexisting }
}
