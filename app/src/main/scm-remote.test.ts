// LIFE-831 — 소스 제어 원격: 실제 git·실제 로컬 bare 원격으로 본다(임시 디렉터리만 — 사용자 레포·외부 서비스에 쓰지 않는다).
// K1 push · K2 브랜치 게시 · K3 pull · K4 fetch·진행·취소·상한(멈춘 ssh 원격) · K5 실패 안내(분류·자격 가림) · K6 env·argv·새 세션 ·
// K7 끝난 뒤 재조회 신호 · K8 루트 직렬 · K9 가둠·이름.
// 사용자 git 설정이 끼지 않게 픽스처·제품 git 모두 `GIT_CONFIG_GLOBAL`(빈 파일)·`GIT_CONFIG_NOSYSTEM=1` 로 돈다(시험 env — 제품 env 규칙은 K6 시험이 따로 고정).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { resolveGit } from './file-list.js'
import { ScmWriter, type ScmWriteDeps } from './scm-write.js'
import {
  SCM_FETCH_ARGS,
  SCM_REMOTE_KILL_GRACE_MS,
  SCM_REMOTE_SHUTDOWN_MS,
  SCM_REMOTE_TIMEOUT_MS,
  ScmRemote,
  clipErrorText,
  runRemoteGit,
  scmPublishArgs,
  scmPullArgs,
  scmPushArgs,
  scmRemoteEnv,
  type ScmRemoteDeps,
} from './scm-remote.js'
import { classifyRemoteError, isSafeRefName, maskCredentials, parseScmRemoteInput, scmRemoteMessage } from '../shared/scm-remote.js'

const REAL_GIT = resolveGit({ pathEnv: process.env.PATH })
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l831-sr-')))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
const globalConfig = path.join(base, 'gitconfig-empty')
fs.writeFileSync(globalConfig, '')
const ISOLATED = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }

// argv·env 키 기록 — 제품이 띄우는 git 은 이 감싸개를 거쳐 진짜 git 으로 exec 한다(같은 PID — 그룹 종료 대상 그대로).
const ARGV_LOG = path.join(base, 'argv.log')
const WRAPPER = path.join(base, 'git-wrap.sh')
fs.writeFileSync(WRAPPER, `#!/bin/sh\nprintf '%s\\t%s\\n' "$$" "$*" >> "$L831_ARGV_LOG"\nenv | cut -d= -f1 | sort > "$L831_ARGV_LOG.env.$$"\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 })

const fixtureEnv = { ...process.env, ...ISOLATED, GIT_TERMINAL_PROMPT: '0' }
const git = (cwd: string, ...args: string[]): string => execFileSync(REAL_GIT, ['-C', cwd, ...args], { encoding: 'utf8', env: fixtureEnv })
const gitCode = (cwd: string, ...args: string[]): number => spawnSync(REAL_GIT, ['-C', cwd, ...args], { env: fixtureEnv }).status ?? -1

let seq = 0
type Fixture = { dir: string; bare: string; work: string; other: string }
/** bare 원격 + 그것을 clone 한 시험 레포(`work`) + 갈라짐용 두 번째 clone(`other`). 초기 커밋은 `push -u origin main`. */
function fixture(): Fixture {
  seq += 1
  const dir = path.join(base, `f${seq}`)
  fs.mkdirSync(dir)
  const bare = path.join(dir, 'remote.git')
  execFileSync(REAL_GIT, ['init', '-q', '--bare', '-b', 'main', bare], { env: fixtureEnv })
  const work = path.join(dir, 'work')
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', work], { env: fixtureEnv })
  identity(work)
  fs.writeFileSync(path.join(work, 'a.txt'), 'a0\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base')
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', '-q', '-u', 'origin', 'main')
  const other = path.join(dir, 'other')
  execFileSync(REAL_GIT, ['clone', '-q', bare, other], { env: fixtureEnv })
  identity(other)
  return { dir, bare, work, other }
}
function identity(root: string): void {
  git(root, 'config', 'user.name', 'tester')
  git(root, 'config', 'user.email', 'tester@example.invalid')
}
const commit = (root: string, rel: string, text: string, message = rel): void => {
  fs.writeFileSync(path.join(root, rel), text)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}
const rev = (root: string, ref = 'HEAD'): string => git(root, 'rev-parse', ref).trim()
const bareRef = (bare: string, ref: string): string | null => (gitCode(bare, 'rev-parse', '--verify', '-q', ref) === 0 ? rev(bare, ref) : null)
const ab = (root: string): string => /# branch\.ab (.*)/.exec(git(root, 'status', '--porcelain=v2', '--branch'))?.[1] ?? ''
const hashFile = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const treeState = (root: string): string => `${rev(root)} ${hashFile(path.join(root, '.git', 'index'))} ${git(root, 'status', '--porcelain=v2', '--untracked-files=all')}`

type Harness = {
  remote: ScmRemote
  writer: ScmWriter
  logs: { event: string; data: Record<string, unknown> }[]
  spawns: { root: string; action: string; pid: number }[]
  refreshed: string[]
  statusChanged: string[]
  picks: { remotes: readonly string[]; branch: string }[]
}
function harness(input: {
  roots: string[]
  pick?: (remotes: readonly string[]) => string | null
  loginPath?: () => Promise<string | null>
  env?: NodeJS.ProcessEnv
  over?: Partial<ScmRemoteDeps>
  writerOver?: Partial<ScmWriteDeps>
}): Harness {
  const logs: Harness['logs'] = []
  const spawns: Harness['spawns'] = []
  const refreshed: string[] = []
  const statusChanged: string[] = []
  const picks: Harness['picks'] = []
  const env = input.env ?? { ...process.env, ...ISOLATED, L831_ARGV_LOG: ARGV_LOG }
  const log = (event: string, data: Record<string, unknown> = {}): void => {
    logs.push({ event, data })
  }
  const writer = new ScmWriter({
    roots: () => input.roots,
    git: () => WRAPPER,
    confirm: async () => 'commit',
    trashItem: async () => {},
    loginPath: input.loginPath ?? (async () => null),
    refresh: () => {},
    statusChanged: (root) => statusChanged.push(`commit:${root}`),
    log,
    env,
    ...input.writerOver,
  })
  const remote = new ScmRemote({
    writer,
    roots: () => input.roots,
    git: () => WRAPPER,
    pickRemote: async ({ remotes, branch }) => {
      picks.push({ remotes, branch })
      return input.pick === undefined ? null : input.pick(remotes)
    },
    refresh: (root) => refreshed.push(root),
    statusChanged: (root) => statusChanged.push(root),
    log,
    env,
    onSpawn: (spawned) => spawns.push(spawned),
    ...input.over,
  })
  return { remote, writer, logs, spawns, refreshed, statusChanged, picks }
}
/** 감싸개 기록에서 그 PID 의 argv(앞의 `-C <cwd>` 뺌). */
const argvOf = (pid: number): string[] => {
  const line = fs
    .readFileSync(ARGV_LOG, 'utf8')
    .split('\n')
    .find((item) => item.startsWith(`${pid}\t`))
  return (line ?? '').split('\t')[1]?.split(' ').slice(2) ?? []
}
const envKeysOf = (pid: number): string[] => fs.readFileSync(`${ARGV_LOG}.env.${pid}`, 'utf8').split('\n').filter((line) => line !== '')
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (check: () => boolean, ms = 5000): Promise<void> => {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor 시간 초과')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
/** 멈추는 원격 — ssh 모양 URL + 그 레포만 `core.sshCommand=sh -c 'sleep 600'`(F11 방식). upstream 도 그 원격으로. */
function hang(root: string): void {
  git(root, 'remote', 'add', 'hang', 'ssh://l831-hang.invalid/x.git')
  git(root, 'config', 'core.sshCommand', "sh -c 'sleep 600'")
  git(root, 'config', 'branch.main.remote', 'hang')
  git(root, 'config', 'branch.main.merge', 'refs/heads/main')
}

describe('argv·env 고정 (K1·K2·K3·K4ⓐ·K6ⓒ)', () => {
  it('동작마다 고정 모양 — 그 밖 플래그 없음, 상한 10 분·유예 1 초', () => {
    expect(SCM_FETCH_ARGS).toEqual(['fetch'])
    expect(scmPullArgs({ remote: 'origin', upstream: 'main' })).toEqual(['pull', 'origin', 'refs/heads/main'])
    expect(scmPushArgs({ remote: 'origin', branch: 'feat', upstream: 'main' })).toEqual(['push', 'origin', 'refs/heads/feat:refs/heads/main'])
    expect(scmPublishArgs({ remote: 'second', branch: 'feat' })).toEqual(['push', '-u', 'second', 'refs/heads/feat'])
    expect(SCM_REMOTE_TIMEOUT_MS).toBe(600_000)
    expect(SCM_REMOTE_KILL_GRACE_MS).toBe(1_000)
  })
  it('env 에 더하는 키 = PATH(로그인 셸 값이 있을 때)·GIT_TERMINAL_PROMPT·GIT_MERGE_AUTOEDIT·LC_ALL·LANG 뿐 — 사용자 ssh·자격 설정 키를 만들지 않는다', () => {
    const baseEnv = { PATH: '/usr/bin:/bin', HOME: '/h', SSH_AUTH_SOCK: '/s' }
    const added = (loginPath: string | null): string[] => {
      const env = scmRemoteEnv({ base: baseEnv, loginPath })
      return Object.keys(env)
        .filter((key) => env[key] !== Reflect.get(baseEnv, key))
        .sort()
    }
    expect(added('/opt/bin:/usr/bin')).toEqual(['GIT_MERGE_AUTOEDIT', 'GIT_TERMINAL_PROMPT', 'LANG', 'LC_ALL', 'PATH'])
    expect(added(null)).toEqual(['GIT_MERGE_AUTOEDIT', 'GIT_TERMINAL_PROMPT', 'LANG', 'LC_ALL'])
    const env = scmRemoteEnv({ base: baseEnv, loginPath: null })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_MERGE_AUTOEDIT).toBe('no')
    expect(Object.keys(env).filter((key) => /^GIT_(SSH|ASKPASS|CONFIG)|^SSH_ASKPASS/.test(key))).toEqual([])
  })
})

describe('K1 push', () => {
  it('upstream 있는 브랜치 — bare 의 upstream ref = 로컬 HEAD, 실제 argv 고정, 끝나면 목록·카드 재조회', async () => {
    const f = fixture()
    commit(f.work, 'b.txt', 'b\n')
    const h = harness({ roots: [f.work] })
    expect(await h.remote.run({ action: 'push', root: f.work })).toEqual({ ok: true })
    expect(bareRef(f.bare, 'refs/heads/main')).toBe(rev(f.work))
    expect(ab(f.work)).toBe('+0 -0')
    expect(h.spawns).toHaveLength(1)
    expect(argvOf(h.spawns[0]!.pid)).toEqual(['push', 'origin', 'refs/heads/main:refs/heads/main'])
    expect(h.refreshed).toEqual([f.work])
    expect(h.statusChanged).toEqual([f.work])
  })
  it('이름이 다른 upstream(feat → origin/main)도 그 upstream 으로 간다 — bare 에 feat ref 없음', async () => {
    const f = fixture()
    git(f.work, 'checkout', '-q', '-b', 'feat', '--track', 'origin/main')
    commit(f.work, 'c.txt', 'c\n')
    const h = harness({ roots: [f.work] })
    expect(await h.remote.run({ action: 'push', root: f.work })).toEqual({ ok: true })
    expect(bareRef(f.bare, 'refs/heads/main')).toBe(rev(f.work))
    expect(bareRef(f.bare, 'refs/heads/feat')).toBeNull()
    expect(argvOf(h.spawns[0]!.pid)).toEqual(['push', 'origin', 'refs/heads/feat:refs/heads/main'])
  })
  it('앞선 것 없음(ahead 0) — git 은 한 번 돌고 조용히 성공', async () => {
    const f = fixture()
    const h = harness({ roots: [f.work] })
    const result = await h.remote.run({ action: 'push', root: f.work })
    expect(result).toEqual({ ok: true })
    expect(h.spawns).toHaveLength(1)
    expect(scmRemoteMessage({ action: 'push', result })).toBeNull()
  })
})

describe('K2 브랜치 게시', () => {
  it('ⓐ 원격 1개 — push -u 로 bare 에 새 ref + branch.<b>.remote·merge, 고르기 없음', async () => {
    const f = fixture()
    git(f.work, 'checkout', '-q', '-b', 'newb')
    commit(f.work, 'n.txt', 'n\n')
    const h = harness({ roots: [f.work] })
    expect(await h.remote.run({ action: 'publish', root: f.work })).toEqual({ ok: true })
    expect(bareRef(f.bare, 'refs/heads/newb')).toBe(rev(f.work))
    expect(git(f.work, 'config', '--get', 'branch.newb.remote').trim()).toBe('origin')
    expect(git(f.work, 'config', '--get', 'branch.newb.merge').trim()).toBe('refs/heads/newb')
    expect(h.picks).toEqual([])
    expect(argvOf(h.spawns[0]!.pid)).toEqual(['push', '-u', 'origin', 'refs/heads/newb'])
    // 그 뒤 push 는 upstream 으로 간다(단추가 「밀어넣기」로 돌아온 상태).
    commit(f.work, 'n2.txt', 'n2\n')
    expect(await h.remote.run({ action: 'push', root: f.work })).toEqual({ ok: true })
    expect(bareRef(f.bare, 'refs/heads/newb')).toBe(rev(f.work))
  })
  it('ⓑ 원격 2개 — 고르기 목록 = git remote, 고른 원격에만 ref · 닫으면 git 0', async () => {
    const f = fixture()
    const second = path.join(f.dir, 'second.git')
    execFileSync(REAL_GIT, ['init', '-q', '--bare', '-b', 'main', second], { env: fixtureEnv })
    git(f.work, 'remote', 'add', 'second', second)
    git(f.work, 'checkout', '-q', '-b', 'pub2')
    const closed = harness({ roots: [f.work], pick: () => null })
    const cancelled = await closed.remote.run({ action: 'publish', root: f.work })
    expect(cancelled).toEqual({ ok: false, code: 'pick_cancelled', error: '취소됨' })
    expect(scmRemoteMessage({ action: 'publish', result: cancelled })).toBeNull()
    expect(closed.spawns).toEqual([])
    expect(closed.picks).toEqual([{ remotes: ['origin', 'second'], branch: 'pub2' }])
    const h = harness({ roots: [f.work], pick: () => 'second' })
    expect(await h.remote.run({ action: 'publish', root: f.work })).toEqual({ ok: true })
    expect(bareRef(second, 'refs/heads/pub2')).toBe(rev(f.work))
    expect(bareRef(f.bare, 'refs/heads/pub2')).toBeNull()
    expect(argvOf(h.spawns[0]!.pid)).toEqual(['push', '-u', 'second', 'refs/heads/pub2'])
  })
  it('ⓑ 고르기가 목록 밖 이름·옵션 모양을 돌려주면 git 없이 거절(K9)', async () => {
    const f = fixture()
    git(f.work, 'remote', 'add', 'second', path.join(f.dir, 'nowhere.git'))
    git(f.work, 'checkout', '-q', '-b', 'pub3')
    for (const evil of ['--upload-pack=touch /tmp/l831-evil', 'nosuch']) {
      const h = harness({ roots: [f.work], pick: () => evil })
      const result = await h.remote.run({ action: 'publish', root: f.work })
      expect(result.ok ? null : result.code).toBe('bad_name')
      expect(h.spawns).toEqual([])
    }
  })
  it('ⓒ 원격 0개 — 「원격이 없습니다」 + git 쓰기 0 · ⓓ 분리된 HEAD — 「브랜치를 체크아웃」 + git 0', async () => {
    const lone = path.join(base, `lone${++seq}`)
    execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', lone], { env: fixtureEnv })
    identity(lone)
    commit(lone, 'a.txt', 'a\n')
    const h = harness({ roots: [lone] })
    for (const action of ['publish', 'push', 'pull', 'fetch'] as const) {
      const result = await h.remote.run({ action, root: lone })
      expect(result.ok ? null : result.code).toBe('no_remote')
      expect(scmRemoteMessage({ action, result })?.text).toContain('원격이 없습니다')
    }
    expect(h.spawns).toEqual([])
    const f = fixture()
    git(f.work, 'checkout', '-q', '--detach')
    const d = harness({ roots: [f.work] })
    for (const action of ['publish', 'push', 'pull'] as const) {
      const result = await d.remote.run({ action, root: f.work })
      expect(result.ok ? null : result.code).toBe('detached')
      expect(scmRemoteMessage({ action, result })?.text).toContain('브랜치를 체크아웃')
    }
    expect(d.spawns).toEqual([])
    expect(d.statusChanged).toEqual([])
  })
})

describe('K3 pull', () => {
  it('ⓐ behind 만 — fast-forward, HEAD = upstream, argv 에 rebase·ff·tags·autostash 없음', async () => {
    const f = fixture()
    commit(f.other, 'o.txt', 'o\n')
    git(f.other, 'push', '-q')
    git(f.work, 'fetch', '-q')
    const h = harness({ roots: [f.work] })
    expect(await h.remote.run({ action: 'pull', root: f.work })).toEqual({ ok: true })
    expect(rev(f.work)).toBe(rev(f.work, '@{u}'))
    const argv = argvOf(h.spawns[0]!.pid)
    expect(argv).toEqual(['pull', 'origin', 'refs/heads/main'])
    expect(argv.some((arg) => /^--(no-)?rebase|^--ff|^--tags|^--autostash|^-c$/.test(arg))).toBe(false)
  })
  it('ⓑ 갈라짐 + pull.rebase 미설정 — git 이 거절, 분류 안내 + 원문, 상태 무변화(HEAD·인덱스·작업 트리)', async () => {
    const f = fixture()
    commit(f.other, 'o.txt', 'o\n')
    git(f.other, 'push', '-q')
    commit(f.work, 'w.txt', 'w\n')
    const before = treeState(f.work)
    const h = harness({ roots: [f.work] })
    const result = await h.remote.run({ action: 'pull', root: f.work })
    expect(result.ok ? null : result.code).toBe('git_error')
    const message = scmRemoteMessage({ action: 'pull', result })
    expect(message?.kind).toBe('error')
    expect(message?.text).toContain('끌어오기 방식')
    expect(message?.text).toContain('Need to specify how to reconcile divergent branches')
    expect(treeState(f.work)).toBe(before)
    // 실패해도 다시 읽는다(fetch 부분이 ref 를 바꿨을 수 있다 — D11).
    expect(h.statusChanged).toEqual([f.work])
  })
  it('ⓒ 갈라짐 + pull.rebase=false — merge 커밋(편집기 없이 — env GIT_MERGE_AUTOEDIT=no)', async () => {
    const f = fixture()
    commit(f.other, 'o.txt', 'o\n')
    git(f.other, 'push', '-q')
    commit(f.work, 'w.txt', 'w\n')
    git(f.work, 'config', 'pull.rebase', 'false')
    const h = harness({ roots: [f.work], env: { ...process.env, ...ISOLATED, L831_ARGV_LOG: ARGV_LOG, GIT_EDITOR: 'false', EDITOR: 'false' } })
    expect(await h.remote.run({ action: 'pull', root: f.work })).toEqual({ ok: true })
    expect(git(f.work, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
    expect(envKeysOf(h.spawns[0]!.pid)).toContain('GIT_MERGE_AUTOEDIT')
  })
  it('ⓓ 갈라짐 + pull.rebase=true — rebase 결과(선형, merge 커밋 없음)', async () => {
    const f = fixture()
    commit(f.other, 'o.txt', 'o\n')
    git(f.other, 'push', '-q')
    commit(f.work, 'w.txt', 'w\n')
    git(f.work, 'config', 'pull.rebase', 'true')
    const h = harness({ roots: [f.work] })
    expect(await h.remote.run({ action: 'pull', root: f.work })).toEqual({ ok: true })
    expect(git(f.work, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(2)
    expect(rev(f.work, 'HEAD~1')).toBe(rev(f.work, '@{u}'))
  })
  it('ⓔ upstream 없음 — 안내 + git 0 (push 도 같음 — 「브랜치 게시」 안내)', async () => {
    const f = fixture()
    git(f.work, 'checkout', '-q', '-b', 'nou')
    const h = harness({ roots: [f.work] })
    const pulled = await h.remote.run({ action: 'pull', root: f.work })
    expect(pulled.ok ? null : pulled.code).toBe('no_upstream')
    const pushed = await h.remote.run({ action: 'push', root: f.work })
    expect(scmRemoteMessage({ action: 'push', result: pushed })?.text).toContain('브랜치 게시')
    expect(h.spawns).toEqual([])
  })
})

describe('K4 fetch·진행·취소·상한', () => {
  it('ⓐ 가져오기 = git fetch(인자 없음) — other 가 push 한 커밋이 @{u} 에 들어오고 behind 가 는다', async () => {
    const f = fixture()
    commit(f.other, 'o.txt', 'o\n')
    git(f.other, 'push', '-q')
    expect(ab(f.work)).toBe('+0 -0')
    const h = harness({ roots: [f.work] })
    expect(await h.remote.run({ action: 'fetch', root: f.work })).toEqual({ ok: true })
    expect(rev(f.work, '@{u}')).toBe(rev(f.other))
    expect(ab(f.work)).toBe('+0 -1')
    expect(argvOf(h.spawns[0]!.pid)).toEqual(['fetch'])
  })

  for (const action of ['push', 'pull', 'fetch'] as const) {
    it(`ⓒ 멈춘 원격 ${action} — 취소 → 2 초 안에 그룹 0 · 「취소됨」 · lock·MERGE_HEAD 없음 · git status 0 · 취소 경로 로그`, async () => {
      const f = fixture()
      hang(f.work)
      commit(f.work, 'h.txt', 'h\n')
      const h = harness({ roots: [f.work] })
      const pending = h.remote.run({ action, root: f.work })
      await waitFor(() => h.spawns.length === 1)
      const pid = h.spawns[0]!.pid
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(groupAlive(pid)).toBe(true)
      // 새 세션 — 제어 터미널 없음(`??`), 그룹 리더 = 자기 자신(K6ⓑ 빠른 확인).
      const ps = execFileSync('ps', ['-o', 'tty=,pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/)
      expect(ps[0]).toBe('??')
      expect(ps[1]).toBe(String(pid))
      const startedAt = Date.now()
      expect(h.remote.cancel({ root: f.work })).toEqual({ ok: true })
      const result = await pending
      await waitFor(() => !groupAlive(pid), 2000)
      expect(Date.now() - startedAt).toBeLessThan(2000)
      expect(result.ok ? null : result.code).toBe('cancelled')
      expect(scmRemoteMessage({ action, result })?.text).toContain('취소했습니다')
      for (const name of ['index.lock', 'MERGE_HEAD', 'FETCH_HEAD.lock']) expect(fs.existsSync(path.join(f.work, '.git', name))).toBe(false)
      expect(gitCode(f.work, 'status')).toBe(0)
      expect(h.logs.filter((entry) => entry.event === 'scm.remote.cancel')).toHaveLength(1)
      expect(h.logs.find((entry) => entry.event === 'scm.remote.kill')?.data).toMatchObject({ action, reason: 'cancel', signal: 'SIGTERM' })
      expect(h.statusChanged).toEqual([f.work])
    }, 15_000)
  }

  it('ⓓ 상한(주입 1.5 초) — 상한 + 2 초 안에 같은 끝 상태 + 「시간 초과」', async () => {
    const f = fixture()
    hang(f.work)
    const h = harness({ roots: [f.work], over: { timeoutMs: 1500 } })
    const startedAt = Date.now()
    const result = await h.remote.run({ action: 'fetch', root: f.work })
    const pid = h.spawns[0]!.pid
    await waitFor(() => !groupAlive(pid), 2000)
    expect(Date.now() - startedAt).toBeLessThan(1500 + 2000)
    expect(result.ok ? null : result.code).toBe('timeout')
    expect(scmRemoteMessage({ action: 'fetch', result })?.text).toContain('시간 초과')
    expect(fs.existsSync(path.join(f.work, '.git', 'index.lock'))).toBe(false)
    expect(gitCode(f.work, 'status')).toBe(0)
    expect(h.logs.find((entry) => entry.event === 'scm.remote.kill')?.data).toMatchObject({ reason: 'timeout' })
  }, 15_000)

  it('ⓓ SIGTERM 을 무시하는 원격 — 유예 뒤 SIGKILL 로 그룹 0', async () => {
    const f = fixture()
    hang(f.work)
    git(f.work, 'config', 'core.sshCommand', "sh -c 'trap \"\" TERM; sleep 600'")
    const h = harness({ roots: [f.work], over: { graceMs: 300 } })
    const pending = h.remote.run({ action: 'fetch', root: f.work })
    await waitFor(() => h.spawns.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const pid = h.spawns[0]!.pid
    h.remote.cancel({ root: f.work })
    const result = await pending
    await waitFor(() => !groupAlive(pid), 2000)
    expect(result.ok ? null : result.code).toBe('cancelled')
    expect(h.logs.filter((entry) => entry.event === 'scm.remote.kill').map((entry) => entry.data.signal)).toEqual(['SIGTERM', 'SIGKILL'])
  }, 15_000)

  it('ⓑ 진행 중 같은 루트 원격 단추 연타 = git 1회(busy) · ⓔ 같은 루트 읽기·다른 루트 쓰기는 막히지 않는다 · K8ⓐ 같은 루트 stage 는 뒤에서 기다린다', async () => {
    const f = fixture()
    const g = fixture()
    hang(f.work)
    const h = harness({ roots: [f.work, g.work] })
    const pending = h.remote.run({ action: 'push', root: f.work })
    await waitFor(() => h.spawns.length === 1)
    for (const action of ['push', 'fetch', 'pull', 'publish'] as const) {
      const again = await h.remote.run({ action, root: f.work })
      expect(again.ok ? null : again.code).toBe('busy')
    }
    expect(h.spawns).toHaveLength(1)
    expect(h.remote.busy(f.work)).toBe(true)
    // 다른 루트의 쓰기는 기다리지 않는다(K8ⓑ).
    fs.writeFileSync(path.join(g.work, 'x.txt'), 'x\n')
    expect(await h.writer.write({ action: 'stage', root: g.work, paths: ['x.txt'] })).toEqual({ ok: true })
    // 같은 루트 읽기(큐 밖) — 목록 읽기 명령이 바로 돈다.
    expect(gitCode(f.work, 'status', '--porcelain=v2')).toBe(0)
    // 같은 루트 stage 는 원격 동작 뒤에서 기다린다(lock 오류 없이).
    fs.writeFileSync(path.join(f.work, 'y.txt'), 'y\n')
    let staged = false
    const stage = h.writer.write({ action: 'stage', root: f.work, paths: ['y.txt'] }).then((result) => {
      staged = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(staged).toBe(false)
    expect(h.logs.some((entry) => entry.event === 'scm.write.wait')).toBe(true)
    h.remote.cancel({ root: f.work })
    expect((await pending).ok).toBe(false)
    expect(await stage).toEqual({ ok: true })
    expect(git(f.work, 'diff', '--cached', '--name-only').trim()).toBe('y.txt')
  }, 15_000)

  it('큐에서 기다리던 원격 동작의 취소 — git 없이 빠지고, 결과는 앞 쓰기를 기다리지 않고 바로 온다(수정 r1 C8ⓑ)', async () => {
    const f = fixture()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({ roots: [f.work] })
    // 앞 쓰기가 큐를 잡고 있는 동안(로그인 PATH 조회를 붙잡아 둔다).
    const blocker = h.writer.enqueue(f.work, () => gate)
    const pending = h.remote.run({ action: 'fetch', root: f.work })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.remote.cancel({ root: f.work })).toEqual({ ok: true })
    // 앞 쓰기(gate)는 아직 안 끝났다 — 그래도 결과가 온다.
    const result = await pending
    expect(result.ok ? null : result.code).toBe('cancelled')
    expect(h.remote.busy(f.work)).toBe(false)
    release()
    await blocker
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(h.spawns).toEqual([])
    expect(h.logs.find((entry) => entry.event === 'scm.remote.cancel')?.data).toMatchObject({ running: false })
    expect(h.statusChanged).toEqual([])
  })
})

describe('K5 실패 안내', () => {
  it('push 거절 fetch first → 「끌어온 뒤 다시」, fetch 뒤 non-fast-forward 도 같은 문장', async () => {
    const f = fixture()
    commit(f.other, 'o.txt', 'o\n')
    git(f.other, 'push', '-q')
    commit(f.work, 'w.txt', 'w\n')
    const h = harness({ roots: [f.work] })
    const first = await h.remote.run({ action: 'push', root: f.work })
    expect(first.ok ? '' : first.error).toMatch(/fetch first/)
    expect(scmRemoteMessage({ action: 'push', result: first })?.text).toContain('끌어온 뒤 다시 밀어넣으세요')
    expect(await h.remote.run({ action: 'fetch', root: f.work })).toEqual({ ok: true })
    const second = await h.remote.run({ action: 'push', root: f.work })
    expect(second.ok ? '' : second.error).toMatch(/non-fast-forward/)
    expect(scmRemoteMessage({ action: 'push', result: second })?.text).toContain('끌어온 뒤 다시 밀어넣으세요')
    expect(bareRef(f.bare, 'refs/heads/main')).toBe(rev(f.other))
  })
  it('ⓔ dirty 겹침 — 안내, 작업 트리 무변화', async () => {
    const f = fixture()
    commit(f.other, 'a.txt', 'other\n')
    git(f.other, 'push', '-q')
    fs.writeFileSync(path.join(f.work, 'a.txt'), 'dirty\n')
    const before = treeState(f.work)
    const h = harness({ roots: [f.work] })
    const result = await h.remote.run({ action: 'pull', root: f.work })
    expect(scmRemoteMessage({ action: 'pull', result })?.text).toContain('작업 트리의 변경이 끌어올 변경과 겹칩니다')
    expect(fs.readFileSync(path.join(f.work, 'a.txt'), 'utf8')).toBe('dirty\n')
    expect(treeState(f.work)).toBe(before)
  })
  it('ⓕ merge 충돌 — 「충돌 1개」 안내, 충돌 파일 u 행·MERGE_HEAD 남음(앱이 abort 하지 않는다)', async () => {
    const f = fixture()
    commit(f.other, 'a.txt', 'other\n')
    git(f.other, 'push', '-q')
    commit(f.work, 'a.txt', 'mine\n')
    git(f.work, 'config', 'pull.rebase', 'false')
    const h = harness({ roots: [f.work] })
    const result = await h.remote.run({ action: 'pull', root: f.work })
    expect(scmRemoteMessage({ action: 'pull', result })?.text).toContain('충돌 1개 — 「병합 변경 사항」')
    expect(git(f.work, 'status', '--porcelain=v2')).toMatch(/^u UU .* a\.txt$/m)
    expect(fs.existsSync(path.join(f.work, '.git', 'MERGE_HEAD'))).toBe(true)
  })
  it('ⓖ rebase 충돌(pull.rebase=true) — rebase 멈춤 안내, rebase-merge 디렉터리 남음', async () => {
    const f = fixture()
    commit(f.other, 'a.txt', 'other\n')
    git(f.other, 'push', '-q')
    commit(f.work, 'a.txt', 'mine\n')
    git(f.work, 'config', 'pull.rebase', 'true')
    const h = harness({ roots: [f.work] })
    const result = await h.remote.run({ action: 'pull', root: f.work })
    expect(scmRemoteMessage({ action: 'pull', result })?.text).toContain('rebase 가 충돌로 멈췄습니다')
    expect(fs.existsSync(path.join(f.work, '.git', 'rebase-merge'))).toBe(true)
  })
  it('ⓗ 닿지 못함(.invalid 호스트) + URL 가짜 자격 — 프롬프트 없이 30 초 안, 화면·반환·로그 어디에도 비밀 0', async () => {
    const f = fixture()
    git(f.work, 'remote', 'set-url', 'origin', 'https://l831user:l831secret@l831-nohost.invalid/x.git')
    const h = harness({ roots: [f.work] })
    const startedAt = Date.now()
    const result = await h.remote.run({ action: 'fetch', root: f.work })
    expect(Date.now() - startedAt).toBeLessThan(30_000)
    expect(result.ok ? null : result.code).toBe('git_error')
    const message = scmRemoteMessage({ action: 'fetch', result })
    expect(message?.text).toContain('원격에 닿지 못했습니다')
    expect(JSON.stringify(result)).not.toContain('l831secret')
    expect(message?.text).not.toContain('l831secret')
    expect(JSON.stringify(h.logs)).not.toContain('l831secret')
    expect(JSON.stringify(h.logs)).not.toMatch(/origin|l831-nohost|main/)
  }, 35_000)
  it('분류 단위 — 인증·호스트 키·거절·갈라짐·dirty·충돌·rebase·네트워크, 모르면 null', () => {
    expect(classifyRemoteError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toContain('인증에 실패')
    expect(classifyRemoteError('remote: Invalid username or password.\nfatal: Authentication failed for')).toContain('인증에 실패')
    expect(classifyRemoteError('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.')).toContain('인증에 실패')
    expect(classifyRemoteError('Host key verification failed.\nfatal: Could not read from remote repository.')).toContain('호스트 키')
    expect(classifyRemoteError(' ! [rejected]        main -> main (fetch first)')).toContain('끌어온 뒤')
    expect(classifyRemoteError(' ! [remote rejected] main -> main (pre-receive hook declined)')).toContain('거절')
    expect(classifyRemoteError('CONFLICT (content): Merge conflict in a\nCONFLICT (add/add): Merge conflict in b')).toContain('충돌 2개')
    expect(classifyRemoteError('error: could not apply 1234... w\nhint: Resolve all conflicts manually')).toContain('rebase')
    expect(classifyRemoteError("fatal: unable to access 'https://x/': Could not resolve host: x")).toContain('닿지 못했습니다')
    expect(classifyRemoteError('L831_PREPUSH_NO_GITLEAKS\nerror: failed to push some refs')).toBeNull()
  })
  it('자격 가림 — scheme://user[:pass]@ 꼴만 가린다', () => {
    expect(maskCredentials("fatal: unable to access 'https://l831user:l831secret@h.invalid/x.git/'")).toBe("fatal: unable to access 'https://***@h.invalid/x.git/'")
    expect(maskCredentials('ssh://git@h/x · https://tok@h/y')).toBe('ssh://***@h/x · https://***@h/y')
    expect(maskCredentials('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    const message = scmRemoteMessage({ action: 'fetch', result: { ok: false, code: 'git_error', error: 'https://u:l831secret@h/ Could not resolve host' } })
    expect(message?.text).not.toContain('l831secret')
  })
})

describe('K6 로그인 셸 PATH (pre-push 훅)', () => {
  function hooked(): { f: Fixture; toolDir: string } {
    const f = fixture()
    fs.mkdirSync(path.join(f.work, '.githooks'))
    fs.writeFileSync(path.join(f.work, '.githooks', 'pre-push'), "#!/bin/sh\ncommand -v gitleaks >/dev/null || { echo 'L831_PREPUSH_NO_GITLEAKS' >&2; exit 1; }\n", { mode: 0o755 })
    git(f.work, 'config', 'core.hooksPath', '.githooks')
    commit(f.work, 'p.txt', 'p\n')
    const toolDir = path.join(f.dir, 'login-bin')
    fs.mkdirSync(toolDir)
    fs.writeFileSync(path.join(toolDir, 'gitleaks'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    return { f, toolDir }
  }
  const minimalEnv = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin', HOME: os.homedir(), ...ISOLATED, L831_ARGV_LOG: ARGV_LOG })
  it('ⓐ 최소 PATH 앱 + 로그인 셸 PATH(gitleaks 있음) — push 성공', async () => {
    const { f, toolDir } = hooked()
    const h = harness({ roots: [f.work], env: minimalEnv(), loginPath: async () => `${toolDir}:/usr/bin:/bin` })
    expect(await h.remote.run({ action: 'push', root: f.work })).toEqual({ ok: true })
    expect(bareRef(f.bare, 'refs/heads/main')).toBe(rev(f.work))
  })
  it('ⓐ 로그인 셸 조회 실패 — 앱 PATH 로 돌고 훅 실패 원문(L831_PREPUSH_NO_GITLEAKS)', async () => {
    const { f } = hooked()
    const h = harness({ roots: [f.work], env: minimalEnv(), loginPath: async () => null })
    const result = await h.remote.run({ action: 'push', root: f.work })
    expect(result.ok ? null : result.code).toBe('git_error')
    expect(scmRemoteMessage({ action: 'push', result })?.text).toContain('L831_PREPUSH_NO_GITLEAKS')
    expect(bareRef(f.bare, 'refs/heads/main')).not.toBe(rev(f.work))
  })
  it('ⓒ 실제 자식 env 키 — 시험 env 에 더해진 것은 GIT_TERMINAL_PROMPT·GIT_MERGE_AUTOEDIT·LC_ALL·LANG(+로그인 PATH) 뿐, argv 에 -c 없음', async () => {
    const f = fixture()
    commit(f.work, 'e.txt', 'e\n')
    const env = minimalEnv()
    const h = harness({ roots: [f.work], env, loginPath: async () => '/usr/bin:/bin:/usr/sbin' })
    expect(await h.remote.run({ action: 'push', root: f.work })).toEqual({ ok: true })
    const pid = h.spawns[0]!.pid
    const keys = envKeysOf(pid).filter((key) => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(key))
    expect(keys.filter((key) => !(key in env)).sort()).toEqual(['GIT_MERGE_AUTOEDIT', 'GIT_TERMINAL_PROMPT', 'LANG', 'LC_ALL'])
    expect(argvOf(pid)).not.toContain('-c')
  })
})

describe('K7·K9 재조회 신호·가둠', () => {
  it('K9 열린 worktree 아님·모르는 동작·형 위반 — git 없이 거절', async () => {
    const f = fixture()
    const h = harness({ roots: [] })
    const closed = await h.remote.run({ action: 'push', root: f.work })
    expect(closed.ok ? null : closed.code).toBe('not_worktree')
    const open = harness({ roots: [f.work] })
    for (const raw of [{ action: 'push --force', root: f.work }, { action: 'fetch' }, null, { action: 'fetch', root: '' }]) {
      const result = await open.remote.run(raw)
      expect(result.ok ? null : result.code).toBe('bad_request')
    }
    expect(h.spawns).toEqual([])
    expect(open.spawns).toEqual([])
    expect(parseScmRemoteInput({ action: 'publish', root: '/r', remote: '--evil' })).toEqual({ action: 'publish', root: '/r' })
  })
  it('K9 이름 모양 — `-` 시작·공백·제어 문자·`:` 거절', () => {
    for (const ok of ['origin', 'feat/x', 'a.b-c_d']) expect(isSafeRefName(ok)).toBe(true)
    for (const bad of ['', '-x', '--upload-pack=x', 'a b', 'a:b', 'a\nb', 'a\0b']) expect(isSafeRefName(bad)).toBe(false)
  })
  it('K7 커밋·amend 성공 뒤 그 경로 상태 재조회 신호(실패·거절은 없음) · 로그에 경로·메시지 없음', async () => {
    const f = fixture()
    const h = harness({ roots: [f.work] })
    fs.writeFileSync(path.join(f.work, 'k.txt'), 'k\n')
    await h.writer.write({ action: 'stage', root: f.work, paths: ['k.txt'] })
    expect(await h.writer.write({ action: 'commit', root: f.work, message: 'k7', amend: false })).toEqual({ ok: true })
    expect(await h.writer.write({ action: 'commit', root: f.work, message: '', amend: true })).toEqual({ ok: true })
    expect(await h.writer.write({ action: 'commit', root: f.work, message: '', amend: false })).toMatchObject({ ok: false, code: 'empty_message' })
    expect(h.statusChanged).toEqual([`commit:${f.work}`, `commit:${f.work}`])
    expect(ab(f.work)).toBe('+1 -0')
  })
})

describe('수정 r1', () => {
  it('C2 브랜치와 같은 이름 태그가 있어도 push·pull·게시가 그 브랜치·upstream 으로 간다', async () => {
    const f = fixture()
    git(f.work, 'tag', 'main')
    commit(f.other, 'o.txt', 'o\n')
    git(f.other, 'push', '-q')
    const h = harness({ roots: [f.work] })
    expect(await h.remote.run({ action: 'pull', root: f.work })).toEqual({ ok: true })
    expect(rev(f.work)).toBe(rev(f.other))
    commit(f.work, 'w.txt', 'w\n')
    expect(await h.remote.run({ action: 'push', root: f.work })).toEqual({ ok: true })
    expect(bareRef(f.bare, 'refs/heads/main')).toBe(rev(f.work))
    git(f.work, 'checkout', '-q', '-b', 'rel')
    git(f.work, 'tag', 'rel')
    expect(await h.remote.run({ action: 'publish', root: f.work })).toEqual({ ok: true })
    expect(bareRef(f.bare, 'refs/heads/rel')).toBe(rev(f.work))
    expect(git(f.work, 'config', '--get', 'branch.rel.merge').trim()).toBe('refs/heads/rel')
    expect(h.spawns.map((spawned) => argvOf(spawned.pid))).toEqual([
      ['pull', 'origin', 'refs/heads/main'],
      ['push', 'origin', 'refs/heads/main:refs/heads/main'],
      ['push', '-u', 'origin', 'refs/heads/rel'],
    ])
  })

  it('C3 앱 종료 — 도는 원격 git 그룹을 끝내고(잔존 0) 상한 안에 돌아온다 · 기다리던 동작은 git 없이 · 종료 뒤 새 동작은 받지 않는다', async () => {
    const f = fixture()
    const g2 = fixture()
    hang(f.work)
    git(f.work, 'config', 'core.sshCommand', "sh -c 'trap \"\" TERM; sleep 600'") // SIGTERM 을 무시하는 그룹원 — SIGKILL 까지 가야 끝난다
    const h = harness({ roots: [f.work, g2.work] })
    const running = h.remote.run({ action: 'fetch', root: f.work })
    await waitFor(() => h.spawns.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const pid = h.spawns[0]!.pid
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocker = h.writer.enqueue(g2.work, () => gate)
    const queued = h.remote.run({ action: 'fetch', root: g2.work })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const startedAt = Date.now()
    await h.remote.shutdown()
    expect(Date.now() - startedAt).toBeLessThanOrEqual(SCM_REMOTE_SHUTDOWN_MS + 200)
    expect(groupAlive(pid)).toBe(false)
    expect((await running).ok ? null : 'cancelled').toBe('cancelled')
    expect((await queued).ok ? null : 'cancelled').toBe('cancelled')
    release()
    await blocker
    expect(h.spawns).toHaveLength(1)
    const after = await h.remote.run({ action: 'fetch', root: g2.work })
    expect(after.ok ? null : after.code).toBe('cancelled')
    expect(h.spawns).toHaveLength(1)
    expect(h.logs.find((entry) => entry.event === 'scm.remote.shutdown')?.data).toMatchObject({ running: 1 })
    expect(h.logs.filter((entry) => entry.event === 'scm.remote.kill').map((entry) => `${String(entry.data.reason)}:${String(entry.data.signal)}`)).toEqual(['shutdown:SIGTERM', 'shutdown:SIGKILL'])
    expect(fs.existsSync(path.join(f.work, '.git', 'index.lock'))).toBe(false)
  }, 15_000)

  it('C3 상한 — 그룹이 안 죽어도 shutdown 은 상한에서 돌아온다(무기한 기다리지 않는다)', async () => {
    const f = fixture()
    hang(f.work)
    const h = harness({ roots: [f.work] })
    const running = h.remote.run({ action: 'fetch', root: f.work })
    await waitFor(() => h.spawns.length === 1)
    const pid = h.spawns[0]!.pid
    // SIGTERM·SIGKILL 이 닿지 않는 것처럼 — 신호 보내기를 막는다(존재 확인 0 은 그대로).
    const real = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => (signal === 0 || signal === undefined ? real(target, signal) : true))
    const startedAt = Date.now()
    await h.remote.shutdown(400)
    const ms = Date.now() - startedAt
    spy.mockRestore()
    expect(ms).toBeGreaterThanOrEqual(350)
    expect(ms).toBeLessThan(1500)
    expect(groupAlive(pid)).toBe(true)
    real(-pid, 'SIGKILL')
    await running
    await waitFor(() => !groupAlive(pid), 2000)
  }, 15_000)

  it('C5 pull.rebase=true + 작업 트리 변경 — 「작업 트리의 변경이 …」 안내, 작업 트리 무변화', async () => {
    const f = fixture()
    commit(f.other, 'o.txt', 'o\n')
    git(f.other, 'push', '-q')
    git(f.work, 'config', 'pull.rebase', 'true')
    fs.writeFileSync(path.join(f.work, 'a.txt'), 'dirty\n')
    const before = treeState(f.work)
    const h = harness({ roots: [f.work] })
    const result = await h.remote.run({ action: 'pull', root: f.work })
    expect(result.ok ? '' : result.error).toMatch(/cannot pull with rebase|unstaged changes/)
    expect(scmRemoteMessage({ action: 'pull', result })?.text).toContain('작업 트리의 변경이 끌어올 변경과 겹칩니다')
    expect(treeState(f.work)).toBe(before)
  })

  it('C4 분류 — HTTP 401/403 은 권한·자격 문장, `unable to access` 단독은 분류 없음 · C5 dirty rebase 문구', () => {
    expect(classifyRemoteError("fatal: unable to access 'https://h/x.git/': The requested URL returned error: 403")).toContain('HTTP 401/403')
    expect(classifyRemoteError("fatal: unable to access 'https://h/x.git/': The requested URL returned error: 401")).toContain('HTTP 401/403')
    expect(classifyRemoteError("fatal: unable to access 'https://h/x.git/': SSL certificate problem: unable to get local issuer certificate")).toBeNull()
    expect(classifyRemoteError("fatal: unable to access 'https://h/x.git/': Could not resolve host: h")).toContain('닿지 못했습니다')
    expect(classifyRemoteError('error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.')).toContain('작업 트리의 변경')
    expect(classifyRemoteError('error: cannot pull with rebase: Your index contains uncommitted changes.')).toContain('작업 트리의 변경')
  })

  it('C9 긴 훅 출력 — 꼬리(원인 줄)가 남고 상한 안, 분류는 자르기 전 전체로(hint)', async () => {
    const f = fixture()
    fs.mkdirSync(path.join(f.work, '.githooks'))
    // 앞에 CONFLICT 모양 줄(앞쪽 — 분류 대상)을 두고 40KB 출력 뒤 원인 줄로 끝낸다.
    fs.writeFileSync(path.join(f.work, '.githooks', 'pre-push'), "#!/bin/sh\necho 'CONFLICT (content): hook says' >&2\nawk 'BEGIN{for(i=0;i<800;i++) print \"hook-noise-line-0123456789-0123456789-0123456789\"}' >&2\necho 'L831_TAIL_REASON' >&2\nexit 1\n", { mode: 0o755 })
    git(f.work, 'config', 'core.hooksPath', '.githooks')
    commit(f.work, 't.txt', 't\n')
    const h = harness({ roots: [f.work] })
    const result = await h.remote.run({ action: 'push', root: f.work })
    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain('L831_TAIL_REASON')
    expect(error).toContain('줄임')
    expect(error.length).toBeLessThan(16 * 1024 + 100)
    expect(result.ok ? undefined : result.hint).toContain('충돌 1개')
    expect(clipErrorText('x'.repeat(100))).toBe('x'.repeat(100))
    const clipped = clipErrorText(`HEAD${'m'.repeat(40_000)}TAIL`)
    expect(clipped.startsWith('HEAD')).toBe(true)
    expect(clipped.endsWith('TAIL')).toBe(true)
    // hint 가 있으면 문구는 그것을 쓴다(null 이면 분류 문장 없이 원문만).
    expect(scmRemoteMessage({ action: 'push', result: { ok: false, code: 'git_error', error: 'Could not resolve host', hint: null } })?.text).toBe('Could not resolve host')
  })

  it('C8ⓐ 정상 종료(exit 0)가 먼저면 끝 무렵 온 취소가 성공을 「취소」로 바꾸지 않는다', async () => {
    const f = fixture()
    const fake = path.join(f.dir, 'git-fetch-ignore-term.sh')
    // fetch 만: SIGTERM 을 무시하고 0.4 초 뒤 exit 0(취소가 와도 정상 종료) — 그 밖은 진짜 git.
    fs.writeFileSync(fake, `#!/bin/sh\nif [ "$3" = fetch ]; then trap '' TERM; sleep 0.4; exit 0; fi\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 })
    const h = harness({ roots: [f.work], over: { git: () => fake, graceMs: 5000 } })
    const pending = h.remote.run({ action: 'fetch', root: f.work })
    await waitFor(() => h.spawns.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    h.remote.cancel({ root: f.work })
    expect(await pending).toEqual({ ok: true })
  }, 15_000)

  it('C7 그룹이 이미 없으면 결과 뒤 유예 SIGKILL 타이머를 지운다(그 뒤 그룹 신호 0)', async () => {
    const f = fixture()
    const fake = path.join(f.dir, 'git-sleep.sh')
    fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
    const running = runRemoteGit({ git: fake, cwd: f.work, args: ['fetch'], env: process.env, timeoutMs: 60_000, graceMs: 300 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    running.kill('cancel')
    const run = await running.done
    expect(run.killed).toBe('cancel')
    const spy = vi.spyOn(process, 'kill')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const calls = spy.mock.calls.length
    spy.mockRestore()
    expect(calls).toBe(0)
  })
})
