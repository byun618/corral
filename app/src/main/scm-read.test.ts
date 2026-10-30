// LIFE-683 S7 — 소스 제어 diff 의 HEAD·인덱스 읽기: 가둠(열린 worktree · 경로 어휘)·ref 고정·상한·바이너리, 그리고 읽기가 `.git/index`·HEAD·refs 를 바꾸지 않는다
// (같은 회차 양성 대조 — `git add` 하면 index 도장이 바뀌는 것을 본다).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readScmContent, SCM_CHECK_ARGS, scmBlobArgs } from './scm-read.js'

let base = ''
let root = ''
const roots = (): string[] => [root]
const git = (...args: string[]): string => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' })

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l683-sr-')))
  root = path.join(base, 'wt')
  fs.mkdirSync(path.join(root, 'dir'), { recursive: true })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(root, 'a.ts'), 'head\n')
  fs.writeFileSync(path.join(root, 'dir', '한글 "q".ts'), 'korean head\n')
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]))
  fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(4096, 98))
  fs.writeFileSync(path.join(root, '-dash.ts'), 'dash\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  fs.writeFileSync(path.join(root, 'a.ts'), 'index\n')
  git('add', 'a.ts')
  fs.writeFileSync(path.join(root, 'a.ts'), 'working\n')
  fs.writeFileSync(path.join(root, 'added.ts'), 'new in index\n')
  git('add', 'added.ts')
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

const stamp = (): string => {
  const gitDir = path.join(root, '.git')
  const one = (file: string): string => {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}:${fs.readFileSync(file).toString('base64').length}`
    } catch {
      return '-'
    }
  }
  return [one(path.join(gitDir, 'index')), one(path.join(gitDir, 'HEAD')), one(path.join(gitDir, 'refs', 'heads', 'main')), String(fs.existsSync(path.join(gitDir, 'index.lock')))].join('|')
}

describe('readScmContent', () => {
  it('HEAD · 인덱스를 각각 읽는다(작업 파일과 다르다)', async () => {
    expect(await readScmContent({ roots: roots(), root, rel: 'a.ts', side: 'head' })).toEqual({ ok: true, kind: 'text', text: 'head\n', size: 5 })
    expect(await readScmContent({ roots: roots(), root, rel: 'a.ts', side: 'index' })).toEqual({ ok: true, kind: 'text', text: 'index\n', size: 6 })
  })
  it('공백·한글·따옴표·대시로 시작하는 경로', async () => {
    expect(await readScmContent({ roots: roots(), root, rel: 'dir/한글 "q".ts', side: 'head' })).toMatchObject({ ok: true, kind: 'text', text: 'korean head\n' })
    expect(await readScmContent({ roots: roots(), root, rel: '-dash.ts', side: 'index' })).toMatchObject({ ok: true, kind: 'text', text: 'dash\n' })
  })
  it('없는 쪽 = missing(인덱스 추가 파일의 HEAD · 없는 경로)', async () => {
    expect(await readScmContent({ roots: roots(), root, rel: 'added.ts', side: 'head' })).toEqual({ ok: true, kind: 'missing' })
    expect(await readScmContent({ roots: roots(), root, rel: 'added.ts', side: 'index' })).toMatchObject({ ok: true, kind: 'text', text: 'new in index\n' })
    expect(await readScmContent({ roots: roots(), root, rel: 'nope.ts', side: 'head' })).toEqual({ ok: true, kind: 'missing' })
    // 폴더(tree 객체)는 blob 이 아니다.
    expect(await readScmContent({ roots: roots(), root, rel: 'dir', side: 'head' })).toEqual({ ok: true, kind: 'missing' })
  })
  it('바이너리(NUL) · 상한 초과는 내용 없이', async () => {
    expect(await readScmContent({ roots: roots(), root, rel: 'bin.dat', side: 'head' })).toEqual({ ok: true, kind: 'binary', size: 3 })
    expect(await readScmContent({ roots: roots(), root, rel: 'big.txt', side: 'head', limit: 1024 })).toEqual({ ok: true, kind: 'too_large', size: 4096, limit: 1024 })
  })
  it('가둠 — 열린 worktree 아닌 루트 · 탈출 경로 · 절대 경로 · 모르는 side 는 거절', async () => {
    expect(await readScmContent({ roots: [], root, rel: 'a.ts', side: 'head' })).toMatchObject({ ok: false, code: 'not_worktree' })
    for (const rel of ['../x', 'dir/../../x', '/etc/passwd', '', 'a//b', 'a\0b', 7, 'a'.repeat(4097)]) expect(await readScmContent({ roots: roots(), root, rel, side: 'head' })).toMatchObject({ ok: false, code: 'bad_path' })
    for (const side of ['HEAD~1', 'main', '--output=/tmp/x', 'working', null]) expect(await readScmContent({ roots: roots(), root, rel: 'a.ts', side })).toMatchObject({ ok: false, code: 'bad_path' })
  })
  it('argv 는 고정 — 경로·ref 는 argv 에 없다(stdin), blob 은 hex oid 만', () => {
    expect(SCM_CHECK_ARGS).toEqual(['--no-optional-locks', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', '-z'])
    expect(scmBlobArgs('0'.repeat(40))).toEqual(['--no-optional-locks', 'cat-file', 'blob', '0'.repeat(40)])
  })
  it('쓰기 0 — 읽는 동안 index·HEAD·ref 도장 불변, 양성 대조로 `git add` 는 index 도장을 바꾼다', async () => {
    const before = stamp()
    for (let round = 0; round < 3; round += 1) {
      await readScmContent({ roots: roots(), root, rel: 'a.ts', side: 'index' })
      await readScmContent({ roots: roots(), root, rel: 'a.ts', side: 'head' })
    }
    expect(stamp()).toBe(before)
    git('add', 'a.ts')
    expect(stamp()).not.toBe(before)
  })
})
