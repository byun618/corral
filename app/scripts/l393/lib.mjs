import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
export const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const pause = ms => new Promise(r => setTimeout(r, ms))
export const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
export const requestId = () => `r1.${Date.now()}.${randomUUID()}`
export async function until(fn, label, ms = 15000) {
  const deadline = Date.now() + ms; let last
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result } catch (e) { last = String(e) } await pause(40) }
  throw Error(`${label} timeout; last error ${last ?? 'none'}`)
}
export function rpc(socketPath, request, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath); let buffer = ''; const timer = setTimeout(() => { s.destroy(); reject(Error('RPC timeout')) }, timeout)
    s.on('error', e => { clearTimeout(timer); reject(e) }); s.on('connect', () => s.write(JSON.stringify(request) + '\n'))
    s.setEncoding('utf8'); s.on('data', b => { buffer += b; if (buffer.includes('\n')) { clearTimeout(timer); s.destroy(); try { resolve(JSON.parse(buffer.split('\n')[0])) } catch(e) { reject(e) } } })
  })
}
export async function fixture(label) {
  const backend = process.env.CORRAL_TEST_BACKEND
  assert(backend && fs.existsSync(backend), 'Set CORRAL_TEST_BACKEND to the isolated guard-v1 build')
  const owner = process.env.CORRAL_VERIFY_OWNER ?? 'codex'
  assert(/^(codex|review-codex|review-grok)$/.test(owner), 'CORRAL_VERIFY_OWNER must be codex, review-codex, or review-grok')
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/l393-' + owner + '-' + label.slice(0,4) + '-'))
  const runId = path.basename(root), raw = path.resolve(process.env.CORRAL_VERIFY_RAW ?? path.join(app, '../specs/LIFE-393-cli-terminal/raw', owner, runId))
  fs.mkdirSync(raw, { recursive: true })
  const home = path.join(root.replace(/^\/private\/tmp(?=\/)/, '/tmp'), 'c'), repo = path.join(root, 'repo'), linked = path.join(root, 'linked')
  for (const dir of [home, repo]) fs.mkdirSync(dir, { mode: 0o700 })
  const config = path.join(home, 'herdr.toml')
  fs.writeFileSync(config, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const registry = path.join(root, 'repos.json'), session = 'life393-' + owner + '-' + path.basename(root).slice(-6)
  const socket = path.join(home, 'herdr-dev/sessions', session, 'herdr.sock')
  assert(Buffer.byteLength(socket) < 104, 'Fixture socket path exceeds macOS limit; use a shorter test label')
  const base = { ...process.env, CORRAL_BACKEND_SOCKET: socket, HERDR_SOCKET_PATH: socket, CORRAL_SESSION: session, HERDR_SESSION: session, HERDR_CONFIG_PATH: config, XDG_CONFIG_HOME: home, CORRAL_SHOT_DIR: raw, CORRAL_REGISTRY: registry, SHELL: '/bin/sh' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_CLI_SOCKET', 'CORRAL_ELECTRON']) delete base[key]
  const children = [], commands = [], observations = [], checks = []
  function client(name) {
    const data = path.join(root, name); fs.mkdirSync(data, { mode: 0o700 })
    return { ...base, CORRAL_USER_DATA: data, CORRAL_CONTROL_SOCKET: path.join(root, name + '.sock') }
  }
  const env = client('headless')
  function start(exe, args, environment, name) {
    const fd = fs.openSync(path.join(raw, name + '.log'), 'w')
    const child = spawn(exe, args, { env: environment, stdio: ['ignore', fd, fd] }); fs.closeSync(fd); children.push(child)
    observations.push({ name, pid: child.pid, exe, args }); return child
  }
  async function run(exe, args, environment = env, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd: options.cwd ?? repo, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }); options.onSpawn?.(child); let stdout = '', stderr = ''
      child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.on('error', reject)
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('command timeout')) }, options.timeout ?? 30000)
      child.stdin.end(options.stdin); child.on('close', (exit, signal) => { clearTimeout(timer); const result = { exe, args, profile: environment.CORRAL_USER_DATA, backendSocket: environment.CORRAL_BACKEND_SOCKET, exit, signal, stdout, stderr }; commands.push(result); resolve(result) })
    })
  }
  async function cli(args, options = {}) {
    const result = await run(process.execPath, [path.join(app, 'cli/corral.mjs'), ...args, '--json'], options.env ?? env, options)
    assert.equal(result.exit, options.fail ? 1 : 0, JSON.stringify(result))
    const json = JSON.parse(result.stdout); assert.equal(json.ok, !options.fail, JSON.stringify(json)); return json
  }
  async function backendRpc(method, params = {}) { const request = { id: randomUUID(), method, params }; const result = await rpc(socket, request); observations.push({ at: Date.now(), backend: { request, response: result } }); assert(!result.error, JSON.stringify(result)); return result.result }
  async function stop(child, signal = 'SIGTERM') { if (!child || child.exitCode !== null || child.signalCode) return; child.kill(signal); await until(() => child.exitCode !== null || child.signalCode, 'child exit') }
  async function startBackend(name = 'backend') { const child = start(backend, ['--session', session, 'server'], base, name); await until(async () => (await backendRpc('corral.terminal')).guard_version === 1, 'backend guard ready'); return child }
  async function serve(environment = env, name = 'serve') { const child = start(process.execPath, [path.join(app, 'cli/corral.mjs'), 'serve', '--json'], environment, name); await until(async () => (await rpc(path.join(environment.CORRAL_USER_DATA, 'runtime/rpc.sock'), { version: 1, id: 'ready', invocation: { command: 'status', flags: {}, args: [], cwd: repo } })).ok, 'runtime ready'); return child }
  async function gui(environment, name) {
    const child = start(path.join(app, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [app, `--user-data-dir=${environment.CORRAL_USER_DATA}`], environment, name)
    await until(async () => (await rpc(environment.CORRAL_CONTROL_SOCKET, { cmd: 'state' })).state?.link.phase === 'live', 'GUI connected', 30000)
    return child
  }
  async function control(environment, request) { const response = await rpc(environment.CORRAL_CONTROL_SOCKET, request); observations.push({ at: Date.now(), controlSocket: environment.CORRAL_CONTROL_SOCKET, request, response }); assert(response.ok, JSON.stringify({ request, response })); return response }
  async function receiver(name, environment = env, worktree = repo) {
    const log = path.join(root, name + '.input'), fifo = path.join(root, name + '.fifo'), starts = path.join(root, name + '.starts')
    const made = await run('mkfifo', [fifo]); assert.equal(made.exit, 0)
    const command = ['python3', path.join(app, 'scripts/l393/receiver.py'), log, fifo, starts].map(quote).join(' ')
    const response = await cli(['terminal', 'create', '--worktree', worktree, '--title', 'same-title', '--command', command], { env: environment })
    const terminal = response.result.terminal
    await until(() => fs.existsSync(starts), 'receiver started'); await pause(100)
    return { terminal, command, log, fifo, starts, input: () => fs.existsSync(log) ? fs.readFileSync(log) : Buffer.alloc(0), output: data => fs.writeFileSync(fifo, data) }
  }
  async function check(id, fn) { const at = new Date().toISOString(); try { const detail = await fn(); checks.push({ id, pass: true, at, detail }) } catch (error) { checks.push({ id, pass: false, at, error: String(error), stack: error.stack }); throw error } }
  async function cleanup() {
    for (const child of [...children].reverse()) await stop(child).catch(e => observations.push({ cleanupError: String(e), pid: child.pid }))
    for (const file of fs.readdirSync(root).filter(f => /\.(input|starts)$/.test(f))) fs.copyFileSync(path.join(root, file), path.join(raw, file))
    fs.writeFileSync(path.join(raw, 'run.json'), JSON.stringify({ runId, root, appRoot: app, node: process.version, runtimeSHA256: createHash('sha256').update(fs.readFileSync(path.join(app, 'out/runtime/cli.mjs'))).digest('hex'), backend, binarySHA256: createHash('sha256').update(fs.readFileSync(backend)).digest('hex'), commands, observations, checks }, null, 2) + '\n')
    console.log(JSON.stringify({ runId, raw, checks: checks.map(({id, pass}) => ({id,pass})) }))
  }
  for (const args of [['init', '-b', 'main', repo], ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], ['-C', repo, 'worktree', 'add', '-b', 'linked', linked]]) { const r = await run('git', args); assert.equal(r.exit, 0) }
  return { root, raw, repo, linked, socket, env, base, runId, client, start, run, cli, backendRpc, stop, startBackend, serve, gui, control, receiver, check, cleanup, observations }
}
