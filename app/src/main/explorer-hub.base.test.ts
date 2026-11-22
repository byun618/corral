// LIFE-830 B6·B7 — 허브의 base 대비: 켠 루트만 같은 git 회차에 base 대비 목록을 `git` push 뒤 `scmBase` push 로 싣고, 끈 루트·열리지 않은 루트는 git 추가 0.
// 수정 r1: A6 status push 가 base 계산을 기다리지 않음 · A7 base 경로 예외가 회차를 막지 않음 · A5 렌더러 수명에 묶음(clearBaseModes).
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

type GitPush = Extract<ExplorerPush, { kind: 'git' }>
type BasePush = Extract<ExplorerPush, { kind: 'scmBase' }>
const gitPushes = (): GitPush[] => pushed.filter((event): event is GitPush => event.kind === 'git')
const basePushes = (): BasePush[] => pushed.filter((event): event is BasePush => event.kind === 'scmBase')
async function waitFor<T>(label: string, read: () => T | undefined): Promise<T> {
  for (let waited = 0; waited < 5_000; waited += 20) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${label} 이(가) 오지 않았다`)
}
const nextGit = (count: number): Promise<GitPush> => waitFor(`git push ${count} 번째`, () => gitPushes()[count - 1])
const nextBase = (count: number): Promise<BasePush> => waitFor(`scmBase push ${count} 번째`, () => basePushes()[count - 1])
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

describe('ExplorerHub base 대비 (LIFE-830)', () => {
  it('끈 루트 — scmBase push 없음, base 용 git 0 회', async () => {
    await hub.subscribe(root)
    await nextGit(1)
    hub.refreshGit(root)
    await nextGit(2)
    await settle()
    expect(basePushes()).toEqual([])
    expect(baseCalls).toEqual([])
    expect(hub.status().counters.baseRuns).toBe(0)
    expect(logs.filter((line) => line.event === 'explorer.scm_base')).toEqual([])
  })
  it('켜면 바로 다시 읽어 git push 뒤 scmBase push(커밋분 + 추적 안 함)를 싣고, 끄면 다음 회차부터 싣지 않는다', async () => {
    await hub.subscribe(root)
    await nextGit(1)
    hub.setBaseMode(root, true)
    const second = await nextGit(2)
    const on = await nextBase(1)
    expect(pushed.indexOf(on)).toBeGreaterThan(pushed.indexOf(second))
    expect(on.base).toMatchObject({ ok: true, info: { name: 'main', source: 'repo' }, total: 2 })
    expect(on.base.ok === true ? on.base.changes.map((change) => [change.status, change.rel]) : null).toEqual([
      ['ADDED', 'b.txt'],
      ['UNTRACKED', 'u.txt'],
    ])
    expect(baseCalls.length).toBeGreaterThan(0)
    expect(hub.status().counters.baseRuns).toBe(1)
    hub.setBaseMode(root, false)
    const callsWhenOff = baseCalls.length
    hub.refreshGit(root)
    await nextGit(3)
    await settle()
    expect(basePushes()).toHaveLength(1)
    expect(baseCalls.length).toBe(callsWhenOff)
  })
  it('구독 전에 켜도 첫 회차부터 싣는다 · 다른 루트는 켜지 않으면 git 추가 0', async () => {
    hub.setBaseMode(root, true)
    await hub.subscribe(root)
    await hub.subscribe(other)
    await waitFor('두 루트 git push', () => (gitPushes().length >= 2 ? true : undefined))
    await nextBase(1)
    await settle()
    expect(basePushes().map((event) => [event.root, event.base.ok])).toEqual([[root, true]])
    expect(logs.filter((line) => line.event === 'explorer.scm_base').map((line) => line.data?.root)).toEqual([root])
  })
  it('열린 worktree 가 아닌 루트·문자열 아닌 값·true 아닌 켜짐 값은 켜지지 않는다', async () => {
    hub.setBaseMode('/not/open', true)
    hub.setBaseMode(7, true)
    hub.setBaseMode(root, 'yes')
    await hub.subscribe(root)
    await nextGit(1)
    await settle()
    expect(basePushes()).toEqual([])
    expect(baseCalls).toEqual([])
  })
  it('A6 — base 계산이 멈춰 있어도 그 회차의 git push(작업 트리·탐색기)는 먼저 나간다', async () => {
    hub.dispose()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hub = new ExplorerHub({
      fork: fakeChild,
      push: (event) => void pushed.push(event),
      roots: () => [root],
      log: () => {},
      baseInputs: () => ({ parent: null, baseRef: 'main' }),
      baseRun: (cwd): GitRun => {
        const real = gitRunner(cwd)
        return async (args) => {
          await gate
          return real(args)
        }
      },
    })
    hub.setBaseMode(root, true)
    await hub.subscribe(root)
    const first = await nextGit(1)
    expect(first.changes?.map((change) => change.rel)).toEqual(['u.txt'])
    await settle()
    expect(basePushes()).toEqual([])
    release()
    expect((await nextBase(1)).base.ok).toBe(true)
  })
  it('A7 — base 재료가 던져도 ok:false git_error 로 내리고, 그 루트의 다음 git 회차가 계속 돈다', async () => {
    hub.dispose()
    hub = new ExplorerHub({
      fork: fakeChild,
      push: (event) => void pushed.push(event),
      roots: () => [root],
      log: (event, data) => void logs.push({ event, data }),
      baseInputs: () => {
        throw new Error('registry boom')
      },
    })
    hub.setBaseMode(root, true)
    await hub.subscribe(root)
    await nextGit(1)
    const failed = await nextBase(1)
    expect(failed.base).toMatchObject({ ok: false, reason: 'git_error' })
    expect(failed.base.ok === false ? failed.base.error : '').toContain('registry boom')
    hub.refreshGit(root)
    await nextGit(2)
    expect((await nextBase(2)).base.ok).toBe(false)
  })
  it('A5 — clearBaseModes(렌더러 다시 불러오기·죽음) 뒤엔 base git 0', async () => {
    hub.setBaseMode(root, true)
    await hub.subscribe(root)
    await nextBase(1)
    hub.clearBaseModes()
    const calls = baseCalls.length
    hub.refreshGit(root)
    await nextGit(2)
    await settle()
    expect(basePushes()).toHaveLength(1)
    expect(baseCalls.length).toBe(calls)
  })
})
