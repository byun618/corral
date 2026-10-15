// LIFE-593 E4·E7ⓓ·E8 — 전체 파일 목록(단위, 실제 git fixture). 오라클(01-criteria 「오라클」)과 집합이 같은지, 루트 가둠 양성 대조, 심은 git 미실행, 취소.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileLister, LS_LISTED, resolveGit } from './file-list.js'

let base = ''
let root = ''
let outside = ''
const git = (args: string[], cwd = root): string => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 })
const split = (text: string): string[] => text.split('\0').filter((item) => item !== '')

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
function oracle(includeIgnored: boolean): Set<string> {
  const deleted = new Set(split(git(['ls-files', '-z', '--deleted'])))
  const off = split(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).filter((rel) => !deleted.has(rel))
  if (!includeIgnored) return new Set(off)
  const ignored = split(git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).filter((rel) => !rel.split('/').slice(0, -1).some((part) => part === '.git' || part === 'node_modules'))
  return new Set([...off, ...ignored])
}

describe('E4 오라클 대조', () => {
  it('ⓐ 끔(기본) = 오라클(끔) — 집합이 같다', async () => {
    const result = await lister().list({ root, includeIgnored: false, requestId: 'a1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(new Set(result.files)).toEqual(oracle(false))
    expect(result.files).not.toContain('gone.ts')
    expect(result.files).toContain('src/new.ts')
    expect(result.files).toContain('forced.txt') // 추적 중인데 패턴에 걸린 파일
    expect(result.files).toContain('keep.log') // ! 부정
    expect(result.files).not.toContain('debug.log')
    expect(result.files).not.toContain('excluded-by-info.txt')
    expect(result.files).not.toContain('src/sub/local-only.txt') // 중첩 .gitignore
  })
  it('ⓑ 켬 = 오라클(켬), .git/·node_modules/ 는 켜도 빠진다', async () => {
    const result = await lister().list({ root, includeIgnored: true, requestId: 'b1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(new Set(result.files)).toEqual(oracle(true))
    expect(result.files).toContain('build/out.js')
    expect(result.files).toContain('debug.log')
    expect(result.files).toContain('src/sub/local-only.txt')
    expect(result.files.some((rel) => rel.split('/').includes('node_modules'))).toBe(false)
    expect(result.files.some((rel) => rel.startsWith('.git/'))).toBe(false)
  })
  it('ⓒ dotfile 은 목록에 든다', async () => {
    const result = await lister().list({ root, includeIgnored: false, requestId: 'c1' })
    expect(result.ok && result.files.includes('.github/workflows/ci.yml') && result.files.includes('.gitignore')).toBe(true)
  })
  it('E8ⓓ 링크는 그 자신 한 줄 — 밖을 가리키는 링크 폴더 안으로 따라가지 않는다. 응답은 루트 상대뿐', async () => {
    const result = await lister().list({ root, includeIgnored: true, requestId: 'd1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files).toContain('link-dir')
    expect(result.files.some((rel) => rel.startsWith('link-dir/'))).toBe(false)
    expect(result.files.some((rel) => rel.startsWith('link-outside-dir/') || rel.includes('secret.txt'))).toBe(false)
    for (const rel of result.files) {
      expect(rel.startsWith('/')).toBe(false)
      expect(rel.split('/')).not.toContain('..')
    }
  })
  it('E2ⓒ 한글 이름(NFC·NFD) 이 목록에 든다', async () => {
    const result = await lister().list({ root, includeIgnored: false, requestId: 'k1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files.map((rel) => rel.normalize('NFC'))).toEqual(expect.arrayContaining(['한글/파일.md', 'nfd/한글.md', 'with space/file name.md']))
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
    expect(result.ok && result.files.includes('--help') && result.files.includes('-rf')).toBe(true)
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
    expect(LS_LISTED).toEqual(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  })
})

describe('E7ⓓ 취소', () => {
  it('취소하면 cancelled 로 끝나고 진행 중 작업이 0 이다', async () => {
    const one = lister()
    const pending = one.list({ root, includeIgnored: true, requestId: 'cancel-me' })
    // confine(비동기) 뒤 등록되므로 한 틱 기다렸다 취소한다.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const cancelled = one.cancel('cancel-me')
    const result = await pending
    if (cancelled) expect(result).toMatchObject({ ok: false, code: 'cancelled' })
    expect(one.active).toBe(0)
  })
  it('cancelAll 뒤 진행 중 작업 0', async () => {
    const one = lister()
    const pending = Promise.all([one.list({ root, includeIgnored: true, requestId: 'p1' }), one.list({ root, includeIgnored: false, requestId: 'p2' })])
    await new Promise((resolve) => setTimeout(resolve, 5))
    one.cancelAll()
    await pending
    expect(one.active).toBe(0)
  })
})
