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
/** 한 줄 미리보기 바이트 상한(미리보기 시작부터). */
export const SEARCH_PREVIEW_MAX_BYTES = 400
/** 첫 일치 앞에 남기는 문맥(UTF-16 글자) — 넘으면 앞을 자른다(좁은 패널에서도 첫 일치가 보이게 — r1 R1-08). */
export const SEARCH_PREVIEW_LEAD_CHARS = 24
/** git 자식 로캘 — 앱 환경에 UTF-8 로캘이 없을 때(Finder 로 띄운 설치본은 `LANG`·`LC_*` 가 없다) 넣는다. C 로캘이면 `-i`·`-P` 가 바이트 단위가 된다(r1 R1-05). */
export const GIT_UTF8_LOCALE = 'en_US.UTF-8'

const KILL_GRACE_MS = 500
const STOP_CLOSE_MS = 1_500
const TOMBSTONE_MS = 30_000
const TOMBSTONE_MAX = 64
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false']

/**
 * git 자식 환경 — 부모 환경 + `GIT_OPTIONAL_LOCKS=0`. 실제로 쓰일 로캘(`LC_ALL` → `LC_CTYPE` → `LANG` 중 처음 비지 않은 것)이 UTF-8 이 아니면
 * `LC_ALL=GIT_UTF8_LOCALE` 를 넣는다. 사용자가 이미 UTF-8 로캘을 줬으면 그대로 둔다.
 */
export function gitEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const effective = [parent.LC_ALL, parent.LC_CTYPE, parent.LANG].find((value) => value !== undefined && value !== '') ?? ''
  const utf8 = /utf-?8/i.test(effective)
  return { ...parent, GIT_OPTIONAL_LOCKS: '0', ...(utf8 ? {} : { LC_ALL: GIT_UTF8_LOCALE }) }
}

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

/**
 * 일치 줄 하나의 미리보기 — 첫 일치(바이트 열 `column`) 앞 문맥은 `leadChars`(UTF-16) 글자까지만 남기고(넘으면 앞이 잘린 줄 — 렌더러가 「…」),
 * 거기서부터 `maxBytes` 바이트까지 글자 경계로 자른다. 좁은 패널에서도 첫 일치가 미리보기 앞쪽에 온다(r1 R1-08).
 */
export function previewOf(input: { text: Buffer; column: number; maxBytes: number; leadChars: number }): { bytes: Buffer; start: number; end: number; column: number } {
  let text = input.text
  // CRLF 파일의 줄 끝 `\r` 은 미리보기에서 뺀다.
  if (text.length > 0 && text[text.length - 1] === 13) text = text.subarray(0, text.length - 1)
  const firstByte = Math.min(input.column - 1, text.length)
  const prefix = text.subarray(0, firstByte).toString('utf8')
  let start = 0
  if (prefix.length > input.leadChars) {
    let cut = prefix.length - input.leadChars
    // 서로게이트 쌍 가운데를 자르지 않는다.
    const code = prefix.charCodeAt(cut)
    if (code >= 0xdc00 && code <= 0xdfff) cut += 1
    start = Buffer.byteLength(prefix.slice(0, cut))
  }
  let end = Math.min(text.length, start + input.maxBytes)
  while (end < text.length && end > start && isContinuation(text[end])) end -= 1
  return { bytes: Buffer.from(text.subarray(start, end)), start, end, column: prefix.length + 1 }
}

type LineEntry = { rel: Buffer; line: number; column: number; byteColumn: number; text: Buffer; preview: Buffer; start: number; end: number; fullLength: number }
export type MatchRow = { column: number; text: Buffer }
type ByteRange = { start: number; end: number }

/**
 * **리터럴(단어 단위 아님)** — ② 의 행들(한 줄, git 출력 순서) → 일치 바이트 범위(0부터, 끝 제외). 확정할 수 없는 일치는 null.
 * git 은 k+1 번째 행의 열 = k 번째 열 + (k 번째 일치의 탐색 창 기준 끝)이라 k 번째 끝 = 열[k+1] − 열[1] 이다. 첫 일치 시작 = 열[1] − 1.
 * 마지막 일치는 다음 열이 없다 — 앞 일치 끝부터 일치 글의 처음 등장(리터럴이라 그것이 곧 가장 왼쪽 일치). 찾은 자리 바이트가 일치 글과 다르면 null.
 * 리터럴은 앞 문맥을 보지 않으므로 git 의 탐색 창이 가짜 일치를 만들지 않는다(r1 리뷰 퍼징 — 잘못된 강조 0).
 */
export function matchByteRanges(input: { text: Buffer; rows: readonly MatchRow[] }): (ByteRange | null)[] {
  const rows = input.rows
  const first = rows[0]?.column ?? 1
  const verified = (start: number, row: MatchRow): ByteRange | null => {
    const end = start + row.text.length
    return start >= 0 && end <= input.text.length && input.text.subarray(start, end).equals(row.text) ? { start, end } : null
  }
  return rows.map((row, index) => {
    if (index === 0) return verified(first - 1, row)
    const next = rows[index + 1]
    if (next !== undefined) return verified(next.column - first - row.text.length, row)
    const at = input.text.indexOf(row.text, row.column - first)
    return at === -1 ? null : verified(at, row)
  })
}

/** git `-w` 의 단어 글자 — ASCII 영숫자와 `_`(바이트 단위, 비 ASCII 바이트는 단어 글자가 아니다). */
const isWordByte = (byte: number | undefined): boolean =>
  byte !== undefined && ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f)

/**
 * **리터럴 + 단어 단위**(r1 R1-02) — 줄을 JS 로 처음부터 훑어 `candidates`(일치 글의 바이트 모양들) 중 가장 앞 등장을 찾고, 앞·뒤 바이트가 단어 글자가 아니면 일치.
 * 정규식을 새로 쓰지 않는다. `-w` 의 `-o` 둘째 이후 행은 탐색 창 시작에서 앞 글자를 못 봐 가짜일 수 있어 위치 원천으로 쓰지 않는다(R1-01).
 */
export function wordRanges(input: { text: Buffer; candidates: readonly Buffer[] }): ByteRange[] {
  const candidates = input.candidates.filter((candidate) => candidate.length > 0)
  const ranges: ByteRange[] = []
  let from = 0
  for (;;) {
    let at = -1
    let length = 0
    for (const candidate of candidates) {
      const found = input.text.indexOf(candidate, from)
      if (found !== -1 && (at === -1 || found < at || (found === at && candidate.length > length))) {
        at = found
        length = candidate.length
      }
    }
    if (at === -1) return ranges
    const end = at + length
    if (!isWordByte(input.text[at - 1]) && !isWordByte(input.text[end])) {
      ranges.push({ start: at, end })
      from = end
    } else from = at + 1
  }
}

export type MatchMode = 'literal' | 'literalWord' | 'regex'
export const matchModeOf = (options: ContentSearchOptions): MatchMode => (options.regex ? 'regex' : options.wholeWord ? 'literalWord' : 'literal')

/**
 * 한 줄의 강조 범위·일치 수. `rows` = ② 의 그 줄 행(없으면 undefined), `rowsComplete` = ② 가 상한·실패 없이 끝났는가.
 * · 리터럴: ② 의 열로 모두 확정(`matchByteRanges`), 수 = 행 수.
 * · 리터럴 + 단어: JS 로 훑는다(`wordRanges`) — 대소문자 구분이면 질의 그대로, 무시면 ② 가 준 일치 글 모양들.
 * · 정규식(단어 단위 포함): 첫 일치만 확정(② 첫 행 = 줄 처음부터 찾은 일치라 가짜가 아니다), 둘째 이후는 모름. 수는 행이 하나일 때만 정확(가짜 행은 늘리기만 한다).
 */
export function lineMatches(input: { text: Buffer; firstColumn: number; rows: readonly MatchRow[] | undefined; rowsComplete: boolean; mode: MatchMode; query: string; caseSensitive: boolean }): {
  ranges: ByteRange[]
  matches: number
  exact: boolean
} {
  const rows = input.rows
  switch (input.mode) {
    case 'literal': {
      if (rows === undefined) return { ranges: [], matches: 1, exact: false }
      return { ranges: matchByteRanges({ text: input.text, rows }).flatMap((range) => (range === null ? [] : [range])), matches: rows.length, exact: input.rowsComplete }
    }
    case 'literalWord': {
      const candidates = input.caseSensitive ? [Buffer.from(input.query)] : (rows ?? []).map((row) => row.text)
      const ranges = wordRanges({ text: input.text, candidates })
      if (ranges.length === 0) return { ranges, matches: 1, exact: false }
      return { ranges, matches: ranges.length, exact: input.caseSensitive || input.rowsComplete }
    }
    case 'regex': {
      const head = rows?.[0]
      const start = input.firstColumn - 1
      const ranges = head !== undefined && head.column === input.firstColumn && input.text.subarray(start, start + head.text.length).equals(head.text) && head.text.length > 0 ? [{ start, end: start + head.text.length }] : []
      return { ranges, matches: 1, exact: rows !== undefined && rows.length === 1 && input.rowsComplete }
    }
  }
}

/** ① 의 줄과 그 줄의 일치(바이트 범위)를 합쳐 결과 행으로 — 범위는 미리보기 기준 UTF-16 으로 옮긴다(미리보기 밖은 버린다). */
export function toResultLine(entry: Omit<LineEntry, 'rel' | 'text' | 'byteColumn'>, found: { ranges: readonly ByteRange[]; matches: number; exact: boolean }): ContentSearchLine {
  const ranges: { start: number; end: number }[] = []
  for (const match of found.ranges) {
    if (match.end <= entry.start || match.start >= entry.end) continue
    const start = utf16Length(entry.preview, Math.max(match.start, entry.start) - entry.start)
    const end = utf16Length(entry.preview, Math.min(match.end, entry.end) - entry.start)
    if (end > start) ranges.push({ start, end })
  }
  return {
    line: entry.line,
    column: entry.column,
    preview: entry.preview.toString('utf8'),
    ranges,
    matches: Math.max(1, found.matches),
    matchesExact: found.exact,
    clippedStart: entry.start > 0,
    clippedEnd: entry.end < entry.fullLength,
  }
}

type StopReason = 'cancelled' | 'timeout' | 'enough' | 'too_large'
type StreamOutcome = { kind: 'exited'; code: number | null; stderr: string } | { kind: 'stopped'; why: StopReason } | { kind: 'spawn_failed'; error: string }

/** git 한 번 — 셸 없이 자기 프로세스 그룹으로. 출력은 조각마다 `onData` 로 넘기고, 거짓이면 「충분」으로 멈춘다. 멈춤 = 그룹 SIGTERM → `KILL_GRACE_MS` 뒤 SIGKILL. */
function runStream(input: {
  git: string
  env: NodeJS.ProcessEnv
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
        env: input.env,
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
  /** git 자식에 줄 부모 환경 — 기본 `process.env`(시험이 로캘 없는 환경을 준다). */
  env?: () => NodeJS.ProcessEnv
  /** 시험용 — 기본은 위 상수. */
  limits?: Partial<{ maxLines: number; maxMatches: number; maxBytes: number; timeoutMs: number; previewMaxBytes: number; previewLeadChars: number }>
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
      previewLeadChars: this.deps.limits?.previewLeadChars ?? SEARCH_PREVIEW_LEAD_CHARS,
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
      const env = gitEnv(this.deps.env?.() ?? process.env)
      // ① 이 실패하면 ② 도 끝낸다(결과가 없으니 강조도 쓸 데 없다). ② 의 실패·시간 초과·상한은 강조만 포기하고 ① 을 기다린다(r1 R1-06).
      const stopMatches = new AbortController()
      controller.signal.addEventListener('abort', () => stopMatches.abort(), { once: true })

      const lines: LineEntry[] = []
      let truncated = false
      const lineParser = new GrepRecordParser()
      const onLine = (record: GrepRecord): boolean => {
        if (lines.length >= limits.maxLines) {
          truncated = true
          return false
        }
        const preview = previewOf({ text: record.text, column: record.column, maxBytes: limits.previewMaxBytes, leadChars: limits.previewLeadChars })
        const fullLength = record.text.length > 0 && record.text[record.text.length - 1] === 13 ? record.text.length - 1 : record.text.length
        lines.push({ rel: Buffer.from(record.path), line: record.line, column: preview.column, byteColumn: record.column, text: Buffer.from(record.text), preview: preview.bytes, start: preview.start, end: preview.end, fullLength })
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
      const run = (run: { onlyMatching: boolean; signal: AbortSignal; parser: GrepRecordParser; onRecord: (record: GrepRecord) => boolean }): Promise<StreamOutcome> =>
        runStream({
          git,
          env,
          cwd: confined.realRoot,
          args: grepArgs({ query, ...options, onlyMatching: run.onlyMatching }),
          signal: run.signal,
          timeoutMs: limits.timeoutMs,
          maxBytes: limits.maxBytes,
          children: this.children,
          onData: (chunk) => run.parser.push(chunk, run.onRecord),
        })
      const lineRun = run({ onlyMatching: false, signal: controller.signal, parser: lineParser, onRecord: onLine }).then((outcome) => {
        if (failureOf(outcome, limits.timeoutMs) !== null) stopMatches.abort()
        return outcome
      })
      const [lineOutcome, matchOutcome] = await Promise.all([lineRun, run({ onlyMatching: true, signal: stopMatches.signal, parser: matchParser, onRecord: onMatch })])
      if (controller.signal.aborted) return CANCELLED
      const failure = failureOf(lineOutcome, limits.timeoutMs)
      if (failure !== null) {
        this.deps.log('content.search', { ok: false, code: failure.code, ms: ms() })
        return failure
      }
      if (lineOutcome.kind === 'stopped' && lineOutcome.why === 'too_large') truncated = true
      // ② 가 끝까지 못 갔으면(상한·실패·시간 초과) 그 뒤 줄의 강조·일치 수는 모른다.
      if (matchOutcome.kind !== 'exited' || (matchOutcome.code !== 0 && matchOutcome.code !== 1)) matchesComplete = false

      // 파일별로 묶는다(git 출력 순서 = 경로 순).
      const byFile = new Map<string, ContentSearchLine[]>()
      let matchCount = 0
      let matchCountExact = true
      let lineCount = 0
      const mode = matchModeOf(options)
      for (const entry of lines) {
        const rel = entry.rel.toString('utf8')
        if (!isSafeRel(rel)) continue
        const rows = matches.get(`${entry.rel.toString('latin1')}\0${entry.line}`)
        const result = toResultLine(entry, lineMatches({ text: entry.text, firstColumn: entry.byteColumn, rows, rowsComplete: matchesComplete, mode, query, caseSensitive }))
        if (!result.matchesExact) matchCountExact = false
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
      this.deps.log('content.search', { ok: true, files: files.length, lines: lineCount, matches: matchCount, matchCountExact, truncated, ms: ms() })
      return { ok: true, root: typeof root === 'string' ? root : '', files, lineCount, matchCount, matchCountExact, truncated, ms: ms() }
    } finally {
      if (this.running.get(requestId) === controller) this.running.delete(requestId)
    }
  }
}
