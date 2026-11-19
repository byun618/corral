// LIFE-803 C1·C2·C3 — 내용 전체 검색(단위, 실제 git fixture). 열은 UTF-16 코드 단위 **1부터**(Monaco 열) — `hello 한글 Foo` 의 `Foo` 는 열 10(0부터 9).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContentSearcher, GrepRecordParser, grepArgs, matchByteRanges, previewOf } from './content-search.js'
import { resolveGit } from './file-list.js'
import type { ContentSearchResult } from '../shared/content-search.js'

let base = ''
let root = ''
let plain = ''
const gitBin = resolveGit({ pathEnv: process.env.PATH })
const git = (args: string[], cwd = root): string => execFileSync(gitBin, args, { cwd, encoding: 'utf8' })
const searcher = (limits?: ConstructorParameters<typeof ContentSearcher>[0]['limits']): ContentSearcher =>
  new ContentSearcher({ roots: () => [root, plain, path.join(base, 'gone')], git: () => gitBin, log: () => undefined, limits })
const OFF = { caseSensitive: false, wholeWord: false, regex: false }
let sequence = 0
const find = (input: { query: string; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; at?: string; limits?: Parameters<typeof searcher>[0] }): Promise<ContentSearchResult> =>
  searcher(input.limits).search({ root: input.at ?? root, query: input.query, caseSensitive: input.caseSensitive ?? true, wholeWord: input.wholeWord ?? false, regex: input.regex ?? false, requestId: `t-${(sequence += 1)}` })
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
    expect(on).toEqual(['a.txt:1:10', 'a.txt:2:8'])
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
    expect(hits(await find({ query: 'fo+(?=bar)', regex: true }))).toEqual(['a.txt:2:1', 'words.txt:1:5', 'words.txt:3:1'])
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
    const preview = previewOf({ text, column: 91, maxBytes: 20, leadBytes: 6 })
    expect(preview.bytes.toString('utf8').startsWith('가가abc')).toBe(true)
    expect(preview.column).toBe(31)
  })
})

describe('-o 열 되찾기 (raw/claude/r1/git-o-column-probe.txt 의 실측 열)', () => {
  const rows = (pairs: [number, string][]) => pairs.map(([column, text]) => ({ column, text: Buffer.from(text) }))
  it('리터럴 — 두 번째 이후 일치의 실제 자리', () => {
    expect(matchByteRanges({ text: Buffer.from('hello 한글 Foo foo'), rows: rows([[14, 'Foo'], [30, 'foo']]), exact: true })).toEqual([{ start: 13, end: 16 }, { start: 17, end: 20 }])
    expect(matchByteRanges({ text: Buffer.from('foo bar foo'), rows: rows([[1, 'foo'], [4, 'foo']]), exact: true })).toEqual([{ start: 0, end: 3 }, { start: 8, end: 11 }])
    expect(matchByteRanges({ text: Buffer.from('foobar foo foobar'), rows: rows([[1, 'foo'], [4, 'foo'], [11, 'foo']]), exact: true })).toEqual([{ start: 0, end: 3 }, { start: 7, end: 10 }, { start: 11, end: 14 }])
  })
  it('정규식 — 마지막 일치 글이 뒤에 여럿이면 모른다(null), 하나면 그 자리', () => {
    expect(matchByteRanges({ text: Buffer.from('foobar foo foobar'), rows: rows([[1, 'foo'], [4, 'foo']]), exact: false })).toEqual([{ start: 0, end: 3 }, null])
    expect(matchByteRanges({ text: Buffer.from('foobar x foobar'), rows: rows([[1, 'foo'], [4, 'foo']]), exact: false })).toEqual([{ start: 0, end: 3 }, { start: 9, end: 12 }])
  })
  it('자리의 바이트가 일치 글과 다르면 null', () => {
    expect(matchByteRanges({ text: Buffer.from('abc'), rows: rows([[2, 'zz']]), exact: true })).toEqual([null])
  })
  it('실제 git — foobar foo foobar 정규식 줄은 확정된 범위만 강조', async () => {
    const line = lineOf(await find({ query: 'fo+(?=bar)', regex: true }), 'words.txt', 3)
    expect(line?.matches).toBe(2)
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
