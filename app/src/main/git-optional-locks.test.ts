// LIFE-672 R6ⓐ — 주기 git status(트리 골격 git-status.ts · 탐색기 explorer-hub.ts)는 optional lock 을 잡지 않는다.
// 실제 호출 경로(getGitStatus·runGitStatus)를 PATH 앞의 git shim 으로 돌려 argv 를 기록하고, 실제 git 으로
// stat 이 더러워진 레포에서 index 를 고쳐 쓰지 않는지(= index.lock 을 안 잡는지) 본다.
// 양성 대조: 같은 레포에서 `--no-optional-locks` 를 뺀 인자는 index 를 고쳐 쓴다.
// 환경에 GIT_OPTIONAL_LOCKS 가 있으면(하네스가 세팅하기도 한다) 대조가 흐려지므로 시험 동안 지운다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GIT_STATUS_ARGS as EXPLORER_GIT_STATUS_ARGS, runGitStatus } from './explorer-hub.js'
import { clearGitStatusCacheForTest, getGitStatus, GIT_STATUS_ARGS as TREE_GIT_STATUS_ARGS } from './git-status.js'

const REAL_GIT = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()

let repo = ''
let shimDir = ''
let argvLog = ''
const saved = { path: process.env.PATH, optionalLocks: process.env.GIT_OPTIONAL_LOCKS }

/** index 파일의 정체 — git 은 index 를 lock 파일에 쓰고 rename 하므로 고쳐 쓰면 inode 가 바뀐다. */
const indexIdentity = (): string => {
  const stat = fs.statSync(path.join(repo, '.git', 'index'))
  return `${stat.ino}:${stat.mtimeMs}`
}

/** 내용은 그대로 두고 mtime 만 미래로 — status 가 stat 을 새로 고쳐 index 에 쓰고 싶어지는 상태. */
const dirtyStat = (): void => {
  const future = new Date(Date.now() + 60_000)
  for (const name of ['a.txt', 'b.txt']) fs.utimesSync(path.join(repo, name), future, future)
}

const gitStatus = (args: readonly string[]): string => execFileSync(REAL_GIT, ['-C', repo, ...args], { encoding: 'utf8' })

/** argv 에 --no-optional-locks 가 있고 status 보다 앞인가(전역 옵션 자리). */
const flagBeforeStatus = (argv: readonly string[]): boolean => {
  const flag = argv.indexOf('--no-optional-locks')
  return flag >= 0 && flag < argv.indexOf('status')
}

/** shim 이 기록한 `status` 호출 argv 들. */
const statusCalls = (): string[][] =>
  fs.existsSync(argvLog)
    ? fs.readFileSync(argvLog, 'utf8').split('\n').filter((line) => line !== '').map((line) => line.split('\u001f')).filter((argv) => argv.includes('status'))
    : []

beforeEach(() => {
  delete process.env.GIT_OPTIONAL_LOCKS
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'l672-optlock-'))
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l672-shim-'))
  argvLog = path.join(shimDir, 'argv.txt')
  // argv 를 0x1f 로 이어 한 줄씩 기록한 뒤 진짜 git 으로 넘긴다
  fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/bash\n(IFS=$'\\x1f'; echo "$*") >> '${argvLog}'\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 })
  process.env.PATH = `${shimDir}${path.delimiter}${saved.path ?? ''}`
  const git = (...args: string[]): void => void execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args])
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b')
  git('add', '.')
  git('commit', '-qm', 'one')
  clearGitStatusCacheForTest()
})

afterEach(() => {
  process.env.PATH = saved.path
  if (saved.optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS
  else process.env.GIT_OPTIONAL_LOCKS = saved.optionalLocks
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(shimDir, { recursive: true, force: true })
})

describe('LIFE-672 주기 git status 의 optional lock 억제', () => {
  it('트리 골격·탐색기 인자 모두 status 앞에 --no-optional-locks', () => {
    for (const args of [TREE_GIT_STATUS_ARGS, EXPLORER_GIT_STATUS_ARGS]) {
      expect(args[0]).toBe('--no-optional-locks')
      expect(args.indexOf('status')).toBeGreaterThan(0)
    }
  })

  it('양성 대조 — 억제를 뺀 인자는 stat 이 더러운 레포에서 index 를 고쳐 쓴다', () => {
    dirtyStat()
    const before = indexIdentity()
    gitStatus(TREE_GIT_STATUS_ARGS.filter((arg) => arg !== '--no-optional-locks'))
    expect(indexIdentity()).not.toBe(before)
  })

  it('getGitStatus(트리 골격 실제 경로) — 실제 argv 에 억제, index 를 고쳐 쓰지 않는다', async () => {
    dirtyStat()
    const before = indexIdentity()
    const summary = await getGitStatus(repo)
    expect(summary.error ?? null).toBeNull()
    expect(summary.branch).toBe('main')
    expect(summary.dirty).toBe(false)
    expect(indexIdentity()).toBe(before)
    expect(statusCalls().map(flagBeforeStatus)).toEqual([true])
  })

  it('runGitStatus(탐색기 실제 경로) — 실제 argv 에 억제, index 를 고쳐 쓰지 않고, 출력은 억제 전과 같다', async () => {
    dirtyStat()
    const before = indexIdentity()
    const outcome = await runGitStatus(repo)
    expect(outcome.error).toBeNull()
    expect(outcome.git).not.toBeNull()
    expect(indexIdentity()).toBe(before)
    expect(statusCalls().map(flagBeforeStatus)).toEqual([true])
    const suppressed = gitStatus(EXPLORER_GIT_STATUS_ARGS)
    const unsuppressed = gitStatus(EXPLORER_GIT_STATUS_ARGS.filter((arg) => arg !== '--no-optional-locks'))
    expect(suppressed).toBe(unsuppressed)
  })
})
