// LIFE-830 B6·B7 — 허브의 base 대비: 켠 루트만 같은 git 회차에 base 대비 목록을 싣고, 끈 루트·열리지 않은 루트는 git 추가 0.
// 새 타이머 없이 기존 신호(구독 첫 회차·새로고침)로만 돈다. 실제 git 저장소 + 가짜 감시 프로세스.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ExplorerHub, type WatcherChild } from './explorer-hub.js'
import { gitRunner, type GitRun } from './scm-base.js'
import type { ExplorerPush } from '../shared/explorer.js'

let base = ''
let root = ''
let other = ''
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l830-hub-')))
  root = path.join(base, 'wt')
  other = path.join(base, 'other')
  for (const dir of [root, other]) {
    fs.mkdirSync(dir)
    git(dir, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'seed')
    git(dir, 'checkout', '-q', '-b', 'feature')
  }
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'feature')
  fs.writeFileSync(path.join(root, 'u.txt'), 'u\n')
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

const fakeChild = (): WatcherChild => ({ pid: 1, postMessage: () => {}, on: () => {}, kill: () => true })

let pushed: ExplorerPush[] = []
let baseCalls: string[][] = []
let logs: { event: string; data?: Record<string, unknown> }[] = []
let hub: ExplorerHub

beforeEach(() => {
  pushed = []
  baseCalls = []
  logs = []
  hub = new ExplorerHub({
    fork: fakeChild,
    push: (event) => void pushed.push(event),
    roots: () => [root, other],
    log: (event, data) => void logs.push({ event, data }),
    baseInputs: () => ({ parent: null, baseRef: 'main' }),
    baseRun: (cwd): GitRun => {
      const real = gitRunner(cwd)
      return (args) => {
        baseCalls.push(args)
        return real(args)
      }
    },
  })
})
afterEach(() => hub.dispose())

const gitPushes = (): Extract<ExplorerPush, { kind: 'git' }>[] => pushed.filter((event): event is Extract<ExplorerPush, { kind: 'git' }> => event.kind === 'git')
async function nextGit(count: number): Promise<Extract<ExplorerPush, { kind: 'git' }>> {
  for (let waited = 0; waited < 5_000; waited += 20) {
    const events = gitPushes()
    const last = events[count - 1]
    if (last !== undefined) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`git push ${count} 번째가 오지 않았다`)
}

describe('ExplorerHub base 대비 (LIFE-830)', () => {
  it('끈 루트 — push 에 base 없음, base 용 git 0 회', async () => {
    await hub.subscribe(root)
    const first = await nextGit(1)
    expect(first.base).toBeUndefined()
    hub.refreshGit(root)
    expect((await nextGit(2)).base).toBeUndefined()
    expect(baseCalls).toEqual([])
    expect(hub.status().counters.baseRuns).toBe(0)
    expect(logs.filter((line) => line.event === 'explorer.scm_base')).toEqual([])
  })
  it('켜면 바로 다시 읽어 base 대비 목록(커밋분 + 추적 안 함)을 싣고, 끄면 다음 회차부터 싣지 않는다', async () => {
    await hub.subscribe(root)
    await nextGit(1)
    hub.setBaseMode(root, true)
    const on = await nextGit(2)
    expect(on.base).toMatchObject({ ok: true, info: { name: 'main', source: 'repo' }, total: 2 })
    expect(on.base?.ok === true ? on.base.changes.map((change) => [change.status, change.rel]) : null).toEqual([
      ['ADDED', 'b.txt'],
      ['UNTRACKED', 'u.txt'],
    ])
    expect(baseCalls.length).toBeGreaterThan(0)
    expect(hub.status().counters.baseRuns).toBe(1)
    hub.setBaseMode(root, false)
    const callsWhenOff = baseCalls.length
    hub.refreshGit(root)
    expect((await nextGit(3)).base).toBeUndefined()
    expect(baseCalls.length).toBe(callsWhenOff)
  })
  it('구독 전에 켜도 첫 회차부터 싣는다 · 다른 루트는 켜지 않으면 git 추가 0', async () => {
    hub.setBaseMode(root, true)
    await hub.subscribe(root)
    await hub.subscribe(other)
    for (let waited = 0; gitPushes().length < 2 && waited < 5_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(gitPushes().find((event) => event.root === root)?.base).toMatchObject({ ok: true })
    expect(gitPushes().find((event) => event.root === other)?.base).toBeUndefined()
    expect(logs.filter((line) => line.event === 'explorer.scm_base').map((line) => line.data?.root)).toEqual([root])
  })
  it('열린 worktree 가 아닌 루트·문자열 아닌 값·true 아닌 켜짐 값은 켜지지 않는다', async () => {
    hub.setBaseMode('/not/open', true)
    hub.setBaseMode(7, true)
    hub.setBaseMode(root, 'yes')
    await hub.subscribe(root)
    expect((await nextGit(1)).base).toBeUndefined()
    expect(baseCalls).toEqual([])
  })
})
