// LIFE-409 F12 — capture the shipped help text verbatim, and hold the prose to the same bar.
//
// G5: r0 captured `--help` and checked nothing about the README, so a README sentence that had
// become false (R1's "settle it with task-update") passed F12. The documentation checks below are
// mechanical, not semantic — every command and every error code this module can answer with has to
// appear in both the README and `specs.json` — but they close the gap where a whole command or a
// whole failure mode goes undocumented.
//
// `--help` and `agent-context` are client-side: they never connect, never start a runtime and
// never touch a profile. That is itself part of what is being recorded here, so this script runs
// against an empty throwaway profile and asserts nothing was created in it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cli = path.join(app, 'cli/corral.mjs')
const owner = process.env.CORRAL_VERIFY_OWNER ?? 'claude'
const raw = path.resolve(process.env.CORRAL_VERIFY_RAW ?? path.join(app, '../specs/LIFE-409-cli-orchestration-core/raw/worker', owner, process.env.CORRAL_VERIFY_ROUND ?? '', 'help'))
const profile = fs.realpathSync(fs.mkdtempSync('/tmp/l409-' + owner + '-help-'))
fs.mkdirSync(raw, { recursive: true })

const COMMANDS = [
  'run-create', 'run-use', 'run-current', 'run-list', 'run-show',
  'task-create', 'task-list', 'task-update', 'dispatch', 'dispatch-show',
]
const env = { ...process.env, CORRAL_USER_DATA: profile }
delete env.CORRAL_RUNTIME_SOCKET
const run = args => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env })

const help = ['# LIFE-409 — `--help` output, verbatim', '', `Captured from \`${path.relative(app, cli)}\` at ${new Date().toISOString()}.`, '']
for (const command of COMMANDS) {
  const text = run(['orchestration', command, '--help'])
  assert.match(text, new RegExp(`corral orchestration ${command} `), `help for ${command} did not print its usage`)
  help.push(`## \`corral orchestration ${command} --help\``, '', '```', text.trimEnd(), '```', '')
}
fs.writeFileSync(path.join(raw, 'help.md'), help.join('\n') + '\n')

const schema = JSON.parse(run(['agent-context', '--json']))
const ours = schema.commands.filter(spec => spec.command.startsWith('orchestration '))
assert.equal(ours.length, 10, `expected ten orchestration commands, found ${ours.length}`)
assert.deepEqual(ours.map(spec => spec.command), COMMANDS.map(name => `orchestration ${name}`))
// Nothing outside the frozen ten was registered.
for (const forbidden of ['gate-create', 'gate-list', 'gate-resolve', 'reset', 'coordinator-start', 'coordinator-stop', 'request-show', 'worker-list', 'worker-show', 'worker-start'])
  assert.equal(schema.commands.some(spec => spec.command === `orchestration ${forbidden}`), false, `${forbidden} must not exist in this slice`)
fs.writeFileSync(path.join(raw, 'agent-context-orchestration.json'), JSON.stringify({ commandCount: schema.commandCount, commands: ours }, null, 2) + '\n')

// --- G5: the shipped prose mentions every command and every error code -------------------------
const readme = fs.readFileSync(path.join(app, 'cli/README.md'), 'utf8')
const specsText = fs.readFileSync(path.join(app, 'src/runtime/orchestration/specs.json'), 'utf8')
for (const command of COMMANDS) {
  assert.ok(readme.includes(command), `README never mentions ${command}`)
  assert.ok(specsText.includes(`"orchestration ${command}"`), `specs.json never mentions ${command}`)
}
// Every code the module raises, read out of the source rather than from a list kept by hand.
const source = ['model.ts', 'index.ts', 'store.ts'].map(name => fs.readFileSync(path.join(app, 'src/runtime/orchestration', name), 'utf8')).join('\n')
const INTERNAL = new Set(['operation_failed', 'unsupported'])  // guards for impossible variants, not a caller's contract
// N9 = C17: the receipt store's codes are read out of `receipts.ts` (and out of this module, which
// re-raises some of them), not kept by hand — the hand-written list silently dropped
// `receipt_capacity` and `request_expired`, which an orchestration mutation can absolutely answer
// with, and the check still passed.
// M9 = C22: the terminal module's three are still written out below, and that is the honest
// description of this list. They are the handle check's answers (`invalid_terminal`,
// `stale_terminal`, `backend_unavailable`), and `terminal/index.ts` raises many codes an
// orchestration command can never produce — extracting them all would widen the README contract
// rather than pin it. Adding a fourth to that path means changing this line too.
const borrowedSource = [
  fs.readFileSync(path.join(app, 'src/runtime/terminal/receipts.ts'), 'utf8'),
  fs.readFileSync(path.join(app, 'src/runtime/orchestration/index.ts'), 'utf8'),
].join('\n')
const BORROWED = [...new Set([
  'invalid_terminal', 'stale_terminal', 'backend_unavailable',
  ...[...borrowedSource.matchAll(/new RuntimeError\('([a-z_]+)'/g)].map(match => match[1]),
])].filter(code => !INTERNAL.has(code)).sort()
const raised = [...new Set([...source.matchAll(/(?:fail|preflight|new RuntimeError)\('([a-z_]+)'/g)].map(match => match[1]))].filter(code => !INTERNAL.has(code))
const codes = [...new Set([...raised, ...BORROWED])].sort()
const missing = { readme: codes.filter(code => !readme.includes(code)), specs: codes.filter(code => !specsText.includes(code)) }
assert.deepEqual(missing, { readme: [], specs: [] }, `documented codes are missing: ${JSON.stringify(missing)}`)
fs.writeFileSync(path.join(raw, 'doc-coverage.json'), JSON.stringify({ commands: COMMANDS, codes, raisedInSource: raised.sort(), borrowed: BORROWED, internalNotDocumented: [...INTERNAL], missing }, null, 2) + '\n')

// The metadata path must not have created anything in the profile.
const created = fs.readdirSync(profile)
assert.deepEqual(created, [], `--help/agent-context created ${created.join(', ')} in the profile`)
fs.rmSync(profile, { recursive: true, force: true })

console.log(JSON.stringify({ raw, commands: ours.length, commandCount: schema.commandCount, profileArtifacts: created.length, documentedCodes: codes.length }))
