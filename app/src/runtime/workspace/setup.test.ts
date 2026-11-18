// LIFE-813 — the registered worktree setup command, against real Git and the local socket.
// Each case names the criterion (01-criteria C1~C8, C10) it covers.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startRuntime } from '../server.js'
import { localCall, request, socketPath } from '../transport.js'
import { CommandRegistry } from '../registry.js'
import { workspaceModule } from './index.js'
import { RepoRegistry } from '../../main/registry.js'
import { isRecord } from '../../shared/json.js'
import { RuntimeError } from '../contracts.js'
import { setupLogDirectory } from './setup.js'
import { WorktreePoller } from '../../main/worktree-watch.js'
import { StartService } from '../../main/work/start.js'
import { newAttemptId, type StartSourceLink, type StartWorkInput } from '../../shared/work-start.js'
import type { ClaimResult } from '../../main/work/links.js'
import { testRepo } from '../../shared/test-rows.js'

const env = { ...process.env }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  process.env = { ...env }
})

/** A fake login shell: `$SHELL -ilc <cmd>` → prepend a marker directory to PATH, then run <cmd>. */
function fakeShell(root: string, prefix: string): string {
  const file = path.join(root, 'fake-login-shell')
  fs.writeFileSync(file, `#!/bin/sh\nPATH='${prefix}':"$PATH"; export PATH\nexec /bin/sh -c "$2"\n`, { mode: 0o755 })
  return file
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l813-')), data = path.join(root, 'data'), repo = path.join(root, 'repo')
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const key of ['CORRAL_RUNTIME_SOCKET', 'CORRAL_SESSION', 'CORRAL_BACKEND_SOCKET', 'CORRAL_WORKTREE_PATH', 'CORRAL_ROOT_PATH']) delete process.env[key]
  process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
  process.env.SHELL = fakeShell(root, path.join(root, 'login-bin'))
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main'); git(repo, 'commit', '--allow-empty', '-m', 'one')
  let runtime = await startRuntime({ userData: data })
  cleanups.push(() => runtime.close().catch(() => {}))
  const parser = new CommandRegistry()
  parser.register(workspaceModule(data))
  const call = (...args: string[]) => localCall(socketPath(data), request(parser.parse(args, repo)))
  const rejected = async (...args: string[]): Promise<string | undefined> => {
    try { return (await call(...args)).error?.code } catch (error) { return error instanceof RuntimeError ? error.code : String(error) }
  }
  const restart = async () => { await runtime.close(); runtime = await startRuntime({ userData: data }) }
  const close = () => runtime.close()
  const invoke = () => runtime.invoke
  const parse = (args: string[]) => parser.parse(args, repo)
  /** A client that hangs up mid-request — the socket closes and the same runtime cancels the request. */
  const callCancelled = (signal: AbortSignal, ...args: string[]) => localCall(socketPath(data), request(parser.parse(args, repo), undefined, 30000), 30000, signal).catch(error => error)
  const callWithin = (ms: number, ...args: string[]) => localCall(socketPath(data), request(parser.parse(args, repo), undefined, ms))
  const real = fs.realpathSync(repo)
  const worktreePath = (name: string) => path.join(real, '.claude/worktrees', name)
  const branchExists = (name: string) => git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${name}`) !== ''
  const logs = () => { try { return fs.readdirSync(setupLogDirectory(data)) } catch { return [] } }
  expect((await call('repo', 'add', '--path', repo)).ok).toBe(true)
  const id = new RepoRegistry(data).records()[0]!.id
  const register = async (command: string) => expect((await call('repo', 'set-setup-command', '--repo', id, '--command', command)).ok).toBe(true)
  return { root, data, repo, real, id, git, call, callWithin, callCancelled, parse, rejected, restart, close, invoke, worktreePath, branchExists, logs, register }
}
const receiptOf = (result: unknown): Record<string, unknown> => (isRecord(result) && isRecord(result.setupReceipt) ? result.setupReceipt : {})
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
/** Running, not a zombie waiting to be reaped — read synchronously so no timer can run in between. */
const running = (pid: number) => { try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z') } catch { return false } }
const until = async (check: () => boolean, ms = 10000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(resolve => setTimeout(resolve, 50)) } }
const pidsIn = (file: string) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) } catch { return [] } }

describe('LIFE-813 worktree setup command', () => {
  it('C1: registers, shows, clears and survives restart; old records read as null; bad values change nothing', async () => {
    const { data, id, call, rejected, restart, register } = await fixture()
    const file = path.join(data, 'repos.json')
    // An old record has no setupCommand at all and still reads, as null.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).repos[0]).not.toHaveProperty('setupCommand')
    const before = fs.readFileSync(file)
    expect(await call('repo', 'show', '--repo', id)).toMatchObject({ ok: true, result: { repo: { id, setupCommand: null } } })
    expect(await call('repo', 'list')).toMatchObject({ ok: true, result: { repos: [{ id, setupCommand: null }] } })
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(4097)]) {
      expect([JSON.stringify(bad.slice(0, 8)), await rejected('repo', 'set-setup-command', '--repo', id, '--command', bad)]).toEqual([JSON.stringify(bad.slice(0, 8)), 'invalid_argument'])
    }
    expect(await rejected('repo', 'set-setup-command', '--repo', id, '--command', 'a\0b')).toBe('invalid_argument')
    expect(fs.readFileSync(file).equals(before)).toBe(true)
    await register('npm ci --prefix app && npm ci --prefix mobile')
    await restart()
    expect(await call('repo', 'show', '--repo', id)).toMatchObject({ result: { repo: { setupCommand: 'npm ci --prefix app && npm ci --prefix mobile' } } })
    expect(await call('repo', 'list')).toMatchObject({ result: { repos: [{ setupCommand: 'npm ci --prefix app && npm ci --prefix mobile' }] } })
    expect((await call('repo', 'set-setup-command', '--repo', id, '--command', 'null')).ok).toBe(true)
    expect(await call('repo', 'show', '--repo', id)).toMatchObject({ result: { repo: { setupCommand: null } } })
    // Clearing removes the field: the record is byte-identical to before registration.
    expect(fs.readFileSync(file).equals(before)).toBe(true)
  })

  it('C2·C3·C6: inherit runs the registered command after git, in the worktree, with corral env and the login-shell PATH; output goes to a log under userData', async () => {
    const { root, real, register, call, worktreePath, git } = await fixture()
    await register('pwd > "$CORRAL_WORKTREE_PATH/../../../../marker-cwd"; echo "$CORRAL_WORKTREE_PATH|$CORRAL_ROOT_PATH|$PATH" > ../../../../marker-env; git -C "$CORRAL_WORKTREE_PATH" rev-parse --abbrev-ref HEAD > ../../../../marker-branch; echo to-stdout; echo to-stderr >&2')
    const created = await call('worktree', 'create', '--name', 'wt-a')
    expect(created.ok).toBe(true)
    const receipt = receiptOf(created.result)
    expect(receipt).toMatchObject({ policy: 'inherit', status: 'completed', exitCode: 0, signal: null, pathSource: 'login_shell', error: null })
    expect(typeof receipt.durationMs).toBe('number')
    const target = worktreePath('wt-a')
    const [worktreeEnv, rootEnv, pathEnv] = fs.readFileSync(path.join(root, 'marker-env'), 'utf8').trim().split('|')
    expect(fs.realpathSync(fs.readFileSync(path.join(root, 'marker-cwd'), 'utf8').trim())).toBe(target)
    expect([worktreeEnv, rootEnv]).toEqual([target, real])
    expect(pathEnv?.startsWith(path.join(root, 'login-bin') + ':')).toBe(true)
    // The command ran after `git worktree add`: the branch was already checked out.
    expect(fs.readFileSync(path.join(root, 'marker-branch'), 'utf8').trim()).toBe('wt-a')
    const log = String(receipt.logPath)
    expect(log.startsWith(setupLogDirectory(path.join(root, 'data')) + path.sep)).toBe(true)
    const text = fs.readFileSync(log, 'utf8')
    expect(text).toContain('to-stdout')
    expect(text).toContain('to-stderr')
    expect(git(target, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  it('C2: skip runs nothing; inherit without a command runs nothing; run without a command is refused before git', async () => {
    const { root, id, call, rejected, register, worktreePath, branchExists, logs } = await fixture()
    expect(receiptOf((await call('worktree', 'create', '--name', 'none')).result)).toEqual({ policy: 'inherit', status: 'skipped', reason: 'no_command', command: null, logPath: null })
    const refused = await call('worktree', 'create', '--name', 'must-run', '--setup', 'run')
    expect(refused).toMatchObject({ ok: false, error: { code: 'setup_not_configured' }, _meta: { outcome: 'not_started' } })
    expect([fs.existsSync(worktreePath('must-run')), branchExists('must-run'), logs()]).toEqual([false, false, []])
    expect(await rejected('worktree', 'create', '--name', 'bad', '--setup', 'always')).toBe('invalid_argument')
    await register(`echo ran >> '${path.join(root, 'count')}'`)
    expect(receiptOf((await call('worktree', 'create', '--name', 'skipped', '--setup', 'skip')).result)).toMatchObject({ policy: 'skip', status: 'skipped', reason: 'policy_skip' })
    expect(fs.existsSync(path.join(root, 'count'))).toBe(false)
    expect(receiptOf((await call('worktree', 'create', '--name', 'ran', '--setup', 'run')).result)).toMatchObject({ policy: 'run', status: 'completed' })
    expect(fs.readFileSync(path.join(root, 'count'), 'utf8')).toBe('ran\n')
    expect((await call('repo', 'show', '--repo', id)).ok).toBe(true)
  })

  it('C3: when the login shell probe fails, the runtime PATH is used and the receipt says so', async () => {
    const { root, register, call } = await fixture()
    const broken = path.join(root, 'broken-shell')
    fs.writeFileSync(broken, '#!/bin/sh\nexit 7\n', { mode: 0o755 })
    process.env.SHELL = broken
    await register('true')
    expect(receiptOf((await call('worktree', 'create', '--name', 'p')).result)).toMatchObject({ status: 'completed', pathSource: 'process' })
  })

  it('C4: a failing command keeps the worktree and branch and fails with setup_failed and its resources', async () => {
    const { register, call, worktreePath, branchExists } = await fixture()
    await register('echo boom >&2; exit 3')
    const response = await call('worktree', 'create', '--name', 'broken')
    expect(response).toMatchObject({ ok: false, error: { code: 'setup_failed', resources: { path: worktreePath('broken'), branch: 'broken', setupReceipt: { status: 'failed', exitCode: 3 } } } })
    const resources = isRecord(response.error?.resources) ? response.error.resources : {}
    expect(response.error?.message).toContain(String(resources.logPath))
    expect(fs.readFileSync(String(resources.logPath), 'utf8')).toContain('boom')
    expect([fs.existsSync(path.join(worktreePath('broken'), '.git')), branchExists('broken')]).toEqual([true, true])
  })

  it('C4: with --agent a failed setup is stages.setup failed, later stages still run, and a replay does not run it again', async () => {
    const { root, register, call } = await fixture()
    const counter = path.join(root, 'counter')
    await register(`echo run >> '${counter}'; exit 5`)
    const args = ['worktree', 'create', '--name', 'agent-wt', '--agent', 'claude', '--request-id', `r1.${Date.now()}.${randomUUID()}`]
    const first = await call(...args)
    expect(first.ok).toBe(true)
    const stages = isRecord(first.result) && isRecord(first.result.stages) ? first.result.stages : {}
    expect(Object.keys(stages)).toEqual(['worktree', 'setup', 'terminal', 'agent', 'prompt'])
    expect(stages.setup).toMatchObject({ status: 'failed', reason: 'failed', error: 'setup_failed', exitCode: 5 })
    // The fixture has no terminal backend: the terminal stage was attempted after the failed setup.
    expect(stages.terminal).toMatchObject({ status: 'failed', error: 'backend_unavailable' })
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\n')
    expect(await call(...args)).toMatchObject({ ok: true, result: { replayed: true, stages: { setup: { status: 'failed' } } } })
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\n')
  })

  it('C5: past the request budget the whole process group is killed and the worktree stays', async () => {
    const { root, data, id, register, worktreePath } = await fixture()
    const pids = path.join(root, 'pids')
    await register(`echo $$ >> '${pids}'; sleep 60 & echo $! >> '${pids}'; sleep 60`)
    const parser = new CommandRegistry()
    parser.register(workspaceModule(data))
    const started = Date.now()
    const response = await localCall(socketPath(data), request(parser.parse(['worktree', 'create', '--name', 'slow', '--repo', id, '--timeout-ms', '3000'], root)))
    expect(Date.now() - started).toBeLessThan(3000)
    expect(response).toMatchObject({ ok: false, error: { code: 'setup_timed_out', resources: { path: worktreePath('slow'), setupReceipt: { status: 'timed_out' } } } })
    const listed = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number)
    expect(listed).toHaveLength(2)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(listed.map(alive)).toEqual([false, false])
    expect(fs.existsSync(worktreePath('slow'))).toBe(true)
  })

  it('C7: worktree setup runs the command in an existing worktree made by plain git; no command is refused without effect', async () => {
    const { root, real, git, repo, register, call, logs } = await fixture()
    const outside = path.join(root, 'by-git')
    git(repo, 'worktree', 'add', '-b', 'by-git', outside)
    const none = await call('worktree', 'setup', '--worktree', `path:${outside}`)
    expect(none).toMatchObject({ ok: false, error: { code: 'setup_not_configured' }, _meta: { outcome: 'not_started' } })
    expect(logs()).toEqual([])
    await register('echo "$CORRAL_WORKTREE_PATH|$CORRAL_ROOT_PATH" > marker')
    const done = await call('worktree', 'setup', '--worktree', `path:${outside}`)
    expect(done).toMatchObject({ ok: true, result: { worktree: { path: fs.realpathSync(outside) }, setupReceipt: { policy: 'run', status: 'completed', exitCode: 0 } } })
    expect(fs.readFileSync(path.join(outside, 'marker'), 'utf8').trim()).toBe(`${fs.realpathSync(outside)}|${real}`)
    await register('exit 9')
    expect(await call('worktree', 'setup', '--worktree', `path:${outside}`)).toMatchObject({ ok: false, error: { code: 'setup_failed', resources: { path: fs.realpathSync(outside), branch: 'by-git', setupReceipt: { exitCode: 9 } } } })
  })

  it('C8: files inside the repository never become the command', async () => {
    const { root, repo, git, data, call } = await fixture()
    const marker = (name: string) => path.join(root, `marker-${name}`)
    fs.writeFileSync(path.join(repo, 'orca.yaml'), `scripts:\n  setup: touch '${marker('orca')}'\n`)
    fs.writeFileSync(path.join(repo, 'conductor.json'), JSON.stringify({ scripts: { setup: `touch '${marker('conductor')}'` } }))
    fs.mkdirSync(path.join(repo, '.corral'))
    fs.writeFileSync(path.join(repo, '.corral', 'setup.sh'), `#!/bin/sh\ntouch '${marker('corral')}'\n`, { mode: 0o755 })
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'hooks in repo')
    // A second, newly registered repo carrying the same files.
    const other = path.join(root, 'other')
    git(root, 'clone', '-q', repo, other)
    expect((await call('repo', 'add', '--path', other)).result).toMatchObject({ repo: { setupCommand: null } })
    const otherId = new RepoRegistry(data).records().find(row => row.path === fs.realpathSync(other))!.id
    const targets: [string, string][] = [[otherId, 'fresh'], [new RepoRegistry(data).records()[0]!.id, 'first']]
    for (const [repoId, name] of targets) {
      expect(receiptOf((await call('worktree', 'create', '--name', name, '--repo', repoId)).result)).toMatchObject({ status: 'skipped', reason: 'no_command' })
    }
    expect((await call('worktree', 'setup', '--worktree', 'branch:fresh')).error?.code).toBe('setup_not_configured')
    expect(['orca', 'conductor', 'corral'].map(name => fs.existsSync(marker(name)))).toEqual([false, false, false])
  })

  it('C10: --run-hooks stays unsupported without naming LIFE-412', async () => {
    const { call, rejected } = await fixture()
    expect((await call('worktree', 'create', '--name', 'x')).ok).toBe(true)
    for (const args of [['worktree', 'rm', '--worktree', 'branch:x', '--run-hooks'], ['worktree', 'create', '--name', 'y', '--run-hooks']]) {
      expect(await rejected(...args)).toBe('unsupported')
      try { await call(...args) } catch (error) { expect(String(error instanceof Error ? error.message : error)).not.toContain('LIFE-412') }
    }
  })

  it('A1 C2+: workspace reads answer at once while a setup command holds the lane', async () => {
    const { register, call, callWithin } = await fixture()
    await register('sleep 3')
    const creating = callWithin(15000, 'worktree', 'create', '--name', 'slow-read', '--timeout-ms', '15000')
    await new Promise(resolve => setTimeout(resolve, 700))
    for (const args of [['repo', 'list'], ['worktree', 'list'], ['repo', 'show', '--repo', 'repo']]) {
      const started = Date.now()
      expect((await call(...args)).ok).toBe(true)
      expect([args.join(' '), Date.now() - started < 1000]).toEqual([args.join(' '), true])
    }
    expect(await creating).toMatchObject({ ok: true, result: { setupReceipt: { status: 'completed' } } })
  })

  it('A3 C3+: a login shell that hangs costs only part of the budget; the command starts with the runtime PATH', async () => {
    const { root, register, callWithin } = await fixture()
    const hang = path.join(root, 'hanging-shell')
    fs.writeFileSync(hang, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
    process.env.SHELL = hang
    await register(`echo started > '${path.join(root, 'started')}'`)
    const begun = Date.now()
    const response = await callWithin(6000, 'worktree', 'create', '--name', 'hang', '--timeout-ms', '6000')
    expect(response).toMatchObject({ ok: true, result: { setupReceipt: { status: 'completed', pathSource: 'process' } } })
    expect(Date.now() - begun).toBeLessThan(4000)
    expect(fs.readFileSync(path.join(root, 'started'), 'utf8')).toBe('started\n')
  })

  it('A4 C4+: with a request id, create without --agent and worktree setup replay the recorded result — present or removed', async () => {
    const { root, git, repo, register, call, worktreePath } = await fixture()
    const counter = path.join(root, 'counter')
    await register(`echo run >> '${counter}'`)
    const id = `r1.${Date.now()}.${randomUUID()}`
    const first = await call('worktree', 'create', '--name', 'once', '--request-id', id)
    expect(first).toMatchObject({ ok: true, result: { replayed: false, setupReceipt: { status: 'completed' } } })
    expect(await call('worktree', 'create', '--name', 'once', '--request-id', id)).toMatchObject({ ok: true, result: { replayed: true } })
    expect((await call('worktree', 'rm', '--worktree', 'branch:once', '--force')).ok).toBe(true)
    expect(fs.existsSync(worktreePath('once'))).toBe(false)
    expect(await call('worktree', 'create', '--name', 'once', '--request-id', id)).toMatchObject({ ok: true, result: { replayed: true } })
    expect(fs.existsSync(worktreePath('once'))).toBe(false)
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\n')
    // A failure is recorded too: the same id answers the same setup_failed, without running again.
    await register(`echo fail >> '${counter}'; exit 2`)
    const failId = `r1.${Date.now()}.${randomUUID()}`
    const failed = await call('worktree', 'create', '--name', 'fails', '--request-id', failId)
    expect(failed).toMatchObject({ ok: false, error: { code: 'setup_failed', resources: { path: worktreePath('fails'), branch: 'fails', replayed: false } } })
    expect((await call('worktree', 'rm', '--worktree', 'branch:fails', '--force')).ok).toBe(true)
    expect(await call('worktree', 'create', '--name', 'fails', '--request-id', failId)).toMatchObject({ ok: false, error: { code: 'setup_failed', resources: { replayed: true, setupReceipt: { exitCode: 2 } } } })
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\nfail\n')
    // worktree setup: same id, one run.
    const outside = path.join(root, 'by-git')
    git(repo, 'worktree', 'add', '-b', 'by-git', outside)
    const setupId = `r1.${Date.now()}.${randomUUID()}`
    expect((await call('worktree', 'setup', '--worktree', `path:${outside}`, '--request-id', setupId)).error?.code).toBe('setup_failed')
    expect((await call('worktree', 'setup', '--worktree', `path:${outside}`, '--request-id', setupId)).error?.resources).toMatchObject({ replayed: true })
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\nfail\nfail\n')
    // A refusal that ran nothing does not spend the id (not_started releases it).
    await register('null')
    const refusedId = `r1.${Date.now()}.${randomUUID()}`
    expect((await call('worktree', 'setup', '--worktree', `path:${outside}`, '--request-id', refusedId)).error?.code).toBe('setup_not_configured')
  })

  it('A5 C5+: closing the runtime kills the setup group at once — a TERM-ignoring child is gone with no timer having run', async () => {
    const { root, register, callWithin, close } = await fixture()
    const pids = path.join(root, 'pids')
    await register(`trap "" TERM; echo $$ >> '${pids}'; sleep 60 & echo $! >> '${pids}'; wait`)
    const creating = callWithin(30000, 'worktree', 'create', '--name', 'quit', '--timeout-ms', '30000').catch(error => error)
    await until(() => pidsIn(pids).length === 2)
    const listed = pidsIn(pids)
    expect(listed.map(running)).toEqual([true, true])
    const closing = close()
    // The app exits right after close: block the event loop so no timer (TERM grace) can fire.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    expect(listed.map(running)).toEqual([false, false])
    await closing.catch(() => {})
    await creating
  })

  it('A8 C1+: a hand-edited invalid command in repos.json is refused with setup_command_invalid and never runs', async () => {
    const { data, root, call, worktreePath, branchExists } = await fixture()
    const registry = new RepoRegistry(data)
    for (const bad of ['', '   ', `touch '${path.join(root, 'nl')}'\nx`, `touch '${path.join(root, 'nul')}'\0`, 'x'.repeat(4097)]) {
      registry.change(state => { state.repos[0]!.setupCommand = bad })
      const response = await call('worktree', 'create', '--name', 'bad-cmd')
      expect([JSON.stringify(bad.slice(0, 6)), response.error?.code, response._meta?.outcome]).toEqual([JSON.stringify(bad.slice(0, 6)), 'setup_command_invalid', 'not_started'])
      expect([fs.existsSync(worktreePath('bad-cmd')), branchExists('bad-cmd')]).toEqual([false, false])
      expect((await call('worktree', 'setup', '--worktree', `path:${fs.realpathSync(path.join(root, 'repo'))}`)).error?.code).toBe('setup_command_invalid')
    }
    expect([fs.existsSync(path.join(root, 'nl')), fs.existsSync(path.join(root, 'nul'))]).toEqual([false, false])
    // skip never reads it.
    expect((await call('worktree', 'create', '--name', 'skip-bad', '--setup', 'skip')).ok).toBe(true)
  })

  it('A2 C10+: the external worktree watcher sees a git worktree add and nothing runs the setup command', async () => {
    const { root, real, git, repo, register, logs } = await fixture()
    const marker = path.join(root, 'watch-marker')
    await register(`touch '${marker}'`)
    const seen: string[][] = []
    const poller = new WorktreePoller({ roots: () => [real], onChange: changed => { seen.push(changed) } })
    await poller.tick()
    git(repo, 'worktree', 'add', '-b', 'external', path.join(root, 'external'))
    expect(await poller.tick()).toEqual([real])
    expect(seen.at(-1)).toEqual([real])
    await new Promise(resolve => setTimeout(resolve, 300))
    expect([fs.existsSync(marker), logs()]).toEqual([false, []])
    // The only caller of the runner is the runtime workspace module (create / worktree setup).
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const callers = execFileSync('grep', ['-rl', '--include=*.ts', 'runSetupCommand(', src], { encoding: 'utf8' }).trim().split('\n').map(file => path.relative(src, file)).filter(file => !file.endsWith('.test.ts')).sort()
    expect(callers).toEqual(['runtime/workspace/index.ts', 'runtime/workspace/setup.ts'])
  })

  it('B1 C4++: with a request id, every refusal before git or the command is not_started — the same id repeats it, and runs once the cause is fixed', async () => {
    const { root, git, repo, data, register, call, worktreePath } = await fixture()
    const rid = () => `r1.${Date.now()}.${randomUUID()}`
    const twice = async (args: string[], code: string) => {
      for (const n of [1, 2]) {
        const response = await call(...args)
        expect([n, args.join(' '), response.error?.code, response._meta?.outcome]).toEqual([n, args.join(' '), code, 'not_started'])
      }
    }
    // already_exists (a branch of that name) — with and without --agent.
    git(repo, 'branch', 'taken')
    const plain = ['worktree', 'create', '--name', 'taken', '--request-id', rid()]
    const agent = ['worktree', 'create', '--name', 'taken', '--agent', 'claude', '--request-id', rid()]
    await twice(plain, 'already_exists')
    await twice(agent, 'already_exists')
    git(repo, 'branch', '-D', 'taken')
    expect((await call(...plain)).ok).toBe(true)
    git(repo, 'worktree', 'remove', '--force', worktreePath('taken')); git(repo, 'branch', '-D', 'taken')
    expect(await call(...agent)).toMatchObject({ ok: true, result: { replayed: false, stages: { worktree: { status: 'completed' } } } })
    // A missing base ref, then the ref appears.
    const noRef = ['worktree', 'create', '--name', 'from-ref', '--base-branch', 'later', '--request-id', rid()]
    await twice(noRef, 'invalid_argument')
    git(repo, 'branch', 'later')
    expect((await call(...noRef)).ok).toBe(true)
    // An invalid branch name and an unknown repo selector repeat their refusal.
    await twice(['worktree', 'create', '--name', 'bad..name', '--request-id', rid()], 'invalid_argument')
    await twice(['worktree', 'create', '--name', 'x', '--repo', 'no-such-repo', '--request-id', rid()], 'not_found')
    // --setup run without a command, then a command is registered.
    const counter = path.join(root, 'counter')
    const mustRun = ['worktree', 'create', '--name', 'must-run', '--setup', 'run', '--request-id', rid()]
    await twice(mustRun, 'setup_not_configured')
    await register(`echo run >> '${counter}'`)
    expect(await call(...mustRun)).toMatchObject({ ok: true, result: { setupReceipt: { status: 'completed' } } })
    // An invalid hand-edited command, then it is fixed — worktree setup this time.
    const outside = path.join(root, 'by-git')
    git(repo, 'worktree', 'add', '-b', 'by-git', outside)
    new RepoRegistry(data).change(state => { state.repos[0]!.setupCommand = '   ' })
    const setupArgs = ['worktree', 'setup', '--worktree', `path:${outside}`, '--request-id', rid()]
    await twice(setupArgs, 'setup_command_invalid')
    await register(`echo run >> '${counter}'`)
    expect(await call(...setupArgs)).toMatchObject({ ok: true, result: { replayed: false, setupReceipt: { status: 'completed' } } })
    expect(await call(...setupArgs)).toMatchObject({ ok: true, result: { replayed: true } })
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\nrun\n')
  })

  it('B2 C4++: a setup cut short by cancellation is not recorded as a failure — the same id answers outcome_unknown and never runs it again', async () => {
    const { root, register, callWithin, close, restart, call, worktreePath } = await fixture()
    const pids = path.join(root, 'pids'), counter = path.join(root, 'counter')
    await register(`echo run >> '${counter}'; echo $$ >> '${pids}'; sleep 60`)
    const id = `r1.${Date.now()}.${randomUUID()}`
    const args = ['worktree', 'create', '--name', 'cut', '--request-id', id, '--timeout-ms', '30000']
    const first = callWithin(30000, ...args).catch(error => error)
    await until(() => pidsIn(pids).length === 1)
    await close()
    await first
    await restart()
    const again = await call(...args)
    expect(again).toMatchObject({ ok: false, error: { code: 'outcome_unknown' } })
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\n')
    expect(fs.existsSync(worktreePath('cut'))).toBe(true)
    // The log says it was cancelled, not that the command failed on its own.
    const logs = fs.readdirSync(setupLogDirectory(path.join(root, 'data')))
    expect(fs.readFileSync(path.join(setupLogDirectory(path.join(root, 'data')), logs[0]!), 'utf8')).toContain('cancelled')
  })

  it('B6: 「작업에서 시작」 retrying the same attemptId after an app restart — a fixed refusal runs, a cancelled setup is unknown and linked', async () => {
    const { root, real, git, repo, register, invoke, close, restart, worktreePath } = await fixture()
    const saved: string[] = []
    const links = {
      saveExplicit: ({ path: at }: { path: string }) => { saved.push(at); return true },
      claimExplicit: ({ path: at }: { path: string }): ClaimResult => { saved.push(at); return 'saved' },
      sourceSave: async (): Promise<StartSourceLink> => ({ state: 'skipped', message: null }),
    }
    // A closed runtime answers request_cancelled at once, and the service retries that until its deadline — keep both short.
    const service = () => new StartService({ invoke: () => invoke(), repos: () => [testRepo({ root: real, worktrees: [] })], links: () => links, work: () => null, log: () => {}, cwd: root, sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 100))), deadlineMs: 2000, worktreeExists: at => fs.existsSync(at) })
    const given = (name: string): StartWorkInput => ({ attemptId: newAttemptId({ now: Date.now(), uuid: randomUUID() }), connectionId: 'c', sourceId: 's', itemId: name, itemKey: 'K-1', repoRoot: real, name, agent: 'shell', model: '', effort: '', prompt: '', submit: false })
    // A name taken by a branch: the attempt fails before git. After the branch is gone, the same id (new service = app restart) creates it.
    git(repo, 'branch', 'busy')
    const busy = given('busy')
    expect((await service().start(busy)).stages.worktree).toMatchObject({ status: 'failed', code: 'already_exists' })
    git(repo, 'branch', '-D', 'busy')
    const retried = await service().start(busy)
    expect(retried.stages.worktree.status).toBe('completed')
    expect(retried.worktreePath).toBe(worktreePath('busy'))
    // A setup cut by the runtime closing: the same id after restart is outcome_unknown — worktree unknown but linked, nothing re-run.
    const counter = path.join(root, 'counter')
    await register(`echo run >> '${counter}'; sleep 60`)
    const cut = given('cut')
    const pending = service().start(cut)
    await until(() => fs.existsSync(counter))
    await close()
    // The attempt that was cut: its result is unknown, and the worktree it made is linked (it was not there before).
    const cutResult = await pending
    expect(cutResult.stages.worktree.status).toBe('unknown')
    expect(cutResult.worktreePath).toBe(worktreePath('cut'))
    expect(saved).toContain(worktreePath('cut'))
    await restart()
    // The same id after restart: the runtime answers outcome_unknown (pending receipt) — not a replayed failure, not a second run.
    // This service saw the worktree before asking, so it does not link it again (R2-A); the first attempt already did.
    const after = await service().start(cut)
    expect(after.stages.worktree).toMatchObject({ status: 'unknown', code: 'outcome_unknown' })
    expect(after.worktreePath).toBe(null)
    expect(fs.readFileSync(counter, 'utf8')).toBe('run\n')
  })

  // LIFE-813 r3 C1 — the same runtime, no restart: a restart answers outcome_unknown for any older id
  // whatever its receipt says, so only a same-runtime retry tells pending from released or recorded.
  describe('r3 C1: same-runtime cancellation and failure after the effect keep the receipt pending', () => {
    const cases: [string, (outside: string) => string[]][] = [
      ['worktree setup', outside => ['worktree', 'setup', '--worktree', `path:${outside}`, '--timeout-ms', '30000']],
      ['worktree create', () => ['worktree', 'create', '--name', 'cut', '--timeout-ms', '30000']],
      ['worktree create --agent', () => ['worktree', 'create', '--name', 'cut', '--agent', 'claude', '--timeout-ms', '30000']],
    ]
    for (const [label, argsOf] of cases) {
      it(`${label}: a client that hangs up mid-setup — the group dies and the same id is outcome_unknown, never run again`, async () => {
        const { root, git, repo, register, callCancelled, call } = await fixture()
        const outside = path.join(root, 'by-git')
        git(repo, 'worktree', 'add', '-b', 'by-git', outside)
        const pids = path.join(root, 'pids'), counter = path.join(root, 'counter')
        await register(`echo run >> '${counter}'; echo $$ >> '${pids}'; sleep 60`)
        const args = [...argsOf(outside), '--request-id', `r1.${Date.now()}.${randomUUID()}`]
        const hangUp = new AbortController()
        const first = callCancelled(hangUp.signal, ...args)
        await until(() => pidsIn(pids).length === 1)
        hangUp.abort()
        await first
        await until(() => !running(pidsIn(pids)[0]!))
        const again = await call(...args)
        expect([label, again.error?.code]).toEqual([label, 'outcome_unknown'])
        expect(fs.readFileSync(counter, 'utf8')).toBe('run\n')
      })
    }

    it('a cancelled setup answers request_cancelled with its own message and the log path (create and create --agent)', async () => {
      const { root, register, invoke, close, parse } = await fixture()
      const counter = path.join(root, 'counter')
      await register(`echo run >> '${counter}'; sleep 60`)
      const dispatch = invoke()
      const answer = dispatch(parse(['worktree', 'create', '--name', 'cut-plain', '--request-id', `r1.${Date.now()}.${randomUUID()}`]), 30000)
      await until(() => fs.existsSync(counter))
      void close()
      const response = await answer
      expect(response.error?.code).toBe('request_cancelled')
      expect(response.error?.message.startsWith('Setup command cancelled')).toBe(true)
      expect(response.error?.resources).toMatchObject({ branch: 'cut-plain', logPath: expect.stringContaining('worktree-setup') })
    })

    it('… and with --agent the cancellation is rethrown, not folded into stages', async () => {
      const { root, register, invoke, close, parse } = await fixture()
      const counter = path.join(root, 'counter')
      await register(`echo run >> '${counter}'; sleep 60`)
      const answer = invoke()(parse(['worktree', 'create', '--name', 'cut-agent', '--agent', 'claude', '--request-id', `r1.${Date.now()}.${randomUUID()}`]), 30000)
      await until(() => fs.existsSync(counter))
      void close()
      const response = await answer
      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe('request_cancelled')
      expect(response.error?.message.startsWith('Setup command cancelled')).toBe(true)
    })

    it('git worktree add failing after it began (a post-checkout hook) keeps the id pending — the same id is outcome_unknown', async () => {
      const { repo, call, worktreePath } = await fixture()
      const hook = path.join(repo, '.git', 'hooks', 'post-checkout')
      fs.writeFileSync(hook, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
      const args = ['worktree', 'create', '--name', 'hooked', '--request-id', `r1.${Date.now()}.${randomUUID()}`]
      const first = await call(...args)
      expect(first.error?.code).toBe('git_failed')
      expect(first._meta?.outcome).not.toBe('not_started')
      expect(fs.existsSync(worktreePath('hooked'))).toBe(true)
      fs.rmSync(hook)
      expect((await call(...args)).error?.code).toBe('outcome_unknown')
    })

    it('a released id is runnable in the same runtime only — after a restart the same id is outcome_unknown (documented)', async () => {
      const { git, repo, call, restart } = await fixture()
      git(repo, 'branch', 'taken')
      const args = ['worktree', 'create', '--name', 'taken', '--request-id', `r1.${Date.now()}.${randomUUID()}`]
      expect(await call(...args)).toMatchObject({ ok: false, error: { code: 'already_exists' }, _meta: { outcome: 'not_started' } })
      await restart()
      git(repo, 'branch', '-D', 'taken')
      expect((await call(...args)).error?.code).toBe('outcome_unknown')
    })
  })
})
