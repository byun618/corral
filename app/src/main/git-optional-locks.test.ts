// LIFE-672 R6ⓐ — 주기 git status(트리 골격 git-status.ts · 탐색기 explorer-hub.ts)는 optional lock 을 잡지 않는다.
// 인자를 고정하고, 실제 git 으로 stat 이 더러워진 레포에서 index 를 고쳐 쓰지 않는지(= index.lock 을 안 잡는지) 본다.
// 양성 대조: 같은 레포에서 `--no-optional-locks` 를 뺀 인자는 index 를 고쳐 쓴다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GIT_STATUS_ARGS as EXPLORER_GIT_STATUS_ARGS } from './explorer-hub.js'
import { clearGitStatusCacheForTest, getGitStatus, GIT_STATUS_ARGS as TREE_GIT_STATUS_ARGS } from './git-status.js'

let repo = ''

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

const gitStatus = (args: readonly string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'l672-optlock-'))
  const git = (...args: string[]): void => void execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args])
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b')
  git('add', '.')
  git('commit', '-qm', 'one')
  clearGitStatusCacheForTest()
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
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

  it('getGitStatus(트리 골격 실제 경로)는 index 를 고쳐 쓰지 않는다', async () => {
    dirtyStat()
    const before = indexIdentity()
    const summary = await getGitStatus(repo)
    expect(summary.error ?? null).toBeNull()
    expect(summary.branch).toBe('main')
    expect(summary.dirty).toBe(false)
    expect(indexIdentity()).toBe(before)
  })

  it('탐색기 인자는 index 를 고쳐 쓰지 않고, 출력은 억제 전과 같다', () => {
    dirtyStat()
    const before = indexIdentity()
    const suppressed = gitStatus(EXPLORER_GIT_STATUS_ARGS)
    expect(indexIdentity()).toBe(before)
    const unsuppressed = gitStatus(EXPLORER_GIT_STATUS_ARGS.filter((arg) => arg !== '--no-optional-locks'))
    expect(suppressed).toBe(unsuppressed)
  })
})
