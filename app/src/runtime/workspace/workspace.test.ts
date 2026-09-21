import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { startRuntime } from '../server.js'
import { localCall, request, socketPath } from '../transport.js'
import { CommandRegistry } from '../registry.js'
import { workspaceModule } from './index.js'
import { RepoRegistry } from '../../main/registry.js'
import { isRecord } from '../../shared/json.js'
import { RuntimeError } from '../contracts.js'
const env = { ...process.env }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  process.env = { ...env }
})
async function fixture(repoName = 'repo') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l392-test-')), data = path.join(root, 'data'), repo = path.join(root, repoName)
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
  it('preserves newline values in repo and worktree selectors against real Git', async () => {
    const { root, data, repo, git, call } = await fixture('repo\nroot')
    expect((await call('repo', 'add', '--path', repo)).ok).toBe(true)
    const registered = new RepoRegistry(data).records()[0]!
    for (const selector of [repo, registered.id, `path:${repo}`, `id:${registered.id}`, `name:${registered.name}`]) {
      expect(await call('repo', 'show', '--repo', selector)).toMatchObject({ ok: true, result: { repo: { id: registered.id } } })
    }
    const external = path.join(root, 'outside\nworktree')
    git('worktree', 'add', '-b', 'outside', external)
    expect((await call('repo', 'add', '--path', external)).error?.code).toBe('already_exists')
    expect(new RepoRegistry(data).records()).toEqual([registered])
    const id = `${registered.id}::${fs.realpathSync(external)}`
    expect((await call('worktree', 'set', '--worktree', `id:${id}`, '--display-name', 'line\nname', '--issue', '12')).ok).toBe(true)
    for (const selector of [external, id, `path:${external}`, `id:${id}`, 'branch:outside', 'name:line\nname', 'issue:12']) {
      expect(await call('worktree', 'show', '--worktree', selector)).toMatchObject({ ok: true, result: { worktree: { id } } })
    }
    expect(await call('worktree', 'list')).toMatchObject({ result: { worktrees: expect.arrayContaining([expect.objectContaining({ id })]) } })
    for (const selector of [`path:${root}/missing\npath`, 'unknown:outside']) {
      expect((await call('worktree', 'show', '--worktree', selector)).error?.code).toBe('not_found')
    }
    for (const prefix of ['identity', 'folder']) {
      expect((await call('worktree', 'show', '--worktree', `${prefix}:${external}`)).error?.code).toBe('invalid_argument')
    }
    await call('worktree', 'set', '--worktree', `path:${repo}`, '--display-name', 'line\nname')
    expect((await call('worktree', 'show', '--worktree', 'name:line\nname')).error?.code).toBe('ambiguous_target')
  })
  it('serializes creation, persists metadata and shares the GUI registry across restart', async () => {
    const { data, repo, git, call, restart } = await fixture()
    fs.chmodSync(data, 0o755)
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
    expect(fs.statSync(data).mode & 0o777).toBe(0o755)
    expect(fs.existsSync(path.join(data, 'worktree-metadata.json'))).toBe(false)
    expect(registry.remove(repo).ok).toBe(true)
    expect(registry.metadata()).toEqual({})
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
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'repos.json'), 'utf8')).worktrees)).toHaveLength(0)
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
  it('clones below an existing parent and rejects only the final child collision', async () => {
    const { root, data, repo, git, call } = await fixture()
    await call('repo', 'add', '--path', repo)
    const registry = new RepoRegistry(data), project = registry.records()[0]!.projectId
    const bare = path.join(root, 'source.git'), parent = path.join(root, 'clones')
    git('clone', '--bare', repo, bare)
    fs.mkdirSync(parent)
    expect(await call('project', 'setup-clone', '--project', project, '--url', bare, '--destination', parent)).toMatchObject({ ok: true, result: { setup: { method: 'cloned' } } })
    expect(git('-C', path.join(parent, 'source'), 'rev-parse', 'HEAD')).toBe(git('rev-parse', 'HEAD'))
    expect((await call('project', 'setup-clone', '--project', project, '--url', bare, '--destination', parent)).error?.code).toBe('already_exists')
  })
  it('reports a branch left by failed git checkout without claiming an existing collision', async () => {
    const { repo, git, call } = await fixture()
    await call('repo', 'add', '--path', repo)
    const parent = path.join(repo, '.claude/worktrees')
    fs.mkdirSync(parent, { recursive: true })
    fs.chmodSync(parent, 0o500)
    try {
      const failed = await call('worktree', 'create', '--name', 'partial')
      expect(failed).toMatchObject({ ok: false, error: { code: 'git_failed', resources: { branch: 'partial' } } })
      expect(git('branch', '--list', 'partial')).toContain('partial')
      expect(fs.existsSync(path.join(parent, 'partial'))).toBe(false)
      const collision = await call('worktree', 'create', '--name', 'partial')
      expect(collision.error?.code).toBe('already_exists')
      expect(collision.error?.resources).toBeUndefined()
    } finally { fs.chmodSync(parent, 0o755) }
  })

  it('uses the input alias basename for absolute, relative and trailing-slash clones', async () => {
    const { root, data, repo, git, call } = await fixture()
    await call('repo', 'add', '--path', repo)
    const registry = new RepoRegistry(data), project = registry.records()[0]!.projectId
    const actual = path.join(root, 'actual.git'), alias = path.join(root, 'alias.git')
    git('clone', '--bare', repo, actual)
    fs.symlinkSync(actual, alias)
    for (const [index, url] of [alias, '../alias.git', '../alias.git/'].entries()) {
      const parent = path.join(root, `clones-${index}`)
      const result = await call('project', 'setup-clone', '--project', project, '--url', url, '--destination', parent)
      const child = fs.realpathSync(path.join(parent, 'alias'))
      expect(result).toMatchObject({ ok: true, result: { repo: { path: child, method: 'cloned' } } })
      expect(git('-C', child, 'rev-parse', 'HEAD')).toBe(git('rev-parse', 'HEAD'))
      expect(fs.existsSync(path.join(parent, 'actual'))).toBe(false)
      expect((await call('project', 'setup-clone', '--project', project, '--url', url, '--destination', parent)).error?.code).toBe('already_exists')
    }
  })

  it.each(['CLI', 'GUI'])('cleans migrated external metadata on %s unregister without guessing ownership', async mode => {
    const { root, data, repo, git, call, restart } = await fixture()
    await call('repo', 'add', '--path', repo)
    const registry = new RepoRegistry(data), original = registry.records()[0]!
    const external = path.join(root, 'external'), nested = path.join(repo, 'nested')
    git('worktree', 'add', '-b', 'external', external)
    git('init', '-b', 'main', nested)
    git('-C', nested, 'commit', '--allow-empty', '-m', 'nested')
    await call('repo', 'add', '--path', nested)
    const other = registry.records().find(row => row.id !== original.id)!
    await call('project', 'setup-create', '--project', original.projectId, '--host', 'local', '--setup-id', 'independent')
    const externalPath = fs.realpathSync(external), unknown = path.join(repo, 'unknown')
    const disk = JSON.parse(fs.readFileSync(path.join(data, 'repos.json'), 'utf8'))
    delete disk.worktrees
    fs.writeFileSync(path.join(data, 'repos.json'), JSON.stringify(disk))
    fs.writeFileSync(path.join(data, 'worktree-metadata.json'), JSON.stringify({
      [externalPath]: { displayName: 'old external', comment: 'old comment' },
      [other.path]: { comment: 'keep nested', parentWorktreeId: `${original.id}::${externalPath}` },
      [unknown]: { comment: 'unknown owner' },
    }))
    fs.chmodSync(data, 0o755)
    await restart()
    expect(await call('worktree', 'show', '--worktree', `path:${external}`)).toMatchObject({ result: { worktree: { comment: 'old comment' } } })
    // Exercise migration on an unrelated write before unregistering.
    await call('repo', 'set-base-ref', '--repo', original.id, '--ref', 'main')
    expect(fs.existsSync(path.join(data, 'worktree-metadata.json'))).toBe(false)
    await restart()
    const before = git('worktree', 'list', '--porcelain')
    if (mode === 'CLI') expect((await call('project', 'setup-delete', '--setup', original.id)).ok).toBe(true)
    else expect(registry.remove(repo).ok).toBe(true)
    expect(registry.metadata()[externalPath]).toBeUndefined()
    expect(registry.metadata()[other.path]).toEqual({ comment: 'keep nested', parentWorktreeId: null })
    expect(registry.metadata()[unknown]).toEqual({ comment: 'unknown owner' })
    expect(registry.setups().some(row => row.id === 'independent')).toBe(true)
    expect(git('worktree', 'list', '--porcelain')).toBe(before)
    expect(fs.existsSync(external)).toBe(true)
    await call('repo', 'add', '--path', repo)
    await restart()
    expect(await call('worktree', 'show', '--worktree', `path:${external}`)).toMatchObject({ result: { worktree: { displayName: 'external', comment: null } } })
    expect(fs.statSync(data).mode & 0o777).toBe(0o755)
  })

  it('unregisters a missing repository while preserving legacy metadata of unknown ownership', async () => {
    const { root, data, repo, call } = await fixture()
    await call('repo', 'add', '--path', repo)
    const registry = new RepoRegistry(data), original = registry.records()[0]!
    const unknown = path.join(root, 'unknown')
    registry.change(data => { data.worktrees[unknown] = { comment: 'unknown' }; data.worktrees[repo] = { repoId: original.id, comment: 'known' } })
    fs.renameSync(repo, path.join(root, 'moved'))
    expect(registry.remove(original.path).ok).toBe(true)
    expect(registry.records()).toEqual([])
    expect(registry.metadata()).toEqual({ [unknown]: { comment: 'unknown' } })
  })

  it('does not use an enclosing repository when a registered nested repository loses .git', async () => {
    const { data, repo, git, call } = await fixture()
    await call('repo', 'add', '--path', repo)
    const registry = new RepoRegistry(data), original = registry.records()[0]!
    const nested = path.join(repo, 'nested')
    git('init', '-b', 'main', nested)
    git('-C', nested, 'commit', '--allow-empty', '-m', 'nested')
    await call('repo', 'add', '--path', nested)
    registry.change(data => { data.worktrees[original.path] = { comment: 'outer owner' } })
    fs.rmSync(path.join(nested, '.git'), { recursive: true, force: true })
    expect(registry.remove(nested).ok).toBe(true)
    expect(registry.metadata()[original.path]).toEqual({ comment: 'outer owner' })
  })


  it('gates the agent flags and keeps every stage of a half-finished composition (F11)', async () => {
    const { repo, call } = await fixture()
    expect((await call('repo', 'add', '--path', repo)).ok).toBe(true)
    // Validation runs in the shared parser before a request is ever sent, so it throws here.
    const rejected = async (...args: string[]): Promise<string | undefined> => {
      try { return (await call(...args)).error?.code } catch (error) { return error instanceof RuntimeError ? error.code : String(error) }
    }
    // §4.1: the agent options exist only next to --agent, and only on worktree create.
    for (const args of [['worktree', 'create', '--name', 'a', '--model', 'opus'],
      ['worktree', 'create', '--name', 'a', '--prompt', 'hi'],
      ['worktree', 'create', '--name', 'a', '--agent', 'gemini'],
      ['worktree', 'create', '--name', 'a', '--agent', 'codex', '--advisor', 'fable'],
      ['worktree', 'create', '--name', 'a', '--agent', 'claude', '--prompt', 'hi', '--prompt-file', '/tmp/x']]) {
      expect([args.join(' '), await rejected(...args)]).toEqual([args.join(' '), 'invalid_request'])
    }
    expect(await rejected('worktree', 'set', '--worktree', 'current', '--agent', 'claude')).toBe('invalid_argument')
    // None of those took a name: they are rejected before git runs.
    expect((await call('worktree', 'list')).result).toMatchObject({ totalCount: 1 })

    // D15: this fixture has no terminal backend, so the terminal stage fails after git succeeded.
    // The worktree is a user resource and stays; the composition reports stage by stage instead of
    // collapsing into one outcome, and it returns the partial result rather than throwing it away.
    const requestId = `r1.${Date.now()}.${randomUUID()}`
    const args = ['worktree', 'create', '--name', 'agent-wt', '--repo', repo, '--agent', 'claude', '--effort', 'high', '--prompt', 'start here', '--request-id', requestId]
    const first = await call(...args)
    expect(first.ok).toBe(true)
    const payload = first.result
    if (!isRecord(payload) || !isRecord(payload.worktree) || !isRecord(payload.stages)) throw new Error(`unexpected result ${JSON.stringify(first)}`)
    expect(typeof payload.worktree.path).toBe('string')
    expect(fs.existsSync(path.join(String(payload.worktree.path), '.git'))).toBe(true)
    expect(Object.fromEntries(Object.entries(payload.stages).map(([key, stage]) => [key, isRecord(stage) ? stage.status : null])))
      .toEqual({ worktree: 'completed', terminal: 'failed', agent: 'not_started', prompt: 'not_started' })
    expect(payload.stages.terminal).toMatchObject({ error: 'backend_unavailable', requestId: expect.stringMatching(/^r1\./) })
    expect(payload.outcome).toBe('completed')
    expect(payload.agent).toBe(null)
    expect(payload.replayed).toBe(false)

    // The same request id replays the same partial result: no second worktree, no already_exists.
    expect(await call(...args)).toMatchObject({ ok: true, result: { replayed: true, stages: payload.stages } })
    expect((await call('worktree', 'list')).result).toMatchObject({ worktrees: expect.arrayContaining([expect.objectContaining({ path: payload.worktree.path })]) })
    // A new id for the same name falls back to the existing worktree create failure, unchanged.
    expect((await call('worktree', 'create', '--name', 'agent-wt', '--repo', repo, '--agent', 'claude')).error?.code).toBe('already_exists')
  })

  // LIFE-394 fix round 1, R6 — rewritten from the code review's `repro.ts` `worktreeRelative` case.
  // `--prompt-file` is a path in the *caller's* directory, and the body it names is part of what the
  // request asked for. Reading it inside the freshly created worktree resolves a different file, and
  // leaving it out of the receipt fingerprint makes a changed body replay the old result.
  it('reads a relative --prompt-file from the invocation directory and binds its body to the receipt (R6)', async () => {
    const { repo, call } = await fixture()
    expect((await call('repo', 'add', '--path', repo)).ok).toBe(true)

    // 1: a body that cannot be read is an effect-free invalid_argument — before git creates anything.
    const before = (await call('worktree', 'list')).result
    const missing = await call('worktree', 'create', '--name', 'no-body', '--repo', repo, '--agent', 'claude',
      '--prompt-file', 'absent.txt', '--request-id', `r1.${Date.now()}.${randomUUID()}`)
    expect(missing.error?.code).toBe('invalid_argument')
    expect(missing._meta?.outcome).toBe('not_started')
    expect(fs.existsSync(path.join(repo, '.claude/worktrees/no-body'))).toBe(false)
    expect((await call('worktree', 'list')).result).toMatchObject(isRecord(before) ? { totalCount: before.totalCount } : {})

    // 2: the file that exists is the caller's. The new worktree is a fresh checkout and has no copy
    //    of it, so a create that resolved the path there would read nothing at all.
    fs.writeFileSync(path.join(repo, 'prompt.txt'), 'original prompt body\n')
    const requestId = `r1.${Date.now()}.${randomUUID()}`
    const args = ['worktree', 'create', '--name', 'body-wt', '--repo', repo, '--agent', 'claude', '--prompt-file', 'prompt.txt', '--request-id', requestId]
    const created = await call(...args)
    expect(created.ok).toBe(true)
    const worktree = isRecord(created.result) && isRecord(created.result.worktree) ? String(created.result.worktree.path) : ''
    expect(fs.existsSync(path.join(worktree, 'prompt.txt'))).toBe(false)

    // 3: same id, same body replays; same id, a changed body is a conflict rather than a replay.
    expect(await call(...args)).toMatchObject({ ok: true, result: { replayed: true } })
    fs.writeFileSync(path.join(repo, 'prompt.txt'), 'CHANGED prompt body\n')
    expect((await call(...args)).error?.code).toBe('request_conflict')
  })
})
