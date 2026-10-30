// PR 상태 출처 (LIFE-624) — `gh` CLI 로 worktree 브랜치(또는 PR URL)의 PR 을 읽고, 링크된 작업의 활동에 열림·머지·닫힘을 남긴다.
//
// - **출처 = gh**(00-analysis F1): 토큰 보관·입력 UI 없이 사용자 기계의 gh keyring 인증을 쓴다. GitHub API 직접 호출은 하지 않는다.
// - **gh 고르기**(F2·C1): PATH 의 절대 항목 → 잘 알려진 설치 위치(`/opt/homebrew/bin`·`/usr/local/bin`). Finder 기동 설치본의 PATH 는
//   `/usr/bin:/bin:/usr/sbin:/sbin` 이라 뒤의 두 곳이 없으면 늘 「gh 없음」 이다. 알려진 worktree 아래 폴더·파일은 건너뛴다(`resolveGit` 와 같은 심은 실행 파일 방어).
// - **실행**(C2): 셸 없이 `execFile`, 인자 배열(브랜치 이름은 인자 하나), timeout · 출력 상한. 실패는 던지지 않고 분류 값(`PrLookup`)으로.
// - **오류 분류**(F3·C3): PR 없음(`none`) · gh 없음 · 미인증(exit 4) · GitHub 원격 아님 · 레포 접근 불가 · 시간 초과/그 밖. 신호는 실측 원문 그대로.
// - **경계**(C5): 브랜치 조회는 지금 트리에 있는 worktree 경로만, URL 조회는 `https://github.com/<owner>/<repo>/pull/<n>` 꼴만. 그 밖은 gh 를 부르지 않고 `rejected`.
// - **비용**(F6·C11): 렌더러가 보일 때만 부른다(상시 타이머 없음). 여기서는 같은 키를 TTL 안에 다시 부르지 않고(진행 중이면 그 약속을 같이 기다린다),
//   동시 실행을 상한 아래로 줄 세운다.
// - **활동**(C8·C10): 링크된 worktree 의 PR 을 보면 그 작업에 열림(+ 머지/닫힘) 줄을 PR 의 시각으로 남긴다 — `eventKey` 로 한 번만.
//   worktree 가 사라진 뒤에도 머지를 잡도록, 열림만 있는 PR 은 상세가 열릴 때 URL 로 다시 본다(`refreshItem`).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../shared/json.js'
import { isPrUrl, type PrBranchesResult, type PrErrorKind, type PrInfo, type PrItemRefreshResult, type PrLookup, type PrState } from '../shared/pr-status.js'
import type { RepoRow, WorktreeRow } from '../shared/types.js'
import { readWorkActivityQuery, type WorkActivityChange, type WorkActivityResult } from '../shared/work.js'

/** 잘 알려진 gh 설치 위치 — PATH 다음에 본다(Homebrew arm64 · Intel/수동 설치). */
export const GH_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
export const GH_TIMEOUT_MS = 15_000
export const GH_MAX_BYTES = 1024 * 1024
export const PR_TTL_MS = 60_000
/** 오류 결과의 TTL — 성공보다 짧게(r1 c1-5). 로그인·설치를 고친 뒤 오래 기다리지 않게, 그래도 같은 화면 여닫기마다 gh 를 띄우지는 않게. */
export const PR_ERROR_TTL_MS = 10_000
export const PR_MAX_CONCURRENT = 3
/** 한 번에 받는 경로 수 · 한 작업에서 다시 보는 URL 수 상한. */
export const PR_MAX_PATHS = 64
export const PR_MAX_URLS = 10
export const PR_JSON_FIELDS = 'number,state,isDraft,url,headRefName,baseRefName,createdAt,mergedAt,closedAt,isCrossRepository'
/**
 * 한 브랜치 목록 상한 — 같은 이름의 포크 PR(아래 `readOutput`)이 섞여도 같은 레포 PR 이 잘리지 않을 만큼.
 * 그래도 포크 PR 이 이보다 많고 같은 레포 PR 이 그 뒤에 있으면 「PR 없음」 이 된다(gh 는 최근 것부터 준다).
 */
export const PR_LIST_LIMIT = 50

const realOr = (file: string): string => {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
const inside = (file: string, root: string): boolean => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

const defaultExecutable = (file: string): boolean => {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** gh 절대 경로 — PATH 의 절대 항목, 그다음 `GH_FALLBACK_DIRS`. `roots`(알려진 worktree) 아래는 건너뛴다. 없으면 null(= 「gh 없음」). */
export function resolveGh(input: { pathEnv: string | undefined; roots?: readonly string[]; isExecutable?: (file: string) => boolean }): string | null {
  const isExecutable = input.isExecutable ?? defaultExecutable
  const roots = (input.roots ?? []).flatMap((root) => [path.resolve(root), realOr(root)])
  const planted = (file: string): boolean => roots.some((root) => inside(path.resolve(file), root) || inside(realOr(file), root))
  const dirs = [...(input.pathEnv ?? '').split(path.delimiter), ...GH_FALLBACK_DIRS]
  for (const dir of dirs) {
    if (dir === '' || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, 'gh')
    if (roots.length > 0 && (planted(dir) || planted(candidate))) continue
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** gh 한 번의 결과 — 실행기는 이 모양만 돌려준다(시험은 가짜 실행기). */
export type GhOutcome =
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  | { kind: 'spawn_error'; code: string; message: string }
  | { kind: 'timeout' }
  | { kind: 'overflow' }

export type GhRun = (input: { gh: string; args: string[]; cwd: string }) => Promise<GhOutcome>

/** 실제 실행기 — 셸 없이, 인자 배열, timeout · 출력 상한. 프롬프트·업데이트 안내는 끈다. */
export const makeRunGh = ({ timeoutMs = GH_TIMEOUT_MS, maxBytes = GH_MAX_BYTES }: { timeoutMs?: number; maxBytes?: number } = {}): GhRun => ({ gh, args, cwd }) => new Promise((resolve) => {
  try {
    execFile(gh, args, {
      cwd,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: maxBytes,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_SPINNER_DISABLED: '1' },
    }, (error, stdout, stderr) => {
      if (error === null) { resolve({ kind: 'exit', code: 0, stdout, stderr }); return }
      const code = error.code
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ kind: 'overflow' })
      else if (error.killed === true || error.signal != null) resolve({ kind: 'timeout' })
      else if (typeof code === 'number') resolve({ kind: 'exit', code, stdout, stderr })
      else resolve({ kind: 'spawn_error', code: typeof code === 'string' ? code : 'unknown', message: error.message.slice(0, 200) })
    })
  } catch (error) {
    resolve({ kind: 'spawn_error', code: 'throw', message: String(error).slice(0, 200) })
  }
})

export const runGh: GhRun = makeRunGh()

const firstLine = (text: string): string => text.split('\n').map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 200) ?? ''

const fail = (error: PrErrorKind, message: string): PrLookup => ({ kind: 'error', error, message })

/** 실패 분류(F3) — 성공(exit 0)은 `readOutput` 이 받는다. */
export function classifyFailure(outcome: GhOutcome): PrLookup {
  switch (outcome.kind) {
    case 'spawn_error':
      return outcome.code === 'ENOENT' || outcome.code === 'EACCES' ? fail('no_gh', outcome.message) : fail('failed', outcome.message)
    case 'timeout':
      return fail('failed', '시간 초과')
    case 'overflow':
      return fail('failed', '출력이 너무 큽니다')
    case 'exit': {
      const line = firstLine(outcome.stderr)
      if (outcome.code === 4) return fail('unauthenticated', line)
      // 폐기·만료 토큰은 exit 1 + 「HTTP 401: Bad credentials」(리뷰 r2 c2-3 실측) — 토큰 없음(exit 4)과 같은 「로그인 필요」 로.
      if (/HTTP 401\b|Bad credentials/i.test(outcome.stderr)) return fail('unauthenticated', line)
      if (/no git remotes found|none of the git remotes configured for this repository point to a known GitHub host/i.test(outcome.stderr)) return fail('not_github', line)
      if (/Could not resolve to a Repository/i.test(outcome.stderr)) return fail('repo_unreadable', line)
      return fail('failed', line === '' ? `gh 종료 코드 ${outcome.code}` : line)
    }
  }
}

const nullableString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

/** gh JSON 한 건 → PrInfo. 모르는 상태·모양이면 null. MERGED 는 closedAt 이 있어도 머지됨이다(실측 a1). */
export function readPr(value: unknown): PrInfo | null {
  if (!isRecord(value)) return null
  const { number, url } = value
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0 || !isPrUrl(url)) return null
  let state: PrState
  switch (value.state) {
    case 'OPEN': state = value.isDraft === true ? 'draft' : 'open'; break
    case 'MERGED': state = 'merged'; break
    case 'CLOSED': state = 'closed'; break
    default: return null
  }
  return {
    number,
    state,
    url,
    headRefName: nullableString(value.headRefName),
    baseRefName: nullableString(value.baseRefName),
    createdAt: nullableString(value.createdAt),
    mergedAt: nullableString(value.mergedAt),
    closedAt: nullableString(value.closedAt),
  }
}

const timeOf = (value: string | null): number => (value === null ? 0 : Date.parse(value) || 0)

/** 한 브랜치의 PR 여럿 중 하나(F4) — 열린 것(초안 포함) 우선, 없으면 가장 최근 createdAt. */
export function pickPr(list: PrInfo[]): PrInfo | null {
  const live = list.filter((pr) => pr.state === 'open' || pr.state === 'draft')
  const pool = live.length > 0 ? live : list
  return pool.reduce<PrInfo | null>((best, pr) => (best === null || timeOf(pr.createdAt) > timeOf(best.createdAt) ? pr : best), null)
}

/**
 * 성공 출력 → 결과. 목록(`pr list`)은 배열, 단건(`pr view`)은 객체.
 * **포크 PR 은 버린다**(r1 e1): `gh pr list --head <브랜치>` 는 head 이름만 보므로 남의 포크에서 같은 이름(`main`·`trunk`·흔한 이름)으로 연 PR 도
 * 돌려준다(실측 `--repo cli/cli --head trunk` → 5건 전부 `isCrossRepository: true`). 그 PR 을 칩·활동에 붙이지 않게 같은 레포 PR 만 남긴다.
 * 한계: 내 포크 브랜치 → upstream 으로 PR 을 여는 흐름(worktree 의 기본 원격이 upstream 인 경우)은 그 PR 이 cross-repo 라 「PR 없음」 이 된다.
 * `isCrossRepository` 칸이 없는 옛 gh 출력은 같은 레포로 본다.
 */
export function readOutput({ stdout, many }: { stdout: string; many: boolean }): PrLookup {
  const parsed = safeParse(stdout)
  if (many) {
    if (!Array.isArray(parsed)) return fail('failed', 'gh 출력 모양이 다릅니다')
    const own = parsed.filter((row) => !(isRecord(row) && row.isCrossRepository === true))
    const read = own.flatMap((row) => { const one = readPr(row); return one === null ? [] : [one] })
    // 행이 있는데 하나도 못 읽었으면(다른 호스트 URL · 모르는 state) 「PR 없음」 이 아니라 「못 읽음」(리뷰 r2 c2-6 — C3).
    if (own.length > 0 && read.length === 0) return fail('failed', 'gh 출력의 PR 을 읽지 못했습니다')
    const pr = pickPr(read)
    return pr === null ? { kind: 'none' } : { kind: 'pr', pr }
  }
  const pr = readPr(parsed)
  return pr === null ? fail('failed', 'gh 출력 모양이 다릅니다') : { kind: 'pr', pr }
}

/** 활동 사건 하나 — 열림 · 머지 · 닫힘. 머지된 PR 을 처음 보면 열림·머지 두 줄(둘 다 PR 의 시각). */
export function prEvents(pr: PrInfo): { action: 'open' | 'merged' | 'closed'; at: number | null }[] {
  const at = (value: string | null): number | null => (value === null ? null : Date.parse(value) || null)
  const events: { action: 'open' | 'merged' | 'closed'; at: number | null }[] = [{ action: 'open', at: at(pr.createdAt) }]
  if (pr.state === 'merged') events.push({ action: 'merged', at: at(pr.mergedAt) })
  if (pr.state === 'closed') events.push({ action: 'closed', at: at(pr.closedAt) })
  return events
}

export const prEventKey = ({ connectionId, itemKey, url, action }: { connectionId: string; itemKey: string; url: string; action: string }): string => `run:pr:${connectionId}:${itemKey}:${url}:${action}`

export type PrWorkPort = {
  recordEvent(input: { connectionId: string; itemId: string | null; itemKey: string; eventKey: string; change: WorkActivityChange; at?: number }): boolean
  activity(input: unknown): WorkActivityResult
}

type Scope = { connectionId: string; itemId: string | null; itemKey: string; worktree: string }

export type PrStatusDeps = {
  repos: () => RepoRow[]
  work: () => PrWorkPort | null
  /** gh 고르기 — 기본은 `resolveGh`(PATH + 알려진 위치, 알려진 worktree 아래 건너뜀). */
  gh?: (roots: string[]) => string | null
  run?: GhRun
  now?: () => number
  ttlMs?: number
  errorTtlMs?: number
  /** cwd 가 있는 폴더인가 — 기본은 실제 stat(시험은 가짜 경로를 쓴다). */
  cwdExists?: (dir: string) => boolean
  maxConcurrent?: number
  log?: (tag: string, fields?: Record<string, unknown>) => void
}

const branchName = (branch: string | null): string | null => (branch === null ? null : branch.replace(/^refs\/heads\//, ''))

export class PrStatus {
  private readonly cache = new Map<string, { at: number; ttl: number; value: Promise<PrLookup> }>()
  private running = 0
  private readonly queue: (() => void)[] = []
  private lastGh: string | null | undefined = undefined
  /** 실제로 gh 를 띄운 횟수 — 시험·관측용(C11). */
  calls = 0

  constructor(private readonly deps: PrStatusDeps) {}

  /** 브랜치 조회(C5) — 알려진 worktree 경로만. 링크된 worktree 면 활동에 남긴다. */
  async branches(input: unknown): Promise<PrBranchesResult> {
    const paths = isRecord(input) && Array.isArray(input.paths) ? input.paths.filter((value): value is string => typeof value === 'string').slice(0, PR_MAX_PATHS) : []
    const repos = this.deps.repos()
    const rows = new Map<string, WorktreeRow>()
    for (const repo of repos) for (const row of repo.worktrees) rows.set(row.path, row)
    const lookups: Record<string, PrLookup> = {}
    let recorded = 0
    await Promise.all([...new Set(paths)].map(async (worktreePath) => {
      const row = rows.get(worktreePath)
      if (row === undefined) { lookups[worktreePath] = { kind: 'rejected', reason: '알려진 worktree 가 아닙니다' }; return }
      const branch = branchName(row.branch)
      if (branch === null) { lookups[worktreePath] = { kind: 'none' }; return }
      const result = await this.cached({
        key: `b:${worktreePath}\n${branch}`,
        args: ['pr', 'list', '--head', branch, '--state', 'all', '--json', PR_JSON_FIELDS, '--limit', String(PR_LIST_LIMIT)],
        cwd: worktreePath,
        many: true,
      })
      lookups[worktreePath] = result
      const link = row.workLink ?? null
      if (result.kind === 'pr' && link !== null && link.connected) {
        recorded += this.record({ pr: result.pr, scope: { connectionId: link.connectionId, itemId: link.itemId, itemKey: link.key, worktree: worktreePath } })
      }
    }))
    return { lookups, recorded }
  }

  /** URL 조회(C5) — GitHub PR URL 꼴만. 레포 밖 cwd 에서도 된다(실측 a4 I). */
  byUrl(url: unknown): Promise<PrLookup> {
    if (!isPrUrl(url)) return Promise.resolve({ kind: 'rejected', reason: 'GitHub PR URL 이 아닙니다' })
    return this.cached({ key: `u:${url}`, args: ['pr', 'view', url, '--json', PR_JSON_FIELDS], cwd: '/', many: false })
  }

  /** 작업 하나의 열린 PR 재조회(C10) — 활동에 열림이 있고 머지가 없는 PR 을 URL 로 다시 본다. 닫힘 기록도 다시 본다 — 다시 열려 머지될 수 있다(r1 c1-2). */
  async refreshItem(input: unknown): Promise<PrItemRefreshResult> {
    const query = readWorkActivityQuery(input)
    const work = this.deps.work()
    if (query === null) return { ok: false, reason: '요청 모양이 잘못됐습니다' }
    if (work === null) return { ok: false, reason: '작업 연결이 없습니다' }
    const listed = work.activity(query)
    if (!listed.ok) return { ok: false, reason: listed.error.message }
    const opened = new Map<string, Scope>()
    const settled = new Set<string>()
    for (const record of listed.records) {
      const change = record.change
      if (change.field !== 'run' || change.event !== 'pr') continue
      if (change.action === 'open') {
        if (!opened.has(change.url)) opened.set(change.url, { connectionId: record.connectionId, itemId: record.itemId === '' ? null : record.itemId, itemKey: record.itemKey ?? query.itemKey ?? '', worktree: change.worktree })
      } else if (change.action === 'merged') settled.add(change.url)
    }
    // 최근에 연 PR 부터 상한까지(리뷰 r2 c2-5) — 닫힌 채 쌓인 옛 PR 이 새 PR 의 재조회 자리를 먹지 않게. 기록은 오래된 것부터라 뒤집는다.
    const pending = [...opened.entries()].reverse().filter(([url, scope]) => !settled.has(url) && scope.itemKey !== '').slice(0, PR_MAX_URLS)
    let recorded = 0
    await Promise.all(pending.map(async ([url, scope]) => {
      const result = await this.byUrl(url)
      // 열림 줄은 이미 있다 — 머지·닫힘만 더한다.
      if (result.kind === 'pr') recorded += this.record({ pr: result.pr, scope, settledOnly: true })
    }))
    return { ok: true, checked: pending.length, recorded }
  }

  /** 활동에 남긴다 — 이미 있는 열쇠는 버려진다. 남긴 줄 수. */
  private record({ pr, scope, settledOnly = false }: { pr: PrInfo; scope: Scope; settledOnly?: boolean }): number {
    const work = this.deps.work()
    if (work === null) return 0
    let count = 0
    for (const event of prEvents(pr)) {
      if (settledOnly && event.action === 'open') continue
      const change: WorkActivityChange = { field: 'run', event: 'pr', action: event.action, worktree: scope.worktree, number: pr.number, url: pr.url, branch: pr.headRefName, base: pr.baseRefName, draft: pr.state === 'draft' }
      const eventKey = prEventKey({ connectionId: scope.connectionId, itemKey: scope.itemKey, url: pr.url, action: event.action })
      if (work.recordEvent({ connectionId: scope.connectionId, itemId: scope.itemId, itemKey: scope.itemKey, eventKey, change, ...(event.at === null ? {} : { at: event.at }) })) count += 1
    }
    return count
  }

  /** TTL 캐시 + 진행 중 합치기. */
  private cached({ key, args, cwd, many }: { key: string; args: string[]; cwd: string; many: boolean }): Promise<PrLookup> {
    const now = (this.deps.now ?? Date.now)()
    const hit = this.cache.get(key)
    if (hit !== undefined && now - hit.at < hit.ttl) return hit.value
    // 오래된 항목 정리 — 키가 무한히 늘지 않게.
    for (const [old, entry] of this.cache) if (now - entry.at >= entry.ttl) this.cache.delete(old)
    // 진행 중에는 성공 TTL 로 합치고, 끝나면 TTL 을 **완료 시각**부터 다시 센다(리뷰 r2 c2-4 — 오래 걸린 실행·줄 선 요청이 끝나자마자 만료되지 않게).
    // 오류로 끝나면 그 항목만 짧은 TTL(r1 c1-5).
    const entry = { at: now, ttl: this.deps.ttlMs ?? PR_TTL_MS, value: this.limited(() => this.execute({ args, cwd, many })) }
    this.cache.set(key, entry)
    void entry.value.then((result) => {
      entry.at = (this.deps.now ?? Date.now)()
      if (result.kind === 'error') entry.ttl = Math.min(entry.ttl, this.deps.errorTtlMs ?? PR_ERROR_TTL_MS)
    })
    return entry.value
  }

  private async execute({ args, cwd, many }: { args: string[]; cwd: string; many: boolean }): Promise<PrLookup> {
    const roots = this.deps.repos().flatMap((repo) => repo.worktrees.map((row) => row.path))
    const gh = (this.deps.gh ?? ((known: string[]) => resolveGh({ pathEnv: process.env.PATH, roots: known })))(roots)
    if (gh !== this.lastGh) {
      this.lastGh = gh
      this.deps.log?.('pr.gh', { gh })
    }
    if (gh === null) return fail('no_gh', 'gh 를 찾지 못했습니다')
    // 없는 cwd 는 execFile 이 ENOENT 로 끝내 「gh 없음」 과 같은 모양이 된다(r1 c1-1) — 띄우기 전에 가른다(트리에서 막 지워진 worktree 등).
    if (!(this.deps.cwdExists ?? isDirectory)(cwd)) return fail('failed', 'worktree 경로가 없습니다')
    this.calls += 1
    const outcome = await (this.deps.run ?? runGh)({ gh, args, cwd })
    const result = outcome.kind === 'exit' && outcome.code === 0 ? readOutput({ stdout: outcome.stdout, many }) : classifyFailure(outcome)
    this.deps.log?.('pr.lookup', { op: args[1], result: result.kind, ...(result.kind === 'error' ? { error: result.error } : {}) })
    return result
  }

  /** 동시 실행 상한 — 넘는 요청은 줄 선다. 던져도 분류 값으로 끝낸다. */
  private limited(task: () => Promise<PrLookup>): Promise<PrLookup> {
    const max = this.deps.maxConcurrent ?? PR_MAX_CONCURRENT
    return new Promise<PrLookup>((resolve) => {
      const start = (): void => {
        this.running += 1
        void task()
          .catch((error: unknown) => fail('failed', String(error).slice(0, 200)))
          .then(resolve)
          .finally(() => {
            this.running -= 1
            this.queue.shift()?.()
          })
      }
      if (this.running < max) start()
      else this.queue.push(start)
    })
  }
}
