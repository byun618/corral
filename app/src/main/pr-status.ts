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
// - **코멘트**(LIFE-811): worktree 경로 → 위 브랜치 조회 결과의 `pr.url` → `gh api graphql` 읽기 query 하나(`comments`). gh 고르기·실행기·분류·TTL·동시 상한은 같은 장치.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../shared/json.js'
import { PR_COMMENTS_QUERY, prUrlParts, readPrComments, type PrComments, type PrCommentsResult } from '../shared/pr-comments.js'
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
/**
 * 코멘트 query 출력 상한(LIFE-811) — 1 MiB 는 일반 코멘트 100건 PR(cli/cli #14963)이 206 KB 라 목록 셋이 다 차면 넘을 수 있다
 * (리뷰 100 + 일반 100 + 스레드 100 × 답글 50). 넘으면 「출력이 너무 큽니다」 오류 값.
 */
export const GH_COMMENTS_MAX_BYTES = 8 * 1024 * 1024

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
const runGhComments: GhRun = makeRunGh({ maxBytes: GH_COMMENTS_MAX_BYTES })

const firstLine = (text: string): string => text.split('\n').map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 200) ?? ''

type PrFailure = { kind: 'error'; error: PrErrorKind; message: string }
const fail = (error: PrErrorKind, message: string): PrFailure => ({ kind: 'error', error, message })

/** 실패 분류(F3) — 성공(exit 0)은 `readOutput` 이 받는다. */
export function classifyFailure(outcome: GhOutcome): PrFailure {
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

/**
 * 코멘트 query 의 gh 인자(C2) — `api graphql` + 호스트 + 변수 셋 + query 하나. owner·name 은 `-f`(문자열 그대로 — `-F` 는 `true`·숫자 이름을 형 변환한다),
 * 번호만 `-F`(정수). 호스트는 `github.com` 고정 — PR URL 이 `isPrUrl` 로 github.com 임을 확인한 값이라 `GH_HOST` 를 따르지 않는다(리뷰 r1 A8).
 * GitHub 쓰기 인자(`-X`·`--method`·mutation)는 없다.
 */
export function prCommentsArgs({ owner, name, number }: { owner: string; name: string; number: number }): string[] {
  return ['api', 'graphql', '--hostname', 'github.com', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${number}`, '-f', `query=${PR_COMMENTS_QUERY}`]
}

/** 코멘트 캐시 값 — 코멘트만(리뷰 r1 A3). 머리의 PR 상태는 매 호출의 최신 브랜치 조회에서 덧붙인다. */
export type CommentsOutcome = { kind: 'comments'; comments: PrComments } | { kind: 'none' } | PrFailure

/** 코멘트 query 의 gh 결과 → 캐시 값. PR 조회로 찾은 번호를 GraphQL 이 못 찾으면(지워진 PR — 실측 a5 exit 1) 「PR 없음」. */
export function readCommentsOutcome(outcome: GhOutcome): CommentsOutcome {
  if (outcome.kind === 'exit' && outcome.code === 0) {
    const comments = readPrComments(outcome.stdout)
    return comments === null ? fail('failed', 'gh 출력 모양이 다릅니다') : { kind: 'comments', comments }
  }
  if (outcome.kind === 'exit' && /Could not resolve to a PullRequest/i.test(outcome.stderr)) return { kind: 'none' }
  return classifyFailure(outcome)
}

type CacheEntry<T> = { at: number; ttl: number; value: Promise<T> }

export class PrStatus {
  private readonly cache = new Map<string, CacheEntry<PrLookup>>()
  private readonly commentsCache = new Map<string, CacheEntry<CommentsOutcome>>()
  private running = 0
  private readonly queue: (() => void)[] = []
  private lastGh: string | null | undefined = undefined
  /** 실제로 gh 를 띄운 횟수 — 시험·관측용(C11). */
  calls = 0

  constructor(private readonly deps: PrStatusDeps) {}

  /** 브랜치 조회(C5) — 알려진 worktree 경로만. 링크된 worktree 면 활동에 남긴다. */
  async branches(input: unknown): Promise<PrBranchesResult> {
    const paths = isRecord(input) && Array.isArray(input.paths) ? input.paths.filter((value): value is string => typeof value === 'string').slice(0, PR_MAX_PATHS) : []
    const rows = this.worktreeRows()
    const lookups: Record<string, PrLookup> = {}
    let recorded = 0
    await Promise.all([...new Set(paths)].map(async (worktreePath) => {
      const one = await this.lookupPath({ worktreePath, rows, force: false, record: true })
      lookups[worktreePath] = one.lookup
      recorded += one.recorded
    }))
    return { lookups, recorded }
  }

  /**
   * 코멘트 조회(LIFE-811 C1) — 입력은 지금 트리의 worktree 경로 하나. 경로 → 브랜치 → PR 은 `branches` 와 같은 길·캐시,
   * 코멘트 query 의 owner·repo·번호는 그 결과의 `pr.url`(`isPrUrl` 통과값)에서만 얻는다. `refresh` 면 두 조회 모두 TTL 을 무시한다(C8).
   * 활동은 남기지 않는다 — 기록과 그 수(`recorded` → 작업 상세 재읽기)는 base 대로 `branches()` 만(리뷰 r1 A2).
   */
  async comments(input: unknown): Promise<PrCommentsResult> {
    const worktreePath = isRecord(input) && typeof input.path === 'string' ? input.path : null
    if (worktreePath === null) return { kind: 'rejected', reason: '요청 모양이 잘못됐습니다' }
    const force = isRecord(input) && input.refresh === true
    const { lookup } = await this.lookupPath({ worktreePath, rows: this.worktreeRows(), force, record: false })
    if (lookup.kind !== 'pr') return lookup
    const pr = lookup.pr
    const parts = prUrlParts(pr.url)
    if (parts === null) return fail('failed', 'PR 주소를 읽지 못했습니다')
    const outcome = await this.cached({
      store: this.commentsCache,
      key: `c:${pr.url}`,
      force,
      task: async () => {
        const launched = await this.launch({ args: prCommentsArgs(parts), cwd: '/', run: this.deps.run ?? runGhComments })
        const result = launched.kind === 'error' ? launched : readCommentsOutcome(launched)
        this.deps.log?.('pr.comments', { result: result.kind, ...(result.kind === 'error' ? { error: result.error } : {}) })
        return result
      },
      onThrow: (message) => fail('failed', message),
    })
    return outcome.kind === 'comments' ? { kind: 'comments', pr, comments: outcome.comments } : outcome
  }

  private worktreeRows(): Map<string, WorktreeRow> {
    const rows = new Map<string, WorktreeRow>()
    for (const repo of this.deps.repos()) for (const row of repo.worktrees) rows.set(row.path, row)
    return rows
  }

  /** 경로 하나의 브랜치 조회 — `record` 이고 링크된 worktree 면 활동에 남긴다(같은 PR 은 `eventKey` 로 한 번만). */
  private async lookupPath({ worktreePath, rows, force, record }: { worktreePath: string; rows: Map<string, WorktreeRow>; force: boolean; record: boolean }): Promise<{ lookup: PrLookup; recorded: number }> {
    const row = rows.get(worktreePath)
    if (row === undefined) return { lookup: { kind: 'rejected', reason: '알려진 worktree 가 아닙니다' }, recorded: 0 }
    const branch = branchName(row.branch)
    if (branch === null) return { lookup: { kind: 'none' }, recorded: 0 }
    const lookup = await this.cachedLookup({
      key: `b:${worktreePath}\n${branch}`,
      args: ['pr', 'list', '--head', branch, '--state', 'all', '--json', PR_JSON_FIELDS, '--limit', String(PR_LIST_LIMIT)],
      cwd: worktreePath,
      many: true,
      force,
    })
    const link = row.workLink ?? null
    if (record && lookup.kind === 'pr' && link !== null && link.connected) {
      return { lookup, recorded: this.record({ pr: lookup.pr, scope: { connectionId: link.connectionId, itemId: link.itemId, itemKey: link.key, worktree: worktreePath } }) }
    }
    return { lookup, recorded: 0 }
  }

  /** URL 조회(C5) — GitHub PR URL 꼴만. 레포 밖 cwd 에서도 된다(실측 a4 I). */
  byUrl(url: unknown): Promise<PrLookup> {
    if (!isPrUrl(url)) return Promise.resolve({ kind: 'rejected', reason: 'GitHub PR URL 이 아닙니다' })
    return this.cachedLookup({ key: `u:${url}`, args: ['pr', 'view', url, '--json', PR_JSON_FIELDS], cwd: '/', many: false, force: false })
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

  private cachedLookup({ key, args, cwd, many, force }: { key: string; args: string[]; cwd: string; many: boolean; force: boolean }): Promise<PrLookup> {
    return this.cached({ store: this.cache, key, force, task: () => this.execute({ args, cwd, many }), onThrow: (message) => fail('failed', message) })
  }

  /** TTL 캐시 + 진행 중 합치기. `force`(새로고침 — LIFE-811 C8)는 TTL 을 무시하고 새로 띄운다. */
  private cached<T extends { kind: string }>({ store, key, force, task, onThrow }: { store: Map<string, CacheEntry<T>>; key: string; force: boolean; task: () => Promise<T>; onThrow: (message: string) => T }): Promise<T> {
    const now = (this.deps.now ?? Date.now)()
    const hit = store.get(key)
    if (!force && hit !== undefined && now - hit.at < hit.ttl) return hit.value
    // 오래된 항목 정리 — 키가 무한히 늘지 않게.
    for (const [old, entry] of store) if (now - entry.at >= entry.ttl) store.delete(old)
    // 진행 중에는 성공 TTL 로 합치고, 끝나면 TTL 을 **완료 시각**부터 다시 센다(리뷰 r2 c2-4 — 오래 걸린 실행·줄 선 요청이 끝나자마자 만료되지 않게).
    // 오류로 끝나면 그 항목만 짧은 TTL(r1 c1-5).
    const entry: CacheEntry<T> = { at: now, ttl: this.deps.ttlMs ?? PR_TTL_MS, value: this.limited({ task, onThrow }) }
    store.set(key, entry)
    void entry.value.then((result) => {
      entry.at = (this.deps.now ?? Date.now)()
      if (result.kind === 'error') entry.ttl = Math.min(entry.ttl, this.deps.errorTtlMs ?? PR_ERROR_TTL_MS)
    })
    return entry.value
  }

  /** gh 를 골라 띄운다 — 못 띄울 사정(gh 없음·cwd 없음)은 분류 값. */
  private async launch({ args, cwd, run }: { args: string[]; cwd: string; run: GhRun }): Promise<GhOutcome | PrFailure> {
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
    return run({ gh, args, cwd })
  }

  private async execute({ args, cwd, many }: { args: string[]; cwd: string; many: boolean }): Promise<PrLookup> {
    const outcome = await this.launch({ args, cwd, run: this.deps.run ?? runGh })
    const result = outcome.kind === 'error' ? outcome : outcome.kind === 'exit' && outcome.code === 0 ? readOutput({ stdout: outcome.stdout, many }) : classifyFailure(outcome)
    this.deps.log?.('pr.lookup', { op: args[1], result: result.kind, ...(result.kind === 'error' ? { error: result.error } : {}) })
    return result
  }

  /** 동시 실행 상한 — 넘는 요청은 줄 선다. 던져도 분류 값으로 끝낸다. 목록·코멘트 조회가 같은 상한을 나눠 쓴다. */
  private limited<T>({ task, onThrow }: { task: () => Promise<T>; onThrow: (message: string) => T }): Promise<T> {
    const max = this.deps.maxConcurrent ?? PR_MAX_CONCURRENT
    return new Promise<T>((resolve) => {
      const start = (): void => {
        this.running += 1
        void task()
          .catch((error: unknown) => onThrow(String(error).slice(0, 200)))
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
