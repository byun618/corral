// LIFE-394 fixture library (§7.3). Modelled on scripts/l393/lib.mjs: same isolation contract, same
// raw-record discipline, different owner, root, session and raw path. Everything a run touches lives
// under /tmp/l394-<owner>-*; the user's global config, default herdr session and installed backend
// are read-only from here. Waiting helpers propagate a timeout as a failure, never as a pass.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { strippedSessionMarkers, withoutSessionMarkers, PRESERVED_NAMES } from './env.mjs'
export const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const pause = ms => new Promise(r => setTimeout(r, ms))
export const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
export const requestId = () => `r1.${Date.now()}.${randomUUID()}`
export async function until(fn, label, ms = 20000) {
  const deadline = Date.now() + ms; let last
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result } catch (e) { last = String(e) } await pause(40) }
  throw Error(`${label} timeout; last error ${last ?? 'none'}`)
}
export function rpc(socketPath, request, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath); let buffer = ''; const timer = setTimeout(() => { s.destroy(); reject(Error('RPC timeout')) }, timeout)
    s.on('error', e => { clearTimeout(timer); reject(e) }); s.on('connect', () => s.write(JSON.stringify(request) + '\n'))
    s.setEncoding('utf8'); s.on('data', b => { buffer += b; if (buffer.includes('\n')) { clearTimeout(timer); s.destroy(); try { resolve(JSON.parse(buffer.split('\n')[0])) } catch (e) { reject(e) } } })
  })
}
export async function fixture(label, options = {}) {
  const backend = options.backend ?? process.env.CORRAL_TEST_BACKEND
  assert(backend && fs.existsSync(backend), 'Set CORRAL_TEST_BACKEND to the isolated guard build under test')
  const owner = process.env.CORRAL_VERIFY_OWNER ?? 'claude'
  assert(/^(claude|review-codex|review-grok)$/.test(owner), 'CORRAL_VERIFY_OWNER must be claude, review-codex, or review-grok')
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/l394-' + owner + '-' + label.slice(0, 4) + '-'))
  const runId = path.basename(root)
  const raw = path.resolve(process.env.CORRAL_VERIFY_RAW ?? path.join(app, '../specs/LIFE-394-cli-agents/raw/worker', owner, 'impl', runId))
  fs.mkdirSync(raw, { recursive: true })
  const home = path.join(root.replace(/^\/private\/tmp(?=\/)/, '/tmp'), 'c'), repo = path.join(root, 'repo'), linked = path.join(root, 'linked')
  for (const dir of [home, repo]) fs.mkdirSync(dir, { mode: 0o700 })
  const config = path.join(home, 'herdr.toml')
  fs.writeFileSync(config, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const registry = path.join(root, 'repos.json'), session = 'life394-' + owner + '-' + runId.slice(-6)
  const socket = path.join(home, 'herdr-dev/sessions', session, 'herdr.sock')
  assert(Buffer.byteLength(socket) < 104, 'Fixture socket path exceeds the macOS limit; use a shorter label')
  // §7.3/§8.2: strip the inherited provider session markers or a launched provider treats itself as
  // a nested session and writes no record. CODEX_HOME, GROK_HOME and CLAUDE_CONFIG_DIR are kept.
  const stripped = strippedSessionMarkers(process.env)
  const inherited = withoutSessionMarkers(process.env)
  const base = { ...inherited, CORRAL_BACKEND_SOCKET: socket, HERDR_SOCKET_PATH: socket, CORRAL_SESSION: session, HERDR_SESSION: session,
    HERDR_CONFIG_PATH: config, XDG_CONFIG_HOME: home, CORRAL_SHOT_DIR: raw, CORRAL_REGISTRY: registry, SHELL: '/bin/sh' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_CLI_SOCKET', 'CORRAL_ELECTRON']) delete base[key]
  const children = [], commands = [], observations = [], checks = []
  observations.push({ strippedEnv: stripped, preservedEnv: Object.fromEntries(PRESERVED_NAMES.map(name => [name, base[name] ?? null])) })
  function client(name) {
    const data = path.join(root, name); fs.mkdirSync(data, { mode: 0o700 })
    return { ...base, CORRAL_USER_DATA: data, CORRAL_CONTROL_SOCKET: path.join(root, name + '.sock') }
  }
  const env = client('headless')
  /** Install a detect manifest override into the fixture's own herdr config dir (F12b). */
  function override(agent, toml) {
    const directory = path.join(home, 'herdr-dev/agent-detection')
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, agent + '.toml')
    fs.writeFileSync(file, toml)
    observations.push({ overrideInstalled: file, bytes: Buffer.byteLength(toml) })
    return file
  }
  function start(exe, args, environment, name) {
    const fd = fs.openSync(path.join(raw, name + '.log'), 'w')
    const child = spawn(exe, args, { env: environment, stdio: ['ignore', fd, fd] }); fs.closeSync(fd); children.push(child)
    observations.push({ name, pid: child.pid, exe, args }); return child
  }
  async function run(exe, args, environment = env, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd: options.cwd ?? repo, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }); options.onSpawn?.(child)
      let stdout = '', stderr = ''
      child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.on('error', reject)
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('command timeout')) }, options.timeout ?? 60000)
      child.stdin.end(options.stdin)
      child.on('close', (exit, signal) => { clearTimeout(timer); const result = { exe, args, profile: environment.CORRAL_USER_DATA, backendSocket: environment.CORRAL_BACKEND_SOCKET, exit, signal, stdout, stderr }; commands.push(result); resolve(result) })
    })
  }
  async function cli(args, options = {}) {
    const result = await run(process.execPath, [path.join(app, 'cli/corral.mjs'), ...args, '--json'], options.env ?? env, options)
    assert.equal(result.exit, options.fail ? 1 : 0, JSON.stringify(result))
    const json = JSON.parse(result.stdout); assert.equal(json.ok, !options.fail, JSON.stringify(json)); return json
  }
  async function backendRpc(method, params = {}) {
    const request = { id: randomUUID(), method, params }
    const result = await rpc(socket, request)
    observations.push({ at: Date.now(), backend: { request, response: result } })
    assert(!result.error, JSON.stringify(result)); return result.result
  }
  async function stop(child, signal = 'SIGTERM') { if (!child || child.exitCode !== null || child.signalCode) return; child.kill(signal); await until(() => child.exitCode !== null || child.signalCode, 'child exit') }
  /** `guard: false` for an unpatched herdr, which answers `ping` but has no corral.terminal method. */
  async function startBackend(name = 'backend', options = {}) {
    const child = start(options.exe ?? backend, ['--session', session, 'server'], base, name)
    if (options.guard === false) await until(async () => (await rpc(socket, { id: 'ping', method: 'ping', params: {} })) !== undefined, 'backend socket ready')
    else await until(async () => (await backendRpc('corral.terminal')).guard_version === 1, 'backend guard ready')
    return child
  }
  /** The CLI talks to a runtime, not to the backend directly; every fixture needs one. */
  async function serve(environment = env, name = 'serve') {
    const child = start(process.execPath, [path.join(app, 'cli/corral.mjs'), 'serve', '--json'], environment, name)
    await until(async () => (await rpc(path.join(environment.CORRAL_USER_DATA, 'runtime/rpc.sock'),
      { version: 1, id: 'ready', invocation: { command: 'status', flags: {}, args: [], cwd: repo } })).ok, 'runtime ready')
    return child
  }
  async function check(id, fn) {
    const at = new Date().toISOString()
    try { const detail = await fn(); checks.push({ id, pass: true, at, detail }) }
    catch (error) { checks.push({ id, pass: false, at, error: String(error), stack: error.stack }); throw error }
  }
  async function cleanup() {
    for (const child of [...children].reverse()) await stop(child).catch(e => observations.push({ cleanupError: String(e), pid: child.pid }))
    fs.writeFileSync(path.join(raw, 'run.json'), JSON.stringify({ runId, root, appRoot: app, node: process.version,
      backend, binarySHA256: createHash('sha256').update(fs.readFileSync(backend)).digest('hex'),
      strippedEnv: stripped, commands, observations, checks }, null, 2) + '\n')
    const failed = checks.filter(c => !c.pass)
    console.log(JSON.stringify({ runId, raw, checks: checks.map(({ id, pass }) => ({ id, pass })), failed: failed.length }))
    // C4: a verification script that cannot say "all passed" exits non-zero.
    if (failed.length) process.exitCode = 1
  }
  for (const args of [['init', '-b', 'main', repo],
    ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'],
    ['-C', repo, 'worktree', 'add', '-b', 'linked', linked]]) { const r = await run('git', args); assert.equal(r.exit, 0, r.stderr) }
  return { root, raw, repo, linked, home, socket, session, env, base, runId, stripped, client, override, start, run, cli, backendRpc, stop, startBackend, serve, check, cleanup, observations, checks }
}
