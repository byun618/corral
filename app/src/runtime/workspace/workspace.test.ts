import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startRuntime } from '../server.js'
import { localCall, request, socketPath } from '../transport.js'
import { CommandRegistry } from '../registry.js'
import { workspaceModule } from './index.js'
import { RepoRegistry } from '../../main/registry.js'
const env = { ...process.env }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  process.env = { ...env }
})
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l392-test-')), data = path.join(root, 'data'), repo = path.join(root, 'repo')
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  delete process.env.CORRAL_RUNTIME_SOCKET
  delete process.env.CORRAL_SESSION
  delete process.env.CORRAL_BACKEND_SOCKET
  process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  fs.mkdirSync(repo)
  git('init', '-b', 'main'); git('commit', '--allow-empty', '-m', 'one')
  git('branch', 'older'); git('commit', '--allow-empty', '-m', 'two')
  let runtime = await startRuntime({ userData: data })
  cleanups.push(() => runtime.close())
  const parser = new CommandRegistry()
  parser.register(workspaceModule(data))
  const call = (...args: string[]) => localCall(socketPath(data), request(parser.parse(args, repo)))
  const restart = async () => { await runtime.close(); runtime = await startRuntime({ userData: data }) }
  return { root, data, repo, git, call, restart }
}
describe('workspace commands against real git and local socket', () => {
  it('serializes creation, persists metadata and shares the GUI registry across restart', async () => {
    const { data, repo, git, call, restart } = await fixture()
    expect((await call('repo', 'add', '--path', repo)).ok).toBe(true)
    const registry = new RepoRegistry(data), id = registry.records()[0]!.id
    expect((await call('repo', 'set-base-ref', '--repo', id, '--ref', 'older')).ok).toBe(true)
    const concurrent = await Promise.all([1, 2].map(() => call('worktree', 'create', '--repo', id, '--name', 'race', '--comment', 'saved')))
    expect(concurrent.filter(result => result.ok)).toHaveLength(1)
    expect(concurrent.find(result => !result.ok)?.error?.code).toBe('already_exists')
    expect(git('rev-parse', 'race')).toBe(git('rev-parse', 'older'))
    await restart()
    expect(await call('worktree', 'show', '--worktree', 'branch:race')).toMatchObject({ result: { worktree: { comment: 'saved' } } })
    expect(registry.records()[0]?.baseRef).toBe('older')
    expect(registry.remove(repo).ok).toBe(true)
    expect(await call('repo', 'list')).toMatchObject({ result: { repos: [] } })
  })
  it('protects dirty and main checkouts, retains unmerged branches and detects ambiguity', async () => {
    const { data, repo, git, call } = await fixture()
    await call('repo', 'add', '--path', repo)
    for (const name of ['one', 'two']) {
      expect((await call('worktree', 'create', '--name', name)).ok).toBe(true)
      await call('worktree', 'set', '--worktree', `branch:${name}`, '--display-name', 'same')
    }
    expect((await call('worktree', 'show', '--worktree', 'name:same')).error?.code).toBe('ambiguous_target')
    expect((await call('worktree', 'rm', '--worktree', `path:${repo}`)).error?.code).toBe('protected_worktree')
    const target = path.join(repo, '.claude/worktrees/one')
    fs.writeFileSync(path.join(target, 'dirty'), 'keep')
    expect((await call('worktree', 'rm', '--worktree', 'branch:one')).error?.code).toBe('dirty_worktree')
    expect(fs.existsSync(path.join(target, 'dirty'))).toBe(true)
    expect((await call('worktree', 'rm', '--worktree', 'branch:one', '--force')).ok).toBe(true)
    git('-C', path.join(repo, '.claude/worktrees/two'), 'commit', '--allow-empty', '-m', 'unmerged')
    expect(await call('worktree', 'delete', '--worktree', 'branch:two')).toMatchObject({ result: { removed: true, preservedBranch: { branchName: 'two' } } })
    expect(git('branch', '--list', 'two')).toContain('two')
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'worktree-metadata.json'), 'utf8')))).toHaveLength(0)
  })
  it('fails headless observation and activation before effects and migrates v1 without losing roots', async () => {
    const { data, repo, call } = await fixture()
    fs.writeFileSync(path.join(data, 'repos.json'), JSON.stringify({ version: 1, repos: [repo] }))
    const registry = new RepoRegistry(data), id = registry.records()[0]!.id
    expect((await call('worktree', 'ps')).error?.code).toBe('backend_unavailable')
    expect((await call('worktree', 'create', '--name', 'blocked', '--activate')).error?.code).toBe('ui_unavailable')
    expect(fs.existsSync(path.join(repo, '.claude/worktrees/blocked'))).toBe(false)
    expect(registry.records()[0]!.id).toBe(id)
    await call('repo', 'set-base-ref', '--repo', id, '--ref', 'main')
    expect(JSON.parse(fs.readFileSync(path.join(data, 'repos.json'), 'utf8')).version).toBe(2)
    expect(registry.list()).toEqual([fs.realpathSync(repo)])
  })
})
