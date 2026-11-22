// LIFE-831 수정 r1 C1 — 진짜 `getGitStatus`(git-status 캐시) + 지연 주입 git 으로 두 경합 장면을 고정한다(리뷰 r1 Claude R1-01 · Grok G2a·G2b).
// ① 캐시 역전: 동작 전 상태를 들고 늦게 끝난 읽기가 동작 뒤 재조회 값을 캐시에서 되덮지 않는다.
// ② 스냅샷 순서: 재빌드가 경로 갱신보다 **나중에 읽은** 값은 overlay 가 이른 갱신 값으로 덮지 않는다(시작 시각이 아니라 읽은 순서).
// 지연은 PATH 맨 앞의 감싸개 `git` 이 깃발 파일이 있을 때 한 번만 준다(결과는 먼저 읽고 늦게 돌려준다 — 옛 스냅샷이 늦게 도착).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveGit } from './file-list.js'
import { clearGitStatusCacheForTest, getGitStatus, invalidateGitStatus, isLaterSnapshot } from './git-status.js'
import type { RepoSkeleton } from './tree.js'
import { patchWorktreeStatus, WorktreeStatusRefresh } from './worktree-status-refresh.js'
import type { GitStatusSummary } from '../shared/types.js'

const REAL_GIT = resolveGit({ pathEnv: process.env.PATH })
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l831-race-')))
const shimDir = path.join(base, 'shim')
const FLAG = path.join(base, 'slow.flag')
/** 느린 읽기가 스냅샷을 다 읽었다는 표지 — 이것을 본 뒤에 동작(커밋)을 한다(띄우는 지연에 기대지 않게). */
const TAKEN = path.join(base, 'slow.taken')
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
let savedPath: string | undefined
beforeAll(() => {
  fs.mkdirSync(shimDir)
  fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nif [ -e '${FLAG}' ]; then rm -f '${FLAG}'; out=$('${REAL_GIT}' "$@"); code=$?; : > '${TAKEN}'; sleep 1; printf '%s\\n' "$out"; exit $code; fi\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 })
  savedPath = process.env.PATH
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(() => {
  process.env.PATH = savedPath
  fs.rmSync(base, { recursive: true, force: true })
})

let seq = 0
function repo(): string {
  seq += 1
  const dir = path.join(base, `r${seq}`)
  execFileSync(REAL_GIT, ['init', '-q', '--bare', '-b', 'main', `${dir}.git`], { env })
  execFileSync(REAL_GIT, ['clone', '-q', `${dir}.git`, dir], { env, stdio: 'ignore' })
  g(dir, 'config', 'user.name', 't')
  g(dir, 'config', 'user.email', 't@e.invalid')
  commit(dir, 'a')
  g(dir, 'push', '-q', '-u', 'origin', 'main')
  clearGitStatusCacheForTest()
  return dir
}
const g = (dir: string, ...args: string[]): string => execFileSync(REAL_GIT, ['-C', dir, ...args], { env, encoding: 'utf8' })
const commit = (dir: string, name: string): void => {
  fs.writeFileSync(path.join(dir, name), name)
  g(dir, 'add', '-A')
  g(dir, 'commit', '-q', '-m', name)
}
const tree = (dir: string, gitStatus: GitStatusSummary): RepoSkeleton[] => [
  { root: dir, name: 'r', error: null, gitError: null, openError: null, worktrees: [{ path: dir, branch: 'main', head: null, isLinked: false, openWorkspaceId: 'w', gitStatus }] },
]
const refresher = (): WorktreeStatusRefresh => new WorktreeStatusRefresh({ read: getGitStatus, invalidate: invalidateGitStatus, isLater: isLaterSnapshot })

describe('C1 — 진짜 getGitStatus 경합', () => {
  it('① 동작 전 스냅샷을 든 느린 읽기가 늦게 끝나도 다음 읽기(재빌드)는 동작 뒤 값이다 — 캐시를 되덮지 않는다', async () => {
    const dir = repo()
    const refresh = refresher()
    fs.rmSync(TAKEN, { force: true })
    fs.writeFileSync(FLAG, '')
    const slow = getGitStatus(dir) // 진행 중 재빌드의 읽기 — ahead 0 을 읽고 1 초 늦게 끝난다
    while (!fs.existsSync(TAKEN)) await new Promise((resolve) => setTimeout(resolve, 10))
    commit(dir, 'b') // 동작(커밋) 끝 — ahead 1
    const fresh = await refresh.refresh(dir)
    expect(fresh?.ahead).toBe(1)
    expect((await slow).ahead).toBe(0)
    expect((await getGitStatus(dir)).ahead).toBe(1)
  }, 15_000)
  it('② 재빌드가 경로 갱신보다 나중에 읽은 값(ahead 2)은 이른 갱신 값(ahead 1)으로 덮이지 않는다 · 먼저 읽은 낡은 값(ahead 0)은 덮인다', async () => {
    const dir = repo()
    const refresh = refresher()
    const before = await getGitStatus(dir) // 그 재빌드가 동작 전에 읽은 값(ahead 0)
    commit(dir, 'b')
    expect((await refresh.refresh(dir))?.ahead).toBe(1)
    commit(dir, 'c') // 터미널에서 한 번 더 — 재빌드가 그 뒤에 읽는다(TTL 만료 대신 무효화로 git 을 다시 돌린다)
    invalidateGitStatus(dir)
    const later = await getGitStatus(dir)
    expect(later.ahead).toBe(2)
    const ahead = (built: RepoSkeleton[]): number | null | undefined => built[0]?.worktrees[0]?.gitStatus.ahead
    // 재빌드는 경로 갱신보다 먼저 시작했다 — 그 경로를 동작 전에 읽었으면(before) 덮이고, 갱신 뒤에 읽었으면(later) 그대로.
    expect(ahead(refresh.overlay({ built: tree(dir, before) }))).toBe(1)
    expect(ahead(refresh.overlay({ built: tree(dir, later) }))).toBe(2)
    // 더 새 값을 본 뒤에는 갱신 값을 버린다 — 그 뒤 낡은 재빌드 값이 와도 덮을 것이 없다(재빌드 결과 그대로).
    expect(ahead(refresh.overlay({ built: tree(dir, before) }))).toBe(0)
  }, 15_000)

  it('③ 같은 무효화 뒤 두 읽기(같은 세대) — 먼저 시작한 읽기가 늦게 끝나도 캐시는 나중에 시작한 읽기의 값이다(수정 r2 D1)', async () => {
    const dir = repo()
    invalidateGitStatus(dir)
    fs.rmSync(TAKEN, { force: true })
    fs.writeFileSync(FLAG, '')
    const slow = getGitStatus(dir) // 먼저 시작 — ahead 0 을 읽고 1 초 늦게 끝난다
    while (!fs.existsSync(TAKEN)) await new Promise((resolve) => setTimeout(resolve, 10))
    commit(dir, 'b')
    const fast = await getGitStatus(dir) // 같은 세대, 나중에 시작 — 바로 ahead 1
    expect(fast.ahead).toBe(1)
    expect((await slow).ahead).toBe(0)
    expect((await getGitStatus(dir)).ahead).toBe(1)
  }, 15_000)
  it('④ 경로 갱신 patch 도 같은 규칙 — 골격이 이미 더 나중 스냅샷이면 이른 값으로 바꾸지 않는다, 더 나중 값이면 바꾼다(수정 r2 D1)', async () => {
    const dir = repo()
    invalidateGitStatus(dir)
    fs.rmSync(TAKEN, { force: true })
    fs.writeFileSync(FLAG, '')
    const slow = getGitStatus(dir)
    while (!fs.existsSync(TAKEN)) await new Promise((resolve) => setTimeout(resolve, 10))
    commit(dir, 'b')
    const later = await getGitStatus(dir)
    const older = await slow
    const ahead = (built: RepoSkeleton[]): number | null | undefined => built[0]?.worktrees[0]?.gitStatus.ahead
    expect(ahead(patchWorktreeStatus({ skeleton: tree(dir, later), path: dir, value: older, isLater: isLaterSnapshot }).skeleton)).toBe(1)
    expect(ahead(patchWorktreeStatus({ skeleton: tree(dir, older), path: dir, value: later, isLater: isLaterSnapshot }).skeleton)).toBe(1)
  }, 15_000)
})
