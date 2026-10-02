// LIFE-445 — 외부 git worktree 변경 지문·폴러, GUI git 목록의 prunable 거르기 (K3ⓓ·K4ⓒ 단위). 실제 git 레포로 본다.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { listGitWorktrees } from './git-worktrees.js'
import { gitCommonDir, worktreeFingerprint, WorktreePoller } from './worktree-watch.js'

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repo(): { root: string; base: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l445-')))
  cleanups.push(base)
  const root = path.join(base, 'repo')
  fs.mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  git(root, 'add', '-A')
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  return { root, base }
}

describe('worktreeFingerprint', () => {
  it('외부 추가·삭제·rm -rf·마지막 linked 삭제마다 바뀌고, 그대로면 같다', async () => {
    const { root, base } = repo()
    const empty = await worktreeFingerprint(root)
    expect(empty).toBe('none') // linked 0 — .git/worktrees 가 아직 없다
    expect(await worktreeFingerprint(root)).toBe(empty)

    const one = path.join(base, 'one')
    git(root, 'worktree', 'add', '-q', '-b', 'one', one)
    const added = await worktreeFingerprint(root)
    expect(added).not.toBe(empty)
    expect(await worktreeFingerprint(root)).toBe(added)

    const two = path.join(base, 'two')
    git(root, 'worktree', 'add', '-q', '-b', 'two', two)
    const both = await worktreeFingerprint(root)
    expect(both).not.toBe(added)

    fs.rmSync(two, { recursive: true, force: true }) // prunable 로 남는다(F2) — 지문은 바뀐다
    const pruned = await worktreeFingerprint(root)
    expect(pruned).not.toBe(both)
    git(root, 'worktree', 'prune')
    expect(await worktreeFingerprint(root)).toBe(added)

    git(root, 'worktree', 'remove', one) // 마지막 linked — git 이 .git/worktrees 를 지운다(F1)
    expect(fs.existsSync(path.join(root, '.git', 'worktrees'))).toBe(false)
    expect(await worktreeFingerprint(root)).toBe('none')
  })

  it('재빌드가 도는 git status·worktree list 는 지문을 바꾸지 않는다 (되먹임 없음, F7)', async () => {
    const { root, base } = repo()
    const one = path.join(base, 'one')
    git(root, 'worktree', 'add', '-q', '-b', 'one', one)
    fs.writeFileSync(path.join(one, 'dirty.txt'), 'x\n')
    const before = await worktreeFingerprint(root)
    git(one, 'status', '--porcelain=v2', '--branch')
    git(root, 'status', '--porcelain=v2', '--branch')
    git(root, 'worktree', 'list', '--porcelain')
    expect(await worktreeFingerprint(root)).toBe(before)
  })

  it('등록 root 가 linked worktree 여도 공통 디렉터리를 찾는다', async () => {
    const { root, base } = repo()
    const one = path.join(base, 'one')
    git(root, 'worktree', 'add', '-q', '-b', 'one', one)
    expect(await gitCommonDir(one)).toBe(path.join(root, '.git'))
    const fromLinked = await worktreeFingerprint(one)
    expect(fromLinked).toBe(await worktreeFingerprint(root))
  })

  it('레포가 아니거나 없는 경로는 오류 지문 — 던지지 않는다', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l445-')))
    cleanups.push(base)
    expect(await worktreeFingerprint(base)).toBe('error:ENOENT')
    expect(await worktreeFingerprint(path.join(base, 'gone'))).toBe('error:ENOENT')
  })
})

describe('WorktreePoller', () => {
  function poller(prints: Map<string, string>, roots: () => string[]) {
    const changes: string[][] = []
    const sizes: number[] = []
    const instance = new WorktreePoller({
      roots,
      fingerprint: async (root) => prints.get(root) ?? 'none',
      onChange: (changed) => changes.push(changed),
      onRoots: (count) => sizes.push(count),
    })
    return { instance, changes, sizes }
  }

  it('처음 본 레포는 바뀐 것으로 치고, 그대로면 부르지 않고, 바뀐 레포만 알린다', async () => {
    const prints = new Map([['/a', 'x'], ['/b', 'y']])
    const { instance, changes } = poller(prints, () => ['/a', '/b'])
    expect(await instance.tick()).toEqual(['/a', '/b'])
    expect(await instance.tick()).toEqual([])
    expect(await instance.tick()).toEqual([])
    prints.set('/b', 'y2')
    expect(await instance.tick()).toEqual(['/b'])
    expect(changes).toEqual([['/a', '/b'], ['/b']])
  })

  it('레지스트리에서 빠진 레포의 상태를 버린다 — 추가·제거 3회 왕복 뒤 크기가 처음과 같다 (누수 없음)', async () => {
    const prints = new Map([['/a', 'x'], ['/d', 'z']])
    let roots = ['/a']
    const { instance, sizes } = poller(prints, () => roots)
    await instance.tick()
    for (let i = 0; i < 3; i += 1) {
      roots = ['/a', '/d']
      await instance.tick()
      expect(instance.size()).toBe(2)
      roots = ['/a']
      await instance.tick()
      expect(instance.size()).toBe(1)
    }
    expect(sizes).toEqual([1, 2, 1, 2, 1, 2, 1])
  })

  it('레지스트리 읽기가 실패하면 상태를 그대로 둔다 — 회복 뒤 전부 「새 레포」 가 되지 않는다', async () => {
    const prints = new Map([['/a', 'x']])
    let fail = false
    const { instance, changes } = poller(prints, () => {
      if (fail) throw new Error('registry')
      return ['/a']
    })
    await instance.tick()
    fail = true
    expect(await instance.tick()).toEqual([])
    fail = false
    expect(await instance.tick()).toEqual([])
    expect(changes).toEqual([['/a']])
  })

  it('앞 틱이 도는 중이면 겹치지 않는다', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const instance = new WorktreePoller({
      roots: () => ['/a'],
      fingerprint: async () => {
        calls += 1
        await gate
        return 'x'
      },
      onChange: () => {},
    })
    const first = instance.tick()
    expect(await instance.tick()).toEqual([])
    release()
    expect(await first).toEqual(['/a'])
    expect(calls).toBe(1)
  })
})

describe('listGitWorktrees — prunable 거르기 (S3)', () => {
  it('디렉터리 없는 항목은 빠지고, 주 체크아웃 판정(isLinked)은 순번 그대로다', async () => {
    const { root, base } = repo()
    const one = path.join(base, 'one')
    const two = path.join(base, 'two')
    git(root, 'worktree', 'add', '-q', '-b', 'one', one)
    git(root, 'worktree', 'add', '-q', '-b', 'two', two)
    fs.rmSync(one, { recursive: true, force: true })
    expect(git(root, 'worktree', 'list', '--porcelain')).toContain('prunable')
    const scan = await listGitWorktrees(root)
    expect(scan.error).toBeNull()
    expect(scan.worktrees.map((row) => [path.basename(row.path), row.isLinked, row.branch])).toEqual([
      ['repo', false, 'main'],
      ['two', true, 'two'],
    ])
  })
})
