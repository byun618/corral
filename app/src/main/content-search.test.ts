// LIFE-803 C1·C2·C3 — 내용 전체 검색(단위, 실제 git fixture). 열은 UTF-16 코드 단위 **1부터**(Monaco 열) — `hello 한글 Foo` 의 `Foo` 는 열 10(0부터 9).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContentSearcher, gitEnv, GrepRecordParser, grepArgs, isWideCodePoint, lineMatches, previewOf, scanRanges, SEARCH_PREVIEW_LEAD_CELLS, uniqueCandidates, withoutBom } from './content-search.js'
import { resolveGit } from './file-list.js'
import type { ContentSearchResult } from '../shared/content-search.js'

let base = ''
let root = ''
let plain = ''
const gitBin = resolveGit({ pathEnv: process.env.PATH })
const git = (args: string[], cwd = root): string => execFileSync(gitBin, args, { cwd, encoding: 'utf8' })
type Deps = ConstructorParameters<typeof ContentSearcher>[0]
const searcher = (limits?: Deps['limits'], extra?: Partial<Pick<Deps, 'env' | 'git'>>): ContentSearcher =>
  new ContentSearcher({ roots: () => [root, plain, path.join(base, 'gone')], git: extra?.git ?? (() => gitBin), env: extra?.env, log: () => undefined, limits })
/** `LANG`·`LC_*` 를 뺀 부모 환경 — Finder 로 띄운 설치본 main 과 같은 조건(코디 확인 `raw/coordinator/installed-app-env-keys.txt`). */
const noLocale = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'LANG' && !key.startsWith('LC_')))
/** 가짜 git — `-o` 가 있는 호출(②)과 없는 호출(①)에 다른 셸 동작. */
const fakeGit = (name: string, input: { lines: string; matches: string }): string => {
  const file = path.join(base, `${name}.sh`)
  fs.writeFileSync(file, `#!/bin/bash\nonly=\nfor a in "$@"; do [ "$a" = "-o" ] && only=1; done\nif [ -n "$only" ]; then\n${input.matches}\nelse\n${input.lines}\nfi\n`, { mode: 0o755 })
  return file
}
const OFF = { caseSensitive: false, wholeWord: false, regex: false }
/** 조건이 참이 될 때까지 10 ms 간격(상한 `ms` — 넘으면 그대로 돌아오고 뒤 단언이 실패한다). */
const until = async (ready: () => boolean, ms = 5_000): Promise<void> => {
  for (const started = Date.now(); !ready() && Date.now() - started < ms; ) await new Promise((resolve) => setTimeout(resolve, 10))
}
/** PID 가 살아 있는가(`kill -0`). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
let sequence = 0
const find = (input: { query: string; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; at?: string; limits?: Parameters<typeof searcher>[0]; env?: Deps['env'] }): Promise<ContentSearchResult> =>
  searcher(input.limits, { env: input.env }).search({ root: input.at ?? root, query: input.query, caseSensitive: input.caseSensitive ?? true, wholeWord: input.wholeWord ?? false, regex: input.regex ?? false, requestId: `t-${(sequence += 1)}` })
const hits = (result: ContentSearchResult): string[] => (result.ok ? result.files.flatMap((file) => file.lines.map((line) => `${file.rel}:${line.line}:${line.column}`)) : [])
const lineOf = (result: ContentSearchResult, rel: string, line: number) => (result.ok ? result.files.find((file) => file.rel === rel)?.lines.find((item) => item.line === line) : undefined)
const marked = (preview: string, ranges: readonly { start: number; end: number }[]): string[] => ranges.map((range) => preview.slice(range.start, range.end))

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l803-s-')))
  root = path.join(base, 'wt')
  plain = path.join(base, 'plain')
  fs.mkdirSync(plain)
  fs.writeFileSync(path.join(plain, 'a.txt'), 'foo\n')
  const write = (rel: string, text: string | Buffer): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  fs.mkdirSync(root)
  git(['init', '-q'])
  write('.gitignore', '*.log\n')
  write('a.txt', 'hello 한글 Foo foo\nfoobar Foo\n')
  write('lit.txt', 'a.b(c)*d\naxbxcd\n')
  write('words.txt', 'foo foobar\nfoo bar foo\nfoobar foo foobar\n')
  write('sp ace/한글 이름.txt', 'foo in space\n')
  write('crlf.txt', 'foo crlf\r\n')
  // r1 R1-01 — 앞 문맥에 기대는 정규식(리뷰 재현 claude-r1-repro-c3.txt). R1-02 — 단어 단위 둘째 일치. R1-05 — 로캘. R1-08 — 긴 앞 문맥.
  write('ctx.txt', 'foofoo bar\nbb\nab\nb.\n')
  write('word2.txt', 'foo foo foobar\n')
  write('loc.txt', 'CAFÉ café\nx 한글 y\n')
  write('lead.txt', `${'a'.repeat(60)} needle tail\n`)
  write('hangul-lead.txt', `${'가'.repeat(30)}needle\n`)
  write('bom.txt', '\uFEFFFoo start\nsecond Foo\n')
  // r3 R3-01 — UTF-8 아닌 긴 줄(Latin-1 é 40 바이트). R3-02 — -o 상한이 줄 가운데(zed), 400 바이트 경계에 걸친 다바이트 줄.
  write('latin1.txt', Buffer.concat([Buffer.alloc(40, 0xe9), Buffer.from(' needle\n')]))
  write('zed.txt', 'Zed zed ZED\n')
  write('wide.txt', `needle${'가'.repeat(200)}\n`)
  write('dash.txt', '--help is text\n')
  write('long.txt', `${'x'.repeat(1024 * 1024)}needle${'y'.repeat(100)}\n`)
  write('bin.dat', Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x01, 0x02]))
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  write('untracked.txt', 'untracked foo\n')
  write('ignored.log', 'ignored foo\n')
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('C1 git grep 백엔드', () => {
  it('인자 — -e 로 질의 한 칸, 끝에 --, 리터럴은 -F, 정규식은 -P', () => {
    const literal = grepArgs({ query: '--help', ...OFF, onlyMatching: false })
    expect(literal.slice(-3)).toEqual(['-e', '--help', '--'])
    expect(literal).toContain('-F')
    expect(literal).toContain('--untracked')
    expect(literal).toContain('-I')
    expect(literal).toContain('-i')
    expect(grepArgs({ query: 'x', caseSensitive: true, wholeWord: true, regex: true, onlyMatching: true })).toEqual(expect.arrayContaining(['-P', '-w', '-o']))
    expect(grepArgs({ query: 'x', caseSensitive: true, wholeWord: false, regex: true, onlyMatching: false })).not.toContain('-i')
  })

  it('ⓐ 리터럴 — . ( * 이 글자 그대로', async () => {
    expect(hits(await find({ query: 'b(c)*' }))).toEqual(['lit.txt:1:3'])
    expect(hits(await find({ query: 'a.b' }))).toEqual(['lit.txt:1:1'])
  })

  it('ⓑ 대소문자 구분 켬/끔이 결과를 가른다', async () => {
    const on = hits(await find({ query: 'Foo', caseSensitive: true }))
    const off = hits(await find({ query: 'Foo', caseSensitive: false }))
    expect(on).toEqual(['a.txt:1:10', 'a.txt:2:8', 'bom.txt:1:1', 'bom.txt:2:8'])
    expect(off).toContain('words.txt:1:1')
    expect(off).toContain('a.txt:2:1')
  })

  it('ⓒ 단어 단위 — foobar 의 foo 는 빠진다', async () => {
    const result = await find({ query: 'foo', wholeWord: true })
    expect(lineOf(result, 'a.txt', 2)).toBeUndefined()
    expect(lineOf(result, 'words.txt', 1)?.column).toBe(1)
    expect(lineOf(result, 'words.txt', 1)?.matches).toBe(1)
  })

  it('ⓓ 정규식 = PCRE — fo+(?=bar) 는 foobar 만', async () => {
    expect(hits(await find({ query: 'fo+(?=bar)', regex: true }))).toEqual(['a.txt:2:1', 'word2.txt:1:9', 'words.txt:1:5', 'words.txt:3:1'])
  })

  it('ⓔ 잘못된 정규식 → 오류(git 메시지)', async () => {
    const result = await find({ query: 'fo(', regex: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('git_failed')
    expect(result.error).toContain('missing closing parenthesis')
  })

  it('ⓕ 추적 + 미추적은 찾고 ignore·바이너리는 뺀다', async () => {
    const result = await find({ query: 'foo' })
    const files = result.ok ? result.files.map((file) => file.rel) : []
    expect(files).toContain('untracked.txt')
    expect(files).toContain('a.txt')
    expect(files).not.toContain('ignored.log')
    expect(files).not.toContain('bin.dat')
  })

  it('ⓖ 공백·한글 경로가 그대로', async () => {
    const result = await find({ query: 'in space' })
    expect(result.ok && result.files.map((file) => file.rel.normalize('NFC'))).toEqual(['sp ace/한글 이름.txt'])
  })

  it('ⓗ 한글 뒤 일치의 열은 UTF-16(1부터) — hello 한글 Foo → 10', async () => {
    const line = lineOf(await find({ query: 'Foo' }), 'a.txt', 1)
    expect(line?.column).toBe(10)
    expect(line && marked(line.preview, line.ranges)).toEqual(['Foo'])
  })

  it('ⓘ - 로 시작하는 질의는 옵션이 아니다', async () => {
    expect(hits(await find({ query: '--help' }))).toEqual(['dash.txt:1:1'])
  })

  it('ⓙ 저장소 아님·사라진 루트·등록 안 된 루트 → 오류', async () => {
    const notRepo = await find({ query: 'foo', at: plain })
    expect(notRepo.ok).toBe(false)
    if (!notRepo.ok) expect(notRepo.code).toBe('git_failed')
    const gone = await find({ query: 'foo', at: path.join(base, 'gone') })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.code).toBe('not_found')
    const stranger = await find({ query: 'foo', at: base })
    expect(stranger.ok).toBe(false)
    if (!stranger.ok) expect(stranger.code).toBe('not_worktree')
  })

  it('ⓚ 결과 경로는 전부 루트 상대(.. ·절대 경로 0)', async () => {
    const result = await find({ query: 'o', caseSensitive: false })
    expect(result.ok).toBe(true)
    for (const file of result.ok ? result.files : []) {
      expect(file.rel.startsWith('/')).toBe(false)
      expect(file.rel.split('/')).not.toContain('..')
    }
  })

  it('형 위반 — 빈 질의·줄바꿈·요청 id', async () => {
    expect((await find({ query: '' })).ok).toBe(false)
    expect((await find({ query: 'a\nb' })).ok).toBe(false)
    const bad = await searcher().search({ root, query: 'foo', ...OFF, requestId: 'a b' })
    expect(bad.ok === false && bad.code).toBe('invalid_argument')
  })

  it('CRLF 줄 끝 \\r 은 미리보기에서 빠진다', async () => {
    expect(lineOf(await find({ query: 'crlf' }), 'crlf.txt', 1)?.preview).toBe('foo crlf')
  })
})

describe('C2 상한·취소', () => {
  it('ⓐ 일치 줄 상한에 닿으면 잘림', async () => {
    const result = await find({ query: 'o', caseSensitive: false, limits: { maxLines: 3 } })
    expect(result.ok && result.lineCount).toBe(3)
    expect(result.ok && result.truncated).toBe(true)
  })

  it('ⓑ 1MB 한 줄 — 미리보기는 상한 안이고 첫 일치가 보인다', async () => {
    const line = lineOf(await find({ query: 'needle' }), 'long.txt', 1)
    expect(line).toBeDefined()
    if (line === undefined) return
    expect(Buffer.byteLength(line.preview)).toBeLessThanOrEqual(400)
    expect(line.clippedStart).toBe(true)
    expect(line.clippedEnd).toBe(false)
    expect(line.column).toBe(1048577)
    expect(marked(line.preview, line.ranges)).toEqual(['needle'])
  })

  it('ⓒ 시간 상한 → timeout 오류', async () => {
    const result = await find({ query: 'o', limits: { timeoutMs: 1 } })
    expect(result.ok === false && result.code).toBe('timeout')
  })

  it('ⓓ 새 검색이 앞 검색을 취소한다', async () => {
    const shared = searcher()
    const first = shared.search({ root, query: 'x', ...OFF, requestId: 'first' })
    const second = shared.search({ root, query: 'needle', ...OFF, requestId: 'second' })
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.ok === false && firstResult.code).toBe('cancelled')
    expect(secondResult.ok).toBe(true)
    expect(shared.livePids).toEqual([])
  })

  it('ⓓ 취소 IPC — 도착 전 취소도 기억한다', async () => {
    const shared = searcher()
    expect(shared.cancel('early')).toBe(false)
    const result = await shared.search({ root, query: 'foo', ...OFF, requestId: 'early' })
    expect(result.ok === false && result.code).toBe('cancelled')
  })

  it('ⓔ killAll — 진행 중 자식 0', async () => {
    const shared = searcher()
    const pending = shared.search({ root, query: 'x', ...OFF, requestId: 'kill' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    shared.killAll()
    expect((await pending).ok).toBe(false)
    expect(shared.livePids).toEqual([])
  })

  it('ⓕ 출력 바이트 상한 → 잘림', async () => {
    const result = await find({ query: 'x', limits: { maxBytes: 1024 } })
    expect(result.ok && result.truncated).toBe(true)
  })
})

describe('C3 줄 안 일치 강조', () => {
  it('ⓐ 리터럴 foo bar foo → 2개', async () => {
    const line = lineOf(await find({ query: 'foo' }), 'words.txt', 2)
    expect(line && line.ranges).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ])
  })

  it('ⓑ 대소문자 무시 Foo foo → 2개', async () => {
    const line = lineOf(await find({ query: 'FOO', caseSensitive: false }), 'a.txt', 1)
    expect(line && marked(line.preview, line.ranges)).toEqual(['Foo', 'foo'])
  })

  it('ⓒ 단어 단위 foo foobar → 1개', async () => {
    const line = lineOf(await find({ query: 'foo', wholeWord: true }), 'words.txt', 1)
    expect(line?.ranges).toEqual([{ start: 0, end: 3 }])
  })

  it('ⓓ 한글 뒤 범위 위치', async () => {
    const line = lineOf(await find({ query: 'Foo' }), 'a.txt', 1)
    expect(line?.ranges[0]).toEqual({ start: 9, end: 12 })
  })

  it('ⓔ 정규식 범위 = git(PCRE) 위치 — 미리보기 앞 맞춤(lookahead 는 범위 밖)', async () => {
    const line = lineOf(await find({ query: 'fo+(?=bar)', regex: true }), 'words.txt', 1)
    expect(line?.ranges).toEqual([{ start: 4, end: 7 }])
  })

  it('ⓕ 잘린 미리보기 기준 범위', () => {
    const text = Buffer.from(`${'가'.repeat(30)}abc${'z'.repeat(30)}`)
    const preview = previewOf({ text, column: 91, maxBytes: 20, leadCells: 4 })
    expect(preview.bytes.toString('utf8').startsWith('가가abc')).toBe(true)
    expect(preview.column).toBe(31)
  })
})

describe('r1 R1-01 — 정규식·단어 단위는 git -o 의 둘째 이후 행을 위치로 쓰지 않는다(가짜 일치 강조 0)', () => {
  const at = async (query: string, line: number, options: { wholeWord?: boolean } = {}) => lineOf(await find({ query, regex: true, ...options }), 'ctx.txt', line)
  it('\\bfoo on foofoo bar → foo@0 만', async () => {
    const line = await at('\\bfoo', 1)
    expect(line?.ranges).toEqual([{ start: 0, end: 3 }])
    expect(line?.matchesExact).toBe(false)
  })
  it('\\bb on bb → b@0 만', async () => {
    expect((await at('\\bb', 2))?.ranges).toEqual([{ start: 0, end: 1 }])
  })
  it('(?<!a)b|a on ab → a@0 만', async () => {
    expect((await at('(?<!a)b|a', 3))?.ranges).toEqual([{ start: 0, end: 1 }])
  })
  it('-w \\.|b on b. → b@0 만', async () => {
    expect((await at('\\.|b', 4, { wholeWord: true }))?.ranges).toEqual([{ start: 0, end: 1 }])
  })
  it('정규식 줄에 git -o 행이 하나뿐이면 일치 수가 정확하다', async () => {
    const line = lineOf(await find({ query: 'fo+(?=bar)', regex: true }), 'words.txt', 1)
    expect(line?.matches).toBe(1)
    expect(line?.matchesExact).toBe(true)
  })
  it('lineMatches(regex) — -o 행이 몇 개든 첫 행만, 첫 행 열이 ① 과 다르면 강조 0', () => {
    const rows = [{ column: 1, text: Buffer.from('foo') }, { column: 4, text: Buffer.from('foo') }]
    expect(lineMatches({ text: Buffer.from('foofoo bar'), firstColumn: 1, rows, rowsComplete: true, mode: 'regex', query: '\\bfoo', caseSensitive: true })).toEqual({ ranges: [{ start: 0, end: 3 }], matches: 1, exact: false })
    expect(lineMatches({ text: Buffer.from('foofoo bar'), firstColumn: 2, rows, rowsComplete: true, mode: 'regex', query: 'x', caseSensitive: true }).ranges).toEqual([])
  })
})

describe('r1 R1-02 — 리터럴 + 단어 단위는 JS 로 훑어 둘째 이후도 확정', () => {
  it('foo foo foobar → foo@0·foo@4 (대소문자 구분)', async () => {
    const line = lineOf(await find({ query: 'foo', wholeWord: true }), 'word2.txt', 1)
    expect(line?.ranges).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }])
    expect(line?.matches).toBe(2)
    expect(line?.matchesExact).toBe(true)
  })
  it('대소문자 무시도 같다(일치 글 모양은 git 이 준 것)', async () => {
    const line = lineOf(await find({ query: 'FOO', wholeWord: true, caseSensitive: false }), 'word2.txt', 1)
    expect(line?.ranges).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }])
  })
  it('scanRanges — 단어 글자(영숫자·_) 경계, 비 ASCII 는 경계', () => {
    expect(scanRanges({ text: Buffer.from('foo_x foo1 xfoo foo 한foo'), candidates: [Buffer.from('foo')], wordBoundary: true })).toEqual([
      { start: 16, end: 19 },
      { start: 23, end: 26 },
    ])
  })
})

describe('r1 R1-05 — git 자식 로캘(LANG·LC_* 없는 env)', () => {
  it('gitEnv — UTF-8 로캘이 없으면 LC_ALL 을 넣고, 있으면 그대로', () => {
    expect(gitEnv({ PATH: '/bin' })).toMatchObject({ LC_ALL: 'en_US.UTF-8', GIT_OPTIONAL_LOCKS: '0' })
    expect(gitEnv({ LC_ALL: 'C', LANG: 'ko_KR.UTF-8' }).LC_ALL).toBe('en_US.UTF-8')
    expect(gitEnv({ LANG: 'ko_KR.UTF-8' }).LC_ALL).toBeUndefined()
    expect(gitEnv({ LC_CTYPE: 'UTF-8' }).LC_ALL).toBeUndefined()
  })
  it('-i 비ASCII — CAFÉ 로 찾으면 CAFÉ·café 둘 다', async () => {
    const line = lineOf(await find({ query: 'CAFÉ', caseSensitive: false, env: noLocale }), 'loc.txt', 1)
    expect(line && marked(line.preview, line.ranges)).toEqual(['CAFÉ', 'café'])
    expect(line?.matches).toBe(2)
  })
  it('-P \\w+ — 한글 단어가 한 덩어리', async () => {
    const line = lineOf(await find({ query: '한\\w+', regex: true, env: noLocale }), 'loc.txt', 2)
    expect(line && marked(line.preview, line.ranges)).toEqual(['한글'])
  })
})

describe('r1 R1-06 — 두 git 호출의 교차 실패', () => {
  it('① 실패 → ② 를 끝내고 바로 오류(② 는 30 s 잠)', async () => {
    const git = fakeGit('lines-fail', { lines: 'echo "fatal: boom" >&2; exit 128', matches: 'exec sleep 30' })
    const shared = searcher({ timeoutMs: 20_000 }, { git: () => git })
    const startedAt = Date.now()
    const result = await shared.search({ root, query: 'foo', ...OFF, requestId: 'lines-fail' })
    expect(result.ok === false && result.code).toBe('git_failed')
    expect(result.ok === false && result.error).toContain('fatal: boom')
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(shared.livePids).toEqual([])
  })
  it('② 실패 → 결과는 그대로, 강조·일치 수만 모름', async () => {
    const git = fakeGit('matches-fail', { lines: "printf 'a.txt\\0001\\0001\\000foo foo\\n'; exit 0", matches: 'echo "fatal: aux" >&2; exit 128' })
    const result = await searcher(undefined, { git: () => git }).search({ root, query: 'foo', ...OFF, requestId: 'matches-fail' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files.map((file) => file.rel)).toEqual(['a.txt'])
    expect(result.files[0]?.lines[0]).toMatchObject({ line: 1, column: 1, ranges: [], matchesExact: false })
    expect(result.matchCountExact).toBe(false)
  })
})

describe('r1 R1-07 — killAll 은 SIGTERM 을 무시하는 자식도 바로 끝낸다', () => {
  // r2 R2-05 — 시간 의존 제거: 두 자식이 trap 을 건 **뒤** 표식 파일을 만들고, 시험은 표식을 본 뒤에 killAll 한다.
  it('trap TERM 무시 자식 — 무시 설치 확인 뒤 killAll, 300 ms 안에 끝(SIGTERM 뒤 SIGKILL 유예 500 ms 를 기다리지 않는다)', async () => {
    const ready = path.join(base, 'ignore-term-ready')
    fs.rmSync(`${ready}-1`, { force: true })
    fs.rmSync(`${ready}-2`, { force: true })
    const git = fakeGit('ignore-term', { lines: `trap '' TERM; touch ${ready}-1; exec sleep 30`, matches: `trap '' TERM; touch ${ready}-2; exec sleep 30` })
    const shared = searcher({ timeoutMs: 20_000 }, { git: () => git })
    const pending = shared.search({ root, query: 'foo', ...OFF, requestId: 'ignore-term' })
    await until(() => fs.existsSync(`${ready}-1`) && fs.existsSync(`${ready}-2`))
    expect(shared.livePids).toHaveLength(2)
    const startedAt = Date.now()
    shared.killAll()
    const result = await pending
    expect(Date.now() - startedAt).toBeLessThan(300)
    expect(result.ok === false && result.code).toBe('cancelled')
    expect(shared.livePids).toEqual([])
  })
})

describe('r2 R2-05 — 취소 연결·프로세스 그룹', () => {
  it('M — ① 이 먼저 끝나고 ② 만 도는 중 새 검색 → 앞 검색의 ② 도 끝난다', async () => {
    const ready = path.join(base, 'aux-only-ready')
    fs.rmSync(ready, { force: true })
    const git = fakeGit('aux-only', { lines: "printf 'a.txt\\0001\\0001\\000foo\\n'; exit 0", matches: `echo $$ > ${ready}.tmp; mv ${ready}.tmp ${ready}; exec sleep 30` })
    const shared = searcher({ timeoutMs: 20_000 }, { git: () => git })
    const first = shared.search({ root, query: 'foo', ...OFF, requestId: 'aux-a' })
    await until(() => fs.existsSync(ready) && shared.livePids.length === 1)
    const auxPid = Number(fs.readFileSync(ready, 'utf8').trim())
    fs.rmSync(ready)
    const startedAt = Date.now()
    const second = shared.search({ root, query: 'foo', ...OFF, requestId: 'aux-b' })
    const result = await first
    expect(result.ok === false && result.code).toBe('cancelled')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await until(() => !alive(auxPid))
    shared.killAll()
    await second
  })
  it('S17·S18 — 취소는 프로세스 그룹째: git 이 띄운 손자도 끝난다', async () => {
    const grand = path.join(base, 'grand.pid')
    fs.rmSync(grand, { force: true })
    const git = fakeGit('grandchild', { lines: `sleep 30 & echo $! > ${grand}.tmp; mv ${grand}.tmp ${grand}; wait`, matches: 'exec sleep 30' })
    const shared = searcher({ timeoutMs: 20_000 }, { git: () => git })
    const pending = shared.search({ root, query: 'foo', ...OFF, requestId: 'grand' })
    await until(() => fs.existsSync(grand))
    const pid = Number(fs.readFileSync(grand, 'utf8').trim())
    expect(alive(pid)).toBe(true)
    expect(shared.cancel('grand')).toBe(true)
    const result = await pending
    expect(result.ok === false && result.code).toBe('cancelled')
    await until(() => !alive(pid), 3_000)
    expect(alive(pid)).toBe(false)
  })
})

describe('r1 R1-08 — 긴 앞 문맥은 줄여 첫 일치가 미리보기 앞쪽에', () => {
  it('앞 60 글자 → 앞이 잘리고 첫 일치는 상한 칸 안', async () => {
    const line = lineOf(await find({ query: 'needle' }), 'lead.txt', 1)
    expect(line?.clippedStart).toBe(true)
    expect(line?.ranges[0]?.start).toBe(SEARCH_PREVIEW_LEAD_CELLS)
    expect(line?.column).toBe(62)
    expect(line?.preview.endsWith('needle tail')).toBe(true)
  })
  it('previewOf — 앞 문맥이 상한 이하면 줄 처음부터', () => {
    expect(previewOf({ text: Buffer.from('ab needle'), column: 4, maxBytes: 400, leadCells: 24 })).toMatchObject({ start: 0, column: 4 })
  })
  it('previewOf — 서로게이트 쌍 가운데를 자르지 않는다', () => {
    const text = Buffer.from(`${'😀'.repeat(20)}x`)
    const preview = previewOf({ text, column: 81, maxBytes: 400, leadCells: 3 })
    expect(preview.bytes.toString('utf8')).toBe('😀x')
  })
})

describe('r1 R1-10 — -o 상한이면 일치 수가 부분값임을 알린다', () => {
  it('maxMatches 1 — 대소문자 무시면 둘째 일치 글 모양을 못 본 줄은 matchesExact 거짓, 결과 전체도', async () => {
    const result = await find({ query: 'foo', caseSensitive: false, limits: { maxMatches: 1 } })
    expect(result.ok && result.matchCountExact).toBe(false)
    expect(lineOf(result, 'words.txt', 2)?.matchesExact).toBe(false)
  })
  it('r2 R2-03 — 대소문자 구분 리터럴은 -o 상한과 무관하게 정확(줄 바이트만 훑는다)', async () => {
    const result = await find({ query: 'foo', limits: { maxMatches: 1 } })
    expect(result.ok && result.matchCountExact).toBe(true)
    expect(lineOf(result, 'words.txt', 2)?.ranges).toEqual([{ start: 0, end: 3 }, { start: 8, end: 11 }])
  })
  it('상한이 없으면 정확', async () => {
    const result = await find({ query: 'needle' })
    expect(result.ok && result.matchCountExact).toBe(true)
  })
})

describe('r2 R2-03 — 리터럴 위치는 줄 바이트에서만(-o 열 무관)', () => {
  const rows = (pairs: [number, string][]) => pairs.map(([column, text]) => ({ column, text: Buffer.from(text) }))
  const literal = (input: { text: string; query: string; rows: [number, string][]; caseSensitive: boolean }) =>
    lineMatches({ text: Buffer.from(input.text), firstColumn: 1, rows: rows(input.rows), rowsComplete: true, mode: 'literal', query: input.query, caseSensitive: input.caseSensitive })
  it('babaa aa 에서 a — 열 값이 진짜 시작(고쳐진 git 가정)이든 지금 git 공식이든 같은 정답', () => {
    const want = [1, 3, 4, 6, 7].map((start) => ({ start, end: start + 1 }))
    const real: [number, string][] = [[2, 'a'], [4, 'a'], [5, 'a'], [7, 'a'], [8, 'a']]
    const odd: [number, string][] = [[2, 'a'], [3, 'a'], [4, 'a'], [5, 'a'], [6, 'a']]
    const junk: [number, string][] = [[99, 'a'], [1, 'a'], [1, 'a'], [1, 'a'], [1, 'a']]
    for (const pairs of [real, odd, junk]) {
      expect(literal({ text: 'babaa aa', query: 'a', rows: pairs, caseSensitive: true }).ranges).toEqual(want)
      expect(literal({ text: 'babaa aa', query: 'A', rows: pairs, caseSensitive: false }).ranges).toEqual(want)
    }
  })
  it('대소문자 무시 — 후보는 ② 의 일치 글 모양(열 무시), 같은 자리면 긴 것', () => {
    expect(literal({ text: 'hello 한글 Foo foo', query: 'FOO', rows: [[14, 'Foo'], [30, 'foo']], caseSensitive: false }).ranges).toEqual([{ start: 13, end: 16 }, { start: 17, end: 20 }])
    expect(scanRanges({ text: Buffer.from('aab'), candidates: [Buffer.from('a'), Buffer.from('aa')], wordBoundary: false })).toEqual([{ start: 0, end: 2 }])
  })
  it('대소문자 무시인데 ② 가 그 줄을 못 봤으면 강조 0·수 모름', () => {
    expect(lineMatches({ text: Buffer.from('Foo'), firstColumn: 1, rows: undefined, rowsComplete: false, mode: 'literal', query: 'foo', caseSensitive: false })).toEqual({ ranges: [], matches: 1, exact: false })
  })
  it('실제 git — foobar foo foobar 정규식 줄은 첫 일치만 강조, 수는 「이상」', async () => {
    const line = lineOf(await find({ query: 'fo+(?=bar)', regex: true }), 'words.txt', 3)
    expect(line?.matches).toBe(1)
    expect(line?.matchesExact).toBe(false)
    expect(line && marked(line.preview, line.ranges)).toEqual(['foo'])
    expect(line?.ranges[0]).toEqual({ start: 0, end: 3 })
  })
})

describe('출력 해석기', () => {
  it('조각으로 와도 행을 맞춘다 — 경로의 줄바꿈도 그대로', () => {
    const parser = new GrepRecordParser()
    const seen: string[] = []
    const all = Buffer.from('a\nb\x001\x002\x00text\nc\x003\x004\x00more\n')
    for (let index = 0; index < all.length; index += 3) parser.push(all.subarray(index, index + 3), (record) => (seen.push(`${record.path.toString()}|${record.line}|${record.column}|${record.text.toString()}`), true))
    expect(seen).toEqual(['a\nb|1|2|text', 'c|3|4|more'])
  })
})

describe('r2 R2-01 — 단어 단위 + 대소문자 무시, 한 줄 다수 일치도 선형', () => {
  it('foo ×50000(-o 상한) 한 줄 — lineMatches 동기 시간 1 초 미만, 범위 50000 개', () => {
    const n = 50_000
    const text = Buffer.from('foo '.repeat(n))
    const rows = Array.from({ length: n }, (_, index) => ({ column: 1 + index * 4, text: Buffer.from('foo') }))
    const started = performance.now()
    const found = lineMatches({ text, firstColumn: 1, rows, rowsComplete: true, mode: 'literalWord', query: 'FOO', caseSensitive: false })
    const elapsed = performance.now() - started
    expect(found.ranges).toHaveLength(n)
    expect(found.ranges[n - 1]).toEqual({ start: (n - 1) * 4, end: (n - 1) * 4 + 3 })
    expect(found.exact).toBe(true)
    expect(elapsed).toBeLessThan(1000)
  })
  it('uniqueCandidates — 같은 바이트열은 하나, 빈 것은 버림', () => {
    expect(uniqueCandidates([Buffer.from('foo'), Buffer.from('Foo'), Buffer.from('foo'), Buffer.from('')]).map((b) => b.toString())).toEqual(['foo', 'Foo'])
  })
})

describe('r2 R2-02 — 앞 문맥 상한은 표시 폭(전각 2칸)', () => {
  it('한글 30자 + 일치 — 첫 일치 앞 폭이 상한 칸 안', () => {
    const text = Buffer.from(`${'가'.repeat(30)}needle`)
    const preview = previewOf({ text, column: 91, maxBytes: 400, leadCells: SEARCH_PREVIEW_LEAD_CELLS })
    const lead = preview.bytes.toString('utf8').slice(0, preview.bytes.toString('utf8').indexOf('needle'))
    const cells = [...lead].reduce((sum, char) => sum + (isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1), 0)
    expect(preview.start).toBeGreaterThan(0)
    expect(cells).toBeLessThanOrEqual(SEARCH_PREVIEW_LEAD_CELLS)
    expect(lead).toBe('가'.repeat(SEARCH_PREVIEW_LEAD_CELLS / 2))
    expect(preview.column).toBe(31)
  })
  it('실제 git — 한글 앞 문맥 줄', async () => {
    const line = lineOf(await find({ query: 'needle' }), 'hangul-lead.txt', 1)
    expect(line?.clippedStart).toBe(true)
    expect(line?.ranges[0]?.start).toBe(SEARCH_PREVIEW_LEAD_CELLS / 2)
    expect(line?.column).toBe(31)
  })
})

describe('r2 R2-04 — UTF-8 BOM 첫 줄', () => {
  it('BOM Foo start → 열 1, 미리보기에 U+FEFF 없음, 둘째 줄 정상', async () => {
    const result = await find({ query: 'Foo', caseSensitive: true })
    const first = lineOf(result, 'bom.txt', 1)
    expect(first?.column).toBe(1)
    expect(first?.preview.startsWith('\uFEFF')).toBe(false)
    expect(first?.preview).toBe('Foo start')
    expect(first?.ranges).toEqual([{ start: 0, end: 3 }])
    expect(lineOf(result, 'bom.txt', 2)?.column).toBe(8)
  })
  it('정규식 첫 일치도 BOM 만큼 맞춘다', async () => {
    const first = lineOf(await find({ query: 'F.o', regex: true, caseSensitive: true }), 'bom.txt', 1)
    expect(first?.ranges).toEqual([{ start: 0, end: 3 }])
    expect(first?.column).toBe(1)
  })
  it('withoutBom — 첫 줄만, BOM 없으면 그대로', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x61])
    expect(withoutBom({ line: 1, text: bom, column: 4 })).toMatchObject({ column: 1, bom: 3 })
    expect(withoutBom({ line: 2, text: bom, column: 4 })).toMatchObject({ column: 4, bom: 0 })
  })
})

describe('r2 R2-05 G — 정규식 첫 일치 바이트 가드(①·② 사이 파일 변경)', () => {
  it('② 첫 행 열은 같지만 글이 줄 바이트와 다르면 강조 0', () => {
    const rows = [{ column: 1, text: Buffer.from('bar') }]
    expect(lineMatches({ text: Buffer.from('foo x'), firstColumn: 1, rows, rowsComplete: true, mode: 'regex', query: 'f..|b..', caseSensitive: true }).ranges).toEqual([])
    expect(lineMatches({ text: Buffer.from('bar x'), firstColumn: 1, rows, rowsComplete: true, mode: 'regex', query: 'f..|b..', caseSensitive: true }).ranges).toEqual([{ start: 0, end: 3 }])
  })
})

describe('r3 R3-01 — UTF-8 아닌 줄의 앞 문맥도 원 바이트로 자른다', () => {
  it('previewOf — 0xE9×40 + needle: start ≤ 줄 길이, 미리보기 비지 않음', () => {
    const text = Buffer.concat([Buffer.alloc(40, 0xe9), Buffer.from(' needle')])
    const preview = previewOf({ text, column: 42, maxBytes: 400, leadCells: SEARCH_PREVIEW_LEAD_CELLS })
    expect(preview.start).toBe(42 - 1 - SEARCH_PREVIEW_LEAD_CELLS)
    expect(preview.start).toBeLessThanOrEqual(text.length)
    expect(preview.bytes.toString('latin1').endsWith(' needle')).toBe(true)
    expect(preview.column).toBe(42)
  })
  it('실제 git — latin1.txt 결과 행에 미리보기와 강조가 있다', async () => {
    const line = lineOf(await find({ query: 'needle' }), 'latin1.txt', 1)
    expect(line?.clippedStart).toBe(true)
    expect(line?.preview.endsWith(' needle')).toBe(true)
    expect(line && marked(line.preview, line.ranges)).toEqual(['needle'])
  })
})

describe('r3 R3-02 — 시험 공백', () => {
  it('W7·W16 — -o 상한이 줄 가운데: Zed zed ZED + maxMatches 2 → 그 줄 matchesExact 거짓·강조 2', async () => {
    const result = await find({ query: 'zed', caseSensitive: false, limits: { maxMatches: 2 } })
    const line = lineOf(result, 'zed.txt', 1)
    expect(line?.ranges).toHaveLength(2)
    expect(line?.matchesExact).toBe(false)
    expect(result.ok && result.matchCountExact).toBe(false)
  })
  it('W13 — CRLF 줄은 뒤가 잘린 줄이 아니다', async () => {
    const line = lineOf(await find({ query: 'crlf' }), 'crlf.txt', 1)
    expect(line?.clippedEnd).toBe(false)
  })
  it('W15 — 400 바이트 경계가 다바이트 글자 가운데면 그 글자 앞에서 자른다', async () => {
    const line = lineOf(await find({ query: 'needle' }), 'wide.txt', 1)
    expect(line?.preview).toBe(`needle${'가'.repeat(131)}`)
    expect(line?.preview.includes('\uFFFD')).toBe(false)
    expect(line?.clippedEnd).toBe(true)
  })
})

describe('r3 R3-04 — 대소문자 구분 리터럴은 ② 를 띄우지 않는다', () => {
  const counted = (name: string): { git: string; calls: () => number } => {
    const log = path.join(base, `${name}.calls`)
    fs.rmSync(log, { force: true })
    const git = fakeGit(name, { lines: `echo 1 >> ${log}; exec ${gitBin} "$@"`, matches: `echo 2 >> ${log}; exec ${gitBin} "$@"` })
    return { git, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0) }
  }
  it('리터럴·단어 단위(구분) → git 1번, 결과·강조는 그대로', async () => {
    for (const wholeWord of [false, true]) {
      const probe = counted(`count-cs-${wholeWord}`)
      const result = await searcher(undefined, { git: () => probe.git }).search({ root, query: 'foo', caseSensitive: true, wholeWord, regex: false, requestId: `cs-${wholeWord}` })
      expect(probe.calls()).toBe(1)
      expect(lineOf(result, 'words.txt', 2)?.ranges).toEqual([{ start: 0, end: 3 }, { start: 8, end: 11 }])
    }
  })
  it('대소문자 무시·정규식은 2번', async () => {
    for (const [index, options] of [{ caseSensitive: false, wholeWord: false, regex: false }, { caseSensitive: true, wholeWord: false, regex: true }].entries()) {
      const probe = counted(`count-two-${index}`)
      await searcher(undefined, { git: () => probe.git }).search({ root, query: 'foo', ...options, requestId: `two-${index}` })
      expect(probe.calls()).toBe(2)
    }
  })
})
