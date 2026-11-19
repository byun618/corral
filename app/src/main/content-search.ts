// 내용 전체 검색 (LIFE-803 ⌘⇧F) — **읽기 전용**. 렌더러가 준 루트를 `confine` 으로 「지금 열린 worktree 루트」 와 대조한 뒤에만 git 을 부른다.
//
// · 백엔드 = `git grep --untracked -I`(02-kickoff D1 — 추적 + 미추적, `.gitignore` 대상·바이너리 제외). 셸 없이 인자 배열로, 질의는 `-e <질의>` 한 칸, 끝에 `--`.
//   git 실행 파일·안전 설정(`core.fsmonitor=false`·`core.quotePath=false`·`GIT_OPTIONAL_LOCKS=0`)·프로세스 그룹 종료는 `file-list.ts` 와 같은 규칙이다.
// · 한 번 찾을 때 git 을 **둘** 띄운다 — ① 일치 줄(`-n --column -z` — 줄 글과 첫 일치의 바이트 열) ② 일치마다 한 행(`-o` — 일치 글).
//   기본 출력은 줄당 첫 일치만 주므로(00-analysis S3) 줄 안 강조 범위는 ② 로 정한다 — 정규식(PCRE)을 JS 로 다시 돌리지 않는다(C3ⓔ).
//   ② 의 열은 두 번째 일치부터 실제 시작이 아니다(`raw/claude/r1/git-o-column-probe.txt` — git 은 첫 열에 앞 일치의 「탐색 창 기준 끝」 을 계속 더한다).
//   그래서 k 번째 일치의 끝 = (k+1 번째 열 − 첫 열) 로 되찾고(`matchByteRanges`), 마지막 일치만은 앞 일치 끝 뒤에서 일치 글을 찾는다 — 리터럴이면 첫 등장이 곧 그 자리,
//   단어 단위·정규식이면 등장이 하나일 때만(아니면 그 일치는 강조하지 않는다 — 잘못된 자리 강조보다 안 하는 쪽). ② 가 상한으로 잘려 모르는 줄도 강조하지 않는다.
// · git 열은 1부터의 **바이트** 오프셋이다(S2) — UTF-16(Monaco 열)으로 바꾼다. 긴 줄은 첫 일치 둘레 `SEARCH_PREVIEW_MAX_BYTES` 만 미리보기로 싣는다.
// · 상한: 일치 줄 수·`-o` 일치 수·출력 바이트·시간. 줄 수·바이트 상한에 닿으면 git 을 끝내고 잘린 결과(`truncated`), 시간 상한이면 오류(`timeout`).
// · 새 검색은 진행 중인 앞 검색을 모두 취소한다(창 하나 — 검색 보기 하나). 앱 종료 때 `killAll`.
import { spawn, type ChildProcess } from 'node:child_process'
import { confine } from './explorer-fs.js'
import { toDiskNames } from './file-list.js'
import { isSafeRel } from '../shared/file-list.js'
import { CONTENT_SEARCH_QUERY_MAX, CONTENT_SEARCH_REQUEST_ID, type ContentSearchFailure, type ContentSearchFile, type ContentSearchLine, type ContentSearchOptions, type ContentSearchResult } from '../shared/content-search.js'

/** 일치 줄 상한 — 넘으면 git 을 끝내고 잘린 결과. */
export const SEARCH_MAX_LINES = 10_000
/** `-o` 일치 행 상한 — 넘으면 그 뒤 줄은 강조 범위를 모른다(결과는 잘리지 않는다). */
export const SEARCH_MAX_MATCHES = 50_000
/** git 한 프로세스의 출력 바이트 상한 — ① 이 넘으면 잘린 결과. */
export const SEARCH_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
/** 시간 상한 — 넘으면 git 을 끝내고 오류. */
export const SEARCH_TIMEOUT_MS = 15_000
/** 한 줄 미리보기 바이트 상한 — 넘는 줄은 첫 일치 앞 `SEARCH_PREVIEW_LEAD_BYTES` 부터 이만큼. */
export const SEARCH_PREVIEW_MAX_BYTES = 400
export const SEARCH_PREVIEW_LEAD_BYTES = 40

const KILL_GRACE_MS = 500
const STOP_CLOSE_MS = 1_500
const TOMBSTONE_MS = 30_000
const TOMBSTONE_MAX = 64
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false']

/** git grep 인자(`-C <루트>` 뒤). `onlyMatching` = ② 일치마다 한 행. */
export function grepArgs(input: ContentSearchOptions & { query: string; onlyMatching: boolean }): string[] {
  return [
    // 저장소가 아닌 루트에서 `--no-index` 로 내려가지 않게 — 오류로 낸다(C1ⓙ).
    '-c',
    'grep.fallbackToNoIndex=false',
    'grep',
    '--untracked',
    '--no-recurse-submodules',
    '-I',
    '--no-color',
    '--no-textconv',
    '-n',
    '--column',
    '-z',
    ...(input.onlyMatching ? ['-o'] : []),
    ...(input.caseSensitive ? [] : ['-i']),
    ...(input.wholeWord ? ['-w'] : []),
    input.regex ? '-P' : '-F',
    '-e',
    input.query,
    '--',
  ]
}

export type GrepRecord = { path: Buffer; line: number; column: number; text: Buffer }

/**
 * `-z -n --column` 출력 해석기 — `경로\0줄\0열\0글\n` 를 조각으로 받아 온전한 행만 낸다. 경로는 NUL 까지라 줄바꿈이 든 경로도 그대로다.
 * 형이 어긋난 행(숫자 아님)은 버린다.
 */
export class GrepRecordParser {
  private pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer, onRecord: (record: GrepRecord) => boolean): boolean {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    let offset = 0
    for (;;) {
      const a = this.pending.indexOf(0, offset)
      if (a === -1) break
      const b = this.pending.indexOf(0, a + 1)
      if (b === -1) break
      const c = this.pending.indexOf(0, b + 1)
      if (c === -1) break
      const end = this.pending.indexOf(10, c + 1)
      if (end === -1) break
      const line = Number(this.pending.subarray(a + 1, b).toString('latin1'))
      const column = Number(this.pending.subarray(b + 1, c).toString('latin1'))
      const record = { path: this.pending.subarray(offset, a), line, column, text: this.pending.subarray(c + 1, end) }
      offset = end + 1
      if (Number.isInteger(line) && line > 0 && Number.isInteger(column) && column > 0 && !onRecord(record)) {
        this.pending = Buffer.alloc(0)
        return false
      }
    }
    this.pending = Buffer.from(this.pending.subarray(offset))
    return true
  }
}

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80
/** UTF-8 바이트 열 → UTF-16 길이(앞 `bytes` 바이트). */
const utf16Length = (bytes: Buffer, end: number): number => bytes.subarray(0, Math.max(0, Math.min(end, bytes.length))).toString('utf8').length

/** 일치 줄 하나의 미리보기 — 첫 일치(바이트 열 `column`) 둘레를 상한 안에서 글자 경계로 자른다. */
export function previewOf(input: { text: Buffer; column: number; maxBytes: number; leadBytes: number }): { bytes: Buffer; start: number; end: number; column: number } {
  let text = input.text
  // CRLF 파일의 줄 끝 `\r` 은 미리보기에서 뺀다.
  if (text.length > 0 && text[text.length - 1] === 13) text = text.subarray(0, text.length - 1)
  const firstByte = Math.min(input.column - 1, text.length)
  let start = 0
  let end = text.length
  if (text.length > input.maxBytes) {
    start = Math.max(0, firstByte - input.leadBytes)
    while (start > 0 && start < text.length && isContinuation(text[start])) start += 1
    end = Math.min(text.length, start + input.maxBytes)
    while (end < text.length && end > start && isContinuation(text[end])) end -= 1
  }
  return { bytes: Buffer.from(text.subarray(start, end)), start, end, column: utf16Length(text, firstByte) + 1 }
}

type LineEntry = { rel: Buffer; line: number; column: number; text: Buffer; preview: Buffer; start: number; end: number; fullLength: number }
export type MatchRow = { column: number; text: Buffer }

/**
 * ② 의 행들(한 줄, git 출력 순서) → 그 줄의 일치 바이트 범위(0부터, 끝 제외). 위치를 확정할 수 없는 일치는 null.
 * git 은 k+1 번째 행의 열 = k 번째 열 + (k 번째 일치의 탐색 창 기준 끝)이라 k 번째 끝 = 열[k+1] − 열[1] 이다. 첫 일치 시작 = 열[1] − 1.
 * 마지막 일치는 다음 열이 없다 — 앞 일치 끝부터 일치 글을 찾되 `exact`(리터럴 — 처음 등장이 곧 가장 왼쪽 일치)가 아니면 등장이 하나일 때만.
 * 찾은 자리의 바이트가 일치 글과 다르면 null(가정이 깨진 경우 강조하지 않는다).
 */
export function matchByteRanges(input: { text: Buffer; rows: readonly MatchRow[]; exact: boolean }): ({ start: number; end: number } | null)[] {
  const rows = input.rows
  const first = rows[0]?.column ?? 1
  const verified = (start: number, row: MatchRow): { start: number; end: number } | null => {
    const end = start + row.text.length
    return start >= 0 && end <= input.text.length && input.text.subarray(start, end).equals(row.text) ? { start, end } : null
  }
  return rows.map((row, index) => {
    if (index === 0) return verified(first - 1, row)
    const next = rows[index + 1]
    if (next !== undefined) return verified(next.column - first - row.text.length, row)
    const from = row.column - first
    const at = input.text.indexOf(row.text, from)
    if (at === -1) return null
    if (!input.exact && input.text.indexOf(row.text, at + 1) !== -1) return null
    return verified(at, row)
  })
}

/** ① 의 줄과 ② 의 일치(바이트 범위 — 모르는 것은 null)를 합쳐 결과 행으로. ② 에 그 줄이 없으면 범위 없음(강조하지 않음). */
export function toResultLine(entry: Omit<LineEntry, 'rel' | 'text'>, matches: readonly ({ start: number; end: number } | null)[] | undefined): ContentSearchLine {
  const ranges: { start: number; end: number }[] = []
  for (const match of matches ?? []) {
    if (match === null || match.end <= entry.start || match.start >= entry.end) continue
    const start = utf16Length(entry.preview, Math.max(match.start, entry.start) - entry.start)
    const end = utf16Length(entry.preview, Math.min(match.end, entry.end) - entry.start)
    if (end > start) ranges.push({ start, end })
  }
  return {
    line: entry.line,
    column: entry.column,
    preview: entry.preview.toString('utf8'),
    ranges,
    matches: Math.max(1, matches?.length ?? 1),
    clippedStart: entry.start > 0,
    clippedEnd: entry.end < entry.fullLength,
  }
}

type StopReason = 'cancelled' | 'timeout' | 'enough' | 'too_large'
type StreamOutcome = { kind: 'exited'; code: number | null; stderr: string } | { kind: 'stopped'; why: StopReason } | { kind: 'spawn_failed'; error: string }

/** git 한 번 — 셸 없이 자기 프로세스 그룹으로. 출력은 조각마다 `onData` 로 넘기고, 거짓이면 「충분」으로 멈춘다. 멈춤 = 그룹 SIGTERM → `KILL_GRACE_MS` 뒤 SIGKILL. */
function runStream(input: {
  git: string
  cwd: string
  args: readonly string[]
  signal: AbortSignal
  timeoutMs: number
  maxBytes: number
  children: Set<ChildProcess>
  onData: (chunk: Buffer) => boolean
}): Promise<StreamOutcome> {
  return new Promise((resolve) => {
    if (input.signal.aborted) {
      resolve({ kind: 'stopped', why: 'cancelled' })
      return
    }
    let child: ChildProcess
    try {
      child = spawn(input.git, [...GIT_SAFE_CONFIG, '-C', input.cwd, ...input.args], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      })
    } catch (error) {
      resolve({ kind: 'spawn_failed', error: String(error).slice(0, 300) })
      return
    }
    input.children.add(child)
    let bytes = 0
    let stderr = ''
    let stopped: StopReason | null = null
    let spawnError: string | null = null
    let killTimer: NodeJS.Timeout | null = null
    let closeTimer: NodeJS.Timeout | null = null
    let finished = false
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        // 그룹이 이미 없다.
      }
    }
    const finish = (code: number | null): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      if (closeTimer !== null) clearTimeout(closeTimer)
      input.signal.removeEventListener('abort', onAbort)
      input.children.delete(child)
      if (stopped !== null) resolve({ kind: 'stopped', why: stopped })
      else if (input.signal.aborted) resolve({ kind: 'stopped', why: 'cancelled' })
      else if (spawnError !== null) resolve({ kind: 'spawn_failed', error: spawnError })
      else resolve({ kind: 'exited', code, stderr: stderr.trim() })
    }
    const stop = (why: StopReason): void => {
      if (stopped !== null) return
      stopped = why
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      closeTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null)
      }, STOP_CLOSE_MS)
    }
    const onAbort = (): void => stop('cancelled')
    input.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop('timeout'), input.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stopped !== null) return
      bytes += chunk.length
      if (bytes > input.maxBytes) stop('too_large')
      else if (!input.onData(chunk)) stop('enough')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 300) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      spawnError = String(error).slice(0, 300)
    })
    child.on('exit', () => killGroup('SIGKILL'))
    child.on('close', (code) => finish(code))
  })
}

/** 진행 중 git 그룹에 지금 바로 SIGKILL(앱 종료). */
function killNow(children: ReadonlySet<ChildProcess>): void {
  for (const child of children) {
    if (child.pid === undefined) continue
    for (const target of [-child.pid, child.pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch {
        // 이미 없다.
      }
    }
  }
}

/** git 종료 결과 → 실패면 실패 응답. 0 = 일치 있음, 1 = 일치 없음(S5). 상한 멈춤(`enough`·`too_large`)은 실패가 아니다. */
function failureOf(outcome: StreamOutcome, timeoutMs: number): ContentSearchFailure | null {
  switch (outcome.kind) {
    case 'spawn_failed':
      return { ok: false, code: 'git_failed', error: outcome.error }
    case 'stopped':
      if (outcome.why === 'cancelled') return { ok: false, code: 'cancelled', error: '취소됨' }
      if (outcome.why === 'timeout') return { ok: false, code: 'timeout', error: `검색 시간 초과 ${timeoutMs} ms` }
      return null
    case 'exited':
      if (outcome.code === 0 || outcome.code === 1) return null
      return { ok: false, code: 'git_failed', error: (outcome.stderr === '' ? `git 종료 ${outcome.code ?? '신호'}` : outcome.stderr).slice(0, 300) }
  }
}

export type ContentSearchDeps = {
  roots: () => readonly string[]
  git: (roots: readonly string[]) => string
  log: (event: string, data?: Record<string, unknown>) => void
  now?: () => number
  /** 시험용 — 기본은 위 상수. */
  limits?: Partial<{ maxLines: number; maxMatches: number; maxBytes: number; timeoutMs: number; previewMaxBytes: number; previewLeadBytes: number }>
}

const CANCELLED: ContentSearchFailure = { ok: false, code: 'cancelled', error: '취소됨' }

export class ContentSearcher {
  private readonly running = new Map<string, AbortController>()
  private readonly tombstones = new Map<string, number>()
  private readonly children = new Set<ChildProcess>()

  constructor(private readonly deps: ContentSearchDeps) {}

  get active(): number {
    return this.running.size
  }

  /** 아직 끝나지 않은 git 자식의 PID(G0 취소 확인 — 기록한 PID 로 사라짐을 본다). */
  get livePids(): number[] {
    return [...this.children].flatMap((child) => (child.pid === undefined ? [] : [child.pid]))
  }

  cancel(requestId: unknown): boolean {
    if (typeof requestId !== 'string') return false
    const controller = this.running.get(requestId)
    if (controller === undefined) {
      if (CONTENT_SEARCH_REQUEST_ID.test(requestId)) this.remember(requestId)
      return false
    }
    controller.abort()
    this.running.delete(requestId)
    return true
  }

  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }

  /** 앱 종료 — 모두 취소하고 남은 git 그룹에 지금 바로 SIGKILL. */
  killAll(): void {
    this.cancelAll()
    killNow(this.children)
  }

  private remember(requestId: string): void {
    const now = Date.now()
    for (const [id, at] of this.tombstones) if (now - at > TOMBSTONE_MS || this.tombstones.size >= TOMBSTONE_MAX) this.tombstones.delete(id)
    this.tombstones.set(requestId, now)
  }

  async search(input: unknown): Promise<ContentSearchResult> {
    const field = (name: string): unknown => (typeof input === 'object' && input !== null && name in input ? Reflect.get(input, name) : undefined)
    const root = field('root')
    const query = field('query')
    const requestId = field('requestId')
    const caseSensitive = field('caseSensitive')
    const wholeWord = field('wholeWord')
    const regex = field('regex')
    if (
      typeof requestId !== 'string' ||
      !CONTENT_SEARCH_REQUEST_ID.test(requestId) ||
      typeof query !== 'string' ||
      query === '' ||
      query.length > CONTENT_SEARCH_QUERY_MAX ||
      /[\0\r\n]/.test(query) ||
      typeof caseSensitive !== 'boolean' ||
      typeof wholeWord !== 'boolean' ||
      typeof regex !== 'boolean'
    )
      return { ok: false, code: 'invalid_argument', error: '요청 형 위반' }
    if (this.tombstones.delete(requestId)) return CANCELLED
    // 새 검색이 앞 검색을 취소한다(C2ⓓ). 취소기는 첫 await 전에 건다.
    this.cancelAll()
    const controller = new AbortController()
    this.running.set(requestId, controller)
    const limits = {
      maxLines: this.deps.limits?.maxLines ?? SEARCH_MAX_LINES,
      maxMatches: this.deps.limits?.maxMatches ?? SEARCH_MAX_MATCHES,
      maxBytes: this.deps.limits?.maxBytes ?? SEARCH_MAX_OUTPUT_BYTES,
      timeoutMs: this.deps.limits?.timeoutMs ?? SEARCH_TIMEOUT_MS,
      previewMaxBytes: this.deps.limits?.previewMaxBytes ?? SEARCH_PREVIEW_MAX_BYTES,
      previewLeadBytes: this.deps.limits?.previewLeadBytes ?? SEARCH_PREVIEW_LEAD_BYTES,
    }
    const now = this.deps.now ?? (() => performance.now())
    const startedAt = now()
    const ms = (): number => Math.round((now() - startedAt) * 10) / 10
    try {
      const roots = this.deps.roots()
      const confined = await confine({ roots, root, rel: '' })
      if (controller.signal.aborted) return CANCELLED
      if (!confined.ok) return { ok: false, code: confined.code, error: confined.error }
      const options = { caseSensitive, wholeWord, regex }
      const git = this.deps.git(roots)
      // 하나가 실패하면 다른 하나도 끝낸다(사용자 취소와 가른다).
      const stopBoth = new AbortController()
      controller.signal.addEventListener('abort', () => stopBoth.abort(), { once: true })

      const lines: LineEntry[] = []
      let truncated = false
      const lineParser = new GrepRecordParser()
      const onLine = (record: GrepRecord): boolean => {
        if (lines.length >= limits.maxLines) {
          truncated = true
          return false
        }
        const preview = previewOf({ text: record.text, column: record.column, maxBytes: limits.previewMaxBytes, leadBytes: limits.previewLeadBytes })
        const fullLength = record.text.length > 0 && record.text[record.text.length - 1] === 13 ? record.text.length - 1 : record.text.length
        lines.push({ rel: Buffer.from(record.path), line: record.line, column: preview.column, text: Buffer.from(record.text), preview: preview.bytes, start: preview.start, end: preview.end, fullLength })
        return true
      }
      const matches = new Map<string, MatchRow[]>()
      let matchRows = 0
      let matchesComplete = true
      const matchParser = new GrepRecordParser()
      const onMatch = (record: GrepRecord): boolean => {
        if (matchRows >= limits.maxMatches) {
          matchesComplete = false
          return false
        }
        matchRows += 1
        const key = `${record.path.toString('latin1')}\0${record.line}`
        const list = matches.get(key)
        const match = { column: record.column, text: Buffer.from(record.text) }
        if (list === undefined) matches.set(key, [match])
        else list.push(match)
        return true
      }
      const run = (run: { onlyMatching: boolean; parser: GrepRecordParser; onRecord: (record: GrepRecord) => boolean }): Promise<StreamOutcome> =>
        runStream({
          git,
          cwd: confined.realRoot,
          args: grepArgs({ query, ...options, onlyMatching: run.onlyMatching }),
          signal: stopBoth.signal,
          timeoutMs: limits.timeoutMs,
          maxBytes: limits.maxBytes,
          children: this.children,
          onData: (chunk) => run.parser.push(chunk, run.onRecord),
        }).then((outcome) => {
          const failure = failureOf(outcome, limits.timeoutMs)
          if (failure !== null && failure.code !== 'cancelled') stopBoth.abort()
          return outcome
        })
      const [lineOutcome, matchOutcome] = await Promise.all([run({ onlyMatching: false, parser: lineParser, onRecord: onLine }), run({ onlyMatching: true, parser: matchParser, onRecord: onMatch })])
      if (controller.signal.aborted) return CANCELLED
      const lineFailure = failureOf(lineOutcome, limits.timeoutMs)
      const matchFailure = failureOf(matchOutcome, limits.timeoutMs)
      // 실제 실패(취소가 아닌 것)를 먼저 — 한쪽 실패가 다른 쪽을 「취소」 로 끝냈을 수 있다.
      const failure = [lineFailure, matchFailure].find((item) => item !== null && item.code !== 'cancelled') ?? lineFailure ?? matchFailure
      if (failure !== null && failure !== undefined) {
        this.deps.log('content.search', { ok: false, code: failure.code, ms: ms() })
        return failure
      }
      if (lineOutcome.kind === 'stopped' && lineOutcome.why === 'too_large') truncated = true
      if (matchOutcome.kind === 'stopped') matchesComplete = false

      // 파일별로 묶는다(git 출력 순서 = 경로 순).
      const byFile = new Map<string, ContentSearchLine[]>()
      let matchCount = 0
      let lineCount = 0
      for (const entry of lines) {
        const rel = entry.rel.toString('utf8')
        if (!isSafeRel(rel)) continue
        const rows = matches.get(`${entry.rel.toString('latin1')}\0${entry.line}`)
        const result = toResultLine(entry, rows === undefined ? undefined : matchByteRanges({ text: entry.text, rows, exact: !regex && !wholeWord }))
        const found = rows
        // ② 가 잘려 이 줄을 못 봤으면 강조하지 않는다(일치 수는 1로 센다).
        if (found === undefined && !matchesComplete) result.ranges = []
        matchCount += result.matches
        lineCount += 1
        const list = byFile.get(rel)
        if (list === undefined) byFile.set(rel, [result])
        else list.push(result)
      }
      const rels = [...byFile.keys()]
      const diskRels = [...rels]
      await toDiskNames({ realRoot: confined.realRoot, files: diskRels, signal: controller.signal })
      if (controller.signal.aborted) return CANCELLED
      const files: ContentSearchFile[] = rels.map((rel, index) => ({ rel: diskRels[index] ?? rel, lines: byFile.get(rel) ?? [] }))
      this.deps.log('content.search', { ok: true, files: files.length, lines: lineCount, matches: matchCount, truncated, ms: ms() })
      return { ok: true, root: typeof root === 'string' ? root : '', files, lineCount, matchCount, truncated, ms: ms() }
    } finally {
      if (this.running.get(requestId) === controller) this.running.delete(requestId)
    }
  }
}
