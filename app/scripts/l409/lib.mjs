// LIFE-409 fixture library (02-kickoff "격리와 검증"). Modelled on scripts/l394/lib.mjs: the same
// isolation contract and the same raw-record discipline, with this task's owner, root, backend
// session and raw path. Everything a run touches lives under /tmp/l409-<owner>-*; the user's global
// config, default herdr session, installed backend and existing terminals are never touched.
//
// Waiting helpers propagate a timeout as a failure, never as a pass (.agents/agents/reviewer.md).
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { strippedSessionMarkers, withoutSessionMarkers, PRESERVED_NAMES } from '../l394/env.mjs'

export const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export const requestId = () => `r1.${Date.now()}.${randomUUID()}`
export const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

/** Where each owner's raw record goes. A reviewer never writes into the worker's directory. */
const RAW_BY_OWNER = {
  claude: 'raw/worker/claude',
  coordinator: 'raw/coordinator/native',
  'review-codex': 'raw/review/codex',
  'review-claude': 'raw/review/claude',
  'review-grok': 'raw/review/grok',
}

/**
 * Poll until `predicate` returns exactly `true`, or fail. The strict comparison is the contract: a
 * predicate that returns a value cannot say "satisfied, and the value is 0", and a loose check
 * turns those into "not yet" — a timeout that would read as a real failure.
 */
export async function until(predicate, label, ms = 20000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    try { if (await predicate() === true) return true } catch (error) { last = String(error) }
    await pause(40)
  }
  throw Error(`${label} timeout after ${ms}ms; last error ${last ?? 'none'}`)
}

export function rpc(socketPath, request, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(Error('RPC timeout')) }, timeout)
    socket.on('error', error => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      clearTimeout(timer); socket.destroy()
      try { resolve(JSON.parse(buffer.split('\n')[0])) } catch (error) { reject(error) }
    })
  })
}

export async function fixture(label, options = {}) {
  const backend = options.backend ?? process.env.CORRAL_TEST_BACKEND
  assert(backend && fs.existsSync(backend), 'Set CORRAL_TEST_BACKEND to the isolated guard build under test')
  const owner = process.env.CORRAL_VERIFY_OWNER ?? 'claude'
  assert(RAW_BY_OWNER[owner], `CORRAL_VERIFY_OWNER must be one of ${Object.keys(RAW_BY_OWNER).join(', ')}`)
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/l409-' + owner + '-' + label.slice(0, 4) + '-'))
  const runId = path.basename(root)
  const raw = path.resolve(process.env.CORRAL_VERIFY_RAW
    ?? path.join(app, '../specs/LIFE-409-cli-orchestration-core', RAW_BY_OWNER[owner], label, runId))
  fs.mkdirSync(raw, { recursive: true })
  const home = path.join(root.replace(/^\/private\/tmp(?=\/)/, '/tmp'), 'c'), repo = path.join(root, 'repo')
  for (const dir of [home, repo]) fs.mkdirSync(dir, { mode: 0o700 })
  const config = path.join(home, 'herdr.toml')
  fs.writeFileSync(config, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const session = 'life409-' + owner + '-' + runId.slice(-6)
  const socket = path.join(home, 'herdr-dev/sessions', session, 'herdr.sock')
  assert(Buffer.byteLength(socket) < 104, 'Fixture socket path exceeds the macOS limit; use a shorter label')
  // §7.3/§8.2: strip the inherited provider session markers or a launched provider treats itself as
  // a nested session. CODEX_HOME, GROK_HOME and CLAUDE_CONFIG_DIR are deliberately preserved.
  const stripped = strippedSessionMarkers(process.env)
  const base = {
    ...withoutSessionMarkers(process.env),
    CORRAL_BACKEND_SOCKET: socket, HERDR_SOCKET_PATH: socket, CORRAL_SESSION: session, HERDR_SESSION: session,
    HERDR_CONFIG_PATH: config, XDG_CONFIG_HOME: home, CORRAL_REGISTRY: path.join(root, 'repos.json'), SHELL: '/bin/sh',
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_CLI_SOCKET', 'CORRAL_ELECTRON']) delete base[key]

  const children = [], commands = [], observations = [], checks = []
  observations.push({ strippedEnv: stripped, preservedEnv: Object.fromEntries(PRESERVED_NAMES.map(name => [name, base[name] ?? null])) })

  function client(name) {
    const data = path.join(root, name)
    fs.mkdirSync(data, { mode: 0o700 })
    return { ...base, CORRAL_USER_DATA: data }
  }
  const env = client('headless')
  /** The single orchestration document of a profile, and the primitives every byte check uses. */
  const stateFile = (environment = env) => path.join(environment.CORRAL_USER_DATA, 'runtime/orchestration/state.json')
  const stateBytes = (environment = env) => fs.existsSync(stateFile(environment)) ? fs.readFileSync(stateFile(environment)) : Buffer.alloc(0)
  const stateDigest = (environment = env) => createHash('sha256').update(stateBytes(environment)).digest('hex')
  const stateJson = (environment = env) => JSON.parse(stateBytes(environment).toString('utf8') || 'null')

  function start(exe, args, environment, name) {
    const fd = fs.openSync(path.join(raw, name + '.log'), 'a')
    const child = spawn(exe, args, { env: environment, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    children.push(child)
    observations.push({ name, pid: child.pid, exe, args: args.slice(0, 4) })
    return child
  }
  async function run(exe, args, environment = env, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd: options.cwd ?? repo, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
      options.onSpawn?.(child)
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => stdout += chunk)
      child.stderr.on('data', chunk => stderr += chunk)
      child.on('error', reject)
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('command timeout')) }, options.timeout ?? 60000)
      child.stdin.end(options.stdin)
      child.on('close', (exit, signal) => {
        clearTimeout(timer)
        const result = { at: new Date().toISOString(), exe, args, profile: environment.CORRAL_USER_DATA, exit, signal, stdout, stderr }
        if (options.record !== false) commands.push(result)
        resolve(result)
      })
    })
  }
  /** Run the CLI and return the parsed envelope. `fail: true` asserts exit 1 and ok false. */
  async function cli(args, options = {}) {
    const result = await run(process.execPath, [path.join(app, 'cli/corral.mjs'), ...args, '--json'], options.env ?? env, options)
    const json = JSON.parse(result.stdout)
    if (options.fail === undefined) {
      assert.equal(result.exit, 0, JSON.stringify(result))
      assert.equal(json.ok, true, JSON.stringify(json))
    } else if (options.fail) {
      assert.equal(result.exit, 1, JSON.stringify(result))
      assert.equal(json.ok, false, JSON.stringify(json))
    }
    return json
  }
  /** Neither asserts nor rejects: used where several racing calls are expected to disagree. */
  async function cliRaw(args, options = {}) {
    const result = await run(process.execPath, [path.join(app, 'cli/corral.mjs'), ...args, '--json'], options.env ?? env, options)
    let json = null
    try { json = JSON.parse(result.stdout) } catch { /* reported as raw stdout instead */ }
    return { ...result, json }
  }
  async function backendRpc(method, params = {}) {
    const request = { id: randomUUID(), method, params }
    const result = await rpc(socket, request)
    observations.push({ at: new Date().toISOString(), backend: { method, response: result } })
    assert(!result.error, JSON.stringify(result))
    return result.result
  }
  async function stop(child, signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode) return
    child.kill(signal)
    await until(() => child.exitCode !== null || child.signalCode !== null, `child ${child.pid} exit (${signal})`)
  }
  async function startBackend(name = 'backend') {
    const child = start(backend, ['--session', session, 'server'], base, name)
    await until(async () => (await backendRpc('corral.terminal')).guard_version === 1, 'backend guard ready')
    return child
  }
  /** The CLI is a socket client; every fixture needs a runtime of its own to talk to. */
  async function serve(environment = env, name = 'serve') {
    const child = start(process.execPath, [path.join(app, 'cli/corral.mjs'), 'serve', '--json'], environment, name)
    // Short per-probe timeout, long overall budget: one slow probe must not consume the whole
    // deadline and turn a loaded machine into a reported product failure.
    await until(async () => (await rpc(path.join(environment.CORRAL_USER_DATA, 'runtime/rpc.sock'),
      { version: 1, id: 'ready', invocation: { command: 'status', flags: {}, args: [], cwd: repo } }, 3000)).ok === true, 'runtime ready', 60000)
    return child
  }
  /** Stop a runtime with an explicit signal and bring a fresh one up on the same profile (F2). */
  async function restart(child, signal, environment = env, name = 'serve') {
    const before = (await cli(['status'], { env: environment })).result.runtime
    await stop(child, signal)
    const next = await serve(environment, name)
    const after = (await cli(['status'], { env: environment })).result.runtime
    assert.equal(after.runtimeId, before.runtimeId, 'runtimeId must survive a restart')
    assert.notEqual(after.instanceId, before.instanceId, 'instanceId must change on restart')
    observations.push({ restart: { signal, runtimeId: after.runtimeId, before: before.instanceId, after: after.instanceId } })
    return { child: next, before, after }
  }
  /** `terminal create --worktree` resolves through the profile's repo registry, so register once. */
  const registered = new Set()
  async function registerRepo(environment = env) {
    if (registered.has(environment.CORRAL_USER_DATA)) return
    const result = await cliRaw(['repo', 'add', '--path', repo], { env: environment })
    assert(result.exit === 0 || result.json?.error?.code === 'already_exists', JSON.stringify(result))
    registered.add(environment.CORRAL_USER_DATA)
  }
  /** A plain shell pane in the isolated backend. Nothing is ever sent to it afterwards. */
  async function pane(title, environment = env, worktree = repo) {
    await registerRepo(environment)
    const response = await cli(['terminal', 'create', '--worktree', worktree, '--title', title], { env: environment })
    return response.result.terminal
  }
  async function check(id, fn) {
    const at = new Date().toISOString()
    try { const detail = await fn(); checks.push({ id, pass: true, at, detail }); return detail }
    catch (error) { checks.push({ id, pass: false, at, error: String(error), stack: error.stack }); throw error }
  }
  /** Write one JSON artifact into the raw directory, and return its path for the verdict table. */
  function record(name, value) {
    const file = path.join(raw, name.endsWith('.json') ? name : name + '.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
    return path.relative(path.join(app, '..'), file)
  }
  async function cleanup() {
    for (const child of [...children].reverse()) await stop(child, 'SIGTERM').catch(error => observations.push({ cleanupError: String(error), pid: child.pid }))
    fs.writeFileSync(path.join(raw, 'run.json'), JSON.stringify({
      runId, label, owner, root, appRoot: app, node: process.version, backend,
      binarySHA256: createHash('sha256').update(fs.readFileSync(backend)).digest('hex'),
      session, strippedEnv: stripped, commands, observations, checks,
    }, null, 2) + '\n')
    const failed = checks.filter(entry => !entry.pass)
    console.log(JSON.stringify({ runId, raw, checks: checks.map(({ id, pass }) => ({ id, pass })), failed: failed.length }))
    // A verification script that cannot say "all passed" exits non-zero.
    if (failed.length) process.exitCode = 1
  }

  for (const args of [['init', '-b', 'main', repo],
    ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
    const result = await run('git', args, base, { record: false })
    assert.equal(result.exit, 0, result.stderr)
  }
  return {
    root, raw, repo, home, socket, session, env, base, runId, owner, backend, stripped,
    client, start, run, cli, cliRaw, backendRpc, stop, startBackend, serve, restart, pane, registerRepo,
    stateFile, stateBytes, stateDigest, stateJson, check, record, cleanup, observations, checks, commands,
  }
}
