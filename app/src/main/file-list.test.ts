// LIFE-593 E4·E7ⓓ·E8 — 전체 파일 목록(단위, 실제 git fixture). 오라클(01-criteria 「오라클」)과 집합이 같은지, 루트 가둠 양성 대조, 심은 git 미실행, 취소.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileLister, LS_LISTED, resolveGit } from './file-list.js'
import type { FileListResult } from '../shared/file-list.js'

let base = ''
let root = ''
let outside = ''
const git = (args: string[], cwd = root): string => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 })
const split = (text: string): string[] => text.split('\0').filter((item) => item !== '')
/** 응답 경로(NUL 로 이은 문자열 — 수정 r1 R1-C-10) → 배열. */
const filesOf = (result: FileListResult): string[] => (result.ok ? split(result.paths) : [])
/** 오라클 비교는 NFC 로(수정 r1 R1-C-02 — 제품은 디스크 이름(NFD 일 수 있음)을, git 오라클은 NFC 를 준다). */
const nfcSet = (files: Iterable<string>): Set<string> => new Set([...files].map((rel) => rel.normalize('NFC')))

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l593-list-')))
  root = path.join(base, 'wt')
  outside = path.join(base, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's')
  const write = (rel: string, text = 'x'): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  fs.mkdirSync(root)
  git(['init', '-q'])
  // E4ⓔ — 추적·untracked·ignored·중첩 .gitignore·! 부정·.git/info/exclude·추적 중인데 패턴에 걸린 파일·공백/한글(NFC·NFD) 이름·링크(파일·폴더·밖).
  write('.gitignore', 'build/\n*.log\n!keep.log\nnode_modules/\nforced.txt\n')
  write('.github/workflows/ci.yml')
  write('src/app.ts')
  write('src/sub/.gitignore', 'local-only.txt\n')
  write('src/sub/local-only.txt')
  write('src/sub/kept.ts')
  write('build/out.js')
  write('debug.log')
  write('keep.log')
  write('forced.txt')
  write('with space/file name.md')
  write('한글/파일.md')
  write('nfd/' + '한글'.normalize('NFD') + '.md')
  write('excluded-by-info.txt')
  write('node_modules/pkg/index.js')
  write('deep/node_modules/x/y.js')
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), 'excluded-by-info.txt\n')
  fs.symlinkSync('src/app.ts', path.join(root, 'link-file'))
  fs.symlinkSync('src', path.join(root, 'link-dir'))
  fs.symlinkSync(outside, path.join(root, 'link-outside-dir'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-outside-file'))
  git(['add', '.gitignore', '.github', 'src/app.ts', 'src/sub/.gitignore', 'src/sub/kept.ts', 'keep.log', 'with space', '한글', 'link-file', 'link-dir'])
  git(['add', '-f', 'forced.txt'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  // untracked
  write('src/new.ts')
  // 지워졌지만 아직 추적 중 — 끔 목록에서 빠진다
  write('gone.ts')
  git(['add', 'gone.ts'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'gone'])
  fs.rmSync(path.join(root, 'gone.ts'))
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

const logs: { event: string; data?: Record<string, unknown> }[] = []
const lister = (roots: () => readonly string[] = () => [root], gitPath = resolveGit({ pathEnv: process.env.PATH })): FileLister =>
  new FileLister({ roots, git: () => gitPath, log: (event, data) => logs.push({ event, data }) })

/** 오라클(01-criteria) — 끔: ls-files -co --exclude-standard − 지워진 추적 파일. 켬: 위 + -oi(.git/·node_modules/ 아래 제외). */
// 수정 r1 R1-C-05 — 디스크에 파일로 없는 추적 항목(sparse·gitlink)과 **폴더를 가리키는 추적 링크**는 고를 수 있는 파일 행이 아니다. 오라클에서도 뺀다(이 fixture 에선 `link-dir`).
const NOT_FILE_ROWS = new Set(['link-dir'])
function oracle(includeIgnored: boolean): Set<string> {
  const deleted = new Set(split(git(['ls-files', '-z', '--deleted'])))
  const off = split(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).filter((rel) => !deleted.has(rel) && !NOT_FILE_ROWS.has(rel))
  if (!includeIgnored) return nfcSet(off)
  const ignored = split(git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).filter((rel) => !rel.split('/').slice(0, -1).some((part) => part === '.git' || part === 'node_modules'))
  return nfcSet([...off, ...ignored])
}

describe('E4 오라클 대조', () => {
  it('ⓐ 끔(기본) = 오라클(끔) — 집합이 같다', async () => {
    const result = await lister().list({ root, includeIgnored: false, requestId: 'a1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(nfcSet(filesOf(result))).toEqual(oracle(false))
    expect(filesOf(result)).not.toContain('gone.ts')
    expect(filesOf(result)).toContain('src/new.ts')
    expect(filesOf(result)).toContain('forced.txt') // 추적 중인데 패턴에 걸린 파일
    expect(filesOf(result)).toContain('keep.log') // ! 부정
    expect(filesOf(result)).not.toContain('debug.log')
    expect(filesOf(result)).not.toContain('excluded-by-info.txt')
    expect(filesOf(result)).not.toContain('src/sub/local-only.txt') // 중첩 .gitignore
  })
  it('ⓑ 켬 = 오라클(켬), .git/·node_modules/ 는 켜도 빠진다', async () => {
    const result = await lister().list({ root, includeIgnored: true, requestId: 'b1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(nfcSet(filesOf(result))).toEqual(oracle(true))
    expect(filesOf(result)).toContain('build/out.js')
    expect(filesOf(result)).toContain('debug.log')
    expect(filesOf(result)).toContain('src/sub/local-only.txt')
    expect(filesOf(result).some((rel) => rel.split('/').includes('node_modules'))).toBe(false)
    expect(filesOf(result).some((rel) => rel.startsWith('.git/'))).toBe(false)
  })
  it('ⓒ dotfile 은 목록에 든다', async () => {
    const result = await lister().list({ root, includeIgnored: false, requestId: 'c1' })
    expect(result.ok && filesOf(result).includes('.github/workflows/ci.yml') && filesOf(result).includes('.gitignore')).toBe(true)
  })
  it('E8ⓓ 링크는 그 자신 한 줄 — 밖을 가리키는 링크 폴더 안으로 따라가지 않는다. 응답은 루트 상대뿐', async () => {
    const result = await lister().list({ root, includeIgnored: true, requestId: 'd1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 추적 중인 폴더 링크는 파일 행이 아니다(수정 r1 R1-C-05), 파일 링크는 그 자신 한 줄.
    expect(filesOf(result)).not.toContain('link-dir')
    expect(filesOf(result)).toContain('link-file')
    expect(filesOf(result).some((rel) => rel.startsWith('link-dir/'))).toBe(false)
    expect(filesOf(result).some((rel) => rel.startsWith('link-outside-dir/') || rel.includes('secret.txt'))).toBe(false)
    for (const rel of filesOf(result)) {
      expect(rel.startsWith('/')).toBe(false)
      expect(rel.split('/')).not.toContain('..')
    }
  })
  it('E2ⓒ 한글 이름(NFC·NFD) 이 목록에 든다', async () => {
    const result = await lister().list({ root, includeIgnored: false, requestId: 'k1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(filesOf(result).map((rel) => rel.normalize('NFC'))).toEqual(expect.arrayContaining(['한글/파일.md', 'nfd/한글.md', 'with space/file name.md']))
  })
})

describe('E8ⓐ 루트 가둠 — 양성 대조(같은 하네스로 정상 요청 통과)', () => {
  it('정상 요청 통과', async () => {
    expect((await lister().list({ root, includeIgnored: false, requestId: 'ok' })).ok).toBe(true)
  })
  it('열리지 않은 실제 git 디렉터리·/·.. 섞인 경로·worktree 하위 폴더는 거절(not_worktree)', async () => {
    const other = path.join(base, 'other-repo')
    fs.mkdirSync(other, { recursive: true })
    git(['init', '-q'], other)
    for (const bad of [other, '/', `${root}/src/..`, `${root}/`, `${root}/../wt`, path.join(root, 'src'), 'wt', '']) {
      const result = await lister().list({ root: bad, includeIgnored: false, requestId: 'x' })
      expect(result).toMatchObject({ ok: false, code: 'not_worktree' })
    }
  })
  it('형 위반(토글이 불리언 아님·요청 id 형 위반·인자 주입 모양)은 거절(invalid_argument)', async () => {
    for (const input of [
      { root, includeIgnored: 'yes', requestId: 'x' },
      { root, includeIgnored: false, requestId: '--output=/tmp/x' },
      { root, includeIgnored: false, requestId: 'a\0b' },
      { root, includeIgnored: false },
      null,
    ]) {
      expect(await lister().list(input)).toMatchObject({ ok: false, code: 'invalid_argument' })
    }
  })
  it('E8ⓑ - 로 시작하는 파일명·NUL 은 인자로 해석되지 않는다(-z 출력 그대로)', async () => {
    fs.writeFileSync(path.join(root, '--help'), 'x')
    fs.writeFileSync(path.join(root, '-rf'), 'x')
    const result = await lister().list({ root, includeIgnored: false, requestId: 'dash' })
    fs.rmSync(path.join(root, '--help'))
    fs.rmSync(path.join(root, '-rf'))
    expect(result.ok && filesOf(result).includes('--help') && filesOf(result).includes('-rf')).toBe(true)
  })
})

describe('E8ⓒ 실행 파일 해석 — 심은 git 이 실행되지 않는다', () => {
  it('PATH 의 상대 항목은 후보가 아니다', () => {
    const seen: string[] = []
    const picked = resolveGit({ pathEnv: ['.', 'bin', '/abs/one', '/abs/two'].join(':'), isExecutable: (file) => (seen.push(file), file === '/abs/two/git' || file === 'git' || file === 'bin/git') })
    expect(picked).toBe('/abs/two/git')
    expect(seen.every((file) => file.startsWith('/'))).toBe(true)
  })
  it('worktree 안에 심은 git(표지 파일을 만드는 스크립트)은 앱 cwd·PATH 상대 항목이 그곳이어도 실행되지 않는다', async () => {
    const marker = path.join(base, 'planted-ran')
    const planted = path.join(root, 'git')
    fs.writeFileSync(planted, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    const cwd = process.cwd()
    process.chdir(root)
    try {
      const gitPath = resolveGit({ pathEnv: `.:${process.env.PATH ?? ''}` })
      expect(gitPath).not.toBe(planted)
      expect(path.isAbsolute(gitPath)).toBe(true)
      const result = await lister(() => [root], gitPath).list({ root, includeIgnored: false, requestId: 'planted' })
      expect(result.ok).toBe(true)
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      process.chdir(cwd)
      fs.rmSync(planted)
    }
  })
  it('레포 설정 core.fsmonitor 명령은 부르지 않는다(-c core.fsmonitor=false)', async () => {
    const marker = path.join(base, 'fsmonitor-ran')
    const hook = path.join(base, 'fsmonitor-hook.sh')
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 })
    git(['config', 'core.fsmonitor', hook])
    try {
      // 양성 대조 — 같은 설정으로 그냥 git status 를 부르면 훅이 돈다.
      execFileSync('git', ['status', '--porcelain'], { cwd: root, stdio: 'ignore' })
      const control = fs.existsSync(marker)
      fs.rmSync(marker, { force: true })
      const result = await lister().list({ root, includeIgnored: true, requestId: 'fsm' })
      expect(control).toBe(true)
      expect(result.ok).toBe(true)
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      git(['config', '--unset', 'core.fsmonitor'])
    }
  })
  it('git 인자는 고정이다 — 렌더러 입력이 들어가지 않는다', () => {
    expect(LS_LISTED).toEqual(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '-s', '-t'])
  })
})

describe('E7ⓓ 취소', () => {
  it('취소하면 cancelled 로 끝나고 진행 중 작업이 0 이다', async () => {
    const one = lister()
    const pending = one.list({ root, includeIgnored: true, requestId: 'cancel-me' })
    // confine(비동기) 뒤 등록되므로 한 틱 기다렸다 취소한다.
    await new Promise((resolve) => setTimeout(resolve, 5))
    one.cancel('cancel-me')
    const result = await pending
    // 수정 r1 R1-C-11 — 조건 없이 단언한다(등록이 첫 await 전이라 언제 취소해도 찾는다).
    expect(result).toMatchObject({ ok: false, code: 'cancelled' })
    expect(one.active).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(one.liveChildren).toBe(0)
  })
  it('cancelAll 뒤 진행 중 작업 0', async () => {
    const one = lister()
    const pending = Promise.all([one.list({ root, includeIgnored: true, requestId: 'p1' }), one.list({ root, includeIgnored: false, requestId: 'p2' })])
    await new Promise((resolve) => setTimeout(resolve, 5))
    one.cancelAll()
    for (const result of await pending) expect(result).toMatchObject({ ok: false, code: 'cancelled' })
    expect(one.active).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(one.liveChildren).toBe(0)
  })
})

// --- 수정 r1 (리뷰 r1 R1-C-03·R1-G-01·R1-C-11·R1-G-02) — 가짜 git(셸 스크립트)이 자기 pid 와 손주 `sleep` pid 를 적는다. 취소·실패·시간 초과 뒤 **OS 에 그 pid 가 남지 않아야** 한다.
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pidsOf = (file: string): number[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map(Number) : [])
const waitDead = async (file: string, ms = 2_000): Promise<number[]> => {
  const until = Date.now() + ms
  for (;;) {
    const left = pidsOf(file).filter(alive)
    if (left.length === 0 || Date.now() > until) return left
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
let fakeSeq = 0
function fakeGit(input: { fail?: string; sleep?: number } = {}): { git: string; pids: string } {
  fakeSeq += 1
  const dir = path.join(base, `fakegit-${fakeSeq}`)
  fs.mkdirSync(dir)
  const pids = path.join(dir, 'pids')
  const fail = input.fail === undefined ? '' : `case "$*" in *'${input.fail}'*) echo boom >&2; exit 3;; esac\n`
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\necho $$ >> '${pids}'\n${fail}sleep ${input.sleep ?? 5} &\necho $! >> '${pids}'\nwait\n`, { mode: 0o755 })
  return { git: path.join(dir, 'git'), pids }
}
const waitPids = async (file: string, count: number): Promise<void> => {
  const until = Date.now() + 3_000
  while (pidsOf(file).length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('수정 r1 — 취소·실패·시간 초과 뒤 자식(손주 포함) 0', () => {
  it('R1-C-03 같은 틱 취소(confine 전) — cancelled 이고 git 자식을 하나도 띄우지 않는다', { timeout: 15_000 }, async () => {
    const fake = fakeGit()
    const one = lister(() => [root], fake.git)
    const pending = one.list({ root, includeIgnored: true, requestId: 'same-tick' })
    one.cancel('same-tick')
    const result = await pending
    expect(result).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await waitDead(fake.pids)).toEqual([])
    expect(pidsOf(fake.pids)).toEqual([])
    expect(one.active).toBe(0)
  })
  it('R1-C-03 같은 틱 cancelAll — cancelled, 자식 0', { timeout: 15_000 }, async () => {
    const fake = fakeGit()
    const one = lister(() => [root], fake.git)
    const pending = Promise.all([one.list({ root, includeIgnored: true, requestId: 'all-1' }), one.list({ root, includeIgnored: false, requestId: 'all-2' })])
    one.cancelAll()
    const results = await pending
    for (const result of results) expect(result).toMatchObject({ ok: false, code: 'cancelled' })
    expect(pidsOf(fake.pids)).toEqual([])
  })
  it('R1-G-01 실행 중 취소 — 손주 프로세스까지 끝난다(프로세스 그룹)', { timeout: 15_000 }, async () => {
    const fake = fakeGit()
    const one = lister(() => [root], fake.git)
    const pending = one.list({ root, includeIgnored: true, requestId: 'running' })
    await waitPids(fake.pids, 6) // 자식 3(listed·deleted·ignored) × (sh + sleep)
    expect(pidsOf(fake.pids).length).toBe(6)
    expect(one.cancel('running')).toBe(true)
    const result = await pending
    expect(result).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await waitDead(fake.pids)).toEqual([])
    expect(one.liveChildren).toBe(0)
  })
  it('R1-C-11 하나가 실패하면 나머지를 즉시 끝내고 첫 실제 실패 코드를 낸다', { timeout: 15_000 }, async () => {
    const fake = fakeGit({ fail: '--deleted' })
    const one = lister(() => [root], fake.git)
    const startedAt = Date.now()
    const result = await one.list({ root, includeIgnored: false, requestId: 'one-fails' })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(result).toMatchObject({ ok: false, code: 'git_failed' })
    expect(await waitDead(fake.pids)).toEqual([])
  })
  it('R1-G-01 시간 초과 — timeout 이고 손주까지 끝난다', { timeout: 15_000 }, async () => {
    const fake = fakeGit()
    const one = new FileLister({ roots: () => [root], git: () => fake.git, log: () => undefined, timeoutMs: 300 })
    const result = await one.list({ root, includeIgnored: false, requestId: 'slow' })
    expect(result).toMatchObject({ ok: false, code: 'timeout' })
    expect(await waitDead(fake.pids)).toEqual([])
    expect(one.liveChildren).toBe(0)
  })
  it('출력 상한을 넘으면 실패로 끝나고 자식이 남지 않는다', { timeout: 15_000 }, async () => {
    const dir = path.join(base, 'fakegit-big')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nyes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`, { mode: 0o755 })
    const one = new FileLister({ roots: () => [root], git: () => path.join(dir, 'git'), log: () => undefined, maxBytes: 1 << 20 })
    const result = await one.list({ root, includeIgnored: false, requestId: 'big' })
    expect(result).toMatchObject({ ok: false, code: 'git_failed' })
    expect(one.liveChildren).toBe(0)
  })
})

describe('수정 r1 — 경로 형태(R1-C-02 NFD)·고를 수 없는 추적 항목(R1-C-05)', () => {
  it('R1-C-02 목록 경로는 디스크 이름 그대로다(git 은 NFC 로 주지만 readdir 은 NFD)', async () => {
    const result = await lister().list({ root, includeIgnored: false, requestId: 'nfd' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const onDisk = 'nfd/' + (fs.readdirSync(path.join(root, 'nfd')).find((name) => name.normalize('NFC') === '한글.md') ?? '')
    expect(filesOf(result)).toContain(onDisk)
    expect(filesOf(result).filter((rel) => rel.normalize('NFC') === 'nfd/한글.md')).toEqual([onDisk])
  })
})

describe('수정 r1 — 고를 수 없는 추적 항목(R1-C-05)·worktree 안 git(R1-C-04)', () => {
  let wt2 = ''
  beforeAll(() => {
    // 별도 레포 — 위 오라클 대조에 섞이지 않게. gitlink(서브모듈 모양)·추적 중인 폴더 링크·sparse(skip-worktree, 디스크에 없음)·추적 중인 파일 링크.
    wt2 = path.join(base, 'wt2')
    fs.mkdirSync(path.join(wt2, 'src'), { recursive: true })
    git(['init', '-q'], wt2)
    fs.writeFileSync(path.join(wt2, 'src', 'a.ts'), 'a')
    fs.writeFileSync(path.join(wt2, 'sparse.ts'), 's')
    fs.symlinkSync('src', path.join(wt2, 'link-dir'))
    fs.symlinkSync('src/a.ts', path.join(wt2, 'link-file'))
    git(['add', '.'], wt2)
    git(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`], wt2)
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], wt2)
    git(['update-index', '--skip-worktree', 'sparse.ts'], wt2)
    fs.rmSync(path.join(wt2, 'sparse.ts'))
  })
  it('gitlink·폴더 링크·sparse(디스크에 없음)는 파일 행으로 나오지 않는다. 파일 링크·보통 파일은 나온다', async () => {
    const result = await lister(() => [wt2]).list({ root: wt2, includeIgnored: true, requestId: 'c05' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(filesOf(result).sort()).toEqual(['link-file', 'src/a.ts'])
  })
  it('R1-C-04 PATH 에 열린 worktree 안 폴더가 있어도 그 안 git 은 고르지 않는다(실경로 대조)', () => {
    const bin = path.join(root, 'tools', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const linked = path.join(base, 'bin-link')
    fs.symlinkSync(bin, linked)
    try {
      const outsideBin = path.dirname(resolveGit({ pathEnv: process.env.PATH, roots: [] }))
      expect(resolveGit({ pathEnv: `${bin}:${process.env.PATH ?? ''}`, roots: [root] })).not.toBe(path.join(bin, 'git'))
      // 밖의 링크가 worktree 안 폴더를 가리켜도(실경로가 안) 고르지 않는다.
      expect(path.dirname(resolveGit({ pathEnv: `${linked}:${process.env.PATH ?? ''}`, roots: [root] }))).toBe(outsideBin)
      // worktree 밖 사용자 PATH 는 그대로 — 열린 worktree 가 없으면 같은 폴더를 고른다(양성 대조).
      expect(resolveGit({ pathEnv: `${bin}:${process.env.PATH ?? ''}`, roots: [] })).toBe(path.join(bin, 'git'))
    } finally {
      fs.rmSync(path.join(root, 'tools'), { recursive: true, force: true })
      fs.rmSync(linked)
    }
  })
})
