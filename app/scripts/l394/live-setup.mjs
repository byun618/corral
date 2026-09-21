// LIFE-394 §7.2 live run. Builds one isolated, untrusted git directory per provider, starts the
// backend under test detached, and prints the environment to drive the product CLI by hand.
//
// It deliberately does not launch the provider or accept anything: the live order in §7.2 is run
// command by command so every screen and every JSON body is observed, and C6 requires the trust
// dialog to be accepted by the worker typing into the TUI rather than by a script.
//
//   node app/scripts/l394/live-setup.mjs --provider codex
//   node app/scripts/l394/live-setup.mjs --stop /tmp/l394-claude-live-codex-XXXX
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { app, rpc, until, pause } from './lib.mjs'
import { strippedSessionMarkers, withoutSessionMarkers, PRESERVED_NAMES } from './env.mjs'

const args = process.argv.slice(2)
const flag = name => { const at = args.indexOf('--' + name); return at < 0 ? undefined : args[at + 1] }

if (flag('stop') !== undefined) {
  const state = JSON.parse(fs.readFileSync(path.join(flag('stop'), 'env.json'), 'utf8'))
  try { process.kill(state.backendPid, 'SIGTERM') } catch (error) { console.log('backend already gone:', String(error)) }
  console.log(JSON.stringify({ stopped: state.backendPid, root: state.root }))
  process.exit(0)
}

const provider = flag('provider')
assert(['claude', 'codex', 'grok'].includes(provider), 'Pass --provider claude|codex|grok')
const backend = process.env.CORRAL_TEST_BACKEND
assert(backend && fs.existsSync(backend), 'Set CORRAL_TEST_BACKEND to the guard build under test')

const root = fs.realpathSync(fs.mkdtempSync('/tmp/l394-claude-live-' + provider + '-'))
const runId = path.basename(root)
const raw = path.resolve(process.env.CORRAL_VERIFY_RAW ?? path.join(app, '../specs/LIFE-394-cli-agents/raw/worker/claude/live', provider))
fs.mkdirSync(raw, { recursive: true })
const home = path.join(root.replace(/^\/private\/tmp(?=\/)/, '/tmp'), 'c'), repo = path.join(root, 'repo'), data = path.join(root, 'headless')
for (const dir of [home, repo, data]) fs.mkdirSync(dir, { mode: 0o700 })
fs.writeFileSync(path.join(home, 'herdr.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')

// A fresh checkout the providers have never seen, so their trust dialog is the live one (F4).
// grok asks only when the directory carries an AGENTS.md (D20, review r3 grok inspect).
const git = (...rest) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...rest], { encoding: 'utf8' }).trim()
execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' })
fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# fixture\n\nLIFE-394 live verification directory. Nothing here is a real project.\n')
fs.writeFileSync(path.join(repo, 'README.md'), 'LIFE-394 live fixture\n')
git('add', '-A'); git('commit', '-m', 'fixture')

const session = 'life394-claude-' + runId.slice(-6)
const socket = path.join(home, 'herdr-dev/sessions', session, 'herdr.sock')
assert(Buffer.byteLength(socket) < 104, 'socket path exceeds the macOS limit')
const stripped = strippedSessionMarkers(process.env)
const base = { ...withoutSessionMarkers(process.env), CORRAL_BACKEND_SOCKET: socket, HERDR_SOCKET_PATH: socket,
  CORRAL_SESSION: session, HERDR_SESSION: session, HERDR_CONFIG_PATH: path.join(home, 'herdr.toml'),
  XDG_CONFIG_HOME: home, CORRAL_SHOT_DIR: raw, CORRAL_REGISTRY: path.join(root, 'repos.json'), SHELL: '/bin/sh' }
for (const key of ['ELECTRON_RUN_AS_NODE', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_CLI_SOCKET', 'CORRAL_ELECTRON']) delete base[key]
const env = { ...base, CORRAL_USER_DATA: data, CORRAL_CONTROL_SOCKET: path.join(root, 'headless.sock') }

const log = fs.openSync(path.join(root, 'backend.log'), 'w')
const child = spawn(backend, ['--session', session, 'server'], { env: base, stdio: ['ignore', log, log], detached: true })
child.unref()
fs.closeSync(log)
await until(async () => (await rpc(socket, { id: 'ready', method: 'corral.terminal', params: {} })).result?.guard_version === 1, 'backend guard ready', 30000)
await pause(200)
const manifests = (await rpc(socket, { id: 'm', method: 'corral.terminal', params: { epoch: (await rpc(socket, { id: 'e', method: 'corral.terminal', params: {} })).result.epoch, deadline_ms: Date.now() + 15000, operation: { method: 'server.agent_manifests', params: {} } } })).result

const state = { runId, provider, root, repo, home, raw, session, socket, backend,
  binarySHA256: createHash('sha256').update(fs.readFileSync(backend)).digest('hex'),
  backendPid: child.pid, strippedEnv: stripped,
  preservedEnv: Object.fromEntries(PRESERVED_NAMES.map(name => [name, base[name] ?? null])),
  manifests, at: new Date().toISOString(),
  env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('CORRAL_') || key.startsWith('HERDR_') || key === 'XDG_CONFIG_HOME' || key === 'SHELL')) }
fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify(state, null, 2) + '\n')
fs.writeFileSync(path.join(raw, 'setup.json'), JSON.stringify(state, null, 2) + '\n')
for (const [key, value] of Object.entries(state.env)) console.log(`export ${key}=${JSON.stringify(value)}`)
console.log(`# root=${root} repo=${repo} raw=${raw} backendPid=${child.pid}`)
