// LIFE-829 — 소스 제어 로컬 쓰기: 실제 git·실제 `index.lock` 으로 본다(임시 레포만 — 사용자 레포에 쓰지 않는다).
// K1 stage·unstage · K2 추적 discard · K3 추적 안 함 휴지통(실패 주입) · K4 커밋 · K5 amend · K6 오류 원문 · K7 로그인 셸 PATH(주입) ·
// K8 lock 재시도(실제 lock 파일) · K9 루트 직렬 · K11 가둠·argv · K12 대기 중 대상 바뀜.
// fix r1: B1 추가 예정·이름 바꾸기 예정 = 휴지통 · B2 휴지통 대상 main 분류 · B3 부분 실패 안내 · B4 HEAD 판별 · B6 lock 재시도는 git exit 128 만.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveGit } from './file-list.js'
import {
  isLockError,
  LOCK_RETRY_DELAYS_MS,
  loginShellPath,
  SCM_ANY_CHANGE_ARGS,
  SCM_DISCARD_ARGS,
  SCM_HEAD_ARGS,
  SCM_STAGE_ALL_ARGS,
  SCM_STAGE_ARGS,
  SCM_STAGED_ARGS,
  SCM_CLASSIFY_ARGS,
  SCM_UNSTAGE_ARGS,
  SCM_UNSTAGE_UNBORN_ARGS,
  scmCommitArgs,
  scmConfirmSpec,
  ScmWriter,
  type ScmConfirmChoice,
  type ScmConfirmSpec,
  type ScmWriteDeps,
} from './scm-write.js'

const GIT = resolveGit({ pathEnv: process.env.PATH })
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l829-sw-')))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

let seq = 0
/** 새 임시 레포 — 사용자 이름·메일은 레포 설정(커밋이 `user.useConfigOnly=true` 라). */
function repo(options: { commit?: boolean } = {}): string {
  seq += 1
  const root = path.join(base, `r${seq}`)
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'tester')
  git(root, 'config', 'user.email', 'tester@example.invalid')
  if (options.commit !== false) {
    write(root, 'a.txt', 'a0\n')
    write(root, 'b.txt', 'b0\n')
    write(root, ':colon.txt', 'c0\n')
    write(root, 'colon.txt', 'plain0\n')
    write(root, 'old.txt', 'old0\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'base')
  }
  return root
}
const git = (root: string, ...args: string[]): string => execFileSync(GIT, ['-C', root, ...args], { encoding: 'utf8' })
const write = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const status = (root: string): string => git(root, 'status', '--porcelain=v1', '--untracked-files=all')
const head = (root: string, rev = 'HEAD'): string => git(root, 'rev-parse', rev).trim()
const hash = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

type Harness = { writer: ScmWriter; logs: { event: string; data: Record<string, unknown> }[]; asked: ScmConfirmSpec[]; trashed: string[]; refreshed: string[]; roots: string[] }
function harness(input: { roots: string[]; answers?: ScmConfirmChoice[]; over?: Partial<ScmWriteDeps> }): Harness {
  const logs: Harness['logs'] = []
  const asked: ScmConfirmSpec[] = []
  const trashed: string[] = []
  const refreshed: string[] = []
  const answers = [...(input.answers ?? [])]
  const roots = input.roots
  const writer = new ScmWriter({
    roots: () => roots,
    git: () => GIT,
    confirm: async (spec) => {
      asked.push(spec)
      return answers.shift() ?? 'cancel'
    },
    trashItem: async (abs) => {
      // 시험의 휴지통 = base/trash 로 옮긴다(진짜 ~/.Trash 는 최종 관문).
      const to = path.join(base, 'trash', `${trashed.length}-${path.basename(abs)}`)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(abs, to)
      trashed.push(to)
    },
    loginPath: async () => null,
    refresh: (root) => refreshed.push(root),
    log: (event, data = {}) => logs.push({ event, data }),
    retryDelays: [20, 20, 20],
    ...input.over,
  })
  return { writer, logs, asked, trashed, refreshed, roots }
}

describe('K11 — 가둠·argv 고정', () => {
  it('argv 는 고정 문자열 + --literal-pathspecs, 경로는 stdin(NUL)으로만', () => {
    expect(SCM_STAGE_ARGS).toEqual(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'])
    expect(SCM_UNSTAGE_ARGS).toEqual(['--literal-pathspecs', 'reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'])
    expect(SCM_UNSTAGE_UNBORN_ARGS).toEqual(['--literal-pathspecs', 'rm', '--cached', '-r', '-q', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'])
    expect(SCM_DISCARD_ARGS).toEqual(['--literal-pathspecs', 'checkout', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'])
    expect(SCM_STAGE_ALL_ARGS).toEqual(['--literal-pathspecs', 'add', '-A', '--', '.'])
    expect(scmCommitArgs({ amend: false, keepMessage: false })).toEqual(['--literal-pathspecs', '-c', 'user.useConfigOnly=true', 'commit', '--quiet', '-F', '-'])
    expect(scmCommitArgs({ amend: true, keepMessage: true })).toEqual(['--literal-pathspecs', '-c', 'user.useConfigOnly=true', 'commit', '--quiet', '--amend', '--no-edit'])
    expect(scmCommitArgs({ amend: true, keepMessage: false })).toEqual(['--literal-pathspecs', '-c', 'user.useConfigOnly=true', 'commit', '--quiet', '--amend', '-F', '-'])
    // 읽기는 lock 을 잡지 않는다.
    for (const args of [SCM_HEAD_ARGS, SCM_STAGED_ARGS, SCM_ANY_CHANGE_ARGS, SCM_CLASSIFY_ARGS]) expect(args[0]).toBe('--no-optional-locks')
  })
  it('열린 worktree 가 아닌 루트 · 형 위반 경로(../x·절대·NUL·빈 목록) · 모르는 동작 = git 실행 없이 거절', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    let gitCalls = 0
    const h = harness({
      roots: [root],
      over: {
        git: () => {
          gitCalls += 1
          return GIT
        },
      },
    })
    const before = status(root)
    const cases: [unknown, string][] = [
      [{ action: 'stage', root: path.join(base, 'elsewhere'), paths: ['a.txt'] }, 'not_worktree'],
      [{ action: 'stage', root, paths: ['../x'] }, 'bad_request'],
      [{ action: 'stage', root, paths: ['/etc/passwd'] }, 'bad_request'],
      [{ action: 'stage', root, paths: ['a\0b'] }, 'bad_request'],
      [{ action: 'stage', root, paths: [] }, 'bad_request'],
      [{ action: 'stage', root, paths: ['a/./b'] }, 'bad_request'],
      [{ action: 'discard', root, tracked: ['../../etc/hosts'], untracked: [] }, 'bad_request'],
      [{ action: 'push', root, paths: ['a.txt'] }, 'bad_request'],
      [{ action: 'stage', root, paths: ['a.txt'], args: ['--force'] }, 'ok'],
      [null, 'bad_request'],
    ]
    for (const [input, code] of cases) {
      const result = await h.writer.write(input)
      if (code === 'ok') expect(result.ok).toBe(true)
      else expect(result).toMatchObject({ ok: false, code })
    }
    // 마지막 ok 한 번만 git 을 불렀다(여분 필드 `args` 는 무시된다 — 렌더러가 argv 를 못 고른다).
    expect(gitCalls).toBe(1)
    expect(before).toBe(' M a.txt\n')
    expect(status(root)).toBe('M  a.txt\n')
  })
  it("`:` 로 시작하는 파일을 stage·discard 하면 그 파일만 바뀐다(pathspec 매직 아님)", async () => {
    const root = repo()
    write(root, ':colon.txt', 'c1\n')
    write(root, 'colon.txt', 'plain1\n')
    const h = harness({ roots: [root], answers: ['discardTracked'] })
    expect(await h.writer.write({ action: 'stage', root, paths: [':colon.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('M  :colon.txt\n M colon.txt\n')
    write(root, ':colon.txt', 'c2\n')
    expect(await h.writer.write({ action: 'discard', root, tracked: [':colon.txt'], untracked: [] })).toEqual({ ok: true })
    expect(read(root, ':colon.txt')).toBe('c1\n')
    expect(read(root, 'colon.txt')).toBe('plain1\n')
  })
})

describe('K1 — stage·unstage', () => {
  it('행 stage → 그 경로만 스테이지, unstage → 되돌림, 그룹 stage = 여러 경로, 다른 경로 무변화', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    write(root, 'b.txt', 'b1\n')
    write(root, 'u/new.txt', 'new\n')
    const h = harness({ roots: [root] })
    expect(await h.writer.write({ action: 'stage', root, paths: ['a.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('M  a.txt\n M b.txt\n?? u/new.txt\n')
    expect(await h.writer.write({ action: 'unstage', root, paths: ['a.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe(' M a.txt\n M b.txt\n?? u/new.txt\n')
    expect(await h.writer.write({ action: 'stage', root, paths: ['a.txt', 'b.txt', 'u/new.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('M  a.txt\nM  b.txt\nA  u/new.txt\n')
    expect(await h.writer.write({ action: 'unstage', root, paths: ['a.txt', 'b.txt', 'u/new.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe(' M a.txt\n M b.txt\n?? u/new.txt\n')
    // 쓰기마다 그 루트를 즉시 재조회한다(D14).
    expect(h.refreshed).toEqual([root, root, root, root])
  })
  it('추적 파일 삭제도 stage 된다(add -A)', async () => {
    const root = repo()
    fs.unlinkSync(path.join(root, 'b.txt'))
    const h = harness({ roots: [root] })
    expect(await h.writer.write({ action: 'stage', root, paths: ['b.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('D  b.txt\n')
  })
  it('HEAD 없는 레포에서도 unstage 된다(F3 — rm --cached, 작업 트리 파일은 그대로)', async () => {
    const root = repo({ commit: false })
    write(root, 'first.txt', 'one\n')
    const h = harness({ roots: [root] })
    expect(await h.writer.write({ action: 'stage', root, paths: ['first.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('A  first.txt\n')
    write(root, 'first.txt', 'one changed\n')
    expect(await h.writer.write({ action: 'unstage', root, paths: ['first.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('?? first.txt\n')
    expect(read(root, 'first.txt')).toBe('one changed\n')
  })
  it('이름 바뀜 unstage(새 + 원래 경로) 뒤 스테이지 그룹에 옛 경로 삭제가 남지 않는다(D4)', async () => {
    const root = repo()
    git(root, 'mv', 'old.txt', 'new-name.txt')
    expect(status(root)).toBe('R  old.txt -> new-name.txt\n')
    const h = harness({ roots: [root] })
    expect(await h.writer.write({ action: 'unstage', root, paths: ['new-name.txt', 'old.txt'] })).toEqual({ ok: true })
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(status(root)).toBe(' D old.txt\n?? new-name.txt\n')
  })
  it('병합 변경 stage = 늘 확인 — 취소면 무변화, 스테이지면 충돌 해결로 스테이지', async () => {
    const root = repo()
    git(root, 'checkout', '-q', '-b', 'other')
    write(root, 'a.txt', 'other\n')
    git(root, 'commit', '-q', '-am', 'other')
    git(root, 'checkout', '-q', 'main')
    write(root, 'a.txt', 'mine\n')
    git(root, 'commit', '-q', '-am', 'mine')
    try {
      git(root, 'merge', '-q', 'other')
    } catch {
      // 충돌 — 기대.
    }
    expect(status(root)).toBe('UU a.txt\n')
    const h = harness({ roots: [root], answers: ['cancel', 'stage'] })
    expect(await h.writer.write({ action: 'stageMerge', root, paths: ['a.txt'] })).toMatchObject({ ok: false, code: 'cancelled' })
    expect(status(root)).toBe('UU a.txt\n')
    expect(await h.writer.write({ action: 'stageMerge', root, paths: ['a.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('M  a.txt\n')
    expect(h.asked.map((spec) => [spec.kind, spec.options.message, spec.options.buttons])).toEqual([
      ['stageMerge', "'a.txt'을(를) 병합 충돌과 함께 스테이지할까요?", ['스테이지', '취소']],
      ['stageMerge', "'a.txt'을(를) 병합 충돌과 함께 스테이지할까요?", ['스테이지', '취소']],
    ])
  })
})

describe('K2·K3 — discard', () => {
  it('추적 파일: 취소 = git·파일 무변화(해시), 확인 = 인덱스 내용으로(스테이지된 내용은 남는다)', async () => {
    const root = repo()
    write(root, 'a.txt', 'staged\n')
    git(root, 'add', 'a.txt')
    write(root, 'a.txt', 'staged + working\n')
    const indexFile = path.join(root, '.git', 'index')
    const before = { status: status(root), file: hash(path.join(root, 'a.txt')), index: hash(indexFile), head: head(root) }
    const h = harness({ roots: [root], answers: ['cancel', 'discardTracked'] })
    expect(await h.writer.write({ action: 'discard', root, tracked: ['a.txt'], untracked: [] })).toMatchObject({ ok: false, code: 'cancelled' })
    expect({ status: status(root), file: hash(path.join(root, 'a.txt')), index: hash(indexFile), head: head(root) }).toEqual(before)
    expect(h.refreshed).toEqual([])
    expect(await h.writer.write({ action: 'discard', root, tracked: ['a.txt'], untracked: [] })).toEqual({ ok: true })
    expect(read(root, 'a.txt')).toBe('staged\n')
    expect(status(root)).toBe('M  a.txt\n')
    expect(h.asked[0]?.options).toMatchObject({ message: "'a.txt'의 변경 내용을 버릴까요?", buttons: ['파일 변경 버리기', '취소'] })
  })
  it('지워진 추적 파일 = 「복원」 문구, 확인하면 돌아온다', async () => {
    const root = repo()
    fs.unlinkSync(path.join(root, 'a.txt'))
    fs.unlinkSync(path.join(root, 'b.txt'))
    const h = harness({ roots: [root], answers: ['discardTracked'] })
    expect(await h.writer.write({ action: 'discard', root, tracked: ['a.txt', 'b.txt'], untracked: [] })).toEqual({ ok: true })
    expect(h.asked[0]?.options).toMatchObject({ message: '2개 파일을 복원할까요?', buttons: ['2개 파일 복원', '취소'] })
    expect(status(root)).toBe('')
  })
  it('섞임 — [추적 파일만]·[모두]·취소 갈래, 추적만이면 추적 안 함은 그대로, 모두면 휴지통으로(같은 내용)', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    write(root, 'u1.txt', 'untracked one\n')
    write(root, 'sub/u2.txt', 'untracked two\n')
    const h = harness({ roots: [root], answers: ['discardTracked', 'discardAll'] })
    expect(await h.writer.write({ action: 'discard', root, tracked: ['a.txt'], untracked: ['u1.txt', 'sub/u2.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('?? sub/u2.txt\n?? u1.txt\n')
    expect(h.trashed).toEqual([])
    expect(h.asked[0]?.choices).toEqual(['discardTracked', 'discardAll', 'cancel'])
    expect(h.asked[0]?.options.buttons).toEqual(['추적 파일 1개 버리기', '3개 파일 모두 버리기', '취소'])
    const hashes = [hash(path.join(root, 'u1.txt')), hash(path.join(root, 'sub/u2.txt'))]
    write(root, 'a.txt', 'a2\n')
    expect(await h.writer.write({ action: 'discard', root, tracked: ['a.txt'], untracked: ['u1.txt', 'sub/u2.txt'] })).toEqual({ ok: true })
    expect(status(root)).toBe('')
    expect(h.trashed.map((file) => hash(file))).toEqual(hashes)
    expect(h.logs.filter((entry) => entry.event === 'scm.write.trash').map((entry) => entry.data)).toEqual([{ root: expect.any(String), files: 2, failed: 0 }])
  })
  it('추적 안 함만 — 휴지통 문구, 휴지통 실패(주입)면 안내만 하고 파일은 그대로(안내도 「옮긴 파일 없음」)', async () => {
    const root = repo()
    write(root, 'u1.txt', 'keep me\n')
    const h = harness({
      roots: [root],
      answers: ['discardAll'],
      over: {
        trashItem: async () => {
          throw new Error('injected trash failure')
        },
      },
    })
    const result = await h.writer.write({ action: 'discard', root, tracked: [], untracked: ['u1.txt'] })
    expect(result).toMatchObject({ ok: false, code: 'trash_failed' })
    expect(!result.ok && result.error).toContain('injected trash failure')
    expect(!result.ok && result.error).toContain('휴지통으로 옮긴 파일 없음.')
    expect(read(root, 'u1.txt')).toBe('keep me\n')
    expect(h.asked[0]?.options).toMatchObject({ message: "추적하지 않는 파일 'u1.txt'을(를) 삭제할까요?", detail: '휴지통에서 복원할 수 있습니다.', buttons: ['휴지통으로 이동', '취소'] })
  })
  it('「추적 안 함」 으로 온 추적 파일은 휴지통으로 보내지 않는다', async () => {
    const root = repo()
    const h = harness({ roots: [root], answers: ['discardAll'] })
    expect(await h.writer.write({ action: 'discard', root, tracked: [], untracked: ['a.txt'] })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(read(root, 'a.txt')).toBe('a0\n')
    expect(h.trashed).toEqual([])
  })
  it('링크인 추적 안 함 = 링크 자체를 휴지통으로(가리키는 대상은 그대로)', async () => {
    const root = repo()
    const outside = path.join(base, `outside-${seq}.txt`)
    fs.writeFileSync(outside, 'outside\n')
    fs.symlinkSync(outside, path.join(root, 'link.txt'))
    const h = harness({ roots: [root], answers: ['discardAll'] })
    expect(await h.writer.write({ action: 'discard', root, tracked: [], untracked: ['link.txt'] })).toEqual({ ok: true })
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n')
    expect(fs.lstatSync(h.trashed[0] ?? '').isSymbolicLink()).toBe(true)
  })
  it('쓰기 모듈에 영구 삭제 경로가 없다(unlink·rm·git clean)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'scm-write.ts'), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
      .join('\n')
    expect(code).not.toMatch(/\bunlink|\brmSync|\brmdir|fs\.rm\b|\.rm\(|'clean'/)
    // `rm --cached`(인덱스에서만 빼기)만 있다 — HEAD 없는 unstage·휴지통으로 옮긴 추가 예정 항목 빼기가 같이 쓴다.
    expect(code.match(/'rm'/g)).toHaveLength(1)
    expect(code).toContain("'rm', '--cached'")
  })
})

describe('B1 — 추가 예정·이름 바꾸기 예정 discard = 휴지통 + 인덱스에서만 빼기', () => {
  it('추가 예정(add -N) — 휴지통 문구, 내용 해시가 휴지통 쪽에 있고 작업 트리·인덱스에서 사라진다', async () => {
    const root = repo()
    write(root, 'ita.txt', 'only copy of this content\n')
    git(root, 'add', '-N', 'ita.txt')
    expect(status(root)).toBe(' A ita.txt\n')
    const before = hash(path.join(root, 'ita.txt'))
    const h = harness({ roots: [root], answers: ['discardAll'] })
    expect(await h.writer.write({ action: 'discard', root, tracked: [], untracked: ['ita.txt'] })).toEqual({ ok: true })
    expect(h.asked[0]?.options).toMatchObject({ message: "추적하지 않는 파일 'ita.txt'을(를) 삭제할까요?", detail: '휴지통에서 복원할 수 있습니다.', buttons: ['휴지통으로 이동', '취소'] })
    expect(h.trashed.map((file) => hash(file))).toEqual([before])
    expect(fs.existsSync(path.join(root, 'ita.txt'))).toBe(false)
    expect(git(root, 'ls-files', '--cached', '--', 'ita.txt')).toBe('')
    expect(status(root)).toBe('')
  })
  it('이름 바꾸기 예정(mv + add -N) — 새 경로는 휴지통(내용 그대로), 원래 경로는 되돌아온다', async () => {
    const root = repo()
    const original = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('')
    write(root, 'old.txt', original)
    git(root, 'commit', '-q', '-am', 'long old')
    fs.renameSync(path.join(root, 'old.txt'), path.join(root, 'moved.txt'))
    fs.appendFileSync(path.join(root, 'moved.txt'), 'edited after move\n')
    git(root, 'add', '-N', 'moved.txt')
    expect(git(root, 'status', '--porcelain=v2', '-z', '--untracked-files=all').split('\0').slice(0, 2)).toEqual([expect.stringMatching(/^2 \.R /), 'old.txt'])
    const before = hash(path.join(root, 'moved.txt'))
    const h = harness({ roots: [root], answers: ['discardAll'] })
    // 렌더러가 만드는 요청 그대로(`discardRequest` 는 ScmView.write.test 가 고정).
    expect(await h.writer.write({ action: 'discard', root, tracked: ['old.txt'], untracked: ['moved.txt'] })).toEqual({ ok: true })
    expect(h.trashed.map((file) => hash(file))).toEqual([before])
    expect(read(root, 'old.txt')).toBe(original)
    expect(status(root)).toBe('')
  })
  it('휴지통 실패면 추가 예정 항목도 그대로(인덱스에서 빼지 않는다)', async () => {
    const root = repo()
    write(root, 'ita.txt', 'keep\n')
    git(root, 'add', '-N', 'ita.txt')
    const h = harness({
      roots: [root],
      answers: ['discardAll'],
      over: {
        trashItem: async () => {
          throw new Error('injected trash failure')
        },
      },
    })
    expect(await h.writer.write({ action: 'discard', root, tracked: [], untracked: ['ita.txt'] })).toMatchObject({ ok: false, code: 'trash_failed' })
    expect(read(root, 'ita.txt')).toBe('keep\n')
    expect(status(root)).toBe(' A ita.txt\n')
  })
})

describe('B2 — 휴지통 대상은 main 이 git 으로 분류한다', () => {
  it('.git·.git/config·무시된 폴더·그 아래 파일·무시된 파일·추적 파일·폴더·없는 경로 = git 쓰기·휴지통 없이 거절(추적 discard 도 하지 않는다)', async () => {
    const root = repo()
    write(root, '.gitignore', 'ign/\n*.log\n')
    git(root, 'add', '.gitignore')
    git(root, 'commit', '-q', '-m', 'ignore')
    write(root, 'ign/x.txt', 'ignored\n')
    write(root, 'build.log', 'log\n')
    write(root, 'dir/u.txt', 'untracked in dir\n')
    write(root, 'a.txt', 'a1\n')
    const indexFile = path.join(root, '.git', 'index')
    const h = harness({ roots: [root], answers: Array.from({ length: 12 }, (): ScmConfirmChoice => 'discardAll') })
    const before = { status: status(root), index: hash(indexFile), config: hash(path.join(root, '.git', 'config')), a: read(root, 'a.txt') }
    for (const rel of ['.git', '.git/config', '.GIT/config', 'ign', 'ign/x.txt', 'build.log', 'b.txt', 'dir', 'missing.txt']) {
      const result = await h.writer.write({ action: 'discard', root, tracked: ['a.txt'], untracked: [rel] })
      expect([rel, result]).toEqual([rel, { ok: false, code: 'bad_request', error: expect.any(String) }])
    }
    expect(h.trashed).toEqual([])
    expect({ status: status(root), index: hash(indexFile), config: hash(path.join(root, '.git', 'config')), a: read(root, 'a.txt') }).toEqual(before)
    expect(fs.existsSync(path.join(root, '.git'))).toBe(true)
    // 같은 요청에 정상 대상이 섞여도 하나가 어긋나면 그것도 옮기지 않는다.
    expect(await h.writer.write({ action: 'discard', root, tracked: [], untracked: ['dir/u.txt', 'build.log'] })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(read(root, 'dir/u.txt')).toBe('untracked in dir\n')
    // 정상 대상만이면 옮긴다.
    expect(await h.writer.write({ action: 'discard', root, tracked: [], untracked: ['dir/u.txt'] })).toEqual({ ok: true })
    expect(h.trashed).toHaveLength(1)
  })
})

describe('B3 — 휴지통 부분 실패 안내는 실제 결과를 말한다', () => {
  it('섞인 discard 에서 둘째 파일만 실패 — 옮긴 것·남은 것(이유)·되돌린 추적 파일을 적고, 파일 상태도 그대로 그렇다', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    write(root, 'u1.txt', 'one\n')
    write(root, 'u2.txt', 'two\n')
    write(root, 'u3.txt', 'three\n')
    let calls = 0
    const moved: string[] = []
    const h = harness({
      roots: [root],
      answers: ['discardAll'],
      over: {
        trashItem: async (abs) => {
          calls += 1
          if (calls === 2) throw new Error('injected second failure')
          const to = path.join(base, 'trash', `b3-${calls}-${path.basename(abs)}`)
          fs.mkdirSync(path.dirname(to), { recursive: true })
          fs.renameSync(abs, to)
          moved.push(to)
        },
      },
    })
    const result = await h.writer.write({ action: 'discard', root, tracked: ['a.txt'], untracked: ['u1.txt', 'u2.txt', 'u3.txt'] })
    expect(result).toMatchObject({ ok: false, code: 'trash_failed' })
    const text = result.ok ? '' : result.error
    expect(text).toBe(
      ['휴지통으로 옮김 2개:\nu1.txt\nu3.txt', '옮기지 못해 그대로 남음 1개:\nu2.txt: Error: injected second failure', '인덱스 내용으로 되돌린 추적 파일 1개:\na.txt'].join('\n\n'),
    )
    expect(text).not.toContain('그대로입니다')
    expect(read(root, 'a.txt')).toBe('a0\n')
    expect(read(root, 'u2.txt')).toBe('two\n')
    expect(fs.existsSync(path.join(root, 'u1.txt')) || fs.existsSync(path.join(root, 'u3.txt'))).toBe(false)
    expect(moved).toHaveLength(2)
    expect(h.refreshed).toEqual([root])
  })
})

describe('B4 — unstage 의 HEAD 판별은 exit 1 만 「HEAD 없음」', () => {
  it('rev-parse 만 128 로 실패시키는 래퍼 = git_error, 인덱스 무변화(rm --cached 로 넘어가지 않는다)', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    git(root, 'add', 'a.txt')
    const wrapper = path.join(base, `git-revparse-fails-${seq}`)
    fs.writeFileSync(wrapper, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = rev-parse ] && { echo "fatal: injected rev-parse failure" >&2; exit 128; }; done\nexec '${GIT}' "$@"\n`, { mode: 0o755 })
    const before = { status: status(root), index: hash(path.join(root, '.git', 'index')) }
    const h = harness({ roots: [root], over: { git: () => wrapper } })
    const result = await h.writer.write({ action: 'unstage', root, paths: ['a.txt'] })
    expect(result).toEqual({ ok: false, code: 'git_error', error: 'fatal: injected rev-parse failure' })
    expect({ status: status(root), index: hash(path.join(root, '.git', 'index')) }).toEqual(before)
    expect(status(root)).toBe('M  a.txt\n')
  })
})

describe('K4·K5 — 커밋·amend', () => {
  it('스테이지된 것만 커밋 — 메시지 그대로, 작업 트리 쪽 변경은 남는다', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    write(root, 'b.txt', 'b1\n')
    git(root, 'add', 'a.txt')
    const h = harness({ roots: [root] })
    const before = head(root)
    expect(await h.writer.write({ action: 'commit', root, message: '첫 줄\n\n본문 줄', amend: false })).toEqual({ ok: true })
    expect(head(root, 'HEAD^')).toBe(before)
    expect(git(root, 'log', '-1', '--format=%B')).toBe('첫 줄\n\n본문 줄\n\n')
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt\n')
    expect(status(root)).toBe(' M b.txt\n')
  })
  it('스테이지 없음 + 변경 있음 = 확인 — 취소면 무변화, 예면 추적 안 함 포함 전부 커밋', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    write(root, 'u/new.txt', 'new\n')
    const h = harness({ roots: [root], answers: ['cancel', 'commit'] })
    const before = { status: status(root), head: head(root) }
    expect(await h.writer.write({ action: 'commit', root, message: 'smart', amend: false })).toMatchObject({ ok: false, code: 'cancelled' })
    expect({ status: status(root), head: head(root) }).toEqual(before)
    expect(await h.writer.write({ action: 'commit', root, message: 'smart', amend: false })).toEqual({ ok: true })
    expect(status(root)).toBe('')
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt\nu/new.txt\n')
    expect(h.asked.map((spec) => [spec.kind, spec.options.message, spec.options.buttons])).toEqual([
      ['smartCommit', '스테이지된 변경이 없습니다. 모든 변경을 스테이지하고 바로 커밋할까요?', ['예', '취소']],
      ['smartCommit', '스테이지된 변경이 없습니다. 모든 변경을 스테이지하고 바로 커밋할까요?', ['예', '취소']],
    ])
  })
  it('변경 아예 없음 = 안내 + git 쓰기 0 · 빈 메시지 = 거절 + git 실행 0', async () => {
    const root = repo()
    let gitCalls = 0
    const h = harness({
      roots: [root],
      over: {
        git: () => {
          gitCalls += 1
          return GIT
        },
      },
    })
    const index = hash(path.join(root, '.git', 'index'))
    const before = head(root)
    expect(await h.writer.write({ action: 'commit', root, message: 'x', amend: false })).toMatchObject({ ok: false, code: 'nothing_to_commit' })
    expect(h.asked).toEqual([])
    expect(head(root)).toBe(before)
    expect(hash(path.join(root, '.git', 'index'))).toBe(index)
    gitCalls = 0
    write(root, 'a.txt', 'a1\n')
    git(root, 'add', 'a.txt')
    expect(await h.writer.write({ action: 'commit', root, message: '  \n ', amend: false })).toMatchObject({ ok: false, code: 'empty_message' })
    expect(gitCalls).toBe(0)
    expect(head(root)).toBe(before)
  })
  it('amend — 메시지 있음: 메시지·내용이 바뀌고 부모 그대로 · 빈 메시지: 직전 메시지 유지 · 스테이지 없음: 메시지만', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-q', '-m', 'second')
    const parent = head(root, 'HEAD^')
    const h = harness({ roots: [root] })
    write(root, 'b.txt', 'b1\n')
    git(root, 'add', 'b.txt')
    expect(await h.writer.write({ action: 'commit', root, message: 'second amended', amend: true })).toEqual({ ok: true })
    expect(head(root, 'HEAD^')).toBe(parent)
    expect(git(root, 'log', '-1', '--format=%B')).toBe('second amended\n\n')
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt\nb.txt\n')
    write(root, 'a.txt', 'a2\n')
    git(root, 'add', 'a.txt')
    expect(await h.writer.write({ action: 'commit', root, message: '', amend: true })).toEqual({ ok: true })
    expect(git(root, 'log', '-1', '--format=%B')).toBe('second amended\n\n')
    expect(git(root, 'show', 'HEAD:a.txt')).toBe('a2\n')
    const tree = git(root, 'rev-parse', 'HEAD^{tree}')
    expect(await h.writer.write({ action: 'commit', root, message: 'message only', amend: true })).toEqual({ ok: true })
    expect(git(root, 'rev-parse', 'HEAD^{tree}')).toBe(tree)
    expect(git(root, 'log', '-1', '--format=%B')).toBe('message only\n\n')
    expect(head(root, 'HEAD^')).toBe(parent)
  })
  it('HEAD 없는 레포의 amend = git 오류 원문', async () => {
    const root = repo({ commit: false })
    write(root, 'x.txt', 'x\n')
    git(root, 'add', 'x.txt')
    const h = harness({ roots: [root] })
    const result = await h.writer.write({ action: 'commit', root, message: 'm', amend: true })
    expect(result).toMatchObject({ ok: false, code: 'git_error' })
    expect(!result.ok && result.error).toMatch(/nothing to amend/i)
  })
})

describe('K6·K7 — 훅 실패 원문 · 로그인 셸 PATH(커밋 git 에만)', () => {
  /** 이 레포 훅 사본(`command -v gitleaks || exit 1`) — gitleaks 대신 시험용 가짜 도구 이름. + 실패 표지 변형 한 줄. */
  function hookRepo(): { root: string; bin: string } {
    const root = repo()
    const bin = path.join(base, `bin-${seq}`)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'fakeleaks'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.mkdirSync(path.join(root, '.githooks'))
    fs.writeFileSync(
      path.join(root, '.githooks', 'pre-commit'),
      [
        '#!/bin/sh',
        'command -v fakeleaks >/dev/null 2>&1 || { echo "pre-commit: fakeleaks 없음 — brew install fakeleaks" >&2; exit 1; }',
        'if git diff --cached | grep -q FAIL_HOOK; then echo "HOOK_FIXED_FAIL: FAIL_HOOK 표지가 있다" >&2; exit 1; fi',
        'exec fakeleaks',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    git(root, 'config', 'core.hooksPath', '.githooks')
    // 훅 파일 자체(표지 문자열 포함)는 커밋해 둔다 — 스마트 커밋이 그것까지 올려 표지에 걸리지 않게.
    git(root, '-c', 'core.hooksPath=/dev/null', 'add', '.githooks')
    git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'hooks')
    return { root, bin }
  }
  const MIN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

  it('최소 PATH 앱 + 로그인 셸 PATH 있음 = 훅 통과 커밋, 그 PATH 는 커밋 git 에만', async () => {
    const { root, bin } = hookRepo()
    // git 래퍼 — 부를 때마다 PATH 와 argv 를 적는다(그 뒤 진짜 git).
    const record = path.join(base, `argv-${seq}.log`)
    const wrapper = path.join(base, `gitwrap-${seq}.sh`)
    fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\t%s\\n' "$PATH" "$*" >> '${record}'\nexec '${GIT}' "$@"\n`, { mode: 0o755 })
    const loginPath = `${bin}:${MIN_PATH}`
    let lookups = 0
    const h = harness({
      roots: [root],
      answers: ['commit'],
      over: {
        git: () => wrapper,
        env: { ...process.env, PATH: MIN_PATH },
        loginPath: async () => {
          lookups += 1
          return loginPath
        },
      },
    })
    write(root, 'a.txt', 'a1\n')
    expect(await h.writer.write({ action: 'stage', root, paths: ['a.txt'] })).toEqual({ ok: true })
    expect(await h.writer.write({ action: 'commit', root, message: 'hooked', amend: false })).toEqual({ ok: true })
    expect(git(root, 'log', '-1', '--format=%s')).toBe('hooked\n')
    write(root, 'b.txt', 'b1\n')
    expect(await h.writer.write({ action: 'commit', root, message: 'smart hooked', amend: false })).toEqual({ ok: true })
    // 로그인 셸 조회는 성공값을 둔다(두 번째 커밋은 다시 묻지 않는다).
    expect(lookups).toBe(1)
    const lines = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => line.split('\t'))
    const commits = lines.filter(([, argv]) => argv?.includes(' commit '))
    expect(commits).toHaveLength(2)
    for (const [pathEnv, argv] of commits) {
      expect(pathEnv).toBe(loginPath)
      expect(argv).toContain('-c user.useConfigOnly=true commit --quiet')
    }
    // 커밋이 아닌 git(stage·읽기·스마트 커밋의 add)은 앱 PATH 그대로.
    const others = lines.filter(([, argv]) => !argv?.includes(' commit '))
    expect(others.length).toBeGreaterThanOrEqual(4)
    for (const [pathEnv] of others) expect(pathEnv).toBe(MIN_PATH)
    // 쓰기 argv 는 전부 --literal-pathspecs 를 단다.
    for (const [, argv] of lines.filter(([, argv]) => !argv?.includes('--no-optional-locks'))) expect(argv).toContain('--literal-pathspecs')
  })
  it('로그인 셸 조회 실패(주입) = 앱 PATH 로 실행 → 훅 오류 원문 · 입력은 그대로 둘 수 있게 실패로 답한다', async () => {
    const { root } = hookRepo()
    const h = harness({ roots: [root], over: { env: { ...process.env, PATH: MIN_PATH }, loginPath: async () => null } })
    write(root, 'a.txt', 'a1\n')
    git(root, 'add', 'a.txt')
    const before = head(root)
    const result = await h.writer.write({ action: 'commit', root, message: 'blocked', amend: false })
    expect(result).toMatchObject({ ok: false, code: 'git_error' })
    expect(!result.ok && result.error).toContain('pre-commit: fakeleaks 없음 — brew install fakeleaks')
    expect(head(root)).toBe(before)
    expect(h.logs.filter((entry) => entry.event === 'scm.write.login_path').map((entry) => entry.data.ok)).toEqual([false])
  })
  it('훅 실패 표지(변형 훅) = 고정 문구가 stderr 원문 그대로', async () => {
    const { root, bin } = hookRepo()
    const h = harness({ roots: [root], over: { env: { ...process.env, PATH: MIN_PATH }, loginPath: async () => `${bin}:${MIN_PATH}` } })
    write(root, 'a.txt', 'FAIL_HOOK\n')
    git(root, 'add', 'a.txt')
    const result = await h.writer.write({ action: 'commit', root, message: 'should fail', amend: false })
    expect(result).toMatchObject({ ok: false, code: 'git_error' })
    expect(!result.ok && result.error).toBe('HOOK_FIXED_FAIL: FAIL_HOOK 표지가 있다')
  })
  it('loginShellPath — 이 기계의 로그인 셸에서 절대 경로 PATH 를 얻는다 · 없는 셸이면 null', async () => {
    const value = await loginShellPath()
    expect(value).toMatch(/^\//)
    expect(value?.split(':')).toContain('/usr/bin')
    expect(await loginShellPath({ shell: path.join(base, 'no-such-shell') })).toBeNull()
  })
})

describe('K8 — index.lock 경합(실제 lock 파일)', () => {
  it('ⓐ lock 을 잡았다 재시도 창 안에 놓으면 성공 — 재시도 ≥ 1 이 로그에 찍힌다', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    const lock = path.join(root, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    const h = harness({ roots: [root], over: { retryDelays: LOCK_RETRY_DELAYS_MS } })
    const releasing = new Promise<void>((resolve) =>
      setTimeout(() => {
        fs.renameSync(lock, `${lock}.released`)
        resolve()
      }, 400),
    )
    const result = await h.writer.write({ action: 'stage', root, paths: ['a.txt'] })
    await releasing
    expect(result).toEqual({ ok: true })
    expect(status(root)).toBe('M  a.txt\n')
    const retries = h.logs.filter((entry) => entry.event === 'scm.write.retry')
    expect(retries.length).toBeGreaterThanOrEqual(1)
    expect(h.logs.find((entry) => entry.event === 'scm.write')?.data.retries).toBe(retries.length)
  })
  it('ⓑ 계속 잡으면 유한 시간(≤ 25 초) 뒤 원문 오류 · ⓒ lock 파일은 그대로', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    const lock = path.join(root, '.git', 'index.lock')
    fs.writeFileSync(lock, 'held by test\n')
    const h = harness({ roots: [root], over: { retryDelays: LOCK_RETRY_DELAYS_MS } })
    const startedAt = performance.now()
    const result = await h.writer.write({ action: 'stage', root, paths: ['a.txt'] })
    const seconds = (performance.now() - startedAt) / 1000
    expect(result).toMatchObject({ ok: false, code: 'git_error' })
    expect(!result.ok && isLockError(result.error)).toBe(true)
    expect(!result.ok && result.error).toContain("index.lock': File exists")
    expect(seconds).toBeLessThanOrEqual(25)
    expect(seconds).toBeGreaterThanOrEqual(19)
    expect(fs.readFileSync(lock, 'utf8')).toBe('held by test\n')
    expect(h.logs.filter((entry) => entry.event === 'scm.write.retry')).toHaveLength(10)
    console.log(`K8b elapsed=${seconds.toFixed(2)}s retries=10`)
  }, 40_000)
  it('lock 문구가 아닌 실패는 다시 돌지 않는다', async () => {
    const root = repo({ commit: false })
    const h = harness({ roots: [root] })
    const result = await h.writer.write({ action: 'commit', root, message: 'x', amend: true })
    expect(result).toMatchObject({ ok: false, code: 'git_error' })
    expect(h.logs.filter((entry) => entry.event === 'scm.write.retry')).toHaveLength(0)
  })
  it('B6 — 훅이 lock 문구를 내고 exit 1 이면 다시 돌지 않는다(훅 실행 1회 · 원문 오류)', async () => {
    const root = repo()
    const counter = path.join(base, `hook-count-${seq}`)
    fs.mkdirSync(path.join(root, '.hooks-lock'))
    fs.writeFileSync(
      path.join(root, '.hooks-lock', 'pre-commit'),
      `#!/bin/sh\necho run >> '${counter}'\necho "fatal: Unable to create '/x/.git/index.lock': File exists." >&2\necho "Another git process seems to be running in this repository" >&2\nexit 1\n`,
      { mode: 0o755 },
    )
    git(root, 'config', 'core.hooksPath', '.hooks-lock')
    write(root, 'a.txt', 'a1\n')
    git(root, 'add', 'a.txt')
    const h = harness({ roots: [root] })
    const result = await h.writer.write({ action: 'commit', root, message: 'x', amend: false })
    expect(result).toMatchObject({ ok: false, code: 'git_error' })
    expect(!result.ok && result.error).toContain('Another git process seems to be running')
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\n')
    expect(h.logs.filter((entry) => entry.event === 'scm.write.retry')).toHaveLength(0)
  })
})

describe('K9 — 앱 자신의 쓰기는 루트마다 직렬', () => {
  it('같은 루트에 동시 쓰기(모두 stage 연타·stage 직후 커밋) = 차례로 끝나고 lock 오류 없음, 대기가 로그에', async () => {
    const root = repo()
    for (let index = 0; index < 30; index += 1) write(root, `many/f${index}.txt`, `${index}\n`)
    write(root, 'a.txt', 'a1\n')
    const h = harness({ roots: [root], over: { retryDelays: [] } })
    const paths = Array.from({ length: 30 }, (_, index) => `many/f${index}.txt`)
    const results = await Promise.all([
      h.writer.write({ action: 'stage', root, paths }),
      h.writer.write({ action: 'stage', root, paths }),
      h.writer.write({ action: 'stage', root, paths: ['a.txt'] }),
      h.writer.write({ action: 'commit', root, message: 'burst', amend: false }),
    ])
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }])
    expect(status(root)).toBe('')
    expect(h.logs.filter((entry) => entry.event === 'scm.write.wait').length).toBeGreaterThanOrEqual(3)
    expect(h.logs.filter((entry) => entry.event === 'scm.write.retry')).toHaveLength(0)
  })
  it('다른 루트끼리는 서로 막지 않는다 — 한 루트가 lock 재시도 중이어도 다른 루트 쓰기가 먼저 끝난다', async () => {
    const blocked = repo()
    const free = repo()
    write(blocked, 'a.txt', 'a1\n')
    write(free, 'a.txt', 'a1\n')
    const lock = path.join(blocked, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    const h = harness({ roots: [blocked, free], over: { retryDelays: [100, 100, 100, 100, 100] } })
    const order: string[] = []
    const first = h.writer.write({ action: 'stage', root: blocked, paths: ['a.txt'] }).then((result) => order.push(`blocked:${result.ok}`))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const second = h.writer.write({ action: 'stage', root: free, paths: ['a.txt'] }).then((result) => order.push(`free:${result.ok}`))
    await Promise.all([first, second])
    expect(order).toEqual(['free:true', 'blocked:false'])
    expect(h.logs.filter((entry) => entry.event === 'scm.write.wait')).toHaveLength(0)
    fs.renameSync(lock, `${lock}.done`)
  })
})

describe('K12 — 대기 중 대상 바뀜', () => {
  it('확인 대화상자 대기 중 그 루트가 닫히면 git 없이 거절(누른 때 루트에만 쓴다)', async () => {
    const root = repo()
    const other = repo()
    write(root, 'a.txt', 'a1\n')
    write(other, 'a.txt', 'other1\n')
    let release: (choice: ScmConfirmChoice) => void = () => {}
    const h = harness({
      roots: [root, other],
      over: { confirm: () => new Promise<ScmConfirmChoice>((resolve) => (release = resolve)) },
    })
    const pending = h.writer.write({ action: 'discard', root, tracked: ['a.txt'], untracked: [] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    h.roots.splice(0, 1) // 사용자가 그 worktree 를 닫고 다른 것(other)을 본다.
    release('discardTracked')
    expect(await pending).toMatchObject({ ok: false, code: 'not_worktree' })
    expect(read(root, 'a.txt')).toBe('a1\n')
    expect(read(other, 'a.txt')).toBe('other1\n')
  })
  it('재시도 대기 중 루트가 닫히면 다시 돌지 않는다', async () => {
    const root = repo()
    write(root, 'a.txt', 'a1\n')
    const lock = path.join(root, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    const roots = [root]
    const h = harness({
      roots,
      over: {
        retryDelays: [50, 50, 50],
        sleep: async (ms) => {
          roots.splice(0, roots.length)
          await new Promise((resolve) => setTimeout(resolve, ms))
        },
      },
    })
    expect(await h.writer.write({ action: 'stage', root, paths: ['a.txt'] })).toMatchObject({ ok: false, code: 'not_worktree' })
    expect(h.logs.filter((entry) => entry.event === 'scm.write.retry')).toHaveLength(1)
    fs.renameSync(lock, `${lock}.done`)
    expect(status(root)).toBe(' M a.txt\n')
  })
})

describe('로그 — 경로·메시지 없이 동작·결과·루트 해시', () => {
  it('scm.write 로그 줄에 경로·메시지가 없다', async () => {
    const root = repo()
    write(root, 'secret-name.txt', 'x\n')
    const h = harness({ roots: [root], answers: ['commit'] })
    await h.writer.write({ action: 'commit', root, message: 'secret message', amend: false })
    const text = JSON.stringify(h.logs)
    expect(text).not.toContain('secret-name')
    expect(text).not.toContain('secret message')
    expect(text).not.toContain(root)
    expect(h.logs.find((entry) => entry.event === 'scm.write')?.data).toMatchObject({ action: 'commit', ok: true, code: null, retries: 0, waited: false, root: expect.stringMatching(/^[0-9a-f]{12}$/) })
  })
  it('확인 문구 — 여러 개·섞임 목록은 앞 10개 + 「외 N개」', () => {
    const files = Array.from({ length: 12 }, (_, index) => `f${index}.txt`)
    expect(scmConfirmSpec({ kind: 'discard', tracked: files, untracked: [], restore: false }).options).toMatchObject({
      message: '12개 파일의 변경 내용을 모두 버릴까요?',
      buttons: ['12개 파일 모두 버리기', '취소'],
    })
    expect(scmConfirmSpec({ kind: 'discard', tracked: [], untracked: files, restore: false }).options.detail).toContain('외 2개')
  })
})
