// LIFE-830 B2·B4·B7·B12 — base 결정 순서(부모 → baseRef → 기본 브랜치 사슬)·풀리지 않는 출처 건너뛰기·옵션 모양 값·argv 고정,
// 그리고 base 대비 목록이 오라클(`git diff --name-status -z -M --merge-base <base>` + status `?`)과 같은 집합인지 실제 git 저장소로 본다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeScmBase, gitRunner, OID, resolveScmBase, SCM_BASE_ORIGIN_HEAD_ARGS, scmBaseDiffArgs, scmBaseVerifyArgs, scmMergeBaseArgs, type GitRun } from './scm-base.js'
import { parseScmChanges, SCM_STATUS_LIMIT } from '../shared/scm.js'

let base = ''
beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l830-sb-')))
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

const gitIn =
  (root: string) =>
  (...args: string[]): string =>
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })

/** 새 저장소 — 첫 브랜치 `first`, 커밋 하나. */
function repo(name: string, first = 'main'): { root: string; git: (...args: string[]) => string; write: (rel: string, text: string) => void; commit: (message: string) => string } {
  const root = path.join(base, name)
  fs.mkdirSync(root, { recursive: true })
  const git = gitIn(root)
  git('init', '-q', '-b', first)
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  const commit = (message: string): string => {
    git('add', '-A')
    git('commit', '-q', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD').trim()
  }
  write('seed.txt', 'seed\n')
  commit('seed')
  return { root, git, write, commit }
}

/** 가짜 git — argv 를 적고 정해 둔 답을 준다. */
function fakeRun(answers: (args: string[]) => { ok: true; stdout: string } | { ok: false; code: number | null; error: string }): { run: GitRun; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async (args) => {
      calls.push(args)
      return answers(args)
    },
  }
}
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('resolveScmBase — 순서·argv (가짜 git)', () => {
  it('부모 브랜치가 풀리면 그것만 — symbolic-ref·사슬은 부르지 않는다, argv 고정', async () => {
    const fake = fakeRun((args) => (args.includes('rev-parse') ? { ok: true, stdout: `${A}\n` } : { ok: true, stdout: `${B}\n` }))
    const result = await resolveScmBase({ run: fake.run, parent: { branch: 'feature/x', head: A }, baseRef: 'dev' })
    expect(result).toEqual({ ok: true, info: { name: 'feature/x', source: 'parent', mergeBase: B } })
    expect(fake.calls).toEqual([scmBaseVerifyArgs('refs/heads/feature/x'), scmMergeBaseArgs(A)])
    expect(scmBaseVerifyArgs('refs/heads/feature/x')).toEqual(['--no-optional-locks', 'rev-parse', '--verify', '--quiet', '--end-of-options', 'refs/heads/feature/x^{commit}'])
    expect(scmMergeBaseArgs(A)).toEqual(['--no-optional-locks', 'merge-base', A, 'HEAD'])
    expect(SCM_BASE_ORIGIN_HEAD_ARGS).toEqual(['--no-optional-locks', 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    expect(scmBaseDiffArgs(B)).toEqual(['--no-optional-locks', '-c', 'core.quotePath=false', 'diff', '--raw', '-z', '-M', '--no-color', '--no-ext-diff', B, '--'])
  })
  it('풀리지 않는 출처는 건너뛴다 — 부모 → baseRef → origin/HEAD → origin/main → origin/master → main → master', async () => {
    const fake = fakeRun(() => ({ ok: false, code: 1, error: 'no' }))
    const result = await resolveScmBase({ run: fake.run, parent: { branch: 'gone', head: null }, baseRef: 'nope' })
    expect(result).toEqual({ ok: false, reason: 'no_base', error: expect.any(String) })
    expect(fake.calls).toEqual([
      scmBaseVerifyArgs('refs/heads/gone'),
      scmBaseVerifyArgs('nope'),
      SCM_BASE_ORIGIN_HEAD_ARGS,
      scmBaseVerifyArgs('refs/remotes/origin/main'),
      scmBaseVerifyArgs('refs/remotes/origin/master'),
      scmBaseVerifyArgs('refs/heads/main'),
      scmBaseVerifyArgs('refs/heads/master'),
    ])
  })
  it('git 에 넘기는 값 — 고정 문자열 · hex oid · `--end-of-options` 바로 뒤의 `^{commit}` ref 뿐, 전부 --no-optional-locks', async () => {
    const fake = fakeRun((args) => (args.includes('symbolic-ref') ? { ok: true, stdout: 'refs/remotes/origin/trunk\n' } : args.at(-1) === 'refs/remotes/origin/trunk^{commit}' ? { ok: true, stdout: `${A}\n` } : args.includes('merge-base') ? { ok: true, stdout: `${B}\n` } : { ok: false, code: 1, error: '' }))
    const result = await resolveScmBase({ run: fake.run, parent: { branch: null, head: 'not-hex' }, baseRef: '--output=/tmp/x' })
    expect(result).toEqual({ ok: true, info: { name: 'origin/trunk', source: 'default', mergeBase: B } })
    for (const call of fake.calls) {
      expect(call[0]).toBe('--no-optional-locks')
      const verifyAt = call.indexOf('--end-of-options')
      if (call.includes('rev-parse')) expect(call.slice(0, verifyAt + 1)).toEqual(['--no-optional-locks', 'rev-parse', '--verify', '--quiet', '--end-of-options'])
      if (call.includes('rev-parse')) expect(call[verifyAt + 1]).toMatch(/\^\{commit\}$/)
      if (call.includes('merge-base')) expect(call[2]).toMatch(OID)
    }
    // 분리된 HEAD 의 부모 head 가 hex 가 아니면 쓰지 않는다(git 에 넘기지 않는다).
    expect(fake.calls.some((call) => call.some((arg) => arg.includes('not-hex')))).toBe(false)
  })
  it('빈 값·줄바꿈 들어간 baseRef·브랜치 이름은 git 에 넘기지 않는다', async () => {
    const fake = fakeRun(() => ({ ok: false, code: 1, error: '' }))
    await resolveScmBase({ run: fake.run, parent: { branch: 'a\nb', head: null }, baseRef: '  ' })
    expect(fake.calls[0]).toEqual(SCM_BASE_ORIGIN_HEAD_ARGS)
  })
  it('merge-base exit 1 = 공통 조상 없음, 그 밖의 실패 = git_error, hex 아닌 출력 = git_error', async () => {
    const answer = (merge: { ok: true; stdout: string } | { ok: false; code: number | null; error: string }) => fakeRun((args) => (args.includes('merge-base') ? merge : { ok: true, stdout: `${A}\n` })).run
    expect(await resolveScmBase({ run: answer({ ok: false, code: 1, error: '' }), parent: null, baseRef: 'x' })).toMatchObject({ ok: false, reason: 'no_merge_base' })
    expect(await resolveScmBase({ run: answer({ ok: false, code: 128, error: 'fatal' }), parent: null, baseRef: 'x' })).toMatchObject({ ok: false, reason: 'git_error' })
    expect(await resolveScmBase({ run: answer({ ok: true, stdout: 'HEAD\n' }), parent: null, baseRef: 'x' })).toMatchObject({ ok: false, reason: 'git_error' })
  })
})

describe('resolveScmBase — 실제 git (B2 ⓐ~ⓔ · B7ⓒ)', () => {
  it('ⓐ 부모 worktree 브랜치 · 분리된 부모는 그 커밋', async () => {
    const r = repo('pa')
    r.git('branch', 'parent-branch')
    r.git('checkout', '-q', '-b', 'child')
    r.write('child.txt', 'c\n')
    r.commit('child')
    const fork = r.git('rev-parse', 'parent-branch').trim()
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: { branch: 'parent-branch', head: fork }, baseRef: null })).toEqual({ ok: true, info: { name: 'parent-branch', source: 'parent', mergeBase: fork } })
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: { branch: null, head: fork }, baseRef: 'main' })).toEqual({ ok: true, info: { name: fork.slice(0, 7), source: 'parent', mergeBase: fork } })
  })
  it('ⓑ 부모 없음 + baseRef · ⓔ 지워진 부모 브랜치는 baseRef 로 넘어간다', async () => {
    const r = repo('pb', 'trunk')
    const fork = r.git('rev-parse', 'HEAD').trim()
    r.git('branch', 'dev')
    r.git('checkout', '-q', '-b', 'work')
    r.commit('work')
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: null, baseRef: 'dev' })).toEqual({ ok: true, info: { name: 'dev', source: 'repo', mergeBase: fork } })
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: { branch: 'deleted-parent', head: null }, baseRef: 'dev' })).toMatchObject({ ok: true, info: { source: 'repo', name: 'dev' } })
  })
  it('ⓒ origin/HEAD 가 가리키는 ref 가 먼저(origin/main 보다) · ⓔ 없는 baseRef 는 건너뛴다', async () => {
    const r = repo('pc')
    const fork = r.git('rev-parse', 'HEAD').trim()
    r.git('update-ref', 'refs/remotes/origin/trunk', fork)
    r.git('update-ref', 'refs/remotes/origin/main', fork)
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    r.git('checkout', '-q', '-b', 'work')
    r.commit('work')
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: null, baseRef: 'no-such-ref' })).toEqual({ ok: true, info: { name: 'origin/trunk', source: 'default', mergeBase: fork } })
  })
  it("ⓒ' 원격 없음 + 로컬 main 만", async () => {
    const r = repo('pc2')
    r.git('checkout', '-q', '-b', 'work')
    r.commit('work')
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: null, baseRef: null })).toMatchObject({ ok: true, info: { name: 'main', source: 'default' } })
  })
  it('ⓓ 셋 다 없음 = no_base', async () => {
    const r = repo('pd', 'work')
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: null, baseRef: null })).toMatchObject({ ok: false, reason: 'no_base' })
  })
  it('B7ⓒ 옵션 모양 baseRef·부모 브랜치는 옵션으로 해석되지 않는다(파일이 생기지 않고 다음 출처로)', async () => {
    const r = repo('pe')
    r.git('checkout', '-q', '-b', 'work')
    const out = path.join(base, 'pe-output.txt')
    const result = await resolveScmBase({ run: gitRunner(r.root), parent: { branch: `--output=${out}`, head: null }, baseRef: `--output=${out}` })
    expect(result).toMatchObject({ ok: true, info: { name: 'main', source: 'default' } })
    expect(fs.existsSync(out)).toBe(false)
  })
  it('B9ⓑ 관련 없는 이력 = no_merge_base · B9ⓐ base 자체 = merge-base HEAD', async () => {
    const r = repo('pf')
    r.git('checkout', '-q', '--orphan', 'lonely')
    r.commit('lonely')
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: null, baseRef: 'main' })).toMatchObject({ ok: false, reason: 'no_merge_base' })
    r.git('checkout', '-q', 'main')
    expect(await resolveScmBase({ run: gitRunner(r.root), parent: null, baseRef: 'main' })).toEqual({ ok: true, info: { name: 'main', source: 'repo', mergeBase: r.git('rev-parse', 'HEAD').trim() } })
  })
})

describe('computeScmBase — 목록 = 오라클 집합 (B4)', () => {
  type Row = { status: string; rel: string; orig: string | null }
  const oracle = (r: { git: (...args: string[]) => string }, baseName: string): Row[] => {
    const rows: Row[] = []
    const records = r.git('-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '-M', '--merge-base', baseName).split('\0')
    for (let i = 0; i < records.length; i += 1) {
      const letter = records[i]?.[0]
      if (letter === undefined) continue
      if (letter === 'R') {
        rows.push({ status: 'R', orig: records[i + 1] ?? '', rel: records[i + 2] ?? '' })
        i += 2
      } else {
        rows.push({ status: letter, rel: records[i + 1] ?? '', orig: null })
        i += 1
      }
    }
    for (const record of r.git('-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all').split('\0')) if (record.startsWith('? ')) rows.push({ status: 'U', rel: record.slice(2), orig: null })
    return rows.sort((a, b) => a.rel.localeCompare(b.rel))
  }
  const LETTER: Record<string, string> = { ADDED: 'A', MODIFIED: 'M', DELETED: 'D', RENAMED: 'R', TYPE_CHANGED: 'T', UNTRACKED: 'U', BOTH_MODIFIED: 'U' }
  const listed = async (r: { root: string; git: (...args: string[]) => string }): Promise<Row[]> => {
    const status = parseScmChanges(r.git('-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all'))
    const result = await computeScmBase({ run: gitRunner(r.root), status, limit: SCM_STATUS_LIMIT, parent: null, baseRef: 'main' })
    if (!result.ok) throw new Error(result.error)
    expect(result.changes.every((change) => change.group === 'base')).toBe(true)
    expect(result.total).toBe(result.changes.length)
    return result.changes.map((change) => ({ status: LETTER[change.status] ?? change.status, rel: change.rel, orig: change.orig })).sort((a, b) => a.rel.localeCompare(b.rel))
  }

  it('커밋분·커밋 뒤 다시 고침·스테이지만·미스테이지만·추적 안 함·이름 바뀜·삭제·공백·한글 경로 — base 쪽에만 생긴 변경과 merge 한 변경은 없다', async () => {
    const r = repo('list')
    r.write('committed.txt', 'one\n')
    r.write('recommitted.txt', 'one\n')
    r.write('staged.txt', 'one\n')
    r.write('unstaged.txt', 'one\n')
    r.write('old name.txt', 'rename me\nwith enough lines\nto keep similarity\n')
    r.write('gone.txt', 'bye\n')
    r.commit('base files')
    r.git('checkout', '-q', '-b', 'feature')
    r.write('committed.txt', 'two\n')
    r.write('recommitted.txt', 'two\n')
    fs.mkdirSync(path.join(r.root, 'dir'))
    r.git('mv', 'old name.txt', 'dir/새 이름.txt')
    r.git('rm', '-q', 'gone.txt')
    r.write('dir/added 파일.txt', 'new\n')
    r.commit('feature work')
    r.write('recommitted.txt', 'three\n')
    r.write('staged.txt', 'two\n')
    r.git('add', 'staged.txt')
    r.write('unstaged.txt', 'two\n')
    r.write('untracked 한글.txt', 'u\n')
    // base 가 앞서 간다(다른 worktree 에서) — 그 변경은 목록에 없어야 한다.
    const mainWt = path.join(base, 'list-main')
    r.git('worktree', 'add', '-q', mainWt, 'main')
    const m = gitIn(mainWt)
    fs.writeFileSync(path.join(mainWt, 'main-only.txt'), 'm\n')
    fs.writeFileSync(path.join(mainWt, 'seed.txt'), 'seed changed on main\n')
    m('add', '-A')
    m('commit', '-q', '-m', 'main moves')
    const before = await listed(r)
    expect(before).toEqual(oracle(r, 'main'))
    expect(before.map((row) => row.rel)).not.toContain('main-only.txt')
    expect(before.map((row) => row.rel)).not.toContain('seed.txt')
    expect(before).toContainEqual({ status: 'R', rel: 'dir/새 이름.txt', orig: 'old name.txt' })
    expect(before).toContainEqual({ status: 'D', rel: 'gone.txt', orig: null })
    expect(before).toContainEqual({ status: 'A', rel: 'dir/added 파일.txt', orig: null })
    expect(before).toContainEqual({ status: 'U', rel: 'untracked 한글.txt', orig: null })
    for (const rel of ['committed.txt', 'recommitted.txt', 'staged.txt', 'unstaged.txt']) expect(before).toContainEqual({ status: 'M', rel, orig: null })
    // base 를 브랜치로 merge — merge-base 가 base 끝으로 옮겨 그 변경이 여전히 없다.
    r.git('add', '-A')
    r.git('commit', '-q', '-m', 'wip')
    r.git('merge', '-q', '--no-edit', 'main')
    const after = await listed(r)
    expect(after).toEqual(oracle(r, 'main'))
    expect(after.map((row) => row.rel)).not.toContain('main-only.txt')
  })
  it('상한 + 1 개까지만 싣고 전체 개수는 따로', async () => {
    const r = repo('limit')
    r.git('checkout', '-q', '-b', 'feature')
    for (let index = 0; index < 5; index += 1) r.write(`f${index}.txt`, 'x\n')
    r.commit('five')
    const status = parseScmChanges(r.git('status', '--porcelain=v2', '-z'))
    const result = await computeScmBase({ run: gitRunner(r.root), status, limit: 2, parent: null, baseRef: 'main' })
    expect(result).toMatchObject({ ok: true, total: 5 })
    expect(result.ok ? result.changes : []).toHaveLength(3)
  })
  it('B7ⓔ 읽기 전용 — 목록 전후 index·HEAD·refs 불변(양성 대조: git add 는 index 를 바꾼다)', async () => {
    const r = repo('ro')
    r.git('checkout', '-q', '-b', 'feature')
    r.write('a.txt', 'a\n')
    r.commit('a')
    r.write('a.txt', 'changed\n')
    const gitDir = path.join(r.root, '.git')
    const stamp = (): string =>
      ['index', 'HEAD', 'refs/heads/main', 'refs/heads/feature'].map((file) => {
        const stat = fs.statSync(path.join(gitDir, file))
        return `${stat.mtimeMs}:${stat.size}:${fs.readFileSync(path.join(gitDir, file)).toString('base64')}`
      }).join('|') + `|${fs.existsSync(path.join(gitDir, 'index.lock'))}`
    const before = stamp()
    const result = await computeScmBase({ run: gitRunner(r.root), status: [], limit: SCM_STATUS_LIMIT, parent: null, baseRef: 'main' })
    expect(result.ok).toBe(true)
    expect(stamp()).toBe(before)
    r.git('add', 'a.txt')
    expect(stamp()).not.toBe(before)
  })
})
